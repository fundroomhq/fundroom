import {
  page,
  paginationQuery,
  TimestampSchema,
  trimmedText,
  UuidSchema,
} from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import {
  QA_CLOSED_REASONS,
  QA_IMPORT_MAX_BYTES,
  QA_SLA_STATES,
  QA_SOURCES,
  QA_STATUSES,
  QA_TARGET_KINDS,
  QA_VISIBILITIES,
} from "./rules.js";

/*
 * Route schemas for `/api/v1/data-room/qa/*` (E3.3 D6, ADR-0051). Names (`.openapi("Qa…")`) are
 * stable API: the SDK and the web app are generated from them. A named schema is never made
 * `.nullable()` (that would inline it); nullable references are `z.union([X, z.null()])`.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const QaQuestionStatusSchema = z.enum(QA_STATUSES).openapi("QaQuestionStatus");
export const QaTargetKindSchema = z.enum(QA_TARGET_KINDS).openapi("QaTargetKind");
export const QaSourceSchema = z.enum(QA_SOURCES).openapi("QaSource");
export const QaVisibilitySchema = z.enum(QA_VISIBILITIES).openapi("QaVisibility");
export const QaClosedReasonSchema = z.enum(QA_CLOSED_REASONS).openapi("QaClosedReason");
export const QaSlaStateSchema = z.enum(QA_SLA_STATES).openapi("QaSlaState");

// ---------------------------------------------------------------------------------------------
// Settings (`settings.dataRoom.qa`, read and written through GET/PATCH /data-room/settings)
// ---------------------------------------------------------------------------------------------

export const QaSettingsSchema = z
  .object({
    enabled: z.boolean(),
    requireApproval: z.boolean(),
    slaHours: z.number().int(),
    reminderLeadHours: z.number().int(),
    defaultVisibility: QaVisibilitySchema,
    allowFolderQuestions: z.boolean(),
    maxOpenPerAsker: z.number().int(),
  })
  .openapi("QaSettings");

/** Deep-merged into the stored `qa` block by PATCH /data-room/settings. */
export const QaSettingsPatchBody = z
  .object({
    enabled: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
    slaHours: z.number().int().min(1).max(720).optional(),
    reminderLeadHours: z.number().int().min(0).max(168).optional(),
    defaultVisibility: QaVisibilitySchema.optional(),
    allowFolderQuestions: z.boolean().optional(),
    maxOpenPerAsker: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .openapi("QaSettingsPatch");

// ---------------------------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------------------------

/** Postgres `text` cannot hold U+0000: refuse it as a 400 instead of failing the write. */
const noNul = (s: string) => !s.includes("\u0000");
const NUL_MESSAGE = "must not contain the NUL character";
const text = (min: number, max: number) => trimmedText({ min, max }).refine(noNul, NUL_MESSAGE);

const subjectField = text(1, 200);
const questionBodyField = text(1, 5000);
const answerBodyField = text(1, 20_000);
const publicTextField = text(1, 6000);

export const QaIdParams = z.object({ id: UuidSchema });

// ---------------------------------------------------------------------------------------------
// Investor side (x-requires `member`; 404 while Q&A is disabled, except GET /qa/status)
// ---------------------------------------------------------------------------------------------

/** GET /qa/status — never 404: `enabled: false` while the workspace has Q&A off. */
export const QaStatusSchema = z
  .object({
    enabled: z.boolean(),
    /** An external investor (not a delegate) in a workspace with Q&A on. */
    canAsk: z.boolean(),
    allowFolderQuestions: z.boolean(),
  })
  .openapi("QaStatus");

export const QaReleasedAnswerSchema = z
  .object({ body: z.string(), releasedAt: TimestampSchema })
  .openapi("QaReleasedAnswer");

export const QaQuestionViewSchema = z
  .object({
    id: UuidSchema,
    targetKind: QaTargetKindSchema,
    targetId: UuidSchema,
    /** Document title / folder name; "" when the caller cannot view the target. */
    targetTitle: z.string(),
    /** The caller asked it. */
    mine: z.boolean(),
    /** Always `published` for a question that is not the caller's. */
    status: QaQuestionStatusSchema,
    /** The caller's own question only. */
    subject: z.string().nullable(),
    /** The caller's own question only. */
    body: z.string().nullable(),
    /** The published wording; published questions only. */
    publicText: z.string().nullable(),
    /** Once released. */
    answer: z.union([QaReleasedAnswerSchema, z.null()]),
    /** When the caller asked it; null for anyone else's question (it would date the asker). */
    createdAt: TimestampSchema.nullable(),
    /** When it was published; null unless `status` is `published`. */
    publishedAt: TimestampSchema.nullable(),
    releasedAt: TimestampSchema.nullable(),
    visibility: z.union([QaVisibilitySchema, z.null()]),
  })
  .openapi("QaQuestionView");

export const QaQuestionPageSchema = page(QaQuestionViewSchema, "QaQuestionPage");

export const QaQuestionScopeSchema = z.enum(["mine", "target"]).openapi("QaQuestionScope");

/**
 * GET /qa/questions. `scope=mine` (default): the caller's questions, any status, optionally on
 * one target. `scope=target`: published questions on the target plus the caller's own on it;
 * `targetKind` and `targetId` are then required.
 */
export const QaQuestionsQuery = paginationQuery(100)
  .extend({
    scope: QaQuestionScopeSchema.default("mine"),
    targetKind: QaTargetKindSchema.optional(),
    targetId: UuidSchema.optional(),
  })
  .refine((q) => q.scope !== "target" || (q.targetKind !== undefined && q.targetId !== undefined), {
    message: "scope=target needs targetKind and targetId",
    path: ["targetId"],
  })
  .refine((q) => (q.targetKind === undefined) === (q.targetId === undefined), {
    message: "targetKind and targetId go together",
    path: ["targetKind"],
  });

/** POST /qa/questions → 201 QaQuestionView. */
export const QaAskBody = z
  .object({
    targetKind: QaTargetKindSchema,
    targetId: UuidSchema,
    subject: subjectField,
    body: questionBodyField,
  })
  .openapi("QaAskBody");

// ---------------------------------------------------------------------------------------------
// Staff inbox (works whether or not Q&A is enabled)
// ---------------------------------------------------------------------------------------------

export const QaMemberRefSchema = z
  .object({ membershipId: UuidSchema, displayName: z.string() })
  .openapi("QaMemberRef");

export const QaAskerSchema = z
  .object({ membershipId: UuidSchema, displayName: z.string(), email: z.string() })
  .openapi("QaAsker");

export const QaTargetRefSchema = z
  .object({ kind: QaTargetKindSchema, id: UuidSchema, title: z.string() })
  .openapi("QaTargetRef");

export const QaTargetDetailSchema = z
  .object({
    kind: QaTargetKindSchema,
    id: UuidSchema,
    title: z.string(),
    /** `1.2/Financials` style breadcrumb (or ltree path); null when unknown. */
    path: z.string().nullable(),
    /** The target is in the recycle bin (non-askers cannot see the question meanwhile). */
    deleted: z.boolean(),
  })
  .openapi("QaTargetDetail");

export const QaInboxItemSchema = z
  .object({
    id: UuidSchema,
    subject: z.string(),
    target: QaTargetRefSchema,
    askerName: z.string().nullable(),
    assigneeName: z.string().nullable(),
    status: QaQuestionStatusSchema,
    dueAt: TimestampSchema.nullable(),
    sla: QaSlaStateSchema,
    createdAt: TimestampSchema,
    /** An answer row exists (draft or released). */
    hasDraft: z.boolean(),
  })
  .openapi("QaInboxItem");

export const QaInboxCountsSchema = z
  .record(QaQuestionStatusSchema, z.number().int())
  .openapi("QaInboxCounts");

export const QaInboxPageSchema = z
  .object({
    items: z.array(QaInboxItemSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
    /** Every status's count in the workspace, independent of the filters and the page. */
    counts: QaInboxCountsSchema,
  })
  .openapi("QaInboxPage");

export const QaInboxAssigneeFilterSchema = z
  .union([z.enum(["me", "unassigned"]), UuidSchema])
  .openapi("QaInboxAssigneeFilter");

/** GET /qa/inbox. */
export const QaInboxQuery = paginationQuery(100).extend({
  status: QaQuestionStatusSchema.optional(),
  assignee: QaInboxAssigneeFilterSchema.optional(),
  targetKind: QaTargetKindSchema.optional(),
  targetId: UuidSchema.optional(),
  /** `true`: unanswered questions past `due_at` only. */
  overdue: z.enum(["true", "false"]).optional(),
});

export const QaInboxAnswerSchema = z
  .object({
    body: z.string(),
    author: z.union([QaMemberRefSchema, z.null()]),
    submittedAt: TimestampSchema.nullable(),
    approvedBy: z.union([QaMemberRefSchema, z.null()]),
    approvedAt: TimestampSchema.nullable(),
    /** The approval covers the current body (its SHA-256 matches). */
    approvalCurrent: z.boolean(),
    rejectedNote: z.string().nullable(),
  })
  .openapi("QaInboxAnswer");

export const QaInboxDetailSchema = z
  .object({
    id: UuidSchema,
    source: QaSourceSchema,
    status: QaQuestionStatusSchema,
    asker: z.union([QaAskerSchema, z.null()]),
    target: QaTargetDetailSchema,
    assignee: z.union([QaMemberRefSchema, z.null()]),
    subject: z.string(),
    body: z.string(),
    publicText: z.string().nullable(),
    category: z.string().nullable(),
    internalNote: z.string().nullable(),
    visibility: z.union([QaVisibilitySchema, z.null()]),
    dueAt: TimestampSchema.nullable(),
    sla: QaSlaStateSchema,
    answer: z.union([QaInboxAnswerSchema, z.null()]),
    createdAt: TimestampSchema,
    releasedAt: TimestampSchema.nullable(),
    publishedAt: TimestampSchema.nullable(),
    closedAt: TimestampSchema.nullable(),
    closedReason: z.union([QaClosedReasonSchema, z.null()]),
  })
  .openapi("QaInboxDetail");

/** POST /qa/inbox — a staff-authored entry (source `staff`, assigned to its author, answer drafted). */
export const QaStaffCreateBody = z
  .object({
    targetKind: QaTargetKindSchema,
    targetId: UuidSchema,
    subject: subjectField,
    body: questionBodyField,
    answer: answerBodyField,
  })
  .openapi("QaStaffCreateBody");

/** PATCH /qa/inbox/{id}. `null` clears a field. */
export const QaInboxPatchBody = z
  .object({
    category: text(1, 60).nullable().optional(),
    internalNote: text(0, 2000).nullable().optional(),
    publicText: publicTextField.nullable().optional(),
    dueAt: TimestampSchema.nullable().optional(),
  })
  .openapi("QaInboxPatchBody");

/** POST /qa/inbox/{id}/assign. null unassigns. */
export const QaAssignBody = z
  .object({ assigneeMembershipId: UuidSchema.nullable() })
  .openapi("QaAssignBody");

/** PUT /qa/inbox/{id}/answer. */
export const QaAnswerBody = z.object({ body: answerBodyField }).openapi("QaAnswerBody");

/** POST /qa/inbox/{id}/reject. */
export const QaRejectBody = z.object({ note: text(1, 2000) }).openapi("QaRejectBody");

/** POST /qa/inbox/{id}/release. */
export const QaReleaseBody = z
  .object({
    /**
     * Default: the workspace's `qa.defaultVisibility` — `target` when that is `asker` but the
     * question has no asker (a staff or imported entry).
     */
    visibility: QaVisibilitySchema.optional(),
    /** `target` only: the published wording (default: existing, else subject + body). */
    publicText: publicTextField.optional(),
  })
  .openapi("QaReleaseBody");

/** POST /qa/inbox/{id}/close. */
export const QaCloseBody = z
  .object({
    reason: z.literal("declined"),
    /** Email the asker that the question was declined. */
    notifyAsker: z.boolean().default(false),
  })
  .openapi("QaCloseBody");

// ---------------------------------------------------------------------------------------------
// Export / import (data-room.qa_manage + fresh session)
// ---------------------------------------------------------------------------------------------

/** GET /qa/export — `text/csv`. */
export const QaExportQuery = z.object({ format: z.enum(["csv"]).default("csv") });

export const QA_EXPORT_COLUMNS = [
  "id",
  "created_at",
  "status",
  "source",
  "target_kind",
  "target_id",
  "target_title",
  "asker_name",
  "asker_email",
  "subject",
  "question",
  "public_text",
  "category",
  "assignee_name",
  "due_at",
  "answer",
  "visibility",
  "released_at",
  "published_at",
  "closed_reason",
] as const;

/** Header row of an import CSV. Empty `target_id` with kind `folder` = the root folder. */
export const QA_IMPORT_COLUMNS = [
  "target_kind",
  "target_id",
  "subject",
  "question",
  "answer",
  "category",
  "publish",
] as const;

/** POST /qa/import. All-or-nothing: any row error writes nothing. */
export const QaImportBody = z
  .object({
    csv: z.string().min(1).max(QA_IMPORT_MAX_BYTES),
    /** Validate and report without writing. */
    dryRun: z.boolean(),
  })
  .openapi("QaImportBody");

export const QaImportErrorSchema = z
  .object({
    /** 1-based line in the CSV (the header is line 1). */
    line: z.number().int().min(1),
    message: z.string(),
  })
  .openapi("QaImportError");

export const QaImportResultSchema = z
  .object({
    /** Data rows read (header excluded). */
    rows: z.number().int().min(0),
    /** Questions written (0 for a dry run or when any row failed). */
    created: z.number().int().min(0),
    errors: z.array(QaImportErrorSchema),
  })
  .openapi("QaImportResult");

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type QaSettingsView = z.infer<typeof QaSettingsSchema>;
export type QaSettingsPatch = z.infer<typeof QaSettingsPatchBody>;
export type QaStatus = z.infer<typeof QaStatusSchema>;
export type QaReleasedAnswer = z.infer<typeof QaReleasedAnswerSchema>;
export type QaQuestionView = z.infer<typeof QaQuestionViewSchema>;
export type QaQuestionPage = z.infer<typeof QaQuestionPageSchema>;
export type QaQuestionScope = z.infer<typeof QaQuestionScopeSchema>;
export type QaQuestionsQueryInput = z.infer<typeof QaQuestionsQuery>;
export type QaAsk = z.infer<typeof QaAskBody>;
export type QaMemberRef = z.infer<typeof QaMemberRefSchema>;
export type QaAsker = z.infer<typeof QaAskerSchema>;
export type QaTargetRef = z.infer<typeof QaTargetRefSchema>;
export type QaTargetDetail = z.infer<typeof QaTargetDetailSchema>;
export type QaInboxItem = z.infer<typeof QaInboxItemSchema>;
export type QaInboxCounts = z.infer<typeof QaInboxCountsSchema>;
export type QaInboxPage = z.infer<typeof QaInboxPageSchema>;
export type QaInboxAssigneeFilter = z.infer<typeof QaInboxAssigneeFilterSchema>;
export type QaInboxQueryInput = z.infer<typeof QaInboxQuery>;
export type QaInboxAnswer = z.infer<typeof QaInboxAnswerSchema>;
export type QaInboxDetail = z.infer<typeof QaInboxDetailSchema>;
export type QaStaffCreate = z.infer<typeof QaStaffCreateBody>;
export type QaInboxPatch = z.infer<typeof QaInboxPatchBody>;
export type QaAssign = z.infer<typeof QaAssignBody>;
export type QaAnswerInput = z.infer<typeof QaAnswerBody>;
export type QaReject = z.infer<typeof QaRejectBody>;
export type QaRelease = z.infer<typeof QaReleaseBody>;
export type QaClose = z.infer<typeof QaCloseBody>;
export type QaImport = z.infer<typeof QaImportBody>;
export type QaImportError = z.infer<typeof QaImportErrorSchema>;
export type QaImportResult = z.infer<typeof QaImportResultSchema>;
