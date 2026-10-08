import { CLOUDFLARE_IP_RANGES_FETCHED_AT } from "@fundroom/config";
import { CLOUDFLARE_IP_RANGES } from "@fundroom/http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { clientIp, proxyTrustOf } from "./deps.js";

/*
 * E3.10 `CLOUDFLARE_TRUSTED_PROXY`: `clientIp` — the address every per-IP rate limit, audit row
 * and operator CIDR check uses — takes `CF-Connecting-IP` only when the address that connected
 * (per the trusted proxy chain) is a Cloudflare edge. The shipped topology is
 * Cloudflare → Caddy → app, so the "peer" is the XFF entry Caddy appended.
 */

const ipOf = async (
  trust: Parameters<typeof clientIp>[1],
  headers: Record<string, string>,
): Promise<string | null> => {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => c.text(clientIp(c, trust) ?? "none"));
  const text = await (await app.request("/", { headers })).text();
  return text === "none" ? null : text;
};

const cfOn = proxyTrustOf({
  TRUST_PROXY: true,
  TRUST_PROXY_HOPS: 1,
  CLOUDFLARE_TRUSTED_PROXY: "on",
});

describe("clientIp with CLOUDFLARE_TRUSTED_PROXY", () => {
  it("uses CF-Connecting-IP when the proxied peer is a Cloudflare edge", async () => {
    expect(
      await ipOf(cfOn, {
        "x-forwarded-for": "6.6.6.6, 172.70.1.9",
        "cf-connecting-ip": "198.51.100.23",
      }),
    ).toBe("198.51.100.23");
  });

  it("ignores a spoofed CF-Connecting-IP from a peer outside Cloudflare's ranges", async () => {
    expect(
      await ipOf(cfOn, { "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "1.1.1.1" }),
    ).toBe("203.0.113.7");
    // Nor can the client make itself look like Cloudflare with a leftmost XFF entry.
    expect(
      await ipOf(cfOn, {
        "x-forwarded-for": "172.70.1.9, 203.0.113.7",
        "cf-connecting-ip": "1.1.1.1",
      }),
    ).toBe("203.0.113.7");
  });

  it("is off unless configured, so the header means nothing by default", async () => {
    const plain = proxyTrustOf({ TRUST_PROXY: true, TRUST_PROXY_HOPS: 1 });
    expect(plain).toEqual({ hops: 1 });
    expect(
      await ipOf(plain, { "x-forwarded-for": "172.70.1.9", "cf-connecting-ip": "198.51.100.23" }),
    ).toBe("172.70.1.9");
    expect(
      proxyTrustOf({ TRUST_PROXY: false, TRUST_PROXY_HOPS: 1, CLOUDFLARE_TRUSTED_PROXY: "on" }),
    ).toBe(false);
  });

  it("layers on CLIENT_IP_HEADER as well", async () => {
    const fly = proxyTrustOf({
      TRUST_PROXY: true,
      TRUST_PROXY_HOPS: 1,
      CLIENT_IP_HEADER: "Fly-Client-IP",
      CLOUDFLARE_TRUSTED_PROXY: "on",
    });
    expect(
      await ipOf(fly, { "fly-client-ip": "2606:4700::1", "cf-connecting-ip": "198.51.100.23" }),
    ).toBe("198.51.100.23");
  });
});

describe("the vendored Cloudflare ranges", () => {
  it("carry the same fetch date doctor's age warning measures from", () => {
    expect(CLOUDFLARE_IP_RANGES.fetchedAt).toBe(CLOUDFLARE_IP_RANGES_FETCHED_AT);
  });
});
