import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Queries for the notify module: staff notification preferences and the in-app inbox (E1.5),
 * plus schedules, quiet hours and workspace chat channels (E2.6).
 */
export type NotifyCadence = FundRoomSchemas["NotifyCadence"];
export type NotifyEventType = FundRoomSchemas["NotifyEventType"];
export type NotifyPreference = FundRoomSchemas["NotifyPreference"];
export type NotifyPreferences = FundRoomSchemas["NotifyPreferences"];
export type NotifySettings = FundRoomSchemas["NotifySettings"];
export type NotifyInbox = FundRoomSchemas["NotifyInbox"];
export type NotifyInboxItem = FundRoomSchemas["NotifyInboxItem"];
/**
 * A chat channel. Two kinds (E3.6): `slack`, an incoming-webhook URL the admin pasted (write-only;
 * only its last four characters come back as `urlHint`), and `slack_app`, a channel of the Slack
 * workspace connected in the Integrations hub (`slackChannelId`/`slackChannelName`, no URL).
 */
export type NotifyChannel = FundRoomSchemas["NotifyChannel"];
export type NotifyChannelKind = FundRoomSchemas["NotifyChannelKind"];
export type NotifyChannelEventType = FundRoomSchemas["NotifyChannelEventType"];
/** A channel the connected Slack app can post to (`GET /notify/slack/channels`). */
export type SlackChannelRef = FundRoomSchemas["NotifySlackChannel"];
export type NotifyChannelTestResult = FundRoomSchemas["NotifyChannelTestResult"];

/**
 * The order the preferences form renders in, and the order the server answers in. Written out
 * rather than derived so a server that gains a type the SPA has no label for does not render a
 * blank legend: the list is the SPA's own contract with `m.notify_event_*`.
 */
export const NOTIFY_EVENT_TYPES: readonly NotifyEventType[] = [
  "document.viewed",
  "document.downloaded",
  "update.replied",
  "round.interest_submitted",
  "round.verification_requested",
  "round.commitment_created",
  "analytics.hot_lead",
  "access_request.submitted",
  "access_review.overdue",
  "membership.delegate_added",
  "qa.question_asked",
  "qa.question_assigned",
  "qa.answer_submitted",
  "qa.answer_released",
  "qa.question_declined",
  "qa.question_due",
  // E3.5: staff alerts (`esign.read` / `round.manage`) and the investor's confirmation email.
  "esign.envelope_attention",
  "round.signature_completed",
  "round.commitment_confirmed",
  // E3.6: a connected provider needs attention (addressed to `integrations.manage`).
  "integration.connection_unhealthy",
  // E3.7: the investor's own accreditation verification (expiring soon / settled), by email.
  "round.verification_expiring",
  "round.verification_decided",
];

/**
 * The types a staff member can tune on the preferences form: all but those that only ever reach
 * an investor by email — `qa.answer_released` and `qa.question_declined` (the investor who asked)
 * and `round.commitment_confirmed` (the investor whose money arrived, E3.5). A staff toggle for
 * them would do nothing.
 */
const ASKER_ONLY_EVENT_TYPES: readonly NotifyEventType[] = [
  "qa.answer_released",
  "qa.question_declined",
  "round.commitment_confirmed",
  "round.verification_expiring",
  "round.verification_decided",
];
export const NOTIFY_STAFF_EVENT_TYPES: readonly NotifyEventType[] = NOTIFY_EVENT_TYPES.filter(
  (t) => !ASKER_ONLY_EVENT_TYPES.includes(t),
);

export const NOTIFY_CADENCES: readonly NotifyCadence[] = ["instant", "daily", "weekly", "off"];

/** The workspace-level events a chat channel can announce, in the order the form lists them. */
export const NOTIFY_CHANNEL_EVENT_TYPES: readonly NotifyChannelEventType[] = [
  "analytics.hot_lead",
  "round.interest_submitted",
  "round.commitment_created",
  "round.verification_requested",
  "access_request.submitted",
  "access_review.overdue",
  "qa.question_asked",
  // E3.6: a connected provider (QuickBooks, Xero, Stripe, Slack, Calendly) stopped working.
  "integration.connection_unhealthy",
];

/** 0 = Sunday … 6 = Saturday, as the API counts them. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, h) => h);

/**
 * The IANA zones this browser knows, for the timezone select. The stored zone is always in the
 * list even if this browser does not know it (a zone renamed since, or a server with newer data),
 * so the select never silently shows a different value from the one saved.
 */
export function timezoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const set = new Set(zones);
  set.add("UTC");
  if (current !== "") set.add(current);
  return [...set].sort();
}

/** The browser's own zone, or `undefined` when it cannot say. */
export function browserTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === "" ? undefined : zone;
  } catch {
    return undefined;
  }
}

/** Two-digit local hour, e.g. `08:00`. Not locale-formatted: it labels a wall-clock hour. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export const notifyPreferencesQuery = queryOptions({
  queryKey: ["notify", "preferences"],
  queryFn: () => call(api().GET("/notify/preferences")),
});

/** The inbox, newest first, a page at a time. `archived` includes archived items as well. */
export function notifyInboxQuery(options: { archived?: boolean; limit?: number } = {}) {
  const limit = options.limit ?? 50;
  const archived = options.archived === true;
  return infiniteQueryOptions({
    queryKey: ["notify", "inbox", { archived, limit }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/notify/inbox", {
          params: {
            query: {
              limit,
              ...(archived ? { archived: "true" as const } : {}),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: NotifyInbox) => last.nextCursor ?? undefined,
  });
}

export const NOTIFY_CHANNELS_KEY = ["notify", "channels"] as const;

export const notifyChannelsQuery = queryOptions({
  queryKey: NOTIFY_CHANNELS_KEY,
  queryFn: () => call(api().GET("/notify/channels")),
});

export const SLACK_CHANNELS_KEY = ["notify", "slack", "channels"] as const;

export const slackChannelsQuery = queryOptions({
  queryKey: SLACK_CHANNELS_KEY,
  queryFn: () => call(api().GET("/notify/slack/channels")),
  // A channel list is cheap to re-ask for and changes when somebody invites the app somewhere.
  staleTime: 30_000,
  retry: false,
});
