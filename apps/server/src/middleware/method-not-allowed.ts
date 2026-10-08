import { ApiError, errorResponse } from "@fundroom/contracts";
import type { MiddlewareHandler } from "hono";
import { TrieRouter } from "hono/router/trie-router";

/*
 * 405 for a known API path asked for with a method it does not serve (RFC 9110 §15.5.6), with
 * the `Allow` header listing the ones it does. Without this, `GET` on a POST-only route fell
 * through to the "unknown API version" 404, or — under a module prefix — to whatever that
 * prefix's middleware answers first (`setup_required`, `module_disabled`), none of which tells
 * the caller what is actually wrong.
 *
 * Runs ahead of the module mounts' own middleware, and only decides when the path is known and
 * the method is not: a matched request, an unknown path and any `OPTIONS` (a CORS preflight is
 * not a method mismatch) pass through untouched.
 */

interface RouteLike {
  readonly method: string;
  readonly path: string;
}

const ALL = "ALL";

/** `HEAD` is served by every `GET` route (Hono dispatches it there). */
function effective(method: string): string {
  return method === "HEAD" ? "GET" : method;
}

/**
 * Hono lists `use()` middleware as an `ALL` route on a wildcard path, indistinguishable from an
 * `all()` handler; it serves nothing by itself, so a caller drops those it knows to be guards.
 */
export function isWildcardMiddleware(route: RouteLike): boolean {
  return route.method === ALL && route.path.endsWith("*");
}

export function methodNotAllowed(options: {
  /**
   * Every route that serves a request under the API prefix (an `ALL` one serves any method). Read
   * once, on the first request, when all are registered.
   */
  readonly routes: () => readonly RouteLike[];
  /** The API path as the API app sees it (`/auth/logout`), or `undefined` when not an API path. */
  readonly apiPath: (path: string) => string | undefined;
}): MiddlewareHandler {
  let index:
    | { readonly router: TrieRouter<number>; readonly methods: readonly string[] }
    | undefined;

  function build(): NonNullable<typeof index> {
    const router = new TrieRouter<number>();
    const methods = new Set<string>();
    for (const route of options.routes()) {
      // The handler is the route's specificity: how many segments are parameters or wildcards.
      router.add(route.method, route.path, (route.path.match(/[:*]/gu) ?? []).length);
      if (route.method !== ALL) methods.add(route.method);
    }
    return { router, methods: [...methods].sort() };
  }

  /** The most specific route serving `method` on `path`, or Infinity when none does. */
  function best(router: TrieRouter<number>, method: string, path: string): number {
    const found = router.match(method, path)[0];
    return found.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...found.map(([s]) => s));
  }

  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const path = options.apiPath(c.req.path);
    if (path === undefined) return next();
    index ??= build();
    const { router, methods } = index;
    const mine = best(router, effective(c.req.method), path);
    const others = methods.map((m) => [m, best(router, m, path)] as const);
    const top = Math.min(mine, ...others.map(([, s]) => s));
    /*
     * The request's method is served by the most specific route for this path: not ours to
     * decide. A *less* specific match does not count — `GET /metrics/import/dry-run` is not
     * `GET /metrics/import/{id}` with id "dry-run" when `/metrics/import/dry-run` is a resource
     * of its own (OpenAPI: concrete paths match before templated ones).
     */
    if (top === Number.POSITIVE_INFINITY || mine === top) return next();
    const allowed = others.filter(([, s]) => s === top).map(([m]) => m);
    if (allowed.includes("GET")) allowed.push("HEAD");
    return errorResponse(
      c,
      new ApiError(
        "method_not_allowed",
        `${c.req.method} is not allowed here; use ${allowed.join(", ")}`,
        {},
        { headers: { Allow: allowed.join(", ") } },
      ),
    );
  };
}
