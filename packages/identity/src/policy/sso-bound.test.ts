import { describe, expect, it } from "vitest";
import { isAuthError } from "../errors.js";
import {
  assertMayChangeAccount,
  boundWorkspaceOf,
  isBoundSession,
  isCentralBound,
  isSsoBound,
  stepUpBudgetKey,
} from "./sso-bound.js";

/*
 * Bound sessions (E3.8 SSO, E3.10 central auth): one rule set, two error codes, and step-up
 * budgets that never touch the user's own.
 */
const WS = "01920000-0000-7000-8000-00000000a001";
const CONN = "01920000-0000-7000-8000-00000000c001";
const sso = { sso: { workspaceId: WS, connectionId: CONN, connectionVersion: 1 } };
const central = { boundWorkspaceId: WS };

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isAuthError(error) ? error.code : "not-an-auth-error";
  }
}

describe("bound sessions", () => {
  it("classifies SSO-bound, central-bound and unbound sessions", () => {
    expect([isSsoBound(sso), isCentralBound(sso), isBoundSession(sso)]).toEqual([
      true,
      false,
      true,
    ]);
    expect([isSsoBound(central), isCentralBound(central), isBoundSession(central)]).toEqual([
      false,
      true,
      true,
    ]);
    expect(isBoundSession({})).toBe(false);
    expect(boundWorkspaceOf(sso)).toBe(WS);
    expect(boundWorkspaceOf(central)).toBe(WS);
    expect(boundWorkspaceOf({})).toBeUndefined();
  });

  it("refuses account changes with the code of the binding", () => {
    expect(codeOf(() => assertMayChangeAccount(sso))).toBe("sso_session_restricted");
    expect(codeOf(() => assertMayChangeAccount(central))).toBe("bound_session_restricted");
    expect(codeOf(() => assertMayChangeAccount({}))).toBeUndefined();
  });

  it("gives each binding its own step-up budget, never the user's", () => {
    expect(stepUpBudgetKey("totp:user:u", {})).toBe("totp:user:u");
    expect(stepUpBudgetKey("totp:user:u", sso)).toBe(`totp:user:u:sso:${WS}`);
    expect(stepUpBudgetKey("totp:user:u", central)).toBe(`totp:user:u:bound:${WS}`);
  });
});
