/** The investor projection of a question (E3.3): what an asker, and anyone else, may see. */
import type { QaQuestionView } from "./contracts.js";
import type { QaQuestionStatus, QaTargetKind, QaVisibility } from "./rules.js";
import { isReleased } from "./rules.js";

// ---------------------------------------------------------------------------------------------
// Investor view projection
// ---------------------------------------------------------------------------------------------

/** What `projectQuestionView` needs from a question row (plus its answer body, if any). */
export interface QaQuestionViewSource {
  readonly id: string;
  readonly targetKind: QaTargetKind;
  readonly documentId: string | null;
  readonly folderId: string | null;
  readonly askerMembershipId: string | null;
  readonly status: QaQuestionStatus;
  readonly subject: string;
  readonly body: string;
  readonly publicText: string | null;
  readonly visibility: QaVisibility | null;
  readonly createdAt: Date;
  readonly releasedAt: Date | null;
  readonly publishedAt: Date | null;
  /** The answer's body; null when there is no answer row. */
  readonly answerBody: string | null;
}

export interface QaViewer {
  /** The caller's membership; null for none. */
  readonly membershipId: string | null;
  /** Delegates never see their principal's (or their own) private questions. */
  readonly isDelegate: boolean;
}

/** Whether `viewer` asked this question (and so sees it in full). */
export function isMine(q: Pick<QaQuestionViewSource, "askerMembershipId">, viewer: QaViewer) {
  return (
    !viewer.isDelegate &&
    viewer.membershipId !== null &&
    q.askerMembershipId === viewer.membershipId
  );
}

/**
 * The investor-shaped view of a question (D2/D6), or null when `viewer` may not see it at all.
 * The asker sees their own question in any status, with the answer once released. Anyone else
 * sees only a `published` question, as `publicText` + answer — never the asker, the original
 * subject/body, the time it was asked, internal notes, the assignee or drafts. `targetTitle` is "" when the caller
 * cannot view the target. RLS and the target check are the service's job; this only shapes.
 */
export function projectQuestionView(
  q: QaQuestionViewSource,
  viewer: QaViewer,
  targetTitle: string,
): QaQuestionView | null {
  const mine = isMine(q, viewer);
  if (!mine && q.status !== "published") return null;
  const targetId = (q.targetKind === "document" ? q.documentId : q.folderId) ?? "";
  const released = isReleased(q.status);
  const releasedAt = released && q.releasedAt !== null ? q.releasedAt.toISOString() : null;
  const answer =
    released && q.answerBody !== null && releasedAt !== null
      ? { body: q.answerBody, releasedAt }
      : null;
  return {
    id: q.id,
    targetKind: q.targetKind,
    targetId,
    targetTitle,
    mine,
    status: mine ? q.status : "published",
    subject: mine ? q.subject : null,
    body: mine ? q.body : null,
    publicText: q.status === "published" ? q.publicText : null,
    answer,
    // when a rival bidder asked is itself a signal: only the asker gets the ask time
    createdAt: mine ? q.createdAt.toISOString() : null,
    publishedAt:
      q.status === "published" && q.publishedAt !== null ? q.publishedAt.toISOString() : null,
    releasedAt,
    visibility: released ? q.visibility : null,
  };
}
