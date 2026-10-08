import type { SubscriptionStatus } from "@fundroom/ports";

/*
 * What a subscription status means for the workspace (E3.10 §5.4), pure so the rules have unit
 * tests of their own. The service, the webhook ingest, the manual operator write and the jobs all
 * decide through here.
 *
 *   trialing, active          good standing: grace cleared; a `billing` suspension is lifted
 *   past_due, unpaid, paused  grace starts now (kept if already running) → suspended after it
 *   canceled                  the plan stays; grace runs from the paid-up period's end
 *   incomplete                checkout started, or a local trial ran out: grace as it is
 *
 * `paused` is not in the contract's list: Stripe pauses a subscription whose trial ended without
 * a payment method and bills nothing more, which is `unpaid` in all but name.
 */

/** Statuses the enforcement job suspends once `grace_until` has passed. */
export const GRACE_STATUSES: readonly SubscriptionStatus[] = [
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "paused",
];

/** Statuses in good standing (a `billing` suspension is lifted). */
export const GOOD_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active"];

const DAY_MS = 86_400_000;

export interface GraceInput {
  /** The row's grace deadline before this change (`null`: none running, or no row yet). */
  readonly graceUntil: Date | null;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly now: Date;
  readonly graceDays: number;
}

export interface GraceDecision {
  readonly graceUntil: Date | null;
  /** Grace started with this change (the owners get the past-due mail). */
  readonly entered: boolean;
  /** Good standing: lift a `billing` suspension. */
  readonly recovered: boolean;
}

/** The grace deadline after a status change. */
export function decideGrace(input: GraceInput): GraceDecision {
  const running = input.graceUntil;
  switch (input.status) {
    case "trialing":
    case "active":
      return { graceUntil: null, entered: false, recovered: true };
    case "past_due":
    case "unpaid":
    case "paused": {
      if (running !== null) return { graceUntil: running, entered: false, recovered: false };
      return {
        graceUntil: new Date(input.now.getTime() + input.graceDays * DAY_MS),
        entered: true,
        recovered: false,
      };
    }
    case "canceled": {
      if (running !== null) return { graceUntil: running, entered: false, recovered: false };
      // Paid up to the period's end; the grace runs from there (never from the past).
      const from = Math.max(input.currentPeriodEnd?.getTime() ?? 0, input.now.getTime());
      return {
        graceUntil: new Date(from + input.graceDays * DAY_MS),
        entered: true,
        recovered: false,
      };
    }
    case "incomplete":
      return { graceUntil: running, entered: false, recovered: false };
  }
}

/**
 * Whether a fact created at `at` is older than the last one applied (`lastEventAt`): Stripe does
 * not deliver in order. Equal instants apply — Stripe's `created` has one-second resolution and
 * several events of one change share it, and every fact is a re-read anyway.
 */
export function isStale(at: Date, lastEventAt: Date | null): boolean {
  return lastEventAt !== null && at.getTime() < lastEventAt.getTime();
}

/**
 * The trial a checkout still grants: the rest of a local trial (whole days, rounded up), the
 * plan's full trial when the workspace never had one, and none once a trial has run out.
 */
export function remainingTrialDays(input: {
  readonly planTrialDays: number;
  readonly localTrialEnd: Date | null;
  readonly hadSubscription: boolean;
  readonly now: Date;
}): number {
  if (input.localTrialEnd !== null) {
    const left = input.localTrialEnd.getTime() - input.now.getTime();
    return left <= 0 ? 0 : Math.min(90, Math.ceil(left / DAY_MS));
  }
  return input.hadSubscription ? 0 : input.planTrialDays;
}

/**
 * Whether a provider fact moved the subscription to another price (R3-L2): only then does the
 * webhook look for the plan carrying the new price. "Before" is the price of the plan the
 * subscription row is on (`plan.billing_price_ref`); a fact that still carries it — among any of
 * its items — changes nothing, so an event about something else (a payment, a renewal) never
 * reverts an operator's plan override on the workspace. A fact with no price says nothing.
 */
export function priceChanged(factPrices: readonly string[], storedPrice: string | null): boolean {
  const prices = factPrices.filter((p) => p !== "");
  if (prices.length === 0) return false;
  return storedPrice === null || !prices.includes(storedPrice);
}

/** The fact's prices: every item's, else the first item's (`""` for none is dropped). */
export function factPrices(fact: {
  readonly priceRef: string;
  readonly priceRefs?: readonly string[] | undefined;
}): string[] {
  const all = fact.priceRefs ?? [fact.priceRef];
  return [...new Set(all.filter((p) => p !== ""))];
}

/**
 * Whether the workspace already had its trial (R3-L7), so a checkout grants none: a provider
 * subscription existed, a trial ran (a local trial that ended keeps its `trial_end`), or the
 * operator billed it by hand. An `incomplete` row that only records a checkout nobody finished
 * (or a plan without a trial) is not a trial had — abandoning the first checkout keeps the trial.
 * A local trial still running is not this function's business (`remainingTrialDays` grants its
 * rest).
 */
export function trialUsed(
  row:
    | {
        readonly provider: "manual" | "stripe";
        readonly providerSubscriptionId: string | null;
        readonly trialEnd: Date | null;
      }
    | undefined,
): boolean {
  if (row === undefined) return false;
  return row.provider === "manual" || row.providerSubscriptionId !== null || row.trialEnd !== null;
}

/** Stripe meter value for storage: whole GB (10^9 bytes), rounded up. */
export function storageGb(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 1_000_000_000);
}
