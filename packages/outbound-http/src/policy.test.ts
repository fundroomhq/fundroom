import { describe, expect, it } from "vitest";
import {
  assessAddresses,
  assessUrl,
  expandIpv6,
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
} from "./policy.js";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks v4 %s", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });

  it("blocks the deprecated 6to4 relay anycast 192.88.99.0/24", () => {
    expect(isBlockedAddress("192.88.99.1")).toBe(true);
    expect(isBlockedAddress("192.88.98.255")).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.128.0.1", "172.32.0.1", "198.20.0.1"])(
    "allows v4 %s",
    (a) => {
      expect(isBlockedAddress(a)).toBe(false);
    },
  );

  it.each([
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "100::1",
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::127.0.0.1",
    "64:ff9b::a00:1",
    "[::1]",
    // IPv4-compatible ::/96 (deprecated, RFC 4291)
    "::127.0.0.1",
    "::7f00:1",
    "::8.8.8.8",
    // SIIT ::ffff:0:0:0/96 (RFC 2765)
    "::ffff:0:127.0.0.1",
    "::ffff:0:7f00:1",
    "::ffff:0:808:808",
    // 6to4 embedding a blocked v4 (127.0.0.1, 169.254.169.254, 10.0.0.1, 0.0.0.0)
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2002:a00:1:1::1",
    "2002::1",
    // local-use NAT64 64:ff9b:1::/48 (RFC 8215) — even with a public embedded v4
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1::808:808",
    // non-/96 forms under the well-known NAT64 prefix
    "64:ff9b:0:0:0:1:808:808",
    // site-local fec0::/10 (deprecated, RFC 3879)
    "fec0::1",
    "feff::1",
    // Teredo 2001::/32 and the rest of 2001::/23 (benchmarking 2001:2::/48, ORCHID 2001:10::/28)
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "2001:10::1",
    "2001:1ff:ffff::1",
    // documentation 3fff::/20, discard/dummy 100::/64 + 100:0:0:1::/64, SRv6 5f00::/16
    "3fff::1",
    "3fff:fff::1",
    "100:0:0:1::1",
    "5f00::1",
    // IETF-reserved space outside 2000::/3
    "4000::1",
    "1::1",
    "e000::1",
  ])("blocks v6 %s", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });

  it.each([
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:1.1.1.1",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "2001:200::1",
    "3fff:1000::1",
    "3ffe::1",
  ])("allows v6 %s", (a) => {
    expect(isBlockedAddress(a)).toBe(false);
  });

  it("treats garbage as blocked", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
    expect(isBlockedAddress("0x7f.0.0.1")).toBe(true);
    expect(isBlockedAddress("2130706433")).toBe(true);
  });
});

describe("expandIpv6", () => {
  it("expands compressed and embedded forms", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6("2001:db8::8:800:200c:417a")).toEqual([
      0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a,
    ]);
    expect(expandIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("rejects malformed input", () => {
    expect(expandIpv6("1:2:3")).toBeUndefined();
    expect(expandIpv6("::1::2")).toBeUndefined();
    expect(expandIpv6("fe80::1%lo0")).toBeUndefined();
    expect(expandIpv6("1.2.3.4")).toBeUndefined();
  });
});

describe("hostnames", () => {
  it("normalizes case, brackets and trailing dots", () => {
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(normalizeHostname("[::1]")).toBe("::1");
  });
  it.each([
    "localhost",
    "LOCALHOST.",
    "foo.localhost",
    "printer.local",
    "db.internal",
    "metadata.google.internal",
    "router.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "x.ip6.arpa",
  ])("blocks %s", (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });
  it.each(["example.com", "internal.example.com", "local.example.org", "localhost.example.com"])(
    "allows %s",
    (h) => {
      expect(isBlockedHostname(h)).toBe(false);
    },
  );
});

describe("assessUrl", () => {
  it("accepts public http(s) URLs on default ports", () => {
    const v = assessUrl("https://Example.com/path?q=1");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.hostname).toBe("example.com");
      expect(v.port).toBe(443);
      expect(v.literal).toBeUndefined();
      expect(v.exempt).toBe(false);
    }
    expect(assessUrl("http://example.com:80/").ok).toBe(true);
  });

  it.each([
    ["ftp://example.com/", "blocked_scheme"],
    ["file:///etc/passwd", "blocked_scheme"],
    ["gopher://example.com/", "blocked_scheme"],
    ["not a url", "blocked_scheme"],
    ["http://user:pw@example.com/", "blocked_host"],
    ["http://localhost/", "blocked_host"],
    ["http://metadata.google.internal/", "blocked_host"],
    ["http://example.com:8080/", "blocked_port"],
    ["https://example.com:22/", "blocked_port"],
    ["http://127.0.0.1/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data", "blocked_address"],
    ["http://[::1]/", "blocked_address"],
    ["http://[::ffff:10.0.0.1]/", "blocked_address"],
    ["http://[64:ff9b::7f00:1]/", "blocked_address"],
    ["http://0x7f000001/", "blocked_address"], // WHATWG URL canonicalises the hex spelling
  ] as const)("rejects %s with %s", (url, code) => {
    const v = assessUrl(url);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it("marks IP literals so the guard skips DNS", () => {
    const v = assessUrl("http://93.184.216.34/");
    expect(v.ok && v.literal).toBe("93.184.216.34");
    const v6 = assessUrl("http://[2606:4700:4700::1111]/");
    expect(v6.ok && v6.literal).toBe("2606:4700:4700::1111");
  });

  it("exempts allowed private hosts from host, port and address checks", () => {
    const policy = { allowedPrivateHosts: ["Keycloak.internal", "10.0.0.5", "[::1]"] };
    expect(assessUrl("http://keycloak.internal:8080/", policy)).toMatchObject({
      ok: true,
      exempt: true,
      port: 8080,
    });
    expect(assessUrl("http://10.0.0.5:9000/", policy)).toMatchObject({ ok: true, exempt: true });
    expect(assessUrl("http://[::1]:3000/", policy)).toMatchObject({ ok: true, exempt: true });
    expect(assessUrl("http://10.0.0.6/", policy)).toMatchObject({
      ok: false,
      code: "blocked_address",
    });
    expect(assessUrl("ftp://keycloak.internal/", policy)).toMatchObject({
      ok: false,
      code: "blocked_scheme",
    });
  });

  it("allowPrivate opens everything but the scheme", () => {
    expect(assessUrl("http://localhost:3000/", { allowPrivate: true })).toMatchObject({
      ok: true,
      exempt: true,
    });
    expect(assessUrl("http://127.0.0.1:1025/", { allowPrivate: true })).toMatchObject({ ok: true });
    expect(assessUrl("file:///x", { allowPrivate: true })).toMatchObject({ ok: false });
  });

  it("honours allowedPorts", () => {
    expect(assessUrl("http://example.com:8443/", { allowedPorts: [8443] }).ok).toBe(true);
    expect(assessUrl("http://example.com/", { allowedPorts: [8443] })).toMatchObject({
      ok: false,
      code: "blocked_port",
    });
  });
});

describe("assessAddresses", () => {
  it("requires every address to be routable", () => {
    expect(assessAddresses(["1.1.1.1", "2606:4700::1111"], false)).toEqual({ ok: true });
    expect(assessAddresses(["1.1.1.1", "10.0.0.1"], false)).toMatchObject({
      ok: false,
      code: "blocked_address",
    });
    expect(assessAddresses([], false)).toMatchObject({ ok: false, code: "dns_failed" });
    expect(assessAddresses([], true)).toMatchObject({ ok: false, code: "dns_failed" });
    expect(assessAddresses(["127.0.0.1"], true)).toEqual({ ok: true });
  });
});
