import { createHash } from "node:crypto";

/*
 * Data-room Q&A rules (E3.3, ADR-0051): the vocabulary, the status machine, the SLA indicator
 * and the investor view projection. Pure — no database, no Hono, no zod — so the service, the
 * SLA job, the importer and the tests all share one definition.
 */

/** `dataroom.qa_status` (migration 0003_qa). */
export const QA_STATUSES = [
  "open",
  "assigned",
  "awaiting_approval",
  "answered",
  "published",
  "closed",
] as const;
export type QaQuestionStatus = (typeof QA_STATUSES)[number];

/** `dataroom.qa_target_kind`. */
export const QA_TARGET_KINDS = ["document", "folder"] as const;
export type QaTargetKind = (typeof QA_TARGET_KINDS)[number];

/** Who wrote the question: an investor, a CSV import, or staff (an FAQ entry with no asker). */
export const QA_SOURCES = ["portal", "import", "staff"] as const;
export type QaSource = (typeof QA_SOURCES)[number];

/** To whom a released answer is visible. */
export const QA_VISIBILITIES = ["asker", "target"] as const;
export type QaVisibility = (typeof QA_VISIBILITIES)[number];

/** Why a question is closed. (A binned or purged target is not a close: the target hides it.) */
export const QA_CLOSED_REASONS = ["declined", "withdrawn", "erased"] as const;
export type QaClosedReason = (typeof QA_CLOSED_REASONS)[number];

export const QA_SLA_STATES = ["none", "on_track", "due_soon", "overdue"] as const;
export type QaSlaState = (typeof QA_SLA_STATES)[number];

/** Waiting on staff: these count against `maxOpenPerAsker` and run the SLA clock. */
export const QA_UNANSWERED_STATUSES = [
  "open",
  "assigned",
  "awaiting_approval",
] as const satisfies readonly QaQuestionStatus[];
/** The answer has been released (to the asker, or to the target's audience). */
export const QA_RELEASED_STATUSES = [
  "answered",
  "published",
] as const satisfies readonly QaQuestionStatus[];

/** `details.reason` values the Q&A routes put on kernel error codes (no new codes, D6). */
export const QA_ERROR_REASONS = [
  "delegate_read_only",
  "folder_questions_disabled",
  "too_many_open",
  "self_approval",
  "approval_required",
  "approval_not_required",
  "nothing_to_approve",
  "closed",
  "no_asker",
  "invalid_assignee",
  "not_an_investor",
  "public_text_required",
  "erased",
  "withdrawn",
  "cursor",
] as const;
export type QaErrorReason = (typeof QA_ERROR_REASONS)[number];

/** Asks per asker per rolling 24 hours before `429 rate_limited`. */
export const QA_MAX_ASKS_PER_DAY = 20;
/** Most data rows one CSV import may carry. */
export const QA_IMPORT_MAX_ROWS = 500;
/** Largest CSV body `POST /qa/import` accepts (characters). */
export const QA_IMPORT_MAX_BYTES = 1_048_576;
/** Written over an erased asker's subject, body and public text. */
export const QA_ERASED_TEXT = "[erased]";

export function isUnanswered(status: QaQuestionStatus): boolean {
  return (QA_UNANSWERED_STATUSES as readonly QaQuestionStatus[]).includes(status);
}

export function isReleased(status: QaQuestionStatus): boolean {
  return (QA_RELEASED_STATUSES as readonly QaQuestionStatus[]).includes(status);
}

// ---------------------------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------------------------

export const QA_ACTIONS = [
  "ask",
  "assign",
  "unassign",
  "save_answer",
  "submit",
  "approve",
  "reject",
  "release_asker",
  "release_target",
  "unpublish",
  "close",
  "withdraw",
  "reopen",
  "erase",
  "withdraw_for_review",
] as const;
export type QaAction = (typeof QA_ACTIONS)[number];

/** Facts some transitions branch on. Both default to false. */
export interface QaTransitionContext {
  /** The question has an assignee (after the action, for `assign`/`unassign`). */
  readonly hasAssignee?: boolean;
  /** The question has a live asker (`source = 'portal'` and the membership still exists). */
  readonly hasAsker?: boolean;
}

type Target =
  | QaQuestionStatus
  | "same"
  | ((ctx: Required<QaTransitionContext>) => QaQuestionStatus);

const openOrAssigned = (ctx: Required<QaTransitionContext>): QaQuestionStatus =>
  ctx.hasAssignee ? "assigned" : "open";

/**
 * `from` → result, per action. A missing entry means the action is refused in that status
 * (the route answers `409 conflict`). `"same"` keeps the status.
 */
const TRANSITIONS: Readonly<Record<QaAction, Partial<Record<QaQuestionStatus, Target>>>> = {
  // creation: see `nextStatus(null, "ask")`
  ask: {},
  assign: {
    open: "assigned",
    assigned: "same",
    awaiting_approval: "same",
    answered: "same",
    published: "same",
  },
  unassign: {
    open: "same",
    assigned: "open",
    awaiting_approval: "same",
    answered: "same",
    published: "same",
  },
  // editing a released answer is allowed: without requireApproval the release stands; with it,
  // a changed text takes the answer offline (`withdraw_for_review`)
  save_answer: {
    open: "same",
    assigned: "same",
    awaiting_approval: "same",
    answered: "same",
    published: "same",
  },
  submit: { open: "awaiting_approval", assigned: "awaiting_approval" },
  // stamps approval; release is a separate step. (A released answer can still be approved in
  // place — e.g. one edited before the workspace turned requireApproval on.)
  approve: { awaiting_approval: "same", answered: "same", published: "same" },
  reject: { awaiting_approval: openOrAssigned },
  release_asker: { open: "answered", assigned: "answered", awaiting_approval: "answered" },
  release_target: {
    open: "published",
    assigned: "published",
    awaiting_approval: "published",
    answered: "published",
  },
  unpublish: { published: (ctx) => (ctx.hasAsker ? "answered" : openOrAssigned(ctx)) },
  close: {
    open: "closed",
    assigned: "closed",
    awaiting_approval: "closed",
    answered: "closed",
    published: "closed",
  },
  // the asker, only before the answer is released
  withdraw: { open: "closed", assigned: "closed", awaiting_approval: "closed" },
  reopen: { closed: openOrAssigned },
  // four-eyes: a released answer whose text changed under requireApproval goes offline until it
  // is submitted, approved and released again
  withdraw_for_review: { answered: openOrAssigned, published: openOrAssigned },
  // DSAR erasure of the asker: whatever the status, the question ends closed/erased
  erase: {
    open: "closed",
    assigned: "closed",
    awaiting_approval: "closed",
    answered: "closed",
    published: "closed",
    closed: "closed",
  },
};

/**
 * The status after `action`, or null when the action is not allowed from `from`. `ask` is the
 * only action with no prior status (`from` null → `open`); every other action needs one.
 */
export function nextStatus(
  from: QaQuestionStatus | null,
  action: QaAction,
  ctx: QaTransitionContext = {},
): QaQuestionStatus | null {
  if (action === "ask") return from === null ? "open" : null;
  if (from === null) return null;
  const target = TRANSITIONS[action][from];
  if (target === undefined) return null;
  if (target === "same") return from;
  if (typeof target === "function") {
    return target({ hasAssignee: ctx.hasAssignee ?? false, hasAsker: ctx.hasAsker ?? false });
  }
  return target;
}

/** Whether `action` is allowed from `from` (see `nextStatus`). */
export function canTransition(from: QaQuestionStatus | null, action: QaAction): boolean {
  return nextStatus(from, action) !== null;
}

// ---------------------------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** `due_at` for a question asked at `createdAt` (the SLA clock starts at ask, D7). */
export function dueAtFor(createdAt: Date, slaHours: number): Date {
  return new Date(createdAt.getTime() + slaHours * HOUR_MS);
}

/**
 * The SLA indicator. `none` when there is no due time or the question is no longer waiting on
 * staff; `overdue` at or after `dueAt`; `due_soon` within `leadHours` of it (never when
 * `leadHours` is 0); otherwise `on_track`.
 */
export function slaState(
  dueAt: Date | null,
  now: Date,
  leadHours: number,
  status: QaQuestionStatus,
): QaSlaState {
  if (dueAt === null || !isUnanswered(status)) return "none";
  const due = dueAt.getTime();
  const t = now.getTime();
  if (t >= due) return "overdue";
  if (leadHours > 0 && t >= due - leadHours * HOUR_MS) return "due_soon";
  return "on_track";
}

// ---------------------------------------------------------------------------------------------
// Text, hashing, approval
// ---------------------------------------------------------------------------------------------

/** The published wording when staff give none: the asker's subject and body, as asked. */
export function defaultPublicText(subject: string, body: string): string {
  return `${subject.trim()}\n\n${body.trim()}`;
}

/** Lower-case hex SHA-256 of a UTF-8 string (`qa_answer.approved_body_sha256`). */
export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Whether the answer's approval covers its current body (four-eyes, D2). */
export function approvalCurrent(answer: {
  readonly body: string;
  readonly approvedBodySha256: string | null;
}): boolean {
  return answer.approvedBodySha256 !== null && answer.approvedBodySha256 === sha256Hex(answer.body);
}

/** Search title: the first non-empty line of the public text, at most 200 characters. */
export function qaSearchTitle(publicText: string): string {
  const line =
    publicText
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
