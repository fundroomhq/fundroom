import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { setWorkspaceHold } from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID, type Tx } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { ControlPlaneHooks, ProvisionedWorkspace } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cellsCommand } from "./cli-commands/cells.js";
import { operatorCommand } from "./cli-commands/operator.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { mintTestApiKey } from "./test/api-keys.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The operator API end to end (E3.10 §5.2, agent A): the CLI grant / revoke, minting the operator
 * session (and every refusal: not an operator, level 1, a proof older than 10 minutes, outside
 * PLATFORM_OPERATOR_CIDRS, a tenant host), the boundary on every operator route (a tenant session,
 * an API key, a revoked operator mid-session — all a plain 404), the operator cookie being no
 * session at all on tenant routes, provisioning in one transaction with the hooks, the workspace
 * list / detail / plan and cell changes / suspend / unsuspend with both audit chains, and cells,
 * operators, the platform chain and health.
 *
 * Run once with FUNDROOM_TEST_POOL_MAX=1 (the provisioning transaction, the hooks and the dual
 * audits must never need a second connection).
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const IN_NET = "10.20.30.40";
const OUT_NET = "203.0.113.9";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
let acmeOwner: { userId: string; membershipId: string };
let operatorUserId: string;
/** The minted operator session (`__Host-op_sid`). */
let opCookie: string;

const hookCalls: ProvisionedWorkspace[] = [];
const hookMode: { hold: boolean; fail: boolean } = { hold: false, fail: false };

async function request(
  host: string,
  path: string,
  init: RequestInit & {
    cookie?: string | undefined;
    ip?: string | undefined;
    authorization?: string | undefined;
    origin?: string | undefined;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  headers.set("x-forwarded-for", init.ip ?? IN_NET);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.method && init.method !== "GET") headers.set("origin", init.origin ?? `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const op = (path: string, init: Parameters<typeof request>[2] = {}) =>
  request(CANON, `/api/v1/platform${path}`, { cookie: opCookie, ...init });

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
}

async function userSession(
  userId: string,
  opts: { level?: 1 | 2; authTime?: Date } = {},
): Promise<string> {
  const s = await running.container.auth.sessions.startSession({
    userId,
    population: "staff",
    context: "first_party",
    authLevel: opts.level ?? 2,
    ...(opts.authTime === undefined ? {} : { authTime: opts.authTime }),
  });
  // A level-2 session's proof: the factor that gave it was just used (as a real step-up does).
  if ((opts.level ?? 2) === 2) {
    await superQuery(
      `UPDATE core.credential SET last_used_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND kind IN ('totp', 'passkey')`,
      [userId],
    );
  }
  return `__Host-sid=${s.token}`;
}

async function mint(cookie: string, ip = IN_NET, host = CANON): Promise<Response> {
  return request(host, "/api/v1/platform/session", { method: "POST", cookie, ip });
}

function opSidOf(res: Response): string | undefined {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-op_sid="));
  return line?.split(";")[0];
}

async function cli(argv: string[], command = operatorCommand) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await command(argv, {
    db: running.container.db,
    audit: running.container.audit,
    osUser: "tester",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Audit rows as the superuser (the chains are fenced from each other). */
async function chain(
  workspaceId: string,
  actionLike: string,
): Promise<
  {
    action: string;
    actor_kind: string;
    actor_user_id: string | null;
    meta: Record<string, unknown>;
  }[]
> {
  const r = await pg.pool.query(
    `SELECT action, actor_kind, actor_user_id::text AS actor_user_id, meta FROM audit.event
      WHERE workspace_id = $1 AND action LIKE $2 ORDER BY seq`,
    [workspaceId, actionLike],
  );
  return r.rows;
}

async function superQuery<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  return (await pg.pool.query(sql, args)).rows as T[];
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
      DATABASE_POOL_MAX: process.env["FUNDROOM_TEST_POOL_MAX"] ?? "6",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      PLATFORM_OPERATOR_CIDRS: "10.0.0.0/8,2001:db8::/32",
      TRUST_PROXY: "true",
      ROLES: "api,web",
      UPDATE_CHECK: "false",
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
  const { db, identityDeps } = running.container;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  const owner = await provisionUser(identityDeps, { email: "owner@acme.test" });
  const m = await provisionMembership(identityDeps, {
    workspaceId: acmeId,
    userId: owner.userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  acmeOwner = { userId: owner.userId, membershipId: m.id };
  await superQuery(
    `INSERT INTO core.plan (id, name, limits) VALUES ('starter', 'Starter', '{"staffSeats": 5}'),
       ('pro', 'Pro', '{}'), ('legacy', 'Legacy', '{}');
     UPDATE core.plan SET archived_at = now() WHERE id = 'legacy';
     -- E3.11: one database = one region, so every cell here is 'eu'.
     INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-2', 'eu', 'https://eu-2.example.test');
     INSERT INTO core.cell (id, region, public_origin, status) VALUES ('old-1', 'eu', '', 'draining');`,
  );
  // The provisioning hooks (sanctions, billing) replaced by a recorder that can hold or fail.
  const recorder: ControlPlaneHooks = {
    async onWorkspaceCreated(tx, ws) {
      hookCalls.push(ws);
      if (hookMode.fail) throw new Error("hook refused");
      if (hookMode.hold) {
        await setWorkspaceHold(
          tx as unknown as Tx,
          {
            workspaceId: ws.id,
            hold: "sanctions_review",
            on: true,
            actor: { kind: "system", source: "sanctions" },
          },
          { audit: running.container.audit, invalidate: () => {} },
        );
      }
    },
  };
  Object.assign(running.container.sanctions, { hooks: recorder });
  Object.assign(running.container.billing, { hooks: {} });

  // An operator needs an account that already holds a second factor (R1-H1): a confirmed
  // authenticator enrolled a day ago.
  const opUser = await provisionUser(identityDeps, { email: "ops@platform.test" });
  await superQuery(
    `INSERT INTO core.credential (user_id, kind, secret, confirmed_at, created_at)
       VALUES ($1, 'totp', 'sealed', now() - interval '1 day', now() - interval '1 day')`,
    [opUser.userId],
  );
  const granted = await cli(["grant", "Ops@Platform.test"]);
  expect(granted.code).toBe(0);
  const [row] = await superQuery<{ user_id: string }>(
    `SELECT o.user_id::text AS user_id FROM core.platform_operator o
       JOIN core.user_identity ui ON ui.user_id = o.user_id WHERE ui.identifier = 'ops@platform.test'`,
  );
  operatorUserId = (row as { user_id: string }).user_id;
}, 240_000);

/*
 * A fresh operator session per test: identity's concurrent-session cap counts every population
 * (handshake note), so a test that mints more sessions for the operator may end an older one.
 */
beforeEach(async () => {
  const minted = await mint(await userSession(operatorUserId));
  expect(minted.status).toBe(200);
  opCookie = opSidOf(minted) as string;
});

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("fundroom operator", () => {
  it("grants an account with a second factor, is idempotent, lists, and audits on the platform chain", async () => {
    const again = await cli(["grant", "ops@platform.test"]);
    expect(again).toMatchObject({ code: 0 });
    expect(again.out).toContain("already an operator");
    const list = await cli(["list", "--json"]);
    const rows = JSON.parse(list.out) as { email: string; createdBy: string; revokedAt: null }[];
    expect(rows).toEqual([
      expect.objectContaining({
        email: "ops@platform.test",
        createdBy: "cli:tester",
        revokedAt: null,
      }),
    ]);
    const audits = await chain(PLATFORM_WORKSPACE_ID, "operator.grant");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.meta).toMatchObject({
      userId: operatorUserId,
      regrant: false,
      source: "cli",
    });
    expect(await cli(["grant"])).toMatchObject({ code: 2 });
    expect(await cli(["grant", "not-an-address"])).toMatchObject({ code: 2 });
    expect(await cli(["revoke", "nobody@platform.test"])).toMatchObject({ code: 1 });
    // R1-H1 (a): never a mailbox alone — no account, or an account without a passkey or a
    // confirmed authenticator, is refused (and nothing is granted or audited).
    const unknown = await cli(["grant", "nobody@platform.test"]);
    expect(unknown).toMatchObject({ code: 1 });
    expect(unknown.err).toContain("refused");
    await provisionUser(running.container.identityDeps, { email: "mailbox@platform.test" });
    await superQuery(
      `INSERT INTO core.credential (user_id, kind, secret)
         SELECT user_id, 'totp', 'sealed' FROM core.user_identity WHERE identifier = 'mailbox@platform.test'`,
    );
    // An unconfirmed authenticator is no factor either.
    const bare = await cli(["grant", "mailbox@platform.test"]);
    expect(bare).toMatchObject({ code: 1 });
    expect(bare.err).toContain("no passkey or authenticator");
    expect(await chain(PLATFORM_WORKSPACE_ID, "operator.grant")).toHaveLength(1);
    // No tenant context ever sees the operator table, not even for its own user.
    const own = await running.container.db.withTenant(
      { workspaceId: acmeId, actorKind: "system" },
      (tx) => tx.execute("SELECT count(*)::int AS n FROM core.platform_operator"),
    );
    expect((own.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("minting an operator session", () => {
  it("sets a SameSite=Strict, HttpOnly, Secure __Host-op_sid and audits the start", async () => {
    const res = await mint(await userSession(operatorUserId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; expiresAt: string };
    expect(body.ok).toBe(true);
    // 12 h absolute at most.
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
    const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-op_sid=")) ?? "";
    expect(line).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Strict/u);
    const [row] = await superQuery<{ population: string; auth_level: number }>(
      `SELECT population::text AS population, auth_level FROM core.session
        WHERE user_id = $1 AND population = 'operator' ORDER BY created_at DESC LIMIT 1`,
      [operatorUserId],
    );
    expect(row).toEqual({ population: "operator", auth_level: 2 });
    expect((await chain(PLATFORM_WORKSPACE_ID, "operator.session_start")).length).toBeGreaterThan(
      1,
    );
  });

  it("is a plain 404 for a live user who is not an operator (even fresh at level 2)", async () => {
    const res = await mint(await userSession(acmeOwner.userId));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(opSidOf(res)).toBeUndefined();
  });

  it("asks a live operator to step up at level 1 or with a proof older than 10 minutes", async () => {
    const level1 = await mint(await userSession(operatorUserId, { level: 1 }));
    expect(level1.status).toBe(403);
    expect((await level1.json()) as unknown).toMatchObject({
      error: { code: "step_up_required", reason: "level" },
    });
    const stale = await mint(
      await userSession(operatorUserId, { authTime: new Date(Date.now() - 11 * 60_000) }),
    );
    expect(stale.status).toBe(403);
    expect((await stale.json()) as unknown).toMatchObject({
      error: { code: "step_up_required", reason: "fresh" },
    });
    expect(opSidOf(level1)).toBeUndefined();
    expect(opSidOf(stale)).toBeUndefined();
  });

  it("is a plain 404 outside PLATFORM_OPERATOR_CIDRS and on any host but the canonical one", async () => {
    // Fresh user sessions each time: see the handshake note on identity's concurrent-session cap.
    const outside = await mint(await userSession(operatorUserId), OUT_NET);
    expect(outside.status).toBe(404);
    expect(await errorCode(outside)).toBe("not_found");
    expect((await mint(await userSession(operatorUserId), "2001:db8::7")).status).toBe(200);
    expect(
      (await mint(await userSession(operatorUserId), IN_NET, `acme.${CANON}`)).status,
    ).not.toBe(200);
    const path = await request(CANON, "/w/acme/api/v1/platform/session", {
      method: "POST",
      cookie: await userSession(operatorUserId),
    });
    expect(path.status).not.toBe(200);
    expect(opSidOf(path)).toBeUndefined();
    // Without any session: the route's own requirement.
    expect((await mint("")).status).toBe(401);
  });

  it("refuses a level-2 proof from a factor enrolled after the session started (R1-H1)", async () => {
    // Someone who controls the operator's mailbox signs in (level 1) …
    const s = await running.container.auth.sessions.startSession({
      userId: operatorUserId,
      population: "staff",
      context: "first_party",
      authLevel: 1,
    });
    // … enrols a passkey of their own inside that session and steps up with it.
    await superQuery(
      `INSERT INTO core.credential (user_id, kind, external_id, public_key, sign_count, created_at, last_used_at)
         VALUES ($1, 'passkey', 'mallory-key', decode('00', 'hex'), 0, now(), now())`,
      [operatorUserId],
    );
    await superQuery(
      `UPDATE core.credential SET last_used_at = NULL WHERE user_id = $1 AND kind = 'totp'`,
      [operatorUserId],
    );
    const stepped = await running.container.auth.sessions.stepUp(s.session.sessionId, 2, "passkey");
    const res = await mint(`__Host-sid=${stepped.token}`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
    expect(opSidOf(res)).toBeUndefined();
    await superQuery(`DELETE FROM core.credential WHERE external_id = 'mallory-key'`);
    // A host-asserted level 2 with no factor used at all is refused too.
    const bare = await running.container.auth.sessions.startSession({
      userId: operatorUserId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
    });
    expect((await mint(`__Host-sid=${bare.token}`)).status).toBe(403);
    // The operator's own, older authenticator still works.
    expect((await mint(await userSession(operatorUserId))).status).toBe(200);
  });

  it("refuses a factor enrolled after the grant, even from a later session (fix round 2)", async () => {
    // Enrol a passkey (after the grant), sign in AGAIN so it predates the session, step up with it.
    await superQuery(
      `INSERT INTO core.credential (user_id, kind, external_id, public_key, sign_count, created_at)
         VALUES ($1, 'passkey', 'late-key', decode('00', 'hex'), 0, now())`,
      [operatorUserId],
    );
    await superQuery(
      `UPDATE core.credential SET last_used_at = NULL WHERE user_id = $1 AND kind = 'totp'`,
      [operatorUserId],
    );
    try {
      const s = await running.container.auth.sessions.startSession({
        userId: operatorUserId,
        population: "staff",
        context: "first_party",
        authLevel: 1,
      });
      await superQuery(
        `UPDATE core.credential SET last_used_at = now() WHERE external_id = 'late-key'`,
      );
      const stepped = await running.container.auth.sessions.stepUp(
        s.session.sessionId,
        2,
        "passkey",
      );
      const res = await mint(`__Host-sid=${stepped.token}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe(
        "factor_too_new",
      );
    } finally {
      await superQuery(`DELETE FROM core.credential WHERE external_id = 'late-key'`);
    }
  });

  it("an operator session cannot mint another one", async () => {
    const token = opCookie.split("=")[1] as string;
    const res = await mint(`__Host-sid=${token}`);
    expect(res.status).not.toBe(200);
    expect(opSidOf(res)).toBeUndefined();
  });
});

describe("the operator boundary", () => {
  const routes: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/workspaces"],
    ["GET", `/workspaces/7e57a11c-0000-4000-8000-00000000f030`],
    ["GET", "/cells"],
    ["GET", "/operators"],
    ["GET", "/audit"],
    ["GET", "/health"],
    ["POST", "/workspaces"],
    ["DELETE", "/session"],
  ];

  it("admits the operator session on every route", async () => {
    for (const path of ["/me", "/workspaces", "/cells", "/operators", "/audit", "/health"]) {
      const res = await op(path);
      expect(res.status, path).toBe(200);
    }
    const me = (await (await op("/me")).json()) as {
      userId: string;
      email: string;
      cellId: string;
    };
    expect(me).toMatchObject({
      userId: operatorUserId,
      email: "ops@platform.test",
      cellId: "default",
    });
  });

  it("answers every other caller with the same 404: tenant session, API key, wrong network, wrong host", async () => {
    const acmeCookie = await userSession(acmeOwner.userId);
    const { token } = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: acmeOwner.membershipId,
      scopes: ["access.read"],
    });
    const callers: [string, Parameters<typeof request>[2]][] = [
      ["anonymous", {}],
      ["tenant owner session", { cookie: acmeCookie }],
      ["operator's own user session", { cookie: await userSession(operatorUserId) }],
      ["operator token in the tenant cookie", { cookie: `__Host-sid=${opCookie.split("=")[1]}` }],
      ["operator outside the network", { cookie: opCookie, ip: OUT_NET }],
    ];
    for (const [who, init] of callers) {
      for (const [method, path] of routes) {
        const res = await request(CANON, `/api/v1/platform${path}`, {
          method,
          ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
          ...init,
        });
        expect(res.status, `${who}: ${method} ${path}`).toBe(404);
        expect(await errorCode(res), `${who}: ${method} ${path}`).toBe("not_found");
      }
    }
    // An API key: on the tenant host the operator surface is the same 404; on the canonical host
    // no key can be valid (there is no workspace to look it up in), so every path — the operator
    // surface and a path that does not exist alike — gets the key resolver's 401.
    for (const [method, path] of routes) {
      const res = await request(`acme.${CANON}`, `/api/v1/platform${path}`, {
        method,
        authorization: `Bearer ${token}`,
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expect(res.status, `api key: ${method} ${path}`).toBe(404);
    }
    const nowhere = await request(CANON, "/api/v1/no-such-path", {
      authorization: `Bearer ${token}`,
    });
    for (const [method, path] of routes) {
      const res = await request(CANON, `/api/v1/platform${path}`, {
        method,
        authorization: `Bearer ${token}`,
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expect(res.status, `api key on canonical: ${method} ${path}`).toBe(nowhere.status);
      expect(await errorCode(res)).toBe(await errorCode(nowhere));
    }
    // The operator's cookie on a tenant host or path: 404 too.
    expect(
      (await request(`acme.${CANON}`, "/api/v1/platform/me", { cookie: opCookie })).status,
    ).toBe(404);
    expect((await request(CANON, "/w/acme/api/v1/platform/me", { cookie: opCookie })).status).toBe(
      404,
    );
  });

  it("the operator session is no session on tenant routes", async () => {
    const token = opCookie.split("=")[1] as string;
    for (const cookie of [opCookie, `__Host-sid=${token}`]) {
      expect((await request(`acme.${CANON}`, "/api/v1/me", { cookie })).status).toBe(401);
      expect((await request(CANON, "/api/v1/me", { cookie })).status).toBe(401);
      expect((await request(`acme.${CANON}`, "/api/v1/access/people", { cookie })).status).toBe(
        401,
      );
    }
  });

  it("refuses a cross-origin write with a live operator cookie", async () => {
    const res = await op("/workspaces", {
      method: "POST",
      body: "{}",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf_rejected");
  });

  it("a revoke ends it on the next request; signing out ends the session", async () => {
    // A second operator (an account with an authenticator), signed in, then revoked by the CLI
    // mid-session.
    const secondUser = await provisionUser(running.container.identityDeps, {
      email: "second@platform.test",
    });
    await superQuery(
      `INSERT INTO core.credential (user_id, kind, secret, confirmed_at, created_at)
         VALUES ($1, 'totp', 'sealed', now() - interval '1 day', now() - interval '1 day')`,
      [secondUser.userId],
    );
    const granted = await cli(["grant", "second@platform.test"]);
    expect(granted.code).toBe(0);
    const [row] = await superQuery<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM core.user_identity WHERE identifier = 'second@platform.test'`,
    );
    const second = opSidOf(await mint(await userSession((row as { user_id: string }).user_id)));
    expect((await op("/me", { cookie: second })).status).toBe(200);
    const revoked = await cli(["revoke", "second@platform.test"]);
    expect(revoked).toMatchObject({ code: 0 });
    expect(revoked.out).toContain("1 operator session(s) ended");
    expect((await op("/me", { cookie: second })).status).toBe(404);
    // The row check alone refuses it too (not only the session revoke): re-grant, then revoke the
    // row only, behind the CLI's back.
    await cli(["grant", "second@platform.test"]);
    const again = opSidOf(await mint(await userSession((row as { user_id: string }).user_id)));
    expect((await op("/me", { cookie: again })).status).toBe(200);
    await superQuery(`UPDATE core.platform_operator SET revoked_at = now() WHERE user_id = $1`, [
      (row as { user_id: string }).user_id,
    ]);
    expect((await op("/me", { cookie: again })).status).toBe(404);
    expect(await chain(PLATFORM_WORKSPACE_ID, "operator.revoke")).toHaveLength(1);

    // Sign-out: 204, the cookie cleared, the session dead, audited.
    const mine = opSidOf(await mint(await userSession(operatorUserId))) as string;
    const out = await op("/session", { method: "DELETE", cookie: mine });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join()).toMatch(/__Host-op_sid=; .*Max-Age=0/u);
    expect((await op("/me", { cookie: mine })).status).toBe(404);
    expect((await chain(PLATFORM_WORKSPACE_ID, "operator.session_end")).length).toBe(1);
  });
});

interface Detail {
  id: string;
  slug: string;
  status: string;
  suspendedReason: string | null;
  planId: string | null;
  cellId: string;
  legalName: string | null;
  country: string | null;
  owners: { email: string }[];
  sanctions: unknown;
}

const DETAIL_KEYS = [
  "cellId",
  "country",
  "createdAt",
  "customDomains",
  "deletedAt",
  "holds",
  "id",
  "legalName",
  "name",
  "owners",
  "planId",
  "sanctions",
  "slug",
  "status",
  "subscription",
  "suspendedReason",
  "usage",
];

async function create(body: Record<string, unknown>): Promise<Response> {
  return op("/workspaces", { method: "POST", body: JSON.stringify(body) });
}

const newWorkspace = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: `${slug} Inc`,
  legalName: `${slug} Holdings Ltd`,
  country: "DE",
  ownerEmail: `founder@${slug}.test`,
  planId: "starter",
  ...extra,
});

describe("provisioning (POST /platform/workspaces)", () => {
  it("creates, seeds, invites the owner, runs the hooks in-tx, and audits both chains", async () => {
    const since = mailer.sent.length;
    const res = await create(newWorkspace("globex"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Detail;
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    expect(body).toMatchObject({
      slug: "globex",
      status: "active",
      planId: "starter",
      cellId: "default",
      legalName: "globex Holdings Ltd",
      country: "DE",
      owners: [],
      sanctions: null,
    });
    expect(hookCalls.at(-1)).toEqual({
      id: body.id,
      slug: "globex",
      legalName: "globex Holdings Ltd",
      country: "DE",
      planId: "starter",
      ownerEmail: "founder@globex.test",
    });
    // The owner is invited (staff/owner), by email, after commit.
    const [invite] = await superQuery<{ kind: string; role: string; status: string }>(
      `SELECT kind::text, role::text, status::text FROM core.invite WHERE workspace_id = $1`,
      [body.id],
    );
    expect(invite).toEqual({ kind: "staff", role: "owner", status: "pending" });
    expect(mailer.sent.slice(since).some((m) => m.to === "founder@globex.test")).toBe(true);
    // Seeded like setup: the privacy notice and the default disclaimer.
    const docs = await superQuery<{ slug: string }>(
      `SELECT slug FROM core.legal_document WHERE workspace_id = $1 ORDER BY slug`,
      [body.id],
    );
    expect(docs.map((d) => d.slug)).toEqual(["offering-legends", "privacy-notice"]);
    const tenant = await chain(body.id, "workspace.created");
    // R1-L5: the tenant's chain says an operator acted, never which one.
    expect(tenant).toEqual([
      expect.objectContaining({
        actor_kind: "host",
        actor_user_id: null,
        meta: expect.objectContaining({ operator: true, source: "platform", planId: "starter" }),
      }),
    ]);
    const platform = (await chain(PLATFORM_WORKSPACE_ID, "workspace.created")).filter(
      (r) => r.meta["workspaceId"] === body.id,
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]?.actor_user_id).toBe(operatorUserId);
    // It is live for its tenant host at once.
    expect((await request(`globex.${CANON}`, "/api/v1/modules")).status).toBe(200);
  });

  it("a hook that holds the workspace leaves it pending_review", async () => {
    hookMode.hold = true;
    try {
      const res = await create(newWorkspace("held-co", { planId: null }));
      expect(res.status).toBe(201);
      expect((await res.json()) as unknown).toMatchObject({
        status: "pending_review",
        holds: ["sanctions_review"],
      });
    } finally {
      hookMode.hold = false;
    }
  });

  it("a failing hook rolls everything back: no workspace, no invite, no audit", async () => {
    hookMode.fail = true;
    try {
      const res = await create(newWorkspace("doomed"));
      expect(res.status).toBe(500);
    } finally {
      hookMode.fail = false;
    }
    expect(await superQuery(`SELECT id FROM core.workspace WHERE slug = 'doomed'`)).toEqual([]);
    expect(
      await superQuery(`SELECT id FROM core.invite WHERE email = 'founder@doomed.test'`),
    ).toEqual([]);
    expect(
      await superQuery(
        `SELECT id FROM audit.event WHERE action = 'workspace.created' AND meta->>'slug' = 'doomed'`,
      ),
    ).toEqual([]);
  });

  it("refuses a taken slug (409 slug_taken), an archived plan and a draining cell", async () => {
    const taken = await create(newWorkspace("acme"));
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("slug_taken");
    const archived = await create(newWorkspace("legacy-co", { planId: "legacy" }));
    expect(archived.status).toBe(400);
    expect((await archived.json()) as unknown).toMatchObject({ error: { field: "planId" } });
    const missing = await create(newWorkspace("ghost-co", { planId: "nope" }));
    expect(missing.status).toBe(400);
    const draining = await create(newWorkspace("drain-co", { cellId: "old-1" }));
    expect(draining.status).toBe(400);
    expect((await draining.json()) as unknown).toMatchObject({ error: { field: "cellId" } });
    expect(
      await superQuery(
        `SELECT slug FROM core.workspace WHERE slug IN ('legacy-co', 'ghost-co', 'drain-co')`,
      ),
    ).toEqual([]);
  });

  it("two concurrent creates of one slug: one 201, one 409, one workspace", async () => {
    const [a, b] = await Promise.all([
      create(newWorkspace("race-co", { ownerEmail: "a@race.test" })),
      create(newWorkspace("race-co", { ownerEmail: "b@race.test" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = await superQuery<{ id: string }>(
      `SELECT id FROM core.workspace WHERE slug = 'race-co'`,
    );
    expect(rows).toHaveLength(1);
    const invites = await superQuery<{ email: string }>(
      `SELECT email::text FROM core.invite WHERE email IN ('a@race.test', 'b@race.test')`,
    );
    expect(invites).toHaveLength(1);
  });
});

describe("workspaces", () => {
  it("pages with an opaque keyset cursor and filters by q, status and plan", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await op(
        `/workspaces?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(res.status).toBe(200);
      const page = (await res.json()) as { items: Detail[]; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((w) => w.slug));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(expect.arrayContaining(["acme", "globex", "held-co", "race-co"]));
    expect(new Set(seen).size).toBe(seen.length);
    const bySearch = (await (await op("/workspaces?q=glob")).json()) as { items: Detail[] };
    expect(bySearch.items.map((w) => w.slug)).toEqual(["globex"]);
    // `_` is not a wildcard.
    expect(
      ((await (await op("/workspaces?q=g_obex")).json()) as { items: Detail[] }).items,
    ).toEqual([]);
    const held = (await (await op("/workspaces?status=pending_review")).json()) as {
      items: Detail[];
    };
    expect(held.items.map((w) => w.slug)).toEqual(["held-co"]);
    const onPlan = (await (await op("/workspaces?plan=starter")).json()) as { items: Detail[] };
    expect(onPlan.items.map((w) => w.slug)).toEqual(expect.arrayContaining(["globex"]));
    expect(onPlan.items.every((w) => w.planId === "starter")).toBe(true);
    const bad = await op("/workspaces?cursor=garbage");
    expect(bad.status).toBe(400);
  });

  it("detail names the owners' addresses and audits that read", async () => {
    const res = await op(`/workspaces/${acmeId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    expect(body.owners).toEqual([{ email: "owner@acme.test" }]);
    const reads = (await chain(PLATFORM_WORKSPACE_ID, "platform.workspace.owners_read")).filter(
      (r) => r.meta["workspaceId"] === acmeId,
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.at(-1)?.actor_user_id).toBe(operatorUserId);
    expect((await op("/workspaces/7e57a11c-0000-4000-8000-00000000f030")).status).toBe(404);
  });

  it("changes plan and cell (both chains); the cell guard follows at once", async () => {
    const res = await op(`/workspaces/${acmeId}`, {
      method: "PATCH",
      body: JSON.stringify({ planId: "pro", cellId: "eu-2" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ planId: "pro", cellId: "eu-2" });
    // Served by another cell now: this process answers 421.
    const moved = await request(`acme.${CANON}`, "/api/v1/modules");
    expect(moved.status).toBe(421);
    expect(moved.headers.get("x-fundroom-cell")).toBe("eu-2");
    const tenant = await chain(acmeId, "workspace.%_change");
    expect(tenant.map((r) => `${r.action} ${r.actor_kind}`)).toEqual([
      "workspace.plan_change host",
      "workspace.cell_change host",
    ]);
    expect(tenant[0]?.meta).toMatchObject({ from: null, to: "pro", operator: true });
    expect(tenant.map((r) => r.actor_user_id)).toEqual([null, null]);
    const platform = (await chain(PLATFORM_WORKSPACE_ID, "workspace.%_change")).filter(
      (r) => r.meta["workspaceId"] === acmeId,
    );
    expect(platform).toHaveLength(2);
    expect(platform.every((r) => r.actor_user_id === operatorUserId)).toBe(true);
    // Back home; an archived plan or a draining cell cannot be assigned.
    expect(
      (
        await op(`/workspaces/${acmeId}`, {
          method: "PATCH",
          body: JSON.stringify({ cellId: "default" }),
        })
      ).status,
    ).toBe(200);
    expect((await request(`acme.${CANON}`, "/api/v1/modules")).status).toBe(200);
    expect(
      (
        await op(`/workspaces/${acmeId}`, {
          method: "PATCH",
          body: JSON.stringify({ planId: "legacy" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await op(`/workspaces/${acmeId}`, {
          method: "PATCH",
          body: JSON.stringify({ cellId: "old-1" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await op(`/workspaces/${acmeId}`, {
          method: "PATCH",
          body: JSON.stringify({ planId: null }),
        })
      ).status,
    ).toBe(200);
  });

  it("corrects the legal name and country (both chains) and queues a re-screen (fix round 2)", async () => {
    const service = running.container.sanctions.service as NonNullable<
      typeof running.container.sanctions.service
    >;
    const calls: string[] = [];
    const original = service.requestRescreen;
    Object.assign(service, {
      requestRescreen: async (input: { workspaceId: string }) => {
        calls.push(input.workspaceId);
        return true;
      },
    });
    try {
      const res = await op(`/workspaces/${acmeId}`, {
        method: "PATCH",
        body: JSON.stringify({ legalName: "Acme Holdings AG", country: "CH" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toMatchObject({
        legalName: "Acme Holdings AG",
        country: "CH",
        owners: [],
      });
      expect(calls).toEqual([acmeId]);
      const tenant = await chain(acmeId, "workspace.legal_change");
      expect(tenant).toEqual([
        expect.objectContaining({
          actor_kind: "host",
          actor_user_id: null,
          meta: expect.objectContaining({ legalName: "Acme Holdings AG", country: "CH" }),
        }),
      ]);
      const platform = (await chain(PLATFORM_WORKSPACE_ID, "workspace.legal_change")).filter(
        (r) => r.meta["workspaceId"] === acmeId,
      );
      expect(platform).toHaveLength(1);
      // The same values again: nothing changes, nothing is re-screened.
      const same = await op(`/workspaces/${acmeId}`, {
        method: "PATCH",
        body: JSON.stringify({ legalName: "Acme Holdings AG" }),
      });
      expect(same.status).toBe(200);
      expect(calls).toHaveLength(1);
      // A malformed country is refused before anything is written.
      expect(
        (
          await op(`/workspaces/${acmeId}`, {
            method: "PATCH",
            body: JSON.stringify({ country: "ch" }),
          })
        ).status,
      ).toBe(400);
      expect(calls).toHaveLength(1);
    } finally {
      Object.assign(service, { requestRescreen: original });
    }
  });

  it("suspends and unsuspends (operator); the tenant sees 423 in between", async () => {
    const acmeCookie = await userSession(acmeOwner.userId);
    const ownersReads = async () =>
      (await chain(PLATFORM_WORKSPACE_ID, "platform.workspace.owners_read")).filter(
        (r) => r.meta["workspaceId"] === acmeId,
      ).length;
    const readsBefore = await ownersReads();
    const res = await op(`/workspaces/${acmeId}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "operator", note: "ticket OPS-1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      status: "suspended",
      suspendedReason: "operator",
      holds: ["operator"],
      // R1-L5: a write's answer is not an owners read.
      owners: [],
    });
    expect(
      (await request(`acme.${CANON}`, "/api/v1/access/people", { cookie: acmeCookie })).status,
    ).toBe(423);
    const lifted = await op(`/workspaces/${acmeId}/unsuspend`, { method: "POST", body: "{}" });
    expect(lifted.status).toBe(200);
    expect(((await lifted.json()) as Detail).status).toBe("active");
    const platform = (await chain(PLATFORM_WORKSPACE_ID, "workspace.%suspend")).filter(
      (r) => r.meta["workspaceId"] === acmeId,
    );
    expect(platform.map((r) => r.action)).toEqual(["workspace.suspend", "workspace.unsuspend"]);
    expect(platform[0]?.meta).toMatchObject({ note: "ticket OPS-1", operator: true });
    expect(platform.map((r) => r.actor_user_id)).toEqual([operatorUserId, operatorUserId]);
    // The note and the operator's identity stay off the tenant's chain.
    const tenant = await chain(acmeId, "workspace.suspend");
    expect(tenant[0]?.meta["note"]).toBeUndefined();
    expect(tenant[0]?.actor_user_id).toBeNull();
    expect(tenant[0]?.meta).toMatchObject({ operator: true, hold: "operator", on: true });
    // Neither write recorded an owners read (only the detail GET does).
    expect(await ownersReads()).toBe(readsBefore);
  });

  it("an operator's suspend + unsuspend over a sanctions hold keeps the hold (R3-M1)", async () => {
    const [held] = await superQuery<{ id: string }>(
      `SELECT id::text FROM core.workspace WHERE slug = 'held-co'`,
    );
    const heldId = (held as { id: string }).id;
    const suspended = await op(`/workspaces/${heldId}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "operator", note: "ticket OPS-2" }),
    });
    expect((await suspended.json()) as unknown).toMatchObject({
      status: "suspended",
      suspendedReason: "operator",
      holds: ["operator", "sanctions_review"],
    });
    const lifted = await op(`/workspaces/${heldId}/unsuspend`, { method: "POST", body: "{}" });
    expect(lifted.status).toBe(200);
    // Still held for its sanctions review: the operator's unsuspend lifted only its own flag.
    expect((await lifted.json()) as unknown).toMatchObject({
      status: "pending_review",
      suspendedReason: null,
      holds: ["sanctions_review"],
    });
  });

  it("a sanctions suspension or hold lifts only with a cleared screening (409 sanctions_unresolved)", async () => {
    const [held] = await superQuery<{ id: string }>(
      `SELECT id::text FROM core.workspace WHERE slug = 'held-co'`,
    );
    const heldId = (held as { id: string }).id;
    const release = JSON.stringify({ hold: "sanctions_review" });
    // With a screening driver configured, a review hold with no screening at all stays.
    const platformDeps = running.container.controlPlane.operators.platform;
    Object.assign(platformDeps, { sanctionsScreening: true });
    try {
      const refused = await op(`/workspaces/${heldId}/unsuspend`, {
        method: "POST",
        body: release,
      });
      expect(refused.status).toBe(409);
      expect(await errorCode(refused)).toBe("sanctions_unresolved");
    } finally {
      Object.assign(platformDeps, { sanctionsScreening: false });
    }
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
         VALUES ($1, 'held-co Holdings Ltd', 'ofac', 'ofac:test:jw1', 'potential_match')`,
      [heldId],
    );
    // An open screening is never released, driver or not.
    expect(
      (await op(`/workspaces/${heldId}/unsuspend`, { method: "POST", body: release })).status,
    ).toBe(409);
    await superQuery(
      `UPDATE core.sanctions_screening SET decision = 'cleared', decided_by = $2, decided_at = now(),
              decision_note = 'false positive' WHERE workspace_id = $1`,
      [heldId, operatorUserId],
    );
    const released = await op(`/workspaces/${heldId}/unsuspend`, { method: "POST", body: release });
    expect(released.status).toBe(200);
    expect((await released.json()) as unknown).toMatchObject({
      status: "active",
      holds: [],
      sanctions: { outcome: "potential_match", decision: "cleared" },
    });

    // A sanctions suspension of acme with a confirmed match stays.
    await running.container.db.withHost((tx) =>
      setWorkspaceHold(
        tx,
        {
          workspaceId: acmeId,
          hold: "sanctions",
          on: true,
          actor: { kind: "system", source: "sanctions" },
        },
        { audit: running.container.audit, invalidate: () => {} },
      ),
    );
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome,
              decision, decided_by, decided_at, decision_note)
         VALUES ($1, 'Acme', 'ofac', 'ofac:test:jw1', 'potential_match', 'confirmed', $2, now(), 'match')`,
      // Confirmed by ANOTHER operator: this one may lift it later (four eyes).
      [acmeId, acmeOwner.userId],
    );
    const liftSanctions = JSON.stringify({ hold: "sanctions" });
    const stays = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: liftSanctions,
    });
    expect(stays.status).toBe(409);
    // An operator suspension cannot downgrade it either.
    const suspend = await op(`/workspaces/${acmeId}/suspend`, {
      method: "POST",
      body: JSON.stringify({ reason: "operator", note: "n" }),
    });
    expect(((await suspend.json()) as Detail).suspendedReason).toBe("sanctions");
    // Lifting the operator's own flag leaves the sanctions suspension.
    const own = await op(`/workspaces/${acmeId}/unsuspend`, { method: "POST", body: "{}" });
    expect((await own.json()) as unknown).toMatchObject({
      status: "suspended",
      suspendedReason: "sanctions",
      holds: ["sanctions"],
    });
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
         VALUES ($1, 'Acme', 'ofac', 'ofac:test2:jw1', 'clear')`,
      [acmeId],
    );
    const lifted = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: liftSanctions,
    });
    expect(lifted.status).toBe(200);
    expect((await lifted.json()) as unknown).toMatchObject({ status: "active", holds: [] });
  });

  it("an error screening never lifts a confirmed match, cleared or not (fix round 3)", async () => {
    await running.container.db.withHost((tx) =>
      setWorkspaceHold(
        tx,
        {
          workspaceId: acmeId,
          hold: "sanctions",
          on: true,
          actor: { kind: "system", source: "sanctions" },
        },
        { audit: running.container.audit, invalidate: () => {} },
      ),
    );
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome,
              decision, decided_by, decided_at, decision_note)
         VALUES ($1, 'Acme', 'ofac', 'ofac:e0:jw1', 'potential_match', 'confirmed', $2, now(), 'match')`,
      [acmeId, acmeOwner.userId],
    );
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome,
              decision, decided_by, decided_at, decision_note)
         VALUES ($1, 'Acme', 'ofac', 'ofac:unavailable', 'error', 'cleared', $2, now(), 'outage')`,
      [acmeId, acmeOwner.userId],
    );
    const res = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: JSON.stringify({ hold: "sanctions" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { reason?: string } }).error.reason).toBe("not_cleared");
    // A real clean screen afterwards does.
    await superQuery(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
         VALUES ($1, 'Acme', 'ofac', 'ofac:e1:jw1', 'clear')`,
      [acmeId],
    );
    const lifted = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: JSON.stringify({ hold: "sanctions" }),
    });
    expect((await lifted.json()) as unknown).toMatchObject({ status: "active", holds: [] });
  });

  it("with no sanctions driver, a review hold with no screening at all is released (noScreening)", async () => {
    hookMode.hold = true;
    let id: string;
    try {
      const res = await create(newWorkspace("noscreen-co", { planId: null }));
      id = ((await res.json()) as Detail).id;
    } finally {
      hookMode.hold = false;
    }
    const released = await op(`/workspaces/${id}/unsuspend`, {
      method: "POST",
      body: JSON.stringify({ hold: "sanctions_review", note: "no driver on this install" }),
    });
    expect(released.status).toBe(200);
    expect((await released.json()) as unknown).toMatchObject({ status: "active", holds: [] });
    const platform = (await chain(PLATFORM_WORKSPACE_ID, "workspace.release")).filter(
      (r) => r.meta["workspaceId"] === id,
    );
    expect(platform.at(-1)?.meta).toMatchObject({ noScreening: true, hold: "sanctions_review" });
  });

  it("clearing a later screening never lifts a confirmed sanctions suspension (R3-M2)", async () => {
    const { rows } = await pg.pool.query<{ id: string }>(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
         VALUES ($1, 'Acme', 'ofac', 'ofac:s1:jw1', 'potential_match') RETURNING id::text`,
      [acmeId],
    );
    const s1 = rows[0]?.id as string;
    const decide = (id: string, decision: "cleared" | "confirmed") =>
      op(`/sanctions/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, note: `${decision} by test` }),
      });
    expect((await decide(s1, "confirmed")).status).toBe(200);
    expect(((await (await op(`/workspaces/${acmeId}`)).json()) as Detail).suspendedReason).toBe(
      "sanctions",
    );
    // A later re-screen hits again (a different entry, say) and is cleared as a false positive.
    const s2 = (
      await pg.pool.query<{ id: string }>(
        `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
           VALUES ($1, 'Acme', 'ofac', 'ofac:s2:jw1', 'potential_match') RETURNING id::text`,
        [acmeId],
      )
    ).rows[0]?.id as string;
    expect((await decide(s2, "cleared")).status).toBe(200);
    // Four eyes: the operator who confirmed S1 cannot lift it.
    const own = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: JSON.stringify({ hold: "sanctions", note: "self" }),
    });
    expect(own.status).toBe(409);
    expect(((await own.json()) as { error: { reason?: string } }).error).toMatchObject({
      code: "sanctions_unresolved",
      reason: "four_eyes",
    });
    // (Another operator confirmed it, for the rest of this test.)
    await superQuery(`UPDATE core.sanctions_screening SET decided_by = $2 WHERE id = $1`, [
      s1,
      acmeOwner.userId,
    ]);
    // Still suspended for sanctions: S2's clearance says nothing about S1's confirmed match.
    expect((await (await op(`/workspaces/${acmeId}`)).json()) as unknown).toMatchObject({
      status: "suspended",
      suspendedReason: "sanctions",
      holds: ["sanctions"],
    });
    // Only an operator's explicit lift does, now that the latest screening is cleared.
    const lifted = await op(`/workspaces/${acmeId}/unsuspend`, {
      method: "POST",
      body: JSON.stringify({ hold: "sanctions", note: "S1 overturned after review" }),
    });
    expect((await lifted.json()) as unknown).toMatchObject({ status: "active", holds: [] });
  });
});

describe("cells, operators, the platform chain, health", () => {
  it("lists cells with counts; the CLI adds and drains (audited)", async () => {
    const added = await cli(
      ["add", "ap-1", "--region", "eu", "--origin", "https://ap-1.example.test/"],
      cellsCommand as never,
    );
    expect(added.code).toBe(0);
    expect(
      (
        await cli(
          ["add", "ap-1", "--region", "eu", "--origin", "https://x.test"],
          cellsCommand as never,
        )
      ).code,
    ).toBe(1);
    expect(
      (
        await cli(
          ["add", "Bad Id", "--region", "eu", "--origin", "https://x.test"],
          cellsCommand as never,
        )
      ).code,
    ).toBe(2);
    // R1-L5: a cell origin is https (or '' = this install); plain http is refused, CLI and DB.
    expect(
      (
        await cli(
          ["add", "ap-2", "--region", "eu", "--origin", "http://ap-2.example.test"],
          cellsCommand as never,
        )
      ).code,
    ).toBe(2);
    await expect(
      superQuery(
        "INSERT INTO core.cell (id, region, public_origin) VALUES ('ap-3', 'eu', 'http://ap-3.test')",
      ),
    ).rejects.toThrow(/cell_public_origin_shape/u);
    expect((await cli(["drain", "ap-1"], cellsCommand as never)).code).toBe(0);
    expect((await cli(["drain", "nope"], cellsCommand as never)).code).toBe(1);
    const cells = (await (await op("/cells")).json()) as {
      cells: { id: string; status: string; workspaces: number; publicOrigin: string }[];
    };
    expect(cells.cells.find((c) => c.id === "default")?.workspaces).toBeGreaterThan(3);
    expect(cells.cells.find((c) => c.id === "ap-1")).toMatchObject({
      status: "draining",
      publicOrigin: "https://ap-1.example.test",
      workspaces: 0,
    });
    const audits = await chain(PLATFORM_WORKSPACE_ID, "cell.%");
    expect(audits.map((a) => a.action)).toEqual(["cell.add", "cell.update"]);
  });

  it("lists operators (read-only), pages the platform chain, reports health", async () => {
    const ops = (await (await op("/operators")).json()) as { operators: { email: string }[] };
    expect(ops.operators.map((o) => o.email)).toEqual([
      "ops@platform.test",
      "second@platform.test",
    ]);
    const first = (await (await op("/audit?limit=3")).json()) as {
      items: { seq: number; action: string }[];
      nextCursor: string;
    };
    expect(first.items).toHaveLength(3);
    const second = (await (await op(`/audit?limit=3&cursor=${first.nextCursor}`)).json()) as {
      items: { seq: number }[];
    };
    expect(Math.max(...second.items.map((i) => i.seq))).toBeLessThan(
      Math.min(...first.items.map((i) => i.seq)),
    );
    expect((await op("/audit?cursor=nope")).status).toBe(400);
    const health = (await (await op("/health")).json()) as {
      deadLetters: number;
      adapters: { name: string }[];
    };
    expect(health.deadLetters).toBeGreaterThanOrEqual(0);
    expect(health.adapters.map((a) => a.name)).toContain("database");
  });
});

describe("onboarding a new operator (enrol-link, fix round 2)", () => {
  const EMAIL = "newop@platform.test";
  const enrolPost = (path: string, body: unknown, init: Parameters<typeof request>[2] = {}) =>
    request(CANON, `/api/v1/platform/enrol${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      ...init,
    });
  const mailsTo = (email: string, since: number) =>
    mailer.sent.slice(since).filter((m) => m.to === email).length;
  const enrolCookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-op_enrol="))
      ?.split(";")[0];

  async function link(email: string): Promise<string> {
    const r = await cli(["enrol-link", email]);
    expect(r.code).toBe(0);
    const url = new URL(r.out.split("\n").find((l) => l.startsWith("https://")) as string);
    expect(url.pathname).toBe("/platform/enrol");
    return url.searchParams.get("token") as string;
  }

  it("needs the token AND the mailbox; ends in an enrolment-only session that adds one factor", async () => {
    const token = await link(EMAIL);
    const [row] = await superQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.auth_challenge WHERE kind = 'operator_enrol' AND email = $1`,
      [EMAIL],
    );
    expect(row?.n).toBe(1);
    // The token is stored as a hash only.
    expect(
      await superQuery(
        `SELECT 1 FROM core.auth_challenge WHERE secret_hash = convert_to($1, 'UTF8')`,
        [token],
      ),
    ).toEqual([]);
    expect((await chain(PLATFORM_WORKSPACE_ID, "operator.enrol_link")).at(-1)?.meta).toMatchObject({
      email: EMAIL,
      createdBy: "cli:tester",
    });

    // Mailbox-only attacker: no token → the same { ok: true }, but no code is ever sent.
    let since = mailer.sent.length;
    const fake = "A".repeat(43);
    const noToken = await enrolPost("/start", { token: fake, email: EMAIL });
    expect(noToken.status).toBe(200);
    expect(await noToken.json()).toEqual({ ok: true });
    expect(mailsTo(EMAIL, since)).toBe(0);
    expect((await enrolPost("/verify", { token: fake, email: EMAIL, code: "123456" })).status).toBe(
      400,
    );

    // Token-only attacker: the token with their own address → same answer, nothing sent anywhere.
    since = mailer.sent.length;
    const wrongMail = await enrolPost("/start", { token, email: "attacker@evil.test" });
    expect(wrongMail.status).toBe(200);
    expect(await wrongMail.json()).toEqual({ ok: true });
    expect(mailer.sent.length).toBe(since);
    // … and without the mailbox cannot produce the code.
    await enrolPost("/start", { token, email: EMAIL });
    const code = await awaitSignInCode(mailer, EMAIL, since);
    const guess = code === "000000" ? "111111" : "000000";
    const wrong = await enrolPost("/verify", { token, email: EMAIL, code: guess });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("invalid_code");
    // The right code for the wrong address (the attacker's) is no better.
    expect((await enrolPost("/verify", { token, email: "attacker@evil.test", code })).status).toBe(
      400,
    );

    // Token + mailbox: an enrolment-only session, the account created.
    const ok = await enrolPost("/verify", { token, email: EMAIL, code });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ email: EMAIL });
    const enrol = enrolCookieOf(ok) as string;
    expect(enrol).toBeDefined();
    expect(ok.headers.getSetCookie().join(";")).toMatch(/SameSite=Strict/u);
    // Single use.
    expect((await enrolPost("/verify", { token, email: EMAIL, code })).status).toBe(400);
    const [user] = await superQuery<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM core.user_identity WHERE identifier = $1`,
      [EMAIL],
    );
    const userId = (user as { user_id: string }).user_id;

    // It is nobody anywhere else: not a user session, not an operator session, no grant.
    const value = enrol.split("=")[1] as string;
    expect((await request(CANON, "/api/v1/me", { cookie: `__Host-sid=${value}` })).status).toBe(
      401,
    );
    expect(
      (await request(CANON, "/api/v1/auth/totp/enrol", { method: "POST", cookie: enrol })).status,
    ).toBe(401);
    expect((await mint(`__Host-sid=${value}`)).status).toBe(401);
    expect((await op("/me", { cookie: `__Host-op_sid=${value}` })).status).toBe(404);
    // Granting before a factor exists is still refused.
    expect((await cli(["grant", EMAIL])).code).toBe(1);

    // The one thing it may do: add a first factor, which ends it.
    const begin = await request(CANON, "/api/v1/platform/enrol/totp", {
      method: "POST",
      cookie: enrol,
    });
    expect(begin.status).toBe(200);
    const { secretBase32 } = (await begin.json()) as { secretBase32: string };
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await enrolPost("/totp/confirm", { code: totp.generate() }, { cookie: enrol });
    expect(confirm.status).toBe(200);
    expect(
      ((await confirm.json()) as { recoveryCodes: string[] }).recoveryCodes.length,
    ).toBeGreaterThan(0);
    expect((await request(CANON, "/api/v1/platform/enrol/session", { cookie: enrol })).status).toBe(
      404,
    );
    expect(
      (await request(CANON, "/api/v1/platform/enrol/totp", { method: "POST", cookie: enrol }))
        .status,
    ).toBe(404);
    const audits = (await chain(PLATFORM_WORKSPACE_ID, "operator.enrol")).filter(
      (r) => r.meta["userId"] === userId,
    );
    expect(audits.map((r) => r.meta["phase"])).toEqual(["session_started", "factor_added"]);

    // Then the CLI grant, and the factor (older than the grant) mints an operator session.
    await superQuery(
      `UPDATE core.credential SET created_at = now() - interval '1 minute',
              confirmed_at = now() - interval '1 minute' WHERE user_id = $1`,
      [userId],
    );
    expect((await cli(["grant", EMAIL])).code).toBe(0);
    expect((await mint(await userSession(userId))).status).toBe(200);
  });

  it("does not add a factor to an account that already has one (409 already_enrolled)", async () => {
    const token = await link("ops@platform.test");
    const since = mailer.sent.length;
    await enrolPost("/start", { token, email: "ops@platform.test" });
    const code = await awaitSignInCode(mailer, "ops@platform.test", since);
    const res = await enrolPost("/verify", { token, email: "ops@platform.test", code });
    expect(res.status).toBe(409);
    expect(enrolCookieOf(res)).toBeUndefined();
  });

  it("five wrong codes kill the link; start is budgeted per client address", async () => {
    const token = await link("burn@platform.test");
    const since = mailer.sent.length;
    await enrolPost("/start", { token, email: "burn@platform.test" }, { ip: "10.77.0.2" });
    const code = await awaitSignInCode(mailer, "burn@platform.test", since);
    const guess = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await enrolPost(
        "/verify",
        { token, email: "burn@platform.test", code: guess },
        { ip: "10.77.0.2" },
      );
    }
    expect(
      (
        await enrolPost(
          "/verify",
          { token, email: "burn@platform.test", code },
          { ip: "10.77.0.2" },
        )
      ).status,
    ).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await enrolPost("/start", { token, email: "x@platform.test" }, { ip: "10.77.0.1" }))
          .status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Off the canonical host it does not exist.
    expect(
      (
        await request(`acme.${CANON}`, "/api/v1/platform/enrol/start", {
          method: "POST",
          body: JSON.stringify({ token, email: "x@platform.test" }),
        })
      ).status,
    ).toBe(404);
  });
});
