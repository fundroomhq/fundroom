import { core, type Tx } from "@fundroom/db";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { revokeDerivedOf } from "./session-repo.js";

const { session, device, user, userIdentity, authChallenge } = core;

/*
 * Host-context queries behind the admin's view of a member's sessions (E2.7 package B1).
 *
 * `core.session` is a global table: a tenant transaction cannot see it at all (its fence admits
 * only the host and the session's own user). Every query here therefore runs under `withHost`,
 * and every one of them is scoped by `last_workspace_id = <this workspace>` — a session that last
 * served another workspace is that workspace's fact, and an admin here may neither list nor
 * revoke it. Callers resolve the user ids from *this* workspace's memberships first, in their
 * own tenant transaction, and only then open the host transaction (never nested: pool deadlock).
 */

/** Live = not revoked, not past either expiry, and the user's session_version still matches. */
function live(now: Date) {
  return and(
    isNull(session.revokedAt),
    gt(session.idleExpiresAt, now),
    gt(session.absoluteExpiresAt, now),
    eq(session.sessionVersion, user.sessionVersion),
    isNull(user.deletedAt),
  );
}

export interface AdminSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly deviceName: string | null;
  readonly userAgent: string;
  readonly ip: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly authLevel: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

/** Live sessions of these users that last served `workspaceId`, newest activity first. */
export async function listLiveWorkspaceSessions(
  tx: Tx,
  userIds: readonly string[],
  workspaceId: string,
  now: Date,
): Promise<AdminSessionRow[]> {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({
      id: session.id,
      userId: session.userId,
      deviceName: device.name,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      authLevel: session.authLevel,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .leftJoin(device, eq(device.id, session.deviceId))
    .where(
      and(
        inArray(session.userId, [...userIds]),
        eq(session.lastWorkspaceId, workspaceId),
        live(now),
      ),
    )
    .orderBy(desc(session.lastSeenAt));
  return rows.map((r) => ({
    ...r,
    deviceName: r.deviceName && r.deviceName.length > 0 ? r.deviceName : null,
    ip: r.ip ?? null,
  }));
}

export interface WorkspaceSessionActivity {
  readonly userId: string;
  /** Latest `last_seen_at` of any session row (live or not) that last served the workspace. */
  readonly lastSeenAt: Date | null;
  readonly liveSessions: number;
}

/** Per-user session activity in one workspace as of `now`, for the access review report. */
export async function workspaceSessionActivity(
  tx: Tx,
  userIds: readonly string[],
  workspaceId: string,
  now: Date,
): Promise<Map<string, WorkspaceSessionActivity>> {
  const out = new Map<string, WorkspaceSessionActivity>();
  if (userIds.length === 0) return out;
  // Live *as of `now`*: the access review rebuilds a report as of the `generatedAt` a reviewer
  // attests to, so a session signed in or out after that instant must not change the count.
  const liveCase = sql<number>`count(*) FILTER (WHERE ${session.createdAt} <= ${now}
      AND (${session.revokedAt} IS NULL OR ${session.revokedAt} > ${now})
      AND ${session.idleExpiresAt} > ${now} AND ${session.absoluteExpiresAt} > ${now}
      AND ${session.sessionVersion} = ${user.sessionVersion} AND ${user.deletedAt} IS NULL)`;
  const rows = await tx
    .select({
      userId: session.userId,
      lastSeenAt: sql<Date | string | null>`max(${session.lastSeenAt})`,
      liveSessions: liveCase,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(inArray(session.userId, [...userIds]), eq(session.lastWorkspaceId, workspaceId)))
    .groupBy(session.userId);
  for (const r of rows) {
    // Aggregates come back through the raw path: timestamptz as text, count as a string.
    const last = r.lastSeenAt === null ? null : new Date(r.lastSeenAt);
    out.set(r.userId, { userId: r.userId, lastSeenAt: last, liveSessions: Number(r.liveSessions) });
  }
  return out;
}

/** One session, only if it belongs to `userId` and last served `workspaceId`. */
export async function findWorkspaceSession(
  tx: Tx,
  sessionId: string,
  userId: string,
  workspaceId: string,
  now: Date,
): Promise<{ id: string } | undefined> {
  const rows = await tx
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        eq(session.lastWorkspaceId, workspaceId),
        live(now),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface RevokedSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly viewAsWorkspaceId: string | null;
  readonly viewAsMembershipId: string | null;
  readonly viewAsStartedAt: Date | null;
  readonly viewAsUntil: Date | null;
}

/**
 * Revokes the live sessions that last served `workspaceId`: of `userIds` when given, of every
 * user otherwise (workspace deletion). `exceptSessionId` keeps the caller signed in. Returns the
 * revoked rows' ids and users, and the view-as state each one held (so the caller can close the
 * `access.view_as_started` trail with an `access.view_as_ended`).
 */
export async function revokeWorkspaceSessions(
  tx: Tx,
  input: {
    readonly workspaceId: string;
    readonly userIds?: readonly string[] | undefined;
    readonly sessionId?: string | undefined;
    readonly exceptSessionId?: string | undefined;
    readonly reason: string;
  },
): Promise<RevokedSessionRow[]> {
  if (input.userIds !== undefined && input.userIds.length === 0) return [];
  const conds = [eq(session.lastWorkspaceId, input.workspaceId), isNull(session.revokedAt)];
  if (input.userIds !== undefined) conds.push(inArray(session.userId, [...input.userIds]));
  if (input.sessionId !== undefined) conds.push(eq(session.id, input.sessionId));
  if (input.exceptSessionId !== undefined)
    conds.push(sql`${session.id} <> ${input.exceptSessionId}`);
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: input.reason })
    .where(and(...conds))
    .returning({
      id: session.id,
      userId: session.userId,
      viewAsWorkspaceId: session.viewAsWorkspaceId,
      viewAsMembershipId: session.viewAsMembershipId,
      viewAsStartedAt: session.viewAsStartedAt,
      viewAsUntil: session.viewAsUntil,
    });
  // What those sessions handed out goes with them (E3.10 FR4), as on a sign-out.
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows;
}

/**
 * Burns the user's outstanding login challenges (OTP codes, magic links) *for this workspace*,
 * so a revoke-all is not undone by a link already sitting in the member's inbox. Host-level
 * challenges (`workspace_id IS NULL`) are not this workspace's to burn.
 */
export async function consumeWorkspaceChallenges(
  tx: Tx,
  userId: string,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const emails = tx
    .select({ identifier: userIdentity.identifier })
    .from(userIdentity)
    .where(and(eq(userIdentity.userId, userId), eq(userIdentity.type, "email")));
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authChallenge.workspaceId, workspaceId),
        isNull(authChallenge.consumedAt),
        gt(authChallenge.expiresAt, now),
        or(eq(authChallenge.userId, userId), inArray(authChallenge.email, emails)),
      ),
    )
    .returning({ id: authChallenge.id });
  return rows.length;
}

/**
 * Tenant context: the user ids behind this workspace's non-revoked memberships — external only,
 * or staff too. The workspace-wide revoke reads this first, then revokes in a host transaction.
 */
export async function workspaceMemberUserIds(
  tx: Tx,
  workspaceId: string,
  includeStaff: boolean,
): Promise<string[]> {
  const { membership } = core;
  const conds = [eq(membership.workspaceId, workspaceId), ne(membership.status, "revoked")];
  if (!includeStaff) conds.push(eq(membership.kind, "external"));
  const rows = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(and(...conds));
  return [...new Set(rows.map((r) => r.userId))];
}
