import { core, type NewPlanRow, type PlanRow, type Tx } from "@fundroom/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

const { plan, workspace } = core;

/*
 * `core.plan` (E3.10). Anyone may read the catalogue; only the host context writes it (the table's
 * `plan_host_write` policy), so every write here runs in a `withHost` transaction.
 */

export async function selectPlan(tx: Tx, id: string): Promise<PlanRow | undefined> {
  const rows = await tx.select().from(plan).where(eq(plan.id, id)).limit(1);
  return rows[0];
}

/** Oldest first. `publicOnly` also drops archived plans. */
export async function selectPlans(
  tx: Tx,
  options: { readonly publicOnly: boolean; readonly includeArchived: boolean },
): Promise<PlanRow[]> {
  const where = [];
  if (options.publicOnly) where.push(eq(plan.public, true));
  if (options.publicOnly || !options.includeArchived) where.push(isNull(plan.archivedAt));
  return tx
    .select()
    .from(plan)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(asc(plan.createdAt), asc(plan.id));
}

/** `undefined` when the id is taken (the caller answers 409). */
export async function insertPlan(tx: Tx, row: NewPlanRow): Promise<PlanRow | undefined> {
  const rows = await tx.insert(plan).values(row).onConflictDoNothing().returning();
  return rows[0];
}

/** Writes `patch` only when the row is still at `version`; bumps it. `undefined` = stale or gone. */
export async function updatePlanAtVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<
    Pick<
      NewPlanRow,
      | "name"
      | "limits"
      | "limitsSchemaVersion"
      | "billingPriceRef"
      | "billingMeteredPriceRefs"
      | "trialDays"
      | "public"
    >
  >,
): Promise<PlanRow | undefined> {
  const rows = await tx
    .update(plan)
    .set({ ...patch, version: sql`${plan.version} + 1` })
    .where(and(eq(plan.id, id), eq(plan.version, version)))
    .returning();
  return rows[0];
}

/** Sets `archived_at` once (a second archive is a no-op returning the row as it is). */
export async function archivePlanRow(tx: Tx, id: string, at: Date): Promise<PlanRow | undefined> {
  const rows = await tx
    .update(plan)
    .set({ archivedAt: at, version: sql`${plan.version} + 1` })
    .where(and(eq(plan.id, id), isNull(plan.archivedAt)))
    .returning();
  return rows[0] ?? selectPlan(tx, id);
}

/** Live workspaces per plan id. Host context (every workspace). */
export async function countWorkspacesByPlan(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({ planId: workspace.planId, n: sql<number>`count(*)::int` })
    .from(workspace)
    .where(and(isNull(workspace.deletedAt), sql`${workspace.planId} IS NOT NULL`))
    .groupBy(workspace.planId);
  return new Map(rows.flatMap((r) => (r.planId === null ? [] : [[r.planId, Number(r.n)]])));
}

/** A workspace's plan id (`null`: unlimited). `undefined` when there is no such live workspace. */
export async function selectWorkspacePlanId(
  tx: Tx,
  workspaceId: string,
): Promise<string | null | undefined> {
  const rows = await tx
    .select({ planId: workspace.planId })
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), isNull(workspace.deletedAt)))
    .limit(1);
  return rows[0] === undefined ? undefined : rows[0].planId;
}

/** The transaction-local context (`app.*` settings), to restore after an audit switch. */
export interface PlanTxContext {
  readonly workspaceId: string;
  readonly actorKind: string;
  readonly membershipId: string;
  readonly userId: string;
}

export async function readPlanTxContext(tx: Tx): Promise<PlanTxContext> {
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

export async function restorePlanTxContext(tx: Tx, ctx: PlanTxContext): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true),
           set_config('app.actor_kind', ${ctx.actorKind}, true),
           set_config('app.membership_id', ${ctx.membershipId}, true),
           set_config('app.user_id', ${ctx.userId}, true)`);
}

/** The `system` actor of `workspaceId` (what `withTenant(systemContext(id))` sets). */
export async function enterSystemContextFor(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${workspaceId}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}

/**
 * A provider price may be a plan's BASE price or a METERED price, never both (fix round 3): the
 * billing webhook maps a subscription to a plan by its base price and reports usage by its
 * metered prices, so one ref in both roles would move plans on a usage line item. Serialised by
 * a transaction-level advisory lock (plan writes are rare operator acts). Returns the clashing ref.
 */
export async function findPriceRefClash(
  tx: Tx,
  planId: string,
  base: string | null,
  metered: readonly string[],
): Promise<string | undefined> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('core.plan:price_refs'))`);
  if (base !== null && metered.includes(base)) return base;
  const r = await tx.execute(sql`
    SELECT ref FROM (
      SELECT p.billing_price_ref AS ref FROM core.plan p
       WHERE p.id <> ${planId} AND p.billing_price_ref IS NOT NULL
         AND p.billing_price_ref IN (
           SELECT jsonb_array_elements_text(${JSON.stringify(metered)}::jsonb))
      UNION ALL
      SELECT ${base}::text AS ref FROM core.plan p
       WHERE p.id <> ${planId} AND ${base}::text IS NOT NULL
         AND ${base}::text = ANY(p.billing_metered_price_refs)
    ) clash LIMIT 1`);
  const row = r.rows[0];
  return row === undefined ? undefined : String(row["ref"]);
}
