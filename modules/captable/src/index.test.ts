import { describe, expect, it } from "vitest";
import { captableModule } from "./index.js";

describe("captable manifest", () => {
  it("is an optional module with its own schema and permissions", () => {
    expect(captableModule.id).toBe("captable");
    expect(captableModule.defaultEnabled).toBe(false);
    expect(captableModule.dependsOn).toEqual(["access"]);
    expect(captableModule.permissions).toEqual(["captable.read", "captable.manage"]);
  });

  it("erases on member.erasure_requested, exports a DSAR section and declares its nav slots", () => {
    expect(Object.keys(captableModule.events?.handles ?? {})).toEqual(["member.erasure_requested"]);
    expect(captableModule.dsar).toBeDefined();
    expect(captableModule.slots?.["admin.nav"]).toHaveLength(1);
    expect(captableModule.slots?.["investor.nav"]).toEqual([
      { id: "captable", label: "Holdings", to: "/captable", order: 60, icon: "pie-chart" },
    ]);
  });
});
