import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  QA_STATUSES,
  QA_TARGET_KINDS,
  type QaClosedReason,
  type QaSource,
  type QaVisibility,
} from "../qa/rules.js";
import { dataroomSchema } from "./dataroom.js";

/*
 * Typed view of `migrations/0003_qa.sql` (E3.3, ADR-0051); the SQL is authoritative (ADR-0004).
 * Same `dataroom` schema object as `./dataroom.ts`: Q&A lives inside the data room because its
 * targets' paths and liveness are data-room facts. The vocabulary (statuses, sources, …) is
 * defined once in `../qa/rules.ts`.
 */

export const qaStatus = dataroomSchema.enum("qa_status", QA_STATUSES);
export const qaTargetKind = dataroomSchema.enum("qa_target_kind", QA_TARGET_KINDS);

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const qaQuestion = dataroomSchema.table("qa_question", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  targetKind: qaTargetKind("target_kind").notNull(),
  documentId: uuid("document_id"),
  folderId: uuid("folder_id"),
  askerMembershipId: uuid("asker_membership_id"),
  source: text("source").$type<QaSource>().notNull(),
  status: qaStatus("status").notNull().default("open"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  publicText: text("public_text"),
  category: text("category"),
  assigneeMembershipId: uuid("assignee_membership_id"),
  dueAt: ts("due_at"),
  visibility: text("visibility").$type<QaVisibility>(),
  internalNote: text("internal_note"),
  closedReason: text("closed_reason").$type<QaClosedReason>(),
  releasedAt: ts("released_at"),
  publishedAt: ts("published_at"),
  firstReleasedAt: ts("first_released_at"),
  closedAt: ts("closed_at"),
  dueSoonNotifiedAt: ts("due_soon_notified_at"),
  overdueNotifiedAt: ts("overdue_notified_at"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const qaAnswer = dataroomSchema.table("qa_answer", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  questionId: uuid("question_id").notNull(),
  body: text("body").notNull(),
  authorMembershipId: uuid("author_membership_id"),
  submittedAt: ts("submitted_at"),
  approvedBy: uuid("approved_by"),
  approvedAt: ts("approved_at"),
  approvedBodySha256: text("approved_body_sha256"),
  rejectedNote: text("rejected_note"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type QaQuestion = typeof qaQuestion.$inferSelect;
export type NewQaQuestion = typeof qaQuestion.$inferInsert;
export type QaAnswer = typeof qaAnswer.$inferSelect;
export type NewQaAnswer = typeof qaAnswer.$inferInsert;
