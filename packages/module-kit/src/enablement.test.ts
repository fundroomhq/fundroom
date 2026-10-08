import { ALL_ENTITLEMENTS, entitlementsOf } from "@fundroom/domain";
import { describe, expect, it } from "vitest";
import { buildBootstrap } from "./enablement.js";
import { defineModule } from "./manifest.js";
import { createModuleRegistry } from "./registry.js";

/*
 * The bootstrap's plan fields (A-3, ADR-0063 §3.3): `modules[].readOnly` and the `entitlements`
 * block — both for staff only, so an investor's bootstrap never discloses the company's plan.
 */
const access = defineModule({ id: "access", version: "1.0.0", required: true });
const crm = defineModule({ id: "crm", version: "1.0.0", defaultEnabled: false });
const metrics = defineModule({ id: "metrics", version: "1.0.0", defaultEnabled: false });
const registry = createModuleRegistry([access, crm, metrics]);

const workspace = {
  id: "w",
  slug: "acme",
  name: "Acme",
  offeringStatus: "506b",
  defaultLocale: "en",
} as never;
const modules = {
  workspaceId: "w",
  enabled: new Set(["access", "crm"]),
  flags: new Map<string, boolean>(),
};
const staff = { id: "m", kind: "staff", role: "owner", status: "active" } as never;
const investor = { id: "i", kind: "external", role: "investor", status: "active" } as never;
const plan = (limits: unknown) => entitlementsOf({ enforced: true, planId: "p", limits });

const boot = (membership: never | undefined, entitlements = plan({ modules: [], features: [] })) =>
  buildBootstrap({ registry, workspace, modules, membership, permissions: [], entitlements });

const readOnly = (b: ReturnType<typeof boot>) =>
  Object.fromEntries(b.modules.map((m) => [m.id, m.readOnly]));

describe("buildBootstrap plan fields", () => {
  it("marks an enabled optional module outside the plan read-only, for staff", () => {
    const b = boot(staff);
    // crm: on, outside the plan. metrics: off (nothing to read). access: required.
    expect(readOnly(b)).toEqual({ access: false, crm: true, metrics: false });
    expect(b.entitlements).toEqual({ modules: [], features: [] });
  });

  it("emits the lists sorted (features in display order), and null for all", () => {
    const b = boot(staff, plan({ modules: ["metrics", "crm"], features: ["sso", "qa", "ai"] }));
    expect(readOnly(b)).toEqual({ access: false, crm: false, metrics: false });
    expect(b.entitlements).toEqual({ modules: ["crm", "metrics"], features: ["qa", "sso", "ai"] });
    expect(boot(staff, plan({})).entitlements).toEqual({ modules: null, features: null });
    expect(boot(staff, ALL_ENTITLEMENTS).entitlements).toEqual({ modules: null, features: null });
    expect(readOnly(boot(staff, ALL_ENTITLEMENTS))).toEqual({
      access: false,
      crm: false,
      metrics: false,
    });
  });

  it("discloses nothing to an investor or a signed-out caller", () => {
    for (const membership of [investor, undefined]) {
      const b = boot(membership);
      expect(readOnly(b)).toEqual({ access: false, crm: false, metrics: false });
      expect("entitlements" in b).toBe(false);
    }
  });

  it("without entitlements (no workspace) emits no block and nothing read-only", () => {
    const b = buildBootstrap({
      registry,
      workspace,
      modules,
      membership: staff,
      permissions: [],
    });
    expect("entitlements" in b).toBe(false);
    expect(b.modules.every((m) => !m.readOnly)).toBe(true);
  });
});
