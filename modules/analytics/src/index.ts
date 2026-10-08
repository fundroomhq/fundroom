import { defineModule, type ModuleManifest } from "@fundroom/module-kit";
import { analyticsDsar } from "./dsar.js";
import {
  createMailDeliveryHandler,
  onDocumentDownloaded,
  onDocumentViewed,
  onUpdateViewed,
} from "./ingest.js";
import { createAnalyticsJobs } from "./jobs.js";
import { captureServices, liveServices } from "./live.js";
import { analyticsPortability } from "./portability.js";
import { registerAnalyticsRoutes } from "./routes.js";
import { createErasureHandler } from "./service/settings.js";
import { analyticsUsage } from "./usage.js";

/*
 * Engagement analytics (E1.5, design/06 §6): who opened what, for how long and how far they
 * read. Server-side facts arrive as outbox events (document viewed/downloaded, update viewed);
 * page dwell arrives as capped heartbeats from the viewer. Raw events are partitioned by month
 * and expire with the workspace's retention; the rollups behind the admin views are kept.
 * Privacy is the default, not a setting bolted on: no email, no IP, no user-agent string — a
 * hashed session id, a browser family and a salted IP hash — and a workspace on `essential`
 * (or `off`) writes less, or nothing, without any other part of the module changing.
 */

export const analyticsModule: ModuleManifest = defineModule({
  id: "analytics",
  version: "0.2.0",
  dsar: analyticsDsar,
  dependsOn: ["access"],
  schema: "analytics",
  migrations: new URL("../migrations/", import.meta.url),
  permissions: ["analytics.read", "analytics.settings"],
  portability: analyticsPortability,
  usage: analyticsUsage,
  routes: (api, services) => {
    captureServices(services);
    registerAnalyticsRoutes(api, services);
  },
  jobs: (services) => {
    captureServices(services);
    return createAnalyticsJobs(services);
  },
  events: {
    handles: {
      "document.viewed": onDocumentViewed,
      "document.downloaded": onDocumentDownloaded,
      "update.viewed": onUpdateViewed,
      // E2.6: email opens/clicks on updates (the kernel's ESP webhook ingress)
      "mail.delivery_recorded": createMailDeliveryHandler(liveServices),
      // E2.6: DSAR erasure fan-out (contract decision 5)
      "member.erasure_requested": createErasureHandler(liveServices),
    },
    // Announced by `analytics.rollup` when a member crosses `hotLeadThreshold`.
    emits: ["analytics.hot_lead"],
  },
  slots: {
    "admin.nav": [
      {
        id: "analytics-admin",
        label: "Engagement",
        to: "/admin/analytics",
        order: 46,
        icon: "metrics",
      },
    ],
    // E2.7: the settings hub (`/admin/settings`) lists every manifest's `admin.settings` entries.
    "admin.settings": [
      {
        id: "analytics-settings",
        label: "Engagement",
        to: "/admin/analytics/settings",
        order: 50,
        icon: "metrics",
      },
    ],
  },
});

export default analyticsModule;

export * from "./contracts.js";
export { analyticsDsar } from "./dsar.js";
export { type Actor, AnalyticsError, type AnalyticsErrorCode } from "./errors.js";
export {
  createMailDeliveryHandler,
  type EventEnvelope,
  onDocumentDownloaded,
  onDocumentViewed,
  onUpdateViewed,
} from "./ingest.js";
export {
  createAnalyticsJobs,
  erasedAmong,
  flushIdleFor,
  foldBatch,
  JOB_FLUSH,
  JOB_MAINTAIN,
  JOB_ROLLUP,
  PARTITION_MONTHS_AHEAD,
  ROLLUP_BATCH,
  ROLLUP_SETTLE_SECONDS,
} from "./jobs.js";
export {
  analyticsPortability,
  IMPORT_PARTITION_MONTHS_BACK,
  importEventWindow,
  importedSessionKey,
} from "./portability.js";
export {
  cappedDwellMs,
  HEARTBEAT_MAX_MS,
  ipHashOf,
  isUnscoredLink,
  PAGE_OPEN_IDLE_MS,
  sessionKeyOf,
  syntheticSessionKey,
  tracksFor,
  uaFamilyOf,
} from "./privacy.js";
export { PERM_READ, PERM_SETTINGS, registerAnalyticsRoutes } from "./routes.js";
export { csvField, HOT_LIST_CSV_COLUMNS, type HotListCsvRow, hotListCsv } from "./service/csv.js";
export {
  announceHotLeads,
  createHotListService,
  HOT_LIST_LIMIT,
  type HotList,
  type HotListEntry,
  type HotListService,
} from "./service/hot-list.js";
export {
  createInsightsService,
  EMAIL_LINK_LIMIT,
  type EmailEngagement,
  type Heatmap,
  type HeatmapPage,
  type InsightsService,
  type MembershipRef,
  type Overview,
  RECENT_LIMIT,
  type RecentEvent,
  type TimelineItem,
  TOP_LIMIT,
  type TopResource,
  type Viewer,
} from "./service/insights.js";
export { type DayRange, dayOf, dayRange, nextBefore } from "./service/range.js";
export {
  DWELL_CAP_MS,
  decay,
  HOT_WEIGHTS,
  type HotScore,
  type HotSignal,
  hotScore,
  SCORE_SCALE,
  type ScoreCounts,
  type ScoreOptions,
  type ScorePoints,
} from "./service/scoring.js";
export {
  type AnalyticsSettingsPatch,
  type AnalyticsSettingsService,
  type AnonymiseCounts,
  createAnalyticsSettingsService,
  createErasureHandler,
  eraseMemberRows,
} from "./service/settings.js";
export {
  type Beater,
  type BeatInput,
  createTrackingService,
  type HeartbeatResult,
  type TrackingService,
} from "./service/tracking.js";
