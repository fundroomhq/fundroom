import { defineModule, type ModuleManifest, type ModuleServices } from "@fundroom/module-kit";
import { createKpisContextProvider } from "./ai-context.js";
import { metricsDsar } from "./dsar.js";
import { createMetricGridHydrator } from "./hydrator.js";
import { createMetricsJobs } from "./jobs.js";
import { metricsPortability } from "./portability.js";
import { registerMetricsRoutes } from "./routes.js";
import { createRecomputeHandler } from "./service/recompute.js";

/*
 * KPIs (E2.4, EXECUTION_PLAN §15, design/03 §157, design/06 §7, ADR-0042): the numbers a
 * founder publishes to their investors — headcount, ARR, runway — entered by hand, imported
 * from a CSV, synced from a Google Sheet or derived from the others by formula, each with its
 * own audience and a history that records every restatement.
 *
 * This is the **first genuine optional module package of Phase 2**, and it is worth saying why
 * after E2.1, E2.2 and E2.3 all went kernel. Those three owned something the kernel reads
 * before there is a module to ask: a routing decision made inside the tenant classifier, a
 * `frame-ancestors` header resolved before the handler runs, a table whose rows mint a
 * membership. Metrics owns none of that. Every fact it has lives in its own `metrics` schema,
 * nothing in tenant resolution or in a security header reads it, and a workspace that never
 * publishes a number should not carry the tables — so `defaultEnabled: false` (design/03 §157
 * lists KPIs off by default).
 *
 * `dependsOn` names `content` as well as `access` because the module registers the
 * `metric_grid` block hydrator, which only means something when there is a page to put it on.
 *
 * There is deliberately **no** `offeringStatusRules`. A KPI is not an offer: an
 * `informational` workspace — one that may describe itself but not solicit — may publish its
 * headcount, and hiding the numbers in that state would confuse "this company is not raising"
 * with "this company will not say how it is doing".
 */
/*
 * `services` is captured when the routes are mounted, the way `modules/content` does it for the
 * disclaimer hydrator: the manifest is a value, so a hydrator and an outbox subscriber — both
 * of which are declared *on* it — cannot be handed the composition root any earlier.
 *
 * The guard is ours and the reason is worth stating. `generateOpenApiDocument()` builds a whole
 * second API app against `stubDeps()`, whose `ModuleServices` is a Proxy that throws on every
 * property read; it runs on each `GET /api/v1/openapi.json`, i.e. at runtime on a live server.
 * Capturing unconditionally would therefore let one request for the contract replace the real
 * services with the throwing stub, and the next content page carrying a `metric_grid` block
 * would fail to hydrate. Reading one property is enough to tell them apart, and a registration
 * against the stub is simply ignored.
 */
let registeredServices: ModuleServices | undefined;

function captureServices(services: ModuleServices): void {
  try {
    void services.db;
  } catch {
    return;
  }
  registeredServices = services;
}

function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("metrics routes are not registered");
  return registeredServices;
}

export const metricsModule: ModuleManifest = defineModule({
  id: "metrics",
  version: "0.1.0",
  dsar: metricsDsar,
  portability: metricsPortability,
  dependsOn: ["access", "content"],
  schema: "metrics",
  migrations: new URL("../migrations/", import.meta.url),
  defaultEnabled: false,
  permissions: ["metrics.read", "metrics.manage", "metrics.settings"],
  routes: (api, services) => {
    captureServices(services);
    registerMetricsRoutes(api, services);
  },
  jobs: createMetricsJobs,
  /*
   * The module subscribes to **its own** topic (§6). Writing points announces them once; this
   * handler recomputes every derived definition whose formula reads one of them, in dependency
   * order, in a single pass — so it deliberately does not re-publish, and a metric derived from
   * a derived metric is correct after one event rather than after N.
   */
  events: {
    emits: ["metric.points_changed", "metric.restated"],
    handles: { "metric.points_changed": createRecomputeHandler(liveServices) },
  },
  // E3.4: outbound webhook topic.
  webhooks: ["metric.points_changed"],
  aiContextProviders: (services) => [createKpisContextProvider(services)], // E3.12 `kpis`
  blockHydrators: [
    {
      type: "metric_grid",
      // `async` so a module that is somehow not registered rejects rather than throwing into
      // the renderer's synchronous call site; `BlockHydrator.hydrate` promises a Promise.
      hydrate: async (data, ctx) => createMetricGridHydrator(liveServices()).hydrate(data, ctx),
    },
  ],
  slots: {
    "investor.nav": [
      // Under Updates (10) and the data room (20): a reader looks at "what did they send me"
      // and "what can I read" before "how is the company doing", and the KPIs are the thing
      // they come back to rather than the thing they arrive for.
      // `/kpis`, not the module id (E-UP-18 D3): `/metrics` is the server's ops endpoint
      // (Prometheus) on every host, so a reload or a bookmark of it never reaches the SPA.
      { id: "metrics", label: "KPIs", to: "/kpis", order: 30, icon: "metrics" },
    ],
    "admin.nav": [
      // 35 is the first free slot after the data room (30) and before notifications (45);
      // content 10, access 20/21, compliance 22, branding 23, domains 24, embed/updates 25,
      // share links 26, analytics 46.
      { id: "metrics-admin", label: "KPIs", to: "/admin/metrics", order: 35, icon: "metrics" },
    ],
    // E2.7: the settings hub lists this. `metrics.settings` governs the spreadsheet sources,
    // which is where the KPI screen's own "Settings" link goes.
    "admin.settings": [
      {
        id: "metrics-settings",
        label: "KPI sources",
        to: "/admin/metrics/sheets",
        order: 43,
        icon: "metrics",
      },
    ],
    // Declaring the block type is what makes the content editor offer it; `blockHydrators`
    // above is what fills it in for a reader.
    "content.blocks": ["metric_grid"],
  },
});

export default metricsModule;

export {
  buildChartSpec,
  CHART_HEIGHT,
  CHART_PALETTE,
  CHART_SERIES_COLOURS,
  CHART_WIDTH,
  type ChartEntry,
  type ChartInput,
  formatTick,
  type RenderedChart,
  renderChart,
} from "./chart.js";
export * from "./contracts.js";
export {
  add,
  div,
  formatFixed,
  MAX_DECIMALS,
  MIN_DECIMALS,
  mul,
  parseFixed,
  SCALE,
  SCALE_DECIMALS,
  sub,
} from "./decimal.js";
export { metricsDsar } from "./dsar.js";
export { type Actor, MetricsError, type MetricsErrorCode } from "./errors.js";
export {
  evaluate,
  FORMULA_MAX_DEPTH,
  FORMULA_MAX_REFS,
  FORMULA_SCHEMA_VERSION,
  type Formula,
  FormulaSchema,
  referencedKeys,
  wouldCycle,
} from "./formula.js";
export {
  createMetricGridHydrator,
  definitionIdsOf,
  type MetricGridChart,
  type MetricGridHydrated,
  type MetricGridTile,
  SPARKLINE_PERIODS,
} from "./hydrator.js";
export {
  createMetricsJobs,
  JOB_IMPORT,
  JOB_KPI_SYNC,
  JOB_KPI_SYNC_PROVIDER,
  JOB_SHEETS_SYNC,
  KPI_SYNC_CRON,
  kpiSyncKey,
  SHEETS_SYNC_CRON,
} from "./jobs.js";
export {
  AGGREGATIONS,
  type Aggregation,
  AUDIENCE_SCHEMA_VERSION,
  audienceAdmits,
  DEFAULT_AUDIENCE,
  DIRECTIONS,
  type Direction,
  IMPORT_STATUSES,
  type ImportStatus,
  KPI_PROVIDERS,
  type KpiProvider,
  METRIC_KEY_RE,
  type MetricAudience,
  MetricAudienceSchema,
  type MetricReader,
  parseAudience,
  SOURCE_KINDS,
  type SourceKind,
  SYNC_STATUSES,
  type SyncStatus,
  UNIT_KINDS,
  type UnitKind,
} from "./model.js";
export {
  type CalendarPeriodKind,
  formatPeriodKey,
  PERIOD_KINDS,
  type Period,
  type PeriodKind,
  parsePeriodKey,
  periodFor,
  periodLabel,
  periodSeries,
} from "./period.js";
export {
  exportSheetConnectionRow,
  IMPORT_INTERRUPTED,
  importImportRow,
  importSheetConnectionRow,
  importSourceBindingRow,
  metricsPortability,
  SHEETS_RECONNECT,
} from "./portability.js";
export {
  type DefinitionPatch,
  DefinitionRepo,
  type DefinitionRow,
  type ImportProgress,
  ImportRepo,
  type ImportRow,
  type NewDefinition,
  type NewPoint,
  type NewSource,
  PointRepo,
  type PointRow,
  readMetricsSettings,
  type SheetConnectionInput,
  SheetConnectionRepo,
  type SheetConnectionRow,
  SourceBindingRepo,
  type SourceBindingRow,
  SourceRepo,
} from "./repos/metrics-repo.js";
export { PERM_MANAGE, PERM_READ, PERM_SETTINGS, registerMetricsRoutes } from "./routes.js";
export {
  createDefinitionService,
  type DefinitionInput,
  type DefinitionService,
} from "./service/definitions.js";
export {
  createGridService,
  type GridCellInput,
  type GridService,
  type GridView,
  type PointHistory,
} from "./service/grid.js";
export {
  createImportService,
  type DryRunResult,
  type ImportDefaults,
  type ImportService,
  METRICS_IMPORT_MAX_ROWS,
} from "./service/import.js";
export {
  bindable,
  CONFLICT_RETRY,
  createKpiSourcesService,
  DEFERRED,
  HISTORY_TOO_LARGE,
  KPI_BACKFILL_MONTHS,
  KPI_READ_BUDGET_MS,
  KPI_TRAILING_MONTHS,
  type KpiProviderSyncOutcome,
  type KpiProviderView,
  type KpiSourcesService,
  type KpiSourcesView,
  type KpiSyncOutcome,
  NOT_CONNECTED,
  type PutBindingInput,
  planKpiCells,
  SOURCE_OVERLAP,
  sheetMappingKeys,
} from "./service/kpi-sources.js";
export {
  type CsvMapping,
  type ImportPlan,
  type PlannedCell,
  type PlannedRow,
  type PlanSummary,
  planImport,
  summarise,
} from "./service/mapping.js";
export {
  type ApplyInput,
  announcePointsChanged,
  applyCells,
  type CellWrite,
  type ReviewPolicy,
  type WriteOutcome,
} from "./service/points.js";
export {
  createRecomputeHandler,
  dependencyOrder,
  RECOMPUTE_WINDOW_PERIODS,
  type RecomputeResult,
  recompute,
} from "./service/recompute.js";
export {
  alignSeries,
  createSeriesService,
  foldValues,
  type PeriodColumn,
  periodColumns,
  type SeriesEntry,
  type SeriesResult,
  type SeriesService,
} from "./service/series.js";
export {
  createSheetsService,
  type PutSheetsInput,
  SHEETS_KEY_PURPOSE,
  type SheetSyncOutcome,
  type SheetsService,
} from "./service/sheets.js";
export {
  CHART_MAX_SERIES,
  CHART_TOKEN_PURPOSE,
  CHART_TOKEN_TTL_DAYS,
  type ChartTokenPayload,
  decodeChartToken,
  signChartToken,
  verifyChartToken,
} from "./tokens.js";
