import {
  type OfferingStatus,
  pgErrorCode,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices, ResolvedDisclaimer } from "@fundroom/module-kit";
import { type Eligibility, eligibility, type Terms } from "@fundroom/round-terms";
import { type Actor, RoundError } from "../errors.js";
import { type InterestSubject, NON_ACCREDITED_LIMIT } from "../model.js";
import {
  type ClosingTaskRecord,
  ClosingTaskRepo,
  CommitmentRepo,
  type InterestRecord,
  InterestRepo,
  type NewRound,
  type RoundPatch,
  type RoundRecord,
  RoundRepo,
  type TermsRecord,
  TermsRepo,
} from "../repos/round-repo.js";
import { investorProgress, type RoundAllocation, readAllocation } from "./allocation.js";

/*
 * Rounds: the staff CRUD, the open/close lifecycle, the closing checklist, and the one
 * investor-facing read (`GET /round/current`) that assembles the whole investor page.
 *
 * Two lifecycle rules live here rather than in the routes, because both have to hold for a
 * caller that is not an HTTP request:
 *
 *  - a round cannot open without terms. An "open round" with nothing to read is an invitation
 *    to indicate interest in something undisclosed, which is the one thing §7's offering rules
 *    are about;
 *  - at most one round is open at a time. The *index* enforces it (a SELECT-then-INSERT check
 *    loses a race between two `POST /open` calls); this turns the 23505 into a sentence.
 */

/** The per-round counters the admin screen badges, including E2.5 D7's 35. */
export interface RoundCounters {
  readonly submitted: number;
  readonly accepted: number;
  readonly nonAccreditedAccepted: number;
  readonly limit: number;
}

export interface RoundDetail {
  readonly round: RoundRecord;
  readonly terms: TermsRecord | undefined;
  readonly history: readonly TermsRecord[];
  readonly allocation: RoundAllocation;
  readonly counters: RoundCounters;
}

/** Everything the investor's round page needs, in one read. */
export interface InvestorView {
  readonly round: RoundRecord | undefined;
  readonly terms: TermsRecord | undefined;
  readonly disclaimer: ResolvedDisclaimer | undefined;
  readonly progress: ReturnType<typeof investorProgress> | undefined;
  readonly calculatorDefaults: { readonly amount: string; readonly currency: string };
  readonly mySubmissions: readonly InterestRecord[];
  readonly eligibilityHint: (Eligibility & { readonly accredited: boolean }) | undefined;
}

export interface InvestorViewInput {
  readonly ctx: TenantContext;
  readonly membershipId: string;
  readonly isStaff: boolean;
  readonly offeringStatus: OfferingStatus;
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
  /** `subject` and `amount` the SPA is previewing with; defaults to an individual at the minimum. */
  readonly subject?: InterestSubject | undefined;
}

/**
 * How long one session's view of one terms revision suppresses another `round.terms_viewed`
 * row. §R asks for "once per session per terms revision"; a session outlives a process, so the
 * map is also bounded and swept, exactly like `data-room`'s view dedupe.
 */
const VIEW_DEDUPE_MS = 30 * 60_000;

/** A tenth of the target, or the stated minimum — what the calculator opens on. */
export function calculatorDefault(round: RoundRecord): string {
  if (round.minimumInvestment !== null) return round.minimumInvestment;
  const target = Number.parseFloat(round.targetAmount);
  // Presentation only: this figure is a *starting position in a form field*, never arithmetic
  // anybody relies on, and it is re-parsed as a decimal string the moment it is used.
  if (!Number.isFinite(target) || target <= 0) return "0.00";
  return (Math.round(target / 10) || 1).toFixed(2);
}

export function createRoundService(services: ModuleServices) {
  const { db } = services;
  const recentTermsViews = new Map<string, number>();

  async function detailIn(ctx: TenantContext, tx: Tx, round: RoundRecord): Promise<RoundDetail> {
    const termsRepo = new TermsRepo(ctx, tx);
    const interest = new InterestRepo(ctx, tx);
    const [current, history, allocation, counts, nonAccredited] = await Promise.all([
      termsRepo.current(round.id, round.instrumentKind),
      termsRepo.history(round.id, round.instrumentKind),
      readAllocation(ctx, tx, round),
      interest.countsFor(round.id),
      interest.nonAccreditedAcceptedCount(round.id),
    ]);
    return {
      round,
      terms: current,
      history,
      allocation,
      counters: {
        submitted: counts.submitted,
        accepted: counts.accepted,
        nonAccreditedAccepted: nonAccredited,
        limit: NON_ACCREDITED_LIMIT,
      },
    };
  }

  return {
    list(ctx: TenantContext): Promise<RoundRecord[]> {
      return db.withTenant(ctx, (tx) => new RoundRepo(ctx, tx).list());
    },

    async get(ctx: TenantContext, id: string): Promise<RoundDetail> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(id);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        return detailIn(ctx, tx, round);
      });
    },

    async allocation(ctx: TenantContext, id: string): Promise<RoundAllocation> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(id);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        return readAllocation(ctx, tx, round);
      });
    },

    async create(ctx: TenantContext, input: NewRound, actor: Actor): Promise<RoundRecord> {
      return db.withTenant(ctx, async (tx) => {
        const created = await new RoundRepo(ctx, tx).insert({
          ...input,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "round.created",
          resourceKind: "round",
          resourceId: created.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            stage: created.stage,
            instrumentKind: created.instrumentKind,
            currency: created.currency,
            targetAmount: created.targetAmount,
          },
        });
        return created;
      });
    },

    async patch(
      ctx: TenantContext,
      id: string,
      patch: RoundPatch,
      actor: Actor,
    ): Promise<RoundRecord> {
      return db.withTenant(ctx, async (tx) => {
        const updated = await new RoundRepo(ctx, tx).update(id, patch);
        if (updated === undefined) throw new RoundError("not_found", "no such round");
        await services.audit.record(tx, ctx, {
          action: "round.updated",
          resourceKind: "round",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { fields: Object.keys(patch) },
        });
        return updated;
      });
    },

    /**
     * Hard delete, and only for a `planning` round nobody has touched.
     *
     * Rounds are history (§S): once one has been open, its terms and its commitments are the
     * record of an offering and have to survive for the six years EXECUTION_PLAN :471 asks for.
     * What this exists for is the round somebody created by mistake five minutes ago.
     */
    async remove(ctx: TenantContext, id: string, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(id);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        if (round.status !== "planning") {
          throw new RoundError(
            "conflict",
            "a round that has been open is history; close it instead of deleting it",
            { status: round.status },
          );
        }
        const commitments = await new CommitmentRepo(ctx, tx).countForRound(id);
        const interest = await new InterestRepo(ctx, tx).countsFor(id);
        if (commitments > 0 || interest.submitted > 0 || interest.accepted > 0) {
          throw new RoundError("conflict", "this round already has commitments or submissions", {
            commitments,
            submissions: interest.submitted + interest.accepted,
          });
        }
        const removed = await new RoundRepo(ctx, tx).remove(id);
        if (!removed) throw new RoundError("not_found", "no such round");
        await services.audit.record(tx, ctx, {
          action: "round.deleted",
          resourceKind: "round",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { name: round.name },
        });
      });
    },

    async open(ctx: TenantContext, id: string, actor: Actor): Promise<RoundRecord> {
      try {
        return await db.withTenant(ctx, async (tx) => {
          const repo = new RoundRepo(ctx, tx);
          const round = await repo.find(id);
          if (round === undefined) throw new RoundError("not_found", "no such round");
          if (round.status === "open") return round;
          if (round.status === "closed") {
            throw new RoundError("conflict", "a closed round cannot be reopened", {
              status: round.status,
            });
          }
          const terms = await new TermsRepo(ctx, tx).current(id, round.instrumentKind);
          if (terms === undefined) {
            throw new RoundError(
              "terms_missing",
              "write the terms before opening the round: an open round with nothing to read is an invitation to indicate interest in something undisclosed",
              { roundId: id },
            );
          }
          const opened = await repo.setStatus(id, "open", services.now());
          if (opened === undefined) throw new RoundError("not_found", "no such round");
          await services.audit.record(tx, ctx, {
            action: "round.opened",
            resourceKind: "round",
            resourceId: id,
            actorMembershipId: actor.membershipId,
            ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
            ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
            meta: { termsId: terms.id, revision: terms.revision },
          });
          await publish(tx, ctx, "round.opened", { roundId: id });
          return opened;
        });
      } catch (error) {
        // `round_one_open_idx`. Two admins pressing Open on two rounds is the race the index
        // exists for; this is where it becomes a sentence rather than a 500.
        if (pgErrorCode(error) === "23505") {
          throw new RoundError("round_already_open", "another round is already open", {});
        }
        throw error;
      }
    },

    async close(ctx: TenantContext, id: string, actor: Actor): Promise<RoundRecord> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new RoundRepo(ctx, tx);
        const round = await repo.find(id);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        if (round.status === "closed") return round;
        if (round.status !== "open") {
          throw new RoundError("conflict", "only an open round can be closed", {
            status: round.status,
          });
        }
        const closed = await repo.setStatus(id, "closed", services.now());
        if (closed === undefined) throw new RoundError("not_found", "no such round");
        await services.audit.record(tx, ctx, {
          action: "round.closed",
          resourceKind: "round",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {},
        });
        await publish(tx, ctx, "round.closed", { roundId: id });
        return closed;
      });
    },

    async closingTasks(ctx: TenantContext, roundId: string): Promise<ClosingTaskRecord[]> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        return new ClosingTaskRepo(ctx, tx).listForRound(roundId);
      });
    },

    async replaceClosingTasks(
      ctx: TenantContext,
      roundId: string,
      items: readonly { id?: string | undefined; title: string; done: boolean }[],
      actor: Actor,
    ): Promise<ClosingTaskRecord[]> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const tasks = await new ClosingTaskRepo(ctx, tx).replace(roundId, items, services.now());
        await services.audit.record(tx, ctx, {
          action: "round.closing_tasks_changed",
          resourceKind: "round",
          resourceId: roundId,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { count: tasks.length, done: tasks.filter((t) => t.doneAt !== null).length },
        });
        return tasks;
      });
    },

    /**
     * The investor's page (§R).
     *
     * Three things happen here that do not happen on any other read, and each is a compliance
     * requirement rather than a feature:
     *
     *  1. **`legal.noteExposure`** stamps `core.membership.first_exposure_at` the first time
     *     this member is shown offering material. Under 506(b) what matters is whether the
     *     relationship pre-dated the offer, so the column is written once and never overwritten.
     *  2. **`round.terms_viewed`** records which revision they were shown, with the disclaimer
     *     stamp and the offering status of the moment (plan §11). Throttled to once per session
     *     per revision, because otherwise a refresh is an audit row.
     *  3. **The progress bar is read in a system context.** `round.commitment` is staff-only in
     *     RLS — correctly, because what other investors put in is not this investor's business —
     *     so the buckets are computed off-fence and only the three aggregate figures cross back.
     */
    async investorView(input: InvestorViewInput): Promise<InvestorView> {
      const { ctx, membershipId, isStaff } = input;
      const assembled = await db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).currentForInvestor();
        const submissions = await new InterestRepo(ctx, tx).listForMember(membershipId);
        if (round === undefined) {
          return { round: undefined, terms: undefined, disclaimer: undefined, submissions };
        }
        const terms = await new TermsRepo(ctx, tx).current(round.id, round.instrumentKind);
        const disclaimer = await services.legal.resolveDisclaimer(tx, ctx);
        // Not while staff view the page as this investor (E2.7): that is not the investor
        // being shown offering material, and the stamp is evidence.
        if (!isStaff && ctx.viewAs === undefined)
          await services.legal.noteExposure(tx, ctx, membershipId);
        return { round, terms, disclaimer, submissions };
      });

      const round = assembled.round;
      if (round === undefined) {
        return {
          round: undefined,
          terms: undefined,
          disclaimer: assembled.disclaimer,
          progress: undefined,
          calculatorDefaults: { amount: "0.00", currency: "USD" },
          mySubmissions: assembled.submissions,
          eligibilityHint: undefined,
        };
      }

      // `showProgress` is the tenant's decision for investors; staff always see the figures,
      // because the admin screen is where the decision is made and hiding them there would hide
      // the thing being decided.
      const wantsProgress = isStaff || round.showProgress;
      const progress = wantsProgress
        ? investorProgress(
            await db.withTenant(systemContext(ctx.workspaceId), (tx) =>
              readAllocation(systemContext(ctx.workspaceId), tx, round),
            ),
          )
        : undefined;

      const defaults = { amount: calculatorDefault(round), currency: round.currency };
      let hint: (Eligibility & { accredited: boolean }) | undefined;
      if (round.status === "open") {
        const accreditation = await db.withTenant(ctx, (tx) =>
          services.legal.accreditation(tx, ctx, membershipId),
        );
        try {
          hint = {
            ...eligibility({
              offeringStatus: input.offeringStatus,
              subject: input.subject ?? "individual",
              amount: defaults.amount,
              currency: round.currency,
            }),
            accredited: accreditation.accredited,
          };
        } catch {
          // `eligibility()` throws for `none`/`informational`, which the module's own offering
          // gate has already refused. A hint is a hint: the page renders without one rather
          // than failing, and the POST is what actually decides.
          hint = undefined;
        }
      }

      // The audit row and the exposure stamp are about *offering material*, so they are written
      // only when there is material: a round with no terms shows nothing to record a view of.
      const terms = assembled.terms;
      if (!isStaff && terms !== undefined && ctx.viewAs === undefined) {
        const key = `${input.sessionId ?? membershipId}:${terms.id}`;
        const at = services.now().getTime();
        const last = recentTermsViews.get(key);
        if (last === undefined || at - last >= VIEW_DEDUPE_MS) {
          recentTermsViews.set(key, at);
          if (recentTermsViews.size > 10_000) {
            for (const [k, seen] of recentTermsViews) {
              if (at - seen > VIEW_DEDUPE_MS) recentTermsViews.delete(k);
            }
          }
          await db.withTenant(ctx, (tx) =>
            services.audit.record(tx, ctx, {
              action: "round.terms_viewed",
              resourceKind: "round_terms",
              resourceId: terms.id,
              actorMembershipId: membershipId,
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              meta: {
                roundId: round.id,
                termsId: terms.id,
                revision: terms.revision,
                offeringStatus: input.offeringStatus,
                disclaimerStamp: terms.disclaimerStamp,
              },
            }),
          );
        }
      }

      return {
        round,
        terms,
        disclaimer: assembled.disclaimer,
        progress,
        calculatorDefaults: defaults,
        mySubmissions: assembled.submissions,
        eligibilityHint: hint,
      };
    },

    /** The live terms of whatever round an investor is looking at; used by the calculator route. */
    async currentTerms(
      ctx: TenantContext,
    ): Promise<{ round: RoundRecord; terms: Terms } | undefined> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).currentForInvestor();
        if (round === undefined) return undefined;
        const current = await new TermsRepo(ctx, tx).current(round.id, round.instrumentKind);
        return current === undefined ? undefined : { round, terms: current.terms };
      });
    },
  };
}

export type RoundService = ReturnType<typeof createRoundService>;
