import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Jobs, dead letters and health (E2.7). Kernel routes behind the required `ops` manifest:
 * `ops.read` to look, `ops.manage` to retry or discard a dead letter (discarding also needs a
 * fresh session). Instance-wide facts — queue depths, adapter checks — only come back on a
 * single-tenant install (`scope: "instance"`); dead letters and domains are always the
 * workspace's own.
 */
export type OpsJobs = FundRoomSchemas["OpsJobs"];
export type DeadLetterItem = FundRoomSchemas["DeadLetterItem"];
export type QueueStats = FundRoomSchemas["QueueStats"];
export type OpsHealth = FundRoomSchemas["OpsHealth"];
export type HealthCheck = FundRoomSchemas["HealthCheck"];
export type DomainHealth = FundRoomSchemas["DomainHealth"];
export type UpdateStatus = FundRoomSchemas["UpdateStatus"];

export const OPS_KEY = ["ops"] as const;

export function opsJobsQuery(limit = 100) {
  return queryOptions({
    queryKey: [...OPS_KEY, "jobs", limit],
    queryFn: () => call(api().GET("/ops/jobs", { params: { query: { limit } } })),
  });
}

export const opsHealthQuery = queryOptions({
  queryKey: [...OPS_KEY, "health"],
  queryFn: () => call(api().GET("/ops/health")),
  // A health page that shows a cached answer is lying about "now": always ask again on mount.
  staleTime: 0,
});

/*
 * Update check (E2.9): the running version against the public release index. The server caches
 * the index (12 h after a success, 1 h after a failure), so asking on every mount costs nothing
 * upstream; a multi-tenant host answers `disabled` / `multi_tenant` and the card is not shown.
 */
export const opsUpdateQuery = queryOptions({
  queryKey: [...OPS_KEY, "update"],
  queryFn: () => call(api().GET("/ops/update")),
  staleTime: 0,
});
