import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Kernel tables in the `core` Postgres schema (EXECUTION_PLAN §7, design/06 §2.1).
 *
 * These TypeScript definitions are the typed view of `migrations/core/*.sql`.
 * The SQL is authoritative (ADR-0004): drizzle-kit can diff this file against
 * a snapshot to draft a migration, but RLS, functions, triggers, grants and
 * the uuidv7 shim are hand-written in the SQL files.
 *
 * Conventions (§7): `uuidv7()` ids, `workspace_id` first in composite indexes,
 * `jsonb` always paired with a `*_schema_version` column, `deleted_at` for
 * soft delete, Postgres enums only for code-owned state machines.
 */

export const coreSchema = pgSchema("core");

/** Case-insensitive text (extension `citext`); drizzle has no built-in type for it. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

/** Workspace slugs are DNS-label shaped: they become subdomains and path segments. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/u;

/** E3.10: `core.workspace.status` (text + CHECK, 0023). */
export const WORKSPACE_STATUSES = ["active", "pending_review", "suspended"] as const;
export type WorkspaceStatusValue = (typeof WORKSPACE_STATUSES)[number];
/** E3.10: `core.workspace.suspended_reason`. */
export const SUSPEND_REASONS = ["operator", "billing", "sanctions", "relocation"] as const;
export type SuspendReasonValue = (typeof SUSPEND_REASONS)[number];
/**
 * E3.10: `core.workspace.holds` — independent flags, each set and cleared by its owner. The
 * status columns are derived from them by a trigger (`workspace_derive_status`, 0023/0024).
 * E3.11 (0024): `relocation` — set while the workspace moves to another cell.
 */
export const WORKSPACE_HOLDS = [
  "sanctions_review",
  "operator",
  "billing",
  "sanctions",
  "relocation",
] as const;
export type WorkspaceHoldValue = (typeof WORKSPACE_HOLDS)[number];

/** Offering status is a code-owned closed set (ADR-0019); versioned through audit (E0.4/E1.6). */
export const offeringStatus = coreSchema.enum("offering_status", [
  "none",
  "informational",
  "506b",
  "506c",
  "non_us",
]);

export const OFFERING_STATUSES = offeringStatus.enumValues;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

/** A tenant. Global table: not fenced by `workspace_id`, but fenced by `id` (see migration). */
export const workspace = coreSchema.table(
  "workspace",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    /** Used for subdomain / path routing. */
    slug: citext("slug").notNull(),
    name: text("name").notNull(),
    offeringStatus: offeringStatus("offering_status").notNull().default("none"),
    settings: jsonb("settings").notNull().default({}),
    settingsSchemaVersion: integer("settings_schema_version").notNull().default(1),
    /** Bumped whenever grants/groups/policies change; `effective_access` rebuild key (ADR-0014). */
    aclVersion: bigint("acl_version", { mode: "number" }).notNull().default(0),
    /** Reference to the per-workspace DEK in the KMS adapter (ADR-0016). */
    kmsKeyRef: text("kms_key_ref"),
    /**
     * E3.11 (0024): DERIVED from the cell (`core.cell.region`) by triggers on every write and on a
     * cell's region change; pinned against tenant actors. Never written by application code.
     */
    dataRegion: text("data_region"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** E2.7: set with `deletedAt` (+30 days); the purge job crypto-shreds after it. */
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    /** E2.7: when the purge job shredded the workspace's keys; a workspace is purged once. */
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    /** E2.8 (0013): the workspace's default UI/email language (a column, not `settings`). */
    defaultLocale: text("default_locale").notNull().default("en"),
    /**
     * E3.8 (0022): the live SSO connection's `enforce = 'staff'`, mirrored here (same transaction)
     * so the tenant resolver carries it and enforcement costs no query.
     */
    ssoEnforced: boolean("sso_enforced").notNull().default(false),
    /**
     * E3.8 (0022): the live ENABLED SSO connection's id and version, mirrored here in the same
     * transaction as every connection write (null when none is enabled). Session resolution
     * ignores a bound session whose connection id / version differ, so a disable, delete or
     * security-relevant save takes effect on the next request even if the revoke fails.
     */
    ssoConnectionId: uuid("sso_connection_id"),
    ssoConnectionVersion: integer("sso_connection_version"),
    /**
     * E3.10 (0023): the cell serving this workspace (`core.cell.id`, FK declared in the SQL — this
     * file does not import `./control-plane.js`, which imports it). With CONTROL_PLANE=on a
     * request that reaches another cell is answered 421 `wrong_cell`.
     */
    cellId: text("cell_id").notNull().default("default"),
    /**
     * E3.10 (0023): the holds (sorted, no duplicates). Written only through
     * `@fundroom/control-plane` `setWorkspaceHold`; a guard trigger refuses tenant actors.
     */
    holds: text("holds").array().$type<WorkspaceHoldValue[]>().notNull().default(sql`'{}'`),
    /**
     * E3.10 (0023): DERIVED from `holds` by a trigger — `suspended` (with `suspendedReason` +
     * `suspendedAt`) while any of operator / billing / sanctions is held (reason = the highest:
     * sanctions > operator > relocation > billing), `pending_review` while only `sanctions_review` is, else
     * `active`. Never written directly (the trigger refuses a value that disagrees).
     */
    status: text("status").$type<WorkspaceStatusValue>().notNull().default("active"),
    suspendedReason: text("suspended_reason").$type<SuspendReasonValue>(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** E3.10 (0023): the tenant's company, for sanctions screening and billing. */
    legalName: text("legal_name"),
    /** ISO 3166-1 alpha-2, upper case. */
    country: text("country"),
    /** E3.10 (0023): `core.plan.id`; null = unlimited (every self-hosted workspace). */
    planId: text("plan_id"),
  },
  (t) => [
    uniqueIndex("workspace_slug_active_idx").on(t.slug).where(sql`${t.deletedAt} IS NULL`),
    index("workspace_purge_due_idx")
      .on(t.purgeAfter)
      .where(sql`${t.purgeAfter} IS NOT NULL AND ${t.purgedAt} IS NULL`),
    check("workspace_slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
    check(
      "workspace_purge_shape",
      sql`(${t.purgeAfter} IS NULL OR ${t.deletedAt} IS NOT NULL) AND (${t.purgedAt} IS NULL OR (${t.deletedAt} IS NOT NULL AND ${t.purgeAfter} IS NOT NULL))`,
    ),
    check(
      "workspace_sso_connection_shape",
      sql`num_nulls(${t.ssoConnectionId}, ${t.ssoConnectionVersion}) IN (0, 2)`,
    ),
    check(
      "workspace_default_locale_shape",
      sql`${t.defaultLocale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    index("workspace_cell_idx").on(t.cellId),
    index("workspace_plan_idx").on(t.planId).where(sql`${t.planId} IS NOT NULL`),
    index("workspace_unavailable_idx").on(t.status).where(sql`${t.status} <> 'active'`),
    index("workspace_created_idx").on(t.createdAt, t.id),
    check("workspace_status", sql`${t.status} IN ('active', 'pending_review', 'suspended')`),
    check(
      "workspace_holds",
      sql`${t.holds} <@ ARRAY['sanctions_review', 'operator', 'billing', 'sanctions', 'relocation']::text[] AND array_position(${t.holds}, NULL) IS NULL AND core.text_array_is_set(${t.holds})`,
    ),
    check(
      "workspace_suspended_reason",
      sql`${t.suspendedReason} IS NULL OR ${t.suspendedReason} IN ('operator', 'billing', 'sanctions', 'relocation')`,
    ),
    check(
      "workspace_suspension_shape",
      sql`(${t.status} = 'suspended') = (${t.suspendedReason} IS NOT NULL) AND (${t.status} = 'suspended') = (${t.suspendedAt} IS NOT NULL)`,
    ),
    check(
      "workspace_legal_name_length",
      sql`${t.legalName} IS NULL OR char_length(${t.legalName}) BETWEEN 1 AND 200`,
    ),
    check("workspace_country_format", sql`${t.country} IS NULL OR ${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

/** Per-workspace module switch (ADR-0007). Absent row = module disabled. */
export const moduleEnablement = coreSchema.table(
  "module_enablement",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").notNull().default({}),
    configSchemaVersion: integer("config_schema_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.module] }),
    check("module_enablement_module_format", sql`${t.module} ~ '^[a-z][a-z0-9-]*$'`),
  ],
);

/**
 * Transactional outbox (design/06 §1). Rows are written in the same transaction as
 * the domain change; the relay (E0.4) reads them in host context. `workspace_id` is
 * NULL for host-level events, which is why this table carries a custom fence.
 */
export const outbox = coreSchema.table(
  "outbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Jobs the relay created for this row (one per subscriber). */
    dispatched: integer("dispatched").notNull().default(0),
  },
  (t) => [
    index("outbox_pending_idx").on(t.availableAt, t.id).where(sql`${t.processedAt} IS NULL`),
    index("outbox_workspace_idx").on(t.workspaceId, t.id),
    index("outbox_processed_idx").on(t.processedAt).where(sql`${t.processedAt} IS NOT NULL`),
  ],
);

/**
 * Idempotency keys (design/07 §6.2). A handler claims its key in the same transaction as
 * the effect it records; a redelivered job finds the key and skips. `workspace_id` NULL is
 * host-level, hence the outbox-style fence in the migration.
 */
export const idempotencyKey = coreSchema.table(
  "idempotency_key",
  {
    key: text("key").primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idempotency_key_expires_idx").on(t.expiresAt),
    check("idempotency_key_format", sql`length(${t.key}) BETWEEN 1 AND 512`),
  ],
);

/** Per-module migration journal (design/06 §9). Written only by the migration runner. */
export const schemaMigration = coreSchema.table(
  "schema_migration",
  {
    module: text("module").notNull(),
    name: text("name").notNull(),
    checksum: text("checksum").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.module, t.name] })],
);

export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;
export type ModuleEnablement = typeof moduleEnablement.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;
export type IdempotencyKeyRow = typeof idempotencyKey.$inferSelect;
export type SchemaMigrationRow = typeof schemaMigration.$inferSelect;
