import type { AuditRecorder } from "@fundroom/audit";
import { createConsentService } from "@fundroom/compliance";
import { requestIdOf } from "@fundroom/contracts";
import { type Database, systemContext } from "@fundroom/db";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";

/*
 * Global Privacy Control made durable (E2.6).
 *
 * `Sec-GPC: 1` is a header, and a header only reaches code that has a browser in front of it.
 * Most of what `LegalServices.allowsPurpose` judges does not: an ESP open webhook arriving hours
 * after the send, the hot-list rollup, a notification fan-out. So when a signed-in member's
 * request carries the signal, this middleware records it as a stored refusal
 * (`core.consent_event`, `source: "gpc"`) for **both** optional purposes, and every later
 * `allowsPurpose` without signals reads `false` from the stored answer — in every consent mode.
 *
 * Recorded once: `recordGpcRefusal` writes only for a purpose whose newest answer is not already
 * a GPC refusal. A later explicit grant made from a browser *without* GPC is a newer fact and wins
 * (the person changed their mind somewhere GPC is off); the next GPC request after it records a
 * newer refusal again.
 *
 * Cheap: a request without the header costs nothing, and a GPC request costs one transaction the
 * first time per member per process and TTL, and nothing after — the positive answer ("both
 * purposes are already GPC-refused") is cached in-process. `forgetGpcRefusal` drops the entry
 * when this process records a consent answer; another process's cache may keep the stale entry
 * for at most `GPC_CACHE_TTL_MS`, after which the next GPC request re-checks.
 *
 * A failure is logged and swallowed: the request itself is not about consent, and failing it
 * would punish the person for sending the signal. Nothing is cached on failure, so the next GPC
 * request retries.
 */

export const GPC_CACHE_TTL_MS = 10 * 60_000;
const GPC_CACHE_MAX = 10_000;

/** `${workspaceId}:${membershipId}` → expiry (epoch ms). Insertion order doubles as LRU-ish. */
const settled = new Map<string, number>();
/** Concurrent GPC requests from one member share one check, so they cannot both append. */
const inFlight = new Map<string, Promise<void>>();

const keyOf = (workspaceId: string, membershipId: string) => `${workspaceId}:${membershipId}`;

/** Drops the cached "already refused" fact after this process records a consent answer. */
export function forgetGpcRefusal(workspaceId: string, membershipId: string): void {
  settled.delete(keyOf(workspaceId, membershipId));
}

/** Test seam: empties the per-process cache. */
export function resetGpcRefusalCache(): void {
  settled.clear();
  inFlight.clear();
}

export interface GpcMiddlewareOptions {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly now?: () => number;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export function gpcConsent(options: GpcMiddlewareOptions): MiddlewareHandler<AppEnv> {
  const now = options.now ?? Date.now;
  const consent = createConsentService({ db: options.db, audit: options.audit });

  async function settle(workspaceId: string, membershipId: string, actor: Actor): Promise<void> {
    const ctx = systemContext(workspaceId);
    await options.db.withTenant(ctx, (tx) =>
      consent.recordGpcRefusal(ctx, tx, membershipId, actor),
    );
    const key = keyOf(workspaceId, membershipId);
    settled.delete(key);
    settled.set(key, now() + GPC_CACHE_TTL_MS);
    if (settled.size > GPC_CACHE_MAX) {
      const oldest = settled.keys().next().value;
      if (oldest !== undefined) settled.delete(oldest);
    }
  }

  return async (c, next) => {
    // View as investor (E2.7): the signal is the *staff member's* browser speaking, and it must
    // never be recorded as the investor's refusal.
    if (c.req.header("sec-gpc") === "1" && c.get("viewAs") === undefined) {
      const tenant = c.get("tenant");
      const session = c.get("session");
      const membershipId = tenant?.membershipId;
      if (tenant !== undefined && membershipId !== undefined) {
        const key = keyOf(tenant.workspaceId, membershipId);
        const expiry = settled.get(key);
        if (expiry === undefined || expiry <= now()) {
          let pending = inFlight.get(key);
          if (pending === undefined) {
            pending = settle(tenant.workspaceId, membershipId, {
              membershipId,
              ...(session === undefined
                ? {}
                : { userId: session.userId, sessionId: session.sessionId }),
              requestId: requestIdOf(c),
            }).finally(() => inFlight.delete(key));
            inFlight.set(key, pending);
          }
          try {
            await pending;
          } catch (error) {
            options.log?.("gpc.record_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    await next();
  };
}

interface Actor {
  readonly membershipId: string;
  readonly userId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
}
