import type { Database } from "@fundroom/db";
import { normalizeHostname } from "../hostname.js";
import { findIssuableByHostname, type IssuableDomain } from "../repos/domains-repo.js";

/*
 * The hostname → workspace lookup behind Caddy's `ask` endpoint and the tenant classifier
 * (E2.1 §1.8). Two callers, one cache, four properties that matter:
 *
 * 1. **Host context.** There is no workspace yet — that is the question being asked — so every
 *    read runs under `db.withHost(...)`. The table's fence admits the `host` actor kind for
 *    exactly this reason (see `0007_custom_domains.sql`). Under `withTenant` it would return
 *    zero rows and every custom domain would 404.
 * 2. **It is attacker-facing.** `?domain=` on the `ask` endpoint is unauthenticated input from
 *    the public internet (the Caddy catch-all proxies every path). So the cache needs a **size
 *    cap** and not only a TTL: a TTL-only negative cache is a memory-pressure vector, one entry
 *    per hostname an attacker cares to invent. The cap follows `container.ts`'s `BRAND_CACHE_MAX`
 *    pattern — clear the whole map when it is full, which is O(1), keeps no LRU bookkeeping on
 *    the TLS handshake path, and costs at most one repopulating query per live hostname.
 * 3. **Negative entries are cached too.** The common case for an unknown host is a bot probing
 *    the IP, and a miss that is not remembered is a database round trip per probe.
 * 4. **Cache misses are rate-limited globally** (E2.1 S3) — see `LOOKUP_MISS_MAX_PER_WINDOW`.
 *    This is the thing that protects Postgres, so it counts database reads rather than requests
 *    and is not keyed on anything a caller supplies.
 *
 * Staleness: 60 s (§9.2), which is also why a demotion takes up to a minute to stop serving.
 * Cross-replica invalidation (`NOTIFY`) is out of scope for E2.1; the TTL is the answer for now.
 */

/** Hostnames answered `dns_ok` or `active`; `active` is not required (E2.1 decision 3). */
export interface CustomDomainLookup {
  /**
   * `ask` + the classifier. Host context, bounded cache, positive AND negative entries.
   *
   * This is the **serving** path, so a `dns_ok` hit here fires the promotion to `active`
   * (E2.1 S2) — at most once per host per cache TTL, off the response path, and never able to
   * fail the request.
   */
  workspaceFor(hostname: string): Promise<{ workspaceId: string; slug: string } | undefined>;
  /** True for `dns_ok` or `active` — what `ask` answers 200 for. Never promotes. */
  issuable(hostname: string): Promise<boolean>;
  invalidate(hostname?: string): void;
}

export interface CustomDomainLookupOptions {
  readonly db: Pick<Database, "withHost">;
  /** §9.2. Default 60 s. */
  readonly ttlMs?: number | undefined;
  /** Ceiling on cached hostnames, positive and negative together. Default 1 000. */
  readonly max?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /** Test seam / alternative store. Defaults to the host-context query in the repo. */
  readonly read?: ((hostname: string) => Promise<IssuableDomain | undefined>) | undefined;
  /**
   * Called when a `dns_ok` row is resolved on the **serving** path: the hostname has just been
   * used to route a real request, which is the only observable evidence that a certificate
   * exists and the edge is serving on it (E2.1 S2, ADR-0039 decision 3).
   *
   * Fire-and-forget by contract. The lookup never awaits it and never lets it throw into the
   * request, and it is called at most once per host per cache TTL, so it is not on the hot path
   * of every request: one `dns_ok` miss triggers one promotion, and the next read sees `active`.
   */
  readonly onServed?: ((domain: IssuableDomain) => void) | undefined;
  /** Global ceiling on database reads per window. Default `LOOKUP_MISS_MAX_PER_WINDOW`. */
  readonly missMaxPerWindow?: number | undefined;
  readonly missWindowMs?: number | undefined;
}

export const LOOKUP_TTL_MS = 60_000;
export const LOOKUP_CACHE_MAX = 1_000;

/**
 * The global cache-miss budget, and why it is shaped like this (E2.1 S3).
 *
 * The `ask` endpoint used to carry its own limiter keyed on the client IP. That was wrong twice
 * over: `TRUST_PROXY=true` in the shipped stack and Caddy *appends* to `X-Forwarded-For`, so the
 * first hop was attacker-supplied and one request per spoofed value bought a fresh bucket — while
 * Caddy dials the endpoint directly, so every legitimate ask shared a single bucket keyed on
 * Caddy's container IP and a bot spraying random SNI could push real customers' first handshakes
 * into a 429.
 *
 * What needs protecting is Postgres, so the limit is on the thing that reaches Postgres: a single
 * global counter of cache **misses**, behind the negative cache and behind `ask`'s canonical-host
 * fast path. A spoofed header cannot inflate a global counter, and legitimate unique-hostname
 * traffic is bounded by real database load rather than by an arbitrary per-IP number.
 *
 * The ceiling: a full cache holds 1 000 hostnames for 60 s, so the most a correctly-sized install
 * can legitimately need is ~1 000 misses per window, plus churn from clear-on-full. 3 000 is
 * three times that, and it is 50 lookups/second of a single index probe on
 * `custom_domain_claim_idx` — a load this database does not notice, while an enumeration sweep
 * worth running needs orders of magnitude more. Over the ceiling the answer is "not found", never
 * a 429: Caddy treats any non-2xx as "do not issue", and a 404 does not tell a prober they found
 * a rate limit.
 */
export const LOOKUP_MISS_MAX_PER_WINDOW = 3_000;
export const LOOKUP_MISS_WINDOW_MS = 60_000;

interface Entry {
  /** `undefined` is a cached negative: the hostname is not verified for any workspace. */
  readonly value: IssuableDomain | undefined;
  readonly until: number;
  /**
   * Set once this entry has fired a serving promotion. The entry is only ever created on a miss,
   * so this plus the TTL is the throttle: one promotion per host per 60 s at worst.
   */
  promoted?: boolean;
}

export function createCustomDomainLookup(options: CustomDomainLookupOptions): CustomDomainLookup {
  const ttlMs = options.ttlMs ?? LOOKUP_TTL_MS;
  const max = options.max ?? LOOKUP_CACHE_MAX;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const read =
    options.read ??
    ((hostname: string) => options.db.withHost((tx) => findIssuableByHostname(tx, hostname)));
  const missMax = options.missMaxPerWindow ?? LOOKUP_MISS_MAX_PER_WINDOW;
  const missWindowMs = options.missWindowMs ?? LOOKUP_MISS_WINDOW_MS;
  const cache = new Map<string, Entry>();
  let missSlot = -1;
  let missCount = 0;

  /**
   * The same normalisation the write path used, so the stored spelling and the `Host` header
   * cannot disagree about what a hostname is — the whole point of `hostname.ts`. It also refuses
   * IP literals, reserved names and public suffixes without a query, which keeps the cheapest
   * garbage off the database entirely.
   */
  function keyOf(hostname: string): string | undefined {
    const withoutPort = hostname.trim().replace(/:\d+$/u, "");
    const checked = normalizeHostname(withoutPort);
    return checked.ok ? checked.hostname : undefined;
  }

  /** One fixed window, one counter, no key. See `LOOKUP_MISS_MAX_PER_WINDOW`. */
  function missAllowed(atMs: number): boolean {
    const slot = Math.floor(atMs / missWindowMs);
    if (slot !== missSlot) {
      missSlot = slot;
      missCount = 0;
    }
    missCount += 1;
    if (missCount <= missMax) return true;
    // Once per window, not once per request: this line exists to tell an operator the ceiling is
    // being hit, not to become the flood's amplifier.
    if (missCount === missMax + 1) {
      log("domains.lookup_miss_limited", { level: "warn", window: missWindowMs, limit: missMax });
    }
    return false;
  }

  async function entryFor(hostname: string): Promise<Entry | undefined> {
    const key = keyOf(hostname);
    // Not a hostname we could ever have stored: answer no, cache nothing, query nothing.
    if (key === undefined) return undefined;
    const t = now().getTime();
    const hit = cache.get(key);
    if (hit !== undefined && hit.until > t) return hit;
    // Over the global budget. Nothing is cached: "we did not look" is not an answer, and caching
    // it would turn a burst into 60 s of false negatives for a hostname that is perfectly valid.
    if (!missAllowed(t)) return undefined;
    const value = await read(key);
    // Clear-on-full, the `BRAND_CACHE_MAX` pattern: an unbounded map keyed by attacker-supplied
    // hostnames is the memory-pressure vector this cap exists to close.
    if (cache.size >= max) {
      cache.clear();
      log("domains.lookup_cache_cleared", { size: max });
    }
    const entry: Entry = { value, until: t + ttlMs };
    cache.set(key, entry);
    return entry;
  }

  return {
    async workspaceFor(hostname) {
      const entry = await entryFor(hostname);
      const row = entry?.value;
      if (entry === undefined || row === undefined) return undefined;
      // The promotion (E2.1 S2). `active` means "a request has been served on this hostname", and
      // this is the one place that fact exists: the classifier resolved a real request through
      // it, so the handshake completed and a certificate is in hand. Deliberately not `ask`,
      // which fires *before* the certificate exists.
      if (row.status === "dns_ok" && entry.promoted !== true && options.onServed !== undefined) {
        entry.promoted = true;
        try {
          options.onServed(row);
        } catch (error) {
          // A promotion is bookkeeping; the request it rode in on has already been routed.
          log("domains.promote_failed", {
            level: "warn",
            hostname: row.hostname,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { workspaceId: row.workspaceId, slug: row.slug };
    },

    async issuable(hostname) {
      // Same entry, same query: `custom_domain_claim_idx` already restricts the read to
      // `dns_ok|active`, so a row existing *is* the answer to both questions.
      return (await entryFor(hostname))?.value !== undefined;
    },

    invalidate(hostname) {
      if (hostname === undefined) {
        cache.clear();
        return;
      }
      const key = keyOf(hostname);
      // Drop both spellings: the caller may hand us the raw string it was given.
      cache.delete(hostname.trim().toLowerCase());
      if (key !== undefined) cache.delete(key);
    },
  };
}
