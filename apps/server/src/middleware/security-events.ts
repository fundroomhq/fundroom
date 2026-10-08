import type { SecurityEventMark } from "@fundroom/identity/http";
import { type Counter, metrics } from "@opentelemetry/api";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { routeLabel } from "../telemetry.js";

/*
 * Security events for refused requests (E2.10 F-29, ASVS 16.3.2 / 16.3.3).
 *
 * An authorization denial (403 `forbidden`, or the 404 the authz middleware answers so as not to
 * confirm that something exists) and a CSRF rejection used to reach only the access line, at the
 * same `warn` as a typo'd URL. Each one now also produces:
 *
 *  - a structured log event, `security.authz_denied` / `security.csrf_rejected`, carrying the
 *    request id, route template, method, status, error code, the missing permission, the reason,
 *    and the session / workspace / actor kind ids — never an address, IP, user agent, query
 *    string or raw path (the same rules as the access log, design/07 §5);
 *  - one increment of `fundroom.security.events{event, code, reason}` — every label bounded.
 *
 * Not an audit row: denials are cheap for a client to produce, and the audit chain is
 * append-only and hash-linked, so a flood of them would be a storage attack on it. For the same
 * reason the log line is capped at `SECURITY_EVENT_LOG_MAX_PER_MINUTE` for the whole process (the
 * counter never is); the first line after a capped minute carries `suppressed: n`. Never a
 * per-client budget: that would be keyed on a header the client writes (E2.1 lesson).
 *
 * Who marks what: identity's CSRF middleware sets `c.var.securityEvent` itself; the API error
 * handler marks every `forbidden` and each `not_found` created through `authzNotFound`. The
 * request log (`request-log.ts`) is what emits, once per request, because it wraps every tree.
 */
export const SECURITY_EVENT_LOG_MAX_PER_MINUTE = 120;

const authzDenials = new WeakSet<object>();

/** The 404 an authorization check answers (it hides whether the thing exists): marked for F-29. */
export function markAuthzDenial<T extends object>(error: T): T {
  authzDenials.add(error);
  return error;
}

export function isAuthzDenial(error: unknown): boolean {
  return typeof error === "object" && error !== null && authzDenials.has(error);
}

/** Records the mark for a refused request, unless one is already there (the first cause wins). */
export function markSecurityEvent(c: Context, mark: SecurityEventMark): void {
  const ctx = c as unknown as Context<AppEnv>;
  if (ctx.get("securityEvent") === undefined) ctx.set("securityEvent", mark);
}

let counter: Counter | undefined;
function securityCounter(): Counter {
  counter ??= metrics.getMeter("fundroom.security").createCounter("fundroom.security.events", {
    description:
      "Security events: requests refused for a security reason (authorization denial, CSRF " +
      "rejection) and security controls that could not run (breached-password check skipped)",
  });
  return counter;
}

/** Keeps labels bounded whatever a caller sets: short snake/kebab tokens only. */
function label(value: string | undefined): string {
  if (value === undefined) return "none";
  return /^[a-z][a-z0-9_.-]{0,47}$/u.test(value) ? value : "other";
}

/**
 * One increment of `fundroom.security.events` for an event that is not tied to a refused
 * request's mark — a package the server wires with a callback (identity knows nothing of the
 * server's telemetry). E3.2 F-21: `breach_check_unavailable`, reason = the fail mode, counted
 * whether the password was accepted unchecked (`open`) or refused (`closed`).
 */
export function countSecurityEvent(event: string, code: string, reason?: string): void {
  securityCounter().add(1, { event: label(event), code: label(code), reason: label(reason) });
}

export interface SecurityEventEmitter {
  emit(c: Context<AppEnv>): void;
}

export function createSecurityEvents(
  log: Log,
  options: { readonly basePath?: string | undefined; readonly now?: () => number } = {},
): SecurityEventEmitter {
  const now = options.now ?? Date.now;
  let minute = -1;
  let logged = 0;
  let suppressed = 0;
  return {
    emit(c) {
      const mark = c.get("securityEvent");
      if (mark === undefined) return;
      securityCounter().add(1, {
        event: mark.event,
        code: label(mark.code),
        reason: label(mark.reason),
      });
      const m = Math.floor(now() / 60_000);
      if (m !== minute) {
        minute = m;
        logged = 0;
      }
      if (logged >= SECURITY_EVENT_LOG_MAX_PER_MINUTE) {
        suppressed += 1;
        return;
      }
      logged += 1;
      const apiKey = c.get("apiKey");
      const keyPrefix = mark.keyPrefix ?? apiKey?.prefix;
      const carried = suppressed;
      suppressed = 0;
      log(`security.${mark.event}`, {
        level: "warn",
        requestId: c.get("requestId"),
        method: c.req.method,
        route: routeLabel(c.req.routePath, options.basePath),
        status: c.res.status,
        // Not `code`: the logger redacts that key everywhere (sign-in codes).
        errorCode: mark.code,
        ...(mark.reason === undefined ? {} : { reason: mark.reason }),
        ...(mark.permission === undefined ? {} : { permission: mark.permission }),
        // E3.4: a key request (any refusal, 403 scope_missing included) names the key — its
        // display prefix and id, never the token.
        ...(keyPrefix === undefined ? {} : { keyPrefix }),
        ...(apiKey === undefined ? {} : { apiKeyId: apiKey.id }),
        sessionId: c.get("session")?.sessionId,
        workspaceId: c.get("workspace")?.id,
        actorKind: c.get("tenant")?.actorKind,
        ...(carried > 0 ? { suppressed: carried } : {}),
      });
    },
  };
}
