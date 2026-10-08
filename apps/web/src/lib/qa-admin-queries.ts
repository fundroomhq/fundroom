import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call, isApiError } from "./api.js";
import { saveBlob } from "./certificates.js";

/*
 * Data-room Q&A, staff side (E3.3 D6, ADR-0051): the inbox by status (keyset-paginated, counts
 * for every status on each page), one question's detail, the workflow actions (assign, answer,
 * submit, approve/reject, release, unpublish, close, reopen, metadata) and the CSV export and
 * import. Every staff route works whether or not Q&A is enabled for investors, so the team can
 * prepare (or import) before switching it on.
 */
export type QaInboxItem = FundRoomSchemas["QaInboxItem"];
export type QaInboxPage = FundRoomSchemas["QaInboxPage"];
export type QaInboxDetail = FundRoomSchemas["QaInboxDetail"];
export type QaQuestionStatus = FundRoomSchemas["QaQuestionStatus"];
export type QaSlaState = FundRoomSchemas["QaSlaState"];
export type QaVisibility = FundRoomSchemas["QaVisibility"];
export type QaTargetKind = FundRoomSchemas["QaTargetKind"];
export type QaImportResult = FundRoomSchemas["QaImportResult"];
export type QaSettings = FundRoomSchemas["QaSettings"];
export type QaSettingsPatch = FundRoomSchemas["QaSettingsPatch"];
/** PATCH /data-room/qa/inbox/{id} (`null` clears a field). */
export interface QaInboxPatch {
  category?: string | null;
  internalNote?: string | null;
  publicText?: string | null;
  dueAt?: string | null;
}

export const QA_INBOX_STATUSES = [
  "open",
  "assigned",
  "awaiting_approval",
  "answered",
  "published",
  "closed",
] as const satisfies readonly QaQuestionStatus[];

/** Roles that carry `data-room.qa_answer` (authz matrix): the only valid assignees. */
export const QA_ANSWER_ROLES: readonly string[] = ["owner", "admin", "editor", "finance", "legal"];

export const QA_ADMIN_KEY = ["data-room", "qa", "admin"] as const;

export interface QaInboxFilter {
  status: QaQuestionStatus;
  /** "" = anyone. */
  assignee: "" | "me" | "unassigned";
  overdue: boolean;
}

export function qaInboxQuery(filter: QaInboxFilter) {
  return infiniteQueryOptions({
    queryKey: [...QA_ADMIN_KEY, "inbox", filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/data-room/qa/inbox", {
          params: {
            query: {
              status: filter.status,
              ...(filter.assignee === "" ? {} : { assignee: filter.assignee }),
              ...(filter.overdue ? { overdue: "true" as const } : {}),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: QaInboxPage) => last.nextCursor ?? undefined,
  });
}

export function qaInboxDetailQuery(id: string) {
  return queryOptions({
    queryKey: [...QA_ADMIN_KEY, "detail", id],
    queryFn: () => call(api().GET("/data-room/qa/inbox/{id}", { params: { path: { id } } })),
  });
}

const path = (id: string) => ({ params: { path: { id } } });

export function qaAssign(id: string, assigneeMembershipId: string | null) {
  return call(
    api().POST("/data-room/qa/inbox/{id}/assign", { ...path(id), body: { assigneeMembershipId } }),
  );
}

export function qaSaveAnswer(id: string, body: string) {
  return call(api().PUT("/data-room/qa/inbox/{id}/answer", { ...path(id), body: { body } }));
}

export function qaSubmit(id: string) {
  return call(api().POST("/data-room/qa/inbox/{id}/submit", path(id)));
}

export function qaApprove(id: string) {
  return call(api().POST("/data-room/qa/inbox/{id}/approve", path(id)));
}

export function qaReject(id: string, note: string) {
  return call(api().POST("/data-room/qa/inbox/{id}/reject", { ...path(id), body: { note } }));
}

export function qaRelease(id: string, body: { visibility: QaVisibility; publicText?: string }) {
  return call(api().POST("/data-room/qa/inbox/{id}/release", { ...path(id), body }));
}

export function qaUnpublish(id: string) {
  return call(api().POST("/data-room/qa/inbox/{id}/unpublish", path(id)));
}

export function qaClose(id: string, notifyAsker: boolean) {
  return call(
    api().POST("/data-room/qa/inbox/{id}/close", {
      ...path(id),
      body: { reason: "declined", notifyAsker },
    }),
  );
}

export function qaReopen(id: string) {
  return call(api().POST("/data-room/qa/inbox/{id}/reopen", path(id)));
}

export function qaPatch(id: string, body: QaInboxPatch) {
  return call(api().PATCH("/data-room/qa/inbox/{id}", { ...path(id), body }));
}

export function qaCreateEntry(body: {
  targetKind: QaTargetKind;
  targetId: string;
  subject: string;
  body: string;
  answer: string;
}) {
  return call(api().POST("/data-room/qa/inbox", { body }));
}

export function qaImport(csv: string, dryRun: boolean): Promise<QaImportResult> {
  return call(api().POST("/data-room/qa/import", { body: { csv, dryRun } }));
}

/** Set (to `true`) when the export hit the server's row cap and left the oldest rows out. */
export const QA_EXPORT_TRUNCATED_HEADER = "x-fundroom-export-truncated";
/**
 * The pre-rename spelling (A-2), read when the new one is absent so this bundle still warns
 * against a server from before the rename. Drop with the server's legacy header.
 */
export const LEGACY_QA_EXPORT_TRUNCATED_HEADER = "x-seedhost-export-truncated";

/**
 * The whole Q&A log as CSV (a `fresh` route, audited `qa.exported`). `truncated`: the file
 * holds fewer rows than the log (the server's cap), so the caller warns.
 */
export async function downloadQaExport(): Promise<{ truncated: boolean }> {
  let truncated = false;
  const request = api().GET("/data-room/qa/export", {
    params: { query: { format: "csv" } },
    parseAs: "blob",
  }) as Promise<{ data?: Blob; error?: unknown; response: Response }>;
  const blob = await call(
    request.then((r) => {
      const flag =
        r.response.headers.get(QA_EXPORT_TRUNCATED_HEADER) ??
        r.response.headers.get(LEGACY_QA_EXPORT_TRUNCATED_HEADER);
      truncated = flag === "true";
      return r;
    }),
  );
  saveBlob(blob, `data-room-qa-${new Date().toISOString().slice(0, 10)}.csv`);
  return { truncated };
}

/** `details.reason` of a Q&A refusal (the server flattens details into the error object). */
export function qaErrorReason(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const reason = error.body.error["reason"];
  return typeof reason === "string" ? reason : undefined;
}
