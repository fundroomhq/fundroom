import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { bytea } from "./identity.js";

/*
 * Per-workspace data-encryption keys (EXECUTION_PLAN §10, ADR-0016, design/06 §4, E0.5).
 * Typed view of `migrations/core/0003_workspace_key.sql`; the SQL is authoritative.
 *
 * One active row per (workspace, purpose). `wrapped_dek` is the DEK wrapped by the KMS
 * adapter named by `kms_key_ref` (`local:v2`, `aws:arn:…`); the plaintext never touches the
 * database. Rotation retires the row (`retired_at`) and links the successor; blobs keep the
 * id of the key they were written under, so retired keys still decrypt. Rows are never
 * deleted by the app role: crypto-shredding a workspace is deleting the workspace (cascade).
 */
export const workspaceKey = coreSchema.table(
  "workspace_key",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull().default("workspace-dek"),
    kmsKeyRef: text("kms_key_ref").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    rotatedFromId: uuid("rotated_from_id").references((): AnyPgColumn => workspaceKey.id),
  },
  (t) => [
    uniqueIndex("workspace_key_active_idx")
      .on(t.workspaceId, t.purpose)
      .where(sql`${t.retiredAt} IS NULL`),
    index("workspace_key_workspace_idx").on(t.workspaceId, t.purpose, t.createdAt),
    check("workspace_key_purpose_format", sql`${t.purpose} ~ '^[a-z][a-z0-9-]*$'`),
  ],
);

export type WorkspaceKey = typeof workspaceKey.$inferSelect;
export type NewWorkspaceKey = typeof workspaceKey.$inferInsert;
