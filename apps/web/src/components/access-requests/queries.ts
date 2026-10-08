import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { api, call } from "../../lib/api.js";

/*
 * The access-request queue (E3.1): verified public "request access" submissions, by status,
 * newest first. The list is keyset-paginated (`nextCursor` handed back as `cursor`, opaque).
 * Approving creates an ordinary invitation; denying optionally sends a neutral notice. The
 * internal decision note is staff-only on both and is never mailed.
 */
export type AccessRequest = FundRoomSchemas["AccessRequest"];
export type AccessRequestStatus = FundRoomSchemas["AccessRequestStatus"];
export type AccessRequestPage = FundRoomSchemas["AccessRequestPage"];

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const satisfies readonly AccessRequestStatus[];

export const ACCESS_REQUESTS_KEY = ["access", "requests"] as const;

export function accessRequestsQuery(status: AccessRequestStatus) {
  return infiniteQueryOptions({
    queryKey: [...ACCESS_REQUESTS_KEY, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/access/requests", {
          params: { query: { status, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        }),
      ),
    getNextPageParam: (last: AccessRequestPage) => last.nextCursor ?? undefined,
  });
}

export interface ApproveInput {
  groupIds: string[];
  expiresInDays?: number;
  message?: string;
  note?: string;
  relationship?: {
    source: NonNullable<AccessRequest["relationship"]>["source"];
    establishedAt: string;
    note?: string;
  };
}

export function approveAccessRequest(id: string, body: ApproveInput) {
  return call(
    api().POST("/access/requests/{id}/approve", {
      params: { path: { id } },
      // Grants are left to the ordinary sharing screens: the queue decides who gets in.
      body: { ...body, grants: [] },
    }),
  );
}

export function denyAccessRequest(id: string, body: { note?: string; notifyRequester: boolean }) {
  return call(api().POST("/access/requests/{id}/deny", { params: { path: { id } }, body }));
}
