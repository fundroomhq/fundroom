import { describe, expect, it } from "vitest";
import { checkCsrf } from "./csrf.js";

const SELF = "https://investors.acme.com";
const h = (init: Record<string, string>) => new Headers(init);

describe("checkCsrf", () => {
  it("lets safe methods through untouched", () => {
    expect(checkCsrf("GET", h({ "sec-fetch-site": "cross-site" }), { selfOrigin: SELF })).toEqual({
      ok: true,
      via: "safe-method",
    });
    expect(checkCsrf("head", h({}), { selfOrigin: SELF }).ok).toBe(true);
  });

  it("trusts Fetch Metadata same-origin and none (user-initiated navigation)", () => {
    expect(checkCsrf("POST", h({ "sec-fetch-site": "same-origin" }), { selfOrigin: SELF })).toEqual(
      { ok: true, via: "fetch-metadata" },
    );
    expect(checkCsrf("POST", h({ "sec-fetch-site": "none" }), { selfOrigin: SELF }).ok).toBe(true);
  });

  it("rejects cross-site and same-site unless the Origin is allowlisted", () => {
    expect(
      checkCsrf("POST", h({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), {
        selfOrigin: SELF,
      }),
    ).toEqual({ ok: false, reason: "cross-site" });
    // acme.com is same-site with investors.acme.com but is not the portal.
    expect(
      checkCsrf("POST", h({ "sec-fetch-site": "same-site", origin: "https://acme.com" }), {
        selfOrigin: SELF,
      }),
    ).toEqual({ ok: false, reason: "cross-site" });
    expect(
      checkCsrf("POST", h({ "sec-fetch-site": "cross-site", origin: "https://app.partner.com" }), {
        selfOrigin: SELF,
        allowedOrigins: ["https://app.partner.com"],
      }),
    ).toEqual({ ok: true, via: "origin" });
  });

  it("falls back to Origin, then Referer, when Fetch Metadata is absent", () => {
    expect(checkCsrf("POST", h({ origin: SELF }), { selfOrigin: SELF })).toEqual({
      ok: true,
      via: "origin",
    });
    expect(
      checkCsrf("POST", h({ origin: "HTTPS://Investors.Acme.com" }), { selfOrigin: SELF }).ok,
    ).toBe(true);
    expect(checkCsrf("POST", h({ origin: "https://evil.example" }), { selfOrigin: SELF })).toEqual({
      ok: false,
      reason: "bad-origin",
    });
    expect(checkCsrf("POST", h({ origin: "null" }), { selfOrigin: SELF })).toEqual({
      ok: false,
      reason: "bad-origin",
    });
    expect(checkCsrf("DELETE", h({ referer: `${SELF}/settings` }), { selfOrigin: SELF })).toEqual({
      ok: true,
      via: "referer",
    });
    expect(checkCsrf("PUT", h({}), { selfOrigin: SELF })).toEqual({
      ok: false,
      reason: "missing-origin",
    });
  });

  it("ignores malformed allowlist entries", () => {
    expect(
      checkCsrf("POST", h({ origin: "https://ok.example" }), {
        selfOrigin: SELF,
        allowedOrigins: ["not a url", "https://ok.example"],
      }).ok,
    ).toBe(true);
  });
});
