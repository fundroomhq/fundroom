import { describe, expect, it } from "vitest";
import { oidcAuthLevel } from "./oidc.js";

/*
 * F-04 (ASVS 6.8.4): an OIDC login is level 1 unless the IdP shows MFA (`amr`), the operator
 * mapped its `acr` to MFA, or the provider is explicitly trusted to enforce MFA.
 */
describe("oidcAuthLevel", () => {
  const plain = {};

  it("defaults to one factor", () => {
    expect(oidcAuthLevel(plain, {})).toBe(1);
    expect(oidcAuthLevel(plain, { amr: ["pwd"] })).toBe(1);
    expect(oidcAuthLevel(plain, { amr: ["hwk"] })).toBe(1);
    expect(oidcAuthLevel(plain, { amr: ["otp"] })).toBe(1);
    expect(oidcAuthLevel(plain, { amr: ["pwd", "pin", "kba"] })).toBe(1); // one category
    expect(oidcAuthLevel(plain, { amr: "mfa" })).toBe(1); // not an array: ignored
    expect(oidcAuthLevel(plain, { amr: [1, null] })).toBe(1);
  });

  it("is two factors when amr says so or spans two categories (RFC 8176)", () => {
    expect(oidcAuthLevel(plain, { amr: ["mfa"] })).toBe(2);
    expect(oidcAuthLevel(plain, { amr: ["MCA"] })).toBe(2);
    expect(oidcAuthLevel(plain, { amr: ["pwd", "otp"] })).toBe(2);
    expect(oidcAuthLevel(plain, { amr: ["hwk", "pin"] })).toBe(2);
    expect(oidcAuthLevel(plain, { amr: ["swk", "fpt"] })).toBe(2);
    expect(oidcAuthLevel(plain, { amr: ["pwd", "sms"] })).toBe(2);
  });

  it("maps only configured acr values to MFA", () => {
    const p = { mfaAcrValues: ["urn:acme:loa:2"] };
    expect(oidcAuthLevel(p, { acr: "urn:acme:loa:2" })).toBe(2);
    expect(oidcAuthLevel(p, { acr: "urn:acme:loa:1" })).toBe(1);
    expect(oidcAuthLevel(plain, { acr: "urn:acme:loa:2" })).toBe(1);
    expect(oidcAuthLevel(p, { acr: ["urn:acme:loa:2"] })).toBe(1);
  });

  it("honours an explicit trust opt-in and a pinned level", () => {
    expect(oidcAuthLevel({ trustMfa: true }, {})).toBe(2);
    expect(oidcAuthLevel({ trustMfa: false }, { amr: ["pwd"] })).toBe(1);
    expect(oidcAuthLevel({ authLevel: 1 }, { amr: ["mfa"] })).toBe(1);
    expect(oidcAuthLevel({ authLevel: 2 }, {})).toBe(2);
  });
});
