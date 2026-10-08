import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * Documents viewed on one UTC day (E3.10 usage metering): the `document_viewed` events of that day
 * — one per open of a document by a member, the same fact the engagement views count. Raw events
 * outlive the day by the workspace's retention, which is always longer than the rollup's reach
 * (yesterday). The workspace's `system` context.
 */
export async function documentsViewedOn(tx: Tx, workspaceId: string, day: string): Promise<number> {
  const r = await tx.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM analytics.event
     WHERE workspace_id = ${workspaceId}
       AND type = 'document_viewed'
       AND occurred_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
       AND occurred_at < ((${day}::date) + 1)::timestamp AT TIME ZONE 'UTC'`);
  return Number(r.rows[0]?.c ?? 0);
}
