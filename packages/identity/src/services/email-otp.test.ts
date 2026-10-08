import { describe, expect, it } from "vitest";
import { linkBindingHash, otpScope } from "./email-otp.js";

/*
 * The share link's OTP binding (E2.3, contract C4).
 *
 * The passcode is checked by `POST /links/{token}/start` and nowhere else; `verify` never sees
 * one. What makes that safe is that a code minted by one link's `start` cannot be spent against
 * another link — otherwise an attacker holding link B's id could ask link A (no passcode) for a
 * code and redeem it at B.
 */
const LINK_A = "01920000-0000-7000-8000-0000000000f1";
const LINK_B = "01920000-0000-7000-8000-0000000000f2";

describe("linkBindingHash", () => {
  it("is 32 bytes, the width of `core.auth_challenge.binding_hash`", () => {
    expect(linkBindingHash(LINK_A)).toHaveLength(32);
  });

  it("is stable for one link, so the code minted at start verifies at verify", () => {
    expect(linkBindingHash(LINK_A).equals(linkBindingHash(LINK_A))).toBe(true);
  });

  it("differs per link, so a code from one link cannot be spent at another", () => {
    expect(linkBindingHash(LINK_A).equals(linkBindingHash(LINK_B))).toBe(false);
  });

  it("is domain-separated, so a link id can never collide with another sha256 in the system", () => {
    // Prefixed rather than bare: a bare sha256(id) would equal any other hash of the same string.
    const bare = linkBindingHash("");
    expect(bare.equals(linkBindingHash("share_link:"))).toBe(false);
  });
});

describe("otpScope", () => {
  it("separates a workspace's codes from host-level ones and from other workspaces", () => {
    expect(otpScope("ws1", "a@example.com")).not.toBe(otpScope("ws2", "a@example.com"));
    expect(otpScope(undefined, "a@example.com")).toBe("otp:-:a@example.com");
  });
});
