import { describe, expect, it } from "vitest";
import { challengeToken } from "./token.js";

const KEY = new Uint8Array(32).fill(7);
const WS = "0192f2a0-0000-7000-8000-000000000001";

describe("challengeToken", () => {
  it("is reproducible for the same workspace and hostname", () => {
    expect(challengeToken(KEY, WS, "investors.acme.com")).toBe(
      challengeToken(KEY, WS, "investors.acme.com"),
    );
  });

  it("is 32 lower-case base32 characters", () => {
    const token = challengeToken(KEY, WS, "investors.acme.com");
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[a-z2-7]{32}$/u);
  });

  it("differs per workspace", () => {
    const other = "0192f2a0-0000-7000-8000-000000000002";
    expect(challengeToken(KEY, WS, "investors.acme.com")).not.toBe(
      challengeToken(KEY, other, "investors.acme.com"),
    );
  });

  it("differs per hostname", () => {
    expect(challengeToken(KEY, WS, "investors.acme.com")).not.toBe(
      challengeToken(KEY, WS, "investors.acme.org"),
    );
  });

  it("differs per key, so rotating the key invalidates every outstanding challenge", () => {
    const other = new Uint8Array(32).fill(9);
    expect(challengeToken(KEY, WS, "investors.acme.com")).not.toBe(
      challengeToken(other, WS, "investors.acme.com"),
    );
  });

  it("is bound to the normalised spelling, not the typed one", () => {
    expect(challengeToken(KEY, WS, "INVESTORS.ACME.COM")).not.toBe(
      challengeToken(KEY, WS, "investors.acme.com"),
    );
  });

  it("does not collide across the workspace/hostname separator", () => {
    // `a:b.com` must not hash the same as workspace `a` + hostname `b.com` read differently.
    expect(challengeToken(KEY, "a", "b.com")).not.toBe(challengeToken(KEY, "a:b", "com"));
  });
});
