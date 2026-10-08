import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "../../components/error-alert.js";
import { formatDateTime } from "../../lib/format.js";
import { type MetricDefinitionView, metricPointsQuery } from "../../lib/metrics-queries.js";
import { m } from "../../paraglide/messages.js";
import { formatMetricValue, sourceLabel } from "./format.js";

/*
 * One cell's revision history (E2.4 §9, `GET /definitions/{id}/points?periodKey=…`).
 *
 * This is the screen that makes a restatement *provable*. `metrics.point` is append-only: a
 * corrected figure is a new revision that supersedes the old row, and both rows survive. So
 * the dialog shows every revision newest-first with its value, its source, when it was
 * written and which revision it replaced — "who changed it, when, from what to what, and
 * from which source". Without this the append-only table is just storage nobody can read.
 */
export function RevisionHistoryDialog({
  definition,
  periodKey,
  periodLabel,
}: {
  definition: MetricDefinitionView;
  periodKey: string;
  periodLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const points = useQuery({ ...metricPointsQuery(definition.id, periodKey), enabled: open });
  const rows = points.data?.points ?? [];
  const format = {
    unit: definition.unit,
    currency: definition.currency,
    decimals: definition.decimals,
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={m.metrics_history_open({ metric: definition.name, period: periodLabel })}
        >
          <History aria-hidden="true" className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.metrics_history_title({ metric: definition.name })}</DialogTitle>
          <DialogDescription>{m.metrics_history_body({ period: periodLabel })}</DialogDescription>
        </DialogHeader>
        {points.isPending && open ? <LoadingState label={m.common_loading()} /> : null}
        {points.isError ? <ErrorAlert error={points.error} /> : null}
        {points.data ? (
          rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.metrics_history_empty()}</p>
          ) : (
            <>
              <p className="text-sm" role="status">
                {rows.length === 1
                  ? m.metrics_history_never_restated()
                  : m.metrics_history_restated({ count: String(rows.length - 1) })}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.metrics_col_revision()}</TableHead>
                    <TableHead>{m.metrics_col_value()}</TableHead>
                    <TableHead>{m.metrics_col_source()}</TableHead>
                    <TableHead>{m.metrics_col_written()}</TableHead>
                    <TableHead>{m.metrics_col_state()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((point) => (
                    <TableRow key={point.id}>
                      <TableCell>{point.revision}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatMetricValue(point.value, format)}
                      </TableCell>
                      <TableCell>{sourceLabel(point.sourceKind)}</TableCell>
                      <TableCell>{formatDateTime(point.createdAt)}</TableCell>
                      <TableCell>
                        {point.current ? (
                          <Badge variant="default">{m.metrics_revision_current()}</Badge>
                        ) : (
                          <Badge variant="outline">{m.metrics_revision_superseded()}</Badge>
                        )}
                        {point.needsReview ? (
                          <Badge variant="warning" className="ml-1">
                            {m.metrics_needs_review()}
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
