import type { TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import type { CommitmentStatus } from "@fundroom/round-terms";
import { type Actor, RoundError } from "../errors.js";
import {
  type CommitmentRecord,
  CommitmentRepo,
  type RoundRecord,
  RoundRepo,
} from "../repos/round-repo.js";
import { allocationOf, type RoundAllocation } from "./allocation.js";

/*
 * Commitments: the money (E2.5 D2).
 *
 * This is the system of record, which is why `crm.pipeline_item.amount` is only ever a forecast
 * and why the CRM board reads the committed figure back from here rather than keeping its own.
 * Every write publishes, because `crm` moves a pipeline card off these events and a card that
 * silently stopped following the money would be worse than no card.
 */

export interface CommitmentInput {
  readonly membershipId?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly amount: string;
  readonly status?: CommitmentStatus | undefined;
  readonly note?: string | undefined;
}

export interface CommitmentPatch {
  readonly amount?: string | undefined;
  readonly status?: CommitmentStatus | undefined;
  readonly note?: string | null | undefined;
}

export interface CommitmentListView {
  readonly round: RoundRecord;
  readonly commitments: readonly CommitmentRecord[];
  readonly allocation: RoundAllocation;
}

export function createCommitmentService(services: ModuleServices) {
  const { db } = services;

  return {
    async list(ctx: TenantContext, roundId: string): Promise<CommitmentListView> {
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const commitments = await new CommitmentRepo(ctx, tx).listForRound(roundId);
        return { round, commitments, allocation: allocationOf(round, commitments) };
      });
    },

    async create(
      ctx: TenantContext,
      roundId: string,
      input: CommitmentInput,
      actor: Actor,
    ): Promise<CommitmentRecord> {
      if (
        input.membershipId === undefined &&
        input.organizationId === undefined &&
        input.contactId === undefined &&
        input.displayName === undefined
      ) {
        // The column CHECK spelled out, so a commitment nobody can chase is a form error and
        // not a 500 from `commitment_has_subject`.
        throw new RoundError(
          "validation_failed",
          "a commitment needs a member, a contact, an organisation or at least a name",
          { field: "displayName" },
        );
      }
      return db.withTenant(ctx, async (tx) => {
        const round = await new RoundRepo(ctx, tx).find(roundId);
        if (round === undefined) throw new RoundError("not_found", "no such round");
        const created = await new CommitmentRepo(ctx, tx).insert({
          roundId,
          ...input,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "round.commitment_created",
          resourceKind: "round_commitment",
          resourceId: created.id,
          actorMembershipId: actor.membershipId,
          ...(created.membershipId === null ? {} : { subjectMembershipId: created.membershipId }),
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          // Amounts are allowed on an audit row — it is fenced to the workspace and the whole
          // point of the row is that somebody can prove what was recorded. They are *not*
          // allowed on the event below, which every subscriber reads.
          meta: {
            roundId,
            status: created.status,
            amount: created.amount,
            currency: round.currency,
          },
        });
        await publish(tx, ctx, "round.commitment_created", {
          commitmentId: created.id,
          roundId,
          ...(created.membershipId === null ? {} : { membershipId: created.membershipId }),
          ...(created.contactId === null ? {} : { contactId: created.contactId }),
          ...(created.organizationId === null ? {} : { organizationId: created.organizationId }),
        });
        return created;
      });
    },

    async patch(
      ctx: TenantContext,
      id: string,
      patch: CommitmentPatch,
      actor: Actor,
    ): Promise<CommitmentRecord> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new CommitmentRepo(ctx, tx);
        const before = await repo.find(id);
        if (before === undefined) throw new RoundError("not_found", "no such commitment");
        const updated = await repo.update(id, patch);
        if (updated === undefined) throw new RoundError("not_found", "no such commitment");
        await services.audit.record(tx, ctx, {
          action: "round.commitment_changed",
          resourceKind: "round_commitment",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(updated.membershipId === null ? {} : { subjectMembershipId: updated.membershipId }),
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          meta: {
            roundId: updated.roundId,
            from: before.status,
            to: updated.status,
            amount: updated.amount,
            fields: Object.keys(patch),
          },
        });
        // Published on every patch, not only a status move: `crm` keys its card on the status
        // and an amount edit is still a fact a subscriber may want to re-read.
        await publish(tx, ctx, "round.commitment_changed", {
          commitmentId: id,
          roundId: updated.roundId,
          status: updated.status,
        });
        return updated;
      });
    },
  };
}

export type CommitmentService = ReturnType<typeof createCommitmentService>;
