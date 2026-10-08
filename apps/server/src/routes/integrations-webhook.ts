import type { BookingWebhookOutcome } from "@fundroom/integrations";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { countSecurityEvent } from "../middleware/security-events.js";

/*
 * Booking webhooks (E3.6, ADR-0054): `POST /webhooks/integrations/{connectionId}` in the ops tree —
 * no tenant, no session, no CSRF (the classifier routes `/webhooks/integrations/<uuid>` without a
 * slug to `ops`). The caller is Calendly or Cal.com; the only credential is the signature the
 * connection's adapter verifies in constant time with our signing key (`booking.parseWebhook`).
 * The workspace comes from the connection row, never the host.
 *
 * Unlike an e-sign callback this is not a wake-up: a verified event is recorded
 * (`core.integration_booking`, deduplicated by the vendor's event id, a status only moving
 * forward) and `integration.booking_recorded` is published in the same transaction. The budgets
 * are the e-sign callback's (`./esign-callback.ts`, E3.5 R3C), for the same reasons:
 *
 *  - **413** past 256 KiB, before the adapter sees a byte.
 *  - **401** when the connection is unknown/deleted/not a booking provider, the id is not a uuid,
 *    or the signature is bad or stale (Calendly: 5-minute tolerance) — one answer for all, so the
 *    URL is no oracle for which connection ids exist. Counted as `integration_webhook_rejected`
 *    (the first of each minute also logs one `security.integration_webhook_rejected` line).
 *  - **200 without any work** past the post-authentication budget (per connection
 *    `INTEGRATION_WEBHOOK_MAX_PER_CONNECTION_PER_MINUTE`, process-wide
 *    `INTEGRATION_WEBHOOK_MAX_PER_MINUTE`) — checked after authentication, keyed by the
 *    authenticated connection; still 200 so the vendor does not disable the subscription.
 *  - **200 without any lookup** past a high process-wide ceiling of requests that have not
 *    authenticated yet; a connection id that authenticated in the last few minutes bypasses it
 *    (charged to a per-id failure sub-budget until it authenticates), and shed / failed-bypass
 *    answers are held to a fixed floor so neither body nor timing is an oracle.
 *  - **500** when ingestion throws (the vendor retries; ingestion is idempotent).
 *  - **200** otherwise, including an authentic event we could not use.
 */
export const INTEGRATION_WEBHOOK_MAX_BYTES = 256 * 1024;
export const INTEGRATION_WEBHOOK_MAX_PER_CONNECTION_PER_MINUTE = 120;
export const INTEGRATION_WEBHOOK_MAX_PER_MINUTE = 6_000;
export const INTEGRATION_WEBHOOK_MAX_PREAUTH_PER_MINUTE = 30_000;
export const INTEGRATION_WEBHOOK_MAX_BYPASS_FAILURES_PER_MINUTE = 240;
export const INTEGRATION_WEBHOOK_SHED_FLOOR_MS = 50;
export const INTEGRATION_WEBHOOK_RECENT_AUTH_MS = 5 * 60_000;
export const INTEGRATION_WEBHOOK_RECENT_AUTH_MAX = 1_024;
export const INTEGRATION_WEBHOOK_PATH_PREFIX = "/webhooks/integrations/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type IntegrationWebhookIngest = (
  connectionId: string,
  request: { readonly headers: Headers; readonly rawBody: Uint8Array },
  options: { readonly admit: () => boolean },
) => Promise<BookingWebhookOutcome>;

/** The route's per-minute budgets (tests shrink them; production uses the defaults). */
export interface IntegrationWebhookBudget {
  readonly perConnectionPerMinute?: number | undefined;
  readonly perMinute?: number | undefined;
  readonly preAuthPerMinute?: number | undefined;
  readonly bypassFailuresPerMinute?: number | undefined;
  readonly shedFloorMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface IntegrationWebhookOptions {
  /** Read per request (the container's service). */
  readonly ingest: () => IntegrationWebhookIngest;
  readonly log: Log;
  readonly budget?: IntegrationWebhookBudget | undefined;
}

export function integrationWebhookRoutes(options: IntegrationWebhookOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const budget = options.budget ?? {};
  const perConnection =
    budget.perConnectionPerMinute ?? INTEGRATION_WEBHOOK_MAX_PER_CONNECTION_PER_MINUTE;
  const max = budget.perMinute ?? INTEGRATION_WEBHOOK_MAX_PER_MINUTE;
  const maxPreAuth = budget.preAuthPerMinute ?? INTEGRATION_WEBHOOK_MAX_PREAUTH_PER_MINUTE;
  const maxBypassFailures =
    budget.bypassFailuresPerMinute ?? INTEGRATION_WEBHOOK_MAX_BYPASS_FAILURES_PER_MINUTE;
  const shedFloorMs = budget.shedFloorMs ?? INTEGRATION_WEBHOOK_SHED_FLOOR_MS;
  const clock = budget.now ?? Date.now;
  let window = Math.floor(clock() / 60_000);
  let preAuth = 0;
  let genuine = 0;
  let rejected = 0;
  let throttled = 0;
  let shed = 0;
  let byConnection = new Map<string, number>();
  let bypassed = new Map<string, number>();
  let bypassPending = new Map<string, number>();
  const recentAuth = new Map<string, number>();

  const rememberAuth = (connectionId: string) => {
    recentAuth.delete(connectionId);
    recentAuth.set(connectionId, clock());
    while (recentAuth.size > INTEGRATION_WEBHOOK_RECENT_AUTH_MAX) {
      const oldest = recentAuth.keys().next().value;
      if (oldest === undefined) break;
      recentAuth.delete(oldest);
    }
  };
  const mayBypass = (connectionId: string): boolean => {
    const at = recentAuth.get(connectionId);
    if (at === undefined) return false;
    if (clock() - at > INTEGRATION_WEBHOOK_RECENT_AUTH_MS) {
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
    if (!authenticated || minute !== window) return;
    const pending = bypassPending.get(connectionId) ?? 0;
    if (pending > 0) bypassPending.set(connectionId, pending - 1);
    bypassed.set(connectionId, (bypassed.get(connectionId) ?? 0) + 1);
  };
  const floorFrom = async (startedAt: number) => {
    const wait = shedFloorMs - (performance.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  const roll = () => {
    const minute = Math.floor(clock() / 60_000);
    if (minute === window) return;
    if (rejected > 1 || throttled > 0 || shed > 0) {
      options.log("integrations.webhook_summary", {
        level: "warn",
        rejected,
        throttled,
        shed,
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
  const admitFor = (connectionId: string): boolean => {
    roll();
    const spent = (byConnection.get(connectionId) ?? 0) + 1;
    byConnection.set(connectionId, spent);
    if (spent > perConnection || genuine >= max) {
      throttled += 1;
      return false;
    }
    genuine += 1;
    return true;
  };
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  app.post(
    `${INTEGRATION_WEBHOOK_PATH_PREFIX}:connectionId`,
    bodyLimit({
      maxSize: INTEGRATION_WEBHOOK_MAX_BYTES,
      onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
    }),
    async (c, next) => {
      if (c.get("classification")?.tree !== "ops") return next();
      const startedAt = performance.now();
      roll();
      const connectionId = c.req.param("connectionId").toLowerCase();
      const rawBody = new Uint8Array(await c.req.arrayBuffer());
      let outcome: BookingWebhookOutcome;
      const valid = UUID_RE.test(connectionId);
      const shedding = valid && ++preAuth > maxPreAuth;
      if (!valid) {
        outcome = "unauthorized";
      } else if (shedding && !mayBypass(connectionId)) {
        shed += 1;
        await floorFrom(startedAt);
        return ok();
      } else {
        const minute = window;
        try {
          outcome = await options.ingest()(
            connectionId,
            { headers: c.req.raw.headers, rawBody },
            { admit: () => admitFor(connectionId) },
          );
        } catch (error) {
          if (shedding) await floorFrom(startedAt);
          options.log("integrations.webhook_ingest_failed", {
            level: "error",
            error: error instanceof Error ? error.name : "unknown",
          });
          return c.json({ error: { code: "internal_error" } }, 500);
        }
        if (outcome !== "unauthorized") rememberAuth(connectionId);
        if (shedding) settleBypass(connectionId, outcome !== "unauthorized", minute);
      }
      if (outcome === "unauthorized") {
        roll();
        rejected += 1;
        countSecurityEvent("integration_webhook_rejected", "unauthenticated");
        if (rejected === 1) {
          // The first of the minute is one log line; the minute's total rolls into the summary.
          options.log("security.integration_webhook_rejected", {
            level: "warn",
            code: "unauthenticated",
          });
        }
        if (shedding) {
          await floorFrom(startedAt);
          return ok();
        }
        return c.json({ error: { code: "unauthenticated" } }, 401);
      }
      // Throttled is deliberately indistinguishable from a recorded delivery.
      return ok();
    },
  );

  return app;
}
