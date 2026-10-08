import { AppShell, AppShellHeader, AppShellSidebar, NavList, ThemeToggle } from "@fundroomhq/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useWebConfig } from "../lib/config-context.js";
import { iconFor } from "../lib/icons.js";
import type { Me, NavItem } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";
import { AccountMenu } from "./account-menu.js";
import { FooterLinks } from "./footer.js";
import { HeaderSearch, type SearchTarget } from "./search/search-field.js";

export interface ShellNavItem extends Omit<NavItem, "order"> {
  readonly exact?: boolean;
}

/**
 * Portal and admin chrome: sidebar nav from module slots, header with workspace search, theme
 * and account, and a footer under the page.
 */
export function Shell({
  items,
  navLabel,
  title,
  headerExtra,
  banner,
  search,
  me,
  hostLinks = false,
  children,
}: {
  items: readonly ShellNavItem[];
  navLabel: string;
  title: string;
  headerExtra?: ReactNode;
  /** A persistent strip above the header (the view-as banner, E2.7). */
  banner?: ReactNode;
  /** Where the header search box sends a query (E2.8); no box when omitted. */
  search?: SearchTarget | undefined;
  me: Me;
  /** A-5: the host's footer links (admin, never the investor portal). */
  hostLinks?: boolean;
  children: ReactNode;
}) {
  const config = useWebConfig();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navItems = items.map((item) => {
    const Icon = iconFor(item.icon);
    return {
      id: item.id,
      label: item.label,
      to: item.to,
      icon: <Icon aria-hidden="true" />,
      active: item.exact
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(`${item.to}/`),
    };
  });
  return (
    <AppShell
      skipToContentLabel={m.nav_skip_to_content()}
      menuLabel={m.nav_menu()}
      fullHeight={config.tree !== "embed"}
      banner={banner}
      sidebar={
        <AppShellSidebar title={title}>
          {/* The workspace identity, from the boot config rather than a query, so it is
              there on the first paint next to the palette it belongs to. The logo is
              decorative: the name sits beside it, so a second announcement would be noise. */}
          {config.branding === null ? null : (
            <div data-slot="brand-mark" className="flex min-w-0 items-center gap-2 px-1">
              {config.branding.logoUrl === null ? null : (
                <img
                  src={config.branding.logoUrl}
                  alt=""
                  className="h-7 w-auto max-w-32 shrink-0 object-contain"
                />
              )}
              <span className="truncate text-sm font-semibold">{config.branding.name}</span>
            </div>
          )}
          <NavList
            ariaLabel={navLabel}
            items={navItems}
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
        <AppShellHeader>
          {headerExtra}
          {search === undefined ? <div className="flex-1" /> : <HeaderSearch to={search} />}
          <ThemeToggle
            labels={{
              light: m.theme_light(),
              dark: m.theme_dark(),
              system: m.theme_system(),
              toggle: m.theme_toggle(),
            }}
          />
          <AccountMenu me={me} />
        </AppShellHeader>
      }
    >
      <div className="flex min-h-full flex-col">
        <div className="flex-1">{children}</div>
        <FooterLinks className="mt-12 border-t pt-4" hostLinks={hostLinks} />
      </div>
    </AppShell>
  );
}
