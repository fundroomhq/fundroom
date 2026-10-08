import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { AnalyticsSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import type { Actor } from "../errors.js";
import {
  EventRepo,
  HotLeadRepo,
  readAnalyticsSettings,
  type SignalRow,
} from "../repos/analytics-repo.js";
import { hotListCsv } from "./csv.js";
import { type HotScore, hotScore, type ScoreCounts, type ScorePoints } from "./scoring.js";

/*
 * The hot list (E2.6, design/03 G2): external members ranked by `hotScore` over the last N
 * days, with the breakdown that produced each score, a CSV of the same list, and the alert pass
 * the rollup job runs after every walk.
 *
 * Who is ranked, and when. Behavioural engagement scoring is not "strictly necessary" access
 * logging (design/04 §3.1), so it is an `engagement`-tier feature: under `off` or `essential`
 * the list is empty and no alert fires, and under `engagement` a member is ranked only while
 * `legal.allowsPurpose(member, "analytics_engagement")` holds — the same gate page dwell obeys,
 * so an objection (or a GPC-backed refusal recorded as one) takes a member off the list at once
 * rather than when their events age out. Staff are never ranked: the list is about investors.
 * Automated email opens and clicks are counted in the breakdown and never scored (`scoring.ts`).
 */
export const HOT_LIST_LIMIT = 200;
const DAY_MS = 86_400_000;

export interface HotListEntry {
  membershipId: string;
  displayName: string;
  role: string;
  score: number;
  points: ScorePoints;
  counts: ScoreCounts;
  lastActivityAt: string | null;
}

export interface HotList {
  mode: AnalyticsSettings["mode"];
  days: number;
  threshold: number | null;
  generatedAt: string;
  entries: HotListEntry[];
}

interface Scored {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: string;
  readonly hot: HotScore;
}

/**
 * Scores members with activity since `now - days`, keeps external members scoring at least
 * `minScore` (and above zero) whose consent allows engagement analytics, and ranks them: score,
 * then most recent activity, then id (a total order, so the CSV is stable). Consent is checked
 * last and only down to `limit`, so the per-member lookups stay bounded.
 */
async function scoreMembers(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  days: number,
  now: Date,
  opts: { readonly limit: number; readonly minScore: number },
): Promise<Scored[]> {
  const from = new Date(now.getTime() - days * DAY_MS);
  const signals = await new EventRepo(ctx, tx).signalsSince(from);
  const byMember = new Map<string, SignalRow[]>();
  for (const s of signals) {
    const list = byMember.get(s.membershipId) ?? [];
    list.push(s);
    byMember.set(s.membershipId, list);
  }
  const names = await new MembershipRepo(ctx, tx).namesFor([...byMember.keys()]);
  const scored: Scored[] = [];
  for (const [membershipId, rows] of byMember) {
    const ref = names.get(membershipId);
    if (ref === undefined || ref.kind !== "external") continue;
    const hot = hotScore(rows, { now, windowDays: days });
    if (hot.score === 0 || hot.score < opts.minScore) continue;
    scored.push({ membershipId, displayName: ref.displayName, role: ref.role, hot });
  }
  scored.sort(
    (a, b) =>
      b.hot.score - a.hot.score ||
      (b.hot.lastActivityAt?.getTime() ?? 0) - (a.hot.lastActivityAt?.getTime() ?? 0) ||
      a.membershipId.localeCompare(b.membershipId),
  );
  const out: Scored[] = [];
  for (const s of scored) {
    if (out.length >= opts.limit) break;
    // An erased member is never ranked or announced, whatever rows the pipeline still holds.
    if (await services.legal.isErased(tx, ctx, s.membershipId)) continue;
    if (await services.legal.allowsPurpose(tx, ctx, s.membershipId, "analytics_engagement")) {
      out.push(s);
    }
  }
  return out;
}

const entryOf = (s: Scored): HotListEntry => ({
  membershipId: s.membershipId,
  displayName: s.displayName,
  role: s.role,
  score: s.hot.score,
  points: s.hot.points,
  counts: s.hot.counts,
  lastActivityAt: s.hot.lastActivityAt?.toISOString() ?? null,
});

export interface HotListService {
  list(ctx: TenantContext, settings: AnalyticsSettings, days: number): Promise<HotList>;
  /** The same list as RFC 4180 CSV; audited (`analytics.hot_list_exported`) in the same transaction. */
  exportCsv(
    ctx: TenantContext,
    settings: AnalyticsSettings,
    days: number,
    actor: Actor,
  ): Promise<{ csv: string; rows: number }>;
}

export function createHotListService(services: ModuleServices): HotListService {
  async function read(tx: Tx, ctx: TenantContext, settings: AnalyticsSettings, days: number) {
    const now = services.now();
    const entries =
      settings.mode === "engagement"
        ? (
            await scoreMembers(services, ctx, tx, days, now, { limit: HOT_LIST_LIMIT, minScore: 1 })
          ).map(entryOf)
        : [];
    return {
      mode: settings.mode,
      days,
      threshold: settings.hotLeadThreshold,
      generatedAt: now.toISOString(),
      entries,
    } satisfies HotList;
  }

  return {
    list(ctx, settings, days) {
      return services.db.withTenant(ctx, (tx) => read(tx, ctx, settings, days));
    },

    exportCsv(ctx, settings, days, actor) {
      return services.db.withTenant(ctx, async (tx) => {
        const list = await read(tx, ctx, settings, days);
        await services.audit.record(tx, ctx, {
          action: "analytics.hot_list_exported",
          resourceKind: "workspace",
          resourceId: ctx.workspaceId,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          meta: { rows: list.entries.length, days, mode: list.mode },
        });
        return { csv: hotListCsv(list.entries), rows: list.entries.length };
      });
    },
  };
}

/**
 * The alert pass (`analytics.rollup`, after the walk): members now at or above
 * `hotLeadThreshold` who have not been announced within the scoring window get one
 * `analytics.hot_lead` each. Nothing when the threshold is `null` or the mode is not
 * `engagement`. The claim and the outbox row share a transaction, so a member is announced
 * exactly once even if the job dies half way.
 *
 * It scores every member active in the window rather than only those the walk just folded: an
 * email open is stamped with the provider's time and routinely arrives minutes late — behind
 * the rollup cursor, so no walk ever hands it over — and it must still be able to tip a member
 * over the threshold. One grouped read of the window per workspace per pass.
 */
export async function announceHotLeads(
  services: ModuleServices,
  workspaceId: string,
): Promise<number> {
  const ctx = systemContext(workspaceId);
  return services.db.withTenant(ctx, async (tx) => {
    const settings = await readAnalyticsSettings(tx, workspaceId);
    const threshold = settings.hotLeadThreshold;
    if (settings.mode !== "engagement" || threshold === null) return 0;
    const days = settings.hotListWindowDays;
    const scored = await scoreMembers(services, ctx, tx, days, services.now(), {
      limit: HOT_LIST_LIMIT,
      minScore: threshold,
    });
    let announced = 0;
    const alerts = new HotLeadRepo(ctx, tx);
    for (const s of scored) {
      if (!(await alerts.claim(s.membershipId, s.hot.score, days))) continue;
      await publish(tx, ctx, "analytics.hot_lead", {
        membershipId: s.membershipId,
        score: s.hot.score,
      });
      announced += 1;
    }
    return announced;
  });
}
