import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { brandingLogoUrl, clientIp, proxyTrustOf, workspaceUrl } from "./deps.js";

/*
 * `workspaceUrl` takes the workspace, not its slug (E2.1 decision 5): an `active` custom domain
 * is the workspace's primary origin, so every public URL the server mints — email links, the
 * logo `<img src>` an inbox fetches — has to be on it. `primaryHost` rides on the resolved
 * workspace row every request already has, which is what lets this stay synchronous.
 */
const BASE = new URL("https://portal.example.test");
const acme = { slug: "acme", primaryHost: null };
const custom = { slug: "acme", primaryHost: "investors.acme.com" };

describe("workspaceUrl", () => {
  it("E3.9 FR1 B7: a custom domain hangs off BASE_PATH, not BASE_URL's (mount) path", () => {
    const mount = new URL("https://acme.com/investors");
    expect(workspaceUrl(mount, "single", custom, "/updates/q3?x=1", "").href).toBe(
      "https://investors.acme.com/updates/q3?x=1",
    );
    expect(workspaceUrl(mount, "single", custom, "/updates/q3", "/app").href).toBe(
      "https://investors.acme.com/app/updates/q3",
    );
    // Without a custom domain: BASE_URL, path included.
    expect(workspaceUrl(mount, "single", acme, "/updates/q3", "").href).toBe(
      "https://acme.com/investors/updates/q3",
    );
  });

  it("falls back to the canonical subdomain in multi mode", () => {
    expect(workspaceUrl(BASE, "multi", acme, "/updates/q3").href).toBe(
      "https://acme.portal.example.test/updates/q3",
    );
  });

  it("falls back to the base URL in single mode", () => {
    expect(workspaceUrl(BASE, "single", acme, "/updates/q3").href).toBe(
      "https://portal.example.test/updates/q3",
    );
  });

  it("prefers an active custom domain in both tenancy modes", () => {
    for (const tenancy of ["single", "multi"] as const) {
      expect(workspaceUrl(BASE, tenancy, custom, "/updates/q3").href).toBe(
        "https://investors.acme.com/updates/q3",
      );
    }
  });

  it("keeps a query string intact on the custom domain", () => {
    expect(workspaceUrl(BASE, "multi", custom, "/unsubscribe?token=a%2Fb").href).toBe(
      "https://investors.acme.com/unsubscribe?token=a%2Fb",
    );
  });

  it("keeps a dev port, exactly as the subdomain branch does", () => {
    const dev = new URL("http://portal.example.test:3000");
    expect(workspaceUrl(dev, "multi", acme, "/x").href).toBe(
      "http://acme.portal.example.test:3000/x",
    );
    expect(workspaceUrl(dev, "multi", custom, "/x").href).toBe("http://investors.acme.com:3000/x");
  });
});

describe("brandingLogoUrl", () => {
  const logo = { sha256: "0123456789abcdef0123456789abcdef" };
  const parts = { baseUrl: BASE, tenancy: "multi" as const };

  it("serves the logo from the workspace's own origin", () => {
    expect(brandingLogoUrl(parts, acme, logo)).toBe(
      "https://acme.portal.example.test/api/v1/branding/logo?v=0123456789abcdef",
    );
    // An email rendered for a workspace on a custom domain must point its <img> at that domain:
    // the canonical subdomain may not even be routable once the operator has moved on.
    expect(brandingLogoUrl(parts, custom, logo)).toBe(
      "https://investors.acme.com/api/v1/branding/logo?v=0123456789abcdef",
    );
  });

  it("stays on the base URL in single mode without a custom domain", () => {
    expect(brandingLogoUrl({ ...parts, tenancy: "single" }, acme, logo)).toBe(
      "https://portal.example.test/api/v1/branding/logo?v=0123456789abcdef",
    );
  });

  it("E3.9: prefixes BASE_URL's path exactly once (it used to be doubled)", () => {
    const based = {
      baseUrl: new URL("https://portal.example.test/investors"),
      tenancy: "single" as const,
    };
    expect(brandingLogoUrl(based, acme, logo)).toBe(
      "https://portal.example.test/investors/api/v1/branding/logo?v=0123456789abcdef",
    );
  });
});

/*
 * E2.10 F-07: behind an appending proxy the leftmost `X-Forwarded-For` entry is the client's own
 * text. Every per-IP rate limit and audit IP goes through `clientIp`, so a spoofed first hop must
 * not move it.
 */
describe("clientIp", () => {
  const ipOf = async (
    trust: Parameters<typeof clientIp>[1],
    headers: Record<string, string>,
  ): Promise<string | null> => {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => c.text(clientIp(c, trust) ?? "none"));
    const text = await (await app.request("/", { headers })).text();
    return text === "none" ? null : text;
  };

  it("ignores spoofed leftmost X-Forwarded-For entries with TRUST_PROXY=true", async () => {
    for (const spoof of ["6.6.6.6", "10.0.0.1, 6.6.6.6", "::1"]) {
      expect(await ipOf(true, { "x-forwarded-for": `${spoof}, 203.0.113.7` })).toBe("203.0.113.7");
    }
  });

  it("follows TRUST_PROXY_HOPS and CLIENT_IP_HEADER from config", async () => {
    const two = proxyTrustOf({ TRUST_PROXY: true, TRUST_PROXY_HOPS: 2 });
    expect(await ipOf(two, { "x-forwarded-for": "6.6.6.6, 198.51.100.4, 172.18.0.3" })).toBe(
      "198.51.100.4",
    );
    const fly = proxyTrustOf({
      TRUST_PROXY: true,
      TRUST_PROXY_HOPS: 1,
      CLIENT_IP_HEADER: "Fly-Client-IP",
    });
    expect(
      await ipOf(fly, { "fly-client-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 1.2.3.4" }),
    ).toBe("203.0.113.9");
    // Without the platform header the request did not come through the edge: no XFF fallback.
    expect(await ipOf(fly, { "x-forwarded-for": "6.6.6.6" })).toBeNull();
  });

  it("never reads forwarded headers without TRUST_PROXY", async () => {
    expect(proxyTrustOf({ TRUST_PROXY: false, TRUST_PROXY_HOPS: 3 })).toBe(false);
    expect(await ipOf(false, { "x-forwarded-for": "6.6.6.6", "fly-client-ip": "6.6.6.6" })).toBe(
      null,
    );
  });
});
