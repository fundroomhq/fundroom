import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  checkRlsCatalog,
  createWorkspace,
  pgErrorCode,
  pgErrorMessage,
  systemContext,
  type TenantContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import {
  CHART_TOKEN_PURPOSE,
  type ChartTokenPayload,
  createSheetsService,
  JOB_SHEETS_SYNC,
  METRICS_IMPORT_MAX_ROWS,
  signChartToken,
} from "@fundroom/module-metrics";
import type { JsonObject, SpreadsheetFailure, SpreadsheetPort } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * KPIs end to end (E2.4): the first module in the product that is **off** by default →
 * per-metric audience gating in TypeScript *and* in RLS → restatement as revisions on an
 * append-only table, provable from the database alone → the period grid's three save rules →
 * the deferred exclusion constraint that makes a restatement writable at all → derived metrics
 * recomputed through the outbox → CSV import (dry run, job, row cap, idempotence) → the public
 * capability-addressed chart PNG and its one indistinguishable refusal → the Google Sheets
 * connection (encrypted credential, `needs_review` instead of a silent overwrite, a failure
 * that sends no mail) → permissions, step-up, the `metric_grid` hydrator on a published page,
 * and the audit/outbox trail.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

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

/** TOTP secrets kept per email so a session can be stepped up again later (see `stepUp`). */
const totpSecrets = new Map<string, string>();
/**
 * The last thirty-second TOTP step this suite consumed per user.
 *
 * The credential remembers the step it accepted and rejects any code at or before it, so a
 * whole-suite run that enrols and steps up inside the same half-minute would fail on the
 * replay guard rather than on anything under test. Waiting for the next step is the only
 * honest way past it, which is also why the suite spends exactly one.
 */
const totpStep = new Map<string, number>();

const stepOf = () => Math.floor(Date.now() / 30_000);

async function freshTotp(email: string): Promise<string> {
  const secret = totpSecrets.get(email);
  if (secret === undefined) throw new Error(`no TOTP secret for ${email}`);
  while (stepOf() <= (totpStep.get(email) ?? -1)) await new Promise((r) => setTimeout(r, 500));
  totpStep.set(email, stepOf());
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

async function stepUpToMfa(slug: string, email: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  totpSecrets.set(email, secretBase32);
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: await freshTotp(email) }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

/**
 * The real step-up ceremony: prove a TOTP code on the current session.
 *
 * Used **once**, in the test that pins it. TOTP's replay guard accepts one code per
 * thirty-second step, so a suite that stepped up six times would spend three minutes asleep
 * waiting for the next window; everywhere else `markFresh` stands in, and the refusal half of
 * the same test is what proves the routes actually ask.
 */
async function stepUp(slug: string, email: string, cookie: string): Promise<string> {
  const verify = await request(slug, "/api/v1/auth/totp/verify", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: await freshTotp(email) }),
  });
  expect(verify.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, verify);
}

/**
 * Stamps an actor's sessions as having just proved themselves — what `sessions.stepUp` writes.
 *
 * Four metrics routes declare `+fresh` and the window is ten minutes, so a suite that signs in
 * once in `beforeAll` and reaches `PUT /sheets` thirty tests later would fail on the clock
 * rather than on the behaviour. What is under test in those places is the *route*, not the
 * ceremony; the ceremony has its own test and identity's own suite.
 */
async function markFresh(actor: Actor, ageMs = 0): Promise<void> {
  // `core.membership` is read in the workspace's own context and `core.session` is written in
  // host context: the session table belongs to no tenant. Doing the lookup on the wrong side
  // of that line yields a NULL subquery and an UPDATE that matches nothing, which would make
  // every assertion below pass for the wrong reason — so the row count is checked.
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
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

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "viewer" | "finance" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin")
    actor.cookie = await stepUpToMfa(slug, email, actor.cookie);
  return actor;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

/** Rows read as the `system` actor of a workspace (RLS admits staff and system on metrics.*). */
async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/**
 * Rows read as a specific *external* membership: exactly what RLS lets that investor see.
 *
 * This is the second half of decision D2 and the half a TypeScript filter cannot stand in for.
 * `audienceAdmits` in `model.ts` decides what the API returns; `metrics.audience_admits_current`
 * decides what a `SELECT` returns, and a test that only exercised the first would pass on a
 * build whose RLS policies had been dropped.
 */
async function rowsAsExternal<T>(membershipId: string, query: string): Promise<T[]> {
  const ctx: TenantContext = { workspaceId: acmeId, actorKind: "external", membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/**
 * The calendar month `n` months before now, as the wire key and as the range's lower bound.
 *
 * Derived from the clock rather than hard-coded: every period this suite writes must land
 * inside the twelve- and twenty-four-month windows `GET /grid` and `GET /series` default to,
 * and a literal `2026-05` would quietly fall out of them next spring.
 */
function monthsAgo(n: number): { key: string; start: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const key = `${d.getUTCFullYear().toString().padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { key, start: d.toISOString() };
}

const M = Array.from({ length: 13 }, (_, i) => monthsAgo(i));

/** `{ kind: "all" }`, spelled once. */
const A_ALL = { kind: "all" } as const;

/** One grid cell, since every save in this file writes the same three fields. */
const cell = (definitionId: string, period: { key: string } | undefined, value: string | null) => ({
  definitionId,
  periodKey: period?.key as string,
  value,
});

interface SeriesBody {
  periodKind: string;
  periods: { key: string; label: string }[];
  series: {
    definitionId: string;
    key: string;
    name: string;
    decimals: number;
    values: (string | null)[];
  }[];
}

interface GridBody {
  periodKind: string;
  periods: { key: string }[];
  definitions: { id: string; key: string }[];
  cells: {
    definitionId: string;
    periodKey: string;
    value: string;
    revision: number;
    sourceKind: string | null;
    needsReview: boolean;
    note: string | null;
  }[];
}

interface WriteResult {
  written: number;
  unchanged: number;
  restated: number;
  skipped: number;
  definitionIds: string[];
}

interface PointsBody {
  points: {
    id: string;
    periodKey: string;
    value: string;
    revision: number;
    sourceKind: string | null;
    needsReview: boolean;
    current: boolean;
    createdAt: string;
  }[];
}

interface ImportBody {
  id: string;
  status: string;
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  rows: { line: number; periodKey: string; status: string; reason?: string; cells: unknown[] }[];
}

interface DryRunBody {
  rows: {
    line: number;
    periodKey: string;
    status: string;
    reason?: string;
    cells: { key: string; status: string; reason?: string; value: string | null }[];
  }[];
  summary: { ok: number; skipped: number; error: number; values: number };
  columns: string[];
}

interface ConnectionBody {
  connection: {
    id: string;
    spreadsheetId: string;
    range: string;
    serviceAccountEmail: string;
    status: string;
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
}

interface RenderedPage {
  sections: {
    key: string;
    blocks: {
      id: string;
      type: string;
      data: Record<string, unknown>;
      unavailable?: string;
    }[];
  }[];
}

/*
 * A fake `SpreadsheetPort`, so no test reaches Google.
 *
 * It is overlaid on `ModuleServices` rather than injected through `startServer`, because
 * `StartOptions` has no `spreadsheets` seam even though `ContainerOptions` does (contract §12
 * C-D.7 created that seam for exactly this test). Reported, not fixed. The *failure* half of
 * the sweep is still driven through the real HTTP route with `SPREADSHEET_DRIVER=noop`, which
 * is a real refusal from a real adapter.
 */
let sheetRows: string[][] = [];
let sheetFailure: SpreadsheetFailure | undefined;
const fakeSheets: SpreadsheetPort = {
  driver: "fake",
  read: () =>
    Promise.resolve(
      sheetFailure === undefined
        ? ({ ok: true, range: { rows: sheetRows } } as const)
        : ({ ok: false, reason: sheetFailure } as const),
    ),
  healthCheck: () => Promise.resolve(),
};

function sheetsServiceWithFakePort() {
  const live = running.container.moduleServices;
  const overlaid = new Proxy(live, {
    get: (target, prop) => (prop === "spreadsheets" ? fakeSheets : Reflect.get(target, prop)),
  });
  return createSheetsService(overlaid);
}

/** The RSA key behind the pasted service-account JSON; generated here and never committed. */
let servicePrivateKeyPem = "";
const SERVICE_ACCOUNT_EMAIL = "kpis@acme-123456.iam.gserviceaccount.com";
const SPREADSHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

let acmeId: string;
let globexId: string;
let owner: Actor;
let financeUser: Actor;
let viewer: Actor;
let ada: Actor;
let board: Actor;
let board2: Actor;
let stale: Actor;
let globexOwner: Actor;
let boardGroupId: string;

const ids: Record<string, string> = {};

async function define(body: Record<string, unknown>): Promise<string> {
  const res = await request("acme", "/api/v1/metrics/definitions", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify(body),
  });
  expect(res.status, JSON.stringify(body)).toBe(201);
  const created = await json<{ id: string; key: string }>(res);
  ids[created.key] = created.id;
  return created.id;
}

async function saveGrid(
  cookie: string,
  cells: { definitionId: string; periodKey: string; value: string | null; note?: string }[],
): Promise<Response> {
  return request("acme", "/api/v1/metrics/grid", {
    method: "PUT",
    cookie,
    body: JSON.stringify({ periodKind: "month", cells }),
  });
}

const pointRowsOf = (definitionId: string, periodStart: string) =>
  rows<{
    id: string;
    revision: number;
    value: string;
    supersededBy: string | null;
    needsReview: boolean;
  }>(
    `SELECT id::text AS id, revision, value::text AS value,
            superseded_by::text AS "supersededBy", needs_review AS "needsReview"
       FROM metrics.point
      WHERE definition_id = '${definitionId}'::uuid
        AND period_start = '${periodStart}'::timestamptz
      ORDER BY revision`,
  );

const outboxCount = async (topic: string): Promise<number> =>
  running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}'`,
    );
    return (r.rows as { n: number }[])[0]?.n ?? 0;
  });

const auditCount = async (action: string): Promise<number> =>
  (
    await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = '${action}'`,
    )
  )[0]?.n ?? 0;

const totalPoints = async (): Promise<number> =>
  (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM metrics.point`))[0]?.n ?? 0;

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
      // Nothing in this suite may reach Google. `noop` also means the container builds no
      // outbound connection pool for the Sheets adapter, which is half of what an operator
      // means by switching the integration off.
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
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  financeUser = await member("acme", acmeId, "cfo@example.com", "staff", "finance");
  viewer = await member("acme", acmeId, "viewer@example.com", "staff", "viewer");
  stale = await member("acme", acmeId, "stale@example.com", "staff", "finance");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  board = await member("acme", acmeId, "board@investor.test", "external", "investor");
  // A second recipient in the same audience, which is what decision D5's shared URL is about.
  board2 = await member("acme", acmeId, "chair@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");

  const group = await json<{ id: string }>(
    await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Board", kind: "board" }),
    }),
  );
  boardGroupId = group.id;
  expect(
    (
      await request("acme", `/api/v1/access/groups/${boardGroupId}/members`, {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ membershipIds: [board.membershipId, board2.membershipId] }),
      })
    ).status,
  ).toBe(200);

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  servicePrivateKeyPem = privateKey;
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema, registry and the off-by-default switch", () => {
  it("metrics.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("point.superseded_by is deferred, so an import can insert a restatement chain in pk order (E2.8)", async () => {
    const r = await running.container.db.pool.query(
      `SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'point_superseded_by_fkey'`,
    );
    expect(r.rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });

  it("registers its permissions, jobs, nav slots and the metric_grid hydrator", async () => {
    const registry = running.container.registry;
    for (const p of ["metrics.read", "metrics.manage", "metrics.settings"]) {
      expect(registry.permissions.has(p)).toBe(true);
    }
    const jobs = registry.resolveJobs(running.container.moduleServices).map((j) => j.name);
    expect(jobs).toEqual(expect.arrayContaining(["metrics.import", JOB_SHEETS_SYNC]));
    expect(registry.blockHydrators.get("metric_grid")?.module).toBe("metrics");
  });

  it("is off until a workspace turns it on, and its routes 404 rather than 403 until then", async () => {
    /*
     * E2.4 §1: metrics is the first module in the product with `defaultEnabled: false`, and an
     * absent `core.module_enablement` row must read as "there is no such thing here". A 403
     * would tell an unauthorised caller that the feature exists and they merely lack the
     * right — which is the oracle the enablement guard exists to avoid.
     */
    const boot = await json<{ modules: { id: string; enabled: boolean }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    expect(boot.modules.find((m) => m.id === "metrics")?.enabled).toBe(false);

    for (const path of ["/api/v1/metrics/definitions", "/api/v1/metrics/grid"]) {
      const res = await request("acme", path, { cookie: owner.cookie });
      expect(res.status, path).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("module_disabled");
    }
    // `GET /series` is `member`, so an investor's refusal must be the same 404, not a 403.
    const investorSeries = await request("acme", "/api/v1/metrics/series", { cookie: ada.cookie });
    expect(investorSeries.status).toBe(404);
    expect((await json<{ error: { code: string } }>(investorSeries)).error.code).toBe(
      "module_disabled",
    );

    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("metrics", true),
    );
    running.container.enablement.invalidate(acmeId);
    expect(
      (await request("acme", "/api/v1/metrics/definitions", { cookie: owner.cookie })).status,
    ).toBe(200);

    const after = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = after.modules.find((m) => m.id === "metrics");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
    expect(mod?.slots["content.blocks"]).toEqual(["metric_grid"]);
  });
});

describe("definitions", () => {
  it("creates the workspace's metrics; a metric nobody published defaults to staff_only", async () => {
    await define({ key: "arr", name: "ARR", unit: "currency", currency: "USD", audience: A_ALL });
    await define({
      key: "board_cash",
      name: "Cash in bank",
      unit: "currency",
      currency: "USD",
      audience: { kind: "groups", groupIds: [boardGroupId] },
    });
    // No `audience` at all. E2.4 D2: a definition is created weeks before anybody decides who
    // should see it, so the default must be the closed one.
    const secret = await define({ key: "secret_margin", name: "Gross margin", unit: "percent" });
    await define({ key: "cash", name: "Cash", unit: "currency", currency: "USD", audience: A_ALL });
    await define({
      key: "net_burn",
      name: "Net burn",
      unit: "currency",
      currency: "USD",
      audience: A_ALL,
    });
    await define({ key: "headcount", name: "Headcount", unit: "count", audience: A_ALL });
    await define({ key: "odd_metric", name: "Odd", unit: "count", audience: A_ALL });
    await define({
      key: "runway",
      name: "Runway",
      unit: "months",
      decimals: 1,
      audience: A_ALL,
      formula: {
        op: "div",
        args: [
          { op: "ref", key: "cash" },
          { op: "ref", key: "net_burn" },
        ],
      },
    });

    const one = await json<{ audience: { kind: string }; formula: unknown }>(
      await request("acme", `/api/v1/metrics/definitions/${secret}`, { cookie: viewer.cookie }),
    );
    expect(one.audience).toEqual({ kind: "staff_only" });
    expect(one.formula).toBeNull();

    const derived = await json<{ aggregation: string; formula: { op: string } }>(
      await request("acme", `/api/v1/metrics/definitions/${ids["runway"]}`, {
        cookie: viewer.cookie,
      }),
    );
    // A formula is evaluated per period, so summing it across periods is arithmetic on
    // something that was never a quantity: the column CHECKs `last` and the service pins it.
    expect(derived.aggregation).toBe("last");
    expect(derived.formula.op).toBe("div");
  });

  it("refuses a duplicate key, a currency mismatch and a formula naming nothing", async () => {
    const dup = await request("acme", "/api/v1/metrics/definitions", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ key: "arr", name: "ARR again", unit: "count" }),
    });
    expect(dup.status).toBe(409);

    const noCurrency = await request("acme", "/api/v1/metrics/definitions", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ key: "mrr", name: "MRR", unit: "currency" }),
    });
    expect(noCurrency.status).toBe(400);
    expect((await json<{ error: { field: string } }>(noCurrency)).error.field).toBe("currency");

    const unknownRef = await request("acme", "/api/v1/metrics/definitions", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        key: "gross_margin",
        name: "GM",
        unit: "ratio",
        formula: { op: "ref", key: "nonexistent" },
      }),
    });
    expect(unknownRef.status).toBe(400);
    expect((await json<{ error: { key: string } }>(unknownRef)).error.key).toBe("nonexistent");
  });
});

describe("per-metric audience gating", () => {
  it("publishes one number to everyone, one to a group and one to nobody", async () => {
    const res = await saveGrid(owner.cookie, [
      { definitionId: ids["arr"] as string, periodKey: M[1]?.key as string, value: "1000000" },
      {
        definitionId: ids["board_cash"] as string,
        periodKey: M[1]?.key as string,
        value: "420000",
      },
      { definitionId: ids["secret_margin"] as string, periodKey: M[1]?.key as string, value: "71" },
    ]);
    expect(res.status).toBe(200);
    expect(await json<WriteResult>(res)).toMatchObject({ written: 3, restated: 0, unchanged: 0 });
  });

  it("GET /series shows an investor only the metrics their audience admits", async () => {
    const asAda = await json<SeriesBody>(
      await request("acme", "/api/v1/metrics/series", { cookie: ada.cookie }),
    );
    expect(asAda.series.map((s) => s.key)).toEqual([
      "arr",
      "cash",
      "headcount",
      "net_burn",
      "odd_metric",
      "runway",
    ]);

    const asBoard = await json<SeriesBody>(
      await request("acme", "/api/v1/metrics/series", { cookie: board.cookie }),
    );
    expect(asBoard.series.map((s) => s.key)).toContain("board_cash");
    expect(asBoard.series.map((s) => s.key)).not.toContain("secret_margin");

    // Staff see everything: the admin grid badges each metric's audience, so hiding rows there
    // would hide the thing the screen exists to manage.
    const asStaff = await json<SeriesBody>(
      await request("acme", "/api/v1/metrics/series", { cookie: viewer.cookie }),
    );
    expect(asStaff.series.map((s) => s.key)).toContain("secret_margin");

    // A metric an investor may not see is *dropped*, never reported as hidden: asking for it
    // by id must not tell them it exists.
    const byId = await json<SeriesBody>(
      await request(
        "acme",
        `/api/v1/metrics/series?ids=${ids["secret_margin"]},${ids["board_cash"]},${ids["arr"]}`,
        { cookie: ada.cookie },
      ),
    );
    expect(byId.series.map((s) => s.key)).toEqual(["arr"]);
    expect(JSON.stringify(byId)).not.toContain(ids["secret_margin"] as string);
  });

  it("the audience is enforced by RLS, not only by the TypeScript filter", async () => {
    /*
     * The half that matters. `audienceAdmits` decides what a route returns;
     * `metrics.audience_admits_current` decides what a `SELECT` returns, and only the second
     * survives a future caller who writes their own query. A `groups` metric must be invisible
     * to a raw read under a non-member's external tenant context — definition *and* points.
     */
    const adaSees = await rowsAsExternal<{ key: string }>(
      ada.membershipId,
      `SELECT key::text AS key FROM metrics.definition ORDER BY key`,
    );
    expect(adaSees.map((r) => r.key)).toEqual([
      "arr",
      "cash",
      "headcount",
      "net_burn",
      "odd_metric",
      "runway",
    ]);

    const boardSees = await rowsAsExternal<{ key: string }>(
      board.membershipId,
      `SELECT key::text AS key FROM metrics.definition ORDER BY key`,
    );
    expect(boardSees.map((r) => r.key)).toContain("board_cash");
    expect(boardSees.map((r) => r.key)).not.toContain("secret_margin");

    // The definition's audience governs its points: there is no per-point gating.
    const adaPoints = await rowsAsExternal<{ key: string }>(
      ada.membershipId,
      `SELECT d.key::text AS key FROM metrics.point p
         JOIN metrics.definition d ON d.id = p.definition_id ORDER BY d.key`,
    );
    expect(adaPoints.map((r) => r.key)).toEqual(["arr"]);
    const boardPoints = await rowsAsExternal<{ key: string }>(
      board.membershipId,
      `SELECT d.key::text AS key FROM metrics.point p
         JOIN metrics.definition d ON d.id = p.definition_id ORDER BY d.key`,
    );
    expect(boardPoints.map((r) => r.key)).toEqual(["arr", "board_cash"]);

    // `metrics.point_current` carries `security_invoker`; without it the view would run as its
    // owner and every one of the rows above would come back to every reader.
    const throughView = await rowsAsExternal<{ n: number }>(
      ada.membershipId,
      `SELECT count(*)::int AS n FROM metrics.point_current`,
    );
    expect(throughView[0]?.n).toBe(1);

    // Provenance, import runs and the Sheets credential are staff-only outright.
    for (const table of ["metrics.source", "metrics.import", "metrics.sheet_connection"]) {
      const seen = await rowsAsExternal<{ n: number }>(
        board.membershipId,
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      expect(seen[0]?.n, table).toBe(0);
    }
  });

  it("an audience whose kind nobody recognises admits nobody, in SQL and in TypeScript", async () => {
    /*
     * The `ELSE false` arm of `metrics.audience_admits_current` and the same bias in
     * `parseAudience`. A row hand-edited in psql, or one written by a future release this one
     * reads, closes rather than opens: falling back to "everyone" because of a parse failure
     * is the single failure mode this module must not have.
     */
    await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      tx.execute(
        `UPDATE metrics.definition SET audience = '{"kind":"everyone_who_asks"}'::jsonb
           WHERE id = '${ids["odd_metric"]}'::uuid`,
      ),
    );

    for (const who of [ada, board]) {
      const seen = await rowsAsExternal<{ key: string }>(
        who.membershipId,
        `SELECT key::text AS key FROM metrics.definition WHERE id = '${ids["odd_metric"]}'::uuid`,
      );
      expect(seen).toEqual([]);
    }
    const series = await json<SeriesBody>(
      await request("acme", "/api/v1/metrics/series", { cookie: ada.cookie }),
    );
    expect(series.series.map((s) => s.key)).not.toContain("odd_metric");

    // The TypeScript half narrows to the same closed value rather than throwing or widening.
    const staffView = await json<{ audience: { kind: string } }>(
      await request("acme", `/api/v1/metrics/definitions/${ids["odd_metric"]}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(staffView.audience).toEqual({ kind: "staff_only" });
  });
});

describe("restatement", () => {
  const period = () => M[2] as { key: string; start: string };

  it("a restatement leaves the old row readable, superseded and out of the live view", async () => {
    const first = await saveGrid(owner.cookie, [
      { definitionId: ids["arr"] as string, periodKey: period().key, value: "1250" },
    ]);
    expect(await json<WriteResult>(first)).toMatchObject({ written: 1, restated: 0 });

    const restated = await saveGrid(owner.cookie, [
      { definitionId: ids["arr"] as string, periodKey: period().key, value: "1300" },
    ]);
    expect(await json<WriteResult>(restated)).toMatchObject({ written: 0, restated: 1 });

    /*
     * Provable from the database alone (E2.4 D3). Both rows are still on disk; the old one
     * names its replacement; the live view shows only the new one. This is the reason the
     * schema is append-only, and the reason `metrics.point` cannot simply REVOKE UPDATE the
     * way `audit.event` does — superseding *is* an update.
     */
    const all = await pointRowsOf(ids["arr"] as string, period().start);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ revision: 1, value: "1250.000000" });
    expect(all[1]).toMatchObject({ revision: 2, value: "1300.000000", supersededBy: null });
    expect(all[0]?.supersededBy).toBe(all[1]?.id);

    const live = await rows<{ revision: number }>(
      `SELECT revision FROM metrics.point_current
        WHERE definition_id = '${ids["arr"]}'::uuid
          AND period_start = '${period().start}'::timestamptz`,
    );
    expect(live).toEqual([{ revision: 2 }]);
  });

  it("the audit row carries both figures as decimal strings, never as JSON numbers", async () => {
    const audit = await rows<{ meta: Record<string, unknown>; resourceKind: string }>(
      `SELECT meta, resource_kind AS "resourceKind" FROM audit.event
        WHERE action = 'metrics.point_restated' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.resourceKind).toBe("metric_definition");
    // Strings, because a JSON number would round the very figure the row exists to prove.
    expect(audit[0]?.meta).toMatchObject({
      periodKey: period().key,
      fromRevision: 1,
      toRevision: 2,
      oldValue: "1250",
      newValue: "1300",
      sourceKind: "manual",
      needsReview: false,
    });
    expect(typeof (audit[0]?.meta as Record<string, unknown> | undefined)?.["oldValue"]).toBe(
      "string",
    );
  });

  it("the history route returns every revision of one cell, newest first, with its source", async () => {
    const body = await json<PointsBody>(
      await request(
        "acme",
        `/api/v1/metrics/definitions/${ids["arr"]}/points?periodKey=${period().key}`,
        { cookie: viewer.cookie },
      ),
    );
    expect(body.points.map((p) => p.revision)).toEqual([2, 1]);
    expect(body.points.map((p) => p.value)).toEqual(["1300", "1250"]);
    expect(body.points.map((p) => p.current)).toEqual([true, false]);
    expect(body.points.map((p) => p.sourceKind)).toEqual(["manual", "manual"]);
    // Each revision carries its own `createdAt`, which is what dates the correction.
    expect(Date.parse(body.points[0]?.createdAt as string)).toBeGreaterThanOrEqual(
      Date.parse(body.points[1]?.createdAt as string),
    );

    // Without `periodKey` the same route is the live series: one row per period, no history.
    const live = await json<PointsBody>(
      await request("acme", `/api/v1/metrics/definitions/${ids["arr"]}/points`, {
        cookie: viewer.cookie,
      }),
    );
    expect(live.points.every((p) => p.current)).toBe(true);
    expect(live.points.filter((p) => p.periodKey === period().key)).toHaveLength(1);
  });

  it("PUT /definitions/{id}/points applies the same rules to one metric at a time", async () => {
    // The per-metric route is the grid's rules with one definition pinned, and it is the one
    // an admin screen uses to fix a single figure. Writing it twice the same way, and once
    // with a null, must leave exactly two revisions on disk.
    const id = ids["board_cash"] as string;
    const put = (value: string | null) =>
      request("acme", `/api/v1/metrics/definitions/${id}/points`, {
        method: "PUT",
        cookie: owner.cookie,
        body: JSON.stringify({ points: [{ periodKey: M[4]?.key, value }] }),
      });
    expect(await json<WriteResult>(await put("500000"))).toMatchObject({
      written: 1,
      unchanged: 0,
      restated: 0,
      skipped: 0,
    });
    expect(await json<WriteResult>(await put("500000.000"))).toMatchObject({
      written: 0,
      unchanged: 1,
      restated: 0,
    });
    expect(await json<WriteResult>(await put(null))).toMatchObject({ skipped: 1, written: 0 });
    expect(await json<WriteResult>(await put("512000"))).toMatchObject({ restated: 1 });
    expect((await pointRowsOf(id, M[4]?.start as string)).map((r) => r.revision)).toEqual([1, 2]);

    // A `custom`-period metric's points carry explicit bounds, so the route refuses a calendar
    // key rather than guessing which arbitrary range `2026-04` was supposed to mean.
    const custom = await define({
      key: "custom_metric",
      name: "Pilot cohort",
      unit: "count",
      periodKind: "custom",
    });
    const refused = await request("acme", `/api/v1/metrics/definitions/${custom}/points`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ points: [{ periodKey: "2026-04", value: "1" }] }),
    });
    expect(refused.status).toBe(400);
    expect((await json<{ error: { periodKind: string } }>(refused)).error.periodKind).toBe(
      "custom",
    );
  });

  it("the append-only trigger refuses a delete and any update but the supersede", async () => {
    /*
     * Immutability is a trigger, not a convention. `audit.event` can simply REVOKE UPDATE;
     * this table cannot, because superseding *is* an update — so the rule has to be "only
     * `superseded_by`, only once, only from NULL", and each refusal names the model rather
     * than saying "permission denied".
     *
     * Drizzle wraps the driver error, so the Postgres message is the innermost one
     * (`pgErrorMessage`); asserting on the wrapper would pass on any failure at all.
     */
    const [first, current] = await pointRowsOf(ids["arr"] as string, period().start);
    const id = first?.id as string;
    const liveId = current?.id as string;
    const refuses = async (statement: string): Promise<string> => {
      try {
        await running.container.db.withTenant(systemContext(acmeId), (tx) => tx.execute(statement));
      } catch (error) {
        expect(pgErrorCode(error)).toBe("23001");
        return pgErrorMessage(error);
      }
      throw new Error(`metrics.point accepted: ${statement}`);
    };
    expect(await refuses(`DELETE FROM metrics.point WHERE id = '${id}'::uuid`)).toMatch(
      /append-only/u,
    );
    expect(await refuses(`UPDATE metrics.point SET value = 9 WHERE id = '${id}'::uuid`)).toMatch(
      /immutable/u,
    );
    // Un-superseding would erase the evidence that the number ever changed. Both ways in are
    // closed: re-pointing a row that is already superseded, and clearing the live row's link.
    expect(
      await refuses(`UPDATE metrics.point SET superseded_by = NULL WHERE id = '${id}'::uuid`),
    ).toMatch(/already superseded/u);
    expect(
      await refuses(`UPDATE metrics.point SET superseded_by = NULL WHERE id = '${liveId}'::uuid`),
    ).toMatch(/un-superseded/u);

    /*
     * Migration 0002, and the only coverage it gets. 0001's trigger enforced "only
     * `superseded_by`, once, from NULL" while its own exception text promised something
     * stronger — "supersede the newest revision instead" — and the column did not carry it:
     * `superseded_by` was a bare foreign key, so a row could be superseded by a point of a
     * different definition, or by a *lower* revision of its own cell. Two rows pointing at
     * each other then made the period vanish from `metrics.point_current` altogether, because
     * that view is `WHERE superseded_by IS NULL`. A restatement register that can lose a
     * published figure is not a register.
     */
    const elsewhere = (await pointRowsOf(ids["board_cash"] as string, M[1]?.start as string))[0]
      ?.id as string;
    expect(elsewhere).toBeDefined();
    expect(
      await refuses(
        `UPDATE metrics.point SET superseded_by = '${elsewhere}'::uuid WHERE id = '${liveId}'::uuid`,
      ),
    ).toMatch(/higher revision of the same/u);
    // A lower revision of the *same* cell is refused too, which is what makes a cycle
    // unrepresentable rather than merely unlikely: A cannot outrank B while B outranks A.
    expect(
      await refuses(
        `UPDATE metrics.point SET superseded_by = '${id}'::uuid WHERE id = '${liveId}'::uuid`,
      ),
    ).toMatch(/higher revision of the same/u);
    // Nothing moved: the live revision is still the live revision.
    const after = await pointRowsOf(ids["arr"] as string, period().start);
    expect(after.map((r) => r.supersededBy)).toEqual([after[1]?.id, null]);
  });
});

describe("the grid's three save rules", () => {
  it("an empty cell writes no point, and certainly not a zero", async () => {
    const before = await totalPoints();
    const res = await saveGrid(owner.cookie, [
      { definitionId: ids["arr"] as string, periodKey: M[3]?.key as string, value: null },
    ]);
    expect(await json<WriteResult>(res)).toMatchObject({
      written: 0,
      restated: 0,
      unchanged: 0,
      skipped: 1,
    });
    expect(await totalPoints()).toBe(before);
    const cells = await pointRowsOf(ids["arr"] as string, M[3]?.start as string);
    expect(cells).toEqual([]);
  });

  it("an unchanged cell writes nothing at all: 1250 and 1250.00 are the same number", async () => {
    /*
     * The no-op rule (§9) is load-bearing: an admin who presses save twice has restated
     * nothing, and an investor must not be told a number changed when it did not. Equality is
     * on the fixed-point value, so a differently-spelled identical figure is still equal — and
     * it is on the value *alone*, so a typo fixed in a note does not restate a published
     * figure (contract §12 C-B.4).
     */
    const pointsBefore = await totalPoints();
    const restatementsBefore = await auditCount("metrics.point_restated");
    const savesBefore = await auditCount("metrics.points_saved");
    const outboxBefore = await outboxCount("metric.points_changed");

    const res = await saveGrid(owner.cookie, [
      // The live value is `1300`; both spellings parse to the same fixed-point number. The
      // note beside it is new, and must not be enough to restate a published figure.
      {
        definitionId: ids["arr"] as string,
        periodKey: M[2]?.key as string,
        value: "1300.00",
        note: "typo fixed in the commentary",
      },
      { definitionId: ids["arr"] as string, periodKey: M[1]?.key as string, value: "1000000" },
    ]);
    expect(await json<WriteResult>(res)).toMatchObject({
      written: 0,
      restated: 0,
      unchanged: 2,
      skipped: 0,
      definitionIds: [],
    });

    expect(await totalPoints()).toBe(pointsBefore);
    expect(await auditCount("metrics.point_restated")).toBe(restatementsBefore);
    // Not even the per-save summary row, and no outbox event: a no-op save must not wake the
    // derived-metric recompute for every workspace that leaves a grid screen open.
    expect(await auditCount("metrics.points_saved")).toBe(savesBefore);
    expect(await outboxCount("metric.points_changed")).toBe(outboxBefore);
  });

  it("an unchanged cell writes nothing when the figure is rounded to fit `decimals` either", async () => {
    /*
     * The test above feeds values that are already exact at the metric's `decimals`, so both
     * sides of the comparison are the same bigint whatever the code does — it **cannot** catch
     * this class and the two are not redundant. Delete neither.
     *
     * `arr` is `decimals: 0`. The comparison used to ask "is the cell equal to the stored row"
     * at the full 1e6 scale while storing `formatFixed(value, decimals)` with the rest thrown
     * away, so `1250.4` could never equal the `1250` it had just written: every save of an
     * unedited grid wrote a revision, each with an audit row reading `old:'1250' new:'1250'`.
     * An investor watching a KPI page would see a figure "restated" weekly to the same number.
     */
    const first = await saveGrid(owner.cookie, [cell(ids["arr"] as string, M[9], "1250.4")]);
    expect(await json<WriteResult>(first)).toMatchObject({ written: 1, restated: 0 });

    const pointsBefore = await totalPoints();
    const restatementsBefore = await auditCount("metrics.point_restated");
    const outboxBefore = await outboxCount("metric.points_changed");

    const again = await saveGrid(owner.cookie, [cell(ids["arr"] as string, M[9], "1250.4")]);
    expect(await json<WriteResult>(again)).toMatchObject({
      written: 0,
      restated: 0,
      unchanged: 1,
      definitionIds: [],
    });
    expect(await totalPoints()).toBe(pointsBefore);
    expect(await auditCount("metrics.point_restated")).toBe(restatementsBefore);
    expect(await outboxCount("metric.points_changed")).toBe(outboxBefore);

    const revisions = await pointRowsOf(ids["arr"] as string, M[9]?.start as string);
    expect(revisions.map((r) => r.revision)).toEqual([1]);
    // Stored at the precision the metric declares, which is the precision the comparison asks
    // at — the store and the equality test are one decision now.
    expect(revisions[0]?.value).toBe("1250.000000");
  });

  it("a value too large for numeric(20,6) is a 400 naming the cell, not a 500 from Postgres", async () => {
    /*
     * `22003` is not a `MetricsError`, so it went past `rethrow` and reached the caller as an
     * `internal_error` on a number they had just typed. Both doors are closed: rounding to
     * `decimals` is what carries a value over the edge (`99999999999999.6` at `decimals: 0`
     * is 10^14), and a seventh fraction place can carry it there too.
     */
    const overflow = await saveGrid(owner.cookie, [
      cell(ids["arr"] as string, M[7], "99999999999999.6"),
    ]);
    expect(overflow.status).toBe(400);
    const body = await json<{ error: { code: string; periodKey: string; field: string } }>(
      overflow,
    );
    expect(body.error).toMatchObject({
      code: "validation_failed",
      periodKey: M[7]?.key,
      field: "value",
    });

    const rounded = await saveGrid(owner.cookie, [
      cell(ids["arr"] as string, M[7], "99999999999999.9999996"),
    ]);
    expect(rounded.status).toBe(400);
    expect((await json<{ error: { code: string } }>(rounded)).error.code).toBe("validation_failed");

    // Refused whole: a batch that cannot be represented writes none of itself.
    expect(await pointRowsOf(ids["arr"] as string, M[7]?.start as string)).toEqual([]);
  });

  it("naming one cell twice is refused, not collapsed and not a 500", async () => {
    /*
     * Both copies computed the same `revision` off one read of the live points, so the second
     * insert raised `point_revision_unique` (`23505`) — a 500 on a body a client can send by
     * accident. Last-one-wins would be worse than a refusal: two different numbers for one
     * cell is a request that cannot mean one thing, and committing one of them silently
     * publishes a figure nobody chose.
     */
    const res = await saveGrid(owner.cookie, [
      cell(ids["arr"] as string, M[6], "10"),
      cell(ids["arr"] as string, M[6], "20"),
    ]);
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; key: string; periodKey: string } }>(res);
    expect(body.error).toMatchObject({
      code: "validation_failed",
      key: "arr",
      periodKey: M[6]?.key,
    });
    expect(await pointRowsOf(ids["arr"] as string, M[6]?.start as string)).toEqual([]);
  });

  it("refuses a hand-typed value for a derived metric rather than overwriting it overnight", async () => {
    const res = await saveGrid(owner.cookie, [
      { definitionId: ids["runway"] as string, periodKey: M[2]?.key as string, value: "9" },
    ]);
    expect(res.status).toBe(400);
    const body = await json<{ error: { derived: boolean; key: string } }>(res);
    expect(body.error).toMatchObject({ derived: true, key: "runway" });
  });

  it("refuses an unreadable figure instead of silently dropping the cell", async () => {
    const res = await saveGrid(owner.cookie, [
      { definitionId: ids["arr"] as string, periodKey: M[4]?.key as string, value: "about 12" },
    ]);
    expect(res.status).toBe(400);
  });
});

describe("the deferred exclusion constraint", () => {
  it("lets one transaction hold two live points for a period, and refuses to commit it", async () => {
    /*
     * Contract §12 C2. `point_one_live_per_period` is DEFERRABLE INITIALLY DEFERRED because an
     * immediate version makes a restatement literally unwritable: superseding is two
     * statements, and between them both rows are live and claim the same period. The invariant
     * the product needs is "no workspace ever *has* two live points for one period", not "no
     * transaction ever passes through a state where it would" — so the check belongs at
     * COMMIT, and this test pins both halves of that: the mid-transaction state is legal, the
     * committed state is not.
     */
    const scratch = await define({ key: "scratch", name: "Scratch", unit: "count" });
    const { start } = M[9] as { key: string; start: string };
    const end = new Date(Date.parse(start));
    end.setUTCMonth(end.getUTCMonth() + 1);

    const insert = (revision: number) =>
      `INSERT INTO metrics.point (workspace_id, definition_id, period, value, revision)
         VALUES ('${acmeId}'::uuid, '${scratch}'::uuid,
                 tstzrange('${start}'::timestamptz, '${end.toISOString()}'::timestamptz, '[)'),
                 1, ${revision})`;

    let liveMidTransaction = -1;
    const attempt = running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      await tx.execute(insert(1));
      await tx.execute(insert(2));
      const seen = await tx.execute(
        `SELECT count(*)::int AS n FROM metrics.point_current
           WHERE definition_id = '${scratch}'::uuid`,
      );
      liveMidTransaction = (seen.rows as { n: number }[])[0]?.n ?? -1;
    });
    await expect(attempt).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === "23P01");
    expect(liveMidTransaction).toBe(2);

    // The whole transaction rolled back, so the invariant still holds on disk.
    expect(await pointRowsOf(scratch, start)).toEqual([]);
  });

  it("a restatement through the API commits the insert and the supersede together", async () => {
    // The same window the constraint tolerates, driven through the route that needs it. If
    // `GridService.save` ever split its work across two transactions, the insert would fail.
    const scratchId = ids["scratch"] as string;
    expect((await saveGrid(owner.cookie, [cell(scratchId, M[8], "5")])).status).toBe(200);
    expect((await saveGrid(owner.cookie, [cell(scratchId, M[8], "6")])).status).toBe(200);
    const all = await pointRowsOf(scratchId, M[8]?.start as string);
    expect(all.map((r) => r.revision)).toEqual([1, 2]);
    expect(all[0]?.supersededBy).toBe(all[1]?.id);
  });
});

describe("derived metrics through the outbox", () => {
  const runwayAt = async (periodKey: string): Promise<string | null | undefined> => {
    const body = await json<SeriesBody>(
      await request("acme", `/api/v1/metrics/series?ids=${ids["runway"]}&periods=24`, {
        cookie: viewer.cookie,
      }),
    );
    const at = body.periods.findIndex((p) => p.key === periodKey);
    return at < 0 ? undefined : body.series[0]?.values[at];
  };

  it("recomputes runway from cash and net_burn after the points-changed event", async () => {
    const res = await saveGrid(owner.cookie, [
      cell(ids["cash"] as string, M[5], "1200000"),
      cell(ids["net_burn"] as string, M[5], "100000"),
    ]);
    expect(await json<WriteResult>(res)).toMatchObject({ written: 2 });

    const value = await waitFor(async () => (await runwayAt(M[5]?.key as string)) ?? undefined);
    expect(value).toBe("12.0");

    // The recompute is the system's own write, not the admin's: its provenance says `derived`
    // and names the inputs it read.
    const source = await rows<{ kind: string; ref: { inputs: string[] } }>(
      `SELECT s.kind, s.ref FROM metrics.point p JOIN metrics.source s ON s.id = p.source_id
        WHERE p.definition_id = '${ids["runway"]}'::uuid LIMIT 1`,
    );
    expect(source[0]?.kind).toBe("derived");
    expect(source[0]?.ref.inputs).toEqual(
      expect.arrayContaining([ids["cash"] as string, ids["net_burn"] as string]),
    );
  });

  it("a burn of zero yields no point — not zero, and not infinity", async () => {
    /*
     * §6, and the reason `div` answers `undefined` rather than throwing: a company that spent
     * nothing this month has not run out of runway, and a zero there would be a lie in the
     * alarming direction. A derived period with no point is a gap in the chart, which is what
     * actually happened.
     *
     * The save carries a **sentinel** period alongside the zero-burn one. One recompute pass
     * decides every period in its window, so waiting for the sentinel's point to appear is
     * what turns "no point yet" into "no point, decided" — an absence nobody waited for
     * proves nothing at all.
     */
    const res = await saveGrid(owner.cookie, [
      cell(ids["cash"] as string, M[6], "900000"),
      cell(ids["net_burn"] as string, M[6], "0"),
      cell(ids["cash"] as string, M[3], "600000"),
      cell(ids["net_burn"] as string, M[3], "50000"),
    ]);
    expect(await json<WriteResult>(res)).toMatchObject({ written: 4 });

    const sentinel = await waitFor(async () => (await runwayAt(M[3]?.key as string)) ?? undefined);
    expect(sentinel).toBe("12.0");
    expect(await runwayAt(M[6]?.key as string)).toBeNull();
    expect(await pointRowsOf(ids["runway"] as string, M[6]?.start as string)).toEqual([]);
  });

  it("a missing input yields no point either", async () => {
    const res = await saveGrid(owner.cookie, [
      cell(ids["cash"] as string, M[7], "800000"),
      // The sentinel again: moving the burn the derived metric already has re-runs the pass.
      cell(ids["net_burn"] as string, M[3], "100000"),
    ]);
    expect(await json<WriteResult>(res)).toMatchObject({ written: 1, restated: 1 });

    const sentinel = await waitFor(async () =>
      (await runwayAt(M[3]?.key as string)) === "6.0" ? "6.0" : undefined,
    );
    expect(sentinel).toBe("6.0");
    expect(await runwayAt(M[7]?.key as string)).toBeNull();
    expect(await pointRowsOf(ids["runway"] as string, M[7]?.start as string)).toEqual([]);
  });

  it("a derived metric that rounds to a shorter `decimals` settles, instead of restating for ever", async () => {
    /*
     * The unattended half of the quantisation defect, and the reason it was the worst of the
     * eight. `tiny_ratio = tiny_a / tiny_b` at `decimals: 0` over `1 / 3` evaluates to
     * `0.333333` and stores `0`; the comparison used to ask at the full 1e6 scale, so the
     * recompute found `0 !== 0.333333` **every time** and restated the point — on every grid
     * save, every CSV import and every nightly sheets sync, for ever, with an audit row and an
     * outbox event each time and nobody to notice. So this asserts a revision that stays put
     * across several later passes, not merely one correct value.
     */
    await define({ key: "tiny_a", name: "Tiny A", unit: "count", audience: A_ALL });
    await define({ key: "tiny_b", name: "Tiny B", unit: "count", audience: A_ALL });
    const ratio = await define({
      key: "tiny_ratio",
      name: "Tiny ratio",
      unit: "ratio",
      audience: A_ALL,
      formula: {
        op: "div",
        args: [
          { op: "ref", key: "tiny_a" },
          { op: "ref", key: "tiny_b" },
        ],
      },
    });
    const ratioAt = async (period: { key: string; start: string }) =>
      (await pointRowsOf(ratio, period.start))[0];

    expect(
      (
        await saveGrid(owner.cookie, [
          cell(ids["tiny_a"] as string, M[9], "1"),
          cell(ids["tiny_b"] as string, M[9], "3"),
        ])
      ).status,
    ).toBe(200);
    const settled = await waitFor(
      async () => await ratioAt(M[9] as { key: string; start: string }),
    );
    expect(settled).toMatchObject({ revision: 1, value: "0.000000" });

    // Two further passes over the same derived metric, each driven by a real save of one of its
    // inputs at a *different* period — which is what a recompute is, and what used to restate.
    for (const [period, a, b, expected] of [
      [M[8], "10", "5", "2.000000"],
      [M[7], "4", "2", "2.000000"],
    ] as const) {
      expect(
        (
          await saveGrid(owner.cookie, [
            cell(ids["tiny_a"] as string, period, a),
            cell(ids["tiny_b"] as string, period, b),
          ])
        ).status,
      ).toBe(200);
      const written = await waitFor(
        async () => await ratioAt(period as { key: string; start: string }),
      );
      expect(written).toMatchObject({ revision: 1, value: expected });
      // The point from the first pass has not moved.
      expect(await ratioAt(M[9] as { key: string; start: string })).toMatchObject({ revision: 1 });
    }
  });

  it("a derived period that overflows numeric(20,6) is a gap, and the rest still recomputes", async () => {
    /*
     * `a + b` with both inputs at 99 999 999 999 999 overflows with no large input at all, and
     * the insert's `22003` aborted the whole recompute transaction — on every retry, for every
     * other derived metric in the workspace. One period that cannot be represented is skipped
     * exactly the way a division by zero is, and its neighbours are still written.
     */
    await define({ key: "big_a", name: "Big A", unit: "count", audience: A_ALL });
    await define({ key: "big_b", name: "Big B", unit: "count", audience: A_ALL });
    const total = await define({
      key: "total_big",
      name: "Total",
      unit: "count",
      audience: A_ALL,
      formula: {
        op: "add",
        args: [
          { op: "ref", key: "big_a" },
          { op: "ref", key: "big_b" },
        ],
      },
    });
    const huge = "99999999999999";

    expect(
      (
        await saveGrid(owner.cookie, [
          cell(ids["big_a"] as string, M[6], huge),
          cell(ids["big_b"] as string, M[6], huge),
          cell(ids["big_a"] as string, M[5], "1"),
          cell(ids["big_b"] as string, M[5], "2"),
        ])
      ).status,
    ).toBe(200);

    // The representable period is the sentinel: once it exists the pass has run, so the other
    // period's emptiness is decided rather than merely not-yet.
    const ok = await waitFor(async () => (await pointRowsOf(total, M[5]?.start as string))[0]);
    expect(ok).toMatchObject({ revision: 1, value: "3.000000" });
    expect(await pointRowsOf(total, M[6]?.start as string)).toEqual([]);
  });

  it("restating an input restates the metric derived from it", async () => {
    const before = await auditCount("metrics.point_restated");
    expect(
      (await saveGrid(owner.cookie, [cell(ids["net_burn"] as string, M[5], "200000")])).status,
    ).toBe(200);
    const value = await waitFor(async () =>
      (await runwayAt(M[5]?.key as string)) === "6.0" ? "6.0" : undefined,
    );
    expect(value).toBe("6.0");
    const revisions = await pointRowsOf(ids["runway"] as string, M[5]?.start as string);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[0]?.supersededBy).toBe(revisions[1]?.id);
    // Two restatements: the input the admin typed, and the derived metric the system rewrote.
    expect(await auditCount("metrics.point_restated")).toBe(before + 2);
  });
});

describe("CSV import", () => {
  const mapping = {
    periodColumn: "period",
    periodKind: "month",
    columns: [
      { column: "headcount", key: "headcount" },
      { column: "arr", key: "arr" },
    ],
  };
  const csv = () =>
    [
      "period,headcount,arr",
      `${M[10]?.key},12,100000`,
      `${M[11]?.key},not a number,110000`,
      ",5,5",
      "2026-13,1,1",
      `${M[10]?.key},9,9`,
    ].join("\n");

  it("a dry run reports every row with a machine-readable reason and writes nothing", async () => {
    const before = await totalPoints();
    const res = await request("acme", "/api/v1/metrics/import/dry-run", {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ csv: csv(), mapping }),
    });
    expect(res.status).toBe(200);
    const body = await json<DryRunBody>(res);
    expect(body.columns).toEqual(["period", "headcount", "arr"]);
    expect(body.rows.map((r) => [r.line, r.status, r.reason ?? null])).toEqual([
      [2, "ok", null],
      [3, "ok", null],
      [4, "error", "missing_period"],
      [5, "error", "unreadable_period"],
      [6, "skipped", "duplicate_period"],
    ]);
    // A row with one good number and one bad one still imports the good one; the bad cell
    // carries its own reason so the admin can see which column to fix.
    expect(body.rows[1]?.cells.map((c) => [c.key, c.status, c.reason ?? null])).toEqual([
      ["headcount", "error", "not_a_number"],
      ["arr", "ok", null],
    ]);
    expect(body.summary).toEqual({ ok: 2, skipped: 1, error: 2, values: 3 });
    // A preview is a preview: nothing reached the table.
    expect(await totalPoints()).toBe(before);
  });

  it("the job applies only the good rows and the import reaches done", async () => {
    const started = await request("acme", "/api/v1/metrics/import", {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ csv: csv(), mapping, note: "September close" }),
    });
    expect(started.status).toBe(200);
    const queued = await json<ImportBody>(started);
    expect(queued.total).toBe(5);

    const done = await waitFor(async () => {
      const body = await json<ImportBody>(
        await request("acme", `/api/v1/metrics/import/${queued.id}`, { cookie: viewer.cookie }),
      );
      return body.status === "done" ? body : undefined;
    });
    expect(done).toMatchObject({ applied: 2, failed: 0, skipped: 3 });

    const grid = await json<GridBody>(
      await request("acme", "/api/v1/metrics/grid?periods=24", { cookie: viewer.cookie }),
    );
    const at = (definitionId: string, periodKey: string) =>
      grid.cells.find((c) => c.definitionId === definitionId && c.periodKey === periodKey);
    expect(at(ids["headcount"] as string, M[10]?.key as string)).toMatchObject({
      value: "12",
      sourceKind: "csv",
      revision: 1,
    });
    expect(at(ids["arr"] as string, M[11]?.key as string)).toMatchObject({
      value: "110000",
      sourceKind: "csv",
    });
    // The `not a number` cell was refused, not coerced: the month simply has no headcount.
    expect(at(ids["headcount"] as string, M[11]?.key as string)).toBeUndefined();

    // Provenance is one source row per *line* (contract §12 C-B.10), carrying the file digest
    // so a point can say which column of which file, on which line, it came from.
    const source = await rows<{ ref: Record<string, unknown> }>(
      `SELECT s.ref FROM metrics.point p JOIN metrics.source s ON s.id = p.source_id
        WHERE p.definition_id = '${ids["headcount"]}'::uuid
          AND p.period_start = '${M[10]?.start}'::timestamptz`,
    );
    expect(source[0]?.ref).toMatchObject({ importId: queued.id, line: 2 });
    expect(String(source[0]?.ref["fileSha256"])).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("re-importing the same file writes no new revision", async () => {
    /*
     * Two layers hold this up and they answer different questions. Within one run, each line
     * is claimed by `metrics.import:<importId>:<line>` in the transaction that writes its
     * points, so a redelivered job resumes rather than doubling a restatement. Across runs,
     * the claim key is new — and the *value* rule catches it: an equal figure writes nothing.
     */
    const pointsBefore = await totalPoints();
    const restatementsBefore = await auditCount("metrics.point_restated");
    const again = await json<ImportBody>(
      await request("acme", "/api/v1/metrics/import", {
        method: "POST",
        cookie: financeUser.cookie,
        body: JSON.stringify({ csv: csv(), mapping }),
      }),
    );
    const done = await waitFor(async () => {
      const body = await json<ImportBody>(
        await request("acme", `/api/v1/metrics/import/${again.id}`, { cookie: viewer.cookie }),
      );
      return body.status === "done" ? body : undefined;
    });
    expect(done.applied).toBe(2);
    expect(await totalPoints()).toBe(pointsBefore);
    expect(await auditCount("metrics.point_restated")).toBe(restatementsBefore);
    const revisions = await pointRowsOf(ids["headcount"] as string, M[10]?.start as string);
    expect(revisions.map((r) => r.revision)).toEqual([1]);
  });

  it("enforces its own row cap and says what the number is", async () => {
    /*
     * `@fundroom/csv` has no cap (contract §12 C5): the invite importer's stayed in identity
     * rather than becoming a second, differently-shaped ceiling on a pure parser. So metrics
     * carries its own, and the refusal names it — "the file was too big" without a number is
     * not actionable.
     */
    const lines = ["period,headcount"];
    for (let i = 0; i <= METRICS_IMPORT_MAX_ROWS; i++) {
      const year = 1000 + Math.floor(i / 12);
      lines.push(`${year}-${String((i % 12) + 1).padStart(2, "0")},1`);
    }
    const body = await json<DryRunBody>(
      await request("acme", "/api/v1/metrics/import/dry-run", {
        method: "POST",
        cookie: financeUser.cookie,
        body: JSON.stringify({
          csv: lines.join("\n"),
          mapping: { periodColumn: "period", periodKind: "month", columns: [mapping.columns[0]] },
        }),
      }),
    );
    expect(body.rows).toHaveLength(METRICS_IMPORT_MAX_ROWS + 1);
    const last = body.rows.at(-1);
    expect(last).toMatchObject({
      status: "error",
      reason: `too_many_rows:${METRICS_IMPORT_MAX_ROWS}`,
    });
    // Reported once, at the row that crossed it, with nothing past it read.
    expect(body.rows.filter((r) => r.reason?.startsWith("too_many_rows"))).toHaveLength(1);
  });

  it("refuses a file whose mapping names no usable column rather than queueing an empty job", async () => {
    const res = await request("acme", "/api/v1/metrics/import", {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({
        csv: "month,people\n2026-01,4",
        mapping: {
          periodColumn: "month",
          periodKind: "month",
          columns: [{ column: "nowhere", key: "headcount" }],
        },
      }),
    });
    // A job that finishes having written nothing looks like success on the progress screen.
    expect(res.status).toBe(400);
  });
});

describe("the chart image", () => {
  let token = "";
  let keyId = "";

  const chart = (t: string, headers: Record<string, string> = {}) =>
    request("acme", `/api/v1/metrics/chart/${t}.png`, { headers });

  const mint = async (overrides: Partial<ChartTokenPayload> = {}, key?: Uint8Array) => {
    const ctx = systemContext(acmeId);
    const dek = await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.currentKey(tx, ctx, CHART_TOKEN_PURPOSE),
    );
    keyId = dek.keyId;
    const payload: ChartTokenPayload = {
      v: 1,
      w: acmeId,
      kid: dek.keyId,
      d: [ids["cash"] as string],
      k: "month",
      n: 12,
      asOf: new Date().toISOString(),
      exp: new Date(Date.now() + 180 * 86_400_000).toISOString(),
      ...overrides,
    };
    return signChartToken(key ?? dek.key, payload);
  };

  it("renders a PNG for a capability token, with the documented cache headers", async () => {
    token = await mint();
    const res = await chart(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Immutable by construction: the token pins the metrics, the periods and `asOf`, so the
    // bytes for one URL can never change.
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/u);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    // No session, no cookie, and no audience check: `d` was filtered at send time, so the
    // capability *is* the filter (decision D5). `cash` is a metric the route never asked an
    // audience about, and it rendered.
    expect(ids["cash"]).toBeDefined();
  });

  it("writes no event and no audit row: an image that names a reader is a tracking pixel", async () => {
    // Decision D5 and plan §15 E1.4. The token names a *set of metrics*, so everyone in a send
    // who sees the same metrics shares one URL — and the route must not turn that URL into an
    // open signal by recording the fetch.
    const auditBefore = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM audit.event`))[0]
      ?.n;
    const outboxBefore = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(`SELECT count(*)::int AS n FROM core.outbox`);
      return (r.rows as { n: number }[])[0]?.n;
    });
    expect((await chart(token)).status).toBe(200);
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM audit.event`))[0]?.n).toBe(
      auditBefore,
    );
    expect(
      await running.container.db.withHost(async (tx) => {
        const r = await tx.execute(`SELECT count(*)::int AS n FROM core.outbox`);
        return (r.rows as { n: number }[])[0]?.n;
      }),
    ).toBe(outboxBefore);
  });

  it("answers 304 from the token alone, before anything is rendered", async () => {
    const etag = (await chart(token)).headers.get("etag") as string;
    const res = await chart(token, { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });

  it("answers every refusal with one indistinguishable 404", async () => {
    /*
     * E2.2 shipped exactly this bug on the handoff route — `unknown_key` told a caller their
     * key id was wrong while `bad_signature` told them it was right — and had to collapse the
     * two. The route is public, so a distinguishable failure is an oracle; this pins that the
     * collapse stays collapsed, including the `kid` oracle the payload's key id could reopen.
     */
    const good = await mint();
    const paths = [
      `/api/v1/metrics/chart/${good}.jpg`,
      "/api/v1/metrics/chart/not-a-token.png",
      `/api/v1/metrics/chart/${await mint({ kid: randomUUID() })}.png`,
      `/api/v1/metrics/chart/${await mint({}, new Uint8Array(32).fill(3))}.png`,
      `/api/v1/metrics/chart/${await mint({ exp: new Date(Date.now() - 1000).toISOString() })}.png`,
      `/api/v1/metrics/chart/${await mint({ w: globexId })}.png`,
    ];
    const responses = await Promise.all(paths.map((p) => request("acme", p)));
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    const bodies = await Promise.all(
      responses.map(async (r) => {
        const body = (await r.json()) as { error: Record<string, unknown> };
        // `requestId` is per request by design and is not a metrics fact; everything else that
        // reaches the caller must be identical.
        delete body.error["requestId"];
        return JSON.stringify(body);
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ error: { code: "not_found" } });
    expect(new Set(responses.map((r) => r.headers.get("content-type"))).size).toBe(1);
  });

  it("verifies before it answers 304, so an expired token stops revalidating", async () => {
    /*
     * The ETag is a hash of the token, so a `If-None-Match` matched before anything was
     * verified: an expired token, a forgery, a token for another workspace and the literal
     * string `zzz` all revalidated successfully for ever. With `Cache-Control: public` that is
     * an image proxy re-serving a chart past its 180-day `exp` indefinitely, while §9.1 says an
     * email read a year later gets a 404. Nothing is rasterised on a cache hit either way —
     * verification is an HMAC and one key read, and the render is what the 304 skips.
     */
    const shortLived = await mint({ exp: new Date(Date.now() + 2_000).toISOString() });
    const fresh = await chart(shortLived);
    expect(fresh.status).toBe(200);
    const etag = fresh.headers.get("etag") as string;
    expect((await chart(shortLived, { "if-none-match": etag })).status).toBe(304);

    await new Promise((r) => setTimeout(r, 2_200));
    const stale = await chart(shortLived, { "if-none-match": etag });
    expect(stale.status).toBe(404);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe("not_found");

    // The ETag is derivable from the token, so an attacker holding a forgery can present its
    // matching validator. It must not buy them a 304 either.
    const forged = await mint({}, new Uint8Array(32).fill(5));
    const forgedEtag = `"${createHash("sha256").update(forged).digest("hex").slice(0, 32)}"`;
    const refused = await chart(forged, { "if-none-match": forgedEtag });
    expect(refused.status).toBe(404);
  });

  it("a token minted under a key the workspace has since rotated away from still renders", async () => {
    /*
     * The whole premise of the token is that it survives in an inbox for 180 days, and
     * `crypto.rotate` is routine. Verifying against whatever key happened to be current would
     * make a rotation silently 404 every chart image in every update ever sent — with a
     * well-formed token and a 404 that says nothing (contract §12 C-B.2 RESOLVED).
     */
    const ctx = systemContext(acmeId);
    const rotated = await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.rotate(tx, ctx, CHART_TOKEN_PURPOSE),
    );
    expect(rotated.keyId).not.toBe(keyId);
    const res = await chart(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("closing an audience does not revoke a chart already sent; deleting the metric does", async () => {
    /*
     * **Accepted behaviour, recorded so nobody "fixes" it** (§13, finding 13). The route
     * performs no audience check by design: `d` was filtered once at send time and the
     * capability *is* the filter (decision D5), so narrowing a metric's audience afterwards
     * leaves every image already delivered rendering. That is a real consequence an admin
     * should be told about where they change an audience, and it is not a bug to be closed
     * here — the check would need a reader, and a URL that identifies one reader is the
     * tracking pixel this product does not ship.
     *
     * The recourse that does work is the one that also takes the number out of the product:
     * soft-deleting the definition drops it from the read, so the token names nothing
     * renderable and the route refuses it like every other failure.
     */
    const sunset = await define({
      key: "sunset_metric",
      name: "Sunset",
      unit: "currency",
      currency: "USD",
      audience: A_ALL,
    });
    expect((await saveGrid(owner.cookie, [cell(sunset, M[1], "4200")])).status).toBe(200);
    const sent = await mint({ d: [sunset] });
    expect((await chart(sent)).status).toBe(200);

    const closed = await request("acme", `/api/v1/metrics/definitions/${sunset}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ audience: { kind: "staff_only" } }),
    });
    expect(closed.status).toBe(200);
    expect((await json<{ audience: { kind: string } }>(closed)).audience.kind).toBe("staff_only");
    // Still 200. An investor who already has the mail still sees the picture.
    expect((await chart(sent)).status).toBe(200);

    await markFresh(owner);
    expect(
      (
        await request("acme", `/api/v1/metrics/definitions/${sunset}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
    expect((await chart(sent)).status).toBe(404);
  });

  it("a key minted for another purpose comes back as no such key, not as a mismatch", async () => {
    const ctx = systemContext(acmeId);
    const unsubscribe = await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.currentKey(tx, ctx, "updates-unsubscribe"),
    );
    const forged = signChartToken(unsubscribe.key, {
      v: 1,
      w: acmeId,
      kid: unsubscribe.keyId,
      d: [ids["cash"] as string],
      k: "month",
      n: 12,
      asOf: new Date().toISOString(),
      exp: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await chart(forged)).status).toBe(404);
  });
});

describe("Google Sheets", () => {
  const mapping = {
    periodColumn: "period",
    periodKind: "month" as const,
    columns: [{ column: "headcount", key: "headcount" }],
  };
  const serviceAccountJson = () =>
    JSON.stringify({
      type: "service_account",
      project_id: "acme-123456",
      client_email: SERVICE_ACCOUNT_EMAIL,
      private_key: servicePrivateKeyPem,
      token_uri: "https://oauth2.googleapis.com/token",
    });

  it("refuses a bad paste before anything is stored", async () => {
    await markFresh(owner);
    const bad: [Record<string, string>, string][] = [
      [{ spreadsheetId: "https://docs.google.com/spreadsheets/d/x/edit" }, "spreadsheetId"],
      [{ range: "not a range!!" }, "range"],
      [{ credentialJson: '{"client_email":"a@b.test"}' }, "credentialJson"],
      [{ credentialJson: "not json at all" }, "credentialJson"],
    ];
    for (const [body, field] of bad) {
      const res = await request("acme", "/api/v1/metrics/sheets", {
        method: "PUT",
        cookie: owner.cookie,
        body: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          range: "KPIs!A1:D100",
          mapping,
          credentialJson: serviceAccountJson(),
          ...body,
        }),
      });
      expect(res.status, field).toBe(400);
      expect((await json<{ error: { field: string } }>(res)).error.field).toBe(field);
    }
    // Validated *before* encryption: a typo stored unread would only fail at 04:35 in a cron
    // job nobody is watching.
    const current = await json<ConnectionBody>(
      await request("acme", "/api/v1/metrics/sheets", { cookie: owner.cookie }),
    );
    expect(current.connection).toBeNull();
    expect(
      (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM metrics.sheet_connection`))[0]?.n,
    ).toBe(0);
  });

  it("stores the service-account key encrypted and never returns it", async () => {
    await markFresh(owner);
    const res = await request("acme", "/api/v1/metrics/sheets", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        spreadsheetId: SPREADSHEET_ID,
        range: "KPIs!A1:D100",
        mapping,
        credentialJson: serviceAccountJson(),
      }),
    });
    expect(res.status).toBe(200);
    const connection = await json<{ serviceAccountEmail: string; status: string }>(res);
    // The address the admin must share the sheet with; there is no OAuth dance, because a
    // self-hoster has nowhere to register a client.
    expect(connection.serviceAccountEmail).toBe(SERVICE_ACCOUNT_EMAIL);
    expect(JSON.stringify(connection)).not.toContain("PRIVATE KEY");

    const stored = await rows<{ blob: string; encryption: Record<string, unknown> }>(
      `SELECT encode(credential_enc, 'escape') AS blob, encryption FROM metrics.sheet_connection`,
    );
    expect(stored[0]?.blob).not.toContain("BEGIN PRIVATE KEY");
    expect(stored[0]?.blob).not.toContain(servicePrivateKeyPem.slice(40, 80));
    expect(stored[0]?.encryption).toMatchObject({ format: "she1" });
    expect(typeof stored[0]?.encryption["keyId"]).toBe("string");
  });

  it("flags a sync that disagrees with a number somebody typed, instead of overwriting it", async () => {
    /*
     * design/06 §7 and E2.4 §8: the sheet becomes the source of record going forward, so the
     * new revision *is* written — but it carries `needs_review`, so the admin screen can show
     * the two figures side by side rather than the number changing under them overnight.
     */
    const typed = await saveGrid(owner.cookie, [cell(ids["headcount"] as string, M[12], "40")]);
    expect(await json<WriteResult>(typed)).toMatchObject({ written: 1 });

    sheetFailure = undefined;
    sheetRows = [
      ["period", "headcount"],
      [M[12]?.key as string, "41"],
      [M[4]?.key as string, "35"],
    ];
    const outcome = await sheetsServiceWithFakePort().sync(systemContext(acmeId));
    expect(outcome).toMatchObject({
      status: "ok",
      written: 1,
      restated: 1,
      unchanged: 0,
      needsReview: 1,
      // Every cell the sheet offered became a number: nothing passed over, nothing unreadable.
      skipped: 0,
      unparsed: 0,
    });

    const overridden = await pointRowsOf(ids["headcount"] as string, M[12]?.start as string);
    expect(overridden.map((r) => r.revision)).toEqual([1, 2]);
    expect(overridden[1]).toMatchObject({ value: "41.000000", needsReview: true });
    // The row the sheet merely added is not flagged: there was no human figure to disagree with.
    const added = await pointRowsOf(ids["headcount"] as string, M[4]?.start as string);
    expect(added[0]).toMatchObject({ revision: 1, needsReview: false });

    const grid = await json<GridBody>(
      await request("acme", "/api/v1/metrics/grid?periods=24", { cookie: viewer.cookie }),
    );
    expect(
      grid.cells.find((c) => c.definitionId === ids["headcount"] && c.periodKey === M[12]?.key),
    ).toMatchObject({ needsReview: true, sourceKind: "sheets", revision: 2 });
  });

  it("records a failed sync on the connection and sends no mail", async () => {
    /*
     * Driven through the real route against the real `noop` adapter, which always refuses. A
     * failure records `status='failed'`, `last_error`, `consecutive_failures++`, an audit row
     * and a warn log — and **no mail**: there is no admin-alert channel in the product yet and
     * inventing one here would be E2.6's decision taken in the wrong place.
     */
    mailer.clear();
    const before = await auditCount("metrics.sheets_sync_failed");
    for (const expected of [1, 2]) {
      const res = await request("acme", "/api/v1/metrics/sheets/sync", {
        method: "POST",
        cookie: financeUser.cookie,
      });
      expect(res.status).toBe(200);
      expect(await json<{ status: string; error: string | null }>(res)).toMatchObject({
        status: "failed",
      });
      const row = await rows<{
        status: string;
        lastError: string;
        consecutiveFailures: number;
      }>(
        `SELECT status, last_error AS "lastError", consecutive_failures AS "consecutiveFailures"
           FROM metrics.sheet_connection`,
      );
      expect(row[0]?.status).toBe("failed");
      expect(row[0]?.lastError).toContain("not_found");
      // A counter rather than a flag: the sweep needs to know how long something has been
      // broken to tell a blip from a spreadsheet somebody un-shared.
      expect(row[0]?.consecutiveFailures).toBe(expected);
    }
    expect(await auditCount("metrics.sheets_sync_failed")).toBe(before + 2);
    expect(mailer.sent).toEqual([]);
  });

  it("a sheet it can read but not parse is `failed`, and the error names the cell", async () => {
    /*
     * The single most likely thing a real founder hits: the MRR column is formatted as
     * currency, Sheets returns `$1,234`, every cell fails to parse — and the sync used to
     * `continue` past each one and report `ok`. A green connection that imports nothing is
     * worse than a red one, because nobody goes looking.
     *
     * The refusal is narrow on purpose: nothing parsed **and** something was unreadable. A
     * sheet with only a header row, or one whose figures are not filled in yet, parses nothing
     * and has nothing wrong with it — that is what a founder sees the day they connect a blank
     * sheet, and the test below relies on it.
     */
    sheetFailure = undefined;
    sheetRows = [
      ["period", "headcount"],
      [M[2]?.key as string, "$1,234"],
      [M[3]?.key as string, "1 234"],
    ];
    const outcome = await sheetsServiceWithFakePort().sync(systemContext(acmeId));
    expect(outcome).toMatchObject({ status: "failed", written: 0, restated: 0, rows: 2 });
    expect(outcome.unparsed).toBeGreaterThan(0);
    // The sentence is the whole diagnosis for the person who has to fix the sheet: without the
    // column, the row and the text, "the sync imported nothing" sends them to the service
    // account and the range — everywhere except the one cell that is formatted as currency.
    expect(outcome.error).toContain("headcount");
    expect(outcome.error).toContain("$1,234");
    expect(outcome.error).toMatch(/currency, percent or thousands-separated/u);

    const row = await rows<{ status: string; lastError: string }>(
      `SELECT status, last_error AS "lastError" FROM metrics.sheet_connection`,
    );
    expect(row[0]?.status).toBe("failed");
    expect(row[0]?.lastError).toContain("headcount");
    // Nothing was written, so the points a working sync left behind are untouched.
    expect((await pointRowsOf(ids["headcount"] as string, M[2]?.start as string)).length).toBe(0);
  });

  it("a successful sync clears the failure counter; disconnecting keeps the points", async () => {
    // A header row and nothing under it: parsed nothing, and nothing wrong with it. The
    // failure above is "nothing parsed **and** something was unreadable", not "nothing parsed".
    sheetRows = [["period", "headcount"]];
    const outcome = await sheetsServiceWithFakePort().sync(systemContext(acmeId));
    expect(outcome).toMatchObject({ status: "ok", written: 0, unparsed: 0, error: null });
    const cleared = await rows<{ status: string; consecutiveFailures: number; lastError: null }>(
      `SELECT status, consecutive_failures AS "consecutiveFailures", last_error AS "lastError"
         FROM metrics.sheet_connection`,
    );
    expect(cleared[0]).toMatchObject({ status: "ok", consecutiveFailures: 0, lastError: null });

    const pointsBefore = await totalPoints();
    await markFresh(owner);
    expect(
      (
        await request("acme", "/api/v1/metrics/sheets", {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
    const gone = await json<ConnectionBody>(
      await request("acme", "/api/v1/metrics/sheets", { cookie: owner.cookie }),
    );
    expect(gone.connection).toBeNull();
    // The numbers it already wrote were true when they were written, and their source rows
    // still say where they came from.
    expect(await totalPoints()).toBe(pointsBefore);
  });
});

describe("permissions and step-up", () => {
  it("metrics.read can read the grid but cannot write it", async () => {
    expect((await request("acme", "/api/v1/metrics/grid", { cookie: viewer.cookie })).status).toBe(
      200,
    );
    const write = await saveGrid(viewer.cookie, [cell(ids["arr"] as string, M[1], "7")]);
    expect(write.status).toBe(403);
    expect((await json<{ error: { permission: string } }>(write)).error.permission).toBe(
      "metrics.manage",
    );
    // `metrics.settings` is owner/admin/finance: connecting a sheet is the same class of
    // decision as the sending domain, and an editor holds neither.
    expect(
      (await request("acme", "/api/v1/metrics/settings", { cookie: viewer.cookie })).status,
    ).toBe(403);
  });

  it("an external member gets 404 on every staff route, never a 403", async () => {
    // A 403 would confirm that the route — and therefore the workspace's KPI programme —
    // exists. The refusal must be the same one an unknown URL gives.
    for (const path of [
      "/api/v1/metrics/definitions",
      `/api/v1/metrics/definitions/${ids["arr"]}`,
      `/api/v1/metrics/definitions/${ids["arr"]}/points`,
      "/api/v1/metrics/grid",
      "/api/v1/metrics/sheets",
      "/api/v1/metrics/settings",
      `/api/v1/metrics/import/${randomUUID()}`,
    ]) {
      const res = await request("acme", path, { cookie: ada.cookie });
      expect(res.status, path).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code, path).toBe("not_found");
    }
    // What an investor may do is read the series, and that is decided by the audience in RLS.
    expect((await request("acme", "/api/v1/metrics/series", { cookie: ada.cookie })).status).toBe(
      200,
    );
  });

  it("a malformed `ids` on the member-facing series is an empty answer, not a 500", async () => {
    /*
     * `ids` is comma-separated text off the query string and anything non-uuid reached Postgres
     * as one, raising `22P02` — a 500 on a `member` route that any investor could trigger by
     * editing their own URL. A malformed id is **dropped**, the same rule the hydrator follows
     * for an id a reader may not see: what comes back must say nothing about what did not.
     */
    const junk = await request("acme", "/api/v1/metrics/series?ids=abc", { cookie: ada.cookie });
    expect(junk.status).toBe(200);
    expect((await json<SeriesBody>(junk)).series).toEqual([]);

    // And a good id beside a bad one still answers for the good one — the bad one does not
    // take it down, and is not reported.
    const mixed = await json<SeriesBody>(
      await request("acme", `/api/v1/metrics/series?ids=abc,${ids["arr"]}`, { cookie: ada.cookie }),
    );
    expect(mixed.series.map((e) => e.key)).toEqual(["arr"]);
    expect(JSON.stringify(mixed)).not.toContain("abc");
  });

  it("the step-up routes demand a session that has recently proved itself", async () => {
    /*
     * `DELETE /definitions/{id}`, `PUT`/`DELETE /sheets` and `PATCH /settings` declare
     * `+fresh` (pinned against the matrix by `authz-matrix.test.ts`). Backdating `auth_time`
     * is how a ten-minute-old session is reproduced without a ten-minute wait; the same
     * cookie must still pass the routes that do *not* ask for freshness, or this would be
     * testing the session and not the declaration.
     */
    const scratch = await define({ key: "throwaway", name: "Throwaway", unit: "count" });
    await markFresh(stale, 30 * 60_000);

    const fresh = await request("acme", "/api/v1/metrics/grid", { cookie: stale.cookie });
    expect(fresh.status).toBe(200);

    const removed = await request("acme", `/api/v1/metrics/definitions/${scratch}`, {
      method: "DELETE",
      cookie: stale.cookie,
    });
    expect(removed.status).toBe(403);
    const refusal = await json<{ error: { code: string; reason: string } }>(removed);
    expect(refusal.error).toMatchObject({ code: "step_up_required", reason: "fresh" });

    const settings = await request("acme", "/api/v1/metrics/settings", {
      method: "PATCH",
      cookie: stale.cookie,
      body: JSON.stringify({ defaultCurrency: "EUR" }),
    });
    expect(settings.status).toBe(403);
    expect((await json<{ error: { reason: string } }>(settings)).error.reason).toBe("fresh");

    /*
     * And the real ceremony closes it: a TOTP code on the owner's own session refreshes
     * `auth_time`, and the same delete goes through. This is the only place the suite spends
     * a TOTP step — the guard rejects a code whose thirty-second step is not newer than the
     * last accepted one, so proving it once and stamping `auth_time` elsewhere is the
     * difference between a suite that runs and one that sleeps through its own timeouts.
     */
    await markFresh(owner, 30 * 60_000);
    expect(
      (
        await request("acme", `/api/v1/metrics/definitions/${scratch}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(403);
    owner.cookie = await stepUp("acme", "owner@example.com", owner.cookie);
    expect(
      (
        await request("acme", `/api/v1/metrics/definitions/${scratch}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses to delete a metric another metric's formula still reads", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/metrics/definitions/${ids["net_burn"]}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    // Deleting it would leave `runway` permanently unevaluable with nothing on screen to say why.
    expect(res.status).toBe(409);
    expect((await json<{ error: { dependents: string[] } }>(res)).error.dependents).toEqual([
      "runway",
    ]);
  });

  it("changes the metric defaults behind a fresh session and records it", async () => {
    await markFresh(owner);
    const res = await request("acme", "/api/v1/metrics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ defaultCurrency: "EUR", defaultPeriodKind: "quarter" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ defaultCurrency: "EUR", defaultPeriodKind: "quarter" });
    expect(await auditCount("metrics.settings_changed")).toBe(1);
  });
});

describe("the metric_grid block on a published page", () => {
  let pageId = "";

  it("publishes a page carrying three metrics with three different audiences", async () => {
    const created = await request("acme", "/api/v1/content/pages", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ slug: "kpis", title: "How we are doing" }),
    });
    expect(created.status).toBe(201);
    pageId = (await json<{ page: { id: string } }>(created)).page.id;

    const draft = await request("acme", `/api/v1/content/pages/${pageId}/draft`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            {
              key: "numbers",
              title: "Numbers",
              blocks: [
                {
                  id: "grid",
                  type: "metric_grid",
                  schemaVersion: 1,
                  data: {
                    columns: 3,
                    definitionIds: [ids["arr"], ids["board_cash"], ids["secret_margin"]],
                  },
                },
              ],
            },
          ],
        },
      }),
    });
    expect(draft.status).toBe(200);
    expect(
      (
        await request("acme", `/api/v1/content/pages/${pageId}/publish`, {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
  });

  it("an investor's page carries only the metrics their audience admits", async () => {
    /*
     * E2.4 §10, and the quiet rule is the one that matters: ids the viewer may not see are
     * **dropped**, not reported. No `hidden: 2`, no placeholder tile, no count — an investor
     * must not be able to learn from a page that a metric they cannot see exists, which is
     * most of what a per-metric audience is for.
     */
    const asAda = await json<RenderedPage>(
      await request("acme", "/api/v1/content/render/kpis", { cookie: ada.cookie }),
    );
    const adaBlock = asAda.sections[0]?.blocks[0];
    expect(adaBlock?.unavailable).toBeUndefined();
    const adaGrid = adaBlock?.data["hydrated"] as {
      columns: number;
      metrics: {
        id: string;
        key: string;
        latest: { periodKey: string; periodLabel: string; value: string } | null;
        previous: { periodKey: string; value: string } | null;
        sparkline: (string | null)[];
      }[];
    };
    expect(adaGrid.columns).toBe(3);
    expect(adaGrid.metrics.map((m) => m.key)).toEqual(["arr"]);
    // Values travel as decimal strings: numeric(20, 6) does not survive a JSON number, and a
    // KPI tile is exactly where somebody would notice.
    expect(adaGrid.metrics[0]?.latest).toEqual({
      periodKey: M[1]?.key,
      periodLabel: expect.any(String),
      value: "1000000",
    });
    // `previous` is the newest period *before* the latest that has a number, not the column
    // beside it: a metric nobody entered last month still shows a delta against the one
    // before, and a gap is not a zero to compare against.
    expect(adaGrid.metrics[0]?.previous).toEqual({ periodKey: M[2]?.key, value: "1300" });
    expect(adaGrid.metrics[0]?.sparkline).toHaveLength(12);
    expect(JSON.stringify(adaGrid)).not.toContain(ids["board_cash"] as string);
    expect(JSON.stringify(adaGrid)).not.toContain(ids["secret_margin"] as string);
    /*
     * The assertion above is scoped to the *hydrated* payload on purpose. The block envelope
     * around it still carries what the page stored — `data.definitionIds` — because
     * `modules/content/src/render.ts` merges the hydrated payload into the raw block data
     * rather than replacing it. That is content's file and its `document_list` block has the
     * same shape, so it is reported rather than pinned here; what E2.4 §10 froze is this
     * payload, and this payload drops them.
     */

    const asBoard = await json<RenderedPage>(
      await request("acme", "/api/v1/content/render/kpis", { cookie: board.cookie }),
    );
    const boardGrid = asBoard.sections[0]?.blocks[0]?.data["hydrated"] as {
      metrics: { key: string }[];
    };
    expect(boardGrid.metrics.map((m) => m.key)).toEqual(["arr", "board_cash"]);

    const asStaff = await json<RenderedPage>(
      await request("acme", "/api/v1/content/render/kpis", { cookie: viewer.cookie }),
    );
    const staffGrid = asStaff.sections[0]?.blocks[0]?.data["hydrated"] as {
      metrics: { key: string }[];
    };
    expect(staffGrid.metrics.map((m) => m.key)).toEqual(["arr", "board_cash", "secret_margin"]);
  });
});

describe("the emailed chart's shared URL", () => {
  /*
   * `medium: "email"` is what makes the hydrator mint a capability URL at all — a mail client
   * carries no session, so the token in the `<img src>` is the authority — and `asOf` is the
   * instant the rendering is *of*. `modules/updates` now derives that instant from the send
   * row's `created_at` (`sendInstant`) rather than from `now()`, and the reason is the property
   * below: a send is retried and a stalled one is re-enqueued, so an instant taken from the
   * clock would hand the recipients reached after a crash a different URL from the ones
   * delivered before it — splitting one audience into retry cohorts with no visible symptom.
   *
   * What is reachable from here is the metrics half: the URL is a function of the audience and
   * of the instant, and of nothing else. The resumed-send half needs a send crashed halfway
   * and is pinned by the unit test in `modules/updates` that drives the real `run()` over faked
   * repos; contorting a whole send lifecycle into this file would test that suite's harness.
   */
  const emailPayload = async (who: Actor, groupIds: readonly string[], asOf: Date) => {
    const hydrated = await running.container.registry.blockHydrators
      .get("metric_grid")
      ?.hydrator.hydrate(
        {
          columns: 3,
          definitionIds: [
            ids["arr"] as string,
            ids["board_cash"] as string,
            ids["secret_margin"] as string,
          ],
        } satisfies JsonObject,
        {
          tenant: {
            workspaceId: acmeId,
            actorKind: "external" as const,
            membershipId: who.membershipId,
          },
          viewer: { kind: "external" as const, membershipId: who.membershipId, groupIds },
          facts: {},
          medium: "email" as const,
          asOf,
        },
      );
    return hydrated as unknown as {
      metrics: { key: string }[];
      chart: { url: string; alt: string; width: number; height: number } | null;
    };
  };

  it("two recipients in one audience share a URL; a different audience gets a different one", async () => {
    const at = new Date();
    const first = await emailPayload(board, [boardGroupId], at);
    const second = await emailPayload(board2, [boardGroupId], at);
    expect(first.metrics.map((m) => m.key)).toEqual(["arr", "board_cash"]);
    // Byte-identical, which is the whole of D5: the token names the *set of metrics an audience
    // may see*, never a reader, so an `<img>` in an email cannot be a tracking pixel.
    expect(first.chart?.url).toBe(second.chart?.url);
    expect(first.chart?.url).toBeTruthy();

    // Gating survives it: a reader in no group sees fewer metrics and therefore a different
    // picture, addressed by a different capability.
    const outsider = await emailPayload(ada, [], at);
    expect(outsider.metrics.map((m) => m.key)).toEqual(["arr"]);
    expect(outsider.chart?.url).not.toBe(first.chart?.url);

    // The chart is never the only place a number exists (§7): the alt text describes it.
    expect(first.chart?.alt.length).toBeGreaterThan(0);
  });

  it("the URL is a function of the instant, so the same instant reproduces it exactly", async () => {
    const at = new Date("2026-09-15T09:00:00.000Z");
    const once = await emailPayload(board, [boardGroupId], at);
    const twice = await emailPayload(board, [boardGroupId], at);
    expect(once.chart?.url).toBe(twice.chart?.url);
    // And a minute later is a different URL — which is exactly why the instant must come down
    // from the send row rather than from `now()`.
    const later = await emailPayload(board, [boardGroupId], new Date(at.getTime() + 60_000));
    expect(later.chart?.url).not.toBe(once.chart?.url);
  });

  it("the minted URL is the one the public route serves", async () => {
    const payload = await emailPayload(board, [boardGroupId], new Date());
    const url = new URL(payload.chart?.url as string);
    // On the workspace's own origin, which is where a mail client will fetch it from.
    expect(url.host).toBe(`acme.${CANON}`);
    const res = await request("acme", url.pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("tenancy, audit and outbox", () => {
  it("another tenant's ids are 404 once it has the module too", async () => {
    const ctx = systemContext(globexId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("metrics", true),
    );
    running.container.enablement.invalidate(globexId);

    for (const path of [
      `/api/v1/metrics/definitions/${ids["arr"]}`,
      `/api/v1/metrics/definitions/${ids["arr"]}/points`,
    ]) {
      expect((await request("globex", path, { cookie: globexOwner.cookie })).status, path).toBe(
        404,
      );
    }
    const grid = await json<GridBody>(
      await request("globex", "/api/v1/metrics/grid", { cookie: globexOwner.cookie }),
    );
    expect(grid.definitions).toEqual([]);
    expect(grid.cells).toEqual([]);
    // A chart token minted for Acme must not render against Globex, whatever its signature.
    const ctxAcme = systemContext(acmeId);
    const dek = await running.container.db.withTenant(ctxAcme, (tx) =>
      running.container.envelope.currentKey(tx, ctxAcme, CHART_TOKEN_PURPOSE),
    );
    const token = signChartToken(dek.key, {
      v: 1,
      w: acmeId,
      kid: dek.keyId,
      d: [ids["cash"] as string],
      k: "month",
      n: 6,
      asOf: new Date().toISOString(),
      exp: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await request("globex", `/api/v1/metrics/chart/${token}.png`)).status).toBe(404);
  });

  it("the audit trail and the outbox carry the lifecycle", async () => {
    const actions = await rows<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit.event
        WHERE action LIKE 'metrics.%' GROUP BY action ORDER BY action`,
    );
    const byAction = Object.fromEntries(actions.map((r) => [r.action, r.n]));
    expect(Object.keys(byAction).sort()).toEqual([
      "metrics.definition_created",
      "metrics.definition_deleted",
      "metrics.definition_updated",
      "metrics.import_finished",
      "metrics.import_started",
      "metrics.point_restated",
      "metrics.points_saved",
      "metrics.settings_changed",
      "metrics.sheets_connected",
      "metrics.sheets_disconnected",
      "metrics.sheets_sync_failed",
      "metrics.sheets_synced",
    ]);
    expect(byAction["metrics.sheets_connected"]).toBe(1);
    expect(byAction["metrics.sheets_disconnected"]).toBe(1);
    expect(byAction["metrics.import_started"]).toBe(2);
    expect(byAction["metrics.import_finished"]).toBe(2);

    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT topic, count(*)::int AS n FROM core.outbox
          WHERE topic LIKE 'metric.%' GROUP BY topic ORDER BY topic`,
      );
      return Object.fromEntries(
        (r.rows as { topic: string; n: number }[]).map((x) => [x.topic, x.n]),
      );
    });
    expect(outbox["metric.points_changed"]).toBeGreaterThan(0);
    // `metric.restated` carries ids only; the figures live on the audit row, which is the
    // evidence record with a retention this product controls (contract §12 C5 ruling).
    expect(outbox["metric.restated"]).toBeGreaterThan(0);
    const payloads = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT payload FROM core.outbox WHERE topic = 'metric.restated' LIMIT 1`,
      );
      return (r.rows as { payload: Record<string, unknown> }[])[0]?.payload ?? {};
    });
    expect(Object.keys(payloads).sort()).toEqual([
      "definitionId",
      "fromRevision",
      "periodStart",
      "sourceKind",
      "toRevision",
    ]);
    expect(JSON.stringify(payloads)).not.toContain("oldValue");
  });
});
