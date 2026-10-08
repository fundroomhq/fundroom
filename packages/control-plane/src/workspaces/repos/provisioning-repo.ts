import {
  core,
  type PlanRow,
  pgErrorCode,
  type SuspendReasonValue,
  type Tx,
  type WorkspaceStatusValue,
} from "@fundroom/db";
import { and, eq, isNull } from "drizzle-orm";

const { plan, workspace } = core;

/*
 * The SQL behind provisioning and the operator's plan / cell changes (E3.10). The workspace row is
 * written in the HOST context: the `workspace_control_plane_guard` trigger admits only host and
 * system writers to cell_id, status, legal_name, country and plan_id.
 */

export async function findPlanRow(tx: Tx, id: string): Promise<PlanRow | undefined> {
  const rows = await tx.select().from(plan).where(eq(plan.id, id)).limit(1);
  return rows[0];
}

export interface NewWorkspaceFacts {
  /** E3.11: the id claimed in the cell directory; absent → the column default. */
  readonly id?: string | undefined;
  readonly slug: string;
  readonly name: string;
  readonly cellId: string;
  readonly legalName: string;
  readonly country: string;
  readonly planId: string | null;
  readonly defaultLocale?: string | undefined;
}

export interface InsertedWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * Inserts the workspace; `undefined` when the slug is taken by a live workspace (the unique index
 * `workspace_slug_active_idx`: a concurrent insert of the same slug waits for the first to commit,
 * then fails here). The transaction is aborted either way — the caller must throw, not continue.
 */
export async function insertWorkspace(
  tx: Tx,
  facts: NewWorkspaceFacts,
): Promise<InsertedWorkspace | undefined> {
  try {
    const rows = await tx
      .insert(workspace)
      .values({
        ...(facts.id === undefined ? {} : { id: facts.id }),
        slug: facts.slug,
        name: facts.name,
        cellId: facts.cellId,
        legalName: facts.legalName,
        country: facts.country,
        planId: facts.planId,
        ...(facts.defaultLocale === undefined ? {} : { defaultLocale: facts.defaultLocale }),
      })
      .returning({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        createdAt: workspace.createdAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error("workspace insert returned no row");
    return row;
  } catch (error) {
    if (pgErrorCode(error) === "23505") return undefined;
    throw error;
  }
}

export async function readWorkspaceState(
  tx: Tx,
  workspaceId: string,
): Promise<
  { status: WorkspaceStatusValue; suspendedReason: SuspendReasonValue | null } | undefined
> {
  const rows = await tx
    .select({ status: workspace.status, suspendedReason: workspace.suspendedReason })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0];
}

/** Whether a live workspace holds the slug (deleted ones free it: the unique index is partial). */
export async function slugInUse(tx: Tx, slug: string): Promise<boolean> {
  const rows = await tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(eq(workspace.slug, slug), isNull(workspace.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export interface LockedPlacement {
  readonly slug: string;
  readonly holds: readonly string[];
  readonly planId: string | null;
  readonly cellId: string;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly deletedAt: Date | null;
}

/** The workspace's plan and cell, row-locked `FOR NO KEY UPDATE` (what `lockAuditChain` takes). */
export async function lockPlacement(
  tx: Tx,
  workspaceId: string,
): Promise<LockedPlacement | undefined> {
  const rows = await tx
    .select({
      slug: workspace.slug,
      holds: workspace.holds,
      planId: workspace.planId,
      cellId: workspace.cellId,
      legalName: workspace.legalName,
      country: workspace.country,
      deletedAt: workspace.deletedAt,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)
    .for("no key update");
  return rows[0];
}

export async function writePlacement(
  tx: Tx,
  workspaceId: string,
  patch: {
    readonly planId?: string | null;
    readonly cellId?: string;
    readonly legalName?: string;
    readonly country?: string;
  },
): Promise<void> {
  await tx
    .update(workspace)
    .set({
      ...(patch.planId === undefined ? {} : { planId: patch.planId }),
      ...(patch.cellId === undefined ? {} : { cellId: patch.cellId }),
      ...(patch.legalName === undefined ? {} : { legalName: patch.legalName }),
      ...(patch.country === undefined ? {} : { country: patch.country }),
    })
    .where(eq(workspace.id, workspaceId));
}

/** E3.11: what the directory entry of a workspace must say (slug, cell) and whether it may be live. */
export async function readEntryFacts(
  tx: Tx,
  workspaceId: string,
): Promise<
  { slug: string; cellId: string; deletedAt: Date | null; holds: readonly string[] } | undefined
> {
  const rows = await tx
    .select({
      slug: workspace.slug,
      cellId: workspace.cellId,
      deletedAt: workspace.deletedAt,
      holds: workspace.holds,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0];
}
