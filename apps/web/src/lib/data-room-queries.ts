import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/* Investor-side queries for the data room (E1.3). The admin screens keep theirs in queries.ts. */
export type DataRoomTree = FundRoomSchemas["DataRoomTree"];
export type DataRoomTreeFolder = FundRoomSchemas["DataRoomTreeFolder"];
export type DataRoomTreeDocument = FundRoomSchemas["DataRoomTreeDocument"];
export type DataRoomDocumentDetail = FundRoomSchemas["DataRoomDocumentDetail"];
export type DataRoomSearchHit = FundRoomSchemas["DataRoomSearchHit"];
export type DataRoomPageText = FundRoomSchemas["DataRoomPageText"];

export const dataRoomTreeQuery = queryOptions({
  queryKey: ["data-room", "tree"],
  queryFn: () => call(api().GET("/data-room/tree")),
});

export function dataRoomDocumentQuery(id: string) {
  return queryOptions({
    queryKey: ["data-room", "document", id],
    queryFn: () => call(api().GET("/data-room/documents/{id}", { params: { path: { id } } })),
  });
}

export function dataRoomSearchQuery(id: string, q: string) {
  return queryOptions({
    queryKey: ["data-room", "document", id, "search", q],
    queryFn: () =>
      call(
        api().GET("/data-room/documents/{id}/search", {
          params: { path: { id }, query: { q } },
        }),
      ),
    enabled: q.trim().length > 0,
  });
}

/**
 * The extracted text of one page (E2.8), rendered as a visually hidden text layer inside the
 * viewer's page figure for screen readers. Keyed by version: a new upload has new text. No
 * retries: a 403/404/409 (gated, missing, not viewable) is an answer, and the viewer falls back
 * to "no text layer" instead of hammering the route.
 */
export function dataRoomPageTextQuery(id: string, versionId: string, n: number) {
  return queryOptions({
    queryKey: ["data-room", "document", id, "page-text", versionId, n],
    queryFn: () =>
      call(
        api().GET("/data-room/documents/{id}/pages/{n}/text", {
          params: { path: { id, n } },
        }),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Absolute URL of a byte-serving endpoint (thumbnail, page, download). */
export function dataRoomFileUrl(apiBase: string, documentId: string, suffix: string): string {
  return `${apiBase}/api/v1/data-room/documents/${documentId}/${suffix}`;
}
