import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
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
import { FileSpreadsheet } from "lucide-react";
import { useId, useState } from "react";
import { api, call, describeError } from "../../lib/api.js";
import {
  type MetricCsvDryRunResult,
  type MetricDefinitionView,
  metricImportQuery,
} from "../../lib/metrics-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { initialMapping, MappingFields, type MappingState, mappingBody } from "./mapping.js";

/*
 * CSV import for metric values (E2.4 §9): paste → dry run → confirm, the shape E1.1 settled
 * for bulk invitations (`components/access/csv-import-dialog.tsx`) and for the same reasons —
 * a paste needs no file picker, and nothing is written until a preview has been read. Two
 * rules are load-bearing and both are here:
 *
 *  - **editing the CSV or the mapping clears the preview**, so a dry run that no longer
 *    describes what would be imported cannot be confirmed;
 *  - **the confirm button is disabled until a dry run has produced applicable rows.**
 *
 * What E1.1 did not have is the **column mapping**. An invite CSV has fixed columns; a metrics
 * export has whatever the founder's spreadsheet calls them, so the admin says which column
 * holds the period and which column feeds which metric (`./mapping.tsx`).
 */

const TEMPLATE = "period,";

function rowStatusVariant(status: string): "success" | "destructive" | "outline" {
  return status === "ok" || status === "applied"
    ? "success"
    : status === "error" || status === "failed"
      ? "destructive"
      : "outline";
}

export function MetricsCsvImportDialog({
  definitions,
}: {
  definitions: readonly MetricDefinitionView[];
}) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState(TEMPLATE);
  const [mapping, setMapping] = useState<MappingState>(() => initialMapping(definitions));
  const [preview, setPreview] = useState<MetricCsvDryRunResult>();
  const [importId, setImportId] = useState<string>();
  const id = useId();
  const queryClient = useQueryClient();

  const status = useQuery({
    ...metricImportQuery(importId ?? ""),
    enabled: importId !== undefined,
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 1000,
  });

  const body = () => ({ csv, mapping: mappingBody(mapping) });

  const dryRun = useGuardedMutation({
    mutationFn: () => call(api().POST("/metrics/import/dry-run", { body: body() })),
    onSuccess: setPreview,
    onError: (error) => toast.error(describeError(error).title),
  });
  const start = useGuardedMutation({
    mutationFn: () => call(api().POST("/metrics/import", { body: body() })),
    onSuccess: (r) => {
      setImportId(r.id);
      toast.success(m.metrics_import_started());
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const done = status.data?.status === "done";
  if (done) void queryClient.invalidateQueries({ queryKey: ["metrics"] });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPreview(undefined);
          setImportId(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FileSpreadsheet aria-hidden="true" />
          {m.metrics_csv_button()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{m.metrics_csv_title()}</DialogTitle>
          <DialogDescription>{m.metrics_csv_subtitle()}</DialogDescription>
        </DialogHeader>
        {importId === undefined ? (
          <>
            <Field id={id} label={m.metrics_csv_field()} description={m.metrics_csv_hint()}>
              <Textarea
                id={id}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  // Any edit to what would be sent invalidates the preview that described
                  // the old input; a stale dry run must not be confirmable.
                  setPreview(undefined);
                }}
                rows={8}
                className="font-mono text-xs"
                {...fieldAria(id, { description: true })}
              />
            </Field>
            <MappingFields
              base={id}
              definitions={definitions}
              mapping={mapping}
              onChange={(next) => {
                setMapping(next);
                setPreview(undefined);
              }}
            />
            {preview ? (
              <div className="space-y-2">
                <p className="text-sm" role="status">
                  {m.metrics_csv_summary({
                    ok: String(preview.summary.ok),
                    skipped: String(preview.summary.skipped),
                    error: String(preview.summary.error),
                    values: String(preview.summary.values),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.metrics_csv_columns_seen({ columns: preview.columns.join(", ") })}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.metrics_col_line()}</TableHead>
                      <TableHead>{m.metrics_col_period()}</TableHead>
                      <TableHead>{m.metrics_col_values()}</TableHead>
                      <TableHead>{m.metrics_col_status()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row) => (
                      <TableRow key={row.line}>
                        <TableCell>{row.line}</TableCell>
                        <TableCell>{row.periodKey || "—"}</TableCell>
                        <TableCell>{row.cells.filter((c) => c.status === "ok").length}</TableCell>
                        <TableCell>
                          <Badge variant={rowStatusVariant(row.status)}>
                            {row.status === "ok"
                              ? m.metrics_csv_row_ok()
                              : (row.reason ?? row.status)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                loading={dryRun.isPending}
                onClick={() => dryRun.mutate()}
              >
                {m.metrics_csv_dry_run()}
              </Button>
              <Button
                type="button"
                loading={start.isPending}
                disabled={!preview || preview.summary.ok === 0}
                onClick={() => start.mutate()}
              >
                {m.metrics_csv_import({ count: String(preview?.summary.values ?? 0) })}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="space-y-3" role="status" aria-live="polite">
            <p className="text-sm">
              {status.data
                ? m.metrics_csv_progress({
                    status: status.data.status,
                    applied: String(status.data.applied),
                    failed: String(status.data.failed),
                    total: String(status.data.total),
                  })
                : m.common_loading()}
            </p>
            {status.data?.lastError ? (
              <p className="text-sm text-destructive">{status.data.lastError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
