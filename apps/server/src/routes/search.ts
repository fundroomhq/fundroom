import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  type OpenAPIHono,
  sessionSecurity,
  search as sr,
} from "@fundroom/contracts";
import { isDisabledForOffering, isHiddenFor } from "@fundroom/module-kit";
import { runSearch, SearchQueryError } from "@fundroom/search";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requireMember } from "../middleware/authz.js";
import { type ApiDeps, requestFactsOf } from "./deps.js";

/*
 * Workspace search (E2.8): `GET /api/v1/search` over `core.search_entry`
 * (authz-matrix.yaml "search (E2.8)"). Contracts: `@fundroom/contracts` `search.ts`; the index
 * and query engine: `@fundroom/search` (`runSearch`, whose header describes the steps).
 *
 * This file decides only *which* modules the caller may search and *as whom*:
 *  - modules: enabled for the workspace (enablement rows, `required`), not switched off by the
 *    offering status (`disabledWhen`, staff too), and — for anyone but staff — not hidden by it
 *    (`hiddenWhen`). The same three rules the bootstrap applies, so search never surfaces a module
 *    the portal does not show. Entries of other modules stay in the index (a re-enabled module
 *    needs no rebuild) and are filtered here.
 *  - as whom: the request's own tenant context. For an investor that is an `external` context,
 *    so RLS applies, and view-as is the investor's context with a READ ONLY transaction.
 *
 * Rate limit: 30 searches a minute per membership (`rateLimiter`, a Postgres counter keyed by
 * membership id — never the IP). Skipped under view-as: the view is read only and writes nothing,
 * not even a counter row, and it is already bounded by the 30-minute view window and the staff
 * member's `access.manage`.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 429, 500, 503);
const TAGS = ["search"];
export const SEARCH_RATE = { max: 30, windowMs: 60_000 } as const;

export function registerSearchRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  api.openapi(
    createRoute({
      method: "get",
      path: "/search",
      tags: TAGS,
      summary: "Search everything the caller can open in this workspace",
      description:
        "Full-text over titles and extracted text of documents, pages and updates, filtered to what the caller could open: an investor sees only entries their grants and groups admit, and a hit behind a gate (NDA, accreditation) is returned only when its title matched, with `gated: true` and no snippet. Modules switched off for the workspace, or hidden for the caller, contribute nothing. Ranked by relevance, then recency. 400 `search_query_invalid` when the query has no searchable word; 429 `rate_limited` above 30 searches a minute.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [requireMember({ gate })] as const,
      request: { query: sr.SearchQuery },
      responses: { 200: jsonResponse(sr.SearchResultsSchema, "Results"), ...ERRORS },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const membership = c.get("membership");
      const workspace = c.get("workspace");
      if (tenant === undefined || membership === undefined || workspace === undefined)
        throw new ApiError("not_found", "no such workspace for this account");
      const query = c.req.valid("query");

      if (tenant.viewAs === undefined) {
        const limit = await deps.rateLimiter.hit(`search:${membership.id}`, SEARCH_RATE);
        if (!limit.allowed)
          throw new ApiError("rate_limited", "too many searches; try again in a minute", {
            retryAfterMs: limit.retryAfterMs,
          });
      }

      // Read before the search transaction opens (never nested inside it).
      const { enabled } = await deps.enablement.get(deps.db, tenant);
      const status = workspace.offeringStatus;
      const isStaff = membership.kind === "staff";
      const modules = deps.registry.modules
        .filter(
          (m) =>
            enabled.has(m.id) &&
            !isDisabledForOffering(m, status) &&
            (isStaff || !isHiddenFor(m, status)),
        )
        .map((m) => m.id);
      const kinds =
        query.kinds === undefined
          ? undefined
          : [
              ...new Set(
                query.kinds
                  .split(",")
                  .map((k) => k.trim())
                  .filter((k) => k.length > 0),
              ),
            ];

      const authz = deps.authz;
      try {
        const results = await runSearch(
          {
            db: deps.db,
            check: (principal, resource, capability, facts) =>
              authz.check(principal, resource, capability, facts),
            facts: requestFactsOf(c, deps.trustProxy),
          },
          tenant,
          { q: query.q, limit: query.limit, offset: query.offset, kinds, modules },
        );
        return c.json(results, 200);
      } catch (error) {
        if (error instanceof SearchQueryError)
          throw new ApiError("search_query_invalid", error.message);
        throw error;
      }
    },
  );
}
