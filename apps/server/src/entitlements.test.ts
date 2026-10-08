import { platform, toApiError } from "@fundroom/contracts";
import type { Tx } from "@fundroom/db";
import { ALL_ENTITLEMENTS, PLAN_FEATURES } from "@fundroom/domain";
import { describe, expect, it } from "vitest";
import { createEntitlements, entitlementCatalog, OPTIONAL_MODULE_IDS } from "./entitlements.js";

/*
 * The server's entitlements port (A-3, ADR-0063). What it pins: the plan's module list may name
 * exactly the optional modules of this build; the wire feature enum and the domain list agree in
 * order; nothing is enforced while CONTROL_PLANE is off (and no query is made); the refusal is
 * the 402 `plan_limit` body the contract fixes; `forWorkspace` reads on the transaction it is given.
 */

const restricted = { planId: "starter", planLimits: { modules: ["data-room"], features: ["sso"] } };

/** A transaction that fails the test if anything reads through it. */
const untouchable = new Proxy({} as Tx, {
  get(_t, prop) {
    throw new Error(`tx.${String(prop)} read while CONTROL_PLANE is off`);
  },
});

/** Answers the one select `readWorkspacePlanLimits` makes with `rows`. */
function selectTx(rows: unknown[]): Tx {
  const chain = { from: () => chain, where: () => chain, limit: async () => rows };
  return { select: () => chain } as unknown as Tx;
}

describe("OPTIONAL_MODULE_IDS / entitlementCatalog", () => {
  it("is the optional modules compiled in, sorted, and never a required one", () => {
    expect(OPTIONAL_MODULE_IDS).toEqual([
      "analytics",
      "captable",
      "crm",
      "data-room",
      "metrics",
      "notify",
      "round",
      "updates",
    ]);
    for (const required of ["content", "access", "branding", "sso", "billing"])
      expect(OPTIONAL_MODULE_IDS).not.toContain(required);
  });

  it("offers every feature in display order, the same list the wire enum carries", () => {
    expect(entitlementCatalog()).toEqual({
      modules: [...OPTIONAL_MODULE_IDS],
      features: [...PLAN_FEATURES],
    });
    expect(platform.PlanFeatureSchema.options).toEqual([...PLAN_FEATURES]);
  });
});

describe("createEntitlements", () => {
  it("allows everything while CONTROL_PLANE is off, without a query", async () => {
    const off = createEntitlements({ enforced: false });
    expect(off.of(restricted)).toBe(ALL_ENTITLEMENTS);
    expect(await off.forWorkspace(untouchable, "w")).toBe(ALL_ENTITLEMENTS);
    expect(() => off.assertFeature(off.of(restricted), "ai")).not.toThrow();
  });

  it("allows everything for a workspace without a plan", () => {
    const on = createEntitlements({ enforced: true });
    const e = on.of({ planId: null, planLimits: null });
    expect(e.enforced).toBe(false);
    expect(() => on.assertModule(e, "crm")).not.toThrow();
  });

  it("refuses with the contract's 402 plan_limit body", () => {
    const on = createEntitlements({ enforced: true });
    const e = on.of(restricted);
    expect(() => on.assertFeature(e, "sso")).not.toThrow();
    expect(() => on.assertModule(e, "data-room")).not.toThrow();

    const feature = toApiError(catchOf(() => on.assertFeature(e, "scim")));
    expect(feature?.status).toBe(402);
    expect(feature?.toBody("r1").error).toEqual({
      code: "plan_limit",
      limit: "feature",
      feature: "scim",
      message: "the workspace's plan does not include the scim feature",
      requestId: "r1",
    });
    const module = toApiError(catchOf(() => on.assertModule(e, "crm")));
    expect(module?.toBody().error).toEqual({
      code: "plan_limit",
      limit: "module",
      module: "crm",
      message: "the workspace's plan does not include the crm module",
    });
  });

  it("forWorkspace reads the plan on the given transaction; an unknown workspace is unrestricted", async () => {
    const on = createEntitlements({ enforced: true });
    const e = await on.forWorkspace(selectTx([restricted]), "w");
    expect(e.enforced).toBe(true);
    expect(e.allowsFeature("sso")).toBe(true);
    expect(e.allowsFeature("ai")).toBe(false);
    expect(await on.forWorkspace(selectTx([]), "gone")).toBe(ALL_ENTITLEMENTS);
  });
});

function catchOf(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
