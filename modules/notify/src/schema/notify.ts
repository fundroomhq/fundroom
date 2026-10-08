import {
  boolean,
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Typed view of `migrations/0001_notify.sql` … `0011_slack_app_channels.sql`; the SQL is
 * authoritative (ADR-0004). The
 * `notify` schema is owned by this module (ADR-0007): nothing outside `modules/notify`
 * reads these tables.
 */
export const notifySchema = pgSchema("notify");

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

/** What processing did with a notification (`sent_at` only says that it was processed). */
export type EmailOutcome =
  | "emailed"
  | "digested"
  | "suppressed"
  | "email_off"
  | "no_address"
  /** Gave up after `NOTIFY_MAX_ATTEMPTS` mailer failures that were not a suppression. */
  | "failed";

export const cadence = notifySchema.enum("cadence", ["instant", "daily", "weekly", "off"]);
export const CADENCES = cadence.enumValues;
export type Cadence = (typeof CADENCES)[number];

export const preference = notifySchema.table(
  "preference",
  {
    workspaceId: uuid("workspace_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    eventType: text("event_type").notNull(),
    cadence: cadence("cadence").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.membershipId, t.eventType] })],
);
export type Preference = typeof preference.$inferSelect;

export const memberSettings = notifySchema.table(
  "member_settings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    /** IANA zone; validated by the API (Intl), not by Postgres. */
    timezone: text("timezone").notNull().default("UTC"),
    /** Local hour 0–23 of the daily digest (and of the weekly one, on `weeklyDay`). */
    digestHour: integer("digest_hour").notNull().default(8),
    /** 0 = Sunday … 6 = Saturday. */
    weeklyDay: integer("weekly_day").notNull().default(1),
    quietStart: integer("quiet_start"),
    quietEnd: integer("quiet_end"),
    lastDailyDigestAt: timestamp("last_daily_digest_at", { withTimezone: true }),
    lastWeeklyDigestAt: timestamp("last_weekly_digest_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.membershipId] })],
);
export type MemberSettings = typeof memberSettings.$inferSelect;

export const digest = notifySchema.table("digest", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
  /** Null while the digest is claimed but not yet (confirmed) sent. */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  messageId: text("message_id"),
  kind: text("kind").$type<"daily" | "weekly">().notNull().default("daily"),
  /** The schedule slot served (ISO instant); part of the ESP idempotency key. */
  slot: text("slot"),
  attempts: integer("attempts").notNull().default(0),
});
export type Digest = typeof digest.$inferSelect;
export type NewDigest = typeof digest.$inferInsert;

export const notification = notifySchema.table("notification", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  eventType: text("event_type").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  actorMembershipId: uuid("actor_membership_id"),
  resourceKind: text("resource_kind"),
  resourceId: uuid("resource_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
  cadence: cadence("cadence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  digestId: uuid("digest_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  deferredUntil: timestamp("deferred_until", { withTimezone: true }),
  emailOutcome: text("email_outcome").$type<EmailOutcome>(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Instant email: send attempts so far (each claim counts one). */
  attempts: integer("attempts").notNull().default(0),
  /** Instant email: not before this (backoff, and the lease of an in-flight claim). */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** An error code from the last failed attempt, never provider text. */
  lastError: text("last_error"),
});
export type Notification = typeof notification.$inferSelect;
export type NewNotification = typeof notification.$inferInsert;

/** `not_connected` (E3.6): a `slack_app` channel whose Slack app connection is gone. */
export type ChannelDisabledReason = "not_found" | "rejected" | "invalid_url" | "not_connected";

/** `slack`: an incoming webhook (a sealed URL). `slack_app` (E3.6): a channel of the Slack app. */
export type ChannelKind = "slack" | "slack_app";

export const channel = notifySchema.table("channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  kind: text("kind").$type<ChannelKind>().notNull().default("slack"),
  name: text("name").notNull(),
  /**
   * Envelope-encrypted webhook URL (purpose `notify-chat`). Never returned, never logged. Set
   * exactly when `kind = 'slack'` (CHECK `channel_kind_webhook`).
   */
  urlEnc: bytea("url_enc"),
  encryption: jsonb("encryption").$type<Record<string, unknown>>().notNull().default({}),
  encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
  urlHint: text("url_hint"),
  /** Slack's channel id (`C…`/`G…`), set exactly when `kind = 'slack_app'`. */
  slackChannelId: text("slack_channel_id"),
  /** Display copy of the Slack channel's name when it was chosen. */
  slackChannelName: text("slack_channel_name"),
  eventTypes: text("event_types").array().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  failureCount: integer("failure_count").notNull().default(0),
  disabledReason: text("disabled_reason").$type<ChannelDisabledReason>(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Channel = typeof channel.$inferSelect;
export type NewChannel = typeof channel.$inferInsert;

export type ChannelDeliveryStatus = "pending" | "sending" | "sent" | "failed" | "dropped";

export const channelDelivery = notifySchema.table("channel_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  sourceKey: text("source_key").notNull(),
  eventType: text("event_type").notNull(),
  actorMembershipId: uuid("actor_membership_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
  status: text("status").$type<ChannelDeliveryStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
export type ChannelDelivery = typeof channelDelivery.$inferSelect;
