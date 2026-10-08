import { Alert, AlertDescription, AlertTitle, Badge } from "@fundroomhq/ui";
import { Link } from "@tanstack/react-router";
import { isCode } from "../../../lib/api.js";
import {
  type QaInboxDetail,
  type QaQuestionStatus,
  type QaSlaState,
  type QaTargetKind,
  qaErrorReason,
} from "../../../lib/qa-admin-queries.js";
import { m } from "../../../paraglide/messages.js";
import { ErrorAlert } from "../../error-alert.js";

/** Tab labels double as the status badge text. */
export function qaStatusLabel(status: QaQuestionStatus): string {
  switch (status) {
    case "open":
      return m.dataroom_qa_admin_status_open();
    case "assigned":
      return m.dataroom_qa_admin_status_assigned();
    case "awaiting_approval":
      return m.dataroom_qa_admin_status_awaiting_approval();
    case "answered":
      return m.dataroom_qa_admin_status_answered();
    case "published":
      return m.dataroom_qa_admin_status_published();
    case "closed":
      return m.dataroom_qa_admin_status_closed();
  }
}

export function qaEmptyLabel(status: QaQuestionStatus): string {
  switch (status) {
    case "open":
      return m.dataroom_qa_admin_empty_open();
    case "assigned":
      return m.dataroom_qa_admin_empty_assigned();
    case "awaiting_approval":
      return m.dataroom_qa_admin_empty_awaiting_approval();
    case "answered":
      return m.dataroom_qa_admin_empty_answered();
    case "published":
      return m.dataroom_qa_admin_empty_published();
    case "closed":
      return m.dataroom_qa_admin_empty_closed();
  }
}

export function QaStatusBadge({ status }: { status: QaQuestionStatus }) {
  const variant =
    status === "published" || status === "answered"
      ? "success"
      : status === "awaiting_approval"
        ? "warning"
        : status === "closed"
          ? "outline"
          : "secondary";
  return <Badge variant={variant}>{qaStatusLabel(status)}</Badge>;
}

/** The SLA indicator: nothing to show once the question is no longer waiting on staff. */
export function QaSlaBadge({ sla }: { sla: QaSlaState }) {
  switch (sla) {
    case "on_track":
      return <Badge variant="success">{m.dataroom_qa_admin_sla_on_track()}</Badge>;
    case "due_soon":
      return <Badge variant="warning">{m.dataroom_qa_admin_sla_due_soon()}</Badge>;
    case "overdue":
      return <Badge variant="destructive">{m.dataroom_qa_admin_sla_overdue()}</Badge>;
    case "none":
      return <span className="text-muted-foreground">—</span>;
  }
}

/** Where the target lives in the admin file browser. */
export function QaTargetLink({
  kind,
  id,
  title,
}: {
  kind: QaTargetKind;
  id: string;
  title: string;
}) {
  const label = title === "" ? m.dataroom_qa_admin_target_untitled() : title;
  return (
    <Link
      to="/admin/$"
      params={{ _splat: `data-room/${kind === "document" ? "documents" : "folders"}/${id}` }}
      className="underline underline-offset-4"
    >
      {label}
    </Link>
  );
}

export function qaClosedReasonLabel(reason: NonNullable<QaInboxDetail["closedReason"]>): string {
  switch (reason) {
    case "declined":
      return m.dataroom_qa_admin_closed_declined();
    case "withdrawn":
      return m.dataroom_qa_admin_closed_withdrawn();
    case "erased":
      return m.dataroom_qa_admin_closed_erased();
  }
}

/** A human sentence for each `conflict`/`validation_failed` reason the Q&A routes give. */
export function qaReasonMessage(reason: string | undefined): string | undefined {
  switch (reason) {
    case "approval_required":
      return m.dataroom_qa_admin_reason_approval_required();
    case "self_approval":
      return m.dataroom_qa_admin_reason_self_approval();
    case "closed":
      return m.dataroom_qa_admin_reason_closed();
    case "no_asker":
      return m.dataroom_qa_admin_reason_no_asker();
    case "nothing_to_approve":
      return m.dataroom_qa_admin_reason_nothing_to_approve();
    case "approval_not_required":
      return m.dataroom_qa_admin_reason_approval_not_required();
    case "invalid_assignee":
      return m.dataroom_qa_admin_reason_invalid_assignee();
    case "public_text_required":
      return m.dataroom_qa_admin_reason_public_text_required();
    case "erased":
      return m.dataroom_qa_admin_reason_erased();
    case "withdrawn":
      return m.dataroom_qa_admin_reason_withdrawn();
    case "cursor":
      return m.dataroom_qa_admin_reason_cursor();
    default:
      return undefined;
  }
}

/** Inline refusal: the reason in words when the server named one, else the generic alert. */
export function QaErrorAlert({ error }: { error: unknown }) {
  if (error === undefined || error === null) return null;
  // A 409 whose reason this screen does not know still means "the question moved on": say so
  // in words rather than falling back to the generic conflict text.
  const message =
    qaReasonMessage(qaErrorReason(error)) ??
    (isCode(error, "conflict") ? m.dataroom_qa_admin_reason_conflict() : undefined);
  if (message === undefined) return <ErrorAlert error={error} />;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.dataroom_qa_admin_refused_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
