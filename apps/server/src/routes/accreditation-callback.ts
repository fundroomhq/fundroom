import type { AccreditationVendorDriver } from "@fundroom/ports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { countSecurityEvent, markSecurityEvent } from "../middleware/security-events.js";
import { canonicalBaseOf } from "../path-mount.js";

/*
 * Accreditation vendor callbacks (E3.7, ADR-0055): `POST /webhooks/accreditation/{connectionId}` in
 * the ops tree — no tenant, no session, no CSRF (the classifier routes
 * `/webhooks/accreditation/<uuid>` to `ops`). The caller is the vendor; the only credential is the
 * signature the connection's adapter verifies (`AccreditationVendorPort.parseCallback`) with the
 * webhook secret stored on the connection. The workspace comes from the connection row, never
 * from the host.
 *
 * **A callback is only a wake-up** (contract §0). Nothing in its body is trusted: after the adapter
 * authenticates it, the service records `last_callback_at` and publishes
 * `accreditation.provider_updated` with the refs it named; the round module re-reads each one over
 * the vendor's authenticated API. A forged or replayed callback can at most cause one extra read.
 *
 * The budgets and answers are a copy of the e-sign callback route's (`./esign-callback.ts`, whose
 * header explains each rule at length) — deliberately a copy, not a shared helper, so neither
 * route's behaviour can drift by editing the other:
 *
 *  - **413** past 256 KiB, before the adapter sees a byte.
 *  - **401** `{"error":{"code":"unauthenticated"}}` when the connection is unknown/deleted, the id
 *    is not a uuid, or the adapter says the request is not authentic — one answer for all three.
 *    Rejections are counted (`accreditation_callback_rejected`); the first of each minute is a
 *    full security event.
 *  - **200 without any work** past the post-authentication budget (per connection, and a
 *    process-wide backstop): checked after authentication and before any write, keyed by the
 *    authenticated connection. Never 429 — a vendor that sees errors retries (Parallel: 3 times
 *    at 60 s) and may disable the endpoint; the reconciliation poller backstops the dropped wake-up.
 *  - **200 without any lookup** past the pre-auth ceiling, with the same `{"ok":true}` body a
 *    delivered callback gets; recently-authenticated ids bypass it (bounded LRU, failure
 *    sub-budget, answers held to a fixed floor while shedding — no body or timing oracle).
 *  - **500** when ingestion throws (so the vendor retries; ingestion is idempotent).
 *  - **200** `{"ok":true}` otherwise.
 *
 * Replay windows are the adapters' own (Parallel checks `Parallel-Timestamp`; VerifyInvestor sends
 * none).
 */
export const ACCREDITATION_CALLBACK_MAX_BYTES = 256 * 1024;
/** Authenticated callbacks one connection may spend per process per minute. */
export const ACCREDITATION_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE = 120;
/** Authenticated callbacks per process per minute, all connections together (the backstop). */
export const ACCREDITATION_CALLBACK_MAX_PER_MINUTE = 6_000;
/** Callbacks per process per minute that may reach the connection lookup (before authentication). */
export const ACCREDITATION_CALLBACK_MAX_PREAUTH_PER_MINUTE = 30_000;
/** Failed (forged) bypasses of the pre-auth ceiling one recently-authenticated id may cost per minute. */
export const ACCREDITATION_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE = 240;
/** While shedding, shed and failed-bypass answers are held until this long after arrival. */
export const ACCREDITATION_CALLBACK_SHED_FLOOR_MS = 50;
/** How long a successful authentication lets a connection id bypass the pre-auth ceiling. */
export const ACCREDITATION_CALLBACK_RECENT_AUTH_MS = 5 * 60_000;
/** How many recently-authenticated connection ids are remembered (least recently used evicted). */
export const ACCREDITATION_CALLBACK_RECENT_AUTH_MAX = 1_024;
export const ACCREDITATION_CALLBACK_PATH_PREFIX = "/webhooks/accreditation/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type AccreditationCallbackRouteOutcome =
  /** Unknown connection or not authentic: one answer. */
  | { readonly status: 401 }
  /** Authentic, but the budget said no before any write (the route still answers 200). */
  | { readonly status: 429; readonly driver: AccreditationVendorDriver }
  /** Authentic; recorded and published. */
  | { readonly status: 200; readonly driver: AccreditationVendorDriver };

/**
 * Authenticates and ingests one callback. `admit()` is called once, after authentication and
 * before any write: `false` means the budget is spent and nothing is recorded.
 */
export type AccreditationCallbackIngest = (
  connectionId: string,
  request: { readonly headers: Headers; readonly rawBody: Uint8Array },
  options: { readonly admit: () => boolean },
) => Promise<AccreditationCallbackRouteOutcome>;

export interface AccreditationCallbackOptions {
  /** Read per request (the container's service). */
  readonly ingest: () => AccreditationCallbackIngest;
  readonly log: Log;
  readonly budget?: AccreditationCallbackBudget | undefined;
}

/** The route's per-minute budgets (tests shrink them; production uses the defaults). */
export interface AccreditationCallbackBudget {
  readonly perConnectionPerMinute?: number | undefined;
  readonly perMinute?: number | undefined;
  readonly preAuthPerMinute?: number | undefined;
  readonly bypassFailuresPerMinute?: number | undefined;
  readonly shedFloorMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** `https://…/webhooks/accreditation/<connectionId>`: what an admin pastes into the vendor's settings. */
export function accreditationCallbackUrl(baseUrl: URL, connectionId: string): string {
  return `${canonicalBaseOf(baseUrl)}${ACCREDITATION_CALLBACK_PATH_PREFIX}${encodeURIComponent(connectionId)}`;
}

export function accreditationCallbackRoutes(options: AccreditationCallbackOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const budget = options.budget ?? {};
  const perConnection =
    budget.perConnectionPerMinute ?? ACCREDITATION_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE;
  const max = budget.perMinute ?? ACCREDITATION_CALLBACK_MAX_PER_MINUTE;
  const maxPreAuth = budget.preAuthPerMinute ?? ACCREDITATION_CALLBACK_MAX_PREAUTH_PER_MINUTE;
  const maxBypassFailures =
    budget.bypassFailuresPerMinute ?? ACCREDITATION_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE;
  const shedFloorMs = budget.shedFloorMs ?? ACCREDITATION_CALLBACK_SHED_FLOOR_MS;
  const clock = budget.now ?? Date.now;
  let window = Math.floor(clock() / 60_000);
  let preAuth = 0;
  let genuine = 0;
  let rejected = 0;
  let throttled = 0;
  let shed = 0;
  /**
   * Authenticated callbacks this minute per connection id. Only ids that authenticated get a key,
   * so the map is bounded by the live connections that called this minute, never by junk.
   */
  let byConnection = new Map<string, number>();
  /**
   * Bypasses of the pre-auth ceiling this minute per recently-authenticated id: `bypassed` counts
   * the ones that authenticated (charged after authentication), `bypassPending` the ones in flight
   * plus the ones that failed (the pre-auth sub-budget; a success is refunded). Both are keyed only
   * by ids in the recent-auth LRU, so bounded like it.
   */
  let bypassed = new Map<string, number>();
  let bypassPending = new Map<string, number>();
  /**
   * Connection id → when it last authenticated, in least-recently-used order (a Map iterates in
   * insertion order; a hit is re-inserted). Written only after a successful authentication.
   */
  const recentAuth = new Map<string, number>();
  const rememberAuth = (connectionId: string) => {
    recentAuth.delete(connectionId);
    recentAuth.set(connectionId, clock());
    while (recentAuth.size > ACCREDITATION_CALLBACK_RECENT_AUTH_MAX) {
      const oldest = recentAuth.keys().next().value;
      if (oldest === undefined) break;
      recentAuth.delete(oldest);
    }
  };
  /**
   * A recently-authenticated id may pass the ceiling while its AUTHENTICATED bypasses are under its
   * per-connection budget and its failed + in-flight ones under the failure sub-budget. Passing
   * reserves one failure slot; `settleBypass` refunds it (and charges the authenticated budget)
   * when the request authenticates.
   */
  const mayBypass = (connectionId: string): boolean => {
    const at = recentAuth.get(connectionId);
    if (at === undefined) return false;
    if (clock() - at > ACCREDITATION_CALLBACK_RECENT_AUTH_MS) {
      recentAuth.delete(connectionId);
      return false;
    }
    if ((bypassed.get(connectionId) ?? 0) >= perConnection) return false;
    const pending = (bypassPending.get(connectionId) ?? 0) + 1;
    if (pending > maxBypassFailures) return false;
    bypassPending.set(connectionId, pending);
    return true;
  };
  const settleBypass = (connectionId: string, authenticated: boolean, minute: number) => {
    // A reservation from a minute that has rolled since is gone with its map.
    if (!authenticated || minute !== window) return;
    const pending = bypassPending.get(connectionId) ?? 0;
    if (pending > 0) bypassPending.set(connectionId, pending - 1);
    bypassed.set(connectionId, (bypassed.get(connectionId) ?? 0) + 1);
  };
  /** Holds a shed / failed-bypass answer until the floor after the request arrived. */
  const floorFrom = async (startedAt: number) => {
    const wait = shedFloorMs - (performance.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  const roll = () => {
    const minute = Math.floor(clock() / 60_000);
    if (minute === window) return;
    if (rejected > 1 || throttled > 0 || shed > 0) {
      options.log("accreditation.callback_summary", {
        level: "warn",
        rejected,
        throttled,
        shed,
        connectionsThrottled: [...byConnection.values()].filter((n) => n > perConnection).length,
        window,
      });
    }
    window = minute;
    preAuth = 0;
    genuine = 0;
    rejected = 0;
    throttled = 0;
    shed = 0;
    byConnection = new Map();
    bypassed = new Map();
    bypassPending = new Map();
  };
  /** The post-authentication budget for one (authenticated) connection. */
  const admitFor = (connectionId: string): boolean => {
    roll();
    const spent = (byConnection.get(connectionId) ?? 0) + 1;
    byConnection.set(connectionId, spent);
    // A connection over its own budget spends nothing global: it cannot crowd out the others.
    if (spent > perConnection || genuine >= max) {
      throttled += 1;
      return false;
    }
    genuine += 1;
    return true;
  };

  app.post(
    `${ACCREDITATION_CALLBACK_PATH_PREFIX}:connectionId`,
    bodyLimit({
      maxSize: ACCREDITATION_CALLBACK_MAX_BYTES,
      onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
    }),
    async (c) => {
      const startedAt = performance.now();
      roll();
      const connectionId = c.req.param("connectionId").toLowerCase();
      const body = new Uint8Array(await c.req.arrayBuffer());
      let outcome: AccreditationCallbackRouteOutcome;
      const valid = UUID_RE.test(connectionId);
      // Past the pre-auth ceiling this minute: nothing may answer 401 to a uuid (no oracle).
      const shedding = valid && ++preAuth > maxPreAuth;
      if (!valid) {
        outcome = { status: 401 };
      } else if (shedding && !mayBypass(connectionId)) {
        // Shed before the lookup: 200 with one body for every id, nothing queued, and held to the
        // same floor as a failed bypass (no timing oracle).
        shed += 1;
        await floorFrom(startedAt);
        return c.json({ ok: true }, 200);
      } else {
        const minute = window;
        try {
          outcome = await options.ingest()(
            connectionId,
            { headers: c.req.raw.headers, rawBody: body },
            { admit: () => admitFor(connectionId) },
          );
        } catch (error) {
          // Not known to be authentic: the reservation stays spent.
          if (shedding) await floorFrom(startedAt);
          // Only the error's name: a message may quote the payload.
          options.log("accreditation.callback_ingest_failed", {
            level: "error",
            error: error instanceof Error ? error.name : "unknown",
          });
          return c.json({ error: { code: "internal_error" } }, 500);
        }
        if (outcome.status !== 401) rememberAuth(connectionId);
        if (shedding) settleBypass(connectionId, outcome.status !== 401, minute);
      }
      if (outcome.status === 401) {
        roll();
        rejected += 1;
        if (rejected === 1) {
          // The first of the minute is a full security event (counter + one log line); the rest
          // only count, and the minute's total is one summary line when it rolls.
          markSecurityEvent(c, {
            event: "accreditation_callback_rejected",
            code: "unauthenticated",
          });
        } else {
          countSecurityEvent("accreditation_callback_rejected", "unauthenticated");
        }
        // A bypassing id that failed while shedding looks exactly like a shed never-seen id.
        if (shedding) {
          await floorFrom(startedAt);
          return c.json({ ok: true }, 200);
        }
        return c.json({ error: { code: "unauthenticated" } }, 401);
      }
      // Over budget (429 from ingestion) is deliberately indistinguishable from a delivered
      // callback: 2xx keeps the vendor's retries quiet, and the poller backstops the wake-up.
      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
