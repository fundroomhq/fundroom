import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { analyticsNoticeQuery } from "./analytics-queries.js";
import { api } from "./api.js";
import { useViewAs } from "./queries.js";

/*
 * Dwell heartbeat client (E1.5). While a document page is on screen the viewer posts the
 * elapsed milliseconds every few seconds; the tab going hidden stops the clock and flushes
 * what is owed, and unmounting flushes plus closes the session so the server can roll it up.
 *
 * Nothing here runs unless the server says so. The notice endpoint's `dwell` flag is the
 * single source of truth: it already folds the workspace's analytics mode, its consent mode,
 * this member's stored answer and their Global Privacy Control signal into one boolean, so the
 * client never re-derives the rule (E1.6/R13). Deciding it here as well would only create a
 * second place to get it wrong, and the permissive direction is the one that matters.
 * Every call is fire-and-forget: a failed beat must never reach the render path, and no
 * timer may outlive the effect that started it.
 */
const BEAT_MS = 5_000;
const MAX_MS = 15_000; // the server caps a single beat here; never send more
const MIN_MS = 500; // don't bother the server with sub-second slivers

export interface DwellHeartbeatOptions {
  /** The document being read. */
  readonly resourceId: string;
  readonly versionId?: string | null;
  /** 1-based page currently on screen. */
  readonly page: number;
  /** False while the document is gated, unavailable or still loading. */
  readonly enabled: boolean;
}

export function useDwellHeartbeat({
  resourceId,
  versionId,
  page,
  enabled,
}: DwellHeartbeatOptions): void {
  // Staff viewing as an investor (E2.7) must not beat as them: the server would refuse every
  // beat with `view_as_read_only`, and nothing of that visit may be recorded as the investor's.
  const viewingAs = useViewAs() !== null;
  const notice = useQuery({ ...analyticsNoticeQuery, enabled: enabled && !viewingAs });
  const tracking = enabled && !viewingAs && notice.data?.dwell === true && page >= 1;

  // One interval per (document, version, page): changing page tears the old one down, which
  // flushes the time owed to the page the reader just left.
  useEffect(() => {
    if (!tracking) return;
    let since = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;

    const send = () => {
      const now = Date.now();
      const ms = Math.min(MAX_MS, Math.max(0, Math.round(now - since)));
      since = now;
      if (ms < MIN_MS) return;
      try {
        void api()
          .POST("/analytics/heartbeat", {
            body: {
              resourceKind: "document",
              resourceId,
              ...(versionId ? { versionId } : {}),
              page,
              ms,
            },
          })
          .catch(() => {});
      } catch {
        /* never throw into the render path */
      }
    };

    const start = () => {
      if (timer !== undefined) return;
      since = Date.now();
      timer = setInterval(send, BEAT_MS);
    };
    const stop = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      send();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [tracking, resourceId, versionId, page]);

  // Declared after the beat effect so React runs this cleanup second: flush, then close.
  useEffect(() => {
    if (!tracking) return;
    return () => {
      try {
        void api()
          .POST("/analytics/close", { body: { resourceKind: "document", resourceId } })
          .catch(() => {});
      } catch {
        /* never throw into the render path */
      }
    };
  }, [tracking, resourceId]);
}
