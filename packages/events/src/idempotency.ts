import type { Database, HostContext, TenantContext, Tx } from "@fundroom/db";
import { deleteExpiredIdempotencyKeys, insertIdempotencyKey } from "./repos/idempotency-repo.js";

/*
 * Idempotency keys (design/07 §6.2). Jobs are at-least-once; a handler that has an
 * external side effect (send an email, call a webhook) claims a key in the transaction
 * that records the effect. Redelivery finds the key and skips. Keys are namespaced by the
 * caller (`updates.send:<sendId>:<recipientId>`), never PII in the clear.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 24 * 3600_000;
export const IDEMPOTENCY_KEY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_-]*)*:[A-Za-z0-9:_.-]{1,400}$/u;

export interface ClaimOptions {
  readonly ttlMs?: number;
  readonly now?: Date;
}

/**
 * Returns true when this transaction owns the key (do the work), false when it was
 * already claimed (skip). Two concurrent claimants serialise on the primary key: the
 * second waits for the first to commit, then sees the conflict.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  ctx: TenantContext | HostContext,
  key: string,
  options: ClaimOptions = {},
): Promise<boolean> {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new Error(`idempotency key ${JSON.stringify(key)} must look like <scope>:<id>`);
  }
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS));
  return insertIdempotencyKey(
    tx,
    key,
    ctx.actorKind === "host" ? null : ctx.workspaceId,
    expiresAt,
  );
}

/** Runs `fn` only when the key is fresh; returns `skipped: true` otherwise. */
export async function onceByKey<T>(
  tx: Tx,
  ctx: TenantContext | HostContext,
  key: string,
  fn: () => Promise<T>,
  options?: ClaimOptions,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const claimed = await claimIdempotencyKey(tx, ctx, key, options);
  if (!claimed) return { skipped: true };
  return { skipped: false, result: await fn() };
}

export async function sweepIdempotencyKeys(db: Database, now = new Date()): Promise<number> {
  return db.withHost((tx) => deleteExpiredIdempotencyKeys(tx, now));
}
