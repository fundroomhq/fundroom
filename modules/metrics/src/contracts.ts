import { integrations, TimestampSchema, trimmedText, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import { FormulaSchema } from "./formula.js";
import {
  AGGREGATIONS,
  DIRECTIONS,
  IMPORT_STATUSES,
  KPI_PROVIDERS,
  METRIC_KEY_RE,
  MetricAudienceSchema,
  SOURCE_KINDS,
  SYNC_STATUSES,
  UNIT_KINDS,
} from "./model.js";
import { PERIOD_KINDS } from "./period.js";

/*
 * Route schemas for `/api/v1/metrics/*` (E2.4 §9). Part of the OpenAPI document the SDK is
 * generated from, so every `.openapi("…")` name is stable API: `MetricDefinition`,
 * `MetricPoint`, `MetricSeries`, `MetricGrid`, `MetricImport`, `MetricSheetConnection` and
 * `MetricAudience` (named in `model.ts`) are the component names the contract froze.
 *
 * Two house rules are load-bearing here and both have bitten this repo before:
 *
 *  - **Every value is a decimal string**, never a JSON number. `numeric(20, 6)` does not
 *    survive a round trip through a double (§5), and JSON.parse would turn one into a double
 *    on the client the moment it left this document. The SDK therefore sees `string` and the
 *    web app parses it deliberately.
 *  - **Never `.nullable()` on a named schema.** `X.nullable()` marks the *component* nullable,
 *    so the generated type becomes `X | null` at every use site, including the ones that can
 *    never be null. `z.union([X, z.null()])` keeps the component alone
 *    (`packages/contracts/src/domains.ts:22-24`).
 */

/** Plain decimal text, the spelling `pg` emits for a `numeric` and `formatFixed` produces. */
export const DecimalSchema = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u, "a plain decimal number")
  .max(32)
  .openapi({ example: "1250000.00", description: "Decimal as text; never a JSON number (§5)" });

export const UnitKindSchema = z.enum(UNIT_KINDS);
export const AggregationSchema = z.enum(AGGREGATIONS);
export const DirectionSchema = z.enum(DIRECTIONS);
export const PeriodKindSchema = z.enum(PERIOD_KINDS);
/** The kinds with a canonical range; a grid or a series column is always one of these. */
export const CalendarPeriodKindSchema = z.enum(["month", "quarter", "year"]);
export type CalendarPeriodKind = z.output<typeof CalendarPeriodKindSchema>;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const SyncStatusSchema = z.enum(SYNC_STATUSES);
export const ImportStatusSchema = z.enum(IMPORT_STATUSES);

const MetricKeySchema = z.string().regex(METRIC_KEY_RE).openapi({
  example: "net_burn",
  description: "Stable machine key; CSV columns and formulas address it",
});

const NullableString = z.union([z.string(), z.null()]);
const NullableDecimal = z.union([DecimalSchema, z.null()]);
const NullableTimestamp = z.union([TimestampSchema, z.null()]);

// --- definitions ----------------------------------------------------------------------------------

export const MetricDefinitionSchema = z
  .object({
    id: UuidSchema,
    key: MetricKeySchema,
    name: z.string(),
    description: NullableString,
    unit: UnitKindSchema,
    /** ISO 4217, and non-null exactly when `unit` is `currency` (the column CHECKs it). */
    currency: NullableString,
    aggregation: AggregationSchema,
    direction: DirectionSchema,
    periodKind: PeriodKindSchema,
    decimals: z.number().int().min(0).max(6),
    /** `null` for a manual metric; a formula makes it derived and recomputed from the outbox. */
    formula: z.union([FormulaSchema, z.null()]),
    display: z.record(z.string(), z.unknown()),
    audience: MetricAudienceSchema,
    sortOrder: z.number().int(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("MetricDefinition");

export const MetricDefinitionListSchema = z
  .object({ definitions: z.array(MetricDefinitionSchema) })
  .openapi("MetricDefinitionList");

/**
 * `display` is an open map on purpose: it holds presentation hints the SPA owns (chart kind,
 * a colour override, whether to show the delta badge) and every one of them is a screen
 * decision, not a fact about the number. Freezing a shape here would make a UI change an API
 * change; nothing on the server reads it.
 */
const DisplaySchema = z.record(z.string(), z.unknown());

export const CreateDefinitionBody = z.object({
  key: MetricKeySchema,
  name: trimmedText({ min: 1, max: 120 }),
  description: z.string().trim().max(2000).optional(),
  unit: UnitKindSchema,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/u)
    .optional(),
  aggregation: AggregationSchema.optional(),
  direction: DirectionSchema.optional(),
  periodKind: PeriodKindSchema.optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  formula: FormulaSchema.optional(),
  display: DisplaySchema.optional(),
  audience: MetricAudienceSchema.optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

/** `key` is absent by design — see `DefinitionRepo.update`: a key is other people's stored data. */
export const PatchDefinitionBody = z.object({
  name: trimmedText({ min: 1, max: 120 }).optional(),
  description: z.union([z.string().trim().max(2000), z.null()]).optional(),
  unit: UnitKindSchema.optional(),
  currency: z
    .union([
      z
        .string()
        .trim()
        .regex(/^[A-Z]{3}$/u),
      z.null(),
    ])
    .optional(),
  aggregation: AggregationSchema.optional(),
  direction: DirectionSchema.optional(),
  periodKind: PeriodKindSchema.optional(),
  decimals: z.number().int().min(0).max(6).optional(),
  formula: z.union([FormulaSchema, z.null()]).optional(),
  display: DisplaySchema.optional(),
  audience: MetricAudienceSchema.optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

export const DefinitionIdParams = z.object({ id: UuidSchema });

// --- points ---------------------------------------------------------------------------------------

/**
 * Who wrote a revision.
 *
 * Resolved to a name rather than left as a bare id: the revision-history dialog would otherwise
 * need a round trip per row to render one. `displayName` is deliberate and narrow — this schema
 * is returned by exactly one route, `GET /definitions/{id}/points`, behind `metrics.read`, to a
 * staff caller who already sees the same name on the people screen and in every audit view. The
 * ids-only rule in this repo governs **outbox payloads** and **audit `meta`** (durable,
 * replicated, exported records), not authenticated staff reads; `modules/analytics` draws the
 * same line, carrying `displayName` on its staff views while refusing to store an email.
 *
 * It must not spread: `MetricSeries` and the `metric_grid` hydrator are investor-facing and
 * carry no author, which is asserted by a test rather than left to custom.
 */
export const MetricAuthorSchema = z
  .object({ membershipId: UuidSchema, displayName: z.string() })
  .openapi("MetricAuthor");

export const MetricPointSchema = z
  .object({
    id: UuidSchema,
    definitionId: UuidSchema,
    periodKey: z.string(),
    periodLabel: z.string(),
    periodStart: TimestampSchema,
    periodEnd: TimestampSchema,
    value: DecimalSchema,
    asOf: TimestampSchema,
    revision: z.number().int().min(1),
    sourceKind: z.union([SourceKindSchema, z.null()]),
    /** A sync found a different number for a cell somebody had typed; an admin must confirm it. */
    needsReview: z.boolean(),
    note: NullableString,
    /** `null` for a revision no person wrote: a sheets sync, a derived recompute. */
    createdBy: z.union([MetricAuthorSchema, z.null()]),
    createdAt: TimestampSchema,
    /** `false` once a later revision has replaced this row — the restatement trail (§D3). */
    current: z.boolean(),
  })
  .openapi("MetricPoint");

export const PointsQuery = z.object({
  /**
   * One period's full revision history instead of the live series. This is where a restatement
   * is *provable*: both rows come back, each with its own revision, source and `createdAt`.
   */
  periodKey: z.string().max(64).optional(),
  from: TimestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(240),
});

export const MetricPointListSchema = z
  .object({ points: z.array(MetricPointSchema) })
  .openapi("MetricPointList");

/**
 * One cell of the grid. `value: null` means "there is no point for this cell" — it never
 * writes a zero, and it never deletes an existing point: `metrics.point` is append-only, so
 * the only way to change a published number is to restate it to another number.
 */
export const MetricCellBody = z.object({
  definitionId: UuidSchema,
  periodKey: z.string().min(1).max(64),
  value: z.union([DecimalSchema, z.null()]),
  note: z.union([z.string().trim().max(500), z.null()]).optional(),
});

export const PutPointsBody = z.object({
  periodKind: PeriodKindSchema.optional(),
  points: z
    .array(MetricCellBody.omit({ definitionId: true }))
    .min(1)
    .max(1000),
});

// --- the period grid ------------------------------------------------------------------------------

export const MetricPeriodSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    start: TimestampSchema,
    end: TimestampSchema,
  })
  .openapi("MetricPeriod");

export const MetricGridCellSchema = z
  .object({
    definitionId: UuidSchema,
    periodKey: z.string(),
    value: DecimalSchema,
    revision: z.number().int().min(1),
    sourceKind: z.union([SourceKindSchema, z.null()]),
    needsReview: z.boolean(),
    note: NullableString,
    asOf: TimestampSchema,
  })
  .openapi("MetricGridCell");

export const MetricGridSchema = z
  .object({
    periodKind: CalendarPeriodKindSchema,
    periods: z.array(MetricPeriodSchema),
    definitions: z.array(MetricDefinitionSchema),
    /** Sparse: a cell with no live point is simply absent, never a zero. */
    cells: z.array(MetricGridCellSchema),
  })
  .openapi("MetricGrid");

export const GridQuery = z.object({
  periodKind: CalendarPeriodKindSchema.default("month"),
  periods: z.coerce.number().int().min(1).max(60).default(12),
  /** The newest period to show; defaults to the one containing now. */
  end: TimestampSchema.optional(),
});

export const PutGridBody = z.object({
  periodKind: CalendarPeriodKindSchema.default("month"),
  cells: z.array(MetricCellBody).min(1).max(2000),
  note: z.string().trim().max(500).optional(),
});

export const MetricWriteResultSchema = z
  .object({
    /** New cells that had no live point before. */
    written: z.number().int(),
    /** Cells whose value already equalled the live point: nothing was written (§9). */
    unchanged: z.number().int(),
    /** Cells that differed: revision + 1, the old row superseded, an audit row written. */
    restated: z.number().int(),
    /** Cells sent as `null`, i.e. "no point here". Never a zero, never a delete. */
    skipped: z.number().int(),
    definitionIds: z.array(UuidSchema),
  })
  .openapi("MetricWriteResult");

// --- the investor-facing series -------------------------------------------------------------------

export const MetricSeriesEntrySchema = z
  .object({
    definitionId: UuidSchema,
    key: MetricKeySchema,
    name: z.string(),
    unit: UnitKindSchema,
    currency: NullableString,
    decimals: z.number().int(),
    direction: DirectionSchema,
    aggregation: AggregationSchema,
    /** Aligned with `periods`, oldest first. `null` is a gap, not a zero (§6). */
    values: z.array(NullableDecimal),
  })
  .openapi("MetricSeriesEntry");

export const MetricSeriesSchema = z
  .object({
    periodKind: CalendarPeriodKindSchema,
    periods: z.array(MetricPeriodSchema),
    series: z.array(MetricSeriesEntrySchema),
  })
  .openapi("MetricSeries");

export const SeriesQuery = z.object({
  periodKind: CalendarPeriodKindSchema.default("month"),
  periods: z.coerce.number().int().min(1).max(60).default(12),
  end: TimestampSchema.optional(),
  /**
   * Comma-separated definition ids (up to 32); omitted means "every metric this reader may
   * see". Ids that are not uuids are dropped by the handler. The length bound keeps the request
   * line inside the HTTP server's 16 KiB head limit whatever is sent (past it the server answers
   * 431 before any route runs, which no operation can document).
   */
  ids: z
    .string()
    .max(1200)
    .regex(/^[0-9A-Za-z, -]*$/u)
    .optional(),
});

// --- CSV import -----------------------------------------------------------------------------------

/**
 * Which column is which. The admin chooses this in the UI after seeing the header row; it is
 * stored on `metrics.source.ref` so a point can say not merely "a CSV" but *which column of
 * which file* it came from.
 *
 * Column names are compared after `normalizeHeaderCell` (`trim().toLowerCase()`, whitespace to
 * `_`), which is what `@fundroom/csv` does and what the admin sees in the preview.
 */
export const MetricCsvMappingSchema = z
  .object({
    periodColumn: trimmedText({ min: 1, max: 120 }),
    periodKind: PeriodKindSchema.default("month"),
    columns: z
      .array(z.object({ column: trimmedText({ min: 1, max: 120 }), key: MetricKeySchema }))
      .min(1)
      .max(50),
  })
  .openapi("MetricCsvMapping");

export const MetricCsvBody = z.object({
  /** Pasted text in a JSON body, not multipart — E1.1's shape (`access.CsvBody`). */
  csv: z.string().min(1).max(2_000_000),
  mapping: MetricCsvMappingSchema,
  note: z.string().trim().max(500).optional(),
});

export const MetricImportCellSchema = z
  .object({
    key: MetricKeySchema,
    column: z.string(),
    value: NullableDecimal,
    status: z.enum(["ok", "skipped", "error"]),
    /** Machine-readable: `not_a_number`, `unknown_metric`, `blank`, `column_missing`. */
    reason: z.string().optional(),
  })
  .openapi("MetricImportCell");

export const MetricImportRowSchema = z
  .object({
    line: z.number().int(),
    periodKey: z.string(),
    status: z.enum(["ok", "skipped", "error", "applied", "failed"]),
    /**
     * Machine-readable, never a sentence to parse: `unreadable_period`, `duplicate_period`,
     * `no_values`, `too_many_rows`, `unknown_metric:<key>`, `period_column_missing`.
     */
    reason: z.string().optional(),
    cells: z.array(MetricImportCellSchema),
  })
  .openapi("MetricImportRow");

export const MetricCsvDryRunResultSchema = z
  .object({
    rows: z.array(MetricImportRowSchema),
    summary: z.object({
      ok: z.number().int(),
      skipped: z.number().int(),
      error: z.number().int(),
      /** How many `(metric, period)` cells the run would write. */
      values: z.number().int(),
    }),
    /** The header cells as normalised, so the admin can fix a mapping that names none of them. */
    columns: z.array(z.string()),
  })
  .openapi("MetricCsvDryRunResult");

export const MetricImportSchema = z
  .object({
    id: UuidSchema,
    status: ImportStatusSchema,
    total: z.number().int(),
    applied: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    rows: z.array(MetricImportRowSchema),
    createdAt: TimestampSchema,
    startedAt: NullableTimestamp,
    finishedAt: NullableTimestamp,
    lastError: NullableString,
  })
  .openapi("MetricImport");

export const ImportIdParams = z.object({ id: UuidSchema });

// --- Google Sheets --------------------------------------------------------------------------------

export const MetricSheetConnectionSchema = z
  .object({
    id: UuidSchema,
    spreadsheetId: z.string(),
    range: z.string(),
    mapping: MetricCsvMappingSchema,
    /** The address the admin must share the sheet with. Never the key, never the JSON. */
    serviceAccountEmail: z.string(),
    status: SyncStatusSchema,
    enabled: z.boolean(),
    lastSyncAt: NullableTimestamp,
    lastError: NullableString,
    consecutiveFailures: z.number().int(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("MetricSheetConnection");

export const MetricSheetConnectionEnvelopeSchema = z
  .object({ connection: z.union([MetricSheetConnectionSchema, z.null()]) })
  .openapi("MetricSheetConnectionEnvelope");

export const PutSheetsBody = z.object({
  spreadsheetId: trimmedText({ min: 1, max: 200 }),
  range: trimmedText({ min: 1, max: 200 }),
  mapping: MetricCsvMappingSchema,
  /**
   * The service-account JSON, exactly as Google generated it. Validated before it is
   * envelope-encrypted (C-D.4): a typo stored unread would only fail at 04:35 in a cron job.
   */
  credentialJson: z.string().min(1).max(64_000),
  enabled: z.boolean().optional(),
});

export const MetricSheetSyncResultSchema = z
  .object({
    status: SyncStatusSchema,
    rows: z.number().int(),
    written: z.number().int(),
    unchanged: z.number().int(),
    restated: z.number().int(),
    /** Cells a sync changed that a person had typed: written, flagged, never silently replaced. */
    needsReview: z.number().int(),
    /** Cells the sync read and deliberately passed over: a blank month, a duplicate period. */
    skipped: z.number().int().nonnegative(),
    /** Cells that were not a plain decimal — a currency-formatted column imports nothing. */
    unparsed: z.number().int().nonnegative(),
    error: NullableString,
  })
  .openapi("MetricSheetSyncResult");

// --- KPI sources (E3.6 §5) -----------------------------------------------------------------------

export const KpiProviderSchema = z.enum(KPI_PROVIDERS).openapi({ example: "quickbooks" });

/** A key of the provider's frozen KPI catalogue (`revenue`, `mrr`, …). */
const SourceMetricKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/u)
  .openapi({ example: "revenue" });

export const MetricKpiBindingSchema = z
  .object({
    id: UuidSchema,
    definitionId: UuidSchema,
    provider: KpiProviderSchema,
    sourceMetric: SourceMetricKeySchema,
    enabled: z.boolean(),
    /** `failed` with `lastError: "not connected"` once the integration is disconnected. */
    status: SyncStatusSchema,
    lastSyncAt: NullableTimestamp,
    /** `null` until the first successful sync, which backfills 24 months (later syncs read 3). */
    lastSuccessAt: NullableTimestamp,
    lastError: NullableString,
    consecutiveFailures: z.number().int().nonnegative(),
    /** Earliest month a sync has written for this binding, or `null`. */
    historyFrom: z.union([z.string().regex(/^\d{4}-\d{2}$/u), z.null()]).openapi({
      example: "2024-10",
    }),
    /**
     * Why the history is shorter than the 24-month backfill (e.g. the vendor's history was too
     * large). Survives later successful syncs; cleared only by a full backfill.
     */
    historyNote: NullableString,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("MetricKpiBinding");

export const MetricKpiProviderSchema = z
  .object({
    provider: KpiProviderSchema,
    /** A live connection exists (`/admin/integrations`); its health is `status`. */
    connected: z.boolean(),
    status: z.union([integrations.IntegrationConnectionStatusSchema, z.null()]),
    accountLabel: NullableString,
    lastSuccessAt: NullableTimestamp,
    lastError: NullableString,
    /** The series this provider offers; empty when the operator has not configured it. */
    metrics: z.array(integrations.KpiSourceMetricSchema),
  })
  .openapi("MetricKpiProvider");

export const MetricKpiSourcesSchema = z
  .object({
    providers: z.array(MetricKpiProviderSchema),
    bindings: z.array(MetricKpiBindingSchema),
  })
  .openapi("MetricKpiSources");

export const PutKpiBindingBody = z.object({
  provider: KpiProviderSchema,
  sourceMetric: SourceMetricKeySchema,
  /** Omitted: `true` for a new binding, unchanged for an existing one. */
  enabled: z.boolean().optional(),
});

export const MetricKpiSyncQueuedSchema = z
  .object({
    /** At least one provider sync is queued (or already queued/running); poll `GET /sources`. */
    queued: z.boolean(),
    /** The providers a sync job was requested for: those with an enabled binding. */
    providers: z.array(KpiProviderSchema),
  })
  .openapi("MetricKpiSyncQueued");

// --- settings -------------------------------------------------------------------------------------

export const MetricsSettingsSchema = z
  .object({
    defaultCurrency: z.string(),
    defaultPeriodKind: CalendarPeriodKindSchema,
  })
  .openapi("MetricsSettings");

export const MetricsSettingsPatchBody = z.object({
  defaultCurrency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/u)
    .optional(),
  defaultPeriodKind: CalendarPeriodKindSchema.optional(),
});
