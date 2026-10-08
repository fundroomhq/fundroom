import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  LoadingState,
  PageHeader,
  Switch,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import {
  DisableReadOnlyModuleDialog,
  isPlanLocked,
  moduleBadges,
  UNAVAILABLE_SWITCH_CLASS,
} from "../../../components/billing/module-plan.js";
import { BillingLinkIfAllowed } from "../../../components/billing/workspace-status.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { type ModuleEnablement, moduleEnablementQuery } from "../../../lib/branding-queries.js";
import { type Bootstrap, navItemsFor, useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/modules/")({ component: ModulesPage });

/*
 * Module enablement (E1.7). Its own route rather than a tab on branding: the two screens
 * share an epic, not a subject, and this one is a standing operations surface — the list a
 * founder comes back to when they want the data room switched on — not part of the one-time
 * look-and-feel pass. It is reached from the admin nav, which `admin.tsx` adds for owners and
 * admins, matching the owner-or-admin requirement the server puts on `PATCH /modules/{id}`.
 *
 * A locked module renders as a disabled switch carrying its reason rather than being hidden:
 * "the data room is on because updates needs it" is the answer to the question the founder
 * came here with, and hiding the row would leave them looking for a toggle that is not there.
 *
 * A-3: the same goes for a module the plan leaves out ("Not on your plan", with the way to
 * Billing), and one that is on but outside the plan reads "Read-only on your plan" — switching
 * it off asks first, because only a plan change turns it back on.
 */
function ModulesPage() {
  const bootstrap = useBootstrap();
  const role = bootstrap.data?.membership?.role;
  const canManage = role === "owner" || role === "admin";
  const modules = useQuery(moduleEnablementQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.modules_title()} description={m.modules_subtitle()} />
      <Card>
        <CardHeader>
          <CardTitle>{m.modules_card_title()}</CardTitle>
          <CardDescription>{m.modules_card_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          {modules.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
          {modules.isError ? <ErrorAlert error={modules.error} /> : null}
          {modules.data ? (
            modules.data.modules.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.modules_empty()}</p>
            ) : (
              <ul className="divide-y">
                {modules.data.modules.map((mod) => (
                  <ModuleRow
                    key={mod.id}
                    module={mod}
                    canManage={canManage}
                    settingsTo={settingsLinkFor(bootstrap.data, mod.id)}
                  />
                ))}
              </ul>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * E2.7: the module's first `admin.settings` entry, if it offers one. Read through `navItemsFor`
 * on a bootstrap narrowed to this module, so an entry is shown under the same rule the settings
 * hub lists it (enabled, not hidden, well-formed).
 */
function settingsLinkFor(bootstrap: Bootstrap | undefined, moduleId: string): string | undefined {
  if (!bootstrap) return undefined;
  const only = { ...bootstrap, modules: bootstrap.modules.filter((mod) => mod.id === moduleId) };
  return navItemsFor(only, "admin.settings")[0]?.to;
}

function ModuleRow({
  module,
  canManage,
  settingsTo,
}: {
  module: ModuleEnablement;
  canManage: boolean;
  settingsTo: string | undefined;
}) {
  const id = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const toggle = useGuardedMutation<unknown, boolean>({
    mutationFn: (enabled) =>
      call(
        api().PATCH("/modules/{id}", { params: { path: { id: module.id } }, body: { enabled } }),
      ),
    onSuccess: (_data, enabled) => {
      toast.success(
        enabled
          ? m.modules_enabled_toast({ module: module.id })
          : m.modules_disabled_toast({ module: module.id }),
      );
      void queryClient.invalidateQueries({ queryKey: ["modules"] });
      // The nav is built from the bootstrap's module list, so it has to be refetched too.
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const unavailable = module.locked || !canManage || toggle.isPending;
  const badges = moduleBadges(module);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Switch
        ref={switchRef}
        id={id}
        checked={module.enabled}
        // Unavailable, not disabled: stays focusable (R3 L2 / RR3 RL3, see UNAVAILABLE_SWITCH_CLASS).
        aria-disabled={unavailable || undefined}
        aria-describedby={badges.length > 0 ? `${id}-state` : undefined}
        className={UNAVAILABLE_SWITCH_CLASS}
        onCheckedChange={(on) => {
          if (unavailable) return;
          if (on !== true && module.readOnly) setConfirming(true);
          else toggle.mutate(on === true);
        }}
      />
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="font-medium">
          {module.id}
        </Label>
        {module.dependsOn.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.modules_depends_on({ list: module.dependsOn.join(", ") })}
          </p>
        ) : null}
      </div>
      {badges.length > 0 ? (
        <span id={`${id}-state`} className="flex flex-wrap gap-2">
          {badges.map((badge) => (
            <Badge key={badge} variant="secondary">
              {badge}
            </Badge>
          ))}
        </span>
      ) : null}
      {isPlanLocked(module) ? <BillingLinkIfAllowed /> : null}
      {settingsTo === undefined ? null : (
        <Link
          to={settingsTo}
          className="text-sm underline underline-offset-4"
          aria-label={m.modules_settings_named({ module: module.id })}
        >
          {m.modules_settings_link()}
        </Link>
      )}
      <DisableReadOnlyModuleDialog
        moduleId={module.id}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => toggle.mutate(false)}
        returnFocusTo={switchRef}
      />
    </li>
  );
}
