import { TimestampSchema, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";

/*
 * Route schemas for `/api/v1/analytics/*`. Part of the OpenAPI document the SDK is generated
 * from, so names (`.openapi("…")`) are stable API. Nothing here carries an email or an IP.
 */
export const AnalyticsModeSchema = z.enum(["off", "essential", "engagement"]);
export const EventTypeSchema = z.enum([
  "document_viewed",
  "page_viewed",
  "document_downloaded",
  "update_viewed",
  "email_opened",
  "email_clicked",
]);
export const ResourceKindSchema = z.enum(["document", "post"]);
export const MembershipKindSchema = z.enum(["staff", "external"]);

const NullableUuid = z.union([UuidSchema, z.null()]);
const NullableInt = z.union([z.number().int(), z.null()]);

// --- member-facing --------------------------------------------------------------------------------
export const HeartbeatBody = z
  .object({
    resourceKind: z.literal("document"),
    resourceId: UuidSchema,
    versionId: UuidSchema.optional(),
    page: z.number().int().min(1).max(100_000),
    /** Milliseconds of dwell since the last beat; capped server-side at 15 s. */
    ms: z.number().int().min(0).max(15_000),
  })
  .openapi("AnalyticsHeartbeatBody");

export const HeartbeatResultSchema = z
  .object({
    accepted: z.boolean(),
    /**
     * `mode`: this workspace does not record page dwell. `unopened`: the server has no record
     * of this session opening the resource, so the beat is a claim with nothing behind it —
     * usually a beat that overtook its own `document.viewed` event, occasionally a forgery.
     */
    reason: z.enum(["mode", "consent", "unopened"]).optional(),
  })
  .openapi("AnalyticsHeartbeatResult");

export const CloseBody = z
  .object({ resourceKind: ResourceKindSchema, resourceId: UuidSchema })
  .openapi("AnalyticsCloseBody");

export const CloseResultSchema = z
  .object({ flushed: z.number().int() })
  .openapi("AnalyticsCloseResult");

export const ConsentStateSchema = z
  .object({
    /** How this workspace obtains consent for optional tracking (`legal.consentMode`, R13). */
    mode: z.enum(["opt_in", "opt_out", "notice_only"]),
    /** The caller's own answer: `true` granted, `false` withdrawn, `null` never asked. */
    granted: z.union([z.boolean(), z.null()]),
    /** The caller's browser sent Global Privacy Control, which overrides any stored answer. */
    gpc: z.boolean(),
    /** Whether the portal should ask: the mode needs an answer and the caller has not given one. */
    shouldAsk: z.boolean(),
  })
  .openapi("AnalyticsConsentState");

export const NoticeSchema = z
  .object({
    mode: AnalyticsModeSchema,
    /** What is recorded about the caller under the current mode (portal transparency notice). */
    tracks: z.array(z.string()),
    consent: ConsentStateSchema,
    /**
     * Whether the browser should send dwell heartbeats at all. This is the single authority the
     * viewer obeys: it already folds the workspace mode, the consent mode, the caller's stored
     * answer and their GPC signal, so the client never has to re-derive the rule (and cannot
     * get it wrong in the permissive direction).
     */
    dwell: z.boolean(),
    /**
     * E2.6: email open/click tracking on updates, the caller's own `email_tracking` purpose.
     * `granted` is their stored answer (`null` never asked); `active` is whether opens and clicks
     * are recorded for them now (the mode is `engagement` and the purpose is allowed, GPC folded in).
     */
    emailTracking: z
      .object({ granted: z.union([z.boolean(), z.null()]), active: z.boolean() })
      .openapi("AnalyticsEmailTrackingState"),
  })
  .openapi("AnalyticsNotice");

// --- staff ---------------------------------------------------------------------------------------
export const OverviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const MembershipRefSchema = z
  .object({
    displayName: z.string(),
    kind: MembershipKindSchema,
    role: z.string(),
  })
  .openapi("AnalyticsMembershipRef");

export const RecentEventSchema = z
  .object({
    id: UuidSchema,
    occurredAt: TimestampSchema,
    type: EventTypeSchema,
    membershipId: UuidSchema,
    membership: z.union([MembershipRefSchema, z.null()]),
    resourceKind: ResourceKindSchema,
    resourceId: UuidSchema,
    versionId: NullableUuid,
    page: NullableInt,
    durationMs: NullableInt,
  })
  .openapi("AnalyticsRecentEvent");

export const TopResourceSchema = z
  .object({
    resourceId: UuidSchema,
    views: z.number().int(),
    uniqueViewers: z.number().int(),
    totalMs: z.number(),
    downloads: z.number().int(),
  })
  .openapi("AnalyticsTopResource");

export const OverviewSchema = z
  .object({
    mode: AnalyticsModeSchema,
    range: z.object({ from: TimestampSchema, to: TimestampSchema }),
    totals: z.object({
      views: z.number().int(),
      uniqueViewers: z.number().int(),
      downloads: z.number().int(),
      totalMs: z.number(),
    }),
    topDocuments: z.array(TopResourceSchema),
    recent: z.array(RecentEventSchema),
  })
  .openapi("AnalyticsOverview");

export const ResourceParams = z.object({ kind: ResourceKindSchema, id: UuidSchema });
export const ResourceMemberParams = ResourceParams.extend({ membershipId: UuidSchema });
export const MemberParams = z.object({ membershipId: UuidSchema });

export const ViewerSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    kind: MembershipKindSchema,
    role: z.string(),
    firstAt: TimestampSchema,
    lastAt: TimestampSchema,
    views: z.number().int(),
    downloads: z.number().int(),
    totalMs: z.number(),
    maxPageReached: NullableInt,
    pagesSeen: z.array(z.number().int()),
  })
  .openapi("AnalyticsViewer");

export const ViewerListSchema = z
  .object({ mode: AnalyticsModeSchema, viewers: z.array(ViewerSchema) })
  .openapi("AnalyticsViewerList");

export const PageDwellSchema = z
  .object({ pageNo: z.number().int(), durationMs: z.number().int(), views: z.number().int() })
  .openapi("AnalyticsPageDwell");

export const PageDwellListSchema = z
  .object({ pages: z.array(PageDwellSchema) })
  .openapi("AnalyticsPageDwellList");

export const TimelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: TimestampSchema.optional(),
  /** Companion to `before`; pass both back together, exactly as the previous page returned them. */
  beforeId: UuidSchema.optional(),
});

export const TimelineItemSchema = z
  .object({
    id: UuidSchema,
    occurredAt: TimestampSchema,
    type: EventTypeSchema,
    resourceKind: ResourceKindSchema,
    resourceId: UuidSchema,
    versionId: NullableUuid,
    pageNo: NullableInt,
    durationMs: NullableInt,
    props: z.record(z.string(), z.unknown()),
  })
  .openapi("AnalyticsTimelineItem");

export const TimelineSchema = z
  .object({
    items: z.array(TimelineItemSchema),
    /** Pass as `before` for the next page; null when this was the last page. */
    nextBefore: z.union([TimestampSchema, z.null()]),
    /**
     * Pass as `beforeId` alongside `nextBefore`. Events are ordered by `(occurredAt, id)` and
     * a close beacon flushes several at the same microsecond, so paging on the timestamp alone
     * would step over the rest of such a tie.
     */
    nextBeforeId: z.union([UuidSchema, z.null()]),
  })
  .openapi("AnalyticsTimeline");

const HotLeadThreshold = z.number().int().min(1).max(100);

export const AnalyticsSettingsSchema = z
  .object({
    mode: AnalyticsModeSchema,
    retentionMonths: z.number().int().min(1).max(120),
    /** Days of engagement the hot list scores (E2.6). */
    hotListWindowDays: z.number().int().min(1).max(90),
    /** Score at which `analytics.hot_lead` fires; `null` = alerts off (the list still ranks). */
    hotLeadThreshold: z.union([HotLeadThreshold, z.null()]),
  })
  .openapi("AnalyticsSettings");

export const AnalyticsSettingsPatchBody = z
  .object({
    mode: AnalyticsModeSchema.optional(),
    retentionMonths: z.number().int().min(1).max(120).optional(),
    hotListWindowDays: z.number().int().min(1).max(90).optional(),
    hotLeadThreshold: z.union([HotLeadThreshold, z.null()]).optional(),
  })
  .openapi("AnalyticsSettingsPatch");

export const AnonymiseResultSchema = z
  .object({
    ok: z.literal(true),
    deleted: z.object({
      events: z.number().int(),
      pageOpens: z.number().int(),
      viewSessions: z.number().int(),
      viewerRollups: z.number().int(),
      pageViewers: z.number().int(),
      hotLeadAlerts: z.number().int(),
    }),
  })
  .openapi("AnalyticsAnonymiseResult");

// --- E2.6: heatmap, hot list, email engagement -----------------------------------------------------
export const HeatmapQuery = z.object({
  /** Only this document version; every version (each its own heatmap) when absent. */
  versionId: UuidSchema.optional(),
});

export const HeatmapPageSchema = z
  .object({
    pageNo: z.number().int(),
    /** Summed dwell on the page, all readers. */
    totalMs: z.number(),
    /** Page reads (one per session that dwelt on it). */
    views: z.number().int(),
    /** Distinct members who read it (erased members stay counted; they are no longer named). */
    viewers: z.number().int(),
    /** `totalMs / views`, rounded. */
    avgMs: z.number().int(),
  })
  .openapi("AnalyticsHeatmapPage");

export const HeatmapSchema = z
  .object({
    mode: AnalyticsModeSchema,
    resourceKind: ResourceKindSchema,
    resourceId: UuidSchema,
    versions: z.array(
      z.object({
        /** `null` when the viewer did not report a version. */
        versionId: NullableUuid,
        pages: z.array(HeatmapPageSchema),
      }),
    ),
  })
  .openapi("AnalyticsHeatmap");

export const HotListQuery = z.object({
  /** Scoring window in days; the workspace's `hotListWindowDays` when absent. */
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export const HotListEntrySchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    role: z.string(),
    /** 0–100. A sort key over what the member did, not a prediction. */
    score: z.number().int().min(0).max(100),
    /** Decayed points per component; they add up to the raw total behind `score`. */
    points: z.object({
      views: z.number(),
      dwell: z.number(),
      downloads: z.number(),
      opens: z.number(),
      clicks: z.number(),
    }),
    /** Undecayed counts inside the window. Automated opens/clicks are listed, never scored. */
    counts: z.object({
      views: z.number().int(),
      dwellMs: z.number(),
      downloads: z.number().int(),
      humanOpens: z.number().int(),
      clicks: z.number().int(),
      automatedOpens: z.number().int(),
      automatedClicks: z.number().int(),
    }),
    lastActivityAt: z.union([TimestampSchema, z.null()]),
  })
  .openapi("AnalyticsHotListEntry");

export const HotListSchema = z
  .object({
    mode: AnalyticsModeSchema,
    days: z.number().int(),
    threshold: z.union([HotLeadThreshold, z.null()]),
    generatedAt: TimestampSchema,
    entries: z.array(HotListEntrySchema),
  })
  .openapi("AnalyticsHotList");

export const PostParams = z.object({ id: UuidSchema });

export const EmailEngagementSchema = z
  .object({
    mode: AnalyticsModeSchema,
    postId: UuidSchema,
    opens: z.object({
      human: z.number().int(),
      uniqueHuman: z.number().int(),
      /** Apple Mail Privacy Protection prefetches and scanners: stored, reported, never scored. */
      automated: z.number().int(),
      uniqueAutomated: z.number().int(),
    }),
    clicks: z.object({
      human: z.number().int(),
      uniqueHuman: z.number().int(),
      automated: z.number().int(),
    }),
    uniqueEngaged: z.number().int(),
    links: z.array(
      z.object({
        /** Origin + path; query and fragment were stripped at ingest. */
        link: z.union([z.string(), z.null()]),
        clicks: z.number().int(),
        uniqueClickers: z.number().int(),
        automatedClicks: z.number().int(),
      }),
    ),
  })
  .openapi("AnalyticsEmailEngagement");
