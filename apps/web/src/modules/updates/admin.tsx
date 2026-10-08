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
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, CalendarClock, Plus, Send, Settings, Trash2 } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { DraftWithAiButton } from "../../components/ai-admin/update-draft.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { RichTextEditor } from "../../components/rich-text-editor.js";
import { useAiFeature } from "../../lib/ai-queries.js";
import { analyticsPostEmailQuery } from "../../lib/analytics-queries.js";
import { api, call, describeError, isCode } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { useBootstrap } from "../../lib/queries.js";
import {
  type PageBlock,
  type PageDoc,
  type PageSection,
  type SendingDomain,
  sendingDomainQuery,
  type UpdateAudience,
  type UpdatePost,
  type UpdatePostDetail,
  type UpdateSectionRule,
  type UpdateSend,
  updatePostQuery,
  updatePostsQuery,
  updateRecipientsQuery,
  updateSendsQuery,
  updatesSettingsQuery,
  updateTemplatesQuery,
  updateThreadsQuery,
} from "../../lib/updates-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * Investor updates, staff side (E1.4): `/admin/updates` lists drafts and sent updates,
 * `/admin/updates/<id>` edits one (autosaved draft, audience, per-section rules, test send,
 * schedule, send now, archive-only publish, sends with per-recipient status, reply threads),
 * `/admin/updates/settings` holds sender settings and the sending domain.
 */
const AUTOSAVE_MS = 1000;

export default function UpdatesAdmin({ splat }: ModulePageProps) {
  const [head, ...rest] = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const can = {
    manage: permissions.includes("updates.manage"),
    send: permissions.includes("updates.send"),
    settings: permissions.includes("updates.settings"),
  };
  if (head === "settings") return <SettingsScreen canSettings={can.settings} />;
  if (head) return <PostEditor key={head} postId={head} can={can} sub={rest[0]} />;
  return <PostList can={can} />;
}

function stateLabel(state: UpdatePost["state"]): string {
  switch (state) {
    case "draft":
      return m.updates_state_draft();
    case "scheduled":
      return m.updates_state_scheduled();
    case "sending":
      return m.updates_state_sending();
    case "sent":
      return m.updates_state_sent();
    case "archived":
      return m.updates_state_archived();
  }
}

function stateVariant(state: UpdatePost["state"]): "default" | "secondary" | "outline" | "warning" {
  return state === "sent"
    ? "default"
    : state === "scheduled" || state === "sending"
      ? "warning"
      : state === "archived"
        ? "outline"
        : "secondary";
}

function PostList({ can }: { can: { manage: boolean; settings: boolean } }) {
  const posts = useQuery(updatePostsQuery);
  // E3.12: only while the workspace has "Draft with AI" effectively on.
  const aiDraft = useAiFeature("updateDraft", can.manage);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.updates_admin_title()}
        description={m.updates_admin_subtitle()}
        actions={
          <div className="flex gap-2">
            {can.settings ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "updates/settings" }}>
                  <Settings aria-hidden="true" />
                  {m.updates_settings_link()}
                </Link>
              </Button>
            ) : null}
            {aiDraft ? <DraftWithAiButton /> : null}
            {can.manage ? <NewUpdateDialog /> : null}
          </div>
        }
      />
      {posts.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {posts.isError ? <ErrorAlert error={posts.error} /> : null}
      {posts.data ? (
        posts.data.posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.updates_admin_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.updates_col_title()}</TableHead>
                <TableHead>{m.updates_col_state()}</TableHead>
                <TableHead>{m.updates_col_audience()}</TableHead>
                <TableHead>{m.updates_col_when()}</TableHead>
                <TableHead>{m.updates_col_delivery()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.data.posts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      to="/admin/$"
                      params={{ _splat: `updates/${p.id}` }}
                      className="font-medium hover:underline"
                    >
                      {p.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariant(p.state)}>{stateLabel(p.state)}</Badge>
                  </TableCell>
                  <TableCell>
                    {p.audience.kind === "all"
                      ? m.updates_audience_all()
                      : m.updates_audience_groups_n({ n: p.audience.groupIds.length })}
                  </TableCell>
                  <TableCell>
                    {p.sentAt
                      ? formatDateTime(p.sentAt)
                      : p.scheduledFor
                        ? formatDateTime(p.scheduledFor)
                        : formatDateTime(p.savedAt)}
                  </TableCell>
                  <TableCell>
                    {p.lastSend && p.lastSend.kind === "live"
                      ? m.updates_delivery_counts({
                          sent: String(p.lastSend.sent),
                          total: String(p.lastSend.total),
                        })
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}

function NewUpdateDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("yc");
  const templates = useQuery({ ...updateTemplatesQuery, enabled: open });
  const ids = { title: useId(), template: useId() };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/updates/posts", {
          body: { title: title.trim(), template: template as "yc" | "minimal" | "board" | "blank" },
        }),
      ),
    onSuccess: (d) => {
      toast.success(m.updates_created());
      setOpen(false);
      setTitle("");
      void queryClient.invalidateQueries({ queryKey: updatePostsQuery.queryKey });
      void navigate({ to: "/admin/$", params: { _splat: `updates/${d.post.id}` } });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.updates_new()}
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
            <DialogTitle>{m.updates_new()}</DialogTitle>
            <DialogDescription>{m.updates_new_body()}</DialogDescription>
          </DialogHeader>
          <Field id={ids.title} label={m.updates_field_title()} required>
            <Input
              id={ids.title}
              value={title}
              required
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{m.updates_field_template()}</legend>
            {(templates.data?.templates ?? []).map((t) => (
              <label key={t.key} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="template"
                  value={t.key}
                  checked={template === t.key}
                  onChange={() => setTemplate(t.key)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-muted-foreground">{t.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {create.isError ? <ErrorAlert error={create.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              {m.common_continue()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- the editor -----------------------------------------------------------------------------------

function PostEditor({
  postId,
  can,
  sub,
}: {
  postId: string;
  can: { manage: boolean; send: boolean };
  sub: string | undefined;
}) {
  const detail = useQuery(updatePostQuery(postId));
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  return <LoadedEditor detail={detail.data} can={can} openSendId={sub} />;
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function LoadedEditor({
  detail,
  can,
  openSendId,
}: {
  detail: UpdatePostDetail;
  can: { manage: boolean; send: boolean };
  openSendId: string | undefined;
}) {
  const postId = detail.post.id;
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(detail.post.title);
  const [doc, setDoc] = useState<PageDoc>(detail.doc);
  const [visibility, setVisibility] = useState(detail.visibility);
  const [audience, setAudience] = useState<UpdateAudience>(detail.post.audience);
  const [savedAt, setSavedAt] = useState(detail.post.savedAt);
  const [post, setPost] = useState(detail.post);
  const editSeq = useRef(0);
  const savedSeq = useRef(0);
  const [pendingEdits, setPendingEdits] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);
  const locked = post.state === "sending";
  const readOnly = !can.manage || locked;

  const adopt = useCallback(
    (d: UpdatePostDetail) => {
      setPost(d.post);
      setSavedAt(d.post.savedAt);
      queryClient.setQueryData(updatePostQuery(postId).queryKey, d);
      void queryClient.invalidateQueries({ queryKey: updatePostsQuery.queryKey });
    },
    [postId, queryClient],
  );

  const edit = useCallback((fn: () => void) => {
    editSeq.current += 1;
    setPendingEdits(true);
    fn();
  }, []);

  const save = useGuardedMutation({
    mutationFn: async (input: {
      seq: number;
      body: {
        title: string;
        doc: PageDoc;
        visibility: Record<string, UpdateSectionRule>;
        audience: UpdateAudience;
        baseSavedAt: string;
      };
    }) => ({
      seq: input.seq,
      result: await call(
        api().PUT("/updates/posts/{id}/draft", {
          params: { path: { id: postId } },
          body: input.body,
        }),
      ),
    }),
    onSuccess: ({ seq, result }) => {
      savedSeq.current = seq;
      setSaveError(undefined);
      if (editSeq.current === seq) {
        setDoc(result.doc);
        setVisibility(result.visibility);
        setTitle(result.post.title);
        setAudience(result.post.audience);
        setPendingEdits(false);
      }
      adopt(result);
    },
    onError: (error) => setSaveError(error),
    onSettled: () => setSaving(false),
  });

  useEffect(() => {
    if (readOnly || !pendingEdits || saving) return;
    const seq = editSeq.current;
    const timer = setTimeout(() => {
      setSaving(true);
      save.mutate({ seq, body: { title, doc, visibility, audience, baseSavedAt: savedAt } });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [title, doc, visibility, audience, pendingEdits, saving, readOnly, savedAt, save.mutate]);

  // While a send runs, poll the post until it settles.
  useEffect(() => {
    if (
      post.state !== "sending" &&
      post.lastSend?.status !== "running" &&
      post.lastSend?.status !== "queued"
    )
      return;
    const t = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: updatePostQuery(postId).queryKey });
      void queryClient.invalidateQueries({ queryKey: updateSendsQuery(postId).queryKey });
    }, 2000);
    return () => clearInterval(t);
  }, [post.state, post.lastSend?.status, postId, queryClient]);
  useEffect(() => {
    setPost(detail.post);
  }, [detail.post]);

  const useAction = (path: "send" | "unschedule" | "publish") =>
    useGuardedMutation({
      mutationFn: () =>
        call(api().POST(`/updates/posts/{id}/${path}`, { params: { path: { id: postId } } })),
      onSuccess: (d) => {
        adopt(d);
        void queryClient.invalidateQueries({ queryKey: updateSendsQuery(postId).queryKey });
        toast.success(
          path === "send"
            ? m.updates_send_queued()
            : path === "publish"
              ? m.updates_published()
              : m.updates_unscheduled(),
        );
      },
      onError: (error) => toast.error(describeError(error).body),
    });
  const sendNow = useAction("send");
  const unschedule = useAction("unschedule");
  const publishOnly = useAction("publish");

  const archive = useGuardedMutation({
    mutationFn: (archived: boolean) =>
      call(
        api().PUT("/updates/posts/{id}/archived", {
          params: { path: { id: postId } },
          body: { archived },
        }),
      ),
    onSuccess: adopt,
    onError: (error) => toast.error(describeError(error).body),
  });
  const navigate = useNavigate();
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/updates/posts/{id}", { params: { path: { id: postId } } })),
    onSuccess: () => {
      toast.success(m.updates_deleted());
      void queryClient.invalidateQueries({ queryKey: updatePostsQuery.queryKey });
      void navigate({ to: "/admin/$", params: { _splat: "updates" } });
    },
    onError: (error) => toast.error(describeError(error).body),
  });

  const ids = { title: useId() };
  const groups = detail.groups;

  const setSection = (i: number, fn: (s: PageSection) => PageSection) =>
    edit(() => setDoc((d) => ({ sections: d.sections.map((s, j) => (j === i ? fn(s) : s)) })));

  return (
    <div className="space-y-6">
      <PageHeader
        title={post.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={stateVariant(post.state)}>{stateLabel(post.state)}</Badge>
            {post.scheduledFor ? (
              <span>{m.updates_scheduled_for({ when: formatDateTime(post.scheduledFor) })}</span>
            ) : null}
            {post.sentAt ? (
              <span>{m.updates_sent_at({ when: formatDateTime(post.sentAt) })}</span>
            ) : null}
            {post.publishedVersionNo ? (
              <span>{m.updates_version_n({ n: String(post.publishedVersionNo) })}</span>
            ) : null}
            <span aria-live="polite" className="text-muted-foreground">
              {saving
                ? m.content_status_saving()
                : pendingEdits
                  ? m.content_status_unsaved()
                  : m.content_status_saved({ when: formatDateTime(savedAt) })}
            </span>
          </span>
        }
        actions={
          <Button asChild variant="ghost">
            <Link to="/admin/$" params={{ _splat: "updates" }}>
              {m.updates_back_to_list()}
            </Link>
          </Button>
        }
      />
      {saveError !== undefined ? (
        isCode(saveError, "conflict") ? (
          <Alert variant="destructive">
            <AlertTitle>{m.content_conflict_title()}</AlertTitle>
            <AlertDescription>
              {m.content_conflict_body()}{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: updatePostQuery(postId).queryKey })
                }
              >
                {m.content_reload()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <ErrorAlert error={saveError} />
        )
      ) : null}
      {locked ? (
        <Alert>
          <AlertTitle>{m.updates_sending_title()}</AlertTitle>
          <AlertDescription>{m.updates_sending_body()}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Field id={ids.title} label={m.updates_field_title()} required>
            <Input
              id={ids.title}
              value={title}
              readOnly={readOnly}
              maxLength={200}
              onChange={(e) => edit(() => setTitle(e.target.value))}
            />
          </Field>
          {doc.sections.map((section, i) => (
            <SectionEditor
              key={section.key}
              section={section}
              rule={visibility[section.key] ?? { mode: "authenticated" }}
              groups={groups}
              readOnly={readOnly}
              first={i === 0}
              last={i === doc.sections.length - 1}
              onChange={(fn) => setSection(i, fn)}
              onRule={(rule) => edit(() => setVisibility((v) => ({ ...v, [section.key]: rule })))}
              onMove={(dir) =>
                edit(() =>
                  setDoc((d) => {
                    const next = [...d.sections];
                    const j = i + dir;
                    const [s] = next.splice(i, 1);
                    if (s) next.splice(j, 0, s);
                    return { sections: next };
                  }),
                )
              }
              onRemove={() =>
                edit(() => setDoc((d) => ({ sections: d.sections.filter((_, j) => j !== i) })))
              }
            />
          ))}
          {!readOnly ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                edit(() =>
                  setDoc((d) => ({
                    sections: [
                      ...d.sections,
                      {
                        key: newId("section"),
                        title: m.updates_new_section_title(),
                        blocks: [
                          {
                            id: newId("text"),
                            type: "rich_text",
                            schemaVersion: 1,
                            data: { format: "markdown", text: "" },
                          },
                        ],
                      },
                    ],
                  })),
                )
              }
            >
              <Plus aria-hidden="true" />
              {m.updates_add_section()}
            </Button>
          ) : null}
        </div>

        <aside className="space-y-6">
          <AudienceCard
            audience={audience}
            groups={groups}
            readOnly={readOnly}
            onChange={(a) => edit(() => setAudience(a))}
          />
          {can.send ? (
            <Card>
              <CardHeader>
                <CardTitle>{m.updates_actions_title()}</CardTitle>
                <CardDescription>{m.updates_actions_body()}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <TestSendDialog postId={postId} disabled={locked || pendingEdits || saving} />
                {post.state === "scheduled" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={unschedule.isPending}
                    onClick={() => unschedule.mutate()}
                  >
                    {m.updates_unschedule()}
                  </Button>
                ) : (
                  <ScheduleDialog
                    postId={postId}
                    disabled={
                      locked ||
                      pendingEdits ||
                      saving ||
                      post.state === "sent" ||
                      post.state === "archived"
                    }
                    onScheduled={adopt}
                  />
                )}
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      disabled={locked || pendingEdits || saving || sendNow.isPending}
                    >
                      <Send aria-hidden="true" />
                      {post.state === "sent" ? m.updates_send_again() : m.updates_send_now()}
                    </Button>
                  }
                  title={m.updates_send_confirm_title()}
                  description={
                    audience.kind === "all"
                      ? m.updates_send_confirm_all()
                      : m.updates_send_confirm_groups({ n: audience.groupIds.length })
                  }
                  confirmLabel={m.updates_send_now()}
                  onConfirm={() => sendNow.mutate()}
                  pending={sendNow.isPending}
                />
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked || pendingEdits || saving || publishOnly.isPending}
                  onClick={() => publishOnly.mutate()}
                >
                  {m.updates_publish_only()}
                </Button>
              </CardContent>
            </Card>
          ) : null}
          {can.manage ? (
            <Card>
              <CardContent className="flex flex-col gap-2 pt-6">
                {post.state === "sent" || post.state === "archived" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={archive.isPending}
                    onClick={() => archive.mutate(post.state !== "archived")}
                  >
                    {post.state === "archived" ? m.updates_unarchive() : m.updates_archive()}
                  </Button>
                ) : null}
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={locked || remove.isPending}
                    >
                      <Trash2 aria-hidden="true" />
                      {m.updates_delete()}
                    </Button>
                  }
                  title={m.updates_delete_confirm_title()}
                  description={m.updates_delete_confirm_body()}
                  confirmLabel={m.updates_delete()}
                  onConfirm={() => remove.mutate()}
                  pending={remove.isPending}
                />
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>

      <SendsCard postId={postId} openSendId={openSendId} />
      {post.state === "sent" || post.state === "archived" || post.state === "sending" ? (
        <EmailEngagementCard postId={postId} />
      ) : null}
      <ThreadsCard postId={postId} />
    </div>
  );
}

function AudienceCard({
  audience,
  groups,
  readOnly,
  onChange,
}: {
  audience: UpdateAudience;
  groups: readonly { id: string; name: string }[];
  readOnly: boolean;
  onChange: (a: UpdateAudience) => void;
}) {
  const name = useId();
  const selected = audience.kind === "groups" ? audience.groupIds : [];
  const toggle = (id: string, on: boolean) => {
    const ids = on ? [...selected, id] : selected.filter((g) => g !== id);
    onChange(ids.length === 0 ? { kind: "all" } : { kind: "groups", groupIds: ids });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_audience_title()}</CardTitle>
        <CardDescription>{m.updates_audience_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={readOnly} className="space-y-2">
          <legend className="sr-only">{m.updates_audience_title()}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              checked={audience.kind === "all"}
              onChange={() => onChange({ kind: "all" })}
            />
            {m.updates_audience_all()}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              checked={audience.kind === "groups"}
              onChange={() =>
                onChange(groups[0] ? { kind: "groups", groupIds: [groups[0].id] } : { kind: "all" })
              }
              disabled={groups.length === 0}
            />
            {m.updates_audience_groups()}
          </label>
          {audience.kind === "groups" ? (
            <div className="ml-6 space-y-1">
              {groups.map((g) => (
                <div key={g.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`${name}-${g.id}`}
                    checked={selected.includes(g.id)}
                    onCheckedChange={(v) => toggle(g.id, v === true)}
                  />
                  <Label htmlFor={`${name}-${g.id}`}>{g.name}</Label>
                </div>
              ))}
            </div>
          ) : null}
        </fieldset>
      </CardContent>
    </Card>
  );
}

function SectionEditor({
  section,
  rule,
  groups,
  readOnly,
  first,
  last,
  onChange,
  onRule,
  onMove,
  onRemove,
}: {
  section: PageSection;
  rule: UpdateSectionRule;
  groups: readonly { id: string; name: string }[];
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onChange: (fn: (s: PageSection) => PageSection) => void;
  onRule: (rule: UpdateSectionRule) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ids = { title: useId(), rule: useId() };
  const ruleGroups = rule.mode === "groups" ? rule.groupIds : [];
  return (
    <Card data-section={section.key}>
      <CardHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <Field id={ids.title} label={m.updates_section_title()}>
              <Input
                id={ids.title}
                value={section.title ?? ""}
                readOnly={readOnly}
                maxLength={120}
                onChange={(e) =>
                  onChange((s) => ({ ...s, title: e.target.value === "" ? null : e.target.value }))
                }
              />
            </Field>
          </div>
          {!readOnly ? (
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m.content_move_up({ name: section.title ?? section.key })}
                disabled={first}
                onClick={() => onMove(-1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m.content_move_down({ name: section.title ?? section.key })}
                disabled={last}
                onClick={() => onMove(1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m.updates_remove_section()}
                onClick={onRemove}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
        <fieldset disabled={readOnly} className="flex flex-wrap items-center gap-4 text-sm">
          <legend className="sr-only">{m.updates_section_audience()}</legend>
          <span className="text-muted-foreground">{m.updates_section_audience()}</span>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={ids.rule}
              checked={rule.mode === "authenticated"}
              onChange={() => onRule({ mode: "authenticated" })}
            />
            {m.updates_rule_everyone()}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={ids.rule}
              checked={rule.mode === "groups"}
              disabled={groups.length === 0}
              onChange={() =>
                groups[0] ? onRule({ mode: "groups", groupIds: [groups[0].id] }) : undefined
              }
            />
            {m.updates_rule_groups()}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={ids.rule}
              checked={rule.mode === "staff_only"}
              onChange={() => onRule({ mode: "staff_only" })}
            />
            {m.updates_rule_staff()}
          </label>
          {rule.mode === "groups"
            ? groups.map((g) => (
                <div key={g.id} className="flex items-center gap-1">
                  <Checkbox
                    id={`${ids.rule}-${g.id}`}
                    checked={ruleGroups.includes(g.id)}
                    onCheckedChange={(v) => {
                      const ids2 =
                        v === true ? [...ruleGroups, g.id] : ruleGroups.filter((x) => x !== g.id);
                      onRule(
                        ids2.length === 0
                          ? { mode: "authenticated" }
                          : { mode: "groups", groupIds: ids2 },
                      );
                    }}
                  />
                  <Label htmlFor={`${ids.rule}-${g.id}`}>{g.name}</Label>
                </div>
              ))
            : null}
        </fieldset>
      </CardHeader>
      <CardContent className="space-y-4">
        {section.blocks.map((block, i) => (
          <BlockEditor
            key={block.id}
            block={block}
            readOnly={readOnly}
            onChange={(data) =>
              onChange((s) => ({
                ...s,
                blocks: s.blocks.map((b, j) => (j === i ? { ...b, data } : b)),
              }))
            }
            onRemove={() => onChange((s) => ({ ...s, blocks: s.blocks.filter((_, j) => j !== i) }))}
          />
        ))}
        {!readOnly ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange((s) => ({
                  ...s,
                  blocks: [
                    ...s.blocks,
                    {
                      id: newId("text"),
                      type: "rich_text",
                      schemaVersion: 1,
                      data: { format: "markdown", text: "" },
                    },
                  ],
                }))
              }
            >
              {m.updates_add_text()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange((s) => ({
                  ...s,
                  blocks: [
                    ...s.blocks,
                    {
                      id: newId("link"),
                      type: "embed",
                      schemaVersion: 1,
                      data: { url: "https://", title: null, provider: "other" },
                    },
                  ],
                }))
              }
            >
              {m.updates_add_link()}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BlockEditor({
  block,
  readOnly,
  onChange,
  onRemove,
}: {
  block: PageBlock;
  readOnly: boolean;
  onChange: (data: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const d = block.data;
  const removeButton = !readOnly ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={m.content_remove_block({ name: block.type })}
      onClick={onRemove}
    >
      <Trash2 aria-hidden="true" />
    </Button>
  ) : null;
  if (block.type === "rich_text") {
    return (
      <div className="flex items-start gap-2">
        <RichTextEditor
          id={id}
          className="flex-1"
          label={m.content_rich_text_label()}
          value={typeof d["text"] === "string" ? d["text"] : ""}
          readOnly={readOnly}
          onChange={(text) => onChange({ format: "markdown", text })}
        />
        {removeButton}
      </div>
    );
  }
  if (block.type === "embed") {
    return (
      <div className="flex items-end gap-2">
        <Field id={`${id}-url`} label={m.content_embed_url()} className="flex-1">
          <Input
            id={`${id}-url`}
            value={typeof d["url"] === "string" ? d["url"] : ""}
            readOnly={readOnly}
            onChange={(e) => onChange({ ...d, url: e.target.value })}
          />
        </Field>
        <Field id={`${id}-title`} label={m.updates_link_title()} className="flex-1">
          <Input
            id={`${id}-title`}
            value={typeof d["title"] === "string" ? d["title"] : ""}
            readOnly={readOnly}
            onChange={(e) =>
              onChange({ ...d, title: e.target.value === "" ? null : e.target.value })
            }
          />
        </Field>
        {removeButton}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <span>{m.updates_block_other({ type: block.type })}</span>
      {removeButton}
    </div>
  );
}

function TestSendDialog({ postId, disabled }: { postId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const id = useId();
  const queryClient = useQueryClient();
  const send = useGuardedMutation({
    mutationFn: () => {
      const list = to
        .split(/[\s,;]+/u)
        .map((s) => s.trim())
        .filter(Boolean);
      return call(
        api().POST("/updates/posts/{id}/test-send", {
          params: { path: { id: postId } },
          body: list.length > 0 ? { to: list } : {},
        }),
      );
    },
    onSuccess: () => {
      toast.success(m.updates_test_queued());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: updateSendsQuery(postId).queryKey });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          {m.updates_test_send()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.updates_test_send()}</DialogTitle>
            <DialogDescription>{m.updates_test_send_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.updates_test_to()} description={m.updates_test_to_help()}>
            <Input id={id} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {send.isError ? <ErrorAlert error={send.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={send.isPending}>
              {m.updates_test_send()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({
  postId,
  disabled,
  onScheduled,
}: {
  postId: string;
  disabled: boolean;
  onScheduled: (d: UpdatePostDetail) => void;
}) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const id = useId();
  const schedule = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/updates/posts/{id}/schedule", {
          params: { path: { id: postId } },
          body: { scheduledFor: new Date(when).toISOString() },
        }),
      ),
    onSuccess: (d) => {
      toast.success(m.updates_scheduled_toast());
      setOpen(false);
      onScheduled(d);
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          <CalendarClock aria-hidden="true" />
          {m.updates_schedule()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            schedule.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{m.updates_schedule()}</DialogTitle>
            <DialogDescription>{m.updates_schedule_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.updates_schedule_when()} required>
            <Input
              id={id}
              type="datetime-local"
              value={when}
              required
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>
          {schedule.isError ? <ErrorAlert error={schedule.error} /> : null}
          <DialogFooter>
            <Button type="submit" disabled={schedule.isPending || !when}>
              {m.updates_schedule()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function sendStatusLabel(s: UpdateSend["status"]): string {
  switch (s) {
    case "queued":
      return m.updates_send_queued_state();
    case "running":
      return m.updates_send_running();
    case "finished":
      return m.updates_send_finished();
    case "failed":
      return m.updates_send_failed();
  }
}

function SendsCard({ postId, openSendId }: { postId: string; openSendId: string | undefined }) {
  const sends = useQuery(updateSendsQuery(postId));
  const [open, setOpen] = useState<string | undefined>(openSendId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_sends_title()}</CardTitle>
        <CardDescription>{m.updates_sends_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        {sends.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {sends.isError ? <ErrorAlert error={sends.error} /> : null}
        {sends.data && sends.data.sends.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.updates_sends_empty()}</p>
        ) : null}
        {sends.data && sends.data.sends.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.updates_col_when()}</TableHead>
                <TableHead>{m.updates_col_kind()}</TableHead>
                <TableHead>{m.updates_col_state()}</TableHead>
                <TableHead>{m.updates_col_delivery()}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sends.data.sends.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                  <TableCell>
                    {s.kind === "test" ? m.updates_kind_test() : m.updates_kind_live()}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === "finished"
                          ? "default"
                          : s.status === "failed"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {sendStatusLabel(s.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {m.updates_delivery_detail({
                      sent: String(s.sent),
                      failed: String(s.failed),
                      skipped: String(s.skipped),
                      total: String(s.total),
                    })}
                    {/* What the ESP reported back after the hand-off (E2.6 webhooks). */}
                    <span className="block text-xs text-muted-foreground">
                      {m.updates_delivery_feedback({
                        delivered: String(s.delivered),
                        bounced: String(s.bounced),
                        complained: String(s.complained),
                      })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={open === s.id}
                      onClick={() => setOpen((o) => (o === s.id ? undefined : s.id))}
                    >
                      {m.updates_recipients()}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {open ? <RecipientsTable sendId={open} /> : null}
      </CardContent>
    </Card>
  );
}

function recipientStatusLabel(s: string): string {
  switch (s) {
    case "queued":
      return m.updates_rcpt_queued();
    case "sent":
      return m.updates_rcpt_sent();
    case "delivered":
      return m.updates_rcpt_delivered();
    case "failed":
      return m.updates_rcpt_failed();
    case "skipped":
      return m.updates_rcpt_skipped();
    case "bounced":
      return m.updates_rcpt_bounced();
    case "complained":
      return m.updates_rcpt_complained();
    default:
      return s;
  }
}

/** `skipped` + `suppressed`: the address hard-bounced or complained on an earlier send. */
function recipientDetail(status: string, error: string | null): string | null {
  if (status === "skipped" && error === "suppressed") return m.updates_rcpt_suppressed();
  return error;
}

function RecipientsTable({ sendId }: { sendId: string }) {
  const q = useQuery(updateRecipientsQuery(sendId));
  if (q.isPending) return <LoadingState label={m.common_loading()} />;
  if (q.isError) return <ErrorAlert error={q.error} />;
  return (
    <Table className="mt-4" aria-label={m.updates_recipients()}>
      <TableHeader>
        <TableRow>
          <TableHead>{m.updates_col_email()}</TableHead>
          <TableHead>{m.updates_col_state()}</TableHead>
          <TableHead>{m.updates_col_detail()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.recipients.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{r.email}</TableCell>
            <TableCell>
              <Badge
                variant={
                  r.status === "sent" || r.status === "delivered"
                    ? "default"
                    : r.status === "failed" || r.status === "bounced" || r.status === "complained"
                      ? "destructive"
                      : "outline"
                }
              >
                {recipientStatusLabel(r.status)}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {recipientDetail(r.status, r.error) ?? (r.sentAt ? formatDateTime(r.sentAt) : "")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/*
 * Opens and clicks for this update, from the analytics module (joined in the browser: updates
 * owns delivery, analytics owns engagement). The route 404s when analytics is disabled or the
 * viewer lacks `analytics.read`, so any error simply hides the card.
 */
function EmailEngagementCard({ postId }: { postId: string }) {
  const q = useQuery(analyticsPostEmailQuery(postId));
  if (!q.data) return null;
  const e = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_email_title()}</CardTitle>
        <CardDescription>{m.updates_email_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {e.mode !== "engagement" ? (
          <p className="text-sm text-muted-foreground">{m.updates_email_mode_off()}</p>
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">{m.updates_email_human_opens()}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{e.opens.uniqueHuman}</dd>
            <dd className="text-xs text-muted-foreground">
              {m.updates_email_opens_total({ n: String(e.opens.human) })}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{m.updates_email_automated_opens()}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{e.opens.uniqueAutomated}</dd>
            <dd className="text-xs text-muted-foreground">
              {m.updates_email_automated_hint({ n: String(e.opens.automated) })}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{m.updates_email_clickers()}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{e.clicks.uniqueHuman}</dd>
            <dd className="text-xs text-muted-foreground">
              {m.updates_email_clicks_total({
                n: String(e.clicks.human),
                automated: String(e.clicks.automated),
              })}
            </dd>
          </div>
        </dl>
        {e.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.updates_email_links_empty()}</p>
        ) : (
          <Table aria-label={m.updates_email_links()}>
            <TableHeader>
              <TableRow>
                <TableHead>{m.updates_email_col_link()}</TableHead>
                <TableHead>{m.updates_email_col_clicks()}</TableHead>
                <TableHead>{m.updates_email_col_clickers()}</TableHead>
                <TableHead>{m.updates_email_col_automated()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {e.links.map((l) => (
                <TableRow key={l.link ?? "unknown"}>
                  <TableCell className="max-w-xs truncate">
                    {l.link ?? m.updates_email_link_unknown()}
                  </TableCell>
                  <TableCell className="tabular-nums">{l.clicks}</TableCell>
                  <TableCell className="tabular-nums">{l.uniqueClickers}</TableCell>
                  <TableCell className="tabular-nums">{l.automatedClicks}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ThreadsCard({ postId }: { postId: string }) {
  const threads = useQuery(updateThreadsQuery(postId));
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const reply = useGuardedMutation({
    mutationFn: (input: { threadMembershipId: string; body: string }) =>
      call(
        api().POST("/updates/posts/{id}/replies", {
          params: { path: { id: postId } },
          body: input,
        }),
      ),
    onSuccess: (_r, input) => {
      setDrafts((d) => ({ ...d, [input.threadMembershipId]: "" }));
      void queryClient.invalidateQueries({ queryKey: updateThreadsQuery(postId).queryKey });
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_replies_title()}</CardTitle>
        <CardDescription>{m.updates_replies_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {threads.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {threads.isError ? <ErrorAlert error={threads.error} /> : null}
        {threads.data && threads.data.threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.updates_replies_empty()}</p>
        ) : null}
        {threads.data?.threads.map((t) => (
          <section key={t.membershipId} aria-label={t.displayName} className="space-y-3">
            <h3 className="font-medium">{t.displayName}</h3>
            <ol className="space-y-2">
              {t.replies.map((r) => (
                <li
                  key={r.id}
                  className={
                    r.authorKind === "staff"
                      ? "rounded-md bg-accent p-3 text-sm"
                      : "rounded-md border p-3 text-sm"
                  }
                >
                  <div className="mb-1 text-xs text-muted-foreground">
                    {r.authorName} · {formatDateTime(r.createdAt)}
                  </div>
                  <p className="whitespace-pre-wrap">{r.body}</p>
                </li>
              ))}
            </ol>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const body = (drafts[t.membershipId] ?? "").trim();
                if (body) reply.mutate({ threadMembershipId: t.membershipId, body });
              }}
            >
              <Textarea
                aria-label={m.updates_reply_to({ name: t.displayName })}
                rows={2}
                maxLength={5000}
                value={drafts[t.membershipId] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.membershipId]: e.target.value }))}
              />
              <div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={reply.isPending || !(drafts[t.membershipId] ?? "").trim()}
                >
                  {m.updates_reply()}
                </Button>
              </div>
            </form>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

// --- settings + sending domain -------------------------------------------------------------------

function SettingsScreen({ canSettings }: { canSettings: boolean }) {
  if (!canSettings) return <ErrorAlert error={new Error(m.updates_settings_forbidden())} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.updates_settings_title()}
        description={m.updates_settings_subtitle()}
        actions={
          <Button asChild variant="ghost">
            <Link to="/admin/$" params={{ _splat: "updates" }}>
              {m.updates_back_to_list()}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <SenderSettingsCard />
        <SendingDomainCard />
      </div>
    </div>
  );
}

function SenderSettingsCard() {
  const settings = useQuery(updatesSettingsQuery);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<
    | {
        fromName: string;
        fromLocalPart: string;
        replyTo: string;
        postalAddress: string;
        footerNote: string;
      }
    | undefined
  >(undefined);
  const ids = {
    fromName: useId(),
    local: useId(),
    replyTo: useId(),
    postal: useId(),
    footer: useId(),
  };
  useEffect(() => {
    if (settings.data && form === undefined) {
      setForm({
        fromName: settings.data.fromName ?? "",
        fromLocalPart: settings.data.fromLocalPart,
        replyTo: settings.data.replyTo ?? "",
        postalAddress: settings.data.postalAddress ?? "",
        footerNote: settings.data.footerNote ?? "",
      });
    }
  }, [settings.data, form]);
  const save = useGuardedMutation({
    mutationFn: () => {
      if (!form) throw new Error("not loaded");
      return call(
        api().PATCH("/updates/settings", {
          body: {
            fromName: form.fromName.trim() || null,
            fromLocalPart: form.fromLocalPart.trim() || "updates",
            replyTo: form.replyTo.trim() || null,
            postalAddress: form.postalAddress.trim() || null,
            footerNote: form.footerNote.trim() || null,
          },
        }),
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(updatesSettingsQuery.queryKey, data);
      toast.success(m.updates_settings_saved());
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  if (settings.isPending || form === undefined) return <LoadingState label={m.common_loading()} />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_sender_title()}</CardTitle>
        <CardDescription>{m.updates_sender_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field
            id={ids.fromName}
            label={m.updates_from_name()}
            description={m.updates_from_name_help()}
          >
            <Input
              id={ids.fromName}
              value={form.fromName}
              maxLength={120}
              onChange={set("fromName")}
            />
          </Field>
          <Field
            id={ids.local}
            label={m.updates_from_local()}
            description={m.updates_from_local_help()}
          >
            <Input id={ids.local} value={form.fromLocalPart} onChange={set("fromLocalPart")} />
          </Field>
          <Field
            id={ids.replyTo}
            label={m.updates_reply_to_addr()}
            description={m.updates_reply_to_help()}
          >
            <Input id={ids.replyTo} type="email" value={form.replyTo} onChange={set("replyTo")} />
          </Field>
          <Field id={ids.postal} label={m.updates_postal()} description={m.updates_postal_help()}>
            <Input
              id={ids.postal}
              value={form.postalAddress}
              maxLength={300}
              onChange={set("postalAddress")}
            />
          </Field>
          <Field id={ids.footer} label={m.updates_footer()} description={m.updates_footer_help()}>
            <Textarea
              id={ids.footer}
              rows={3}
              value={form.footerNote}
              maxLength={1000}
              onChange={set("footerNote")}
            />
          </Field>
          <Button type="submit" disabled={save.isPending}>
            {m.common_save()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function domainStatusLabel(s: SendingDomain["status"]): string {
  switch (s) {
    case "verified":
      return m.updates_domain_verified();
    case "failed":
      return m.updates_domain_failed();
    default:
      return m.updates_domain_pending();
  }
}

function SendingDomainCard() {
  const q = useQuery(sendingDomainQuery);
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const id = useId();
  const setQ = (d: SendingDomain | null) =>
    queryClient.setQueryData(sendingDomainQuery.queryKey, { domain: d });
  const set = useGuardedMutation({
    mutationFn: () =>
      call(api().PUT("/updates/sending-domain", { body: { domain: domain.trim() } })),
    onSuccess: (d) => {
      setQ(d);
      setDomain("");
      toast.success(m.updates_domain_set());
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  const verify = useGuardedMutation({
    mutationFn: () => call(api().POST("/updates/sending-domain/verify")),
    onSuccess: (d) => {
      setQ(d);
      toast[d.status === "verified" ? "success" : "info"](
        d.status === "verified" ? m.updates_domain_verified() : m.updates_domain_not_yet(),
      );
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  const remove = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/updates/sending-domain")),
    onSuccess: () => {
      setQ(null);
      toast.success(m.updates_domain_removed());
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  if (q.isPending) return <LoadingState label={m.common_loading()} />;
  if (q.isError) return <ErrorAlert error={q.error} />;
  const d = q.data.domain;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_domain_title()}</CardTitle>
        <CardDescription>{m.updates_domain_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {d ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{d.domain}</span>
              <Badge
                variant={
                  d.status === "verified"
                    ? "default"
                    : d.status === "failed"
                      ? "destructive"
                      : "warning"
                }
              >
                {domainStatusLabel(d.status)}
              </Badge>
              {d.lastCheckedAt ? (
                <span className="text-xs text-muted-foreground">
                  {m.updates_domain_checked({ when: formatDateTime(d.lastCheckedAt) })}
                </span>
              ) : null}
            </div>
            {d.lastError ? <ErrorAlert error={new Error(d.lastError)} /> : null}
            <Table aria-label={m.updates_domain_records()}>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.updates_rec_type()}</TableHead>
                  <TableHead>{m.updates_rec_name()}</TableHead>
                  <TableHead>{m.updates_rec_value()}</TableHead>
                  <TableHead>{m.updates_rec_status()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.records.map((r) => {
                  const check = d.checks[r.kind];
                  return (
                    <TableRow key={r.kind}>
                      <TableCell>
                        {r.type}{" "}
                        <span className="text-xs uppercase text-muted-foreground">{r.kind}</span>
                        {!r.required ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.updates_rec_optional()}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs break-all">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs break-all">{r.value}</TableCell>
                      <TableCell>
                        {check === undefined
                          ? m.updates_rec_unchecked()
                          : check.ok
                            ? m.updates_rec_ok()
                            : m.updates_rec_missing()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex gap-2">
              <Button type="button" disabled={verify.isPending} onClick={() => verify.mutate()}>
                {m.updates_domain_verify()}
              </Button>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" disabled={remove.isPending}>
                    {m.updates_domain_remove()}
                  </Button>
                }
                title={m.updates_domain_remove()}
                description={m.updates_domain_remove_body()}
                confirmLabel={m.updates_domain_remove()}
                onConfirm={() => remove.mutate()}
                pending={remove.isPending}
              />
            </div>
          </>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              set.mutate();
            }}
          >
            <Field
              id={id}
              label={m.updates_domain_field()}
              description={m.updates_domain_field_help()}
              className="flex-1"
            >
              <Input
                id={id}
                value={domain}
                placeholder="mail.example.com"
                onChange={(e) => setDomain(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={set.isPending || !domain.trim()}>
              {m.updates_domain_add()}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
