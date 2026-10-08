import { lockApiKeysOfMember } from "@fundroom/api-keys";
import { core, type TenantContext, type Tx } from "@fundroom/db";
import { lockESignEnvelopesOfMember } from "@fundroom/esign";
import { AccessRequestRepo, MembershipRepo } from "@fundroom/identity";
import { lockIntegrationBookingsOfMember } from "@fundroom/integrations";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

const {
  membership,
  invite,
  session,
  authChallenge,
  groupMember,
  accessGrant,
  scimUser,
  ssoConnection,
  userIdentity,
} = core;

/**
 * Everything the identity step (`../service/identity-erasure.ts`) will write under the workspace
 * row and the audit chain but other paths lock BEFORE them (the E3.5 LX global order: entity rows
 * → workspace row → chain), locked up front. Called at the start of every transaction that can
 * reach the identity step — `DsarRequestRepo.lockById` (erasure kind), `erasure.request`, and
 * (container) every `member.erasure_requested` subscriber — before its first audit entry.
 * Idempotent within a transaction; the step re-locks rows it already holds.
 *
 * Fixed order (each group in id order), matching the other paths that take the same rows:
 *  1. the member's API key rows (key cap advisory lock first) — E3.4 D1;
 *  2. the e-sign connection advisory lock, then the member's envelope rows — E3.5;
 *  2b. the workspace's booking advisory lock, then the member's recorded bookings (by membership
 *     or address) — E3.6, as booking ingest takes them;
 *  2c. the member's SCIM user rows (by membership or user, deleted ones too) — E3.8: SCIM takes a
 *     `scim_user` row before the membership it maps (suspend / role recompute / deprovision), so
 *     they sort before step 3. `scim_group_member` rows are neither locked nor written by the
 *     step (they carry ids only and survive the scrub), so the group paths cannot close a cycle;
 *  3. every staff owner row (`lockOwners`, NO KEY UPDATE) — as ownership transfer, owner
 *     revoke/demote and `identityBlockedBy` take them (R3B: an owner-changing path held the owner
 *     rows and waited for the workspace row the completing erasure held, 40P01);
 *  4. the membership, then its live delegates — as People revoke (target, then delegates),
 *     delegate add / invite resend (the principal), set-groups and login's activation/touch;
 *  5. their live group rows, then the invites the step or the revoke rewrites (accepted by the
 *     member, pending to the address, pending issued by or for them), then their live grants —
 *     the order `MembershipRepo.revoke` + `GrantRepo.revokeForMemberships` write them;
 *  6. the access requests that became the member or carried the address, then the address's
 *     access-request challenges (consumed: they cannot be row-locked) — as verify / approve /
 *     deny and invite acceptance take requests before the workspace row.
 * Login challenges, sessions, credentials, devices and user identities (E3.8: the SSO ones the
 * step deletes) are NOT here: they are only ever locked by host transactions that never take a
 * workspace row (sign-in, step-up, view-as, TOTP, SSO finish), so the step waiting for one under
 * the workspace row cannot close a cycle. Webhook deliveries are
 * deleted `SKIP LOCKED` by the step itself.
 */
export async function prelockErasureSubject(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<void> {
  await lockApiKeysOfMember(tx, ctx, membershipId);
  await lockESignEnvelopesOfMember(tx, ctx, membershipId);
  await lockIntegrationBookingsOfMember(tx, ctx, membershipId);
  const scope = (cond: ReturnType<typeof and>) =>
    and(eq(membership.workspaceId, ctx.workspaceId), cond);
  const subject = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(scope(eq(membership.id, membershipId)))
    .limit(1);
  await tx
    .select({ id: scimUser.id })
    .from(scimUser)
    .where(scimUsersOf(ctx.workspaceId, membershipId, subject[0]?.userId))
    .orderBy(asc(scimUser.id))
    .for("no key update");
  const memberships = new MembershipRepo(ctx, tx);
  await memberships.lockOwners();
  const target = await tx
    .select({ id: membership.id })
    .from(membership)
    .where(scope(eq(membership.id, membershipId)))
    .for("no key update");
  if (target.length === 0) return;
  const delegates = await tx
    .select({ id: membership.id })
    .from(membership)
    .where(
      scope(
        and(eq(membership.principalMembershipId, membershipId), ne(membership.status, "revoked")),
      ),
    )
    .orderBy(asc(membership.id))
    .for("no key update");
  const ids = [membershipId, ...delegates.map((d) => d.id)];
  await tx
    .select({ g: groupMember.groupId })
    .from(groupMember)
    .where(
      and(
        eq(groupMember.workspaceId, ctx.workspaceId),
        inArray(groupMember.membershipId, ids),
        isNull(groupMember.revokedAt),
      ),
    )
    .orderBy(asc(groupMember.groupId), asc(groupMember.membershipId))
    .for("no key update");
  const email = (await memberships.namesFor([membershipId])).get(membershipId)?.email ?? null;
  const pending = eq(invite.status, "pending");
  const issued = or(inArray(invite.invitedBy, ids), inArray(invite.principalMembershipId, ids));
  await tx
    .select({ id: invite.id })
    .from(invite)
    .where(
      and(
        eq(invite.workspaceId, ctx.workspaceId),
        or(
          eq(invite.acceptedMembershipId, membershipId),
          and(pending, issued),
          email === null
            ? undefined
            : and(pending, sql`lower(${invite.email}::text) = lower(${email})`),
        ),
      ),
    )
    .orderBy(asc(invite.id))
    .for("no key update");
  await tx
    .select({ id: accessGrant.id })
    .from(accessGrant)
    .where(
      and(
        eq(accessGrant.workspaceId, ctx.workspaceId),
        isNull(accessGrant.revokedAt),
        eq(accessGrant.subjectKind, "membership"),
        inArray(accessGrant.subjectId, ids),
      ),
    )
    .orderBy(asc(accessGrant.id))
    .for("no key update");
  await new AccessRequestRepo(ctx, tx).prelockForErasure(membershipId, email);
}

/** The SCIM user rows (E3.8) that describe the member in this workspace, deleted ones included. */
function scimUsersOf(workspaceId: string, membershipId: string, userId: string | undefined) {
  return and(
    eq(scimUser.workspaceId, workspaceId),
    userId === undefined
      ? eq(scimUser.membershipId, membershipId)
      : or(eq(scimUser.membershipId, membershipId), eq(scimUser.userId, userId)),
  );
}

/*
 * The kernel's identity-erasure step (E2.7 DSAR, contract §5): the per-workspace facts about a
 * person that no module owns — the membership profile, the invites that carried their address,
 * this workspace's sessions and login challenges — plus the one call that may pseudonymise the
 * global identity, `core.erase_user_identity` (migration 0012).
 *
 * Everything here runs on the caller's transaction. That is the point: the step runs inside the
 * transaction of whichever module reported last (an outbox handler), and a second pool
 * connection taken there is the deadlock this codebase keeps rediscovering.
 */

/**
 * An erased invite's address, in the shape 0012's `erase_user_identity` gives an identity:
 * `erased+<the row's own id, hex>@erased.invalid`. Keyed on the invite row, never on the address:
 * a digest of the address is reversible by anyone with a list of candidate addresses, and would
 * give the same person's invites in two separate erasures (erased, re-invited, erased again) the
 * same value. Unroutable, unique per row, and stable if the step ever runs twice.
 */
const invitePseudonym = sql`'erased+' || replace(${invite.id}::text, '-', '') || '@erased.invalid'`;

export interface MembershipIdentity {
  readonly userId: string;
  readonly status: string;
  readonly role: string;
}

export class IdentityErasureRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  async membership(membershipId: string): Promise<MembershipIdentity | undefined> {
    const rows = await this.tx
      .select({ userId: membership.userId, status: membership.status, role: membership.role })
      .from(membership)
      .where(and(eq(membership.workspaceId, this.ctx.workspaceId), eq(membership.id, membershipId)))
      .limit(1);
    return rows[0];
  }

  /** Profile → `{}`, the staff-written relationship note → null. Returns rows touched (0/1). */
  async scrubMembership(membershipId: string): Promise<number> {
    const rows = await this.tx
      .update(membership)
      .set({ profile: {}, relationshipNote: null })
      .where(and(eq(membership.workspaceId, this.ctx.workspaceId), eq(membership.id, membershipId)))
      .returning({ id: membership.id });
    return rows.length;
  }

  /**
   * Invites that carried the person's address in this workspace — the one they accepted, and any
   * still pending to the same address: the address becomes the pseudonym, the free-text message
   * (written to them, often naming them) is dropped, and a pending one is revoked.
   */
  async scrubInvites(membershipId: string, email: string | null): Promise<number> {
    const mine = eq(invite.acceptedMembershipId, membershipId);
    const match =
      email === null
        ? mine
        : or(
            mine,
            sql`lower(${invite.email}::text) = lower(${email}) AND ${invite.status} = 'pending'`,
          );
    const rows = await this.tx
      .update(invite)
      .set({
        email: invitePseudonym,
        message: null,
        status: sql`CASE WHEN ${invite.status} = 'pending' THEN 'revoked'::core.invite_status ELSE ${invite.status} END`,
        revokedAt: sql`CASE WHEN ${invite.status} = 'pending' THEN now() ELSE ${invite.revokedAt} END`,
      })
      .where(
        and(
          eq(invite.workspaceId, this.ctx.workspaceId),
          match,
          sql`${invite.email}::text NOT LIKE 'erased+%@erased.invalid'`,
        ),
      )
      .returning({ id: invite.id });
    return rows.length;
  }

  /** Outstanding login challenges of this workspace for the person (they carry the address). */
  async deleteChallenges(userId: string, email: string | null): Promise<number> {
    const who =
      email === null
        ? eq(authChallenge.userId, userId)
        : or(
            eq(authChallenge.userId, userId),
            sql`lower(${authChallenge.email}::text) = lower(${email})`,
          );
    const rows = await this.tx
      .delete(authChallenge)
      .where(and(eq(authChallenge.workspaceId, this.ctx.workspaceId), who))
      .returning({ id: authChallenge.id });
    return rows.length;
  }

  /**
   * Revokes the person's sessions that last served this workspace (or none yet) and scrubs their
   * network facts. A session serving another workspace is that tenant's fact and is left alone —
   * the global erasure, when it happens, takes all of them.
   *
   * `core.session` is a global table whose fence admits the host or the session's own user. A
   * tenant transaction is neither, so the transaction-local `app.user_id` is pointed at the
   * subject for this one statement and restored straight after — on the same connection, the way
   * 0012's definer functions do it — instead of opening a host transaction (a second connection).
   */
  async revokeWorkspaceSessions(userId: string): Promise<number> {
    const saved = await this.tx.execute(
      sql`SELECT current_setting('app.user_id', true) AS v, set_config('app.user_id', ${userId}, true)`,
    );
    const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
    // No `finally`: on an error the transaction is aborted and rolling back reverts the setting.
    const rows = await this.tx
      .update(session)
      .set({
        revokedAt: sql`coalesce(${session.revokedAt}, now())`,
        revokedReason: sql`coalesce(${session.revokedReason}, 'erased')`,
        ip: null,
        userAgent: "",
        viewAsMembershipId: null,
        viewAsWorkspaceId: null,
        viewAsUntil: null,
        viewAsStartedAt: null,
      })
      .where(
        and(
          eq(session.userId, userId),
          or(eq(session.lastWorkspaceId, this.ctx.workspaceId), isNull(session.lastWorkspaceId)),
        ),
      )
      .returning({ id: session.id });
    await this.tx.execute(sql`SELECT set_config('app.user_id', ${previous}, true)`);
    return rows.length;
  }

  /**
   * The SCIM projection of the member (E3.8 decision 12): `user_name` → `erased-<row id>@invalid`
   * (unique per row), every other personal field → null, deactivated and tombstoned
   * (`deleted_at`, fix round 1 M1): SCIM then answers 404 for it, so a late PATCH cannot write the
   * erased person's details back. A later IdP POST for the same person is a new provisioning (the
   * tenant is the controller). Group edges (`scim_group_member`, ids only) are kept. Rows touched.
   */
  async scrubScimUsers(membershipId: string, userId: string): Promise<number> {
    const rows = await this.tx
      .update(scimUser)
      .set({
        userName: sql`'erased-' || ${scimUser.id}::text || '@invalid'`,
        email: null,
        displayName: null,
        givenName: null,
        familyName: null,
        externalId: null,
        active: false,
        updatedAt: sql`now()`,
        deletedAt: sql`coalesce(${scimUser.deletedAt}, now())`,
      })
      .where(
        and(
          scimUsersOf(this.ctx.workspaceId, membershipId, userId),
          sql`${scimUser.userName}::text NOT LIKE 'erased-%@invalid'`,
        ),
      )
      .returning({ id: scimUser.id });
    return rows.length;
  }

  /**
   * The member's SSO identities for THIS workspace's connections (E3.8 decision 12): `user_identity`
   * rows of type oidc|saml whose identifier is `<connectionId>|<subject>` for a connection of this
   * workspace, deleted connections included. Identities another workspace's IdP linked are that
   * tenant's fact and stay. `core.user_identity`'s fence admits the host or the user, so — as for
   * sessions — `app.user_id` is pointed at the subject for this one statement.
   */
  async deleteSsoIdentities(userId: string): Promise<number> {
    const saved = await this.tx.execute(
      sql`SELECT current_setting('app.user_id', true) AS v, set_config('app.user_id', ${userId}, true)`,
    );
    const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
    const connections = this.tx
      .select({ id: sql`${ssoConnection.id}::text` })
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, this.ctx.workspaceId));
    const rows = await this.tx
      .delete(userIdentity)
      .where(
        and(
          eq(userIdentity.userId, userId),
          inArray(userIdentity.type, ["oidc", "saml"]),
          inArray(sql`split_part(${userIdentity.identifier}, '|', 1)`, connections),
        ),
      )
      .returning({ id: userIdentity.id });
    await this.tx.execute(sql`SELECT set_config('app.user_id', ${previous}, true)`);
    return rows.length;
  }

  /** `core.erase_user_identity` (0012): true when the identity was pseudonymised globally. */
  async eraseUserIdentity(userId: string): Promise<boolean> {
    const r = await this.tx.execute(
      sql`SELECT core.erase_user_identity(${userId}::uuid, ${this.ctx.workspaceId}::uuid) AS global`,
    );
    return (r.rows[0] as { global: boolean } | undefined)?.global === true;
  }

  /** `core.user_other_live_memberships` (0012): how many other workspaces still hold the person. */
  async otherLiveMemberships(userId: string): Promise<number> {
    const r = await this.tx.execute(
      sql`SELECT core.user_other_live_memberships(${userId}::uuid, ${this.ctx.workspaceId}::uuid) AS n`,
    );
    return Number((r.rows[0] as { n: number | string } | undefined)?.n ?? 0);
  }
}
