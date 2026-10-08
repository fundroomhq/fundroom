import { describe, expect, it } from "vitest";
import {
  isAncestorOrSelf,
  isPendingGate,
  LTREE_PATH_RE,
  membershipExpired,
  pathDepth,
  resourceKey,
  SUBJECT_SPECIFICITY,
  subjectKey,
  veiledBy,
} from "./model.js";

describe("model helpers", () => {
  it("subjectKey keeps role names and ids apart", () => {
    expect(subjectKey({ kind: "role", role: "investor" })).toBe("role:investor");
    expect(subjectKey({ kind: "role", role: "delegate" })).toBe("role:delegate");
    expect(subjectKey({ kind: "group", id: "g1" })).toBe("group:g1");
    expect(subjectKey({ kind: "membership", id: "g1" })).toBe("membership:g1");
    expect(subjectKey({ kind: "link", id: "l1" })).toBe("link:l1");
  });

  it("resourceKey is kind:id", () => {
    expect(resourceKey({ kind: "folder", id: "f1", path: "a.b" })).toBe("folder:f1");
  });

  it("ranks subjects membership > link > group > role", () => {
    const s = SUBJECT_SPECIFICITY;
    expect(s.membership > s.link && s.link > s.group && s.group > s.role).toBe(true);
  });

  it("isAncestorOrSelf respects label boundaries", () => {
    expect(isAncestorOrSelf("a.b", "a.b")).toBe(true);
    expect(isAncestorOrSelf("a.b", "a.b.c")).toBe(true);
    expect(isAncestorOrSelf("a.b", "a.bc")).toBe(false);
    expect(isAncestorOrSelf("a.b.c", "a.b")).toBe(false);
    expect(isAncestorOrSelf("b", "a.b")).toBe(false);
  });

  it("pathDepth counts labels; no path and the empty path are depth 0", () => {
    expect(pathDepth(undefined)).toBe(0);
    expect(pathDepth("")).toBe(0);
    expect(pathDepth("root")).toBe(1);
    expect(pathDepth("root.a.b")).toBe(3);
  });

  it("LTREE_PATH_RE accepts dotted labels only", () => {
    for (const ok of ["a", "root.a_b.C-9", "ab.cd"]) expect(LTREE_PATH_RE.test(ok)).toBe(true);
    for (const bad of ["", ".a", "a.", "a..b", "a.b!", "!a.b", "a b", "a.b c"]) {
      expect({ bad, ok: LTREE_PATH_RE.test(bad) }).toEqual({ bad, ok: false });
    }
  });

  it("isPendingGate wants an object with a string kind and a string source", () => {
    expect(isPendingGate({ kind: "nda", source: "workspace", detail: {} })).toBe(true);
    expect(isPendingGate({ kind: "nda" })).toBe(false);
    expect(isPendingGate({ source: "workspace" })).toBe(false);
    expect(isPendingGate({ kind: 1, source: "workspace" })).toBe(false);
    expect(isPendingGate({ kind: "nda", source: 1 })).toBe(false);
    expect(isPendingGate(null)).toBe(false);
    expect(isPendingGate("nda")).toBe(false);
    expect(isPendingGate(undefined)).toBe(false);
  });
});

describe("membershipExpired (P1-01)", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  it("treats a missing expiry as open-ended", () => {
    expect(membershipExpired(null, now)).toBe(false);
    expect(membershipExpired(undefined, now)).toBe(false);
  });
  it("is expired at and after the instant, live one millisecond before", () => {
    expect(membershipExpired(new Date(now.getTime() - 1), now)).toBe(true);
    expect(membershipExpired(new Date(now.getTime()), now)).toBe(true);
    expect(membershipExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });

  it("veiledBy: at or below a staff-only node, never a sibling prefix or an unknown location", () => {
    const veil = [{ kind: "folder", id: "s", path: "r.abc" }];
    expect(veiledBy("r.abc", veil)).toBe(true);
    expect(veiledBy("r.abc.def", veil)).toBe(true);
    expect(veiledBy("r.abcd", veil)).toBe(false);
    expect(veiledBy("r", veil)).toBe(false);
    expect(veiledBy(undefined, veil)).toBe(false);
    expect(veiledBy("r.abc", [])).toBe(false);
  });
});
