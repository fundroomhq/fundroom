import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

/*
 * CORS for `/api/v1` (§10 "API": exact-match allow-list per workspace). The canonical origin and
 * `CORS_ALLOWED_ORIGINS` are always allowed, and `workspaceOrigins` adds a workspace's verified
 * custom domain (E2.1 decision 5) — the portal's own address, whose pages must be able to call
 * the API. Same-origin requests carry no `Origin` header worth matching, so they are unaffected.
 * Credentials are allowed because the session is a cookie; that is exactly why the list is
 * exact-match and never `*`.
 *
 * **Embed host origins are NOT added here, and must never be** (E2.2 decision 5; this corrects
 * an earlier comment that invited it). The embedded portal is an iframe served from *our* origin,
 * so its `fetch` to `/api/v1` is same-origin and needs no CORS entry at all. Allow-listing the
 * host page's origin would grant credentialed, state-changing API access to every script on that
 * page — a tag manager, a marketing snippet, a compromised plugin — which is precisely the
 * host-XSS-forges-API-calls threat the iframe boundary exists to prevent (design/08 §6). The same
 * reasoning keeps them out of the CSRF allow-list: `selfOrigin` is derived per request from the
 * Host header, and a host page is not it.
 */
export interface CorsOptions {
  readonly staticOrigins: readonly string[];
  readonly workspaceOrigins?: ((c: Context) => readonly string[]) | undefined;
}

export const CORS_ALLOWED_HEADERS = ["Content-Type", "X-Request-Id", "Idempotency-Key"];
export const CORS_EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "Deprecation", "Sunset"];

export function normalizeOrigin(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function apiCors(options: CorsOptions): MiddlewareHandler {
  const fixed = new Set(
    options.staticOrigins.map(normalizeOrigin).filter((o): o is string => o !== undefined),
  );
  return cors({
    origin: (origin, c) => {
      const o = normalizeOrigin(origin);
      if (o === undefined) return null;
      if (fixed.has(o)) return origin;
      const extra = options.workspaceOrigins?.(c) ?? [];
      return extra.some((e) => normalizeOrigin(e) === o) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: CORS_ALLOWED_HEADERS,
    exposeHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 600,
  });
}
