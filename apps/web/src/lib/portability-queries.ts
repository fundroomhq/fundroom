import { type ErrorCode, FundRoomApiError, type FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { callNoContent } from "./access-admin-queries.js";
import { ApiFailure, api, apiBase, call } from "./api.js";

/*
 * Workspace export (E2.8): the owner-only `/portability/*` routes. An export is prepared in the
 * background (queued → running → ready | failed), kept for 7 days, and downloaded as a signed
 * zip. Requesting and downloading need a fresh session, so both go through `useGuardedMutation`.
 */
export type WorkspaceExport = FundRoomSchemas["WorkspaceExport"];
export type WorkspaceExportStatus = FundRoomSchemas["WorkspaceExportStatus"];

export const PORTABILITY_KEY = ["portability"] as const;
/** How often the list is re-read while an export is still being prepared. */
export const EXPORT_POLL_MS = 3000;

export function isExportActive(e: Pick<WorkspaceExport, "status">): boolean {
  return e.status === "queued" || e.status === "running";
}

export const workspaceExportsQuery = queryOptions({
  queryKey: [...PORTABILITY_KEY, "exports"],
  queryFn: () => call(api().GET("/portability/exports")),
  refetchInterval: (query) =>
    (query.state.data?.items ?? []).some(isExportActive) ? EXPORT_POLL_MS : false,
});

export const workspaceExportKeysQuery = queryOptions({
  queryKey: [...PORTABILITY_KEY, "export-key"],
  queryFn: () => call(api().GET("/portability/export-key")),
});

export function requestWorkspaceExport(includeRawAnalytics: boolean): Promise<WorkspaceExport> {
  return call(api().POST("/portability/exports", { body: { includeRawAnalytics } }));
}

export function deleteWorkspaceExport(id: string): Promise<void> {
  return callNoContent(api().DELETE("/portability/exports/{id}", { params: { path: { id } } }));
}

/**
 * How much of the server's 10-minute step-up window (`STEP_UP_MAX_AGE_MS`) must be left for the
 * preflight to hand the download to the browser. The margin covers the gap between this check
 * and the browser's own request, and a `Date` header that is only accurate to the second.
 */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
export const STEP_UP_MARGIN_MS = 60 * 1000;

export interface ExportDownload {
  filename: string;
  sha256: string | null;
}

/** The URL the browser fetches the zip from (same origin as the API client). */
export function exportDownloadHref(id: string): string {
  return `${apiBase()}/api/v1/portability/exports/${encodeURIComponent(id)}/download`;
}

/** The name the server's `Content-Disposition` gives the zip (`<slug>-export-<date>.zip`). */
export function exportFilename(
  item: Pick<WorkspaceExport, "createdAt" | "completedAt">,
  slug: string,
): string {
  return `${slug || "workspace"}-export-${(item.completedAt ?? item.createdAt).slice(0, 10)}.zip`;
}

/** The refusal the download route would have answered with, raised before navigating. */
function refusal(
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiFailure {
  return new ApiFailure(
    new FundRoomApiError(status, { error: { ...details, code, message } }, undefined),
    undefined,
  );
}

/** Clicks a hidden `<a download>` so the browser's download manager fetches `href` to disk. */
function saveHref(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** The server's clock when it answered, falling back to ours (a proxy may strip `Date`). */
function serverNow(response: Response): number {
  const date = response.headers.get("date");
  const parsed = date === null ? Number.NaN : Date.parse(date);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Downloads a ready export by handing its URL to the browser's download manager, which streams
 * the zip straight to disk with its own progress bar. An export is the whole workspace — it can
 * be gigabytes — so it must never be buffered into a `Blob` in the tab the way the (small)
 * certificates in `lib/certificates.ts` are: that holds the whole file in memory and crashes the
 * tab long before the end of a large one.
 *
 * A navigation cannot show a refusal on this screen, so everything the download route would
 * refuse is checked first, with cheap reads that record nothing:
 *  - the export row (`GET /portability/exports/{id}`): not `ready` → 409 `export_not_ready`,
 *    past `expiresAt` or `expired` → 410 `export_expired`; a missing row is the usual 404;
 *  - the session's freshness (`GET /me`: `authTime` against the server's `Date`): with less than
 *    `STEP_UP_MARGIN_MS` of the step-up window left this throws `step_up_required` (reason
 *    `fresh`), which `useGuardedMutation` turns into the step-up round trip — the route's
 *    `returnTo` brings the owner back here to press Download again.
 * Only then is a hidden `<a download>` clicked. The route is same-origin and cookie-authenticated,
 * so the navigation carries the session; `Content-Disposition: attachment` keeps the page in
 * place. The SHA-256 comes from the export row, so the owner can verify the saved file.
 */
export async function downloadWorkspaceExport(
  item: Pick<WorkspaceExport, "id">,
  slug: string,
): Promise<ExportDownload> {
  const row = await call(
    api().GET("/portability/exports/{id}", { params: { path: { id: item.id } } }),
  );
  const meResult = await api().GET("/me");
  const me = await call(Promise.resolve(meResult));
  const now = serverNow(meResult.response);
  if (row.status === "expired" || (row.expiresAt !== null && Date.parse(row.expiresAt) <= now)) {
    throw refusal(410, "export_expired", "the export has expired");
  }
  if (row.status !== "ready") throw refusal(409, "export_not_ready", "the export is not ready");
  const age = now - Date.parse(me.session.authTime);
  if (!(age >= -STEP_UP_MARGIN_MS && age <= STEP_UP_WINDOW_MS - STEP_UP_MARGIN_MS)) {
    throw refusal(403, "step_up_required", "please confirm it's you", { reason: "fresh" });
  }
  const filename = exportFilename(row, slug);
  saveHref(exportDownloadHref(row.id), filename);
  return { filename, sha256: row.sha256 };
}
