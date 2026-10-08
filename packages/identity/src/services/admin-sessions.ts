import {
  type Membership,
  type MembershipRole,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AuthError } from "../errors.js";
import { describeUserAgent } from "../mail/templates.js";
import {
  consumeWorkspaceChallenges,
  findWorkspaceSession,
  listLiveWorkspaceSessions,
  type RevokedSessionRow,
  revokeWorkspaceSessions,
  workspaceMemberUserIds,
} from "../repos/admin-session-repo.js";
import { listWorkspaceMembershipsForUser, MembershipRepo } from "../repos/membership-repo.js";
import type { IdentityDeps } from "./types.js";

/*
 * Member sessions, as a workspace admin sees them (E2.7 package B1).
 *
 * A session is a global row (`core.session`), but the only sessions a workspace may list or
 * revoke are those whose `last_workspace_id` is that workspace: a session that last served
 * another workspace is the other tenant's fact, and "revoke" there would sign the person out of
 * a workspace this admin has no say over. Every query is scoped that way (admin-session-repo.ts).
 *
 * Target rules: an external target needs `access.manage` (the route's gate); a staff target also
 * needs `access.manage_staff`; an owner's sessions may be revoked only by an owner.
 *
 * Transactions are strictly sequenced, never nested (pool-deadlock rule): the target membership
 * is read in a tenant transaction, the sessions are revoked in a host transaction (with the
 * `session.revoked` outbox rows), and the audit row is written in a second tenant transaction.
 * Revocation is not reversible, so the audit row trails the change rather than wrapping it — the
 * same order `SessionService.revokeSessionsForWorkspace` uses.
 *
 * A revoked session that was viewing the portal as an investor ends that view: each such row gets
 * the `access.view_as_ended` (`reason: "session_revoked"`) that `SessionService.revokeSession`
 * writes, in the viewed workspace, so every `access.view_as_started` trail is closed whichever
 * path signed the staff member out.
 *
 * **Sessions are global.** A session is one sign-in of a person, not one per workspace: the
 * workspace a session "belongs to" here is only the one it last served (`last_workspace_id`).
 * Revoking it signs that person out of *every* workspace they were using it for — a person who
 * is a member of two workspaces and last used this one is signed out of the other one too (and
 * signs in again there). This is deliberate: a session cannot be half-revoked, and "unbinding"
 * it from this workspace would leave a sign-in that an admin asked to end still able to reach
 * this workspace the moment it served another one. The route descriptions and the admin UI say
 * so.
 */

export const ADMIN_REVOKE_REASON = "admin";

export interface AdminActor {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  /** The caller's current session; never revoked by a workspace-wide revoke. */
  readonly sessionId: string;
  /** Holds `access.manage_staff`. */
  readonly canManageStaff: boolean;
}

export interface MemberSessionSummary {
  readonly id: string;
  readonly deviceName: string | null;
  readonly device: string;
  readonly ip: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly authLevel: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface AdminSessionService {
  /** Live sessions of the member that last served this workspace. `not_found` for no member. */
  list(ctx: TenantContext, membershipId: string): Promise<MemberSessionSummary[]>;
  /** `not_found` when the session is unknown, not the member's, or serves another workspace. */
  revoke(
    ctx: TenantContext,
    membershipId: string,
    sessionId: string,
    actor: AdminActor,
    requestId?: string | null | undefined,
  ): Promise<void>;
  /** Every this-workspace session of the member, plus their outstanding login challenges here. */
  revokeAllForMember(
    ctx: TenantContext,
    membershipId: string,
    actor: AdminActor,
    requestId?: string | null | undefined,
  ): Promise<number>;
  /**
   * Danger zone: every this-workspace session of every external member, and of every staff
   * member too when `includeStaff` (the caller's current session always survives).
   */
  revokeWorkspace(
    ctx: TenantContext,
    input: { readonly includeStaff: boolean; readonly requestId?: string | null | undefined },
    actor: AdminActor,
  ): Promise<number>;
  /**
   * Workspace deletion: every live session that last served the workspace, whoever holds it.
   * Audits nothing itself (the caller's `workspace.deleted` row carries the count) except the
   * `access.view_as_ended` of a revoked session that was viewing as an investor.
   */
  revokeAllInWorkspace(
    workspaceId: string,
    reason: string,
    requestId?: string | null | undefined,
  ): Promise<number>;
}

function assertMayTouch(target: Membership, actor: AdminActor): void {
  if (target.kind === "staff" && !actor.canManageStaff)
    throw new AuthError("forbidden", "your role cannot manage staff sessions");
  if (target.role === "owner" && actor.role !== "owner")
    throw new AuthError("forbidden", "only an owner can revoke an owner's sessions");
}

async function publishRevoked(
  tx: Tx,
  revoked: readonly { userId: string }[],
  workspaceId: string,
  reason: string,
): Promise<void> {
  const byUser = new Map<string, number>();
  for (const r of revoked) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + 1);
  for (const [userId, count] of byUser)
    await publish(tx, { actorKind: "host" }, "session.revoked", {
      userId,
      count,
      reason,
      workspaceId,
    });
}

export function createAdminSessionService(
  deps: Pick<IdentityDeps, "db" | "audit" | "now" | "log">,
): AdminSessionService {
  const now = () => deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});

  async function member(ctx: TenantContext, membershipId: string): Promise<Membership> {
    const m = await deps.db.withTenant(ctx, (tx) => new MembershipRepo(ctx, tx).byId(membershipId));
    if (m === undefined) throw new AuthError("not_found", "no such member");
    return m;
  }

  /** Closes the view-as trail of every revoked session that was viewing as an investor. */
  async function endViews(
    revoked: readonly RevokedSessionRow[],
    requestId: string | null | undefined,
  ): Promise<void> {
    const at = now().getTime();
    for (const r of revoked) {
      if (
        r.viewAsWorkspaceId === null ||
        r.viewAsMembershipId === null ||
        r.viewAsUntil === null ||
        r.viewAsUntil.getTime() <= at
      )
        continue;
      const workspaceId = r.viewAsWorkspaceId;
      const staff = await deps.db.withHost((tx) => listWorkspaceMembershipsForUser(tx, r.userId), {
        actorKind: "host",
        userId: r.userId,
      });
      await deps.audit.recordDetached(systemContext(workspaceId), {
        action: "access.view_as_ended",
        resourceKind: "membership",
        resourceId: r.viewAsMembershipId,
        subjectMembershipId: r.viewAsMembershipId,
        actorKind: "staff",
        actorMembershipId: staff.find((m) => m.workspaceId === workspaceId)?.id ?? null,
        actorUserId: r.userId,
        sessionId: r.id,
        ...(requestId === undefined || requestId === null ? {} : { requestId }),
        meta: { reason: "session_revoked" },
      });
    }
  }

  async function audit(
    ctx: TenantContext,
    input: Parameters<IdentityDeps["audit"]["record"]>[2],
  ): Promise<void> {
    await deps.db.withTenant(ctx, (tx) => deps.audit.record(tx, ctx, input));
  }

  return {
    async list(ctx, membershipId) {
      const m = await member(ctx, membershipId);
      const rows = await deps.db.withHost((tx) =>
        listLiveWorkspaceSessions(tx, [m.userId], ctx.workspaceId, now()),
      );
      return rows.map((r) => ({
        id: r.id,
        deviceName: r.deviceName,
        device: describeUserAgent(r.userAgent),
        ip: r.ip,
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        authLevel: r.authLevel,
        idleExpiresAt: r.idleExpiresAt,
        absoluteExpiresAt: r.absoluteExpiresAt,
      }));
    },

    async revoke(ctx, membershipId, sessionId, actor, requestId) {
      const m = await member(ctx, membershipId);
      assertMayTouch(m, actor);
      const revoked = await deps.db.withHost(async (tx) => {
        const found = await findWorkspaceSession(tx, sessionId, m.userId, ctx.workspaceId, now());
        if (found === undefined) return [];
        const rows = await revokeWorkspaceSessions(tx, {
          workspaceId: ctx.workspaceId,
          userIds: [m.userId],
          sessionId,
          reason: ADMIN_REVOKE_REASON,
        });
        await publishRevoked(tx, rows, ctx.workspaceId, ADMIN_REVOKE_REASON);
        return rows;
      });
      if (revoked.length === 0) throw new AuthError("not_found", "no such session");
      await endViews(revoked, requestId);
      await audit(ctx, {
        action: "access.session_revoked",
        resourceKind: "session",
        resourceId: sessionId,
        subjectMembershipId: membershipId,
        sessionId: actor.sessionId,
        requestId: requestId ?? null,
        meta: { reason: ADMIN_REVOKE_REASON },
      });
      log("access.session_revoked", { workspaceId: ctx.workspaceId, membershipId, sessionId });
    },

    async revokeAllForMember(ctx, membershipId, actor, requestId) {
      const m = await member(ctx, membershipId);
      assertMayTouch(m, actor);
      const { revoked, challenges } = await deps.db.withHost(async (tx) => {
        const rows = await revokeWorkspaceSessions(tx, {
          workspaceId: ctx.workspaceId,
          userIds: [m.userId],
          // An admin revoking their own sessions keeps the one they are using.
          exceptSessionId: m.userId === actor.userId ? actor.sessionId : undefined,
          reason: ADMIN_REVOKE_REASON,
        });
        await publishRevoked(tx, rows, ctx.workspaceId, ADMIN_REVOKE_REASON);
        const burnt = await consumeWorkspaceChallenges(tx, m.userId, ctx.workspaceId, now());
        return { revoked: rows, challenges: burnt };
      });
      await endViews(revoked, requestId);
      await audit(ctx, {
        action: "access.sessions_revoked",
        resourceKind: "session",
        subjectMembershipId: membershipId,
        sessionId: actor.sessionId,
        requestId: requestId ?? null,
        meta: { reason: ADMIN_REVOKE_REASON, count: revoked.length, challenges },
      });
      log("access.sessions_revoked", {
        workspaceId: ctx.workspaceId,
        membershipId,
        revoked: revoked.length,
      });
      return revoked.length;
    },

    async revokeWorkspace(ctx, input, actor) {
      const userIds = await deps.db.withTenant(ctx, (tx) =>
        workspaceMemberUserIds(tx, ctx.workspaceId, input.includeStaff),
      );
      const revoked = await deps.db.withHost(async (tx) => {
        const rows = await revokeWorkspaceSessions(tx, {
          workspaceId: ctx.workspaceId,
          userIds,
          exceptSessionId: actor.sessionId,
          reason: ADMIN_REVOKE_REASON,
        });
        await publishRevoked(tx, rows, ctx.workspaceId, ADMIN_REVOKE_REASON);
        return rows;
      });
      await endViews(revoked, input.requestId);
      await audit(ctx, {
        action: "access.sessions_revoked_all",
        resourceKind: "session",
        sessionId: actor.sessionId,
        requestId: input.requestId ?? null,
        meta: {
          reason: ADMIN_REVOKE_REASON,
          includeStaff: input.includeStaff,
          count: revoked.length,
          users: new Set(revoked.map((r) => r.userId)).size,
        },
      });
      log("access.sessions_revoked_all", {
        workspaceId: ctx.workspaceId,
        includeStaff: input.includeStaff,
        revoked: revoked.length,
      });
      return revoked.length;
    },

    async revokeAllInWorkspace(workspaceId, reason, requestId) {
      const rows = await deps.db.withHost(async (tx) => {
        const revoked = await revokeWorkspaceSessions(tx, { workspaceId, reason });
        await publishRevoked(tx, revoked, workspaceId, reason);
        return revoked;
      });
      await endViews(rows, requestId);
      return rows.length;
    },
  };
}
