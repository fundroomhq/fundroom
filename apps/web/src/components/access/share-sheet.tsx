import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { api, call, describeError } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import {
  type AccessHolder,
  explainQuery,
  groupsQuery,
  peopleQuery,
  type ResourceRef,
  whoHasAccessQuery,
} from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { capabilityLabel, gateLabel, personName, roleLabel } from "./common.js";

const CAPS = ["view", "download", "comment", "edit"] as const;
const ROLES = [
  "investor",
  "delegate",
  "viewer",
  "editor",
  "finance",
  "legal",
  "admin",
  "owner",
] as const;

/**
 * The per-resource share sheet (design/05 §4.6): who has access grouped by "via", the gates
 * still pending, add a person / group / role with capabilities and expiry, remove a rule,
 * and "why?" for any holder. Modules embed it wherever a resource is shown.
 */
export function ShareSheet({
  resource,
  label,
  canManage,
  trigger,
}: {
  resource: ResourceRef;
  /** Human name of the resource for the title. */
  label: string;
  canManage: boolean;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const who = useQuery({ ...whoHasAccessQuery(resource), enabled: open });
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["access", "who"] });
  const revoke = useGuardedMutation<unknown, string>({
    mutationFn: (id) => call(api().DELETE("/access/grants/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.share_removed());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline">
            <Share2 aria-hidden="true" />
            {m.share_button()}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.share_title({ name: label })}</DialogTitle>
          <DialogDescription>{m.share_subtitle()}</DialogDescription>
        </DialogHeader>
        {canManage ? <AddGrantForm resource={resource} onDone={invalidate} /> : null}
        <section aria-labelledby="share-holders-heading" className="space-y-2">
          <h3 id="share-holders-heading" className="text-sm font-medium">
            {m.share_who_heading()}
          </h3>
          {who.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
          {who.isError ? <ErrorAlert error={who.error} /> : null}
          {who.data ? (
            who.data.holders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.share_nobody()}</p>
            ) : (
              <ul className="divide-y">
                {who.data.holders.map((h) => (
                  <HolderRow
                    key={h.membershipId}
                    holder={h}
                    resource={resource}
                    canManage={canManage}
                    onRevoke={(id) => revoke.mutate(id)}
                    revoking={revoke.isPending}
                  />
                ))}
              </ul>
            )
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function HolderRow({
  holder,
  resource,
  canManage,
  onRevoke,
  revoking,
}: {
  holder: AccessHolder;
  resource: ResourceRef;
  canManage: boolean;
  onRevoke: (grantId: string) => void;
  revoking: boolean;
}) {
  const [why, setWhy] = useState(false);
  const explain = useQuery({ ...explainQuery(resource, holder.membershipId), enabled: why });
  const direct = holder.via.filter((v) => v.subject.kind === "membership" && !v.inherited);
  const vias = [...new Set(holder.via.map((v) => viaLabel(v.subject)))];
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{personName(holder)}</span>
        <span className="text-xs text-muted-foreground">{holder.email}</span>
        {holder.capabilities.length === 0 ? (
          <Badge variant="destructive">{m.share_excluded()}</Badge>
        ) : (
          holder.capabilities.map((c) => (
            <Badge key={c} variant="secondary">
              {capabilityLabel(c)}
            </Badge>
          ))
        )}
        {holder.pendingGates.map((g) => (
          <Badge key={`${g.kind}-${g.source}`} variant="warning">
            {gateLabel(g.kind, g.detail)}
          </Badge>
        ))}
        {holder.expiresAt ? (
          <span className="text-xs text-muted-foreground">
            {m.share_expires({ when: formatDate(holder.expiresAt) })}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{m.share_via({ list: vias.join(", ") })}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setWhy((v) => !v)}
          aria-expanded={why}
        >
          {m.share_why()}
        </Button>
        {canManage && direct.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={revoking}
            onClick={() => {
              for (const v of direct) onRevoke(v.grantId);
            }}
          >
            {m.share_remove_direct()}
          </Button>
        ) : null}
      </div>
      {why ? (
        <section className="rounded-md border p-2 text-xs" aria-label={m.share_why()}>
          {explain.isPending ? <LoadingState lines={1} label={m.common_loading()} /> : null}
          {explain.isError ? <ErrorAlert error={explain.error} /> : null}
          {explain.data ? (
            <ol className="space-y-1">
              {explain.data.rules.map((r) => (
                <li
                  key={`${r.grantId}-${r.capability}`}
                  className={r.decisive ? "" : "text-muted-foreground line-through"}
                >
                  {m.share_rule({
                    effect: r.effect === "allow" ? m.share_allow() : m.share_exclude(),
                    capability: capabilityLabel(r.capability),
                    subject: viaLabel(r.subject),
                    where: r.inherited ? m.share_inherited() : m.share_here(),
                  })}
                </li>
              ))}
              {explain.data.rules.length === 0 ? <li>{m.share_no_rules()}</li> : null}
            </ol>
          ) : null}
        </section>
      ) : null}
    </li>
  );
}

function viaLabel(s: AccessHolder["via"][number]["subject"]): string {
  switch (s.kind) {
    case "membership":
      return m.share_via_direct();
    case "group":
      return m.share_via_group({ name: s.label });
    case "role":
      return m.share_via_role({ role: roleLabel(s.role ?? s.label) });
    default:
      return m.share_via_link();
  }
}

function AddGrantForm({ resource, onDone }: { resource: ResourceRef; onDone: () => void }) {
  const [kind, setKind] = useState<"membership" | "group" | "role">("membership");
  const [subjectId, setSubjectId] = useState("");
  const [caps, setCaps] = useState<string[]>(["view"]);
  const [effect, setEffect] = useState<"allow" | "exclude">("allow");
  const [until, setUntil] = useState("");
  const ids = { kind: useId(), subject: useId(), effect: useId(), until: useId() };
  const people = useQuery({
    ...peopleQuery({ status: "active,dormant" }),
    enabled: kind === "membership",
  });
  const groups = useQuery({ ...groupsQuery, enabled: kind === "group" });

  const add = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/access/grants", {
          body: {
            subject:
              kind === "role"
                ? { kind: "role", role: subjectId as "investor" }
                : { kind, id: subjectId },
            // Kind and id only: the server derives the rule's path from the resource itself.
            // `resource.path` is where the resource *sits* (the listing above reads inherited
            // rules along it); sent as the rule's scope, a document's folder path shared the
            // whole folder (review R1-A1).
            resource: { kind: resource.kind, id: resource.id },
            capabilities: caps as ("view" | "download" | "comment" | "edit")[],
            effect,
            ...(until ? { validUntil: new Date(until).toISOString() } : {}),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.share_added());
      setSubjectId("");
      onDone();
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!subjectId || caps.length === 0) return;
    add.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={ids.kind} label={m.share_subject_kind()}>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as typeof kind);
              setSubjectId("");
            }}
          >
            <SelectTrigger id={ids.kind}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="membership">{m.share_kind_person()}</SelectItem>
              <SelectItem value="group">{m.share_kind_group()}</SelectItem>
              <SelectItem value="role">{m.share_kind_role()}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id={ids.subject} label={m.share_subject()} className="sm:col-span-2">
          <Select value={subjectId} onValueChange={setSubjectId}>
            <SelectTrigger id={ids.subject}>
              <SelectValue placeholder={m.share_subject_placeholder()} />
            </SelectTrigger>
            <SelectContent>
              {kind === "membership"
                ? (people.data?.items ?? []).map((p) => (
                    <SelectItem key={p.membershipId} value={p.membershipId}>
                      {personName(p)}
                    </SelectItem>
                  ))
                : kind === "group"
                  ? (groups.data?.groups ?? []).map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))
                  : ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {roleLabel(r)}
                      </SelectItem>
                    ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm font-medium">{m.share_capabilities()}</legend>
        {CAPS.map((c) => {
          const id = `share-cap-${c}`;
          return (
            <div key={c} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={caps.includes(c)}
                onCheckedChange={(on) =>
                  setCaps((cur) => (on === true ? [...cur, c] : cur.filter((x) => x !== c)))
                }
              />
              <Label htmlFor={id}>{capabilityLabel(c)}</Label>
            </div>
          );
        })}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={ids.effect} label={m.share_effect()}>
          <Select value={effect} onValueChange={(v) => setEffect(v as typeof effect)}>
            <SelectTrigger id={ids.effect}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">{m.share_allow()}</SelectItem>
              <SelectItem value="exclude">{m.share_exclude()}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id={ids.until} label={m.share_until()} className="sm:col-span-2">
          <input
            id={ids.until}
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          />
        </Field>
      </div>
      <Button type="submit" loading={add.isPending} disabled={!subjectId || caps.length === 0}>
        {m.share_add()}
      </Button>
    </form>
  );
}
