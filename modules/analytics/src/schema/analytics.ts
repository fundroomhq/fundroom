import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Typed view of `migrations/0001_analytics.sql`, `0002_engagement.sql` and `0003_rollup_retention.sql`; the SQL is authoritative (ADR-0004). The
 * `analytics` schema is owned by this module (ADR-0007): nothing outside `modules/analytics`
 * reads these tables. `event` is range-partitioned by `occurred_at`; drizzle sees the parent.
 */
export const analyticsSchema = pgSchema("analytics");

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

export const EVENT_TYPES = [
  "document_viewed",
  "page_viewed",
  "document_downloaded",
  "update_viewed",
  // E2.6: from `mail.delivery_recorded` (migrations/0002_engagement.sql)
  "email_opened",
  "email_clicked",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RESOURCE_KINDS = ["document", "post"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const UA_FAMILIES = ["chrome", "safari", "firefox", "edge", "other"] as const;
export type UaFamily = (typeof UA_FAMILIES)[number];

export const viewSession = analyticsSchema.table("view_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  sessionKey: bytea("session_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ipHash: bytea("ip_hash"),
  uaFamily: text("ua_family").$type<UaFamily>(),
  embed: boolean("embed").notNull().default(false),
});
export type ViewSession = typeof viewSession.$inferSelect;

export const event = analyticsSchema.table(
  "event",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    viewSessionId: uuid("view_session_id"),
    membershipId: uuid("membership_id").notNull(),
    type: text("type").$type<EventType>().notNull(),
    resourceKind: text("resource_kind").$type<ResourceKind>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    versionId: uuid("version_id"),
    pageNo: integer("page_no"),
    durationMs: integer("duration_ms"),
    props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
    propsSchemaVersion: integer("props_schema_version").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.occurredAt, t.id] })],
);
export type AnalyticsEvent = typeof event.$inferSelect;

export const pageOpen = analyticsSchema.table(
  "page_open",
  {
    workspaceId: uuid("workspace_id").notNull(),
    viewSessionId: uuid("view_session_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    resourceKind: text("resource_kind").$type<ResourceKind>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    versionId: uuid("version_id"),
    pageNo: integer("page_no").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.viewSessionId, t.resourceId, t.pageNo] })],
);
export type PageOpen = typeof pageOpen.$inferSelect;

export const viewerResourceRollup = analyticsSchema.table(
  "viewer_resource_rollup",
  {
    workspaceId: uuid("workspace_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    resourceKind: text("resource_kind").$type<ResourceKind>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    views: integer("views").notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
    totalMs: bigint("total_ms", { mode: "number" }).notNull().default(0),
    maxPageReached: integer("max_page_reached"),
    pagesSeen: integer("pages_seen").array().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.membershipId, t.resourceId] })],
);
export type ViewerResourceRollup = typeof viewerResourceRollup.$inferSelect;

export const dailyResourceRollup = analyticsSchema.table(
  "daily_resource_rollup",
  {
    workspaceId: uuid("workspace_id").notNull(),
    day: date("day").notNull(),
    resourceKind: text("resource_kind").$type<ResourceKind>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    views: integer("views").notNull().default(0),
    uniqueViewers: integer("unique_viewers").notNull().default(0),
    totalMs: bigint("total_ms", { mode: "number" }).notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day, t.resourceId] })],
);
export type DailyResourceRollup = typeof dailyResourceRollup.$inferSelect;

export const rollupCursor = analyticsSchema.table("rollup_cursor", {
  workspaceId: uuid("workspace_id").primaryKey(),
  lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true }).notNull(),
  lastEventId: uuid("last_event_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type RollupCursor = typeof rollupCursor.$inferSelect;

/** Stands in for "no version reported" in `page_rollup`/`page_viewer` keys (a PK cannot hold NULL). */
export const NO_VERSION = "00000000-0000-0000-0000-000000000000";

export const pageRollup = analyticsSchema.table(
  "page_rollup",
  {
    workspaceId: uuid("workspace_id").notNull(),
    resourceKind: text("resource_kind").$type<ResourceKind>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    versionKey: uuid("version_key").notNull(),
    pageNo: integer("page_no").notNull(),
    totalMs: bigint("total_ms", { mode: "number" }).notNull().default(0),
    views: integer("views").notNull().default(0),
    viewers: integer("viewers").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.resourceId, t.versionKey, t.pageNo] })],
);
export type PageRollup = typeof pageRollup.$inferSelect;

export const pageViewer = analyticsSchema.table(
  "page_viewer",
  {
    workspaceId: uuid("workspace_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    versionKey: uuid("version_key").notNull(),
    pageNo: integer("page_no").notNull(),
    membershipId: uuid("membership_id").notNull(),
    /** Last time the rollup saw this member read the page (retention trims on it, 0003). */
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.workspaceId, t.resourceId, t.versionKey, t.pageNo, t.membershipId],
    }),
  ],
);

export const hotLeadAlert = analyticsSchema.table(
  "hot_lead_alert",
  {
    workspaceId: uuid("workspace_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
    score: integer("score").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.membershipId] })],
);
