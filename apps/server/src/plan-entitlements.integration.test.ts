import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditService } from "@fundroom/audit";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, PLATFORM_WORKSPACE_ID } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { PLAN_FEATURES } from "@fundroom/domain";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { plansCommand } from "./cli-commands/plans.js";
import { OPTIONAL_MODULE_IDS } from "./entitlements.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Plan entitlements, the editing side (A-3 / E-UP-2, ADR-0063; owner D): the operator API stores
 * and returns `limits.modules` / `limits.features` (sorted; `limits_schema_version` 2; the lists
 * ride in the `plan.create` / `plan.update` audit meta), refuses a module that is not an optional
 * module of this build with 400 `validation_failed` `{ reason: "unknown_module", module }`,
 * refuses duplicates and unknown features at the schema, and lists the `entitlementCatalog` the
 * console builds its checklists from. The tenant's `GET /billing` and `GET /usage` carry the
 * lists. `fundroom plan upsert --modules/--features` replaces only the key it names on an existing
 * plan's current limits (the numbers stay) and exits 2 naming an unknown module.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let op: string;
let owner: string;
let workspaceId: string;

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const operator = (path: string, method = "GET", body?: unknown) =>
  request(CANON, `/api/v1/platform${path}`, {
    method,
    cookie: op,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

type Limits = Record<string, unknown>;
type PlanBody = { id: string; version: number; limits: Limits };
type ErrorBody = { error: { code: string; reason?: string; module?: string | null } };

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

/** The workspace's owner, signed in and stepped up (staff sessions need MFA). */
async function signedInOwner(slug: string, email: string): Promise<string> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: "Owner" });
  await provisionMembership(deps, {
    workspaceId,
    userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  const host = `${slug}.${CANON}`;
  const since = mailer.sent.length;
  const start = await request(host, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(host, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const cookie = cookiesOf(verify);
  const enrol = await request(host, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(host, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function stored(id: string): Promise<{ limits: Limits; limits_schema_version: number }> {
  const rows = await q<{ limits: Limits; limits_schema_version: number }>(
    "SELECT limits, limits_schema_version FROM core.plan WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no plan ${id}`);
  return row;
}

async function auditLimits(action: string, planId: string): Promise<Limits[]> {
  const rows = await q<{ meta: Record<string, unknown> }>(
    "SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = $2 AND meta->>'planId' = $3 ORDER BY seq",
    [PLATFORM_WORKSPACE_ID, action, planId],
  );
  return rows.map((r) => r.meta["limits"] as Limits);
}

/** `fundroom plan …` against the test database; stdout lines and stderr text collected. */
async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string }> {
  const out: string[] = [];
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await plansCommand(argv, {
      db: running.container.db,
      audit: createAuditService({ db: running.container.db }),
      osUser: "tester",
      out: (line) => out.push(line),
    });
    return { code, out, err: err.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    err.mockRestore();
  }
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
      CONTROL_PLANE: "on",
      BILLING_DRIVER: "manual",
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
  workspaceId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email: "op@platform.test", displayName: "Op" });
  await q("INSERT INTO core.platform_operator (user_id, created_by) VALUES ($1, 'cli:test')", [
    userId,
  ]);
  const minted = await running.container.auth.sessions.startSession({
    userId,
    population: "operator",
    context: "first_party",
    authLevel: 2,
  });
  op = `__Host-op_sid=${minted.token}`;
  owner = await signedInOwner("acme", "owner@acme.test");
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("plan entitlements (operator API)", () => {
  it("lists the entitlement catalogue: optional modules of this build and every feature", async () => {
    const res = await operator("/plans");
    expect(res.status).toBe(200);
    const body = await json<{ entitlementCatalog: { modules: string[]; features: string[] } }>(res);
    expect(body.entitlementCatalog).toEqual({
      modules: [...OPTIONAL_MODULE_IDS],
      features: [...PLAN_FEATURES],
    });
    expect(body.entitlementCatalog.modules).toEqual(
      expect.arrayContaining(["data-room", "updates", "crm", "captable"]),
    );
    // Required modules (and kernel manifests) are never offered.
    expect(body.entitlementCatalog.modules).not.toContain("content");
    expect(body.entitlementCatalog.features).toHaveLength(12);
  });

  it("creates and changes a plan with lists: stored sorted at schema version 2, returned, audited", async () => {
    const created = await operator("/plans", "POST", {
      id: "growth",
      name: "Growth",
      limits: { staffSeats: 5, modules: ["updates", "data-room"], features: ["sso", "ai"] },
      public: true,
    });
    expect(created.status).toBe(201);
    const plan = await json<PlanBody>(created);
    const want = { staffSeats: 5, modules: ["data-room", "updates"], features: ["ai", "sso"] };
    expect(plan.limits).toEqual(want);
    expect(await stored("growth")).toEqual({ limits: want, limits_schema_version: 2 });
    expect(await auditLimits("plan.create", "growth")).toEqual([want]);

    // `limits` replaces the whole object: `[]` = none, a list left out = all.
    const changed = await operator("/plans/growth", "PATCH", {
      version: plan.version,
      limits: { staffSeats: 5, modules: [], features: ["qa"] },
    });
    expect(changed.status).toBe(200);
    const after = await json<PlanBody>(changed);
    expect(after.limits).toEqual({ staffSeats: 5, modules: [], features: ["qa"] });
    expect((await stored("growth")).limits).toEqual(after.limits);
    expect(await auditLimits("plan.update", "growth")).toEqual([after.limits]);

    const listed = await json<{ plans: PlanBody[] }>(await operator("/plans"));
    expect(listed.plans.find((p) => p.id === "growth")?.limits).toEqual(after.limits);

    const dropped = await operator("/plans/growth", "PATCH", {
      version: after.version,
      limits: { staffSeats: 5 },
    });
    expect(dropped.status).toBe(200);
    expect((await json<PlanBody>(dropped)).limits).toEqual({ staffSeats: 5 });
    expect(await stored("growth")).toEqual({
      limits: { staffSeats: 5 },
      limits_schema_version: 2,
    });

    // Put the lists back for the tenant reads below.
    const restored = await operator("/plans/growth", "PATCH", {
      version: after.version + 1,
      limits: want,
    });
    expect(restored.status).toBe(200);
  });

  it("refuses a module that is not an optional module of this build with 400 details", async () => {
    for (const module of ["content", "audit", "nosuch"]) {
      const res = await operator("/plans", "POST", {
        id: `bad-${module}`,
        name: "Bad",
        limits: { modules: ["data-room", module] },
      });
      expect(res.status, module).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error).toMatchObject({
        code: "validation_failed",
        reason: "unknown_module",
        module,
      });
    }
    expect(await q("SELECT id FROM core.plan WHERE id LIKE 'bad-%'")).toEqual([]);

    const before = await stored("growth");
    const current = await json<{ plans: PlanBody[] }>(await operator("/plans"));
    const version = current.plans.find((p) => p.id === "growth")?.version;
    const patch = await operator("/plans/growth", "PATCH", {
      version,
      limits: { modules: ["metrics", "nosuch"] },
    });
    expect(patch.status).toBe(400);
    expect((await json<ErrorBody>(patch)).error).toMatchObject({
      reason: "unknown_module",
      module: "nosuch",
    });
    expect(await stored("growth")).toEqual(before);
  });

  it("refuses duplicate ids, unknown features and malformed module ids at the schema", async () => {
    for (const limits of [
      { modules: ["crm", "crm"] },
      { features: ["sso", "sso"] },
      { features: ["telepathy"] },
      { modules: ["Data Room"] },
      { modules: "crm" },
    ]) {
      const res = await operator("/plans", "POST", { id: "dup", name: "Dup", limits });
      expect(res.status, JSON.stringify(limits)).toBe(400);
      expect((await json<ErrorBody>(res)).error.code).toBe("validation_failed");
    }
    expect(await q("SELECT id FROM core.plan WHERE id = 'dup'")).toEqual([]);
  });
});

describe("plan entitlements (tenant reads)", () => {
  it("GET /billing plans and GET /usage carry the lists", async () => {
    const want = { staffSeats: 5, modules: ["data-room", "updates"], features: ["ai", "sso"] };
    await running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET plan_id = 'growth' WHERE id = '${workspaceId}'`),
    );
    running.container.resolver.invalidate();

    const billing = await request(`acme.${CANON}`, "/api/v1/billing", { cookie: owner });
    expect(billing.status).toBe(200);
    const overview = await json<{ plans: { id: string; limits: Limits }[] }>(billing);
    expect(overview.plans.find((p) => p.id === "growth")?.limits).toEqual(want);

    const usage = await request(`acme.${CANON}`, "/api/v1/usage", { cookie: owner });
    expect(usage.status).toBe(200);
    expect((await json<{ plan: { id: string; limits: Limits } }>(usage)).plan).toMatchObject({
      id: "growth",
      limits: want,
    });

    const platformUsage = await operator(`/workspaces/${workspaceId}/usage`);
    expect(platformUsage.status).toBe(200);
    expect((await json<{ plan: { limits: Limits } }>(platformUsage)).plan.limits).toEqual(want);
  });
});

describe("fundroom plan upsert --modules / --features", () => {
  it("creates a plan from the flags alone (`none` = [])", async () => {
    const r = await cli("upsert", "basic", "--name", "Basic", "--modules", "none");
    expect(r.code, r.err).toBe(0);
    expect(r.out[0]).toBe("created basic\tBasic\tunlimited modules=[] features=all");
    expect(await stored("basic")).toEqual({ limits: { modules: [] }, limits_schema_version: 2 });
  });

  it("replaces only the key named on the plan's current limits; the numbers stay", async () => {
    await operator("/plans", "POST", {
      id: "scale",
      name: "Scale",
      limits: { staffSeats: 20, storageBytes: 5_000, modules: ["crm"], features: ["qa"] },
    });
    const r = await cli("upsert", "scale", "--features", "sso,scim");
    expect(r.code, r.err).toBe(0);
    expect(r.out[0]).toBe(
      "updated scale\tScale\tstaffSeats=20,storageBytes=5000 modules=[crm] features=[scim sso]",
    );
    expect((await stored("scale")).limits).toEqual({
      staffSeats: 20,
      storageBytes: 5_000,
      modules: ["crm"],
      features: ["scim", "sso"],
    });
    expect((await auditLimits("plan.update", "scale")).at(-1)).toEqual({
      staffSeats: 20,
      storageBytes: 5_000,
      modules: ["crm"],
      features: ["scim", "sso"],
    });

    // `all` removes the key (no restriction); the other list and the numbers stay.
    const all = await cli("upsert", "scale", "--modules", "all");
    expect(all.code, all.err).toBe(0);
    expect((await stored("scale")).limits).toEqual({
      staffSeats: 20,
      storageBytes: 5_000,
      features: ["scim", "sso"],
    });

    // With --limits, the flag overrides the same key in the JSON and the JSON replaces the rest.
    const both = await cli(
      "upsert",
      "scale",
      "--limits",
      '{"staffSeats":30,"features":["qa"]}',
      "--features",
      "ai",
    );
    expect(both.code, both.err).toBe(0);
    expect((await stored("scale")).limits).toEqual({ staffSeats: 30, features: ["ai"] });

    // Decision 10: a `--limits` that leaves a list out keeps the plan's current one, read in the
    // same transaction as the write; only a flag clears it.
    expect((await cli("upsert", "scale", "--modules", "crm")).code).toBe(0);
    const seats = await cli("upsert", "scale", "--limits", '{"staffSeats":40}');
    expect(seats.code, seats.err).toBe(0);
    expect((await stored("scale")).limits).toEqual({
      staffSeats: 40,
      modules: ["crm"],
      features: ["ai"],
    });
    const cleared = await cli(
      "upsert",
      "scale",
      "--limits",
      '{"staffSeats":30}',
      "--modules",
      "all",
    );
    expect(cleared.code, cleared.err).toBe(0);
    expect((await stored("scale")).limits).toEqual({ staffSeats: 30, features: ["ai"] });

    const list = await cli("list");
    expect(list.out.find((l) => l.startsWith("scale\t"))).toContain(
      "staffSeats=30 modules=all features=[ai]",
    );
  });

  it("exits 2 naming an unknown module and the valid ones; nothing is written", async () => {
    const before = await stored("scale");
    const r = await cli("upsert", "scale", "--modules", "crm,content");
    expect(r.code).toBe(2);
    expect(r.err).toContain("content is not an optional module of this build");
    expect(r.err).toContain(`valid: ${OPTIONAL_MODULE_IDS.join(", ")}`);
    expect(await stored("scale")).toEqual(before);

    const feature = await cli("upsert", "scale", "--features", "sso,telepathy");
    expect(feature.code).toBe(2);
    expect(feature.err).toContain("telepathy is not a feature");
  });
});
