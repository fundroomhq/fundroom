import { listLiveWorkspaceIds, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { PAGE_OPEN_IDLE_MS } from "./privacy.js";
import {
  type CursorRow,
  type DailyDelta,
  EventRepo,
  HotLeadRepo,
  lockWorkspaceAnalytics,
  type PageDelta,
  PageOpenRepo,
  PageRollupRepo,
  RollupRepo,
  type ViewerDelta,
  ViewSessionRepo,
} from "./repos/analytics-repo.js";
import {
  dropPartition,
  ensurePartitions,
  expiredPartitions,
  workspaceRetentionFacts,
} from "./repos/partition-repo.js";
import { NO_VERSION } from "./schema/analytics.js";
import { announceHotLeads } from "./service/hot-list.js";

export const JOB_FLUSH = "analytics.flush";
export const JOB_ROLLUP = "analytics.rollup";
export const JOB_MAINTAIN = "analytics.maintain";

/** Events younger than this are left for the next rollup pass (in-flight transactions). */
export const ROLLUP_SETTLE_SECONDS = 10;
export const ROLLUP_BATCH = 1000;
export const PARTITION_MONTHS_AHEAD = 3;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

const isEmail = (type: CursorRow["type"]) => type === "email_opened" || type === "email_clicked";

/**
 * Folds one batch of events into per-(member, resource), per-(day, resource) and — for
 * `page_viewed` — per-(resource, version, page) heatmap deltas. Email opens and clicks are not
 * reads of the resource: they appear in none of the three (a member who only opened the email
 * must not show up in "who viewed" the update); the hot list and the email route read them raw.
 */
export function foldBatch(rows: readonly CursorRow[]): {
  viewers: ViewerDelta[];
  daily: DailyDelta[];
  pages: PageDelta[];
} {
  const viewers = new Map<string, ViewerDelta>();
  const daily = new Map<string, DailyDelta>();
  const pages = new Map<string, PageDelta>();
  for (const r of rows) {
    if (isEmail(r.type)) continue;
    if (r.type === "page_viewed" && r.pageNo !== null) {
      const versionKey = r.versionId ?? NO_VERSION;
      const pk = `${r.resourceId}:${versionKey}:${r.pageNo}`;
      const p = pages.get(pk) ?? {
        resourceKind: r.resourceKind,
        resourceId: r.resourceId,
        versionKey,
        pageNo: r.pageNo,
        totalMs: 0,
        views: 0,
        membershipIds: [],
      };
      pages.set(pk, {
        ...p,
        totalMs: p.totalMs + (r.durationMs ?? 0),
        views: p.views + 1,
        membershipIds: p.membershipIds.includes(r.membershipId)
          ? p.membershipIds
          : [...p.membershipIds, r.membershipId],
      });
    }
    const isView = r.type === "document_viewed" || r.type === "update_viewed";
    const isDownload = r.type === "document_downloaded";
    const ms = r.type === "page_viewed" ? (r.durationMs ?? 0) : 0;
    const page = r.type === "page_viewed" ? r.pageNo : null;

    const vk = `${r.membershipId}:${r.resourceId}`;
    const v = viewers.get(vk) ?? {
      membershipId: r.membershipId,
      resourceKind: r.resourceKind,
      resourceId: r.resourceId,
      firstAt: r.occurredAt,
      lastAt: r.occurredAt,
      views: 0,
      downloads: 0,
      totalMs: 0,
      maxPageReached: null,
      pagesSeen: [],
    };
    viewers.set(vk, {
      ...v,
      firstAt: r.occurredAt < v.firstAt ? r.occurredAt : v.firstAt,
      lastAt: r.occurredAt > v.lastAt ? r.occurredAt : v.lastAt,
      views: v.views + (isView ? 1 : 0),
      downloads: v.downloads + (isDownload ? 1 : 0),
      totalMs: v.totalMs + ms,
      maxPageReached: page === null ? v.maxPageReached : Math.max(page, v.maxPageReached ?? 0),
      pagesSeen: page === null || v.pagesSeen.includes(page) ? v.pagesSeen : [...v.pagesSeen, page],
    });

    const day = dayOf(r.occurredAt);
    const dk = `${day}:${r.resourceId}`;
    const d = daily.get(dk) ?? {
      day,
      resourceKind: r.resourceKind,
      resourceId: r.resourceId,
      views: 0,
      downloads: 0,
      totalMs: 0,
    };
    daily.set(dk, {
      ...d,
      views: d.views + (isView ? 1 : 0),
      downloads: d.downloads + (isDownload ? 1 : 0),
      totalMs: d.totalMs + ms,
    });
  }
  return { viewers: [...viewers.values()], daily: [...daily.values()], pages: [...pages.values()] };
}

/**
 * The subset of `ids` with an erasure request (E2.6). A fact about an erased member that is
 * still in the pipeline — an idle page_open row, a batch the rollup is folding — is dropped
 * rather than written back into the tables the erasure just emptied.
 */
export async function erasedAmong(
  services: ModuleServices,
  tx: Tx,
  ctx: TenantContext,
  ids: Iterable<string>,
): Promise<Set<string>> {
  const erased = new Set<string>();
  for (const id of new Set(ids)) {
    if (await services.legal.isErased(tx, ctx, id)) erased.add(id);
  }
  return erased;
}

/**
 * Flushes idle page_open rows to `page_viewed` events under the workspace analytics lock,
 * discarding (never flushing) the rows of erased members.
 */
export async function flushIdleFor(
  services: ModuleServices,
  tx: Tx,
  ctx: TenantContext,
  before: Date,
): Promise<number> {
  await lockWorkspaceAnalytics(tx, ctx.workspaceId);
  const opens = new PageOpenRepo(ctx, tx);
  for (const id of await erasedAmong(services, tx, ctx, await opens.membersIdleBefore(before))) {
    await opens.deleteForMembership(id);
  }
  return opens.flushIdle(before);
}

/*
 * `analytics.flush` (every minute): page_open rows silent for two minutes become
 * `page_viewed` events (the tab closed without a beacon). `analytics.rollup` (every five
 * minutes): incremental keyset walk of `event` per workspace into the three rollup tables —
 * the admin views therefore lag by up to five minutes — then the hot-lead pass over every member
 * active in the scoring window (E2.6; the design asks for alerts within a minute, the rollup cadence makes
 * it five: a documented deviation). `analytics.maintain` (daily): future partitions; then, per
 * workspace, delete that workspace's raw events and view sessions older than its own
 * `retentionMonths` — and the per-member rollups (`viewer_resource_rollup`, `page_viewer`,
 * `hot_lead_alert`) whose last activity is older — skipped entirely while `legal.legalHold` is
 * set; then drop the shared partitions older than the *longest* retention among all workspaces
 * (soft-deleted ones included), unless any of them is on legal hold. A partition holds every
 * tenant's rows: dropping at the shortest retention would delete the others' data, so the
 * partition drop only ever reclaims what no workspace may keep and the per-workspace trim does
 * the rest.
 */
export function createAnalyticsJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  const workspaceIds = async (only: string | undefined) =>
    only === undefined ? await listLiveWorkspaceIds(services.db) : [only];

  async function rollupWorkspace(workspaceId: string): Promise<number> {
    const ctx = systemContext(workspaceId);
    let total = 0;
    for (;;) {
      const n = await services.db.withTenant(ctx, async (tx) => {
        const rollups = new RollupRepo(ctx, tx);
        const events = new EventRepo(ctx, tx);
        // Serialised with the DSAR erasure: see `lockWorkspaceAnalytics`.
        await lockWorkspaceAnalytics(tx, workspaceId);
        const cursor = await rollups.readCursor();
        const rows = await events.afterCursor(cursor, ROLLUP_SETTLE_SECONDS, ROLLUP_BATCH);
        if (rows.length === 0) return 0;
        // Re-checked inside the transaction: a member erased since these events were written is
        // not folded back into the per-member rollups (the cursor still moves past them).
        const erased = await erasedAmong(
          services,
          tx,
          ctx,
          rows.map((r) => r.membershipId),
        );
        const { viewers, daily, pages } = foldBatch(
          erased.size === 0 ? rows : rows.filter((r) => !erased.has(r.membershipId)),
        );
        for (const v of viewers) await rollups.applyViewer(v);
        const heat = new PageRollupRepo(ctx, tx);
        for (const p of pages) await heat.apply(p);
        for (const d of daily) {
          await rollups.applyDaily(d);
          const unique = await events.uniqueViewersOn(d.day, d.resourceId);
          await rollups.setUniqueViewers(d.day, d.resourceId, unique);
        }
        const last = rows[rows.length - 1];
        if (last) await rollups.writeCursor({ occurredAt: last.occurredAtText, eventId: last.id });
        return rows.length;
      });
      total += n;
      if (n < ROLLUP_BATCH) break;
    }
    const announced = await announceHotLeads(services, workspaceId);
    if (announced > 0) services.log("analytics.hot_leads", { workspaceId, announced });
    return total;
  }

  return [
    {
      name: JOB_FLUSH,
      cron: "* * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 5 * 60 },
      handler: async (job) => {
        const before = new Date(services.now().getTime() - PAGE_OPEN_IDLE_MS);
        for (const workspaceId of await workspaceIds(
          (job.data as { workspaceId?: string }).workspaceId,
        )) {
          const ctx = systemContext(workspaceId);
          const flushed = await services.db.withTenant(ctx, (tx) =>
            flushIdleFor(services, tx, ctx, before),
          );
          if (flushed > 0) services.log("analytics.flushed", { workspaceId, events: flushed });
        }
      },
    },
    {
      name: JOB_ROLLUP,
      cron: "*/5 * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 10 * 60 },
      handler: async (job) => {
        for (const workspaceId of await workspaceIds(
          (job.data as { workspaceId?: string }).workspaceId,
        )) {
          const events = await rollupWorkspace(workspaceId);
          if (events > 0) services.log("analytics.rolled_up", { workspaceId, events });
        }
      },
    },
    {
      name: JOB_MAINTAIN,
      cron: "15 3 * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async () => {
        const created = await services.db.withHost((tx) =>
          ensurePartitions(tx, PARTITION_MONTHS_AHEAD),
        );
        const facts = await services.db.withHost((tx) => workspaceRetentionFacts(tx));
        let retention: number | undefined;
        const held: string[] = [];
        const trimmed = { events: 0, sessions: 0, viewerRollups: 0, pageViewers: 0, hotLeads: 0 };
        const now = services.now();
        for (const ws of facts) {
          const parsed = parseWorkspaceSettings(ws.settings);
          const months = parsed.analytics.retentionMonths;
          retention = retention === undefined ? months : Math.max(retention, months);
          if (parsed.legal.legalHold) {
            held.push(ws.id);
            continue;
          }
          if (ws.deleted) continue;
          const ctx = systemContext(ws.id);
          const n = await services.db.withTenant(ctx, async (tx) => ({
            events: await new EventRepo(ctx, tx).deleteExpired(months, now),
            sessions: await new ViewSessionRepo(ctx, tx).deleteExpired(months, now),
            viewerRollups: await new RollupRepo(ctx, tx).deleteViewerExpired(months, now),
            pageViewers: await new PageRollupRepo(ctx, tx).deleteViewerExpired(months, now),
            hotLeads: await new HotLeadRepo(ctx, tx).deleteExpired(months, now),
          }));
          for (const k of Object.keys(trimmed) as (keyof typeof trimmed)[]) trimmed[k] += n[k];
        }
        const dropped: string[] = [];
        if (retention !== undefined && held.length === 0) {
          const longest = retention;
          const names = await services.db.withHost((tx) => expiredPartitions(tx, longest));
          for (const name of names) {
            await services.db.withHost((tx) => dropPartition(tx, name));
            dropped.push(name);
          }
        }
        services.log("analytics.maintained", {
          created,
          dropped,
          retentionMonths: retention ?? null,
          trimmedEvents: trimmed.events,
          trimmedSessions: trimmed.sessions,
          trimmedViewerRollups: trimmed.viewerRollups,
          trimmedPageViewers: trimmed.pageViewers,
          trimmedHotLeads: trimmed.hotLeads,
          legalHold: held,
        });
      },
    },
  ];
}
