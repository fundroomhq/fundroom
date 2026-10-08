import type { ESignDriver } from "@fundroom/ports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { countSecurityEvent, markSecurityEvent } from "../middleware/security-events.js";
import { canonicalBaseOf } from "../path-mount.js";

/*
 * E-sign vendor callbacks (E3.5, ADR-0053): `POST /webhooks/esign/{connectionId}` in the ops tree —
 * no tenant, no session, no CSRF (the classifier routes `/webhooks/esign/<uuid>` to `ops`, which the
 * tenant and session middleware skip). The caller is the vendor; the only credential is the
 * signature/secret the connection's adapter verifies (`ESignPort.parseCallback`). The workspace
 * comes from the connection row, never from the host.
 *
 * **A callback is only a wake-up** (contract §0). Nothing in its body is trusted: after the adapter
 * authenticates it, the service looks up the envelope it names within that connection's workspace
 * and enqueues an idempotency-keyed status pull (`esign.sync`). A forged or replayed callback can at
 * most cause one extra pull, and a replay of a genuine one is exactly that.
 *
 *  - **413** past 256 KiB, before the adapter sees a byte.
 *  - **401** when the connection is unknown/deleted, the id is not a uuid, or the adapter says the
 *    request is not authentic — one answer for all three, so the URL is not an oracle for which
 *    connection ids exist. Rejections are counted (`fundroom.security.events{event=
 *    esign_callback_rejected}`); the first of each minute is marked as a security event (one
 *    `security.esign_callback_rejected` line) and the rest roll into one summary line per minute.
 *  - **200 without any work** past the post-authentication budget: each connection may spend
 *    `ESIGN_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE` a minute, and all connections together a much
 *    higher process-wide backstop (`ESIGN_CALLBACK_MAX_PER_MINUTE`). The budget is checked after
 *    authentication and before any envelope work (the E2.6 lesson: counting junk would let a flood
 *    of forged POSTs starve the genuine vendor), and it is keyed by the *authenticated* connection,
 *    so one tenant's vendor (or a tenant replaying its own genuine callbacks) cannot spend
 *    another's. Over budget the answer is still 200 — not 429 — because Dropbox Sign clears the
 *    account's callback URL after 10 consecutive non-2xx answers; the dropped wake-up costs
 *    nothing, since the `esign.sync-due` sweep pulls every open envelope on its own schedule.
 *    Only the process-wide backstop is global, never per IP: behind the shipped proxy the first
 *    `X-Forwarded-For` hop is attacker-supplied.
 *  - **200 without any lookup** past a (high) process-wide ceiling of callbacks that have not
 *    authenticated yet (`ESIGN_CALLBACK_MAX_PREAUTH_PER_MINUTE`): every request naming a uuid costs
 *    a connection lookup and, for a live id, a transaction and an unseal before the signature can
 *    be checked. Shedding answers 200 with the Dropbox Sign ack text — one body for every id, so
 *    it is no oracle, harmless to the other drivers, and never a non-2xx: a 401 here would let
 *    junk uuids from anyone switch off every tenant's callbacks (Dropbox Sign clears the URL after
 *    10 non-2xx). Nothing is queued; the `esign.sync-due` sweep backstops the wake-up. A connection
 *    id that **authenticated in the last few minutes** (a small bounded LRU, populated only after a
 *    successful authentication, so junk never enters it) bypasses the ceiling, so real tenants
 *    keep their wake-ups under a flood. A bypass is charged to the id's per-connection budget only
 *    once it has AUTHENTICATED (R3C): forged callbacks naming a recent id spend a separate per-id
 *    sub-budget of failed bypasses (`ESIGN_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE`, reserved on
 *    entry so a concurrent burst cannot overrun it, refunded on success), never the genuine
 *    vendor's share. That sub-budget is the only thing a forger can exhaust — no pre-auth check
 *    can tell a genuine callback from a forged one, so without it the ids an attacker knows would
 *    buy unbounded auth work — and exhausting it costs more forgeries a minute than the vendor's
 *    whole genuine budget; the `esign.sync-due` sweep backstops what it sheds.
 *    While shedding, a bypassing request that fails authentication is answered with the same ack,
 *    and every shed or failed-bypass answer is held until a fixed floor after the request arrived
 *    (`ESIGN_CALLBACK_SHED_FLOOR_MS`, R3C), so neither the body nor the timing tells a
 *    recently-live id (lookup + transaction + unseal + signature check) from a never-seen one (no
 *    lookup). The floor is a timer, not work, so shedding stays cheap; a callback that
 *    authenticates is never held (only the genuine vendor can produce one, so its timing is no
 *    oracle to a forger).
 *  - **500** when ingestion throws (so the vendor retries; ingestion is idempotent).
 *  - **200** otherwise — including an envelope we do not know (no oracle). Dropbox Sign treats a
 *    callback as delivered only when the body contains `Hello API Event Received`, and clears the
 *    account's callback URL after 10 consecutive failures, so for that driver the body is the ack.
 *
 * No tighter timestamp window is applied here: each adapter owns its own (contract Corrections:
 * Dropbox Sign −72 h/+5 min, Documenso ±5 min, DocuSeal and DocuSign none).
 */
export const ESIGN_CALLBACK_MAX_BYTES = 256 * 1024;
/** Authenticated callbacks one connection may spend per process per minute. */
export const ESIGN_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE = 120;
/** Authenticated callbacks per process per minute, all connections together (the backstop). */
export const ESIGN_CALLBACK_MAX_PER_MINUTE = 6_000;
/** Callbacks per process per minute that may reach the connection lookup (before authentication). */
export const ESIGN_CALLBACK_MAX_PREAUTH_PER_MINUTE = 30_000;
/**
 * Failed (forged) bypasses of the pre-auth ceiling one recently-authenticated id may cost per
 * process per minute — separate from, and larger than, its authenticated budget (R3C).
 */
export const ESIGN_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE = 240;
/**
 * While shedding, a shed answer and a failed bypass are both held until this long after the request
 * arrived, so their timing is no oracle for which ids authenticated recently (R3C). A failed
 * authentication (one host lookup, one tenant transaction, an unseal, a signature check) takes a
 * few milliseconds; the floor leaves an order of magnitude of headroom for a loaded database.
 */
export const ESIGN_CALLBACK_SHED_FLOOR_MS = 50;
/** How long a successful authentication lets a connection id bypass the pre-auth ceiling. */
export const ESIGN_CALLBACK_RECENT_AUTH_MS = 5 * 60_000;
/** How many recently-authenticated connection ids are remembered (least recently used evicted). */
export const ESIGN_CALLBACK_RECENT_AUTH_MAX = 1_024;
export const ESIGN_CALLBACK_PATH_PREFIX = "/webhooks/esign/";
/** What Dropbox Sign needs to see in the body of a callback answer. */
export const DROPBOX_SIGN_ACK = "Hello API Event Received";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ESignCallbackOutcome =
  /** Unknown connection or not authentic: one answer. */
  | { readonly status: 401 }
  /** Authentic, but the budget said no before any envelope work (the route still answers 200). */
  | { readonly status: 429; readonly driver: ESignDriver }
  /** Authentic; an envelope it named (if any we know) has a sync queued. */
  | { readonly status: 200; readonly driver: ESignDriver };

/**
 * Authenticates and ingests one callback. `admit()` is called once, after authentication and
 * before any envelope lookup: `false` means the budget is spent and nothing is enqueued.
 */
export type ESignCallbackIngest = (
  connectionId: string,
  request: { readonly headers: Headers; readonly body: Uint8Array },
  options: { readonly admit: () => boolean },
) => Promise<ESignCallbackOutcome>;

export interface ESignCallbackOptions {
  /** Read per request (the container's service). */
  readonly ingest: () => ESignCallbackIngest;
  readonly log: Log;
  readonly budget?: ESignCallbackBudget | undefined;
}

/** The route's per-minute budgets (tests shrink them; production uses the defaults). */
export interface ESignCallbackBudget {
  /** Authenticated callbacks per connection (default `ESIGN_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE`). */
  readonly perConnectionPerMinute?: number | undefined;
  /** Authenticated callbacks, all connections (default `ESIGN_CALLBACK_MAX_PER_MINUTE`). */
  readonly perMinute?: number | undefined;
  /** Requests reaching the lookup before authentication (default `ESIGN_CALLBACK_MAX_PREAUTH_PER_MINUTE`). */
  readonly preAuthPerMinute?: number | undefined;
  /** Failed bypasses per recent id (default `ESIGN_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE`). */
  readonly bypassFailuresPerMinute?: number | undefined;
  /** While shedding, the floor for shed / failed-bypass answers (default `ESIGN_CALLBACK_SHED_FLOOR_MS`). */
  readonly shedFloorMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** `https://…/webhooks/esign/<connectionId>`: what an admin pastes into the vendor's settings. */
export function esignCallbackUrl(baseUrl: URL, connectionId: string): string {
  return `${canonicalBaseOf(baseUrl)}${ESIGN_CALLBACK_PATH_PREFIX}${encodeURIComponent(connectionId)}`;
}

export function esignCallbackRoutes(options: ESignCallbackOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const budget = options.budget ?? {};
  const perConnection =
    budget.perConnectionPerMinute ?? ESIGN_CALLBACK_MAX_PER_CONNECTION_PER_MINUTE;
  const max = budget.perMinute ?? ESIGN_CALLBACK_MAX_PER_MINUTE;
  const maxPreAuth = budget.preAuthPerMinute ?? ESIGN_CALLBACK_MAX_PREAUTH_PER_MINUTE;
  const maxBypassFailures =
    budget.bypassFailuresPerMinute ?? ESIGN_CALLBACK_MAX_BYPASS_FAILURES_PER_MINUTE;
  const shedFloorMs = budget.shedFloorMs ?? ESIGN_CALLBACK_SHED_FLOOR_MS;
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
    while (recentAuth.size > ESIGN_CALLBACK_RECENT_AUTH_MAX) {
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
    if (clock() - at > ESIGN_CALLBACK_RECENT_AUTH_MS) {
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
      options.log("esign.callback_summary", {
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
    `${ESIGN_CALLBACK_PATH_PREFIX}:connectionId`,
    bodyLimit({
      maxSize: ESIGN_CALLBACK_MAX_BYTES,
      onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
    }),
    async (c) => {
      const startedAt = performance.now();
      roll();
      const connectionId = c.req.param("connectionId").toLowerCase();
      const body = new Uint8Array(await c.req.arrayBuffer());
      let outcome: ESignCallbackOutcome;
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
        return c.text(DROPBOX_SIGN_ACK, 200);
      } else {
        const minute = window;
        try {
          outcome = await options.ingest()(
            connectionId,
            { headers: c.req.raw.headers, body },
            { admit: () => admitFor(connectionId) },
          );
        } catch (error) {
          // Not known to be authentic: the reservation stays spent.
          if (shedding) await floorFrom(startedAt);
          // Only the error's name: a message may quote the payload.
          options.log("esign.callback_ingest_failed", {
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
            event: "esign_callback_rejected",
            code: "unauthenticated",
          });
        } else {
          countSecurityEvent("esign_callback_rejected", "unauthenticated");
        }
        // A bypassing id that failed while shedding looks exactly like a shed never-seen id.
        if (shedding) {
          await floorFrom(startedAt);
          return c.text(DROPBOX_SIGN_ACK, 200);
        }
        return c.json({ error: { code: "unauthenticated" } }, 401);
      }
      // Over budget (429 from ingestion) is deliberately indistinguishable from a delivered
      // callback: 2xx keeps the vendor's URL alive, and the sweep backstops the dropped wake-up.
      if (outcome.driver === "dropbox-sign") {
        return c.text(DROPBOX_SIGN_ACK, 200);
      }
      return c.json({ ok: true }, 200);
    },
  );

  return app;
}
