import { randomUUID } from "node:crypto";
import { createAccreditationService } from "@fundroom/accreditation";
import { createMemoryAccreditationAdapter } from "@fundroom/accreditation/testing";
import { createWorkspace, type Database, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { AccreditationProviderError } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * Accreditation vendor connections, end to end (E3.7, ADR-0055) against a real server on a real
 * database, with the in-memory vendor standing in for VerifyInvestor and Parallel Markets:
 *
 *  - the vendor list (`offered`) and who may read it (legal yes; viewer/editor 403; investor 404);
 *  - the connection lifecycle: step-up, live credential check BEFORE anything is stored (422 and
 *    no row; 502 when the vendor is down), hints only, blank secret keeps the stored one (same
 *    driver only — never a replaced connection's), verify (status/lastError), driver switch
 *    (soft-deletes the old row), delete, the 10/h save budget, a vendor the operator does not
 *    offer;
 *  - the ops callback: one 401 body for unknown / forged / non-uuid, an authentic callback records
 *    `last_callback_at` and publishes ONE `accreditation.provider_updated`, over budget is 200;
 *  - `ModuleServices.accreditation`: `effective()` manual vs vendor, `start`/`check`/
 *    `fetchEvidence` through the memory vendor, `not_connected` on a driver mismatch, an
 *    `unauthorized` vendor answer marking the connection;
 *  - a one-connection pool: no transaction is held while the vendor is being called.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const vi = createMemoryAccreditationAdapter("verifyinvestor");
const pm = createMemoryAccreditationAdapter("parallel-markets");
const adapters = { verifyinvestor: vi.definition, "parallel-markets": pm.definition };
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql } = h;

let acmeId: string;
let betaId: string;
let owner: Actor;
let stale: Actor;
let counsel: Actor;
let viewer: Actor;
let editor: Actor;
let ada: Actor;
let betaOwner: Actor;

const TOKEN = "vi-api-token-0123456789-wxyz";
const HOOK = "vi-webhook-secret-abcdef-9876";
const PM_KEY = "pm-api-key-0123456789-qrst";
const PM_HOOK = "pm-signing-key-0123456789-lmno";

interface ConnectionBody {
  id: string;
  driver: string;
  label: string;
  environment: string;
  credentialHints: Record<string, string>;
  status: "active" | "error";
  lastVerifiedAt: string | null;
  lastError: string | null;
  lastCallbackAt: string | null;
  callbackUrl: string;
  handoffUrl: string;
}

/** The acme VerifyInvestor connection. */
let conn: ConnectionBody;

async function put(
  slug: string,
  cookie: string,
  body: Record<string, unknown>,
  via?: RunningServer,
): Promise<Response> {
  return request(slug, "/api/v1/accreditation/connection", {
    method: "PUT",
    cookie,
    body: JSON.stringify(body),
    ...(via === undefined ? {} : { server: via }),
  });
}

async function connectionOf(slug: string, cookie: string): Promise<ConnectionBody | null> {
  const res = await request(slug, "/api/v1/accreditation/connection", { cookie });
  expect(res.status).toBe(200);
  return (await json<{ connection: ConnectionBody | null }>(res)).connection;
}

/** A POST to the vendor callback URL on the canonical host (the ops tree). */
async function callback(
  connectionId: string,
  req: { headers: Headers; rawBody: Uint8Array },
  via?: RunningServer,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("host", CANON);
  return (via ?? running).app.request(`${BASE}/webhooks/accreditation/${connectionId}`, {
    method: "POST",
    headers,
    body: req.rawBody as Uint8Array<ArrayBuffer>,
  });
}

async function outboxFor(connectionId: string) {
  return (
    await pg.pool.query<{ payload: { connectionId: string; driver: string; refs: string[] } }>(
      `SELECT payload FROM core.outbox WHERE topic = 'accreditation.provider_updated'
          AND payload->>'connectionId' = $1 ORDER BY id`,
      [connectionId],
    )
  ).rows;
}

async function rowsOf(workspaceId: string) {
  return (
    await pg.pool.query<{
      id: string;
      driver: string;
      deleted_at: Date | null;
      last_callback_at: Date | null;
      status: string;
    }>(
      `SELECT id, driver, deleted_at, last_callback_at, status
         FROM core.accreditation_connection WHERE workspace_id = $1 ORDER BY created_at`,
      [workspaceId],
    )
  ).rows;
}

/** Every session of `actor`'s user authenticated `ageMs` ago (past the step-up window). */
async function age(actor: Actor, ageMs: number): Promise<void> {
  await pg.pool.query(
    `UPDATE core.session SET auth_time = now() - ($2::bigint * interval '1 millisecond')
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1) AND revoked_at IS NULL`,
    [actor.membershipId, ageMs],
  );
}

/** Rejects if `p` has not settled within `ms` (a held pool connection shows up as a hang). */
async function within<T>(ms: number, label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out (pool held?)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env),
    logger: createLogger({ level: "error" }),
    mailer,
    accreditationAdapters: adapters,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  stale = await member("acme", acmeId, "stale@acme.test", "staff", "admin");
  counsel = await member("acme", acmeId, "counsel@acme.test", "staff", "legal");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  editor = await member("acme", acmeId, "editor@acme.test", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  betaOwner = await member("beta", betaId, "owner@beta.test", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("who may see and change the connection", () => {
  it("lists both vendors (offered, with credential fields) to accreditation.read holders", async () => {
    const res = await request("acme", "/api/v1/accreditation/providers", {
      cookie: counsel.cookie,
    });
    expect(res.status).toBe(200);
    const { providers } = await json<{
      providers: {
        driver: string;
        offered: boolean;
        handoff: string;
        credentialFields: { key: string; kind: string }[];
      }[];
    }>(res);
    expect(providers.map((p) => [p.driver, p.offered, p.handoff])).toEqual([
      ["verifyinvestor", true, "invite_email"],
      ["parallel-markets", true, "widget"],
    ]);
    expect(providers[0]?.credentialFields.map((f) => f.key)).toEqual([
      "apiToken",
      "webhookSecret",
      "environment",
      "portalName",
    ]);
  });

  it("refuses viewer and editor (403) and hides everything from an investor (404)", async () => {
    for (const path of ["/api/v1/accreditation/providers", "/api/v1/accreditation/connection"]) {
      for (const who of [viewer, editor]) {
        expect((await request("acme", path, { cookie: who.cookie })).status, path).toBe(403);
      }
      expect((await request("acme", path, { cookie: ada.cookie })).status, path).toBe(404);
    }
    const body = { driver: "verifyinvestor", credentials: { apiToken: TOKEN } };
    for (const who of [viewer, editor, counsel]) {
      expect((await put("acme", who.cookie, body)).status).toBe(403);
    }
    expect((await put("acme", ada.cookie, body)).status).toBe(404);
    for (const [method, path] of [
      ["POST", "/api/v1/accreditation/connection/verify"],
      ["DELETE", "/api/v1/accreditation/connection"],
    ] as const) {
      expect((await request("acme", path, { method, cookie: counsel.cookie })).status).toBe(403);
      expect((await request("acme", path, { method, cookie: ada.cookie })).status).toBe(404);
    }
  });

  it("starts unconfigured, and saving needs a fresh session (step-up)", async () => {
    expect(await connectionOf("acme", counsel.cookie)).toBeNull();
    await age(stale, 20 * 60_000);
    const res = await put("acme", stale.cookie, {
      driver: "verifyinvestor",
      credentials: { apiToken: TOKEN, environment: "staging" },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: "step_up_required", reason: "fresh" } });
    expect(await rowsOf(acmeId)).toEqual([]);
  });
});

describe("saving the connection", () => {
  it("checks the credentials live before storing anything (422, no row; 502 when unreachable)", async () => {
    const before = vi.vendor.calls()["verifyCredentials"] ?? 0;
    const bad = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: { apiToken: "invalid", environment: "staging" },
    });
    expect(bad.status).toBe(422);
    expect((await json<ErrorBody>(bad)).error.code).toBe("accreditation_credentials_invalid");
    expect(vi.vendor.calls()["verifyCredentials"]).toBe(before + 1);

    const missing = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: { environment: "staging" },
    });
    expect(missing.status).toBe(422);
    expect(await json(missing)).toMatchObject({
      error: { code: "accreditation_credentials_invalid", fields: ["apiToken"] },
    });

    const down = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: { apiToken: "unreachable", environment: "staging" },
    });
    expect(down.status).toBe(502);
    expect((await json<ErrorBody>(down)).error.code).toBe("accreditation_provider_error");
    expect(await rowsOf(acmeId)).toEqual([]);
  });

  it("connects: hints only, nothing secret in responses, rows or audit", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: {
        apiToken: TOKEN,
        webhookSecret: HOOK,
        environment: "staging",
        portalName: "Acme",
      },
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HOOK);
    conn = (JSON.parse(text) as { connection: ConnectionBody }).connection;
    expect(conn).toMatchObject({
      driver: "verifyinvestor",
      label: "VerifyInvestor.com",
      environment: "staging",
      status: "active",
      lastError: null,
      lastCallbackAt: null,
      callbackUrl: `http://${CANON}/webhooks/accreditation/${conn.id}`,
      handoffUrl: `http://acme.${CANON}/api/v1/round/current/verification/handoff`,
      credentialHints: {
        apiToken: `••••${TOKEN.slice(-4)}`,
        webhookSecret: `••••${HOOK.slice(-4)}`,
        environment: "staging",
        portalName: "Acme",
      },
    });
    expect(conn.lastVerifiedAt).not.toBeNull();

    const read = await (
      await request("acme", "/api/v1/accreditation/connection", { cookie: counsel.cookie })
    ).text();
    expect(read).not.toContain(TOKEN);
    expect(read).not.toContain(HOOK);
    const [row] = (
      await pg.pool.query<{ blob: string }>(
        `SELECT encode(credentials_enc, 'escape') || credential_hints::text || encryption::text AS blob
           FROM core.accreditation_connection WHERE id = $1`,
        [conn.id],
      )
    ).rows;
    expect(row?.blob).not.toContain(TOKEN);
    expect(row?.blob).not.toContain(HOOK);
    const audit = await sql<{ action: string; meta: Record<string, unknown> }>(
      acmeId,
      `SELECT action, meta FROM audit.event WHERE resource_id = '${conn.id}' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action)).toEqual(["accreditation.connection_saved"]);
    expect(audit[0]?.meta).toMatchObject({
      driver: "verifyinvestor",
      environment: "staging",
      replaced: false,
      fields: ["apiToken", "environment", "portalName", "webhookSecret"],
    });
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it("a same-driver save with blank secrets keeps the stored ones", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: { apiToken: "", environment: "production" },
    });
    expect(res.status).toBe(200);
    const saved = (await json<{ connection: ConnectionBody }>(res)).connection;
    expect(saved.id).toBe(conn.id);
    expect(saved.environment).toBe("production");
    expect(saved.credentialHints).toMatchObject({
      apiToken: `••••${TOKEN.slice(-4)}`,
      webhookSecret: `••••${HOOK.slice(-4)}`,
    });
    // The live check ran on the stored secrets; the omitted plain field kept its value too.
    expect(vi.vendor.configs().at(-1)).toEqual({
      apiToken: TOKEN,
      webhookSecret: HOOK,
      environment: "production",
      portalName: "Acme",
    });
    conn = saved;
  });
});

describe("re-verifying", () => {
  const verify = () =>
    request("acme", "/api/v1/accreditation/connection/verify", {
      method: "POST",
      cookie: owner.cookie,
    });

  it("records a refusal on the connection, a vendor outage as 502 without changing it", async () => {
    const ok = await verify();
    expect(ok.status).toBe(200);
    expect((await json<{ connection: ConnectionBody }>(ok)).connection.status).toBe("active");

    vi.vendor.failNext(1, "unauthorized");
    const refused = (await json<{ connection: ConnectionBody }>(await verify())).connection;
    expect(refused.status).toBe("error");
    expect(refused.lastError).toMatch(/^unauthorized/u);

    vi.vendor.failNext(1, "unavailable");
    const down = await verify();
    expect(down.status).toBe(502);
    expect((await json<ErrorBody>(down)).error.code).toBe("accreditation_provider_error");
    expect((await connectionOf("acme", counsel.cookie))?.status).toBe("error");

    const again = (await json<{ connection: ConnectionBody }>(await verify())).connection;
    expect(again).toMatchObject({ status: "active", lastError: null });
    const actions = await sql<{ action: string; outcome: string }>(
      acmeId,
      `SELECT action, outcome FROM audit.event WHERE resource_id = '${conn.id}'
          AND action = 'accreditation.connection_verified' ORDER BY seq`,
    );
    expect(actions.map((a) => a.outcome)).toEqual(["success", "failure", "success"]);
  });
});

describe("the vendor callback", () => {
  const UNAUTH = { error: { code: "unauthenticated" } };

  it("answers unknown, forged and non-uuid ids with the same 401 body", async () => {
    const genuine = vi.vendor.callbackRequest(["vr:1"], HOOK);
    const forged = vi.vendor.callbackRequest(["vr:1"], "not-the-secret");
    const answers = [
      await callback(randomUUID(), genuine),
      await callback(conn.id, forged),
      await callback(conn.id, { headers: new Headers(), rawBody: genuine.rawBody }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(UNAUTH);
    }
    // A non-uuid id never reaches the ops tree (classifier), and nothing about it says more.
    const junk = await callback("not-a-uuid", genuine);
    expect(junk.status).not.toBe(200);
    expect(await outboxFor(conn.id)).toEqual([]);
    expect((await rowsOf(acmeId))[0]?.last_callback_at).toBeNull();
  });

  it("an authentic callback records last_callback_at and publishes ONE wake-up with the refs", async () => {
    const res = await callback(conn.id, vi.vendor.callbackRequest(["vr:7", "vr:8", "vr:7"], HOOK));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await outboxFor(conn.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      connectionId: conn.id,
      driver: "verifyinvestor",
      refs: ["vr:7", "vr:8"],
    });
    const [row] = await rowsOf(acmeId);
    expect(row?.last_callback_at).not.toBeNull();
    expect((await connectionOf("acme", counsel.cookie))?.lastCallbackAt).not.toBeNull();
  });

  it("an unknown id costs one host lookup and no tenant transaction (no pre-auth DB decoy)", async () => {
    // Fix round 2: the unknown-id 401 spends an HMAC (no DB work) as its stand-in for a signature
    // check; the host lookup is the only DB cost a junk uuid may buy under the pre-auth ceiling.
    const counts = { host: 0, tenant: 0 };
    const real = running.container.db;
    const db = {
      ...real,
      withHost: ((fn: never) => {
        counts.host += 1;
        return real.withHost(fn);
      }) as Database["withHost"],
      withTenant: ((ctx: never, fn: never) => {
        counts.tenant += 1;
        return real.withTenant(ctx, fn);
      }) as Database["withTenant"],
    } as Database;
    const svc = createAccreditationService({
      db,
      audit: running.container.audit,
      crypto: running.container.envelope,
      fetch: globalThis.fetch,
      adapters,
      callbackUrl: (id) => id,
    });
    const cost = async (id: string, secret: string) => {
      counts.host = 0;
      counts.tenant = 0;
      const r = await svc.ingestCallback(id, vi.vendor.callbackRequest(["vr:1"], secret));
      expect(r.status).toBe(401);
      return { ...counts };
    };
    expect(await cost(randomUUID(), HOOK)).toEqual({ host: 1, tenant: 0 });
    expect(await cost(conn.id, "not-the-secret")).toEqual({ host: 1, tenant: 1 });
  });

  it("over the per-connection budget answers 200 and records nothing", async () => {
    const budgeted = await startServer({
      config: esignTestConfig(env, { ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      accreditationAdapters: adapters,
      accreditationCallbackBudget: { perConnectionPerMinute: 1 },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const before = (await outboxFor(conn.id)).length;
      const first = await callback(conn.id, vi.vendor.callbackRequest(["vr:9"], HOOK), budgeted);
      expect(first.status).toBe(200);
      expect(await outboxFor(conn.id)).toHaveLength(before + 1);
      const over = await callback(conn.id, vi.vendor.callbackRequest(["vr:9"], HOOK), budgeted);
      expect(over.status).toBe(200);
      expect(await over.json()).toEqual({ ok: true });
      expect(await outboxFor(conn.id)).toHaveLength(before + 1);
      // Forged ones are still the 401 (they never spend the budget either).
      const forged = await callback(conn.id, vi.vendor.callbackRequest(["vr:9"], "x"), budgeted);
      expect(forged.status).toBe(401);
    } finally {
      await budgeted.stop();
    }
  });
});

describe("ModuleServices.accreditation", () => {
  const acme = () => systemContext(acmeId);
  const beta = () => systemContext(betaId);
  const service = () => running.container.moduleServices.accreditation;

  it("effective(): the live vendor, or manual without a connection", async () => {
    expect(await service().effective(undefined, acme())).toEqual({
      driver: "verifyinvestor",
      label: "VerifyInvestor.com",
      requires: { evidenceUpload: false, adminDecision: false },
      connectionId: conn.id,
    });
    expect(await service().effective(undefined, beta())).toEqual({
      driver: "manual",
      label: "Manual review",
      requires: { evidenceUpload: true, adminDecision: true },
    });
    // Inside a caller's (system-context) transaction too.
    const inTx = await running.container.db.withTenant(acme(), (tx) =>
      service().effective(tx, acme()),
    );
    expect(inTx.driver).toBe("verifyinvestor");
    expect(service().label("parallel-markets")).toBe("Parallel Markets");
    expect(service().label("manual")).toBe("Manual review");
  });

  it("start → vendor decides → check → evidence, through the stored credentials", async () => {
    const started = await service().start(acme(), {
      driver: "verifyinvestor",
      verificationId: randomUUID(),
      subject: "individual",
      email: "ada@investor.test",
      portalName: "Acme",
    });
    expect(started.handoff).toEqual({ kind: "invite_sent" });
    expect(vi.vendor.configs().at(-1)?.["apiToken"]).toBe(TOKEN);
    expect(
      (
        await service().check(acme(), {
          driver: "verifyinvestor",
          providerRef: started.providerRef,
        })
      ).status,
    ).toBe("in_progress");
    vi.vendor.accredit(started.providerRef);
    const decided = await service().check(acme(), {
      driver: "verifyinvestor",
      providerRef: started.providerRef,
    });
    expect(decided).toMatchObject({ status: "accredited", vendorStatus: "accredited" });
    const pdf = await service().fetchEvidence(acme(), {
      driver: "verifyinvestor",
      providerRef: started.providerRef,
    });
    expect(
      Buffer.from(pdf?.bytes ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  });

  it("not_connected when the live connection is another driver, or there is none", async () => {
    const other = service().check(acme(), { driver: "parallel-markets", providerRef: "x" });
    await expect(other).rejects.toBeInstanceOf(AccreditationProviderError);
    await expect(other).rejects.toMatchObject({ code: "not_connected", retryable: false });
    await expect(
      service().start(beta(), {
        driver: "verifyinvestor",
        verificationId: randomUUID(),
        subject: "individual",
        email: "x@investor.test",
      }),
    ).rejects.toMatchObject({ code: "not_connected" });
  });

  it("a vendor that refuses the stored credentials marks the connection (and nothing else)", async () => {
    vi.vendor.failNext(1, "unauthorized");
    await expect(
      service().check(acme(), { driver: "verifyinvestor", providerRef: "mem:1" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await connectionOf("acme", counsel.cookie)).toMatchObject({
      status: "error",
      lastError: expect.stringMatching(/^unauthorized/u) as unknown,
    });
    // A transient failure does not.
    const fixed = await request("acme", "/api/v1/accreditation/connection/verify", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect((await json<{ connection: ConnectionBody }>(fixed)).connection.status).toBe("active");
    vi.vendor.failNext(1, "unavailable");
    await expect(
      service().check(acme(), { driver: "verifyinvestor", providerRef: "mem:1" }),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect((await connectionOf("acme", counsel.cookie))?.status).toBe("active");
  });
});

describe("offered vendors", () => {
  it("a vendor the operator does not offer is listed offered:false and cannot be connected", async () => {
    const narrow = await startServer({
      config: esignTestConfig(env, { ROLES: "api", ACCREDITATION_DRIVERS: "verifyinvestor" }),
      logger: createLogger({ level: "error" }),
      mailer,
      accreditationAdapters: adapters,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const list = await json<{ providers: { driver: string; offered: boolean }[] }>(
        await request("acme", "/api/v1/accreditation/providers", {
          cookie: counsel.cookie,
          server: narrow,
        }),
      );
      expect(list.providers.map((p) => [p.driver, p.offered])).toEqual([
        ["verifyinvestor", true],
        ["parallel-markets", false],
      ]);
      const before = pm.vendor.calls()["verifyCredentials"] ?? 0;
      const res = await put(
        "acme",
        owner.cookie,
        {
          driver: "parallel-markets",
          credentials: { apiKey: PM_KEY, clientId: "client-1", environment: "demo" },
        },
        narrow,
      );
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).error.code).toBe("accreditation_driver_not_offered");
      // Refused before the vendor was asked anything; the live connection is untouched.
      expect(pm.vendor.calls()["verifyCredentials"] ?? 0).toBe(before);
      expect((await connectionOf("acme", counsel.cookie))?.id).toBe(conn.id);
    } finally {
      await narrow.stop();
    }
  });
});

describe("switching vendor", () => {
  let pmConn: ConnectionBody;

  it("replaces the connection: the old row is soft-deleted and stops answering", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "parallel-markets",
      credentials: {
        apiKey: PM_KEY,
        clientId: "client-1",
        webhookSigningKey: PM_HOOK,
        environment: "demo",
      },
    });
    expect(res.status).toBe(200);
    pmConn = (await json<{ connection: ConnectionBody }>(res)).connection;
    expect(pmConn.id).not.toBe(conn.id);
    expect(pmConn).toMatchObject({ driver: "parallel-markets", environment: "demo" });
    const rows = await rowsOf(acmeId);
    expect(rows.map((r) => [r.id, r.driver, r.deleted_at !== null])).toEqual([
      [conn.id, "verifyinvestor", true],
      [pmConn.id, "parallel-markets", false],
    ]);
    const [audit] = await sql<{ meta: Record<string, unknown> }>(
      acmeId,
      `SELECT meta FROM audit.event WHERE resource_id = '${pmConn.id}' ORDER BY seq`,
    );
    expect(audit?.meta).toMatchObject({
      replaced: true,
      previousDriver: "verifyinvestor",
      previousConnectionId: conn.id,
    });
    // The replaced connection's callback URL is dead.
    const old = await callback(conn.id, vi.vendor.callbackRequest(["vr:1"], HOOK));
    expect(old.status).toBe(401);
    expect(await old.json()).toEqual({ error: { code: "unauthenticated" } });
    // The new one answers with its own key.
    const fresh = await callback(pmConn.id, pm.vendor.callbackRequest(["rec_1"], PM_HOOK));
    expect(fresh.status).toBe(200);
    expect((await outboxFor(pmConn.id))[0]?.payload.refs).toEqual(["rec_1"]);
  });

  it("modules follow the switch: widget handoff, not_connected for the old driver", async () => {
    const ctx = systemContext(acmeId);
    const svc = running.container.moduleServices.accreditation;
    expect((await svc.effective(undefined, ctx)).driver).toBe("parallel-markets");
    const started = await svc.start(ctx, {
      driver: "parallel-markets",
      verificationId: randomUUID(),
      subject: "individual",
      email: "ada@investor.test",
      firstName: "Ada",
    });
    expect(started.handoff).toMatchObject({
      kind: "widget",
      config: { clientId: "client-1", environment: "demo", email: "ada@investor.test" },
    });
    await expect(
      svc.check(ctx, { driver: "verifyinvestor", providerRef: "vr:1" }),
    ).rejects.toMatchObject({ code: "not_connected" });
  });

  it("a vendor the operator stops offering starts nothing new; open verifications still sync", async () => {
    const ctx = systemContext(acmeId);
    const open = await running.container.moduleServices.accreditation.start(ctx, {
      driver: "parallel-markets",
      verificationId: randomUUID(),
      subject: "individual",
      email: "open@investor.test",
    });
    const narrow = await startServer({
      config: esignTestConfig(env, { ROLES: "api", ACCREDITATION_DRIVERS: "verifyinvestor" }),
      logger: createLogger({ level: "error" }),
      mailer,
      accreditationAdapters: adapters,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const svc = narrow.container.moduleServices.accreditation;
      expect(await svc.effective(undefined, ctx)).toEqual({
        driver: "manual",
        label: "Manual review",
        requires: { evidenceUpload: true, adminDecision: true },
      });
      await expect(
        svc.start(ctx, {
          driver: "parallel-markets",
          verificationId: randomUUID(),
          subject: "individual",
          email: "new@investor.test",
        }),
      ).rejects.toMatchObject({ code: "not_connected" });
      pm.vendor.accredit(open.providerRef);
      expect(
        (await svc.check(ctx, { driver: "parallel-markets", providerRef: open.providerRef }))
          .status,
      ).toBe("accredited");
      expect(
        await svc.fetchEvidence(ctx, { driver: "parallel-markets", providerRef: open.providerRef }),
      ).not.toBeNull();
      // The main server (both offered) still uses the vendor.
      expect(
        (await running.container.moduleServices.accreditation.effective(undefined, ctx)).driver,
      ).toBe("parallel-markets");
    } finally {
      await narrow.stop();
    }
  });

  it("switching back never reuses a replaced connection's secrets", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "verifyinvestor",
      credentials: { environment: "staging" },
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: { code: "accreditation_credentials_invalid", fields: ["apiToken"] },
    });
    expect((await connectionOf("acme", counsel.cookie))?.id).toBe(pmConn.id);
  });

  it("a one-connection pool: no transaction is open while the vendor is called", async () => {
    const single = await startServer({
      config: esignTestConfig(env, { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      accreditationAdapters: adapters,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    await single.container.relay.stop();
    const ctx = systemContext(acmeId);
    const svc = single.container.moduleServices.accreditation;
    // While the vendor call hangs, another query on the ONLY pool connection must get through.
    const probe = () =>
      within(
        5_000,
        "concurrent query",
        single.container.db.withTenant(ctx, async (tx) => {
          await tx.execute("SELECT 1");
          return true;
        }),
      );
    const held = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
      const hold = pm.vendor.hold();
      const pending = call();
      await within(5_000, `${label} reached the vendor`, hold.reached);
      expect(await probe(), label).toBe(true);
      hold.release();
      return within(5_000, label, pending);
    };
    try {
      const started = await held("start", () =>
        svc.start(ctx, {
          driver: "parallel-markets",
          verificationId: randomUUID(),
          subject: "individual",
          email: "pool@investor.test",
        }),
      );
      await held("check", () =>
        svc.check(ctx, { driver: "parallel-markets", providerRef: started.providerRef }),
      );
      pm.vendor.accredit(started.providerRef);
      await held("fetchEvidence", () =>
        svc.fetchEvidence(ctx, { driver: "parallel-markets", providerRef: started.providerRef }),
      );
      // The connection routes: save and verify make their live check outside any transaction.
      const saved = await held("save", () =>
        put(
          "acme",
          owner.cookie,
          {
            driver: "parallel-markets",
            // Secrets left blank keep the stored ones; plain fields are always sent.
            credentials: { clientId: "client-1", environment: "demo" },
          },
          single,
        ),
      );
      expect(saved.status, await saved.clone().text()).toBe(200);
      const verified = await held("verify", () =>
        request("acme", "/api/v1/accreditation/connection/verify", {
          method: "POST",
          cookie: owner.cookie,
          server: single,
        }),
      );
      expect(verified.status).toBe(200);
      // An unauthorized answer is recorded afterwards, still on the one connection.
      pm.vendor.failNext(1, "unauthorized");
      await expect(
        within(
          5_000,
          "unauthorized check",
          svc.check(ctx, {
            driver: "parallel-markets",
            providerRef: started.providerRef,
          }),
        ),
      ).rejects.toMatchObject({ code: "unauthorized" });
      const cb = await within(
        5_000,
        "callback",
        callback(pmConn.id, pm.vendor.callbackRequest(["rec_2"], PM_HOOK), single),
      );
      expect(cb.status).toBe(200);
    } finally {
      await single.stop();
    }
  }, 90_000);
});

describe("disconnecting", () => {
  it("soft-deletes the connection: manual again, callbacks 401, a second delete is 404", async () => {
    const live = await connectionOf("acme", counsel.cookie);
    expect(live).not.toBeNull();
    const res = await request("acme", "/api/v1/accreditation/connection", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(await connectionOf("acme", counsel.cookie)).toBeNull();
    expect(
      (
        await running.container.moduleServices.accreditation.effective(
          undefined,
          systemContext(acmeId),
        )
      ).driver,
    ).toBe("manual");
    const cb = await callback(live?.id ?? "", pm.vendor.callbackRequest(["rec_3"], PM_HOOK));
    expect(cb.status).toBe(401);
    const again = await request("acme", "/api/v1/accreditation/connection", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(again.status).toBe(404);
    const audit = await sql<{ action: string }>(
      acmeId,
      `SELECT action FROM audit.event WHERE resource_id = '${live?.id}' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action).at(-1)).toBe("accreditation.connection_deleted");
    expect((await rowsOf(acmeId)).every((r) => r.deleted_at !== null)).toBe(true);
  });
});

describe("the save budget", () => {
  it("allows 10 save attempts an hour per workspace (refused ones count), then 429", async () => {
    const valid = {
      driver: "verifyinvestor",
      credentials: { apiToken: TOKEN, environment: "staging" },
    };
    expect((await put("beta", betaOwner.cookie, valid)).status).toBe(200);
    for (let i = 0; i < 9; i++) {
      const res = await put("beta", betaOwner.cookie, {
        driver: "verifyinvestor",
        credentials: { apiToken: "invalid", environment: "staging" },
      });
      expect(res.status, `attempt ${i + 2}`).toBe(422);
    }
    const before = vi.vendor.calls()["verifyCredentials"] ?? 0;
    const limited = await put("beta", betaOwner.cookie, valid);
    expect(limited.status).toBe(429);
    expect((await json<ErrorBody>(limited)).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Refused before the vendor was asked.
    expect(vi.vendor.calls()["verifyCredentials"] ?? 0).toBe(before);
    // Another workspace's budget is its own (acme has spent 9 of its 10 in the tests above).
    expect((await put("acme", owner.cookie, valid)).status).toBe(200);
  });
});

describe("unreadable credentials", () => {
  it("mark the connection error instead of leaving it active while every call fails", async () => {
    const ctx = systemContext(betaId);
    const before = await connectionOf("beta", betaOwner.cookie);
    expect(before?.status).toBe("active");
    // beta's connection has no webhook secret (polling only): the same 401 body as unknown ids.
    const silent = await callback(before?.id ?? "", vi.vendor.callbackRequest(["vr:1"], HOOK));
    expect(silent.status).toBe(401);
    expect(await silent.json()).toEqual({ error: { code: "unauthenticated" } });
    await pg.pool.query(
      `UPDATE core.accreditation_connection SET credentials_enc = '\\x00'::bytea
        WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [betaId],
    );
    await expect(
      running.container.moduleServices.accreditation.check(ctx, {
        driver: "verifyinvestor",
        providerRef: "vr:1",
      }),
    ).rejects.toMatchObject({ code: "unauthorized", retryable: false });
    expect(await connectionOf("beta", betaOwner.cookie)).toMatchObject({
      id: before?.id,
      status: "error",
      lastError: expect.stringMatching(/unreadable/u) as unknown,
    });
  });
});
