import { cn, PageHeader } from "@fundroomhq/ui";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/_portal/settings")({ component: SettingsLayout });

const TABS = [
  { to: "/settings", label: () => m.settings_tab_profile(), exact: true },
  { to: "/settings/security", label: () => m.settings_tab_security(), exact: false },
] as const;

/** E3.2: only an investor can have delegates, so only an investor sees the tab. */
const DELEGATES_TAB = {
  to: "/settings/delegates",
  label: () => m.settings_tab_delegates(),
  exact: false,
} as const;

/** Section nav rendered as links (real navigation, so no tabpanel semantics). */
function SettingsLayout() {
  const bootstrap = useBootstrap();
  const tabs =
    bootstrap.data?.membership?.role === "investor" ? [...TABS, DELEGATES_TAB] : [...TABS];
  return (
    <div className="space-y-6">
      <PageHeader title={m.settings_title()} description={m.settings_subtitle()} />
      <nav aria-label={m.settings_tabs_label()}>
        <ul className="inline-flex items-center gap-1 rounded-lg bg-muted p-1 text-sm">
          {tabs.map((tab) => (
            <li key={tab.to}>
              <Link
                to={tab.to}
                activeOptions={{ exact: tab.exact }}
                className="inline-flex h-8 items-center rounded-md px-3 text-muted-foreground transition-colors hover:text-foreground"
                activeProps={{
                  className: cn(
                    "inline-flex h-8 items-center rounded-md px-3 transition-colors",
                    "bg-background text-foreground shadow-sm",
                  ),
                  "aria-current": "page",
                }}
              >
                {tab.label()}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
