import { describe, expect, it } from "vitest";
import { normalizeIp, truncateIp } from "./ip.js";

describe("IP minimisation", () => {
  it("truncates IPv4 to /24", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncateIp(" 10.1.2.3 ")).toBe("10.1.2.0/24");
  });

  it("truncates IPv6 to /48 and handles compression, zones and mapped v4", () => {
    expect(truncateIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3::/48");
    expect(truncateIp("2001:0DB8:0000:0042:0000:8a2e:0370:7334")).toBe("2001:db8:0::/48");
    expect(truncateIp("fe80::1%eth0")).toBe("fe80:0:0::/48");
    expect(truncateIp("::ffff:192.0.2.128")).toBe("192.0.2.0/24");
    expect(truncateIp("::1")).toBe("0:0:0::/48");
  });

  it("returns undefined for garbage instead of throwing", () => {
    expect(truncateIp("not-an-ip")).toBeUndefined();
    expect(truncateIp("")).toBeUndefined();
    expect(normalizeIp("999.1.1.1")).toBeUndefined();
  });

  it("normalizes full addresses", () => {
    expect(normalizeIp("203.0.113.77")).toBe("203.0.113.77");
    expect(normalizeIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });
});
