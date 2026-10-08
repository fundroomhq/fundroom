import {
  OFFERING_STATUSES,
  type OfferingPeriod,
  type OfferingStatus,
  type TenantContext,
  type Tx,
  updateOfferingStatus,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { type Actor, ComplianceError } from "../errors.js";
import { OfferingPeriodRepo, readWorkspaceFacts } from "../repos/compliance-repo.js";
import type { ComplianceDeps } from "./types.js";

/*
 * Offering mode (ADR-0019, EXECUTION_PLAN §11, design/04 §1.6).
 *
 * The status is two things at once: a column on `core.workspace` that every request reads, and an
 * append-only `core.offering_period` history that answers "which status was in force when this
 * document was disclosed". `change()` moves both in one transaction, because a column that
 * disagrees with its own history is worse than either alone.
 */

/** What a status permits, as data. §11's table, so the UI and the route guards read one source. */
export interface OfferingPermits {
  readonly status: OfferingStatus;
  /** May the round / terms module be enabled at all? */
  readonly roundAndTerms: boolean;
  /** May a section be published to unauthenticated readers? */
  readonly publicSections: boolean;
  /** May share links be issued? (Always identity-bound; this is about issuing them at all.) */
  readonly shareLinks: boolean;
  /** Must an investor pass accreditation before an indication of interest is accepted? */
  readonly accreditationRequired: boolean;
  /**
   * May a verified public access request be approved automatically (E3.1, email-domain rule)?
   * Never under 506(b): every admission there needs a person to attest a pre-existing
   * relationship (design/03:182).
   */
  readonly requestAutoApprove: boolean;
  /** One sentence an admin can read without a lawyer. */
  readonly explanation: string;
}

const PERMITS: Readonly<Record<OfferingStatus, Omit<OfferingPermits, "status">>> = Object.freeze({
  none: {
    roundAndTerms: false,
    publicSections: false,
    shareLinks: false,
    accreditationRequired: false,
    requestAutoApprove: true,
    explanation:
      "No offering. Nothing about securities is published and the portal is a private room for existing relationships.",
  },
  informational: {
    roundAndTerms: false,
    publicSections: true,
    shareLinks: false,
    accreditationRequired: false,
    requestAutoApprove: true,
    explanation:
      "Informational only. Factual business information may be public, a banner says no securities are being offered, and the round and terms modules stay off.",
  },
  "506b": {
    roundAndTerms: true,
    publicSections: true,
    shareLinks: true,
    accreditationRequired: false,
    requestAutoApprove: false,
    explanation:
      "Rule 506(b): no general solicitation. Public sections may carry factual business information only — never terms — and every investor must have a relationship that pre-dates the offer.",
  },
  "506c": {
    roundAndTerms: true,
    publicSections: true,
    shareLinks: true,
    accreditationRequired: true,
    requestAutoApprove: true,
    explanation:
      "Rule 506(c): you may solicit publicly behind an accredited-only legend, and in exchange every purchaser must be verified as accredited, not merely self-certified.",
  },
  non_us: {
    roundAndTerms: true,
    publicSections: false,
    shareLinks: true,
    accreditationRequired: false,
    requestAutoApprove: true,
    explanation:
      "Non-US template. The US exemptions do not apply; local rules do, and this deployment enforces the conservative defaults until a jurisdiction profile is configured.",
  },
});

/** The §11 permissions table for one status, or for every status when called with no argument. */
export function permits(status: OfferingStatus): OfferingPermits;
export function permits(): readonly OfferingPermits[];
export function permits(status?: OfferingStatus): OfferingPermits | readonly OfferingPermits[] {
  if (status === undefined) {
    return OFFERING_STATUSES.map((s) => ({ status: s, ...PERMITS[s] }));
  }
  return { status, ...PERMITS[status] };
}

/**
 * Reliance on Rule 506(c) is irrevocable for the offering it was claimed for: once the company has
 * solicited publicly it cannot un-solicit, so falling back to 506(b) for the same round is not a
 * setting, it is a new offering. The service refuses the move rather than warning about it (R5's
 * "warn, never block" is about people, not about this).
 */
export function isIrrevocableFrom(status: OfferingStatus): boolean {
  return status === "506c";
}

export interface OfferingChange {
  readonly to: OfferingStatus;
  readonly reason?: string | undefined;
  readonly actor: Actor;
  /**
   * The route layer sets this once the admin has confirmed an irrevocable move (a confirm-token
   * round trip). Without it, `change()` returns `requiresConfirmation` instead of writing.
   */
  readonly confirmed?: boolean | undefined;
}

export interface OfferingState {
  readonly status: OfferingStatus;
  /** The open period. Seeded lazily, so this is never undefined after a call to `current()`. */
  readonly period: OfferingPeriod;
  readonly permits: OfferingPermits;
}

export interface OfferingChangeResult {
  /** When true nothing was written: ask the admin to confirm, then call again with `confirmed`. */
  readonly requiresConfirmation: boolean;
  readonly from: OfferingStatus;
  readonly to: OfferingStatus;
  readonly period?: OfferingPeriod | undefined;
  readonly permits: OfferingPermits;
}

export interface OfferingService {
  current(ctx: TenantContext, tx: Tx): Promise<OfferingState>;
  history(ctx: TenantContext, tx: Tx): Promise<readonly OfferingPeriod[]>;
  change(ctx: TenantContext, tx: Tx, input: OfferingChange): Promise<OfferingChangeResult>;
  /** The §11 table, for the admin screen that explains what a status would do. */
  permits(status?: OfferingStatus): OfferingPermits | readonly OfferingPermits[];
}

export function createOfferingService(deps: ComplianceDeps): OfferingService {
  const now = deps.now ?? (() => new Date());

  /**
   * Every workspace that existed before E1.6 has an `offering_status` but no period rows. Rather
   * than backfilling a start date we cannot know, the first read opens a period *now* for the
   * status the workspace already has: the history then honestly says "this status has been in
   * force at least since we started recording", which is what an auditor can rely on.
   */
  async function ensurePeriod(
    ctx: TenantContext,
    tx: Tx,
    status: OfferingStatus,
  ): Promise<OfferingPeriod> {
    const periods = new OfferingPeriodRepo(ctx, tx);
    const open = await periods.current();
    if (open !== undefined) return open;
    // Idempotent: two first reads at once both end up with the one seeded row (E3.2).
    return periods.openIfNone({ status, startedAt: now(), reason: "seed" });
  }

  async function facts(ctx: TenantContext, tx: Tx) {
    const ws = await readWorkspaceFacts(tx, ctx);
    if (ws === undefined) throw new ComplianceError("not_found", "workspace not visible");
    return ws;
  }

  return {
    permits,

    async current(ctx, tx) {
      const ws = await facts(ctx, tx);
      const period = await ensurePeriod(ctx, tx, ws.offeringStatus);
      return { status: ws.offeringStatus, period, permits: permits(ws.offeringStatus) };
    },

    async history(ctx, tx) {
      const ws = await facts(ctx, tx);
      await ensurePeriod(ctx, tx, ws.offeringStatus);
      return new OfferingPeriodRepo(ctx, tx).history();
    },

    async change(ctx, tx, input) {
      const ws = await facts(ctx, tx);
      const from = ws.offeringStatus;
      const { to } = input;

      if (isIrrevocableFrom(from) && to !== from) {
        throw new ComplianceError(
          "offering_irrevocable",
          "reliance on Rule 506(c) is irrevocable for this offering; close the offering and start a new one rather than switching back",
          { from, to },
        );
      }
      if (to === from) {
        const period = await ensurePeriod(ctx, tx, from);
        return { requiresConfirmation: false, from, to, period, permits: permits(to) };
      }
      // Switching *to* 506(c) is the point of no return, so it costs a confirmation round trip.
      if (isIrrevocableFrom(to) && input.confirmed !== true) {
        return { requiresConfirmation: true, from, to, permits: permits(to) };
      }

      const periods = new OfferingPeriodRepo(ctx, tx);
      const open = await ensurePeriod(ctx, tx, from);
      /*
       * The instant has to be read *after* the period exists, and never before the period it is
       * about to close began. A workspace that predates E1.6 has its first period seeded right
       * here, at `now()`; taking the timestamp earlier would close that period before it opened
       * and trip the `offering_period_window` CHECK — a 500 that only appears for a workspace
       * changing its status for the first time, which is every workspace, once.
       */
      const at = new Date(Math.max(now().getTime(), open.startedAt.getTime()));
      await periods.close(open.id, at);
      const period = await periods.open({
        status: to,
        startedAt: at,
        changedBy: input.actor.membershipId,
        reason: input.reason ?? null,
      });
      await updateOfferingStatus(tx, ctx.workspaceId, to);

      await deps.audit.record(tx, ctx, {
        action: "workspace.offering_status_changed",
        resourceKind: "workspace",
        resourceId: ctx.workspaceId,
        actorMembershipId: input.actor.membershipId,
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        diff: { before: { offeringStatus: from }, after: { offeringStatus: to } },
        meta: {
          from,
          to,
          periodId: period.id,
          irrevocable: isIrrevocableFrom(to),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      });
      await publish(tx, ctx, "workspace.offering_status_changed", {
        workspaceId: ctx.workspaceId,
        from,
        to,
        byMembershipId: input.actor.membershipId,
      });

      return { requiresConfirmation: false, from, to, period, permits: permits(to) };
    },
  };
}
