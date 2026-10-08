import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";

const { membership, userIdentity } = core;

/**
 * The live membership (active, unexpired) of this workspace whose user owns `email` as an email
 * identity — how a booking's invitee is matched to a member at ingest. A user holds at most one
 * membership per workspace; the oldest row wins should that ever not hold.
 */
export async function liveMembershipByEmail(
  tx: Tx,
  ctx: TenantContext,
  email: string,
  at: Date,
): Promise<string | undefined> {
  const rows = await tx
    .select({ id: membership.id })
    .from(membership)
    .innerJoin(
      userIdentity,
      and(eq(userIdentity.userId, membership.userId), eq(userIdentity.type, "email")),
    )
    .where(
      and(
        eq(membership.workspaceId, ctx.workspaceId),
        eq(membership.status, "active"),
        or(isNull(membership.expiresAt), gt(membership.expiresAt, at)),
        sql`lower(${userIdentity.identifier}::text) = lower(${email})`,
      ),
    )
    .orderBy(asc(membership.createdAt), asc(membership.id))
    .limit(1);
  return rows[0]?.id;
}

/**
 * Every email identity of the user behind `membershipId` (lower-cased) — erasure matches bookings
 * by all of them, as ingest matches an invitee against any of them. Read BEFORE the identity is
 * pseudonymised (the identity step runs `core.erase_user_identity` last).
 */
export async function emailIdentitiesOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ email: userIdentity.identifier })
    .from(membership)
    .innerJoin(
      userIdentity,
      and(eq(userIdentity.userId, membership.userId), eq(userIdentity.type, "email")),
    )
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)));
  return [...new Set(rows.map((r) => String(r.email).toLowerCase()))];
}
