import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ExternalLink } from "lucide-react";
import { myBookingLinksQuery } from "../../lib/integrations-queries.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * "Book time" on the investor home (E3.6): the Cal.com / Calendly links this member's audience
 * admits, in the admin's order. The page is only rendered when the bootstrap says at least one
 * link is visible (`bookingLinksAvailable`), so an empty answer (a link disabled since) renders
 * nothing rather than an empty card. Links open the vendor in a new tab with no opener and no
 * referrer: nothing of the portal URL travels to the vendor, and no embed means no CSP change.
 * Shown under view-as too — the links are what the investor would see and are harmless.
 */
export function BookingCard() {
  const links = useQuery(myBookingLinksQuery);
  if (links.isPending) return <LoadingState lines={1} label={m.common_loading()} />;
  if (links.isError) return <ErrorAlert error={links.error} />;
  if (links.data.links.length === 0) return null;
  return (
    <section aria-labelledby="home-booking">
      <Card>
        <CardHeader>
          <CalendarClock aria-hidden="true" className="size-5 text-primary" />
          <CardTitle>
            <h2 id="home-booking">{m.booking_portal_title()}</h2>
          </CardTitle>
          <CardDescription>{m.booking_portal_body()}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {links.data.links.map((link) => (
              <li key={link.id}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                >
                  {link.label}
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">{m.integrations_opens_new_tab()}</span>
                </a>
                {link.description === null ? null : (
                  <p className="text-sm text-muted-foreground">{link.description}</p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
