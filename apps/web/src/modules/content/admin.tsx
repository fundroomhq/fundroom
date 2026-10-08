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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Eye, History, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { PageRenderer, visibilityLabel } from "../../components/content/page-renderer.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, describeError, isApiError, isCode } from "../../lib/api.js";
import { legalDocumentsQuery } from "../../lib/compliance-queries.js";
import { formatDateTime } from "../../lib/format.js";
import { metricDefinitionsQuery } from "../../lib/metrics-queries.js";
import {
  type ContentPageDetail,
  contentPageQuery,
  contentPagesQuery,
  contentPreviewQuery,
  contentRevisionsQuery,
  contentSettingsQuery,
  type PageBlock,
  type PageDoc,
  type PageSection,
  useBootstrap,
  type VisibilityRule,
} from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * The overview page editor (E1.2, /admin/content[/<pageId>]). The document is edited
 * locally and autosaved as the draft (validated server-side against the block registry);
 * section audiences save at once; publishing turns the draft into an immutable revision.
 */
const AUTOSAVE_MS = 1000;
const BLOCK_TYPES = [
  "hero",
  "rich_text",
  "team",
  "faq",
  "embed",
  "metric_grid",
  "round_summary",
  "document_list",
  "disclaimer",
] as const;
type BlockType = (typeof BLOCK_TYPES)[number];

function blockTypeLabel(type: string): string {
  switch (type) {
    case "hero":
      return m.content_block_hero();
    case "rich_text":
      return m.content_block_rich_text();
    case "team":
      return m.content_block_team();
    case "faq":
      return m.content_block_faq();
    case "embed":
      return m.content_block_embed();
    case "metric_grid":
      return m.content_block_metric_grid();
    case "round_summary":
      return m.content_block_round_summary();
    case "document_list":
      return m.content_block_document_list();
    case "disclaimer":
      return m.content_block_disclaimer();
    default:
      return type;
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyBlock(type: BlockType): PageBlock {
  const data: Record<string, unknown> = {
    hero: { heading: m.content_new_heading(), subheading: null, imageUrl: null, cta: null },
    rich_text: { format: "markdown", text: "" },
    team: { members: [] },
    faq: { items: [] },
    embed: { url: "https://", title: null, provider: "other" },
    metric_grid: { definitionIds: [], columns: 3 },
    // No config at all (contract §R): the block names the open round by being on the page,
    // and the hydrator decides what this reader may see. Nothing here to get wrong.
    round_summary: {},
    document_list: { folderId: null, documentIds: [], title: null },
    disclaimer: { slug: null },
  }[type];
  return { id: newId(type.replace(/_/gu, "-")), type, schemaVersion: 1, data };
}

export default function ContentAdmin({ splat }: ModulePageProps) {
  const pages = useQuery(contentPagesQuery);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const canManage = permissions.includes("content.manage");
  const canSettings = permissions.includes("content.settings");
  const [selectedFromPath] = splat.split("/").filter(Boolean);
  const homeId = pages.data?.pages.find((p) => p.kind === "home")?.id;
  const selectedId = selectedFromPath ?? homeId;

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.content_admin_title()}
        description={m.content_admin_subtitle()}
        actions={canManage ? <NewPageDialog /> : undefined}
      />
      {pages.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {pages.isError ? <ErrorAlert error={pages.error} /> : null}
      {pages.data ? (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <aside className="space-y-6">
            <nav aria-label={m.content_pages_nav()}>
              <ul className="space-y-1">
                {pages.data.pages.map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/admin/$"
                      params={{ _splat: `content/${p.id}` }}
                      aria-current={p.id === selectedId ? "page" : undefined}
                      className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent aria-[current=page]:bg-accent"
                    >
                      <span className="truncate">{p.title}</span>
                      {p.draftDirty ? (
                        <Badge variant="secondary">{m.content_badge_draft()}</Badge>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {canSettings ? <PublicSectionsCard /> : null}
          </aside>
          <div>
            {selectedId ? (
              <PageEditor
                key={selectedId}
                pageId={selectedId}
                canManage={canManage}
                canPublish={permissions.includes("content.publish")}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewPageDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const ids = { title: useId(), slug: useId() };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/content/pages", { body: { title: title.trim(), slug: slug.trim() } })),
    onSuccess: (d) => {
      toast.success(m.content_page_created());
      setOpen(false);
      setTitle("");
      setSlug("");
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
      void navigate({ to: "/admin/$", params: { _splat: `content/${d.page.id}` } });
    },
  });
  const slugify = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.content_new_page()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.content_new_page()}</DialogTitle>
            <DialogDescription>{m.content_new_page_body()}</DialogDescription>
          </DialogHeader>
          <Field id={ids.title} label={m.content_field_title()} required>
            <Input
              id={ids.title}
              value={title}
              required
              onChange={(e) => {
                setTitle(e.target.value);
                setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field
            id={ids.slug}
            label={m.content_field_slug()}
            description={m.content_field_slug_help()}
            required
          >
            <Input
              id={ids.slug}
              value={slug}
              required
              onChange={(e) => setSlug(slugify(e.target.value))}
            />
          </Field>
          {create.isError ? <ErrorAlert error={create.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !title.trim() || !slug}>
              {m.common_continue()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PublicSectionsCard() {
  const settings = useQuery(contentSettingsQuery);
  const queryClient = useQueryClient();
  const id = useId();
  const update = useGuardedMutation({
    mutationFn: (allowPublicSections: boolean) =>
      call(api().PATCH("/content/settings", { body: { allowPublicSections } })),
    onSuccess: (data) => {
      queryClient.setQueryData(contentSettingsQuery.queryKey, data);
      toast.success(m.content_settings_saved());
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.content_public_title()}</CardTitle>
        <CardDescription>{m.content_public_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={settings.data?.allowPublicSections ?? false}
            disabled={settings.isPending || update.isPending}
            onCheckedChange={(v) => update.mutate(v)}
          />
          <Label htmlFor={id}>{m.content_public_switch()}</Label>
        </div>
      </CardContent>
    </Card>
  );
}

// --- the editor -----------------------------------------------------------------------------------

function PageEditor({
  pageId,
  canManage,
  canPublish,
}: {
  pageId: string;
  canManage: boolean;
  canPublish: boolean;
}) {
  const detail = useQuery(contentPageQuery(pageId));
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  return <LoadedEditor detail={detail.data} canManage={canManage} canPublish={canPublish} />;
}

function LoadedEditor({
  detail,
  canManage,
  canPublish,
}: {
  detail: ContentPageDetail;
  canManage: boolean;
  canPublish: boolean;
}) {
  const pageId = detail.page.id;
  const queryClient = useQueryClient();
  const [doc, setDoc] = useState<PageDoc>(detail.draft.doc);
  const [savedAt, setSavedAt] = useState(detail.draft.savedAt);
  const [visibility, setVisibility] = useState(detail.visibility);
  const editSeq = useRef(0);
  const savedSeq = useRef(0);
  const [pendingEdits, setPendingEdits] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);
  const readOnly = !canManage;

  const edit = useCallback((fn: (d: PageDoc) => PageDoc) => {
    editSeq.current += 1;
    setPendingEdits(true);
    setDoc((d) => fn(d));
  }, []);

  const save = useGuardedMutation({
    mutationFn: async (input: { doc: PageDoc; seq: number; baseSavedAt: string }) => ({
      seq: input.seq,
      result: await call(
        api().PUT("/content/pages/{id}/draft", {
          params: { path: { id: pageId } },
          body: { doc: input.doc, baseSavedAt: input.baseSavedAt },
        }),
      ),
    }),
    onSuccess: ({ seq, result }) => {
      savedSeq.current = seq;
      setSavedAt(result.draft.savedAt);
      setSaveError(undefined);
      // Adopt the server's normalised document unless the user kept typing meanwhile.
      if (editSeq.current === seq) {
        setDoc(result.draft.doc);
        setPendingEdits(false);
      }
      setVisibility(result.visibility);
      queryClient.setQueryData(contentPageQuery(pageId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
    },
    onError: (error) => setSaveError(error),
    onSettled: () => setSaving(false),
  });

  // Autosave: debounce after the last edit; never while a save is in flight.
  useEffect(() => {
    if (readOnly || !pendingEdits || saving) return;
    const seq = editSeq.current;
    const timer = setTimeout(() => {
      setSaving(true);
      save.mutate({ doc, seq, baseSavedAt: savedAt });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [doc, pendingEdits, saving, readOnly, savedAt, save.mutate]);

  const setRule = useGuardedMutation({
    mutationFn: (rules: Record<string, VisibilityRule>) =>
      call(
        api().PUT("/content/pages/{id}/visibility", {
          params: { path: { id: pageId } },
          body: { rules },
        }),
      ),
    onSuccess: (result) => {
      setVisibility(result.visibility);
      queryClient.setQueryData(contentPageQuery(pageId).queryKey, result);
    },
    onError: (error) => toast.error(describeError(error).body),
  });

  const publish = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/content/pages/{id}/publish", { params: { path: { id: pageId } }, body: {} }),
      ),
    onSuccess: (result) => {
      toast.success(m.content_published({ n: String(result.page.publishedRevisionNo ?? "") }));
      queryClient.setQueryData(contentPageQuery(pageId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["content", "render"] });
      void queryClient.invalidateQueries({ queryKey: ["content", "revisions", pageId] });
    },
    onError: (error) => toast.error(describeError(error).body),
  });

  const rename = useGuardedMutation({
    mutationFn: (title: string) =>
      call(
        api().PATCH("/content/pages/{id}", { params: { path: { id: pageId } }, body: { title } }),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(contentPageQuery(pageId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).body),
  });

  const navigate = useNavigate();
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/content/pages/{id}", { params: { path: { id: pageId } } })),
    onSuccess: () => {
      toast.success(m.content_page_deleted());
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
      void navigate({ to: "/admin/$", params: { _splat: "content" } });
    },
    onError: (error) => toast.error(describeError(error).body),
  });

  const updateRule = (key: string, rule: VisibilityRule) => {
    const next = { ...visibility, [key]: rule };
    setVisibility(next);
    setRule.mutate(next);
  };

  const status = saving
    ? m.content_status_saving()
    : pendingEdits
      ? m.content_status_unsaved()
      : m.content_status_saved({ when: formatDateTime(savedAt) });
  const dirty = pendingEdits || saving || detail.page.draftDirty;
  const titleId = useId();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={titleId} className="sr-only">
            {m.content_field_title()}
          </Label>
          <Input
            id={titleId}
            defaultValue={detail.page.title}
            readOnly={readOnly}
            className="text-lg font-semibold"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== detail.page.title) rename.mutate(v);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {detail.page.kind === "home"
              ? m.content_home_hint()
              : m.content_slug_hint({ slug: detail.page.slug })}
            {" · "}
            {detail.page.publishedRevisionNo === null
              ? m.content_never_published()
              : m.content_published_rev({ n: String(detail.page.publishedRevisionNo) })}
            {" · "}
            <span aria-live="polite">{status}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <PreviewDialog pageId={pageId} groups={detail.groups} />
          <HistoryDialog pageId={pageId} canManage={canManage} />
          {canPublish ? (
            <Button
              type="button"
              onClick={() => publish.mutate()}
              disabled={publish.isPending || saving || pendingEdits}
            >
              <Send aria-hidden="true" />
              {dirty ? m.content_publish() : m.content_republish()}
            </Button>
          ) : null}
        </div>
      </div>

      {saveError !== undefined ? (
        <SaveError
          error={saveError}
          onReload={() =>
            void queryClient.invalidateQueries({ queryKey: contentPageQuery(pageId).queryKey })
          }
        />
      ) : null}

      <div className="space-y-4">
        {doc.sections.map((section, si) => (
          <SectionEditor
            key={section.key}
            section={section}
            index={si}
            count={doc.sections.length}
            rule={visibility[section.key] ?? { mode: "authenticated" }}
            groups={detail.groups}
            readOnly={readOnly}
            onRule={(rule) => updateRule(section.key, rule)}
            onChange={(fn) =>
              edit((d) => ({ sections: d.sections.map((s, i) => (i === si ? fn(s) : s)) }))
            }
            onMove={(dir) =>
              edit((d) => {
                const next = [...d.sections];
                const target = si + dir;
                if (target < 0 || target >= next.length) return d;
                const [item] = next.splice(si, 1);
                if (item === undefined) return d;
                next.splice(target, 0, item);
                return { sections: next };
              })
            }
            onRemove={() => edit((d) => ({ sections: d.sections.filter((_, i) => i !== si) }))}
          />
        ))}
        {!readOnly ? (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              edit((d) => ({
                sections: [
                  ...d.sections,
                  { key: newId("section"), title: m.content_new_section(), blocks: [] },
                ],
              }))
            }
          >
            <Plus aria-hidden="true" />
            {m.content_add_section()}
          </Button>
        ) : null}
      </div>

      {canManage && detail.page.kind === "custom" ? (
        <Card>
          <CardHeader>
            <CardTitle>{m.content_danger_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  <Trash2 aria-hidden="true" />
                  {m.content_delete_page()}
                </Button>
              }
              title={m.content_delete_page()}
              description={m.content_delete_page_body()}
              confirmLabel={m.content_delete_page()}
              onConfirm={() => remove.mutate()}
              pending={remove.isPending}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SaveError({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (isCode(error, "conflict")) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.content_conflict_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.content_conflict_body()}</p>
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            {m.content_reload()}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (isApiError(error) && error.code === "validation_failed") {
    const issues =
      (error.body.error["issues"] as { path: string; message: string }[] | undefined) ?? [];
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.content_invalid_title()}</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {issues.map((i) => (
              <li key={i.path}>
                <code className="font-mono text-xs">{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  return <ErrorAlert error={error} />;
}

function PreviewDialog({
  pageId,
  groups,
}: {
  pageId: string;
  groups: ContentPageDetail["groups"];
}) {
  const [open, setOpen] = useState(false);
  const [as, setAs] = useState("authenticated");
  const preview = useQuery({ ...contentPreviewQuery(pageId, as), enabled: open });
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Eye aria-hidden="true" />
          {m.content_preview()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{m.content_preview()}</DialogTitle>
          <DialogDescription>{m.content_preview_body()}</DialogDescription>
        </DialogHeader>
        <Field id={id} label={m.content_preview_as()}>
          <Select value={as} onValueChange={setAs}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="authenticated">{m.content_vis_authenticated()}</SelectItem>
              <SelectItem value="staff">{m.content_vis_staff_only()}</SelectItem>
              <SelectItem value="public">{m.content_vis_public()}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={`group:${g.id}`}>
                  {m.content_vis_groups({ groups: g.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {preview.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {preview.isError ? <ErrorAlert error={preview.error} /> : null}
        {preview.data ? <PageRenderer page={preview.data} showAudience groups={groups} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ pageId, canManage }: { pageId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const revisions = useQuery({ ...contentRevisionsQuery(pageId), enabled: open });
  const queryClient = useQueryClient();
  const restore = useGuardedMutation({
    mutationFn: (revisionId: string) =>
      call(
        api().POST("/content/pages/{id}/revisions/{revisionId}/restore", {
          params: { path: { id: pageId, revisionId } },
        }),
      ),
    onSuccess: (result) => {
      toast.success(m.content_restored());
      queryClient.setQueryData(contentPageQuery(pageId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: contentPagesQuery.queryKey });
      setOpen(false);
      // The editor is keyed by page id; force it to reload the restored draft.
      void queryClient.resetQueries({ queryKey: contentPageQuery(pageId).queryKey });
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <History aria-hidden="true" />
          {m.content_history()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.content_history()}</DialogTitle>
          <DialogDescription>{m.content_history_body()}</DialogDescription>
        </DialogHeader>
        {revisions.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {revisions.isError ? <ErrorAlert error={revisions.error} /> : null}
        {revisions.data ? (
          revisions.data.revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.content_never_published()}</p>
          ) : (
            <ul className="divide-y">
              {revisions.data.revisions.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span className="font-medium">
                      {m.content_revision_n({ n: String(r.revisionNo) })}
                    </span>
                    {r.isCurrent ? <Badge className="ml-2">{m.content_badge_live()}</Badge> : null}
                    <div className="text-xs text-muted-foreground">
                      {r.publishedAt ? formatDateTime(r.publishedAt) : ""}
                      {r.note ? ` · ${r.note}` : ""}
                    </div>
                  </div>
                  {canManage && !r.isCurrent ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(r.id)}
                    >
                      {m.content_restore()}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// --- sections -------------------------------------------------------------------------------------

function SectionEditor({
  section,
  index,
  count,
  rule,
  groups,
  readOnly,
  onRule,
  onChange,
  onMove,
  onRemove,
}: {
  section: PageSection;
  index: number;
  count: number;
  rule: VisibilityRule;
  groups: ContentPageDetail["groups"];
  readOnly: boolean;
  onRule: (rule: VisibilityRule) => void;
  onChange: (fn: (s: PageSection) => PageSection) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ids = { title: useId(), vis: useId(), add: useId() };
  const settings = useQuery(contentSettingsQuery);
  const allowPublic = settings.data?.allowPublicSections === true;
  const [addType, setAddType] = useState<BlockType | "">("");
  const label = section.title || m.content_untitled_section();
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">{label}</CardTitle>
          <Badge variant={rule.mode === "public" ? "destructive" : "outline"}>
            {visibilityLabel(rule, groups)}
          </Badge>
          {!readOnly ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.content_move_up({ name: label })}
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.content_move_down({ name: label })}
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.content_remove_section({ name: label })}
                onClick={onRemove}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={ids.title} label={m.content_section_title()}>
            <Input
              id={ids.title}
              value={section.title ?? ""}
              readOnly={readOnly}
              onChange={(e) =>
                onChange((s) => ({ ...s, title: e.target.value === "" ? null : e.target.value }))
              }
            />
          </Field>
          <Field
            id={ids.vis}
            label={m.content_section_audience()}
            description={rule.mode === "public" ? m.content_public_warning() : undefined}
          >
            <Select
              value={rule.mode}
              disabled={readOnly}
              onValueChange={(mode) => {
                if (mode === "groups")
                  onRule({ mode: "groups", groupIds: groups[0] ? [groups[0].id] : [] });
                else onRule({ mode: mode as "authenticated" | "staff_only" | "public" });
              }}
            >
              <SelectTrigger id={ids.vis}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="authenticated">{m.content_vis_authenticated()}</SelectItem>
                <SelectItem value="groups" disabled={groups.length === 0}>
                  {m.content_vis_groups_option()}
                </SelectItem>
                <SelectItem value="staff_only">{m.content_vis_staff_only()}</SelectItem>
                <SelectItem value="public" disabled={!allowPublic}>
                  {m.content_vis_public()}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {rule.mode === "groups" ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{m.content_pick_groups()}</legend>
            <div className="flex flex-wrap gap-4">
              {groups.map((g) => {
                const checked = rule.groupIds.includes(g.id);
                const cid = `${ids.vis}-${g.id}`;
                return (
                  <div key={g.id} className="flex items-center gap-2">
                    <Checkbox
                      id={cid}
                      checked={checked}
                      disabled={readOnly}
                      onCheckedChange={(v) => {
                        const next =
                          v === true
                            ? [...rule.groupIds, g.id]
                            : rule.groupIds.filter((x) => x !== g.id);
                        if (next.length > 0) onRule({ mode: "groups", groupIds: next });
                      }}
                    />
                    <Label htmlFor={cid}>{g.name}</Label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <div className="space-y-4">
          {section.blocks.map((block, bi) => (
            <BlockEditor
              key={block.id}
              block={block}
              readOnly={readOnly}
              onChange={(data) =>
                onChange((s) => ({
                  ...s,
                  blocks: s.blocks.map((b, i) => (i === bi ? { ...b, data } : b)),
                }))
              }
              onRemove={() =>
                onChange((s) => ({ ...s, blocks: s.blocks.filter((_, i) => i !== bi) }))
              }
            />
          ))}
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field id={ids.add} label={m.content_add_block()} className="min-w-56">
              <Select value={addType} onValueChange={(v) => setAddType(v as BlockType)}>
                <SelectTrigger id={ids.add}>
                  <SelectValue placeholder={m.content_pick_block()} />
                </SelectTrigger>
                <SelectContent>
                  {BLOCK_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {blockTypeLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={addType === ""}
              onClick={() => {
                if (addType === "") return;
                onChange((s) => ({ ...s, blocks: [...s.blocks, emptyBlock(addType)] }));
                setAddType("");
              }}
            >
              <Plus aria-hidden="true" />
              {m.content_add_block()}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- blocks ----------------------------------------------------------------------------------------

type Data = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");

function BlockEditor({
  block,
  readOnly,
  onChange,
  onRemove,
}: {
  block: PageBlock;
  readOnly: boolean;
  onChange: (data: Data) => void;
  onRemove: () => void;
}) {
  const d = block.data as Data;
  const set = (patch: Data) => onChange({ ...d, ...patch });
  const base = useId();
  const label = blockTypeLabel(block.type);
  return (
    <div className="space-y-3 rounded-lg border p-4" data-block={block.id}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <code className="text-xs text-muted-foreground">{block.id}</code>
        {!readOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label={m.content_remove_block({ name: label })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {block.type === "hero" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field id={`${base}-h`} label={m.content_hero_heading()} required>
            <Input
              id={`${base}-h`}
              value={s(d["heading"])}
              readOnly={readOnly}
              onChange={(e) => set({ heading: e.target.value })}
            />
          </Field>
          <Field id={`${base}-s`} label={m.content_hero_subheading()}>
            <Input
              id={`${base}-s`}
              value={s(d["subheading"])}
              readOnly={readOnly}
              onChange={(e) => set({ subheading: e.target.value || null })}
            />
          </Field>
          <Field id={`${base}-i`} label={m.content_hero_image()}>
            <Input
              id={`${base}-i`}
              type="url"
              value={s(d["imageUrl"])}
              readOnly={readOnly}
              onChange={(e) => set({ imageUrl: e.target.value || null })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${base}-cl`} label={m.content_hero_cta_label()}>
              <Input
                id={`${base}-cl`}
                value={s((d["cta"] as Data | null)?.["label"])}
                readOnly={readOnly}
                onChange={(e) =>
                  set({
                    cta: e.target.value
                      ? {
                          label: e.target.value,
                          href: s((d["cta"] as Data | null)?.["href"]) || "/",
                        }
                      : null,
                  })
                }
              />
            </Field>
            <Field id={`${base}-ch`} label={m.content_hero_cta_href()}>
              <Input
                id={`${base}-ch`}
                value={s((d["cta"] as Data | null)?.["href"])}
                readOnly={readOnly}
                onChange={(e) =>
                  set({
                    cta: {
                      label:
                        s((d["cta"] as Data | null)?.["label"]) || m.content_hero_cta_default(),
                      href: e.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
        </div>
      ) : null}
      {block.type === "rich_text" ? (
        <Field
          id={`${base}-t`}
          label={m.content_rich_text_label()}
          description={m.content_rich_text_help()}
        >
          <Textarea
            id={`${base}-t`}
            rows={8}
            value={s(d["text"])}
            readOnly={readOnly}
            onChange={(e) => set({ format: "markdown", text: e.target.value })}
          />
        </Field>
      ) : null}
      {block.type === "team" ? (
        <TeamEditor
          members={(d["members"] as Data[] | undefined) ?? []}
          readOnly={readOnly}
          onChange={(members) => set({ members })}
        />
      ) : null}
      {block.type === "faq" ? (
        <FaqEditor
          items={(d["items"] as Data[] | undefined) ?? []}
          readOnly={readOnly}
          onChange={(items) => set({ items })}
        />
      ) : null}
      {block.type === "embed" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            id={`${base}-u`}
            label={m.content_embed_url()}
            description={m.content_embed_help()}
            required
          >
            <Input
              id={`${base}-u`}
              type="url"
              value={s(d["url"])}
              readOnly={readOnly}
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          <Field id={`${base}-et`} label={m.content_field_title()}>
            <Input
              id={`${base}-et`}
              value={s(d["title"])}
              readOnly={readOnly}
              onChange={(e) => set({ title: e.target.value || null })}
            />
          </Field>
        </div>
      ) : null}
      {block.type === "metric_grid" ? (
        <MetricDefinitionPicker
          id={`${base}-m`}
          selected={(d["definitionIds"] as string[] | undefined) ?? []}
          readOnly={readOnly}
          onChange={(definitionIds) => set({ definitionIds })}
        />
      ) : null}
      {block.type === "document_list" ? (
        <Field
          id={`${base}-d`}
          label={m.content_document_ids()}
          description={m.content_reference_help()}
        >
          <Textarea
            id={`${base}-d`}
            rows={2}
            value={((d["documentIds"] as string[] | undefined) ?? []).join("\n")}
            readOnly={readOnly}
            onChange={(e) => set({ documentIds: e.target.value.split(/\s+/u).filter(Boolean) })}
          />
        </Field>
      ) : null}
      {block.type === "disclaimer" ? (
        <DisclaimerPicker
          id={`${base}-dc`}
          slug={s(d["slug"])}
          readOnly={readOnly}
          onChange={(slug) => set({ slug })}
        />
      ) : null}
    </div>
  );
}

function TeamEditor({
  members,
  readOnly,
  onChange,
}: {
  members: Data[];
  readOnly: boolean;
  onChange: (members: Data[]) => void;
}) {
  const base = useId();
  const update = (i: number, patch: Data) =>
    onChange(members.map((mem, j) => (j === i ? { ...mem, ...patch } : mem)));
  return (
    <div className="space-y-3">
      {members.map((mem, i) => (
        <div key={`${base}-${i}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
          <Field id={`${base}-${i}-n`} label={m.common_name()} required>
            <Input
              id={`${base}-${i}-n`}
              value={s(mem["name"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { name: e.target.value })}
            />
          </Field>
          <Field id={`${base}-${i}-t`} label={m.content_member_title()}>
            <Input
              id={`${base}-${i}-t`}
              value={s(mem["title"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { title: e.target.value || null })}
            />
          </Field>
          <Field id={`${base}-${i}-b`} label={m.content_member_bio()} className="md:col-span-2">
            <Textarea
              id={`${base}-${i}-b`}
              rows={2}
              value={s(mem["bio"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { bio: e.target.value || null })}
            />
          </Field>
          <Field id={`${base}-${i}-p`} label={m.content_member_photo()}>
            <Input
              id={`${base}-${i}-p`}
              type="url"
              value={s(mem["photoUrl"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { photoUrl: e.target.value || null })}
            />
          </Field>
          <Field id={`${base}-${i}-l`} label="LinkedIn">
            <Input
              id={`${base}-${i}-l`}
              type="url"
              value={s(mem["linkedinUrl"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { linkedinUrl: e.target.value || null })}
            />
          </Field>
          {!readOnly ? (
            <div className="md:col-span-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(members.filter((_, j) => j !== i))}
              >
                <Trash2 aria-hidden="true" />
                {m.common_remove()}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {!readOnly ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...members,
              { name: "", title: null, bio: null, photoUrl: null, linkedinUrl: null },
            ])
          }
        >
          <Plus aria-hidden="true" />
          {m.content_add_member()}
        </Button>
      ) : null}
    </div>
  );
}

function FaqEditor({
  items,
  readOnly,
  onChange,
}: {
  items: Data[];
  readOnly: boolean;
  onChange: (items: Data[]) => void;
}) {
  const base = useId();
  const update = (i: number, patch: Data) =>
    onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={`${base}-${i}`} className="grid gap-3 rounded-md border p-3">
          <Field id={`${base}-${i}-q`} label={m.content_faq_question()} required>
            <Input
              id={`${base}-${i}-q`}
              value={s(it["question"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { question: e.target.value })}
            />
          </Field>
          <Field id={`${base}-${i}-a`} label={m.content_faq_answer()} required>
            <Textarea
              id={`${base}-${i}-a`}
              rows={2}
              value={s(it["answer"])}
              readOnly={readOnly}
              onChange={(e) => update(i, { answer: e.target.value })}
            />
          </Field>
          {!readOnly ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <Trash2 aria-hidden="true" />
                {m.common_remove()}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {!readOnly ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...items, { question: "", answer: "" }])}
        >
          <Plus aria-hidden="true" />
          {m.content_add_faq()}
        </Button>
      ) : null}
    </div>
  );
}

/*
 * The disclaimer block names a kernel legal document by slug. Staff pick it by name from the
 * workspace's own documents (`GET /compliance/documents`); the empty value means "whatever the
 * workspace default is", which is the setting on /admin/legal rather than a value stored here.
 * An editor who cannot read the compliance routes still sees (and keeps) the stored slug.
 */
function DisclaimerPicker({
  id,
  slug,
  readOnly,
  onChange,
}: {
  id: string;
  slug: string;
  readOnly: boolean;
  onChange: (slug: string | null) => void;
}) {
  const documents = useQuery({ ...legalDocumentsQuery, retry: false });
  const options = (documents.data?.documents ?? []).filter((doc) => doc.kind === "disclaimer");
  const known = slug === "" || options.some((doc) => doc.slug === slug);
  return (
    <Field
      id={id}
      label={m.content_disclaimer_slug()}
      description={m.content_disclaimer_help()}
      className="md:col-span-2"
    >
      <NativeSelect
        id={id}
        value={slug}
        disabled={readOnly}
        aria-describedby={`${id}-description`}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">{m.content_disclaimer_default()}</option>
        {options.map((doc) => (
          <option key={doc.id} value={doc.slug}>
            {doc.title}
          </option>
        ))}
        {known ? null : <option value={slug}>{slug}</option>}
      </NativeSelect>
    </Field>
  );
}

/*
 * The `metric_grid` block stores definition ids and nothing else (E2.4 §10). It used to be
 * edited as newline-separated UUIDs in a `<textarea>`, which asked an admin to copy an
 * opaque id out of another screen and offered no way to notice a typo: a wrong id is simply
 * a tile that never appears. This lists the workspace's metrics by name instead, and keeps
 * the block's own ordering — the order boxes are ticked is the order the tiles render in.
 *
 * The catalogue read is `retry: false` on purpose: `metrics` is an optional module and the
 * route 404s when it is off. An id already in the block that the catalogue does not know
 * (a deleted metric, or the module being off) is still listed, so editing a neighbouring
 * block cannot silently drop it.
 */
function MetricDefinitionPicker({
  id,
  selected,
  readOnly,
  onChange,
}: {
  id: string;
  selected: readonly string[];
  readOnly: boolean;
  onChange: (ids: string[]) => void;
}) {
  const definitions = useQuery({ ...metricDefinitionsQuery, retry: false });
  const known = definitions.data?.definitions ?? [];
  const unknown = selected.filter((x) => !known.some((def) => def.id === x));
  const toggle = (definitionId: string, on: boolean) =>
    onChange(on ? [...selected, definitionId] : selected.filter((x) => x !== definitionId));
  return (
    <Field
      id={id}
      label={m.content_metric_ids()}
      description={m.content_metric_pick_help()}
      className="md:col-span-2"
    >
      <div id={id} className="space-y-2">
        {definitions.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {!definitions.isPending && known.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.content_metric_none()}</p>
        ) : null}
        {known.map((def) => (
          <label key={def.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(def.id)}
              disabled={readOnly}
              onChange={(e) => toggle(def.id, e.target.checked)}
            />
            <span>{def.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{def.key}</span>
          </label>
        ))}
        {unknown.map((x) => (
          <label key={x} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked disabled={readOnly} onChange={() => toggle(x, false)} />
            <span className="font-mono text-xs">{x}</span>
            <span className="text-xs text-muted-foreground">{m.content_metric_unknown()}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}
