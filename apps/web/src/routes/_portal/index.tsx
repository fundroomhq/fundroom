import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { PageRenderer } from "../../components/content/page-renderer.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { BookingCard } from "../../components/portal/booking-card.js";
import { isCode } from "../../lib/api.js";
import { useWebConfig } from "../../lib/config-context.js";
import { iconFor } from "../../lib/icons.js";
import { navItemsFor, renderedPageQuery, useBootstrap, useMe } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

export const Route = createFileRoute("/_portal/")({ component: Home });

/**
 * Investor home = the published `home` content page (E1.2), followed by the module tiles so
 * the sections of the portal stay one click away.
 */
function Home() {
  const config = useWebConfig();
  const me = useMe();
  const bootstrap = useBootstrap();
  const page = useQuery(renderedPageQuery("home"));
  const name = me.data?.session.user.displayName ?? "";
  const workspace =
    bootstrap.data?.workspace?.name ?? config.workspace?.name ?? config.instanceName;
  const items = navItemsFor(bootstrap.data, "investor.nav");
  const isStaff = bootstrap.data?.membership?.kind === "staff";
  return (
    <div className="space-y-10">
      <PageHeader title={m.home_welcome({ name })} description={m.home_subtitle({ workspace })} />
      {page.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {page.isError && !isCode(page.error, "not_found") ? <ErrorAlert error={page.error} /> : null}
      {page.data ? <PageRenderer page={page.data} showAudience={isStaff} /> : null}
      {bootstrap.data?.bookingLinksAvailable === true ? <BookingCard /> : null}
      {items.length === 0 ? (
        page.data === undefined && bootstrap.data?.bookingLinksAvailable !== true ? (
          <EmptyState
            icon={<Inbox aria-hidden="true" />}
            title={m.home_empty_title()}
            description={m.home_empty_body()}
          />
        ) : null
      ) : (
        <section aria-labelledby="home-sections">
          <h2 id="home-sections" className="mb-3 text-sm font-medium text-muted-foreground">
            {m.home_sections()}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const Icon = iconFor(item.icon);
              return (
                <li key={item.id}>
                  <Card className="h-full transition-colors hover:bg-accent/40">
                    <Link
                      to={item.to}
                      className="block h-full rounded-xl focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <CardHeader>
                        <Icon aria-hidden="true" className="size-5 text-primary" />
                        <CardTitle>{item.label}</CardTitle>
                        <CardDescription>{m.home_open_section()}</CardDescription>
                      </CardHeader>
                      <CardContent />
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
