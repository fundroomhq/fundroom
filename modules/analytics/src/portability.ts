import { createHash } from "node:crypto";
import type { ModulePortability } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { PARTITION_MONTHS_AHEAD } from "./jobs.js";
import { ensurePartitions, ensurePartitionsFrom } from "./repos/partition-repo.js";

/*
 * Workspace export/import (E2.8).
 *
 *  * Raw engagement data — `view_session`, `event`, `page_open` — travels ONLY when the export
 *    was requested with `includeRawAnalytics` (`includeWhen: "rawAnalytics"`). It is per-member
 *    behavioural data, so it is opt-in egress.
 *     - `view_session.ip_hash` is an HMAC under the SOURCE workspace's `analytics-ip` key and
 *       cannot be re-keyed (the address is never stored): omitted, NULL on import (the column
 *       allows it — server-side facts have none).
 *     - `view_session.session_key` is sha256 of a kernel session id that does not exist on the
 *       target: omitted, and replaced on import by a fresh unique 32-byte value derived from the
 *       row's new id (the column is NOT NULL, UNIQUE per workspace, exactly 32 octets).
 *     - `event` is PARTITION BY RANGE (occurred_at) with no default partition, so an INSERT for a
 *       month the target instance has no partition for would fail the whole import.
 *       `beforeImport` creates the partitions for the full retention window (120 months back,
 *       the `retentionMonths` maximum) plus the usual months ahead, through the module's own
 *       `analytics.ensure_partitions`, and only when events are actually being imported.
 *       Partitions left empty are dropped by the next `analytics.maintain` like any other.
 *       An event outside that window (possible only under a decade-long legal hold, or with a
 *       skewed clock) is dropped on import rather than failing the import.
 *     - `page_open` is the ≤2-minute heartbeat buffer; carried with its session so the flush job
 *       on the target turns it into the `page_viewed` event it would have become.
 *  * Rollups — `viewer_resource_rollup`, `daily_resource_rollup`, `page_rollup`, `page_viewer`,
 *    `hot_lead_alert` — are the durable analytics record (design/06 "analytics_rollups") and
 *    always travel. `membership_id`, `resource_id` and `version_key` are exported row ids and are
 *    remapped generically; the zero-uuid `version_key` is not an id and stays.
 *  * `rollup_cursor` travels too, although it looks instance-local: the rollups above already
 *    contain every event up to the cursor, and a fresh cursor (1970) would fold every imported raw
 *    event into them a second time. Its `last_event_id` is remapped like any other id.
 */

/** Months of raw events the import makes room for: the `retentionMonths` maximum. */
export const IMPORT_PARTITION_MONTHS_BACK = 120;

function monthStartUtc(d: Date, deltaMonths: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + deltaMonths, 1));
}

/**
 * The occurred_at range the import guarantees partitions for. One month narrower than what
 * `beforeImport` creates on each side, so a partition bound read in a non-UTC session time zone
 * still covers it.
 */
export function importEventWindow(now: Date): { readonly from: Date; readonly to: Date } {
  return {
    from: monthStartUtc(now, -IMPORT_PARTITION_MONTHS_BACK),
    to: monthStartUtc(now, PARTITION_MONTHS_AHEAD + 1),
  };
}

/** A fresh `session_key` for an imported view session: unique, 32 octets, bytea hex text. */
export function importedSessionKey(newSessionId: string): string {
  return `\\x${createHash("sha256").update(`import:${newSessionId}`).digest("hex")}`;
}

export const analyticsPortability: ModulePortability = {
  version: 1,
  tables: [
    {
      table: "view_session",
      mode: "rows",
      includeWhen: "rawAnalytics",
      omitColumns: ["session_key", "ip_hash"],
      importRow(row: JsonObject) {
        if (typeof row["id"] !== "string") return null;
        return { ...row, session_key: importedSessionKey(row["id"]) };
      },
    },
    {
      table: "event",
      mode: "rows",
      includeWhen: "rawAnalytics",
      importRow(row: JsonObject, ctx) {
        const at =
          typeof row["occurred_at"] === "string" ? Date.parse(row["occurred_at"]) : Number.NaN;
        const w = importEventWindow(ctx.now);
        if (!(at >= w.from.getTime() && at < w.to.getTime())) return null;
        return row;
      },
    },
    { table: "page_open", mode: "rows", includeWhen: "rawAnalytics" },
    { table: "viewer_resource_rollup", mode: "rows" },
    { table: "daily_resource_rollup", mode: "rows" },
    { table: "rollup_cursor", mode: "rows" },
    { table: "page_rollup", mode: "rows" },
    { table: "page_viewer", mode: "rows" },
    { table: "hot_lead_alert", mode: "rows" },
  ],
  async beforeImport({ tx, ctx, services, rows }) {
    if ((rows["event"] ?? 0) === 0) return;
    const now = services.now();
    // months -(BACK+1) .. -1, then 0 .. AHEAD+1: one month of margin on both sides of the window.
    await ensurePartitionsFrom(
      tx,
      monthStartUtc(now, -(IMPORT_PARTITION_MONTHS_BACK + 1)),
      IMPORT_PARTITION_MONTHS_BACK,
    );
    await ensurePartitions(tx, PARTITION_MONTHS_AHEAD + 1);
    services.log("analytics.import_partitions_ensured", { workspaceId: ctx.workspaceId });
  },
};
