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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api, call, describeError } from "../../lib/api.js";
import { groupsQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { roleLabel } from "./common.js";
import { GroupPicker } from "./group-picker.js";

const STAFF_ROLES = ["admin", "editor", "viewer", "finance", "legal"] as const;

/** "Invite people": one email per line, kind/role, groups, message (§13.1). */
export function InviteDialog({
  canInviteStaff,
  onDone,
}: {
  canInviteStaff: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState("");
  const [kind, setKind] = useState<"staff" | "external">("external");
  const [role, setRole] = useState<string>("investor");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{
    created: number;
    failed: { email: string; code: string }[];
  }>();
  const ids = { emails: useId(), kind: useId(), role: useId(), message: useId() };
  const groups = useQuery({ ...groupsQuery, enabled: open });
  const queryClient = useQueryClient();

  const invite = useGuardedMutation({
    mutationFn: (list: { email: string }[]) =>
      call(
        api().POST("/access/invites", {
          body: {
            invites: list,
            kind,
            role: role as "investor",
            groupIds,
            grants: [],
            ...(message.trim() ? { message: message.trim() } : {}),
          },
        }),
      ),
    onSuccess: (r) => {
      setResult({ created: r.created.length, failed: r.failed });
      void queryClient.invalidateQueries({ queryKey: ["access"] });
      if (r.created.length > 0) toast.success(m.invite_sent({ count: r.created.length }));
      onDone?.();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = emails
      .split(/[\n,;]+/u)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
    if (list.length === 0) return;
    invite.mutate(list);
  };

  const reset = () => {
    setEmails("");
    setResult(undefined);
    setGroupIds([]);
    setMessage("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <UserPlus aria-hidden="true" />
          {m.invite_button()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{m.invite_dialog_title()}</DialogTitle>
            <DialogDescription>{m.invite_subtitle()}</DialogDescription>
          </DialogHeader>
          <Field
            id={ids.emails}
            label={m.invite_emails()}
            description={m.invite_emails_hint()}
            required
          >
            <Textarea
              id={ids.emails}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              rows={4}
              required
              aria-describedby={`${ids.emails}-description`}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={ids.kind} label={m.invite_kind()}>
              <Select
                value={kind}
                onValueChange={(v) => {
                  const k = v as "staff" | "external";
                  setKind(k);
                  setRole(k === "staff" ? "editor" : "investor");
                }}
              >
                <SelectTrigger id={ids.kind}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="external">{m.kind_external()}</SelectItem>
                  {canInviteStaff ? <SelectItem value="staff">{m.kind_staff()}</SelectItem> : null}
                </SelectContent>
              </Select>
            </Field>
            <Field id={ids.role} label={m.invite_role()}>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id={ids.role}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(kind === "staff" ? STAFF_ROLES : (["investor"] as const)).map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {groups.data && groups.data.groups.length > 0 ? (
            <GroupPicker
              groups={groups.data.groups}
              value={groupIds}
              onChange={setGroupIds}
              legend={m.invite_groups()}
              idPrefix="invite-group"
            />
          ) : null}
          <Field id={ids.message} label={m.invite_message()} description={m.invite_message_hint()}>
            <Textarea
              id={ids.message}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              aria-describedby={`${ids.message}-description`}
            />
          </Field>
          {result ? (
            <div className="rounded-md border p-3 text-sm" role="status">
              <p>{m.invite_result_created({ count: result.created })}</p>
              {result.failed.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {result.failed.map((f) => (
                    <li key={f.email}>
                      {f.email}: {f.code === "conflict" ? m.invite_already_member() : f.code}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {result ? m.common_close() : m.common_cancel()}
            </Button>
            <Button type="submit" loading={invite.isPending}>
              {m.invite_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
