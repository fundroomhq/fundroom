import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Label,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, FolderLock, Inbox, Lock, MessageSquare } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { gateLabel } from "../../components/access/common.js";
import { UnlockSheet } from "../../components/compliance/unlock-sheet.js";
import { AskQuestionButton } from "../../components/data-room/qa/ask-dialog.js";
import { MyQuestionsPage, QuestionDetailPage } from "../../components/data-room/qa/pages.js";
import { QaTargetPanel } from "../../components/data-room/qa/target-panel.js";
import { DocumentViewer } from "../../components/data-room/viewer.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { useWebConfig } from "../../lib/config-context.js";
import {
  type DataRoomTree,
  type DataRoomTreeDocument,
  type DataRoomTreeFolder,
  dataRoomFileUrl,
  dataRoomTreeQuery,
} from "../../lib/data-room-queries.js";
import { useQaStatus } from "../../lib/qa-queries.js";
import { useBootstrap, useViewAs } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * The investor data room (E1.3): `/data-room[/folders/<id>]` browses the tree the member
 * may see (index numbers, folders first), `/data-room/documents/<id>` opens the secure
 * viewer. Bytes come from the API only; nothing here ever links to storage.
 * `/data-room/questions[/<id>]` is the investor side of Q&A (E3.3): the member's own questions
 * and one question (also the landing page of search hits and "answered" emails).
 */
export default function DataRoomInvestor({ splat }: ModulePageProps) {
  const [head = "", id] = splat.split("/").filter(Boolean);
  if (head === "documents" && id) return <DocumentViewer documentId={id} backTo="data-room" />;
  if (head === "questions") return id ? <QuestionDetailPage id={id} /> : <MyQuestionsPage />;
  return <Browser folderId={head === "folders" && id ? id : null} />;
}

export function documentBadge(
  d: DataRoomTreeDocument,
): { label: string; variant: "outline" | "secondary" | "warning" } | null {
  if (d.access.reason === "gated") return { label: m.dataroom_locked(), variant: "warning" };
  if (d.scanStatus === "pending" || d.scanStatus === "scanning" || d.renderStatus === "pending")
    return { label: m.dataroom_processing(), variant: "secondary" };
  if (d.renderStatus === "unsupported" || d.renderStatus === "failed")
    return { label: m.dataroom_download_only(), variant: "outline" };
  return null;
}

function Browser({ folderId }: { folderId: string | null }) {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  const membershipId = bootstrap.data?.membership?.id ?? "";
  const tree = useQuery(dataRoomTreeQuery);
  const qa = useQaStatus();
  const viewingAs = useViewAs() !== null;
  const [q, setQ] = useState("");
  const searchId = useId();

  const view = useMemo(() => {
    if (!tree.data) return undefined;
    return organise(tree.data, folderId, q);
  }, [tree.data, folderId, q]);

  if (tree.isPending) return <LoadingState label={m.common_loading()} />;
  if (tree.isError) return <ErrorAlert error={tree.error} />;
  if (!view)
    return (
      <EmptyState
        icon={<Inbox aria-hidden="true" />}
        title={m.dataroom_empty_title()}
        description={m.dataroom_empty_body()}
      />
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.dataroom_title()}
        description={m.dataroom_subtitle()}
        actions={
          // "My questions" and asking are the asker's: a delegate (canAsk false) has neither
          // (C15), and staff viewing the portal as an investor cannot ask for them (C14).
          qa.enabled && qa.canAsk ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/$" params={{ _splat: "data-room/questions" }}>
                  <MessageSquare aria-hidden="true" />
                  {m.dataroom_qa_my_questions()}
                </Link>
              </Button>
              {qa.allowFolderQuestions && !viewingAs ? (
                <AskQuestionButton
                  targetKind="folder"
                  targetId={view.folderId}
                  targetTitle={view.crumbs.at(-1)?.name ?? m.dataroom_root()}
                  label={m.dataroom_qa_ask_folder()}
                />
              ) : null}
            </div>
          ) : undefined
        }
      />
      <nav aria-label={m.dataroom_breadcrumb()} className="text-sm">
        <ol className="flex flex-wrap items-center gap-1 text-muted-foreground">
          <li>
            {folderId === null ? (
              <span aria-current="page" className="font-medium text-foreground">
                {m.dataroom_root()}
              </span>
            ) : (
              <Link to="/$" params={{ _splat: "data-room" }} className="hover:underline">
                {m.dataroom_root()}
              </Link>
            )}
          </li>
          {view.crumbs.map((c, i) => (
            <li key={c.id} className="flex items-center gap-1">
              <span aria-hidden="true">/</span>
              {i === view.crumbs.length - 1 ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {c.name}
                </span>
              ) : (
                <Link
                  to="/$"
                  params={{ _splat: `data-room/folders/${c.id}` }}
                  className="hover:underline"
                >
                  {c.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="max-w-sm">
        <Label htmlFor={searchId}>{m.dataroom_filter_label()}</Label>
        <Input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={m.dataroom_filter_placeholder()}
        />
      </div>
      {view.folders.length === 0 && view.documents.length === 0 ? (
        <EmptyState
          icon={<Inbox aria-hidden="true" />}
          title={m.dataroom_empty_title()}
          description={m.dataroom_empty_body()}
        />
      ) : null}
      {view.folders.length > 0 ? (
        <section aria-labelledby="dr-folders">
          <h2 id="dr-folders" className="mb-2 text-sm font-medium text-muted-foreground">
            {m.dataroom_folders()}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.folders.map((f) => (
              <li key={f.id}>
                <Card className="h-full transition-colors hover:bg-accent/40">
                  <Link
                    to="/$"
                    params={{ _splat: `data-room/folders/${f.id}` }}
                    className="block h-full rounded-xl focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <CardContent className="flex items-center gap-3 py-4">
                      <FolderLock aria-hidden="true" className="size-5 shrink-0 text-primary" />
                      <span className="truncate">
                        {f.index ? (
                          <span className="mr-2 tabular-nums text-muted-foreground">{f.index}</span>
                        ) : null}
                        {f.name}
                      </span>
                    </CardContent>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {view.documents.length > 0 ? (
        <section aria-labelledby="dr-documents">
          <h2 id="dr-documents" className="mb-2 text-sm font-medium text-muted-foreground">
            {m.dataroom_documents()}
          </h2>
          <ul className="divide-y rounded-md border">
            {view.documents.map((d) => {
              const badge = documentBadge(d);
              const gates = d.access.pendingGates;
              return (
                <li key={d.id} className="flex items-center gap-3 p-3">
                  <img
                    src={dataRoomFileUrl(config.apiBase, d.id, "thumbnail")}
                    alt=""
                    loading="lazy"
                    width={40}
                    height={52}
                    className="size-12 shrink-0 rounded border object-cover bg-muted"
                    onError={(e) => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/$"
                      params={{ _splat: `data-room/documents/${d.id}` }}
                      className="font-medium hover:underline"
                    >
                      <span className="mr-2 tabular-nums text-muted-foreground">{d.index}</span>
                      {d.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {d.pageCount !== null
                        ? m.dataroom_pages({ count: String(d.pageCount) })
                        : m.dataroom_no_preview()}
                      {gates.length > 0
                        ? ` · ${gates.map((g) => gateLabel(g.kind, g.detail)).join(", ")}`
                        : ""}
                    </p>
                  </div>
                  {badge === null ? (
                    <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
                  ) : d.access.reason === "gated" ? (
                    /*
                     * The lock is the way in, not a dead end (contract S6.3). A member who is
                     * only missing an NDA can sign it here and keep reading; the badge stays a
                     * badge for every other reason a document can be unavailable.
                     */
                    <UnlockSheet
                      gates={gates}
                      resourceLabel={d.title}
                      membershipId={membershipId}
                      onUnlocked={() => undefined}
                      trigger={
                        <button
                          type="button"
                          className="rounded-full focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <Badge variant={badge.variant}>
                            <Lock aria-hidden="true" className="mr-1 size-3" />
                            {m.dataroom_unlock({ title: d.title })}
                          </Badge>
                        </button>
                      }
                    />
                  ) : (
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {qa.enabled ? <QaTargetPanel targetKind="folder" targetId={view.folderId} /> : null}
    </div>
  );
}

function organise(tree: DataRoomTree, folderId: string | null, q: string) {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const current = folderId ?? tree.rootId;
  if (folderId !== null && !byId.has(folderId)) return undefined;
  const crumbs: DataRoomTreeFolder[] = [];
  let cur = folderId === null ? undefined : byId.get(folderId);
  while (cur) {
    crumbs.unshift(cur);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  const needle = q.trim().toLowerCase();
  const sort = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const folders = tree.folders
    .filter((f) => (needle ? f.name.toLowerCase().includes(needle) : f.parentId === current))
    .sort(sort);
  const documents = tree.documents
    .filter((d) => (needle ? d.title.toLowerCase().includes(needle) : d.folderId === current))
    .sort((a, b) =>
      sort({ sortOrder: a.sortOrder, name: a.title }, { sortOrder: b.sortOrder, name: b.title }),
    );
  return { crumbs, folders, documents, folderId: current };
}
