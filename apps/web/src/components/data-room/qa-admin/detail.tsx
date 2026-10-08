import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  LoadingState,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { useAiFeature } from "../../../lib/ai-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  QA_ADMIN_KEY,
  QA_ANSWER_ROLES,
  type QaInboxDetail,
  type QaInboxPatch,
  type QaVisibility,
  qaApprove,
  qaAssign,
  qaClose,
  qaInboxDetailQuery,
  qaPatch,
  qaReject,
  qaRelease,
  qaReopen,
  qaSaveAnswer,
  qaSubmit,
  qaUnpublish,
} from "../../../lib/qa-admin-queries.js";
import { dataRoomSettingsQuery, peopleQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { QaSuggestion } from "../../ai-admin/qa-suggestion.js";
import { NativeSelect } from "../../compliance/common.js";
import { ErrorAlert } from "../../error-alert.js";
import {
  QaErrorAlert,
  QaSlaBadge,
  QaStatusBadge,
  QaTargetLink,
  qaClosedReasonLabel,
} from "./common.js";
import type { QaPermissions } from "./inbox.js";

/** An ISO instant as a `datetime-local` value in the browser's zone. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/*
 * A status change removes the control that was pressed (and a dialog, on unmount, hands focus
 * back to its trigger — often gone too). Focus goes to the question's heading once that settled.
 */
function focusLater(ref: RefObject<HTMLElement | null>): void {
  setTimeout(() => ref.current?.focus(), 0);
}

function visibilityLabel(v: QaVisibility): string {
  return v === "asker"
    ? m.dataroom_qa_admin_visibility_asker()
    : m.dataroom_qa_admin_visibility_target();
}

/** The mutation plumbing every action shares: write the fresh detail, reload the lists. */
function useQaAction<TVars>(
  id: string,
  fn: (vars: TVars) => Promise<QaInboxDetail>,
  opts: { success?: string; onDone?: () => void } = {},
) {
  const qc = useQueryClient();
  return useGuardedMutation<QaInboxDetail, TVars>({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(qaInboxDetailQuery(id).queryKey, data);
      if (opts.success) toast.success(opts.success);
      opts.onDone?.();
    },
    // A refusal (409) usually means the question moved on underneath: reload it and the lists.
    onSettled: () => void qc.invalidateQueries({ queryKey: QA_ADMIN_KEY }),
  });
}

/*
 * One question (/admin/data-room/questions/<id>): everything staff may see, and the workflow
 * controls the viewer's permissions allow — `qa_answer` drafts and submits, `qa_approve`
 * approves or rejects (never their own answer: four-eyes), `qa_manage` assigns, releases,
 * unpublishes, closes, reopens and edits the metadata. Controls the viewer cannot use are absent.
 */
export function QaDetail({ id, perms }: { id: string; perms: QaPermissions }) {
  const detail = useQuery(qaInboxDetailQuery(id));
  const settings = useQuery(dataRoomSettingsQuery);
  const bootstrap = useBootstrap();
  const myMembershipId = bootstrap.data?.membership?.id;
  const headingRef = useRef<HTMLHeadingElement>(null);
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  const q = detail.data;
  const requireApproval = settings.data?.qa?.requireApproval ?? false;
  const defaultVisibility = settings.data?.qa?.defaultVisibility ?? "asker";
  return (
    <div className="space-y-6">
      <Link
        to="/admin/$"
        params={{ _splat: "data-room/questions" }}
        className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {m.dataroom_qa_admin_back()}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
          {q.subject}
        </h2>
        <QaStatusBadge status={q.status} />
        <QaSlaBadge sla={q.sla} />
      </div>
      <QuestionCard q={q} />
      <AssignmentCard q={q} canManage={perms.canManage} />
      <AnswerCard
        // Per question: the AI suggestion (and the editor below) never carry over to another one.
        key={q.id}
        q={q}
        perms={perms}
        requireApproval={requireApproval}
        myMembershipId={myMembershipId}
        headingRef={headingRef}
      />
      {perms.canManage ? (
        <ReleaseCard
          q={q}
          defaultVisibility={defaultVisibility}
          requireApproval={requireApproval}
          headingRef={headingRef}
        />
      ) : null}
      {perms.canManage ? <MetadataCard key={q.id} q={q} /> : null}
    </div>
  );
}

function QuestionCard({ q }: { q: QaInboxDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_question()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="whitespace-pre-wrap">{q.body}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_col_asker()}</dt>
          <dd>
            {q.asker ? (
              <>
                {q.asker.displayName}{" "}
                <span className="break-all text-muted-foreground">{q.asker.email}</span>
              </>
            ) : q.source === "import" ? (
              m.dataroom_qa_admin_source_import()
            ) : (
              m.dataroom_qa_admin_source_staff()
            )}
          </dd>
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_col_target()}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <QaTargetLink kind={q.target.kind} id={q.target.id} title={q.target.title} />
            {q.target.path ? <span className="text-muted-foreground">{q.target.path}</span> : null}
            {q.target.deleted ? (
              <Badge variant="destructive">{m.dataroom_qa_admin_target_trashed()}</Badge>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_category()}</dt>
          <dd>{q.category ?? "—"}</dd>
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_due()}</dt>
          <dd>{q.dueAt ? formatDateTime(q.dueAt) : "—"}</dd>
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_visibility()}</dt>
          <dd>
            {q.visibility ? visibilityLabel(q.visibility) : m.dataroom_qa_admin_not_released()}
          </dd>
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_col_created()}</dt>
          <dd>{formatDateTime(q.createdAt)}</dd>
          {q.releasedAt ? (
            <>
              <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_released()}</dt>
              <dd>{formatDateTime(q.releasedAt)}</dd>
            </>
          ) : null}
          {q.closedReason ? (
            <>
              <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_closed()}</dt>
              <dd>
                {q.closedAt
                  ? m.dataroom_qa_admin_closed_at({
                      reason: qaClosedReasonLabel(q.closedReason),
                      when: formatDateTime(q.closedAt),
                    })
                  : qaClosedReasonLabel(q.closedReason)}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{m.dataroom_qa_admin_field_internal_note()}</dt>
          <dd className="whitespace-pre-wrap">{q.internalNote ?? "—"}</dd>
        </dl>
        {q.publicText !== null ? (
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{m.dataroom_qa_admin_field_public_text()}</h3>
            <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{q.publicText}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AssignmentCard({ q, canManage }: { q: QaInboxDetail; canManage: boolean }) {
  const selectId = useId();
  const people = useQuery({
    // Only active staff: a dormant or suspended member cannot pick the question up (C11).
    ...peopleQuery({ kind: "staff", status: "active" }),
    enabled: canManage,
  });
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const assign = useQaAction(q.id, (assignee: string | null) => qaAssign(q.id, assignee), {
    success: m.dataroom_qa_admin_assigned_toast(),
    onDone: () => setChoice(undefined),
  });
  const current = q.assignee?.membershipId ?? "";
  const value = choice ?? current;
  // Only roles holding `data-room.qa_answer` can be assigned; the server re-checks (400
  // invalid_assignee), which is shown inline.
  const candidates = (people.data?.items ?? []).filter(
    (p) => p.status === "active" && QA_ANSWER_ROLES.includes(p.role),
  );
  const editable = canManage && q.status !== "closed";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_assignment()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {editable ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              assign.mutate(value === "" ? null : value);
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor={selectId}>{m.dataroom_qa_admin_col_assignee()}</Label>
              <NativeSelect
                id={selectId}
                value={value}
                className="w-64"
                disabled={people.isPending}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">{m.dataroom_qa_admin_unassigned()}</option>
                {q.assignee && !candidates.some((p) => p.membershipId === current) ? (
                  <option value={q.assignee.membershipId}>{q.assignee.displayName}</option>
                ) : null}
                {candidates.map((p) => (
                  <option key={p.membershipId} value={p.membershipId}>
                    {p.displayName}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="submit"
              variant="outline"
              loading={assign.isPending}
              disabled={value === current}
            >
              {m.dataroom_qa_admin_assign()}
            </Button>
          </form>
        ) : (
          <p className="text-sm">{q.assignee?.displayName ?? m.dataroom_qa_admin_unassigned()}</p>
        )}
        {people.isError ? <ErrorAlert error={people.error} /> : null}
        <QaErrorAlert error={assign.error} />
      </CardContent>
    </Card>
  );
}

function AnswerCard({
  q,
  perms,
  requireApproval,
  myMembershipId,
  headingRef,
}: {
  q: QaInboxDetail;
  perms: QaPermissions;
  requireApproval: boolean;
  myMembershipId: string | undefined;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const a = q.answer;
  const editable = perms.canAnswer && q.status !== "closed";
  const focusHeading = () => focusLater(headingRef);
  const submit = useQaAction(q.id, () => qaSubmit(q.id), {
    success: m.dataroom_qa_admin_submitted_toast(),
    onDone: focusHeading,
  });
  const approve = useQaAction(q.id, () => qaApprove(q.id), {
    success: m.dataroom_qa_admin_approved_toast(),
    onDone: focusHeading,
  });
  const [rejecting, setRejecting] = useState(false);
  const selfAuthored = a?.author != null && a.author.membershipId === myMembershipId;
  const canSubmit =
    perms.canAnswer &&
    requireApproval &&
    a !== null &&
    (q.status === "open" || q.status === "assigned");
  const canApproveNow =
    perms.canApprove &&
    requireApproval &&
    a !== null &&
    !a.approvalCurrent &&
    (q.status === "awaiting_approval" || q.status === "answered" || q.status === "published");
  const canReject = perms.canApprove && q.status === "awaiting_approval";
  // E3.12: "Suggest an answer" while the workspace has it effectively on. The request id lives
  // here, above the editor (which a save remounts), so the suggestion stays beside the answer.
  // R3-M5: a staff-entered or imported question has no asker whose access could bound the sources
  // (the task refuses `no_asker`), so the button is not offered for it.
  const aiSuggest = useAiFeature("qaAnswer", editable && q.asker !== null);
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_answer()}</CardTitle>
        {a ? (
          <CardDescription>
            {a.author
              ? m.dataroom_qa_admin_answer_by({ name: a.author.displayName })
              : m.dataroom_qa_admin_answer_by_unknown()}
            {a.submittedAt
              ? ` · ${m.dataroom_qa_admin_submitted_at({ when: formatDateTime(a.submittedAt) })}`
              : ""}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {a?.rejectedNote ? (
          <Alert variant="warning">
            <AlertTitle>{m.dataroom_qa_admin_rejected_title()}</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{a.rejectedNote}</AlertDescription>
          </Alert>
        ) : null}
        {a && requireApproval ? (
          <p className="text-sm" role="status">
            {a.approvedBy && a.approvedAt
              ? a.approvalCurrent
                ? m.dataroom_qa_admin_approved_by({
                    name: a.approvedBy.displayName,
                    when: formatDateTime(a.approvedAt),
                  })
                : m.dataroom_qa_admin_approval_stale()
              : m.dataroom_qa_admin_not_approved()}
          </p>
        ) : null}
        {editable ? (
          <AnswerEditor
            key={`${q.id}-${a?.body ?? ""}`}
            q={q}
            requireApproval={requireApproval}
            ai={aiSuggest ? { requestId: aiRequestId, onRequest: setAiRequestId } : undefined}
          />
        ) : a ? (
          <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{a.body}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{m.dataroom_qa_admin_no_answer()}</p>
        )}
        {canApproveNow && selfAuthored ? (
          <p className="text-sm text-muted-foreground">{m.dataroom_qa_admin_self_authored()}</p>
        ) : null}
        {canSubmit || canApproveNow || canReject ? (
          <div className="flex flex-wrap gap-2">
            {canSubmit ? (
              <Button type="button" loading={submit.isPending} onClick={() => submit.mutate()}>
                {m.dataroom_qa_admin_submit()}
              </Button>
            ) : null}
            {canApproveNow ? (
              <Button type="button" loading={approve.isPending} onClick={() => approve.mutate()}>
                {m.dataroom_qa_admin_approve()}
              </Button>
            ) : null}
            {canReject ? (
              <Button type="button" variant="outline" onClick={() => setRejecting(true)}>
                {m.dataroom_qa_admin_reject()}
              </Button>
            ) : null}
          </div>
        ) : null}
        <QaErrorAlert error={submit.error ?? approve.error} />
        {rejecting ? (
          <RejectDialog
            q={q}
            onClose={() => setRejecting(false)}
            onDone={() => {
              setRejecting(false);
              focusHeading();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function AnswerEditor({
  q,
  requireApproval,
  ai,
}: {
  q: QaInboxDetail;
  requireApproval: boolean;
  ai: { requestId: string | null; onRequest: (id: string | null) => void } | undefined;
}) {
  const id = useId();
  const [text, setText] = useState(q.answer?.body ?? "");
  const released = q.status === "answered" || q.status === "published";
  // Four-eyes (S2): under requireApproval a changed released answer is taken offline by the
  // server (back to open/assigned) until it is approved and released again.
  const takesOffline = released && requireApproval;
  const save = useQaAction(q.id, (body: string) => qaSaveAnswer(q.id, body), {
    success: takesOffline
      ? m.dataroom_qa_admin_answer_offline_toast()
      : m.dataroom_qa_admin_draft_saved(),
  });
  const dirty = text.trim() !== (q.answer?.body ?? "") && text.trim() !== "";
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (dirty) save.mutate(text.trim());
      }}
    >
      <Field
        id={id}
        label={m.dataroom_qa_admin_field_answer()}
        {...(released
          ? {
              description: takesOffline
                ? m.dataroom_qa_admin_released_edit_offline_hint()
                : m.dataroom_qa_admin_released_edit_hint(),
            }
          : {})}
      >
        <Textarea
          id={id}
          rows={8}
          maxLength={20000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          {...(released ? { "aria-describedby": `${id}-description` } : {})}
        />
      </Field>
      <Button type="submit" variant="outline" loading={save.isPending} disabled={!dirty}>
        {m.dataroom_qa_admin_save_draft()}
      </Button>
      <QaErrorAlert error={save.error} />
      {ai ? (
        <QaSuggestion
          questionId={q.id}
          requestId={ai.requestId}
          onRequest={ai.onRequest}
          editorText={text}
          onUse={setText}
        />
      ) : null}
    </form>
  );
}

function RejectDialog({
  q,
  onClose,
  onDone,
}: {
  q: QaInboxDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const reject = useQaAction(q.id, (n: string) => qaReject(q.id, n), {
    success: m.dataroom_qa_admin_rejected_toast(),
    onDone,
  });
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim() !== "") reject.mutate(note.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.dataroom_qa_admin_reject_title()}</DialogTitle>
            <DialogDescription>{m.dataroom_qa_admin_reject_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.dataroom_qa_admin_reject_note()} required>
            <Textarea
              id={id}
              rows={3}
              maxLength={2000}
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <QaErrorAlert error={reject.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {m.common_cancel()}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={reject.isPending}
              disabled={note.trim() === ""}
            >
              {m.dataroom_qa_admin_reject()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseCard({
  q,
  defaultVisibility,
  requireApproval,
  headingRef,
}: {
  q: QaInboxDetail;
  defaultVisibility: QaVisibility;
  requireApproval: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [dialog, setDialog] = useState<"release" | "close">();
  const focusHeading = () => focusLater(headingRef);
  const unpublish = useQaAction(q.id, () => qaUnpublish(q.id), {
    success: m.dataroom_qa_admin_unpublished_toast(),
    onDone: focusHeading,
  });
  const reopen = useQaAction(q.id, () => qaReopen(q.id), {
    success: m.dataroom_qa_admin_reopened_toast(),
    onDone: focusHeading,
  });
  const releasableStatus =
    q.status === "open" ||
    q.status === "assigned" ||
    q.status === "awaiting_approval" ||
    q.status === "answered";
  // Under requireApproval only an answer whose approval covers its current text may go out
  // (the server refuses with approval_required otherwise), so the button waits for it (C12).
  const needsApproval = requireApproval && q.answer !== null && !q.answer.approvalCurrent;
  const releasable = q.answer !== null && releasableStatus && !needsApproval;
  // A closed question whose asker withdrew it or was erased stays closed (S4/C6).
  const reopenable =
    q.status === "closed" && q.closedReason !== "withdrawn" && q.closedReason !== "erased";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_release_card()}</CardTitle>
        <CardDescription>{m.dataroom_qa_admin_release_card_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {releasable ? (
            <Button type="button" onClick={() => setDialog("release")}>
              {q.status === "answered"
                ? m.dataroom_qa_admin_publish()
                : m.dataroom_qa_admin_release()}
            </Button>
          ) : null}
          {q.status === "published" ? (
            <Button
              type="button"
              variant="outline"
              loading={unpublish.isPending}
              onClick={() => unpublish.mutate()}
            >
              {m.dataroom_qa_admin_unpublish()}
            </Button>
          ) : null}
          {q.status === "closed" ? (
            reopenable ? (
              <Button
                type="button"
                variant="outline"
                loading={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                {m.dataroom_qa_admin_reopen()}
              </Button>
            ) : null
          ) : (
            <Button type="button" variant="outline" onClick={() => setDialog("close")}>
              {m.dataroom_qa_admin_close()}
            </Button>
          )}
        </div>
        {q.answer === null && q.status !== "closed" ? (
          <p className="text-sm text-muted-foreground">
            {m.dataroom_qa_admin_release_needs_answer()}
          </p>
        ) : null}
        {needsApproval && releasableStatus ? (
          <p className="text-sm text-muted-foreground">
            {m.dataroom_qa_admin_release_needs_approval()}
          </p>
        ) : null}
        {q.status === "closed" && !reopenable ? (
          <p className="text-sm text-muted-foreground">
            {q.closedReason === "erased"
              ? m.dataroom_qa_admin_reason_erased()
              : m.dataroom_qa_admin_reason_withdrawn()}
          </p>
        ) : null}
        <QaErrorAlert error={unpublish.error ?? reopen.error} />
        {dialog === "release" ? (
          <ReleaseDialog
            q={q}
            defaultVisibility={defaultVisibility}
            onClose={() => setDialog(undefined)}
            onDone={() => {
              setDialog(undefined);
              focusHeading();
            }}
          />
        ) : null}
        {dialog === "close" ? (
          <CloseDialog
            q={q}
            onClose={() => setDialog(undefined)}
            onDone={() => {
              setDialog(undefined);
              focusHeading();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReleaseDialog({
  q,
  defaultVisibility,
  onClose,
  onDone,
}: {
  q: QaInboxDetail;
  defaultVisibility: QaVisibility;
  onClose: () => void;
  onDone: () => void;
}) {
  const base = useId();
  const hasAsker = q.asker !== null && q.source === "portal";
  // An already-answered question can only go further: to everyone who can see the target.
  const askerAllowed = hasAsker && q.status !== "answered";
  const [visibility, setVisibility] = useState<QaVisibility>(
    askerAllowed ? defaultVisibility : "target",
  );
  const [publicText, setPublicText] = useState(q.publicText ?? `${q.subject}\n\n${q.body}`);
  const release = useQaAction(
    q.id,
    (body: { visibility: QaVisibility; publicText?: string }) => qaRelease(q.id, body),
    { success: m.dataroom_qa_admin_released_toast(), onDone },
  );
  const textMissing = visibility === "target" && publicText.trim() === "";
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (textMissing) return;
            release.mutate(
              visibility === "target"
                ? { visibility, publicText: publicText.trim() }
                : { visibility },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.dataroom_qa_admin_release_title()}</DialogTitle>
            <DialogDescription>{m.dataroom_qa_admin_release_body()}</DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {m.dataroom_qa_admin_field_visibility()}
            </legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${base}-visibility`}
                value="asker"
                className="mt-1"
                checked={visibility === "asker"}
                disabled={!askerAllowed}
                onChange={() => setVisibility("asker")}
              />
              <span>
                <span className="font-medium">{m.dataroom_qa_admin_visibility_asker()}</span>
                <span className="block text-muted-foreground">
                  {hasAsker
                    ? m.dataroom_qa_admin_visibility_asker_hint()
                    : m.dataroom_qa_admin_visibility_asker_none()}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${base}-visibility`}
                value="target"
                className="mt-1"
                checked={visibility === "target"}
                onChange={() => setVisibility("target")}
              />
              <span>
                <span className="font-medium">{m.dataroom_qa_admin_visibility_target()}</span>
                <span className="block text-muted-foreground">
                  {m.dataroom_qa_admin_visibility_target_hint()}
                </span>
              </span>
            </label>
          </fieldset>
          {visibility === "target" ? (
            <>
              <Alert variant="warning">
                <AlertTitle>{m.dataroom_qa_admin_public_text_warning_title()}</AlertTitle>
                <AlertDescription>{m.dataroom_qa_admin_public_text_warning()}</AlertDescription>
              </Alert>
              <Field
                id={`${base}-text`}
                label={m.dataroom_qa_admin_field_public_text()}
                required
                {...(textMissing ? { error: m.dataroom_qa_admin_public_text_required() } : {})}
              >
                <Textarea
                  id={`${base}-text`}
                  rows={6}
                  maxLength={6000}
                  required
                  value={publicText}
                  onChange={(e) => setPublicText(e.target.value)}
                />
              </Field>
            </>
          ) : null}
          <QaErrorAlert error={release.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" loading={release.isPending} disabled={textMissing}>
              {m.dataroom_qa_admin_release_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({
  q,
  onClose,
  onDone,
}: {
  q: QaInboxDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [notify, setNotify] = useState(false);
  const close = useQaAction(q.id, (n: boolean) => qaClose(q.id, n), {
    success: m.dataroom_qa_admin_closed_toast(),
    onDone,
  });
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.dataroom_qa_admin_close_title()}</DialogTitle>
          <DialogDescription>{m.dataroom_qa_admin_close_body()}</DialogDescription>
        </DialogHeader>
        {q.asker ? (
          <div className="flex items-center gap-2">
            <Checkbox id={id} checked={notify} onCheckedChange={(on) => setNotify(on === true)} />
            <Label htmlFor={id}>{m.dataroom_qa_admin_close_notify()}</Label>
          </div>
        ) : null}
        <QaErrorAlert error={close.error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={close.isPending}
            onClick={() => close.mutate(q.asker !== null && notify)}
          >
            {m.dataroom_qa_admin_close()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetadataCard({ q }: { q: QaInboxDetail }) {
  const base = useId();
  const [category, setCategory] = useState(q.category ?? "");
  const [note, setNote] = useState(q.internalNote ?? "");
  const [due, setDue] = useState(toLocalInput(q.dueAt));
  const [publicText, setPublicText] = useState(q.publicText ?? "");
  const save = useQaAction(q.id, (body: QaInboxPatch) => qaPatch(q.id, body), {
    success: m.dataroom_qa_admin_saved_toast(),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const body: QaInboxPatch = {};
    if (category.trim() !== (q.category ?? ""))
      body.category = category.trim() === "" ? null : category.trim();
    if (note.trim() !== (q.internalNote ?? ""))
      body.internalNote = note.trim() === "" ? null : note.trim();
    if (due !== toLocalInput(q.dueAt)) body.dueAt = due === "" ? null : new Date(due).toISOString();
    if (q.status === "published" && publicText.trim() !== "" && publicText.trim() !== q.publicText)
      body.publicText = publicText.trim();
    if (Object.keys(body).length > 0) save.mutate(body);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_details()}</CardTitle>
        <CardDescription>{m.dataroom_qa_admin_details_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field id={`${base}-category`} label={m.dataroom_qa_admin_field_category()}>
            <Input
              id={`${base}-category`}
              value={category}
              maxLength={60}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
          <Field id={`${base}-due`} label={m.dataroom_qa_admin_field_due()}>
            <Input
              id={`${base}-due`}
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field
              id={`${base}-note`}
              label={m.dataroom_qa_admin_field_internal_note()}
              description={m.dataroom_qa_admin_internal_note_hint()}
            >
              <Textarea
                id={`${base}-note`}
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-describedby={`${base}-note-description`}
              />
            </Field>
          </div>
          {q.status === "published" ? (
            <div className="sm:col-span-2">
              <Field id={`${base}-public`} label={m.dataroom_qa_admin_field_public_text()}>
                <Textarea
                  id={`${base}-public`}
                  rows={5}
                  maxLength={6000}
                  value={publicText}
                  onChange={(e) => setPublicText(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <div className="space-y-3 sm:col-span-2">
            <Button type="submit" variant="outline" loading={save.isPending}>
              {m.common_save()}
            </Button>
            <QaErrorAlert error={save.error} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
