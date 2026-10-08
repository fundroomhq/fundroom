import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  LoadingState,
  PageHeader,
  Switch,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Megaphone } from "lucide-react";
import { useId, useState } from "react";
import { BlockView } from "../../components/content/page-renderer.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, describeError } from "../../lib/api.js";
import { formatDate, formatDateTime } from "../../lib/format.js";
import { useMe } from "../../lib/queries.js";
import {
  updateArchivePageQuery,
  updateArchiveQuery,
  updateThreadsQuery,
} from "../../lib/updates-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * Investor updates, reader side (E1.4): `/updates` is the archive of sent updates this
 * member may read (plus the email opt-out switch), `/updates/<slug>` renders one update as
 * the server filtered it for this reader, with the member's private reply thread.
 */
export default function UpdatesInvestor({ splat }: ModulePageProps) {
  const [slug] = splat.split("/").filter(Boolean);
  if (slug) return <ArchivePage slug={slug} />;
  return <ArchiveList />;
}

function ArchiveList() {
  const archive = useQuery(updateArchiveQuery);
  const queryClient = useQueryClient();
  const switchId = useId();
  const me = useMe();
  const isStaff = me.data?.membership?.kind === "staff";
  const subscription = useGuardedMutation({
    mutationFn: (subscribed: boolean) =>
      call(api().PUT("/updates/subscription", { body: { subscribed } })),
    onSuccess: (r) => {
      queryClient.setQueryData(updateArchiveQuery.queryKey, (old) =>
        old ? { ...old, subscribed: r.subscribed } : old,
      );
      toast.success(r.subscribed ? m.updates_subscribed_toast() : m.updates_unsubscribed_toast());
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  if (archive.isPending) return <LoadingState label={m.common_loading()} />;
  if (archive.isError) return <ErrorAlert error={archive.error} />;
  return (
    <div className="space-y-6">
      <PageHeader title={m.updates_title()} description={m.updates_subtitle()} />
      {archive.data.posts.length === 0 ? (
        <EmptyState
          icon={<Megaphone aria-hidden="true" />}
          title={m.updates_empty_title()}
          description={m.updates_empty_body()}
        />
      ) : (
        <ul className="space-y-3">
          {archive.data.posts.map((p) => (
            <li key={p.id}>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <Link
                      to="/$"
                      params={{ _splat: `updates/${p.slug}` }}
                      className="hover:underline"
                    >
                      {p.title}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {p.sentAt ? formatDate(p.sentAt) : m.updates_state_sent()}
                  </CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {!isStaff ? (
        <Card>
          <CardHeader>
            <CardTitle>{m.updates_email_pref_title()}</CardTitle>
            <CardDescription>{m.updates_email_pref_body()}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Switch
                id={switchId}
                checked={archive.data.subscribed}
                disabled={subscription.isPending}
                onCheckedChange={(v) => subscription.mutate(v)}
              />
              <Label htmlFor={switchId}>{m.updates_email_pref_switch()}</Label>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ArchivePage({ slug }: { slug: string }) {
  const page = useQuery(updateArchivePageQuery(slug));
  if (page.isPending) return <LoadingState label={m.common_loading()} />;
  if (page.isError) return <ErrorAlert error={page.error} />;
  const p = page.data;
  return (
    <article className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/$" params={{ _splat: "updates" }}>
            {m.updates_back()}
          </Link>
        </Button>
      </div>
      <PageHeader
        title={p.post.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {p.post.sentAt ? <span>{formatDateTime(p.post.sentAt)}</span> : null}
            {p.viewer === "staff" ? (
              <Badge variant="outline">{m.updates_staff_view()}</Badge>
            ) : null}
          </span>
        }
      />
      <div className="space-y-10">
        {p.sections.map((section) => {
          const headingId = `section-${section.key}`;
          return (
            <section
              key={section.key}
              aria-labelledby={section.title ? headingId : undefined}
              data-section={section.key}
            >
              {section.title ? (
                <h2 id={headingId} className="mb-4 text-xl font-semibold tracking-tight">
                  {section.title}
                </h2>
              ) : null}
              <div className="space-y-6">
                {section.blocks.map((block) => (
                  <BlockView key={block.id} block={block} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <ReplyThread postId={p.post.id} staff={p.viewer === "staff"} />
    </article>
  );
}

function ReplyThread({ postId, staff }: { postId: string; staff: boolean }) {
  const threads = useQuery({ ...updateThreadsQuery(postId), enabled: !staff });
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const id = useId();
  const reply = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/updates/posts/{id}/replies", {
          params: { path: { id: postId } },
          body: { body: body.trim() },
        }),
      ),
    onSuccess: () => {
      setBody("");
      toast.success(m.updates_reply_sent());
      void queryClient.invalidateQueries({ queryKey: updateThreadsQuery(postId).queryKey });
    },
    onError: (error) => toast.error(describeError(error).body),
  });
  if (staff) return null;
  const mine = threads.data?.threads[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.updates_reply_title()}</CardTitle>
        <CardDescription>{m.updates_reply_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {threads.isError ? <ErrorAlert error={threads.error} /> : null}
        {mine && mine.replies.length > 0 ? (
          <ol className="space-y-2">
            {mine.replies.map((r) => (
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
        ) : null}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) reply.mutate();
          }}
        >
          <Label htmlFor={id}>{m.updates_reply_label()}</Label>
          <Textarea
            id={id}
            rows={3}
            maxLength={5000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button type="submit" disabled={reply.isPending || !body.trim()}>
            {m.updates_reply()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
