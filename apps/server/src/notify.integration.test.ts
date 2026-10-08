import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  checkRlsCatalog,
  createDatabase,
  createWorkspace,
  systemContext,
  type TenantContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventPayload, EventTopic } from "@fundroom/domain";
import { type EventHandler, publish } from "@fundroom/events";
import {
  createAccessReviewJobs,
  createAccessReviewService,
  provisionMembership,
  provisionUser,
} from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  CHANNEL_DISABLE_AFTER,
  DEFAULT_DIGEST_HOUR,
  deliverNotification,
  JOB_CHANNELS,
  JOB_DELIVER,
  JOB_DIGEST,
  JOB_RETENTION,
  JOB_SEND,
  NOTIFY_MAX_ATTEMPTS,
  sendDigestFor,
  wallClock,
} from "@fundroom/module-notify";
import {
  type ChatMessage,
  type ChatPostResult,
  type ChatWebhookPort,
  type MailerPort,
  MailSuppressedError,
  type OutboundEmail,
} from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Staff notifications end to end (E1.5): per-member cadences (instant / daily / off) and
 * digest settings → fan-out from investor activity (`document.viewed`, `document.downloaded`,
 * `update.replied`, and the E2.5 round events) to every eligible staff member, never the actor and never for internal
 * activity → the hourly dedupe key → instant email through `notification.created` (with
 * `notify.deliver` as the safety net) → the daily digest at each member's own UTC hour →
 * email suppression (switch off, or no address) that still fills the inbox → the inbox and
 * its RLS fence between two admins → RLS catalog, audit and cross-tenant isolation.
 *
 * E2.6 ("full"), in a workspace of its own (`initech`) so its clock games cannot disturb the
 * above: Slack channels (`notify.manage`, step-up, the URL never echoed, fan-out through a fake
 * `ChatWebhookPort`, auto-disable after repeated `not_found`, transient retry), digests in the
 * member's own timezone with catch-up, weekly digests, quiet hours, the kernel suppression list,
 * inbox keyset paging / read-all / archive, retention (and legal hold), and DSAR erasure.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
/** Addresses the fake suppression wrapper refuses for `stream: "notification"` mail. */
const suppressed = new Set<string>();
/** Addresses whose every send fails with a (non-suppression) provider error. */
const failing = new Set<string>();
/** Every send the mailer was asked for, successful or not, in order. */
const attempted: OutboundEmail[] = [];
/** Runs after a successful send; throwing simulates an acknowledgement lost after the ESP took it. */
let afterSend: ((message: OutboundEmail) => void) | undefined;

/** Every post the fake chat adapter received, in order. */
const posts: { url: string; message: ChatMessage }[] = [];
/** Canned answers per webhook URL (default `{ ok: true }`). */
const chatAnswers = new Map<string, ChatPostResult>();
const fakeChat: ChatWebhookPort = {
  driver: "fake",
  validateUrl(url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: "not a URL" };
    }
    if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") {
      // Deliberately quotes the input back: the module must not pass that on.
      return { ok: false, reason: `refusing to post to ${url}` };
    }
    return u.pathname.startsWith("/services/")
      ? { ok: true }
      : { ok: false, reason: "path must be /services/…" };
  },
  async post(url, message) {
    posts.push({ url, message });
    return chatAnswers.get(url) ?? { ok: true };
  },
};

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

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
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
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
  role: "owner" | "admin" | "editor" | "viewer" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

/** Rows read as the `system` actor (RLS lets the system actor see every inbox). */
async function rows<T>(query: string, ctx?: TenantContext): Promise<T[]> {
  return running.container.db.withTenant(ctx ?? systemContext(acmeId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

function staffContext(membershipId: string, workspaceId?: string): TenantContext {
  return { workspaceId: workspaceId ?? acmeId, actorKind: "staff", membershipId };
}

async function publishOutbox<T extends EventTopic>(
  workspaceId: string,
  topic: T,
  payload: EventPayload<T>,
): Promise<number> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload));
}

/** The module's registered subscriber for a topic (the same closure the dispatcher calls). */
function handlerFor(topic: EventTopic, moduleId: string): EventHandler {
  const sub = running.container.subscriptions
    .subscribersFor(topic)
    .find((x) => x.id.startsWith(`${moduleId}.`));
  if (!sub) throw new Error(`no ${moduleId} subscriber for ${topic}`);
  return sub.handler;
}

/** Delivers one event to a subscriber the way the dispatcher does: a system tx plus the job. */
async function deliver<T extends EventTopic>(
  handler: EventHandler,
  topic: T,
  payload: EventPayload<T>,
  outboxId: number,
  workspaceId?: string,
): Promise<void> {
  const ws = workspaceId ?? acmeId;
  const ctx = systemContext(ws);
  await running.container.db.withTenant(ctx, (tx) =>
    handler(
      {
        outboxId,
        topic,
        workspaceId: ws,
        payload,
        schemaVersion: 1,
        createdAt: new Date(),
      },
      {
        tx,
        ctx,
        job: {
          id: `test-${outboxId}`,
          name: `event.${topic}`,
          data: { outboxId },
          signal: new AbortController().signal,
        },
      },
    ),
  );
}

async function runJob(name: string, data: Record<string, string | number> = {}): Promise<void> {
  const jobs = running.container.registry.resolveJobs(running.container.moduleServices);
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  await job.handler({ id: `test-${name}`, name, data, signal: new AbortController().signal });
}

interface Settings {
  emailEnabled: boolean;
  timezone: string;
  digestHour: number;
  weeklyDay: number;
  quietHours: { start: number; end: number } | null;
}

interface Preferences {
  preferences: { eventType: string; cadence: string; isDefault: boolean }[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  emailEnabled: true,
  timezone: "UTC",
  digestHour: DEFAULT_DIGEST_HOUR,
  weeklyDay: 1,
  quietHours: null,
};

interface Inbox {
  items: {
    id: string;
    eventType: string;
    sentAt: string | null;
    readAt: string | null;
    archivedAt: string | null;
    actor: { membershipId: string; displayName: string; kind: string; role: string } | null;
    subjectName: string | null;
    resourceKind: string | null;
    resourceId: string | null;
    payload: Record<string, unknown>;
  }[];
  unread: number;
  nextCursor: string | null;
}

interface Row {
  id: string;
  eventType: string;
  cadence: string;
  sentAt: string | null;
  resourceId: string | null;
}

async function inboxRows(membershipId: string): Promise<Row[]> {
  return rows<Row>(
    `SELECT id, event_type AS "eventType", cadence, sent_at AS "sentAt", resource_id AS "resourceId"
     FROM notify.notification WHERE membership_id = '${membershipId}'::uuid
     ORDER BY created_at`,
  );
}

const DOC_1 = randomUUID();
const DOC_2 = randomUUID();
const POST_1 = randomUUID();
const REPLY_1 = randomUUID();
const VERSION_1 = randomUUID();

let acmeId: string;
let globexId: string;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let quiet: Actor;
let ghost: Actor;
let ada: Actor;
let globexOwner: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const memory = mailer;
  // Stands in for the composition root's suppression wrapper: refuses notification-stream mail
  // to a suppressed address with the kernel's own error class, and lets everything else through.
  const suppressing: MailerPort = {
    driver: "memory",
    async send(message) {
      attempted.push(message);
      if (message.stream === "notification" && suppressed.has(String(message.to))) {
        throw new MailSuppressedError("bounce");
      }
      if (failing.has(String(message.to))) {
        throw Object.assign(new Error(`550 mailbox ${String(message.to)} unavailable`), {
          name: "MailerError",
          code: "rejected",
        });
      }
      const sent = await memory.send(message);
      afterSend?.(message);
      return sent;
    },
    healthCheck: () => memory.healthCheck(),
  };
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer: suppressing,
    chat: fakeChat,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  viewer = await member("acme", acmeId, "viewer@example.com", "staff", "viewer");
  quiet = await member("acme", acmeId, "quiet@example.com", "staff", "viewer");
  ghost = await member("acme", acmeId, "ghost@example.com", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  // Ghost keeps a membership but loses their email identity: the inbox still fills, mail cannot.
  const ghostUserId = await running.container.db.withTenant(systemContext(acmeId), async (tx) => {
    const r = await tx.execute(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${ghost.membershipId}'::uuid`,
    );
    return (r.rows as { userId: string }[])[0]?.userId ?? "";
  });
  const dropped = await running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `DELETE FROM core.user_identity WHERE user_id = '${ghostUserId}'::uuid RETURNING id`,
    );
    return r.rows.length;
  });
  expect(dropped).toBeGreaterThan(0);
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema + registry", () => {
  it("notify.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers the permissions, the jobs and the admin nav slot", async () => {
    const registry = running.container.registry;
    expect(registry.permissions.has("notify.read")).toBe(true);
    expect(registry.permissions.has("notify.manage")).toBe(true);
    const jobs = registry.resolveJobs(running.container.moduleServices).map((j) => j.name);
    expect(jobs).toEqual(
      expect.arrayContaining([JOB_SEND, JOB_DELIVER, JOB_DIGEST, JOB_CHANNELS, JOB_RETENTION]),
    );
    const boot = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = boot.modules.find((m) => m.id === "notify");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
  });
});

describe("preferences", () => {
  it("defaults are reported as defaults, and every staff role may set its own", async () => {
    const before = await json<Preferences>(
      await request("acme", "/api/v1/notify/preferences", { cookie: viewer.cookie }),
    );
    expect(before.preferences).toEqual([
      { eventType: "document.viewed", cadence: "daily", isDefault: true },
      { eventType: "document.downloaded", cadence: "daily", isDefault: true },
      { eventType: "update.replied", cadence: "instant", isDefault: true },
      { eventType: "round.interest_submitted", cadence: "instant", isDefault: true },
      { eventType: "round.verification_requested", cadence: "instant", isDefault: true },
      { eventType: "round.commitment_created", cadence: "instant", isDefault: true },
      { eventType: "analytics.hot_lead", cadence: "instant", isDefault: true },
      { eventType: "access_request.submitted", cadence: "instant", isDefault: true },
      { eventType: "access_review.overdue", cadence: "instant", isDefault: true },
      { eventType: "membership.delegate_added", cadence: "instant", isDefault: true },
      { eventType: "qa.question_asked", cadence: "instant", isDefault: true },
      { eventType: "qa.question_assigned", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_submitted", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_released", cadence: "instant", isDefault: true },
      { eventType: "qa.question_declined", cadence: "instant", isDefault: true },
      { eventType: "qa.question_due", cadence: "instant", isDefault: true },
      { eventType: "esign.envelope_attention", cadence: "instant", isDefault: true },
      { eventType: "round.signature_completed", cadence: "instant", isDefault: true },
      { eventType: "round.commitment_confirmed", cadence: "instant", isDefault: true },
      { eventType: "integration.connection_unhealthy", cadence: "instant", isDefault: true },
      // E3.7: the investor's own verification alerts (the vocabulary is shared).
      { eventType: "round.verification_expiring", cadence: "instant", isDefault: true },
      { eventType: "round.verification_decided", cadence: "instant", isDefault: true },
    ]);
    expect(before.settings).toEqual(DEFAULT_SETTINGS);

    const put = async (actor: Actor, body: unknown) => {
      const res = await request("acme", "/api/v1/notify/preferences", {
        method: "PUT",
        cookie: actor.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return json<Preferences>(res);
    };

    const asOwner = await put(owner, {
      preferences: [{ eventType: "document.viewed", cadence: "instant" }],
    });
    expect(asOwner.preferences).toEqual([
      { eventType: "document.viewed", cadence: "instant", isDefault: false },
      { eventType: "document.downloaded", cadence: "daily", isDefault: true },
      { eventType: "update.replied", cadence: "instant", isDefault: true },
      { eventType: "round.interest_submitted", cadence: "instant", isDefault: true },
      { eventType: "round.verification_requested", cadence: "instant", isDefault: true },
      { eventType: "round.commitment_created", cadence: "instant", isDefault: true },
      { eventType: "analytics.hot_lead", cadence: "instant", isDefault: true },
      { eventType: "access_request.submitted", cadence: "instant", isDefault: true },
      { eventType: "access_review.overdue", cadence: "instant", isDefault: true },
      { eventType: "membership.delegate_added", cadence: "instant", isDefault: true },
      { eventType: "qa.question_asked", cadence: "instant", isDefault: true },
      { eventType: "qa.question_assigned", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_submitted", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_released", cadence: "instant", isDefault: true },
      { eventType: "qa.question_declined", cadence: "instant", isDefault: true },
      { eventType: "qa.question_due", cadence: "instant", isDefault: true },
      { eventType: "esign.envelope_attention", cadence: "instant", isDefault: true },
      { eventType: "round.signature_completed", cadence: "instant", isDefault: true },
      { eventType: "round.commitment_confirmed", cadence: "instant", isDefault: true },
      { eventType: "integration.connection_unhealthy", cadence: "instant", isDefault: true },
      { eventType: "round.verification_expiring", cadence: "instant", isDefault: true },
      { eventType: "round.verification_decided", cadence: "instant", isDefault: true },
    ]);
    await put(editor, { preferences: [{ eventType: "document.viewed", cadence: "off" }] });
    const asViewer = await put(viewer, {
      preferences: [{ eventType: "document.viewed", cadence: "daily" }],
      settings: { digestHour: 5 },
    });
    expect(asViewer.settings).toEqual({ ...DEFAULT_SETTINGS, digestHour: 5 });
    await put(quiet, {
      preferences: [{ eventType: "document.downloaded", cadence: "instant" }],
      settings: { emailEnabled: false },
    });
    await put(ghost, {
      preferences: [{ eventType: "document.downloaded", cadence: "instant" }],
    });

    const reread = await json<Preferences>(
      await request("acme", "/api/v1/notify/preferences", { cookie: quiet.cookie }),
    );
    expect(reread.settings).toEqual({ ...DEFAULT_SETTINGS, emailEnabled: false });
    expect(reread.preferences.find((p) => p.eventType === "document.downloaded")).toEqual({
      eventType: "document.downloaded",
      cadence: "instant",
      isDefault: false,
    });
  });

  it("an unknown cadence, timezone or quiet window is refused, and this module has no investor surface", async () => {
    for (const body of [
      { preferences: [{ eventType: "document.viewed", cadence: "hourly" }] },
      { preferences: [], settings: { timezone: "Mars/Olympus" } },
      { preferences: [], settings: { digestHour: 24 } },
      { preferences: [], settings: { weeklyDay: 7 } },
      { preferences: [], settings: { quietHours: { start: 5, end: 5 } } },
    ]) {
      const bad = await request("acme", "/api/v1/notify/preferences", {
        method: "PUT",
        cookie: owner.cookie,
        body: JSON.stringify(body),
      });
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
    for (const [method, path] of [
      ["GET", "/api/v1/notify/preferences"],
      ["PUT", "/api/v1/notify/preferences"],
      ["GET", "/api/v1/notify/inbox"],
      ["POST", "/api/v1/notify/inbox/read"],
      ["POST", "/api/v1/notify/inbox/read-all"],
      ["POST", "/api/v1/notify/inbox/archive"],
      ["GET", "/api/v1/notify/channels"],
      ["POST", "/api/v1/notify/channels"],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: ada.cookie,
        ...(method === "GET" ? {} : { body: JSON.stringify({ preferences: [] }) }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("fan-out", () => {
  it("an investor's document view reaches every subscribed staff member, instantly for some", async () => {
    mailer.clear();
    await publishOutbox(acmeId, "document.viewed", {
      documentId: DOC_1,
      versionId: VERSION_1,
      membershipId: ada.membershipId,
      sessionId: randomUUID(),
    });

    const ownerRow = await waitFor(async () => (await inboxRows(owner.membershipId))[0]);
    expect(ownerRow).toMatchObject({
      eventType: "document.viewed",
      cadence: "instant",
      resourceId: DOC_1,
    });
    // Editor switched this event off; everyone else is on the daily queue.
    expect(await inboxRows(editor.membershipId)).toEqual([]);
    for (const m of [viewer, quiet, ghost]) {
      const [row] = await inboxRows(m.membershipId);
      expect(row).toMatchObject({ eventType: "document.viewed", cadence: "daily", sentAt: null });
    }
    // The investor who caused it is not a recipient: this module writes to staff only.
    expect(await inboxRows(ada.membershipId)).toEqual([]);

    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "owner@example.com" && m.subject.includes("viewed")),
    );
    expect(mail.subject).toBe("ada viewed a document");
    expect(mail.text).toContain("ada viewed a document in Acme.");
    expect(mail.text).toContain(`http://acme.${CANON}/admin/analytics/documents/${DOC_1}`);
    expect(mail.tags).toEqual(["notify", "document.viewed"]);
    expect(mail.headers?.["Auto-Submitted"]).toBe("auto-generated");
    expect(mail.idempotencyKey).toBe(`notify:${ownerRow.id}`);
    // E2.6: the notification stream (suppression applies) and an ids-only ref for bounces.
    expect(mail.stream).toBe("notification");
    expect(mail.ref).toEqual({
      kind: "notification",
      id: ownerRow.id,
      membershipId: owner.membershipId,
    });
    expect(mail.tracking).toBeUndefined();
    // E1.7: a notification always belongs to one workspace, so it carries its brand key.
    expect(mail.workspaceId).toBe(acmeId);
    expect(mailer.sent.filter((m) => m.tags?.includes("notify"))).toHaveLength(1);

    const inbox = await json<Inbox>(
      await request("acme", "/api/v1/notify/inbox", { cookie: owner.cookie }),
    );
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0]).toMatchObject({
      eventType: "document.viewed",
      resourceKind: "document",
      resourceId: DOC_1,
      readAt: null,
      actor: {
        membershipId: ada.membershipId,
        displayName: "ada",
        kind: "external",
        role: "investor",
      },
    });
    expect(inbox.items[0]?.payload).toEqual({ documentId: DOC_1, versionId: VERSION_1 });
    expect(inbox.items[0]?.sentAt).not.toBeNull();
  });

  it("the same viewer re-opening the same document inside the hour adds nothing", async () => {
    const before = await inboxRows(owner.membershipId);
    await deliver(
      handlerFor("document.viewed", "notify"),
      "document.viewed",
      {
        documentId: DOC_1,
        versionId: VERSION_1,
        membershipId: ada.membershipId,
        sessionId: randomUUID(),
      },
      9001,
    );
    expect(await inboxRows(owner.membershipId)).toEqual(before);
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.notification WHERE resource_id = '${DOC_1}'::uuid`,
        )
      )[0]?.n,
    ).toBe(4);
  });

  it("staff activity is not interesting: an internal actor produces nothing", async () => {
    const before = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM notify.notification`);
    await deliver(
      handlerFor("document.viewed", "notify"),
      "document.viewed",
      {
        documentId: randomUUID(),
        versionId: VERSION_1,
        membershipId: editor.membershipId,
        sessionId: null,
      },
      9002,
    );
    expect(await rows<{ n: number }>(`SELECT count(*)::int AS n FROM notify.notification`)).toEqual(
      before,
    );
  });

  it("email off or no address still fills the inbox, and never sends mail", async () => {
    mailer.clear();
    await deliver(
      handlerFor("document.downloaded", "notify"),
      "document.downloaded",
      {
        documentId: DOC_2,
        versionId: VERSION_1,
        membershipId: ada.membershipId,
        variant: "watermarked",
      },
      9003,
    );
    // Five staff members, two of them instant (the two that cannot be emailed).
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.notification WHERE resource_id = '${DOC_2}'::uuid`,
        )
      )[0]?.n,
    ).toBe(5);
    for (const m of [quiet, ghost]) {
      const row = await waitFor(async () => {
        const found = (await inboxRows(m.membershipId)).find((r) => r.resourceId === DOC_2);
        return found?.sentAt === null ? undefined : found;
      });
      expect(row).toMatchObject({ eventType: "document.downloaded", cadence: "instant" });
    }
    expect(mailer.sent.map((m) => m.to)).not.toContain("quiet@example.com");
    expect(mailer.sent.map((m) => m.to)).not.toContain("ghost@example.com");
    expect(mailer.sent.filter((m) => m.tags?.includes("notify"))).toEqual([]);
    const daily = await inboxRows(owner.membershipId);
    expect(daily.find((r) => r.resourceId === DOC_2)).toMatchObject({
      cadence: "daily",
      sentAt: null,
    });
  });

  it("a reply to an update reaches staff instantly", async () => {
    mailer.clear();
    await deliver(
      handlerFor("update.replied", "notify"),
      "update.replied",
      {
        postId: POST_1,
        replyId: REPLY_1,
        threadMembershipId: ada.membershipId,
        authorMembershipId: ada.membershipId,
      },
      9004,
    );
    const sent = await waitFor(async () => {
      const mails = mailer.sent.filter((m) => m.tags?.includes("update.replied"));
      return mails.length === 3 ? mails : undefined;
    });
    expect(sent.map((m) => m.to).sort()).toEqual([
      "editor@example.com",
      "owner@example.com",
      "viewer@example.com",
    ]);
    expect(sent[0]?.subject).toBe("ada replied to an update");
    expect(sent[0]?.text).toContain(`http://acme.${CANON}/admin/updates/${POST_1}`);
    // Every staff member gets the row, including the two who cannot be emailed.
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.notification
           WHERE event_type = 'update.replied' AND cadence = 'instant'`,
        )
      )[0]?.n,
    ).toBe(5);
    // …and each is processed by its own `notify.send` job, the unemailable ones included.
    await waitFor(async () => {
      const [r] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM notify.notification
         WHERE event_type = 'update.replied' AND cadence = 'instant' AND sent_at IS NULL`,
      );
      return r?.n === 0 ? true : undefined;
    });
  });

  it("notify.deliver is the safety net for an instant row whose subscriber never ran", async () => {
    const [row] = await inboxRows(owner.membershipId);
    if (!row) throw new Error("no row");
    await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      tx.execute(
        `UPDATE notify.notification SET sent_at = NULL, created_at = now() - interval '2 minutes'
         WHERE id = '${row.id}'::uuid`,
      ),
    );
    mailer.clear();
    await runJob(JOB_DELIVER, { workspaceId: acmeId });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      ["owner@example.com", "ada viewed a document"],
    ]);
    expect((await inboxRows(owner.membershipId))[0]?.sentAt).not.toBeNull();
  });

  it("E3.10 FR1: a held or suspended workspace sends nothing; the row waits and goes once active", async () => {
    const setHolds = (holds: string) =>
      running.container.db.withHost((tx) =>
        tx.execute(`UPDATE core.workspace SET holds = '${holds}' WHERE id = '${acmeId}'`),
      );
    const [row] = await inboxRows(owner.membershipId);
    if (!row) throw new Error("no row");
    await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      tx.execute(
        `UPDATE notify.notification SET sent_at = NULL, created_at = now() - interval '2 minutes'
         WHERE id = '${row.id}'::uuid`,
      ),
    );
    mailer.clear();
    try {
      await setHolds("{billing}");
      expect(
        await deliverNotification(running.container.moduleServices, systemContext(acmeId), row.id),
      ).toBe("workspace_inactive");
      await runJob(JOB_DELIVER, { workspaceId: acmeId });
      expect(mailer.sent).toEqual([]);
      expect((await inboxRows(owner.membershipId))[0]?.sentAt).toBeNull();
    } finally {
      await setHolds("{}");
    }
    await runJob(JOB_DELIVER, { workspaceId: acmeId });
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.com"]);
    expect((await inboxRows(owner.membershipId))[0]?.sentAt).not.toBeNull();
  });
});

describe("daily digest", () => {
  /*
   * The digest job evaluates the schedule at `job.data.at` when given. Pending rows are moved to
   * a fixed instant in the past first, so each run below is a statement about a known clock and
   * not about what hour the suite happens to run at.
   */
  const EPOCH = "2020-01-01T00:00:00.000Z";

  it("bundles each member's daily rows at their own local hour", async () => {
    await rows(`UPDATE notify.notification SET created_at = '${EPOCH}' WHERE sent_at IS NULL`);
    mailer.clear();
    // 04:00: nobody's slot has passed since the rows appeared.
    await runJob(JOB_DIGEST, { workspaceId: acmeId, at: "2020-01-01T04:00:00Z" });
    expect(mailer.sent).toEqual([]);

    // The viewer moved their digest to 05:00 (UTC, the default timezone).
    await runJob(JOB_DIGEST, { workspaceId: acmeId, at: "2020-01-01T05:10:00Z" });
    expect(mailer.sent).toHaveLength(1);
    const digest = mailer.sent[0];
    expect(digest?.to).toBe("viewer@example.com");
    expect(digest?.subject).toBe("Acme: 2 new activities in your data room");
    expect(digest?.text).toContain("Here is what happened in Acme since your last digest.");
    expect(digest?.text).toContain("Document views (1)");
    expect(digest?.text).toContain("Document downloads (1)");
    expect(digest?.text).toContain("ada viewed a document");
    expect(digest?.text).toContain(`http://acme.${CANON}/admin/notify`);
    expect(digest?.tags).toEqual(["notify", "digest"]);
    // E2.6: its own stream (suppression applies, tracking never does) and ids-only ref.
    expect(digest?.stream).toBe("notification");
    expect(digest?.ref).toMatchObject({ kind: "notify_digest", membershipId: viewer.membershipId });
    const stored = await rows<{ count: number; messageId: string | null; kind: string }>(
      `SELECT count, message_id AS "messageId", kind FROM notify.digest
       WHERE membership_id = '${viewer.membershipId}'::uuid`,
    );
    expect(stored[0]?.count).toBe(2);
    expect(stored[0]?.kind).toBe("daily");
    expect(stored[0]?.messageId).not.toBeNull();
    expect((await inboxRows(viewer.membershipId)).every((r) => r.sentAt !== null)).toBe(true);

    // Running again has nothing left to bundle.
    mailer.clear();
    await runJob(JOB_DIGEST, { workspaceId: acmeId, at: "2020-01-01T05:20:00Z" });
    expect(mailer.sent).toEqual([]);
  });

  it("the default hour covers everyone else; the unemailable get their rows marked processed", async () => {
    mailer.clear();
    await runJob(JOB_DIGEST, { workspaceId: acmeId, at: "2020-01-01T08:10:00Z" });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([
      "editor@example.com",
      "owner@example.com",
    ]);
    expect(mailer.sent[0]?.subject).toBe("Acme: 1 new activity in your data room");
    for (const m of [quiet, ghost]) {
      expect((await inboxRows(m.membershipId)).every((r) => r.sentAt !== null)).toBe(true);
    }
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.digest
           WHERE membership_id IN ('${quiet.membershipId}'::uuid, '${ghost.membershipId}'::uuid)`,
        )
      )[0]?.n,
    ).toBe(0);
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.notification WHERE sent_at IS NULL`,
        )
      )[0]?.n,
    ).toBe(0);
  });
});

describe("inbox", () => {
  it("each member reads their own rows and marks them read", async () => {
    const inbox = await json<Inbox>(
      await request("acme", "/api/v1/notify/inbox?limit=50", { cookie: viewer.cookie }),
    );
    expect(inbox.items.map((i) => i.eventType)).toEqual([
      "update.replied",
      "document.downloaded",
      "document.viewed",
    ]);
    expect(inbox.unread).toBe(3);
    const marked = await request("acme", "/api/v1/notify/inbox/read", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({}),
    });
    expect(await json(marked)).toEqual({ updated: 3 });
    const after = await json<Inbox>(
      await request("acme", "/api/v1/notify/inbox", { cookie: viewer.cookie }),
    );
    expect(after.unread).toBe(0);
    expect(after.items.every((i) => i.readAt !== null)).toBe(true);
    // Marking twice changes nothing.
    expect(
      await json(
        await request("acme", "/api/v1/notify/inbox/read", {
          method: "POST",
          cookie: viewer.cookie,
          body: JSON.stringify({}),
        }),
      ),
    ).toEqual({ updated: 0 });
  });

  it("one admin can neither read nor mark another admin's inbox (RLS, not a permission)", async () => {
    const editorRows = await inboxRows(editor.membershipId);
    const target = editorRows[0];
    if (!target) throw new Error("no editor row");

    // Through the API: the ids belong to someone else, so nothing is updated.
    const attempt = await request("acme", "/api/v1/notify/inbox/read", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({ ids: editorRows.map((r) => r.id) }),
    });
    expect(await json(attempt)).toEqual({ updated: 0 });
    const editorInbox = await json<Inbox>(
      await request("acme", "/api/v1/notify/inbox", { cookie: editor.cookie }),
    );
    expect(editorInbox.unread).toBe(editorRows.length);

    // And underneath: the RLS policies fence a staff actor to their own membership.
    const asViewer = staffContext(viewer.membershipId);
    const otherRows = await rows<{ id: string }>(
      `SELECT id FROM notify.notification WHERE membership_id = '${editor.membershipId}'::uuid`,
      asViewer,
    );
    expect(otherRows).toEqual([]);
    const own = await rows<{ id: string }>(`SELECT id FROM notify.notification`, asViewer);
    expect(own.map((r) => r.id).sort()).toEqual(
      (await inboxRows(viewer.membershipId)).map((r) => r.id).sort(),
    );
    const updated = await running.container.db.withTenant(asViewer, async (tx) => {
      const r = await tx.execute(
        `UPDATE notify.notification SET read_at = now() WHERE id = '${target.id}'::uuid RETURNING id`,
      );
      return r.rows.length;
    });
    expect(updated).toBe(0);
  });
});

describe("tenancy + audit", () => {
  it("another workspace sees none of this and this workspace's session is unknown there", async () => {
    const empty = await json<Inbox>(
      await request("globex", "/api/v1/notify/inbox", { cookie: globexOwner.cookie }),
    );
    expect(empty).toEqual({ items: [], unread: 0, nextCursor: null });
    for (const [method, path] of [
      ["GET", "/api/v1/notify/preferences"],
      ["GET", "/api/v1/notify/inbox"],
    ] as const) {
      expect((await request("globex", path, { method, cookie: owner.cookie })).status, path).toBe(
        404,
      );
    }
    const ids = (await inboxRows(editor.membershipId)).map((r) => r.id);
    const crossTenant = await request("globex", "/api/v1/notify/inbox/read", {
      method: "POST",
      cookie: globexOwner.cookie,
      body: JSON.stringify({ ids }),
    });
    expect(await json(crossTenant)).toEqual({ updated: 0 });
    expect(
      await rows<{ id: string }>(`SELECT id FROM notify.notification`, systemContext(globexId)),
    ).toEqual([]);
  });

  it("the audit trail carries preference changes, sends and digests", async () => {
    const audit = await rows<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit.event
       WHERE action IN ('notify.preferences_changed', 'notification.sent', 'notification.digest_sent')
       GROUP BY action ORDER BY action`,
    );
    expect(Object.fromEntries(audit.map((r) => [r.action, r.n]))).toEqual({
      "notify.preferences_changed": 5,
      // …plus one: the row the E3.10 FR1 hold test sent once its workspace was active again.
      "notification.sent": 6,
      "notification.digest_sent": 3,
    });
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'notification.created'`,
      );
      return (r.rows as { n: number }[])[0]?.n;
    });
    // One instant row per fan-out that produced one: the view, the two downloads, five replies.
    expect(outbox).toBe(8);
  });
});

// --- E2.6 ---------------------------------------------------------------------------------------

/** Stamps (or backdates) an actor's sessions' `auth_time` — what a step-up writes. */
async function markFresh(actor: Actor, workspaceId: string, ageMs = 0): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
      systemContext(workspaceId),
    )
  )[0]?.userId;
  expect(userId).toBeDefined();
  const updated = await running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds' WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    return r.rows.length;
  });
  expect(updated).toBeGreaterThan(0);
}

interface Channel {
  id: string;
  kind: string;
  name: string;
  urlHint: string;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  failureCount: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}

const SECRET_URL = "https://hooks.slack.com/services/T0INITECH/B0DEALS/s3cretT0kenAbcd1234";
const REVOKED_URL = "https://hooks.slack.com/services/T0INITECH/B0GONE/revokedT0kenZzzz9876";
const FLAKY_URL = "https://hooks.slack.com/services/T0INITECH/B0FLAKY/flakyT0kenQqqq5555";

describe("E2.6", () => {
  let initechId: string;
  let boss: Actor;
  let deputy: Actor;
  let clerk: Actor;
  let nyc: Actor;
  let weekly: Actor;
  let sleepy: Actor;
  let bounced: Actor;
  let eve: Actor;
  let finn: Actor;
  let dealsChannel: Channel;

  const ws = () => initechId;
  const inI = (sql: string) => rows(sql, systemContext(initechId));
  const api = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    request("initech", `/api/v1/notify${path}`, init);
  const iRows = (membershipId: string) =>
    rows<Row & { emailOutcome: string | null; deferredUntil: string | null }>(
      `SELECT id, event_type AS "eventType", cadence, sent_at AS "sentAt", resource_id AS "resourceId",
         email_outcome AS "emailOutcome", deferred_until AS "deferredUntil"
       FROM notify.notification WHERE membership_id = '${membershipId}'::uuid ORDER BY created_at`,
      systemContext(initechId),
    );
  const putPrefs = async (actor: Actor, body: unknown) => {
    const res = await api("/preferences", {
      method: "PUT",
      cookie: actor.cookie,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return json<Preferences>(res);
  };

  beforeAll(async () => {
    initechId = (await createWorkspace(running.container.db, { slug: "initech", name: "Initech" }))
      .id;
    boss = await member("initech", initechId, "boss@initech.test", "staff", "owner");
    deputy = await member("initech", initechId, "deputy@initech.test", "staff", "admin");
    clerk = await member("initech", initechId, "clerk@initech.test", "staff", "editor");
    nyc = await member("initech", initechId, "nyc@initech.test", "staff", "viewer");
    weekly = await member("initech", initechId, "weekly@initech.test", "staff", "viewer");
    sleepy = await member("initech", initechId, "sleepy@initech.test", "staff", "viewer");
    bounced = await member("initech", initechId, "bounced@initech.test", "staff", "viewer");
    eve = await member("initech", initechId, "eve@investor.test", "external", "investor");
    finn = await member("initech", initechId, "finn@investor.test", "external", "investor");
    mailer.clear();
  }, 120_000);

  describe("channels: notify.manage, step-up, and a URL that never comes back", () => {
    it("owner and admin hold notify.manage; an editor is refused, an investor sees nothing", async () => {
      const list = await api("/channels", { cookie: deputy.cookie });
      expect(list.status).toBe(200);
      expect(await json(list)).toEqual({ channels: [] });
      const asEditor = await api("/channels", { cookie: clerk.cookie });
      expect(asEditor.status).toBe(403);
      expect((await json<{ error: { permission: string } }>(asEditor)).error.permission).toBe(
        "notify.manage",
      );
      for (const [method, path] of [
        ["GET", "/channels"],
        ["POST", "/channels"],
        ["PATCH", `/channels/${randomUUID()}`],
        ["DELETE", `/channels/${randomUUID()}`],
        ["POST", `/channels/${randomUUID()}/test`],
      ] as const) {
        const res = await api(path, {
          method,
          cookie: eve.cookie,
          ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });

    it("a URL the chat adapter refuses is rejected before storage, without quoting it back", async () => {
      await markFresh(boss, ws());
      const evil = "https://evil.example.test/services/leak-me-please";
      const res = await api("/channels", {
        method: "POST",
        cookie: boss.cookie,
        body: JSON.stringify({ name: "Evil", url: evil, eventTypes: ["analytics.hot_lead"] }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("validation_failed");
      expect(text).not.toContain("leak-me-please");
      expect(text).not.toContain("evil.example.test");
      expect(await inI(`SELECT id FROM notify.channel`)).toEqual([]);
    });

    it("creates a channel: 201, the URL encrypted at rest and absent from every response and audit row", async () => {
      const res = await api("/channels", {
        method: "POST",
        cookie: boss.cookie,
        body: JSON.stringify({
          name: "#deals",
          url: SECRET_URL,
          eventTypes: [
            "round.interest_submitted",
            "analytics.hot_lead",
            "round.commitment_created",
            "round.interest_submitted",
          ],
        }),
      });
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain("s3cretT0ken");
      expect(text).not.toContain("hooks.slack.com");
      dealsChannel = JSON.parse(text) as Channel;
      expect(dealsChannel).toMatchObject({
        kind: "slack",
        name: "#deals",
        urlHint: "1234",
        enabled: true,
        failureCount: 0,
        disabledReason: null,
      });
      // Deduplicated on write.
      expect([...dealsChannel.eventTypes].sort()).toEqual([
        "analytics.hot_lead",
        "round.commitment_created",
        "round.interest_submitted",
      ]);

      const listText = await (await api("/channels", { cookie: boss.cookie })).text();
      expect(listText).toContain(dealsChannel.id);
      expect(listText).not.toContain("s3cretT0ken");

      // At rest: ciphertext under a `notify-chat` key, never the plaintext.
      const stored = await inI(
        `SELECT position(convert_to('s3cretT0ken', 'UTF8') in url_enc) AS pos,
           encryption->>'keyId' AS "keyId", url_hint AS hint
         FROM notify.channel WHERE id = '${dealsChannel.id}'::uuid`,
      );
      expect(stored[0]).toMatchObject({ pos: 0, hint: "1234" });
      const key = await inI(
        `SELECT purpose FROM core.workspace_key WHERE id = '${(stored[0] as { keyId: string }).keyId}'::uuid`,
      );
      expect(key[0]).toMatchObject({ purpose: "notify-chat" });
      const leaked = await inI(
        `SELECT count(*)::int AS n FROM audit.event WHERE meta::text LIKE '%hooks.slack.com%' OR meta::text LIKE '%s3cretT0ken%'`,
      );
      expect(leaked[0]).toMatchObject({ n: 0 });
      const audited = await inI(
        `SELECT action FROM audit.event WHERE resource_id = '${dealsChannel.id}'::uuid`,
      );
      expect(audited.map((r) => (r as { action: string }).action)).toContain(
        "notify.channel_created",
      );
    });

    it("create, re-point and delete need a fresh session; rename and toggle do not", async () => {
      await markFresh(boss, ws(), 30 * 60_000);
      const create = await api("/channels", {
        method: "POST",
        cookie: boss.cookie,
        body: JSON.stringify({ name: "late", url: SECRET_URL, eventTypes: [] }),
      });
      expect(create.status).toBe(403);
      expect((await json<{ error: { code: string } }>(create)).error.code).toBe("step_up_required");
      const repoint = await api(`/channels/${dealsChannel.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ url: REVOKED_URL }),
      });
      expect(repoint.status).toBe(403);
      expect((await json<{ error: { code: string } }>(repoint)).error.code).toBe(
        "step_up_required",
      );
      const del = await api(`/channels/${dealsChannel.id}`, {
        method: "DELETE",
        cookie: boss.cookie,
      });
      expect(del.status).toBe(403);
      const rename = await api(`/channels/${dealsChannel.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ name: "#deal-flow" }),
      });
      expect(rename.status).toBe(200);
      expect(await json<Channel>(rename)).toMatchObject({ name: "#deal-flow", urlHint: "1234" });
      // Still pointing at the original webhook: the refused re-point changed nothing.
      await markFresh(boss, ws());
    });

    it("re-pointing with a fresh session validates, re-encrypts and never echoes", async () => {
      const bad = await api(`/channels/${dealsChannel.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ url: "http://hooks.slack.com/services/plain" }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain("/services/plain");
      const ok = await api(`/channels/${dealsChannel.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ url: SECRET_URL.replace("1234", "4321") }),
      });
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).not.toContain("s3cretT0ken");
      expect((JSON.parse(body) as Channel).urlHint).toBe("4321");
      // Put it back for the fan-out tests.
      await api(`/channels/${dealsChannel.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ url: SECRET_URL }),
      });
    });
  });

  describe("channel fan-out through the chat port", () => {
    let revoked: Channel;
    let flaky: Channel;

    beforeAll(async () => {
      await markFresh(deputy, ws());
      const make = async (name: string, url: string, eventTypes: string[]) => {
        const res = await api("/channels", {
          method: "POST",
          cookie: deputy.cookie,
          body: JSON.stringify({ name, url, eventTypes }),
        });
        expect(res.status).toBe(201);
        return json<Channel>(res);
      };
      revoked = await make("#gone", REVOKED_URL, ["round.verification_requested"]);
      flaky = await make("#flaky", FLAKY_URL, ["round.commitment_created"]);
      chatAnswers.set(REVOKED_URL, { ok: false, reason: "not_found", detail: "no_service" });
    });

    it("an interest submission posts once to the subscribed channel, with the investor's name", async () => {
      posts.length = 0;
      const submissionId = randomUUID();
      const roundId = randomUUID();
      const payload = { submissionId, roundId, membershipId: eve.membershipId };
      await publishOutbox(initechId, "round.interest_submitted", payload);
      const post = await waitFor(async () => posts.find((p) => p.url === SECRET_URL));
      expect(post.message.text).toBe("eve indicated interest in the round in Initech.");
      expect(post.message.link?.url).toBe(`http://initech.${CANON}/admin/round/rounds/${roundId}`);
      // Only #deals subscribes to interest.
      expect(posts.filter((p) => p.url !== SECRET_URL)).toEqual([]);
      // A redelivered event finds its delivery row and queues nothing new.
      await deliver(
        handlerFor("round.interest_submitted", "notify"),
        "round.interest_submitted",
        payload,
        9101,
        initechId,
      );
      await runJob(JOB_CHANNELS, { workspaceId: initechId });
      expect(posts.filter((p) => p.url === SECRET_URL)).toHaveLength(1);
      const [delivery] = await inI(
        `SELECT status, attempts FROM notify.channel_delivery WHERE source_key = 'round.interest_submitted:${submissionId}'`,
      );
      expect(delivery).toMatchObject({ status: "sent", attempts: 1 });
      const [ch] = await inI(
        `SELECT last_success_at IS NOT NULL AS ok, failure_count AS n FROM notify.channel WHERE id = '${dealsChannel.id}'::uuid`,
      );
      expect(ch).toMatchObject({ ok: true, n: 0 });
    });

    it("a hot lead reaches the channel and every analytics.read holder's inbox", async () => {
      posts.length = 0;
      mailer.clear();
      await publishOutbox(initechId, "analytics.hot_lead", {
        membershipId: eve.membershipId,
        score: 77,
      });
      const post = await waitFor(async () => posts.find((p) => p.url === SECRET_URL));
      expect(post.message.text).toBe("eve became a hot lead in Initech (score 77).");
      expect(post.message.link?.url).toBe(
        `http://initech.${CANON}/admin/analytics/members/${eve.membershipId}`,
      );
      const bossRow = await waitFor(async () =>
        (await iRows(boss.membershipId)).find((r) => r.eventType === "analytics.hot_lead"),
      );
      expect(bossRow).toMatchObject({ cadence: "instant", resourceId: eve.membershipId });
      const mail = await waitFor(async () =>
        mailer.sent.find((m) => m.to === "boss@initech.test" && m.subject.includes("hot lead")),
      );
      expect(mail.subject).toBe("eve became a hot lead");
      expect(mail.text).toContain("Engagement score: 77 of 100.");
    });

    it("a commitment that names no member says so; a staff member cannot be a hot lead", async () => {
      posts.length = 0;
      const commitmentId = randomUUID();
      await publishOutbox(initechId, "round.commitment_created", {
        commitmentId,
        roundId: randomUUID(),
      });
      const post = await waitFor(async () => posts.find((p) => p.url === SECRET_URL));
      expect(post.message.text).toBe("A new commitment was recorded in Initech.");
      const bossRow = await waitFor(async () =>
        (await iRows(boss.membershipId)).find((r) => r.resourceId === commitmentId),
      );
      expect(bossRow.eventType).toBe("round.commitment_created");

      const before = await inI(`SELECT count(*)::int AS n FROM notify.notification`);
      await deliver(
        handlerFor("analytics.hot_lead", "notify"),
        "analytics.hot_lead",
        { membershipId: clerk.membershipId, score: 99 },
        9102,
        initechId,
      );
      expect(await inI(`SELECT count(*)::int AS n FROM notify.notification`)).toEqual(before);
    });

    it(`a revoked webhook disables its channel after ${CHANNEL_DISABLE_AFTER} not_found posts`, async () => {
      for (let i = 0; i < CHANNEL_DISABLE_AFTER; i++) {
        await publishOutbox(initechId, "round.verification_requested", {
          verificationId: randomUUID(),
          membershipId: finn.membershipId,
        });
        await waitFor(async () => {
          const [c] = await inI(
            `SELECT failure_count AS n FROM notify.channel WHERE id = '${revoked.id}'::uuid`,
          );
          return (c as { n: number }).n === i + 1 ? true : undefined;
        });
      }
      const listed = await json<{ channels: Channel[] }>(
        await api("/channels", { cookie: boss.cookie }),
      );
      const gone = listed.channels.find((c) => c.id === revoked.id);
      expect(gone).toMatchObject({
        enabled: false,
        disabledReason: "not_found",
        failureCount: CHANNEL_DISABLE_AFTER,
        lastError: "not_found: no_service",
      });
      expect(JSON.stringify(listed)).not.toContain("revokedT0ken");
      const audit = await inI(
        `SELECT action, meta->>'reason' AS reason FROM audit.event WHERE resource_id = '${revoked.id}'::uuid AND action = 'notify.channel_disabled'`,
      );
      expect(audit).toEqual([{ action: "notify.channel_disabled", reason: "not_found" }]);
      // Disabled: the next event queues nothing for it.
      const postsBefore = posts.filter((p) => p.url === REVOKED_URL).length;
      const verificationId = randomUUID();
      await deliver(
        handlerFor("round.verification_requested", "notify"),
        "round.verification_requested",
        { verificationId, membershipId: finn.membershipId },
        9103,
        initechId,
      );
      expect(
        await inI(
          `SELECT id FROM notify.channel_delivery WHERE source_key = 'round.verification_requested:${verificationId}'`,
        ),
      ).toEqual([]);
      expect(posts.filter((p) => p.url === REVOKED_URL)).toHaveLength(postsBefore);

      // Re-enabling clears the count and the reason.
      const back = await api(`/channels/${revoked.id}`, {
        method: "PATCH",
        cookie: boss.cookie,
        body: JSON.stringify({ enabled: true }),
      });
      expect(await json<Channel>(back)).toMatchObject({
        enabled: true,
        disabledReason: null,
        failureCount: 0,
      });
    });

    it("unavailable and rate_limited are retried with backoff, not counted toward disabling", async () => {
      chatAnswers.set(FLAKY_URL, { ok: false, reason: "rate_limited", retryAfterMs: 120_000 });
      const commitmentId = randomUUID();
      await publishOutbox(initechId, "round.commitment_created", {
        commitmentId,
        roundId: randomUUID(),
        membershipId: finn.membershipId,
      });
      const key = `round.commitment_created:${commitmentId}`;
      const first = await waitFor(async () => {
        const [d] = await inI(
          `SELECT status, attempts, next_attempt_at > now() + interval '90 seconds' AS later FROM notify.channel_delivery WHERE source_key = '${key}' AND channel_id = '${flaky.id}'::uuid`,
        );
        return (d as { attempts: number } | undefined)?.attempts === 1 &&
          (d as { status: string }).status === "pending"
          ? d
          : undefined;
      });
      expect(first).toMatchObject({ later: true });
      const [c1] = await inI(
        `SELECT failure_count AS n, enabled FROM notify.channel WHERE id = '${flaky.id}'::uuid`,
      );
      expect(c1).toMatchObject({ n: 0, enabled: true });

      // The service recovers; the retry is due; the minute sweep posts it.
      chatAnswers.delete(FLAKY_URL);
      await inI(
        `UPDATE notify.channel_delivery SET next_attempt_at = now() - interval '1 second' WHERE source_key = '${key}'`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      const [d2] = await inI(
        `SELECT status, attempts FROM notify.channel_delivery WHERE source_key = '${key}' AND channel_id = '${flaky.id}'::uuid`,
      );
      expect(d2).toMatchObject({ status: "sent", attempts: 2 });
      expect(posts.filter((p) => p.url === FLAKY_URL).at(-1)?.message.text).toBe(
        "finn committed to the round in Initech.",
      );
    });

    it("the test route posts now and reports what the chat service said", async () => {
      posts.length = 0;
      const ok = await api(`/channels/${dealsChannel.id}/test`, {
        method: "POST",
        cookie: deputy.cookie,
      });
      expect(await json(ok)).toEqual({ ok: true, reason: null, detail: null });
      expect(posts[0]?.message.text).toContain("Test message from Initech");
      chatAnswers.set(SECRET_URL, { ok: false, reason: "not_found", detail: "no_service" });
      const bad = await api(`/channels/${dealsChannel.id}/test`, {
        method: "POST",
        cookie: deputy.cookie,
      });
      expect(await json(bad)).toEqual({
        ok: false,
        reason: "not_found",
        detail: "not_found: no_service",
      });
      chatAnswers.delete(SECRET_URL);
      // A failed test is reported, not counted toward disabling.
      const [c] = await inI(
        `SELECT failure_count AS n, enabled FROM notify.channel WHERE id = '${dealsChannel.id}'::uuid`,
      );
      expect(c).toMatchObject({ n: 0, enabled: true });
      expect(
        (await api(`/channels/${randomUUID()}/test`, { method: "POST", cookie: deputy.cookie }))
          .status,
      ).toBe(404);
    });

    it("deleting a channel removes it and its queue", async () => {
      await markFresh(deputy, ws());
      const del = await api(`/channels/${flaky.id}`, { method: "DELETE", cookie: deputy.cookie });
      expect(del.status).toBe(200);
      expect(
        await inI(`SELECT id FROM notify.channel_delivery WHERE channel_id = '${flaky.id}'::uuid`),
      ).toEqual([]);
      expect(
        (await api(`/channels/${flaky.id}`, { method: "DELETE", cookie: deputy.cookie })).status,
      ).toBe(404);
    });
  });

  describe("digests in the member's own timezone", () => {
    it("a New York 08:00 daily digest waits for 08:00 New York, and catches up a missed hour", async () => {
      await putPrefs(nyc, {
        preferences: [{ eventType: "document.viewed", cadence: "daily" }],
        settings: { timezone: "America/New_York", digestHour: 8 },
      });
      const doc = randomUUID();
      await deliver(
        handlerFor("document.viewed", "notify"),
        "document.viewed",
        { documentId: doc, versionId: VERSION_1, membershipId: eve.membershipId, sessionId: null },
        9201,
        initechId,
      );
      // Monday 2020-01-06, 00:00Z = Sunday 19:00 in New York (EST, -5).
      await inI(
        `UPDATE notify.notification SET created_at = '2020-01-06T00:00:00Z' WHERE membership_id = '${nyc.membershipId}'::uuid AND sent_at IS NULL`,
      );
      mailer.clear();
      // 12:30Z = 07:30 New York: a UTC-08:00 digest would already have gone; this one waits.
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-06T12:30:00Z" });
      expect(mailer.sent.filter((m) => m.to === "nyc@initech.test")).toEqual([]);
      // 16:00Z = 11:00 New York: the 08:00 run never happened; this one catches up.
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-06T16:00:00Z" });
      const sent = mailer.sent.filter((m) => m.to === "nyc@initech.test");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe("Initech: 1 new activity in your data room");
      const [s1] = await inI(
        `SELECT last_daily_digest_at AS last FROM notify.member_settings WHERE membership_id = '${nyc.membershipId}'::uuid`,
      );
      expect(new Date((s1 as { last: string }).last).toISOString()).toBe(
        "2020-01-06T16:00:00.000Z",
      );

      // A row that arrives after today's digest waits for tomorrow's 08:00 New York (13:00Z).
      await deliver(
        handlerFor("document.viewed", "notify"),
        "document.viewed",
        {
          documentId: randomUUID(),
          versionId: VERSION_1,
          membershipId: eve.membershipId,
          sessionId: null,
        },
        9202,
        initechId,
      );
      await inI(
        `UPDATE notify.notification SET created_at = '2020-01-06T17:00:00Z' WHERE membership_id = '${nyc.membershipId}'::uuid AND sent_at IS NULL`,
      );
      mailer.clear();
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-07T12:59:00Z" });
      expect(mailer.sent.filter((m) => m.to === "nyc@initech.test")).toEqual([]);
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-07T13:00:00Z" });
      expect(mailer.sent.filter((m) => m.to === "nyc@initech.test")).toHaveLength(1);
    });

    it("a weekly cadence bundles on the chosen weekday only", async () => {
      await putPrefs(weekly, {
        preferences: [
          { eventType: "document.viewed", cadence: "weekly" },
          { eventType: "document.downloaded", cadence: "weekly" },
        ],
        settings: { weeklyDay: 3, digestHour: 9 },
      });
      const prefs = await json<Preferences>(await api("/preferences", { cookie: weekly.cookie }));
      expect(prefs.preferences.find((p) => p.eventType === "document.viewed")).toEqual({
        eventType: "document.viewed",
        cadence: "weekly",
        isDefault: false,
      });
      expect(prefs.settings).toMatchObject({ weeklyDay: 3, digestHour: 9, timezone: "UTC" });
      for (const [i, topic] of (["document.viewed", "document.downloaded"] as const).entries()) {
        await deliver(
          handlerFor(topic, "notify"),
          topic,
          {
            documentId: randomUUID(),
            versionId: VERSION_1,
            membershipId: eve.membershipId,
            ...(topic === "document.viewed" ? { sessionId: null } : { variant: "original" }),
          } as EventPayload<typeof topic>,
          9210 + i,
          initechId,
        );
      }
      const mine = await iRows(weekly.membershipId);
      expect(mine.filter((r) => r.cadence === "weekly" && r.sentAt === null)).toHaveLength(2);
      // Monday 2020-01-06.
      await inI(
        `UPDATE notify.notification SET created_at = '2020-01-06T00:00:00Z' WHERE membership_id = '${weekly.membershipId}'::uuid AND sent_at IS NULL AND cadence = 'weekly'`,
      );
      mailer.clear();
      // Tuesday 10:00 and Wednesday 08:59: not yet.
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-07T10:00:00Z" });
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-08T08:59:00Z" });
      expect(mailer.sent.filter((m) => m.to === "weekly@initech.test")).toEqual([]);
      // Wednesday 09:05.
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-08T09:05:00Z" });
      const sent = mailer.sent.filter((m) => m.to === "weekly@initech.test");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe("Initech: your week — 2 new activities");
      expect(sent[0]?.text).toContain("Here is what happened in Initech this week.");
      const [d] = await inI(
        `SELECT kind, count FROM notify.digest WHERE membership_id = '${weekly.membershipId}'::uuid`,
      );
      expect(d).toEqual({ kind: "weekly", count: 2 });
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-01-08T10:05:00Z" });
      expect(mailer.sent.filter((m) => m.to === "weekly@initech.test")).toHaveLength(1);
    });
  });

  describe("quiet hours", () => {
    it("hold back instant email (the inbox row appears at once) until the window ends", async () => {
      const tz = "Asia/Kolkata";
      const h = wallClock(new Date(), tz).hour;
      const set = await putPrefs(sleepy, {
        preferences: [],
        settings: { timezone: tz, quietHours: { start: h, end: (h + 2) % 24 } },
      });
      expect(set.settings).toMatchObject({
        timezone: tz,
        quietHours: { start: h, end: (h + 2) % 24 },
      });
      mailer.clear();
      const replyId = randomUUID();
      await deliver(
        handlerFor("update.replied", "notify"),
        "update.replied",
        {
          postId: POST_1,
          replyId,
          threadMembershipId: eve.membershipId,
          authorMembershipId: eve.membershipId,
        },
        9301,
        initechId,
      );
      // Everyone else is emailed; sleepy's row exists, unsent, deferred to the window's end.
      const others = await waitFor(async () => {
        const m = mailer.sent.filter((x) => x.tags?.includes("update.replied"));
        return m.some((x) => x.to === "boss@initech.test") ? m : undefined;
      });
      expect(others.map((m) => m.to)).not.toContain("sleepy@initech.test");
      const row = await waitFor(async () => {
        const r = (await iRows(sleepy.membershipId)).find((x) => x.eventType === "update.replied");
        return r?.deferredUntil ? r : undefined;
      });
      expect(row.sentAt).toBeNull();
      expect(new Date(row.deferredUntil as string).getTime()).toBeGreaterThan(Date.now());
      const inbox = await json<Inbox>(await api("/inbox", { cookie: sleepy.cookie }));
      expect(inbox.items.map((i) => i.id)).toContain(row.id);

      // The sweep leaves it alone while the hold stands…
      await inI(
        `UPDATE notify.notification SET created_at = now() - interval '2 minutes' WHERE id = '${row.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(mailer.sent.map((m) => m.to)).not.toContain("sleepy@initech.test");
      // …a due row still inside quiet hours is re-deferred rather than sent…
      await inI(
        `UPDATE notify.notification SET deferred_until = now() - interval '1 second' WHERE id = '${row.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(mailer.sent.map((m) => m.to)).not.toContain("sleepy@initech.test");
      const [again] = await iRows(sleepy.membershipId).then((r) =>
        r.filter((x) => x.id === row.id),
      );
      expect(new Date(again?.deferredUntil as string).getTime()).toBeGreaterThan(Date.now());
      // …and once the window has ended (moved away from now), the sweep sends it.
      await putPrefs(sleepy, {
        preferences: [],
        settings: { quietHours: { start: (h + 3) % 24, end: (h + 5) % 24 } },
      });
      await inI(
        `UPDATE notify.notification SET deferred_until = now() - interval '1 second' WHERE id = '${row.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      const mail = mailer.sent.find((m) => m.to === "sleepy@initech.test");
      expect(mail?.subject).toBe("eve replied to an update");
      const [done] = (await iRows(sleepy.membershipId)).filter((x) => x.id === row.id);
      expect(done).toMatchObject({ emailOutcome: "emailed", deferredUntil: null });
      expect(done?.sentAt).not.toBeNull();
    });
  });

  describe("the suppression list", () => {
    it("a suppressed address is processed without mail and never retried", async () => {
      suppressed.add("bounced@initech.test");
      mailer.clear();
      const replyId = randomUUID();
      const postId = randomUUID();
      await deliver(
        handlerFor("update.replied", "notify"),
        "update.replied",
        {
          postId,
          replyId,
          threadMembershipId: finn.membershipId,
          authorMembershipId: finn.membershipId,
        },
        9401,
        initechId,
      );
      const row = await waitFor(async () => {
        const r = (await iRows(bounced.membershipId)).find(
          (x) => x.resourceId === postId && x.sentAt !== null,
        );
        return r;
      });
      expect(row.emailOutcome).toBe("suppressed");
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(mailer.sent.map((m) => m.to)).not.toContain("bounced@initech.test");
      // A digest to a suppressed address: rows processed, no digest row, the stamp moves on.
      await deliver(
        handlerFor("document.viewed", "notify"),
        "document.viewed",
        {
          documentId: randomUUID(),
          versionId: VERSION_1,
          membershipId: finn.membershipId,
          sessionId: null,
        },
        9402,
        initechId,
      );
      await inI(
        `UPDATE notify.notification SET created_at = '2020-02-03T00:00:00Z' WHERE membership_id = '${bounced.membershipId}'::uuid AND sent_at IS NULL`,
      );
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-02-03T08:30:00Z" });
      expect(mailer.sent.map((m) => m.to)).not.toContain("bounced@initech.test");
      const pending = (await iRows(bounced.membershipId)).filter((r) => r.sentAt === null);
      expect(pending).toEqual([]);
      const digested = (await iRows(bounced.membershipId)).filter(
        (r) => r.eventType === "document.viewed",
      );
      expect(digested.every((r) => r.emailOutcome === "suppressed")).toBe(true);
      expect(
        await inI(
          `SELECT id FROM notify.digest WHERE membership_id = '${bounced.membershipId}'::uuid`,
        ),
      ).toEqual([]);
      suppressed.delete("bounced@initech.test");
    });
  });

  describe("delivery robustness: retries, starvation, digests, no mail inside a transaction", () => {
    let poison: Actor;
    let digesty: Actor;
    const aRows = (membershipId: string) =>
      rows<{
        id: string;
        resourceId: string | null;
        attempts: number;
        nextAttemptAt: string | null;
        lastError: string | null;
        sentAt: string | null;
        emailOutcome: string | null;
      }>(
        `SELECT id, resource_id AS "resourceId", attempts, next_attempt_at AS "nextAttemptAt",
           last_error AS "lastError", sent_at AS "sentAt", email_outcome AS "emailOutcome"
         FROM notify.notification WHERE membership_id = '${membershipId}'::uuid ORDER BY created_at`,
        systemContext(initechId),
      );
    const triesTo = (to: string) => attempted.filter((m) => m.to === to).length;
    /** A fresh unsent instant row written straight to the table (no outbox event). */
    const insertInstant = async (membershipId: string, createdAgo: string): Promise<string> => {
      const [r] = await inI(
        `INSERT INTO notify.notification (workspace_id, membership_id, event_type, dedupe_key,
           actor_membership_id, resource_kind, resource_id, payload, cadence, created_at)
         VALUES ('${initechId}'::uuid, '${membershipId}'::uuid, 'update.replied', 'test:' || gen_random_uuid(),
           '${finn.membershipId}'::uuid, 'post', gen_random_uuid(), '{}'::jsonb, 'instant', now() - interval '${createdAgo}')
         RETURNING id`,
      );
      return (r as { id: string }).id;
    };

    beforeAll(async () => {
      poison = await member("initech", initechId, "poison@initech.test", "staff", "viewer");
      digesty = await member("initech", initechId, "digesty@initech.test", "staff", "viewer");
    }, 60_000);

    afterAll(() => {
      failing.clear();
      afterSend = undefined;
    });

    it("a send that keeps failing backs off, then is closed as failed", async () => {
      failing.add("poison@initech.test");
      const postId = randomUUID();
      await deliver(
        handlerFor("update.replied", "notify"),
        "update.replied",
        {
          postId,
          replyId: randomUUID(),
          threadMembershipId: finn.membershipId,
          authorMembershipId: finn.membershipId,
        },
        9501,
        initechId,
      );
      const first = await waitFor(async () => {
        const r = (await aRows(poison.membershipId)).find((x) => x.resourceId === postId);
        return r && r.attempts >= 1 && r.lastError !== null ? r : undefined;
      });
      // Not processed, an error *code* (never the provider's text, which quotes the address),
      // and the next attempt pushed out by the backoff.
      expect(first).toMatchObject({ attempts: 1, sentAt: null, emailOutcome: null });
      expect(first.lastError).toBe("rejected");
      expect(new Date(first.nextAttemptAt as string).getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
      await inI(
        `UPDATE notify.notification SET created_at = now() - interval '2 minutes' WHERE id = '${first.id}'::uuid`,
      );
      // The sweep leaves it alone while the backoff runs…
      const tries = triesTo("poison@initech.test");
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(triesTo("poison@initech.test")).toBe(tries);
      // …tries again once it is due…
      await inI(
        `UPDATE notify.notification SET next_attempt_at = now() - interval '1 second' WHERE id = '${first.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(triesTo("poison@initech.test")).toBe(tries + 1);
      expect((await aRows(poison.membershipId)).find((x) => x.id === first.id)?.attempts).toBe(2);
      // …and the last allowed attempt closes the row for good.
      await inI(
        `UPDATE notify.notification SET attempts = ${NOTIFY_MAX_ATTEMPTS - 1}, next_attempt_at = now() - interval '1 second' WHERE id = '${first.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      const closed = (await aRows(poison.membershipId)).find((x) => x.id === first.id);
      expect(closed).toMatchObject({ attempts: NOTIFY_MAX_ATTEMPTS, emailOutcome: "failed" });
      expect(closed?.sentAt).not.toBeNull();
      await inI(
        `UPDATE notify.notification SET next_attempt_at = now() - interval '1 second' WHERE id = '${first.id}'::uuid`,
      );
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(triesTo("poison@initech.test")).toBe(tries + 2);
    });

    it("a pile of failing rows cannot starve a fresh alert", async () => {
      // More poisoned rows than one sweep takes (200), all older than the fresh one and all due.
      await inI(
        `INSERT INTO notify.notification (workspace_id, membership_id, event_type, dedupe_key,
           actor_membership_id, resource_kind, resource_id, payload, cadence, created_at,
           attempts, next_attempt_at)
         SELECT '${initechId}'::uuid, '${poison.membershipId}'::uuid, 'update.replied', 'poison:' || g,
           '${finn.membershipId}'::uuid, 'post', gen_random_uuid(), '{}'::jsonb, 'instant',
           now() - interval '1 day', 1, now() - interval '1 minute'
         FROM generate_series(1, 210) g`,
      );
      const fresh = await insertInstant(clerk.membershipId, "2 minutes");
      mailer.clear();
      await runJob(JOB_DELIVER, { workspaceId: initechId });
      expect(mailer.sent.filter((m) => m.ref?.id === fresh).map((m) => m.to)).toEqual([
        "clerk@initech.test",
      ]);
      await inI(`DELETE FROM notify.notification WHERE dedupe_key LIKE 'poison:%'`);
    });

    it("the notification.created subscriber queues the send; no mail goes out inside the outbox transaction", async () => {
      const id = await insertInstant(clerk.membershipId, "0 seconds");
      let handlerOpen = true;
      let sentInsideHandler = false;
      afterSend = (m) => {
        if (m.ref?.id === id && handlerOpen) sentInsideHandler = true;
      };
      await deliver(
        handlerFor("notification.created", "notify"),
        "notification.created",
        { notificationId: id, membershipId: clerk.membershipId, type: "update.replied" },
        9502,
        initechId,
      );
      handlerOpen = false;
      expect(sentInsideHandler).toBe(false);
      // The queued `notify.send` job emails it moments later, outside any transaction.
      const mail = await waitFor(async () => mailer.sent.find((m) => m.ref?.id === id));
      expect(mail.to).toBe("clerk@initech.test");
      expect(mail.idempotencyKey).toBe(`notify:${id}`);
      afterSend = undefined;
    });

    /*
     * Pool discipline: with a one-connection pool, delivery must still finish. Any step that
     * takes a second pool connection while holding a transaction (the workspace lookup used to
     * sit inside the claim transaction) waits for itself forever.
     */
    it("instant delivery and digests finish on a one-connection pool (no connection taken while holding one)", async () => {
      const tiny = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
      try {
        const base = running.container.moduleServices;
        // The live services with only the pool (and a DB-free mailer) swapped out.
        const services = new Proxy(base, {
          get(target, prop) {
            if (prop === "db") return tiny;
            if (prop === "mailer") return mailer;
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
        const ctx = systemContext(initechId);
        const ids = [
          await insertInstant(clerk.membershipId, "0 seconds"),
          await insertInstant(boss.membershipId, "0 seconds"),
          await insertInstant(clerk.membershipId, "0 seconds"),
        ];
        const within = <T>(promise: Promise<T>, ms: number) =>
          Promise.race([
            promise,
            new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), ms)),
          ]);
        const outcomes = await within(
          Promise.all(ids.map((id) => deliverNotification(services, ctx, id))),
          10_000,
        );
        expect(outcomes).not.toBe("stuck");
        expect(outcomes).toEqual(["sent", "sent", "sent"]);
        const digest = await within(
          sendDigestFor(services, ctx, clerk.membershipId, "daily", undefined, new Date()),
          10_000,
        );
        expect(digest).not.toBe("stuck");
      } finally {
        await tiny.close();
      }
    });

    it("a digest whose acknowledgement was lost is re-sent once, under the same idempotency key", async () => {
      await putPrefs(digesty, {
        preferences: [{ eventType: "document.viewed", cadence: "daily" }],
        settings: { timezone: "UTC", digestHour: 8 },
      });
      await deliver(
        handlerFor("document.viewed", "notify"),
        "document.viewed",
        {
          documentId: randomUUID(),
          versionId: VERSION_1,
          membershipId: finn.membershipId,
          sessionId: null,
        },
        9503,
        initechId,
      );
      await inI(
        `UPDATE notify.notification SET created_at = '2020-03-02T00:00:00Z' WHERE membership_id = '${digesty.membershipId}'::uuid AND sent_at IS NULL`,
      );
      let lost = 0;
      afterSend = (m) => {
        if (m.to === "digesty@initech.test" && lost === 0) {
          lost += 1;
          throw new Error("connection reset after the provider accepted the message");
        }
      };
      mailer.clear();
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-03-02T08:30:00Z" });
      const digestOf = () =>
        inI(
          `SELECT id, sent_at AS "sentAt", slot, attempts FROM notify.digest WHERE membership_id = '${digesty.membershipId}'::uuid`,
        ) as Promise<{ id: string; sentAt: string | null; slot: string; attempts: number }[]>;
      // The provider took it, but we never heard: the claim stands, nothing is marked sent.
      const [claimed] = await digestOf();
      expect(claimed).toMatchObject({
        sentAt: null,
        slot: "2020-03-02T08:00:00.000Z",
        attempts: 1,
      });
      expect(
        (await aRows(digesty.membershipId)).filter((r) => r.sentAt === null).length,
      ).toBeGreaterThan(0);
      // The next run finishes the same digest, under the same key and ref, and marks it.
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-03-02T09:30:00Z" });
      const sends = mailer.sent.filter((m) => m.to === "digesty@initech.test");
      expect(sends).toHaveLength(2);
      expect(sends[0]?.idempotencyKey).toBe(
        `notify:digest:${digesty.membershipId}:daily:2020-03-02T08:00:00.000Z`,
      );
      expect(sends[1]?.idempotencyKey).toBe(sends[0]?.idempotencyKey);
      expect(sends[1]?.ref).toEqual(sends[0]?.ref);
      expect(sends[0]?.ref?.id).toBe(claimed?.id);
      const done = await digestOf();
      expect(done).toHaveLength(1);
      expect(done[0]?.sentAt).not.toBeNull();
      expect((await aRows(digesty.membershipId)).filter((r) => r.sentAt === null)).toEqual([]);
      await runJob(JOB_DIGEST, { workspaceId: initechId, at: "2020-03-02T10:30:00Z" });
      expect(mailer.sent.filter((m) => m.to === "digesty@initech.test")).toHaveLength(2);
      afterSend = undefined;
    });
  });

  describe("inbox paging, read-all and archive", () => {
    it("keyset pages walk every row exactly once, even when timestamps tie", async () => {
      const docs = Array.from({ length: 5 }, () => randomUUID());
      for (const [i, documentId] of docs.entries()) {
        await deliver(
          handlerFor("document.downloaded", "notify"),
          "document.downloaded",
          { documentId, versionId: VERSION_1, membershipId: eve.membershipId, variant: "original" },
          9500 + i,
          initechId,
        );
      }
      // Three of them at the very same microsecond: only the id can order them.
      await inI(
        `UPDATE notify.notification SET created_at = '2026-01-01T00:00:00.123456Z' WHERE membership_id = '${clerk.membershipId}'::uuid AND resource_id IN ('${docs[0]}'::uuid, '${docs[1]}'::uuid, '${docs[2]}'::uuid)`,
      );
      const all = (await iRows(clerk.membershipId)).map((r) => r.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const page: Inbox = await json<Inbox>(
          await api(`/inbox?limit=2${q}`, { cookie: clerk.cookie }),
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...all].sort());
      const bad = await api("/inbox?cursor=bm90LWEtY3Vyc29y", { cookie: clerk.cookie });
      expect(bad.status).toBe(400);
    });

    it("read-all marks what the screen showed and leaves a later arrival unread", async () => {
      const upTo = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 20));
      await deliver(
        handlerFor("document.downloaded", "notify"),
        "document.downloaded",
        {
          documentId: randomUUID(),
          versionId: VERSION_1,
          membershipId: eve.membershipId,
          variant: "original",
        },
        9510,
        initechId,
      );
      const before = await json<Inbox>(await api("/inbox", { cookie: clerk.cookie }));
      const res = await api("/inbox/read-all", {
        method: "POST",
        cookie: clerk.cookie,
        body: JSON.stringify({ upTo }),
      });
      expect((await json<{ updated: number }>(res)).updated).toBe(before.unread - 1);
      const after = await json<Inbox>(await api("/inbox", { cookie: clerk.cookie }));
      expect(after.unread).toBe(1);
      expect(after.items[0]?.readAt).toBeNull();
      // Without `upTo`: everything.
      await api("/inbox/read-all", { method: "POST", cookie: clerk.cookie, body: "{}" });
      expect((await json<Inbox>(await api("/inbox", { cookie: clerk.cookie }))).unread).toBe(0);
    });

    it("archive hides a row from the default view and only touches the caller's own rows", async () => {
      const inbox = await json<Inbox>(await api("/inbox", { cookie: clerk.cookie }));
      const target = inbox.items[0];
      if (!target) throw new Error("empty inbox");
      const res = await api("/inbox/archive", {
        method: "POST",
        cookie: clerk.cookie,
        body: JSON.stringify({ ids: [target.id] }),
      });
      expect(await json(res)).toEqual({ updated: 1 });
      const visible = await json<Inbox>(await api("/inbox", { cookie: clerk.cookie }));
      expect(visible.items.map((i) => i.id)).not.toContain(target.id);
      const withArchived = await json<Inbox>(
        await api("/inbox?archived=true", { cookie: clerk.cookie }),
      );
      expect(withArchived.items.find((i) => i.id === target.id)?.archivedAt).not.toBeNull();
      // Someone else's ids change nothing.
      const foreign = await api("/inbox/archive", {
        method: "POST",
        cookie: deputy.cookie,
        body: JSON.stringify({ ids: [target.id] }),
      });
      expect(await json(foreign)).toEqual({ updated: 0 });
      const restore = await api("/inbox/archive", {
        method: "POST",
        cookie: clerk.cookie,
        body: JSON.stringify({ ids: [target.id], archived: false }),
      });
      expect(await json(restore)).toEqual({ updated: 1 });
    });
  });

  describe("retention", () => {
    const setSettings = (patch: string) =>
      running.container.db.withHost((tx) =>
        tx.execute(
          `UPDATE core.workspace SET settings = coalesce(settings, '{}'::jsonb) || '${patch}'::jsonb WHERE id = '${initechId}'::uuid`,
        ),
      );

    it("drops rows older than notify.retentionDays, and nothing while under legal hold", async () => {
      await setSettings(`{"notify": {"retentionDays": 7}, "legal": {"legalHold": true}}`);
      const old = (await iRows(clerk.membershipId)).slice(0, 2).map((r) => r.id);
      await inI(
        `UPDATE notify.notification SET created_at = now() - interval '30 days' WHERE id IN (${old.map((id) => `'${id}'::uuid`).join(", ")})`,
      );
      const count = async () =>
        ((await inI(`SELECT count(*)::int AS n FROM notify.notification`))[0] as { n: number }).n;
      const before = await count();
      await runJob(JOB_RETENTION, { workspaceId: initechId });
      expect(await count()).toBe(before);

      await setSettings(`{"notify": {"retentionDays": 7}, "legal": {"legalHold": false}}`);
      await runJob(JOB_RETENTION, { workspaceId: initechId });
      const survivors = (await iRows(clerk.membershipId)).map((r) => r.id);
      for (const id of old) expect(survivors).not.toContain(id);
      // Rows from 2020 (the digest tests' clock) are older than seven days too.
      expect(
        await inI(
          `SELECT id FROM notify.notification WHERE created_at < now() - interval '7 days'`,
        ),
      ).toEqual([]);
      expect(await count()).toBeGreaterThan(0);
      // Another workspace's rows are untouched.
      expect(
        (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM notify.notification`))[0]?.n,
      ).toBeGreaterThan(0);
    });
  });

  describe("DSAR erasure", () => {
    it("erases what notify holds about a member and reports its step to the kernel", async () => {
      // Eve caused alerts earlier in this file (an interest submission and a hot lead, both
      // also posted to #deals). Publishing a fresh event here would race the erasure: an event
      // emitted before the request but dispatched after it re-creates what was just erased.
      expect(
        await inI(
          `SELECT id FROM notify.channel_delivery WHERE actor_membership_id = '${eve.membershipId}'::uuid`,
        ),
      ).not.toEqual([]);
      const caused = await inI(
        `SELECT count(*)::int AS n FROM notify.notification WHERE actor_membership_id = '${eve.membershipId}'::uuid`,
      );
      expect((caused[0] as { n: number }).n).toBeGreaterThan(0);

      await markFresh(boss, ws());
      const requested = await request("initech", "/api/v1/compliance/erasure-requests", {
        method: "POST",
        cookie: boss.cookie,
        body: JSON.stringify({ membershipId: eve.membershipId }),
      });
      expect(requested.status).toBe(201);
      const { id: requestId } = await json<{ id: string }>(requested);
      const step = await waitFor(async () => {
        const r = await inI(
          `SELECT counts FROM core.dsar_step WHERE request_id = '${requestId}'::uuid AND module = 'notify'`,
        );
        return r[0] as { counts: Record<string, number> } | undefined;
      });
      expect(step.counts["notificationsCaused"]).toBe((caused[0] as { n: number }).n);
      expect(step.counts["channelDeliveries"]).toBeGreaterThan(0);
      expect(
        await inI(
          `SELECT id FROM notify.notification WHERE actor_membership_id = '${eve.membershipId}'::uuid OR membership_id = '${eve.membershipId}'::uuid`,
        ),
      ).toEqual([]);
      expect(
        await inI(
          `SELECT id FROM notify.channel_delivery WHERE actor_membership_id = '${eve.membershipId}'::uuid`,
        ),
      ).toEqual([]);

      // A staff member: inbox, digests, preferences and settings all go; a channel they created
      // stays (workspace configuration) but forgets them.
      const hadRows = (await iRows(deputy.membershipId)).length;
      expect(hadRows).toBeGreaterThan(0);
      await putPrefs(deputy, {
        preferences: [{ eventType: "document.viewed", cadence: "off" }],
        settings: { timezone: "Europe/London" },
      });
      const second = await request("initech", "/api/v1/compliance/erasure-requests", {
        method: "POST",
        cookie: boss.cookie,
        body: JSON.stringify({ membershipId: deputy.membershipId }),
      });
      expect(second.status).toBe(201);
      const { id: secondId } = await json<{ id: string }>(second);
      await waitFor(async () => {
        const r = await inI(
          `SELECT 1 FROM core.dsar_step WHERE request_id = '${secondId}'::uuid AND module = 'notify'`,
        );
        return r[0];
      });
      expect(await iRows(deputy.membershipId)).toEqual([]);
      for (const table of ["preference", "member_settings", "digest"]) {
        expect(
          await inI(
            `SELECT 1 FROM notify.${table} WHERE membership_id = '${deputy.membershipId}'::uuid`,
          ),
          table,
        ).toEqual([]);
      }
      expect(
        await inI(
          `SELECT id FROM notify.channel WHERE created_by = '${deputy.membershipId}'::uuid`,
        ),
      ).toEqual([]);
      expect(
        ((await inI(`SELECT count(*)::int AS n FROM notify.channel`))[0] as { n: number }).n,
      ).toBeGreaterThan(0);
    });

    it("an event about an erased member, dispatched after the request, is dropped", async () => {
      // Eve (an investor) and deputy (staff) were erased above. Outbox events emitted before
      // those requests but delivered after them must not write the rows back.
      const postId = randomUUID();
      await deliver(
        handlerFor("update.replied", "notify"),
        "update.replied",
        {
          postId,
          replyId: randomUUID(),
          threadMembershipId: eve.membershipId,
          authorMembershipId: eve.membershipId,
        },
        9701,
        initechId,
      );
      expect(
        await inI(`SELECT id FROM notify.notification WHERE resource_id = '${postId}'::uuid`),
      ).toEqual([]);
      await deliver(
        handlerFor("analytics.hot_lead", "notify"),
        "analytics.hot_lead",
        { membershipId: eve.membershipId, score: 97 },
        9702,
        initechId,
      );
      expect(
        await inI(
          `SELECT id FROM notify.notification WHERE actor_membership_id = '${eve.membershipId}'::uuid OR resource_id = '${eve.membershipId}'::uuid`,
        ),
      ).toEqual([]);
      expect(
        await inI(
          `SELECT id FROM notify.channel_delivery WHERE actor_membership_id = '${eve.membershipId}'::uuid`,
        ),
      ).toEqual([]);
      // An erased staff member is no longer a recipient; everyone else still is.
      const other = randomUUID();
      await deliver(
        handlerFor("update.replied", "notify"),
        "update.replied",
        {
          postId: other,
          replyId: randomUUID(),
          threadMembershipId: finn.membershipId,
          authorMembershipId: finn.membershipId,
        },
        9703,
        initechId,
      );
      const recipients = (
        (await inI(
          `SELECT membership_id AS "membershipId" FROM notify.notification WHERE resource_id = '${other}'::uuid`,
        )) as { membershipId: string }[]
      ).map((r) => r.membershipId);
      expect(recipients).toContain(boss.membershipId);
      expect(recipients).not.toContain(deputy.membershipId);
    });
  });
});

/*
 * E3.1: a verified access request from a non-member alerts the staff who can decide it
 * (`access.manage`: owner and admin), unless it is no longer pending by the time the event is
 * dispatched — an auto-approved request, or one decided or deleted in between.
 */
describe("access requests (E3.1)", () => {
  async function insertRequest(status: "pending" | "approved", name: string): Promise<string> {
    const [row] = await rows<{ id: string }>(
      `INSERT INTO core.access_request (workspace_id, email, name, firm, reason, status, auto_approved, verified_at, expires_at)
       VALUES ('${acmeId}'::uuid, '${randomUUID()}@prospect.test', '${name}', 'Secret Firm LLC',
         'Private reason text', '${status}', ${status === "approved"}, now(), now() + interval '30 days')
       RETURNING id::text AS id`,
    );
    if (!row) throw new Error("no access_request row");
    return row.id;
  }
  const alertsFor = async (membershipId: string, id: string) =>
    (await inboxRows(membershipId)).filter(
      (r) => r.eventType === "access_request.submitted" && r.resourceId === id,
    );

  it("a pending request reaches access.manage holders only, named in the email, generic in the payload", async () => {
    mailer.clear();
    const id = await insertRequest("pending", "Grace Prospect");
    await publishOutbox(acmeId, "access_request.submitted", { accessRequestId: id });
    const [ownerRow] = await waitFor(async () => {
      const r = await alertsFor(owner.membershipId, id);
      return r.length > 0 ? r : undefined;
    });
    expect(ownerRow).toMatchObject({ cadence: "instant", resourceId: id });
    const [stored] = await rows<{ actor: string | null; kind: string; payload: unknown }>(
      `SELECT actor_membership_id AS actor, resource_kind AS kind, payload
       FROM notify.notification WHERE id = '${ownerRow?.id}'::uuid`,
    );
    // Ids only: the requester's name, address, firm and reason are never stored in notify.*.
    expect(stored).toEqual({
      actor: null,
      kind: "access_request",
      payload: { accessRequestId: id },
    });
    // editor and viewer do not hold access.manage.
    for (const m of [editor, viewer, quiet, ghost]) {
      expect(await alertsFor(m.membershipId, id)).toEqual([]);
    }
    const mail = await waitFor(async () =>
      mailer.sent.find(
        (m) => m.to === "owner@example.com" && m.subject.includes("requested access"),
      ),
    );
    expect(mail.subject).toBe("Grace Prospect requested access");
    expect(mail.text).toContain(`http://acme.${CANON}/admin/access-requests`);
    expect(mail.text).not.toContain("Secret Firm");
    expect(mail.text).not.toContain("Private reason");

    // The inbox names the requester (read from the live row), never "removed contact".
    const inbox = await json<Inbox>(
      await request("acme", "/api/v1/notify/inbox", { cookie: owner.cookie }),
    );
    expect(inbox.items.find((i) => i.resourceId === id)).toMatchObject({
      eventType: "access_request.submitted",
      actor: null,
      subjectName: "Grace Prospect",
      resourceKind: "access_request",
    });
    // Other alerts carry no subject name.
    expect(
      inbox.items.filter((i) => i.resourceId !== id).every((i) => i.subjectName === null),
    ).toBe(true);

    // A redelivered event dedupes on the request id.
    await deliver(
      handlerFor("access_request.submitted", "notify"),
      "access_request.submitted",
      { accessRequestId: id },
      9301,
    );
    expect(await alertsFor(owner.membershipId, id)).toHaveLength(1);
  });

  it("an auto-approved, since-decided or deleted request alerts nobody", async () => {
    const approved = await insertRequest("approved", "Auto Approved");
    const gone = randomUUID();
    const handler = handlerFor("access_request.submitted", "notify");
    await deliver(handler, "access_request.submitted", { accessRequestId: approved }, 9302);
    await deliver(handler, "access_request.submitted", { accessRequestId: gone }, 9303);
    const [n] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify.notification
       WHERE event_type = 'access_request.submitted' AND resource_id IN ('${approved}'::uuid, '${gone}'::uuid)`,
    );
    expect(n?.n).toBe(0);
  });
});

/*
 * E3.2: the daily `access-review.overdue` job. Its own workspaces (`hooli`, never reviewed and
 * created 100 days ago; `initrode`, 200 days old but reviewed today) and a fake clock a few days
 * ahead, so every other workspace in this file — created today — is not due and stays untouched.
 */
describe("overdue access review (E3.2)", () => {
  const DAY = 24 * 3600_000;
  let hooliId: string;
  let initrodeId: string;
  let hooliOwner: string;
  let hooliEditor: string;
  let hooliInvestor: string;
  /** A Wednesday noon UTC 1–7 days ahead: the same ISO week for a few hours either side. */
  let T: Date;

  async function provision(
    workspaceId: string,
    email: string,
    kind: "staff" | "external",
    role: "owner" | "editor" | "investor",
  ): Promise<string> {
    const deps = running.container.identityDeps;
    const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
    const m = await provisionMembership(deps, {
      workspaceId,
      userId: user.userId,
      kind,
      role,
      source: "test",
    });
    return m.id;
  }

  async function ageWorkspace(workspaceId: string, days: number): Promise<void> {
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.workspace SET created_at = now() - interval '${days} days' WHERE id = '${workspaceId}'::uuid`,
      ),
    );
  }

  const runAt = async (at: Date) => {
    const [job] = createAccessReviewJobs({
      deps: running.container.identityDeps,
      now: () => at,
    });
    if (!job) throw new Error("no job");
    await job.handler({
      id: `test-review-${at.getTime()}`,
      name: job.name,
      data: {},
      signal: new AbortController().signal,
    });
  };

  const overdueAudits = (workspaceId: string) =>
    rows<{ actorKind: string; resourceId: string | null; meta: Record<string, unknown> }>(
      `SELECT actor_kind AS "actorKind", resource_id AS "resourceId", meta FROM audit.event
       WHERE workspace_id = '${workspaceId}'::uuid AND action = 'access.review_overdue'
       ORDER BY occurred_at`,
      systemContext(workspaceId),
    );

  const alerts = (workspaceId: string, membershipId: string) =>
    rows<{ resourceKind: string; resourceId: string; actor: string | null; payload: unknown }>(
      `SELECT resource_kind AS "resourceKind", resource_id AS "resourceId",
              actor_membership_id AS actor, payload
         FROM notify.notification
        WHERE membership_id = '${membershipId}'::uuid AND event_type = 'access_review.overdue'`,
      systemContext(workspaceId),
    );

  beforeAll(async () => {
    const d = new Date(Date.now() + DAY);
    while (d.getUTCDay() !== 3) d.setTime(d.getTime() + DAY);
    T = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
    hooliId = (await createWorkspace(running.container.db, { slug: "hooli", name: "Hooli" })).id;
    initrodeId = (
      await createWorkspace(running.container.db, { slug: "initrode", name: "Initrode" })
    ).id;
    hooliOwner = await provision(hooliId, "gavin@hooli.test", "staff", "owner");
    hooliEditor = await provision(hooliId, "jared@hooli.test", "staff", "editor");
    hooliInvestor = await provision(hooliId, "peter@investor.test", "external", "investor");
    const initrodeOwner = await provision(initrodeId, "bill@initrode.test", "staff", "owner");
    await ageWorkspace(hooliId, 100);
    await ageWorkspace(initrodeId, 200);
    await createAccessReviewService(running.container.identityDeps).complete(
      { workspaceId: initrodeId, actorKind: "staff", membershipId: initrodeOwner },
      { reviewerMembershipId: initrodeOwner },
    );
  }, 60_000);

  it("the composition root registers the daily job", () => {
    const job = running.container.jobs.find((j) => j.name === "access-review.overdue");
    expect(job?.cron).toBe("41 6 * * *");
  });

  it("an overdue workspace: one audit row, one alert to access.manage, none to others", async () => {
    mailer.clear();
    await runAt(T);
    const audits = await overdueAudits(hooliId);
    expect(audits).toHaveLength(1);
    const [created] = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT created_at AS "createdAt" FROM core.workspace WHERE id = '${hooliId}'::uuid`,
      );
      return r.rows as { createdAt: string }[];
    });
    const dueAt = new Date(new Date(String(created?.createdAt)).getTime() + 90 * DAY);
    expect(audits[0]).toMatchObject({
      actorKind: "system",
      resourceId: null,
      meta: { dueAt: dueAt.toISOString(), lastReviewId: null },
    });
    expect(audits[0]?.meta["week"]).toMatch(/^\d{4}-W\d{2}$/u);

    const [alert] = await waitFor(async () => {
      const r = await alerts(hooliId, hooliOwner);
      return r.length > 0 ? r : undefined;
    });
    expect(alert).toEqual({
      resourceKind: "workspace",
      resourceId: hooliId,
      actor: null,
      payload: { dueAt: dueAt.toISOString(), lastReviewId: null },
    });
    // The editor does not hold access.manage; an investor never gets staff alerts.
    expect(await alerts(hooliId, hooliEditor)).toEqual([]);
    expect(await alerts(hooliId, hooliInvestor)).toEqual([]);
    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "gavin@hooli.test" && m.subject.includes("access review")),
    );
    expect(mail.subject).toBe("The access review is overdue");
    expect(mail.text).toContain(`http://hooli.${CANON}/admin/access-review`);
    expect(mail.text).toContain("No access review has been recorded yet.");

    // Reviewed today, so not due, although the workspace is older than hooli; and every
    // workspace created today (acme, globex, …) is not due either.
    expect(await overdueAudits(initrodeId)).toEqual([]);
    expect(await overdueAudits(acmeId)).toEqual([]);
  });

  it("a rerun in the same ISO week (same day or later) writes nothing, a redelivery dedupes", async () => {
    await runAt(new Date(T.getTime() + 2 * 3600_000));
    await runAt(new Date(T.getTime() + 2 * DAY));
    expect(await overdueAudits(hooliId)).toHaveLength(1);
    // A duplicate event (a redelivery) collapses into the week's row.
    await deliver(
      handlerFor("access_review.overdue", "notify"),
      "access_review.overdue",
      { dueAt: new Date(T.getTime() - DAY).toISOString(), lastReviewId: null },
      9801,
      hooliId,
    );
    expect(await alerts(hooliId, hooliOwner)).toHaveLength(1);
  });

  it("still overdue next week: reminded once more", async () => {
    await runAt(new Date(T.getTime() + 7 * DAY));
    const audits = await overdueAudits(hooliId);
    expect(audits).toHaveLength(2);
    expect(audits[1]?.meta["week"]).not.toBe(audits[0]?.meta["week"]);
    expect(await overdueAudits(initrodeId)).toEqual([]);
  });
});
