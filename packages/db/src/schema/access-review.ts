import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";

/*
 * Completed periodic access reviews (E2.7, EXECUTION_PLAN §15 "access review report").
 *
 * Typed view of `migrations/core/0012_admin_surfaces.sql`; the SQL is authoritative (ADR-0004).
 * Append-only evidence: `seedhost_app` has no UPDATE or DELETE on the table and an UPDATE
 * trigger refuses rewrites. Staff and system contexts only (RLS). `reviewerMembershipId` has no
 * foreign key, like the audit log's actor ids: the evidence outlives the reviewer's membership.
 * `reportSha256` is the sha256 (hex) of the report's canonical JSON at completion time.
 */
export const accessReview = coreSchema.table(
  "access_review",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    reviewerMembershipId: uuid("reviewer_membership_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    memberCount: integer("member_count").notNull(),
    flaggedCount: integer("flagged_count").notNull(),
    note: text("note"),
    reportSha256: text("report_sha256").notNull(),
    /** The canonical report `reportSha256` is over; the evidence itself (E2.7 review M3). */
    report: jsonb("report").notNull(),
    reportSchemaVersion: integer("report_schema_version").notNull().default(1),
  },
  (t) => [
    index("access_review_ws_idx").on(t.workspaceId, t.completedAt.desc(), t.id.desc()),
    check(
      "access_review_counts",
      sql`${t.memberCount} >= 0 AND ${t.flaggedCount} BETWEEN 0 AND ${t.memberCount}`,
    ),
    check("access_review_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
    check("access_review_sha256_shape", sql`${t.reportSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type AccessReview = typeof accessReview.$inferSelect;
export type NewAccessReview = typeof accessReview.$inferInsert;
