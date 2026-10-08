import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createDatabase, createWorkspace, type Database, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { parseEventPayload } from "@fundroom/domain";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import {
  type MailDeliveryEvent,
  type MailerPort,
  MailSuppressedError,
  type OutboundEmail,
  type SentEmail,
} from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { createMailFeedback } from "./mail/feedback.js";
import { MAIL_MESSAGE_RETENTION_DAYS, sweepMailMessages } from "./mail/jobs.js";
import { createKernelMailer } from "./mail/kernel-mailer.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Mail delivery feedback end to end (E2.6 WP-B): the send wrapper records every accepted message
 * sent on behalf of a workspace, the ESP webhook finds its way back to that workspace from the
 * provider message id alone, hard bounces and complaints suppress (per workspace, hashed), the
 * suppression holds for broadcast/notification sends and never for transactional ones, opens and
 * clicks are published only in `engagement` mode for a member whose consent allows it, and the
 * admin can see and (freshly) lift an entry.
 *
 * The mailer is a fake whose `parseWebhook` this file controls: the request body is a JSON array
 * of `MailDeliveryEvent`s and the "signature" is one header. The adapters' own signature schemes
 * are WP-A's tests; this file is about what the kernel does with a verified event.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const SIGNATURE = "x-fake-signature";
const GOOD = "good";

interface FakeMailer extends MailerPort {
  readonly sent: OutboundEmail[];
}

function createFakeMailer(): FakeMailer {
  const sent: OutboundEmail[] = [];
  let seq = 0;
  return {
    driver: "fake",
    capabilities: { perMessageTracking: false, webhooks: true },
    sent,
    async send(message): Promise<SentEmail> {
      // The provider's own suppression list refusing the recipient (Postmark's 406).
      if (message.to.startsWith("refused-by-esp")) throw new MailSuppressedError("provider");
      sent.push(message);
      seq += 1;
      return { messageId: `fake-${seq}-${randomUUID()}`, acceptedAt: new Date() };
    },
    async parseWebhook(request) {
      if (request.headers.get(SIGNATURE) === "boom") throw new Error("confirm failed");
      if (request.headers.get(SIGNATURE) !== GOOD) return undefined;
      const raw = (await request.json()) as (Omit<MailDeliveryEvent, "occurredAt"> & {
        occurredAt: string;
      })[];
      return raw.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt) }));
    },
    async healthCheck() {},
  };
}

let pg: TestPostgres;
let running: RunningServer;
let fake: FakeMailer;
let acmeId: string;
let betaId: string;
let gammaId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor;
let betaOwner: Actor;

interface Actor {
  cookie: string;
  membershipId: string;
}

async function req(host: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie && !headers.has("origin"))
    headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const request = (slug: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  req(`${slug}.${CANON}`, path, init);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = fake.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(fake, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function rows<T>(query: string, workspaceId: string = acmeId): Promise<T[]> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function auditCount(action: string, workspaceId = acmeId): Promise<number> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${workspaceId}'::uuid
       AND action = '${action}'`,
    workspaceId,
  );
  return r[0]?.n ?? 0;
}

/** Every `mail.delivery_recorded` payload in the workspace's outbox, oldest first. */
async function recorded(workspaceId = acmeId): Promise<Record<string, unknown>[]> {
  const r = await rows<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM core.outbox WHERE topic = 'mail.delivery_recorded' ORDER BY id`,
    workspaceId,
  );
  return r.map((x) => x.payload);
}

async function suppressionCount(workspaceId = acmeId): Promise<number> {
  const r = await rows<{ n: number }>(
    "SELECT count(*)::int AS n FROM core.mail_suppression",
    workspaceId,
  );
  return r[0]?.n ?? 0;
}

async function markFresh(actor: Actor, ageMs = 0): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
      acmeId,
    )
  )[0]?.userId;
  expect(userId).toBeDefined();
  const updated = await running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
         WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    return r.rows.length;
  });
  expect(updated).toBeGreaterThan(0);
}

async function patchSettings(workspaceId: string, block: string, patch: object): Promise<void> {
  await running.container.db.withHost(async (tx) => {
    await tx.execute(
      `UPDATE core.workspace SET settings = settings || jsonb_build_object('${block}',
         coalesce(settings->'${block}', '{}'::jsonb) || '${JSON.stringify(patch)}'::jsonb)
       WHERE id = '${workspaceId}'::uuid`,
    );
  });
  running.container.resolver.invalidate();
}

async function grantTracking(workspaceId: string, membershipId: string, granted: boolean) {
  await rows(
    `INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source)
       VALUES ('${workspaceId}'::uuid, '${membershipId}'::uuid, 'email_tracking', ${granted}, 'settings')`,
    workspaceId,
  );
}

/** A broadcast send exactly as `updates` makes one: stream, ref, workspace. */
async function broadcast(
  workspaceId: string,
  to: string,
  membershipId?: string,
  stream: "broadcast" | "notification" | "transactional" = "broadcast",
): Promise<SentEmail> {
  return running.container.mailer.send({
    to,
    subject: "Q3 update",
    text: "Hello",
    stream,
    workspaceId,
    ref: {
      kind: "post",
      id: randomUUID(),
      ...(membershipId === undefined ? {} : { membershipId }),
    },
  });
}

type WireEvent = Omit<MailDeliveryEvent, "occurredAt" | "provider"> & { occurredAt?: string };

function webhook(events: readonly WireEvent[], signature = GOOD, driver = "fake") {
  return req(CANON, `/webhooks/email/${driver}`, {
    method: "POST",
    headers: { [SIGNATURE]: signature, "content-type": "application/json" },
    body: JSON.stringify(
      events.map((e) => ({
        provider: "fake",
        occurredAt: new Date().toISOString(),
        ...e,
      })),
    ),
  });
}

function ev(
  kind: MailDeliveryEvent["kind"],
  messageId: string,
  recipient: string,
  extra: Partial<WireEvent> = {},
): WireEvent {
  return { kind, messageId, recipient, reason: undefined, ...extra };
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  fake = createFakeMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer: fake,
    chat: {
      driver: "test",
      validateUrl: () => ({ ok: true }),
      post: async () => ({ ok: true }),
    },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  gammaId = (await createWorkspace(running.container.db, { slug: "gamma", name: "Gamma" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  betaOwner = await member("beta", betaId, "owner@beta.example.com", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("wiring", () => {
  it("exposes the chat seam to modules", () => {
    expect(running.container.moduleServices.chat.driver).toBe("test");
  });

  it("records every workspace message it sends, ids only, and never instance mail", async () => {
    const sent = await broadcast(acmeId, "someone@example.org", ada.membershipId);
    const found = await rows<{
      stream: string;
      ref_kind: string;
      membership_id: string;
      provider: string;
    }>(
      `SELECT stream, ref_kind, membership_id, provider FROM core.mail_message
         WHERE provider_message_id = '${sent.messageId}'`,
    );
    expect(found).toEqual([
      { stream: "broadcast", ref_kind: "post", membership_id: ada.membershipId, provider: "fake" },
    ]);
    // Instance-level mail (no workspace) has nowhere to be recorded, and is not.
    const before = await rows<{ n: number }>("SELECT count(*)::int AS n FROM core.mail_message");
    await running.container.mailer.send({ to: "x@example.org", subject: "s", text: "t" });
    const after = await rows<{ n: number }>("SELECT count(*)::int AS n FROM core.mail_message");
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe("the webhook", () => {
  it("answers 404 for a driver that is not configured, and 401 for a bad signature", async () => {
    expect((await webhook([], GOOD, "resend")).status).toBe(404);
    const bad = await webhook([], "forged");
    expect(bad.status).toBe(401);
  });

  it("answers 500 when the adapter throws, so the provider retries", async () => {
    expect((await webhook([], "boom")).status).toBe(500);
  });

  it("is an ops route: no tenant host, no session, no CSRF origin needed", async () => {
    const res = await webhook([]);
    expect(res.status).toBe(200);
  });

  it("refuses a body past 256 KiB before the adapter sees it", async () => {
    const res = await req(CANON, "/webhooks/email/fake", {
      method: "POST",
      headers: { [SIGNATURE]: GOOD, "content-type": "application/json" },
      body: `[${" ".repeat(300 * 1024)}]`,
    });
    expect(res.status).toBe(413);
  });

  it("ignores a message id it never recorded once the event is older than the early window", async () => {
    const before = await recorded();
    const res = await webhook([
      ev("bounce", "never-sent", "who@example.org", {
        bounceType: "hard",
        occurredAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      }),
    ]);
    expect(res.status).toBe(200);
    expect(await recorded()).toEqual(before);
    expect(await suppressionCount()).toBe(0);
  });

  it("asks for a retry (503) when a recent event beats the sender's recordSent, then ingests the retry", async () => {
    const early = `early-${randomUUID()}`;
    const event = ev("bounce", early, "early@example.org", {
      bounceType: "hard",
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const first = await webhook([event]);
    expect(first.status).toBe(503);
    expect(await suppressionCount(gammaId)).toBe(0);
    // recordSent commits.
    await rows(
      `INSERT INTO core.mail_message (workspace_id, provider, provider_message_id, stream, sent_at)
         VALUES ('${gammaId}'::uuid, 'fake', '${early}', 'broadcast', now() - interval '2 minutes')`,
      gammaId,
    );
    const retried = await webhook([event]);
    expect(retried.status).toBe(200);
    expect((await recorded(gammaId)).map((e) => e["providerMessageId"])).toContain(early);
    expect(await suppressionCount(gammaId)).toBe(1);
  });
});

describe("suppression", () => {
  const address = "Bounce.Me@Example.org";
  let bounceMessageId = "";

  it("a hard bounce suppresses the address, audits it once, and publishes the event", async () => {
    const sent = await broadcast(acmeId, address, ada.membershipId);
    bounceMessageId = sent.messageId;
    const auditsBefore = await auditCount("mail.suppressed");
    const res = await webhook([
      ev("bounce", sent.messageId, address, { bounceType: "hard", reason: "550 5.1.1" }),
    ]);
    expect(res.status).toBe(200);
    expect(await suppressionCount()).toBe(1);
    expect(await auditCount("mail.suppressed")).toBe(auditsBefore + 1);

    const stored = await rows<{ address_masked: string; reason: string; hash_len: number }>(
      "SELECT address_masked, reason, octet_length(address_hash)::int AS hash_len FROM core.mail_suppression",
    );
    // The address itself is nowhere in the row.
    expect(stored).toEqual([
      { address_masked: "b•••@example.org", reason: "bounce", hash_len: 32 },
    ]);

    const events = await recorded();
    const last = events.at(-1);
    const messageRef = (
      await rows<{ id: string }>(
        `SELECT id FROM core.mail_message WHERE provider_message_id = '${sent.messageId}'`,
      )
    )[0]?.id;
    expect(last).toMatchObject({
      messageRef,
      providerMessageId: sent.messageId,
      kind: "bounce",
      bounceType: "hard",
      automated: false,
      refKind: "post",
      membershipId: ada.membershipId,
      link: null,
    });
    // The payload is exactly what the catalogue declares.
    expect(() => parseEventPayload("mail.delivery_recorded", last, 1)).not.toThrow();

    // The same bounce again (ESPs retry) neither duplicates the entry nor the audit row.
    await webhook([ev("bounce", sent.messageId, address, { bounceType: "hard" })]);
    expect(await suppressionCount()).toBe(1);
    expect(await auditCount("mail.suppressed")).toBe(auditsBefore + 1);
  });

  it("refuses the next broadcast and notification send, case-insensitively, and never a transactional one", async () => {
    const before = fake.sent.length;
    await expect(broadcast(acmeId, "bounce.me@example.org")).rejects.toBeInstanceOf(
      MailSuppressedError,
    );
    await expect(broadcast(acmeId, address, undefined, "notification")).rejects.toMatchObject({
      code: "suppressed",
      reason: "bounce",
    });
    expect(fake.sent.length).toBe(before);
    await broadcast(acmeId, address, undefined, "transactional");
    expect(fake.sent.length).toBe(before + 1);
  });

  it("a complaint suppresses; a soft bounce and a delay do not", async () => {
    const soft = await broadcast(acmeId, "soft@example.org");
    await webhook([
      ev("bounce", soft.messageId, "soft@example.org", { bounceType: "soft" }),
      ev("delay", soft.messageId, "soft@example.org"),
    ]);
    expect(await suppressionCount()).toBe(1);
    await expect(broadcast(acmeId, "soft@example.org")).resolves.toBeDefined();

    const complained = await broadcast(acmeId, "angry@example.org");
    await webhook([ev("complaint", complained.messageId, "angry@example.org")]);
    expect(await suppressionCount()).toBe(2);
    await expect(broadcast(acmeId, "angry@example.org")).rejects.toMatchObject({
      reason: "complaint",
    });
  });

  it("is per workspace: another workspace's bounce never suppresses here, and its list is invisible", async () => {
    const shared = "shared@example.org";
    const betaSent = await broadcast(betaId, shared);
    await webhook([ev("bounce", betaSent.messageId, shared, { bounceType: "hard" })]);
    expect(await suppressionCount(betaId)).toBe(1);
    await expect(broadcast(betaId, shared)).rejects.toBeInstanceOf(MailSuppressedError);
    // acme still mails the address.
    await expect(broadcast(acmeId, shared)).resolves.toBeDefined();
    // And beta's event went to beta's outbox, not acme's.
    expect((await recorded(betaId)).length).toBe(1);

    const acmeList = await json<{ items: { address: string }[] }>(
      await request("acme", "/api/v1/mail/suppressions", { cookie: owner.cookie }),
    );
    expect(acmeList.items.map((i) => i.address)).not.toContain("s•••@example.org");
    const betaList = await json<{ items: { id: string }[] }>(
      await request("beta", "/api/v1/mail/suppressions", { cookie: betaOwner.cookie }),
    );
    const betaEntry = betaList.items[0]?.id ?? "";
    await markFresh(owner);
    // acme's owner cannot lift beta's entry by id.
    const cross = await request("acme", `/api/v1/mail/suppressions/${betaEntry}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(cross.status).toBe(404);
    expect(await suppressionCount(betaId)).toBe(1);
  });

  it("the bounce's suppression key survives across sends (hash, not a per-send salt)", async () => {
    await expect(broadcast(acmeId, address)).rejects.toBeInstanceOf(MailSuppressedError);
    expect(bounceMessageId).not.toBe("");
  });

  it("survives a rotation of the workspace's mail-suppression key", async () => {
    const shared = "shared@example.org";
    const ctx = systemContext(betaId);
    const { envelope, db } = running.container;
    const before = await db.withTenant(ctx, (tx) =>
      envelope.currentKey(tx, ctx, "mail-suppression"),
    );
    const rotated = await db.withTenant(ctx, (tx) => envelope.rotate(tx, ctx, "mail-suppression"));
    expect(rotated.keyId).not.toBe(before.keyId);

    // The entry hashed under the retired key still stops the send.
    await expect(broadcast(betaId, shared)).rejects.toBeInstanceOf(MailSuppressedError);
    await expect(
      broadcast(betaId, "SHARED@example.org", undefined, "notification"),
    ).rejects.toMatchObject({ reason: "bounce" });

    // A retried bounce for the same address is recognised, not listed a second time.
    const again = await broadcast(betaId, "fresh@example.org");
    await webhook([ev("bounce", again.messageId, shared, { bounceType: "hard" })]);
    expect(await suppressionCount(betaId)).toBe(1);

    // A new entry is written under the current key and holds too.
    await webhook([ev("complaint", again.messageId, "fresh@example.org")]);
    const keys = await rows<{ key_id: string; address_masked: string }>(
      "SELECT key_id, address_masked FROM core.mail_suppression ORDER BY id",
      betaId,
    );
    expect(keys).toEqual([
      { key_id: before.keyId, address_masked: "s•••@example.org" },
      { key_id: rotated.keyId, address_masked: "f•••@example.org" },
    ]);
    await expect(broadcast(betaId, "fresh@example.org")).rejects.toMatchObject({
      reason: "complaint",
    });
  });
});

describe("opens and clicks", () => {
  let messageId = "";

  it("drops opens while the analytics mode is not engagement", async () => {
    const sent = await broadcast(acmeId, "ada@investor.test", ada.membershipId);
    messageId = sent.messageId;
    await grantTracking(acmeId, ada.membershipId, true);
    const before = (await recorded()).length;
    await webhook([ev("open", messageId, "ada@investor.test", { userAgent: "Mozilla/5.0" })]);
    expect((await recorded()).length).toBe(before);
  });

  it("drops opens in engagement mode when the member's consent is missing or withdrawn", async () => {
    await patchSettings(acmeId, "analytics", { mode: "engagement" });
    await grantTracking(acmeId, ada.membershipId, false);
    const before = (await recorded()).length;
    await webhook([ev("open", messageId, "ada@investor.test")]);
    expect((await recorded()).length).toBe(before);

    // A message with no member attached can never be consented for.
    const anon = await broadcast(acmeId, "anon@example.org");
    await webhook([ev("open", anon.messageId, "anon@example.org")]);
    expect((await recorded()).length).toBe(before);
  });

  it("publishes opens and clicks when both hold, with the automated flag and a stripped link", async () => {
    await grantTracking(acmeId, ada.membershipId, true);
    const before = (await recorded()).length;
    const later = new Date(Date.now() + 60_000).toISOString();
    await webhook([
      ev("open", messageId, "ada@investor.test", { userAgent: "Mozilla/5.0" }),
      ev("open", messageId, "ada@investor.test", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0",
      }),
      ev("click", messageId, "ada@investor.test", {
        url: `https://acme.${CANON}/updates/q3?token=secret#frag`,
        occurredAt: later,
      }),
      ev("click", messageId, "ada@investor.test", {
        machine: true,
        url: `https://acme.${CANON}/s/8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA`,
      }),
      // A foreign origin is stored as its origin only.
      ev("click", messageId, "ada@investor.test", {
        url: "https://docs.google.com/document/d/1AbCsecret/edit",
        occurredAt: later,
      }),
      // An unsubscribe click is the reader leaving: never published as a click.
      ev("click", messageId, "ada@investor.test", {
        url: `https://acme.${CANON}/unsubscribe?token=abc`,
        occurredAt: later,
      }),
      ev("click", messageId, "ada@investor.test", {
        url: `https://acme.${CANON}/api/v1/updates/unsubscribe?token=abc`,
        occurredAt: later,
      }),
      // Resend-style: an open with no user agent cannot evidence a human.
      ev("open", messageId, "ada@investor.test"),
    ]);
    const events = (await recorded()).slice(before);
    expect(events.map((e) => [e["kind"], e["automated"], e["link"]])).toEqual([
      ["open", true, null],
      ["open", false, null],
      ["click", false, `https://acme.${CANON}/updates/q3`],
      ["click", true, `https://acme.${CANON}/s/:token`],
      ["click", false, "https://docs.google.com"],
      ["open", true, null],
    ]);
    for (const e of events) {
      expect(() => parseEventPayload("mail.delivery_recorded", e, 1)).not.toThrow();
      expect(e["membershipId"]).toBe(ada.membershipId);
    }
    await patchSettings(acmeId, "analytics", { mode: "essential" });
  });
});

describe("provider-side suppression", () => {
  it("a provider_suppressed: bounce lists the address with reason provider and is not published", async () => {
    const sent = await broadcast(gammaId, "listed@example.org");
    const before = (await recorded(gammaId)).length;
    const suppressedBefore = await suppressionCount(gammaId);
    const res = await webhook([
      ev("bounce", sent.messageId, "listed@example.org", {
        bounceType: "hard",
        reason: "provider_suppressed:OnAccountSuppressionList",
      }),
    ]);
    expect(res.status).toBe(200);
    expect((await recorded(gammaId)).length).toBe(before);
    expect(await suppressionCount(gammaId)).toBe(suppressedBefore + 1);
    const reasons = await rows<{ reason: string }>(
      "SELECT reason FROM core.mail_suppression WHERE address_masked = 'l•••@example.org'",
      gammaId,
    );
    expect(reasons).toEqual([{ reason: "provider" }]);
    await expect(broadcast(gammaId, "listed@example.org")).rejects.toMatchObject({
      reason: "provider",
    });
  });

  it("a send the ESP refuses from its own list (MailSuppressedError provider) is listed locally", async () => {
    const address = "refused-by-esp@example.org";
    await expect(broadcast(gammaId, address)).rejects.toMatchObject({
      code: "suppressed",
      reason: "provider",
    });
    const listed = await rows<{ reason: string; message_ref: string | null }>(
      "SELECT reason, message_ref FROM core.mail_suppression WHERE address_masked = 'r•••@example.org'",
      gammaId,
    );
    expect(listed).toEqual([{ reason: "provider", message_ref: null }]);
    // The next send is refused by the kernel wrapper, before the adapter is called.
    const sentBefore = fake.sent.length;
    await expect(broadcast(gammaId, address, undefined, "notification")).rejects.toMatchObject({
      reason: "provider",
    });
    expect(fake.sent.length).toBe(sentBefore);
  });
});

describe("the send path and the pool", () => {
  let tiny: Database;
  let sendPool: Database;

  beforeAll(() => {
    tiny = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
    sendPool = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
  });
  afterAll(async () => {
    await tiny?.close();
    await sendPool?.close();
  });

  function kernelMailer(sendDb: Database) {
    const feedback = createMailFeedback({
      db: tiny,
      sendDb,
      envelope: running.container.envelope,
      audit: running.container.audit,
      allowsTracking: async () => false,
    });
    return createKernelMailer(createFakeMailer(), feedback);
  }

  const within = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
      promise,
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), ms)),
    ]);

  it("a sender holding every main-pool connection can still send (no pool deadlock)", async () => {
    const mailer = kernelMailer(sendPool);
    const ctx = systemContext(gammaId);
    // notify's deliver job shape: send while holding the (only) connection in a transaction.
    const outcome = await within(
      tiny.withTenant(ctx, async () =>
        mailer.send({
          to: "pool@example.org",
          subject: "s",
          text: "t",
          stream: "notification",
          workspaceId: gammaId,
        }),
      ),
      5_000,
    );
    expect(outcome).not.toBe("stuck");
    expect(outcome).toMatchObject({ messageId: expect.any(String) });
  });
});

describe("admin routes", () => {
  it("status names the driver and the webhook URL to paste", async () => {
    const res = await request("acme", "/api/v1/mail/status", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = await json<{ driver: string; webhookUrl: string; capabilities: object }>(res);
    expect(body.driver).toBe("fake");
    expect(body.webhookUrl).toBe(`${BASE}/webhooks/email/fake`);
    expect(body.capabilities).toMatchObject({ webhooks: true });
  });

  it("lists masked entries newest first with a working keyset cursor", async () => {
    const first = await json<{
      items: { id: string; address: string; reason: string }[];
      nextCursor: string | null;
    }>(await request("acme", "/api/v1/mail/suppressions?limit=1", { cookie: owner.cookie }));
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ address: "a•••@example.org", reason: "complaint" });
    expect(first.nextCursor).not.toBeNull();
    const second = await json<{ items: { address: string }[]; nextCursor: string | null }>(
      await request(
        "acme",
        `/api/v1/mail/suppressions?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        { cookie: owner.cookie },
      ),
    );
    expect(second.items.map((i) => i.address)).toEqual(["b•••@example.org"]);
    expect(second.nextCursor).toBeNull();
    const bad = await request("acme", "/api/v1/mail/suppressions?cursor=nope", {
      cookie: owner.cookie,
    });
    expect(bad.status).toBe(400);
  });

  it("an editor gets 403 and an investor the 404 an unknown route gets", async () => {
    expect(
      (await request("acme", "/api/v1/mail/suppressions", { cookie: editor.cookie })).status,
    ).toBe(403);
    expect((await request("acme", "/api/v1/mail/status", { cookie: ada.cookie })).status).toBe(404);
  });

  it("lifting an entry needs a fresh session, audits it, and re-opens mail", async () => {
    const list = await json<{ items: { id: string; address: string }[] }>(
      await request("acme", "/api/v1/mail/suppressions", { cookie: owner.cookie }),
    );
    const entry = list.items.find((i) => i.address === "b•••@example.org");
    expect(entry).toBeDefined();

    await markFresh(owner, 11 * 60_000);
    const stale = await request("acme", `/api/v1/mail/suppressions/${entry?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(stale.status).toBe(403);
    expect((await json<{ error: { code: string; reason: string } }>(stale)).error).toMatchObject({
      code: "step_up_required",
      reason: "fresh",
    });

    await markFresh(owner);
    const auditsBefore = await auditCount("mail.unsuppressed");
    const res = await request("acme", `/api/v1/mail/suppressions/${entry?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(await auditCount("mail.unsuppressed")).toBe(auditsBefore + 1);
    await expect(broadcast(acmeId, "bounce.me@example.org")).resolves.toBeDefined();

    const again = await request("acme", `/api/v1/mail/suppressions/${entry?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(again.status).toBe(404);
  });
});

describe("retention", () => {
  const DAY = 24 * 3600_000;

  async function seedMessage(workspaceId: string, ageDays: number): Promise<string> {
    const providerMessageId = `aged-${ageDays}-${randomUUID()}`;
    await rows(
      `INSERT INTO core.mail_message (workspace_id, provider, provider_message_id, stream, sent_at)
         VALUES ('${workspaceId}'::uuid, 'fake', '${providerMessageId}', 'broadcast',
                 now() - interval '${ageDays} days')`,
      workspaceId,
    );
    return providerMessageId;
  }

  async function exists(workspaceId: string, providerMessageId: string): Promise<boolean> {
    const r = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.mail_message
         WHERE provider_message_id = '${providerMessageId}'`,
      workspaceId,
    );
    return (r[0]?.n ?? 0) > 0;
  }

  it("is scheduled as a kernel job", () => {
    const job = running.container.jobs.find((j) => j.name === "mail.message_sweep");
    expect(job?.cron).toBe("55 3 * * *");
  });

  it("deletes rows past the bound in batches, keeps younger ones, and skips a workspace on legal hold", async () => {
    const old = [
      await seedMessage(acmeId, MAIL_MESSAGE_RETENTION_DAYS + 30),
      await seedMessage(acmeId, MAIL_MESSAGE_RETENTION_DAYS + 5),
      await seedMessage(acmeId, MAIL_MESSAGE_RETENTION_DAYS + 1),
    ];
    const young = await seedMessage(acmeId, MAIL_MESSAGE_RETENTION_DAYS - 1);
    const held = await seedMessage(betaId, MAIL_MESSAGE_RETENTION_DAYS + 30);
    await patchSettings(betaId, "legal", { legalHold: true });

    const result = await sweepMailMessages({
      db: running.container.db,
      batchSize: 2,
      now: () => new Date(Date.now() + DAY / 24),
    });
    expect(result.deleted).toBe(3);
    expect(result.held).toBe(1);
    for (const id of old) expect(await exists(acmeId, id)).toBe(false);
    expect(await exists(acmeId, young)).toBe(true);
    expect(await exists(betaId, held)).toBe(true);
    // Everything this file sent today is untouched.
    const recent = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.mail_message WHERE sent_at > now() - interval '1 day'",
    );
    expect(recent[0]?.n).toBeGreaterThan(0);

    // A late webhook for a swept message is ignored like any unknown id.
    const before = (await recorded()).length;
    const res = await webhook([
      ev("open", old[0] ?? "", "someone@example.org", {
        occurredAt: new Date(Date.now() - 40 * DAY).toISOString(),
      }),
    ]);
    expect(res.status).toBe(200);
    expect((await recorded()).length).toBe(before);

    // Lifting the hold lets the next run trim it.
    await patchSettings(betaId, "legal", { legalHold: false });
    const next = await sweepMailMessages({ db: running.container.db });
    expect(next.deleted).toBe(1);
    expect(await exists(betaId, held)).toBe(false);
  });
});
