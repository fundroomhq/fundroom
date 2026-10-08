import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * The partition plumbing behind `analytics.maintain`. Partitions of `analytics.event` belong to
 * no tenant, so these run in a host transaction and call the plpgsql helpers the migration
 * installed — the SQL is authoritative (ADR-0004), this file only types the calls.
 */

/** Creates missing monthly partitions through `monthsAhead`; returns how many were created. */
export async function ensurePartitions(tx: Tx, monthsAhead: number): Promise<number> {
  const r = await tx.execute(sql`SELECT analytics.ensure_partitions(${monthsAhead}::int) AS n`);
  return Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/** Partitions wholly older than `retentionMonths`, oldest first. */
export async function expiredPartitions(tx: Tx, retentionMonths: number): Promise<string[]> {
  const r = await tx.execute(
    sql`SELECT partition_name FROM analytics.expired_partitions(${retentionMonths}::int)`,
  );
  return r.rows.map((x) => String((x as { partition_name: unknown }).partition_name));
}

/** Detaches and drops one partition by name (the function validates the name). */
export async function dropPartition(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`SELECT analytics.drop_partition(${name}::text)`);
}

/** One workspace's say in the shared partition drop. */
export interface WorkspaceRetentionFact {
  readonly id: string;
  readonly settings: unknown;
  /** Soft-deleted workspaces are included: their rows stay in the shared partitions. */
  readonly deleted: boolean;
}

/**
 * Every workspace, soft-deleted ones included (host transaction). `listActiveWorkspaceIds`
 * skips soft-deleted workspaces, but their raw events live in the same monthly partitions until
 * the workspace is purged, so a legal hold or a long retention on one of them must still stop a
 * partition drop.
 */
export async function workspaceRetentionFacts(tx: Tx): Promise<WorkspaceRetentionFact[]> {
  const r = await tx.execute(
    sql`SELECT id, settings, deleted_at IS NOT NULL AS deleted FROM core.workspace ORDER BY created_at`,
  );
  return r.rows.map((x) => {
    const row = x as { id: string; settings: unknown; deleted: boolean };
    return { id: row.id, settings: row.settings, deleted: row.deleted === true };
  });
}

/**
 * Creates missing monthly partitions for `from` (truncated to its month) through
 * `monthsAhead` months later (at most 120, the function's own bound). Used by the workspace
 * import (E2.8), whose raw events may predate every partition the target instance has.
 */
export async function ensurePartitionsFrom(
  tx: Tx,
  from: Date,
  monthsAhead: number,
): Promise<number> {
  const r = await tx.execute(
    sql`SELECT analytics.ensure_partitions(${monthsAhead}::int, ${from.toISOString().slice(0, 10)}::date) AS n`,
  );
  return Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}
