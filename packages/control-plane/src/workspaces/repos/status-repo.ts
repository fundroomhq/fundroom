import {
  core,
  type SuspendReasonValue,
  type Tx,
  type WorkspaceHoldValue,
  type WorkspaceStatusValue,
} from "@fundroom/db";
import { eq, sql } from "drizzle-orm";

const { workspace } = core;

/*
 * The SQL behind `setWorkspaceHold` (E3.10). The only place `core.workspace.holds` is written
 * (status, suspended_reason and suspended_at are derived from it by a trigger); the migration's
 * guard trigger refuses any tenant actor (staff, external) that tries, so these run in a `system`
 * context.
 */

/** The transaction-local context (`app.*` settings) as the caller left it. */
export interface TxContextSnapshot {
  readonly workspaceId: string;
  readonly actorKind: string;
  readonly membershipId: string;
  readonly userId: string;
}

export async function readTxContext(tx: Tx): Promise<TxContextSnapshot> {
  const r = await tx.execute<{
    workspace_id: string;
    actor_kind: string;
    membership_id: string;
    user_id: string;
  }>(sql`
    SELECT coalesce(current_setting('app.workspace_id', true), '') AS workspace_id,
           coalesce(current_setting('app.actor_kind', true), '') AS actor_kind,
           coalesce(current_setting('app.membership_id', true), '') AS membership_id,
           coalesce(current_setting('app.user_id', true), '') AS user_id`);
  const row = r.rows[0];
  return {
    workspaceId: row?.workspace_id ?? "",
    actorKind: row?.actor_kind ?? "",
    membershipId: row?.membership_id ?? "",
    userId: row?.user_id ?? "",
  };
}

/** Restores a snapshot taken by `readTxContext` (transaction-local, like `withTenant`). */
export async function restoreTxContext(tx: Tx, ctx: TxContextSnapshot): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true),
           set_config('app.actor_kind', ${ctx.actorKind}, true),
           set_config('app.membership_id', ${ctx.membershipId}, true),
           set_config('app.user_id', ${ctx.userId}, true)`);
}

/**
 * Switches the open transaction to the `system` actor of `workspaceId` (transaction-local
 * settings, exactly what `withTenant(systemContext(id))` sets) — the audit chain's fence and the
 * workspace guard trigger both need it.
 */
export async function enterSystemContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${workspaceId}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}

export interface WorkspaceHoldsRow {
  readonly holds: readonly WorkspaceHoldValue[];
  readonly status: WorkspaceStatusValue;
  readonly suspendedReason: SuspendReasonValue | null;
}

/**
 * The workspace's flags, row-locked `FOR NO KEY UPDATE` until commit — the same mode
 * `lockAuditChain` takes first, so the audit that follows adds no lock of its own on the row.
 */
export async function lockWorkspaceHolds(
  tx: Tx,
  workspaceId: string,
): Promise<WorkspaceHoldsRow | undefined> {
  const rows = await tx
    .select({
      holds: workspace.holds,
      status: workspace.status,
      suspendedReason: workspace.suspendedReason,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)
    .for("no key update");
  return rows[0];
}

/**
 * Writes the flags; the `workspace_derive_status` trigger derives status, reason and
 * `suspended_at` (`at` is taken only when this write is what suspends the workspace). Returns the
 * derived columns.
 */
export async function writeWorkspaceHolds(
  tx: Tx,
  workspaceId: string,
  holds: readonly WorkspaceHoldValue[],
  at: Date,
): Promise<{ status: WorkspaceStatusValue; suspendedReason: SuspendReasonValue | null }> {
  const rows = await tx
    .update(workspace)
    .set({
      holds: [...holds],
      // the trigger keeps the old value while it stays suspended and clears it when it is not
      suspendedAt: at,
    })
    .where(eq(workspace.id, workspaceId))
    .returning({ status: workspace.status, suspendedReason: workspace.suspendedReason });
  const row = rows[0];
  if (row === undefined) throw new Error("workspace row vanished under its lock");
  return row;
}
