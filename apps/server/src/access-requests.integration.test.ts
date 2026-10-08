import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { eraseIdentity } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import {
  createWorkspace,
  type DsarRequest,
  systemContext,
  updateOfferingStatus,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import {
  ACCESS_REQUEST_CODE_TTL_MS,
  ACCESS_REQUEST_PENDING_CAP,
  ACCESS_REQUEST_RETENTION_DAYS,
  provisionMembership,
  provisionUser,
  RATE_LIMITS,
} from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { OutboundEmail } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { INVITE_DAILY_CAP } from "./routes/access.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Access requests & the approval queue (E3.1), end to end in multi-tenant mode.
 *
 *  - acme (offering `none`): the full flow — start → emailed code → verify → queue → approve →
 *    the ordinary invite, accepted through the email OTP → a membership with `source = request`;
 *    deny → a neutral mail without the internal note; domain auto-approval.
 *  - globex (`506b`): approving needs the relationship attestation (422 without it), the
 *    attested facts land on the membership, and a matching domain is NOT auto-approved.
 *  - initech: the pending cap (500 seeded rows) and the feature switched off (404).
 *
 * Every "no" a stranger can provoke — an existing member, the honeypot, a rate limit, the pending
 * cap — must look exactly like a "yes" (202, `{ expiresAt }` only, over the duration floor), and
 * every refused code the same 400 `invalid_code`, including attempts spent by parallel guesses.
 * Then the admin side's tenancy (404 across tenants and for externals), the sweeper, erasure,
 * and one pass through a server whose pool holds a single connection (a nested acquire there is
 * a deadlock, not a slow test).
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const FLOOR_MS = 250;
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let secretKey: string;
let storagePath: string;
/** The main server's log lines (the security-event log is asserted on). */
const logLines: Record<string, unknown>[] = [];

interface Actor {
  cookie: string;
  membershipId: string;
}

type Server = Pick<RunningServer, "app">;

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string; server?: Server } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return (init.server ?? running).app.request(`http://${slug}.${CANON}${path}`, {
    ...init,
    headers,
  });
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

/** Superuser read/write around RLS: the test inspects and seeds what the routes wrote. */
async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
}

async function signIn(slug: string, email: string, server?: Server): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
    ...(server ? { server } : {}),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    ...(server ? { server } : {}),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
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
  role: "owner" | "admin" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/** The first mail to `to` sent after `since` that uses `template`, waited for (sends are detached). */
async function awaitMail(
  to: string,
  since: number,
  template: string,
  timeoutMs = 15_000,
): Promise<OutboundEmail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = mailer.sent.slice(since).find((m) => m.to === to && m.template?.name === template);
    if (hit) return hit;
    if (Date.now() > deadline) {
      const seen = mailer.sent
        .slice(since)
        .map((m) => `${m.to}: ${m.template?.name ?? "?"} ${m.subject}`)
        .join("\n");
      throw new Error(`no ${template} mail to ${to} within ${timeoutMs} ms; sent:\n${seen}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Mails to `to` after `since`, once detached sends have had time to land. */
async function mailsTo(to: string, since: number, settleMs = 400): Promise<OutboundEmail[]> {
  await new Promise((r) => setTimeout(r, settleMs));
  return mailer.sent.slice(since).filter((m) => m.to === to);
}

function codeOf(mail: OutboundEmail): string {
  const m = /\b(\d{6})\b/u.exec(mail.text);
  if (!m?.[1]) throw new Error(`no code in mail:\n${mail.text}`);
  return m[1];
}

interface Body {
  expiresAt?: unknown;
  status?: unknown;
  error?: unknown;
}

interface Started {
  status: number;
  body: Body;
  ms: number;
}

async function start(
  slug: string,
  body: Record<string, unknown>,
  server?: Server,
  headers?: Record<string, string>,
): Promise<Started> {
  const t0 = performance.now();
  const res = await request(slug, "/api/v1/access-requests/start", {
    method: "POST",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
    ...(server ? { server } : {}),
  });
  const ms = performance.now() - t0;
  return { status: res.status, body: await json<Body>(res), ms };
}

async function verify(slug: string, email: string, code: string, server?: Server) {
  const res = await request(slug, "/api/v1/access-requests/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    ...(server ? { server } : {}),
  });
  return { status: res.status, body: await json<Body>(res) };
}

/** An error body without its per-request id, so two refusals compare whole. */
function refusal(r: { status: number; body: Body }) {
  const { requestId: _drop, ...rest } = (r.body.error ?? {}) as Record<string, unknown>;
  return { status: r.status, ...rest };
}

/** start → the emailed code → verify; returns the request id (the newest row for the address). */
async function submit(
  slug: string,
  email: string,
  extra: Record<string, unknown> = {},
  server?: Server,
): Promise<string> {
  const since = mailer.sent.length;
  const s = await start(slug, { email, name: email.split("@")[0], ...extra }, server);
  expect(s.status).toBe(202);
  const mail = await awaitMail(email, since, "auth.access_request_code");
  const v = await verify(slug, email, codeOf(mail), server);
  expect(v).toEqual({ status: 200, body: { status: "received" } });
  const [row] = await sql<{ id: string }>(
    `SELECT r.id FROM core.access_request r JOIN core.workspace w ON w.id = r.workspace_id
      WHERE w.slug = $1 AND r.email = $2 ORDER BY r.created_at DESC LIMIT 1`,
    [slug, email.trim().toLowerCase()],
  );
  if (row === undefined) throw new Error(`no request row for ${email}`);
  return row.id;
}

async function challengesOf(workspaceId: string, email: string) {
  return sql<{ id: string; name: string; expires_at: Date; client_ip_hash: Buffer | null }>(
    `SELECT id, name, expires_at, client_ip_hash FROM core.access_request_challenge
      WHERE workspace_id = $1::uuid AND email = $2 ORDER BY created_at`,
    [workspaceId, email],
  );
}

async function capRemaining(workspaceId: string): Promise<number> {
  return (await running.container.rateLimiter.peek(`invite:ws:${workspaceId}`, INVITE_DAILY_CAP))
    .remaining;
}

async function setRequests(
  slug: string,
  actor: Actor,
  requests: Partial<{
    enabled: boolean;
    autoApproveDomains: string[];
    defaultGroupIds: string[];
    pendingExpiryDays: number;
  }>,
): Promise<Response> {
  return request(slug, "/api/v1/access/settings", {
    method: "PATCH",
    cookie: actor.cookie,
    body: JSON.stringify({
      requests: {
        enabled: true,
        autoApproveDomains: [],
        defaultGroupIds: [],
        pendingExpiryDays: 30,
        ...requests,
      },
    }),
  });
}

async function rowOf(id: string) {
  const [row] = await sql<{
    status: string;
    email: string;
    name: string;
    firm: string | null;
    reason: string | null;
    decision_note: string | null;
    relationship_note: string | null;
    decided_at: Date | null;
    auto_approved: boolean;
    invite_id: string | null;
    membership_id: string | null;
    suggested_group_ids: string[];
    client_ip_hash: Buffer | null;
  }>("SELECT * FROM core.access_request WHERE id = $1::uuid", [id]);
  return row;
}

async function countRequests(workspaceId: string): Promise<number> {
  const [r] = await sql<{ n: number }>(
    "SELECT count(*)::int AS n FROM core.access_request WHERE workspace_id = $1::uuid",
    [workspaceId],
  );
  return r?.n ?? 0;
}

async function auditActions(workspaceId: string, resourceId: string) {
  return sql<{ action: string; actor_kind: string; meta: Record<string, unknown> }>(
    `SELECT action, actor_kind, meta FROM audit.event
      WHERE workspace_id = $1::uuid AND resource_id = $2 ORDER BY occurred_at, seq`,
    [workspaceId, resourceId],
  );
}

let acmeId: string;
let globexId: string;
let initechId: string;
let acmeOwner: Actor;
let acmeAdmin: Actor;
let acmeLegal: Actor;
let acmeInvestor: Actor;
let globexOwner: Actor;
let initechOwner: Actor;
let boardId: string;

function testConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: secretKey,
      STORAGE_FS_PATH: storagePath,
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      // One trusted proxy: `clientIp()` is the rightmost X-Forwarded-For entry (E2.10 F-07).
      TRUST_PROXY: "true",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      ...extra,
    },
  });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  secretKey = randomBytes(32).toString("base64");
  storagePath = mkdtempSync(join(tmpdir(), "fundroom-storage-"));
  running = await startServer({
    config: testConfig(),
    logger: createLogger({
      level: "warn",
      destination: new Writable({
        write(chunk, _enc, cb) {
          for (const line of String(chunk).split("\n").filter(Boolean))
            logLines.push(JSON.parse(line) as Record<string, unknown>);
          cb();
        },
      }),
    }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(db, { slug: "globex", name: "Globex" })).id;
  initechId = (await createWorkspace(db, { slug: "initech", name: "Initech" })).id;
  await db.withTenant(systemContext(globexId), (tx) =>
    updateOfferingStatus(tx, globexId, "506b" as never),
  );
  running.container.resolver.invalidate();

  acmeOwner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  acmeAdmin = await member("acme", acmeId, "admin@acme.test", "staff", "admin");
  acmeLegal = await member("acme", acmeId, "legal@acme.test", "staff", "legal");
  acmeInvestor = await member("acme", acmeId, "lp@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "owner@globex.test", "staff", "owner");
  initechOwner = await member("initech", initechId, "owner@initech.test", "staff", "owner");

  const board = await request("acme", "/api/v1/access/groups", {
    method: "POST",
    cookie: acmeOwner.cookie,
    body: JSON.stringify({ name: "Board" }),
  });
  expect(board.status).toBe(200);
  boardId = (await json<{ id: string }>(board)).id;
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("settings", () => {
  it("is off by default: the public routes are 404 and GET /access/settings says so", async () => {
    const settings = await json<{ requests: Record<string, unknown> }>(
      await request("acme", "/api/v1/access/settings", { cookie: acmeLegal.cookie }),
    );
    expect(settings.requests).toEqual({
      enabled: false,
      autoApproveDomains: [],
      defaultGroupIds: [],
      pendingExpiryDays: 30,
    });
    const s = await start("acme", { email: "x@y.test", name: "X" });
    expect(s.status).toBe(404);
    expect(refusal(s)).toMatchObject({ status: 404, code: "not_found" });
    const v = await verify("acme", "x@y.test", "123456");
    expect(v.status).toBe(404);
    const boot = await json<{ requestAccessEnabled: boolean }>(
      await request("acme", "/api/v1/modules"),
    );
    expect(boot.requestAccessEnabled).toBe(false);
  });

  it("refuses default groups that are not live groups of this workspace", async () => {
    const gx = await json<{ id: string }>(
      await request("globex", "/api/v1/access/groups", {
        method: "POST",
        cookie: globexOwner.cookie,
        body: JSON.stringify({ name: "Globex LPs" }),
      }),
    );
    const archived = await json<{ id: string }>(
      await request("acme", "/api/v1/access/groups", {
        method: "POST",
        cookie: acmeOwner.cookie,
        body: JSON.stringify({ name: "Old" }),
      }),
    );
    expect(
      (
        await request("acme", `/api/v1/access/groups/${archived.id}`, {
          method: "DELETE",
          cookie: acmeOwner.cookie,
        })
      ).status,
    ).toBe(200);
    for (const bad of [gx.id, archived.id, randomUUID()]) {
      const res = await setRequests("acme", acmeOwner, { defaultGroupIds: [boardId, bad] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("validation_failed");
    }
    // Nothing was written by the refusals.
    const settings = await json<{ requests: { enabled: boolean } }>(
      await request("acme", "/api/v1/access/settings", { cookie: acmeLegal.cookie }),
    );
    expect(settings.requests.enabled).toBe(false);
  });

  it("a deleted default group leaves the settings, and a stale id in a PATCH is dropped, not refused (C1)", async () => {
    const make = async (name: string) =>
      (
        await json<{ id: string }>(
          await request("acme", "/api/v1/access/groups", {
            method: "POST",
            cookie: acmeOwner.cookie,
            body: JSON.stringify({ name }),
          }),
        )
      ).id;
    const keep = await make("C1 keep");
    const gone = await make("C1 gone");
    expect(
      (await setRequests("acme", acmeOwner, { enabled: false, defaultGroupIds: [keep, gone] }))
        .status,
    ).toBe(200);
    // Deleting a group through the API takes it out of the defaults, in the same transaction.
    expect(
      (
        await request("acme", `/api/v1/access/groups/${gone}`, {
          method: "DELETE",
          cookie: acmeOwner.cookie,
        })
      ).status,
    ).toBe(200);
    const after = await json<{ requests: { defaultGroupIds: string[] } }>(
      await request("acme", "/api/v1/access/settings", { cookie: acmeLegal.cookie }),
    );
    expect(after.requests.defaultGroupIds).toEqual([keep]);

    // A default that is already stored when its group dies some other way (a row written before
    // this fix, a restore) must not make the page unsaveable: it is dropped, not refused.
    const legacy = await make("C1 legacy");
    expect(
      (await setRequests("acme", acmeOwner, { enabled: false, defaultGroupIds: [keep, legacy] }))
        .status,
    ).toBe(200);
    await sql("UPDATE core.group SET deleted_at = now() WHERE id = $1::uuid", [legacy]);
    const resave = await setRequests("acme", acmeOwner, {
      enabled: false,
      defaultGroupIds: [keep, legacy],
    });
    expect(resave.status).toBe(200);
    expect(
      (await json<{ requests: { defaultGroupIds: string[] } }>(resave)).requests.defaultGroupIds,
    ).toEqual([keep]);
    // A NEWLY added dead id is still refused.
    const added = await setRequests("acme", acmeOwner, {
      enabled: false,
      defaultGroupIds: [keep, gone],
    });
    expect(added.status).toBe(400);
    expect((await setRequests("acme", acmeOwner, { enabled: false })).status).toBe(200);
  });

  it("replaces the whole requests object, audits and takes effect at once", async () => {
    const expiry = await request("acme", "/api/v1/access/settings", {
      method: "PATCH",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ inviteExpiryDays: 14 }),
    });
    expect(expiry.status).toBe(200);
    const res = await setRequests("acme", acmeOwner, {
      autoApproveDomains: ["AutoCo.test"],
      defaultGroupIds: [boardId],
    });
    expect(res.status).toBe(200);
    const saved = await json<{ requests: unknown; inviteExpiryDays: number }>(res);
    // A requests-only patch leaves the other access settings alone.
    expect(saved.inviteExpiryDays).toBe(14);
    expect(saved.requests).toEqual({
      enabled: true,
      autoApproveDomains: ["autoco.test"],
      defaultGroupIds: [boardId],
      pendingExpiryDays: 30,
    });
    const boot = await json<{ requestAccessEnabled: boolean }>(
      await request("acme", "/api/v1/modules"),
    );
    expect(boot.requestAccessEnabled).toBe(true);
    const audit = await auditActions(acmeId, acmeId);
    expect(audit.filter((a) => a.action === "access.settings_changed").at(-1)?.meta).toMatchObject({
      fields: ["requests"],
    });
    // Legal may read settings but not change them.
    const denied = await setRequests("acme", acmeLegal, {});
    expect([403, 404]).toContain(denied.status);

    expect(
      (await setRequests("globex", globexOwner, { autoApproveDomains: ["autoco.test"] })).status,
    ).toBe(200);
    expect((await setRequests("initech", initechOwner, {})).status).toBe(200);
  });
});

describe("request → verify → queue → approve → invite accepted", () => {
  let requestId: string;

  it("queues a verified request with the suggested groups and audits it as the system", async () => {
    const since = mailer.sent.length;
    const s = await start("acme", {
      email: "Ada@Investor.test",
      name: "Ada Lovelace",
      firm: "Analytical Ventures",
      reason: "Seed round",
      website: "",
    });
    expect(s.status).toBe(202);
    expect(Object.keys(s.body)).toEqual(["expiresAt"]);
    // A challenge, not a request: nothing in core.access_request until the code is proven.
    expect(await countRequests(acmeId)).toBe(0);
    const [challenge] = await challengesOf(acmeId, "ada@investor.test");
    expect(challenge?.name).toBe("Ada Lovelace");
    expect(challenge?.expires_at.toISOString()).toBe(s.body.expiresAt);
    // Not listed before the code is proven.
    const before = await json<{ items: unknown[] }>(
      await request("acme", "/api/v1/access/requests", { cookie: acmeLegal.cookie }),
    );
    expect(before.items).toEqual([]);

    const mail = await awaitMail("ada@investor.test", since, "auth.access_request_code");
    expect(mail.text).toContain("in the name of Ada Lovelace (Analytical Ventures)");
    const v = await verify("acme", "ADA@investor.test", codeOf(mail));
    expect(v).toEqual({ status: 200, body: { status: "received" } });
    const [row] = await sql<{ id: string }>(
      "SELECT id FROM core.access_request WHERE workspace_id = $1::uuid AND email = $2",
      [acmeId, "ada@investor.test"],
    );
    requestId = row?.id ?? "";
    expect(await challengesOf(acmeId, "ada@investor.test")).toEqual([]);

    const page = await json<{ items: Record<string, unknown>[]; nextCursor: string | null }>(
      await request("acme", "/api/v1/access/requests?status=pending", {
        cookie: acmeLegal.cookie,
      }),
    );
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: requestId,
      email: "ada@investor.test",
      name: "Ada Lovelace",
      firm: "Analytical Ventures",
      reason: "Seed round",
      status: "pending",
      suggestedGroupIds: [boardId],
      autoApproved: false,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      relationship: null,
      inviteId: null,
      membershipId: null,
    });
    const audit = await auditActions(acmeId, requestId);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ["access_request.submitted", "system"],
    ]);
    // Replaying the spent code is the same refusal as a wrong one.
    expect(refusal(await verify("acme", "ada@investor.test", codeOf(mail)))).toMatchObject({
      status: 400,
      code: "invalid_code",
    });
  });

  it("refusals spend no invitation slot: 409, 400 future relationship, 404 group (C7, C8)", async () => {
    const before = await capRemaining(acmeId);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const bad = await request("acme", `/api/v1/access/requests/${requestId}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ relationship: { source: "intro", establishedAt: future } }),
    });
    expect(bad.status).toBe(400);
    expect((await json<{ error: Record<string, unknown> }>(bad)).error).toMatchObject({
      code: "validation_failed",
      reason: "relationship_in_future",
    });
    const unknownGroup = await request("acme", `/api/v1/access/requests/${requestId}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ groupIds: [randomUUID()] }),
    });
    expect(unknownGroup.status).toBe(404);
    expect(await capRemaining(acmeId)).toBe(before);
    expect(await rowOf(requestId)).toMatchObject({ status: "pending", invite_id: null });
  });

  it("approves into an ordinary invite that counts toward the daily cap", async () => {
    const capKey = `invite:ws:${acmeId}`;
    const capBefore = await running.container.rateLimiter.hit(capKey, INVITE_DAILY_CAP);
    const since = mailer.sent.length;
    const res = await request("acme", `/api/v1/access/requests/${requestId}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ groupIds: [boardId], note: "met at demo day" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{
      request: Record<string, unknown>;
      invite: { id: string };
      mailSent: boolean;
    }>(res);
    expect(body.mailSent).toBe(true);
    expect(body.request).toMatchObject({
      id: requestId,
      status: "approved",
      decisionNote: "met at demo day",
      decidedBy: { membershipId: acmeAdmin.membershipId },
      inviteId: body.invite.id,
    });
    expect(body.invite).toMatchObject({
      email: "ada@investor.test",
      kind: "external",
      role: "investor",
      groupIds: [boardId],
      status: "pending",
    });
    const [inv] = await sql<{ access_request_id: string }>(
      "SELECT access_request_id FROM core.invite WHERE id = $1::uuid",
      [body.invite.id],
    );
    expect(inv?.access_request_id).toBe(requestId);
    const mail = await awaitMail("ada@investor.test", since, "auth.invite");
    expect(mail.text).toContain("/invite/");
    // The probe above, the approval, and this probe: the approval spent one invitation.
    const capAfter = await running.container.rateLimiter.hit(capKey, INVITE_DAILY_CAP);
    expect(capBefore.remaining - capAfter.remaining).toBe(2);
    const audit = await auditActions(acmeId, requestId);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ["access_request.submitted", "system"],
      ["access_request.approved", "staff"],
    ]);
    // Not pending any more: a second decision is a conflict.
    for (const verb of ["approve", "deny"]) {
      const again = await request("acme", `/api/v1/access/requests/${requestId}/${verb}`, {
        method: "POST",
        cookie: acmeAdmin.cookie,
        body: JSON.stringify({}),
      });
      expect(again.status).toBe(409);
    }
  });

  it("the requester signs in through the invite; the membership records source=request", async () => {
    const ada = await signIn("acme", "ada@investor.test");
    expect(ada.membershipId).not.toBe("");
    const [m] = await sql<{ source: string }>(
      "SELECT source FROM core.membership WHERE id = $1::uuid",
      [ada.membershipId],
    );
    expect(m?.source).toBe("request");
    const detail = await json<Record<string, unknown>>(
      await request("acme", `/api/v1/access/requests/${requestId}`, { cookie: acmeLegal.cookie }),
    );
    expect(detail).toMatchObject({ status: "approved", membershipId: ada.membershipId });
    const approved = await json<{ items: { id: string }[] }>(
      await request("acme", "/api/v1/access/requests?status=approved", {
        cookie: acmeLegal.cookie,
      }),
    );
    expect(approved.items.map((i) => i.id)).toEqual([requestId]);
  });

  it("an existing member who asks again is mailed a sign-in hint, and no row is written", async () => {
    const rowsBefore = await countRequests(acmeId);
    const since = mailer.sent.length;
    const s = await start("acme", { email: "ada@investor.test", name: "Ada" });
    expect(s.status).toBe(202);
    await awaitMail("ada@investor.test", since, "auth.access_request_existing");
    expect(await countRequests(acmeId)).toBe(rowsBefore);
    expect(await challengesOf(acmeId, "ada@investor.test")).toEqual([]);
    expect(refusal(await verify("acme", "ada@investor.test", "000000"))).toMatchObject({
      status: 400,
      code: "invalid_code",
    });
  });
});

describe("approval edges", () => {
  it("a waiting invitation for the address is 409 invite_pending; the admin's invite is untouched (C4)", async () => {
    const id = await submit("acme", "doubled@lp.test");
    const inv = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ invites: [{ email: "doubled@lp.test" }] }),
    });
    expect(inv.status).toBe(200);
    const inviteId = (await json<{ created: { id: string }[] }>(inv)).created[0]?.id;
    const before = await capRemaining(acmeId);
    const res = await request("acme", `/api/v1/access/requests/${id}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    // Error details are flattened into the error object.
    expect((await json<{ error: Record<string, unknown> }>(res)).error).toMatchObject({
      code: "conflict",
      reason: "invite_pending",
    });
    expect(await capRemaining(acmeId)).toBe(before);
    const [row] = await sql<{ status: string }>(
      "SELECT status FROM core.invite WHERE id = $1::uuid",
      [inviteId],
    );
    expect(row?.status).toBe("pending");
    expect(await rowOf(id)).toMatchObject({ status: "pending" });
  });

  it("an invitation mail that fails after commit is 200 with mailSent: false, never a 503 (C3)", async () => {
    const id = await submit("acme", "mailfail@lp.test");
    mailer.failNext(1, "mailfail@lp.test");
    const res = await request("acme", `/api/v1/access/requests/${id}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await json<{
      request: { status: string };
      invite: { id: string };
      mailSent: boolean;
    }>(res);
    expect(body.mailSent).toBe(false);
    expect(body.request.status).toBe("approved");
    const [inv] = await sql<{ status: string }>(
      "SELECT status FROM core.invite WHERE id = $1::uuid",
      [body.invite.id],
    );
    expect(inv?.status).toBe("pending");
  });
});

describe("deny", () => {
  it("mails a neutral refusal that never carries the internal note; the cooldown then holds", async () => {
    const id = await submit("acme", "mallory@nope.test");
    const since = mailer.sent.length;
    const res = await request("acme", `/api/v1/access/requests/${id}/deny`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ note: "SECRET-NOTE competitor" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ request: Record<string, unknown> }>(res);
    expect(body.request).toMatchObject({
      id,
      status: "denied",
      decisionNote: "SECRET-NOTE competitor",
      inviteId: null,
    });
    const mail = await awaitMail("mallory@nope.test", since, "auth.access_request_denied");
    expect(`${mail.subject}\n${mail.text}\n${mail.html ?? ""}`).not.toContain("SECRET-NOTE");
    expect(JSON.stringify(mail.template?.props ?? {})).not.toContain("SECRET-NOTE");
    const audit = await auditActions(acmeId, id);
    expect(audit.map((a) => a.action)).toEqual([
      "access_request.submitted",
      "access_request.denied",
    ]);
    expect(JSON.stringify(audit)).not.toContain("SECRET-NOTE");

    // Within the cooldown a new request answers "received" and leaves no queue row.
    await submit("acme", "mallory@nope.test");
    const [open] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.access_request
        WHERE workspace_id = $1::uuid AND email = 'mallory@nope.test' AND status <> 'denied'`,
      [acmeId],
    );
    expect(open?.n).toBe(0);
  });

  it("notifyRequester=false sends nothing", async () => {
    const id = await submit("acme", "quiet@nope.test");
    const since = mailer.sent.length;
    const res = await request("acme", `/api/v1/access/requests/${id}/deny`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ notifyRequester: false }),
    });
    expect(res.status).toBe(200);
    expect(await mailsTo("quiet@nope.test", since)).toEqual([]);
  });
});

describe("Rule 506(b) and domain auto-approval", () => {
  it("auto-approves a listed domain outside 506(b): an invite is issued at once", async () => {
    const since = mailer.sent.length;
    const id = await submit("acme", "carol@autoco.test");
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "approved", auto_approved: true });
    expect(row?.invite_id).not.toBeNull();
    await awaitMail("carol@autoco.test", since, "auth.invite");
    const audit = await auditActions(acmeId, id);
    expect(audit.map((a) => [a.action, a.actor_kind])).toEqual([
      ["access_request.submitted", "system"],
      ["access_request.approved", "system"],
    ]);
    expect(audit[1]?.meta).toMatchObject({ auto: true });
    const [inv] = await sql<{ group_ids: string[] }>(
      "SELECT group_ids FROM core.invite WHERE id = $1::uuid",
      [row?.invite_id],
    );
    expect(inv?.group_ids).toEqual([boardId]);
  });

  let globexRequest: string;

  it("never auto-approves under 506(b), even for a listed domain", async () => {
    globexRequest = await submit("globex", "dave@autoco.test");
    expect(await rowOf(globexRequest)).toMatchObject({ status: "pending", auto_approved: false });
  });

  it("506(b) approval without the relationship attestation is 422; with it, it lands on the membership", async () => {
    const bare = await request("globex", `/api/v1/access/requests/${globexRequest}/approve`, {
      method: "POST",
      cookie: globexOwner.cookie,
      body: JSON.stringify({}),
    });
    expect(bare.status).toBe(422);
    expect((await json<{ error: { code: string } }>(bare)).error.code).toBe(
      "relationship_attestation_required",
    );
    expect(await rowOf(globexRequest)).toMatchObject({ status: "pending", invite_id: null });

    const establishedAt = "2025-01-15T00:00:00.000Z";
    const ok = await request("globex", `/api/v1/access/requests/${globexRequest}/approve`, {
      method: "POST",
      cookie: globexOwner.cookie,
      body: JSON.stringify({
        relationship: { source: "prior_investor", establishedAt, note: "angel in 2024" },
      }),
    });
    expect(ok.status).toBe(200);
    const body = await json<{ request: Record<string, unknown> }>(ok);
    expect(body.request).toMatchObject({
      status: "approved",
      relationship: { source: "prior_investor", establishedAt, note: "angel in 2024" },
    });
    const dave = await signIn("globex", "dave@autoco.test");
    const [m] = await sql<{
      source: string;
      relationship_source: string;
      relationship_established_at: Date;
    }>(
      `SELECT source, relationship_source, relationship_established_at FROM core.membership
        WHERE id = $1::uuid`,
      [dave.membershipId],
    );
    expect(m).toMatchObject({ source: "request", relationship_source: "prior_investor" });
    expect(m?.relationship_established_at.toISOString()).toBe(establishedAt);
    const audit = await auditActions(globexId, dave.membershipId);
    expect(audit.map((a) => a.action)).toContain("membership.relationship_recorded");
  });
});

describe("decoy parity: every 'no' a stranger can provoke looks like a 'yes'", () => {
  /** The body is `{ expiresAt }` and it is the arrival instant + the code lifetime. */
  const shape = (s: Started) => ({
    status: s.status,
    keys: Object.keys(s.body),
    expiresAt: !Number.isNaN(Date.parse(String(s.body.expiresAt))),
  });
  const YES = { status: 202, keys: ["expiresAt"], expiresAt: true };

  it("existing member, honeypot, rate limit and a full queue answer like a new request (S1, S2)", async () => {
    const cases = {} as Record<
      "fresh" | "member" | "staffMember" | "suspended" | "honeypot" | "rateLimited",
      Started & { sentAt: number }
    >;
    const timed = async (body: Record<string, unknown>) => {
      const sentAt = Date.now();
      return { ...(await start("acme", body)), sentAt };
    };
    cases.fresh = await timed({ email: "fresh@parity.test", name: "Fresh" });
    cases.member = await timed({ email: "lp@investor.test", name: "LP" });
    cases.staffMember = await timed({ email: "legal@acme.test", name: "Ed" });
    // A suspended member's address: a silent decoy (no mail, no row).
    const deps = running.container.identityDeps;
    const sus = await provisionUser(deps, { email: "sus@parity.test", displayName: "Sus" });
    await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: sus.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await sql("UPDATE core.membership SET status = 'suspended' WHERE user_id = $1::uuid", [
      sus.userId,
    ]);
    const susSince = mailer.sent.length;
    cases.suspended = await timed({ email: "sus@parity.test", name: "Sus" });
    const honeypotSince = mailer.sent.length;
    cases.honeypot = await timed({
      email: "bot@parity.test",
      name: "Bot",
      website: "http://spam.test",
    });
    // access_request.start.email: 3 per hour per address, then silence.
    const limited: (Started & { sentAt: number })[] = [];
    for (let i = 0; i < 4; i += 1)
      limited.push(await timed({ email: "spam@parity.test", name: `S${i}` }));
    cases.rateLimited = limited[3] as Started & { sentAt: number };

    for (const [name, s] of Object.entries(cases)) {
      expect(shape(s), name).toEqual(YES);
      expect(s.ms, name).toBeGreaterThanOrEqual(FLOOR_MS - 10);
      // Taken when the call arrived, not after the real path's work (S2).
      const lead = Date.parse(String(s.body.expiresAt)) - ACCESS_REQUEST_CODE_TTL_MS - s.sentAt;
      expect(lead, name).toBeGreaterThanOrEqual(-5);
      expect(lead, name).toBeLessThan(FLOOR_MS);
    }
    // Only real submissions leave a challenge: the honeypot, the rate-limited attempt, members.
    expect(await challengesOf(acmeId, "bot@parity.test")).toEqual([]);
    expect(await mailsTo("bot@parity.test", honeypotSince)).toEqual([]);
    const spamCodes = () =>
      mailer.sent.filter(
        (m) => m.to === "spam@parity.test" && m.template?.name === "auth.access_request_code",
      );
    // Sends are detached: wait (bounded) for the three accepted ones before counting.
    for (const deadline = Date.now() + 15_000; spamCodes().length < 3 && Date.now() < deadline; )
      await new Promise((r) => setTimeout(r, 20));
    expect(spamCodes()).toHaveLength(3);
    // Each accepted submission is its own challenge (nothing that repeats per address).
    expect((await challengesOf(acmeId, "spam@parity.test")).map((c) => c.name)).toEqual([
      "S0",
      "S1",
      "S2",
    ]);
    expect(await challengesOf(acmeId, "lp@investor.test")).toEqual([]);
    expect(await challengesOf(acmeId, "sus@parity.test")).toEqual([]);
    expect(await mailsTo("sus@parity.test", susSince)).toEqual([]);

    // Every "no" at verify is one refusal, whatever the address is.
    const wrong = refusal(await verify("acme", "fresh@parity.test", "000000"));
    expect(wrong).toMatchObject({ status: 400, code: "invalid_code" });
    for (const email of [
      "lp@investor.test",
      "sus@parity.test",
      "bot@parity.test",
      "nobody@parity.test",
    ])
      expect(refusal(await verify("acme", email, "000000")), email).toEqual(wrong);
  });

  it("one client IP gets 20 starts an hour; the 21st is the same answer, sends nothing, and is a security event (S4)", async () => {
    const ip = "198.51.100.23";
    const max = RATE_LIMITS.accessRequestStartPerIp.max;
    const headers = { "x-forwarded-for": `10.9.9.9, ${ip}` };
    const accepted = await Promise.all(
      Array.from({ length: max }, (_, i) =>
        start("acme", { email: `ip${i}@parity.test`, name: `IP${i}` }, undefined, headers),
      ),
    );
    for (const a of accepted) expect(shape(a)).toEqual(YES);
    // The client-written left entry is not the key: a different one changes nothing.
    const since = mailer.sent.length;
    const over = await start("acme", { email: "ip-over@parity.test", name: "Over" }, undefined, {
      "x-forwarded-for": `10.1.1.1, ${ip}`,
    });
    expect(shape(over)).toEqual(YES);
    expect(over.ms).toBeGreaterThanOrEqual(FLOOR_MS - 10);
    expect(await challengesOf(acmeId, "ip-over@parity.test")).toEqual([]);
    expect(await mailsTo("ip-over@parity.test", since)).toEqual([]);
    const events = logLines.filter((l) => l["msg"] === "security.access_request_throttled");
    expect(events.at(-1)).toMatchObject({ reason: "ip_budget", errorCode: "decoy", status: 202 });
    expect(JSON.stringify(events)).not.toContain(ip);
    // Another client is unaffected.
    const other = await start("acme", { email: "ip-other@parity.test", name: "Other" }, undefined, {
      "x-forwarded-for": "198.51.100.24",
    });
    expect(shape(other)).toEqual(YES);
    expect(await challengesOf(acmeId, "ip-other@parity.test")).toHaveLength(1);
    // The stored ip hash is keyed, never the address.
    const [c] = await challengesOf(acmeId, "ip-other@parity.test");
    expect(c?.client_ip_hash?.toString("latin1") ?? "").not.toContain("198.51.100");
  });

  it("a full queue (the pending cap) answers like a new request and writes nothing", async () => {
    await sql(
      `INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at)
         SELECT $1::uuid, 'seed' || g || '@cap.test', 'Seed ' || g, 'pending', now(),
                now() + interval '30 days'
           FROM generate_series(1, $2::int) g`,
      [initechId, ACCESS_REQUEST_PENDING_CAP],
    );
    const rowsBefore = await countRequests(initechId);
    const since = mailer.sent.length;
    const s = await start("initech", { email: "late@cap.test", name: "Late" });
    expect(shape(s)).toEqual(YES);
    expect(s.ms).toBeGreaterThanOrEqual(FLOOR_MS - 10);
    expect(await countRequests(initechId)).toBe(rowsBefore);
    expect(await mailsTo("late@cap.test", since)).toEqual([]);
  });

  it("switched off is a plain 404 for both public routes", async () => {
    await setRequests("initech", initechOwner, { enabled: false });
    expect((await start("initech", { email: "x@cap.test", name: "X" })).status).toBe(404);
    expect((await verify("initech", "x@cap.test", "000000")).status).toBe(404);
  });
});

describe("invalid_code uniformity", () => {
  it("wrong, expired and over-budget codes are one refusal; parallel guesses cannot exceed the budget", async () => {
    const since = mailer.sent.length;
    await start("acme", { email: "guess@parity.test", name: "Guess" });
    const code = codeOf(await awaitMail("guess@parity.test", since, "auth.access_request_code"));
    const wrongCode = code === "000000" ? "111111" : "000000";
    const baseline = refusal(await verify("acme", "guess@parity.test", wrongCode));
    expect(baseline).toMatchObject({ status: 400, code: "invalid_code" });

    const guesses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const guess = String((Number(code) + i + 1) % 1_000_000).padStart(6, "0");
        return verify("acme", "guess@parity.test", guess);
      }),
    );
    for (const g of guesses) expect(refusal(g)).toEqual(baseline);
    // Budget spent (5 per 15 minutes per address, counted before comparing): the right code is
    // refused the same way, and the challenge is still there for when the window passes.
    expect(refusal(await verify("acme", "guess@parity.test", code))).toEqual(baseline);
    expect(await challengesOf(acmeId, "guess@parity.test")).toHaveLength(1);
    expect(
      (
        await sql<{ n: number }>(
          "SELECT count(*)::int AS n FROM core.access_request WHERE email = 'guess@parity.test'",
        )
      )[0]?.n,
    ).toBe(0);

    // Expired: a fresh code, aged past its TTL.
    const since2 = mailer.sent.length;
    await start("acme", { email: "late@parity.test", name: "Late" });
    const code2 = codeOf(await awaitMail("late@parity.test", since2, "auth.access_request_code"));
    await sql(
      `UPDATE core.access_request_challenge SET expires_at = now() - interval '1 second'
        WHERE email = 'late@parity.test'`,
    );
    expect(refusal(await verify("acme", "late@parity.test", code2))).toEqual(baseline);
  });

  it("failed verifications for other addresses never lock a requester out (S3)", async () => {
    // Far past the old 1000/h workspace bucket would be slow here; the point is that there is no
    // shared bucket at all — the rule set has none, and a burst for other addresses changes nothing.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => verify("acme", `noise${i}@evil.test`, "000000")),
    );
    const since = mailer.sent.length;
    await start("acme", { email: "calm@parity.test", name: "Calm" });
    const code = codeOf(await awaitMail("calm@parity.test", since, "auth.access_request_code"));
    expect(await verify("acme", "calm@parity.test", code)).toEqual({
      status: 200,
      body: { status: "received" },
    });
    expect(Object.keys(RATE_LIMITS).filter((k) => k.startsWith("accessRequestVerify"))).toEqual([
      "accessRequestVerifyPerEmail",
    ]);
  });
});

describe("admin tenancy", () => {
  it("another tenant's request ids answer 404 on every admin route", async () => {
    const theirs = await submit("globex", "erin@globex-lp.test");
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      [
        "POST",
        "/approve",
        { relationship: { source: "intro", establishedAt: "2025-01-01T00:00:00Z" } },
      ],
      ["POST", "/deny", {}],
    ] as const) {
      const res = await request("acme", `/api/v1/access/requests/${theirs}${suffix}`, {
        method,
        cookie: acmeOwner.cookie,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${suffix}`).toBe(404);
    }
    expect(await rowOf(theirs)).toMatchObject({ status: "pending" });
    const list = await json<{ items: { id: string }[] }>(
      await request("acme", "/api/v1/access/requests", { cookie: acmeOwner.cookie }),
    );
    expect(list.items.map((i) => i.id)).not.toContain(theirs);
  });

  it("externals get 404 on every admin route; legal may read but not decide", async () => {
    const id = await submit("acme", "frank@lp.test");
    for (const [method, path] of [
      ["GET", "/api/v1/access/requests"],
      ["GET", `/api/v1/access/requests/${id}`],
      ["POST", `/api/v1/access/requests/${id}/approve`],
      ["POST", `/api/v1/access/requests/${id}/deny`],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: acmeInvestor.cookie,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(
      (await request("acme", `/api/v1/access/requests/${id}`, { cookie: acmeLegal.cookie })).status,
    ).toBe(200);
    const deny = await request("acme", `/api/v1/access/requests/${id}/deny`, {
      method: "POST",
      cookie: acmeLegal.cookie,
      body: "{}",
    });
    expect([403, 404]).toContain(deny.status);
  });

  it("pages newest first with a keyset cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await submit("globex", `page${i}@lp.test`));
    const first = await json<{ items: { id: string }[]; nextCursor: string | null }>(
      await request("globex", "/api/v1/access/requests?limit=2", { cookie: globexOwner.cookie }),
    );
    expect(first.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await json<{ items: { id: string }[]; nextCursor: string | null }>(
      await request(
        "globex",
        `/api/v1/access/requests?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        { cookie: globexOwner.cookie },
      ),
    );
    expect(second.items.map((i) => i.id)[0]).toBe(ids[0]);
  });
});

describe("sweeper", () => {
  it("drops expired challenges, expires stale pending requests and deletes old decisions", async () => {
    const service = running.container.accessRequests;
    const since = mailer.sent.length;
    await start("acme", { email: "stale@sweep.test", name: "Stale" });
    await awaitMail("stale@sweep.test", since, "auth.access_request_code");
    await sql(
      `UPDATE core.access_request_challenge SET expires_at = now() - interval '1 minute'
        WHERE email = 'stale@sweep.test'`,
    );
    const pending = await submit("acme", "slow@sweep.test");
    const denied = await submit("acme", "old@sweep.test");
    await request("acme", `/api/v1/access/requests/${denied}/deny`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({ notifyRequester: false }),
    });
    await sql(
      "UPDATE core.access_request SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid",
      [pending],
    );
    await sql(
      `UPDATE core.access_request SET decided_at = now() - ($2::int + 1) * interval '1 day'
        WHERE id = $1::uuid`,
      [denied, ACCESS_REQUEST_RETENTION_DAYS],
    );
    const r = await service.sweep();
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await challengesOf(acmeId, "stale@sweep.test")).toEqual([]);
    expect(await rowOf(denied)).toBeUndefined();
    expect(await rowOf(pending)).toMatchObject({ status: "expired" });
    expect((await rowOf(pending))?.decided_at).not.toBeNull();
    const audit = await auditActions(acmeId, pending);
    expect(audit.at(-1)).toMatchObject({ action: "access_request.expired", actor_kind: "system" });
    const expired = await json<{ items: { id: string }[] }>(
      await request("acme", "/api/v1/access/requests?status=expired", {
        cookie: acmeLegal.cookie,
      }),
    );
    expect(expired.items.map((i) => i.id)).toContain(pending);
    // The job is registered with the kernel's jobs.
    expect(running.container.jobs.map((j) => j.name)).toContain("access-requests.sweep");
  });
});

describe("erasure", () => {
  it("pseudonymises the member's request rows (by membership and by address)", async () => {
    const id = await submit("acme", "grace@erase.test", { firm: "Hopper Capital", reason: "why" });
    const approve = await request("acme", `/api/v1/access/requests/${id}/approve`, {
      method: "POST",
      cookie: acmeAdmin.cookie,
      body: JSON.stringify({
        note: "internal",
        relationship: { source: "intro", establishedAt: "2025-02-01T00:00:00Z", note: "via Bob" },
      }),
    });
    expect(approve.status).toBe(200);
    const grace = await signIn("acme", "grace@erase.test");
    // A challenge in flight for the address (a new start) goes with the rest.
    await sql(
      `INSERT INTO core.access_request_challenge (id, workspace_id, email, name, code_hash, expires_at)
       VALUES (gen_random_uuid(), $1::uuid, 'grace@erase.test', 'Grace', '\\x00', now() + interval '10 minutes')`,
      [acmeId],
    );
    // An older, denied request from the same address is matched by email.
    const [older] = await sql<{ id: string }>(
      `INSERT INTO core.access_request (workspace_id, email, name, firm, reason, status,
         decision_note, decided_at, expires_at)
       VALUES ($1::uuid, 'grace@erase.test', 'Grace', 'Old firm', 'old', 'denied', 'no', now(), now())
       RETURNING id`,
      [acmeId],
    );
    // A pending one too (it would otherwise sit in the queue under a pseudonym).
    const [open] = await sql<{ id: string }>(
      `INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at)
       VALUES ($1::uuid, 'grace@erase.test', 'Grace', 'pending', now(), now() + interval '30 days')
       RETURNING id`,
      [acmeId],
    );
    const [dsar] = await sql<DsarRequest>(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, requested_by, due_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now() + interval '30 days')
       RETURNING id, workspace_id AS "workspaceId", membership_id AS "membershipId"`,
      [acmeId, grace.membershipId, acmeOwner.membershipId],
    );
    const ctx = systemContext(acmeId);
    const erased = await running.container.db.withTenant(ctx, (tx) =>
      eraseIdentity(
        { audit: running.container.audit, bookingSuppressionKeys: running.container.envelope },
        ctx,
        tx,
        dsar as DsarRequest,
        new Date(),
      ),
    );
    expect(erased.counts).toMatchObject({ accessRequests: 3 });
    expect(await challengesOf(acmeId, "grace@erase.test")).toEqual([]);
    // Closed as expired, decided now (C11: the queue shows decidedAt for it).
    expect(await rowOf(open?.id ?? "")).toMatchObject({ status: "expired" });
    expect((await rowOf(open?.id ?? ""))?.decided_at).not.toBeNull();
    for (const rid of [id, older?.id ?? "", open?.id ?? ""]) {
      const row = await rowOf(rid);
      expect(row?.email).toMatch(/^erased\+[0-9a-f]+@erased\.invalid$/u);
      expect(row).toMatchObject({
        name: "[erased]",
        firm: null,
        reason: null,
        decision_note: null,
        relationship_note: null,
      });
    }
  });
});

describe("a one-connection pool", () => {
  it("start → verify → list → approve complete without a nested acquire", async () => {
    const single = await startServer({
      // An api node, as in data-room-qa's and data-room-vault's one-connection tests. With the
      // `worker` role this server also polled every job and event queue on its one connection —
      // 251 pollers every 500 ms (37 topics × WORKER_CONCURRENCY 5, plus the jobs) — so under a
      // loaded full suite the pool's wait queue sat ~250 deep and each route step waited seconds
      // behind pg-boss fetches: starvation, not a nested acquire. The main server's workers run
      // the handlers. (The product side: the queue now caps worker concurrency at the pool size.)
      config: testConfig({ DATABASE_POOL_MAX: "1", ROLES: "api,web" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    // As in data-room-qa's one-connection test: the api node's own outbox relay holds the pool's
    // only connection while a batch dispatches (E3.4's webhook fan-out made these batches heavier),
    // so under load a route times out acquiring — serialisation, not a nested acquire by a route.
    // The relay is stopped; the main server's relay, on its own pool, still delivers the events.
    await single.container.relay.stop();
    try {
      const run = async () => {
        const id = await submit("acme", "pool@single.test", {}, single);
        const list = await request("acme", "/api/v1/access/requests", {
          cookie: acmeAdmin.cookie,
          server: single,
        });
        expect(list.status).toBe(200);
        const approve = await request("acme", `/api/v1/access/requests/${id}/approve`, {
          method: "POST",
          cookie: acmeAdmin.cookie,
          server: single,
          body: JSON.stringify({}),
        });
        expect(approve.status).toBe(200);
        const deny = await submit("acme", "pool2@single.test", {}, single);
        const denied = await request("acme", `/api/v1/access/requests/${deny}/deny`, {
          method: "POST",
          cookie: acmeAdmin.cookie,
          server: single,
          body: JSON.stringify({}),
        });
        expect(denied.status).toBe(200);
        // And an existing member's start (the other mail path).
        expect(
          (await start("acme", { email: "lp@investor.test", name: "LP" }, single)).status,
        ).toBe(202);
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 30_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 60_000);
});
