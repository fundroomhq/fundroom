import { describe, expect, it } from "vitest";
import { parsePlanLimits } from "../plans/plans.js";
import { checkQuota, PlanLimitError, planLimitError, type QuotaUsage } from "./quotas.js";

/*
 * The pure quota decision (E3.10). What it pins: an absent limit is unlimited, the limit is
 * inclusive ("at most max"), a caller that already wrote its row passes `delta: 0` and is refused
 * only when OVER, and junk in a stored `limits` object never becomes a limit of zero.
 */
const usage = (over: Partial<QuotaUsage> = {}): QuotaUsage => ({
  staffSeats: 0,
  investorSeats: 0,
  storageBytes: 0,
  customDomains: 0,
  ...over,
});

describe("checkQuota", () => {
  it("allows anything when the plan does not limit the kind", () => {
    expect(checkQuota({}, usage({ staffSeats: 10_000 }), "staffSeats", 1)).toEqual({ ok: true });
    expect(checkQuota({ investorSeats: 1 }, usage({ staffSeats: 50 }), "staffSeats", 5)).toEqual({
      ok: true,
    });
  });

  it("allows up to and including the limit, and refuses the one past it", () => {
    const limits = { staffSeats: 3 };
    expect(checkQuota(limits, usage({ staffSeats: 2 }), "staffSeats", 1)).toEqual({ ok: true });
    expect(checkQuota(limits, usage({ staffSeats: 3 }), "staffSeats", 1)).toEqual({
      ok: false,
      limit: "staffSeats",
      max: 3,
    });
  });

  it("treats delta 0 as 'not over the limit' (a row already written counts itself)", () => {
    const limits = { investorSeats: 2 };
    expect(checkQuota(limits, usage({ investorSeats: 2 }), "investorSeats", 0).ok).toBe(true);
    expect(checkQuota(limits, usage({ investorSeats: 3 }), "investorSeats", 0)).toEqual({
      ok: false,
      limit: "investorSeats",
      max: 2,
    });
  });

  it("compares bytes against the declared size", () => {
    const limits = { storageBytes: 1_000 };
    expect(checkQuota(limits, usage({ storageBytes: 600 }), "storageBytes", 400).ok).toBe(true);
    expect(checkQuota(limits, usage({ storageBytes: 600 }), "storageBytes", 401)).toEqual({
      ok: false,
      limit: "storageBytes",
      max: 1_000,
    });
  });

  it("a zero limit refuses the first one; a negative or junk delta adds nothing", () => {
    expect(checkQuota({ customDomains: 0 }, usage(), "customDomains", 1).ok).toBe(false);
    expect(checkQuota({ customDomains: 0 }, usage(), "customDomains", 0).ok).toBe(true);
    expect(
      checkQuota({ customDomains: 1 }, usage({ customDomains: 1 }), "customDomains", -5).ok,
    ).toBe(true);
    expect(
      checkQuota({ customDomains: 1 }, usage({ customDomains: 1 }), "customDomains", Number.NaN).ok,
    ).toBe(true);
  });
});

describe("parsePlanLimits", () => {
  it("keeps known non-negative integers and drops everything else", () => {
    expect(
      parsePlanLimits({
        staffSeats: 5,
        investorSeats: "10",
        storageBytes: -1,
        customDomains: 1.5,
        emailsPerMonth: 0,
        bogus: 3,
      }),
    ).toEqual({ staffSeats: 5, emailsPerMonth: 0 });
    expect(parsePlanLimits(null)).toEqual({});
    expect(parsePlanLimits([1, 2])).toEqual({});
  });

  it("keeps the entitlement lists (A-3): sorted, unique, unknown features dropped", () => {
    expect(
      parsePlanLimits({
        staffSeats: 2,
        modules: ["updates", "data-room", "updates", 3],
        features: ["sso", "teleport", "ai"],
      }),
    ).toEqual({ staffSeats: 2, modules: ["data-room", "updates"], features: ["ai", "sso"] });
    expect(parsePlanLimits({ modules: [], features: [] })).toEqual({ modules: [], features: [] });
  });

  it("reads a malformed list as absent (= all), never as []", () => {
    expect(parsePlanLimits({ modules: "crm", features: { sso: true } })).toEqual({});
  });
});

describe("PlanLimitError", () => {
  it("is shaped like the API error envelope (402 plan_limit, limit and max in details)", () => {
    const e = new PlanLimitError("staffSeats", 3);
    expect(e).toMatchObject({
      code: "plan_limit",
      status: 402,
      details: { limit: "staffSeats", max: 3 },
    });
  });

  it("has an entitlement sibling: 402 plan_limit with the module or feature, no max", () => {
    expect(planLimitError({ limit: "module", module: "crm" })).toMatchObject({
      code: "plan_limit",
      status: 402,
      details: { limit: "module", module: "crm" },
      message: "the workspace's plan does not include the crm module",
    });
    expect(planLimitError({ limit: "feature", feature: "sso" })).toMatchObject({
      details: { limit: "feature", feature: "sso" },
      message: "the workspace's plan does not include the sso feature",
    });
  });
});
