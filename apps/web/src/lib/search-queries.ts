import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Workspace search (E2.8): `GET /search`. The server filters every hit through the caller's
 * access (RLS, grants, gates), so what comes back is exactly what this member may know exists.
 * Snippets arrive as plain-text segments with a `highlight` flag — never HTML — and are rendered
 * as React text with `<mark>` around the matched parts.
 */
export type SearchHit = FundRoomSchemas["SearchHit"];
export type SearchResults = FundRoomSchemas["SearchResults"];

export const SEARCH_PAGE_SIZE = 20;
/** The server refuses offsets past 500; "Load more" stops there. */
export const SEARCH_MAX_OFFSET = 500;
export const SEARCH_MAX_QUERY = 200;

export function searchQuery(q: string, limit = SEARCH_PAGE_SIZE) {
  return infiniteQueryOptions({
    queryKey: ["search", q, limit],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      call(api().GET("/search", { params: { query: { q, limit, offset: pageParam } } })),
    getNextPageParam: (last: SearchResults, pages: SearchResults[]) => {
      if (!last.hasMore) return undefined;
      const next = pages.reduce((n, p) => n + p.hits.length, 0);
      return next > SEARCH_MAX_OFFSET ? undefined : next;
    },
    enabled: q.trim() !== "",
    staleTime: 15_000,
  });
}
