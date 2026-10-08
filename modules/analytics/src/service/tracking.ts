import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { AnalyticsSettings, LegalSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import {
  ANALYTICS_IP_PURPOSE,
  cappedDwellMs,
  ipHashOf,
  sessionKeyOf,
  tracksFor,
  uaFamilyOf,
} from "../privacy.js";
import {
  EventRepo,
  lockWorkspaceAnalytics,
  PageOpenRepo,
  ViewSessionRepo,
} from "../repos/analytics-repo.js";
import type { ResourceKind } from "../schema/analytics.js";

/*
 * Member-facing tracking (design/06 §6): the page-dwell heartbeat, the close beacon and the
 * transparency notice. RLS admits staff and system actors only, so everything here runs in a
 * `system` tenant transaction — the caller's membership id travels as data, never as the
 * transaction's actor. Nothing an investor sends decides *whether* we record: the workspace's
 * mode does, and anything below `engagement` turns the heartbeat into a no-op.
 *
 * Since E1.6 the mode is necessary but no longer sufficient: dwell is optional tracking, so a
 * member must also be permitted under the workspace's consent mode (R13). That decision is a
 * kernel fact about a person, so it is asked of `services.legal.allowsPurpose` rather than
 * re-derived here — and it is asked on the server, because a client that decides for itself
 * can only ever get it wrong in the permissive direction.
 */
export interface Beater {
  readonly membershipId: string;
  readonly sessionId: string;
  /** The request carried a Global Privacy Control signal (`Sec-GPC: 1`). */
  readonly gpc: boolean;
  readonly ip?: string | undefined;
  readonly userAgent?: string | null | undefined;
  readonly embed: boolean;
}

export interface BeatInput {
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly versionId?: string | undefined;
  readonly page: number;
  readonly ms: number;
}

export interface HeartbeatResult {
  readonly accepted: boolean;
  readonly reason?: "mode" | "consent" | "unopened" | undefined;
}

/** What the portal tells the person being measured, and what their browser is allowed to send. */
export interface Notice {
  readonly mode: AnalyticsSettings["mode"];
  readonly tracks: string[];
  readonly consent: {
    readonly mode: LegalSettings["consentMode"];
    readonly granted: boolean | null;
    readonly gpc: boolean;
    readonly shouldAsk: boolean;
  };
  readonly dwell: boolean;
  /** E2.6: the caller's `email_tracking` purpose — their stored answer and whether opens/clicks are recorded. */
  readonly emailTracking: {
    readonly granted: boolean | null;
    readonly active: boolean;
  };
}

/** The caller's stored answer and the signals their browser sent with this request. */
export interface ConsentSignals {
  readonly membershipId: string;
  readonly gpc: boolean;
}

export interface TrackingService {
  notice(
    workspaceId: string,
    settings: AnalyticsSettings,
    legal: LegalSettings,
    who: ConsentSignals,
  ): Promise<Notice>;
  /**
   * Takes no `LegalSettings`: the consent mode is folded in by `services.legal.allowsPurpose`,
   * which reads it from the workspace itself. Passing it here too would invite the two to
   * disagree.
   */
  heartbeat(
    workspaceId: string,
    settings: AnalyticsSettings,
    who: Beater,
    input: BeatInput,
  ): Promise<HeartbeatResult>;
  close(
    workspaceId: string,
    who: Pick<Beater, "sessionId">,
    input: { resourceKind: ResourceKind; resourceId: string },
  ): Promise<{ flushed: number }>;
}

export function createTrackingService(services: ModuleServices): TrackingService {
  /** The workspace's `analytics-ip` key, created on first use like every other data key. */
  async function ipHashFor(tx: Tx, ctx: TenantContext, ip: string | undefined) {
    if (ip === undefined || ip.length === 0) return null;
    const key = await services.crypto.currentKey(tx, ctx, ANALYTICS_IP_PURPOSE);
    return ipHashOf(key.key, ip);
  }

  /**
   * Whether this member may be measured beyond the strictly-necessary access facts. Asked in a
   * `system` transaction like everything else here: the consent row belongs to the member, but
   * reading it is the module's business, not theirs.
   */
  async function mayTrackDwell(workspaceId: string, who: ConsentSignals): Promise<boolean> {
    const ctx = systemContext(workspaceId);
    return services.db.withTenant(ctx, (tx) =>
      services.legal.allowsPurpose(tx, ctx, who.membershipId, "analytics_engagement", {
        gpc: who.gpc,
      }),
    );
  }

  return {
    async notice(workspaceId, settings, legal, who) {
      const ctx = systemContext(workspaceId);
      const stored = await services.db.withTenant(ctx, (tx) =>
        services.legal.consentFor(tx, ctx, who.membershipId, "analytics_engagement"),
      );
      const allowed = await mayTrackDwell(workspaceId, who);
      const email = await services.db.withTenant(ctx, async (tx) => ({
        granted: await services.legal.consentFor(tx, ctx, who.membershipId, "email_tracking"),
        allowed:
          settings.mode === "engagement" &&
          (await services.legal.allowsPurpose(tx, ctx, who.membershipId, "email_tracking", {
            gpc: who.gpc,
          })),
      }));
      return {
        mode: settings.mode,
        tracks: tracksFor(settings.mode),
        consent: {
          mode: legal.consentMode,
          granted: stored,
          gpc: who.gpc,
          // Only an opt-in workspace has anything to ask; the others record until told not to.
          shouldAsk:
            settings.mode === "engagement" &&
            legal.consentMode === "opt_in" &&
            stored === null &&
            !who.gpc,
        },
        dwell: settings.mode === "engagement" && allowed,
        emailTracking: { granted: email.granted, active: email.allowed },
      };
    },

    async heartbeat(workspaceId, settings, who, input) {
      if (settings.mode !== "engagement") return { accepted: false, reason: "mode" };
      if (!(await mayTrackDwell(workspaceId, { membershipId: who.membershipId, gpc: who.gpc })))
        return { accepted: false, reason: "consent" };
      const ms = cappedDwellMs(input.ms);
      const ctx = systemContext(workspaceId);
      return services.db.withTenant(ctx, async (tx) => {
        // An erased member writes nothing back (E2.6). `allowsPurpose` says no for them too;
        // this is the explicit check, inside the transaction that would write.
        if (await services.legal.isErased(tx, ctx, who.membershipId)) {
          return { accepted: false, reason: "consent" as const };
        }
        const viewSessionId = await new ViewSessionRepo(ctx, tx).upsert({
          membershipId: who.membershipId,
          sessionKey: sessionKeyOf(who.sessionId),
          ipHash: await ipHashFor(tx, ctx, who.ip),
          uaFamily: uaFamilyOf(who.userAgent),
          embed: who.embed,
        });
        /*
         * The beat names the resource, so on its own it is the caller's claim about what they
         * are reading. Honour it only where the server has already recorded this session
         * opening that resource: the authorisation happened in the route that emitted
         * `document.viewed`, and requiring evidence of it keeps a member from writing
         * themselves into the "who viewed" list of a document they never opened. A beat that
         * overtakes its own outbox event is refused; the next one, seconds later, is not.
         */
        if (
          !(await new EventRepo(ctx, tx).hasOpen(
            viewSessionId,
            input.resourceKind,
            input.resourceId,
          ))
        ) {
          return { accepted: false, reason: "unopened" as const };
        }
        // A zero-length beat still touches the session (the tab is open, the page is not read).
        if (ms > 0) {
          await new PageOpenRepo(ctx, tx).beat({
            viewSessionId,
            membershipId: who.membershipId,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            versionId: input.versionId ?? null,
            pageNo: input.page,
            ms,
          });
        }
        return { accepted: true };
      });
    },

    async close(workspaceId, who, input) {
      const ctx = systemContext(workspaceId);
      const flushed = await services.db.withTenant(ctx, async (tx) => {
        const sessionId = await new ViewSessionRepo(ctx, tx).findIdByKey(
          sessionKeyOf(who.sessionId),
        );
        // No session row means nothing was ever beaten for this tab: nothing to flush.
        if (sessionId === undefined) return 0;
        await lockWorkspaceAnalytics(tx, workspaceId);
        const opens = new PageOpenRepo(ctx, tx);
        for (const id of await opens.membersOfSession(sessionId, input.resourceId)) {
          if (await services.legal.isErased(tx, ctx, id)) await opens.deleteForMembership(id);
        }
        return opens.flushSession(sessionId, input.resourceId);
      });
      return { flushed };
    },
  };
}
