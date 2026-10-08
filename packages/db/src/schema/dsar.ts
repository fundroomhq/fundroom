import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";

/*
 * DSAR requests (erasure since E2.6 decision 5; access and rectification since E2.7) and the
 * per-module steps that answer an erasure (design/04 §3.2).
 *
 * Typed view of `migrations/core/0011_dsar.sql` and `0012_admin_surfaces.sql`; the SQL is
 * authoritative (ADR-0004) — the transition-only trigger on the request, the insert-only
 * trigger on the step and the fences all live there. The orchestration (legal hold, statutory clock, `expected_modules`) is
 * `@fundroom/compliance` and `apps/server/src/routes/compliance.ts`.
 *
 * `membershipId` has no foreign key on purpose: the request is the record that a person was
 * erased and must outlive the membership row it names.
 */

export const dsarStatus = coreSchema.enum("dsar_status", ["requested", "completed", "cancelled"]);

export const DSAR_STATUSES = dsarStatus.enumValues;
export type DsarStatus = (typeof DSAR_STATUSES)[number];

/** E2.7 (0012): what the subject asked for. Rows before 0012 are all `erasure`. */
export const dsarKind = coreSchema.enum("dsar_kind", ["erasure", "access", "rectification"]);

export const DSAR_KINDS = dsarKind.enumValues;
export type DsarKind = (typeof DSAR_KINDS)[number];

/** The `dsar_step.module` the kernel's identity-erasure step reports as (E2.7). */
export const DSAR_IDENTITY_STEP = "core.identity";

export const dsarRequest = coreSchema.table(
  "dsar_request",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The member to be erased. No FK: the request outlives the membership. */
    membershipId: uuid("membership_id").notNull(),
    /** E2.7: erasure | access | rectification. Immutable. */
    kind: dsarKind("kind").notNull().default("erasure"),
    /** The staff membership that recorded the request. */
    requestedBy: uuid("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Statutory deadline (`erasureDueAt`): +30 days, or +45 for a US workspace. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: dsarStatus("status").notNull().default("requested"),
    /** Module ids expected to report, frozen at request time. */
    expectedModules: text("expected_modules").array().notNull().default(sql`'{}'`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    note: text("note"),
    /** E2.7: staff note written when completing an access/rectification request. */
    completionNote: text("completion_note"),
    /** E2.7: sha256 (hex) of the subject export that answered an access request. */
    exportSha256: text("export_sha256"),
  },
  (t) => [
    // One open request per member and kind (0012; was per member in 0011).
    uniqueIndex("dsar_request_open_idx")
      .on(t.workspaceId, t.membershipId, t.kind)
      .where(sql`${t.status} = 'requested'`),
    index("dsar_request_ws_idx").on(t.workspaceId, t.requestedAt.desc(), t.id.desc()),
    check("dsar_request_due_after_request", sql`${t.dueAt} > ${t.requestedAt}`),
    check("dsar_request_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
    check(
      "dsar_request_completion_note_length",
      sql`${t.completionNote} IS NULL OR char_length(${t.completionNote}) <= 1000`,
    ),
    check(
      "dsar_request_export_sha256_shape",
      sql`${t.exportSha256} IS NULL OR ${t.exportSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "dsar_request_completion_shape",
      sql`${t.status} = 'completed' OR (${t.completionNote} IS NULL AND ${t.exportSha256} IS NULL)`,
    ),
  ],
);

export const dsarStep = coreSchema.table(
  "dsar_step",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => dsarRequest.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Rows removed or pseudonymised, by table — numbers only. */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    countsSchemaVersion: integer("counts_schema_version").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.module] }),
    check(
      "dsar_step_module_shape",
      sql`${t.module} ~ '^[a-z][a-z0-9-]{0,63}$' OR ${t.module} = 'core.identity'`,
    ),
  ],
);

export type DsarRequest = typeof dsarRequest.$inferSelect;
export type NewDsarRequest = typeof dsarRequest.$inferInsert;
export type DsarStep = typeof dsarStep.$inferSelect;
export type NewDsarStep = typeof dsarStep.$inferInsert;
