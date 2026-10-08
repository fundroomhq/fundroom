import { describe, expect, it } from "vitest";
import { foldConsent, readGpc } from "./consent.js";

function nav(value: unknown): Navigator {
  return { globalPrivacyControl: value } as unknown as Navigator;
}

describe("consent", () => {
  it("grants only when the host says yes and GPC is silent", () => {
    expect(foldConsent({ analytics: true }, false)).toEqual({ analytics: true });
  });

  it("never lets a host CMP turn measurement on over a GPC signal", () => {
    // The rule the server enforces too (`if (gpc) return false`), so the two cannot disagree.
    expect(foldConsent({ analytics: true }, true)).toEqual({ analytics: false, gpc: true });
  });

  it("stays off when the host says no", () => {
    expect(foldConsent({ analytics: false }, false)).toEqual({ analytics: false });
    expect(foldConsent({ analytics: false }, true)).toEqual({ analytics: false, gpc: true });
  });

  it("never sends `gpc: false`: absence means no signal", () => {
    expect(Object.hasOwn(foldConsent({ analytics: true }, false), "gpc")).toBe(false);
  });

  it("reads GPC as a negative-only signal", () => {
    expect(readGpc(nav(true))).toBe(true);
    expect(readGpc(nav("1"))).toBe(true);
    expect(readGpc(nav(false))).toBe(false);
    expect(readGpc(nav(undefined))).toBe(false);
    expect(readGpc(nav("yes"))).toBe(false);
    expect(readGpc(undefined)).toBe(false);
  });
});
