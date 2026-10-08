import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import * as m from "../paraglide/messages.js";
import { api, call } from "./api.js";
import { dataRoomTreeQuery } from "./data-room-queries.js";

/*
 * Queries for the analytics module (E1.5): the staff "Engagement" screens (overview, who
 * viewed, per-page dwell, per-contact timeline, settings) and the member-facing transparency
 * notice the portal shows investors.
 */
export type AnalyticsMode = FundRoomSchemas["AnalyticsSettings"]["mode"];
export type AnalyticsOverview = FundRoomSchemas["AnalyticsOverview"];
export type AnalyticsTopResource = FundRoomSchemas["AnalyticsTopResource"];
export type AnalyticsRecentEvent = FundRoomSchemas["AnalyticsRecentEvent"];
export type AnalyticsViewer = FundRoomSchemas["AnalyticsViewer"];
export type AnalyticsViewerList = FundRoomSchemas["AnalyticsViewerList"];
export type AnalyticsPageDwell = FundRoomSchemas["AnalyticsPageDwell"];
export type AnalyticsTimeline = FundRoomSchemas["AnalyticsTimeline"];
export type AnalyticsTimelineItem = FundRoomSchemas["AnalyticsTimelineItem"];
export type AnalyticsSettings = FundRoomSchemas["AnalyticsSettings"];
export type AnalyticsNotice = FundRoomSchemas["AnalyticsNotice"];
export type AnalyticsHeatmap = FundRoomSchemas["AnalyticsHeatmap"];
export type AnalyticsHeatmapPage = FundRoomSchemas["AnalyticsHeatmapPage"];
export type AnalyticsHotList = FundRoomSchemas["AnalyticsHotList"];
export type AnalyticsHotListEntry = FundRoomSchemas["AnalyticsHotListEntry"];
export type AnalyticsEmailEngagement = FundRoomSchemas["AnalyticsEmailEngagement"];
export type AnalyticsResourceKind = "document" | "post";

export function analyticsOverviewQuery(days: number) {
  return queryOptions({
    queryKey: ["analytics", "overview", days],
    queryFn: () => call(api().GET("/analytics/overview", { params: { query: { days } } })),
  });
}

export function analyticsViewersQuery(kind: AnalyticsResourceKind, id: string) {
  return queryOptions({
    queryKey: ["analytics", "viewers", kind, id],
    queryFn: () =>
      call(api().GET("/analytics/{kind}/{id}/viewers", { params: { path: { kind, id } } })),
  });
}

export function analyticsPageDwellQuery(
  kind: AnalyticsResourceKind,
  id: string,
  membershipId: string,
) {
  return queryOptions({
    queryKey: ["analytics", "viewers", kind, id, membershipId, "pages"],
    queryFn: () =>
      call(
        api().GET("/analytics/{kind}/{id}/viewers/{membershipId}/pages", {
          params: { path: { kind, id, membershipId } },
        }),
      ),
  });
}

/** Page heatmap (E2.6): dwell, views and distinct readers per page, one entry per version. */
export function analyticsHeatmapQuery(kind: AnalyticsResourceKind, id: string) {
  return queryOptions({
    queryKey: ["analytics", "heatmap", kind, id],
    queryFn: () =>
      call(api().GET("/analytics/{kind}/{id}/heatmap", { params: { path: { kind, id } } })),
  });
}

/** `days` undefined = the workspace's `hotListWindowDays`; the answer says which it used. */
export function analyticsHotListQuery(days: number | undefined) {
  return queryOptions({
    queryKey: ["analytics", "hot-list", days ?? "default"],
    queryFn: () =>
      call(
        api().GET("/analytics/hot-list", {
          params: { query: days === undefined ? {} : { days } },
        }),
      ),
  });
}

/** The hot list as CSV bytes (audited server-side), handed to the browser as a download. */
export async function fetchHotListCsv(days: number | undefined): Promise<Blob> {
  return call(
    api().GET("/analytics/hot-list.csv", {
      params: { query: days === undefined ? {} : { days } },
      parseAs: "blob",
    }),
  );
}

/*
 * One update's email opens and clicks. The updates screen joins this in the browser: the
 * analytics module may be disabled, or the viewer may lack `analytics.read`, and either way
 * the route 404s — so no retry, and the caller hides the card on any error.
 */
export function analyticsPostEmailQuery(postId: string) {
  return queryOptions({
    queryKey: ["analytics", "post-email", postId],
    queryFn: () =>
      call(api().GET("/analytics/posts/{id}/email", { params: { path: { id: postId } } })),
    retry: false,
  });
}

interface TimelineCursor {
  readonly before: string;
  readonly beforeId: string;
}

/** Keyset paged: each page carries the `(nextBefore, nextBeforeId)` cursor for the page after it. */
export function analyticsTimelineQuery(membershipId: string, limit = 25) {
  return infiniteQueryOptions({
    queryKey: ["analytics", "timeline", membershipId, limit],
    initialPageParam: undefined as TimelineCursor | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/analytics/members/{membershipId}/timeline", {
          params: {
            path: { membershipId },
            // The id travels with the timestamp: events sharing a microsecond (one close
            // beacon flushes several) would otherwise be stepped over at a page boundary.
            query:
              pageParam === undefined
                ? { limit }
                : { limit, before: pageParam.before, beforeId: pageParam.beforeId },
          },
        }),
      ),
    getNextPageParam: (last: AnalyticsTimeline): TimelineCursor | undefined =>
      last.nextBefore === null || last.nextBeforeId === null
        ? undefined
        : { before: last.nextBefore, beforeId: last.nextBeforeId },
  });
}

export const analyticsSettingsQuery = queryOptions({
  queryKey: ["analytics", "settings"],
  queryFn: () => call(api().GET("/analytics/settings")),
});

/** The member-facing transparency notice (design/04 §2) — what this workspace records. */
export const analyticsNoticeQuery = queryOptions({
  queryKey: ["analytics", "notice"],
  queryFn: () => call(api().GET("/analytics/notice")),
  staleTime: 5 * 60_000,
  retry: false,
});

/*
 * Analytics answers with resource ids only: it stores facts about resources it does not own,
 * and asking it to carry titles would make the fact store depend on every module that produces
 * one. The admin screens resolve the names on the client instead, from the data room's own tree
 * — and fall back to the short id when the caller cannot read the tree or the document is gone,
 * because an engagement row must still render for a document that has since been deleted.
 */
export function useResourceTitles(): (kind: string, id: string) => string {
  const tree = useQuery({ ...dataRoomTreeQuery, retry: false, staleTime: 60_000 });
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of tree.data?.documents ?? []) map.set(d.id, d.title);
    return map;
  }, [tree.data]);
  return (kind, id) =>
    (kind === "document" ? titles.get(id) : undefined) ??
    m.analytics_document_ref({ id: id.slice(0, 8) });
}
