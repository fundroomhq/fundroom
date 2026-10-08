import {
  AppShell,
  AppShellSidebar,
  Badge,
  Button,
  NavList,
  ThemeToggle,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Building2,
  KeyRound,
  LogOut,
  type LucideIcon,
  Scale,
  Server,
  Shield,
  ShieldAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "../../lib/api.js";
import { endOperatorSession, PLATFORM_KEY, type PlatformMe } from "../../lib/platform-queries.js";
import { m } from "../../paraglide/messages.js";
import { FooterLinks } from "../footer.js";

interface PlatformNavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Workspaces is the console's index, so it also owns `/platform/workspaces/*`. */
  prefixes: readonly string[];
  exact?: boolean;
}

function navItems(): PlatformNavItem[] {
  return [
    {
      id: "workspaces",
      label: m.platform_nav_workspaces(),
      to: "/platform",
      icon: Building2,
      prefixes: ["/platform/workspaces"],
      exact: true,
    },
    {
      id: "plans",
      label: m.platform_nav_plans(),
      to: "/platform/plans",
      icon: Scale,
      prefixes: [],
    },
    {
      id: "cells",
      label: m.platform_nav_cells(),
      to: "/platform/cells",
      icon: Server,
      prefixes: [],
    },
    {
      id: "sanctions",
      label: m.platform_nav_sanctions(),
      to: "/platform/sanctions",
      icon: ShieldAlert,
      prefixes: [],
    },
    {
      id: "audit",
      label: m.platform_nav_audit(),
      to: "/platform/audit",
      icon: Shield,
      prefixes: [],
    },
    {
      id: "health",
      label: m.platform_nav_health(),
      to: "/platform/health",
      icon: Activity,
      prefixes: [],
    },
    {
      id: "operators",
      label: m.platform_nav_operators(),
      to: "/platform/operators",
      icon: KeyRound,
      prefixes: [],
    },
  ];
}

function isActive(item: PlatformNavItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/u, "") || "/";
  if (path === item.to) return true;
  if (!item.exact && path.startsWith(`${item.to}/`)) return true;
  return item.prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The operator console's chrome (E3.10). Deliberately not the workspace `Shell`: there is no
 * workspace, no bootstrap and no tenant account menu here — the only identity on screen is the
 * operator session, and the only account action is ending it.
 */
export function PlatformShell({ me, children }: { me: PlatformMe; children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: endOperatorSession,
    // `resetQueries` drops every console answer and refetches `/platform/me`, whose 404 is what
    // puts the sign-in gate back — the same path an expired session takes.
    onSuccess: () => void queryClient.resetQueries({ queryKey: PLATFORM_KEY }),
    onError: (error) => toast.error(describeError(error).body),
  });
  const items = navItems().map((item) => {
    const Icon = item.icon;
    return {
      id: item.id,
      label: item.label,
      to: item.to,
      icon: <Icon aria-hidden="true" />,
      active: isActive(item, pathname),
    };
  });
  return (
    <AppShell
      skipToContentLabel={m.nav_skip_to_content()}
      menuLabel={m.nav_menu()}
      sidebar={
        <AppShellSidebar>
          <p className="px-1 text-sm font-semibold">{m.platform_title()}</p>
          <NavList
            ariaLabel={m.platform_nav_label()}
            items={items}
            render={(item, props) => (
              <Link to={item.to} {...props}>
                {item.icon}
                <span>{item.label}</span>
              </Link>
            )}
          />
        </AppShellSidebar>
      }
      header={
        <>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm">
              {m.platform_signed_in_as({ who: me.email ?? me.displayName })}
            </span>
            <Badge variant="outline">{m.platform_cell({ cell: me.cellId })}</Badge>
          </div>
          <ThemeToggle
            labels={{
              light: m.theme_light(),
              dark: m.theme_dark(),
              system: m.theme_system(),
              toggle: m.theme_toggle(),
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOut aria-hidden="true" />
            {m.platform_sign_out()}
          </Button>
        </>
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="flex-1">{children}</div>
        <FooterLinks className="mt-12 border-t pt-4" hostLinks />
      </div>
    </AppShell>
  );
}
