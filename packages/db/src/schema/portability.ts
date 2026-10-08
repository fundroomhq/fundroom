import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { bytea } from "./identity.js";

/*
 * Workspace export and import (E2.8, EXECUTION_PLAN §15 "workspace export zip + import").
 *
 * Typed view of `migrations/core/0013_search_portability_i18n.sql`; the SQL is authoritative
 * (ADR-0004). Staff and system contexts only (RLS). The engine is `@fundroom/portability`.
 */

export const WORKSPACE_EXPORT_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
] as const;
export type WorkspaceExportStatus = (typeof WORKSPACE_EXPORT_STATUSES)[number];

export const workspaceExport = coreSchema.table(
  "workspace_export",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The requesting membership; no FK. NULL for an operator (CLI) export. */
    requestedBy: uuid("requested_by"),
    status: text("status").notNull().default("queued"),
    /** `{ includeRawAnalytics: boolean }`. */
    options: jsonb("options").notNull().default({}),
    optionsSchemaVersion: integer("options_schema_version").notNull().default(1),
    /** `ws/<ws>/exports/<id>.zip`, SHE1-encrypted. */
    storageKey: text("storage_key"),
    encryption: jsonb("encryption"),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** sha256 of the zip plaintext. */
    sha256: bytea("sha256"),
    manifestSha256: bytea("manifest_sha256"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
  },
  (t) => [
    index("workspace_export_ws_idx").on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex("workspace_export_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("workspace_export_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'ready'`),
    check(
      "workspace_export_status",
      sql`${t.status} IN ('queued', 'running', 'ready', 'failed', 'expired')`,
    ),
    check("workspace_export_size", sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`),
    check(
      "workspace_export_sha256_shape",
      sql`(${t.sha256} IS NULL OR octet_length(${t.sha256}) = 32) AND (${t.manifestSha256} IS NULL OR octet_length(${t.manifestSha256}) = 32)`,
    ),
    check(
      "workspace_export_error_length",
      sql`${t.error} IS NULL OR char_length(${t.error}) <= 2000`,
    ),
  ],
);

/** One row per imported workspace; `workspaceId` is the NEW workspace. */
export const workspaceImport = coreSchema.table(
  "workspace_import",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** `{ instanceId?, workspaceId, slug, exportedAt, manifestSha256, signature }`. */
    source: jsonb("source").notNull(),
    sourceSchemaVersion: integer("source_schema_version").notNull().default(1),
    counts: jsonb("counts").notNull().default({}),
    countsSchemaVersion: integer("counts_schema_version").notNull().default(1),
    auditArchiveKey: text("audit_archive_key"),
    auditArchiveEncryption: jsonb("audit_archive_encryption"),
    auditArchiveEncryptionSchemaVersion: integer("audit_archive_encryption_schema_version")
      .notNull()
      .default(1),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    /** Operator label recorded by the CLI. */
    importedBy: text("imported_by").notNull(),
  },
  (t) => [index("workspace_import_ws_idx").on(t.workspaceId)],
);

export type WorkspaceExport = typeof workspaceExport.$inferSelect;
export type NewWorkspaceExport = typeof workspaceExport.$inferInsert;
export type WorkspaceImport = typeof workspaceImport.$inferSelect;
