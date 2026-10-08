import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULE,
  parseVisibilityMap,
  sectionVisible,
  type VisibilityRule,
  viewerForPreview,
} from "./visibility.js";

const G1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const G2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c02";
const anon = { kind: "anonymous" as const, groupIds: [] };
const investor = { kind: "external" as const, membershipId: "m", groupIds: [G1] };
const staff = { kind: "staff" as const, membershipId: "s", groupIds: [] };

describe("sectionVisible", () => {
  const cases: [VisibilityRule, boolean, boolean, boolean, boolean][] = [
    // rule, anon, investor(G1), staff, anon with allowPublic
    [{ mode: "authenticated" }, false, true, true, false],
    [{ mode: "staff_only" }, false, false, true, false],
    [{ mode: "groups", groupIds: [G1] }, false, true, true, false],
    [{ mode: "groups", groupIds: [G2] }, false, false, true, false],
    [{ mode: "public" }, false, true, true, true],
  ];
  it.each(cases)("%o", (rule, a, i, s, aPublic) => {
    expect(sectionVisible(rule, anon, { allowPublic: false })).toBe(a);
    expect(sectionVisible(rule, investor, { allowPublic: false })).toBe(i);
    expect(sectionVisible(rule, staff, { allowPublic: false })).toBe(s);
    expect(sectionVisible(rule, anon, { allowPublic: true })).toBe(aPublic);
  });

  it("treats a public section as authenticated when the setting is off", () => {
    expect(sectionVisible({ mode: "public" }, investor, { allowPublic: false })).toBe(true);
    expect(sectionVisible({ mode: "public" }, anon, { allowPublic: false })).toBe(false);
  });
});

describe("parseVisibilityMap", () => {
  it("falls back to the default, never to public, for unreadable rules", () => {
    expect(parseVisibilityMap({ a: { mode: "public" }, b: { mode: "nope" }, c: 4 })).toEqual({
      a: { mode: "public" },
      b: DEFAULT_RULE,
      c: DEFAULT_RULE,
    });
    expect(parseVisibilityMap(null)).toEqual({});
  });
});

describe("viewerForPreview", () => {
  it("maps the audience tokens", () => {
    expect(viewerForPreview("public").kind).toBe("anonymous");
    expect(viewerForPreview("staff").kind).toBe("staff");
    expect(viewerForPreview("authenticated")).toEqual({ kind: "external", groupIds: [] });
    expect(viewerForPreview(`group:${G1}`)).toEqual({ kind: "external", groupIds: [G1] });
  });
});
