import { describe, expect, it } from "vitest";
import {
  createMemoryRateLimiter,
  createPostgresRateLimiter,
  RATE_LIMITS,
  scaleRateLimitRule,
  shareLinkRateKey,
} from "./rate-limiter.js";

describe("memory rate limiter (same semantics as the Postgres one)", () => {
  it("allows up to max hits per window, then denies with a retry hint", async () => {
    let t = 1_000_000;
    const rl = createMemoryRateLimiter({ now: () => new Date(t) });
    const rule = { max: 3, windowMs: 60_000 };
    expect(await rl.hit("k", rule)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    await rl.hit("k", rule);
    expect((await rl.hit("k", rule)).allowed).toBe(true);
    const denied = await rl.hit("k", rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Other keys are independent.
    expect((await rl.hit("other", rule)).allowed).toBe(true);
    // A minute later the previous bucket has decayed away.
    t += 120_000;
    expect((await rl.hit("k", rule)).allowed).toBe(true);
  });

  it("weights the previous bucket by how far into the window we are", async () => {
    let t = 60_000 * 10; // exactly on a boundary
    const rl = createMemoryRateLimiter({ now: () => new Date(t) });
    const rule = { max: 4, windowMs: 60_000 };
    for (let i = 0; i < 4; i++) await rl.hit("k", rule);
    t += 90_000; // half way into the next bucket: previous counts 0.5 * 4 = 2
    expect((await rl.hit("k", rule)).allowed).toBe(true); // 1 + 2 = 3 <= 4
    expect((await rl.hit("k", rule)).allowed).toBe(true); // 2 + 2 = 4 <= 4
    expect((await rl.hit("k", rule)).allowed).toBe(false); // 3 + 2 = 5
  });

  it("peek does not count and reset clears", async () => {
    const rl = createMemoryRateLimiter();
    const rule = { max: 1, windowMs: 60_000 };
    expect((await rl.peek("k", rule)).allowed).toBe(true);
    await rl.hit("k", rule);
    expect((await rl.peek("k", rule)).allowed).toBe(false);
    await rl.reset("k");
    expect((await rl.peek("k", rule)).allowed).toBe(true);
  });

  it("documents the kernel limits from design/05 §7", () => {
    expect(RATE_LIMITS.otpStartPerEmail).toEqual({ max: 5, windowMs: 15 * 60_000 });
    expect(RATE_LIMITS.otpStartPerIp).toEqual({ max: 20, windowMs: 60 * 60_000 });
    expect(RATE_LIMITS.totpPerUser.max).toBe(5);
  });
});

describe("share-link rate limits (E2.3, ADR-0039 decision 4)", () => {
  it("defines a limit for each of the link's three guessable secrets", () => {
    expect(RATE_LIMITS.shareLinkResolve.max).toBeGreaterThan(0);
    expect(RATE_LIMITS.shareLinkPasscode.max).toBeGreaterThan(0);
    expect(RATE_LIMITS.shareLinkOtpStart.max).toBeGreaterThan(0);
    // The passcode is the low-entropy one, so it gets the tightest bucket of the three.
    expect(RATE_LIMITS.shareLinkPasscode.max).toBeLessThan(RATE_LIMITS.shareLinkResolve.max);
  });

  it("keys every limit on the link, never on a caller-supplied address", () => {
    // Behind the shipped Caddy, `TRUST_PROXY=true` takes the first X-Forwarded-For hop, which the
    // attacker writes. A bucket keyed on that is a bucket the attacker chooses.
    const link = "01920000-0000-7000-8000-0000000000f1";
    expect(shareLinkRateKey("resolve", link)).toBe(`link:resolve:${link}`);
    expect(shareLinkRateKey("passcode", link)).toBe(`link:passcode:${link}`);
  });

  it("keys the OTP start per link AND address, so one visitor cannot lock out the rest", () => {
    const link = "01920000-0000-7000-8000-0000000000f1";
    expect(shareLinkRateKey("otp_start", link, "a@example.com")).toBe(
      `link:otp_start:${link}:a@example.com`,
    );
    expect(shareLinkRateKey("otp_start", link, "b@example.com")).not.toBe(
      shareLinkRateKey("otp_start", link, "a@example.com"),
    );
  });

  it("folds spelling differences of one address into one bucket", () => {
    const link = "01920000-0000-7000-8000-0000000000f1";
    expect(shareLinkRateKey("otp_start", link, "  A@Example.COM ")).toBe(
      shareLinkRateKey("otp_start", link, "a@example.com"),
    );
  });

  it("never throws on a malformed address, which would be a way to skip the limit", () => {
    expect(() => shareLinkRateKey("otp_start", "l", "not-an-email")).not.toThrow();
  });
});

describe("RATE_LIMIT_MULTIPLIER (E2.10)", () => {
  it("scales max, never the window, and is the identity at 1", () => {
    const rule = { max: 5, windowMs: 15 * 60_000 };
    expect(scaleRateLimitRule(rule, 1)).toBe(rule);
    expect(scaleRateLimitRule(rule, 100)).toEqual({ max: 500, windowMs: 15 * 60_000 });
  });

  it("the limiter applies it to every rule a caller passes, kernel constants included", async () => {
    const rl = createMemoryRateLimiter({ multiplier: 4 });
    const rule = RATE_LIMITS.otpStartPerEmail; // 5 per 15 min
    for (let i = 0; i < 20; i++) expect((await rl.hit("otp", rule)).allowed).toBe(true);
    expect((await rl.peek("otp", rule)).allowed).toBe(false);
    const denied = await rl.hit("otp", rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // An inline route rule (e.g. setup's 10 / 15 min) is scaled the same way.
    const inline = { max: 1, windowMs: 60_000 };
    for (let i = 0; i < 4; i++) expect((await rl.hit("inline", inline)).allowed).toBe(true);
    expect((await rl.hit("inline", inline)).allowed).toBe(false);
  });

  it("defaults to 1 (unchanged ceilings)", async () => {
    const rl = createMemoryRateLimiter();
    const rule = { max: 2, windowMs: 60_000 };
    await rl.hit("k", rule);
    await rl.hit("k", rule);
    expect((await rl.hit("k", rule)).allowed).toBe(false);
  });

  it("refuses a non-positive or fractional multiplier at construction", () => {
    for (const m of [0, -1, 1.5, Number.NaN]) {
      expect(() => createMemoryRateLimiter({ multiplier: m })).toThrow(RangeError);
      // biome-ignore lint/suspicious/noExplicitAny: the db is never touched before validation
      expect(() => createPostgresRateLimiter({} as any, { multiplier: m })).toThrow(RangeError);
    }
  });
});
