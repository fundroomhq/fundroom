import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Label,
  LoadingState,
  PageHeader,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useId, useState } from "react";
import { personName } from "../../../components/access/common.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { TypedConfirmDialog } from "../../../components/typed-confirm-dialog.js";
import { formatDate } from "../../../lib/format.js";
import { peopleQuery, useBootstrap } from "../../../lib/queries.js";
import {
  dangerErrorMessage,
  deleteWorkspace,
  errorReason,
  revokeAllSessions,
  transferOwnership,
} from "../../../lib/settings-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/danger")({ component: DangerPage });

/*
 * The danger zone (E2.7). Three owner-only actions, each behind a fresh session (step-up via
 * `useGuardedMutation`) and a typed confirmation of the workspace slug — the server checks the
 * same slug, so the dialog's gate and the API's gate are one rule, not two.
 *
 *  - **Transfer ownership** to an active staff member; the caller drops to admin unless they
 *    keep ownership too.
 *  - **Revoke all sessions** of every investor (and, optionally, staff — except the caller's
 *    own session, so the owner doing this is not signed out mid-incident).
 *  - **Delete the workspace.** A soft delete: purged after 30 days, restorable until then by an
 *    operator with `fundroom workspace restore`, refused outright under legal hold. Every
 *    session serving the workspace is revoked, including this one, so on success the screen
 *    leaves for the sign-in page instead of waiting for the next request to 401.
 */
function DangerPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const canTransfer = permissions.includes("access.transfer");
  const canDelete = permissions.includes("access.delete_workspace");
  if (!canTransfer && !canDelete) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.danger_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  const slug = bootstrap.data?.workspace?.slug ?? "";
  const selfId = bootstrap.data?.membership?.id;
  return (
    <div className="space-y-6">
      <PageHeader title={m.danger_title()} description={m.danger_subtitle({ slug })} />
      <p className="text-sm">
        <Link to="/admin/settings" className="underline underline-offset-4">
          {m.adminsettings_back()}
        </Link>
      </p>
      {canTransfer ? (
        <>
          <TransferCard slug={slug} selfId={selfId} />
          <RevokeAllCard slug={slug} />
        </>
      ) : null}
      {canDelete ? <DeleteCard slug={slug} /> : null}
    </div>
  );
}

function DangerError({ error }: { error: unknown }) {
  // The only workspace of a single-tenant instance is not deleted from here (it would leave an
  // empty instance): the operator decommissions the instance instead.
  const special =
    errorReason(error) === "last_workspace"
      ? m.danger_error_last_workspace()
      : dangerErrorMessage(error);
  if (special === undefined) return <ErrorAlert error={error} />;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.danger_error_title()}</AlertTitle>
      <AlertDescription>{special}</AlertDescription>
    </Alert>
  );
}

function TransferCard({ slug, selfId }: { slug: string; selfId: string | undefined }) {
  const ids = useId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const staff = useQuery(peopleQuery({ kind: "staff", status: "active" }));
  const candidates = (staff.data?.items ?? []).filter(
    (p) => p.membershipId !== selfId && p.status === "active" && p.kind === "staff",
  );
  const [target, setTarget] = useState("");
  const [keepOwner, setKeepOwner] = useState(false);
  const chosen = candidates.find((p) => p.membershipId === target);
  const transfer = useGuardedMutation({
    mutationFn: () => transferOwnership({ toMembershipId: target, confirm: slug, keepOwner }),
    onSuccess: () => {
      toast.success(m.danger_transfer_done({ name: chosen ? personName(chosen) : "" }));
      void queryClient.invalidateQueries({ queryKey: ["access"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
      if (!keepOwner) void navigate({ to: "/admin/settings" });
    },
  });
  return (
    <Card className="max-w-3xl border-destructive/50">
      <CardHeader>
        <CardTitle>{m.danger_transfer_title()}</CardTitle>
        <CardDescription>{m.danger_transfer_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {staff.isPending ? <LoadingState lines={1} label={m.common_loading()} /> : null}
        {staff.isError ? <ErrorAlert error={staff.error} /> : null}
        {staff.data ? (
          candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.danger_transfer_no_candidates()}</p>
          ) : (
            <>
              <Field id={`${ids}-target`} label={m.danger_transfer_target()} className="max-w-sm">
                <NativeSelect
                  id={`${ids}-target`}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">{m.danger_transfer_pick()}</option>
                  {candidates.map((p) => (
                    <option key={p.membershipId} value={p.membershipId}>
                      {personName(p)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${ids}-keep`}
                  checked={keepOwner}
                  onCheckedChange={(on) => setKeepOwner(on === true)}
                />
                <Label htmlFor={`${ids}-keep`} className="font-normal">
                  {m.danger_transfer_keep_owner()}
                </Label>
              </div>
              {transfer.isError ? <DangerError error={transfer.error} /> : null}
              <TypedConfirmDialog
                trigger={
                  <Button type="button" variant="destructive" disabled={chosen === undefined}>
                    {m.danger_transfer_button()}
                  </Button>
                }
                title={m.danger_transfer_confirm_title({
                  name: chosen ? personName(chosen) : "",
                })}
                description={
                  keepOwner ? m.danger_transfer_confirm_keep() : m.danger_transfer_confirm_drop()
                }
                phrase={slug}
                confirmLabel={m.danger_transfer_button()}
                pending={transfer.isPending}
                onConfirm={() => transfer.mutate()}
              />
            </>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function RevokeAllCard({ slug }: { slug: string }) {
  const ids = useId();
  const queryClient = useQueryClient();
  const [includeStaff, setIncludeStaff] = useState(false);
  const revoke = useGuardedMutation({
    mutationFn: () => revokeAllSessions({ confirm: slug, includeStaff }),
    onSuccess: (result) => {
      toast.success(m.danger_revoke_done({ count: result.revoked }));
      void queryClient.invalidateQueries({ queryKey: ["access"] });
    },
  });
  return (
    <Card className="max-w-3xl border-destructive/50">
      <CardHeader>
        <CardTitle>{m.danger_revoke_title()}</CardTitle>
        <CardDescription>{m.danger_revoke_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2">
          <Checkbox
            id={`${ids}-staff`}
            checked={includeStaff}
            onCheckedChange={(on) => setIncludeStaff(on === true)}
          />
          <Label htmlFor={`${ids}-staff`} className="font-normal">
            {m.danger_revoke_include_staff()}
          </Label>
        </div>
        {revoke.isError ? <DangerError error={revoke.error} /> : null}
        <TypedConfirmDialog
          trigger={
            <Button type="button" variant="destructive">
              {m.danger_revoke_button()}
            </Button>
          }
          title={m.danger_revoke_confirm_title()}
          description={
            includeStaff ? m.danger_revoke_confirm_staff() : m.danger_revoke_confirm_external()
          }
          phrase={slug}
          confirmLabel={m.danger_revoke_button()}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate()}
        />
      </CardContent>
    </Card>
  );
}

function DeleteCard({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useGuardedMutation({
    mutationFn: () => deleteWorkspace(slug),
    onSuccess: (result) => {
      toast.success(m.danger_delete_done({ date: formatDate(result.purgeAfter) }), {
        duration: 15_000,
      });
      // This session was revoked with every other one serving the workspace: drop everything
      // cached about it and leave, rather than letting the next background refetch 401.
      queryClient.clear();
      void navigate({ to: "/login", search: { returnTo: "/" } });
    },
  });
  return (
    <Card className="max-w-3xl border-destructive">
      <CardHeader>
        <CardTitle className="text-destructive">{m.danger_delete_title()}</CardTitle>
        <CardDescription>{m.danger_delete_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{m.danger_delete_point_window()}</li>
          <li>
            {m.danger_delete_point_restore_before()}{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              fundroom workspace restore {slug}
            </code>
            {m.danger_delete_point_restore_after()}
          </li>
          <li>{m.danger_delete_point_sessions()}</li>
          <li>{m.danger_delete_point_legal_hold()}</li>
        </ul>
        {remove.isError ? <DangerError error={remove.error} /> : null}
        <TypedConfirmDialog
          trigger={
            <Button type="button" variant="destructive">
              {m.danger_delete_button()}
            </Button>
          }
          title={m.danger_delete_confirm_title({ slug })}
          description={m.danger_delete_confirm_body()}
          phrase={slug}
          confirmLabel={m.danger_delete_button()}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </CardContent>
    </Card>
  );
}
