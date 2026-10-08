import { core, type TenantUsageDailyRow, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

const { tenantUsageDaily } = core;

/*
 * `core.tenant_usage_daily` and the per-day counts the rollup reads (E3.10). The table admits the
 * host and the workspace's staff (read) and system (read/write) actors; the rollup writes in the
 * workspace's system context, the retention sweep deletes in host context.
 */

export async function selectLatestUsage(
  tx: Tx,
  workspaceId: string,
): Promise<TenantUsageDailyRow | undefined> {
  const rows = await tx
    .select()
    .from(tenantUsageDaily)
    .where(eq(tenantUsageDaily.workspaceId, workspaceId))
    .orderBy(desc(tenantUsageDaily.day))
    .limit(1);
  return rows[0];
}

/** Rows with `day >= since` (`YYYY-MM-DD`), oldest first. */
export async function selectUsageSince(
  tx: Tx,
  workspaceId: string,
  since: string,
): Promise<TenantUsageDailyRow[]> {
  return tx
    .select()
    .from(tenantUsageDaily)
    .where(and(eq(tenantUsageDaily.workspaceId, workspaceId), gte(tenantUsageDaily.day, since)))
    .orderBy(asc(tenantUsageDaily.day));
}

export interface UsageRowValues {
  readonly storageBytes: number;
  readonly docsViewed: number;
  readonly emailsSent: number;
  readonly staffSeats: number;
  readonly investorSeats: number;
  readonly customDomains: number;
}

/** Insert or overwrite the `(workspace, day)` row. */
export async function upsertUsageRow(
  tx: Tx,
  workspaceId: string,
  day: string,
  values: UsageRowValues,
  computedAt: Date,
): Promise<void> {
  await tx
    .insert(tenantUsageDaily)
    .values({ workspaceId, day, ...values, computedAt })
    .onConflictDoUpdate({
      target: [tenantUsageDaily.workspaceId, tenantUsageDaily.day],
      set: { ...values, computedAt },
    });
}

/** Retention: rows with `day < before`. Host context. Returns how many went. */
export async function deleteUsageBefore(tx: Tx, before: string): Promise<number> {
  const r = await tx.execute(sql`DELETE FROM core.tenant_usage_daily WHERE day < ${before}::date`);
  return r.rowCount ?? 0;
}

/** Messages the kernel mailer recorded for the workspace on the UTC day `day`. */
export async function countEmailsSent(tx: Tx, workspaceId: string, day: string): Promise<number> {
  const r = await tx.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM core.mail_message
     WHERE workspace_id = ${workspaceId}
       AND sent_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
       AND sent_at < ((${day}::date) + 1)::timestamp AT TIME ZONE 'UTC'`);
  return Number(r.rows[0]?.c ?? 0);
}

/** One page of live workspace ids after `after` (id order). Host context. */
export async function selectWorkspaceIdsPage(
  tx: Tx,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const r = await tx.execute<{ id: string }>(sql`
    SELECT id FROM core.workspace
     WHERE deleted_at IS NULL ${after === null ? sql`` : sql`AND id > ${after}::uuid`}
     ORDER BY id
     LIMIT ${limit}`);
  return r.rows.map((row) => row.id);
}
