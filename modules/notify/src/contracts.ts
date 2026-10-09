import { TimestampSchema, trimmedText, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import { CHANNEL_EVENT_TYPES, NOTIFY_EVENT_TYPES } from "./rules.js";
import { isValidTimezone } from "./schedule.js";

/*
 * Route schemas for `/api/v1/notify/*`. Part of the OpenAPI document the SDK is generated
 * from, so names (`.openapi("…")`) are stable API.
 */
export const NotifyEventTypeSchema = z.enum(NOTIFY_EVENT_TYPES).openapi("NotifyEventType");
export const CadenceSchema = z.enum(["instant", "daily", "weekly", "off"]).openapi("NotifyCadence");

export const PreferenceSchema = z
  .object({ eventType: NotifyEventTypeSchema, cadence: CadenceSchema, isDefault: z.boolean() })
  .openapi("NotifyPreference");

const Hour = z.number().int().min(0).max(23);

export const QuietHoursSchema = z
  .object({
    /** Local hour the quiet window starts (inclusive). */
    start: Hour,
    /** Local hour it ends (exclusive); before `start` wraps midnight. */
    end: Hour,
  })
  .refine((q) => q.start !== q.end, { message: "start and end must differ", path: ["end"] })
  .openapi("NotifyQuietHours");

export const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: "not an IANA timezone this server knows" })
  .openapi({ example: "Europe/London", description: "IANA timezone name." });

export const SettingsSchema = z
  .object({
    emailEnabled: z.boolean(),
    timezone: z.string(),
    /** Local hour of the daily digest (and of the weekly one). */
    digestHour: Hour,
    /** Weekly digest day: 0 = Sunday … 6 = Saturday. */
    weeklyDay: z.number().int().min(0).max(6),
    /** Instant emails inside this window wait until it ends; the inbox fills regardless. */
    quietHours: z.union([QuietHoursSchema, z.null()]),
  })
  .openapi("NotifySettings");

export const PreferencesSchema = z
  .object({ preferences: z.array(PreferenceSchema), settings: SettingsSchema })
  .openapi("NotifyPreferences");

export const UpdatePreferencesBody = z
  .object({
    preferences: z
      .array(z.object({ eventType: NotifyEventTypeSchema, cadence: CadenceSchema }))
      .max(NOTIFY_EVENT_TYPES.length),
    settings: z
      .object({
        emailEnabled: z.boolean().optional(),
        timezone: TimezoneSchema.optional(),
        digestHour: Hour.optional(),
        weeklyDay: z.number().int().min(0).max(6).optional(),
        /** `null` turns quiet hours off. */
        quietHours: z.union([QuietHoursSchema, z.null()]).optional(),
      })
      .optional(),
  })
  .openapi("NotifyUpdatePreferences");

export const InboxActorSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    kind: z.enum(["staff", "external"]),
    role: z.string(),
  })
  .openapi("NotifyInboxActor");

export const InboxItemSchema = z
  .object({
    id: UuidSchema,
    eventType: NotifyEventTypeSchema,
    createdAt: TimestampSchema,
    sentAt: z.union([TimestampSchema, z.null()]),
    readAt: z.union([TimestampSchema, z.null()]),
    archivedAt: z.union([TimestampSchema, z.null()]),
    actor: z.union([InboxActorSchema, z.null()]),
    /**
     * Who the alert is about when no member acted: an access request's requester name (E3.1),
     * read at render time so an erased requester shows the pseudonym. Null otherwise, or when
     * the subject no longer exists.
     */
    subjectName: z.union([z.string(), z.null()]),
    resourceKind: z.union([z.string(), z.null()]),
    resourceId: z.union([UuidSchema, z.null()]),
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi("NotifyInboxItem");

export const InboxSchema = z
  .object({
    items: z.array(InboxItemSchema),
    /** Unread, not archived — independent of the page. */
    unread: z.number().int(),
    /** Pass as `cursor` for the next (older) page; null on the last page. */
    nextCursor: z.union([z.string(), z.null()]),
  })
  .openapi("NotifyInbox");

export const InboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  /** `true` includes archived rows. */
  archived: z.enum(["true", "false"]).optional(),
  /** `true` lists unread rows only. */
  unread: z.enum(["true", "false"]).optional(),
});

export const MarkReadBody = z
  .object({ ids: z.array(UuidSchema).max(500).optional() })
  .openapi("NotifyMarkRead");

export const ReadAllBody = z
  .object({
    /** Only rows created at or before this instant (what the screen showed); default now. */
    upTo: TimestampSchema.optional(),
  })
  .openapi("NotifyReadAll");

export const ArchiveBody = z
  .object({
    ids: z.array(UuidSchema).min(1).max(500),
    /** `false` restores archived rows. Default `true`. */
    archived: z.boolean().default(true),
  })
  .openapi("NotifyArchive");

export const MarkReadResultSchema = z
  .object({ updated: z.number().int() })
  .openapi("NotifyMarkReadResult");

// --- channels (notify.manage) --------------------------------------------------------------

export const ChannelEventTypeSchema = z.enum(CHANNEL_EVENT_TYPES).openapi("NotifyChannelEventType");

/** The webhook URL is write-only: it is accepted here and never appears in any response. */
const WebhookUrl = z
  .string()
  .min(12)
  .max(500)
  .openapi({ description: "Slack incoming-webhook URL. Write-only: never returned." });

/** Slack's channel id (`C…` public, `G…`/`C…` private). */
const SlackChannelId = z
  .string()
  .regex(/^[A-Z0-9]{1,40}$/u, "a Slack channel id")
  .openapi({
    example: "C0123ABCD",
    description: "Slack channel id (from `GET /notify/slack/channels`).",
  });

export const ChannelKindSchema = z.enum(["slack", "slack_app"]).openapi("NotifyChannelKind");

export const ChannelDisabledReasonSchema = z
  .enum(["not_found", "rejected", "invalid_url", "not_connected"])
  .openapi("NotifyChannelDisabledReason");

export const ChannelSchema = z
  .object({
    id: UuidSchema,
    /** `slack`: an incoming webhook. `slack_app` (E3.6): a channel of the Slack app connection. */
    kind: ChannelKindSchema,
    name: z.string(),
    /** Last four characters of the webhook URL, to tell channels apart; null for `slack_app`. */
    urlHint: z.union([z.string(), z.null()]),
    /** The Slack channel a `slack_app` channel posts to; null for `slack`. */
    slackChannelId: z.union([z.string(), z.null()]),
    /** That channel's name when it was chosen (display only); null for `slack`. */
    slackChannelName: z.union([z.string(), z.null()]),
    eventTypes: z.array(ChannelEventTypeSchema),
    enabled: z.boolean(),
    /**
     * Set when the channel switched itself off after repeated permanent failures.
     * `not_connected`: the Slack app was disconnected — reconnect it, then switch the channel on.
     */
    disabledReason: z.union([ChannelDisabledReasonSchema, z.null()]),
    failureCount: z.number().int(),
    lastSuccessAt: z.union([TimestampSchema, z.null()]),
    lastError: z.union([z.string(), z.null()]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("NotifyChannel");

export const ChannelListSchema = z
  .object({ channels: z.array(ChannelSchema) })
  .openapi("NotifyChannelList");

const ChannelEventTypes = z.array(ChannelEventTypeSchema).max(CHANNEL_EVENT_TYPES.length);

/**
 * One body for both kinds (the route guard needs an object schema): `kind` absent or `slack`
 * needs `name` and `url`; `slack_app` (E3.6) needs `slackChannelId` and takes an optional `name`
 * (default `#<slack channel name>`). A field of the other kind is refused (`validation_failed`).
 */
export const CreateChannelBody = z
  .object({
    kind: ChannelKindSchema.optional(),
    name: trimmedText({ min: 1, max: 80 }).optional(),
    /** `slack` only: the incoming-webhook URL. */
    url: WebhookUrl.optional(),
    /** `slack_app` only: a channel from `GET /notify/slack/channels`. */
    slackChannelId: SlackChannelId.optional(),
    eventTypes: ChannelEventTypes,
    enabled: z.boolean().optional(),
  })
  .openapi("NotifyCreateChannel");

export const UpdateChannelBody = z
  .object({
    name: trimmedText({ min: 1, max: 80 }).optional(),
    /** `slack` only. Changing the URL needs a fresh session (step-up), like creating a channel. */
    url: WebhookUrl.optional(),
    /** `slack_app` only (E3.6). Re-pointing needs a fresh session too. */
    slackChannelId: SlackChannelId.optional(),
    eventTypes: ChannelEventTypes.optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("NotifyUpdateChannel");

export const ChannelParams = z.object({ id: UuidSchema });

export const ChannelTestResultSchema = z
  .object({
    ok: z.boolean(),
    reason: z.union([
      z.enum([
        "invalid_url",
        "not_found",
        "rejected",
        "rate_limited",
        "unavailable",
        "not_connected",
      ]),
      z.null(),
    ]),
    detail: z.union([z.string(), z.null()]),
  })
  .openapi("NotifyChannelTestResult");

// --- Slack app channels (E3.6) --------------------------------------------------------------

export const SlackChannelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    isPrivate: z.boolean(),
  })
  .openapi("NotifySlackChannel");

export const SlackChannelListSchema = z
  .object({ channels: z.array(SlackChannelSchema) })
  .openapi("NotifySlackChannelList");
