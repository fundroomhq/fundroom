import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildEffectiveAccess, rederiveRulePaths } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  type IntegrationConnectionSummary,
  type IntegrationServices,
  ModuleEnablementRepo,
} from "@fundroom/module-kit";
import {
  HISTORY_TOO_LARGE,
  JOB_KPI_SYNC,
  JOB_KPI_SYNC_PROVIDER,
  KPI_SYNC_CRON,
  kpiSyncKey,
  metricsDsar,
} from "@fundroom/module-metrics";
import { exportPublicKeys, importWorkspace } from "@fundroom/portability";
import type { JsonObject, KpiReadRequest, KpiSourceMetric } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWorkspaceExport } from "./cli-commands/workspace-portability.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * KPI sources end to end (E3.6 §5): a monthly metric bound to a series of a connected
 * QuickBooks / Xero / Stripe account and pulled into the append-only point series.
 *
 * The integrations kernel is replaced by a fake `IntegrationServices` (canned series,
 * `not_connected`, vendor refusals), installed on the container's own services object — which is
 * exactly what `ModuleServices.integrations` hands the module — so nothing reaches a vendor and
 * the module is tested against the port, not against the kernel's adapters.
 *
 * Pinned: the 24-month backfill then the trailing 3; `historical: false` writes only the current
 * month; a synced value over a hand-typed one is a flagged revision, never an overwrite; a failed
 * read is recorded and mails nobody; a disconnect turns the next (cron) sync into "not
 * connected"; a binding deleted while the vendor answers writes nothing; only monthly manual
 * metrics can be bound (422 `binding_period_unsupported`); the binding routes want a fresh
 * session; sync-now is rate limited; bindings travel in a workspace export, health reset.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let tmp: string;

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

/** Owners and admins need a second factor before any `+fresh` route will listen to them. */
async function enrolTotp(slug: string, cookie: string): Promise<string> {
  const { TOTP, Secret } = await import("otpauth");
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const code = new TOTP({ secret: Secret.fromBase32(secretBase32) }).generate();
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  role: "owner" | "finance" | "viewer",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "staff",
    role,
    source: "test",
  });
  const actor = await signIn(slug, email);
  if (role === "owner") actor.cookie = await enrolTotp(slug, actor.cookie);
  return actor;
}

/** `auth_time` stamped `ageMs` ago on every live session of the actor (see metrics suite). */
async function markFresh(actor: Actor, workspaceId: string, ageMs = 0): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
      workspaceId,
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

async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

const auditCount = async (action: string, workspaceId?: string): Promise<number> =>
  (
    await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = '${action}'`,
      workspaceId,
    )
  )[0]?.n ?? 0;

function monthsAgo(n: number): { key: string; start: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const key = `${d.getUTCFullYear().toString().padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { key, start: d.toISOString() };
}
const month = (n: number) => monthsAgo(n).key;

/** Points a Stripe sync wrote. Not every point: `doubled`'s recompute runs off the outbox. */
const STRIPE_POINTS = `SELECT count(*)::int AS n FROM metrics.point p
  JOIN metrics.source s ON s.id = p.source_id WHERE s.kind = 'stripe'`;

async function enableMetrics(workspaceId: string): Promise<void> {
  const ctx = systemContext(workspaceId);
  await running.container.db.withTenant(ctx, (tx) =>
    new ModuleEnablementRepo(ctx, tx).set("metrics", true),
  );
  running.container.enablement.invalidate(workspaceId);
}

// --- the fake integrations kernel ----------------------------------------------------------------

const CATALOGUE: Record<string, KpiSourceMetric[]> = {
  stripe: [
    {
      key: "gross_volume",
      label: "Gross volume",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    { key: "net_volume", label: "Net volume", kind: "flow", unit: "currency", historical: true },
    { key: "new_customers", label: "New customers", kind: "flow", unit: "count", historical: true },
    { key: "mrr", label: "MRR", kind: "stock", unit: "currency", historical: false },
  ],
  quickbooks: [
    { key: "revenue", label: "Revenue", kind: "flow", unit: "currency", historical: true },
    { key: "cash", label: "Cash", kind: "stock", unit: "currency", historical: true },
  ],
  xero: [{ key: "revenue", label: "Revenue", kind: "flow", unit: "currency", historical: true }],
};

type ReadResult = Awaited<ReturnType<IntegrationServices["readKpi"]>>;

const CONNECTION_IDS: Record<string, string> = {
  stripe: "01920000-0000-7000-8000-00000000c001",
  quickbooks: "01920000-0000-7000-8000-00000000c002",
  xero: "01920000-0000-7000-8000-00000000c003",
};

const fake = {
  /** Providers connected in acme. Every other workspace has nothing connected. */
  connected: new Set<string>(["stripe"]),
  reads: [] as { workspaceId: string; provider: string; req: KpiReadRequest }[],
  /** Monthly gross volume by month key; the canned series. */
  gross: new Map<string, string>(),
  mrr: "4200",
  /** While set, every read answers this instead of the canned series. */
  refusal: undefined as ReadResult | undefined,
  /** A read starting at this month answers `too_large` (a history too big to backfill). */
  tooLargeFrom: undefined as string | undefined,
  /** Runs while the "vendor" is answering — outside any transaction, like the real call. */
  duringRead: undefined as (() => Promise<void>) | undefined,
  /** Reads of this provider wait until `open` resolves (a slow vendor). */
  gate: undefined as { provider: string; open: Promise<void> } | undefined,
  /** Every read of this provider fails (`unavailable`). */
  failProvider: undefined as string | undefined,
};

function summaryOf(provider: string): IntegrationConnectionSummary {
  return {
    id: CONNECTION_IDS[provider] ?? "",
    provider: provider as IntegrationConnectionSummary["provider"],
    status: "active",
    accountLabel: `Acme on ${provider}`,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

function installFakeIntegrations(): void {
  const isConnected = (ctx: TenantContext, provider: string) =>
    ctx.workspaceId === acmeId && fake.connected.has(provider);
  const overrides: Partial<IntegrationServices> = {
    connection: async (_tx, ctx, provider) =>
      isConnected(ctx, provider) ? summaryOf(provider) : undefined,
    kpiMetrics: (provider) => CATALOGUE[provider] ?? [],
    readKpi: async (ctx, provider, req) => {
      fake.reads.push({ workspaceId: ctx.workspaceId, provider, req });
      if (!isConnected(ctx, provider)) return { ok: false, reason: "not_connected" };
      if (fake.gate?.provider === provider) await fake.gate.open;
      if (fake.failProvider === provider) return { ok: false, reason: "unavailable" };
      if (fake.duringRead !== undefined) {
        const hook = fake.duringRead;
        fake.duringRead = undefined;
        await hook();
      }
      if (fake.tooLargeFrom !== undefined && req.fromMonth === fake.tooLargeFrom) {
        fake.tooLargeFrom = undefined;
        return { ok: false, reason: "too_large" };
      }
      if (fake.refusal !== undefined) {
        // Every read while set, including the per-series retries; the test clears it.
        const r = fake.refusal;
        return r;
      }
      const series = req.metrics.map((metric) => {
        if (metric === "mrr") {
          // The vendor only knows today's MRR; a value for last month must not be written.
          return {
            metric,
            points: [
              { month: month(1), value: "1" },
              { month: month(0), value: fake.mrr },
            ],
          };
        }
        if (metric === "new_customers") {
          return { metric, points: [{ month: month(0), value: "5" }] };
        }
        return {
          metric,
          points: [...fake.gross.entries()]
            .filter(([m]) => m >= req.fromMonth && m <= req.toMonth)
            .map(([m, value]) => ({ month: m, value })),
        };
      });
      return { ok: true, value: { currency: "USD", series } };
    },
  };
  // The container's own object — the same one `ModuleServices.integrations` returns.
  Object.assign(running.container.integrations.services, overrides);
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let finance: Actor;
let viewer: Actor;
let globexOwner: Actor;
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

async function bind(
  definitionId: string,
  body: Record<string, unknown>,
  cookie = owner.cookie,
): Promise<Response> {
  return request("acme", `/api/v1/metrics/definitions/${definitionId}/binding`, {
    method: "PUT",
    cookie,
    body: JSON.stringify(body),
  });
}

/**
 * `POST /sources/sync` only enqueues the workspace's KPI job (202); the worker runs it. Waits
 * until the binding of `key` records a new `lastSyncAt`.
 */
async function syncAndWait(key: string): Promise<void> {
  const before = (await bindingOf(ids[key] as string))?.lastSyncAt ?? null;
  const res = await syncNow();
  expect(res.status).toBe(202);
  expect(await json<QueuedBody>(res)).toMatchObject({ queued: true });
  await waitFor(async () => {
    const after = (await bindingOf(ids[key] as string))?.lastSyncAt ?? null;
    return after !== null && after !== before ? after : undefined;
  });
}

async function syncNow(slug = "acme", cookie = finance.cookie): Promise<Response> {
  return request(slug, "/api/v1/metrics/sources/sync", { method: "POST", cookie });
}

interface BindingBody {
  id: string;
  definitionId: string;
  provider: string;
  sourceMetric: string;
  enabled: boolean;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface SourcesBody {
  providers: {
    provider: string;
    connected: boolean;
    status: string | null;
    accountLabel: string | null;
    metrics: KpiSourceMetric[];
  }[];
  bindings: BindingBody[];
}

interface QueuedBody {
  queued: boolean;
  providers: string[];
}

async function sources(cookie = owner.cookie): Promise<SourcesBody> {
  const res = await request("acme", "/api/v1/metrics/sources", { cookie });
  expect(res.status).toBe(200);
  return json<SourcesBody>(res);
}

const bindingOf = async (definitionId: string) =>
  (await sources()).bindings.find((b) => b.definitionId === definitionId);

const livePoints = (definitionId: string, workspaceId?: string) =>
  rows<{
    periodStart: string;
    value: string;
    kind: string;
    revision: number;
    needsReview: boolean;
  }>(
    `SELECT to_char(p.period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS "periodStart",
            p.value::text AS value, s.kind::text AS kind, p.revision, p.needs_review AS "needsReview"
       FROM metrics.point_current p LEFT JOIN metrics.source s ON s.id = p.source_id
      WHERE p.definition_id = '${definitionId}'::uuid ORDER BY p.period_start`,
    workspaceId,
  );

/** Runs one workspace's KPI sync job — what the nightly fan-out enqueues. */
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

/** Runs one (workspace, provider) KPI sync job in-process — what the fan-out enqueues. */
async function runKpiJob(workspaceId: string, provider = "stripe"): Promise<void> {
  const job = running.container.registry
    .resolveJobs(running.container.moduleServices)
    .find((j) => j.name === JOB_KPI_SYNC_PROVIDER);
  expect(job).toBeDefined();
  await job?.handler({
    id: "test",
    name: JOB_KPI_SYNC_PROVIDER,
    data: { workspaceId, provider },
    signal: new AbortController().signal,
  } as never);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  tmp = mkdtempSync(join(tmpdir(), "fundroom-kpi-"));
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      // The workspace export (portability test below) stages its archive here.
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
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
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  installFakeIntegrations();
  await enableMetrics(acmeId);
  await enableMetrics(globexId);
  owner = await member("acme", acmeId, "owner@example.com", "owner");
  finance = await member("acme", acmeId, "cfo@example.com", "finance");
  viewer = await member("acme", acmeId, "viewer@example.com", "viewer");
  globexOwner = await member("globex", globexId, "boss@example.org", "finance");
  for (let i = 23; i >= 0; i--) fake.gross.set(month(i), `${1000 + (23 - i)}`);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema and registry", () => {
  it("metrics.source_binding passes the RLS catalog check and the source kinds exist", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
    const labels = await running.container.db.pool.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'metrics' AND t.typname = 'source_kind' ORDER BY e.enumsortorder`,
    );
    expect(labels.rows.map((r) => r.enumlabel)).toEqual([
      "manual",
      "csv",
      "sheets",
      "derived",
      "quickbooks",
      "xero",
      "stripe",
    ]);
  });

  it("registers the nightly kpi sync", () => {
    const job = running.container.registry
      .resolveJobs(running.container.moduleServices)
      .find((j) => j.name === JOB_KPI_SYNC);
    expect(job?.cron).toBe(KPI_SYNC_CRON);
    expect(KPI_SYNC_CRON).toBe("55 4 * * *");
  });
});

describe("sources and bindings", () => {
  it("lists every KPI provider with its connection state and series; settings only", async () => {
    const body = await sources();
    expect(body.providers.map((p) => [p.provider, p.connected, p.status])).toEqual([
      ["quickbooks", false, null],
      ["xero", false, null],
      ["stripe", true, "active"],
    ]);
    expect(body.providers.find((p) => p.provider === "stripe")?.metrics.map((m) => m.key)).toEqual([
      "gross_volume",
      "net_volume",
      "new_customers",
      "mrr",
    ]);
    expect(body.bindings).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|rk_/iu);

    const refused = await request("acme", "/api/v1/metrics/sources", { cookie: viewer.cookie });
    expect(refused.status).toBe(403);
  });

  it("only a monthly, non-formula metric can be bound (422 binding_period_unsupported)", async () => {
    await define({ key: "revenue", name: "Revenue", unit: "currency", currency: "USD" });
    await define({ key: "mrr", name: "MRR", unit: "currency", currency: "USD" });
    await define({ key: "customers", name: "New customers", unit: "count" });
    await define({ key: "churned", name: "Churned", unit: "count" });
    await define({
      key: "quarterly_rev",
      name: "Quarterly revenue",
      unit: "currency",
      currency: "USD",
      periodKind: "quarter",
    });
    await define({
      key: "doubled",
      name: "Doubled",
      unit: "currency",
      currency: "USD",
      formula: {
        op: "mul",
        args: [
          { op: "ref", key: "revenue" },
          { op: "const", value: "2" },
        ],
      },
    });
    await markFresh(owner, acmeId);

    for (const key of ["quarterly_rev", "doubled"]) {
      const res = await bind(ids[key] as string, {
        provider: "stripe",
        sourceMetric: "gross_volume",
      });
      expect(res.status, key).toBe(422);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
        "binding_period_unsupported",
      );
    }
    // Not in the provider's catalogue, and a count series into a money metric.
    const unknown = await bind(ids["revenue"] as string, {
      provider: "stripe",
      sourceMetric: "arr",
    });
    expect(unknown.status).toBe(400);
    expect((await json<{ error: { field: string } }>(unknown)).error.field).toBe("sourceMetric");
    const unit = await bind(ids["revenue"] as string, {
      provider: "stripe",
      sourceMetric: "new_customers",
    });
    expect(unit.status).toBe(400);
    expect(await rows(`SELECT 1 FROM metrics.source_binding`)).toEqual([]);
  });

  it("the binding routes demand a session that has recently proved itself", async () => {
    await markFresh(owner, acmeId, 30 * 60_000);
    const put = await bind(ids["revenue"] as string, {
      provider: "stripe",
      sourceMetric: "gross_volume",
    });
    expect(put.status).toBe(403);
    expect((await json<{ error: { code: string; reason: string } }>(put)).error).toMatchObject({
      code: "step_up_required",
      reason: "fresh",
    });
    const del = await request("acme", `/api/v1/metrics/definitions/${ids["revenue"]}/binding`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(403);
    // The same stale session still reads the sources: only the writes ask for freshness.
    expect(
      (await request("acme", "/api/v1/metrics/sources", { cookie: owner.cookie })).status,
    ).toBe(200);
  });

  it("binds, audits, and a bound metric cannot be turned quarterly or into a formula", async () => {
    await markFresh(owner, acmeId);
    for (const [key, sourceMetric] of [
      ["revenue", "gross_volume"],
      ["mrr", "mrr"],
      ["customers", "new_customers"],
    ] as const) {
      const res = await bind(ids[key] as string, { provider: "stripe", sourceMetric });
      expect(res.status, key).toBe(200);
      expect(await json<BindingBody>(res)).toMatchObject({
        definitionId: ids[key],
        provider: "stripe",
        sourceMetric,
        enabled: true,
        status: "idle",
        lastSuccessAt: null,
      });
    }
    expect(await auditCount("metrics.kpi_binding_set")).toBe(3);

    const patch = await request("acme", `/api/v1/metrics/definitions/${ids["revenue"]}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ periodKind: "quarter" }),
    });
    expect(patch.status).toBe(422);
    expect((await json<{ error: { code: string } }>(patch)).error.code).toBe(
      "binding_period_unsupported",
    );
  });
});

describe("one source per metric (review R2)", () => {
  const sheetBody = (keys: string[]) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    return JSON.stringify({
      spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
      range: "KPIs!A1:D100",
      mapping: {
        periodColumn: "period",
        periodKind: "month",
        columns: keys.map((key) => ({ column: key, key })),
      },
      credentialJson: JSON.stringify({
        type: "service_account",
        project_id: "acme-123456",
        client_email: "kpis@acme-123456.iam.gserviceaccount.com",
        private_key: privateKey,
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    });
  };

  it("a metric the Sheet feeds cannot be bound, and a bound metric cannot join the Sheet mapping", async () => {
    await markFresh(owner, acmeId);
    const linked = await request("acme", "/api/v1/metrics/sheets", {
      method: "PUT",
      cookie: owner.cookie,
      body: sheetBody(["churned"]),
    });
    expect(linked.status).toBe(200);

    const bindRes = await bind(ids["churned"] as string, {
      provider: "stripe",
      sourceMetric: "new_customers",
    });
    expect(bindRes.status).toBe(409);
    expect((await json<{ error: { code: string; reason: string } }>(bindRes)).error).toMatchObject({
      code: "conflict",
      reason: "source_overlap",
    });

    const remap = await request("acme", "/api/v1/metrics/sheets", {
      method: "PUT",
      cookie: owner.cookie,
      body: sheetBody(["churned", "mrr"]),
    });
    expect(remap.status).toBe(409);
    expect(
      (await json<{ error: { code: string; reason: string; keys: string[] } }>(remap)).error,
    ).toMatchObject({ code: "conflict", reason: "source_overlap", keys: ["mrr"] });
    // The refused mapping stored nothing: the sheet still names only `churned`.
    const stored = await rows<{ mapping: { columns: { key: string }[] } }>(
      `SELECT mapping FROM metrics.sheet_connection`,
    );
    expect(stored[0]?.mapping.columns.map((c) => c.key)).toEqual(["churned"]);

    const unlinked = await request("acme", "/api/v1/metrics/sheets", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(unlinked.status).toBe(200);
  });
});

describe("sync", () => {
  it("the first sync backfills 24 months; a synced value over a typed one is flagged, not overwritten", async () => {
    // A number somebody typed for last month, before the integration existed.
    const typed = await request("acme", "/api/v1/metrics/grid", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        periodKind: "month",
        cells: [{ definitionId: ids["revenue"], periodKey: month(1), value: "999" }],
      }),
    });
    expect(typed.status).toBe(200);
    mailer.clear();
    fake.reads.length = 0;

    // Sync-now never reads inline (a 24-month Stripe read can take minutes): it queues the
    // workspace's KPI job and answers 202; the worker runs it.
    await syncAndWait("customers");
    // Each read carries the job's abort signal; compare the rest.
    expect(fake.reads[0]?.req.signal).toBeInstanceOf(AbortSignal);
    expect(
      fake.reads.map(({ workspaceId, provider, req }) => ({
        workspaceId,
        provider,
        req: { metrics: req.metrics, fromMonth: req.fromMonth, toMonth: req.toMonth },
      })),
    ).toEqual([
      {
        workspaceId: acmeId,
        provider: "stripe",
        req: {
          metrics: ["gross_volume", "mrr", "new_customers"],
          fromMonth: month(23),
          toMonth: month(0),
        },
      },
    ]);

    const revenue = await livePoints(ids["revenue"] as string);
    expect(revenue).toHaveLength(24);
    expect(revenue.every((p) => p.kind === "stripe")).toBe(true);
    expect(revenue[0]).toMatchObject({ periodStart: month(23), value: "1000.000000" });
    // The typed 999 is superseded by the synced figure, which carries the review flag.
    expect(revenue.find((p) => p.periodStart === month(1))).toMatchObject({
      value: "1022.000000",
      revision: 2,
      needsReview: true,
    });
    const history = await rows<{ value: string; kind: string }>(
      `SELECT p.value::text AS value, s.kind::text AS kind FROM metrics.point p
         LEFT JOIN metrics.source s ON s.id = p.source_id
        WHERE p.definition_id = '${ids["revenue"]}'::uuid
          AND p.period_start = '${monthsAgo(1).start}'::timestamptz ORDER BY p.revision`,
    );
    expect(history).toEqual([
      { value: "999.000000", kind: "manual" },
      { value: "1022.000000", kind: "stripe" },
    ]);

    // `historical: false`: only the current month, although the vendor sent last month too.
    expect(await livePoints(ids["mrr"] as string)).toEqual([
      expect.objectContaining({ periodStart: month(0), value: "4200.000000", kind: "stripe" }),
    ]);

    const source = await rows<{ ref: JsonObject }>(
      `SELECT ref FROM metrics.source WHERE kind = 'stripe'`,
    );
    expect(source[0]?.ref).toMatchObject({
      provider: "stripe",
      connectionId: CONNECTION_IDS["stripe"],
      currency: "USD",
    });

    const binding = await bindingOf(ids["revenue"] as string);
    expect(binding).toMatchObject({ status: "ok", lastError: null, consecutiveFailures: 0 });
    expect(binding?.lastSuccessAt).not.toBeNull();
    expect(await auditCount("metrics.kpi_synced")).toBe(1);
  });

  it("later syncs read the trailing 3 months, and a vendor restatement is a plain revision", async () => {
    fake.reads.length = 0;
    fake.gross.set(month(0), "2500");
    fake.mrr = "4300";
    await syncAndWait("revenue");
    expect(fake.reads.map((r) => r.req.fromMonth)).toEqual([month(2)]);
    const current = (await livePoints(ids["revenue"] as string)).find(
      (p) => p.periodStart === month(0),
    );
    expect(current).toMatchObject({ value: "2500.000000", revision: 2, needsReview: false });
  });

  it("a failed read records the failure on every binding and mails nobody", async () => {
    mailer.clear();
    fake.reads.length = 0;
    fake.refusal = { ok: false, reason: "rate_limited", detail: "429 from vendor" };
    const failedBefore = await auditCount("metrics.kpi_sync_failed");
    const pointsBefore = await rows<{ n: number }>(STRIPE_POINTS);

    try {
      await syncAndWait("revenue");
    } finally {
      fake.refusal = undefined;
    }
    // Throttled: the provider fails once — no per-series re-reads to make the 429s worse.
    expect(fake.reads).toHaveLength(1);
    for (const key of ["mrr", "customers"]) {
      expect(await bindingOf(ids[key] as string), key).toMatchObject({
        status: "failed",
        lastError: "rate_limited: 429 from vendor",
      });
    }
    const binding = await bindingOf(ids["revenue"] as string);
    expect(binding).toMatchObject({
      status: "failed",
      lastError: "rate_limited: 429 from vendor",
      consecutiveFailures: 1,
    });
    // The last success is kept, so the next sync reads 3 months and not a fresh 24.
    expect(binding?.lastSuccessAt).not.toBeNull();
    expect(await auditCount("metrics.kpi_sync_failed")).toBe(failedBefore + 1);
    expect(await rows(STRIPE_POINTS)).toEqual(pointsBefore);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(mailer.sent).toEqual([]);
  });

  it("a binding deleted while the vendor answers writes nothing", async () => {
    fake.gross.set(month(0), "3100");
    await markFresh(owner, acmeId);
    fake.duringRead = async () => {
      const res = await request("acme", `/api/v1/metrics/definitions/${ids["revenue"]}/binding`, {
        method: "DELETE",
        cookie: owner.cookie,
      });
      expect(res.status).toBe(200);
    };
    await syncAndWait("mrr");
    // Revenue's binding was gone by the time the write transaction locked it.
    const current = (await livePoints(ids["revenue"] as string)).find(
      (p) => p.periodStart === month(0),
    );
    expect(current?.value).toBe("2500.000000");
    expect(await bindingOf(ids["revenue"] as string)).toBeUndefined();
    expect(await auditCount("metrics.kpi_binding_removed")).toBe(1);

    const again = await request("acme", `/api/v1/metrics/definitions/${ids["revenue"]}/binding`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(again.status).toBe(404);
  });

  it("the nightly cron only enqueues: one job per workspace with metrics on, keyed per day", async () => {
    const sent: { name: string; data: JsonObject; key: string | undefined }[] = [];
    const live = running.container.moduleServices;
    const recording = new Proxy(live, {
      get: (target, prop) =>
        prop === "queue"
          ? {
              send: async (name: string, data: JsonObject, opts?: { idempotencyKey?: string }) => {
                sent.push({ name, data, key: opts?.idempotencyKey });
                return "job";
              },
              sendInTransaction: live.queue.sendInTransaction,
            }
          : Reflect.get(target, prop),
    });
    const cron = running.container.registry
      .resolveJobs(recording)
      .find((j) => j.name === JOB_KPI_SYNC);
    fake.reads.length = 0;
    await cron?.handler({
      id: "cron",
      name: JOB_KPI_SYNC,
      data: {},
      signal: new AbortController().signal,
    } as never);
    // Nothing was synced inline: the vendor was not called.
    expect(fake.reads).toEqual([]);
    // One job per (workspace, bound provider): acme has Stripe bindings, globex has none.
    expect(sent).toEqual([
      {
        name: JOB_KPI_SYNC_PROVIDER,
        data: { workspaceId: acmeId, provider: "stripe" },
        key: kpiSyncKey(acmeId, "stripe"),
      },
    ]);
    expect(new Set(sent.map((j) => j.key)).size).toBe(sent.length);
  });

  it("a new binding backfills alone; a too-large backfill falls back to 3 months with a note", async () => {
    await markFresh(owner, acmeId);
    const added = await bind(ids["churned"] as string, {
      provider: "stripe",
      sourceMetric: "new_customers",
    });
    expect(added.status).toBe(200);
    fake.reads.length = 0;
    fake.tooLargeFrom = month(23);
    await syncAndWait("churned");
    // One job: 3 months for the established bindings, a 24-month read for the new one that the
    // vendor refuses as too large, then its 3-month fallback.
    expect(fake.reads.map((r) => [r.req.metrics.join(","), r.req.fromMonth])).toEqual([
      ["mrr,new_customers", month(2)],
      ["new_customers", month(23)],
      ["new_customers", month(2)],
    ]);
    const churned = await bindingOf(ids["churned"] as string);
    expect(churned).toMatchObject({
      status: "ok",
      lastError: null,
      historyFrom: month(0),
      historyNote: HISTORY_TOO_LARGE,
    });
    expect(churned?.lastSuccessAt).not.toBeNull();
    // The established ones were never pulled into the backfill, and carry no note.
    expect(await bindingOf(ids["mrr"] as string)).toMatchObject({
      status: "ok",
      lastError: null,
      historyNote: null,
    });

    // A later ordinary sync succeeds and the truncation stays visible.
    await runKpiJob(acmeId);
    expect(await bindingOf(ids["churned"] as string)).toMatchObject({
      status: "ok",
      historyNote: HISTORY_TOO_LARGE,
    });
  });

  it("after a disconnect the nightly job records `not connected` and reads nothing", async () => {
    fake.connected.delete("stripe");
    fake.reads.length = 0;
    mailer.clear();
    await runKpiJob(acmeId);
    expect(fake.reads).toEqual([]);
    const body = await sources();
    expect(body.providers.find((p) => p.provider === "stripe")?.connected).toBe(false);
    for (const b of body.bindings) {
      expect(b).toMatchObject({ status: "failed", lastError: "not connected" });
    }
    expect(body.bindings).toHaveLength(3);
    expect(mailer.sent).toEqual([]);
    fake.connected.add("stripe");
  });
});

describe("one job per provider (review R4)", () => {
  it("a slow, failing provider does not delay another", async () => {
    fake.connected.add("quickbooks");
    await define({ key: "cash_qb", name: "Cash (QBO)", unit: "currency", currency: "USD" });
    await markFresh(owner, acmeId);
    expect(
      (await bind(ids["cash_qb"] as string, { provider: "quickbooks", sourceMetric: "cash" }))
        .status,
    ).toBe(200);
    // QuickBooks sorts first and is the slow, failing one: in a single job per workspace (or a
    // single worker slot) it would hold Stripe back until it gave up.
    let release: () => void = () => undefined;
    fake.gate = { provider: "quickbooks", open: new Promise<void>((r) => (release = r)) };
    fake.failProvider = "quickbooks";
    const stripeBefore = (await bindingOf(ids["mrr"] as string))?.lastSyncAt ?? null;
    try {
      const res = await syncNow();
      expect(res.status).toBe(202);
      expect(await json<QueuedBody>(res)).toEqual({
        queued: true,
        providers: ["quickbooks", "stripe"],
      });
      // Stripe's job finishes while QuickBooks' is still stuck at the vendor.
      await waitFor(async () => {
        const b = await bindingOf(ids["mrr"] as string);
        return b !== undefined && b.lastSyncAt !== stripeBefore ? b : undefined;
      }, 15_000);
      expect(await bindingOf(ids["mrr"] as string)).toMatchObject({ status: "ok" });
      expect((await bindingOf(ids["cash_qb"] as string))?.lastSyncAt).toBeNull();
    } finally {
      release();
    }
    await waitFor(async () => (await bindingOf(ids["cash_qb"] as string))?.lastSyncAt ?? undefined);
    expect(await bindingOf(ids["cash_qb"] as string)).toMatchObject({
      status: "failed",
      lastError: "unavailable",
    });
    fake.gate = undefined;
    fake.failProvider = undefined;
    // Leave the workspace as the portability test expects it: Stripe bindings only.
    await markFresh(owner, acmeId);
    const unbound = await request("acme", `/api/v1/metrics/definitions/${ids["cash_qb"]}/binding`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(unbound.status).toBe(200);
    fake.connected.delete("quickbooks");
  });
});

describe("portability, DSAR and rate limits", () => {
  it("bindings travel in a workspace export, with their health reset", async () => {
    const out = join(tmp, "acme.zip");
    expect(await runWorkspaceExport(["acme", "--out", out], running.container.config)).toBe(0);
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey ?? "";
    const result = await importWorkspace(
      {
        db: running.container.db,
        storage: running.container.storage,
        envelope: running.container.envelope,
        keyRing: running.container.config.keyRing,
        modules: running.container.registry.modules,
        instanceVersion: "test",
        audit: running.container.audit,
        moduleServices: running.container.moduleServices,
        rederiveRulePaths,
        rebuildAccess: async (tx, ctx) => {
          await rebuildEffectiveAccess(tx, ctx);
        },
        tmpDir: tmp,
      },
      { file: out, slug: "acme-copy", trustedPublicKeys: [key], importedBy: "test" },
    );
    expect(result.counts["metrics.source_binding"]).toBe(3);
    const copied = await rows<{
      key: string;
      provider: string;
      sourceMetric: string;
      status: string;
      lastSuccessAt: string | null;
      lastError: string | null;
    }>(
      `SELECT d.key, b.provider, b.source_metric AS "sourceMetric", b.status::text AS status,
              b.last_success_at AS "lastSuccessAt", b.last_error AS "lastError"
         FROM metrics.source_binding b JOIN metrics.definition d ON d.id = b.definition_id
        WHERE b.workspace_id = '${result.workspaceId}' ORDER BY d.key`,
      result.workspaceId,
    );
    expect(copied).toEqual([
      {
        key: "churned",
        provider: "stripe",
        sourceMetric: "new_customers",
        status: "idle",
        lastSuccessAt: null,
        lastError: null,
      },
      {
        key: "customers",
        provider: "stripe",
        sourceMetric: "new_customers",
        status: "idle",
        lastSuccessAt: null,
        lastError: null,
      },
      {
        key: "mrr",
        provider: "stripe",
        sourceMetric: "mrr",
        status: "idle",
        lastSuccessAt: null,
        lastError: null,
      },
    ]);
    // The copy has no connection (credentials never travel), so its sync says so.
    await enableMetrics(result.workspaceId);
    await runKpiJob(result.workspaceId);
    const after = await rows<{ lastError: string | null }>(
      `SELECT last_error AS "lastError" FROM metrics.source_binding`,
      result.workspaceId,
    );
    expect(after.map((r) => r.lastError)).toEqual([
      "not connected",
      "not connected",
      "not connected",
    ]);
    // And the source workspace is untouched.
    expect((await sources()).bindings).toHaveLength(3);
  });

  it("the member's DSAR export is unaffected by bindings they created", async () => {
    const ctx = systemContext(acmeId);
    const exported = await running.container.db.withTenant(ctx, (tx) =>
      metricsDsar.export({ tx, ctx, membershipId: owner.membershipId } as never),
    );
    expect(JSON.stringify(exported)).not.toContain("source_binding");
  });

  it("sync-now only queues, one KPI job per workspace at a time, and is rate limited to 6 an hour", async () => {
    // Nothing bound in globex: nothing to queue, and it says so.
    for (let i = 0; i < 6; i++) {
      const res = await syncNow("globex", globexOwner.cookie);
      expect(res.status, `sync ${i + 1}`).toBe(202);
      expect(await json<QueuedBody>(res)).toEqual({ queued: false, providers: [] });
    }
    // Every Stripe KPI job acme ran carries the one (workspace, provider) key the nightly
    // fan-out uses too, and the queue held at most one waiting and one running per key.
    const jobs = await running.container.db.pool.query(
      `SELECT singleton_key AS key, state::text AS state FROM pgboss.job
        WHERE name = $1 AND data->>'workspaceId' = $2 AND data->>'provider' = 'stripe'`,
      [JOB_KPI_SYNC_PROVIDER, acmeId],
    );
    expect(jobs.rows.length).toBeGreaterThan(0);
    expect(new Set(jobs.rows.map((r) => r.key))).toEqual(new Set([kpiSyncKey(acmeId, "stripe")]));
    expect(
      jobs.rows.filter((r) => ["created", "retry"].includes(r.state)).length,
    ).toBeLessThanOrEqual(1);
    expect(jobs.rows.filter((r) => r.state === "active").length).toBeLessThanOrEqual(1);
    const limited = await syncNow("globex", globexOwner.cookie);
    expect(limited.status).toBe(429);
    expect((await json<{ error: { code: string } }>(limited)).error.code).toBe("rate_limited");
  });
});
