import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_IP_RANGES, cloudflareClientIp, isCloudflareAddress } from "./cloudflare.js";

const headers =
  (h: Record<string, string>) =>
  (name: string): string | undefined =>
    h[name.toLowerCase()];

describe("isCloudflareAddress", () => {
  it("matches both families, including the edges of a range", () => {
    expect(isCloudflareAddress("173.245.48.1")).toBe(true);
    expect(isCloudflareAddress("173.245.63.255")).toBe(true);
    expect(isCloudflareAddress("173.245.64.0")).toBe(false);
    expect(isCloudflareAddress("104.23.255.255")).toBe(true);
    expect(isCloudflareAddress("2606:4700::6810:84e5")).toBe(true);
    expect(isCloudflareAddress("2a06:98c7:ffff::1")).toBe(true);
    expect(isCloudflareAddress("2a06:98c8::1")).toBe(false);
  });

  it("matches an IPv4-mapped IPv6 socket address as its IPv4, and strips ports", () => {
    expect(isCloudflareAddress("::ffff:104.16.0.1")).toBe(true);
    expect(isCloudflareAddress("::ffff:203.0.113.7")).toBe(false);
    expect(isCloudflareAddress("104.16.0.1:443")).toBe(true);
    expect(isCloudflareAddress("[2400:cb00::1]:443")).toBe(true);
  });

  it("refuses everything that is not an address", () => {
    for (const v of [undefined, "", "cloudflare", "10.0.0.1", "127.0.0.1", "::1"]) {
      expect(isCloudflareAddress(v)).toBe(false);
    }
  });

  it("vendors well-formed CIDRs with a fetch date", () => {
    expect(CLOUDFLARE_IP_RANGES.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const list = new BlockList();
    for (const c of CLOUDFLARE_IP_RANGES.v4) {
      const [net, bits] = c.split("/");
      expect(() => list.addSubnet(net as string, Number(bits), "ipv4")).not.toThrow();
    }
    for (const c of CLOUDFLARE_IP_RANGES.v6) {
      const [net, bits] = c.split("/");
      expect(() => list.addSubnet(net as string, Number(bits), "ipv6")).not.toThrow();
    }
  });
});

describe("cloudflareClientIp", () => {
  it("believes CF-Connecting-IP only from a Cloudflare peer", () => {
    const h = headers({ "cf-connecting-ip": "198.51.100.23" });
    expect(cloudflareClientIp("162.158.1.2", h)).toBe("198.51.100.23");
    expect(cloudflareClientIp("2400:cb00:2049::1", h)).toBe("198.51.100.23");
  });

  it("ignores a spoofed CF-Connecting-IP from any other peer", () => {
    const spoof = headers({ "cf-connecting-ip": "1.1.1.1" });
    expect(cloudflareClientIp("203.0.113.7", spoof)).toBe("203.0.113.7");
    expect(cloudflareClientIp("10.0.0.5", spoof)).toBe("10.0.0.5");
    expect(cloudflareClientIp(undefined, spoof)).toBeUndefined();
  });

  it("keeps the peer when a Cloudflare request carries no usable header", () => {
    expect(cloudflareClientIp("162.158.1.2", headers({}))).toBe("162.158.1.2");
    expect(cloudflareClientIp("162.158.1.2", headers({ "cf-connecting-ip": "x" }))).toBe(
      "162.158.1.2",
    );
  });
});
