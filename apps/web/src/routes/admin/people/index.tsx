import {
  Badge,
  Button,
  Input,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  ConfirmDialog,
  personName,
  roleLabel,
  StatusBadge,
} from "../../../components/access/common.js";
import { CsvImportDialog } from "../../../components/access/csv-import-dialog.js";
import { InviteDialog } from "../../../components/access/invite-dialog.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import { invitesQuery, peopleQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/people/")({ component: PeoplePage });

/** People (design/05 §6): external / staff tabs with search, plus pending invitations. */
function PeoplePage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const canManage = permissions.includes("access.manage");
  const canManageStaff = permissions.includes("access.manage_staff");
  const [q, setQ] = useState("");
  const searchId = useId();
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.people_title()}
        description={m.people_subtitle()}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <CsvImportDialog />
              <InviteDialog canInviteStaff={canManageStaff} />
            </div>
          ) : undefined
        }
      />
      <div className="max-w-sm">
        <label htmlFor={searchId} className="sr-only">
          {m.people_search()}
        </label>
        <Input
          id={searchId}
          type="search"
          placeholder={m.people_search()}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Tabs defaultValue="external">
        <TabsList aria-label={m.people_tabs()}>
          <TabsTrigger value="external">{m.people_tab_external()}</TabsTrigger>
          <TabsTrigger value="staff">{m.people_tab_staff()}</TabsTrigger>
          <TabsTrigger value="invites">{m.people_tab_invites()}</TabsTrigger>
        </TabsList>
        <TabsContent value="external">
          <PeopleTable kind="external" q={q} />
        </TabsContent>
        <TabsContent value="staff">
          <PeopleTable kind="staff" q={q} />
        </TabsContent>
        <TabsContent value="invites">
          <InvitesTable canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PeopleTable({ kind, q }: { kind: "staff" | "external"; q: string }) {
  const people = useQuery(peopleQuery({ kind, q: q.trim() || undefined }));
  if (people.isPending) return <LoadingState lines={4} label={m.common_loading()} />;
  if (people.isError) return <ErrorAlert error={people.error} />;
  if (people.data.items.length === 0)
    return <p className="py-6 text-sm text-muted-foreground">{m.people_empty()}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.people_col_name()}</TableHead>
          <TableHead>{m.people_col_role()}</TableHead>
          <TableHead>{m.people_col_groups()}</TableHead>
          <TableHead>{m.people_col_status()}</TableHead>
          <TableHead>{m.people_col_last_seen()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.data.items.map((p) => (
          <TableRow key={p.membershipId}>
            <TableCell>
              <Link
                to="/admin/people/$membershipId"
                params={{ membershipId: p.membershipId }}
                className="font-medium underline-offset-4 hover:underline"
              >
                {personName(p)}
              </Link>
              <div className="text-xs text-muted-foreground">
                {p.email}
                {typeof p.profile["firm"] === "string" ? ` · ${p.profile["firm"]}` : ""}
              </div>
            </TableCell>
            <TableCell>{roleLabel(p.role)}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {p.groups.map((g) => (
                  <Badge key={g.id} variant="outline">
                    {g.name}
                  </Badge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <StatusBadge status={p.status} />
            </TableCell>
            <TableCell>{p.lastSeenAt ? formatDateTime(p.lastSeenAt) : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function InvitesTable({ canManage }: { canManage: boolean }) {
  const invites = useQuery(invitesQuery("pending"));
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["access", "invites"] });
  const resend = useGuardedMutation<unknown, string>({
    mutationFn: (id) =>
      call(api().POST("/access/invites/{id}/resend", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.invite_resent());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const revoke = useGuardedMutation<unknown, string>({
    mutationFn: (id) => call(api().DELETE("/access/invites/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.invite_revoked());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  if (invites.isPending) return <LoadingState lines={3} label={m.common_loading()} />;
  if (invites.isError) return <ErrorAlert error={invites.error} />;
  if (invites.data.invites.length === 0)
    return <p className="py-6 text-sm text-muted-foreground">{m.invites_empty()}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.invites_col_email()}</TableHead>
          <TableHead>{m.people_col_role()}</TableHead>
          <TableHead>{m.invites_col_expires()}</TableHead>
          <TableHead className="sr-only">{m.common_actions()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invites.data.invites.map((i) => (
          <TableRow key={i.id}>
            <TableCell>{i.email}</TableCell>
            <TableCell>{roleLabel(i.role)}</TableCell>
            <TableCell>{formatDate(i.expiresAt)}</TableCell>
            <TableCell className="text-right">
              {canManage ? (
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={resend.isPending && resend.variables === i.id}
                    onClick={() => resend.mutate(i.id)}
                  >
                    {m.invite_resend()}
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button type="button" variant="ghost" size="sm">
                        {m.invite_revoke()}
                      </Button>
                    }
                    title={m.invite_revoke_title({ email: i.email })}
                    description={m.invite_revoke_body()}
                    confirmLabel={m.invite_revoke()}
                    pending={revoke.isPending}
                    onConfirm={() => revoke.mutate(i.id)}
                  />
                </div>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
