import {
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Formula } from "../formula.js";
import type {
  Aggregation,
  Direction,
  ImportStatus,
  KpiProvider,
  MetricAudience,
  SourceKind,
  SyncStatus,
  UnitKind,
} from "../model.js";
import type { PeriodKind } from "../period.js";

/*
 * Typed view of `migrations/0001_metrics.sql`; the SQL is authoritative (ADR-0004). The
 * `metrics` schema is owned by this module (ADR-0007): nothing outside `modules/metrics`
 * reads these tables.
 *
 * The enum unions come from `../model.js` and `../period.js` rather than from
 * `pgSchema.enum()`, which is the opposite of what `modules/updates` does and is deliberate:
 * a route contract, a CSV importer and the formula evaluator all need the vocabulary, and
 * importing it from here would drag drizzle into files the dependency-cruiser rule
 * `only-repos-touch-drizzle` keeps it out of. The `as const` tuples live in the pure module
 * and the columns are typed from them, so there is still exactly one list.
 */
export const metricsSchema = pgSchema("metrics");

/** `tstzrange` as its canonical text form, e.g. `["2026-03-01 00:00:00+00","2026-04-01 00:00:00+00")`. */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tstzrange";
  },
});

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

export const definition = metricsSchema.table("definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  key: citext("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  unit: text("unit").$type<UnitKind>().notNull(),
  currency: text("currency"),
  aggregation: text("aggregation").$type<Aggregation>().notNull().default("last"),
  direction: text("direction").$type<Direction>().notNull().default("up_good"),
  periodKind: text("period_kind").$type<PeriodKind>().notNull().default("month"),
  decimals: smallint("decimals").notNull().default(0),
  formula: jsonb("formula").$type<Formula>(),
  formulaSchemaVersion: integer("formula_schema_version").notNull().default(1),
  display: jsonb("display").$type<Record<string, unknown>>().notNull().default({}),
  displaySchemaVersion: integer("display_schema_version").notNull().default(1),
  audience: jsonb("audience").$type<MetricAudience>().notNull().default({ kind: "staff_only" }),
  audienceSchemaVersion: integer("audience_schema_version").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export type Definition = typeof definition.$inferSelect;

export const source = metricsSchema.table("source", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  kind: text("kind").$type<SourceKind>().notNull(),
  ref: jsonb("ref").$type<Record<string, unknown>>().notNull().default({}),
  refSchemaVersion: integer("ref_schema_version").notNull().default(1),
  importedBy: uuid("imported_by"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Source = typeof source.$inferSelect;

/**
 * `value` is `numeric(20, 6)`, which drizzle hands over as a **string** and which the repos
 * turn into a fixed-point bigint before anything else sees it (`../decimal.js`). Nothing in
 * this module may put a `numeric` through `Number()`.
 *
 * `periodStart` is `GENERATED ALWAYS … STORED`: drizzle has no generated-column concept here,
 * so it is declared as a plain column and never written. The SQL is what enforces that.
 */
export const point = metricsSchema.table("point", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  definitionId: uuid("definition_id").notNull(),
  period: tstzrange("period").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  value: numeric("value", { precision: 20, scale: 6 }).notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull().defaultNow(),
  sourceId: uuid("source_id"),
  revision: integer("revision").notNull().default(1),
  supersededBy: uuid("superseded_by"),
  needsReview: boolean("needs_review").notNull().default(false),
  note: text("note"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Point = typeof point.$inferSelect;

export const metricImport = metricsSchema.table("import", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sourceId: uuid("source_id"),
  status: text("status").$type<ImportStatus>().notNull().default("pending"),
  defaults: jsonb("defaults").$type<Record<string, unknown>>().notNull().default({}),
  defaultsSchemaVersion: integer("defaults_schema_version").notNull().default(1),
  rows: jsonb("rows").$type<readonly unknown[]>().notNull().default([]),
  rowsSchemaVersion: integer("rows_schema_version").notNull().default(1),
  total: integer("total").notNull().default(0),
  applied: integer("applied").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  lastError: text("last_error"),
});
export type MetricImport = typeof metricImport.$inferSelect;

export const sheetConnection = metricsSchema.table("sheet_connection", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  spreadsheetId: text("spreadsheet_id").notNull(),
  range: text("range").notNull(),
  mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull().default({}),
  mappingSchemaVersion: integer("mapping_schema_version").notNull().default(1),
  credentialEnc: bytea("credential_enc").notNull(),
  encryption: jsonb("encryption").$type<Record<string, unknown>>().notNull().default({}),
  encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
  serviceAccountEmail: text("service_account_email").notNull(),
  status: text("status").$type<SyncStatus>().notNull().default("idle"),
  enabled: boolean("enabled").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SheetConnection = typeof sheetConnection.$inferSelect;

/** Typed view of `migrations/0006_kpi_bindings.sql` (E3.6 §5). */
export const sourceBinding = metricsSchema.table("source_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  definitionId: uuid("definition_id").notNull(),
  provider: text("provider").$type<KpiProvider>().notNull(),
  sourceMetric: text("source_metric").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").$type<SyncStatus>().notNull().default("idle"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  historyFrom: text("history_from"),
  historyNote: text("history_note"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SourceBinding = typeof sourceBinding.$inferSelect;
