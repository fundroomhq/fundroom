import { describe, expect, it } from "vitest";
import {
  ALL_ENTITLEMENTS,
  entitlementsOf,
  isPlanFeature,
  PLAN_FEATURES,
  parseEntitlementList,
} from "./entitlements.js";

/*
 * Plan entitlements (A-3, ADR-0063). What it pins: absent = all and [] = none; nothing is enforced
 * without CONTROL_PLANE=on and a plan; a malformed stored list reads as "all" (the backstop rule
 * `parsePlanLimits` follows) and unknown feature ids are dropped rather than voiding the list.
 */
describe("PLAN_FEATURES", () => {
  it("is the closed list of 12 in display order", () => {
    expect(PLAN_FEATURES).toEqual([
      "qa",
      "api_keys",
      "webhooks",
      "integrations",
      "esign",
      "accreditation",
      "sso",
      "scim",
      "forensic",
      "anchoring",
      "ai",
      "access_reviews",
    ]);
    expect(isPlanFeature("sso")).toBe(true);
    expect(isPlanFeature("SSO")).toBe(false);
    expect(isPlanFeature(1)).toBe(false);
  });
});

describe("parseEntitlementList", () => {
  it("is undefined (no restriction) unless the value is an array", () => {
    for (const raw of [undefined, null, "data-room", 3, { a: 1 }])
      expect(parseEntitlementList(raw)).toBeUndefined();
  });

  it("keeps strings only, de-duplicated and sorted; [] stays []", () => {
    expect(parseEntitlementList([])).toEqual([]);
    expect(parseEntitlementList(["updates", "crm", 4, null, "crm", "analytics"])).toEqual([
      "analytics",
      "crm",
      "updates",
    ]);
  });

  it("filters to `allowed` when given", () => {
    expect(parseEntitlementList(["sso", "bogus", "ai"], PLAN_FEATURES)).toEqual(["ai", "sso"]);
  });
});

describe("entitlementsOf", () => {
  const restricted = { modules: ["data-room"], features: ["sso"] };

  it("allows everything when not enforced or without a plan", () => {
    expect(entitlementsOf({ enforced: false, planId: "starter", limits: restricted })).toBe(
      ALL_ENTITLEMENTS,
    );
    expect(entitlementsOf({ enforced: true, planId: null, limits: restricted })).toBe(
      ALL_ENTITLEMENTS,
    );
    expect(ALL_ENTITLEMENTS.enforced).toBe(false);
    expect(ALL_ENTITLEMENTS.allowsModule("crm")).toBe(true);
    expect(ALL_ENTITLEMENTS.allowsFeature("ai")).toBe(true);
  });

  it("restricts to the plan's lists when enforced with a plan", () => {
    const e = entitlementsOf({ enforced: true, planId: "starter", limits: restricted });
    expect(e.enforced).toBe(true);
    expect(e.allowsModule("data-room")).toBe(true);
    expect(e.allowsModule("crm")).toBe(false);
    expect(e.allowsFeature("sso")).toBe(true);
    expect(e.allowsFeature("scim")).toBe(false);
    expect(e.modules).toEqual(new Set(["data-room"]));
  });

  it("an absent key is all; [] is none", () => {
    const e = entitlementsOf({ enforced: true, planId: "p", limits: { features: [] } });
    expect(e.enforced).toBe(true);
    expect(e.modules).toBe("all");
    expect(e.allowsModule("captable")).toBe(true);
    for (const f of PLAN_FEATURES) expect(e.allowsFeature(f)).toBe(false);
  });

  it("reads a malformed list, or malformed limits, as all", () => {
    for (const limits of [
      { modules: "crm", features: { sso: true } },
      null,
      [],
      "junk",
      { staffSeats: 3 },
    ]) {
      const e = entitlementsOf({ enforced: true, planId: "p", limits });
      expect(e.modules).toBe("all");
      expect(e.features).toBe("all");
    }
  });

  it("drops unknown feature ids inside a list", () => {
    const e = entitlementsOf({
      enforced: true,
      planId: "p",
      limits: { features: ["sso", "teleport", 7] },
    });
    expect(e.features).toEqual(new Set(["sso"]));
  });
});
