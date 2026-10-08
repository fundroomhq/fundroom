import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";
import { saveBlob } from "./certificates.js";

/*
 * Access administration (E2.7): the periodic access review and a member's sessions in this
 * workspace. The review report is computed by the server on every read and bounded there
 * (`summary.truncated` says when the bound bit). Completing a review attests to the report the
 * reviewer was looking at: the screen sends back its `reportSha256` and `generatedAt`, and the
 * server answers 409 `report_changed` when access moved in between (the screen then reloads the
 * report and asks again). The stored report of each past review is downloadable as evidence.
 */
export type AccessReviewReport = FundRoomSchemas["AccessReviewReport"];
export type AccessReviewRow = FundRoomSchemas["AccessReviewRow"];
export type AccessReviewRecord = FundRoomSchemas["AccessReviewRecord"];
export type AccessReviewFlag = FundRoomSchemas["AccessReviewFlag"];
export type MemberSession = FundRoomSchemas["MemberSession"];

export const ACCESS_REVIEW_FLAGS = [
  "stale",
  "never_active",
  "expiring",
  "accreditation_lapsed",
  "accreditation_diverges",
  "pending_gates",
] as const satisfies readonly AccessReviewFlag[];

export const accessReviewQuery = queryOptions({
  queryKey: ["access", "review", "report"],
  // The route also serves CSV, so the generated type is a union with `string`; `format=json`
  // pins it to the report.
  queryFn: () =>
    call<AccessReviewReport>(
      api().GET("/access/review", { params: { query: { format: "json" } } }) as Promise<{
        data?: AccessReviewReport;
        error?: unknown;
        response: Response;
      }>,
    ),
  staleTime: 0,
});

export const accessReviewsQuery = queryOptions({
  queryKey: ["access", "review", "records"],
  queryFn: () => call(api().GET("/access/reviews")),
});

/** The report as CSV (audited server-side as `access.review_exported`). */
export async function downloadAccessReviewCsv(): Promise<void> {
  const blob = await call(
    api().GET("/access/review", { params: { query: { format: "csv" } }, parseAs: "blob" }),
  );
  saveBlob(blob, `access-review-${new Date().toISOString().slice(0, 10)}.csv`);
}

/** Completes the review, attesting to the report on screen. */
export function completeAccessReview(
  report: Pick<AccessReviewReport, "reportSha256" | "generatedAt">,
  note: string,
): Promise<AccessReviewRecord> {
  return call(
    api().POST("/access/reviews", {
      body: {
        ...(note === "" ? {} : { note }),
        reportSha256: report.reportSha256,
        generatedAt: report.generatedAt,
      },
    }),
  );
}

/** The stored report a past review attested to (its sha256 is the record's `reportSha256`). */
export async function downloadAccessReviewEvidence(record: AccessReviewRecord): Promise<void> {
  const blob = await call(
    api().GET("/access/reviews/{id}/report", {
      params: { path: { id: record.id } },
      parseAs: "blob",
    }) as Promise<{ data?: Blob; error?: unknown; response: Response }>,
  );
  saveBlob(blob, `access-review-${record.completedAt.slice(0, 10)}-${record.id.slice(0, 8)}.json`);
}

/** Live sessions of one member whose last workspace is this one (others are not ours to show). */
export function memberSessionsQuery(membershipId: string) {
  return queryOptions({
    queryKey: ["access", "person", membershipId, "sessions"],
    queryFn: () =>
      call(api().GET("/access/people/{id}/sessions", { params: { path: { id: membershipId } } })),
  });
}

/**
 * `call()` for routes that answer 204: openapi-fetch reports an empty success as
 * `data: undefined`, which `call()` would read as a failure. Errors still go through `call()`
 * so they arrive as the usual `ApiFailure` (step-up, `view_as_read_only` …).
 */
export async function callNoContent(
  promise: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<void> {
  await call(promise.then((result) => (result.response.ok ? { ...result, data: null } : result)));
}
