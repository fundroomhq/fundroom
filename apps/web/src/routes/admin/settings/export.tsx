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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, ShieldAlert, ShieldOff, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { CopyButton } from "../../../components/copy-button.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { formatBytes, formatDateTime } from "../../../lib/format.js";
import {
  deleteWorkspaceExport,
  downloadWorkspaceExport,
  type ExportDownload,
  PORTABILITY_KEY,
  requestWorkspaceExport,
  type WorkspaceExport,
  type WorkspaceExportStatus,
  workspaceExportKeysQuery,
  workspaceExportsQuery,
} from "../../../lib/portability-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/export")({ component: ExportPage });

/*
 * Workspace export (E2.8). The owner asks for a full export — every table, every file, the
 * audit trail — which is prepared in the background and kept for 7 days as a signed zip. Asking
 * for one and downloading it are fresh-session actions (step-up via `useGuardedMutation`; the
 * download is checked first and then streamed to disk by the browser's download manager, see
 * `downloadWorkspaceExport`). The list polls while an export is still queued or running. The zip holds every document in
 * plaintext, so the page says so before anybody presses the button.
 */
function ExportPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("portability.export")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.export_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  const slug = bootstrap.data?.workspace?.slug ?? "";
  return (
    <div className="space-y-6">
      <PageHeader title={m.export_title()} description={m.export_subtitle()} />
      <p className="text-sm">
        <Link to="/admin/settings" className="underline underline-offset-4">
          {m.adminsettings_back()}
        </Link>
      </p>
      <ContentsCard />
      <RequestCard />
      <ExportsCard slug={slug} />
      <KeysCard />
    </div>
  );
}

function ContentsCard() {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.export_contents_title()}</CardTitle>
        <CardDescription>{m.export_contents_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="list-disc space-y-1 pl-5">
          <li>{m.export_contents_tables()}</li>
          <li>{m.export_contents_files()}</li>
          <li>{m.export_contents_audit()}</li>
          <li>{m.export_contents_manifest()}</li>
          <li>{m.export_contents_not()}</li>
        </ul>
        {/* Static guidance, not an event: a note, not a live region. */}
        <Alert variant="destructive" role="note">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{m.export_plaintext_title()}</AlertTitle>
          <AlertDescription>{m.export_plaintext_body()}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function RequestCard() {
  const ids = useId();
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState(false);
  const request = useGuardedMutation({
    mutationFn: () => requestWorkspaceExport(raw),
    onSuccess: () => {
      toast.success(m.export_requested());
      void queryClient.invalidateQueries({ queryKey: [...PORTABILITY_KEY, "exports"] });
    },
  });
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.export_request_title()}</CardTitle>
        <CardDescription>{m.export_request_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2">
          <Checkbox
            id={`${ids}-raw`}
            checked={raw}
            onCheckedChange={(on) => setRaw(on === true)}
            aria-describedby={`${ids}-raw-hint`}
          />
          <div className="grid gap-1">
            <Label htmlFor={`${ids}-raw`} className="font-normal">
              {m.export_raw_analytics()}
            </Label>
            <p id={`${ids}-raw-hint`} className="text-xs text-muted-foreground">
              {m.export_raw_analytics_hint()}
            </p>
          </div>
        </div>
        {request.isError ? <ErrorAlert error={request.error} /> : null}
        <Button type="button" loading={request.isPending} onClick={() => request.mutate()}>
          {m.export_request_button()}
        </Button>
      </CardContent>
    </Card>
  );
}

function statusBadge(status: WorkspaceExportStatus) {
  switch (status) {
    case "queued":
      return <Badge variant="secondary">{m.export_status_queued()}</Badge>;
    case "running":
      return <Badge variant="secondary">{m.export_status_running()}</Badge>;
    case "ready":
      return <Badge variant="success">{m.export_status_ready()}</Badge>;
    case "failed":
      return <Badge variant="destructive">{m.export_status_failed()}</Badge>;
    default:
      return <Badge variant="outline">{m.export_status_expired()}</Badge>;
  }
}

/** Shown in a cell that has no value yet (an export still being prepared). */
const NONE = "—";

function ExportsCard({ slug }: { slug: string }) {
  const exports = useQuery(workspaceExportsQuery);
  const queryClient = useQueryClient();
  const [last, setLast] = useState<ExportDownload | null>(null);
  const download = useGuardedMutation({
    mutationFn: (item: WorkspaceExport) => downloadWorkspaceExport(item, slug),
    onSuccess: (result) => {
      setLast(result);
      toast.success(m.export_downloaded({ file: result.filename }));
      void queryClient.invalidateQueries({ queryKey: [...PORTABILITY_KEY, "exports"] });
    },
  });
  const remove = useGuardedMutation({
    mutationFn: (id: string) => deleteWorkspaceExport(id),
    onSuccess: () => {
      toast.success(m.export_deleted());
      void queryClient.invalidateQueries({ queryKey: [...PORTABILITY_KEY, "exports"] });
    },
  });
  const items = exports.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.export_list_title()}</CardTitle>
        <CardDescription>{m.export_list_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {exports.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {exports.isError ? <ErrorAlert error={exports.error} /> : null}
        {download.isError ? <ErrorAlert error={download.error} /> : null}
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        {exports.data && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.export_list_empty()}</p>
        ) : null}
        {items.length > 0 ? (
          <Table>
            <TableCaption className="sr-only">{m.export_list_title()}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{m.export_col_requested()}</TableHead>
                <TableHead>{m.export_col_status()}</TableHead>
                <TableHead>{m.export_col_size()}</TableHead>
                <TableHead>{m.export_col_sha256()}</TableHead>
                <TableHead>{m.export_col_expires()}</TableHead>
                <TableHead>
                  <span className="sr-only">{m.export_col_actions()}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const when = formatDateTime(item.createdAt);
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div>{when}</div>
                      {item.options.includeRawAnalytics ? (
                        <div className="text-xs text-muted-foreground">
                          {m.export_with_raw_analytics()}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div>{statusBadge(item.status)}</div>
                      {item.status === "failed" && item.error ? (
                        <div className="mt-1 max-w-xs text-xs text-destructive">{item.error}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{formatBytes(item.sizeBytes)}</TableCell>
                    <TableCell>
                      {item.sha256 === null ? (
                        NONE
                      ) : (
                        <div className="flex items-center gap-2">
                          <code className="max-w-40 truncate font-mono text-xs" title={item.sha256}>
                            {item.sha256}
                          </code>
                          <CopyButton
                            value={item.sha256}
                            label={m.export_copy_sha256({ date: when })}
                          />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.expiresAt === null ? NONE : formatDateTime(item.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {item.status === "ready" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            loading={download.isPending && download.variables?.id === item.id}
                            onClick={() => download.mutate(item)}
                            aria-label={m.export_download_label({ date: when })}
                          >
                            <Download aria-hidden="true" />
                            {m.export_download()}
                          </Button>
                        ) : null}
                        <DeleteExport
                          when={when}
                          pending={remove.isPending && remove.variables === item.id}
                          onConfirm={() => remove.mutate(item.id)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
        {last?.sha256 ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">{m.export_downloaded_sha({ file: last.filename })}</p>
            <p className="text-muted-foreground">
              {m.export_downloaded_sha_hint({ file: last.filename })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {last.sha256}
              </code>
              <CopyButton value={last.sha256} label={m.export_downloaded_sha_copy()} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeleteExport({
  when,
  pending,
  onConfirm,
}: {
  when: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={m.export_delete_label({ date: when })}
        >
          <Trash2 aria-hidden="true" />
          {m.export_delete()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.export_delete_title()}</DialogTitle>
          <DialogDescription>{m.export_delete_body({ date: when })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_cancel()}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            loading={pending}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            {m.export_delete()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeysCard() {
  const keys = useQuery(workspaceExportKeysQuery);
  const current = keys.data?.keys[0];
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.export_keys_title()}</CardTitle>
        <CardDescription>{m.export_keys_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {keys.isPending ? <LoadingState lines={1} label={m.common_loading()} /> : null}
        {keys.isError ? <ErrorAlert error={keys.error} /> : null}
        {keys.data ? (
          <ul className="space-y-3">
            {keys.data.keys.map((key) => (
              <li key={key.keyId} className="space-y-1">
                <p className="text-sm font-medium">
                  {m.export_key_id({ id: key.keyId, alg: key.alg })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {key.publicKey}
                  </code>
                  <CopyButton value={key.publicKey} label={m.export_key_copy({ id: key.keyId })} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <Alert role="note">
          <AlertTitle>{m.export_verify_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.export_verify_body()}</p>
            <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-xs">
              {`fundroom workspace verify-export workspace-export.zip --public-key ${current?.publicKey ?? "<public key>"}`}
            </pre>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
