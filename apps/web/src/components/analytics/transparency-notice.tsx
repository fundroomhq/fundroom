import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { analyticsNoticeQuery } from "../../lib/analytics-queries.js";
import { m } from "../../paraglide/messages.js";
import { ConsentControl, EmailTrackingConsent } from "../compliance/consent-control.js";

/*
 * Investor transparency notice (design/04 §2): the portal must tell a member what this
 * workspace records about them. It lives on the member's own settings page — always in the
 * same place, one click from every screen, and out of the way of reading documents.
 *
 * The notice renders nothing when analytics is not part of this build or not enabled for the
 * workspace: the endpoint 404s and there is nothing to disclose.
 */
export function TransparencyNotice() {
  const notice = useQuery(analyticsNoticeQuery);
  if (!notice.data) return null;
  // The server's track list is the whole disclosure (E2.6: `engagement` names email opens,
  // clicks and the engagement score itself); the portal only localises the keys.
  const { mode, tracks, emailTracking } = notice.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.analytics_notice_title()}</CardTitle>
        <CardDescription>{m.analytics_notice_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {mode === "off" || tracks.length === 0 ? (
          <p>{m.analytics_notice_off()}</p>
        ) : (
          <>
            <p>{m.analytics_notice_intro()}</p>
            <ul className="list-disc space-y-1 pl-5">
              {tracks.map((t) => (
                <li key={t}>{trackLabel(t)}</li>
              ))}
            </ul>
            {/* The member's own email_tracking state, as the server decided it (mode, consent
                and GPC folded in) — so the notice never claims tracking that is not happening. */}
            {mode === "engagement" && emailTracking ? (
              <p>
                {emailTracking.active
                  ? m.analytics_notice_email_active()
                  : m.analytics_notice_email_inactive()}
              </p>
            ) : null}
            <p className="text-muted-foreground">{m.analytics_notice_rights()}</p>
          </>
        )}
        {/* Consent is unbundled from the notice (ADR-0037 decision 6): reading what is
            recorded and deciding whether it may be are two different acts. */}
        {mode === "off" ? null : <ConsentControl notice={notice.data} />}
        {/* Email tracking is its own purpose: a member can allow reading analytics and still
            refuse open/click tracking, or the other way round. Shown under GPC too (off,
            disabled, with the reason) — the member should see that it is off. */}
        {mode === "engagement" ? <EmailTrackingConsent /> : null}
      </CardContent>
    </Card>
  );
}

/** Localised names for the notice's stable track keys (`tracksFor()` on the server). */
export function trackLabel(track: string): string {
  switch (track) {
    case "document_views":
      return m.analytics_track_document_views();
    case "downloads":
      return m.analytics_track_downloads();
    case "update_views":
      return m.analytics_track_update_views();
    case "page_dwell":
      return m.analytics_track_page_dwell();
    case "browser_family":
      return m.analytics_track_browser_family();
    case "hashed_ip":
      return m.analytics_track_hashed_ip();
    case "email_opens":
      return m.analytics_track_email_opens();
    case "email_clicks":
      return m.analytics_track_email_clicks();
    case "engagement_score":
      return m.analytics_track_engagement_score();
    default:
      return track;
  }
}
