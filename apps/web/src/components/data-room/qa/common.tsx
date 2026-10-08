import { Alert, AlertDescription, AlertTitle, Badge } from "@fundroomhq/ui";
import { isApiError, isCode } from "../../../lib/api.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import type { QaQuestionStatus, QaQuestionView } from "../../../lib/qa-queries.js";
import { m } from "../../../paraglide/messages.js";
import { ErrorAlert } from "../../error-alert.js";

/*
 * Investor-facing status vocabulary (E3.3 D2). The staff workflow steps (open, assigned,
 * awaiting approval) are one state to the asker: the team has it and has not answered yet.
 */
export function qaStatusLabel(status: QaQuestionStatus): string {
  switch (status) {
    case "answered":
      return m.dataroom_qa_status_answered();
    case "published":
      return m.dataroom_qa_status_published();
    case "closed":
      return m.dataroom_qa_status_closed();
    default:
      return m.dataroom_qa_status_awaiting();
  }
}

export function QaStatusBadge({ status }: { status: QaQuestionStatus }) {
  const variant =
    status === "published" || status === "answered"
      ? "success"
      : status === "closed"
        ? "outline"
        : "secondary";
  return <Badge variant={variant}>{qaStatusLabel(status)}</Badge>;
}

/** The released answer, as plain text (staff prose; never HTML). */
export function QaAnswerBlock({
  answer,
  headingLevel = 3,
  headingId,
}: {
  answer: NonNullable<QaQuestionView["answer"]>;
  headingLevel?: 2 | 3;
  headingId: string;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} className="rounded-md border-l-4 border-primary/60 pl-3">
      <Heading id={headingId} className="text-sm font-semibold">
        {m.dataroom_qa_answer_heading()}
      </Heading>
      <p className="whitespace-pre-wrap text-sm">{answer.body}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {m.dataroom_qa_answered_at({ when: formatDateTime(answer.releasedAt) })}
      </p>
    </section>
  );
}

/*
 * When a question is dated (S7): the asker sees when they asked; anyone else sees only when it
 * was published — the server does not send them the ask time, which would date the asker.
 */
export function QaWhen({ q }: { q: QaQuestionView }) {
  const text = q.mine
    ? q.createdAt
      ? m.dataroom_qa_asked_on({ when: formatDate(q.createdAt) })
      : null
    : q.publishedAt
      ? m.dataroom_qa_published_on({ when: formatDate(q.publishedAt) })
      : null;
  return text === null ? null : <p className="text-xs text-muted-foreground">{text}</p>;
}

/** A list that failed: a stale "show more" cursor gets words of its own (C13). */
export function QaListError({ error }: { error: unknown }) {
  if (
    isCode(error, "validation_failed") &&
    isApiError(error) &&
    error.body.error["reason"] === "cursor"
  )
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.dataroom_qa_err_cursor_title()}</AlertTitle>
        <AlertDescription>{m.dataroom_qa_err_cursor_body()}</AlertDescription>
      </Alert>
    );
  return <ErrorAlert error={error} />;
}
