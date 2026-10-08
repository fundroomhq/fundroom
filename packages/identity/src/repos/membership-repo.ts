import {
  type Attestation,
  core,
  type DelegateScope,
  type Group,
  type GroupMember,
  type Invite,
  type Membership,
  type MembershipKind,
  type MembershipRole,
  type MembershipStatus,
  type NewAttestation,
  type NewInvite,
  type NewMembership,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";

const { membership, invite, group, groupMember, attestation, auditEvent, user, userIdentity } =
  core;

/** The user's display name, else the name the inviter gave (`profile.displayName`), else "". */
const displayNameExpr = sql<string>`COALESCE(NULLIF(${user.displayName}, ''), ${membership.profile}->>'displayName', '')`;

/*
 * Tenant-context repositories. `TenantRepo` appends `workspace_id = ctx.workspaceId` to every
 * read and forces it on inserts, on top of the RLS fence. Login, invites, revocation and the
 * People / Groups screens (E1.1) read and write through these.
 */

/** A membership with the person behind it, for the People screens. */
export interface PersonRow {
  readonly membership: Membership;
  readonly displayName: string;
  /** Primary email; null only for a user without an email identity (host-asserted, E2.2). */
  readonly email: string | null;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  /**
   * For a delegate (E3.2): who it acts for, so every list can say "Jane Doe (for Acme Ventures —
   * Bob Smith)". `firm` is the principal's `profile.firm`, if any. `null` for everyone else.
   */
  readonly principal: DelegatePrincipal | null;
}

export interface DelegatePrincipal {
  readonly membershipId: string;
  readonly displayName: string;
  readonly firm: string | null;
}

export interface PeopleFilter {
  readonly kind?: MembershipKind | undefined;
  readonly statuses?: readonly MembershipStatus[] | undefined;
  readonly groupId?: string | undefined;
  /** Case-insensitive substring of the display name or email. */
  readonly q?: string | undefined;
  /** Last membership id of the previous page (ids are uuidv7: creation order). */
  readonly cursor?: string | undefined;
  readonly limit: number;
}

function principalOf(
  principals: ReadonlyMap<string, DelegatePrincipal>,
  m: Pick<Membership, "principalMembershipId">,
): DelegatePrincipal | null {
  return m.principalMembershipId === null
    ? null
    : (principals.get(m.principalMembershipId) ?? null);
}

export class MembershipRepo extends TenantRepo<typeof membership> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(membership, ctx, tx);
  }

  /** The user's non-revoked membership in this workspace, if any. */
  async findForUser(userId: string): Promise<Membership | undefined> {
    const rows = await this.findMany(
      and(eq(membership.userId, userId), ne(membership.status, "revoked")),
    );
    return rows[0];
  }

  async byId(id: string): Promise<Membership | undefined> {
    return this.findById(id);
  }

  async byIds(ids: readonly string[]): Promise<Membership[]> {
    if (ids.length === 0) return [];
    return this.findMany(inArray(membership.id, [...ids]));
  }

  async create(values: Omit<NewMembership, "workspaceId">): Promise<Membership> {
    return this.insertOne(values);
  }

  async activate(id: string): Promise<Membership | undefined> {
    const rows = await this.tx
      .update(membership)
      .set({ status: "active", activatedAt: new Date(), lastSeenAt: new Date() })
      .where(this.scope(and(eq(membership.id, id), eq(membership.status, "invited"))))
      .returning();
    return rows[0];
  }

  async touchSeen(id: string): Promise<void> {
    await this.tx
      .update(membership)
      .set({ lastSeenAt: new Date() })
      .where(this.scope(eq(membership.id, id)));
  }

  /** Role, profile, expiry and status edits from the People screen. */
  async update(
    id: string,
    patch: Partial<
      Pick<
        NewMembership,
        "role" | "profile" | "expiresAt" | "status" | "reverifyDueAt" | "relationshipEstablishedAt"
      >
    >,
  ): Promise<Membership | undefined> {
    const rows = await this.tx
      .update(membership)
      .set(patch)
      .where(this.scope(and(eq(membership.id, id), ne(membership.status, "revoked"))))
      .returning();
    return rows[0];
  }

  /**
   * Row-locks every staff owner membership of the workspace (`FOR UPDATE`, in id order so two
   * callers never deadlock on each other), for the length of the caller's transaction (E2.10
   * R1-A5). Take it before `countActiveOwners` on any path that can take an owner away —
   * demotion, revocation, ownership transfer: under READ COMMITTED two owners demoting each other
   * at once both counted two owners and both went ahead, leaving the workspace with none. The
   * second one now waits here, and its count sees the first one's committed change.
   */
  async lockOwners(): Promise<void> {
    await this.tx
      .select({ id: membership.id })
      .from(membership)
      .where(this.scope(and(eq(membership.kind, "staff"), eq(membership.role, "owner"))))
      .orderBy(asc(membership.id))
      // NO KEY UPDATE: it still serialises every owner-changing path against the others, but no
      // longer blocks inserts that merely reference an owner row by foreign key.
      .for("no key update");
  }

  /**
   * Owners who can administer the workspace right now — the last-owner floor (never let the last
   * one go). One predicate (E3.2): a staff owner whose status is `active` and who is not past its
   * own `expires_at` (P1-01). An `invited` owner has never signed in and a `dormant` one may never
   * come back, so neither keeps the workspace owned; portability's `countLiveOwners` uses the same
   * rule.
   *
   * `excluding` leaves one membership out of the count, so a caller about to take an owner away
   * asks the question it means — "is anybody else still an owner?" — instead of `<= 1`, which
   * would refuse removing an invited or dormant owner (not counted) while one active owner remains.
   */
  async countActiveOwners(
    now = new Date(),
    options: { readonly excluding?: string | undefined } = {},
  ): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(membership)
      .where(
        this.scope(
          and(
            eq(membership.kind, "staff"),
            eq(membership.role, "owner"),
            eq(membership.status, "active"),
            or(isNull(membership.expiresAt), gt(membership.expiresAt, now)),
            options.excluding === undefined ? undefined : ne(membership.id, options.excluding),
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** Non-revoked delegates acting for a principal. */
  /** The user's membership here whatever its status, revoked included (newest first). */
  async findAnyForUser(userId: string): Promise<Membership | undefined> {
    const rows = await this.tx
      .select()
      .from(membership)
      .where(this.scope(eq(membership.userId, userId)))
      .orderBy(desc(membership.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Self-service delegate adds a principal made since `since`: the
   * `membership.delegate_added` and `membership.delegate_add_skipped` audit rows it is the actor
   * of. Audit rows are append-only and survive restarts, so the budget cannot be reset by
   * withdrawing an invitation or by a deploy. `oldest` dates the window's first counted add.
   */
  async delegateAddsSince(
    principalMembershipId: string,
    since: Date,
  ): Promise<{ count: number; oldest: Date | null }> {
    const rows = await this.tx
      .select({
        n: sql<number>`count(*)::int`,
        // Epoch milliseconds: `timestamptz::text` ends in `+00`, which `new Date()` cannot read.
        oldest: sql<
          string | null
        >`(extract(epoch FROM min(${auditEvent.occurredAt})) * 1000)::bigint::text`,
      })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.workspaceId, this.ctx.workspaceId),
          eq(auditEvent.actorMembershipId, principalMembershipId),
          inArray(auditEvent.action, [
            "membership.delegate_added",
            "membership.delegate_add_skipped",
          ]),
          gt(auditEvent.occurredAt, since),
        ),
      );
    const r = rows[0];
    return {
      count: r?.n ?? 0,
      oldest: r?.oldest == null ? null : new Date(Number(r.oldest)),
    };
  }

  async delegatesOf(principalMembershipId: string): Promise<Membership[]> {
    return this.findMany(
      and(
        eq(membership.principalMembershipId, principalMembershipId),
        ne(membership.status, "revoked"),
      ),
    );
  }

  /**
   * For a delegate: its principal and scope, when the principal is live (`active`, not expired).
   * `undefined` for a non-delegate or a delegate whose principal is not live (E3.2).
   */
  async liveDelegationPrincipal(
    delegateMembershipId: string,
    now = new Date(),
  ): Promise<{ readonly id: string; readonly scope: DelegateScope } | undefined> {
    const d = await this.byId(delegateMembershipId);
    if (d === undefined || d.role !== "delegate" || d.principalMembershipId === null)
      return undefined;
    if (d.delegateScope === null) return undefined;
    const p = await this.byId(d.principalMembershipId);
    if (p === undefined || p.status !== "active") return undefined;
    if (p.expiresAt !== null && p.expiresAt.getTime() <= now.getTime()) return undefined;
    return { id: p.id, scope: d.delegateScope };
  }

  /**
   * Row-locks the principal (`FOR UPDATE`) so two concurrent "add a delegate" calls for the same
   * principal count one after the other and cannot both slip under the limit.
   */
  async lockForUpdate(id: string): Promise<Membership | undefined> {
    const rows = await this.tx
      .select()
      .from(membership)
      .where(this.scope(eq(membership.id, id)))
      .for("update");
    return rows[0];
  }

  /**
   * Row-locks one membership `FOR NO KEY UPDATE` (serialises writers of the row and of what hangs
   * off it — group rows, delegates — without blocking foreign-key inserts that reference it).
   */
  async lockNoKeyUpdate(id: string): Promise<Membership | undefined> {
    const rows = await this.tx
      .select()
      .from(membership)
      .where(this.scope(eq(membership.id, id)))
      .for("no key update");
    return rows[0];
  }

  /** The People list: memberships joined with the person and their live groups. */
  async listPeople(
    filter: PeopleFilter,
  ): Promise<{ items: PersonRow[]; nextCursor: string | null }> {
    const conds = [];
    if (filter.kind !== undefined) conds.push(eq(membership.kind, filter.kind));
    if (filter.statuses !== undefined && filter.statuses.length > 0)
      conds.push(inArray(membership.status, [...filter.statuses]));
    if (filter.cursor !== undefined) conds.push(gt(membership.id, filter.cursor));
    if (filter.q !== undefined && filter.q.trim().length > 0) {
      const needle = `%${filter.q.trim().replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;
      conds.push(
        or(
          ilike(user.displayName, needle),
          ilike(sql`${membership.profile}->>'displayName'`, needle),
          ilike(userIdentity.identifier, needle),
        ),
      );
    }
    if (filter.groupId !== undefined) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM ${groupMember} gm WHERE gm.workspace_id = ${this.ctx.workspaceId} AND gm.group_id = ${filter.groupId} AND gm.membership_id = ${membership.id} AND gm.revoked_at IS NULL)`,
      );
    }
    const rows = await this.tx
      .select({ m: membership, displayName: displayNameExpr, email: userIdentity.identifier })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .leftJoin(
        userIdentity,
        and(
          eq(userIdentity.userId, membership.userId),
          eq(userIdentity.type, "email"),
          eq(userIdentity.isPrimary, true),
        ),
      )
      .where(this.scope(conds.length > 0 ? and(...conds) : undefined))
      .orderBy(asc(membership.id))
      .limit(filter.limit + 1);
    const page = rows.slice(0, filter.limit);
    const groupsBy = await this.groupsFor(page.map((r) => r.m.id));
    const principals = await this.principalsFor(page.map((r) => r.m));
    return {
      items: page.map((r) => ({
        membership: r.m,
        displayName: r.displayName,
        email: r.email ?? null,
        groups: groupsBy.get(r.m.id) ?? [],
        principal: principalOf(principals, r.m),
      })),
      nextCursor: rows.length > filter.limit ? (page.at(-1)?.m.id ?? null) : null,
    };
  }

  /** One person with the same joins as the list. */
  async person(id: string): Promise<PersonRow | undefined> {
    const rows = await this.tx
      .select({ m: membership, displayName: displayNameExpr, email: userIdentity.identifier })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .leftJoin(
        userIdentity,
        and(
          eq(userIdentity.userId, membership.userId),
          eq(userIdentity.type, "email"),
          eq(userIdentity.isPrimary, true),
        ),
      )
      .where(this.scope(eq(membership.id, id)))
      .limit(1);
    const r = rows[0];
    if (r === undefined) return undefined;
    const groups = await this.groupsFor([id]);
    const principals = await this.principalsFor([r.m]);
    return {
      membership: r.m,
      displayName: r.displayName,
      email: r.email ?? null,
      groups: groups.get(id) ?? [],
      principal: principalOf(principals, r.m),
    };
  }

  /** Name and firm of the principals of the delegates among `rows` (E3.2 display). */
  private async principalsFor(
    rows: readonly Pick<Membership, "principalMembershipId">[],
  ): Promise<Map<string, DelegatePrincipal>> {
    const ids = [
      ...new Set(
        rows.map((r) => r.principalMembershipId).filter((id): id is string => id !== null),
      ),
    ];
    const out = new Map<string, DelegatePrincipal>();
    if (ids.length === 0) return out;
    const found = await this.tx
      .select({
        id: membership.id,
        displayName: displayNameExpr,
        firm: sql<string | null>`NULLIF(${membership.profile}->>'firm', '')`,
      })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(this.scope(inArray(membership.id, ids)));
    for (const r of found)
      out.set(r.id, { membershipId: r.id, displayName: r.displayName, firm: r.firm ?? null });
    return out;
  }

  /** Display names for a set of memberships ("who has access" rows). */
  async namesFor(
    ids: readonly string[],
  ): Promise<
    Map<
      string,
      { displayName: string; email: string | null; kind: MembershipKind; role: MembershipRole }
    >
  > {
    const out = new Map<
      string,
      { displayName: string; email: string | null; kind: MembershipKind; role: MembershipRole }
    >();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({
        id: membership.id,
        kind: membership.kind,
        role: membership.role,
        displayName: displayNameExpr,
        email: userIdentity.identifier,
      })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .leftJoin(
        userIdentity,
        and(
          eq(userIdentity.userId, membership.userId),
          eq(userIdentity.type, "email"),
          eq(userIdentity.isPrimary, true),
        ),
      )
      .where(this.scope(inArray(membership.id, [...ids])));
    for (const r of rows)
      out.set(r.id, {
        displayName: r.displayName,
        email: r.email ?? null,
        kind: r.kind,
        role: r.role,
      });
    return out;
  }

  private async groupsFor(
    membershipIds: readonly string[],
  ): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    if (membershipIds.length === 0) return out;
    const rows = await this.tx
      .select({ membershipId: groupMember.membershipId, id: group.id, name: group.name })
      .from(groupMember)
      .innerJoin(group, eq(group.id, groupMember.groupId))
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          isNull(groupMember.revokedAt),
          isNull(group.deletedAt),
          inArray(groupMember.membershipId, [...membershipIds]),
        ),
      )
      .orderBy(asc(group.name));
    for (const r of rows)
      out.set(r.membershipId, [...(out.get(r.membershipId) ?? []), { id: r.id, name: r.name }]);
    return out;
  }

  /**
   * Revocation core (§13.2): status=revoked, delegates cascade, group rows keep a
   * `revoked_at`, pending invites created by this member are cancelled. Sessions, grants,
   * outbox and audit are the caller's job (`MembershipService.revoke`).
   */
  async revoke(
    id: string,
    input: { by?: string | undefined; reason?: string | undefined },
  ): Promise<string[]> {
    const now = new Date();
    const revoked = await this.tx
      .update(membership)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy: input.by ?? null,
        revokeReason: input.reason ?? null,
      })
      .where(this.scope(and(eq(membership.id, id), ne(membership.status, "revoked"))))
      .returning({ id: membership.id });
    if (revoked.length === 0) return [];
    const delegates = await this.tx
      .update(membership)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy: input.by ?? null,
        revokeReason: "principal_revoked",
      })
      .where(
        this.scope(and(eq(membership.principalMembershipId, id), ne(membership.status, "revoked"))),
      )
      .returning({ id: membership.id });
    const ids = [id, ...delegates.map((d) => d.id)];
    await this.tx
      .update(groupMember)
      .set({ revokedAt: now })
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          inArray(groupMember.membershipId, ids),
          isNull(groupMember.revokedAt),
        ),
      );
    // Pending invitations they sent, and pending delegate invitations acting for them (E3.2):
    // an admin-added delegate's invite names the admin as inviter, not the principal.
    await this.tx
      .update(invite)
      .set({ status: "revoked", revokedAt: now })
      .where(
        and(
          eq(invite.workspaceId, this.ctx.workspaceId),
          or(inArray(invite.invitedBy, ids), inArray(invite.principalMembershipId, ids)),
          eq(invite.status, "pending"),
        ),
      );
    return ids;
  }
}

export class InviteRepo extends TenantRepo<typeof invite> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(invite, ctx, tx);
  }

  async create(values: Omit<NewInvite, "workspaceId">): Promise<Invite> {
    return this.insertOne(values);
  }

  async byId(id: string): Promise<Invite | undefined> {
    return this.findById(id);
  }

  async list(filter: { status?: Invite["status"] | undefined; limit: number }): Promise<Invite[]> {
    return this.tx
      .select()
      .from(invite)
      .where(this.scope(filter.status === undefined ? undefined : eq(invite.status, filter.status)))
      .orderBy(desc(invite.createdAt))
      .limit(filter.limit);
  }

  /** Pending invites by address for dry-run duplicate detection. */
  async pendingEmails(now = new Date()): Promise<Set<string>> {
    const rows = await this.tx
      .select({ email: invite.email })
      .from(invite)
      .where(this.scope(and(eq(invite.status, "pending"), gt(invite.expiresAt, now))));
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  async findPendingByEmail(email: string, now = new Date()): Promise<Invite | undefined> {
    const rows = await this.tx
      .select()
      .from(invite)
      .where(
        this.scope(
          and(eq(invite.email, email), eq(invite.status, "pending"), gt(invite.expiresAt, now)),
        ),
      )
      .orderBy(desc(invite.createdAt))
      .limit(1);
    return rows[0];
  }

  async findByTokenHash(tokenHash: Buffer): Promise<Invite | undefined> {
    const rows = await this.findMany(eq(invite.tokenHash, tokenHash));
    return rows[0];
  }

  /** Resend: a fresh token and expiry on the same row. */
  async rotateToken(id: string, tokenHash: Buffer, expiresAt: Date): Promise<Invite | undefined> {
    const rows = await this.tx
      .update(invite)
      .set({ tokenHash, expiresAt })
      .where(this.scope(and(eq(invite.id, id), eq(invite.status, "pending"))))
      .returning();
    return rows[0];
  }

  async accept(id: string, membershipId: string): Promise<boolean> {
    const rows = await this.tx
      .update(invite)
      .set({ status: "accepted", acceptedAt: new Date(), acceptedMembershipId: membershipId })
      .where(this.scope(and(eq(invite.id, id), eq(invite.status, "pending"))))
      .returning({ id: invite.id });
    return rows.length > 0;
  }

  /** Pending, unexpired delegate invitations acting for a principal (E3.2), newest first. */
  async pendingDelegatesOf(principalMembershipId: string, now = new Date()): Promise<Invite[]> {
    return this.tx
      .select()
      .from(invite)
      .where(
        this.scope(
          and(
            eq(invite.principalMembershipId, principalMembershipId),
            eq(invite.status, "pending"),
            gt(invite.expiresAt, now),
          ),
        ),
      )
      .orderBy(desc(invite.createdAt));
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.tx
      .update(invite)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(this.scope(and(eq(invite.id, id), eq(invite.status, "pending"))))
      .returning({ id: invite.id });
    return rows.length > 0;
  }

  /** Sweeps pending invites past their expiry (E0.4 job). */
  async expire(now = new Date()): Promise<number> {
    const rows = await this.tx
      .update(invite)
      .set({ status: "expired" })
      .where(this.scope(and(eq(invite.status, "pending"), sql`${invite.expiresAt} <= ${now}`)))
      .returning({ id: invite.id });
    return rows.length;
  }
}

export interface GroupWithCount extends Group {
  readonly memberCount: number;
}

export class GroupRepo extends TenantRepo<typeof group> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(group, ctx, tx);
  }

  async create(values: { name: string; kind?: string | undefined }): Promise<Group> {
    return this.insertOne({ name: values.name.trim(), kind: values.kind ?? "custom" });
  }

  async byId(id: string): Promise<Group | undefined> {
    const rows = await this.findMany(and(eq(group.id, id), isNull(group.deletedAt)));
    return rows[0];
  }

  async byIds(ids: readonly string[]): Promise<Group[]> {
    if (ids.length === 0) return [];
    return this.findMany(and(inArray(group.id, [...ids]), isNull(group.deletedAt)));
  }

  async byName(name: string): Promise<Group | undefined> {
    const rows = await this.findMany(
      and(sql`lower(${group.name}) = lower(${name.trim()})`, isNull(group.deletedAt)),
    );
    return rows[0];
  }

  async list(): Promise<Group[]> {
    return this.tx
      .select()
      .from(group)
      .where(this.scope(isNull(group.deletedAt)))
      .orderBy(asc(group.name));
  }

  async listWithCounts(): Promise<GroupWithCount[]> {
    const rows = await this.tx
      .select({
        g: group,
        memberCount: sql<number>`(SELECT count(*)::int FROM ${groupMember} gm WHERE gm.group_id = ${group.id} AND gm.revoked_at IS NULL)`,
      })
      .from(group)
      .where(this.scope(isNull(group.deletedAt)))
      .orderBy(asc(group.name));
    return rows.map((r) => ({ ...r.g, memberCount: r.memberCount }));
  }

  async update(
    id: string,
    patch: { name?: string | undefined; kind?: string | undefined },
  ): Promise<Group | undefined> {
    const set: Partial<Group> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (Object.keys(set).length === 0) return this.byId(id);
    const rows = await this.tx
      .update(group)
      .set(set)
      .where(this.scope(and(eq(group.id, id), isNull(group.deletedAt))))
      .returning();
    return rows[0];
  }

  /** Soft delete; member rows are revoked so the group's grants stop applying. */
  async softDelete(id: string): Promise<number> {
    const rows = await this.tx
      .update(group)
      .set({ deletedAt: new Date() })
      .where(this.scope(and(eq(group.id, id), isNull(group.deletedAt))))
      .returning({ id: group.id });
    if (rows.length === 0) return 0;
    const members = await this.tx
      .update(groupMember)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          eq(groupMember.groupId, id),
          isNull(groupMember.revokedAt),
        ),
      )
      .returning({ membershipId: groupMember.membershipId });
    return members.length;
  }

  async addMember(groupId: string, membershipId: string, addedBy?: string): Promise<GroupMember> {
    const rows = await this.tx
      .insert(groupMember)
      .values({
        workspaceId: this.ctx.workspaceId,
        groupId,
        membershipId,
        addedBy: addedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [groupMember.groupId, groupMember.membershipId],
        set: { revokedAt: null, addedAt: new Date(), addedBy: addedBy ?? null },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async removeMember(groupId: string, membershipId: string): Promise<boolean> {
    const rows = await this.tx
      .update(groupMember)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          eq(groupMember.groupId, groupId),
          eq(groupMember.membershipId, membershipId),
          isNull(groupMember.revokedAt),
        ),
      )
      .returning({ groupId: groupMember.groupId });
    return rows.length > 0;
  }

  async membersOf(groupId: string): Promise<GroupMember[]> {
    return this.tx
      .select()
      .from(groupMember)
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          eq(groupMember.groupId, groupId),
          isNull(groupMember.revokedAt),
        ),
      );
  }

  async groupIdsFor(membershipId: string): Promise<string[]> {
    const rows = await this.tx
      .select({ groupId: groupMember.groupId })
      .from(groupMember)
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          eq(groupMember.membershipId, membershipId),
          isNull(groupMember.revokedAt),
        ),
      );
    return rows.map((r) => r.groupId);
  }

  /**
   * The groups a member counts as in for a group *audience* of `module` (E3.2): its own live
   * groups, plus — for a delegate whose principal is live and whose scope admits the module — the
   * principal's. The SQL twin is `core.current_delegation_principal(module)` (0017), which
   * `updates.audience_includes_current` and the search `groups` arm use; the two must agree.
   */
  async audienceGroupIdsFor(
    membershipId: string,
    module: string,
    now = new Date(),
  ): Promise<string[]> {
    const own = await this.groupIdsFor(membershipId);
    const principal = await new MembershipRepo(this.ctx, this.tx).liveDelegationPrincipal(
      membershipId,
      now,
    );
    if (principal === undefined || !delegateScopeAdmitsModule(principal.scope, module)) return own;
    const borrowed = await this.groupIdsFor(principal.id);
    return [...new Set([...own, ...borrowed])];
  }
}

/** `core.current_delegation_principal`'s scope rule: which module's audiences a scope admits. */
export function delegateScopeAdmitsModule(scope: DelegateScope, module: string): boolean {
  return (
    scope === "all" ||
    (scope === "data_room" && module === "data-room") ||
    (scope === "updates" && module === "updates")
  );
}

export class AttestationRepo extends TenantRepo<typeof attestation> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(attestation, ctx, tx);
  }

  async record(values: Omit<NewAttestation, "workspaceId">): Promise<Attestation> {
    return this.insertOne(values);
  }

  /** The newest live attestation of a kind; `undefined` when never signed, expired or revoked. */
  async current(
    membershipId: string,
    kind: string,
    now = new Date(),
  ): Promise<Attestation | undefined> {
    const rows = await this.tx
      .select()
      .from(attestation)
      .where(
        this.scope(
          and(
            eq(attestation.membershipId, membershipId),
            eq(attestation.kind, kind),
            isNull(attestation.revokedAt),
            sql`(${attestation.expiresAt} IS NULL OR ${attestation.expiresAt} > ${now})`,
          ),
        ),
      )
      .orderBy(desc(attestation.signedAt))
      .limit(1);
    return rows[0];
  }

  async listFor(membershipId: string): Promise<Attestation[]> {
    return this.findMany(eq(attestation.membershipId, membershipId));
  }

  /**
   * Attaches the certificate reference to an acceptance already on record (E2.3, contract D2).
   *
   * The certificate cites the acceptance's audit `seq` and `hash`, so it can only be built after
   * the attestation and its audit row exist — which means `evidence_ref` has to be filled in a
   * second statement, inside the same transaction. Deliberately narrow: this sets one nullable
   * column and never touches `kind`, `signed_at` or `data`, the fields that are the evidence.
   */
  async setEvidenceRef(id: string, evidenceRef: string): Promise<Attestation | undefined> {
    const rows = await this.tx
      .update(attestation)
      .set({ evidenceRef })
      .where(this.scope(and(eq(attestation.id, id), isNull(attestation.revokedAt))))
      .returning();
    return rows[0];
  }
}

/** Host context with `userId` set: the user's own memberships across workspaces (switcher). */
export async function listWorkspaceMembershipsForUser(
  tx: Tx,
  userId: string,
): Promise<Pick<Membership, "workspaceId" | "kind" | "role" | "status" | "id" | "expiresAt">[]> {
  return tx
    .select({
      id: membership.id,
      workspaceId: membership.workspaceId,
      kind: membership.kind,
      role: membership.role,
      status: membership.status,
      expiresAt: membership.expiresAt,
    })
    .from(membership)
    .where(and(eq(membership.userId, userId), ne(membership.status, "revoked")))
    .orderBy(membership.createdAt);
}

export type { MembershipKind, MembershipRole };
