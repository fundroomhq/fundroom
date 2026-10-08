import { describe, expect, it } from "vitest";
import { createSsoService } from "./service.js";
import type { SsoServiceDeps } from "./types.js";

/*
 * E3.9 (ADR-0057): the IdP-facing URLs (OIDC redirect URI, SAML ACS / entity id / metadata) hang
 * off BASE_URL itself — never `origin + BASE_PATH`, which is wrong behind a proxy that strips or
 * replaces the prefix. Identical to the old output whenever BASE_URL's path is BASE_PATH.
 */
function spFor(baseUrl: string, basePath?: string) {
  const deps = {
    fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
    protocols: ["oidc", "saml"],
    baseUrl: new URL(baseUrl),
    ...(basePath === undefined ? {} : { basePath }),
  } as unknown as SsoServiceDeps;
  return createSsoService(deps).spInfo("0b8c3f9e-9a8e-4f0e-9d51-1c0f6a6d2b11");
}

const ID = "0b8c3f9e-9a8e-4f0e-9d51-1c0f6a6d2b11";

describe("SSO service-provider URLs (canonical base = BASE_URL)", () => {
  it("at the root", () => {
    for (const base of ["https://portal.test", "https://portal.test/"]) {
      expect(spFor(base, "")).toEqual({
        oidcRedirectUri: `https://portal.test/sso/oidc/${ID}/callback`,
        samlAcsUrl: `https://portal.test/sso/saml/${ID}/acs`,
        samlEntityId: `https://portal.test/sso/saml/${ID}/metadata`,
        samlMetadataUrl: `https://portal.test/sso/saml/${ID}/metadata`,
      });
    }
  });

  it("is what origin + BASE_PATH gave when BASE_URL's path is BASE_PATH", () => {
    for (const base of ["https://portal.test/investors", "https://portal.test/investors/"]) {
      const sp = spFor(base, "/investors");
      expect(sp.oidcRedirectUri).toBe(`https://portal.test/investors/sso/oidc/${ID}/callback`);
      expect(sp.samlAcsUrl).toBe(`https://portal.test/investors/sso/saml/${ID}/acs`);
    }
  });

  it("follows BASE_URL when a path-mount proxy replaces or strips the prefix", () => {
    // Replace shape: public https://acme.com/investors → app BASE_PATH=/app.
    expect(spFor("https://acme.com/investors", "/app").oidcRedirectUri).toBe(
      `https://acme.com/investors/sso/oidc/${ID}/callback`,
    );
    // Strip shape: app at the root, BASE_URL is the public mount.
    expect(spFor("https://acme.com/investors", "").samlAcsUrl).toBe(
      `https://acme.com/investors/sso/saml/${ID}/acs`,
    );
    // A proxy that adds a leading segment (BASE_URL path ends with BASE_PATH).
    expect(spFor("https://acme.com/ir/investors", "/investors").samlMetadataUrl).toBe(
      `https://acme.com/ir/investors/sso/saml/${ID}/metadata`,
    );
  });
});
