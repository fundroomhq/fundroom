import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { formatDateTime } from "../../lib/format.js";
import {
  formatCount,
  type PlatformHealth,
  platformHealthQuery,
} from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/platform/health")({ component: HealthPage });

/*
 * Install health for the operator (E3.10): queue depth per queue, the dead-letter count and the
 * adapter checks — the same facts the single-mode ops screens show, with no job payloads (a
 * payload can carry tenant content; the count and the queue name cannot).
 */
function HealthPage() {
  const health = useQuery(platformHealthQuery);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.platform_health_title()}
        description={m.platform_health_body()}
        actions={
          <Button
            type="button"
            variant="outline"
            loading={health.isFetching}
            onClick={() => void health.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            {m.ops_refresh()}
          </Button>
        }
      />
      {health.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {health.isError ? <ErrorAlert error={health.error} /> : null}
      {health.data ? <HealthView health={health.data} /> : null}
    </div>
  );
}

function HealthView({ health }: { health: PlatformHealth }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {m.health_checked_at({ when: formatDateTime(health.checkedAt) })}
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{m.ops_queues_title()}</CardTitle>
            <CardDescription>
              {m.platform_health_dead_letters({ count: health.deadLetters })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {health.queues.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.ops_queues_empty()}</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">{m.ops_queues_title()}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.ops_col_queue()}</TableHead>
                    <TableHead className="text-right">{m.ops_col_queued()}</TableHead>
                    <TableHead className="text-right">{m.ops_col_active()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.queues.map((q) => (
                    <TableRow key={q.name}>
                      <TableCell className="font-mono text-xs">{q.name}</TableCell>
                      <TableCell className="text-right">{formatCount(q.queued)}</TableCell>
                      <TableCell className="text-right">{formatCount(q.active)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{m.health_checks_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            {health.adapters.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.health_checks_empty()}</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">{m.health_checks_title()}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.health_col_check()}</TableHead>
                    <TableHead>{m.health_col_status()}</TableHead>
                    <TableHead>{m.health_col_detail()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.adapters.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell className="font-mono text-xs">{a.name}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            a.status === "ok"
                              ? "success"
                              : a.status === "fail"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {a.status === "ok"
                            ? m.health_status_ok()
                            : a.status === "fail"
                              ? m.health_status_down()
                              : m.health_status_skipped()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{a.detail ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
