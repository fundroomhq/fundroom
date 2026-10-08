import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Laptop, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ConfirmDialog,
  SectionCard,
  TotpCard,
} from "../../../components/account/security-cards.js";
import { useSignOut } from "../../../components/account-menu.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { SsoSessionRestrictedNotice } from "../../../components/sso-sign-in.js";
import { api, call, describeError } from "../../../lib/api.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  devicesQuery,
  passkeysQuery,
  passwordQuery,
  refreshSession,
  sessionsQuery,
} from "../../../lib/queries.js";
import { useSessionRestriction } from "../../../lib/sso-login.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { isWebAuthnCancelled, register, webAuthnSupported } from "../../../lib/webauthn.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/_portal/settings/security")({ component: Security });

function Security() {
  const config = useWebConfig();
  /*
   * E3.8 FR1: a session that came from the workspace's single sign-on may not change the
   * account's global security, and the server refuses every one of these calls
   * (`sso_session_restricted`). Rather than a screen of controls that all fail, say why once.
   * E3.10: the same for a session central auth handed to this workspace host
   * (`bound_session_restricted`) — its account lives on the canonical host.
   */
  const restricted = useSessionRestriction();
  if (restricted !== null) return <SsoSessionRestrictedNotice kind={restricted} />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SessionsCard />
      <DevicesCard />
      <PasskeysCard />
      <TotpCard />
      {config.auth.methods.includes("password") ? <PasswordCard /> : null}
    </div>
  );
}

// --- sessions ----------------------------------------------------------------------------------

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery(sessionsQuery);
  const signOut = useSignOut();
  const revoke = useGuardedMutation<unknown, string>({
    mutationFn: (id) => call(api().DELETE("/me/sessions/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.sessions_revoked());
      void queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const everywhere = useGuardedMutation({
    mutationFn: () => call(api().POST("/auth/logout-everywhere")),
    onSuccess: () => void signOut(),
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <SectionCard
      title={m.sessions_title()}
      description={m.sessions_subtitle()}
      footer={
        <Button
          type="button"
          variant="destructive"
          loading={everywhere.isPending}
          onClick={() => everywhere.mutate()}
        >
          {m.sessions_sign_out_everywhere()}
        </Button>
      }
    >
      {sessions.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {sessions.isError ? <ErrorAlert error={sessions.error} /> : null}
      {sessions.data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.sessions_col_device()}</TableHead>
              <TableHead>{m.sessions_col_last_seen()}</TableHead>
              <TableHead>{m.sessions_col_level()}</TableHead>
              <TableHead className="sr-only">{m.common_actions()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data.sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="flex items-center gap-2">
                      {s.deviceName}
                      {s.current ? <Badge>{m.sessions_current()}</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.device}
                      {s.ip ? ` · ${s.ip}` : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell>{formatDateTime(s.lastSeenAt)}</TableCell>
                <TableCell>{String(s.authLevel)}</TableCell>
                <TableCell className="text-right">
                  {!s.current ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={revoke.isPending && revoke.variables === s.id}
                      onClick={() => revoke.mutate(s.id)}
                    >
                      {m.sessions_revoke()}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </SectionCard>
  );
}

// --- devices -----------------------------------------------------------------------------------

function DevicesCard() {
  const queryClient = useQueryClient();
  const devices = useQuery(devicesQuery);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey });
  const rename = useGuardedMutation<unknown, { id: string; name: string }>({
    mutationFn: ({ id, name }) =>
      call(api().PATCH("/me/devices/{id}", { params: { path: { id } }, body: { name } })),
    onSuccess: invalidate,
    onError: (error) => toast.error(describeError(error).title),
  });
  const forget = useGuardedMutation<unknown, string>({
    mutationFn: (id) => call(api().DELETE("/me/devices/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.devices_forgotten());
      invalidate();
      void queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <SectionCard title={m.devices_title()} description={m.devices_subtitle()}>
      {devices.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {devices.isError ? <ErrorAlert error={devices.error} /> : null}
      {devices.data ? (
        <ul className="divide-y">
          {devices.data.devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
              <Laptop aria-hidden="true" className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate">{d.name}</span>
                  {d.trusted ? <Badge variant="secondary">{m.devices_trusted()}</Badge> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {d.device} · {m.devices_last_seen({ when: formatDateTime(d.lastSeenAt) })}
                </div>
              </div>
              <RenameDialog
                title={m.devices_rename()}
                current={d.name}
                pending={rename.isPending}
                onSave={(name) => rename.mutate({ id: d.id, name })}
              />
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="ghost" size="sm">
                    {m.devices_forget()}
                  </Button>
                }
                title={m.devices_forget_title({ name: d.name })}
                description={m.devices_forget_body()}
                confirmLabel={m.devices_forget()}
                pending={forget.isPending}
                onConfirm={() => forget.mutate(d.id)}
              />
            </li>
          ))}
          {devices.data.devices.length === 0 ? (
            <li className="py-3 text-sm text-muted-foreground">{m.devices_empty()}</li>
          ) : null}
        </ul>
      ) : null}
    </SectionCard>
  );
}

function RenameDialog({
  title,
  current,
  pending,
  onSave,
}: {
  title: string;
  current: string;
  pending: boolean;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) setName(current);
  }, [open, current]);
  const id = `rename-${current.replace(/\W+/gu, "-")}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {m.common_rename()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() === "") return;
            onSave(name.trim());
            setOpen(false);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{m.common_rename_body()}</DialogDescription>
          </DialogHeader>
          <Field id={id} label={m.common_name()} required>
            <Input
              id={id}
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
              {...fieldAria(id, {})}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- passkeys ----------------------------------------------------------------------------------

function PasskeysCard() {
  const config = useWebConfig();
  /*
   * E3.9 FR2 C1: `passkey` is missing from the page's methods where passkeys cannot work (a path
   * mount, another origin than the passkey RP's); registering is refused there, so no "Add"
   * button. Listing, renaming and removing are not origin-bound and stay.
   */
  const passkeyOn = config.auth.methods.includes("passkey");
  const queryClient = useQueryClient();
  const passkeys = useQuery(passkeysQuery);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    void webAuthnSupported().then(setSupported);
  }, []);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });
    void refreshSession(queryClient);
  };
  const add = useGuardedMutation({
    mutationFn: async () => {
      const begin = await call(api().POST("/auth/passkeys/register/begin"));
      const response = await register(begin.options);
      return call(
        api().POST("/auth/passkeys/register/finish", {
          body: { challengeId: begin.challengeId, response },
        }),
      );
    },
    onSuccess: () => {
      toast.success(m.passkeys_added());
      invalidate();
    },
    onError: (error) => {
      if (!isWebAuthnCancelled(error)) toast.error(describeError(error).title);
    },
  });
  const rename = useGuardedMutation<unknown, { id: string; label: string }>({
    mutationFn: ({ id, label }) =>
      call(api().PATCH("/auth/passkeys/{id}", { params: { path: { id } }, body: { label } })),
    onSuccess: invalidate,
    onError: (error) => toast.error(describeError(error).title),
  });
  const remove = useGuardedMutation<unknown, string>({
    mutationFn: (id) => call(api().DELETE("/auth/passkeys/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success(m.passkeys_removed());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <SectionCard
      title={m.passkeys_title()}
      description={m.passkeys_subtitle()}
      action={
        supported && passkeyOn ? (
          <Button type="button" size="sm" loading={add.isPending} onClick={() => add.mutate()}>
            <KeyRound aria-hidden="true" />
            {m.passkeys_add()}
          </Button>
        ) : null
      }
    >
      {passkeyOn ? null : (
        <p className="text-sm text-muted-foreground">{m.passkeys_unavailable_here()}</p>
      )}
      {passkeys.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
      {passkeys.isError ? <ErrorAlert error={passkeys.error} /> : null}
      {passkeys.data ? (
        <ul className="divide-y">
          {passkeys.data.passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
              <Smartphone aria-hidden="true" className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate">{p.label}</span>
                  {p.backedUp ? <Badge variant="secondary">{m.passkeys_synced()}</Badge> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {m.passkeys_created({ when: formatDateTime(p.createdAt) })}
                  {p.lastUsedAt
                    ? ` · ${m.passkeys_last_used({ when: formatDateTime(p.lastUsedAt) })}`
                    : ""}
                </div>
              </div>
              <RenameDialog
                title={m.passkeys_rename()}
                current={p.label}
                pending={rename.isPending}
                onSave={(label) => rename.mutate({ id: p.id, label })}
              />
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="ghost" size="sm">
                    {m.common_remove()}
                  </Button>
                }
                title={m.passkeys_remove_title({ label: p.label })}
                description={m.passkeys_remove_body()}
                confirmLabel={m.common_remove()}
                pending={remove.isPending}
                onConfirm={() => remove.mutate(p.id)}
              />
            </li>
          ))}
          {passkeys.data.passkeys.length === 0 && passkeyOn ? (
            <li className="py-3 text-sm text-muted-foreground">
              {supported ? m.passkeys_empty() : m.passkeys_unsupported()}
            </li>
          ) : null}
        </ul>
      ) : null}
    </SectionCard>
  );
}

// --- password ----------------------------------------------------------------------------------

function PasswordCard() {
  const queryClient = useQueryClient();
  const status = useQuery(passwordQuery);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: passwordQuery.queryKey });
  // Replacing a password needs the current one (F-20); setting the first one does not.
  const set = useGuardedMutation<unknown, { password: string; currentPassword?: string }>({
    mutationFn: (body) => call(api().PUT("/auth/password", { body })),
    onSuccess: () => {
      toast.success(m.password_saved());
      setPassword("");
      setCurrent("");
      invalidate();
    },
  });
  const remove = useGuardedMutation({
    // Removing needs the current password too, unless the session is level 2 (E2.10 R1-01).
    mutationFn: () =>
      call(
        api().DELETE("/auth/password", {
          body: current.length > 0 ? { currentPassword: current } : {},
        }),
      ),
    onSuccess: () => {
      toast.success(m.password_removed());
      invalidate();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const id = "new-password";
  const currentId = "current-password";
  const error = set.isError ? describeError(set.error).body : undefined;
  const needsCurrent = status.data?.set === true;
  return (
    <SectionCard title={m.password_title()} description={m.password_subtitle()}>
      {status.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
      {status.isError ? <ErrorAlert error={status.error} /> : null}
      {status.data ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length === 0 || (needsCurrent && current.length === 0)) return;
            set.mutate(needsCurrent ? { password, currentPassword: current } : { password });
          }}
        >
          <p className="text-sm text-muted-foreground">
            {status.data.set ? m.password_is_set() : m.password_not_set()}
          </p>
          {needsCurrent ? (
            <Field
              id={currentId}
              label={m.password_current()}
              description={m.password_current_hint()}
            >
              <Input
                id={currentId}
                type="password"
                autoComplete="current-password"
                value={current}
                maxLength={256}
                required
                onChange={(e) => setCurrent(e.target.value)}
                {...fieldAria(currentId, { description: true })}
              />
            </Field>
          ) : null}
          <Field id={id} label={m.password_new()} error={error} description={m.password_hint()}>
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={password}
              minLength={12}
              maxLength={256}
              onChange={(e) => setPassword(e.target.value)}
              {...fieldAria(id, { error: error !== undefined, description: true })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              loading={set.isPending}
              disabled={password.length === 0 || (needsCurrent && current.length === 0)}
            >
              {status.data.set ? m.password_replace() : m.password_set()}
            </Button>
            {status.data.set ? (
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline">
                    {m.password_remove()}
                  </Button>
                }
                title={m.password_remove_title()}
                description={m.password_remove_body()}
                confirmLabel={m.password_remove()}
                pending={remove.isPending}
                onConfirm={() => remove.mutate()}
              />
            ) : null}
          </div>
        </form>
      ) : null}
    </SectionCard>
  );
}
