import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@fundroomhq/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleDashed } from "lucide-react";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/admin/")({ component: AdminOverview });

/*
 * The getting-started list. Items whose screen exists link to it; the rest still say "soon",
 * so the list is honest about what a founder can actually do next rather than offering five
 * dead ends.
 */
const CHECKLIST = [
  { key: "admin_todo_access" },
  { key: "admin_todo_content" },
  { key: "admin_todo_data_room" },
  { key: "admin_todo_updates" },
  { key: "admin_todo_branding", to: "/admin/branding" },
] as const;

function AdminOverview() {
  const bootstrap = useBootstrap();
  const data = bootstrap.data;
  if (!data) return null;
  const enabled = data.modules.filter((mod) => mod.enabled);
  return (
    <div className="space-y-6">
      <PageHeader title={m.admin_overview_title()} description={m.admin_overview_subtitle()} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{m.admin_workspace_card()}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{m.admin_ws_name()}</dt>
              <dd>{data.workspace?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">{m.admin_ws_slug()}</dt>
              <dd>
                <code className="font-mono text-xs">{data.workspace?.slug ?? "—"}</code>
              </dd>
              <dt className="text-muted-foreground">{m.admin_ws_offering()}</dt>
              <dd>
                <Badge variant="outline">{data.workspace?.offeringStatus ?? "—"}</Badge>
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{m.admin_modules_card()}</CardTitle>
            <CardDescription>
              {m.admin_modules_subtitle({ count: String(enabled.length) })}
            </CardDescription>
            <CardAction>
              <Link to="/admin/modules" className="text-sm underline underline-offset-4">
                {m.admin_modules_manage()}
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {enabled.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.admin_modules_empty()}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {enabled.map((mod) => (
                  <li key={mod.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{mod.id}</span>
                    <span className="text-muted-foreground">
                      {m.common_version_short({ version: mod.version })}
                    </span>
                    {mod.hidden ? (
                      <Badge variant="secondary">{m.admin_module_hidden()}</Badge>
                    ) : null}
                    {Object.entries(mod.flags)
                      .filter(([, on]) => on)
                      .map(([flag]) => (
                        <Badge key={flag} variant="outline">
                          {flag}
                        </Badge>
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{m.admin_you_card()}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{m.profile_col_role()}</dt>
              <dd>{data.membership?.role ?? "—"}</dd>
              <dt className="text-muted-foreground">{m.admin_permissions()}</dt>
              <dd>{String(data.permissions.length)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{m.admin_getting_started()}</CardTitle>
          <CardDescription>{m.admin_getting_started_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {CHECKLIST.map((item) => (
              <li key={item.key} className="flex items-center gap-2 text-muted-foreground">
                <CircleDashed aria-hidden="true" className="size-4" />
                {"to" in item ? (
                  <Link to={item.to} className="underline underline-offset-4">
                    {m[item.key]()}
                  </Link>
                ) : (
                  <>
                    <span>{m[item.key]()}</span>
                    <Badge variant="outline">{m.admin_todo_soon()}</Badge>
                  </>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
