import { describe, expect, it } from "vitest";
import {
  decideGrace,
  factPrices,
  isStale,
  priceChanged,
  remainingTrialDays,
  storageGb,
  trialUsed,
} from "./effects.js";
import { yesterdayOf } from "./jobs.js";

const NOW = new Date("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

describe("decideGrace", () => {
  const base = { graceUntil: null, currentPeriodEnd: null, now: NOW, graceDays: 14 } as const;

  it("starts the grace period on past_due, unpaid and paused", () => {
    for (const status of ["past_due", "unpaid", "paused"] as const) {
      expect(decideGrace({ ...base, status })).toEqual({
        graceUntil: days(14),
        entered: true,
        recovered: false,
      });
    }
  });

  it("keeps a running grace period (no reset by a later event, no second mail)", () => {
    expect(decideGrace({ ...base, status: "unpaid", graceUntil: days(3) })).toEqual({
      graceUntil: days(3),
      entered: false,
      recovered: false,
    });
  });

  it("runs a cancellation's grace from the paid-up period's end, never from the past", () => {
    expect(
      decideGrace({ ...base, status: "canceled", currentPeriodEnd: days(10) }).graceUntil,
    ).toEqual(days(24));
    expect(
      decideGrace({ ...base, status: "canceled", currentPeriodEnd: days(-30) }).graceUntil,
    ).toEqual(days(14));
  });

  it("clears the grace period and recovers on active and trialing", () => {
    for (const status of ["active", "trialing"] as const) {
      expect(decideGrace({ ...base, status, graceUntil: days(-1) })).toEqual({
        graceUntil: null,
        entered: false,
        recovered: true,
      });
    }
  });

  it("leaves incomplete as it is", () => {
    expect(decideGrace({ ...base, status: "incomplete" }).graceUntil).toBeNull();
    expect(decideGrace({ ...base, status: "incomplete", graceUntil: days(2) }).graceUntil).toEqual(
      days(2),
    );
  });

  it("with zero grace days, grace ends now", () => {
    expect(decideGrace({ ...base, graceDays: 0, status: "past_due" }).graceUntil).toEqual(NOW);
  });
});

describe("isStale", () => {
  it("ignores only strictly older facts", () => {
    expect(isStale(days(-1), null)).toBe(false);
    expect(isStale(days(-1), NOW)).toBe(true);
    expect(isStale(NOW, NOW)).toBe(false);
    expect(isStale(days(1), NOW)).toBe(false);
  });
});

describe("remainingTrialDays", () => {
  it("grants the rest of a local trial, rounded up", () => {
    expect(
      remainingTrialDays({
        planTrialDays: 14,
        localTrialEnd: new Date(NOW.getTime() + 2.5 * DAY),
        hadSubscription: true,
        now: NOW,
      }),
    ).toBe(3);
  });

  it("grants nothing once a trial ran out or a subscription existed", () => {
    expect(
      remainingTrialDays({
        planTrialDays: 14,
        localTrialEnd: days(-1),
        hadSubscription: true,
        now: NOW,
      }),
    ).toBe(0);
    expect(
      remainingTrialDays({
        planTrialDays: 14,
        localTrialEnd: null,
        hadSubscription: true,
        now: NOW,
      }),
    ).toBe(0);
  });

  it("grants the plan's trial to a workspace that never had one", () => {
    expect(
      remainingTrialDays({
        planTrialDays: 14,
        localTrialEnd: null,
        hadSubscription: false,
        now: NOW,
      }),
    ).toBe(14);
  });
});

describe("priceChanged / factPrices (R3-L2)", () => {
  it("moves only when none of the fact's prices is the stored plan's", () => {
    expect(priceChanged(["price_a"], "price_a")).toBe(false);
    // A metered item next to the base price: still the same plan.
    expect(priceChanged(["price_meter", "price_a"], "price_a")).toBe(false);
    expect(priceChanged(["price_b"], "price_a")).toBe(true);
    // The row's plan has no price (free, or a manual plan): any price is news.
    expect(priceChanged(["price_b"], null)).toBe(true);
    // A fact without a price says nothing about the plan.
    expect(priceChanged([], "price_a")).toBe(false);
    expect(priceChanged([""], null)).toBe(false);
  });

  it("reads every item's price, else the first item's", () => {
    expect(factPrices({ priceRef: "a", priceRefs: ["m", "a", "a"] })).toEqual(["m", "a"]);
    expect(factPrices({ priceRef: "a" })).toEqual(["a"]);
    expect(factPrices({ priceRef: "" })).toEqual([]);
  });
});

describe("trialUsed (R3-L7)", () => {
  const row = { provider: "stripe", providerSubscriptionId: null, trialEnd: null } as const;
  it("an abandoned first checkout (incomplete, no subscription, no trial) keeps the trial", () => {
    expect(trialUsed(undefined)).toBe(false);
    expect(trialUsed(row)).toBe(false);
  });
  it("a provider subscription, a trial that ran, or manual billing used it", () => {
    expect(trialUsed({ ...row, providerSubscriptionId: "sub_1" })).toBe(true);
    expect(trialUsed({ ...row, trialEnd: NOW })).toBe(true);
    expect(trialUsed({ ...row, provider: "manual" })).toBe(true);
  });
});

describe("usage helpers", () => {
  it("rounds storage up to whole GB", () => {
    expect(storageGb(0)).toBe(0);
    expect(storageGb(1)).toBe(1);
    expect(storageGb(1_000_000_000)).toBe(1);
    expect(storageGb(1_000_000_001)).toBe(2);
  });

  it("yesterday is the previous UTC day", () => {
    expect(yesterdayOf(new Date("2026-09-27T00:30:00Z"))).toBe("2026-09-26");
    expect(yesterdayOf(new Date("2026-03-01T10:00:00Z"))).toBe("2026-02-28");
  });
});
