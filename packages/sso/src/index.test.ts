import type { DnsAnswer } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  checkIssuer,
  cleanMfaValues,
  emailDomain,
  evaluateTxt,
  LEGACY_SSO_TXT_LABEL,
  LEGACY_SSO_TXT_PREFIX,
  legacyTxtName,
  normalizeSsoDomain,
  OidcConfigError,
  oidcLoginLevel,
  SSO_KEY_PURPOSE,
  samlLoginLevel,
  txtName,
  txtValue,
} from "./index.js";

describe("@fundroom/sso", () => {
  it("seals connection secrets under the sso-credentials key purpose", () => {
    expect(SSO_KEY_PURPOSE).toBe("sso-credentials");
  });
});

describe("MFA mapping (decision 7)", () => {
  const none = { trust: false, values: [] };
  it("OIDC: amr/acr evidence or trust, else level 1", () => {
    expect(oidcLoginLevel(none, {})).toBe(1);
    expect(oidcLoginLevel(none, { amr: ["pwd"] })).toBe(1);
    expect(oidcLoginLevel(none, { amr: ["pwd", "otp"] })).toBe(2);
    expect(oidcLoginLevel(none, { amr: ["mfa"] })).toBe(2);
    expect(oidcLoginLevel(none, { acr: "urn:mfa" })).toBe(1);
    expect(oidcLoginLevel({ trust: false, values: ["urn:mfa"] }, { acr: "urn:mfa" })).toBe(2);
    expect(oidcLoginLevel({ trust: true, values: [] }, { amr: ["pwd"] })).toBe(2);
  });

  it("SAML: AuthnContextClassRef in the mapped values, or trust", () => {
    const pw = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
    const mfa = "http://schemas.microsoft.com/claims/multipleauthn";
    expect(samlLoginLevel(none, [pw])).toBe(1);
    expect(samlLoginLevel({ trust: false, values: [mfa] }, [pw])).toBe(1);
    expect(samlLoginLevel({ trust: false, values: [mfa] }, [mfa])).toBe(2);
    expect(samlLoginLevel({ trust: true, values: [] }, [])).toBe(2);
  });

  it("cleans admin-entered values", () => {
    expect(cleanMfaValues([" a ", "", "a", "b"])).toEqual(["a", "b"]);
    expect(cleanMfaValues(Array.from({ length: 30 }, (_, i) => `v${i}`))).toHaveLength(20);
  });
});

describe("domains", () => {
  it("normalises admin input and refuses what nobody can own", () => {
    expect(normalizeSsoDomain(" @Acme-Corp.COM. ")).toEqual({ ok: true, domain: "acme-corp.com" });
    expect(normalizeSsoDomain("bücher.de")).toEqual({ ok: true, domain: "xn--bcher-kva.de" });
    for (const bad of ["com", "co.uk", "*.acme.com", "10.0.0.1", "localhost", "a b.com", ""]) {
      expect(normalizeSsoDomain(bad).ok).toBe(false);
    }
  });

  it("names the TXT record and value with the current label and prefix only", () => {
    expect(txtName("acme-corp.com")).toBe("_fundroom-sso.acme-corp.com");
    expect(txtValue("tok")).toBe("fundroom-sso=tok");
    // The pre-rename spelling is a lookup fallback, never an instruction.
    expect(legacyTxtName("acme-corp.com")).toBe("_seedhost-sso.acme-corp.com");
    expect(LEGACY_SSO_TXT_LABEL).toBe("_seedhost-sso");
    expect(LEGACY_SSO_TXT_PREFIX).toBe("seedhost-sso=");
    expect(emailDomain("a@Acme.com")).toBe("acme.com");
    expect(emailDomain("nope")).toBeUndefined();
  });

  const answer = (values: string[], rcode: DnsAnswer["rcode"] = "ok"): DnsAnswer => ({
    name: "_fundroom-sso.acme-corp.com",
    type: "TXT",
    values,
    rcode,
    resolver: "test",
  });
  const token = "abcdefghijklmnopqrstuvwxyz012345";

  it("accepts the exact token, quoted or chunked, among other records", () => {
    expect(evaluateTxt(answer(["v=spf1 -all", `fundroom-sso=${token}`]), token).ok).toBe(true);
    expect(
      evaluateTxt(answer([`"fundroom-sso=${token.slice(0, 10)}" "${token.slice(10)}"`]), token).ok,
    ).toBe(true);
  });

  it("A-2: accepts the token under the pre-rename `seedhost-sso=` prefix too, naming the record", () => {
    // A domain added before the rename was told to publish `seedhost-sso=<token>`; the row
    // stores only the token, so the same proof is recognised under either prefix.
    expect(evaluateTxt(answer([`seedhost-sso=${token}`]), token)).toEqual({
      ok: true,
      detail: "_fundroom-sso.acme-corp.com carries the verification record",
    });
    const legacy = { ...answer([`"seedhost-sso=${token}"`]), name: "_seedhost-sso.acme-corp.com" };
    expect(evaluateTxt(legacy, token)).toEqual({
      ok: true,
      detail: "_seedhost-sso.acme-corp.com carries the verification record",
    });
    // Either prefix still has to carry THIS token, and an unknown prefix is no proof at all.
    expect(evaluateTxt(answer(["seedhost-sso=other"]), token)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not this workspace's token"),
    });
    expect(evaluateTxt(answer([`other-sso=${token}`, token]), token).ok).toBe(false);
  });

  it("refuses another token, no record, and resolver failures, saying which", () => {
    expect(evaluateTxt(answer(["fundroom-sso=other"]), token)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not this workspace's token"),
    });
    expect(evaluateTxt(answer([]), token)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no TXT"),
    });
    expect(evaluateTxt(answer([], "nxdomain"), token)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("does not exist"),
    });
    expect(evaluateTxt(answer([], "servfail"), token).ok).toBe(false);
  });
});

describe("OIDC issuer checks", () => {
  const why = (issuer: string, hosts: string[] = []) => {
    try {
      checkIssuer(issuer, hosts);
      return "ok";
    } catch (error) {
      return error instanceof OidcConfigError ? error.reason : "other";
    }
  };

  it("accepts tenant-specific https issuers", () => {
    expect(why("https://accounts.google.com")).toBe("ok");
    expect(why("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")).toBe(
      "ok",
    );
    expect(why("https://acme.okta.com/oauth2/default")).toBe("ok");
  });

  it("refuses Entra's multi-tenant endpoints", () => {
    for (const t of ["common", "organizations", "consumers", "Common"]) {
      expect(why(`https://login.microsoftonline.com/${t}/v2.0`)).toBe("issuer_mismatch");
    }
    expect(why("https://login.microsoftonline.com/")).toBe("issuer_mismatch");
  });

  it("refuses http (unless allow-listed), credentials, queries and non-URLs", () => {
    expect(why("http://idp.example.com")).toBe("discovery_failed");
    expect(why("http://127.0.0.1:9999", ["127.0.0.1"])).toBe("ok");
    expect(why("https://u:p@idp.example.com")).toBe("discovery_failed");
    expect(why("https://idp.example.com/?x=1")).toBe("discovery_failed");
    expect(why("idp.example.com")).toBe("discovery_failed");
  });
});
