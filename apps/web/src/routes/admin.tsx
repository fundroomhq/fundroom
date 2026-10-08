import { Button, EmptyState, LoadingState } from "@fundroomhq/ui";
import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Eye } from "lucide-react";
import {
  usePastDueBanner,
  WorkspaceStatusBanner,
  WorkspaceUnavailablePanel,
} from "../components/billing/workspace-status.js";
import { Shell } from "../components/shell.js";
import { SsoRequiredScreen } from "../components/sso-sign-in.js";
import {
  EmbedAdminBlocked,
  NotFoundScreen,
  RouteErrorScreen,
} from "../components/status-screens.js";
import { ViewAsBanner } from "../components/view-as-banner.js";
import { isSsoRequired } from "../lib/api.js";
import { canSeeBilling } from "../lib/billing-queries.js";
import { useWebConfig } from "../lib/config-context.js";
import { meQuery, navItemsFor, useBootstrap, useMe, useViewAs } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";

/*
 * Admin tree. Staff only; anyone else (signed-in investor, no membership) sees the same
 * not-found screen an unknown URL shows. Never rendered inside an embed.
 */
export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ context, location }) => {
    if (context.config.tree === "embed") return;
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me === null) throw redirect({ to: "/login", search: { returnTo: location.href } });
  },
  component: AdminLayout,
});

function AdminLayout() {
  const config = useWebConfig();
  const me = useMe();
  const bootstrap = useBootstrap();
  const viewAs = useViewAs();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // E3.10: owner/admin/finance on an install that bills (the page 404s for anyone else).
  const billing = canSeeBilling(config, bootstrap.data) && viewAs === null;
  const workspaceStatus = bootstrap.data?.workspaceStatus ?? null;
  const pastDue = usePastDueBanner(billing && workspaceStatus === null);
  if (config.tree === "embed") return <EmbedAdminBlocked />;
  if (me.isPending || bootstrap.isPending) return <LoadingState label={m.common_loading()} />;
  // E3.8: the workspace enforces single sign-on and this staff session did not come from it.
  if (isSsoRequired(me.error) || isSsoRequired(bootstrap.error)) return <SsoRequiredScreen />;
  if (me.isError) return <RouteErrorScreen error={me.error} />;
  if (bootstrap.isError) return <RouteErrorScreen error={bootstrap.error} />;
  if (bootstrap.data.ssoRequired === true) {
    return <SsoRequiredScreen owner={bootstrap.data.ssoBreakGlass === true} />;
  }
  /*
   * Viewing as an investor (E2.7): every request in this workspace is served as them, so the
   * membership here is theirs and every admin API answers 404. Rather than the not-found screen
   * (which would read as "you lost admin"), say why and offer the two ways on: the portal as
   * they see it, or the banner's Exit.
   */
  if (me.data && viewAs !== null) {
    return (
      <Shell
        hostLinks
        items={[]}
        navLabel={m.admin_nav_label()}
        title={m.admin_title({ workspace: config.workspace?.name ?? config.instanceName })}
        me={me.data}
        banner={<ViewAsBanner viewAs={viewAs} />}
      >
        <EmptyState
          icon={<Eye aria-hidden="true" />}
          title={m.view_as_admin_title()}
          description={m.view_as_admin_body()}
          action={
            <Button asChild variant="outline">
              <Link to="/">{m.view_as_admin_portal()}</Link>
            </Button>
          }
        />
      </Shell>
    );
  }
  if (!me.data || bootstrap.data.membership?.kind !== "staff") return <NotFoundScreen />;

  /*
   * E3.10: the workspace is suspended or held for review. Every admin API but billing answers
   * 423 now, so the nav shrinks to billing (for those who may open it) and every other screen
   * gives way to one explanation instead of a page of errors.
   */
  if (workspaceStatus !== null) {
    const onBilling =
      billing && (pathname === "/admin/billing" || pathname.startsWith("/admin/billing/"));
    // E3.11: while the host moves the workspace, the residency page stays readable (the server
    // lets `GET /residency` through for a relocation hold) — it is where the move is shown.
    const residency =
      workspaceStatus.reason === "relocation" &&
      (bootstrap.data.permissions ?? []).includes("compliance.read");
    const onResidency =
      residency &&
      (pathname === "/admin/settings/residency" ||
        pathname.startsWith("/admin/settings/residency/"));
    return (
      <Shell
        hostLinks
        items={[
          ...(billing
            ? [
                {
                  id: "billing",
                  label: m.billing_title(),
                  to: "/admin/billing",
                  icon: "billing",
                } as const,
              ]
            : []),
          ...(residency
            ? [
                {
                  id: "residency",
                  label: m.residency_title(),
                  to: "/admin/settings/residency",
                  icon: "residency",
                } as const,
              ]
            : []),
        ]}
        navLabel={m.admin_nav_label()}
        title={m.admin_title({ workspace: config.workspace?.name ?? config.instanceName })}
        me={me.data}
        banner={
          <WorkspaceStatusBanner state={workspaceStatus} billingLink={billing && !onBilling} />
        }
      >
        {onBilling || onResidency ? (
          <Outlet />
        ) : (
          <WorkspaceUnavailablePanel state={workspaceStatus} billingLink={billing} />
        )}
      </Shell>
    );
  }

  /*
   * Module enablement has no server-side `admin.nav` slot — a module cannot offer the screen
   * that switches it off — so the kernel nav carries it here, for the same owner-or-admin
   * audience `PATCH /modules/{id}` is open to. Mail delivery (E2.6) is the same shape: its
   * routes are kernel routes with no manifest of their own, behind `access.settings`.
   */
  const role = bootstrap.data.membership?.role;
  const items = [
    { id: "overview", label: m.admin_nav_overview(), to: "/admin", icon: "dashboard", exact: true },
    ...navItemsFor(bootstrap.data, "admin.nav"),
    ...(bootstrap.data.permissions.includes("access.settings")
      ? [{ id: "mail", label: m.admin_nav_mail(), to: "/admin/mail", icon: "mail" }]
      : []),
    // E3.4: API keys and webhooks are kernel screens (keys authenticate before any module is
    // resolved; delivery needs the kernel-only `outbound`), so, like mail, the nav carries them.
    ...(bootstrap.data.permissions.includes("api-keys.read")
      ? [{ id: "api-keys", label: m.admin_nav_api_keys(), to: "/admin/api-keys", icon: "key" }]
      : []),
    ...(bootstrap.data.permissions.includes("webhooks.read")
      ? [{ id: "webhooks", label: m.admin_nav_webhooks(), to: "/admin/webhooks", icon: "webhook" }]
      : []),
    // E3.5: e-signature is kernel (an e-sign NDA closes the gate `requireMember` enforces).
    ...(bootstrap.data.permissions.includes("esign.read")
      ? [{ id: "esign", label: m.admin_nav_esign(), to: "/admin/esign", icon: "signature" }]
      : []),
    // E3.6: connections are kernel rows several modules consume (KPIs, Slack, bookings).
    ...(bootstrap.data.permissions.includes("integrations.read")
      ? [
          {
            id: "integrations",
            label: m.integrations_nav(),
            to: "/admin/integrations",
            icon: "plug",
          },
        ]
      : []),
    ...(role === "owner" || role === "admin"
      ? [{ id: "modules", label: m.admin_nav_modules(), to: "/admin/modules", icon: "settings" }]
      : []),
  ];
  return (
    <Shell
      hostLinks
      items={items}
      navLabel={m.admin_nav_label()}
      title={m.admin_title({ workspace: config.workspace?.name ?? config.instanceName })}
      me={me.data}
      search="/admin/search"
      banner={pastDue}
      headerExtra={
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft aria-hidden="true" />
            {m.admin_back_to_portal()}
          </Link>
        </Button>
      }
    >
      <Outlet />
    </Shell>
  );
}
