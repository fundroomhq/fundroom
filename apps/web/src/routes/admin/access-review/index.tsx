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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardCheck, Download } from "lucide-react";
import { useId, useState } from "react";
import { roleLabel, StatusBadge } from "../../../components/access/common.js";
import {
  PlanFeatureNotice,
  usePlanAllowsFeature,
} from "../../../components/billing/plan-feature-notice.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import {
  ACCESS_REVIEW_FLAGS,
  type AccessReviewFlag,
  type AccessReviewRecord,
  type AccessReviewReport,
  type AccessReviewRow,
  accessReviewQuery,
  accessReviewsQuery,
  completeAccessReview,
  downloadAccessReviewCsv,
  downloadAccessReviewEvidence,
} from "../../../lib/access-admin-queries.js";
import { describeError, isApiError } from "../../../lib/api.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/access-review/")({ component: AccessReviewPage });

/*
 * The periodic access review (E2.7): who holds access, with what, and which of them deserve a
 * second look (stale, never active, expiring, accreditation lapsed or disagreeing with its gate,
 * gates still pending). The report is recomputed by the server on every read; "Mark review
 * complete" attests to the report on screen (its `reportSha256`): the server rebuilds it as of
 * the same instant and stores it, or answers `report_changed` when access moved in between — the
 * screen then reloads the report and says so, and the reviewer looks again. The next review is
 * due 90 days later. The CSV is the same report for a spreadsheet, audited on download; each past
 * review's stored report downloads as evidence.
 */
function flagLabel(flag: AccessReviewFlag): string {
  switch (flag) {
    case "stale":
      return m.access_review_flag_stale();
    case "never_active":
      return m.access_review_flag_never_active();
    case "expiring":
      return m.access_review_flag_expiring();
    case "accreditation_lapsed":
      return m.access_review_flag_accreditation_lapsed();
    case "accreditation_diverges":
      return m.access_review_flag_accreditation_diverges();
    case "pending_gates":
      return m.access_review_flag_pending_gates();
  }
}

type FlagFilter = "" | "flagged" | AccessReviewFlag;

function AccessReviewPage() {
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("access.manage");
  const report = useQuery(accessReviewQuery);
  const [changed, setChanged] = useState(false);
  const csv = useGuardedMutation({
    mutationFn: () => downloadAccessReviewCsv(),
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.access_review_title()}
        description={m.access_review_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={csv.isPending}
              onClick={() => csv.mutate()}
            >
              <Download aria-hidden="true" />
              {m.access_review_download_csv()}
            </Button>
            {canManage && report.data ? (
              <CompleteReviewDialog report={report.data} onReportChanged={setChanged} />
            ) : null}
          </div>
        }
      />
      {/* A-3: the report and past reviews stay readable; recording a review needs the feature. */}
      <PlanFeatureNotice feature="access_reviews" />
      {report.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {report.isError ? <ErrorAlert error={report.error} /> : null}
      {changed ? (
        <Alert variant="warning" role="alert">
          <AlertTitle>{m.access_review_changed_title()}</AlertTitle>
          <AlertDescription>{m.access_review_changed_body()}</AlertDescription>
        </Alert>
      ) : null}
      {report.data ? <ReportView report={report.data} /> : null}
      {report.data ? <PastReviews /> : null}
    </div>
  );
}

function ReportView({ report }: { report: AccessReviewReport }) {
  const [filter, setFilter] = useState<FlagFilter>("");
  const filterId = useId();
  const { summary, lastReview, nextReviewDueAt } = report;
  // A-3: no "overdue" nag for a review the plan no longer lets anyone record.
  const planAllows = usePlanAllowsFeature("access_reviews");
  const overdue = planAllows && new Date(nextReviewDueAt).getTime() < Date.now();
  const rows = report.members.filter((row) =>
    filter === "" ? true : filter === "flagged" ? row.flags.length > 0 : row.flags.includes(filter),
  );
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label={m.access_review_summary_members()} value={String(summary.members)} />
        <SummaryTile label={m.access_review_summary_flagged()} value={String(summary.flagged)} />
        <SummaryTile
          label={m.access_review_summary_last()}
          value={lastReview === null ? m.access_review_never() : formatDate(lastReview.completedAt)}
          detail={
            lastReview === null
              ? undefined
              : m.access_review_last_by({
                  name: lastReview.reviewerName ?? m.access_review_unknown_reviewer(),
                })
          }
        />
        <SummaryTile
          label={m.access_review_summary_next()}
          value={formatDate(nextReviewDueAt)}
          badge={overdue ? m.access_review_overdue() : undefined}
        />
      </div>

      {summary.truncated ? (
        <Alert variant="warning">
          <AlertTitle>{m.access_review_truncated_title()}</AlertTitle>
          <AlertDescription>
            {m.access_review_truncated_body({ count: String(report.members.length) })}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{m.access_review_table_title()}</CardTitle>
          <CardDescription>
            {m.access_review_generated({ when: formatDateTime(report.generatedAt) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id={filterId} label={m.access_review_filter()} className="max-w-xs">
            <NativeSelect
              id={filterId}
              value={filter}
              onChange={(e) => setFilter(e.target.value as FlagFilter)}
            >
              <option value="">{m.access_review_filter_all()}</option>
              <option value="flagged">{m.access_review_filter_flagged()}</option>
              {ACCESS_REVIEW_FLAGS.map((f) => (
                <option key={f} value={f}>
                  {`${flagLabel(f)} (${summary.byFlag[f] ?? 0})`}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {rows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">{m.access_review_empty()}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table aria-label={m.access_review_table_title()}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.access_review_col_person()}</TableHead>
                    <TableHead>{m.access_review_col_role()}</TableHead>
                    <TableHead>{m.access_review_col_status()}</TableHead>
                    <TableHead>{m.access_review_col_groups()}</TableHead>
                    <TableHead>{m.access_review_col_last_active()}</TableHead>
                    <TableHead>{m.access_review_col_expires()}</TableHead>
                    <TableHead>{m.access_review_col_sessions()}</TableHead>
                    <TableHead>{m.access_review_col_nda()}</TableHead>
                    <TableHead>{m.access_review_col_accreditation()}</TableHead>
                    <TableHead>{m.access_review_col_pending()}</TableHead>
                    <TableHead>{m.access_review_col_flags()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <ReviewRow key={row.membershipId} row={row} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function SummaryTile({
  label,
  value,
  detail,
  badge,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  badge?: string | undefined;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">
          {value}
          {badge === undefined ? null : (
            <Badge variant="destructive" className="ml-2 align-middle">
              {badge}
            </Badge>
          )}
        </p>
        {detail === undefined ? null : <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

function ReviewRow({ row }: { row: AccessReviewRow }) {
  const name = row.name ?? m.access_review_unnamed();
  const acc = row.accreditation;
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          to="/admin/people/$membershipId"
          params={{ membershipId: row.membershipId }}
          className="underline underline-offset-4"
        >
          {name}
        </Link>
        {row.email === null ? null : (
          <span className="block text-xs font-normal text-muted-foreground">{row.email}</span>
        )}
      </TableCell>
      <TableCell>
        {row.kind === "staff" ? m.kind_staff() : m.kind_external()} · {roleLabel(row.role)}
      </TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="text-sm">
        {row.groups.length === 0 ? "—" : row.groups.join(", ")}
      </TableCell>
      <TableCell>
        {row.lastActiveAt === null ? m.access_review_never() : formatDate(row.lastActiveAt)}
      </TableCell>
      <TableCell>{row.expiresAt === null ? "—" : formatDate(row.expiresAt)}</TableCell>
      <TableCell>{row.activeSessions}</TableCell>
      <TableCell className="text-sm">
        {row.nda === null ? "—" : `${row.nda.kind} · ${formatDate(row.nda.signedAt)}`}
      </TableCell>
      <TableCell className="text-sm">
        {acc === null ? (
          "—"
        ) : (
          <>
            {m.access_review_acc_signed({ when: formatDate(acc.signedAt) })}
            {acc.expiresAt === null ? null : (
              <span className="block text-xs text-muted-foreground">
                {m.access_review_acc_expires({ when: formatDate(acc.expiresAt) })}
              </span>
            )}
            {acc.gateLapsesAt === null ? null : (
              <span className="block text-xs text-muted-foreground">
                {m.access_review_acc_gate_lapses({
                  when: formatDate(acc.gateLapsesAt),
                  days: String(acc.gateMaxAgeDays ?? ""),
                })}
              </span>
            )}
            {acc.diverges ? (
              <span className="mt-1 block text-xs font-medium text-destructive">
                {m.access_review_acc_diverges()}
              </span>
            ) : null}
          </>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {row.pendingGates.length === 0 ? "—" : row.pendingGates.join(", ")}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {row.flags.map((f) => (
            <Badge key={f} variant="warning">
              {flagLabel(f)}
            </Badge>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}

function isReportChanged(error: unknown): boolean {
  return isApiError(error) && error.body.error["reason"] === "report_changed";
}

function CompleteReviewDialog({
  report,
  onReportChanged,
}: {
  report: AccessReviewReport;
  /** `true` when the server refused a stale report, `false` once a review was recorded. */
  onReportChanged: (changed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  const planAllows = usePlanAllowsFeature("access_reviews");
  const queryClient = useQueryClient();
  const complete = useGuardedMutation({
    mutationFn: () => completeAccessReview(report, note.trim()),
    onSuccess: () => {
      toast.success(m.access_review_completed());
      onReportChanged(false);
      setOpen(false);
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["access", "review"] });
    },
    onError: (error) => {
      if (isReportChanged(error)) {
        // Access moved since this report was generated: show the new one and ask again. The
        // note stays, so the reviewer does not have to type it twice.
        setOpen(false);
        onReportChanged(true);
        void queryClient.invalidateQueries({ queryKey: ["access", "review", "report"] });
        return;
      }
      toast.error(describeError(error).title);
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" disabled={!planAllows}>
          <ClipboardCheck aria-hidden="true" />
          {m.access_review_complete()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            complete.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.access_review_complete_title()}</DialogTitle>
            <DialogDescription>
              {m.access_review_complete_body({
                members: String(report.summary.members),
                flagged: String(report.summary.flagged),
              })}
            </DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.access_review_note()} description={m.access_review_note_hint()}>
            <Textarea
              id={id}
              value={note}
              maxLength={1000}
              aria-describedby={`${id}-description`}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={complete.isPending}>
              {m.access_review_complete()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PastReviews() {
  const reviews = useQuery(accessReviewsQuery);
  if (reviews.isPending) return null;
  if (reviews.isError) return <ErrorAlert error={reviews.error} />;
  if (reviews.data.items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.access_review_history_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table aria-label={m.access_review_history_title()}>
            <TableHeader>
              <TableRow>
                <TableHead>{m.access_review_history_when()}</TableHead>
                <TableHead>{m.access_review_history_by()}</TableHead>
                <TableHead>{m.access_review_history_counts()}</TableHead>
                <TableHead>{m.access_review_note()}</TableHead>
                <TableHead>{m.access_review_history_evidence()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reviews.data.items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.completedAt)}</TableCell>
                  <TableCell>{r.reviewerName ?? m.access_review_unknown_reviewer()}</TableCell>
                  <TableCell>
                    {m.access_review_history_count_value({
                      members: String(r.memberCount),
                      flagged: String(r.flaggedCount),
                    })}
                  </TableCell>
                  <TableCell className="text-sm">{r.note ?? "—"}</TableCell>
                  <TableCell>
                    <EvidenceButton record={r} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceButton({ record }: { record: AccessReviewRecord }) {
  const download = useGuardedMutation({
    mutationFn: () => downloadAccessReviewEvidence(record),
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={download.isPending}
      aria-label={m.access_review_history_download_label({
        when: formatDateTime(record.completedAt),
      })}
      onClick={() => download.mutate()}
    >
      <Download aria-hidden="true" />
      {m.access_review_history_download()}
    </Button>
  );
}
