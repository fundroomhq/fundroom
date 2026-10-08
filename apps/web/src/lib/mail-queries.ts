import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Mail delivery (E2.6): which mail driver this server sends with, where its provider must post
 * delivery events, and the workspace's suppression list. Kernel routes behind `access.settings`.
 */
export type MailStatus = FundRoomSchemas["MailStatus"];
export type MailSuppression = FundRoomSchemas["MailSuppression"];
export type MailSuppressionPage = FundRoomSchemas["MailSuppressionPage"];

export const MAIL_KEY = ["mail"] as const;

export const mailStatusQuery = queryOptions({
  queryKey: [...MAIL_KEY, "status"],
  queryFn: () => call(api().GET("/mail/status")),
});

/** Newest first. The cursor is opaque: it is handed back exactly as received. */
export function mailSuppressionsQuery(limit = 50) {
  return infiniteQueryOptions({
    queryKey: [...MAIL_KEY, "suppressions", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/mail/suppressions", {
          params: { query: { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: MailSuppressionPage) => last.nextCursor ?? undefined,
  });
}
