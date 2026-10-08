import { describe, expect, it } from "vitest";
import { forwardedClientIp, normalizeIp } from "./request.js";

/* E2.10 F-07: the client address behind a trusted proxy. */

const headers =
  (h: Record<string, string>) =>
  (name: string): string | undefined =>
    h[name.toLowerCase()];

describe("forwardedClientIp", () => {
  it("never takes the client-written leftmost X-Forwarded-For entry behind one proxy", () => {
    // The client sent `X-Forwarded-For: 6.6.6.6`; the proxy appended the address it saw.
    const h = headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(forwardedClientIp(h, { hops: 1 })).toBe("203.0.113.7");
    // Rotating the spoofed value does not change the answer (no fresh rate-limit bucket).
    for (const spoof of ["1.1.1.1", "10.0.0.1, 9.9.9.9", "garbage"]) {
      expect(
        forwardedClientIp(headers({ "x-forwarded-for": `${spoof}, 203.0.113.7` }), { hops: 1 }),
      ).toBe("203.0.113.7");
    }
  });

  it("counts hops from the right", () => {
    const h = headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 172.18.0.3" });
    expect(forwardedClientIp(h, { hops: 2 })).toBe("198.51.100.4");
    expect(forwardedClientIp(h, { hops: 3 })).toBe("6.6.6.6");
    // Fewer entries than hops: the leftmost there is (Express's `trust proxy = n`).
    expect(forwardedClientIp(h, { hops: 9 })).toBe("6.6.6.6");
  });

  it("with a platform header, reads only that header and never falls back to X-Forwarded-For", () => {
    const trust = { hops: 1, clientIpHeader: "Fly-Client-IP" };
    expect(
      forwardedClientIp(
        headers({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }),
        trust,
      ),
    ).toBe("203.0.113.9");
    expect(forwardedClientIp(headers({ "x-forwarded-for": "6.6.6.6" }), trust)).toBeUndefined();
  });

  it("answers only IP literals (ports stripped), else undefined for the socket fallback", () => {
    expect(forwardedClientIp(headers({ "x-forwarded-for": "not-an-ip" }), { hops: 1 })).toBe(
      undefined,
    );
    expect(forwardedClientIp(headers({}), { hops: 1 })).toBeUndefined();
    expect(normalizeIp("203.0.113.7:4711")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp(" ")).toBeUndefined();
  });
});
