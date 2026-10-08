import { core, type Tx } from "@fundroom/db";
import { lte } from "drizzle-orm";

/** True when this transaction claimed the key; false when it already existed. */
export async function insertIdempotencyKey(
  tx: Tx,
  key: string,
  workspaceId: string | null,
  expiresAt: Date,
): Promise<boolean> {
  const rows = await tx
    .insert(core.idempotencyKey)
    .values({ key, workspaceId, expiresAt })
    .onConflictDoNothing()
    .returning({ key: core.idempotencyKey.key });
  return rows.length === 1;
}

export async function deleteExpiredIdempotencyKeys(tx: Tx, now: Date): Promise<number> {
  const rows = await tx
    .delete(core.idempotencyKey)
    .where(lte(core.idempotencyKey.expiresAt, now))
    .returning({ key: core.idempotencyKey.key });
  return rows.length;
}
