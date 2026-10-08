import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const { membership, effectiveAccess, effectiveAccessState, accessGrant, workspace } = core;

export interface MembershipLite {
  readonly id: string;
  readonly kind: "staff" | "external";
  readonly role: string;
  readonly status: string;
  /** `membership.expires_at`: past it the membership is not live (P1-01). */
  readonly expiresAt: Date | null;
  /**
   * A delegate's principal (E3.2): its status and expiry, read in the same statement. `null` for a
   * membership that is not a delegate. A delegate is live only while its principal is.
   */
  readonly principal: { readonly status: string; readonly expiresAt: Date | null } | null;
}

/** kind/role/status/expiry of one membership in the current workspace (RBAC + "is it live"). */
export async function membershipSummary(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<MembershipLite | undefined> {
  const principal = alias(membership, "principal");
  const rows = await tx
    .select({
      id: membership.id,
      kind: membership.kind,
      role: membership.role,
      status: membership.status,
      expiresAt: membership.expiresAt,
      principalId: principal.id,
      principalStatus: principal.status,
      principalExpiresAt: principal.expiresAt,
    })
    .from(membership)
    .leftJoin(
      principal,
      and(
        eq(principal.id, membership.principalMembershipId),
        eq(principal.workspaceId, membership.workspaceId),
      ),
    )
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)))
    .limit(1);
  const r = rows[0];
  if (r === undefined) return undefined;
  const isDelegate = r.role === "delegate";
  return {
    id: r.id,
    kind: r.kind,
    role: r.role,
    status: r.status,
    expiresAt: r.expiresAt,
    // A delegate whose principal row is missing reads as a principal that is not live.
    principal: !isDelegate
      ? null
      : r.principalId === null
        ? { status: "revoked", expiresAt: null }
        : { status: r.principalStatus ?? "revoked", expiresAt: r.principalExpiresAt },
  };
}

/**
 * Whether the workspace needs a rebuild that no `acl.changed` event will trigger: the
 * state is behind the version, a materialised row's validity ran out, or a rule whose
 * validity started after the last build has become live.
 */
export async function staleWorkspaces(tx: Tx, ctx: TenantContext, now: Date): Promise<boolean> {
  const ws = ctx.workspaceId;
  const state = (
    await tx
      .select()
      .from(effectiveAccessState)
      .where(eq(effectiveAccessState.workspaceId, ws))
      .limit(1)
  )[0];
  if (state === undefined) return true;
  const version = (
    await tx
      .select({ v: workspace.aclVersion })
      .from(workspace)
      .where(eq(workspace.id, ws))
      .limit(1)
  )[0];
  if (version !== undefined && Number(version.v) > Number(state.aclVersion)) return true;
  const expired = await tx
    .select({ one: sql<number>`1` })
    .from(effectiveAccess)
    .where(and(eq(effectiveAccess.workspaceId, ws), lte(effectiveAccess.expiresAt, now)))
    .limit(1);
  if (expired.length > 0) return true;
  const activated = await tx
    .select({ one: sql<number>`1` })
    .from(accessGrant)
    .where(
      and(
        eq(accessGrant.workspaceId, ws),
        isNull(accessGrant.revokedAt),
        gt(sql`lower(${accessGrant.validity})`, state.builtAt),
        lte(sql`lower(${accessGrant.validity})`, now),
      ),
    )
    .limit(1);
  return activated.length > 0;
}
