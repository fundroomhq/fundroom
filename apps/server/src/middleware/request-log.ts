import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { routeLabel } from "../telemetry.js";
import { createSecurityEvents } from "./security-events.js";

/** Segments after these carry a bearer secret in the SPA's own routes (`/s/<token>`, `/invite/<token>`). */
const TOKEN_PARENTS: ReadonlySet<string> = new Set([
  "s",
  "invite",
  "invites",
  "links",
  "token",
  "chart",
]);
/** A uuid, a long hex/base64url token, a number, or anything with an `@`. */
const IDENTIFIER_SEGMENT_RE = /^(?:[0-9a-f-]{16,}|[A-Za-z0-9_-]{20,}|\d+|.*@.*)$/iu;
const MAX_SEGMENTS = 8;

/**
 * The request path with every secret-bearing or identifier-shaped segment replaced (E2.10 F-01):
 * the segment after `s`/`invite`/`chart` (among others) becomes `:token` whatever it looks like, and anything shaped
 * like a token, uuid, number or address becomes `:id`. At most eight segments, 64 chars each.
 */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/").slice(1);
  const out: string[] = [];
  for (const [i, segment] of segments.slice(0, MAX_SEGMENTS).entries()) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep the raw segment for the checks below
    }
    const parent = i > 0 ? segments[i - 1] : undefined;
    if (parent !== undefined && TOKEN_PARENTS.has(parent) && segment !== "") out.push(":token");
    else if (IDENTIFIER_SEGMENT_RE.test(decoded)) out.push(":id");
    else out.push(segment.slice(0, 64));
  }
  return `/${out.join("/")}${segments.length > MAX_SEGMENTS ? "/…" : ""}`;
}

export interface RequestLogOptions {
  /** BASE_PATH, so `<BASE_PATH>/*` is recognised as the SPA catch-all. */
  readonly basePath?: string | undefined;
}

/**
 * One access line per request. Attributes are ids and templates only (design/07 §5):
 * request id, route template, status, duration, workspace id, actor kind. No IPs (the
 * audit log keeps truncated ones), no query strings, no user agents.
 *
 * The SPA catch-all has no template worth the name, so its lines add `path`, redacted by
 * `redactPath` — never the raw path, which carries share-link and invite tokens (F-01).
 */
export function requestLog(log: Log, options: RequestLogOptions = {}): MiddlewareHandler<AppEnv> {
  // F-29: a refused request marked by the CSRF check or the API error handler gets its own
  // `security.*` event after the access line (see `./security-events.ts`).
  const security = createSecurityEvents(log, { basePath: options.basePath });
  return async (c, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      const status = c.res.status;
      const tenant = c.get("tenant");
      const route = routeLabel(c.req.routePath, options.basePath);
      log("http.request", {
        level:
          status >= 500
            ? "error"
            : status >= 400
              ? "warn"
              : c.get("classification")?.tree === "ops"
                ? "debug"
                : "info",
        requestId: c.get("requestId"),
        method: c.req.method,
        route,
        ...(route === c.req.routePath ? {} : { path: redactPath(c.req.path) }),
        status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        tree: c.get("classification")?.tree,
        workspaceId: c.get("workspace")?.id,
        actorKind: tenant?.actorKind,
        sessionId: c.get("session")?.sessionId,
      });
      security.emit(c);
    }
  };
}
