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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  fieldAria,
  Input,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { callNoContent } from "../../lib/access-admin-queries.js";
import { api, call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  SCIM_ROLES,
  SCIM_TOKEN_LIMIT,
  type ScimAdminView,
  type ScimGroup,
  type ScimMappableRole,
  type ScimToken,
  SSO_KEY,
  scimAdminQuery,
  scimGroupsQuery,
  scimUsersQuery,
} from "../../lib/sso-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog, roleLabel } from "../access/common.js";
import {
  PlanFeatureNotice,
  usePlanAllowsFeature,
  usePlanRemovalWarning,
} from "../billing/plan-feature-notice.js";
import { NativeSelect } from "../compliance/common.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";
import { CopyRow, SsoRefusal } from "./common.js";

/*
 * SCIM provisioning (E3.8). The identity provider creates, suspends and removes staff through
 * `{BASE_URL}/scim/v2` with a bearer token made here. At most two live tokens, so a rotation is
 * "create the new one, switch the IdP, revoke the old one". A token is shown once, in a dialog
 * that stays until the admin closes it; only its prefix is kept for recognising it later.
 *
 * Groups map to staff roles here (not in the IdP): the highest mapped role wins, members of no
 * mapped group get the default role, and owners are never changed by SCIM.
 */
export function ScimCard({ canManage }: { canManage: boolean }) {
  const scim = useQuery(scimAdminQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.sso_admin_scim_title()}</CardTitle>
        <CardDescription>{m.sso_admin_scim_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <PlanFeatureNotice feature="scim" />
        {scim.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {scim.isError ? <ErrorAlert error={scim.error} /> : null}
        {scim.data === undefined ? null : scim.data.enabled ? (
          <ScimEnabled view={scim.data} canManage={canManage} />
        ) : (
          <Alert>
            <AlertTitle>{m.sso_admin_scim_disabled_title()}</AlertTitle>
            <AlertDescription>{m.sso_admin_scim_disabled_body()}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function ScimEnabled({ view, canManage }: { view: ScimAdminView; canManage: boolean }) {
  const tokensHeading = useId();
  return (
    <div className="space-y-6">
      <dl className="space-y-3">
        <CopyRow
          label={m.sso_admin_scim_base_url()}
          value={view.baseUrl}
          copyLabel={m.sso_admin_copy_scim_base_url()}
        />
      </dl>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{m.sso_admin_scim_count_users()}</dt>
        <dd>{view.counts.users}</dd>
        <dt className="text-muted-foreground">{m.sso_admin_scim_count_active()}</dt>
        <dd>{view.counts.activeUsers}</dd>
        <dt className="text-muted-foreground">{m.sso_admin_scim_count_groups()}</dt>
        <dd>{view.counts.groups}</dd>
      </dl>

      <section aria-labelledby={tokensHeading} className="space-y-3">
        <h3 id={tokensHeading} className="font-semibold">
          {m.sso_admin_scim_tokens_title()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.sso_admin_scim_tokens_body()}</p>
        <p className="text-sm text-muted-foreground">{m.sso_admin_scim_tokens_outlive()}</p>
        {view.tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.sso_admin_scim_tokens_empty()}</p>
        ) : (
          <ul className="space-y-2">
            {view.tokens.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                canManage={canManage}
                last={view.tokens.length === 1}
              />
            ))}
          </ul>
        )}
        {canManage ? (
          <CreateToken
            full={view.tokens.length >= SCIM_TOKEN_LIMIT}
            rotating={view.tokens.length > 0}
          />
        ) : null}
      </section>

      <ScimGroups canManage={canManage} />
      <ScimUsers />
    </div>
  );
}

function TokenRow({
  token,
  canManage,
  last,
}: {
  token: ScimToken;
  canManage: boolean;
  /** The only live token: on a plan without SCIM, revoking it cannot be undone (RR3 RL4). */
  last: boolean;
}) {
  const queryClient = useQueryClient();
  const warn = usePlanRemovalWarning("scim", last);
  const revoke = useGuardedMutation({
    mutationFn: () =>
      callNoContent(api().DELETE("/sso/scim/tokens/{id}", { params: { path: { id: token.id } } })),
    onSuccess: () => {
      toast.success(m.sso_admin_scim_token_revoked({ name: token.name }));
      void queryClient.invalidateQueries({ queryKey: SSO_KEY });
    },
  });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="font-medium">{token.name}</span>
        <span className="text-muted-foreground">
          <code className="font-mono text-xs">{token.displayPrefix}…</code>{" "}
          {m.sso_admin_scim_token_created({ when: formatDateTime(token.createdAt) })}{" "}
          {token.lastUsedAt === null
            ? m.sso_admin_scim_token_never_used()
            : m.sso_admin_scim_token_last_used({ when: formatDateTime(token.lastUsedAt) })}
        </span>
      </div>
      {canManage ? (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm">
              {m.sso_admin_scim_token_revoke({ name: token.name })}
            </Button>
          }
          title={m.sso_admin_scim_token_revoke_title({ name: token.name })}
          description={warn(m.sso_admin_scim_token_revoke_body())}
          confirmLabel={m.sso_admin_scim_token_revoke_confirm()}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
        />
      ) : null}
      {revoke.isError ? <SsoRefusal error={revoke.error} /> : null}
    </li>
  );
}

function CreateToken({
  full,
  rotating,
}: {
  full: boolean;
  /** A live token exists (the list holds only live ones), so a new token is a rotation. */
  rotating: boolean;
}) {
  const id = useId();
  // A-3: existing tokens keep working and can be revoked; while one is live a second one is
  // rotation (allowed), but provisioning from scratch needs `scim` on the plan.
  const planAllows = usePlanAllowsFeature("scim") || rotating;
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  // The token lives here only: never in the query cache, never in storage.
  const [revealed, setRevealed] = useState<string | null>(null);
  const create = useGuardedMutation({
    mutationFn: (value: string) => call(api().POST("/sso/scim/tokens", { body: { name: value } })),
    onSuccess: (result) => {
      setRevealed(result.token);
      setName("");
      void queryClient.invalidateQueries({ queryKey: SSO_KEY });
    },
  });
  const value = name.trim();
  return (
    <>
      {full ? (
        <p className="text-sm text-muted-foreground">{m.sso_admin_scim_token_limit_note()}</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (value !== "") create.mutate(value);
          }}
        >
          <Field
            id={id}
            label={m.sso_admin_scim_token_name()}
            description={m.sso_admin_scim_token_name_help()}
          >
            <Input
              id={id}
              value={name}
              maxLength={80}
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                create.reset();
              }}
              {...fieldAria(id, { description: true })}
            />
          </Field>
          <Button type="submit" loading={create.isPending} disabled={value === "" || !planAllows}>
            {m.sso_admin_scim_token_create()}
          </Button>
        </form>
      )}
      {create.isError ? (
        <SsoRefusal error={create.error} title={m.sso_admin_scim_token_refused_title()} />
      ) : null}
      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.sso_admin_scim_token_reveal_title()}</DialogTitle>
            <DialogDescription>{m.shown_once_warning()}</DialogDescription>
          </DialogHeader>
          <code className="block w-full overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
            {revealed}
          </code>
          <p className="text-sm text-muted-foreground">{m.sso_admin_scim_token_reveal_body()}</p>
          <DialogFooter>
            {revealed === null ? null : (
              <CopyButton value={revealed} label={m.sso_admin_copy_scim_token()} />
            )}
            <Button type="button" onClick={() => setRevealed(null)}>
              {m.shown_once_dismiss()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// --- groups -----------------------------------------------------------------------------------

function ScimGroups({ canManage }: { canManage: boolean }) {
  const headingId = useId();
  const groups = useQuery(scimGroupsQuery);
  const list = groups.data?.groups ?? [];
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="font-semibold">
        {m.sso_admin_scim_groups_title()}
      </h3>
      <p className="text-sm text-muted-foreground">{m.sso_admin_scim_groups_help()}</p>
      {groups.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
      {groups.isError ? <ErrorAlert error={groups.error} /> : null}
      {groups.data === undefined ? null : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.sso_admin_scim_groups_empty()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.sso_admin_scim_col_group()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_members()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_role()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((group) => (
              <GroupRow key={group.id} group={group} canManage={canManage} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function GroupRow({ group, canManage }: { group: ScimGroup; canManage: boolean }) {
  const id = useId();
  const queryClient = useQueryClient();
  const setRole = useGuardedMutation({
    mutationFn: (role: ScimMappableRole | null) =>
      call(
        api().PUT("/sso/scim/groups/{id}/role", {
          params: { path: { id: group.id } },
          body: { role },
        }),
      ),
    onSuccess: (result) => {
      toast.success(
        result.group.role === null
          ? m.sso_admin_scim_group_unmapped({ group: result.group.displayName })
          : m.sso_admin_scim_group_mapped({
              group: result.group.displayName,
              role: roleLabel(result.group.role),
            }),
      );
      void queryClient.invalidateQueries({ queryKey: SSO_KEY });
    },
  });
  return (
    <TableRow>
      <TableCell className="font-medium">{group.displayName}</TableCell>
      <TableCell>{group.memberCount}</TableCell>
      <TableCell>
        {canManage ? (
          <div className="space-y-1">
            <NativeSelect
              id={id}
              aria-label={m.sso_admin_scim_group_role_label({ group: group.displayName })}
              value={group.role ?? ""}
              // A-3: mapping roles is maintaining who has access — allowed on any plan (an owner
              // must always be able to demote a group).
              disabled={setRole.isPending}
              onChange={(e) =>
                setRole.mutate(e.target.value === "" ? null : (e.target.value as ScimMappableRole))
              }
            >
              <option value="">{m.sso_admin_scim_role_none()}</option>
              {SCIM_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </NativeSelect>
            {setRole.isError ? <SsoRefusal error={setRole.error} /> : null}
          </div>
        ) : group.role === null ? (
          m.sso_admin_scim_role_none()
        ) : (
          roleLabel(group.role)
        )}
      </TableCell>
    </TableRow>
  );
}

// --- users ------------------------------------------------------------------------------------

function ScimUsers() {
  const headingId = useId();
  const users = useInfiniteQuery(scimUsersQuery);
  const rows = users.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="font-semibold">
        {m.sso_admin_scim_users_title()}
      </h3>
      {users.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
      {users.isError ? <ErrorAlert error={users.error} /> : null}
      {users.data === undefined ? null : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.sso_admin_scim_users_empty()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.sso_admin_scim_col_user_name()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_display_name()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_status()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_role()}</TableHead>
              <TableHead>{m.sso_admin_scim_col_groups()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="break-all">{user.userName}</TableCell>
                <TableCell>{user.displayName ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={user.active ? "success" : "secondary"}>
                    {user.active
                      ? m.sso_admin_scim_user_active()
                      : m.sso_admin_scim_user_suspended()}
                  </Badge>
                </TableCell>
                <TableCell>{user.role === null ? "—" : roleLabel(user.role)}</TableCell>
                <TableCell>{user.groups.length === 0 ? "—" : user.groups.join(", ")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {users.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={users.isFetchingNextPage}
          onClick={() => void users.fetchNextPage()}
        >
          {m.sso_admin_scim_users_more()}
        </Button>
      ) : null}
    </section>
  );
}
