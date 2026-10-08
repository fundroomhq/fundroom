import {
  Badge,
  Button,
  Checkbox,
  Label,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MailCheck, MessageSquare, Settings } from "lucide-react";
import { useId, useState } from "react";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { type NotifyInboxItem, notifyInboxQuery } from "../../lib/notify-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { eventLabel } from "./labels.js";

/**
 * The newest `createdAt` the screen is showing. "Mark all as read" sends it as `upTo`, so a
 * notification that arrived after the list was drawn stays unread — a founder never dismisses an
 * alert they did not see. It is the server's own timestamp, so a skewed browser clock cannot
 * widen the window. `undefined` (nothing loaded) lets the server use "now".
 */
function newestShown(items: readonly NotifyInboxItem[]): string | undefined {
  let newest: string | undefined;
  for (const item of items) {
    if (newest === undefined || Date.parse(item.createdAt) > Date.parse(newest)) {
      newest = item.createdAt;
    }
  }
  return newest;
}

export function InboxScreen({ canManageChannels }: { canManageChannels: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedId = useId();
  const inbox = useInfiniteQuery(notifyInboxQuery({ archived: showArchived }));
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["notify", "inbox"] });
  const markRead = useGuardedMutation({
    mutationFn: (ids: string[]) => call(api().POST("/notify/inbox/read", { body: { ids } })),
    onSuccess: refresh,
  });
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  const markAll = useGuardedMutation({
    mutationFn: () => {
      const upTo = newestShown(items);
      return call(
        api().POST("/notify/inbox/read-all", { body: upTo === undefined ? {} : { upTo } }),
      );
    },
    onSuccess: refresh,
  });
  const archive = useGuardedMutation({
    mutationFn: (v: { id: string; archived: boolean }) =>
      call(api().POST("/notify/inbox/archive", { body: { ids: [v.id], archived: v.archived } })),
    onSuccess: refresh,
  });
  // `unread` is the member's whole count, the same on every page; the first page is freshest.
  const unread = inbox.data?.pages[0]?.unread ?? 0;
  const mutationError = markRead.error ?? markAll.error ?? archive.error;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.notify_admin_title()}
        description={m.notify_admin_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManageChannels ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "notify/channels" }}>
                  <MessageSquare aria-hidden="true" />
                  {m.notify_channels_link()}
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: "notify/preferences" }}>
                <Settings aria-hidden="true" />
                {m.notify_preferences_link()}
              </Link>
            </Button>
            <Button
              type="button"
              disabled={unread === 0}
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <MailCheck aria-hidden="true" />
              {m.notify_mark_all_read()}
            </Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p aria-live="polite" className="text-sm">
          {m.notify_unread_count({ n: String(unread) })}
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id={archivedId}
            checked={showArchived}
            onCheckedChange={(on) => setShowArchived(on === true)}
          />
          <Label htmlFor={archivedId}>{m.notify_show_archived()}</Label>
        </div>
      </div>
      {inbox.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {inbox.isError ? <ErrorAlert error={inbox.error} /> : null}
      {mutationError ? <ErrorAlert error={mutationError} /> : null}
      {inbox.data ? (
        items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.notify_inbox_empty()}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.notify_col_when()}</TableHead>
                  <TableHead>{m.notify_col_what()}</TableHead>
                  <TableHead>{m.notify_col_who()}</TableHead>
                  <TableHead>{m.notify_col_status()}</TableHead>
                  <TableHead>{m.common_actions()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{formatDateTime(item.createdAt)}</TableCell>
                    <TableCell>
                      {item.eventType === "access_request.submitted" ? (
                        <Link
                          to="/admin/access-requests"
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : item.eventType === "access_review.overdue" ? (
                        <Link
                          to="/admin/access-review"
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : item.eventType === "integration.connection_unhealthy" ? (
                        <Link
                          to="/admin/integrations"
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : item.eventType === "esign.envelope_attention" ? (
                        <Link
                          to="/admin/esign"
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : item.eventType === "round.signature_completed" &&
                        typeof item.payload["roundId"] === "string" ? (
                        <Link
                          to="/admin/$"
                          params={{ _splat: `round/rounds/${item.payload["roundId"]}/closing` }}
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : item.eventType.startsWith("qa.") && item.resourceId !== null ? (
                        <Link
                          to="/admin/$"
                          params={{ _splat: `data-room/questions/${item.resourceId}` }}
                          className="font-medium underline underline-offset-4"
                        >
                          {eventLabel(item.eventType)}
                        </Link>
                      ) : (
                        eventLabel(item.eventType)
                      )}
                    </TableCell>
                    <TableCell>
                      {item.eventType === "access_review.overdue" ||
                      item.eventType === "qa.question_due" ||
                      item.eventType === "esign.envelope_attention" ||
                      item.eventType === "integration.connection_unhealthy"
                        ? m.notify_actor_system()
                        : item.eventType.startsWith("qa.") && item.actor === null
                          ? m.notify_actor_qa()
                          : (item.actor?.displayName ??
                            item.subjectName ??
                            m.notify_actor_unknown())}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {item.readAt === null ? (
                          <Badge variant="warning">{m.notify_unread()}</Badge>
                        ) : (
                          <Badge variant="outline">{m.notify_read()}</Badge>
                        )}
                        {item.archivedAt === null ? null : (
                          <Badge variant="secondary">{m.notify_archived()}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {item.readAt === null ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => markRead.mutate([item.id])}
                          >
                            {m.notify_mark_read()}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            archive.mutate({ id: item.id, archived: item.archivedAt === null })
                          }
                        >
                          {item.archivedAt === null ? m.notify_archive() : m.notify_unarchive()}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {inbox.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={inbox.isFetchingNextPage}
                onClick={() => void inbox.fetchNextPage()}
              >
                {m.common_load_more()}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
