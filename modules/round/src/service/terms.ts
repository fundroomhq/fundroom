import type { TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { parseTerms, TERMS_SCHEMA_VERSION, type Terms } from "@fundroom/round-terms";
import { type Actor, RoundError } from "../errors.js";
import { RoundRepo, type TermsRecord, TermsRepo } from "../repos/round-repo.js";

/*
 * Terms are append-only revisions (E2.5 D3), the same model `metrics.point` uses for a
 * restatement and for the same reason: EXECUTION_PLAN :471 requires terms to be append-only with
 * `as_of` dates and versioned disclaimer blocks, and the question an auditor asks three years
 * later is "what was this investor shown on the day they subscribed". An UPDATE would delete the
 * answer.
 *
 * So a change *inserts* revision n + 1 and points revision n's `superseded_by` at it, inside one
 * transaction, with the disclaimer stamp in force at that moment stamped onto the new row. A
 * trigger in the migration refuses every other kind of update, so this is not a convention the
 * next caller can forget.
 */

export interface PutTermsInput {
  readonly terms: unknown;
  readonly asOf?: Date | undefined;
}

export function createTermsService(services: ModuleServices) {
  const { db } = services;

  return {
    /** The live revision, or `undefined` when the round has no terms yet. */
    async current(ctx: TenantContext, roundId: string): Promise<TermsRecord | undefined> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        return new TermsRepo(ctx, tx).current(roundId, round.instrumentKind);
      });
    },

    /** Every revision, newest first. */
    async history(ctx: TenantContext, roundId: string): Promise<TermsRecord[]> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        return new TermsRepo(ctx, tx).history(roundId, round.instrumentKind);
      });
    },

    /**
     * Writes the next revision.
     *
     * The body is parsed against the round's **own** `instrument_kind` rather than against the
     * union: the union would accept a note body for a round whose column says `safe`, and the
     * two would then disagree for as long as the row existed. A mismatch is a field error, not
     * a 500 from a jsonb CHECK.
     */
    async put(
      ctx: TenantContext,
      roundId: string,
      input: PutTermsInput,
      actor: Actor,
    ): Promise<TermsRecord> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");

        let parsed: Terms;
        try {
          parsed = parseTerms(round.instrumentKind, input.terms);
        } catch (error) {
          throw new RoundError(
            "validation_failed",
            `these terms are not a valid ${round.instrumentKind}`,
            {
              field: "terms",
              instrumentKind: round.instrumentKind,
              reason: error instanceof Error ? error.message : String(error),
            },
          );
        }

        const repo = new TermsRepo(ctx, tx);
        const previous = await repo.current(roundId, round.instrumentKind);
        const revision = await repo.nextRevision(roundId);
        // The stamp is read *now*, not copied from the previous revision: what makes the pair
        // evidence is that this text was published alongside that disclaimer version.
        const stamp = await services.legal.stampFor(tx, ctx);
        const created = await repo.insert({
          roundId,
          revision,
          terms: parsed,
          schemaVersion: TERMS_SCHEMA_VERSION,
          asOf: input.asOf ?? services.now(),
          disclaimerStamp: stamp ?? null,
          createdBy: actor.membershipId,
        });
        if (previous !== undefined) await repo.supersede(previous.id, created.id);

        await services.audit.record(tx, ctx, {
          action: "round.terms_changed",
          resourceKind: "round_terms",
          resourceId: created.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            roundId,
            revision,
            instrumentKind: round.instrumentKind,
            supersededId: previous?.id ?? null,
            disclaimerStamp: stamp ?? null,
          },
        });
        await publish(tx, ctx, "round.terms_changed", {
          roundId,
          termsId: created.id,
          revision,
        });
        return created;
      });
    },
  };
}

export type TermsService = ReturnType<typeof createTermsService>;
