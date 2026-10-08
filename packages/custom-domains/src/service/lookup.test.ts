import type { Database, Tx } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import type { IssuableDomain } from "../repos/domains-repo.js";
import {
  createCustomDomainLookup,
  LOOKUP_CACHE_MAX,
  LOOKUP_MISS_MAX_PER_WINDOW,
  LOOKUP_MISS_WINDOW_MS,
  LOOKUP_TTL_MS,
} from "./lookup.js";

/*
 * The cache is on the TLS handshake path and its input is unauthenticated (`?domain=` on the
 * `ask` endpoint, reachable through Caddy's catch-all). So the tests that matter are not "does
 * it cache" but: does it cache *negatives*, does it expire, and is it *bounded* — a TTL-only
 * negative cache is a memory-pressure vector, one entry per hostname an attacker invents.
 */

const WS = "01920000-0000-7000-8000-0000000000a1";

function row(hostname: string, status: IssuableDomain["status"] = "dns_ok"): IssuableDomain {
  return {
    id: "01920000-0000-7000-8000-0000000000c1",
    workspaceId: WS,
    slug: "acme",
    hostname,
    status,
  };
}

function fixture(
  known: Readonly<Record<string, IssuableDomain>> = {},
  options: { onServedThrows?: boolean } = {},
) {
  const asked: string[] = [];
  const served: string[] = [];
  const logged: string[] = [];
  let clock = new Date("2026-09-13T00:00:00Z");
  let hostCalls = 0;
  const db = {
    withHost: async <T>(fn: (tx: Tx) => Promise<T>) => {
      hostCalls++;
      return fn({} as Tx);
    },
  } as unknown as Pick<Database, "withHost">;

  const lookup = createCustomDomainLookup({
    db,
    now: () => clock,
    read: async (hostname) => {
      asked.push(hostname);
      return known[hostname];
    },
    onServed: (domain) => {
      served.push(domain.hostname);
      if (options.onServedThrows === true) throw new Error("promotion exploded");
    },
    log: (event) => logged.push(event),
  });
  return {
    lookup,
    asked,
    served,
    logged,
    get hostCalls() {
      return hostCalls;
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("workspaceFor", () => {
  it("answers for dns_ok as well as active — a cert cannot exist before the first handshake", async () => {
    const f = fixture({
      "investors.acme.com": row("investors.acme.com", "dns_ok"),
      "ir.acme.com": row("ir.acme.com", "active"),
    });
    expect(await f.lookup.workspaceFor("investors.acme.com")).toEqual({
      workspaceId: WS,
      slug: "acme",
    });
    expect(await f.lookup.issuable("ir.acme.com")).toBe(true);
  });

  it("normalises the Host header the same way the write path did, port and case included", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com") });
    expect(await f.lookup.issuable("INVESTORS.Acme.com.")).toBe(true);
    expect(await f.lookup.issuable("investors.acme.com:8443")).toBe(true);
    // One cached entry, one query: all three spellings are the same hostname.
    expect(f.asked).toEqual(["investors.acme.com"]);
  });

  it("refuses what could never have been stored without touching the database", async () => {
    const f = fixture();
    for (const host of ["127.0.0.1", "localhost", "com", "*.acme.com", "", "a..b"]) {
      expect(await f.lookup.issuable(host), host).toBe(false);
    }
    expect(f.asked).toEqual([]);
    expect(f.hostCalls).toBe(0);
  });

  it("caches negatives, because the common unknown host is a bot probing the IP", async () => {
    const f = fixture();
    expect(await f.lookup.issuable("nope.example.com")).toBe(false);
    expect(await f.lookup.issuable("nope.example.com")).toBe(false);
    expect(f.asked).toEqual(["nope.example.com"]);
  });

  it("expires after the 60 s TTL (§9.2), which is why a demotion takes a minute to bite", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com") });
    await f.lookup.issuable("investors.acme.com");
    f.advance(LOOKUP_TTL_MS - 1);
    await f.lookup.issuable("investors.acme.com");
    expect(f.asked).toHaveLength(1);
    f.advance(2);
    await f.lookup.issuable("investors.acme.com");
    expect(f.asked).toHaveLength(2);
  });
});

describe("the size cap", () => {
  it("is bounded, not just TTL'd: an attacker-supplied hostname cannot grow the map forever", async () => {
    const asked: string[] = [];
    const cleared: number[] = [];
    const lookup = createCustomDomainLookup({
      db: { withHost: async () => undefined } as unknown as Pick<Database, "withHost">,
      max: 4,
      read: async (hostname) => {
        asked.push(hostname);
        return undefined;
      },
      log: (event) => {
        if (event === "domains.lookup_cache_cleared") cleared.push(cleared.length + 1);
      },
    });

    for (let i = 0; i < 4; i++) await lookup.issuable(`probe${i}.example.com`);
    expect(asked).toHaveLength(4);
    expect(cleared).toHaveLength(0);
    // The 5th miss finds the map full and clears it (the BRAND_CACHE_MAX pattern: O(1), no LRU
    // bookkeeping on the handshake path), so the earlier entries are gone and re-queried.
    await lookup.issuable("probe4.example.com");
    expect(cleared).toHaveLength(1);
    await lookup.issuable("probe0.example.com");
    expect(asked).toHaveLength(6);
  });

  it("defaults to 1 000 entries", () => {
    expect(LOOKUP_CACHE_MAX).toBe(1_000);
    expect(LOOKUP_TTL_MS).toBe(60_000);
  });
});

describe("invalidate", () => {
  it("drops one hostname in any spelling the caller happens to hold", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com") });
    await f.lookup.issuable("investors.acme.com");
    f.lookup.invalidate("INVESTORS.Acme.com.");
    await f.lookup.issuable("investors.acme.com");
    expect(f.asked).toHaveLength(2);
  });

  it("drops everything when called with no hostname", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com") });
    await f.lookup.issuable("investors.acme.com");
    await f.lookup.issuable("other.example.com");
    f.lookup.invalidate();
    await f.lookup.issuable("investors.acme.com");
    await f.lookup.issuable("other.example.com");
    expect(f.asked).toHaveLength(4);
  });
});

describe("host context", () => {
  it("reads through withHost: the fence admits the host actor, and there is no workspace yet", async () => {
    let sawHost = false;
    const lookup = createCustomDomainLookup({
      db: {
        withHost: async <T>(fn: (tx: Tx) => Promise<T>) => {
          sawHost = true;
          return fn({} as Tx);
        },
      } as unknown as Pick<Database, "withHost">,
      // No `read` override: the default path is the one under test.
    });
    // The default `read` runs the repo's host-context query; with a stub `Tx` it throws, and the
    // point of the assertion is only that it was reached through `withHost`.
    await lookup.issuable("investors.acme.com").catch(() => undefined);
    expect(sawHost).toBe(true);
  });
});

/*
 * `dns_ok → active` (E2.1 S2).
 *
 * `active` is what `ResolvedWorkspace.primaryHost` keys off, so it decides where `workspaceUrl`,
 * `canonicalOrigin` and `brandingLogoUrl` point. It therefore has to mean "the edge is serving on
 * this hostname" and not "DNS looked right twice": a zone with a CAA record excluding our CA, or
 * an ACME account that is rate-limited, answers the hostname with a TLS error, and every update
 * email would ship dead links. The classifier resolving a live request through the hostname is
 * the only place that fact is observable.
 */
describe("the serving promotion", () => {
  it("fires for a dns_ok row resolved on the classifier path", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com", "dns_ok") });
    expect(await f.lookup.workspaceFor("investors.acme.com")).toEqual({
      workspaceId: WS,
      slug: "acme",
    });
    expect(f.served).toEqual(["investors.acme.com"]);
  });

  it("does not fire for `ask`, which asks before the certificate exists", async () => {
    // `ask` answers 200 on `dns_ok` precisely because the certificate cannot exist before the
    // first handshake (decision 3). Promoting from it would make `active` mean "Caddy asked".
    const f = fixture({ "investors.acme.com": row("investors.acme.com", "dns_ok") });
    expect(await f.lookup.issuable("investors.acme.com")).toBe(true);
    expect(f.served).toEqual([]);
  });

  it("fires at most once per host per cache TTL, however many requests arrive", async () => {
    const f = fixture({ "investors.acme.com": row("investors.acme.com", "dns_ok") });
    for (let i = 0; i < 50; i++) await f.lookup.workspaceFor("investors.acme.com");
    expect(f.served).toHaveLength(1);
    // A fresh entry after the TTL may try again — which is the intended retry for a promotion
    // that failed, and is bounded at one per minute per host.
    f.advance(LOOKUP_TTL_MS + 1);
    await f.lookup.workspaceFor("investors.acme.com");
    expect(f.served).toHaveLength(2);
  });

  it("never fires for a row that is already active", async () => {
    const f = fixture({ "ir.acme.com": row("ir.acme.com", "active") });
    await f.lookup.workspaceFor("ir.acme.com");
    expect(f.served).toEqual([]);
  });

  it("still routes the request when the promotion throws", async () => {
    const f = fixture(
      { "investors.acme.com": row("investors.acme.com", "dns_ok") },
      { onServedThrows: true },
    );
    expect(await f.lookup.workspaceFor("investors.acme.com")).toEqual({
      workspaceId: WS,
      slug: "acme",
    });
    expect(f.logged).toContain("domains.promote_failed");
  });
});

/*
 * The global cache-miss limit (E2.1 S3).
 *
 * The `ask` route used to carry a limiter keyed on `clientIp(c, trustProxy)`. With
 * `TRUST_PROXY=true` in the shipped stack and Caddy *appending* to `X-Forwarded-For`, the first
 * hop was attacker-supplied — a fresh bucket per spoofed value, so the limiter never fired —
 * while every legitimate ask arrived from Caddy's own container IP and shared one bucket.
 * Counting database reads instead is both unspoofable and the thing that actually needs a ceiling.
 */
describe("the cache-miss limit", () => {
  function limited(max: number, known: Readonly<Record<string, IssuableDomain>> = {}) {
    const asked: string[] = [];
    const logged: string[] = [];
    let clock = new Date("2026-09-13T00:00:00Z");
    const lookup = createCustomDomainLookup({
      db: { withHost: async () => undefined } as unknown as Pick<Database, "withHost">,
      missMaxPerWindow: max,
      now: () => clock,
      read: async (hostname) => {
        asked.push(hostname);
        return known[hostname];
      },
      log: (event) => logged.push(event),
    });
    return {
      lookup,
      asked,
      logged,
      advance: (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
    };
  }

  it("stops querying the database past the ceiling and answers not-found", async () => {
    const f = limited(3, { "real.acme.com": row("real.acme.com") });
    for (let i = 0; i < 3; i++) expect(await f.lookup.issuable(`p${i}.example.com`)).toBe(false);
    expect(f.asked).toHaveLength(3);
    // Over budget: a hostname that *is* verified is answered `false` without a query. 404 rather
    // than 429 on purpose — Caddy treats any non-2xx as "do not issue", and a 404 does not tell
    // a prober they found a rate limit.
    expect(await f.lookup.issuable("real.acme.com")).toBe(false);
    expect(f.asked).toHaveLength(3);
    expect(f.logged).toContain("domains.lookup_miss_limited");
  });

  it("caches nothing while over budget: 'we did not look' is not an answer", async () => {
    const f = limited(1, { "real.acme.com": row("real.acme.com") });
    await f.lookup.issuable("first.example.com");
    expect(await f.lookup.issuable("real.acme.com")).toBe(false);
    // The next window asks properly rather than serving a 60-second false negative.
    f.advance(60_001);
    expect(await f.lookup.issuable("real.acme.com")).toBe(true);
  });

  it("is not spent by repeats, because the cache sits in front of it", async () => {
    const f = limited(2, { "real.acme.com": row("real.acme.com") });
    for (let i = 0; i < 100; i++) expect(await f.lookup.issuable("real.acme.com")).toBe(true);
    expect(f.asked).toHaveLength(1);
  });

  it("resets each window and defaults to a ceiling well above a full cache", async () => {
    const f = limited(1);
    await f.lookup.issuable("a.example.com");
    await f.lookup.issuable("b.example.com");
    expect(f.asked).toHaveLength(1);
    f.advance(LOOKUP_MISS_WINDOW_MS);
    await f.lookup.issuable("c.example.com");
    expect(f.asked).toHaveLength(2);
    // Three times what a full 1 000-entry cache can need in a 60 s window.
    expect(LOOKUP_MISS_MAX_PER_WINDOW).toBe(3 * LOOKUP_CACHE_MAX);
    expect(LOOKUP_MISS_WINDOW_MS).toBe(LOOKUP_TTL_MS);
  });
});
