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
import { type CsvDryRunResult, importQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";

const TEMPLATE = "email,name,firm,groups,expires_at,note\n";

function reasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "invalid_email":
      return m.csv_reason_invalid_email();
    case "already_member":
      return m.csv_reason_already_member();
    case "already_invited":
      return m.csv_reason_already_invited();
    case "duplicate_in_file":
      return m.csv_reason_duplicate();
    default:
      if (reason?.startsWith("unknown_group:"))
        return m.csv_reason_unknown_group({ name: reason.slice("unknown_group:".length) });
      return reason ?? "";
  }
}

/** Bulk CSV invitations: paste → dry run preview → import job with per-row status. */
export function CsvImportDialog() {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState(TEMPLATE);
  const [preview, setPreview] = useState<CsvDryRunResult>();
  const [importId, setImportId] = useState<string>();
  const id = useId();
  const queryClient = useQueryClient();
  const status = useQuery({
    ...importQuery(importId ?? ""),
    enabled: importId !== undefined,
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 1000,
  });

  const dryRun = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/access/invites/csv/dry-run", { body: { csv, groupIds: [], grants: [] } })),
    onSuccess: setPreview,
    onError: (error) => toast.error(describeError(error).title),
  });
  const start = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/access/invites/csv/import", { body: { csv, groupIds: [], grants: [] } })),
    onSuccess: (r) => {
      setImportId(r.id);
      toast.success(m.csv_started());
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const done = status.data?.status === "done";
  if (done) void queryClient.invalidateQueries({ queryKey: ["access", "invites"] });

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
          {m.csv_button()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.csv_title()}</DialogTitle>
          <DialogDescription>{m.csv_subtitle()}</DialogDescription>
        </DialogHeader>
        {importId === undefined ? (
          <>
            <Field id={id} label={m.csv_field()} description={m.csv_hint()}>
              <Textarea
                id={id}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setPreview(undefined);
                }}
                rows={8}
                className="font-mono text-xs"
                aria-describedby={`${id}-description`}
              />
            </Field>
            {preview ? (
              <div className="space-y-2">
                <p className="text-sm" role="status">
                  {m.csv_summary({
                    ok: String(preview.summary.ok),
                    skipped: String(preview.summary.skipped),
                    error: String(preview.summary.error),
                  })}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.csv_col_line()}</TableHead>
                      <TableHead>{m.csv_col_email()}</TableHead>
                      <TableHead>{m.csv_col_groups()}</TableHead>
                      <TableHead>{m.csv_col_status()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((r) => (
                      <TableRow key={r.line}>
                        <TableCell>{r.line}</TableCell>
                        <TableCell>{r.email || "—"}</TableCell>
                        <TableCell>{r.groups.join(", ")}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              r.status === "ok"
                                ? "success"
                                : r.status === "error"
                                  ? "destructive"
                                  : "outline"
                            }
                          >
                            {r.status === "ok" ? m.csv_status_ok() : reasonLabel(r.reason)}
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
                {m.csv_dry_run()}
              </Button>
              <Button
                type="button"
                loading={start.isPending}
                disabled={!preview || preview.summary.ok === 0}
                onClick={() => start.mutate()}
              >
                {m.csv_import({ count: String(preview?.summary.ok ?? 0) })}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="space-y-3" role="status" aria-live="polite">
            <p className="text-sm">
              {status.data
                ? m.csv_progress({
                    status: status.data.status,
                    invited: String(status.data.invited),
                    failed: String(status.data.failed),
                    total: String(status.data.total),
                  })
                : m.common_loading()}
            </p>
            {status.data ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.csv_col_line()}</TableHead>
                    <TableHead>{m.csv_col_email()}</TableHead>
                    <TableHead>{m.csv_col_status()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.data.rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell>{r.line}</TableCell>
                      <TableCell>{r.email || "—"}</TableCell>
                      <TableCell>
                        {r.status === "invited"
                          ? m.csv_status_invited()
                          : r.status === "failed"
                            ? m.csv_status_failed({ reason: r.reason ?? "" })
                            : r.status === "ok"
                              ? m.csv_status_pending()
                              : reasonLabel(r.reason)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
