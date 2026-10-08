import { Button, EmptyState, LoadingState } from "@fundroomhq/ui";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { ExternalLink, Lock } from "lucide-react";
import { useSignOut } from "../components/account-menu.js";
import { PortalUnavailableScreen } from "../components/billing/workspace-status.js";
import { AcceptanceGate } from "../components/compliance/acceptance-gate.js";
import { Shell } from "../components/shell.js";
import { SsoRequiredScreen } from "../components/sso-sign-in.js";
import { RouteErrorScreen } from "../components/status-screens.js";
import { ViewAsBanner } from "../components/view-as-banner.js";
import { openInNewTab } from "../embed/EmbedFrame.js";
import { isSsoRequired } from "../lib/api.js";
import { workspaceScoped } from "../lib/compliance-queries.js";
import { useWebConfig } from "../lib/config-context.js";
import { type Me, meQuery, navItemsFor, useBootstrap, useMe, useViewAs } from "../lib/queries.js";
import { currentInvestorHref } from "../modules/investor-paths.js";
import { m } from "../paraglide/messages.js";

/*
 * Investor tree layout. Signed out → login with returnTo. Signed in but not a member here →
 * the no-access screen (identical whether or not the account exists elsewhere).
 */
export const Route = createFileRoute("/_portal")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me === null) {
      // E-UP-18: an old investor path (`/metrics`) comes back as its new one (`/kpis`); the old
      // one is a server path, and the sign-in would go home instead.
      throw redirect({ to: "/login", search: { returnTo: currentInvestorHref(location.href) } });
    }
  },
  component: PortalLayout,
});

function PortalLayout() {
  const config = useWebConfig();
  const me = useMe();
  const bootstrap = useBootstrap();
  const viewAs = useViewAs();

  if (me.isPending || bootstrap.isPending) return <LoadingState label={m.common_loading()} />;
  // E3.8: staff held to the workspace's single sign-on, whichever of the two said so.
  if (isSsoRequired(me.error) || isSsoRequired(bootstrap.error)) return <SsoRequiredScreen />;
  if (me.isError) return <RouteErrorScreen error={me.error} />;
  if (bootstrap.isError) return <RouteErrorScreen error={bootstrap.error} />;
  if (me.data === null) return <LoadingState label={m.common_loading()} />; // redirecting
  if (bootstrap.data.ssoRequired === true) {
    return <SsoRequiredScreen owner={bootstrap.data.ssoBreakGlass === true} />;
  }
  // E3.10: suspended or held for review. The same screen whatever the reason (investors are
  // never told it); the server refuses the portal's APIs with a plain 404 meanwhile.
  if (bootstrap.data.workspaceStatus !== null && bootstrap.data.workspaceStatus !== undefined) {
    return <PortalUnavailableScreen staff={bootstrap.data.membership?.kind === "staff"} />;
  }
  if (bootstrap.data.membership === null) return <NoAccess me={me.data} />;
  /*
   * Every investor route passes through here, so this is where an outstanding legal
   * acceptance stops (ADR-0037 decision 5). The server enforces it independently — a 403
   * `legal_acceptance_required` anywhere else refreshes the bootstrap and lands the member
   * back on exactly this screen (`createQueryClient`, `useGuardedMutation`).
   */
  // The bootstrap lists workspace-scoped documents only; the filter keeps it that way.
  const owed = workspaceScoped(bootstrap.data.pendingAcceptances);
  if (owed.length > 0) {
    // Viewing as an investor who has not accepted yet: this is what they would see, and the
    // staff member cannot accept for them (read-only), so the banner stays on top of it.
    if (viewAs !== null) {
      return (
        <>
          <div
            role="status"
            className="w-full border-b border-warning bg-warning px-4 py-2 text-sm font-medium text-warning-foreground md:px-8"
          >
            <ViewAsBanner viewAs={viewAs} />
          </div>
          <AcceptanceGate pending={owed} />
        </>
      );
    }
    return <AcceptanceGate pending={owed} />;
  }

  const items = [
    { id: "home", label: m.nav_home(), to: "/", icon: "home", exact: true },
    ...navItemsFor(bootstrap.data, "investor.nav"),
    { id: "settings", label: m.nav_settings(), to: "/settings", icon: "settings" },
  ];
  return (
    <Shell
      items={items}
      navLabel={m.nav_primary()}
      title={config.workspace?.name ?? config.instanceName}
      me={me.data}
      search="/search"
      banner={viewAs === null ? undefined : <ViewAsBanner viewAs={viewAs} />}
    >
      <Outlet />
    </Shell>
  );
}

function NoAccess({ me }: { me: Me }) {
  const config = useWebConfig();
  const signOut = useSignOut();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        icon={<Lock aria-hidden="true" />}
        title={m.no_access_title()}
        description={m.no_access_body({ name: me.session.user.displayName })}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {config.tree === "embed" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openInNewTab(config.canonicalOrigin, "/")}
              >
                <ExternalLink aria-hidden="true" />
                {m.embed_open_new_tab()}
              </Button>
            ) : null}
            <Button type="button" onClick={() => void signOut()}>
              {m.account_sign_out()}
            </Button>
          </div>
        }
      />
    </div>
  );
}
