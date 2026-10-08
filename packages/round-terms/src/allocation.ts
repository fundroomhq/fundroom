import { fixed, moneyValue, percentOf, percentValue } from "./money.js";

/*
 * How much of the round is spoken for (E2.5 D2, D8).
 *
 * `round.commitment` is the system of record for money, and this is the only place its rows are
 * added up — the admin tracker, the investor progress bar, the CRM reconciliation panel and the
 * commitments CSV all read the same four buckets from the same function. A second roll-up
 * somewhere would eventually disagree with this one in front of an investor.
 */

/** Mirrors the `round.commitment_status` enum. */
export const COMMITMENT_STATUSES = ["soft", "verbal", "signed", "wired", "withdrawn"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export interface Allocation {
  readonly target: string;
  readonly soft: string;
  readonly verbal: string;
  readonly signed: string;
  readonly wired: string;
  /** `verbal + signed + wired`: the money somebody has actually said yes to. */
  readonly committed: string;
  /** `soft + committed`. Exact — never capped, even when the round is oversubscribed. */
  readonly total: string;
  /** `max(0, target - total)`; never negative, because "minus $50,000 left" is not a figure. */
  readonly remaining: string;
  /** Percentages of the target, two decimals, capped at 100 so a bar cannot overflow. */
  readonly percent: {
    readonly soft: string;
    readonly committed: string;
    readonly wired: string;
  };
}

/** 100 % at the shared scale — the cap the display percentages are clamped to. */
const FULL = 100_000_000n;

function share(part: bigint, target: bigint): string {
  if (target <= 0n) return "0.00";
  const pct = percentOf(part, target);
  if (pct === undefined) return "0.00";
  return percentValue(pct > FULL ? FULL : pct);
}

/**
 * The buckets for a round.
 *
 * `withdrawn` commitments are excluded rather than shown as a fifth bucket: a withdrawal is the
 * absence of a commitment, and a tracker that kept them visible would let a round look fuller
 * than it is. The row stays in the table for the audit trail; it just stops counting.
 *
 * An amount that is not a decimal string counts as nothing. Every real caller passes a
 * `numeric(20, 6)` straight from the column, so this can only fire on a hand-built payload —
 * and a total that silently swallowed a malformed row would be worse than one that ignored it
 * visibly, which is what a bucket short of the sum of its parts does.
 */
export function allocation(
  commitments: readonly { readonly amount: string; readonly status: CommitmentStatus }[],
  target: string,
): Allocation {
  const buckets: Record<CommitmentStatus, bigint> = {
    soft: 0n,
    verbal: 0n,
    signed: 0n,
    wired: 0n,
    withdrawn: 0n,
  };
  for (const commitment of commitments) {
    const amount = fixed(commitment.amount);
    if (amount === undefined) continue;
    const bucket = buckets[commitment.status];
    if (bucket === undefined) continue;
    buckets[commitment.status] = bucket + amount;
  }

  const committed = buckets.verbal + buckets.signed + buckets.wired;
  const total = buckets.soft + committed;
  const targetValue = fixed(target) ?? 0n;
  const outstanding = targetValue - total;

  return {
    target: moneyValue(targetValue),
    soft: moneyValue(buckets.soft),
    verbal: moneyValue(buckets.verbal),
    signed: moneyValue(buckets.signed),
    wired: moneyValue(buckets.wired),
    committed: moneyValue(committed),
    total: moneyValue(total),
    remaining: moneyValue(outstanding > 0n ? outstanding : 0n),
    percent: {
      soft: share(buckets.soft, targetValue),
      committed: share(committed, targetValue),
      wired: share(buckets.wired, targetValue),
    },
  };
}
