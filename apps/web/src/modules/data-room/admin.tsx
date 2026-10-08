import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Switch,
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
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Download,
  ExternalLink,
  FolderPlus,
  Gavel,
  LayoutTemplate,
  MessagesSquare,
  RotateCcw,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { ShareSheet } from "../../components/access/share-sheet.js";
import { useReadOnlyRestoreWarning } from "../../components/billing/module-plan.js";
import {
  NotOnPlanBadge,
  PlanFeatureNotice,
  usePlanAllowsFeature,
} from "../../components/billing/plan-feature-notice.js";
import { ForensicCard } from "../../components/data-room/forensic.js";
import { QaDetail } from "../../components/data-room/qa-admin/detail.js";
import { QaInbox, type QaPermissions } from "../../components/data-room/qa-admin/inbox.js";
import { QaSettingsSection } from "../../components/data-room/qa-admin/settings-section.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, apiBase, call, describeError } from "../../lib/api.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import {
  type DataRoomDocument,
  type DataRoomDocumentDetail,
  type DataRoomTree,
  type DataRoomTreeFolder,
  dataRoomDocumentQuery,
  dataRoomSettingsQuery,
  dataRoomTemplatesQuery,
  dataRoomTrashQuery,
  dataRoomTreeQuery,
  useBootstrap,
} from "../../lib/queries.js";
import { uploadFile } from "../../lib/upload.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * Data room admin (E1.3, /admin/data-room[/folders/<id>|/documents/<id>|/trash|/settings]):
 * the folder browser with index numbers, uploads (tus or multipart, `lib/upload.ts`),
 * document detail with protection, versions, legal hold and the share sheet, the recycle
 * bin and the settings form. Read-only without `data-room.manage`. Forensic watermarking (E3.13):
 * a protection switch, a settings default, and for `data-room.forensics` the tracing card.
 */
const invalidateTree = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ["data-room"] });

function statusLabel(d: Pick<DataRoomDocument, "scanStatus" | "renderStatus">): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (d.scanStatus === "infected")
    return { label: m.dataroom_admin_status_infected(), variant: "destructive" };
  if (d.scanStatus === "error")
    return { label: m.dataroom_admin_status_error(), variant: "destructive" };
  if (d.scanStatus === "pending" || d.scanStatus === "scanning" || d.renderStatus === "pending") {
    return { label: m.dataroom_admin_status_processing(), variant: "secondary" };
  }
  if (d.scanStatus === "skipped")
    return { label: m.dataroom_admin_status_unscanned(), variant: "outline" };
  if (d.renderStatus === "unsupported")
    return { label: m.dataroom_admin_status_download_only(), variant: "outline" };
  if (d.renderStatus === "failed")
    return { label: m.dataroom_admin_status_preview_failed(), variant: "destructive" };
  return { label: m.dataroom_admin_status_ready(), variant: "default" };
}

function StatusBadge({ d }: { d: Pick<DataRoomDocument, "scanStatus" | "renderStatus"> }) {
  const s = statusLabel(d);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export default function DataRoomAdmin({ splat }: ModulePageProps) {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const canManage = permissions.includes("data-room.manage");
  const canDownload = permissions.includes("data-room.download");
  const canHold = permissions.includes("data-room.legal_hold");
  const canSettings = permissions.includes("data-room.settings");
  const canForensics = permissions.includes("data-room.forensics");
  const qaPerms: QaPermissions = {
    canAnswer: permissions.includes("data-room.qa_answer"),
    canApprove: permissions.includes("data-room.qa_approve"),
    canManage: permissions.includes("data-room.qa_manage"),
    canSettings,
  };
  const [head, id] = splat.split("/").filter(Boolean);

  let body: React.ReactNode;
  if (head === "documents" && id) {
    body = (
      <DocumentPage
        id={id}
        canManage={canManage}
        canDownload={canDownload}
        canHold={canHold}
        canForensics={canForensics}
      />
    );
  } else if (head === "questions" && id) {
    body = <QaDetail id={id} perms={qaPerms} />;
  } else if (head === "questions") {
    body = <QaInbox perms={qaPerms} />;
  } else if (head === "trash") {
    body = <TrashPage canManage={canManage} />;
  } else if (head === "settings") {
    body = <SettingsPage canSettings={canSettings} />;
  } else {
    body = <FolderBrowser folderId={head === "folders" ? id : undefined} canManage={canManage} />;
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.dataroom_admin_title()}
        description={m.dataroom_admin_subtitle()}
        actions={
          <nav aria-label={m.dataroom_admin_sections()} className="flex gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/$" params={{ _splat: "data-room" }}>
                {m.dataroom_admin_nav_files()}
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/$" params={{ _splat: "data-room/questions" }}>
                <MessagesSquare aria-hidden="true" />
                {m.dataroom_qa_admin_nav()}
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/$" params={{ _splat: "data-room/trash" }}>
                <Trash2 aria-hidden="true" />
                {m.dataroom_admin_nav_trash()}
              </Link>
            </Button>
            {canSettings ? (
              <Button asChild variant="ghost" size="sm">
                <Link to="/admin/$" params={{ _splat: "data-room/settings" }}>
                  <Settings aria-hidden="true" />
                  {m.dataroom_admin_nav_settings()}
                </Link>
              </Button>
            ) : null}
          </nav>
        }
      />
      {body}
    </div>
  );
}

// --- folder browser -------------------------------------------------------------------------------

interface UploadRow {
  key: string;
  name: string;
  sent: number;
  total: number;
  state: "uploading" | "done" | "failed";
  error?: string;
}

function FolderBrowser({
  folderId,
  canManage,
}: {
  folderId: string | undefined;
  canManage: boolean;
}) {
  const tree = useQuery(dataRoomTreeQuery);
  if (tree.isPending) return <LoadingState label={m.common_loading()} />;
  if (tree.isError) return <ErrorAlert error={tree.error} />;
  return (
    <LoadedBrowser tree={tree.data} folderId={folderId ?? tree.data.rootId} canManage={canManage} />
  );
}

function LoadedBrowser({
  tree,
  folderId,
  canManage,
}: {
  tree: DataRoomTree;
  folderId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  // Decision 14: deleting is allowed on a read-only data room, restoring is not.
  const warnRestore = useReadOnlyRestoreWarning("data-room");
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const current = folderId === tree.rootId ? undefined : byId.get(folderId);
  const crumbs: DataRoomTreeFolder[] = [];
  for (let f = current; f !== undefined; f = f.parentId ? byId.get(f.parentId) : undefined)
    crumbs.unshift(f);
  const folders = tree.folders
    .filter((f) => f.parentId === folderId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const documents = tree.documents
    .filter((d) => d.folderId === folderId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const patchFolder = useGuardedMutation({
    mutationFn: (v: { id: string; sortOrder?: number; name?: string; parentId?: string }) =>
      call(
        api().PATCH("/data-room/folders/{id}", {
          params: { path: { id: v.id } },
          body: {
            ...(v.sortOrder === undefined ? {} : { sortOrder: v.sortOrder }),
            ...(v.name === undefined ? {} : { name: v.name }),
            ...(v.parentId === undefined ? {} : { parentId: v.parentId }),
          },
        }),
      ),
    onSuccess: (data) => qc.setQueryData(dataRoomTreeQuery.queryKey, data),
    onError: (e) => toast.error(describeError(e).title),
  });
  const patchDocument = useGuardedMutation({
    mutationFn: (v: { id: string; sortOrder: number }) =>
      call(
        api().PATCH("/data-room/documents/{id}", {
          params: { path: { id: v.id } },
          body: { sortOrder: v.sortOrder },
        }),
      ),
    onSuccess: () => void invalidateTree(qc),
    onError: (e) => toast.error(describeError(e).title),
  });
  const deleteFolder = useGuardedMutation({
    mutationFn: (id: string) =>
      call(api().DELETE("/data-room/folders/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_moved_to_bin());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  const deleteDocument = useGuardedMutation({
    mutationFn: (id: string) =>
      call(api().DELETE("/data-room/documents/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_moved_to_bin());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setUploads((u) => [
        ...u,
        { key, name: file.name, sent: 0, total: file.size, state: "uploading" },
      ]);
      try {
        await uploadFile(file, {
          folderId,
          onProgress: (sent, total) =>
            setUploads((u) => u.map((r) => (r.key === key ? { ...r, sent, total } : r))),
        });
        setUploads((u) =>
          u.map((r) => (r.key === key ? { ...r, state: "done", sent: r.total } : r)),
        );
        void invalidateTree(qc);
      } catch (error) {
        setUploads((u) =>
          u.map((r) =>
            r.key === key ? { ...r, state: "failed", error: describeError(error).body } : r,
          ),
        );
      }
    }
  }

  const move = (
    items: { id: string; sortOrder: number }[],
    i: number,
    dir: -1 | 1,
    isFolder: boolean,
  ) => {
    const a = items[i];
    const b = items[i + dir];
    if (!a || !b) return;
    const orders = items.map((x, n) =>
      n === i
        ? b.sortOrder || n + dir + 1
        : n === i + dir
          ? a.sortOrder || i + 1
          : x.sortOrder || n + 1,
    );
    // Give the two rows distinct, swapped positions in a normalised 1..n sequence.
    const norm = items.map((_, n) => n + 1);
    const ai = norm[i] as number;
    const bi = norm[i + dir] as number;
    void orders;
    if (isFolder) {
      patchFolder.mutate({ id: a.id, sortOrder: bi });
      patchFolder.mutate({ id: b.id, sortOrder: ai });
    } else {
      patchDocument.mutate({ id: a.id, sortOrder: bi });
      patchDocument.mutate({ id: b.id, sortOrder: ai });
    }
  };

  return (
    <div className="space-y-6">
      <nav aria-label={m.dataroom_admin_breadcrumb()} className="text-sm">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to="/admin/$" params={{ _splat: "data-room" }} className="hover:underline">
              {m.dataroom_admin_root()}
            </Link>
          </li>
          {crumbs.map((f) => (
            <li key={f.id} className="flex items-center gap-1">
              <span aria-hidden="true">/</span>
              <Link
                to="/admin/$"
                params={{ _splat: `data-room/folders/${f.id}` }}
                className="hover:underline"
              >
                {f.index ? `${f.index} ` : ""}
                {f.name}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <NewFolderDialog parentId={folderId} />
          <TemplateDialog parentId={folderId === tree.rootId ? undefined : folderId} />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label={m.dataroom_admin_upload_input()}
            onChange={onFiles}
          />
          <Button type="button" onClick={() => fileInput.current?.click()}>
            <Upload aria-hidden="true" />
            {m.dataroom_admin_upload()}
          </Button>
          {current ? (
            <ShareSheet
              resource={{ kind: "folder", id: current.id, path: current.path }}
              label={current.name}
              canManage
            />
          ) : null}
        </div>
      ) : null}
      {uploads.length > 0 ? (
        <ul aria-label={m.dataroom_admin_uploads()} className="space-y-1 text-sm">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-3">
              <span className="truncate">{u.name}</span>
              {u.state === "uploading" ? (
                <progress
                  value={u.sent}
                  max={Math.max(1, u.total)}
                  aria-label={u.name}
                  className="h-2 w-40"
                />
              ) : u.state === "done" ? (
                <Badge>{m.dataroom_admin_upload_done()}</Badge>
              ) : (
                <Badge variant="destructive">{u.error ?? m.dataroom_admin_upload_failed()}</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {folders.length === 0 && documents.length === 0 ? (
        <EmptyState
          icon={<FolderPlus aria-hidden="true" />}
          title={m.dataroom_admin_empty_title()}
          description={m.dataroom_admin_empty_body()}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">{m.dataroom_admin_col_index()}</TableHead>
              <TableHead>{m.common_name()}</TableHead>
              <TableHead>{m.dataroom_admin_col_status()}</TableHead>
              <TableHead>{m.dataroom_admin_col_size()}</TableHead>
              <TableHead>{m.dataroom_admin_col_updated()}</TableHead>
              {canManage ? (
                <TableHead className="text-right">{m.dataroom_admin_col_actions()}</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {folders.map((f, i) => (
              <TableRow key={f.id}>
                <TableCell className="font-mono text-xs">{f.index}</TableCell>
                <TableCell>
                  <Link
                    to="/admin/$"
                    params={{ _splat: `data-room/folders/${f.id}` }}
                    className="font-medium hover:underline"
                  >
                    {f.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{m.dataroom_admin_folder()}</Badge>
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>{formatDateTime(f.updatedAt)}</TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.dataroom_admin_move_up({ name: f.name })}
                        disabled={i === 0}
                        onClick={() => move(folders, i, -1, true)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.dataroom_admin_move_down({ name: f.name })}
                        disabled={i === folders.length - 1}
                        onClick={() => move(folders, i, 1, true)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <RenameDialog
                        name={f.name}
                        onSave={(name) => patchFolder.mutate({ id: f.id, name })}
                      />
                      <MoveDialog
                        tree={tree}
                        excludePath={f.path}
                        currentParent={f.parentId ?? tree.rootId}
                        onMove={(parentId) => patchFolder.mutate({ id: f.id, parentId })}
                      />
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={m.dataroom_admin_delete({ name: f.name })}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        }
                        title={m.dataroom_admin_delete_folder_title()}
                        description={warnRestore(
                          m.dataroom_admin_delete_folder_body({ name: f.name }),
                        )}
                        confirmLabel={m.dataroom_admin_delete_confirm()}
                        pending={deleteFolder.isPending}
                        onConfirm={() => deleteFolder.mutate(f.id)}
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
            {documents.map((d, i) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.index}</TableCell>
                <TableCell>
                  <Link
                    to="/admin/$"
                    params={{ _splat: `data-room/documents/${d.id}` }}
                    className="font-medium hover:underline"
                  >
                    {d.title}
                  </Link>
                  {d.legalHold ? (
                    <Badge variant="destructive" className="ml-2">
                      {m.dataroom_admin_legal_hold()}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge d={d} />
                </TableCell>
                <TableCell>{formatBytes(d.sizeBytes)}</TableCell>
                <TableCell>{formatDateTime(d.updatedAt)}</TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.dataroom_admin_move_up({ name: d.title })}
                        disabled={i === 0}
                        onClick={() => move(documents, i, -1, false)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.dataroom_admin_move_down({ name: d.title })}
                        disabled={i === documents.length - 1}
                        onClick={() => move(documents, i, 1, false)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={m.dataroom_admin_delete({ name: d.title })}
                            disabled={d.legalHold}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        }
                        title={m.dataroom_admin_delete_document_title()}
                        description={warnRestore(
                          m.dataroom_admin_delete_document_body({ name: d.title }),
                        )}
                        confirmLabel={m.dataroom_admin_delete_confirm()}
                        pending={deleteDocument.isPending}
                        onConfirm={() => deleteDocument.mutate(d.id)}
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function NewFolderDialog({ parentId }: { parentId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const id = useId();
  const qc = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/data-room/folders", { body: { parentId, name: name.trim() } })),
    onSuccess: (data) => {
      qc.setQueryData(dataRoomTreeQuery.queryKey, data);
      toast.success(m.dataroom_admin_folder_created());
      setOpen(false);
      setName("");
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FolderPlus aria-hidden="true" />
          {m.dataroom_admin_new_folder()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.dataroom_admin_new_folder()}</DialogTitle>
            <DialogDescription>{m.dataroom_admin_new_folder_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.common_name()} required>
            <Input
              id={id}
              value={name}
              required
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {create.isError ? <ErrorAlert error={create.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {m.common_continue()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const id = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(name);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {m.common_rename()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSave(value.trim());
            setOpen(false);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.common_rename()}</DialogTitle>
            <DialogDescription>{m.dataroom_admin_rename_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.common_name()} required>
            <Input
              id={id}
              value={value}
              required
              maxLength={300}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pick a destination folder (a native select keeps jsdom and screen readers happy). */
function MoveDialog({
  tree,
  excludePath,
  currentParent,
  onMove,
}: {
  tree: DataRoomTree;
  excludePath?: string | undefined;
  currentParent: string;
  onMove: (parentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(currentParent);
  const id = useId();
  const options = [
    { id: tree.rootId, label: m.dataroom_admin_root() },
    ...tree.folders
      .filter(
        (f) =>
          excludePath === undefined ||
          !(f.path === excludePath || f.path.startsWith(`${excludePath}.`)),
      )
      .sort((a, b) => (a.index ?? "").localeCompare(b.index ?? "", undefined, { numeric: true }))
      .map((f) => ({ id: f.id, label: `${f.index ?? ""} ${f.name}`.trim() })),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setTarget(currentParent);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {m.dataroom_admin_move()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onMove(target);
            setOpen(false);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.dataroom_admin_move()}</DialogTitle>
            <DialogDescription>{m.dataroom_admin_move_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.dataroom_admin_move_target()}>
            <select
              id={id}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={target === currentParent}>
              {m.dataroom_admin_move()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialog({ parentId }: { parentId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const templates = useQuery({ ...dataRoomTemplatesQuery, enabled: open });
  const qc = useQueryClient();
  const apply = useGuardedMutation({
    mutationFn: (id: string) =>
      call(
        api().POST("/data-room/templates/{id}/apply", {
          params: { path: { id } },
          body: parentId ? { parentId } : {},
        }),
      ),
    onSuccess: (data) => {
      qc.setQueryData(dataRoomTreeQuery.queryKey, data.tree);
      toast.success(m.dataroom_admin_template_applied({ count: String(data.created) }));
      setOpen(false);
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <LayoutTemplate aria-hidden="true" />
          {m.dataroom_admin_apply_template()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.dataroom_admin_apply_template()}</DialogTitle>
          <DialogDescription>{m.dataroom_admin_apply_template_body()}</DialogDescription>
        </DialogHeader>
        {templates.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {templates.isError ? <ErrorAlert error={templates.error} /> : null}
        <ul className="space-y-3">
          {templates.data?.templates.map((t) => (
            <li key={t.id} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm text-muted-foreground">{t.description}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.folders.slice(0, 6).join(" · ")}
                    {t.folders.length > 6 ? " …" : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(t.id)}
                >
                  {m.dataroom_admin_apply_template_action({ name: t.name })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// --- document detail --------------------------------------------------------------------------------

function DocumentPage({
  id,
  canManage,
  canDownload,
  canHold,
  canForensics,
}: {
  id: string;
  canManage: boolean;
  canDownload: boolean;
  canHold: boolean;
  canForensics: boolean;
}) {
  const detail = useQuery(dataRoomDocumentQuery(id));
  const tree = useQuery(dataRoomTreeQuery);
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  return (
    <LoadedDocument
      detail={detail.data}
      tree={tree.data}
      canManage={canManage}
      canDownload={canDownload}
      canHold={canHold}
      canForensics={canForensics}
    />
  );
}

function LoadedDocument({
  detail,
  tree,
  canManage,
  canDownload,
  canHold,
  canForensics,
}: {
  detail: DataRoomDocumentDetail;
  tree: DataRoomTree | undefined;
  canManage: boolean;
  canDownload: boolean;
  canHold: boolean;
  canForensics: boolean;
}) {
  const warnRestore = useReadOnlyRestoreWarning("data-room");
  const d = detail.document;
  const qc = useQueryClient();
  const key = dataRoomDocumentQuery(d.id).queryKey;
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [changeNote, setChangeNote] = useState("");
  const noteId = useId();
  const dlId = useId();
  const wmId = useId();
  const fxId = useId();
  // A-3: forensic marking can be switched off on any document, on only with `forensic` on the plan.
  const forensicAllowed = usePlanAllowsFeature("forensic");

  const patch = useGuardedMutation({
    mutationFn: (body: {
      title?: string;
      folderId?: string;
      protection?: { download?: boolean; watermark?: boolean; forensic?: boolean };
    }) => call(api().PATCH("/data-room/documents/{id}", { params: { path: { id: d.id } }, body })),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      void invalidateTree(qc);
      toast.success(m.dataroom_admin_saved());
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/data-room/documents/{id}", { params: { path: { id: d.id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_moved_to_bin());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    for (const file of files) {
      const rowKey = `${file.name}-${Date.now()}`;
      setUploads((u) => [
        ...u,
        { key: rowKey, name: file.name, sent: 0, total: file.size, state: "uploading" },
      ]);
      try {
        await uploadFile(file, {
          documentId: d.id,
          changeNote: changeNote.trim() || undefined,
          onProgress: (sent, total) =>
            setUploads((u) => u.map((r) => (r.key === rowKey ? { ...r, sent, total } : r))),
        });
        setUploads((u) => u.map((r) => (r.key === rowKey ? { ...r, state: "done" } : r)));
        setChangeNote("");
        void invalidateTree(qc);
      } catch (error) {
        setUploads((u) =>
          u.map((r) =>
            r.key === rowKey ? { ...r, state: "failed", error: describeError(error).body } : r,
          ),
        );
      }
    }
  }

  const base = `${apiBase()}/api/v1/data-room/documents/${d.id}`;
  return (
    <div className="space-y-6">
      <nav aria-label={m.dataroom_admin_breadcrumb()} className="text-sm">
        <Link
          to="/admin/$"
          params={{ _splat: `data-room/folders/${detail.folder.id}` }}
          className="hover:underline"
        >
          {detail.folder.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>
          {d.index} {d.title}
        </span>
      </nav>
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <div className="space-y-3">
          {detail.currentVersion && detail.currentVersion.renderStatus === "ready" ? (
            <img
              src={`${base}/thumbnail`}
              alt={m.dataroom_admin_thumbnail_alt({ title: d.title })}
              className="w-full rounded-md border"
            />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
              {m.dataroom_admin_no_preview()}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{d.contentType ?? "—"}</Badge>
            <StatusBadge d={d} />
            {d.legalHold ? (
              <Badge variant="destructive">{m.dataroom_admin_legal_hold()}</Badge>
            ) : null}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/$" params={{ _splat: `data-room/documents/${d.id}` }}>
              <ExternalLink aria-hidden="true" />
              {m.dataroom_admin_open_viewer()}
            </Link>
          </Button>
          {canDownload && detail.currentVersion ? (
            <Button asChild variant="outline" size="sm">
              <a href={`${base}/download?variant=original`}>
                <Download aria-hidden="true" />
                {m.dataroom_admin_download_original()}
              </a>
            </Button>
          ) : null}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{d.title}</CardTitle>
              <CardDescription>
                {m.dataroom_admin_document_meta({
                  pages: String(d.pageCount ?? "—"),
                  size: formatBytes(d.sizeBytes),
                  updated: formatDateTime(d.updatedAt),
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {detail.scan && detail.scan.status !== "clean" ? (
                <p className="text-sm text-muted-foreground">
                  {m.dataroom_admin_scan_note({
                    status: detail.scan.status,
                    engine: detail.scan.engine ?? "—",
                  })}
                </p>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <RenameDialog name={d.title} onSave={(title) => patch.mutate({ title })} />
                  {tree ? (
                    <MoveDialog
                      tree={tree}
                      currentParent={d.folderId}
                      onMove={(folderId) => patch.mutate({ folderId })}
                    />
                  ) : null}
                  <ShareSheet
                    resource={{ kind: "document", id: d.id, path: detail.folder.path }}
                    label={d.title}
                    canManage
                  />
                  <ConfirmDialog
                    trigger={
                      <Button type="button" variant="outline" size="sm" disabled={d.legalHold}>
                        <Trash2 aria-hidden="true" />
                        {m.dataroom_admin_delete_document_title()}
                      </Button>
                    }
                    title={m.dataroom_admin_delete_document_title()}
                    description={warnRestore(
                      m.dataroom_admin_delete_document_body({ name: d.title }),
                    )}
                    confirmLabel={m.dataroom_admin_delete_confirm()}
                    pending={remove.isPending}
                    onConfirm={() => remove.mutate()}
                  />
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-3">
                  <Switch
                    id={dlId}
                    checked={d.protection.download}
                    disabled={!canManage || patch.isPending}
                    onCheckedChange={(v) => patch.mutate({ protection: { download: v } })}
                  />
                  <Label htmlFor={dlId}>{m.dataroom_admin_protection_download()}</Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id={wmId}
                    checked={d.protection.watermark}
                    disabled={!canManage || patch.isPending}
                    onCheckedChange={(v) => patch.mutate({ protection: { watermark: v } })}
                  />
                  <Label htmlFor={wmId}>{m.dataroom_admin_protection_watermark()}</Label>
                </div>
                <div className="flex items-start gap-3 sm:col-span-2">
                  <Switch
                    id={fxId}
                    className="mt-0.5"
                    checked={d.protection.forensic ?? false}
                    disabled={
                      !canManage ||
                      patch.isPending ||
                      (!forensicAllowed && !(d.protection.forensic ?? false))
                    }
                    aria-describedby={`${fxId}-hint`}
                    onCheckedChange={(v) => patch.mutate({ protection: { forensic: v } })}
                  />
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={fxId}>{m.dataroom_admin_protection_forensic()}</Label>
                      {forensicAllowed ? null : <NotOnPlanBadge />}
                    </div>
                    <p id={`${fxId}-hint`} className="text-sm text-muted-foreground">
                      {m.dataroom_admin_protection_forensic_hint()}
                    </p>
                  </div>
                </div>
              </div>
              {canHold ? <LegalHoldDialog detail={detail} /> : null}
              {detail.legalHold ? (
                <p className="text-sm text-muted-foreground">
                  {m.dataroom_admin_legal_hold_note({
                    reason: detail.legalHold.reason ?? "—",
                    at: detail.legalHold.setAt ? formatDateTime(detail.legalHold.setAt) : "—",
                  })}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{m.dataroom_admin_versions()}</CardTitle>
              <CardDescription>{m.dataroom_admin_versions_body()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {canManage ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field id={noteId} label={m.dataroom_admin_change_note()}>
                    <Input
                      id={noteId}
                      value={changeNote}
                      maxLength={500}
                      onChange={(e) => setChangeNote(e.target.value)}
                    />
                  </Field>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    aria-label={m.dataroom_admin_upload_version_input()}
                    onChange={onFiles}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload aria-hidden="true" />
                    {m.dataroom_admin_upload_version()}
                  </Button>
                </div>
              ) : null}
              {uploads.length > 0 ? (
                <ul aria-label={m.dataroom_admin_uploads()} className="space-y-1 text-sm">
                  {uploads.map((u) => (
                    <li key={u.key} className="flex items-center gap-3">
                      <span className="truncate">{u.name}</span>
                      {u.state === "uploading" ? (
                        <progress
                          value={u.sent}
                          max={Math.max(1, u.total)}
                          aria-label={u.name}
                          className="h-2 w-40"
                        />
                      ) : u.state === "done" ? (
                        <Badge>{m.dataroom_admin_upload_done()}</Badge>
                      ) : (
                        <Badge variant="destructive">
                          {u.error ?? m.dataroom_admin_upload_failed()}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{m.dataroom_admin_col_file()}</TableHead>
                    <TableHead>{m.dataroom_admin_col_size()}</TableHead>
                    <TableHead>{m.dataroom_admin_col_status()}</TableHead>
                    <TableHead>{m.dataroom_admin_change_note()}</TableHead>
                    <TableHead>{m.dataroom_admin_col_updated()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.versions
                    .filter((v) => v !== null)
                    .map((v) => (
                      <TableRow key={v.id}>
                        <TableCell>
                          {m.common_version_short({ version: v.versionNo })}{" "}
                          {v.isCurrent ? (
                            <Badge variant="secondary">{m.dataroom_admin_current()}</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>{v.fileName}</TableCell>
                        <TableCell>{formatBytes(v.sizeBytes)}</TableCell>
                        <TableCell>{v.renderStatus}</TableCell>
                        <TableCell>{v.changeNote ?? "—"}</TableCell>
                        <TableCell>{formatDateTime(v.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {canForensics ? <ForensicCard detail={detail} /> : null}
        </div>
      </div>
    </div>
  );
}

function LegalHoldDialog({ detail }: { detail: DataRoomDocumentDetail }) {
  const d = detail.document;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const id = useId();
  const qc = useQueryClient();
  const set = useGuardedMutation({
    mutationFn: (hold: boolean) =>
      call(
        api().PUT("/data-room/documents/{id}/legal-hold", {
          params: { path: { id: d.id } },
          body: hold ? { hold, reason: reason.trim() } : { hold },
        }),
      ),
    onSuccess: (data) => {
      qc.setQueryData(dataRoomDocumentQuery(d.id).queryKey, data);
      void invalidateTree(qc);
      toast.success(
        d.legalHold ? m.dataroom_admin_legal_hold_cleared() : m.dataroom_admin_legal_hold_set(),
      );
      setOpen(false);
      setReason("");
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Gavel aria-hidden="true" />
          {d.legalHold
            ? m.dataroom_admin_legal_hold_clear()
            : m.dataroom_admin_legal_hold_set_action()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            set.mutate(!d.legalHold);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>
              {d.legalHold
                ? m.dataroom_admin_legal_hold_clear()
                : m.dataroom_admin_legal_hold_set_action()}
            </DialogTitle>
            <DialogDescription>{m.dataroom_admin_legal_hold_body()}</DialogDescription>
          </DialogHeader>
          {d.legalHold ? null : (
            <Field id={id} label={m.dataroom_admin_legal_hold_reason()} required>
              <Textarea
                id={id}
                value={reason}
                required
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
          {set.isError ? <ErrorAlert error={set.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={set.isPending || (!d.legalHold && !reason.trim())}>
              {m.common_continue()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- recycle bin ------------------------------------------------------------------------------------

function TrashPage({ canManage }: { canManage: boolean }) {
  const trash = useQuery(dataRoomTrashQuery);
  const qc = useQueryClient();
  const restoreFolder = useGuardedMutation({
    mutationFn: (id: string) =>
      call(api().POST("/data-room/folders/{id}/restore", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_restored());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  const restoreDocument = useGuardedMutation({
    mutationFn: (id: string) =>
      call(api().POST("/data-room/documents/{id}/restore", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_restored());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  const purge = useGuardedMutation({
    mutationFn: (id: string) =>
      call(api().DELETE("/data-room/documents/{id}/purge", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.dataroom_admin_purged());
      void invalidateTree(qc);
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  if (trash.isPending) return <LoadingState label={m.common_loading()} />;
  if (trash.isError) return <ErrorAlert error={trash.error} />;
  const { folders, documents } = trash.data;
  if (folders.length === 0 && documents.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 aria-hidden="true" />}
        title={m.dataroom_admin_trash_empty_title()}
        description={m.dataroom_admin_trash_empty_body()}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.common_name()}</TableHead>
          <TableHead>{m.dataroom_admin_col_kind()}</TableHead>
          <TableHead>{m.dataroom_admin_col_deleted()}</TableHead>
          <TableHead>{m.dataroom_admin_col_purge()}</TableHead>
          {canManage ? (
            <TableHead className="text-right">{m.dataroom_admin_col_actions()}</TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {folders.map((f) => (
          <TableRow key={f.id}>
            <TableCell>{f.name}</TableCell>
            <TableCell>{m.dataroom_admin_folder()}</TableCell>
            <TableCell>{f.deletedAt ? formatDateTime(f.deletedAt) : "—"}</TableCell>
            <TableCell>{f.purgeAfter ? formatDateTime(f.purgeAfter) : "—"}</TableCell>
            {canManage ? (
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => restoreFolder.mutate(f.id)}
                  disabled={restoreFolder.isPending}
                >
                  <RotateCcw aria-hidden="true" />
                  {m.dataroom_admin_restore({ name: f.name })}
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
        {documents.map((d) => (
          <TableRow key={d.id}>
            <TableCell>
              {d.title}
              {d.legalHold ? (
                <Badge variant="destructive" className="ml-2">
                  {m.dataroom_admin_legal_hold()}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>{m.dataroom_admin_document()}</TableCell>
            <TableCell>{d.deletedAt ? formatDateTime(d.deletedAt) : "—"}</TableCell>
            <TableCell>
              {d.purgeAfter ? formatDateTime(d.purgeAfter) : m.dataroom_admin_purge_held()}
            </TableCell>
            {canManage ? (
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => restoreDocument.mutate(d.id)}
                    disabled={restoreDocument.isPending}
                  >
                    <RotateCcw aria-hidden="true" />
                    {m.dataroom_admin_restore({ name: d.title })}
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button type="button" variant="destructive" size="sm" disabled={d.legalHold}>
                        {m.dataroom_admin_purge_now({ name: d.title })}
                      </Button>
                    }
                    title={m.dataroom_admin_purge_title()}
                    description={m.dataroom_admin_purge_body({ name: d.title })}
                    confirmLabel={m.dataroom_admin_purge_confirm()}
                    pending={purge.isPending}
                    onConfirm={() => purge.mutate(d.id)}
                  />
                </div>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- settings ---------------------------------------------------------------------------------------

function SettingsPage({ canSettings }: { canSettings: boolean }) {
  const settings = useQuery(dataRoomSettingsQuery);
  const qc = useQueryClient();
  const ids = {
    wm: useId(),
    fx: useId(),
    dl: useId(),
    un: useId(),
    purge: useId(),
    max: useId(),
  };
  // A-3: the forensic default can be switched off, on only with `forensic` on the plan.
  const forensicAllowed = usePlanAllowsFeature("forensic");
  const [purgeDays, setPurgeDays] = useState<string | undefined>(undefined);
  const [maxMb, setMaxMb] = useState<string | undefined>(undefined);
  const update = useGuardedMutation({
    mutationFn: (body: {
      watermarkByDefault?: boolean;
      forensicByDefault?: boolean;
      downloadByDefault?: boolean;
      allowUnscanned?: boolean;
      purgeAfterDays?: number;
      maxUploadBytes?: number | null;
    }) => call(api().PATCH("/data-room/settings", { body })),
    onSuccess: (data) => {
      qc.setQueryData(dataRoomSettingsQuery.queryKey, data);
      toast.success(m.dataroom_admin_settings_saved());
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  if (settings.isPending) return <LoadingState label={m.common_loading()} />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  const s = settings.data;
  const ro = !canSettings || update.isPending;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{m.dataroom_admin_nav_settings()}</CardTitle>
          <CardDescription>
            {m.dataroom_admin_settings_body({ scanner: s.scanner })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <PlanFeatureNotice feature="forensic" />
          <div className="flex items-center gap-3">
            <Switch
              id={ids.wm}
              checked={s.watermarkByDefault}
              disabled={ro}
              onCheckedChange={(v) => update.mutate({ watermarkByDefault: v })}
            />
            <Label htmlFor={ids.wm}>{m.dataroom_admin_setting_watermark()}</Label>
          </div>
          <div className="flex items-start gap-3">
            <Switch
              id={ids.fx}
              className="mt-0.5"
              checked={s.forensicByDefault}
              disabled={ro || (!forensicAllowed && !s.forensicByDefault)}
              aria-describedby={`${ids.fx}-hint`}
              onCheckedChange={(v) => update.mutate({ forensicByDefault: v })}
            />
            <div className="grid gap-1">
              <Label htmlFor={ids.fx}>{m.dataroom_admin_setting_forensic()}</Label>
              <p id={`${ids.fx}-hint`} className="text-sm text-muted-foreground">
                {m.dataroom_admin_setting_forensic_hint()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id={ids.dl}
              checked={s.downloadByDefault}
              disabled={ro}
              onCheckedChange={(v) => update.mutate({ downloadByDefault: v })}
            />
            <Label htmlFor={ids.dl}>{m.dataroom_admin_setting_download()}</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id={ids.un}
              checked={s.allowUnscanned}
              disabled={ro}
              onCheckedChange={(v) => update.mutate({ allowUnscanned: v })}
            />
            <Label htmlFor={ids.un}>{m.dataroom_admin_setting_unscanned()}</Label>
          </div>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const body: { purgeAfterDays?: number; maxUploadBytes?: number | null } = {};
              if (purgeDays !== undefined) body.purgeAfterDays = Number(purgeDays);
              if (maxMb !== undefined)
                body.maxUploadBytes = maxMb === "" ? null : Math.round(Number(maxMb) * 1024 * 1024);
              update.mutate(body);
            }}
          >
            <Field id={ids.purge} label={m.dataroom_admin_setting_purge_days()}>
              <Input
                id={ids.purge}
                type="number"
                min={1}
                max={365}
                value={purgeDays ?? String(s.purgeAfterDays)}
                disabled={ro}
                onChange={(e) => setPurgeDays(e.target.value)}
              />
            </Field>
            <Field
              id={ids.max}
              label={m.dataroom_admin_setting_max_upload({
                max: formatBytes(s.limits.uploadMaxBytes),
              })}
            >
              <Input
                id={ids.max}
                type="number"
                min={1}
                value={
                  maxMb ??
                  (s.maxUploadBytes === null
                    ? ""
                    : String(Math.round(s.maxUploadBytes / 1024 / 1024)))
                }
                disabled={ro}
                onChange={(e) => setMaxMb(e.target.value)}
              />
            </Field>
            {canSettings ? (
              <div className="sm:col-span-2">
                <Button type="submit" disabled={update.isPending}>
                  {m.common_save()}
                </Button>
              </div>
            ) : null}
          </form>
        </CardContent>
      </Card>
      {s.qa ? <QaSettingsSection qa={s.qa} canSettings={canSettings} /> : null}
    </div>
  );
}
