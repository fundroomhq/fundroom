import {
  core,
  type SubscriptionRow,
  type SubscriptionStatusValue,
  type SuspendReasonValue,
  type Tx,
  type WorkspaceStatusValue,
} from "@fundroom/db";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

const { subscription, billingEvent, workspace, plan, tenantUsageDaily } = core;

/*
 * The SQL behind `@fundroom/billing` (E3.10). `core.subscription` is fenced to its workspace but
 * admits the host (the webhook finds a row by provider id before it knows the workspace), tenant
 * staff read their own, and only host/system write. `core.billing_event` is host only.
 */

export type { SubscriptionRow };

/** The transaction-local `app.*` settings, as the caller left them. */
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

export async function restoreTxContext(tx: Tx, ctx: TxContextSnapshot): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true),
           set_config('app.actor_kind', ${ctx.actorKind}, true),
           set_config('app.membership_id', ${ctx.membershipId}, true),
           set_config('app.user_id', ${ctx.userId}, true)`);
}

/** Switches the open transaction to `workspaceId`'s `system` actor (audit fence, guard trigger). */
export async function enterSystemContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${workspaceId}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}

// --- subscriptions --------------------------------------------------------------------------

export async function findSubscription(
  tx: Tx,
  workspaceId: string,
): Promise<SubscriptionRow | undefined> {
  const rows = await tx
    .select()
    .from(subscription)
    .where(eq(subscription.workspaceId, workspaceId))
    .limit(1);
  return rows[0];
}

/** The workspace's row, locked `FOR UPDATE` (taken before any audit: lock order). */
export async function lockSubscription(
  tx: Tx,
  workspaceId: string,
): Promise<SubscriptionRow | undefined> {
  const rows = await tx
    .select()
    .from(subscription)
    .where(eq(subscription.workspaceId, workspaceId))
    .limit(1)
    .for("update");
  return rows[0];
}

/** The row holding this provider subscription id, locked. Host context. */
export async function lockByProviderSubscription(
  tx: Tx,
  providerSubscriptionId: string,
): Promise<SubscriptionRow | undefined> {
  const rows = await tx
    .select()
    .from(subscription)
    .where(eq(subscription.providerSubscriptionId, providerSubscriptionId))
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * The rows holding this provider customer id, locked. Host context. More than one would mean two
 * workspaces share a customer — which our checkout never does — and the caller refuses to map it.
 */
export async function lockByProviderCustomer(
  tx: Tx,
  providerCustomerId: string,
): Promise<SubscriptionRow[]> {
  return tx
    .select()
    .from(subscription)
    .where(eq(subscription.providerCustomerId, providerCustomerId))
    .limit(2)
    .for("update");
}

export interface SubscriptionWrite {
  readonly planId: string;
  readonly provider: "manual" | "stripe";
  readonly status: SubscriptionStatusValue;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly graceUntil: Date | null;
  readonly lastEventAt: Date | null;
}

export async function insertSubscription(
  tx: Tx,
  workspaceId: string,
  row: SubscriptionWrite,
): Promise<void> {
  await tx.insert(subscription).values({ workspaceId, ...row });
}

/**
 * Inserts the workspace's row unless one exists; `false` when another transaction got there first
 * (a concurrent insert waits on the primary key and then does nothing).
 */
export async function insertSubscriptionIfAbsent(
  tx: Tx,
  workspaceId: string,
  row: SubscriptionWrite,
): Promise<boolean> {
  const rows = await tx
    .insert(subscription)
    .values({ workspaceId, ...row })
    .onConflictDoNothing({ target: subscription.workspaceId })
    .returning({ workspaceId: subscription.workspaceId });
  return rows.length > 0;
}

export async function updateSubscription(
  tx: Tx,
  workspaceId: string,
  row: Partial<SubscriptionWrite>,
): Promise<void> {
  await tx
    .update(subscription)
    .set({ ...row, version: sql`${subscription.version} + 1` })
    .where(eq(subscription.workspaceId, workspaceId));
}

// --- dedupe -----------------------------------------------------------------------------------

export async function billingEventSeen(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: billingEvent.id })
    .from(billingEvent)
    .where(eq(billingEvent.id, id))
    .limit(1);
  return rows.length > 0;
}

/**
 * Claims a provider event id: `true` when this transaction inserted it, `false` when it was
 * already there (a concurrent delivery waits on the primary key until the first commits).
 */
export async function claimBillingEvent(
  tx: Tx,
  row: { id: string; provider: "manual" | "stripe"; type: string; workspaceId: string | null },
): Promise<boolean> {
  const rows = await tx
    .insert(billingEvent)
    .values({ ...row, type: row.type.slice(0, 128) })
    .onConflictDoNothing({ target: billingEvent.id })
    .returning({ id: billingEvent.id });
  return rows.length > 0;
}

export async function setBillingEventWorkspace(
  tx: Tx,
  id: string,
  workspaceId: string,
): Promise<void> {
  await tx.update(billingEvent).set({ workspaceId }).where(eq(billingEvent.id, id));
}

/** Deletes `core.billing_event` rows received before `before`; returns how many. */
export async function deleteBillingEventsBefore(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .delete(billingEvent)
    .where(lt(billingEvent.receivedAt, before))
    .returning({ id: billingEvent.id });
  return rows.length;
}

// --- workspaces and plans -------------------------------------------------------------------

export interface BillingWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly planId: string | null;
  readonly status: WorkspaceStatusValue;
  readonly suspendedReason: SuspendReasonValue | null;
  readonly holds: readonly string[];
  readonly deletedAt: Date | null;
}

export async function findWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<BillingWorkspace | undefined> {
  const rows = await tx
    .select({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      legalName: workspace.legalName,
      planId: workspace.planId,
      status: workspace.status,
      suspendedReason: workspace.suspendedReason,
      holds: workspace.holds,
      deletedAt: workspace.deletedAt,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0];
}

/** Nothing but billing (or nothing) holds the workspace: money matters to it (mail). */
export function onlyBillingHolds(ws: Pick<BillingWorkspace, "holds">): boolean {
  return ws.holds.every((h) => h === "billing");
}

/** Moves a workspace to another plan (host or system context: the guard trigger). */
export async function setWorkspacePlan(tx: Tx, workspaceId: string, planId: string): Promise<void> {
  await tx.update(workspace).set({ planId }).where(eq(workspace.id, workspaceId));
}

/**
 * The one unarchived plan carrying any of these provider prices, if exactly one does (a metered
 * price next to the base one belongs to no plan; two plans sharing a price are ambiguous).
 */
export async function findPlanIdByPriceRefs(
  tx: Tx,
  priceRefs: readonly string[],
): Promise<string | undefined> {
  if (priceRefs.length === 0) return undefined;
  const rows = await tx
    .select({ id: plan.id })
    .from(plan)
    .where(and(inArray(plan.billingPriceRef, [...priceRefs]), isNull(plan.archivedAt)))
    .limit(2);
  return rows.length === 1 ? rows[0]?.id : undefined;
}

/** A plan's provider price (`null`: free, or no such plan). */
export async function planPriceRef(tx: Tx, planId: string): Promise<string | null> {
  const rows = await tx
    .select({ priceRef: plan.billingPriceRef })
    .from(plan)
    .where(eq(plan.id, planId))
    .limit(1);
  return rows[0]?.priceRef ?? null;
}

// --- jobs ---------------------------------------------------------------------------------------

/** One keyset page: rows after `after` (workspace id order), at most `limit`. */
export interface Page {
  readonly after: string | null;
  readonly limit: number;
}

const afterId = (after: string | null) =>
  after === null ? undefined : sql`${subscription.workspaceId} > ${after}`;

/**
 * Workspaces whose grace has run out on a status the enforcement job suspends. Host context.
 * Only those without the `billing` flag (setting it again changes nothing, and listing them every
 * hour would crowd out the ones the job can act on), and not those merely held for sanctions
 * review (`pending_review`: not live yet — its grace is enforced once it is released). A flag
 * under an operator or sanctions suspension is set (billing's own; it outlives theirs).
 */
export async function listGraceExpired(
  tx: Tx,
  now: Date,
  statuses: readonly SubscriptionStatusValue[],
  page: Page,
): Promise<string[]> {
  const rows = await tx
    .select({ workspaceId: subscription.workspaceId })
    .from(subscription)
    .innerJoin(workspace, eq(workspace.id, subscription.workspaceId))
    .where(
      and(
        isNotNull(subscription.graceUntil),
        lt(subscription.graceUntil, now),
        inArray(subscription.status, [...statuses]),
        isNull(workspace.deletedAt),
        sql`NOT ('billing' = ANY(${workspace.holds}))`,
        sql`${workspace.status} <> 'pending_review'`,
        afterId(page.after),
      ),
    )
    .orderBy(subscription.workspaceId)
    .limit(page.limit);
  return rows.map((r) => r.workspaceId);
}

/**
 * Workspaces flagged `billing` whose subscription is in good standing again — whatever else holds
 * them (a paid-up flag under an operator suspension must still go). Host context.
 */
export async function listRecovered(
  tx: Tx,
  statuses: readonly SubscriptionStatusValue[],
  page: Page,
): Promise<string[]> {
  const rows = await tx
    .select({ workspaceId: subscription.workspaceId })
    .from(subscription)
    .innerJoin(workspace, eq(workspace.id, subscription.workspaceId))
    .where(
      and(
        inArray(subscription.status, [...statuses]),
        sql`'billing' = ANY(${workspace.holds})`,
        isNull(workspace.deletedAt),
        afterId(page.after),
      ),
    )
    .orderBy(subscription.workspaceId)
    .limit(page.limit);
  return rows.map((r) => r.workspaceId);
}

/**
 * Local trials (no provider subscription behind them) that have ended, of workspaces that are not
 * deleted (a deleted one is owed no mail and has nothing left to suspend). Host context.
 */
export async function listExpiredLocalTrials(tx: Tx, now: Date, page: Page): Promise<string[]> {
  const rows = await tx
    .select({ workspaceId: subscription.workspaceId })
    .from(subscription)
    .innerJoin(workspace, eq(workspace.id, subscription.workspaceId))
    .where(
      and(
        eq(subscription.status, "trialing"),
        isNull(subscription.providerSubscriptionId),
        isNotNull(subscription.trialEnd),
        lt(subscription.trialEnd, now),
        isNull(workspace.deletedAt),
        afterId(page.after),
      ),
    )
    .orderBy(subscription.workspaceId)
    .limit(page.limit);
  return rows.map((r) => r.workspaceId);
}

export interface UsageReportRow {
  readonly workspaceId: string;
  readonly customerRef: string;
  readonly subscriptionRef: string;
  readonly staffSeats: number;
  readonly storageBytes: number;
}

/**
 * Stripe subscriptions that bill (not canceled) with that day's usage row. Host context; keyset
 * paged on workspace id.
 */
export async function listUsageToReport(
  tx: Tx,
  day: string,
  after: string | null,
  limit: number,
): Promise<UsageReportRow[]> {
  const rows = await tx
    .select({
      workspaceId: subscription.workspaceId,
      customerRef: subscription.providerCustomerId,
      subscriptionRef: subscription.providerSubscriptionId,
      staffSeats: tenantUsageDaily.staffSeats,
      storageBytes: tenantUsageDaily.storageBytes,
    })
    .from(subscription)
    .innerJoin(
      tenantUsageDaily,
      and(
        eq(tenantUsageDaily.workspaceId, subscription.workspaceId),
        eq(tenantUsageDaily.day, day),
      ),
    )
    .where(
      and(
        eq(subscription.provider, "stripe"),
        isNotNull(subscription.providerCustomerId),
        isNotNull(subscription.providerSubscriptionId),
        inArray(subscription.status, ["trialing", "active", "past_due", "unpaid"]),
        after === null ? undefined : sql`${subscription.workspaceId} > ${after}`,
      ),
    )
    .orderBy(subscription.workspaceId)
    .limit(limit);
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    customerRef: r.customerRef as string,
    subscriptionRef: r.subscriptionRef as string,
    staffSeats: Number(r.staffSeats),
    storageBytes: Number(r.storageBytes),
  }));
}
