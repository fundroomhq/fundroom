import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_KEY_RATE_LIMIT,
  ApiKeyRepo,
  apiKeyTokenHash,
  MAX_LIVE_API_KEYS,
} from "@fundroom/api-keys";
import { createErasureService, prelockIdentityErasure } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { MembershipRepo, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Workspace API keys, backend (E3.4-A, ADR-0052): the key lifecycle routes, the bearer resolver
 * and the guards, against a real server on a real database. Key-callable routes used here:
 * `GET /access/groups` and `GET /access/people` (`access.read`, `apiKey: true`) and
 * `GET /audit/events` (`audit.read`, `apiKey: true`). Per-route key behaviour of every other
 * key-callable route is `api-keys-routes.integration.test.ts` (E3.4-C).
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
let otherId: string;
let ownerCookie: string;
let ownerId: string;
let otherOwnerId: string;

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; embed?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) {
    headers.set("cookie", init.cookie);
    if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  }
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorBody {
  error: { code: string; reason?: string; message: string; requestId?: string };
}

async function signIn(slug: string, email: string): Promise<string> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
    headers: { origin: `http://${slug}.${CANON}` },
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    headers: { origin: `http://${slug}.${CANON}` },
  });
  expect(verify.status).toBe(200);
  return verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
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
  return withSetCookies(cookie, confirm);
}

/** A member of `workspaceId`; signed in at level 2 (fresh) when `signIn` is set. */
async function member(
  slug: string,
  workspaceId: string,
  email: string,
  role: string,
  options: { signIn?: boolean } = {},
): Promise<{ id: string; cookie: string | undefined }> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId,
    userId,
    kind: "staff",
    role: role as never,
    source: "test",
  });
  if (options.signIn !== true) return { id: m.id, cookie: undefined };
  return { id: m.id, cookie: await stepUpToMfa(slug, await signIn(slug, email)) };
}

async function sql<T = Record<string, unknown>>(workspaceId: string, query: string): Promise<T[]> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: "live" | "expired" | "revoked";
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  replacedById: string | null;
  lastUsedAt: string | null;
  createdBy: { membershipId: string; displayName: string | null };
  note: string | null;
}

async function createKey(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; key: KeyView; token: string; body: unknown }> {
  const res = await request("acme", "/api/v1/api-keys", {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
  });
  const b = await json<{ key: KeyView; token: string }>(res);
  return { status: res.status, key: b.key, token: b.token, body: b };
}

const asKey = (token: string, path = "/api/v1/access/groups", slug = "acme") =>
  request(slug, path, { headers: bearer(token) });

async function keyRow(id: string) {
  const [row] = await sql<{
    revoked_at: string | null;
    revoked_reason: string | null;
    last_used_at: string | null;
    last_used_ip: string | null;
    expires_at: string | null;
    replaced_by_id: string | null;
  }>(
    acmeId,
    `SELECT revoked_at, revoked_reason, last_used_at::text, last_used_ip, expires_at::text,
            replaced_by_id FROM core.api_key WHERE id = '${id}'`,
  );
  return row;
}

async function auditFor(resourceId: string) {
  return sql<{ action: string; meta: Record<string, unknown>; actor_kind: string }>(
    acmeId,
    `SELECT action, meta, actor_kind FROM audit.event WHERE resource_id = '${resourceId}'
      ORDER BY seq`,
  );
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      UPDATE_CHECK: "false",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  otherId = (await createWorkspace(db, { slug: "other", name: "Other" })).id;
  const owner = await member("acme", acmeId, "owner@acme.test", "owner", { signIn: true });
  ownerId = owner.id;
  ownerCookie = owner.cookie as string;
  otherOwnerId = (await member("other", otherId, "owner@other.test", "owner")).id;
  // CRM is `defaultEnabled: false`; one key-callable write below goes through it.
  const ctx = systemContext(acmeId);
  await db.withTenant(ctx, (tx) => new ModuleEnablementRepo(ctx, tx).set("crm", true));
  running.container.enablement.invalidate(acmeId);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("API key lifecycle routes", () => {
  it("creates a key (token once), lists it without secrets, and audits without the token", async () => {
    const created = await createKey(ownerCookie, {
      name: "Zapier",
      scopes: ["access.read", "access.read"],
      note: "  polls people  ",
    });
    expect(created.status).toBe(201);
    // A-2: new keys are minted `frk_` and insert under 0027's widened api_key_prefix_shape.
    expect(created.token).toMatch(/^frk_[A-Za-z0-9_-]{43}$/u);
    expect(created.key).toMatchObject({
      name: "Zapier",
      prefix: created.token.slice(0, 12),
      scopes: ["access.read"],
      status: "live",
      note: "polls people",
      createdBy: { membershipId: ownerId },
      revokedAt: null,
      lastUsedAt: null,
    });

    const list = await request("acme", "/api/v1/api-keys", { cookie: ownerCookie });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toMatch(/token|hash/iu);
    const { items } = JSON.parse(text) as { items: KeyView[] };
    expect(items.map((k) => k.id)).toContain(created.key.id);

    const audit = await auditFor(created.key.id);
    expect(audit.map((a) => a.action)).toEqual(["api_key.created"]);
    expect(JSON.stringify(audit)).not.toContain(created.token.slice(12));
    expect(audit[0]?.meta).toMatchObject({ prefix: created.key.prefix, scopes: ["access.read"] });
  });

  it("offers only key-callable scopes, marking the ones the caller holds", async () => {
    const res = await request("acme", "/api/v1/api-keys/scopes", { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const { scopes } = await json<{ scopes: { id: string; description: string; held: boolean }[] }>(
      res,
    );
    const ids = scopes.map((s) => s.id);
    expect(ids).toContain("access.read");
    expect(ids).not.toContain("api-keys.read");
    expect(ids).not.toContain("access.manage");
    expect(scopes.every((s) => s.held)).toBe(true);
    expect(scopes.find((s) => s.id === "access.read")?.description).not.toBe("");
  });

  it("refuses scopes no key-callable route needs and bad expiries", async () => {
    const notOffered = await createKey(ownerCookie, { name: "x", scopes: ["api-keys.manage"] });
    expect(notOffered.status).toBe(400);
    expect((notOffered.body as ErrorBody).error.reason).toBe("scope_not_offered");
    const past = await createKey(ownerCookie, {
      name: "x",
      scopes: ["access.read"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((past.body as ErrorBody).error.reason).toBe("invalid_expiry");
    const tooFar = await createKey(ownerCookie, {
      name: "x",
      scopes: ["access.read"],
      expiresAt: new Date(Date.now() + 3 * 366 * 86_400_000).toISOString(),
    });
    expect((tooFar.body as ErrorBody).error.reason).toBe("invalid_expiry");
  });

  it("renames a key and changes its note (audited), 404s an unknown id", async () => {
    const { key } = await createKey(ownerCookie, { name: "Before", scopes: ["access.read"] });
    const res = await request("acme", `/api/v1/api-keys/${key.id}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: JSON.stringify({ name: "After", note: null }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ key: KeyView }>(res)).key).toMatchObject({ name: "After", note: null });
    expect((await auditFor(key.id)).map((a) => a.action)).toEqual([
      "api_key.created",
      "api_key.updated",
    ]);
    const missing = await request("acme", "/api/v1/api-keys/7e57a11c-0000-4000-8000-00000000f030", {
      method: "PATCH",
      cookie: ownerCookie,
      body: JSON.stringify({ name: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  it("another workspace's owner cannot see or touch acme's keys", async () => {
    const { key } = await createKey(ownerCookie, { name: "Private", scopes: ["access.read"] });
    const globex = await member("other", otherId, "admin@other.test", "admin", { signIn: true });
    const list = await request("other", "/api/v1/api-keys", { cookie: globex.cookie });
    expect(list.status).toBe(200);
    expect((await json<{ items: KeyView[] }>(list)).items.map((k) => k.id)).not.toContain(key.id);
    const revoke = await request("other", `/api/v1/api-keys/${key.id}/revoke`, {
      method: "POST",
      cookie: globex.cookie,
    });
    expect(revoke.status).toBe(404);
    expect((await keyRow(key.id))?.revoked_at).toBeNull();
  });
});

describe("the bearer resolver and guards", () => {
  it("a key calls a key-callable route as its creator; the answer matches the session's", async () => {
    const { token } = await createKey(ownerCookie, { name: "reader", scopes: ["access.read"] });
    const withKey = await asKey(token);
    expect(withKey.status).toBe(200);
    const withSession = await request("acme", "/api/v1/access/groups", { cookie: ownerCookie });
    expect(await withKey.json()).toEqual(await withSession.json());
    expect((await asKey(token, "/api/v1/access/people")).status).toBe(200);
  });

  it("a legacy shk_ key minted before the rename still authenticates; rotating it mints frk_ (A-2)", async () => {
    // Written straight through the repo, so the row passes the database's prefix CHECK as a
    // pre-0027 key would have: the token keeps its `shk_` spelling end to end.
    const legacyToken = `shk_${randomBytes(32).toString("base64url")}`;
    const ctx = systemContext(acmeId);
    const legacy = await running.container.db.withTenant(ctx, (tx) =>
      new ApiKeyRepo(ctx, tx).insert({
        name: "legacy",
        tokenHash: apiKeyTokenHash(legacyToken),
        prefix: legacyToken.slice(0, 12),
        scopes: ["access.read"],
        createdByMembershipId: ownerId,
        expiresAt: null,
        note: null,
      }),
    );
    expect(legacy.prefix).toMatch(/^shk_[A-Za-z0-9_-]{8}$/u);
    expect((await asKey(legacyToken)).status).toBe(200);
    expect((await asKey(`frk_${legacyToken.slice(4)}`)).status).toBe(401);

    const res = await request("acme", `/api/v1/api-keys/${legacy.id}/rotate`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ graceHours: 0 }),
    });
    expect(res.status).toBe(201);
    const rotated = await json<{ key: KeyView; token: string }>(res);
    expect(rotated.token).toMatch(/^frk_[A-Za-z0-9_-]{43}$/u);
    expect(rotated.key.prefix).toBe(rotated.token.slice(0, 12));
    expect((await asKey(legacyToken)).status).toBe(401);
    expect((await asKey(rotated.token)).status).toBe(200);

    // The CHECK still refuses any other prefix.
    const bad = await running.container.db
      .withTenant(ctx, (tx) =>
        new ApiKeyRepo(ctx, tx).insert({
          name: "bad prefix",
          tokenHash: apiKeyTokenHash(`xxk_${"A".repeat(43)}`),
          prefix: "xxk_AbCdEfGh",
          scopes: ["access.read"],
          createdByMembershipId: ownerId,
          expiresAt: null,
          note: null,
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(JSON.stringify(bad, Object.getOwnPropertyNames(bad ?? {}))).toContain(
      "api_key_prefix_shape",
    );
  });

  it("a key on any route that is not key-callable is 401 api_key_not_allowed", async () => {
    const { token } = await createKey(ownerCookie, { name: "nope", scopes: ["access.read"] });
    for (const [method, path] of [
      ["GET", "/api/v1/me"],
      ["GET", "/api/v1/api-keys"],
      ["GET", "/api/v1/api-keys/scopes"],
      ["POST", "/api/v1/api-keys"],
      ["GET", "/api/v1/access/groups/7e57a11c-0000-4000-8000-00000000f030"],
      ["POST", "/api/v1/access/groups"],
      ["GET", "/api/v1/modules/enablement"],
      ["GET", "/api/v1/me/sessions"],
    ] as const) {
      const res = await request("acme", path, {
        method,
        headers: bearer(token),
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = await json<ErrorBody>(res);
      expect(body.error, `${method} ${path}`).toMatchObject({
        code: "unauthenticated",
        reason: "api_key_not_allowed",
      });
    }
  });

  it("a key whose scopes do not cover the route is 403 scope_missing", async () => {
    const { token } = await createKey(ownerCookie, {
      name: "people only",
      scopes: ["access.read"],
    });
    const res = await asKey(token, "/api/v1/audit/events");
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "forbidden",
      reason: "scope_missing",
    });
    const both = await createKey(ownerCookie, {
      name: "both",
      scopes: ["access.read", "audit.read"],
    });
    expect((await asKey(both.token, "/api/v1/audit/events")).status).toBe(200);
  });

  it("a session cookie and a key together are 400 ambiguous_credentials", async () => {
    const { token } = await createKey(ownerCookie, { name: "both", scopes: ["access.read"] });
    const res = await request("acme", "/api/v1/access/groups", {
      cookie: ownerCookie,
      headers: bearer(token),
    });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "validation_failed",
      reason: "ambiguous_credentials",
    });
    // A stale (unresolvable) session cookie counts too: which credential was meant is not ours
    // to guess.
    const stale = await request("acme", "/api/v1/access/groups", {
      headers: { ...bearer(token), cookie: "__Host-sid=not-a-session" },
    });
    expect(stale.status).toBe(400);
  });

  it("malformed, unknown, revoked, expired and other-workspace keys all answer the same 401", async () => {
    const live = await createKey(ownerCookie, { name: "to revoke", scopes: ["access.read"] });
    const revoke = await request("acme", `/api/v1/api-keys/${live.key.id}/revoke`, {
      method: "POST",
      cookie: ownerCookie,
    });
    expect(revoke.status).toBe(200);
    const expired = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: ownerId,
      scopes: ["access.read"],
    });
    await sql(
      acmeId,
      `UPDATE core.api_key SET expires_at = now() - interval '1 second' WHERE id = '${expired.id}'`,
    );
    const foreign = await mintTestApiKey(running.container.db, {
      workspaceId: otherId,
      creatorMembershipId: otherOwnerId,
      scopes: ["access.read"],
    });
    const unknown = `frk_${randomBytes(32).toString("base64url")}`;
    const unknownLegacy = `shk_${randomBytes(32).toString("base64url")}`;

    const answers: unknown[] = [];
    for (const token of [
      "shk_short",
      "frk_short",
      `shk_${"!".repeat(43)}`,
      unknown,
      unknownLegacy,
      live.token,
      expired.token,
      foreign.token,
    ]) {
      const res = await asKey(token);
      expect(res.status, token.slice(0, 12)).toBe(401);
      const body = await json<ErrorBody>(res);
      answers.push({
        ...body.error,
        requestId: undefined,
        headers: res.headers.get("content-type"),
      });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toMatchObject({ code: "unauthenticated", reason: "invalid_api_key" });
    // The foreign key still works where it belongs.
    expect((await asKey(foreign.token, "/api/v1/access/groups", "other")).status).toBe(200);
  });

  it("other bearer values are ignored as before (a plain 401 without a key reason)", async () => {
    const res = await request("acme", "/api/v1/access/groups", {
      headers: { authorization: "Bearer some-metrics-token" },
    });
    expect(res.status).toBe(401);
    expect((await json<ErrorBody>(res)).error.reason).toBeUndefined();
  });

  it("the embed API never takes a key", async () => {
    const { token } = await createKey(ownerCookie, { name: "embed", scopes: ["access.read"] });
    const res = await request("acme", "/embed/acme/api/v1/access/groups", {
      headers: bearer(token),
    });
    expect(res.status).toBe(401);
    expect((await json<ErrorBody>(res)).error.reason).toBe("api_key_not_allowed");
  });

  it("rate-limits per key: 429 with Retry-After once the 600/60 s budget is spent", async () => {
    const { key, token } = await createKey(ownerCookie, { name: "busy", scopes: ["access.read"] });
    const other = await createKey(ownerCookie, { name: "quiet", scopes: ["access.read"] });
    // The budget is spent by writing the limiter's buckets directly — this window, the one
    // before and the one after — rather than by 600 sequential hits, which under a loaded full
    // suite could straddle a window boundary and leave the sliding estimate just under the cap.
    // Production limits are untouched; the key hash is the limiter's own (sha256, base64url).
    const bucketKey = createHash("sha256").update(`api_key:${key.id}`).digest("base64url");
    const current = Math.floor(Date.now() / API_KEY_RATE_LIMIT.windowMs);
    await running.container.db.pool.query(
      `INSERT INTO core.rate_limit (key, bucket, count)
       SELECT $1, b, $2 FROM unnest($3::bigint[]) AS b
       ON CONFLICT (key, bucket) DO UPDATE SET count = EXCLUDED.count`,
      [bucketKey, API_KEY_RATE_LIMIT.limit * 10, [current - 1, current, current + 1]],
    );
    const res = await asKey(token);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json<ErrorBody>(res)).error.code).toBe("rate_limited");
    // Per key, not per workspace.
    expect((await asKey(other.token)).status).toBe(200);
  });

  it("records last use at most once a minute, with a truncated address", async () => {
    const { key, token } = await createKey(ownerCookie, { name: "touch", scopes: ["access.read"] });
    expect((await keyRow(key.id))?.last_used_at).toBeNull();
    expect((await asKey(token)).status).toBe(200);
    const first = await keyRow(key.id);
    expect(first?.last_used_at).not.toBeNull();
    expect((await asKey(token)).status).toBe(200);
    expect((await keyRow(key.id))?.last_used_at).toBe(first?.last_used_at);

    // The cross-process throttle is the conditional UPDATE itself.
    const ctx = systemContext(acmeId);
    const touch = () =>
      running.container.db.withTenant(ctx, (tx) =>
        new ApiKeyRepo(ctx, tx).touchLastUsed(key.id, "203.0.113.0/24", 60),
      );
    expect(await touch()).toBe(false);
    await sql(
      acmeId,
      `UPDATE core.api_key SET last_used_at = now() - interval '61 seconds' WHERE id = '${key.id}'`,
    );
    expect(await touch()).toBe(true);
    expect(await touch()).toBe(false);
    const list = await json<{ items: KeyView[] }>(
      await request("acme", "/api/v1/api-keys", { cookie: ownerCookie }),
    );
    expect(list.items.find((k) => k.id === key.id)?.lastUsedAt).not.toBeNull();
  });

  it("audit entries written during a key request carry meta.apiKeyId (and no session)", async () => {
    // A module service writes this entry (`crm.contact_created`), not the route: the id comes from
    // the request's async context, not from an argument anybody had to remember to pass.
    const { key, token } = await createKey(ownerCookie, {
      name: "crm writer",
      scopes: ["crm.manage"],
    });
    const res = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ displayName: "Via key" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const [row] = await sql<{
      action: string;
      meta: Record<string, unknown>;
      session_id: string | null;
      actor_membership_id: string | null;
    }>(
      acmeId,
      `SELECT action, meta, session_id, actor_membership_id FROM audit.event
        WHERE resource_id = '${id}'`,
    );
    expect(row).toMatchObject({
      action: "crm.contact_created",
      session_id: null,
      actor_membership_id: ownerId,
      meta: { apiKeyId: key.id },
    });
    // The same write with a session carries no key.
    const viaSession = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ displayName: "Via session" }),
    });
    expect(viaSession.status).toBe(201);
    const sid = (await json<{ id: string }>(viaSession)).id;
    const [plain] = await sql<{ meta: Record<string, unknown> }>(
      acmeId,
      `SELECT meta FROM audit.event WHERE resource_id = '${sid}'`,
    );
    expect(plain?.meta).not.toHaveProperty("apiKeyId");
  });
});

describe("rotation, revocation and expiry", () => {
  it("rotation with grace 0 revokes the old key at once and returns a new token", async () => {
    const old = await createKey(ownerCookie, {
      name: "rotate-now",
      scopes: ["access.read"],
      note: "n",
    });
    const res = await request("acme", `/api/v1/api-keys/${old.key.id}/rotate`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ graceHours: 0 }),
    });
    expect(res.status).toBe(201);
    const r = await json<{ key: KeyView; token: string; previous: KeyView }>(res);
    expect(r.token).not.toBe(old.token);
    expect(r.key).toMatchObject({ name: "rotate-now", scopes: ["access.read"], note: "n" });
    expect(r.previous).toMatchObject({
      status: "revoked",
      revokedReason: "rotated",
      replacedById: r.key.id,
    });
    expect((await asKey(old.token)).status).toBe(401);
    expect((await asKey(r.token)).status).toBe(200);
    expect((await auditFor(r.key.id)).map((a) => a.action)).toEqual(["api_key.rotated"]);
  });

  it("rotation with grace keeps the old key working until the grace ends, once", async () => {
    const old = await createKey(ownerCookie, { name: "rotate-later", scopes: ["access.read"] });
    const res = await request("acme", `/api/v1/api-keys/${old.key.id}/rotate`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ graceHours: 2 }),
    });
    expect(res.status).toBe(201);
    const r = await json<{ key: KeyView; token: string; previous: KeyView }>(res);
    expect(r.previous.status).toBe("live");
    const until = Date.parse(r.previous.expiresAt as string) - Date.now();
    expect(until).toBeGreaterThan(2 * 3_600_000 - 60_000);
    expect(until).toBeLessThanOrEqual(2 * 3_600_000);
    expect((await asKey(old.token)).status).toBe(200);
    expect((await asKey(r.token)).status).toBe(200);
    const again = await request("acme", `/api/v1/api-keys/${old.key.id}/rotate`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(409);
    expect((await json<ErrorBody>(again)).error.reason).toBe("already_rotated");
    // The grace window ends: the old key stops at once.
    await sql(
      acmeId,
      `UPDATE core.api_key SET expires_at = now() - interval '1 second' WHERE id = '${old.key.id}'`,
    );
    expect((await asKey(old.token)).status).toBe(401);
  });

  it("revoke is idempotent and audited once", async () => {
    const { key, token } = await createKey(ownerCookie, { name: "bye", scopes: ["access.read"] });
    for (let i = 0; i < 2; i++) {
      const res = await request("acme", `/api/v1/api-keys/${key.id}/revoke`, {
        method: "POST",
        cookie: ownerCookie,
      });
      expect(res.status).toBe(200);
      expect((await json<{ key: KeyView }>(res)).key).toMatchObject({
        status: "revoked",
        revokedReason: "revoked",
      });
    }
    expect((await auditFor(key.id)).map((a) => a.action)).toEqual([
      "api_key.created",
      "api_key.revoked",
    ]);
    expect((await asKey(token)).status).toBe(401);
    const rotate = await request("acme", `/api/v1/api-keys/${key.id}/rotate`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({}),
    });
    expect(rotate.status).toBe(409);
  });

  it("an expired key is listed as expired and refused", async () => {
    const { key, token } = await createKey(ownerCookie, {
      name: "short-lived",
      scopes: ["access.read"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await asKey(token)).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE core.api_key SET expires_at = now() - interval '1 second' WHERE id = '${key.id}'`,
    );
    expect((await asKey(token)).status).toBe(401);
    const list = await json<{ items: KeyView[] }>(
      await request("acme", "/api/v1/api-keys", { cookie: ownerCookie }),
    );
    expect(list.items.find((k) => k.id === key.id)?.status).toBe("expired");
  });
});

describe("the creator's authority", () => {
  it("a demoted creator's key is capped by the new role (403 scope_missing)", async () => {
    const admin = await member("acme", acmeId, "demoted@acme.test", "admin", { signIn: true });
    const { token } = await createKey(admin.cookie as string, {
      name: "admin key",
      scopes: ["access.read"],
    });
    expect((await asKey(token)).status).toBe(200);
    // `viewer` does not hold access.read.
    await sql(acmeId, `UPDATE core.membership SET role = 'viewer' WHERE id = '${admin.id}'`);
    const res = await asKey(token);
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.reason).toBe("scope_missing");
    // Promoted back: works again (the cap is the CURRENT role).
    await sql(acmeId, `UPDATE core.membership SET role = 'admin' WHERE id = '${admin.id}'`);
    expect((await asKey(token)).status).toBe(200);
  });

  it("a creator who left: the key stops at once and the sweep revokes it", async () => {
    const admin = await member("acme", acmeId, "leaver@acme.test", "admin", { signIn: true });
    const { key, token } = await createKey(admin.cookie as string, {
      name: "leaver key",
      scopes: ["access.read"],
    });
    const survivor = await createKey(ownerCookie, { name: "survivor", scopes: ["access.read"] });
    expect((await asKey(token)).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE core.membership SET status = 'revoked', revoked_at = now() WHERE id = '${admin.id}'`,
    );
    const res = await asKey(token);
    expect(res.status).toBe(401);
    expect((await json<ErrorBody>(res)).error.reason).toBe("invalid_api_key");

    const swept = await running.container.apiKeys.sweep();
    expect(swept.revoked).toBeGreaterThanOrEqual(1);
    expect(await keyRow(key.id)).toMatchObject({ revoked_reason: "creator_inactive" });
    expect((await keyRow(survivor.key.id))?.revoked_at).toBeNull();
    const audit = await auditFor(key.id);
    expect(audit.map((a) => a.action)).toEqual(["api_key.created", "api_key.auto_revoked"]);
    expect(audit[1]).toMatchObject({ actor_kind: "system", meta: { reason: "creator_inactive" } });
    // A second sweep finds nothing new for it.
    await running.container.apiKeys.sweep();
    expect((await auditFor(key.id)).length).toBe(2);
  });

  it("a suspended or expired creator's key is refused too", async () => {
    const a = await member("acme", acmeId, "suspended@acme.test", "admin");
    const b = await member("acme", acmeId, "expiring@acme.test", "admin");
    const ka = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: a.id,
      scopes: ["access.read"],
    });
    const kb = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: b.id,
      scopes: ["access.read"],
    });
    expect((await asKey(ka.token)).status).toBe(200);
    expect((await asKey(kb.token)).status).toBe(200);
    await sql(acmeId, `UPDATE core.membership SET status = 'suspended' WHERE id = '${a.id}'`);
    await sql(
      acmeId,
      `UPDATE core.membership SET expires_at = now() - interval '1 second' WHERE id = '${b.id}'`,
    );
    expect((await asKey(ka.token)).status).toBe(401);
    expect((await asKey(kb.token)).status).toBe(401);
  });

  it("erasing the creator revokes their keys (reason erased) and counts them", async () => {
    const admin = await member("acme", acmeId, "erased@acme.test", "admin");
    const k1 = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: admin.id,
      scopes: ["access.read"],
    });
    const k2 = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: admin.id,
      scopes: ["access.read"],
    });
    await sql(
      acmeId,
      `UPDATE core.api_key SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = '${k2.id}'`,
    );
    const ctx = systemContext(acmeId);
    const detail = await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: admin.id,
        expectedModules: [],
        actor: { membershipId: ownerId },
      }),
    );
    expect(detail.request.status).toBe("completed");
    expect(await keyRow(k1.id)).toMatchObject({ revoked_reason: "erased" });
    expect(await keyRow(k2.id)).toMatchObject({ revoked_reason: "revoked" });
    const [step] = await sql<{ counts: Record<string, number> }>(
      acmeId,
      `SELECT counts FROM core.dsar_step WHERE request_id = '${detail.request.id}'
          AND module = 'core.identity'`,
    );
    expect(step?.counts["apiKeysRevoked"]).toBe(1);
    expect((await auditFor(k1.id)).map((a) => a.action)).toEqual(["api_key.auto_revoked"]);
    expect((await asKey(k1.token)).status).toBe(401);
  });
});

describe("the live-key cap", () => {
  it("refuses the 51st live key (409 too_many_keys); revoked and expired keys do not count", async () => {
    const ctx = systemContext(acmeId);
    const live = await running.container.db.withTenant(ctx, (tx) =>
      new ApiKeyRepo(ctx, tx).countLive(new Date()),
    );
    for (let i = live; i < MAX_LIVE_API_KEYS; i++)
      await mintTestApiKey(running.container.db, {
        workspaceId: acmeId,
        creatorMembershipId: ownerId,
        scopes: ["access.read"],
      });
    const refused = await createKey(ownerCookie, { name: "one too many", scopes: ["access.read"] });
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorBody).error).toMatchObject({
      code: "conflict",
      reason: "too_many_keys",
    });
    // Revoke one: there is room again.
    const [one] = await sql<{ id: string }>(
      acmeId,
      `SELECT id FROM core.api_key WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
    );
    await request("acme", `/api/v1/api-keys/${one?.id}/revoke`, {
      method: "POST",
      cookie: ownerCookie,
    });
    expect((await createKey(ownerCookie, { name: "room", scopes: ["access.read"] })).status).toBe(
      201,
    );
    // Sanity: the digest is what the row stores, never the token.
    const [row] = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM core.api_key
        WHERE token_hash = '\\x${apiKeyTokenHash("frk_x").toString("hex")}'`,
    );
    expect(row?.n).toBe(0);
  });
});

/*
 * Fix round 1: lock order between identity erasure and the key paths (D1, D2), deterministic.
 *
 * The identity step runs under the audit chain (`DsarRequestRepo.lockById` takes it first). A key
 * path takes its key row (revoke, rotate, sweep) or its cap lock (create, rotate) and THEN the
 * chain. Each round pauses an erasure's final step right after it took the chain — a raw
 * connection holds the DSAR row it is about to lock — starts the contender, waits until it is
 * blocked too, then lets the erasure go. Before the fixes, erasure then waited for the key row /
 * workspace row the contender held while the contender waited for the chain: 40P01. Now both
 * finish and `pg_stat_database.deadlocks` does not move.
 */
describe("erasure vs the key paths never deadlock (fix round 1, D1/D2)", () => {
  const deadlocks = async () => {
    await pg.pool.query("SELECT pg_stat_clear_snapshot()");
    const [r] = (
      await pg.pool.query<{ n: string }>(
        "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
      )
    ).rows;
    return Number(r?.n ?? 0);
  };
  const settle = () => new Promise((r) => setTimeout(r, 1_500));
  /** Waits until at least `atLeast` backends other than `holder` wait on a lock. */
  const blockedBehind = async (holder: number, atLeast: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pg.pool.query<{ n: number }>(
        "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND pid <> $1",
        [holder],
      );
      if ((rows[0]?.n ?? 0) >= atLeast) return;
      if (Date.now() > deadline) throw new Error(`fewer than ${atLeast} blocked backends`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** One round: erasure of a fresh admin paused under the chain, `contend` started, released. */
  async function round(
    contend: (ctx: { adminId: string; keyId: string }) => Promise<number>,
  ): Promise<void> {
    const n = Math.random().toString(36).slice(2, 8);
    const admin = await member("acme", acmeId, `race-${n}@acme.test`, "admin");
    const key = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: admin.id,
      scopes: ["access.read"],
    });
    const sys = systemContext(acmeId);
    const erasure = createErasureService({
      db: running.container.db,
      audit: running.container.audit,
      bookingSuppressionKeys: running.container.envelope,
    });
    const detail = await running.container.db.withTenant(sys, (tx) =>
      erasure.request(sys, tx, {
        membershipId: admin.id,
        expectedModules: ["probe"],
        actor: { membershipId: ownerId },
      }),
    );
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '15s'");
      const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      await holder.query("SELECT id FROM core.dsar_request WHERE id = $1 FOR UPDATE", [
        detail.request.id,
      ]);
      // The last report: runs the identity step (and revokes the member's keys) under the chain.
      const step = running.container.db.withTenant(sys, (tx) =>
        erasure.completeStep(sys, tx, detail.request.id, "probe", {}),
      );
      await blockedBehind(pid, 1);
      const contender = contend({ adminId: admin.id, keyId: key.id });
      await blockedBehind(pid, 2);
      await holder.query("COMMIT");
      await step;
      expect(await contender).toBeLessThan(500);
      expect(await keyRow(key.id)).toMatchObject({ revoked_reason: expect.any(String) });
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  }

  const post = async (path: string, body?: unknown) =>
    (
      await request("acme", path, {
        method: "POST",
        cookie: ownerCookie,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).status;

  it("a key minted for the member after the pre-lock cannot deadlock the identity step (fix round 2)", async () => {
    /*
     * The module-handler sequence: the container wrapper pre-locks → the handler audits (takes the
     * chain) → it reports, and `lockById` runs the identity step under the chain. A key minted for
     * the member between the pre-lock and the chain, then revoked (key row → chain) while the
     * step waits to lock it (chain → key row), was a 40P01. The pre-lock now holds the cap lock,
     * so the mint waits for the erasure — and then refuses, the member being gone.
     */
    await running.container.relay.stop();
    try {
      await settle();
      const before = await deadlocks();
      const sys = systemContext(acmeId);
      const db = running.container.db;
      await sql(
        acmeId,
        "UPDATE core.api_key SET revoked_at = now(), revoked_reason = 'revoked' WHERE revoked_at IS NULL",
      );
      const admin = await member("acme", acmeId, `late-${Date.now()}@acme.test`, "admin");
      const row = await db.withTenant(sys, (tx) => new MembershipRepo(sys, tx).byId(admin.id));
      if (row === undefined) throw new Error("no membership");
      const adminCtx = {
        workspaceId: acmeId,
        actorKind: "staff" as const,
        membershipId: row.id,
        userId: row.userId,
      };
      const ownerCtx = { workspaceId: acmeId, actorKind: "staff" as const, membershipId: ownerId };
      const erasure = createErasureService({
        db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      });
      const detail = await db.withTenant(sys, (tx) =>
        erasure.request(sys, tx, {
          membershipId: admin.id,
          expectedModules: ["probe"],
          actor: { membershipId: ownerId },
        }),
      );
      const gate = () => {
        let open: () => void = () => {};
        const p = new Promise<void>((r) => {
          open = r;
        });
        return { p, open };
      };
      const prelocked = gate();
      const chainHeld = gate();
      const toChain = gate();
      const toReport = gate();
      const handler = db.withTenant(sys, async (tx) => {
        await prelockIdentityErasure(sys, tx, admin.id);
        prelocked.open();
        await toChain.p;
        // What analytics / crm do before they report: an audit entry (the chain).
        await running.container.audit.record(tx, sys, {
          action: "api_key.updated",
          resourceKind: "api_key",
          meta: { probe: true },
        });
        chainHeld.open();
        await toReport.p;
        await erasure.completeStep(sys, tx, detail.request.id, "probe", {});
      });
      await prelocked.p;
      const mint = running.container.apiKeys.create(adminCtx, row, {
        name: "late",
        scopes: ["access.read"],
      });
      const settled = { done: false };
      void mint.then(
        () => {
          settled.done = true;
        },
        () => {
          settled.done = true;
        },
      );
      // Either the mint finishes (no cap lock held: the old bug) or it waits behind the erasure.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await pg.pool.query<{ n: number }>(
          "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted",
        );
        if (settled.done || (rows[0]?.n ?? 0) >= 1) break;
        if (Date.now() > deadline) throw new Error("the mint neither finished nor blocked");
        await new Promise((r) => setTimeout(r, 25));
      }
      toChain.open();
      await chainHeld.p;
      let revoke: Promise<unknown> | undefined;
      if (settled.done) {
        const minted = await mint;
        // Revoke the new key: key row → chain, and the chain is the handler's.
        revoke = running.container.apiKeys.revoke(ownerCtx, minted.key.id);
        const until = Date.now() + 10_000;
        for (;;) {
          const { rows } = await pg.pool.query<{ n: number }>(
            "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted",
          );
          if ((rows[0]?.n ?? 0) >= 1) break;
          if (Date.now() > until) throw new Error("the revoke did not block");
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      toReport.open();
      const results = await Promise.allSettled([handler, mint, ...(revoke ? [revoke] : [])]);
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason as { code?: string; cause?: { code?: string }; details?: unknown });
      expect(results[0]?.status, JSON.stringify(failures)).toBe("fulfilled");
      // The only acceptable refusal: the mint, once the erasure let it run, finds the member gone.
      for (const f of failures)
        expect(f).toMatchObject({ code: "conflict", details: { reason: "creator_not_live" } });
      const [live] = await sql<{ n: number }>(
        acmeId,
        `SELECT count(*)::int AS n FROM core.api_key
          WHERE created_by_membership_id = '${admin.id}' AND revoked_at IS NULL`,
      );
      expect(live?.n).toBe(0);
      await settle();
      expect(await deadlocks()).toBe(before);
    } finally {
      running.container.relay.start();
    }
  }, 60_000);

  it("revoke, rotate, create and the sweep against the identity step", async () => {
    // The outbox relay would run every module's erasure handler concurrently: stopped, so the
    // only transactions in play are the ones each round starts.
    await running.container.relay.stop();
    try {
      // Room under the cap for the create rounds (the cap test above filled it).
      await sql(
        acmeId,
        "UPDATE core.api_key SET revoked_at = now(), revoked_reason = 'revoked' WHERE revoked_at IS NULL",
      );
      await settle();
      const before = await deadlocks();
      for (let i = 0; i < 2; i++) {
        await round(({ keyId }) => post(`/api/v1/api-keys/${keyId}/revoke`));
        await round(({ keyId }) => post(`/api/v1/api-keys/${keyId}/rotate`, { graceHours: 1 }));
        await round(() => post("/api/v1/api-keys", { name: "racing", scopes: ["access.read"] }));
        // A dead creator's key elsewhere in the workspace, so the sweep has something to audit.
        const dead = await member("acme", acmeId, `dead-${i}-${Date.now()}@acme.test`, "admin");
        await mintTestApiKey(running.container.db, {
          workspaceId: acmeId,
          creatorMembershipId: dead.id,
          scopes: ["access.read"],
        });
        await sql(
          acmeId,
          `UPDATE core.membership SET status = 'suspended' WHERE id = '${dead.id}'`,
        );
        await round(async () => {
          await running.container.apiKeys.sweep();
          return 200;
        });
      }
      await settle();
      expect(await deadlocks()).toBe(before);
    } finally {
      running.container.relay.start();
    }
  }, 120_000);

  it("key lifecycle audit entries carry the session (D4)", async () => {
    const { key } = await createKey(ownerCookie, { name: "with session", scopes: ["access.read"] });
    const rows = await sql<{ session_id: string | null }>(
      acmeId,
      `SELECT session_id FROM audit.event WHERE resource_id = '${key.id}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.session_id).not.toBeNull();
  });
  it("a chained rotation cannot grow the workspace past the cap (D3)", async () => {
    const ctx = systemContext(acmeId);
    const live = () =>
      running.container.db.withTenant(ctx, (tx) => new ApiKeyRepo(ctx, tx).countLive(new Date()));
    // Exactly the cap: revoke everything, then mint 50.
    await sql(
      acmeId,
      "UPDATE core.api_key SET revoked_at = now(), revoked_reason = 'revoked' WHERE revoked_at IS NULL",
    );
    for (let i = await live(); i < MAX_LIVE_API_KEYS; i++)
      await mintTestApiKey(running.container.db, {
        workspaceId: acmeId,
        creatorMembershipId: ownerId,
        scopes: ["access.read"],
      });
    const [first] = await sql<{ id: string }>(
      acmeId,
      `SELECT id FROM core.api_key WHERE revoked_at IS NULL AND replaced_by_id IS NULL
          AND (expires_at IS NULL OR expires_at > now()) ORDER BY id LIMIT 1`,
    );
    const rotate = (id: string, graceHours: number) =>
      request("acme", `/api/v1/api-keys/${id}/rotate`, {
        method: "POST",
        cookie: ownerCookie,
        body: JSON.stringify({ graceHours }),
      });
    const one = await rotate(first?.id as string, 168);
    expect(one.status).toBe(201);
    expect(await live()).toBe(MAX_LIVE_API_KEYS + 1);
    const next = (await json<{ key: KeyView }>(one)).key.id;
    const two = await rotate(next, 168);
    expect(two.status).toBe(409);
    expect((await json<ErrorBody>(two)).error.reason).toBe("too_many_keys");
    // Grace 0 is net zero, so it is always allowed.
    expect((await rotate(next, 0)).status).toBe(201);
    expect(await live()).toBe(MAX_LIVE_API_KEYS + 1);
  });
});
