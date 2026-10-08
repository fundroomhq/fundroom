import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * The counts behind plan quotas and the usage rollup (E3.10). Raw SQL on the caller's transaction,
 * in whatever context it is in: `core.membership`, `core.invite` and `core.custom_domain` admit
 * every actor of the workspace (staff, external, system), `core.tenant_usage_daily` its staff and
 * system actors — so the counts are the same whoever triggers the check.
 *
 * "Live" seats: a membership that is not revoked or suspended and not past its `expires_at`
 * (`invited`, `active` and `dormant` all hold a seat). Investor seats count `role = 'investor'`
 * only — a delegate acts for an investor and is capped per principal (E3.2), not by the plan.
 */

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

export interface WorkspaceQuotaRow {
  readonly planId: string | null;
  /** The plan's `limits` jsonb (unparsed); `null` without a plan. */
  readonly limits: unknown;
}

/** The workspace's plan and its limits in one read, no lock. `undefined`: no such workspace. */
export async function selectWorkspaceQuota(
  tx: Tx,
  workspaceId: string,
): Promise<WorkspaceQuotaRow | undefined> {
  const r = await tx.execute<{ plan_id: string | null; limits: unknown }>(sql`
    SELECT w.plan_id, p.limits
      FROM core.workspace w
      LEFT JOIN core.plan p ON p.id = w.plan_id
     WHERE w.id = ${workspaceId}`);
  const row = r.rows[0];
  return row === undefined ? undefined : { planId: row.plan_id, limits: row.limits ?? null };
}

/**
 * The quota lock: the workspace row, `FOR NO KEY UPDATE` until commit — the same row and mode
 * `lockAuditChain` takes first, so it adds no new edge to the global lock order (entity rows /
 * feature locks → workspace row → audit chain). Every seat or domain write audits in the same
 * transaction, so it would take this row anyway; the check only takes it earlier. That matters:
 * the access-request approvals already hold the row (`lockWorkspaceFacts`) when they write their
 * invitation, so a separate advisory lock taken here would be acquired AFTER the row there and
 * BEFORE it on a plain invite — a cycle. Taken only when a plan limits the kind being added.
 */
export async function lockWorkspaceForQuota(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM core.workspace WHERE id = ${workspaceId} FOR NO KEY UPDATE`);
}

const LIVE_MEMBERSHIP = sql`status IN ('invited', 'active', 'dormant') AND (expires_at IS NULL OR expires_at > now())`;

/** Live staff memberships (+ pending, unexpired staff invitations when `withInvites`). */
export async function countStaffSeats(
  tx: Tx,
  workspaceId: string,
  options: { readonly withInvites: boolean },
): Promise<number> {
  const r = await tx.execute<{ members: string; invites: string }>(sql`
    SELECT (SELECT count(*) FROM core.membership
             WHERE workspace_id = ${workspaceId} AND kind = 'staff' AND ${LIVE_MEMBERSHIP}) AS members,
           ${
             options.withInvites
               ? sql`(SELECT count(*) FROM core.invite
                       WHERE workspace_id = ${workspaceId} AND kind = 'staff'
                         AND status = 'pending' AND expires_at > now())`
               : sql`0`
} AS invites`);
  const row = r.rows[0];
  return n(row?.members) + n(row?.invites);
}

/** Live investor memberships (+ pending, unexpired investor invitations when `withInvites`). */
export async function countInvestorSeats(
  tx: Tx,
  workspaceId: string,
  options: { readonly withInvites: boolean },
): Promise<number> {
  const r = await tx.execute<{ members: string; invites: string }>(sql`
    SELECT (SELECT count(*) FROM core.membership
             WHERE workspace_id = ${workspaceId} AND kind = 'external' AND role = 'investor'
               AND ${LIVE_MEMBERSHIP}) AS members,
           ${
             options.withInvites
               ? sql`(SELECT count(*) FROM core.invite
                       WHERE workspace_id = ${workspaceId} AND kind = 'external'
                         AND role = 'investor' AND status = 'pending' AND expires_at > now())`
               : sql`0`
} AS invites`);
  const row = r.rows[0];
  return n(row?.members) + n(row?.invites);
}

/** Custom domains that are not deleted and not `failed` (a failed row claims nothing). */
export async function countCustomDomains(tx: Tx, workspaceId: string): Promise<number> {
  const r = await tx.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM core.custom_domain
     WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL AND status <> 'failed'`);
  return n(r.rows[0]?.c);
}

/** `storage_bytes` of the newest usage row (0 before the first rollup). */
export async function latestStorageBytes(tx: Tx, workspaceId: string): Promise<number> {
  const r = await tx.execute<{ b: string | null }>(sql`
    SELECT storage_bytes AS b FROM core.tenant_usage_daily
     WHERE workspace_id = ${workspaceId}
     ORDER BY day DESC LIMIT 1`);
  return n(r.rows[0]?.b);
}
