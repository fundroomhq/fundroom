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
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  ConfirmDialog,
  capabilityLabel,
  personName,
  roleLabel,
  StatusBadge,
} from "../../../components/access/common.js";
import { DelegatesCard, delegateScopeLabel } from "../../../components/access/delegates.js";
import { MemberSessionsCard, ViewAsButton } from "../../../components/access/member-sessions.js";
import {
  NativeSelect,
  relationshipSourceLabel,
  relationshipWarningLabel,
} from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { RELATIONSHIP_SOURCES, type RelationshipSource } from "../../../lib/compliance-queries.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import {
  groupsQuery,
  type Person,
  personQuery,
  useBootstrap,
  useMe,
} from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/people/$membershipId")({ component: PersonPage });

const STAFF_ROLES = ["owner", "admin", "editor", "viewer", "finance", "legal"] as const;

function PersonPage() {
  const { membershipId } = Route.useParams();
  const person = useQuery(personQuery(membershipId));
  const bootstrap = useBootstrap();
  const me = useMe();
  const permissions = bootstrap.data?.permissions ?? [];
  const canManage = permissions.includes("access.manage");
  const canManageStaff = permissions.includes("access.manage_staff");
  const myRole = bootstrap.data?.membership?.role;

  if (person.isPending) return <LoadingState label={m.common_loading()} />;
  if (person.isError) return <ErrorAlert error={person.error} />;
  const { person: p, delegates, attestations, grants } = person.data;
  const isSelf = me.data?.membership?.id === p.membershipId;
  const canEdit = canManage && (p.kind === "external" || canManageStaff);
  // Sessions follow the server's target rules: staff need `access.manage_staff`, and only an
  // owner may sign an owner out.
  const canActOnSessions = canEdit && !isSelf && (p.role !== "owner" || myRole === "owner");
  const canViewAs = canManage && p.kind === "external" && p.status === "active";
  return (
    <div className="space-y-6">
      <PageHeader
        title={personName(p)}
        description={p.email ?? ""}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/people">
                <ArrowLeft aria-hidden="true" />
                {m.people_back()}
              </Link>
            </Button>
            {canViewAs ? <ViewAsButton membershipId={p.membershipId} name={personName(p)} /> : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{m.person_membership()}</CardTitle>
            <CardDescription>{m.person_membership_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{m.people_col_status()}</dt>
              <dd>
                <StatusBadge status={p.status} />
              </dd>
              <dt className="text-muted-foreground">{m.invite_kind()}</dt>
              <dd>{p.kind === "staff" ? m.kind_staff() : m.kind_external()}</dd>
              <dt className="text-muted-foreground">{m.people_col_role()}</dt>
              <dd>{roleLabel(p.role)}</dd>
              {typeof p.profile["firm"] === "string" ? (
                <>
                  <dt className="text-muted-foreground">{m.person_firm()}</dt>
                  <dd>{p.profile["firm"]}</dd>
                </>
              ) : null}
              {p.principal !== null ? (
                <>
                  <dt className="text-muted-foreground">{m.person_acts_for()}</dt>
                  <dd>
                    <Link
                      to="/admin/people/$membershipId"
                      params={{ membershipId: p.principal.membershipId }}
                      className="underline"
                    >
                      {p.principal.firm
                        ? m.person_principal_with_firm({
                            firm: p.principal.firm,
                            name: p.principal.displayName,
                          })
                        : p.principal.displayName}
                    </Link>
                    {p.delegateScope ? ` · ${delegateScopeLabel(p.delegateScope)}` : null}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{m.person_source()}</dt>
              <dd>{p.source}</dd>
              <dt className="text-muted-foreground">{m.person_joined()}</dt>
              <dd>{p.activatedAt ? formatDate(p.activatedAt) : "—"}</dd>
              <dt className="text-muted-foreground">{m.people_col_last_seen()}</dt>
              <dd>{p.lastSeenAt ? formatDateTime(p.lastSeenAt) : "—"}</dd>
              {/* Owners never expire (P1-02): the row would only ever say "No expiry" (E3.2). */}
              {p.role === "owner" ? null : (
                <>
                  <dt className="text-muted-foreground">{m.person_expires()}</dt>
                  <dd>{p.expiresAt ? formatDate(p.expiresAt) : m.person_no_expiry()}</dd>
                </>
              )}
            </dl>
            {canEdit && p.kind === "staff" && p.status !== "revoked" ? (
              <RoleEditor
                membershipId={p.membershipId}
                current={p.role}
                actorIsOwner={myRole === "owner"}
              />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{m.person_groups()}</CardTitle>
            <CardDescription>{m.person_groups_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage && p.status !== "revoked" ? (
              <GroupsEditor membershipId={p.membershipId} current={p.groups.map((g) => g.id)} />
            ) : (
              <div className="flex flex-wrap gap-1">
                {p.groups.length === 0 ? (
                  <span className="text-sm text-muted-foreground">{m.person_no_groups()}</span>
                ) : (
                  p.groups.map((g) => (
                    <Badge key={g.id} variant="outline">
                      {g.name}
                    </Badge>
                  ))
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {p.kind === "external" ? (
          <Card>
            <CardHeader>
              <CardTitle>{m.relationship_title()}</CardTitle>
              <CardDescription>{m.relationship_subtitle()}</CardDescription>
            </CardHeader>
            <CardContent>
              <RelationshipEditor person={p} canEdit={canManage && p.status !== "revoked"} />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{m.person_access()}</CardTitle>
            <CardDescription>{m.person_access_subtitle()}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {grants.length === 0 ? (
              <p className="text-muted-foreground">{m.person_no_grants()}</p>
            ) : (
              <ul className="divide-y">
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 py-2">
                    <code className="font-mono text-xs">
                      {g.resource.kind}:{g.resource.id.slice(0, 8)}
                    </code>
                    <Badge variant={g.effect === "allow" ? "secondary" : "destructive"}>
                      {g.effect === "allow" ? "" : `${m.share_exclude()} `}
                      {capabilityLabel(g.capability)}
                    </Badge>
                    {g.validUntil ? (
                      <span className="text-xs text-muted-foreground">
                        {m.share_expires({ when: formatDate(g.validUntil) })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {attestations.length > 0 ? (
              <div>
                <h3 className="font-medium">{m.person_attestations()}</h3>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {attestations.map((a) => (
                    <li key={`${a.kind}-${a.signedAt}`}>
                      {a.kind} · {formatDate(a.signedAt)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {delegates.length > 0 ? (
              <div>
                <h3 className="font-medium">{m.person_delegates()}</h3>
                <ul className="mt-1 list-disc pl-5">
                  {delegates.map((d) => (
                    <li key={d.membershipId}>
                      <Link
                        to="/admin/people/$membershipId"
                        params={{ membershipId: d.membershipId }}
                      >
                        {personName(d)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {p.kind === "external" && p.role === "investor" && p.status !== "revoked" ? (
          <DelegatesCard mode="admin" principalId={p.membershipId} canManage={canManage} />
        ) : null}

        {p.status !== "revoked" ? (
          <MemberSessionsCard
            membershipId={p.membershipId}
            name={personName(p)}
            canAct={canActOnSessions}
          />
        ) : null}

        {canEdit && p.status !== "revoked" && !isSelf ? (
          <Card>
            <CardHeader>
              <CardTitle>{m.person_danger()}</CardTitle>
              <CardDescription>{m.person_danger_subtitle()}</CardDescription>
            </CardHeader>
            <CardContent>
              <RevokeButton
                membershipId={p.membershipId}
                name={personName(p)}
                delegates={delegates.length}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function RoleEditor({
  membershipId,
  current,
  actorIsOwner,
}: {
  membershipId: string;
  current: string;
  actorIsOwner: boolean;
}) {
  const [role, setRole] = useState(current);
  const id = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/access/people/{id}", {
          params: { path: { id: membershipId } },
          body: { role: role as "admin" },
        }),
      ),
    onSuccess: () => {
      toast.success(m.person_role_saved());
      void queryClient.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const roles = STAFF_ROLES.filter((r) => r !== "owner" || actorIsOwner);
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (role !== current) save.mutate();
      }}
    >
      <Field id={id} label={m.person_change_role()}>
        <Select
          value={role}
          onValueChange={setRole}
          disabled={current === "owner" && !actorIsOwner}
        >
          <SelectTrigger id={id} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r} value={r}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button type="submit" variant="outline" loading={save.isPending} disabled={role === current}>
        {m.common_save()}
      </Button>
    </form>
  );
}

function GroupsEditor({ membershipId, current }: { membershipId: string; current: string[] }) {
  const groups = useQuery(groupsQuery);
  const [selected, setSelected] = useState<string[]>(current);
  useEffect(() => setSelected(current), [current]);
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT("/access/people/{id}/groups", {
          params: { path: { id: membershipId } },
          body: { groupIds: selected },
        }),
      ),
    onSuccess: () => {
      toast.success(m.person_groups_saved());
      void queryClient.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  if (groups.isPending) return <LoadingState lines={2} label={m.common_loading()} />;
  if (groups.isError) return <ErrorAlert error={groups.error} />;
  if (groups.data.groups.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {m.person_no_groups_yet()}{" "}
        <Link to="/admin/groups" className="underline">
          {m.groups_title()}
        </Link>
      </p>
    );
  const dirty = selected.length !== current.length || selected.some((id) => !current.includes(id));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">{m.person_groups()}</legend>
        {groups.data.groups.map((g) => {
          const id = `member-group-${g.id}`;
          return (
            <div key={g.id} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selected.includes(g.id)}
                onCheckedChange={(on) =>
                  setSelected((cur) =>
                    on === true ? [...cur, g.id] : cur.filter((x) => x !== g.id),
                  )
                }
              />
              <Label htmlFor={id}>{g.name}</Label>
            </div>
          );
        })}
      </fieldset>
      <Button type="submit" variant="outline" loading={save.isPending} disabled={!dirty}>
        {m.common_save()}
      </Button>
    </form>
  );
}

function RevokeButton({
  membershipId,
  name,
  delegates,
}: {
  membershipId: string;
  name: string;
  delegates: number;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const revoke = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/access/people/{id}/revoke", {
          params: { path: { id: membershipId } },
          body: reason.trim() ? { reason: reason.trim() } : {},
        }),
      ),
    onSuccess: (r) => {
      toast.success(m.person_revoked({ sessions: r.sessionsRevoked }));
      void queryClient.invalidateQueries({ queryKey: ["access"] });
      void navigate({ to: "/admin/people" });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="destructive">
          {m.person_revoke()}
        </Button>
      }
      title={m.person_revoke_title({ name })}
      description={
        delegates > 0
          ? m.person_revoke_body_delegates({ count: delegates })
          : m.person_revoke_body()
      }
      confirmLabel={m.person_revoke()}
      pending={revoke.isPending}
      onConfirm={() => revoke.mutate()}
    >
      <Field id={id} label={m.person_revoke_reason()} description={m.person_revoke_reason_hint()}>
        <Textarea
          id={id}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          aria-describedby={`${id}-description`}
        />
      </Field>
    </ConfirmDialog>
  );
}

/*
 * Relationship evidence (ADR-0037 decision 11). The heuristic warns and never blocks: it is
 * surfaced where staff can act on it, worded as the prompt it is, and every control on this
 * card stays usable while the warning stands.
 */
function RelationshipEditor({ person, canEdit }: { person: Person; canEdit: boolean }) {
  const rel = person.relationship;
  const [source, setSource] = useState<string>(rel.source ?? "");
  const [establishedAt, setEstablishedAt] = useState(rel.establishedAt?.slice(0, 10) ?? "");
  const [note, setNote] = useState(rel.note ?? "");
  const base = useId();
  const queryClient = useQueryClient();
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/access/people/{id}", {
          params: { path: { id: person.membershipId } },
          body: {
            relationship: {
              source: source === "" ? null : (source as RelationshipSource),
              establishedAt: establishedAt === "" ? null : `${establishedAt}T00:00:00.000Z`,
              note: note.trim() === "" ? null : note.trim(),
            },
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.relationship_saved());
      void queryClient.invalidateQueries({ queryKey: ["access"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <div className="space-y-4">
      {rel.warning === null ? null : (
        <Alert variant="warning">
          <AlertTitle>{m.relationship_warning_title()}</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{relationshipWarningLabel(rel.warning)}</p>
            <p>{m.relationship_warning_not_blocking()}</p>
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{m.relationship_first_exposure()}</dt>
        <dd>{rel.firstExposureAt ? formatDateTime(rel.firstExposureAt) : m.relationship_none()}</dd>
        {canEdit ? null : (
          <>
            <dt className="text-muted-foreground">{m.relationship_field_source()}</dt>
            <dd>
              {rel.source === null ? m.relationship_none() : relationshipSourceLabel(rel.source)}
            </dd>
            <dt className="text-muted-foreground">{m.relationship_field_established()}</dt>
            <dd>{rel.establishedAt ? formatDate(rel.establishedAt) : m.relationship_none()}</dd>
          </>
        )}
      </dl>
      {canEdit ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field id={`${base}-source`} label={m.relationship_field_source()}>
              <NativeSelect
                id={`${base}-source`}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">{m.relationship_source_unrecorded()}</option>
                {RELATIONSHIP_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {relationshipSourceLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id={`${base}-date`} label={m.relationship_field_established()}>
              <Input
                id={`${base}-date`}
                type="date"
                value={establishedAt}
                onChange={(e) => setEstablishedAt(e.target.value)}
              />
            </Field>
          </div>
          <Field
            id={`${base}-note`}
            label={m.relationship_field_note()}
            description={m.relationship_field_note_hint()}
          >
            <Textarea
              id={`${base}-note`}
              rows={2}
              value={note}
              aria-describedby={`${base}-note-description`}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" loading={save.isPending}>
            {m.common_save()}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
