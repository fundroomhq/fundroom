import { type OfferingStatus, pgErrorCode, systemContext, type TenantContext } from "@fundroom/db";
import { parseFixed } from "@fundroom/decimal";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { AccreditationAnswersInput, ModuleServices } from "@fundroom/module-kit";
import { type Eligibility, eligibility } from "@fundroom/round-terms";
import { type Actor, RoundError } from "../errors.js";
import type { InterestSubject } from "../model.js";
import { NON_ACCREDITED_LIMIT } from "../model.js";
import {
  type CommitmentRecord,
  CommitmentRepo,
  type InterestRecord,
  InterestRepo,
  RoundRepo,
  type VerificationRecord,
  VerificationRepo,
} from "../repos/round-repo.js";
import { openVerification } from "./vendor.js";

/*
 * The interest form (E2.5 §B, design/03 §83).
 *
 * "Indicate interest", never "subscribe": nothing here takes money, and design/03 is explicit
 * that there are no payment instructions before an admin accepts. What the form does do is
 * decide, *server-side*, which accreditation path the offering status and the amount imply
 * (D4 — the browser previews the same answer from the same pure function and never decides),
 * record the questionnaire through `ModuleServices.legal` so the two attestation rows E2.3 froze
 * are written by the kernel rather than by this module, and — under 506(c), below the
 * minimum-investment safe harbour — open a verification the company has to settle before it can
 * accept anything.
 *
 * Everything this module knows about a person's accredited status it learns from `legal`. It
 * never touches `core.attestation` (D5), because that row's lifecycle — its expiry, its
 * revocation, the policy gate that reads it — belongs to the kernel.
 */

/** §R: five submissions per member per hour. */
export const INTEREST_RATE = { max: 5, windowMs: 60 * 60_000 } as const;

/**
 * Whether the kernel's live `accredited` attestation came from somebody **checking**.
 *
 * This is the distinction the whole 506(c) flow turns on, and it is why the gate cannot simply
 * read `accredited`. A self-certification writes an `accredited` row too — that is what E2.3
 * froze, and what the policy gate reads under 506(b) — with `data.method: "self_certified"`.
 * Treating that row as satisfying 506(c) would let an investor tick a box and be accepted, which
 * is exactly the step Rule 506(c) adds over 506(b), and exactly what `@fundroom/compliance`
 * prefixes `verified:` in order to keep answerable six years later.
 */
const isVerified = (accreditation: {
  readonly accredited: boolean;
  readonly method?: string | undefined;
}): boolean => accreditation.accredited && (accreditation.method ?? "").startsWith("verified:");

export interface SubmitInterestInput {
  readonly ctx: TenantContext;
  readonly membershipId: string;
  readonly offeringStatus: OfferingStatus;
  readonly amount: string;
  readonly subject: InterestSubject;
  readonly entityName?: string | undefined;
  readonly note?: string | undefined;
  readonly accreditation?: AccreditationAnswersInput | undefined;
  readonly consent?: boolean | undefined;
  readonly evidence?:
    | { readonly uaFamily?: string | undefined; readonly ipHash?: Uint8Array | undefined }
    | undefined;
  readonly actor: Actor;
}

export interface SubmitInterestResult {
  readonly submission: InterestRecord;
  readonly eligibility: Eligibility;
  readonly verification: VerificationRecord | undefined;
}

export interface InterestDecisionResult {
  readonly submission: InterestRecord;
  readonly commitment: CommitmentRecord | undefined;
  readonly warnings: readonly string[];
}

/** A submission row plus the person behind it; the staff queue, never an investor's own list. */
export interface InterestRow extends InterestRecord {
  readonly displayName: string | null;
  readonly email: string | null;
}

/**
 * `interest_open_per_member_idx` — one *open* submission per member per round.
 *
 * The index is what enforces it, because a SELECT-then-INSERT check loses a race between two
 * tabs; this is where the 23505 becomes a sentence rather than a 500. A member whose submission
 * was declined may try again, which is why the index is partial on `status = 'submitted'`.
 */
async function withOpenSubmissionGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new RoundError(
        "conflict",
        "you already have a submission waiting for the company to review",
        {},
      );
    }
    throw error;
  }
}

export function createInterestService(services: ModuleServices) {
  const { db } = services;

  /** The person's own view: their submissions, whatever round they belong to. */
  async function mine(ctx: TenantContext, membershipId: string): Promise<InterestRecord[]> {
    return db.withTenant(ctx, (tx) => new InterestRepo(ctx, tx).listForMember(membershipId));
  }

  return {
    mine,

    /** The staff queue for one round, with names attached. */
    async listForRound(
      ctx: TenantContext,
      roundId: string,
      status?: InterestRecord["status"],
    ): Promise<InterestRow[]> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const rows = await new InterestRepo(ctx, tx).listForRound(roundId, status);
        const names = await new MembershipRepo(ctx, tx).namesFor(rows.map((r) => r.membershipId));
        return rows.map((r) => {
          const who = names.get(r.membershipId);
          return {
            ...r,
            displayName: who?.displayName ?? null,
            email: who?.email ?? null,
          };
        });
      });
    },

    /**
     * The investor's submission.
     *
     * Rate-limited before anything else is read: five an hour per member, because the form is
     * reachable by every external in the workspace and a submission fans out into an audit row,
     * an outbox event, a staff notification and possibly an attestation.
     */
    async submit(input: SubmitInterestInput): Promise<SubmitInterestResult> {
      const { ctx, membershipId } = input;
      const limit = await services.rateLimiter.hit(`round.interest:${membershipId}`, INTEREST_RATE);
      if (!limit.allowed) {
        throw new RoundError("rate_limited", "too many interest submissions; try again later", {
          retryAfterMs: limit.retryAfterMs,
        });
      }

      const amount = parseFixed(input.amount);
      if (amount === undefined || amount <= 0n) {
        throw new RoundError("validation_failed", "enter an amount", { field: "amount" });
      }
      if (input.subject === "entity" && (input.entityName ?? "").trim().length === 0) {
        throw new RoundError("validation_failed", "name the entity you are subscribing through", {
          field: "entityName",
        });
      }

      const prepared = await db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).currentForInvestor();
        if (round === undefined || round.status !== "open") {
          throw new RoundError("round_not_open", "this round is not open for interest", {});
        }
        const minimum =
          round.minimumInvestment === null ? undefined : parseFixed(round.minimumInvestment);
        if (minimum !== undefined && amount < minimum) {
          throw new RoundError("below_minimum", "this is below the round's minimum investment", {
            field: "amount",
            minimum: round.minimumInvestment,
            currency: round.currency,
          });
        }
        const stamp = await services.legal.stampFor(tx, ctx);
        const accreditation = await services.legal.accreditation(tx, ctx, membershipId);
        return {
          round,
          disclaimerStamp: stamp ?? null,
          alreadyVerified: isVerified(accreditation),
        };
      });
      const round = prepared.round;

      let decided: Eligibility;
      try {
        decided = eligibility({
          offeringStatus: input.offeringStatus,
          subject: input.subject,
          amount: input.amount,
          currency: round.currency,
        });
      } catch {
        // `none`/`informational` — unreachable, because the module's own `disabledWhen` answers
        // 404 for every route in those two statuses. Reported as a refusal rather than a 500 so
        // that a gate that somehow let it through is visible rather than merely broken.
        throw new RoundError("round_not_open", "this workspace is not offering securities", {
          offeringStatus: input.offeringStatus,
        });
      }

      /*
       * The questionnaire is recorded through `legal.certifyAccreditation`, which is the
       * acceptance service under a different name: it finds the workspace's published
       * `accreditation` document and writes the click-wrap row and the dated `accredited` row
       * against it. If the workspace has published no such document the call refuses with
       * `accreditation_unavailable` (409) — deliberately not a 404, because nothing the investor
       * asked for is missing; the company has not finished setting this up.
       */
      let accreditationStamp: string | null = null;
      let nonAccredited = false;
      if (decided.questionnaire && input.accreditation !== undefined) {
        if (input.consent !== true) {
          throw new RoundError(
            "validation_failed",
            "tick the box agreeing to receive these records electronically",
            { field: "consent" },
          );
        }
        const certified = await db.withTenant(ctx, (tx) =>
          services.legal.certifyAccreditation(tx, ctx, {
            membershipId,
            answers: input.accreditation as AccreditationAnswersInput,
            ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
            actor: {
              membershipId: input.actor.membershipId,
              ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
              ...(input.actor.sessionId === undefined ? {} : { sessionId: input.actor.sessionId }),
            },
          }),
        );
        accreditationStamp = certified.stamp;
        nonAccredited = certified.nonAccredited;
      }

      /*
       * A verification is opened only when the path asks for one *and* nobody has already
       * checked this member — a live `accredited` attestation whose method carries the
       * `verified:` prefix. Re-verifying them would ask an investor to upload a tax return the
       * company has already decided it does not need (§R's "already accredited" branch). A
       * *self-certification* does not count, however recent: that is the step 506(c) adds. The
       * path is still stored as computed, because what rule applied on the day is the fact worth
       * keeping.
       */
      const needsVerification =
        decided.path === "verification_required" && !prepared.alreadyVerified;

      let attached: string | null = null;
      /*
       * The write runs in a **system** context, and the reason is `round.verification`: it has
       * no external RLS policy beyond reading one's own rows, because a policy wide enough to
       * let an investor insert a verification would be wide enough to let them write one. The
       * verification is the company's record *about* the member, not the member's own row — so
       * the service checks who is asking (it is their own submission by construction) and then
       * writes off-fence, exactly as the evidence upload does. The audit rows below carry the
       * investor as the actor explicitly, so the trail still says who acted.
       */
      const sys = systemContext(ctx.workspaceId);
      const actorKind = ctx.actorKind === "external" ? ("external" as const) : ("staff" as const);
      const written = await withOpenSubmissionGuard(async () =>
        db.withTenant(sys, async (tx) => {
          const submission = await new InterestRepo(sys, tx).insert({
            roundId: round.id,
            membershipId,
            amount: input.amount,
            currency: round.currency,
            subject: input.subject,
            entityName: input.entityName ?? null,
            note: input.note ?? null,
            accreditationPath: decided.path,
            nonAccredited,
            accreditationStamp,
            disclaimerStamp: prepared.disclaimerStamp,
            offeringStatus: input.offeringStatus,
          });

          let verification: VerificationRecord | undefined;
          if (needsVerification) {
            /*
             * E3.7: one pending verification per member (under the member's lock, which the
             * investor's own "start verification" takes too): a member who already has one open
             * — started from the verification card, or by an earlier submission — gets this
             * submission attached to it rather than a second one (a vendor bills per
             * verification). A new one is opened with the workspace's effective provider; a
             * vendor start is a job enqueued in this transaction and run after it commits, never
             * a vendor call inside it.
             */
            const verifications = new VerificationRepo(sys, tx);
            await verifications.lockMember(membershipId);
            verification = await verifications.pendingForMember(membershipId);
            if (verification === undefined) {
              const opened = await openVerification(services, tx, sys, {
                membershipId,
                interestSubmissionId: submission.id,
                subject: input.subject,
                actorKind,
                actor: input.actor,
              });
              verification = opened.verification;
            }
            await new InterestRepo(sys, tx).attachVerification(submission.id, verification.id);
            attached = verification.id;
          }

          await services.audit.record(tx, sys, {
            action: "round.interest_submitted",
            actorKind,
            resourceKind: "interest_submission",
            resourceId: submission.id,
            actorMembershipId: input.actor.membershipId,
            subjectMembershipId: membershipId,
            ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
            ...(input.actor.sessionId === undefined ? {} : { sessionId: input.actor.sessionId }),
            meta: {
              roundId: round.id,
              amount: submission.amount,
              currency: submission.currency,
              subject: submission.subject,
              accreditationPath: submission.accreditationPath,
              nonAccredited: submission.nonAccredited,
              offeringStatus: submission.offeringStatus,
              accreditationStamp: submission.accreditationStamp,
              disclaimerStamp: submission.disclaimerStamp,
              verificationId: verification?.id ?? null,
            },
          });
          await publish(tx, sys, "round.interest_submitted", {
            submissionId: submission.id,
            roundId: round.id,
            membershipId,
          });
          return { submission, verification };
        }),
      );

      return {
        // The row is updated inside the transaction *after* the INSERT returned it, so the id
        // is put back on the object here rather than costing a second SELECT.
        submission: { ...written.submission, verificationId: attached },
        eligibility: decided,
        verification: written.verification,
      };
    },

    /** The investor withdrawing their own open submission. */
    async withdraw(
      ctx: TenantContext,
      id: string,
      membershipId: string,
      actor: Actor,
    ): Promise<InterestRecord> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new InterestRepo(ctx, tx);
        const found = await repo.find(id);
        // RLS already hides other people's rows from an external actor; the check is what makes
        // the refusal a 404 rather than an accidental 500 when a *staff* caller passes an id.
        if (found === undefined || found.membershipId !== membershipId) {
          throw new RoundError("not_found", "no such submission");
        }
        const updated = await repo.decide(id, {
          status: "withdrawn",
          decidedBy: membershipId,
          decidedAt: services.now(),
        });
        if (updated === undefined) {
          throw new RoundError("conflict", "this submission has already been decided", {
            status: found.status,
          });
        }
        await services.audit.record(tx, ctx, {
          action: "round.interest_withdrawn",
          resourceKind: "interest_submission",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { roundId: updated.roundId },
        });
        return updated;
      });
    },

    /**
     * Staff accepting a submission: it becomes a commitment.
     *
     * The 506(c) refusal is the load-bearing rule. `permits("506c").accreditationRequired` is
     * true and design/04 is blunt that every purchaser must pass accreditation *before*
     * acceptance — so an accept is refused unless somebody **checked**: a live `accredited`
     * attestation whose `data.method` carries the `verified:` prefix, or a submission that took
     * the minimum-investment safe harbour and carries the stamp of the written representations
     * that go with it. A bare self-certification does not open this door, however recent; that
     * is the difference between 506(b) and 506(c).
     */
    async accept(
      ctx: TenantContext,
      id: string,
      input: { readonly amount?: string | undefined; readonly note?: string | undefined },
      offeringStatus: OfferingStatus,
      actor: Actor,
    ): Promise<InterestDecisionResult> {
      const gate = await db.withTenant(ctx, async (tx) => {
        const submission = await new InterestRepo(ctx, tx).find(id);
        if (submission === undefined) throw new RoundError("not_found", "no such submission");
        if (submission.status !== "submitted") {
          throw new RoundError("conflict", "this submission has already been decided", {
            status: submission.status,
          });
        }
        const accreditation = await services.legal.accreditation(tx, ctx, submission.membershipId);
        return { submission, verified: isVerified(accreditation) };
      });
      const submission = gate.submission;

      if (offeringStatus === "506c") {
        const selfCertified =
          submission.accreditationPath === "self_certified" &&
          submission.accreditationStamp !== null;
        if (!gate.verified && !selfCertified) {
          throw new RoundError(
            "accreditation_required",
            "under Rule 506(c) this investor has to be verified as accredited before you can accept",
            {
              membershipId: submission.membershipId,
              accreditationPath: submission.accreditationPath,
              verificationId: submission.verificationId,
            },
          );
        }
      }

      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(submission.roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const amount = input.amount ?? submission.amount;
        const commitment = await new CommitmentRepo(ctx, tx).insert({
          roundId: round.id,
          membershipId: submission.membershipId,
          amount,
          status: "soft",
          interestSubmissionId: submission.id,
          ...(input.note === undefined ? {} : { note: input.note }),
          createdBy: actor.membershipId,
        });
        const repo = new InterestRepo(ctx, tx);
        const updated = await repo.decide(id, {
          status: "accepted",
          decidedBy: actor.membershipId,
          decidedAt: services.now(),
          decisionNote: input.note ?? null,
          commitmentId: commitment.id,
        });
        if (updated === undefined) {
          throw new RoundError("conflict", "this submission has already been decided", {});
        }

        const meta = {
          roundId: round.id,
          commitmentId: commitment.id,
          amount: commitment.amount,
          currency: round.currency,
          accreditationPath: submission.accreditationPath,
          nonAccredited: submission.nonAccredited,
          override: input.amount !== undefined,
        };
        await services.audit.record(tx, ctx, {
          action: "round.interest_accepted",
          resourceKind: "interest_submission",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: submission.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta,
        });
        await services.audit.record(tx, ctx, {
          action: "round.commitment_created",
          resourceKind: "round_commitment",
          resourceId: commitment.id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: submission.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { ...meta, submissionId: id, status: commitment.status },
        });
        await publish(tx, ctx, "round.interest_decided", {
          submissionId: id,
          roundId: round.id,
          membershipId: submission.membershipId,
          decision: "accepted",
          commitmentId: commitment.id,
        });
        await publish(tx, ctx, "round.commitment_created", {
          commitmentId: commitment.id,
          roundId: round.id,
          membershipId: submission.membershipId,
        });

        /*
         * E2.5 D7: counted over *accepted* submissions whose questionnaire named no category,
         * after this one. It is a warning on the response and a badge on the admin screen, never
         * a block — the 35 in Rule 506(b) counts purchasers in an offering, and only the company
         * and its counsel know whether this portal holds all of them.
         */
        const nonAccreditedAccepted = await repo.nonAccreditedAcceptedCount(round.id);
        const warnings =
          nonAccreditedAccepted >= NON_ACCREDITED_LIMIT ? ["non_accredited_limit"] : [];
        return { submission: updated, commitment, warnings };
      });
    },

    async decline(
      ctx: TenantContext,
      id: string,
      input: { readonly note?: string | undefined },
      actor: Actor,
    ): Promise<InterestDecisionResult> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new InterestRepo(ctx, tx);
        const found = await repo.find(id);
        if (found === undefined) throw new RoundError("not_found", "no such submission");
        const updated = await repo.decide(id, {
          status: "declined",
          decidedBy: actor.membershipId,
          decidedAt: services.now(),
          decisionNote: input.note ?? null,
        });
        if (updated === undefined) {
          throw new RoundError("conflict", "this submission has already been decided", {
            status: found.status,
          });
        }
        await services.audit.record(tx, ctx, {
          action: "round.interest_declined",
          resourceKind: "interest_submission",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          subjectMembershipId: updated.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: { roundId: updated.roundId },
        });
        await publish(tx, ctx, "round.interest_decided", {
          submissionId: id,
          roundId: updated.roundId,
          membershipId: updated.membershipId,
          decision: "declined",
        });
        return { submission: updated, commitment: undefined, warnings: [] };
      });
    },
  };
}

export type InterestService = ReturnType<typeof createInterestService>;
