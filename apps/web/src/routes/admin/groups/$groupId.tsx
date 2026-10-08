import {
  Button,
  Checkbox,
  Dialog,
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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, UserPlus } from "lucide-react";
import { useState } from "react";
import {
  ConfirmDialog,
  personName,
  roleLabel,
  StatusBadge,
} from "../../../components/access/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { groupQuery, peopleQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { groupKindLabel } from "./index.js";

export const Route = createFileRoute("/admin/groups/$groupId")({ component: GroupPage });

function GroupPage() {
  const { groupId } = Route.useParams();
  const group = useQuery(groupQuery(groupId));
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("access.manage");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["access"] });
  const remove = useGuardedMutation<unknown, string>({
    mutationFn: (membershipId) =>
      call(
        api().DELETE("/access/groups/{id}/members/{membershipId}", {
          params: { path: { id: groupId, membershipId } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.group_member_removed());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const del = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/access/groups/{id}", { params: { path: { id: groupId } } })),
    onSuccess: (r) => {
      toast.success(m.group_deleted({ grants: r.grants }));
      invalidate();
      void navigate({ to: "/admin/groups" });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  if (group.isPending) return <LoadingState label={m.common_loading()} />;
  if (group.isError) return <ErrorAlert error={group.error} />;
  const g = group.data.group;
  const memberIds = new Set(group.data.members.map((p) => p.membershipId));
  return (
    <div className="space-y-6">
      <PageHeader
        title={g.name}
        description={m.group_detail_subtitle({
          kind: groupKindLabel(g.kind),
          count: g.memberCount,
        })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/groups">
                <ArrowLeft aria-hidden="true" />
                {m.groups_back()}
              </Link>
            </Button>
            {canManage ? (
              <>
                <AddMembersDialog groupId={groupId} exclude={memberIds} onDone={invalidate} />
                <ConfirmDialog
                  trigger={
                    <Button type="button" variant="destructive">
                      {m.group_delete()}
                    </Button>
                  }
                  title={m.group_delete_title({ name: g.name })}
                  description={m.group_delete_body({ count: g.memberCount })}
                  confirmLabel={m.group_delete()}
                  pending={del.isPending}
                  onConfirm={() => del.mutate()}
                />
              </>
            ) : null}
          </div>
        }
      />
      {group.data.members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.group_no_members()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.people_col_name()}</TableHead>
              <TableHead>{m.people_col_role()}</TableHead>
              <TableHead>{m.people_col_status()}</TableHead>
              <TableHead className="sr-only">{m.common_actions()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.data.members.map((p) => (
              <TableRow key={p.membershipId}>
                <TableCell>
                  <Link to="/admin/people/$membershipId" params={{ membershipId: p.membershipId }}>
                    {personName(p)}
                  </Link>
                  <div className="text-xs text-muted-foreground">{p.email}</div>
                </TableCell>
                <TableCell>{roleLabel(p.role)}</TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={remove.isPending && remove.variables === p.membershipId}
                      onClick={() => remove.mutate(p.membershipId)}
                    >
                      {m.common_remove()}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function AddMembersDialog({
  groupId,
  exclude,
  onDone,
}: {
  groupId: string;
  exclude: Set<string>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const people = useQuery({ ...peopleQuery({ status: "active,dormant,invited" }), enabled: open });
  const add = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/access/groups/{id}/members", {
          params: { path: { id: groupId } },
          body: { membershipIds: selected },
        }),
      ),
    onSuccess: (r) => {
      toast.success(m.group_members_added({ count: r.added }));
      setSelected([]);
      setOpen(false);
      onDone();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const candidates = (people.data?.items ?? []).filter((p) => !exclude.has(p.membershipId));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <UserPlus aria-hidden="true" />
          {m.group_add_members()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected.length > 0) add.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.group_add_members()}</DialogTitle>
            <DialogDescription>{m.group_add_members_body()}</DialogDescription>
          </DialogHeader>
          {people.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
          {people.isError ? <ErrorAlert error={people.error} /> : null}
          {people.data ? (
            candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.group_no_candidates()}</p>
            ) : (
              <fieldset className="max-h-72 space-y-2 overflow-y-auto">
                <legend className="sr-only">{m.people_title()}</legend>
                {candidates.map((p) => {
                  const id = `add-member-${p.membershipId}`;
                  return (
                    <div key={p.membershipId} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={selected.includes(p.membershipId)}
                        onCheckedChange={(on) =>
                          setSelected((cur) =>
                            on === true
                              ? [...cur, p.membershipId]
                              : cur.filter((x) => x !== p.membershipId),
                          )
                        }
                      />
                      <Label htmlFor={id}>
                        {personName(p)}
                        <span className="ml-2 text-xs text-muted-foreground">{p.email}</span>
                      </Label>
                    </div>
                  );
                })}
              </fieldset>
            )
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" loading={add.isPending} disabled={selected.length === 0}>
              {m.group_add_selected({ count: String(selected.length) })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
