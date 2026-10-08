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
  Field,
  Input,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog, personName } from "../../../components/access/common.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError, isApiError } from "../../../lib/api.js";
import {
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  type DataRequest,
  type DataRequestKind,
  type DataRequestStatus,
  dataRequestsQuery,
  downloadSubjectExport,
} from "../../../lib/compliance-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { peopleQuery } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { CreateErasureCard } from "./-erasure-requests.js";

/*
 * Data-subject requests of every kind (E2.7): access (a copy of what we hold), rectification
 * (a correction) and erasure (E2.6). One list with kind and status filters; a row opens its
 * detail — the statutory deadline, the steps each module reported with their counts, what is
 * still pending, the completion note and the sha256 of the export that answered an access
 * request. Staff with `compliance.manage` can record access/rectification requests, download
 * the subject's export (a zip; a `fresh` route, so it runs through `useGuardedMutation` like any
 * other step-up write), and mark access/rectification requests complete. The download itself
 * changes nothing: its sha256 (`X-Content-SHA256`) is remembered and prefilled into "Mark
 * complete", which the server checks against the export it audited. Erasure keeps its own
 * creation card and completes itself once every module has reported — unless its subject has
 * become the workspace's last owner (`blockedReason: "last_owner"`), which the detail explains
 * and which "Finish erasure" completes once ownership has moved.
 *
 * The file is `-`-prefixed so the router generator does not treat it as a route.
 */
const DATA_REQUESTS_KEY = ["compliance", "data-requests"] as const;

function kindLabel(kind: DataRequestKind): string {
  switch (kind) {
    case "access":
      return m.dsar_kind_access();
    case "rectification":
      return m.dsar_kind_rectification();
    case "erasure":
      return m.dsar_kind_erasure();
  }
}

function statusLabel(status: DataRequestStatus): string {
  switch (status) {
    case "requested":
      return m.erasure_status_requested();
    case "completed":
      return m.erasure_status_completed();
    case "cancelled":
      return m.erasure_status_cancelled();
  }
}

function subjectName(r: DataRequest): string {
  return r.subjectName ?? m.erasure_member_ref({ id: r.membershipId.slice(0, 8) });
}

export function DataRequestsArea({ canManage }: { canManage: boolean }) {
  const [kind, setKind] = useState<DataRequestKind | "">("");
  const [status, setStatus] = useState<DataRequestStatus | "">("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const base = useId();
  const requests = useInfiniteQuery(
    dataRequestsQuery({
      kind: kind === "" ? undefined : kind,
      status: status === "" ? undefined : status,
    }),
  );
  const items = requests.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = items.find((r) => r.id === selectedId);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{m.dsar_title()}</CardTitle>
          <CardDescription>{m.dsar_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{m.erasure_retained()}</p>
          <div className="grid gap-4 sm:grid-cols-2 md:max-w-xl">
            <Field id={`${base}-kind`} label={m.dsar_filter_kind()}>
              <NativeSelect
                id={`${base}-kind`}
                value={kind}
                onChange={(e) => setKind(e.target.value as DataRequestKind | "")}
              >
                <option value="">{m.dsar_filter_all()}</option>
                {DATA_REQUEST_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={`${base}-status`} label={m.dsar_filter_status()}>
              <NativeSelect
                id={`${base}-status`}
                value={status}
                onChange={(e) => setStatus(e.target.value as DataRequestStatus | "")}
              >
                <option value="">{m.dsar_filter_all()}</option>
                {DATA_REQUEST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {requests.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
          {requests.isError ? <ErrorAlert error={requests.error} /> : null}
          {requests.data && items.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">{m.dsar_empty()}</p>
          ) : null}
          {items.length > 0 ? (
            <div className="overflow-x-auto">
              <Table aria-label={m.dsar_title()}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.erasure_col_person()}</TableHead>
                    <TableHead>{m.dsar_col_kind()}</TableHead>
                    <TableHead>{m.erasure_col_requested()}</TableHead>
                    <TableHead>{m.erasure_col_due()}</TableHead>
                    <TableHead>{m.erasure_col_status()}</TableHead>
                    <TableHead>
                      <span className="sr-only">{m.common_actions()}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{subjectName(r)}</TableCell>
                      <TableCell>{kindLabel(r.kind)}</TableCell>
                      <TableCell>{formatDateTime(r.requestedAt)}</TableCell>
                      <TableCell>
                        {formatDateTime(r.dueAt)}
                        {r.status === "requested" && r.overdue ? (
                          <Badge variant="destructive" className="ml-2">
                            {m.erasure_overdue()}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-pressed={r.id === selectedId}
                          aria-label={m.dsar_open_for({
                            kind: kindLabel(r.kind),
                            name: subjectName(r),
                          })}
                          onClick={() => setSelectedId(r.id === selectedId ? undefined : r.id)}
                        >
                          {m.dsar_open()}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {requests.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              loading={requests.isFetchingNextPage}
              onClick={() => void requests.fetchNextPage()}
            >
              {m.common_load_more()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {selected ? (
        <RequestDetail key={selected.id} request={selected} canManage={canManage} />
      ) : null}
      {canManage ? <CreateDataRequestCard /> : null}
      {canManage ? <CreateErasureCard /> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: DataRequestStatus }) {
  return (
    <Badge
      variant={status === "completed" ? "success" : status === "cancelled" ? "outline" : "warning"}
    >
      {statusLabel(status)}
    </Badge>
  );
}

/** 409 reasons the complete route can answer with. */
function completeRefusal(error: unknown): string | undefined {
  if (!isApiError(error) || error.status !== 409) return undefined;
  const reason = error.body.error["reason"];
  if (reason === "request_closed") return m.dsar_refused_closed();
  if (reason === "self_completing") return m.dsar_refused_self_completing();
  if (reason === "export_unknown") return m.dsar_refused_export_unknown();
  if (reason === "last_owner") return m.dsar_refused_last_owner();
  return undefined;
}

function RequestDetail({ request: r, canManage }: { request: DataRequest; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  // The sha256 of the export downloaded from this screen, offered back on "Mark complete".
  const [exportSha, setExportSha] = useState("");
  const noteId = useId();
  const shaId = useId();
  const open = r.status === "requested";
  const name = subjectName(r);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: DATA_REQUESTS_KEY });
  const download = useGuardedMutation({
    mutationFn: () => downloadSubjectExport(r.membershipId),
    // The download changes nothing on the server but its audit row: the request stays open
    // until it is marked complete with the export's fingerprint.
    onSuccess: ({ sha256 }) => {
      if (sha256 !== null) setExportSha(sha256);
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const complete = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/data-requests/{id}/complete", {
          params: { path: { id: r.id } },
          body: {
            ...(note.trim() === "" ? {} : { note: note.trim() }),
            ...(r.kind === "access" && exportSha.trim() !== ""
              ? { exportSha256: exportSha.trim().toLowerCase() }
              : {}),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.dsar_completed());
      setNote("");
      refresh();
    },
    onError: (error) => toast.error(completeRefusal(error) ?? describeError(error).title),
  });
  const finishErasure = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/data-requests/{id}/complete", {
          params: { path: { id: r.id } },
          body: {},
        }),
      ),
    onSuccess: () => {
      toast.success(m.dsar_erasure_finished());
      void queryClient.invalidateQueries({ queryKey: ["compliance", "erasure-requests"] });
      refresh();
    },
    onError: (error) => toast.error(completeRefusal(error) ?? describeError(error).title),
  });
  const cancel = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/erasure-requests/{id}/cancel", { params: { path: { id: r.id } } }),
      ),
    onSuccess: () => {
      toast.success(m.erasure_cancelled());
      void queryClient.invalidateQueries({ queryKey: ["compliance", "erasure-requests"] });
      refresh();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const done = r.expectedModules.length - r.pendingModules.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dsar_detail_title({ kind: kindLabel(r.kind), name })}</CardTitle>
        <CardDescription>{m.dsar_detail_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.erasure_col_status()}</dt>
          <dd>
            <StatusBadge status={r.status} />
          </dd>
          <dt className="text-muted-foreground">{m.erasure_col_requested()}</dt>
          <dd>{formatDateTime(r.requestedAt)}</dd>
          <dt className="text-muted-foreground">{m.erasure_col_due()}</dt>
          <dd>
            {formatDateTime(r.dueAt)}
            {open && r.overdue ? (
              <Badge variant="destructive" className="ml-2">
                {m.erasure_overdue()}
              </Badge>
            ) : null}
          </dd>
          {r.completedAt === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.dsar_completed_at()}</dt>
              <dd>{formatDateTime(r.completedAt)}</dd>
            </>
          )}
          {r.cancelledAt === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.dsar_cancelled_at()}</dt>
              <dd>{formatDateTime(r.cancelledAt)}</dd>
            </>
          )}
          {r.note === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.erasure_field_note()}</dt>
              <dd className="whitespace-pre-wrap">{r.note}</dd>
            </>
          )}
          {r.completionNote === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.dsar_completion_note()}</dt>
              <dd className="whitespace-pre-wrap">{r.completionNote}</dd>
            </>
          )}
          {r.exportSha256 === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.dsar_export_sha256()}</dt>
              <dd className="font-mono text-xs break-all">{r.exportSha256}</dd>
            </>
          )}
        </dl>

        {r.kind === "erasure" && open && r.blockedReason === "last_owner" ? (
          <Alert variant="warning">
            <AlertTitle>{m.dsar_blocked_last_owner_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.dsar_blocked_last_owner_body({ name })}</p>
              {canManage ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  loading={finishErasure.isPending}
                  onClick={() => finishErasure.mutate()}
                >
                  {m.dsar_finish_erasure()}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {r.kind === "erasure" ? (
          <p className="text-sm">
            {m.erasure_modules_progress({
              done: String(done),
              expected: String(r.expectedModules.length),
            })}
            {r.pendingModules.length > 0 ? (
              <span className="block text-xs text-muted-foreground">
                {m.erasure_modules_waiting({ modules: r.pendingModules.join(", ") })}
              </span>
            ) : null}
          </p>
        ) : null}

        <div>
          <h3 className="text-sm font-medium">{m.dsar_steps()}</h3>
          {r.steps.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{m.dsar_steps_empty()}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <Table aria-label={m.dsar_steps()}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.dsar_step_module()}</TableHead>
                    <TableHead>{m.dsar_step_completed()}</TableHead>
                    <TableHead>{m.dsar_step_counts()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.steps.map((step) => (
                    <TableRow key={step.module}>
                      <TableCell className="font-mono text-xs">{step.module}</TableCell>
                      <TableCell>{formatDateTime(step.completedAt)}</TableCell>
                      <TableCell className="text-sm">
                        {Object.keys(step.counts).length === 0
                          ? "—"
                          : Object.entries(step.counts)
                              .map(([table, n]) => `${table}: ${n}`)
                              .join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {r.kind === "rectification" ? (
          <Alert>
            <AlertTitle>{m.dsar_rectification_title()}</AlertTitle>
            <AlertDescription>
              <p>
                {m.dsar_rectification_body()}{" "}
                <Link
                  to="/admin/people/$membershipId"
                  params={{ membershipId: r.membershipId }}
                  className="font-medium underline underline-offset-4"
                >
                  {m.dsar_rectification_link({ name })}
                </Link>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {canManage && r.kind !== "erasure" ? (
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                loading={download.isPending}
                onClick={() => download.mutate()}
              >
                <Download aria-hidden="true" />
                {m.dsar_download_export()}
              </Button>
              <p className="text-xs text-muted-foreground">{m.dsar_download_export_hint()}</p>
            </div>
            {open ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  complete.mutate();
                }}
              >
                {r.kind === "access" ? (
                  <Field
                    id={shaId}
                    label={m.dsar_export_sha256()}
                    description={
                      exportSha === "" ? m.dsar_export_sha256_hint() : m.dsar_export_sha256_filled()
                    }
                  >
                    <Input
                      id={shaId}
                      value={exportSha}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-xs"
                      aria-describedby={`${shaId}-description`}
                      onChange={(e) => setExportSha(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Field
                  id={noteId}
                  label={m.dsar_completion_note()}
                  description={m.dsar_completion_note_hint()}
                >
                  <Textarea
                    id={noteId}
                    value={note}
                    maxLength={1000}
                    aria-describedby={`${noteId}-description`}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <Button type="submit" loading={complete.isPending}>
                  {m.dsar_mark_complete()}
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}

        {canManage && r.kind === "erasure" && open ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline">
                {m.erasure_cancel()}
              </Button>
            }
            title={m.erasure_cancel_title()}
            description={m.erasure_cancel_body()}
            confirmLabel={m.erasure_cancel()}
            pending={cancel.isPending}
            onConfirm={() => cancel.mutate()}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreateDataRequestCard() {
  const [kind, setKind] = useState<"access" | "rectification">("access");
  const [q, setQ] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [note, setNote] = useState("");
  const [refused, setRefused] = useState(false);
  const base = useId();
  // The directory is another area's route (`access.read`): without it the picker is empty and
  // says so, rather than taking the whole tab down.
  const people = useQuery({ ...peopleQuery({ q: q.trim() || undefined }), retry: false });
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/data-requests", {
          body: { kind, membershipId, ...(note.trim() === "" ? {} : { note: note.trim() }) },
        }),
      ),
    onSuccess: () => {
      toast.success(m.dsar_created());
      setMembershipId("");
      setNote("");
      setRefused(false);
      void queryClient.invalidateQueries({ queryKey: DATA_REQUESTS_KEY });
    },
    onError: (error) => {
      if (
        isApiError(error) &&
        error.status === 409 &&
        error.body.error["reason"] === "request_open"
      ) {
        setRefused(true);
        return;
      }
      toast.error(describeError(error).title);
    },
  });
  const candidates = people.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dsar_create_title()}</CardTitle>
        <CardDescription>{m.dsar_create_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (membershipId !== "") create.mutate();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{m.dsar_field_kind()}</legend>
            {(["access", "rectification"] as const).map((k) => (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${base}-kind`}
                  value={k}
                  checked={kind === k}
                  className="mt-1"
                  onChange={() => {
                    setKind(k);
                    setRefused(false);
                  }}
                />
                <span>
                  <span className="font-medium">{kindLabel(k)}</span>
                  <span className="block text-muted-foreground">
                    {k === "access" ? m.dsar_kind_access_hint() : m.dsar_kind_rectification_hint()}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id={`${base}-q`} label={m.dsar_field_search()}>
              <Input
                id={`${base}-q`}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Field>
            <Field
              id={`${base}-member`}
              label={m.dsar_field_member()}
              description={people.isError ? m.erasure_people_unavailable() : undefined}
            >
              <NativeSelect
                id={`${base}-member`}
                value={membershipId}
                {...(people.isError ? { "aria-describedby": `${base}-member-description` } : {})}
                onChange={(e) => {
                  setMembershipId(e.target.value);
                  setRefused(false);
                }}
              >
                <option value="">{m.erasure_member_pick()}</option>
                {candidates.map((p) => (
                  <option key={p.membershipId} value={p.membershipId}>
                    {p.email ? `${personName(p)} (${p.email})` : personName(p)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              id={`${base}-note`}
              label={m.dsar_field_note()}
              description={m.dsar_field_note_hint()}
              className="md:col-span-2"
            >
              <Textarea
                id={`${base}-note`}
                value={note}
                maxLength={1000}
                aria-describedby={`${base}-note-description`}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
          {refused ? (
            <Alert variant="destructive">
              <AlertTitle>{m.erasure_refused_open_title()}</AlertTitle>
              <AlertDescription>{m.dsar_refused_open_body()}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" loading={create.isPending} disabled={membershipId === ""}>
            {m.dsar_create_submit()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
