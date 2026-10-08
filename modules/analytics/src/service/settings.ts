import {
  lockWorkspaceFacts,
  type ResolvedWorkspace,
  type TenantContext,
  type Tx,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import {
  type AnalyticsSettings,
  parseWorkspaceSettings,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import type { EventHandler } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, AnalyticsError } from "../errors.js";
import {
  EventRepo,
  HotLeadRepo,
  lockWorkspaceAnalytics,
  PageOpenRepo,
  PageRollupRepo,
  RollupRepo,
  readWorkspaceSettingsIn,
  ViewSessionRepo,
} from "../repos/analytics-repo.js";

/*
 * Tracking mode, retention and the DSAR erasure (design/06 §6, design/04 §2). The settings live
 * on `core.workspace.settings.analytics`, so a change is one audited write plus a cache drop —
 * `off` stops every writer in this module at once. Anonymising a member removes every row that
 * names them; the daily rollups stay because they carry counts only.
 */
export interface AnonymiseCounts {
  events: number;
  pageOpens: number;
  viewSessions: number;
  viewerRollups: number;
  /** E2.6: the member's rows in the heatmap's distinct-reader set (the page counts stay). */
  pageViewers: number;
  /** E2.6: the "already announced as a hot lead" marker. */
  hotLeadAlerts: number;
}

/** The `PATCH /settings` body: every field may be absent. */
export interface AnalyticsSettingsPatch {
  readonly mode?: AnalyticsSettings["mode"] | undefined;
  readonly retentionMonths?: number | undefined;
  readonly hotListWindowDays?: number | undefined;
  /** `null` turns hot-lead alerts off (the list still ranks). */
  readonly hotLeadThreshold?: number | null | undefined;
}

/**
 * Every row in `analytics.*` that names the member, in the caller's transaction: raw events,
 * open pages, view sessions (with their salted IP hashes), per-viewer rollups, the heatmap's
 * distinct-reader rows and the hot-lead marker. The anonymous counts (`daily_resource_rollup`,
 * `page_rollup`) stay: they name nobody. Shared by the staff route and the DSAR subscriber.
 *
 * Races with the pipeline (E2.6): the workspace analytics lock is taken first, so the rollup walk
 * and the page_open flush — which take it too — run wholly before or wholly after this. Open
 * pages go before events regardless: a flush moves page_open rows into events, and deleting the
 * source first means no statement here can miss what a concurrent flush just produced.
 */
export async function eraseMemberRows(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<AnonymiseCounts> {
  await lockWorkspaceAnalytics(tx, ctx.workspaceId);
  const pageOpens = await new PageOpenRepo(ctx, tx).deleteForMembership(membershipId);
  return {
    events: await new EventRepo(ctx, tx).deleteForMembership(membershipId),
    pageOpens,
    viewSessions: await new ViewSessionRepo(ctx, tx).deleteForMembership(membershipId),
    viewerRollups: await new RollupRepo(ctx, tx).deleteViewerForMembership(membershipId),
    pageViewers: await new PageRollupRepo(ctx, tx).deleteViewerForMembership(membershipId),
    hotLeadAlerts: await new HotLeadRepo(ctx, tx).deleteForMembership(membershipId),
  };
}

/*
 * `analytics.member_erasure_requested` (E2.6, contract decision 5): the kernel's DSAR request
 * fans out over the outbox; this module erases its own rows, audits it (`analytics.anonymised`,
 * actor `system`, the request id in meta) and reports the counts back through
 * `legal.completeErasureStep`, all in the dispatcher's transaction — so the report can never
 * claim an erasure that rolled back. Idempotent: a redelivery deletes nothing and the kernel
 * keeps the first report. The legal hold is the kernel's to enforce (it refuses the request);
 * by the time the event exists the request was accepted.
 */
export function createErasureHandler(services: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const tenant = ctx as TenantContext;
    const p = event.payload as { requestId: string; membershipId: string };
    const counts = await eraseMemberRows(tenant, tx, p.membershipId);
    const svc = services();
    await svc.audit.record(tx, tenant, {
      action: "analytics.anonymised",
      resourceKind: "membership",
      resourceId: p.membershipId,
      subjectMembershipId: p.membershipId,
      meta: { ...counts, requestId: p.requestId },
    });
    await svc.legal.completeErasureStep(tx, tenant, p.requestId, "analytics", { ...counts });
  };
}

export interface AnalyticsSettingsService {
  read(workspace: Pick<ResolvedWorkspace, "settings">): AnalyticsSettings;
  patch(
    ctx: TenantContext,
    workspace: Pick<ResolvedWorkspace, "id" | "settings">,
    patch: AnalyticsSettingsPatch,
    actor: Actor,
  ): Promise<AnalyticsSettings>;
  anonymise(ctx: TenantContext, membershipId: string, actor: Actor): Promise<AnonymiseCounts>;
}

export function createAnalyticsSettingsService(services: ModuleServices): AnalyticsSettingsService {
  return {
    read(workspace) {
      return parseWorkspaceSettings(workspace.settings).analytics;
    },

    async patch(ctx, workspace, patch, actor) {
      const next = await services.db.withTenant(ctx, async (tx) => {
        // The `analytics` block alone, merged on the row-locked copy (A-3 R2 M1): never the
        // caller's cached `workspace.settings`, never the whole document — a concurrent writer of
        // another block keeps its change. Row lock first, audit last (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, workspace.id))?.settings,
        );
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          analytics: { ...current.analytics, ...patch },
        });
        await updateWorkspaceSettingsBlock(tx, workspace.id, "analytics", next.analytics);
        await services.audit.record(tx, ctx, {
          action: "analytics.settings_changed",
          resourceKind: "workspace",
          resourceId: workspace.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          meta: {
            fields: Object.keys(patch),
            mode: next.analytics.mode,
            retentionMonths: next.analytics.retentionMonths,
            hotListWindowDays: next.analytics.hotListWindowDays,
            hotLeadThreshold: next.analytics.hotLeadThreshold,
          },
        });
        return next;
      });
      services.workspaces.invalidate(workspace.id);
      return next.analytics;
    },

    async anonymise(ctx, membershipId, actor) {
      return services.db.withTenant(ctx, async (tx) => {
        const known = await new MembershipRepo(ctx, tx).namesFor([membershipId]);
        if (!known.has(membershipId)) {
          throw new AnalyticsError("not_found", "no such member", { membershipId });
        }
        // A legal hold overrides deletion (design/04 §3.2 exception (a)), exactly as the kernel's
        // DSAR request refuses: same 409 `conflict`, same `reason`. Read in this transaction,
        // not from the cached workspace, so a hold set a moment ago already applies.
        if ((await readWorkspaceSettingsIn(tx, ctx.workspaceId)).legal.legalHold) {
          throw new AnalyticsError("conflict", "the workspace is under legal hold", {
            reason: "legal_hold",
          });
        }
        const counts = await eraseMemberRows(ctx, tx, membershipId);
        await services.audit.record(tx, ctx, {
          action: "analytics.anonymised",
          resourceKind: "membership",
          resourceId: membershipId,
          subjectMembershipId: membershipId,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          meta: { ...counts },
        });
        return counts;
      });
    },
  };
}
