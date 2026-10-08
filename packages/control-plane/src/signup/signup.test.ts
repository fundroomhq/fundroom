import { describe, expect, it, vi } from "vitest";
import type { Plan } from "../plans/plans.js";
import {
  listSignupPlans,
  SIGNUP_BUDGETS,
  SIGNUP_RATES,
  SIGNUP_RESERVED_SLUGS,
  SIGNUP_START_FLOOR_MS,
  SIGNUP_TERMS_ATTESTATION_KIND,
  type SignupDeps,
  SignupError,
  signupNetworkKey,
  signupSlugReserved,
  signupWideNetworkKey,
  startSignup,
} from "./signup.js";

const plans = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../plans/plans.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plans/plans.js")>()),
  listPlans: async () => plans.rows,
}));

/*
 * Signup's fixed policy (E3.10 §5.7): the budgets the contract names, the E3.1 timing floor, the
 * terms attestation stamp, and the hostnames a public signup may never claim.
 */
describe("signup policy", () => {
  it("the ceiling is a last resort", () => {
    expect(SIGNUP_BUDGETS.globalPerHour).toBeGreaterThanOrEqual(1000);
  });

  it("budgets: per address, per IP and per network well below a high install ceiling", () => {
    expect(SIGNUP_RATES.startPerEmail).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(SIGNUP_RATES.startPerIp.max).toBeLessThan(SIGNUP_RATES.startPerNetwork.max);
    expect(SIGNUP_RATES.startPerNetwork.max * 10).toBeLessThanOrEqual(SIGNUP_RATES.startGlobal.max);
    expect(SIGNUP_RATES.verifyPerNetwork.max * 10).toBeLessThanOrEqual(
      SIGNUP_RATES.completeGlobal.max,
    );
    expect(SIGNUP_RATES.completeGlobal).toEqual({
      max: SIGNUP_BUDGETS.globalPerHour,
      windowMs: 3_600_000,
    });
    expect(SIGNUP_RATES.slugPerIp).toEqual({ max: 30, windowMs: 60_000 });
    expect(SIGNUP_RATES.plansPerIp).toEqual({ max: 30, windowMs: 60_000 });
    expect(SIGNUP_START_FLOOR_MS).toBe(250);
  });

  it("the terms attestation is the ADR-0032 stamp shape", () => {
    expect(SIGNUP_TERMS_ATTESTATION_KIND).toMatch(/^[a-z][a-z0-9-]*:v\d+$/u);
  });

  it("reserves the service's own hostnames", () => {
    for (const slug of ["www", "api", "admin", "platform", "auth", "signup", "mail"]) {
      expect(SIGNUP_RESERVED_SLUGS.has(slug), slug).toBe(true);
    }
    expect(SIGNUP_RESERVED_SLUGS.has("acme")).toBe(false);
    for (const slug of ["mta-sts", "autodiscover", "sso", "scim", "webhooks", "oauth", "id"]) {
      expect(signupSlugReserved(slug), slug).toBe(true);
    }
    for (const slug of [
      "ns1",
      "ns4",
      "w",
      "embed",
      "ops",
      "smtp",
      "status",
      "portals",
      "fallback",
    ]) {
      expect(signupSlugReserved(slug), slug).toBe(true);
    }
  });

  it("refuses IDNA A-labels (lookalike Unicode hostnames)", () => {
    expect(signupSlugReserved("xn--pple-43d")).toBe(true);
    expect(signupSlugReserved("XN--pple-43d")).toBe(true);
    expect(signupSlugReserved("x-n--fine")).toBe(false);
    expect(signupSlugReserved("acme")).toBe(false);
  });

  it("keys networks by IPv4 /24 and IPv6 /64", () => {
    expect(signupNetworkKey("203.0.113.7")).toBe("v4:203.0.113");
    expect(signupNetworkKey("203.0.113.250")).toBe(signupNetworkKey("203.0.113.7"));
    expect(signupNetworkKey("203.0.114.7")).not.toBe(signupNetworkKey("203.0.113.7"));
    expect(signupNetworkKey("::ffff:203.0.113.9")).toBe("v4:203.0.113");
    expect(signupNetworkKey("2001:db8:1:2:aaaa::1")).toBe("v6:2001:0db8:0001:0002");
    expect(signupNetworkKey("2001:db8:1:2::ffff")).toBe("v6:2001:0db8:0001:0002");
    expect(signupNetworkKey("2001:db8::1")).toBe("v6:2001:0db8:0000:0000");
    expect(signupNetworkKey("::1")).toBe("v6:0000:0000:0000:0000");
    expect(signupNetworkKey(undefined)).toBe("unknown");
    expect(signupNetworkKey("not-an-ip")).toBe("unknown");
  });

  it("keys IPv6 starts by /48 as well (fix round 3); IPv4 has no wide key", () => {
    expect(signupWideNetworkKey("2001:db8:1:2::1")).toBe("v6:2001:0db8:0001");
    expect(signupWideNetworkKey("2001:db8:1:ffff::9")).toBe(
      signupWideNetworkKey("2001:db8:1:2::1"),
    );
    expect(signupWideNetworkKey("2001:db8:2::1")).not.toBe(signupWideNetworkKey("2001:db8:1::1"));
    expect(signupWideNetworkKey("203.0.113.7")).toBeUndefined();
    expect(signupWideNetworkKey("::ffff:203.0.113.7")).toBeUndefined();
    expect(signupWideNetworkKey(undefined)).toBeUndefined();
  });
});

/** Just enough of `SignupDeps` for the checks that run before any database work. */
function fakeDeps(termsVersion: number, overrides: Partial<SignupDeps> = {}): SignupDeps {
  const refuse = { allowed: false, retryAfterMs: 1000 };
  return {
    defaultPlanId: "free",
    termsVersion,
    selfServeCheckout: true,
    provisioning: {
      identity: { rateLimiter: { hit: async () => refuse } },
      db: { withHost: async (fn: (tx: unknown) => unknown) => fn({}) },
    },
    ...overrides,
  } as unknown as SignupDeps;
}

const startInput = {
  email: "a@example.com",
  companyName: "Acme",
  legalName: "Acme Ltd",
  country: "GB",
  slug: "acme",
  acceptTerms: true,
} as const;

describe("signup terms version (A-5: configuration)", () => {
  it("refuses a version other than the configured one, naming the current one", async () => {
    const error = await startSignup(fakeDeps(2), { ...startInput, termsVersion: 1 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SignupError);
    expect(error).toMatchObject({ code: "terms_version", details: { current: 2 } });
  });

  it("accepts the configured version (the next check, the budgets, is what refuses here)", async () => {
    const error = await startSignup(fakeDeps(2), { ...startInput, termsVersion: 2 }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "rate_limited" });
  });
});

function plan(id: string, over: Partial<Plan> = {}): Plan {
  const at = new Date("2026-01-01T00:00:00Z");
  return {
    id,
    name: id.toUpperCase(),
    limits: { staffSeats: 3 },
    billingPriceRef: null,
    billingMeteredPriceRefs: [],
    trialDays: 0,
    public: true,
    archivedAt: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe("listSignupPlans", () => {
  it("offers public, unarchived plans in catalogue order, with `paid` and no price ids", async () => {
    plans.rows = [
      plan("free"),
      plan("growth", { billingPriceRef: "price_growth", trialDays: 14 }),
      plan("hidden", { public: false }),
      plan("old", { archivedAt: new Date("2026-02-01T00:00:00Z") }),
      plan("pro", { billingPriceRef: "price_pro" }),
    ];
    const listed = await listSignupPlans(fakeDeps(1));
    expect(listed).toEqual([
      { id: "free", name: "FREE", limits: { staffSeats: 3 }, trialDays: 0, paid: false },
      { id: "growth", name: "GROWTH", limits: { staffSeats: 3 }, trialDays: 14, paid: true },
      { id: "pro", name: "PRO", limits: { staffSeats: 3 }, trialDays: 0, paid: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain("price_");
  });

  it("nothing is `paid` when checkout is not self-serve (manual or no billing)", async () => {
    plans.rows = [plan("free"), plan("pro", { billingPriceRef: "price_pro" })];
    const listed = await listSignupPlans(fakeDeps(1, { selfServeCheckout: false }));
    expect(listed.map((p) => [p.id, p.paid])).toEqual([
      ["free", false],
      ["pro", false],
    ]);
  });
});
