import { core, type OutboxRow, type Tx } from "@fundroom/db";
import { and, eq, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";

/*
 * Raw access to core.outbox. Writers call `insertOutboxRow` inside the business transaction
 * (any context); the relay calls the rest in host context, which is the one context that
 * sees every row (outbox fence, migration 0000).
 */
export interface NewOutboxEvent {
  readonly workspaceId: string | null;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadSchemaVersion: number;
  readonly availableAt?: Date | undefined;
}

export async function insertOutboxRow(tx: Tx, event: NewOutboxEvent): Promise<number> {
  const rows = await tx
    .insert(core.outbox)
    .values({
      workspaceId: event.workspaceId,
      topic: event.topic,
      payload: event.payload,
      payloadSchemaVersion: event.payloadSchemaVersion,
      ...(event.availableAt ? { availableAt: event.availableAt } : {}),
    })
    .returning({ id: core.outbox.id });
  const row = rows[0];
  if (!row) throw new Error("outbox insert returned no row");
  return row.id;
}

/**
 * Pending rows, oldest first, locked for this transaction; other relays skip them.
 *
 * `now` is the relay's clock, which has millisecond resolution, while `available_at` defaults
 * to the database's `now()` in microseconds. A row stamped at 12:00:00.123456 is due once the
 * relay's clock reads 12:00:00.123, so the bound is the end of `now`'s millisecond: `<= now`
 * would leave every row written within the current millisecond (the common case on a fast
 * connection) waiting for the next poll.
 */
export async function claimPendingOutboxRows(
  tx: Tx,
  limit: number,
  now: Date,
): Promise<OutboxRow[]> {
  const endOfMillisecond = new Date(now.getTime() + 1);
  return tx
    .select()
    .from(core.outbox)
    .where(and(isNull(core.outbox.processedAt), lt(core.outbox.availableAt, endOfMillisecond)))
    .orderBy(core.outbox.id)
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function markOutboxProcessed(
  tx: Tx,
  id: number,
  dispatched: number,
  now: Date,
): Promise<void> {
  await tx
    .update(core.outbox)
    .set({
      processedAt: now,
      dispatched,
      attempts: sql`${core.outbox.attempts} + 1`,
      lastError: null,
    })
    .where(eq(core.outbox.id, id));
}

export async function markOutboxFailed(
  tx: Tx,
  id: number,
  error: string,
  retryAt: Date,
): Promise<void> {
  await tx
    .update(core.outbox)
    .set({
      attempts: sql`${core.outbox.attempts} + 1`,
      lastError: error.slice(0, 2000),
      availableAt: retryAt,
    })
    .where(eq(core.outbox.id, id));
}

/** Deletes processed rows older than `before`. Returns the count. */
export async function sweepProcessedOutboxRows(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .delete(core.outbox)
    .where(and(isNotNull(core.outbox.processedAt), lte(core.outbox.processedAt, before)))
    .returning({ id: core.outbox.id });
  return rows.length;
}

/** Rows still pending (for /readyz-style checks and tests). */
export async function countPendingOutboxRows(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(core.outbox)
    .where(isNull(core.outbox.processedAt));
  return rows[0]?.n ?? 0;
}
