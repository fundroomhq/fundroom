/**
 * Rate limiting (EXECUTION_PLAN §5.2 `RateLimiterPort`). Default adapter is the Postgres
 * sliding window in `@fundroom/identity`; Redis is an optional adapter later.
 */
export interface RateLimitRule {
  /** Maximum hits allowed inside one window. */
  readonly max: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Hits left in the current window (0 when denied). */
  readonly remaining: number;
  /** How long a denied caller should wait; 0 when allowed. */
  readonly retryAfterMs: number;
}

export interface RateLimiterPort {
  /**
   * Records one hit against `key` and reports whether it is within `rule`.
   * Keys must not contain PII in the clear; callers hash emails and IPs.
   */
  hit(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
  /** Reports the state without recording a hit. */
  peek(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
  /** Clears a key, e.g. after a successful login resets the failure counter. */
  reset(key: string): Promise<void>;
}
