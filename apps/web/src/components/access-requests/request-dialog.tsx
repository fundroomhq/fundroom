import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  fieldAria,
  Input,
  Label,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../lib/api.js";
import { RELATIONSHIP_SOURCES, type RelationshipSource } from "../../lib/compliance-queries.js";
import { formatDate, formatDateTime } from "../../lib/format.js";
import { groupsQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { GroupPicker } from "../access/group-picker.js";
import { NativeSelect, relationshipSourceLabel } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";
import { AccessRequestStatusBadge } from "./common.js";
import {
  ACCESS_REQUESTS_KEY,
  type AccessRequest,
  type ApproveInput,
  approveAccessRequest,
  denyAccessRequest,
} from "./queries.js";

export type RequestDialogMode = "detail" | "approve" | "deny";

/*
 * One dialog per request with three faces: the detail (reason, firm, the decision once made),
 * the approve form and the deny form. Switching face keeps a single modal open, so focus never
 * bounces between stacked dialogs. The approve/deny faces are only reachable with
 * `access.manage` and only while the request is pending.
 */
export function RequestDialog({
  request,
  mode,
  onModeChange,
  onClose,
  canManage,
  requires506bRelationship,
}: {
  request: AccessRequest;
  mode: RequestDialogMode;
  onModeChange: (mode: RequestDialogMode) => void;
  onClose: () => void;
  canManage: boolean;
  requires506bRelationship: boolean;
}) {
  const decidable = canManage && request.status === "pending";
  const face = decidable ? mode : "detail";
  // Opening focuses the first control (Radix). Switching face inside the open dialog removes
  // the button that was pressed, so focus is moved to the new face's heading: a screen reader
  // announces the new view, and the next Tab lands on its first field.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const firstFace = useRef(face);
  useEffect(() => {
    if (face !== firstFace.current) titleRef.current?.focus();
  }, [face]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {face === "approve" ? (
          <ApproveForm
            titleRef={titleRef}
            request={request}
            requires506bRelationship={requires506bRelationship}
            onCancel={onClose}
            onDone={onClose}
          />
        ) : face === "deny" ? (
          <DenyForm titleRef={titleRef} request={request} onCancel={onClose} onDone={onClose} />
        ) : (
          <Detail
            request={request}
            decidable={decidable}
            onModeChange={onModeChange}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  request: r,
  decidable,
  onModeChange,
  onClose,
}: {
  request: AccessRequest;
  decidable: boolean;
  onModeChange: (mode: RequestDialogMode) => void;
  onClose: () => void;
}) {
  const groups = useQuery(groupsQuery);
  const groupName = (id: string) => groups.data?.groups.find((g) => g.id === id)?.name ?? null;
  const suggested = r.suggestedGroupIds.map(groupName).filter((n): n is string => n !== null);
  const notGiven = m.accessrequests_not_given();
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{m.accessrequests_detail_title({ name: r.name })}</DialogTitle>
        <DialogDescription>{m.accessrequests_detail_subtitle()}</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{m.accessrequests_field_status()}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AccessRequestStatusBadge status={r.status} />
          {r.autoApproved ? (
            <Badge variant="outline">{m.accessrequests_auto_approved()}</Badge>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">{m.accessrequests_col_email()}</dt>
        <dd className="break-all">{r.email}</dd>
        <dt className="text-muted-foreground">{m.accessrequests_col_firm()}</dt>
        <dd>{r.firm ?? notGiven}</dd>
        <dt className="text-muted-foreground">{m.accessrequests_field_reason()}</dt>
        <dd className="whitespace-pre-wrap">{r.reason ?? notGiven}</dd>
        <dt className="text-muted-foreground">{m.accessrequests_col_requested()}</dt>
        <dd>{formatDateTime(r.createdAt)}</dd>
        {r.verifiedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.accessrequests_field_verified()}</dt>
            <dd>{formatDateTime(r.verifiedAt)}</dd>
          </>
        )}
        {r.status === "pending" || r.status === "expired" ? (
          <>
            <dt className="text-muted-foreground">
              {r.status === "pending"
                ? m.accessrequests_col_expires()
                : m.accessrequests_col_expired()}
            </dt>
            <dd>
              {formatDateTime(r.status === "expired" ? (r.decidedAt ?? r.expiresAt) : r.expiresAt)}
            </dd>
          </>
        ) : null}
        {suggested.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{m.accessrequests_field_suggested_groups()}</dt>
            <dd className="flex flex-wrap gap-1">
              {suggested.map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
            </dd>
          </>
        ) : null}
        {r.decidedAt === null || r.status === "expired" ? null : (
          <>
            <dt className="text-muted-foreground">{m.accessrequests_col_decided()}</dt>
            <dd>
              {r.decidedBy
                ? m.accessrequests_decided_by({
                    when: formatDateTime(r.decidedAt),
                    name: r.decidedBy.displayName,
                  })
                : formatDateTime(r.decidedAt)}
            </dd>
          </>
        )}
        {r.decisionNote === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.accessrequests_note()}</dt>
            <dd className="whitespace-pre-wrap">{r.decisionNote}</dd>
          </>
        )}
        {r.relationship === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.accessrequests_relationship_legend()}</dt>
            <dd>
              {m.accessrequests_relationship_summary({
                source: relationshipSourceLabel(r.relationship.source),
                date: formatDate(r.relationship.establishedAt),
              })}
              {r.relationship.note ? (
                <span className="block whitespace-pre-wrap text-muted-foreground">
                  {r.relationship.note}
                </span>
              ) : null}
            </dd>
          </>
        )}
      </dl>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {m.common_close()}
        </Button>
        {decidable ? (
          <>
            <Button type="button" variant="outline" onClick={() => onModeChange("deny")}>
              {m.accessrequests_deny()}
            </Button>
            <Button type="button" onClick={() => onModeChange("approve")}>
              {m.accessrequests_approve()}
            </Button>
          </>
        ) : null}
      </DialogFooter>
    </div>
  );
}

function ConflictAlert() {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.accessrequests_error_conflict_title()}</AlertTitle>
      <AlertDescription>{m.accessrequests_error_conflict_body()}</AlertDescription>
    </Alert>
  );
}

function isConflict(error: unknown): boolean {
  return isApiError(error) && error.code === "conflict";
}

/** 409 because the address already has a pending invitation: resend or revoke that one. */
function isInvitePending(error: unknown): boolean {
  if (!isApiError(error) || error.code !== "conflict") return false;
  // The server flattens error details into the error object.
  return error.body.error["reason"] === "invite_pending";
}

function InvitePendingAlert() {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.accessrequests_error_invite_pending_title()}</AlertTitle>
      <AlertDescription>{m.accessrequests_error_invite_pending_body()}</AlertDescription>
    </Alert>
  );
}

/** Today in the browser's calendar, as a date input's `YYYY-MM-DD`. */
function todayInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ApproveForm({
  titleRef,
  request: r,
  requires506bRelationship,
  onCancel,
  onDone,
}: {
  titleRef: RefObject<HTMLHeadingElement | null>;
  request: AccessRequest;
  requires506bRelationship: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const base = useId();
  const queryClient = useQueryClient();
  const groups = useQuery(groupsQuery);
  const [groupIds, setGroupIds] = useState<string[]>(r.suggestedGroupIds);
  const [expiryText, setExpiryText] = useState("");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [source, setSource] = useState<RelationshipSource | "">("");
  const [establishedOn, setEstablishedOn] = useState("");
  const [relationshipNote, setRelationshipNote] = useState("");
  const [attempted, setAttempted] = useState(false);

  const expiry = Number(expiryText);
  const expiryValid =
    expiryText === "" || (/^\d+$/u.test(expiryText) && expiry >= 1 && expiry <= 90);
  // Under 506(b) the relationship is required; elsewhere it is optional, but the server takes
  // it only whole (source and date together).
  const relationshipWanted = requires506bRelationship || source !== "" || establishedOn !== "";
  const sourceError =
    relationshipWanted && source === ""
      ? m.accessrequests_relationship_source_required()
      : undefined;
  const dateError =
    relationshipWanted && establishedOn === ""
      ? m.accessrequests_relationship_date_required()
      : undefined;
  const valid = expiryValid && sourceError === undefined && dateError === undefined;
  const show = (error: string | undefined) => (attempted ? error : undefined);

  // Suggested groups are only those still in the loaded list: one archived since the request
  // arrived is neither offered nor sent. Until the list has loaded nothing can be checked, so
  // approving waits for it.
  const liveGroupIds = groups.data ? new Set(groups.data.groups.map((g) => g.id)) : undefined;
  const selectedGroupIds = liveGroupIds ? groupIds.filter((id) => liveGroupIds.has(id)) : [];
  const approve = useGuardedMutation({
    mutationFn: (body: ApproveInput) => approveAccessRequest(r.id, body),
    onSuccess: (result) => {
      if (result.mailSent) toast.success(m.accessrequests_approved({ email: r.email }));
      else toast.warning(m.accessrequests_approved_mail_failed());
      onDone();
    },
    // Whatever the answer — even a refusal — the queue may have changed underneath (decided
    // elsewhere, expired), so it is reloaded either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["access", "invites"] });
    },
  });
  const relationshipRefused =
    isApiError(approve.error) && approve.error.code === "relationship_attestation_required";

  function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!valid || groups.isPending) return;
    approve.mutate({
      groupIds: selectedGroupIds,
      ...(expiryText === "" ? {} : { expiresInDays: expiry }),
      ...(message.trim() === "" ? {} : { message: message.trim() }),
      ...(note.trim() === "" ? {} : { note: note.trim() }),
      ...(source !== "" && establishedOn !== ""
        ? {
            relationship: {
              source,
              establishedAt: `${establishedOn}T00:00:00.000Z`,
              ...(relationshipNote.trim() === "" ? {} : { note: relationshipNote.trim() }),
            },
          }
        : {}),
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {m.accessrequests_approve_title({ name: r.name })}
        </DialogTitle>
        <DialogDescription>{m.accessrequests_approve_body({ email: r.email })}</DialogDescription>
      </DialogHeader>
      {groups.data && groups.data.groups.length > 0 ? (
        <GroupPicker
          groups={groups.data.groups}
          value={selectedGroupIds}
          onChange={setGroupIds}
          legend={m.accessrequests_groups()}
          description={m.accessrequests_groups_hint()}
          idPrefix={`${base}-group`}
        />
      ) : null}
      {groups.isError ? <ErrorAlert error={groups.error} /> : null}
      <Field
        id={`${base}-expiry`}
        label={m.accessrequests_expiry()}
        description={m.accessrequests_expiry_hint()}
        error={show(expiryValid ? undefined : m.accessrequests_expiry_invalid())}
        className="max-w-xs"
      >
        <Input
          id={`${base}-expiry`}
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          value={expiryText}
          onChange={(e) => setExpiryText(e.target.value)}
          {...fieldAria(`${base}-expiry`, {
            description: true,
            error: attempted && !expiryValid,
          })}
        />
      </Field>
      <Field
        id={`${base}-message`}
        label={m.accessrequests_message()}
        description={m.accessrequests_message_hint()}
      >
        <Textarea
          id={`${base}-message`}
          rows={2}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-describedby={`${base}-message-description`}
        />
      </Field>
      <Field
        id={`${base}-note`}
        label={m.accessrequests_note()}
        description={m.accessrequests_note_hint()}
      >
        <Textarea
          id={`${base}-note`}
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby={`${base}-note-description`}
        />
      </Field>
      <fieldset className="space-y-3 rounded-md border p-3" aria-describedby={`${base}-rel-hint`}>
        <legend className="px-1 text-sm font-medium">
          {m.accessrequests_relationship_legend()}
          {requires506bRelationship ? (
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          ) : null}
        </legend>
        {requires506bRelationship ? (
          <Alert variant="warning" id={`${base}-rel-hint`}>
            <AlertTitle>{m.accessrequests_relationship_506b_title()}</AlertTitle>
            <AlertDescription>{m.accessrequests_relationship_506b()}</AlertDescription>
          </Alert>
        ) : (
          <p id={`${base}-rel-hint`} className="text-sm text-muted-foreground">
            {m.accessrequests_relationship_optional()}
          </p>
        )}
        {relationshipRefused ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.accessrequests_relationship_506b_title()}</AlertTitle>
            <AlertDescription>{m.accessrequests_error_relationship_required()}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${base}-source`}
            label={m.relationship_field_source()}
            error={show(sourceError)}
            required={requires506bRelationship}
          >
            <NativeSelect
              id={`${base}-source`}
              value={source}
              required={requires506bRelationship}
              onChange={(e) => setSource(e.target.value as RelationshipSource | "")}
              {...fieldAria(`${base}-source`, { error: show(sourceError) !== undefined })}
            >
              <option value="">{m.relationship_source_unrecorded()}</option>
              {RELATIONSHIP_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {relationshipSourceLabel(s)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={`${base}-date`}
            label={m.relationship_field_established()}
            error={show(dateError)}
            required={requires506bRelationship}
          >
            <Input
              id={`${base}-date`}
              type="date"
              max={todayInputValue()}
              value={establishedOn}
              required={requires506bRelationship}
              onChange={(e) => setEstablishedOn(e.target.value)}
              {...fieldAria(`${base}-date`, { error: show(dateError) !== undefined })}
            />
          </Field>
        </div>
        <Field
          id={`${base}-rel-note`}
          label={m.relationship_field_note()}
          description={m.relationship_field_note_hint()}
        >
          <Textarea
            id={`${base}-rel-note`}
            rows={2}
            maxLength={2000}
            value={relationshipNote}
            onChange={(e) => setRelationshipNote(e.target.value)}
            aria-describedby={`${base}-rel-note-description`}
          />
        </Field>
      </fieldset>
      {isInvitePending(approve.error) ? (
        <InvitePendingAlert />
      ) : isConflict(approve.error) ? (
        <ConflictAlert />
      ) : null}
      {approve.isError && !isConflict(approve.error) && !relationshipRefused ? (
        <ErrorAlert error={approve.error} />
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" loading={approve.isPending} disabled={groups.isPending}>
          {m.accessrequests_approve_submit()}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DenyForm({
  titleRef,
  request: r,
  onCancel,
  onDone,
}: {
  titleRef: RefObject<HTMLHeadingElement | null>;
  request: AccessRequest;
  onCancel: () => void;
  onDone: () => void;
}) {
  const base = useId();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const deny = useGuardedMutation({
    mutationFn: () =>
      denyAccessRequest(r.id, {
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        notifyRequester: notify,
      }),
    onSuccess: () => {
      toast.success(m.accessrequests_denied());
      onDone();
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY }),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        deny.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
          {m.accessrequests_deny_title({ name: r.name })}
        </DialogTitle>
        <DialogDescription>{m.accessrequests_deny_body()}</DialogDescription>
      </DialogHeader>
      <Field
        id={`${base}-note`}
        label={m.accessrequests_note()}
        description={m.accessrequests_deny_note_hint()}
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
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${base}-notify`}
          checked={notify}
          onCheckedChange={(on) => setNotify(on === true)}
          aria-describedby={`${base}-notify-hint`}
          className="mt-0.5"
        />
        <div className="grid gap-1">
          <Label htmlFor={`${base}-notify`}>{m.accessrequests_notify()}</Label>
          <p id={`${base}-notify-hint`} className="text-sm text-muted-foreground">
            {m.accessrequests_notify_hint()}
          </p>
        </div>
      </div>
      {isConflict(deny.error) ? <ConflictAlert /> : null}
      {deny.isError && !isConflict(deny.error) ? <ErrorAlert error={deny.error} /> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" variant="destructive" loading={deny.isPending}>
          {m.accessrequests_deny_submit()}
        </Button>
      </DialogFooter>
    </form>
  );
}
