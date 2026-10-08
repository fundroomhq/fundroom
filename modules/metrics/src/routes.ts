import { createHash } from "node:crypto";
import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { lockWorkspaceFacts, systemContext, updateWorkspaceSettingsBlock } from "@fundroom/db";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import { renderChart } from "./chart.js";
import * as s from "./contracts.js";
import { formatFixed } from "./decimal.js";
import { type Actor, MetricsError, type MetricsErrorCode } from "./errors.js";
import { type CalendarPeriodKind, formatPeriodKey, type Period, periodLabel } from "./period.js";
import type {
  DefinitionRow,
  ImportRow,
  PointRow,
  SheetConnectionRow,
  SourceBindingRow,
} from "./repos/metrics-repo.js";
import { createDefinitionService, type DefinitionService } from "./service/definitions.js";
import { createGridService, type GridService, type GridView } from "./service/grid.js";
import { createImportService, type ImportService } from "./service/import.js";
import {
  createKpiSourcesService,
  type KpiProviderView,
  type KpiSourcesService,
} from "./service/kpi-sources.js";
import type { CsvMapping } from "./service/mapping.js";
import {
  createSeriesService,
  type PeriodColumn,
  type SeriesResult,
  type SeriesService,
} from "./service/series.js";
import { createSheetsService, type SheetsService } from "./service/sheets.js";
import { CHART_TOKEN_PURPOSE, resolveChartToken } from "./tokens.js";

/*
 * `/api/v1/metrics/*` (E2.4 §9). Staff surfaces sit behind `metrics.read` / `metrics.manage` /
 * `metrics.settings`; `GET /series` is `member`, because what an investor sees is decided by
 * the metric's audience inside RLS and not by RBAC; `GET /chart/{token}.png` is public, because
 * a mail client carries no session and the capability token in the URL is the authority.
 *
 * Handlers hold no logic beyond shaping the response: the services decide, the repos touch SQL.
 * Services are built on **first use** — `moduleServicesOf` is a Proxy of thunks and touching
 * one at registration time throws against the OpenAPI generation stub
 * (`modules/analytics/src/routes.ts:58-67` is the idiom).
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
/** A route that can refuse with a 422 (`binding_period_unsupported`). */
const ERRORS_422 = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
/** The chart route answers no 401 and no 403 by design: see its own comment. */
const PUBLIC_ERRORS = errorResponses(400, 404, 429, 500, 503);
const TAGS = ["metrics"];

export const PERM_READ = "metrics.read";
export const PERM_MANAGE = "metrics.manage";
export const PERM_SETTINGS = "metrics.settings";

/**
 * `POST /sheets/sync` and `POST /sources/sync` budget: Google's quota is per project and the
 * accounting vendors' per connection, so it is the thing protected.
 */
const SYNC_RATE = { max: 6, windowMs: 60 * 60_000 } as const;

/** Any version, any variant: this filters query text before it reaches `::uuid[]`, nothing more. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Binary response shape for the OpenAPI document (the SDK treats it as a blob). */
const binaryResponse = (description: string) => ({
  description,
  content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } },
});

type Vars = ModuleEnv["Variables"];
interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!session && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
  membershipId: sg.membership.id,
  requestId: requestIdOf(c),
  sessionId: sg.session?.sessionId,
  apiKeyId: c.get("apiKey")?.id,
});

/**
 * `MetricsErrorCode` is a subset of the API vocabulary plus one of its own: `sync_failed` is a
 * remote spreadsheet refusing us, which is a dependency problem and not the caller's mistake,
 * so it surfaces as 503 rather than as a 400 that invites them to retype something correct.
 */
const API_CODE: Readonly<Record<MetricsErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  conflict: "conflict",
  validation_failed: "validation_failed",
  forbidden: "forbidden",
  sync_failed: "service_unavailable",
  binding_period_unsupported: "binding_period_unsupported",
};

function rethrow(error: unknown): never {
  if (error instanceof MetricsError) {
    throw new ApiError(API_CODE[error.code], error.message, error.details);
  }
  throw error;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function definitionBody(d: DefinitionRow) {
  return {
    id: d.id,
    key: d.key,
    name: d.name,
    description: d.description,
    unit: d.unit,
    currency: d.currency,
    aggregation: d.aggregation,
    direction: d.direction,
    periodKind: d.periodKind,
    decimals: d.decimals,
    formula: d.formula,
    display: d.display,
    audience: d.audience,
    sortOrder: d.sortOrder,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

const periodOf = (p: PointRow, definition: DefinitionRow): Period => ({
  kind: definition.periodKind,
  start: p.periodStart,
  end: p.periodEnd,
});

function pointBody(
  p: PointRow,
  definition: DefinitionRow,
  current: boolean,
  author: { readonly membershipId: string; readonly displayName: string } | null,
) {
  const period = periodOf(p, definition);
  return {
    id: p.id,
    definitionId: p.definitionId,
    periodKey: formatPeriodKey(period),
    periodLabel: periodLabel(period),
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    // Decimal string, never a JSON number (§5).
    value: formatFixed(p.value, definition.decimals),
    asOf: p.asOf.toISOString(),
    revision: p.revision,
    sourceKind: p.sourceKind,
    needsReview: p.needsReview,
    note: p.note,
    createdBy: author,
    createdAt: p.createdAt.toISOString(),
    current,
  };
}

const periodBody = (c: PeriodColumn) => ({
  key: c.key,
  label: c.label,
  start: c.period.start.toISOString(),
  end: c.period.end.toISOString(),
});

function gridBody(view: GridView) {
  const decimals = new Map(view.definitions.map((d) => [d.id, d.decimals]));
  return {
    periodKind: view.periodKind,
    periods: view.columns.map(periodBody),
    definitions: view.definitions.map(definitionBody),
    cells: view.cells.map(({ periodKey, point }) => ({
      definitionId: point.definitionId,
      periodKey,
      value: formatFixed(point.value, decimals.get(point.definitionId) ?? 0),
      revision: point.revision,
      sourceKind: point.sourceKind,
      needsReview: point.needsReview,
      note: point.note,
      asOf: point.asOf.toISOString(),
    })),
  };
}

function seriesBody(result: SeriesResult, periodKind: CalendarPeriodKind) {
  return {
    periodKind,
    periods: result.columns.map(periodBody),
    series: result.entries.map((e) => ({
      definitionId: e.definition.id,
      key: e.definition.key,
      name: e.definition.name,
      unit: e.definition.unit,
      currency: e.definition.currency,
      decimals: e.definition.decimals,
      direction: e.definition.direction,
      aggregation: e.definition.aggregation,
      values: e.values.map((v) => (v === undefined ? null : formatFixed(v, e.definition.decimals))),
    })),
  };
}

function importBody(row: ImportRow) {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    applied: row.applied,
    skipped: row.skipped,
    failed: row.failed,
    rows: row.rows as z.infer<typeof s.MetricImportRowSchema>[],
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastError: row.lastError,
  };
}

/** Never the credential and never the encryption envelope: only what the admin needs to act. */
function connectionBody(row: SheetConnectionRow) {
  return {
    id: row.id,
    spreadsheetId: row.spreadsheetId,
    range: row.range,
    mapping: row.mapping as unknown as z.infer<typeof s.MetricCsvMappingSchema>,
    serviceAccountEmail: row.serviceAccountEmail,
    status: row.status,
    enabled: row.enabled,
    lastSyncAt: iso(row.lastSyncAt),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function bindingBody(b: SourceBindingRow) {
  return {
    id: b.id,
    definitionId: b.definitionId,
    provider: b.provider,
    sourceMetric: b.sourceMetric,
    enabled: b.enabled,
    status: b.status,
    lastSyncAt: iso(b.lastSyncAt),
    lastSuccessAt: iso(b.lastSuccessAt),
    lastError: b.lastError,
    consecutiveFailures: b.consecutiveFailures,
    historyFrom: b.historyFrom,
    historyNote: b.historyNote,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

const kpiProviderBody = (p: KpiProviderView) => ({
  provider: p.provider,
  connected: p.connected,
  status: p.status,
  accountLabel: p.accountLabel,
  lastSuccessAt: iso(p.lastSuccessAt),
  lastError: p.lastError,
  metrics: p.metrics.map((m) => ({ ...m })),
});

export function registerMetricsRoutes(api: ModuleRouter, services: ModuleServices): void {
  // Built on first use: nothing may be constructed at registration time.
  let definitions: DefinitionService | undefined;
  let grid: GridService | undefined;
  let series: SeriesService | undefined;
  let imports: ImportService | undefined;
  let sheets: SheetsService | undefined;
  let kpi: KpiSourcesService | undefined;
  const definitionSvc = () => (definitions ??= createDefinitionService(services));
  const gridSvc = () => (grid ??= createGridService(services));
  const seriesSvc = () => (series ??= createSeriesService(services));
  const importSvc = () => (imports ??= createImportService(services));
  const sheetsSvc = () => (sheets ??= createSheetsService(services));
  const kpiSvc = () => (kpi ??= createKpiSourcesService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();

  // --- definitions ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/definitions",
      tags: TAGS,
      summary: "Every metric this workspace defines",
      description:
        "Grid order (`sortOrder`, then `key`). Staff see every metric whatever its audience: the admin screen badges the audience, so hiding rows would hide the thing the screen manages.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      responses: { 200: jsonResponse(s.MetricDefinitionListSchema, "Definitions"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const rows = await definitionSvc().list(sg.tenant);
      return c.json({ definitions: rows.map(definitionBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/definitions",
      tags: TAGS,
      summary: "Define a metric",
      description:
        "A `formula` makes the metric derived: it is recomputed from its inputs whenever one of them moves, and it aggregates `last` because a formula is evaluated per period. A formula naming a metric that does not exist, or one that would make this metric depend on itself, is refused with the offending key.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateDefinitionBody) },
      responses: { 201: jsonResponse(s.MetricDefinitionSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const created = await definitionSvc().create(sg.tenant, body, actorOf(c, sg));
        return c.json(definitionBody(created), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/definitions/{id}",
      tags: TAGS,
      summary: "One metric definition",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.DefinitionIdParams },
      responses: { 200: jsonResponse(s.MetricDefinitionSchema, "Definition"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await definitionSvc().get(sg.tenant, c.req.valid("param").id);
        return c.json(definitionBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/definitions/{id}",
      tags: TAGS,
      summary: "Change a metric's name, unit, display, audience or formula",
      description:
        "`key` is deliberately not patchable: a CSV column map, a formula reference and a chart token all address a metric by its key, so renaming one is a migration of other people's stored data rather than a field edit.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.DefinitionIdParams, body: jsonBody(s.PatchDefinitionBody) },
      responses: { 200: jsonResponse(s.MetricDefinitionSchema, "Definition"), ...ERRORS_422 },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await definitionSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          body,
          actorOf(c, sg),
        );
        return c.json(definitionBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/definitions/{id}",
      tags: TAGS,
      summary: "Remove a metric (soft; its points stay for the record)",
      description:
        "Refused while another metric's formula still reads this one — that formula would silently stop producing points. The points themselves are kept: a figure an investor was shown did not stop having been shown.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.DefinitionIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await definitionSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- points -----------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/definitions/{id}/points",
      tags: TAGS,
      summary: "One metric's series, or one period's full restatement history",
      description:
        "Without `periodKey` this is the live series (`metrics.point_current`), newest revision of each period. With `periodKey` it is **every** revision of that one cell, newest first: both rows of a restatement, each with its own source and `createdAt`, which is what makes a restatement provable rather than merely claimed.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.DefinitionIdParams, query: s.PointsQuery },
      responses: { 200: jsonResponse(s.MetricPointListSchema, "Points"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      try {
        const history = await gridSvc().history(sg.tenant, id, {
          ...(q.periodKey === undefined ? {} : { periodKey: q.periodKey }),
          ...(q.from === undefined ? {} : { from: new Date(q.from) }),
          limit: q.limit,
        });
        return c.json(
          {
            points: history.points.map(({ point, current, author }) =>
              pointBody(point, history.definition, current, author),
            ),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/definitions/{id}/points",
      tags: TAGS,
      summary: "Write one metric's values for a set of periods",
      description:
        "Same rules as the grid: `value: null` writes nothing (it is not a zero and not a delete), a value equal to the live point writes nothing, and a value that differs writes revision + 1 and supersedes the old row. Derived metrics are refused — edit their inputs.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { params: s.DefinitionIdParams, body: jsonBody(s.PutPointsBody) },
      responses: { 200: jsonResponse(s.MetricWriteResultSchema, "Written"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const outcome = await gridSvc().savePoints(
          sg.tenant,
          c.req.valid("param").id,
          body.points,
          actorOf(c, sg),
        );
        return c.json({ ...outcome, definitionIds: [...outcome.definitionIds] }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- the period grid --------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/grid",
      tags: TAGS,
      summary: "The period grid: metrics down, periods across",
      description:
        "Only the metrics reported at the requested period kind are rows — a quarterly metric has no March column, and a row of blanks would read as 'nobody has entered this yet'. `cells` is sparse: a period with no live point is simply absent, never a zero.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { query: s.GridQuery },
      responses: { 200: jsonResponse(s.MetricGridSchema, "Grid"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const view = await gridSvc().read(sg.tenant, {
        periodKind: q.periodKind,
        periods: q.periods,
        ...(q.end === undefined ? {} : { end: new Date(q.end) }),
      });
      return c.json(gridBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/grid",
      tags: TAGS,
      summary: "Save the grid",
      description:
        "A sparse array of cells. `value: null` means 'no point for this cell' and writes nothing; a cell equal to the live point writes nothing, so re-saving the grid is not a restatement storm; a cell that differs writes revision + 1, supersedes the old row and records the restatement — all in one transaction.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.PutGridBody) },
      responses: { 200: jsonResponse(s.MetricWriteResultSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const outcome = await gridSvc().save(
          sg.tenant,
          {
            periodKind: body.periodKind,
            cells: body.cells,
            ...(body.note === undefined ? {} : { note: body.note }),
          },
          actorOf(c, sg),
        );
        return c.json({ ...outcome, definitionIds: [...outcome.definitionIds] }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- the investor-facing read -----------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/series",
      tags: TAGS,
      summary: "The metrics this reader may see, as a series",
      description:
        "`member`, not a permission: what an investor sees is decided by each metric's audience inside RLS, not by RBAC. Staff calling it see everything, which is why the admin screens use `/grid` and `/definitions` instead. `null` in `values` is a gap, never a zero.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: s.SeriesQuery },
      responses: { 200: jsonResponse(s.MetricSeriesSchema, "Series"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      /*
       * `ids` is comma-separated text straight off the query string, and anything that is not
       * a uuid reached Postgres as one: `?ids=abc` raised `22P02`, which is not a `MetricsError`
       * and so left this member-facing route as a 500 that any investor could trigger. Malformed
       * ids are **dropped**, not reported — the same rule the hydrator already follows for an id
       * a reader may not see, and for the same reason: what comes back must not say anything
       * about what did not.
       */
      const requested = q.ids
        ?.split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .slice(0, 60);
      // An `ids` naming nothing well-formed asks for those metrics and gets them: none. Only an
      // absent (or empty) parameter means "every metric this reader may see".
      const ids =
        requested === undefined || requested.length === 0
          ? undefined
          : requested.filter((x) => UUID_RE.test(x));
      const result = await seriesSvc().read(sg.tenant, {
        periodKind: q.periodKind,
        periods: q.periods,
        ...(q.end === undefined ? {} : { end: new Date(q.end) }),
        ...(ids === undefined ? {} : { ids }),
      });
      return c.json(seriesBody(result, q.periodKind), 200);
    },
  );

  // --- CSV import -------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/import/dry-run",
      tags: TAGS,
      summary: "Preview a CSV import without writing anything",
      description:
        "The CSV is pasted text in a JSON body, not multipart. Every row comes back with a status and a machine-readable reason (`unreadable_period`, `duplicate_period`, `not_a_number`, `unknown_metric`, `too_many_rows:<n>`, …), and `columns` is the normalised header so a mapping that names no real column can be corrected.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.MetricCsvBody) },
      responses: { 200: jsonResponse(s.MetricCsvDryRunResultSchema, "Preview"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const result = await importSvc().dryRun(
          sg.tenant,
          body.csv,
          body.mapping as unknown as CsvMapping,
        );
        return c.json(
          {
            rows: result.rows.map((r) => ({ ...r, cells: r.cells.map((cell) => ({ ...cell })) })),
            summary: result.summary,
            columns: [...result.columns],
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags: TAGS,
      summary: "Start a CSV import",
      description:
        "Stores the validated plan and enqueues the worker, which applies one line at a time and is safe to redeliver. Refused when no row has a usable value: a job that finishes having written nothing looks like success, and the admin would go looking for their numbers instead of at their mapping.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.MetricCsvBody) },
      responses: { 200: jsonResponse(s.MetricImportSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await importSvc().start(
          sg.tenant,
          {
            csv: body.csv,
            mapping: body.mapping as unknown as CsvMapping,
            ...(body.note === undefined ? {} : { note: body.note }),
          },
          actorOf(c, sg),
        );
        return c.json(importBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/import/{id}",
      tags: TAGS,
      summary: "Progress and per-row results of a CSV import",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.ImportIdParams },
      responses: { 200: jsonResponse(s.MetricImportSchema, "Import"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(importBody(await importSvc().get(sg.tenant, c.req.valid("param").id)), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- Google Sheets ----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/sheets",
      tags: TAGS,
      summary: "The workspace's Google Sheet connection",
      description:
        "Never the credential: only the spreadsheet, the range, the mapping, the service-account address to share the sheet with, and how the last sync went.",
      security: sessionSecurity,
      "x-requires": PERM_SETTINGS,
      middleware: [perm(PERM_SETTINGS)] as const,
      responses: {
        200: jsonResponse(s.MetricSheetConnectionEnvelopeSchema, "Connection"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      const row = await sheetsSvc().get(sg.tenant);
      return c.json({ connection: row === undefined ? null : connectionBody(row) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/sheets",
      tags: TAGS,
      summary: "Connect a Google Sheet (service account)",
      description:
        "Paste the service-account JSON Google generated; the private key is envelope-encrypted under the workspace data key and the account's address is returned so you can share the sheet with it. The spreadsheet id, the A1 range and the JSON are all validated **before** anything is stored, so a typo fails here rather than at 04:35 in a cron job. A mapping that names a metric fed by a KPI integration is refused with 409 `conflict`, `reason: source_overlap` — one source per metric.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { body: jsonBody(s.PutSheetsBody) },
      responses: { 200: jsonResponse(s.MetricSheetConnectionSchema, "Connected"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await sheetsSvc().put(
          sg.tenant,
          { ...body, mapping: body.mapping as unknown as CsvMapping },
          actorOf(c, sg),
        );
        return c.json(connectionBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/sheets",
      tags: TAGS,
      summary: "Disconnect the Google Sheet",
      description:
        "Drops the stored credential. The points it already wrote stay: they were true when they were written, and their source rows still say where they came from.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      responses: { 200: jsonResponse(OkSchema, "Disconnected"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await sheetsSvc().remove(sg.tenant, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/sheets/sync",
      tags: TAGS,
      summary: "Pull the sheet now",
      description:
        "Rate limited to 6 an hour: Google's quota is per project, so it is the thing being protected. A value that differs from a point somebody typed by hand is written as a new revision flagged `needsReview` — never a silent overwrite.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      responses: { 200: jsonResponse(s.MetricSheetSyncResultSchema, "Synced"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const limit = await services.rateLimiter.hit(
        `metrics.sheets_sync:${sg.workspace.id}`,
        SYNC_RATE,
      );
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many syncs", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      try {
        return c.json(await sheetsSvc().sync(sg.tenant, actorOf(c, sg)), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- KPI sources (E3.6 §5) -------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/sources",
      tags: TAGS,
      summary: "KPI integrations and the metrics bound to them",
      description:
        "One entry per KPI provider (QuickBooks Online, Xero, Stripe): whether it is connected (connections are managed under `/integrations`), its health, and the series it offers. `bindings` lists every metric fed by one of them with the health of its last sync. Never a credential.",
      security: sessionSecurity,
      "x-requires": PERM_SETTINGS,
      middleware: [perm(PERM_SETTINGS)] as const,
      responses: { 200: jsonResponse(s.MetricKpiSourcesSchema, "Sources"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const view = await kpiSvc().overview(sg.tenant);
      return c.json(
        {
          providers: view.providers.map(kpiProviderBody),
          bindings: view.bindings.map(bindingBody),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/definitions/{id}/binding",
      tags: TAGS,
      summary: "Feed a metric from a KPI integration",
      description:
        "Binds a monthly, non-formula metric to one series of a provider (`revenue`, `mrr`, …) — anything else is refused with 422 `binding_period_unsupported`. A metric the Google Sheet mapping already feeds is refused with 409 `conflict`, `reason: source_overlap` (and `PUT /sheets` refuses a mapping naming a bound metric the same way). The series' unit must match the metric's (money feeds a currency metric, a count a count metric). A connection is not required yet; the nightly sync (04:55 UTC) records `not connected` until there is one. A synced value that differs from a hand-typed one is written as a new revision flagged `needsReview`.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { params: s.DefinitionIdParams, body: jsonBody(s.PutKpiBindingBody) },
      responses: { 200: jsonResponse(s.MetricKpiBindingSchema, "Bound"), ...ERRORS_422 },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await kpiSvc().putBinding(
          sg.tenant,
          c.req.valid("param").id,
          body,
          actorOf(c, sg),
        );
        return c.json(bindingBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/definitions/{id}/binding",
      tags: TAGS,
      summary: "Stop feeding a metric from a KPI integration",
      description:
        "The points the integration already wrote stay: they were true when they were written, and their source rows still say where they came from.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { params: s.DefinitionIdParams },
      responses: { 200: jsonResponse(OkSchema, "Unbound"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await kpiSvc().removeBinding(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/sources/sync",
      tags: TAGS,
      summary: "Queue a KPI sync now",
      description:
        'Never reads a vendor inline — a Stripe backfill can take many minutes. Enqueues one sync job per provider with an enabled binding (the same jobs and per-(workspace, provider) keys the nightly 04:55 UTC sweep uses, so at most one is queued and one running per provider) and answers 202 `{queued, providers}` (`queued: false` when nothing is bound); poll `GET /sources` for each binding\'s `status`, `lastSyncAt`, `lastError`, `historyFrom` and `historyNote`. Rate limited to 6 an hour. A job reads the trailing 3 months for bindings that have synced before and 24 for new ones; a backfill too large to read falls back to 3 months (`historyNote` says so); a refused credential, `rate_limited` or `unavailable` fails the provider once; other failures are retried per series; an aborted read, or anything not started within 20 minutes, is left with `lastError: "deferred to next sync"` and read first next time. Nobody is mailed on failure.',
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      responses: { 202: jsonResponse(s.MetricKpiSyncQueuedSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const limit = await services.rateLimiter.hit(
        `metrics.kpi_sync:${sg.workspace.id}`,
        SYNC_RATE,
      );
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many syncs", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      const providers = await kpiSvc().requestSync(sg.tenant, actorOf(c, sg));
      return c.json({ queued: providers.length > 0, providers }, 202);
    },
  );

  // --- settings ---------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "Metric defaults (reporting currency, period)",
      description:
        "Two fields, and the shortness is the design: unit, decimals, aggregation, direction and audience all belong on the *definition*, because two metrics in one workspace legitimately disagree about every one of them. These only decide what the 'new metric' form opens on.",
      security: sessionSecurity,
      "x-requires": PERM_SETTINGS,
      middleware: [perm(PERM_SETTINGS)] as const,
      responses: { 200: jsonResponse(s.MetricsSettingsSchema, "Settings"), ...ERRORS },
    }),
    (c) => c.json(parseWorkspaceSettings(signed(c).workspace.settings).metrics, 200),
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change the metric defaults",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { body: jsonBody(s.MetricsSettingsPatchBody) },
      responses: { 200: jsonResponse(s.MetricsSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const patch = c.req.valid("json");
      const next = await services.db.withTenant(sg.tenant, async (tx) => {
        // The `metrics` block alone, merged on the row-locked copy (A-3 R2 M1): never the request's
        // cached settings, never the whole document — a concurrent writer of another block keeps
        // its change. Row lock first, audit last (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, sg.workspace.id))?.settings,
        );
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          metrics: { ...current.metrics, ...patch },
        });
        await updateWorkspaceSettingsBlock(tx, sg.workspace.id, "metrics", next.metrics);
        await services.audit.record(tx, sg.tenant, {
          action: "metrics.settings_changed",
          resourceKind: "workspace",
          resourceId: sg.workspace.id,
          actorMembershipId: sg.membership.id,
          requestId: requestIdOf(c),
          meta: { fields: Object.keys(patch) },
        });
        return next;
      });
      services.workspaces.invalidate(sg.workspace.id);
      return c.json(next.metrics, 200);
    },
  );

  // --- the chart image (public, capability-addressed) -------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/chart/{token}.png",
      tags: TAGS,
      summary: "A chart of the metrics a capability token names (public)",
      description:
        "What an update email's `<img src>` points at; a mail client carries no session, so the signed token in the URL is the authority. The token names the **set of metrics an audience may see**, never a reader, so everyone in a send who sees the same metrics shares one URL — which is what keeps the image from being a tracking pixel. Unknown, expired and badly-signed tokens all answer 404.",
      "x-requires": "public",
      /*
       * Declared by hand rather than through `request.params`. **Do not "tidy" this into a
       * zod `params` schema**: every chart image would then answer 400, with nothing in the
       * logs to say why, and the only symptom would be broken images in already-sent mail.
       *
       * `@hono/zod-openapi` rewrites `{token}` to Hono's `:token`, and Hono reads `:token.png`
       * as a parameter *named* `token.png` that captures the whole segment — so a zod `params`
       * schema for `token` never receives a value and every request would 400 before the
       * handler ran. Declaring the parameter here keeps the path template valid OpenAPI (and
       * Schemathesis happy) while the handler reads the raw segment and strips the extension.
       * The same quirk means the pattern matches any segment, so the `.png` suffix is checked
       * below rather than by the router.
       */
      parameters: [
        {
          name: "token",
          in: "path",
          required: true,
          description: "Capability token minted at send time; `base64url(payload).base64url(hmac)`",
          // base64url segments joined by `.`, under 1000 characters (at most CHART_MAX_SERIES
          // ids). The bound keeps the request line inside the HTTP server's 16 KiB head limit
          // whatever is sent; past it the server answers 431 before any route runs.
          schema: { type: "string", maxLength: 1024, pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" },
        },
      ],
      responses: {
        200: binaryResponse("The chart"),
        304: { description: "Not modified (`If-None-Match` matched)" },
        ...PUBLIC_ERRORS,
      },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const raw = c.req.param("token.png") ?? c.req.param("token") ?? "";
      /*
       * One wire status for every refusal — malformed, wrong signature, expired, wrong
       * workspace, unknown id. The route is public and a distinguishable failure is an oracle:
       * E2.2 shipped exactly that bug on the handoff route (`unknown_key` vs `bad_signature`)
       * and had to collapse the two. The reason survives in the log, where only an operator
       * reads it.
       */
      const refuse = (reason: string): never => {
        services.log("metrics.chart_refused", { workspaceId: workspace.id, reason });
        throw new ApiError("not_found", "no such chart");
      };
      if (!raw.endsWith(".png")) return refuse("not_png");
      const token = raw.slice(0, -4);

      const etag = `"${createHash("sha256").update(token).digest("hex").slice(0, 32)}"`;
      const headers = {
        // Immutable by construction: the token pins the metrics, the periods and `asOf`, so the
        // bytes for one URL can never change. That is what lets the 304 answer without a render.
        "Cache-Control": "public, max-age=86400, immutable",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
        // Mail clients and webmail fetch this from another origin; the default CORP would block it.
        "Cross-Origin-Resource-Policy": "cross-origin",
      };

      const ctx = systemContext(workspace.id);
      /*
       * Select the key the token names, then verify under it — never the other way round, and
       * never "whatever key is current". `crypto.rotate` is a routine act and `crypto.rewrap`
       * runs nightly, so verifying against the current key would make a rotation silently 404
       * every chart image in every update ever sent, for 180 days, with a well-formed token
       * and a 404 that says nothing. The purpose check lives in this closure: a key minted for
       * unsubscribe links must come back as "no such key", not as a key that fails to match.
       */
      const resolved = await resolveChartToken(token, services.now(), async (kid) =>
        services.db.withTenant(ctx, async (tx) => {
          const found = await services.crypto.keyById(tx, ctx, kid);
          return found?.purpose === CHART_TOKEN_PURPOSE ? found : undefined;
        }),
      );
      if (!resolved.ok) return refuse(resolved.reason);
      const payload = resolved.payload;
      if (payload.w !== workspace.id) return refuse("wrong_workspace");
      const asOf = new Date(payload.asOf);
      if (Number.isNaN(asOf.getTime())) return refuse("bad_as_of");

      /*
       * **Verify first, 304 second.** The ETag hashes the token, so a matching `If-None-Match`
       * used to answer 304 before `resolveChartToken` ran — and an expired token, a forged one,
       * a token for another workspace and the literal string `zzz` all revalidated successfully
       * for ever. With `Cache-Control: public` that is an image proxy re-serving a chart past
       * its 180-day `exp` indefinitely, while §9.1 says an email read a year later gets a 404.
       * Nothing is rasterised on a cache hit either way: verification is an HMAC and one key
       * read, and the render below is what the 304 exists to skip.
       */
      if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers) as never;

      /*
       * **No audience check here, and that is deliberate.** `payload.d` was already filtered
       * against the audience at send time, so the capability *is* the filter (decision D5). A
       * per-reader check would need a reader, and a URL that identifies one reader is the
       * tracking pixel this product does not ship. A reader looking for the missing check
       * should read that decision before adding one: putting it back would break the
       * shared-URL property, not tighten anything.
       *
       * The context is therefore `system`, and the read is as-of: per period, the highest
       * revision created on or before `asOf`, so a restatement made afterwards does not
       * rewrite a picture somebody already has in their inbox.
       */
      const read = await seriesSvc().read(
        ctx,
        { periodKind: payload.k, periods: payload.n, end: asOf, ids: payload.d },
        asOf,
      );
      /*
       * Back into the token's own order. `read` resolves ids through `DefinitionRepo.byIds`,
       * which is `ORDER BY sort_order, key` — the *editor's* order, not the block's — while the
       * `alt` text travelled with the mail was built by the hydrator from `d` in block order,
       * and `buildChartSpec` takes the y axis's unit, currency, decimals and accent colour from
       * the first entry. Rebuilding in a different order therefore produced a picture whose y
       * axis was in a different unit from the sentence describing it: an `alt` reading
       * "Cash: $1.2M … Churn: 3%" against an axis labelled in percent. The token already
       * carries the order the `alt` was written for, so it is the order that is drawn.
       */
      const byId = new Map(read.entries.map((e) => [e.definition.id, e]));
      const entries = payload.d.flatMap((id) => {
        const entry = byId.get(id);
        return entry === undefined ? [] : [entry];
      });
      const result: SeriesResult = { columns: read.columns, entries };
      if (result.entries.length === 0) return refuse("no_series");

      const branding = parseWorkspaceSettings(workspace.settings).branding;
      /*
       * Rasterised at twice the CSS size. The email declares 600 × 300 **CSS** pixels and
       * clamps them to its 536 px body column, so a 1× bitmap is soft on every retina display
       * an investor reads mail on and doubling it costs the email side nothing. It does not
       * disturb the ETag either, which hashes the token rather than the bytes.
       */
      const chart = await renderChart(
        services.renderer,
        {
          columns: result.columns,
          entries: result.entries,
          accentColor: branding.accentColor,
        },
        2,
      );
      return c.body(chart.image.bytes as unknown as ArrayBuffer, 200, {
        ...headers,
        "Content-Type": chart.image.contentType,
        "Content-Length": String(chart.image.bytes.byteLength),
      }) as never;
    },
  );
}
