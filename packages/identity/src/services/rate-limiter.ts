import type { Database } from "@fundroom/db";
import type { RateLimitDecision, RateLimiterPort, RateLimitRule } from "@fundroom/ports";
import { sha256 } from "../crypto/tokens.js";
import {
  deleteBucketsBefore,
  deleteKey,
  incrementBucket,
  readBuckets,
} from "../repos/rate-limit-repo.js";

/*
 * RateLimiterPort on Postgres (EXECUTION_PLAN §5.2): sliding-window counter over two fixed
 * buckets. Keys are hashed before they touch the database, so `otp:start:email:<address>`
 * never lands in a table. Good to a few hundred hits per second per key on a single node;
 * a Redis adapter is the upgrade for large hosts.
 */
export interface PostgresRateLimiterOptions {
  readonly now?: () => Date;
  /**
   * `RATE_LIMIT_MULTIPLIER` (E2.10): every rule's `max` is multiplied by this before it is
   * applied, so a load-test or CI stack can raise every ceiling at once without each caller
   * knowing. The window is unchanged. Applied here, in the one place every `RateLimiterPort`
   * caller goes through, rather than in each route. Config refuses anything but 1 in prod.
   * Default 1; must be a positive integer.
   */
  readonly multiplier?: number;
}

/** Applies a multiplier to a rule's ceiling (window unchanged). Exported for tests and docs. */
export function scaleRateLimitRule(rule: RateLimitRule, multiplier: number): RateLimitRule {
  return multiplier === 1 ? rule : { max: rule.max * multiplier, windowMs: rule.windowMs };
}

function multiplierOf(options: PostgresRateLimiterOptions): number {
  const m = options.multiplier ?? 1;
  if (!Number.isInteger(m) || m < 1) {
    throw new RangeError(`rate-limit multiplier must be a positive integer, got ${m}`);
  }
  return m;
}

function keyHash(key: string): string {
  return sha256(key).toString("base64url");
}

function decide(
  current: number,
  previous: number,
  elapsedFrac: number,
  rule: RateLimitRule,
): RateLimitDecision {
  const estimate = current + previous * (1 - elapsedFrac);
  const allowed = estimate <= rule.max;
  const remaining = allowed ? Math.max(0, Math.floor(rule.max - estimate)) : 0;
  const retryAfterMs = allowed ? 0 : Math.ceil(rule.windowMs * (1 - elapsedFrac)) || rule.windowMs;
  return { allowed, remaining, retryAfterMs };
}

export function createPostgresRateLimiter(
  db: Database,
  options: PostgresRateLimiterOptions = {},
): RateLimiterPort & { sweep(olderThanMs: number): Promise<number> } {
  const now = options.now ?? (() => new Date());
  const multiplier = multiplierOf(options);

  function buckets(rule: RateLimitRule): {
    current: number;
    previous: number;
    elapsedFrac: number;
  } {
    const t = now().getTime();
    const current = Math.floor(t / rule.windowMs);
    return {
      current,
      previous: current - 1,
      elapsedFrac: (t - current * rule.windowMs) / rule.windowMs,
    };
  }

  return {
    async hit(key, baseRule) {
      const rule = scaleRateLimitRule(baseRule, multiplier);
      const k = keyHash(key);
      const b = buckets(rule);
      return db.withHost(async (tx) => {
        const count = await incrementBucket(tx, k, b.current);
        const prev = (await readBuckets(tx, k, [b.previous])).get(b.previous) ?? 0;
        return decide(count, prev, b.elapsedFrac, rule);
      });
    },
    async peek(key, baseRule) {
      const rule = scaleRateLimitRule(baseRule, multiplier);
      const k = keyHash(key);
      const b = buckets(rule);
      return db.withHost(async (tx) => {
        const rows = await readBuckets(tx, k, [b.current, b.previous]);
        // A peek asks "would one more hit be allowed?"
        return decide(
          (rows.get(b.current) ?? 0) + 1,
          rows.get(b.previous) ?? 0,
          b.elapsedFrac,
          rule,
        );
      });
    },
    async reset(key) {
      await db.withHost((tx) => deleteKey(tx, keyHash(key)));
    },
    async sweep(olderThanMs) {
      // Buckets are per-window integers; use the smallest window anyone would configure (1 min)
      // to compute a conservative floor.
      const floor = Math.floor((now().getTime() - olderThanMs) / 60_000);
      return db.withHost((tx) => deleteBucketsBefore(tx, floor));
    },
  };
}

/** In-memory limiter for unit tests and single-process tools. Same semantics, no persistence. */
export function createMemoryRateLimiter(options: PostgresRateLimiterOptions = {}): RateLimiterPort {
  const now = options.now ?? (() => new Date());
  const multiplier = multiplierOf(options);
  const store = new Map<string, number>();
  const bucketsOf = (rule: RateLimitRule) => {
    const t = now().getTime();
    const current = Math.floor(t / rule.windowMs);
    return {
      current,
      previous: current - 1,
      elapsedFrac: (t - current * rule.windowMs) / rule.windowMs,
    };
  };
  return {
    async hit(key, baseRule) {
      const rule = scaleRateLimitRule(baseRule, multiplier);
      const b = bucketsOf(rule);
      const ck = `${key}#${b.current}`;
      const count = (store.get(ck) ?? 0) + 1;
      store.set(ck, count);
      return decide(count, store.get(`${key}#${b.previous}`) ?? 0, b.elapsedFrac, rule);
    },
    async peek(key, baseRule) {
      const rule = scaleRateLimitRule(baseRule, multiplier);
      const b = bucketsOf(rule);
      return decide(
        (store.get(`${key}#${b.current}`) ?? 0) + 1,
        store.get(`${key}#${b.previous}`) ?? 0,
        b.elapsedFrac,
        rule,
      );
    },
    async reset(key) {
      for (const k of [...store.keys()]) if (k.startsWith(`${key}#`)) store.delete(k);
    },
  };
}

/** The limits the kernel applies (design/05 §7). Exported so tests and docs stay honest. */
export const RATE_LIMITS = {
  otpStartPerEmail: { max: 5, windowMs: 15 * 60_000 },
  otpStartPerIp: { max: 20, windowMs: 60 * 60_000 },
  otpVerifyPerIp: { max: 30, windowMs: 15 * 60_000 },
  passwordPerEmail: { max: 5, windowMs: 15 * 60_000 },
  passwordPerIp: { max: 20, windowMs: 60 * 60_000 },
  totpPerUser: { max: 5, windowMs: 15 * 60_000 },
  /** E3.8: TOTP / recovery step-ups from SSO-bound sessions, per client address. */
  totpSsoPerIp: { max: 20, windowMs: 15 * 60_000 },
  passkeyPerIp: { max: 20, windowMs: 15 * 60_000 },
  oidcPerIp: { max: 30, windowMs: 15 * 60_000 },
  /*
   * Share links (E2.3, contract D7 / ADR-0039 decision 4). A share-link URL is an unauthenticated
   * surface with three separately guessable secrets — the token, the passcode and the OTP — so
   * each gets its own counter, and every one of them is keyed on **the link**, never on
   * `clientIp()` alone: an IP is shared (NAT, mobile carriers) or rotated (botnets), so an IP
   * bucket cannot bound guesses at one link. Use `shareLinkRateKey` to build the keys. An IP bucket may be added on top of these;
   * it may never replace them.
   *
   * The passcode has a second, harder stop: `share_link.passcode_attempts` /
   * `passcode_locked_until` on the row itself, the way `core.auth_challenge.attempts` already
   * works for OTP. This limit only blunts the rate.
   */
  shareLinkResolve: { max: 60, windowMs: 15 * 60_000 },
  shareLinkPasscode: { max: 10, windowMs: 15 * 60_000 },
  shareLinkOtpStart: { max: 5, windowMs: 15 * 60_000 },
  /*
   * Public access requests (E3.1). Use `accessRequestRateKey` to build the keys; the address and
   * the client IP are folded to a sha256 digest, never stored raw.
   *
   * start: per (workspace, address) 3/h — the budget that bounds how many codes, and so how many
   * live challenges, one address can have; per workspace 1000/h — a ceiling on mail volume, high
   * enough that one noisy client cannot switch the form off for everyone; per (workspace, client
   * IP) 20/h. `clientIp()` is trustworthy here since E2.10 (F-07): without TRUST_PROXY it is the
   * socket peer, behind a trusted proxy the entry TRUST_PROXY_HOPS from the right (or the
   * platform's CLIENT_IP_HEADER) — never the client-written leftmost X-Forwarded-For entry — the
   * same address the sign-in per-IP buckets key on. Over any start limit the answer is the
   * ordinary one and nothing is sent: a 429 would tell a stranger which addresses somebody else
   * has been asking about.
   *
   * verify: per (workspace, address) 5 per 15 min, hit BEFORE any code is compared — the attempt
   * budget for every code mailed to that address together. Over it the answer is the ordinary
   * `invalid_code`. There is deliberately no workspace-wide verify bucket: anyone could spend it
   * and switch verification off for every requester (E3.1 S3).
   */
  accessRequestStartPerEmail: { max: 3, windowMs: 60 * 60_000 },
  accessRequestStartPerWorkspace: { max: 1000, windowMs: 60 * 60_000 },
  accessRequestStartPerIp: { max: 20, windowMs: 60 * 60_000 },
  accessRequestVerifyPerEmail: { max: 5, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Rate-limit keys for the public access-request routes (E3.1). The address (or client IP) is
 * folded to a sha256 digest here, so it never appears in a key even in the in-memory limiter (the
 * Postgres limiter hashes the whole key again before storing it). `subject` is the normalized
 * address for `start_email`/`verify_email`, the client IP for `start_ip`, absent for `start_ws`.
 */
export function accessRequestRateKey(
  what: "start_email" | "start_ws" | "start_ip" | "verify_email",
  workspaceId: string,
  subject?: string | undefined,
): string {
  return subject === undefined
    ? `access_request:${what}:${workspaceId}`
    : `access_request:${what}:${workspaceId}:${sha256(subject.trim().toLowerCase()).toString("hex")}`;
}

/**
 * Rate-limit keys for the share-link routes. `email` is present for the OTP start (one visitor
 * asking repeatedly must not lock every other visitor out of the same link) and absent for
 * resolve and passcode, where the link row is the whole subject.
 *
 * `email` must already be normalized (`normalizeEmail`) so two spellings of one address share a
 * bucket; it is lower-cased here as a backstop, never validated — a key builder that could throw
 * would turn a malformed address into a way to skip the limit. The address is hashed into the key
 * by the limiter itself (`keyHash`), so nothing here reaches a table in the clear.
 */
export function shareLinkRateKey(
  what: "resolve" | "passcode" | "otp_start",
  linkId: string,
  email?: string | undefined,
): string {
  return email === undefined
    ? `link:${what}:${linkId}`
    : `link:${what}:${linkId}:${email.trim().toLowerCase()}`;
}
