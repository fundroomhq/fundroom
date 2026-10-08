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
  EmptyState,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, RefreshCw, ShieldOff } from "lucide-react";
import { ConfirmDialog } from "../../../components/access/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { formatDateTime } from "../../../lib/format.js";
import { type DeadLetterItem, OPS_KEY, opsJobsQuery } from "../../../lib/ops-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/jobs/")({ component: JobsPage });

/*
 * Jobs and dead letters (E2.7). What an admin needs when "the rebuild did not happen": which
 * background jobs gave up, on what, and a way to try again or let go.
 *
 *  - Queue depths are instance-wide, so they only appear on a single-tenant install; on a
 *    multi-tenant one the card says why it is absent rather than showing zeros.
 *  - A dead letter shows its source queue, event topic and subscriber, when it failed, how
 *    often it was retried and the error — never the payload (the server does not send it).
 *  - Retry is a plain mutation: it re-enqueues the same job, which is what failed in the
 *    first place, so there is nothing to confirm. Discard is final, so it confirms first and
 *    needs a fresh session (step-up through `useGuardedMutation`).
 */
function JobsPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("ops.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.ops_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <JobsScreen canManage={permissions.includes("ops.manage")} />;
}

function JobsScreen({ canManage }: { canManage: boolean }) {
  const jobs = useQuery(opsJobsQuery());
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.ops_jobs_title()}
        description={m.ops_jobs_subtitle()}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={jobs.isFetching && !jobs.isPending}
            onClick={() => void jobs.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            {m.ops_refresh()}
          </Button>
        }
      />
      {jobs.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {jobs.isError ? <ErrorAlert error={jobs.error} /> : null}
      {jobs.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{m.ops_queues_title()}</CardTitle>
              <CardDescription>
                {jobs.data.scope === "instance"
                  ? m.ops_queues_body()
                  : m.ops_queues_workspace_scope()}
              </CardDescription>
            </CardHeader>
            {jobs.data.scope === "instance" ? (
              <CardContent>
                {jobs.data.queues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{m.ops_queues_empty()}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{m.ops_col_queue()}</TableHead>
                        <TableHead className="text-right">{m.ops_col_queued()}</TableHead>
                        <TableHead className="text-right">{m.ops_col_active()}</TableHead>
                        <TableHead className="text-right">{m.ops_col_failed()}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.data.queues.map((q) => (
                        <TableRow key={q.name}>
                          <TableCell>
                            <code className="font-mono text-xs">{q.name}</code>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{q.queued}</TableCell>
                          <TableCell className="text-right tabular-nums">{q.active}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {q.failed > 0 ? (
                              <Badge variant="destructive">{q.failed}</Badge>
                            ) : (
                              q.failed
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            ) : null}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{m.ops_dlq_title()}</CardTitle>
              <CardDescription>{m.ops_dlq_body()}</CardDescription>
              <CardAction>
                <Badge variant={jobs.data.deadLetters.count > 0 ? "destructive" : "outline"}>
                  {m.ops_dlq_count({ count: String(jobs.data.deadLetters.count) })}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {jobs.data.deadLetters.items.length === 0 ? (
                <EmptyState
                  icon={<CircleCheck />}
                  title={m.ops_dlq_empty()}
                  description={m.ops_dlq_empty_body()}
                />
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{m.ops_col_source()}</TableHead>
                        <TableHead>{m.ops_col_topic()}</TableHead>
                        <TableHead>{m.ops_col_subscriber()}</TableHead>
                        <TableHead>{m.ops_col_failed_at()}</TableHead>
                        <TableHead className="text-right">{m.ops_col_retries()}</TableHead>
                        <TableHead>{m.ops_col_error()}</TableHead>
                        {canManage ? <TableHead>{m.common_actions()}</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.data.deadLetters.items.map((item) => (
                        <DeadLetterRow key={item.id} item={item} canManage={canManage} />
                      ))}
                    </TableBody>
                  </Table>
                  {jobs.data.deadLetters.count > jobs.data.deadLetters.items.length ? (
                    <p className="text-sm text-muted-foreground">
                      {m.ops_dlq_more({
                        shown: String(jobs.data.deadLetters.items.length),
                        count: String(jobs.data.deadLetters.count),
                      })}
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** First line of the error, cut short enough for a table cell; the full text is one click away. */
function errorSummary(error: string): string {
  const first = error.split("\n", 1)[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

function DeadLetterRow({ item, canManage }: { item: DeadLetterItem; canManage: boolean }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...OPS_KEY, "jobs"] });
  const label = item.topic ?? item.sourceQueue;
  const retry = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/ops/jobs/dead-letters/{id}/retry", { params: { path: { id: item.id } } })),
    onSuccess: () => {
      toast.success(m.ops_retried({ job: label }));
      refresh();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const discard = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/ops/jobs/dead-letters/{id}", { params: { path: { id: item.id } } })),
    onSuccess: () => {
      toast.success(m.ops_discarded({ job: label }));
      refresh();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const summary = errorSummary(item.error);
  return (
    <TableRow>
      <TableCell>
        <code className="font-mono text-xs">{item.sourceQueue}</code>
      </TableCell>
      <TableCell>
        {item.topic ? <code className="font-mono text-xs">{item.topic}</code> : "—"}
      </TableCell>
      <TableCell>
        {item.subscriber ? <code className="font-mono text-xs">{item.subscriber}</code> : "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap">{formatDateTime(item.failedAt)}</TableCell>
      <TableCell className="text-right tabular-nums">{item.retries}</TableCell>
      <TableCell className="max-w-md">
        {summary === item.error ? (
          <span className="break-words font-mono text-xs">{item.error}</span>
        ) : (
          <details>
            <summary className="cursor-pointer break-words font-mono text-xs">{summary}</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs">
              {item.error}
            </pre>
          </details>
        )}
      </TableCell>
      {canManage ? (
        <TableCell>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={retry.isPending}
              aria-label={m.ops_retry_named({ job: label })}
              onClick={() => retry.mutate()}
            >
              {m.ops_retry()}
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={discard.isPending}
                  aria-label={m.ops_discard_named({ job: label })}
                >
                  {m.ops_discard()}
                </Button>
              }
              title={m.ops_discard_title({ job: label })}
              description={m.ops_discard_body()}
              confirmLabel={m.ops_discard()}
              pending={discard.isPending}
              onConfirm={() => discard.mutate()}
            />
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
