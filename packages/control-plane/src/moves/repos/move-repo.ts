import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * The SQL behind moves between cells (E3.11, ADR-0059). Raw statements on the caller's
 * transaction; the workspace's control-plane columns are written in the host or system context
 * (the `workspace_control_plane_guard` trigger refuses tenant actors). Timestamps come back as
 * text on the raw `execute` path and are coerced here.
 */

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function dateOf(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

export interface MoveSourceRow {
  readonly id: string;
  readonly slug: string;
  readonly cellId: string;
  readonly holds: readonly string[];
  readonly planId: string | null;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly deletedAt: Date | null;
  readonly purgedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly legalHold: boolean;
}

interface RawSource {
  id: string;
  slug: string;
  cell_id: string;
  holds: string[] | string;
  plan_id: string | null;
  legal_name: string | null;
  country: string | null;
  deleted_at: unknown;
  purged_at: unknown;
  purge_after: unknown;
  legal_hold: boolean | null;
}

function textArray(v: string[] | string): string[] {
  if (Array.isArray(v)) return v;
  const inner = v.replace(/^\{|\}$/gu, "");
  return inner.length === 0 ? [] : inner.split(",");
}

function toSource(r: RawSource): MoveSourceRow {
  return {
    id: r.id,
    slug: r.slug,
    cellId: r.cell_id,
    holds: textArray(r.holds),
    planId: r.plan_id,
    legalName: r.legal_name,
    country: r.country,
    deletedAt: dateOf(r.deleted_at),
    purgedAt: dateOf(r.purged_at),
    purgeAfter: dateOf(r.purge_after),
    legalHold: r.legal_hold === true,
  };
}

const SOURCE_COLUMNS = sql`id::text AS id, slug, cell_id, holds, plan_id, legal_name, country,
  deleted_at, purged_at, purge_after,
  coalesce((settings #>> '{legal,legalHold}')::boolean, false) AS legal_hold`;

/**
 * The workspace row, locked `FOR NO KEY UPDATE` (the mode `lockAuditChain` takes first, so an
 * erasure request or any audited write waits behind it). Host or system context.
 */
export async function lockMoveWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<MoveSourceRow | undefined> {
  const r = rowsOf<RawSource>(
    await tx.execute(sql`SELECT ${SOURCE_COLUMNS} FROM core.workspace
      WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`),
  );
  return r[0] === undefined ? undefined : toSource(r[0]);
}

export async function readMoveWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<MoveSourceRow | undefined> {
  const r = rowsOf<RawSource>(
    await tx.execute(sql`SELECT ${SOURCE_COLUMNS} FROM core.workspace
      WHERE id = ${workspaceId}::uuid`),
  );
  return r[0] === undefined ? undefined : toSource(r[0]);
}

/** Erasure requests of the workspace: still open, and ever recorded (any status). */
export async function erasureCounts(
  tx: Tx,
  workspaceId: string,
): Promise<{ readonly open: number; readonly total: number }> {
  const r = rowsOf<{ open: number; total: number }>(
    await tx.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'requested')::int AS open, count(*)::int AS total
        FROM core.dsar_request WHERE workspace_id = ${workspaceId}::uuid AND kind = 'erasure'`),
  );
  return { open: Number(r[0]?.open ?? 0), total: Number(r[0]?.total ?? 0) };
}

/** The billing binding a move carries (the provider's ids travel with the workspace). */
export interface CarriedSubscription {
  readonly planId: string;
  readonly provider: string;
  readonly status: string;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly trialEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly graceUntil: string | null;
  readonly lastEventAt: string | null;
}

function isoOrNull(v: unknown): string | null {
  const d = dateOf(v);
  return d === null ? null : d.toISOString();
}

export async function readSubscription(
  tx: Tx,
  workspaceId: string,
): Promise<CarriedSubscription | null> {
  const r = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT plan_id, provider, status, provider_customer_id, provider_subscription_id,
             current_period_end, trial_end, cancel_at_period_end, grace_until, last_event_at
        FROM core.subscription WHERE workspace_id = ${workspaceId}::uuid`),
  );
  const row = r[0];
  if (row === undefined) return null;
  return {
    planId: String(row["plan_id"]),
    provider: String(row["provider"]),
    status: String(row["status"]),
    providerCustomerId: (row["provider_customer_id"] as string | null) ?? null,
    providerSubscriptionId: (row["provider_subscription_id"] as string | null) ?? null,
    currentPeriodEnd: isoOrNull(row["current_period_end"]),
    trialEnd: isoOrNull(row["trial_end"]),
    cancelAtPeriodEnd: row["cancel_at_period_end"] === true,
    graceUntil: isoOrNull(row["grace_until"]),
    lastEventAt: isoOrNull(row["last_event_at"]),
  };
}

/** The target's copy of the binding (system context of the new workspace). */
export async function insertSubscription(
  tx: Tx,
  workspaceId: string,
  s: CarriedSubscription,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id,
      provider_subscription_id, current_period_end, trial_end, cancel_at_period_end, grace_until,
      last_event_at)
    VALUES (${workspaceId}::uuid, ${s.planId}, ${s.provider}, ${s.status}, ${s.providerCustomerId},
      ${s.providerSubscriptionId}, ${s.currentPeriodEnd}::timestamptz, ${s.trialEnd}::timestamptz,
      ${s.cancelAtPeriodEnd}, ${s.graceUntil}::timestamptz, ${s.lastEventAt}::timestamptz)
    ON CONFLICT (workspace_id) DO NOTHING`);
}

/**
 * Locks the workspace's billing row (if any) BEFORE the workspace row: the billing webhook takes
 * the subscription and then the workspace (its hold), so the switchover must too.
 */
export async function lockSubscription(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM core.subscription WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`,
  );
}

/** The source's binding goes at the switchover: the target's copy is the only live one. */
export async function deleteSubscription(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM core.subscription WHERE workspace_id = ${workspaceId}::uuid`);
}

/** Hostnames of the workspace's live custom domains (re-added as pending on the target). */
export async function liveCustomDomains(tx: Tx, workspaceId: string): Promise<string[]> {
  const r = rowsOf<{ hostname: string }>(
    await tx.execute(sql`
      SELECT hostname::text AS hostname FROM core.custom_domain
       WHERE workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL ORDER BY created_at`),
  );
  return r.map((x) => x.hostname);
}

export async function planExists(tx: Tx, planId: string): Promise<boolean> {
  const r = rowsOf<{ ok: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM core.plan WHERE id = ${planId}) AS ok`),
  );
  return r[0]?.ok === true;
}

/**
 * Soft-deletes the source copy after a switchover: the ordinary purge machinery crypto-shreds it
 * once `purge_after` (switch + MOVE_SOURCE_RETENTION_HOURS) has passed. Idempotent.
 */
export async function markMovedAway(
  tx: Tx,
  workspaceId: string,
  at: Date,
  purgeAfter: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE core.workspace SET deleted_at = ${at.toISOString()}::timestamptz,
                              purge_after = ${purgeAfter.toISOString()}::timestamptz
     WHERE id = ${workspaceId}::uuid AND deleted_at IS NULL`);
}

/** Local workspaces carrying the `relocation` hold (the moves sweep's work list). */
export async function listRelocating(tx: Tx, limit: number): Promise<MoveSourceRow[]> {
  return rowsOf<RawSource>(
    await tx.execute(sql`SELECT ${SOURCE_COLUMNS} FROM core.workspace
      WHERE 'relocation' = ANY (holds) AND deleted_at IS NULL ORDER BY id LIMIT ${limit}`),
  ).map(toSource);
}

/** Live local workspaces using `slug` (a crashed import's copy is among them). Host context. */
export async function liveWorkspacesBySlug(tx: Tx, slug: string): Promise<string[]> {
  return rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT id::text AS id FROM core.workspace WHERE slug = ${slug} AND deleted_at IS NULL`),
  ).map((r) => r.id);
}

/** The move id recorded on a workspace's import, if it was a move's copy (its system context). */
export async function moveIdOfCopy(tx: Tx, workspaceId: string): Promise<string | undefined> {
  const r = rowsOf<{ move_id: string | null }>(
    await tx.execute(sql`
      SELECT source ->> 'moveId' AS move_id FROM core.workspace_import
       WHERE workspace_id = ${workspaceId}::uuid AND source ? 'moveId'
       ORDER BY imported_at DESC LIMIT 1`),
  );
  return r[0]?.move_id ?? undefined;
}

/**
 * The copy's billing binding as the source had it at the switch: replaced, or removed when the
 * source had none any more (its system context).
 */
export async function replaceSubscription(
  tx: Tx,
  workspaceId: string,
  s: CarriedSubscription | null,
): Promise<void> {
  await deleteSubscription(tx, workspaceId);
  if (s !== null) await insertSubscription(tx, workspaceId, s);
}

/**
 * Discards a failed or cancelled move's copy: deleted and due for the purge at once, and its
 * billing binding removed in the same transaction (fix R1-3: the provider ids are unique per
 * database, and a dead copy must never answer the provider's webhooks).
 */
export async function discardCopy(tx: Tx, workspaceId: string, at: Date): Promise<void> {
  await deleteSubscription(tx, workspaceId);
  await tx.execute(sql`
    UPDATE core.workspace SET deleted_at = ${at.toISOString()}::timestamptz,
                              purge_after = ${at.toISOString()}::timestamptz
     WHERE id = ${workspaceId}::uuid AND deleted_at IS NULL`);
}
