import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { formatDate } from "../../../lib/format.js";
import { groupsQuery, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/groups/")({ component: GroupsPage });

export const GROUP_KINDS = ["custom", "round", "board", "advisors"] as const;

export function groupKindLabel(kind: string): string {
  switch (kind) {
    case "round":
      return m.group_kind_round();
    case "board":
      return m.group_kind_board();
    case "advisors":
      return m.group_kind_advisors();
    default:
      return m.group_kind_custom();
  }
}

/** Groups (design/05 §4.3): audiences that grants, policies and updates target. */
function GroupsPage() {
  const groups = useQuery(groupsQuery);
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("access.manage");
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.groups_title()}
        description={m.groups_subtitle()}
        actions={canManage ? <CreateGroupDialog /> : undefined}
      />
      {groups.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {groups.isError ? <ErrorAlert error={groups.error} /> : null}
      {groups.data ? (
        groups.data.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.groups_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.common_name()}</TableHead>
                <TableHead>{m.groups_col_kind()}</TableHead>
                <TableHead>{m.groups_col_members()}</TableHead>
                <TableHead>{m.groups_col_created()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.data.groups.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <Link
                      to="/admin/groups/$groupId"
                      params={{ groupId: g.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {g.name}
                    </Link>
                  </TableCell>
                  <TableCell>{groupKindLabel(g.kind)}</TableCell>
                  <TableCell>{String(g.memberCount)}</TableCell>
                  <TableCell>{formatDate(g.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}

function CreateGroupDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof GROUP_KINDS)[number]>("custom");
  const ids = { name: useId(), kind: useId() };
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () => call(api().POST("/access/groups", { body: { name: name.trim(), kind } })),
    onSuccess: () => {
      toast.success(m.group_created());
      setOpen(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {m.group_new()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.group_new()}</DialogTitle>
            <DialogDescription>{m.group_new_body()}</DialogDescription>
          </DialogHeader>
          <Field id={ids.name} label={m.common_name()} required>
            <Input
              id={ids.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </Field>
          <Field id={ids.kind} label={m.groups_col_kind()}>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger id={ids.kind}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUP_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {groupKindLabel(k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {m.group_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
