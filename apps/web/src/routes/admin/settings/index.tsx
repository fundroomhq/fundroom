import { Card, CardDescription, CardHeader, CardTitle, PageHeader } from "@fundroomhq/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { canSeeAi } from "../../../lib/ai-queries.js";
import { canSeeBilling } from "../../../lib/billing-queries.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { iconFor } from "../../../lib/icons.js";
import { navItemsFor, useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/")({ component: SettingsHub });

/*
 * The settings hub (E2.7). Every manifest with a workspace settings screen offers it in the
 * `admin.settings` slot, so this page is a directory, not a form: it lists those entries (from
 * enabled modules only — a disabled module's settings screen has nothing to configure) and,
 * for owners, the danger zone. Whether the viewer may change what a linked screen shows is that
 * screen's question to answer; listing the link costs nothing and hiding it would make a
 * read-only admin wonder where the setting went.
 */
function SettingsHub() {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  // E3.10: the `billing` manifest is required (so always enabled), but its page exists only on
  // an install that bills and only for `billing.read` holders — anyone else would get a 404.
  const billing = canSeeBilling(config, bootstrap.data);
  // E3.12: likewise the `ai` manifest's AI assist page only on an install with a model.
  const ai = canSeeAi(config, bootstrap.data);
  const items = navItemsFor(bootstrap.data, "admin.settings").filter(
    (item) => (billing || item.to !== "/admin/billing") && (ai || item.to !== "/admin/settings/ai"),
  );
  const permissions = bootstrap.data?.permissions ?? [];
  const isOwner =
    permissions.includes("access.transfer") || permissions.includes("access.delete_workspace");
  return (
    <div className="space-y-6">
      <PageHeader title={m.adminsettings_title()} description={m.adminsettings_subtitle()} />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.adminsettings_empty()}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const Icon = iconFor(item.icon);
            return (
              <li key={`${item.id}-${item.to}`}>
                <Card className="relative h-full transition-colors hover:bg-muted/40">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                      <Link
                        to={item.to}
                        className="underline underline-offset-4 after:absolute after:inset-0"
                      >
                        {item.label}
                      </Link>
                      <ChevronRight aria-hidden="true" className="ml-auto size-4" />
                    </CardTitle>
                  </CardHeader>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {isOwner ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <TriangleAlert aria-hidden="true" className="size-4" />
              <Link to="/admin/settings/danger" className="underline underline-offset-4">
                {m.adminsettings_danger_link()}
              </Link>
            </CardTitle>
            <CardDescription>{m.adminsettings_danger_body()}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
    </div>
  );
}
