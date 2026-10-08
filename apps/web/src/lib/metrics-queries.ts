import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Queries for the KPI module (E2.4 §9): the admin catalogue and period grid, the per-cell
 * revision history, the CSV import job, the Sheets connection and settings, and the
 * investor-facing series.
 *
 * Every numeric value on these types is a decimal **string**, not a number. `numeric(20, 6)`
 * does not survive a round trip through a double (contract §5) and a KPI is exactly the place
 * somebody would notice; `parseValue` below is the one place the web app turns one into a
 * float, and it does so only to draw a picture of it.
 */
export type MetricDefinition = FundRoomSchemas["MetricDefinition"];
/**
 * A definition as the screens read it.
 *
 * `formula` is deliberately not in it. §6's formula is a recursive tree, and the generated
 * type is correspondingly self-referential; TypeScript's structural comparison hits its
 * recursion limit on it and then reports two *identical* `MetricDefinition`s as "two
 * different types with this name … unrelated" the moment one of them has passed through a
 * generic — which `useQuery(...).data` always has. Nothing in the web app edits or evaluates
 * a formula (a derived metric is computed server-side and refuses a hand-typed value,
 * C-B.8), so narrowing it away here keeps that depth out of the UI entirely rather than
 * sprinkling casts at every prop.
 */
export type MetricDefinitionView = Omit<FundRoomSchemas["MetricDefinition"], "formula">;
export type MetricAudience = FundRoomSchemas["MetricAudience"];
export type MetricGrid = FundRoomSchemas["MetricGrid"];
export type MetricGridCell = FundRoomSchemas["MetricGridCell"];
export type MetricPeriod = FundRoomSchemas["MetricPeriod"];
export type MetricPoint = FundRoomSchemas["MetricPoint"];
export type MetricSeries = FundRoomSchemas["MetricSeries"];
export type MetricSeriesEntry = FundRoomSchemas["MetricSeriesEntry"];
export type MetricImport = FundRoomSchemas["MetricImport"];
export type MetricImportRow = FundRoomSchemas["MetricImportRow"];
export type MetricCsvDryRunResult = FundRoomSchemas["MetricCsvDryRunResult"];
export type MetricCsvMapping = FundRoomSchemas["MetricCsvMapping"];
export type MetricSheetConnection = FundRoomSchemas["MetricSheetConnection"];
export type MetricsSettings = FundRoomSchemas["MetricsSettings"];
export type MetricWriteResult = FundRoomSchemas["MetricWriteResult"];
export type MetricUnit = MetricDefinition["unit"];
export type MetricDirection = MetricDefinition["direction"];
export type MetricAggregation = MetricDefinition["aggregation"];
export type CalendarPeriodKind = MetricGrid["periodKind"];

export const UNIT_KINDS = ["currency", "count", "percent", "ratio", "days", "months"] as const;
export const AGGREGATIONS = ["sum", "last", "avg"] as const;
export const DIRECTIONS = ["up_good", "down_good", "neutral"] as const;
export const PERIOD_KINDS = ["month", "quarter", "year", "custom"] as const;
export const CALENDAR_PERIOD_KINDS = ["month", "quarter", "year"] as const;

/** `undefined` for anything that is not a plain decimal — never `NaN`, never a silent 0. */
export function parseValue(text: string | null | undefined): number | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

export const metricDefinitionsQuery = queryOptions({
  queryKey: ["metrics", "definitions"],
  queryFn: () => call(api().GET("/metrics/definitions")),
});

export function metricGridQuery(periodKind: CalendarPeriodKind, periods: number) {
  return queryOptions({
    queryKey: ["metrics", "grid", periodKind, periods],
    queryFn: () => call(api().GET("/metrics/grid", { params: { query: { periodKind, periods } } })),
  });
}

/**
 * One cell's full revision history, newest first (§9). This is where a restatement is
 * *provable* — who changed it, when, from what to what and from which source — so the screen
 * asks for it by `periodKey` and shows every row, superseded ones included.
 */
export function metricPointsQuery(id: string, periodKey: string) {
  return queryOptions({
    queryKey: ["metrics", "points", id, periodKey],
    queryFn: () =>
      call(
        api().GET("/metrics/definitions/{id}/points", {
          params: { path: { id }, query: { periodKey } },
        }),
      ),
  });
}

export function metricSeriesQuery(periodKind: CalendarPeriodKind, periods: number) {
  return queryOptions({
    queryKey: ["metrics", "series", periodKind, periods],
    queryFn: () =>
      call(api().GET("/metrics/series", { params: { query: { periodKind, periods } } })),
  });
}

export function metricImportQuery(id: string) {
  return queryOptions({
    queryKey: ["metrics", "import", id],
    queryFn: () => call(api().GET("/metrics/import/{id}", { params: { path: { id } } })),
  });
}

export const metricSheetsQuery = queryOptions({
  queryKey: ["metrics", "sheets"],
  queryFn: () => call(api().GET("/metrics/sheets")),
});

export const metricsSettingsQuery = queryOptions({
  queryKey: ["metrics", "settings"],
  queryFn: () => call(api().GET("/metrics/settings")),
});

// --- KPI sources (E3.6 §5) ----------------------------------------------------------------------

/*
 * A metric bound to a finance/billing provider's monthly series (QuickBooks Online, Xero,
 * Stripe). The connection itself lives in the Integrations hub (`/admin/integrations`); this
 * module only says which of *its* definitions reads which of the provider's metrics.
 *
 * Only a month-period, non-formula definition can be bound (the server answers
 * `binding_period_unsupported` otherwise): a provider reports calendar months, and a derived
 * metric is computed, never fed.
 */
export const KPI_PROVIDERS = ["quickbooks", "xero", "stripe"] as const;
export type KpiSources = FundRoomSchemas["MetricKpiSources"];
export type KpiSourceProvider = FundRoomSchemas["MetricKpiProvider"];
export type KpiBinding = FundRoomSchemas["MetricKpiBinding"];
export type KpiSourceMetric = FundRoomSchemas["KpiSourceMetric"];
export type KpiProvider = KpiSourceProvider["provider"];

/** Whether a definition may be fed by a provider: calendar months, and not derived. */
export function isBindable(definition: { periodKind: string; formula?: unknown }): boolean {
  return definition.periodKind === "month" && (definition.formula ?? null) === null;
}

export const METRIC_SOURCES_KEY = ["metrics", "sources"] as const;

export const metricSourcesQuery = queryOptions({
  queryKey: METRIC_SOURCES_KEY,
  queryFn: () => call(api().GET("/metrics/sources")),
});
