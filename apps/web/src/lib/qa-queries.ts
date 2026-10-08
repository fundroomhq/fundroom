import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions, useQuery } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call } from "./api.js";

/*
 * Investor-side data-room Q&A (E3.3, ADR-0051). Everything hangs off `GET /qa/status`: while
 * the workspace has Q&A off (or the call fails for any reason) the portal shows no Q&A at all,
 * and every other investor route would answer 404 anyway. A question that is not the caller's
 * arrives already projected by the server (published wording only, no asker, no original body);
 * the SPA never has anything to hide.
 */
export type QaStatus = FundRoomSchemas["QaStatus"];
export type QaQuestionView = FundRoomSchemas["QaQuestionView"];
export type QaQuestionPage = FundRoomSchemas["QaQuestionPage"];
export type QaTargetKind = FundRoomSchemas["QaTargetKind"];
export type QaQuestionStatus = FundRoomSchemas["QaQuestionStatus"];

export const QA_KEY = ["data-room", "qa"] as const;

export const SUBJECT_MAX = 200;
export const QUESTION_MAX = 5000;

const DISABLED: QaStatus = { enabled: false, canAsk: false, allowFolderQuestions: false };

export const qaStatusQuery = queryOptions({
  queryKey: [...QA_KEY, "status"],
  queryFn: () => call(api().GET("/data-room/qa/status")),
  staleTime: 60_000,
  retry: false,
});

/**
 * The Q&A switch as the portal sees it: `enabled: false` until the answer arrives and whenever
 * the call fails (404 from an older server, offline, …) — Q&A is additive, never a blocker.
 */
export function useQaStatus(enabled = true): QaStatus {
  const status = useQuery({ ...qaStatusQuery, enabled });
  return status.data ?? DISABLED;
}

/** Published questions on one document/folder plus the caller's own on it. */
export function qaTargetQuestionsQuery(targetKind: QaTargetKind, targetId: string) {
  return infiniteQueryOptions({
    queryKey: [...QA_KEY, "questions", "target", targetKind, targetId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/data-room/qa/questions", {
          params: {
            query: {
              scope: "target",
              targetKind,
              targetId,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: QaQuestionPage) => last.nextCursor ?? undefined,
  });
}

/** The caller's own questions, any status, newest first. */
export const myQuestionsQuery = infiniteQueryOptions({
  queryKey: [...QA_KEY, "questions", "mine"],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    call(
      api().GET("/data-room/qa/questions", {
        params: {
          query: { scope: "mine", ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        },
      }),
    ),
  getNextPageParam: (last: QaQuestionPage) => last.nextCursor ?? undefined,
});

export function qaQuestionQuery(id: string) {
  return queryOptions({
    queryKey: [...QA_KEY, "question", id],
    queryFn: () => call(api().GET("/data-room/qa/questions/{id}", { params: { path: { id } } })),
  });
}

export interface AskInput {
  targetKind: QaTargetKind;
  targetId: string;
  subject: string;
  body: string;
}

export function askQuestion(body: AskInput) {
  return call(api().POST("/data-room/qa/questions", { body }));
}

export function withdrawQuestion(id: string) {
  return call(api().POST("/data-room/qa/questions/{id}/withdraw", { params: { path: { id } } }));
}

/** Still waiting on staff: the asker may withdraw it. */
export function isPending(status: QaQuestionStatus): boolean {
  return status === "open" || status === "assigned" || status === "awaiting_approval";
}

/**
 * The line a question is listed under. Mine: my subject. Anyone else's: the first line of the
 * published wording (which staff may have edited to strip identifying details).
 */
export function questionHeadline(q: QaQuestionView): string {
  if (q.mine && q.subject) return q.subject;
  const first = (q.publicText ?? "").split("\n").find((l) => l.trim() !== "");
  return (first ?? "").trim().slice(0, 200) || m.dataroom_qa_question_heading();
}

/** The published wording minus the headline line, for a non-asker's view. */
export function questionPublicRest(q: QaQuestionView): string {
  const text = q.publicText ?? "";
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  return i < 0
    ? ""
    : lines
        .slice(i + 1)
        .join("\n")
        .trim();
}

/** `data-room/documents/<id>` / `data-room/folders/<id>` — a splat under `/`. */
export function qaTargetSplat(kind: QaTargetKind, id: string): string {
  return kind === "document" ? `data-room/documents/${id}` : `data-room/folders/${id}`;
}
