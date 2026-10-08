import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  fieldAria,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, ShieldCheck, ShieldOff } from "lucide-react";
import { type FormEvent, Fragment, useId, useState } from "react";
import { personName } from "../../../components/access/common.js";
import { AnchorSummary, AnchorsCard } from "../../../components/audit/anchors.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { CopyButton } from "../../../components/copy-button.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { describeError, isApiError, isCode } from "../../../lib/api.js";
import {
  AUDIT_ACTION_RE,
  AUDIT_RESOURCE_KIND_RE,
  type AuditEvent,
  type AuditExportResult,
  type AuditFilter,
  type AuditOutcome,
  auditEventsQuery,
  auditExportKeysQuery,
  downloadAuditExport,
  verifyAuditChain,
} from "../../../lib/audit-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { peopleQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/audit/")({ component: AuditPage });

/*
 * The audit log (E2.7). Four jobs on one screen, in the order an admin reaches for them:
 *
 *  - **Find what happened.** Filters are native inputs (they are what jsdom and a keyboard
 *    both handle best), applied on submit so a half-typed action prefix never hits the server.
 *    The list is cursor-paged newest first; each row expands to its `meta` and `diff` as JSON.
 *  - **Prove nothing was changed.** "Verify chain" walks the hash chain server-side on demand
 *    (never on load: it reads every row) and shows the verdict and any problems verbatim.
 *  - **Hand it to someone else.** The signed export is a zip counsel or an auditor can check
 *    offline; it needs `audit.export` and a fresh session, so the download goes through
 *    `useGuardedMutation` like any other step-up write.
 *  - **Say what to check it against.** The public keys, copyable, and the one CLI command.
 *  - **Show who else witnessed it** (E3.13). External anchors: which drivers the operator runs,
 *    each checkpoint's receipts, and the proof file a third party verifies offline.
 */
function AuditPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("audit.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.audit_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  const slug = bootstrap.data?.workspace?.slug ?? "";
  return (
    <div className="space-y-6">
      <PageHeader title={m.audit_title()} description={m.audit_subtitle()} />
      <EventsCard canPickPeople={permissions.includes("access.read")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <VerifyCard />
        <ExportCard canExport={permissions.includes("audit.export")} slug={slug} />
      </div>
      <AnchorsCard canExport={permissions.includes("audit.export")} />
      <KeysCard />
    </div>
  );
}

// --- filters + events ---------------------------------------------------------------------------

interface Draft {
  action: string;
  actor: string;
  subject: string;
  resourceKind: string;
  outcome: "" | AuditOutcome;
  from: string;
  to: string;
}

const EMPTY_DRAFT: Draft = {
  action: "",
  actor: "",
  subject: "",
  resourceKind: "",
  outcome: "",
  from: "",
  to: "",
};

/** `<input type="date">` gives a local calendar day; the API wants an instant. */
function dayStart(day: string): string | undefined {
  if (day === "") return undefined;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function dayEnd(day: string): string | undefined {
  if (day === "") return undefined;
  const d = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toFilter(draft: Draft): AuditFilter {
  return {
    action: draft.action.trim() || undefined,
    actorMembershipId: draft.actor || undefined,
    subjectMembershipId: draft.subject || undefined,
    resourceKind: draft.resourceKind.trim() || undefined,
    outcome: draft.outcome || undefined,
    from: dayStart(draft.from),
    to: dayEnd(draft.to),
  };
}

function outcomeLabel(outcome: AuditOutcome): string {
  switch (outcome) {
    case "success":
      return m.audit_outcome_success();
    case "denied":
      return m.audit_outcome_denied();
    case "failure":
      return m.audit_outcome_failure();
  }
}

function OutcomeBadge({ outcome }: { outcome: AuditOutcome }) {
  const variant =
    outcome === "success" ? "success" : outcome === "denied" ? "warning" : "destructive";
  return <Badge variant={variant}>{outcomeLabel(outcome)}</Badge>;
}

function actorLabel(event: AuditEvent): string {
  if (event.actorName) return event.actorName;
  switch (event.actorKind) {
    case "system":
      return m.audit_actor_system();
    case "host":
      return m.audit_actor_host();
    default:
      return event.actorMembershipId === null ? "—" : m.audit_actor_unknown();
  }
}

function EventsCard({ canPickPeople }: { canPickPeople: boolean }) {
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<AuditFilter>({});
  const [errors, setErrors] = useState<{ action?: string; resourceKind?: string; range?: string }>(
    {},
  );
  const people = useQuery({ ...peopleQuery({}), enabled: canPickPeople });
  const events = useInfiniteQuery(auditEventsQuery(applied));
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    const action = draft.action.trim();
    if (action !== "" && !AUDIT_ACTION_RE.test(action))
      next.action = m.audit_filter_action_invalid();
    const kind = draft.resourceKind.trim();
    if (kind !== "" && !AUDIT_RESOURCE_KIND_RE.test(kind))
      next.resourceKind = m.audit_filter_resource_invalid();
    if (draft.from !== "" && draft.to !== "" && draft.from > draft.to)
      next.range = m.audit_filter_range_invalid();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setApplied(toFilter(draft));
  }

  function reset() {
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setApplied({});
  }

  const personOptions = (people.data?.items ?? []).map((p) => ({
    id: p.membershipId,
    label: personName(p),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.audit_events_title()}</CardTitle>
        <CardDescription>{m.audit_events_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          aria-label={m.audit_filters_label()}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={apply}
          noValidate
        >
          <Field
            id={`${ids}-action`}
            label={m.audit_filter_action()}
            description={m.audit_filter_action_hint()}
            error={errors.action}
          >
            <Input
              id={`${ids}-action`}
              value={draft.action}
              placeholder="access."
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set("action", e.target.value)}
              {...fieldAria(`${ids}-action`, { description: true, error: !!errors.action })}
            />
          </Field>
          {canPickPeople ? (
            <>
              <Field id={`${ids}-actor`} label={m.audit_filter_actor()}>
                <NativeSelect
                  id={`${ids}-actor`}
                  value={draft.actor}
                  onChange={(e) => set("actor", e.target.value)}
                >
                  <option value="">{m.audit_filter_anyone()}</option>
                  {personOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id={`${ids}-subject`} label={m.audit_filter_subject()}>
                <NativeSelect
                  id={`${ids}-subject`}
                  value={draft.subject}
                  onChange={(e) => set("subject", e.target.value)}
                >
                  <option value="">{m.audit_filter_anyone()}</option>
                  {personOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          ) : null}
          <Field
            id={`${ids}-kind`}
            label={m.audit_filter_resource()}
            description={m.audit_filter_resource_hint()}
            error={errors.resourceKind}
          >
            <Input
              id={`${ids}-kind`}
              value={draft.resourceKind}
              placeholder="membership"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set("resourceKind", e.target.value)}
              {...fieldAria(`${ids}-kind`, { description: true, error: !!errors.resourceKind })}
            />
          </Field>
          <Field id={`${ids}-outcome`} label={m.audit_filter_outcome()}>
            <NativeSelect
              id={`${ids}-outcome`}
              value={draft.outcome}
              onChange={(e) => set("outcome", e.target.value as Draft["outcome"])}
            >
              <option value="">{m.audit_filter_any_outcome()}</option>
              <option value="success">{m.audit_outcome_success()}</option>
              <option value="denied">{m.audit_outcome_denied()}</option>
              <option value="failure">{m.audit_outcome_failure()}</option>
            </NativeSelect>
          </Field>
          <Field id={`${ids}-from`} label={m.audit_filter_from()} error={errors.range}>
            <Input
              id={`${ids}-from`}
              type="date"
              value={draft.from}
              onChange={(e) => set("from", e.target.value)}
              {...fieldAria(`${ids}-from`, { error: !!errors.range })}
            />
          </Field>
          <Field id={`${ids}-to`} label={m.audit_filter_to()}>
            <Input
              id={`${ids}-to`}
              type="date"
              value={draft.to}
              onChange={(e) => set("to", e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm">
              {m.audit_filter_apply()}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              {m.audit_filter_reset()}
            </Button>
          </div>
        </form>

        {events.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
        {events.isError ? <ErrorAlert error={events.error} /> : null}
        {events.data ? (
          items.length === 0 ? (
            <EmptyState title={m.audit_events_empty()} description={m.audit_events_empty_body()} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.audit_col_when()}</TableHead>
                    <TableHead>{m.audit_col_action()}</TableHead>
                    <TableHead>{m.audit_col_actor()}</TableHead>
                    <TableHead>{m.audit_col_subject()}</TableHead>
                    <TableHead>{m.audit_col_resource()}</TableHead>
                    <TableHead>{m.audit_col_outcome()}</TableHead>
                    <TableHead>
                      <span className="sr-only">{m.audit_col_details()}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </TableBody>
              </Table>
              {events.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={events.isFetchingNextPage}
                  onClick={() => void events.fetchNextPage()}
                >
                  {m.common_load_more()}
                </Button>
              ) : null}
            </>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function EventRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <Fragment>
      <TableRow>
        <TableCell className="whitespace-nowrap">{formatDateTime(event.occurredAt)}</TableCell>
        <TableCell>
          <code className="font-mono text-xs">{event.action}</code>
        </TableCell>
        <TableCell>{actorLabel(event)}</TableCell>
        <TableCell>
          {event.subjectName ??
            (event.subjectMembershipId === null ? "—" : m.audit_actor_unknown())}
        </TableCell>
        <TableCell>
          <code className="font-mono text-xs">{event.resourceKind}</code>
        </TableCell>
        <TableCell>
          <OutcomeBadge outcome={event.outcome} />
        </TableCell>
        <TableCell>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={m.audit_details_named({ seq: String(event.seq), action: event.action })}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? m.audit_details_hide() : m.audit_details_show()}
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/40">
            <section
              id={detailId}
              aria-label={m.audit_details_named({ seq: String(event.seq), action: event.action })}
              className="grid gap-4 lg:grid-cols-2"
            >
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm lg:col-span-2">
                <dt className="text-muted-foreground">{m.audit_detail_seq()}</dt>
                <dd className="font-mono text-xs">{event.seq}</dd>
                <dt className="text-muted-foreground">{m.audit_detail_resource_id()}</dt>
                <dd className="break-all font-mono text-xs">{event.resourceId ?? "—"}</dd>
                <dt className="text-muted-foreground">{m.audit_detail_ip()}</dt>
                <dd className="font-mono text-xs">{event.ip ?? "—"}</dd>
                <dt className="text-muted-foreground">{m.audit_detail_user_agent()}</dt>
                <dd className="break-all text-xs">{event.userAgent ?? "—"}</dd>
                <dt className="text-muted-foreground">{m.audit_detail_request_id()}</dt>
                <dd className="break-all font-mono text-xs">{event.requestId ?? "—"}</dd>
                {event.onBehalfOfMembershipId === null ? null : (
                  <>
                    <dt className="text-muted-foreground">{m.audit_detail_on_behalf_of()}</dt>
                    <dd className="break-all font-mono text-xs">{event.onBehalfOfMembershipId}</dd>
                  </>
                )}
              </dl>
              <div className="min-w-0 space-y-1">
                <h3 className="text-sm font-medium">{m.audit_detail_meta()}</h3>
                <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs">
                  {json(event.meta)}
                </pre>
              </div>
              <div className="min-w-0 space-y-1">
                <h3 className="text-sm font-medium">{m.audit_detail_diff()}</h3>
                <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs">
                  {json(event.diff)}
                </pre>
              </div>
            </section>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

// --- verify -------------------------------------------------------------------------------------

function VerifyCard() {
  const verify = useGuardedMutation({ mutationFn: verifyAuditChain });
  const result = verify.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.audit_verify_title()}</CardTitle>
        <CardDescription>{m.audit_verify_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          type="button"
          variant="outline"
          loading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          <ShieldCheck aria-hidden="true" />
          {m.audit_verify_button()}
        </Button>
        {verify.isError ? <ErrorAlert error={verify.error} /> : null}
        {result ? (
          <Alert variant={result.ok ? "default" : "destructive"} role="status">
            <AlertTitle>{result.ok ? m.audit_verify_ok() : m.audit_verify_failed()}</AlertTitle>
            <AlertDescription>
              <p>
                {m.audit_verify_summary({
                  rows: String(result.checkedRows),
                  checkpoints: String(result.checkpoints),
                  head: String(result.headSeq),
                })}
              </p>
              {result.problems.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.problems.map((problem) => (
                    <li key={problem} className="break-all font-mono text-xs">
                      {problem}
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.anchors ? <AnchorSummary anchors={result.anchors} /> : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- export -------------------------------------------------------------------------------------

function exportErrorMessage(error: unknown): string {
  if (isCode(error, "payload_too_large")) return m.audit_export_too_large();
  if (
    isCode(error, "conflict") &&
    isApiError(error) &&
    error.body.error["reason"] === "export_running"
  )
    return m.audit_export_running();
  return describeError(error).body;
}

function ExportCard({ canExport, slug }: { canExport: boolean; slug: string }) {
  const ids = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<AuditExportResult | null>(null);
  const rangeInvalid = from !== "" && to !== "" && from > to;
  const exportZip = useGuardedMutation({
    mutationFn: () => downloadAuditExport({ from: dayStart(from), to: dayEnd(to) }, slug),
    onSuccess: (result) => {
      setLast(result);
      setOpen(false);
      toast.success(m.audit_export_done({ file: result.filename }));
    },
    onError: (error) => toast.error(exportErrorMessage(error)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.audit_export_title()}</CardTitle>
        <CardDescription>{m.audit_export_body()}</CardDescription>
        {canExport ? (
          <CardAction>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <Download aria-hidden="true" />
                  {m.audit_export_open()}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!rangeInvalid) exportZip.mutate();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>{m.audit_export_dialog_title()}</DialogTitle>
                    <DialogDescription>{m.audit_export_dialog_body()}</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id={`${ids}-from`}
                      label={m.audit_filter_from()}
                      error={rangeInvalid ? m.audit_filter_range_invalid() : undefined}
                    >
                      <Input
                        id={`${ids}-from`}
                        type="date"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                        {...fieldAria(`${ids}-from`, { error: rangeInvalid })}
                      />
                    </Field>
                    <Field id={`${ids}-to`} label={m.audit_filter_to()}>
                      <Input
                        id={`${ids}-to`}
                        type="date"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </Field>
                  </div>
                  {exportZip.isError ? (
                    <Alert variant="destructive" role="alert">
                      <AlertDescription>{exportErrorMessage(exportZip.error)}</AlertDescription>
                    </Alert>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="outline">
                        {m.common_cancel()}
                      </Button>
                    </DialogClose>
                    <Button type="submit" disabled={rangeInvalid} loading={exportZip.isPending}>
                      {m.audit_export_submit()}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {canExport ? null : <p className="text-muted-foreground">{m.audit_export_forbidden()}</p>}
        {last?.sha256 ? (
          <div className="space-y-2">
            <p className="font-medium">{m.audit_export_sha({ file: last.filename })}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {last.sha256}
              </code>
              <CopyButton value={last.sha256} label={m.audit_export_sha_copy()} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- keys ---------------------------------------------------------------------------------------

function KeysCard() {
  const keys = useQuery(auditExportKeysQuery);
  const current = keys.data?.keys.find((k) => k.current);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.audit_keys_title()}</CardTitle>
        <CardDescription>{m.audit_keys_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {keys.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {keys.isError ? <ErrorAlert error={keys.error} /> : null}
        {keys.data ? (
          <ul className="space-y-3">
            {keys.data.keys.map((key) => (
              <li key={key.keyId} className="space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {m.audit_key_id({ id: key.keyId, alg: keys.data.alg })}
                  </span>
                  {key.current ? <Badge variant="success">{m.audit_key_current()}</Badge> : null}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {key.publicKey}
                  </code>
                  <CopyButton value={key.publicKey} label={m.audit_key_copy({ id: key.keyId })} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <Alert>
          <AlertTitle>{m.audit_howto_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.audit_howto_body()}</p>
            <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-xs">
              {`fundroom audit verify-export audit-export.zip --public-key ${current?.publicKey ?? "<public key>"}`}
            </pre>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
