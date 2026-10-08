import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyRepo, apiKeyTokenHash, displayPrefix, mintApiKeyToken } from "@fundroom/api-keys";
import { loadAuthzMatrix } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The key-callable routes (E3.4 §C, ADR-0052), proved one by one with a real `frk_` key:
 *
 *  - every `apiKey: true` matrix row answers a key that holds exactly its permission, with the
 *    same body shape a session gets from the same route;
 *  - the same route answers a key without that scope 403 `scope_missing`;
 *  - a key acts as its creator's CURRENT role: demote the creator and the permission is gone
 *    (403 `scope_missing`), revoke the creator and the key stops working (401);
 *  - every write a key makes is audited to the creator with `meta.apiKeyId` and no session;
 *  - a sample of unmarked rows (session, member, stepUp, other permissions) answers 401
 *    `api_key_not_allowed` — never 403/404, so a key learns nothing about routes it cannot call.
 *
 * Keys are inserted through `ApiKeyRepo` rather than minted through `POST /api-keys`: that route
 * wants a step-up ceremony and has its own suite; what is under test here is what a key may call.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const SLUG = "acme";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;

interface Actor {
  cookie: string;
  membershipId: string;
}

let owner: Actor;
let adminId: string; // the creator who is demoted, then revoked
let leaverId: string;

type Auth = { cookie?: string; key?: string };

async function request(path: string, init: RequestInit & Auth = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `${SLUG}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) {
    headers.set("cookie", init.cookie);
    if (init.method && init.method !== "GET") headers.set("origin", `http://${SLUG}.${CANON}`);
  }
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  return running.app.request(`http://${SLUG}.${CANON}${path}`, { ...init, headers });
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

async function signIn(email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function enrolMfa(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

/** A staff membership that never signs in: a key's creator only has to be a live member. */
async function staff(name: string, role: "owner" | "admin"): Promise<string> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email: `${name}@acme.test`, displayName: name });
  const m = await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: "staff",
    role,
    source: "test",
  });
  return m.id;
}

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const ctx = systemContext(acmeId);
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

/** Inserts a live key for `creator` holding `scopes`; returns the plaintext token and its id. */
async function mintKey(
  creator: string,
  scopes: readonly string[],
): Promise<{ id: string; token: string }> {
  const token = mintApiKeyToken();
  const ctx = systemContext(acmeId);
  const row = await running.container.db.withTenant(ctx, (tx) =>
    new ApiKeyRepo(ctx, tx).insert({
      name: `test ${scopes.join(",")}`.slice(0, 80),
      tokenHash: apiKeyTokenHash(token),
      prefix: displayPrefix(token),
      scopes,
      createdByMembershipId: creator,
      expiresAt: null,
      note: null,
    }),
  );
  return { id: row.id, token };
}

async function expectError(res: Response, status: number, code: string, reason?: string) {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const body = JSON.parse(text) as { error: { code: string; reason?: string } };
  expect(body.error.code, text).toBe(code);
  if (reason !== undefined) expect(body.error.reason, text).toBe(reason);
}

/**
 * A JSON value reduced to its structure: object keys (sorted) with the shape of each value,
 * arrays by the shape of their first element. Two answers with the same shape are the same
 * contract even when a value (a timestamp, a count) moved between the calls.
 */
function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])];
  if (typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]),
    );
  return typeof v;
}

// --- fixtures ------------------------------------------------------------------------------------
const ROOT = randomUUID();
const FOLDER = { id: randomUUID(), path: "root.keys" };
const DOC = randomUUID();
let groupId: string;
let metricId: string;
let roundId: string;
let postId: string;
let contactId: string;
let questionId: string;
let importId: string;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
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
      SPREADSHEET_DRIVER: "noop",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: SLUG, name: "Acme" })).id;
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, async (tx) => {
    const repo = new ModuleEnablementRepo(ctx, tx);
    for (const id of ["crm", "metrics", "round", "updates", "data-room"]) await repo.set(id, true);
  });
  running.container.enablement.invalidate(acmeId);
  // Round routes 404 while the workspace offers nothing.
  await running.container.db.withTenant(ctx, (tx) => updateOfferingStatus(tx, acmeId, "506b"));
  running.container.resolver.invalidate();

  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email: "owner@acme.test", displayName: "Owner" });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  owner = await signIn("owner@acme.test");
  owner.cookie = await enrolMfa(owner.cookie);
  adminId = await staff("ada", "admin");
  leaverId = await staff("lee", "admin");

  // Data the reads can find, made through the session API (or SQL where no route makes it).
  await sql(`INSERT INTO dataroom.folder (id, workspace_id, name, path)
             VALUES ('${ROOT}', '${acmeId}', 'Root', 'root')`);
  await sql(`INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
             VALUES ('${FOLDER.id}', '${acmeId}', '${ROOT}', 'Keys', '${FOLDER.path}')`);
  await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
             VALUES ('${DOC}', '${acmeId}', '${FOLDER.id}', '${FOLDER.path}', 'Deck')`);

  const ok = async (res: Response, status = 200) => {
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const post = (path: string, body: unknown, method = "POST") =>
    request(path, { method, cookie: owner.cookie, body: JSON.stringify(body) });
  groupId = (await ok(await post("/api/v1/access/groups", { name: "Board" })))["id"] as string;
  metricId = (
    await ok(
      await post("/api/v1/metrics/definitions", {
        key: "arr",
        name: "ARR",
        unit: "count",
        audience: { kind: "all" },
      }),
      201,
    )
  )["id"] as string;
  roundId = (
    await ok(
      await post("/api/v1/round/rounds", {
        name: "Seed 2026",
        stage: "seed",
        instrumentKind: "safe",
        targetAmount: "2000000",
        currency: "USD",
      }),
      201,
    )
  )["id"] as string;
  const created = await ok(
    await post("/api/v1/updates/posts", { title: "September", template: "yc" }),
    201,
  );
  postId = (created["post"] as { id: string }).id;
  expect(postId).toBeTruthy();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

// --- the route table -----------------------------------------------------------------------------

interface KeyRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  /** The matrix path (`{id}` placeholders). */
  readonly path: string;
  readonly perm: string;
  /** The concrete URL, resolved after the fixtures exist. */
  readonly url: () => string;
  readonly body?: () => unknown;
  readonly status?: number;
}

const periodKey = (i: number) => `2026-${String(i).padStart(2, "0")}`;
let writeCounter = 0;
const csvImport = () => ({
  csv: ["period,arr", `${periodKey(7)},700`, `${periodKey(8)},800`].join("\n"),
  mapping: {
    periodColumn: "period",
    periodKind: "month",
    columns: [{ column: "arr", key: "arr" }],
  },
});

const ROUTES: readonly KeyRoute[] = [
  { method: "GET", path: "/access/people", perm: "access.read", url: () => "/access/people" },
  {
    method: "GET",
    path: "/access/people/{id}",
    perm: "access.read",
    url: () => `/access/people/${owner.membershipId}`,
  },
  { method: "GET", path: "/access/groups", perm: "access.read", url: () => "/access/groups" },
  { method: "GET", path: "/audit/events", perm: "audit.read", url: () => "/audit/events?limit=5" },
  {
    method: "GET",
    path: "/data-room/documents/{id}/versions",
    perm: "data-room.read",
    url: () => `/data-room/documents/${DOC}/versions`,
  },
  {
    method: "POST",
    path: "/data-room/qa/inbox",
    perm: "data-room.qa_manage",
    url: () => "/data-room/qa/inbox",
    body: () => ({
      targetKind: "document",
      targetId: DOC,
      subject: `Churn? ${++writeCounter}`,
      body: "What is monthly churn?",
      answer: "Under 2%.",
    }),
    status: 201,
  },
  {
    method: "GET",
    path: "/data-room/qa/inbox",
    perm: "data-room.read",
    url: () => "/data-room/qa/inbox",
  },
  {
    method: "GET",
    path: "/data-room/qa/inbox/{id}",
    perm: "data-room.read",
    url: () => `/data-room/qa/inbox/${questionId}`,
  },
  { method: "GET", path: "/updates/posts", perm: "updates.read", url: () => "/updates/posts" },
  {
    method: "GET",
    path: "/updates/posts/{id}",
    perm: "updates.read",
    url: () => `/updates/posts/${postId}`,
  },
  {
    method: "GET",
    path: "/metrics/definitions",
    perm: "metrics.read",
    url: () => "/metrics/definitions",
  },
  {
    method: "PUT",
    path: "/metrics/definitions/{id}/points",
    perm: "metrics.manage",
    url: () => `/metrics/definitions/${metricId}/points`,
    body: () => ({ points: [{ periodKey: periodKey(1), value: String(100 + ++writeCounter) }] }),
  },
  {
    method: "GET",
    path: "/metrics/definitions/{id}/points",
    perm: "metrics.read",
    url: () => `/metrics/definitions/${metricId}/points`,
  },
  {
    method: "PUT",
    path: "/metrics/grid",
    perm: "metrics.manage",
    url: () => "/metrics/grid",
    body: () => ({
      periodKind: "month",
      cells: [
        { definitionId: metricId, periodKey: periodKey(2), value: String(200 + ++writeCounter) },
      ],
    }),
  },
  {
    method: "GET",
    path: "/metrics/grid",
    perm: "metrics.read",
    url: () => "/metrics/grid?periodKind=month&periods=6&end=2026-06-30T00:00:00.000Z",
  },
  {
    method: "POST",
    path: "/metrics/import/dry-run",
    perm: "metrics.manage",
    url: () => "/metrics/import/dry-run",
    body: csvImport,
  },
  {
    method: "POST",
    path: "/metrics/import",
    perm: "metrics.manage",
    url: () => "/metrics/import",
    body: csvImport,
  },
  {
    method: "GET",
    path: "/metrics/import/{id}",
    perm: "metrics.read",
    url: () => `/metrics/import/${importId}`,
  },
  { method: "GET", path: "/round/rounds", perm: "round.read", url: () => "/round/rounds" },
  {
    method: "GET",
    path: "/round/rounds/{id}/commitments",
    perm: "round.read",
    url: () => `/round/rounds/${roundId}/commitments`,
  },
  {
    method: "GET",
    path: "/round/rounds/{id}/interest",
    perm: "round.read",
    url: () => `/round/rounds/${roundId}/interest`,
  },
  {
    method: "GET",
    path: "/round/rounds/{id}/closing",
    perm: "round.read",
    url: () => `/round/rounds/${roundId}/closing`,
  },
  {
    method: "POST",
    path: "/crm/contacts",
    perm: "crm.manage",
    url: () => "/crm/contacts",
    body: () => ({ displayName: `Pat ${++writeCounter}`, email: `pat${writeCounter}@lp.test` }),
    status: 201,
  },
  { method: "GET", path: "/crm/contacts", perm: "crm.read", url: () => "/crm/contacts" },
  // E3.6: the recorded-bookings register (empty here; its rows are proved in integrations*.test).
  {
    method: "GET",
    path: "/integrations/bookings",
    perm: "integrations.read",
    url: () => "/integrations/bookings",
  },
  {
    method: "GET",
    path: "/crm/contacts/{id}",
    perm: "crm.read",
    url: () => `/crm/contacts/${contactId}`,
  },
  {
    method: "PATCH",
    path: "/crm/contacts/{id}",
    perm: "crm.manage",
    url: () => `/crm/contacts/${contactId}`,
    body: () => ({ displayName: `Pat renamed ${++writeCounter}` }),
  },
];

/** Remembers the ids a write made, so the reads after it (table order) have something to find. */
function remember(route: KeyRoute, body: Record<string, unknown>): void {
  if (route.path === "/data-room/qa/inbox" && route.method === "POST")
    questionId ??= body["id"] as string;
  if (route.path === "/crm/contacts" && route.method === "POST") contactId ??= body["id"] as string;
  if (route.path === "/metrics/import" && route.method === "POST")
    importId ??= body["id"] as string;
}

async function call(route: KeyRoute, auth: Auth): Promise<Response> {
  const body = route.body?.();
  return request(`/api/v1${route.url()}`, {
    method: route.method,
    ...auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("the route table is the matrix", () => {
  it("covers every C-owned `apiKey: true` row and nothing else", () => {
    const marked = loadAuthzMatrix()
      .routes.filter((r) => r.apiKey)
      .map((r) => `${r.method} ${r.path}`)
      // B's webhook delivery rows are proved in the webhooks suite.
      .filter((r) => !r.includes(" /webhooks/"))
      // E3.5's envelope rows need a vendor envelope; they are proved in esign.integration.test.ts.
      .filter((r) => !r.includes(" /esign/"))
      .sort();
    expect(ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(marked);
  });
});

describe("a key holding exactly the route's permission", () => {
  const keys = new Map<string, { id: string; token: string }>();
  const keyFor = async (perm: string) => {
    let k = keys.get(perm);
    if (k === undefined) {
      k = await mintKey(owner.membershipId, [perm]);
      keys.set(perm, k);
    }
    return k;
  };

  for (const route of ROUTES) {
    it(`${route.method} ${route.path} (${route.perm}) answers like a session does`, async () => {
      const key = await keyFor(route.perm);
      const viaKey = await call(route, { key: key.token });
      const keyText = await viaKey.text();
      expect(viaKey.status, keyText).toBe(route.status ?? 200);
      const keyBody = JSON.parse(keyText) as Record<string, unknown>;
      remember(route, keyBody);

      const viaSession = await call(route, { cookie: owner.cookie });
      const sessionText = await viaSession.text();
      expect(viaSession.status, sessionText).toBe(route.status ?? 200);
      expect(shapeOf(keyBody)).toEqual(shapeOf(JSON.parse(sessionText)));
    });
  }

  it("the reads see the same rows a session sees", async () => {
    for (const route of ROUTES.filter((r) => r.method === "GET" && r.path !== "/audit/events")) {
      const key = await keyFor(route.perm);
      const a = await json(await call(route, { key: key.token }));
      const b = await json(await call(route, { cookie: owner.cookie }));
      // An import's progress moves with the worker between the two calls, and a person's
      // last-seen stamp moves with the owner's own session.
      if (route.path === "/metrics/import/{id}" || route.path.startsWith("/access/people"))
        expect(shapeOf(a)).toEqual(shapeOf(b));
      else expect(a, route.path).toEqual(b);
    }
  });
});

describe("a key without the route's permission", () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.path} answers 403 scope_missing`, async () => {
      // A key-callable scope that is not this one: the refusal is about the scope, not the route.
      const other = route.perm === "audit.read" ? "crm.read" : "audit.read";
      const key = await mintKey(owner.membershipId, [other]);
      await expectError(await call(route, { key: key.token }), 403, "forbidden", "scope_missing");
    });
  }
});

describe("the key acts as its creator's current role", () => {
  it("a demoted creator's key loses the permissions the new role lacks", async () => {
    const key = await mintKey(adminId, ["access.read", "crm.read", "crm.manage"]);
    expect((await request("/api/v1/access/people", { key: key.token })).status).toBe(200);
    const made = await request("/api/v1/crm/contacts", {
      method: "POST",
      key: key.token,
      body: JSON.stringify({ displayName: "Before demotion" }),
    });
    expect(made.status, await made.clone().text()).toBe(201);

    await sql(`UPDATE core.membership SET role = 'viewer' WHERE id = '${adminId}'`);

    await expectError(
      await request("/api/v1/access/people", { key: key.token }),
      403,
      "forbidden",
      "scope_missing",
    );
    await expectError(
      await request("/api/v1/crm/contacts", {
        method: "POST",
        key: key.token,
        body: JSON.stringify({ displayName: "After demotion" }),
      }),
      403,
      "forbidden",
      "scope_missing",
    );
    // A viewer still holds `crm.read`, and the key still carries it.
    expect((await request("/api/v1/crm/contacts", { key: key.token })).status).toBe(200);
  });

  it("a creator who is no longer a live member leaves a key that authenticates nothing", async () => {
    const key = await mintKey(leaverId, ["access.read"]);
    expect((await request("/api/v1/access/people", { key: key.token })).status).toBe(200);
    await sql(`UPDATE core.membership SET status = 'revoked' WHERE id = '${leaverId}'`);
    const res = await request("/api/v1/access/people", { key: key.token });
    expect(res.status, await res.clone().text()).toBe(401);
  });
});

describe("writes made with a key are audited to the creator with meta.apiKeyId", () => {
  const audited = (action: string, resourceId?: string) =>
    sql<{
      actor: string | null;
      session: string | null;
      apiKeyId: string | null;
    }>(
      `SELECT actor_membership_id::text AS actor, session_id::text AS session,
              meta->>'apiKeyId' AS "apiKeyId"
         FROM audit.event
        WHERE action = '${action}'
          ${resourceId === undefined ? "" : `AND resource_id = '${resourceId}'`}
        ORDER BY seq DESC LIMIT 1`,
    );

  it("crm contact create and update", async () => {
    const key = await mintKey(owner.membershipId, ["crm.manage"]);
    const res = await request("/api/v1/crm/contacts", {
      method: "POST",
      key: key.token,
      body: JSON.stringify({ displayName: "Audited" }),
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const patched = await request(`/api/v1/crm/contacts/${id}`, {
      method: "PATCH",
      key: key.token,
      body: JSON.stringify({ displayName: "Audited again" }),
    });
    expect(patched.status).toBe(200);
    for (const action of ["crm.contact_created", "crm.contact_updated"]) {
      expect(await audited(action, id), action).toEqual([
        { actor: owner.membershipId, session: null, apiKeyId: key.id },
      ]);
    }
  });

  it("metrics point writes, restatements and the import", async () => {
    const key = await mintKey(owner.membershipId, ["metrics.manage"]);
    const put = (value: string) =>
      request(`/api/v1/metrics/definitions/${metricId}/points`, {
        method: "PUT",
        key: key.token,
        body: JSON.stringify({ points: [{ periodKey: periodKey(5), value }] }),
      });
    expect((await put("1")).status).toBe(200);
    expect((await put("2")).status).toBe(200); // a restatement
    const expected = [{ actor: owner.membershipId, session: null, apiKeyId: key.id }];
    expect(await audited("metrics.points_saved")).toEqual(expected);
    expect(await audited("metrics.point_restated", metricId)).toEqual(expected);

    const started = await request("/api/v1/metrics/import", {
      method: "POST",
      key: key.token,
      body: JSON.stringify(csvImport()),
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const { id } = await json<{ id: string }>(started);
    expect(await audited("metrics.import_started", id)).toEqual(expected);
  });

  it("a staff Q&A entry", async () => {
    const key = await mintKey(owner.membershipId, ["data-room.qa_manage"]);
    const res = await request("/api/v1/data-room/qa/inbox", {
      method: "POST",
      key: key.token,
      body: JSON.stringify({
        targetKind: "document",
        targetId: DOC,
        subject: "Audited question",
        body: "Who audits the auditors?",
        answer: "The chain.",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const expected = [{ actor: owner.membershipId, session: null, apiKeyId: key.id }];
    expect(await audited("qa.question_asked", id)).toEqual(expected);
    expect(await audited("qa.answer_saved", id)).toEqual(expected);
  });
});

describe("routes that are not key-callable", () => {
  const every = [
    "access.read",
    "access.manage",
    "audit.read",
    "crm.read",
    "crm.manage",
    "data-room.read",
    "data-room.qa_manage",
    "metrics.read",
    "metrics.manage",
    "round.read",
    "updates.read",
  ];
  const SAMPLE: readonly [method: string, path: () => string, body?: unknown][] = [
    ["GET", () => "/me"], // session
    ["GET", () => "/data-room/tree"], // member
    ["GET", () => "/metrics/series"], // member
    ["GET", () => "/access/invites"], // access.read, unmarked
    ["POST", () => "/access/groups", { name: "Nope" }], // access.manage, unmarked
    ["DELETE", () => `/access/groups/${groupId}`], // stepUp
    ["GET", () => "/crm/organizations"], // crm.read, unmarked
    ["DELETE", () => `/crm/contacts/${contactId}`], // crm.manage, unmarked
    ["GET", () => "/audit/verify"], // audit.read, unmarked
    ["PATCH", () => "/data-room/settings", { qa: { enabled: true } }], // stepUp
    ["POST", () => "/updates/posts", { title: "Nope" }], // updates.manage
    ["GET", () => "/api-keys"], // keys never see keys
    ["GET", () => `/round/rounds/${roundId}`], // round.read, unmarked
  ];

  it("answer 401 api_key_not_allowed, whatever the key holds", async () => {
    const key = await mintKey(owner.membershipId, every);
    for (const [method, path, body] of SAMPLE) {
      const res = await request(`/api/v1${path()}`, {
        method,
        key: key.token,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      expect(res.status, `${method} ${path()}: ${text}`).toBe(401);
      const err = (JSON.parse(text) as { error: { code: string; reason?: string } }).error;
      expect(err.code, `${method} ${path()}`).toBe("unauthenticated");
      expect(err.reason, `${method} ${path()}`).toBe("api_key_not_allowed");
    }
  });
});
