import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * Fixed buckets of `windowMs` per key. Two buckets (current + previous) give the classic
 * sliding-window-counter estimate without a log of every hit. Keys are hashed by the caller.
 */
export async function incrementBucket(tx: Tx, key: string, bucket: number): Promise<number> {
  const r = await tx.execute<{ count: number }>(sql`
    INSERT INTO core.rate_limit (key, bucket, count) VALUES (${key}, ${bucket}, 1)
    ON CONFLICT (key, bucket) DO UPDATE SET count = core.rate_limit.count + 1
    RETURNING count`);
  return Number(r.rows[0]?.count ?? 0);
}

export async function readBuckets(
  tx: Tx,
  key: string,
  buckets: readonly number[],
): Promise<Map<number, number>> {
  const r = await tx.execute<{ bucket: string | number; count: number }>(sql`
    SELECT bucket, count FROM core.rate_limit
    WHERE key = ${key} AND bucket IN (${sql.join(
      buckets.map((b) => sql`${b}`),
      sql`, `,
    )})`);
  const out = new Map<number, number>();
  for (const row of r.rows) out.set(Number(row.bucket), Number(row.count));
  return out;
}

export async function deleteKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`DELETE FROM core.rate_limit WHERE key = ${key}`);
}

/** Cleanup (E0.4 job): buckets older than the longest window in use. */
export async function deleteBucketsBefore(tx: Tx, bucket: number): Promise<number> {
  const r = await tx.execute(sql`DELETE FROM core.rate_limit WHERE bucket < ${bucket}`);
  return r.rowCount ?? 0;
}
