import { core, type Tx } from "@fundroom/db";
import { and, count, eq, gt, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";

const { workspace, workspaceKey } = core;

/*
 * Data access for the workspace lifecycle after E2.7's "delete workspace" (package B1): the soft
 * delete with its 30-day purge clock, the operator's restore, and the purge job's crypto-shred.
 * The only file in `src/workspace/` that imports drizzle (`only-repos-touch-drizzle`). Query
 * builder only, never `tx.execute`, so every `timestamptz` comes back as a `Date`.
 *
 * Which context each function needs is part of its contract:
 *  - tenant (staff/system of the workspace itself): `core.workspace`'s fence admits its own row,
 *    and `core.workspace_key`'s standard fence admits its own keys;
 *  - host: sees every workspace row (restore, the purge scan) and no tenant table.
 */

export interface LifecycleRow {
  readonly id: string;
  readonly slug: string;
  readonly settings: unknown;
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly purgedAt: Date | null;
  /** E3.10 holds (E3.11: `relocation` blocks a delete). */
  readonly holds: readonly string[];
  readonly cellId: string;
}

const columns = {
  id: workspace.id,
  slug: workspace.slug,
  settings: workspace.settings,
  deletedAt: workspace.deletedAt,
  purgeAfter: workspace.purgeAfter,
  purgedAt: workspace.purgedAt,
  holds: workspace.holds,
  cellId: workspace.cellId,
};

/** Tenant or host: the row, deleted or not. */
export async function readWorkspace(tx: Tx, id: string): Promise<LifecycleRow | undefined> {
  const rows = await tx.select(columns).from(workspace).where(eq(workspace.id, id)).limit(1);
  return rows[0];
}

/**
 * Tenant or host: the row, locked `FOR UPDATE` until the transaction ends. The purge and the
 * restore both take it first, so one of them waits for the other and then sees its outcome.
 */
export async function lockWorkspace(tx: Tx, id: string): Promise<LifecycleRow | undefined> {
  const rows = await tx
    .select(columns)
    .from(workspace)
    .where(eq(workspace.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

/** Host: live (not soft-deleted) workspaces other than `exceptId`. */
export async function countOtherLiveWorkspaces(tx: Tx, exceptId: string): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(workspace)
    .where(and(isNull(workspace.deletedAt), ne(workspace.id, exceptId)));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Host: workspaces that still "exist" for the first-run setup gate — live ones, and ones deleted
 * through the danger zone (`purge_after` set) that are not purged yet: those can still be
 * restored, and setup must not mint a new owner next to them. A row soft-deleted without a
 * purge clock (a first-run setup that was rolled back) does not count; neither does a purged one.
 */
export async function countSetupBlockingWorkspaces(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(workspace)
    .where(
      or(
        isNull(workspace.deletedAt),
        and(isNotNull(workspace.purgeAfter), isNull(workspace.purgedAt)),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** Tenant: starts the purge clock. `undefined` when the workspace was already deleted. */
export async function markDeleted(
  tx: Tx,
  id: string,
  at: Date,
  purgeAfter: Date,
): Promise<LifecycleRow | undefined> {
  const rows = await tx
    .update(workspace)
    .set({ deletedAt: at, purgeAfter })
    .where(and(eq(workspace.id, id), isNull(workspace.deletedAt)))
    .returning(columns);
  return rows[0];
}

/**
 * Host: deleted, not purged workspaces matching an id or a slug (a slug may have been reused),
 * locked `FOR UPDATE` (see `lockWorkspace`): a purge that is already running finishes first.
 */
export async function findDeleted(
  tx: Tx,
  by: { readonly id: string } | { readonly slug: string },
): Promise<LifecycleRow[]> {
  const match = "id" in by ? eq(workspace.id, by.id) : eq(workspace.slug, by.slug);
  return tx
    .select(columns)
    .from(workspace)
    .where(and(match, isNotNull(workspace.deletedAt), isNull(workspace.purgedAt)))
    .for("update");
}

/** Host: clears the soft delete while the clock still runs. `undefined` when it no longer may. */
export async function restoreDeleted(
  tx: Tx,
  id: string,
  now: Date,
): Promise<LifecycleRow | undefined> {
  const rows = await tx
    .update(workspace)
    .set({ deletedAt: null, purgeAfter: null })
    .where(
      and(
        eq(workspace.id, id),
        isNotNull(workspace.deletedAt),
        isNull(workspace.purgedAt),
        gt(workspace.purgeAfter, now),
      ),
    )
    .returning(columns);
  return rows[0];
}

/** Host: deleted workspaces whose clock has run out and that are not purged yet, oldest first. */
export async function purgeDue(tx: Tx, now: Date, limit: number): Promise<LifecycleRow[]> {
  return tx
    .select(columns)
    .from(workspace)
    .where(
      and(
        isNotNull(workspace.deletedAt),
        isNull(workspace.purgedAt),
        lte(workspace.purgeAfter, now),
      ),
    )
    .orderBy(workspace.purgeAfter)
    .limit(limit);
}

/** Marker written into `kms_key_ref` of a shredded key. */
export const SHREDDED_KEY_REF = "shredded";

/**
 * Tenant (system context of the workspace): crypto-shreds every data key of the workspace by
 * overwriting the wrapped DEK with zero bytes and retiring the row. The application role has no
 * DELETE on `core.workspace_key` (0003) — and `core.mail_message.key_id` references it — so the
 * row stays as a tombstone and the key material goes. Returns how many keys were shredded.
 */
export async function shredWorkspaceKeys(tx: Tx, workspaceId: string, at: Date): Promise<number> {
  const rows = await tx
    .update(workspaceKey)
    .set({
      wrappedDek: Buffer.alloc(0),
      kmsKeyRef: SHREDDED_KEY_REF,
      retiredAt: sql`coalesce(${workspaceKey.retiredAt}, ${at})`,
    })
    .where(
      and(eq(workspaceKey.workspaceId, workspaceId), ne(workspaceKey.kmsKeyRef, SHREDDED_KEY_REF)),
    )
    .returning({ id: workspaceKey.id });
  return rows.length;
}

/** Tenant (system context): stamps `purged_at` once. */
export async function markPurged(tx: Tx, workspaceId: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(workspace)
    .set({ purgedAt: at })
    .where(
      and(
        eq(workspace.id, workspaceId),
        isNotNull(workspace.deletedAt),
        isNull(workspace.purgedAt),
      ),
    )
    .returning({ id: workspace.id });
  return rows.length > 0;
}

/** Test/ops helper: live (non-shredded) key count of a workspace (tenant context). */
export async function liveKeyCount(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx
    .select({ id: workspaceKey.id })
    .from(workspaceKey)
    .where(
      and(eq(workspaceKey.workspaceId, workspaceId), ne(workspaceKey.kmsKeyRef, SHREDDED_KEY_REF)),
    );
  return rows.length;
}
