import type { PlanFeature } from "@fundroom/domain";
import type { EntitlementsPort } from "@fundroom/ports";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";

/*
 * Plan feature gates as route middleware (A-3, ADR-0063).
 *
 * For a kernel route whose every call turns a feature on (`PUT /sso/connection`, `POST /api-keys`,
 * …): 402 `plan_limit` `{ limit: "feature", feature }` when the workspace's plan does not include
 * it. A route that gates only a *transition* (a toggle going off→on, a PATCH that changes the URL)
 * calls `deps.entitlements.assertFeature` in its handler instead, where the old and new values are
 * known.
 *
 * Place it AFTER the route's permission guard in the middleware list. A 402 must never be an
 * oracle: anonymous callers, investors and staff without the permission keep getting exactly the
 * answer they got before plans existed (the authz sweep asserts the deny cells unchanged).
 *
 * No I/O: the plan's limits ride on the resolved workspace. `deps` is read when a request runs,
 * never when the route is registered (the OpenAPI build registers routes against a throwing stub).
 */
export function requireFeature(
  deps: { readonly entitlements: EntitlementsPort },
  feature: PlanFeature,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const workspace = c.get("workspace");
    // No resolved workspace is not this gate's question (the permission guard before it has
    // already answered for one).
    if (workspace !== undefined) {
      const entitlements = deps.entitlements;
      entitlements.assertFeature(entitlements.of(workspace), feature);
    }
    await next();
  };
}
