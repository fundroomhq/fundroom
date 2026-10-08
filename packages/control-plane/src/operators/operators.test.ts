import { describe, expect, it } from "vitest";
import {
  normalizeOperatorEmail,
  OPERATOR_MINT_MAX_AGE_MS,
  OperatorInputError,
  operatorMintRefusal,
  operatorProofRefusal,
} from "./operators.js";

/*
 * Who may mint an operator session (E3.10 §5.2), the pure half: a level-2 user session whose
 * proof is at most 10 minutes old, not bound to a tenant (SSO or central auth), and not itself an
 * operator session. The route adds the I/O checks (control plane, canonical host, CIDR, live
 * operator row).
 */
const now = new Date("2026-09-27T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const fresh = {
  population: "staff" as const,
  authLevel: 2 as const,
  authTime: ago(60_000),
  sso: undefined,
};

describe("operatorMintRefusal", () => {
  it("admits a fresh level-2 user session, at the 10-minute edge too", () => {
    expect(operatorMintRefusal(fresh, now)).toBeUndefined();
    expect(operatorMintRefusal({ ...fresh, population: "external" }, now)).toBeUndefined();
    expect(
      operatorMintRefusal({ ...fresh, authTime: ago(OPERATOR_MINT_MAX_AGE_MS) }, now),
    ).toBeUndefined();
  });

  it("refuses level 1 and a proof older than 10 minutes", () => {
    expect(operatorMintRefusal({ ...fresh, authLevel: 1 }, now)).toBe("level");
    expect(
      operatorMintRefusal({ ...fresh, authTime: ago(OPERATOR_MINT_MAX_AGE_MS + 1) }, now),
    ).toBe("stale");
    // A clock that says the proof is from the future (beyond skew) is not "fresh" either.
    expect(operatorMintRefusal({ ...fresh, authTime: ago(-5 * 60_000) }, now)).toBe("stale");
  });

  it("refuses SSO- and central-auth-bound sessions before anything else", () => {
    const sso = { workspaceId: "w", connectionId: "c", connectionVersion: 1 };
    expect(operatorMintRefusal({ ...fresh, sso }, now)).toBe("bound");
    expect(operatorMintRefusal({ ...fresh, authLevel: 1, sso }, now)).toBe("bound");
    expect(operatorMintRefusal({ ...fresh, boundWorkspaceId: "w" }, now)).toBe("bound");
    expect(operatorMintRefusal({ ...fresh, boundWorkspaceId: null }, now)).toBeUndefined();
    expect(operatorMintRefusal({ ...fresh, bound: { workspaceId: "w" } }, now)).toBe("bound");
  });

  it("an operator session cannot mint another", () => {
    expect(operatorMintRefusal({ ...fresh, population: "operator" }, now)).toBe("population");
  });
});

describe("normalizeOperatorEmail", () => {
  it("lower-cases and trims, and refuses what is not an address", () => {
    expect(normalizeOperatorEmail("  Ops@Example.COM ")).toBe("ops@example.com");
    expect(() => normalizeOperatorEmail("not-an-email")).toThrow(OperatorInputError);
    expect(() => normalizeOperatorEmail(`${"a".repeat(250)}@x.io`)).toThrow(OperatorInputError);
  });
});

describe("operatorProofRefusal (R1-H1, fix round 2)", () => {
  const granted = new Date("2026-09-25T00:00:00Z");
  const created = new Date("2026-09-27T11:00:00Z");
  const before = new Date("2026-09-20T00:00:00Z");
  const afterGrant = new Date("2026-09-26T00:00:00Z");
  const after = new Date("2026-09-27T11:05:00Z");

  it("admits a proof from factors usable before the grant and the session", () => {
    expect(operatorProofRefusal([{ usableSince: before }], created, granted)).toBeUndefined();
  });

  it("refuses a factor enrolled after the grant, even in an older session", () => {
    // Enrol, sign in again, mint: the factor predates this session but not the grant.
    expect(operatorProofRefusal([{ usableSince: afterGrant }], created, granted)).toBe(
      "new_factor",
    );
    expect(operatorProofRefusal([{ usableSince: granted }], created, granted)).toBe("new_factor");
  });

  it("refuses a factor enrolled inside the session, even next to an older one", () => {
    expect(operatorProofRefusal([{ usableSince: after }], created, granted)).toBe("new_factor");
    expect(
      operatorProofRefusal([{ usableSince: before }, { usableSince: after }], created, granted),
    ).toBe("new_factor");
  });

  it("refuses a level no factor proved, and a user with no live grant", () => {
    expect(operatorProofRefusal([], created, granted)).toBe("unproven");
    expect(operatorProofRefusal([{ usableSince: before }], created, undefined)).toBe(
      "not_operator",
    );
  });
});
