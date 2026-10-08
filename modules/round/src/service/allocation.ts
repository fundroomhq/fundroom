import type { TenantContext, Tx } from "@fundroom/db";
import { type Allocation, allocation } from "@fundroom/round-terms";
import { type CommitmentRecord, CommitmentRepo, type RoundRecord } from "../repos/round-repo.js";

/*
 * The allocation tracker (E2.5 D2).
 *
 * `round.commitment` is the system of record for money and `allocation()` in
 * `@fundroom/round-terms` is the only thing that adds it up — the admin tracker, the investor
 * progress bar, the CRM reconciliation panel and the commitments CSV all end up here. A second
 * roll-up written closer to one of those screens would eventually disagree with this one in
 * front of an investor, which is the failure mode the single function exists to prevent.
 */

/** The buckets plus the round's currency, which `Allocation` itself does not carry. */
export interface RoundAllocation extends Allocation {
  readonly currency: string;
}

export function allocationOf(
  round: Pick<RoundRecord, "targetAmount" | "currency">,
  commitments: readonly Pick<CommitmentRecord, "amount" | "status">[],
): RoundAllocation {
  return {
    ...allocation(
      commitments.map((c) => ({ amount: c.amount, status: c.status })),
      round.targetAmount,
    ),
    currency: round.currency,
  };
}

/** Reads the round's commitments in the caller's transaction and folds them. */
export async function readAllocation(
  ctx: TenantContext,
  tx: Tx,
  round: Pick<RoundRecord, "id" | "targetAmount" | "currency">,
): Promise<RoundAllocation> {
  const commitments = await new CommitmentRepo(ctx, tx).listForRound(round.id);
  return allocationOf(round, commitments);
}

/**
 * What an investor is shown when `showProgress` is on.
 *
 * Three buckets rather than five: `soft`, `committed` and `wired`. The split between verbal and
 * signed is an internal distinction about paperwork — an investor reading "verbal $400,000,
 * signed $150,000" learns how far behind the company's counsel is, which is not what a progress
 * bar is for. `remaining` and the percentages come across because they are the two figures
 * somebody deciding whether to join a round actually acts on.
 */
export function investorProgress(a: RoundAllocation) {
  return {
    currency: a.currency,
    target: a.target,
    soft: a.soft,
    committed: a.committed,
    wired: a.wired,
    total: a.total,
    remaining: a.remaining,
    percent: a.percent,
  };
}
