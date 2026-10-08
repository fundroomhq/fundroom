import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  LoadingState,
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
import { useNavigate } from "@tanstack/react-router";
import { Eye } from "lucide-react";
import { useId, useState } from "react";
import {
  callNoContent,
  type MemberSession,
  memberSessionsQuery,
} from "../../lib/access-admin-queries.js";
import { api, call, describeError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { resetForViewAs } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { ConfirmDialog } from "./common.js";

/*
 * A member's sessions in this workspace (E2.7). The server lists only sessions whose last
 * workspace is this one: a session the same person uses in another workspace is that tenant's
 * fact, and the card says so rather than pretending the list is everything. Both revocations
 * are `fresh` routes, so `useGuardedMutation` sends a stale session through step-up and back.
 */
export function MemberSessionsCard({
  membershipId,
  name,
  canAct,
}: {
  membershipId: string;
  name: string;
  /** `access.manage` (and the target rules: staff need `manage_staff`, owners need an owner). */
  canAct: boolean;
}) {
  const sessions = useQuery(memberSessionsQuery(membershipId));
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: memberSessionsQuery(membershipId).queryKey });
  const revokeAll = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/access/people/{id}/sessions/revoke", {
          params: { path: { id: membershipId } },
        }),
      ),
    onSuccess: (out) => {
      toast.success(m.member_sessions_revoked_all({ count: out.revoked }));
      refresh();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const items = sessions.data?.sessions ?? [];
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>{m.member_sessions_title()}</CardTitle>
        <CardDescription>{m.member_sessions_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessions.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {sessions.isError ? <ErrorAlert error={sessions.error} /> : null}
        {sessions.data && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.member_sessions_empty()}</p>
        ) : null}
        {items.length > 0 ? (
          // Focusable so a keyboard user can scroll the table sideways (axe scrollable-region-focusable).
          <section
            className="overflow-x-auto"
            aria-label={m.member_sessions_title()}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
            tabIndex={0}
          >
            <Table aria-label={m.member_sessions_title()}>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.member_sessions_col_device()}</TableHead>
                  <TableHead>{m.member_sessions_col_ip()}</TableHead>
                  <TableHead>{m.member_sessions_col_created()}</TableHead>
                  <TableHead>{m.member_sessions_col_last_seen()}</TableHead>
                  <TableHead>{m.member_sessions_col_expires()}</TableHead>
                  {canAct ? (
                    <TableHead>
                      <span className="sr-only">{m.common_actions()}</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <SessionRow
                    key={s.id}
                    membershipId={membershipId}
                    session={s}
                    canAct={canAct}
                    onRevoked={refresh}
                  />
                ))}
              </TableBody>
            </Table>
          </section>
        ) : null}
        <p className="text-xs text-muted-foreground">{m.member_sessions_scope_note()}</p>
        {canAct && items.length > 0 ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline">
                {m.member_sessions_revoke_all()}
              </Button>
            }
            title={m.member_sessions_revoke_all_title({ name })}
            description={m.member_sessions_revoke_all_body()}
            confirmLabel={m.member_sessions_revoke_all()}
            pending={revokeAll.isPending}
            onConfirm={() => revokeAll.mutate()}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function SessionRow({
  membershipId,
  session: s,
  canAct,
  onRevoked,
}: {
  membershipId: string;
  session: MemberSession;
  canAct: boolean;
  onRevoked: () => void;
}) {
  const revoke = useGuardedMutation({
    mutationFn: () =>
      callNoContent(
        api().DELETE("/access/people/{id}/sessions/{sessionId}", {
          params: { path: { id: membershipId, sessionId: s.id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.member_sessions_revoked());
      onRevoked();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const device = s.deviceName ?? s.device;
  return (
    <TableRow>
      <TableCell className="font-medium">
        {device}
        {s.deviceName !== null ? (
          <span className="block text-xs font-normal text-muted-foreground">{s.device}</span>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">{s.ip ?? "—"}</TableCell>
      <TableCell>{formatDateTime(s.createdAt)}</TableCell>
      <TableCell>{formatDateTime(s.lastSeenAt)}</TableCell>
      <TableCell>
        {formatDateTime(
          s.idleExpiresAt < s.absoluteExpiresAt ? s.idleExpiresAt : s.absoluteExpiresAt,
        )}
      </TableCell>
      {canAct ? (
        <TableCell>
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={m.member_sessions_revoke_named({ device })}
              >
                {m.member_sessions_revoke()}
              </Button>
            }
            title={m.member_sessions_revoke_title({ device })}
            description={m.member_sessions_revoke_body()}
            confirmLabel={m.member_sessions_revoke()}
            pending={revoke.isPending}
            onConfirm={() => revoke.mutate()}
          />
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/**
 * "View as investor" (E2.7): staff with `access.manage` see the portal exactly as one active
 * external member does, read-only, for 30 minutes. The reason is required and goes into the
 * audit trail. Starting it is a `fresh` route. On success every cached answer is the staff
 * member's and about to be wrong, so the cache is reset before landing on the portal home.
 */
export function ViewAsButton({ membershipId, name }: { membershipId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const id = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const trimmed = reason.trim();
  const start = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/access/people/{id}/view-as", {
          params: { path: { id: membershipId } },
          body: { reason: trimmed },
        }),
      ),
    onSuccess: async () => {
      setOpen(false);
      await resetForViewAs(queryClient);
      await navigate({ to: "/" });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Eye aria-hidden="true" />
          {m.view_as_start()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed.length >= 3) start.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.view_as_dialog_title({ name })}</DialogTitle>
            <DialogDescription>{m.view_as_dialog_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.view_as_reason()} description={m.view_as_reason_hint()}>
            <Textarea
              id={id}
              value={reason}
              minLength={3}
              maxLength={500}
              required
              aria-describedby={`${id}-description`}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={start.isPending} disabled={trimmed.length < 3}>
              {m.view_as_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
