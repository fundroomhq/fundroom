import type { TenantContext, Tx } from "@fundroom/db";
import type { AnalyticsSettings } from "@fundroom/domain";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { EventRepo, PageRollupRepo, RollupRepo } from "../repos/analytics-repo.js";
import { type EventType, NO_VERSION, type ResourceKind } from "../schema/analytics.js";
import { dayRange, nextBefore } from "./range.js";

/*
 * The staff read surfaces (design/06 §6): the overview, "who viewed this", the per-viewer page
 * dwell drill-down and one contact's timeline. Counts come from the rollup tables written by
 * `analytics.rollup`, so they lag by up to five minutes; the timeline and the recent strip read
 * raw events. Every call runs in the caller's own tenant transaction — RLS is the fence, this
 * layer never widens it.
 */
export const TOP_LIMIT = 10;
export const RECENT_LIMIT = 25;

export interface MembershipRef {
  displayName: string;
  kind: "staff" | "external";
  role: string;
}

/** A member whose row has since been removed still owns rollup rows; name them, never guess. */
const UNKNOWN: MembershipRef = { displayName: "Removed member", kind: "external", role: "unknown" };

export interface TopResource {
  resourceId: string;
  views: number;
  uniqueViewers: number;
  totalMs: number;
  downloads: number;
}

export interface RecentEvent {
  id: string;
  occurredAt: string;
  type: EventType;
  membershipId: string;
  membership: MembershipRef | null;
  resourceKind: ResourceKind;
  resourceId: string;
  versionId: string | null;
  page: number | null;
  durationMs: number | null;
}

export interface Overview {
  mode: AnalyticsSettings["mode"];
  range: { from: string; to: string };
  totals: { views: number; uniqueViewers: number; downloads: number; totalMs: number };
  topDocuments: TopResource[];
  recent: RecentEvent[];
}

export interface Viewer {
  membershipId: string;
  displayName: string;
  kind: "staff" | "external";
  role: string;
  firstAt: string;
  lastAt: string;
  views: number;
  downloads: number;
  totalMs: number;
  maxPageReached: number | null;
  pagesSeen: number[];
}

export interface TimelineItem {
  id: string;
  occurredAt: string;
  type: EventType;
  resourceKind: ResourceKind;
  resourceId: string;
  versionId: string | null;
  pageNo: number | null;
  durationMs: number | null;
  props: Record<string, unknown>;
}

export interface HeatmapPage {
  pageNo: number;
  totalMs: number;
  views: number;
  viewers: number;
  avgMs: number;
}

export interface Heatmap {
  mode: AnalyticsSettings["mode"];
  resourceKind: ResourceKind;
  resourceId: string;
  /** One heatmap per document version (pages of two versions are different pages), newest activity first. */
  versions: { versionId: string | null; pages: HeatmapPage[] }[];
}

export interface EmailEngagement {
  mode: AnalyticsSettings["mode"];
  postId: string;
  opens: { human: number; uniqueHuman: number; automated: number; uniqueAutomated: number };
  clicks: { human: number; uniqueHuman: number; automated: number };
  /** Distinct members with a human open or click (a click implies an open a pixel blocker hid). */
  uniqueEngaged: number;
  links: { link: string | null; clicks: number; uniqueClickers: number; automatedClicks: number }[];
}

/** Links listed per post: enough for any real update, bounded for a pathological one. */
export const EMAIL_LINK_LIMIT = 100;

export interface InsightsService {
  heatmap(
    ctx: TenantContext,
    settings: AnalyticsSettings,
    kind: ResourceKind,
    resourceId: string,
    versionId: string | null,
  ): Promise<Heatmap>;
  email(ctx: TenantContext, settings: AnalyticsSettings, postId: string): Promise<EmailEngagement>;
  overview(ctx: TenantContext, settings: AnalyticsSettings, days: number): Promise<Overview>;
  viewers(
    ctx: TenantContext,
    settings: AnalyticsSettings,
    kind: ResourceKind,
    resourceId: string,
  ): Promise<{ mode: AnalyticsSettings["mode"]; viewers: Viewer[] }>;
  pages(
    ctx: TenantContext,
    resourceId: string,
    membershipId: string,
  ): Promise<{ pages: { pageNo: number; durationMs: number; views: number }[] }>;
  timeline(
    ctx: TenantContext,
    membershipId: string,
    page: { limit: number; before?: string | undefined; beforeId?: string | undefined },
  ): Promise<{ items: TimelineItem[]; nextBefore: string | null; nextBeforeId: string | null }>;
}

async function refsFor(
  ctx: TenantContext,
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, MembershipRef>> {
  const names = await new MembershipRepo(ctx, tx).namesFor([...new Set(ids)]);
  return new Map(
    [...names.entries()].map(([id, n]) => [
      id,
      { displayName: n.displayName, kind: n.kind, role: n.role } satisfies MembershipRef,
    ]),
  );
}

export function createInsightsService(services: ModuleServices): InsightsService {
  return {
    async heatmap(ctx, settings, kind, resourceId, versionId) {
      const rows = await services.db.withTenant(ctx, (tx) =>
        new PageRollupRepo(ctx, tx).heatmap(kind, resourceId, versionId),
      );
      const byVersion = new Map<string, { latest: number; pages: HeatmapPage[] }>();
      for (const r of rows) {
        const v = byVersion.get(r.versionKey) ?? { latest: 0, pages: [] };
        v.latest = Math.max(v.latest, r.updatedAt.getTime());
        v.pages.push({
          pageNo: r.pageNo,
          totalMs: r.totalMs,
          views: r.views,
          viewers: r.viewers,
          avgMs: r.views === 0 ? 0 : Math.round(r.totalMs / r.views),
        });
        byVersion.set(r.versionKey, v);
      }
      return {
        mode: settings.mode,
        resourceKind: kind,
        resourceId,
        versions: [...byVersion.entries()]
          .sort((a, b) => b[1].latest - a[1].latest || a[0].localeCompare(b[0]))
          .map(([key, v]) => ({
            versionId: key === NO_VERSION ? null : key,
            pages: v.pages.sort((a, b) => a.pageNo - b.pageNo),
          })),
      };
    },

    async email(ctx, settings, postId) {
      return services.db.withTenant(ctx, async (tx) => {
        const events = new EventRepo(ctx, tx);
        const stats = await events.emailStats(postId);
        const links = await events.emailLinks(postId, EMAIL_LINK_LIMIT);
        return {
          mode: settings.mode,
          postId,
          opens: {
            human: stats.humanOpens,
            uniqueHuman: stats.uniqueHumanOpens,
            automated: stats.automatedOpens,
            uniqueAutomated: stats.uniqueAutomatedOpens,
          },
          clicks: {
            human: stats.humanClicks,
            uniqueHuman: stats.uniqueClickers,
            automated: stats.automatedClicks,
          },
          uniqueEngaged: stats.uniqueEngaged,
          links,
        };
      });
    },

    async overview(ctx, settings, days) {
      const { fromDay, toDay, from, to } = dayRange(services.now(), days);
      return services.db.withTenant(ctx, async (tx) => {
        const rollups = new RollupRepo(ctx, tx);
        const events = new EventRepo(ctx, tx);
        const totals = await rollups.totals(fromDay, toDay);
        const top = await rollups.top("document", fromDay, toDay, TOP_LIMIT);
        const unique = await events.uniqueViewersByResource(
          top.map((t) => t.resourceId),
          from,
        );
        const recent = await events.recent(RECENT_LIMIT);
        const refs = await refsFor(
          ctx,
          tx,
          recent.map((r) => r.membershipId),
        );
        return {
          mode: settings.mode,
          range: { from: from.toISOString(), to: to.toISOString() },
          totals: {
            views: totals.views,
            uniqueViewers: await events.uniqueViewersSince(from),
            downloads: totals.downloads,
            totalMs: totals.totalMs,
          },
          topDocuments: top.map((t) => ({
            resourceId: t.resourceId,
            views: t.views,
            uniqueViewers: unique.get(t.resourceId) ?? 0,
            totalMs: t.totalMs,
            downloads: t.downloads,
          })),
          recent: recent.map((r) => ({
            id: r.id,
            occurredAt: r.occurredAt.toISOString(),
            type: r.type,
            membershipId: r.membershipId,
            membership: refs.get(r.membershipId) ?? null,
            resourceKind: r.resourceKind,
            resourceId: r.resourceId,
            versionId: r.versionId,
            page: r.pageNo,
            durationMs: r.durationMs,
          })),
        };
      });
    },

    async viewers(ctx, settings, kind, resourceId) {
      return services.db.withTenant(ctx, async (tx) => {
        const rows = await new RollupRepo(ctx, tx).viewersFor(kind, resourceId);
        const refs = await refsFor(
          ctx,
          tx,
          rows.map((r) => r.membershipId),
        );
        return {
          mode: settings.mode,
          viewers: rows.map((r) => {
            const ref = refs.get(r.membershipId) ?? UNKNOWN;
            return {
              membershipId: r.membershipId,
              displayName: ref.displayName,
              kind: ref.kind,
              role: ref.role,
              firstAt: r.firstAt.toISOString(),
              lastAt: r.lastAt.toISOString(),
              views: r.views,
              downloads: r.downloads,
              totalMs: r.totalMs,
              maxPageReached: r.maxPageReached,
              pagesSeen: r.pagesSeen,
            };
          }),
        };
      });
    },

    async pages(ctx, resourceId, membershipId) {
      const pages = await services.db.withTenant(ctx, (tx) =>
        new EventRepo(ctx, tx).pagesFor(resourceId, membershipId),
      );
      return { pages };
    },

    async timeline(ctx, membershipId, page) {
      const rows = await services.db.withTenant(ctx, (tx) =>
        new EventRepo(ctx, tx).timeline(
          membershipId,
          page.before ?? null,
          page.beforeId ?? null,
          page.limit,
        ),
      );
      const cursor = nextBefore(rows, page.limit);
      return {
        items: rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt.toISOString(),
          type: r.type,
          resourceKind: r.resourceKind,
          resourceId: r.resourceId,
          versionId: r.versionId,
          pageNo: r.pageNo,
          durationMs: r.durationMs,
          props: r.props,
        })),
        nextBefore: cursor?.before ?? null,
        nextBeforeId: cursor?.beforeId ?? null,
      };
    },
  };
}
