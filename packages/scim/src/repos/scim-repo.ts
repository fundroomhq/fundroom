import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";

const { scimToken, scimUser, scimGroup, scimGroupMember, membership, workspace } = core;

export type ScimTokenRow = typeof scimToken.$inferSelect;
export type ScimUserRecordRow = typeof scimUser.$inferSelect;
export type ScimGroupRecordRow = typeof scimGroup.$inferSelect;

export type ScimUserValues = Pick<
  ScimUserRecordRow,
  "userName" | "externalId" | "email" | "displayName" | "givenName" | "familyName" | "active"
>;

export interface MembershipFacts {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly role: string;
  readonly status: string;
  readonly activatedAt: Date | null;
}

/*
 * `core.scim_token` / `scim_user` / `scim_group` / `scim_group_member` (migration
 * `core/0022_sso_scim.sql`; the SQL is authoritative) plus the read of `core.membership` the
 * role/owner rules need. Query builder only, except for the advisory lock and the filter SQL.
 *
 * Every tenant query carries `workspace_id = ctx.workspaceId` next to RLS (TenantRepo's reasoning).
 */
export class ScimRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  private get ws(): string {
    return this.ctx.workspaceId;
  }

  /**
   * The workspace's SCIM advisory lock (`scim.workspace:<ws>`), held to commit. First in the
   * global lock order: before any scim row, the membership row, the workspace row and the audit
   * chain. Every SCIM write takes it, so provisioning in one workspace is serialised.
   */
  async lockWorkspace(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scim.workspace:${this.ws}`}::text, 0))`,
    );
  }

  // --- tokens ------------------------------------------------------------------------------------

  async liveTokens(): Promise<ScimTokenRow[]> {
    return this.tx
      .select()
      .from(scimToken)
      .where(and(eq(scimToken.workspaceId, this.ws), isNull(scimToken.revokedAt)))
      .orderBy(asc(scimToken.createdAt));
  }

  async insertToken(values: {
    tokenHash: Buffer;
    displayPrefix: string;
    name: string;
    createdByMembershipId: string | null;
  }): Promise<ScimTokenRow> {
    const rows = await this.tx
      .insert(scimToken)
      .values({ ...values, workspaceId: this.ws })
      .returning();
    return rows[0] as ScimTokenRow;
  }

  async revokeToken(id: string, at: Date): Promise<ScimTokenRow | undefined> {
    const rows = await this.tx
      .update(scimToken)
      .set({ revokedAt: at })
      .where(
        and(eq(scimToken.workspaceId, this.ws), eq(scimToken.id, id), isNull(scimToken.revokedAt)),
      )
      .returning();
    return rows[0];
  }

  /** `last_used_at = at` unless it was set after `staleBefore` (the write throttle). */
  async touchToken(id: string, at: Date, staleBefore: Date): Promise<void> {
    await this.tx
      .update(scimToken)
      .set({ lastUsedAt: at })
      .where(
        and(
          eq(scimToken.workspaceId, this.ws),
          eq(scimToken.id, id),
          or(isNull(scimToken.lastUsedAt), lt(scimToken.lastUsedAt, staleBefore)),
        ),
      );
  }

  // --- memberships (read only) -------------------------------------------------------------------

  async membership(id: string): Promise<MembershipFacts | undefined> {
    const rows = await this.tx
      .select({
        id: membership.id,
        userId: membership.userId,
        kind: membership.kind,
        role: membership.role,
        status: membership.status,
        activatedAt: membership.activatedAt,
      })
      .from(membership)
      .where(and(eq(membership.workspaceId, this.ws), eq(membership.id, id)))
      .limit(1);
    return rows[0];
  }

  /** Membership status by id (missing ids are absent from the map). */
  async membershipStatuses(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({ id: membership.id, status: membership.status })
      .from(membership)
      .where(and(eq(membership.workspaceId, this.ws), inArray(membership.id, [...ids])));
    for (const r of rows) out.set(r.id, r.status);
    return out;
  }

  /**
   * Row locks for a multi-member change, taken BEFORE any write or audit, in erasure's order
   * (`prelockErasureSubject` 2c → 3 → 4; global order: feature lock → entity rows → workspace row
   * / audit chain):
   *  1. the scim_user rows, in id order;
   *  2. every staff OWNER row of the workspace (`lockOwners`' query, NO KEY UPDATE) — as ownership
   *     transfer, owner revoke/demote and erasure take them first (R2-H1b);
   *  3. the other target memberships, in id order (owners among them are already held; recompute
   *     re-reads each role under this lock and skips owners).
   */
  async lockForRecompute(scimUserIds: readonly string[], membershipIds: readonly string[]) {
    const users = [...new Set(scimUserIds)].sort();
    if (users.length > 0) {
      await this.tx
        .select({ id: scimUser.id })
        .from(scimUser)
        .where(and(eq(scimUser.workspaceId, this.ws), inArray(scimUser.id, users)))
        .orderBy(asc(scimUser.id))
        .for("update");
    }
    if (membershipIds.length === 0) return;
    const owners = await this.tx
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.workspaceId, this.ws),
          eq(membership.kind, "staff"),
          eq(membership.role, "owner"),
        ),
      )
      .orderBy(asc(membership.id))
      .for("no key update");
    const held = new Set(owners.map((o) => o.id));
    const members = [...new Set(membershipIds)].filter((id) => !held.has(id)).sort();
    if (members.length > 0) {
      await this.tx
        .select({ id: membership.id })
        .from(membership)
        .where(and(eq(membership.workspaceId, this.ws), inArray(membership.id, members)))
        .orderBy(asc(membership.id))
        .for("no key update");
    }
  }

  // --- users -------------------------------------------------------------------------------------

  async user(id: string, forUpdate = false): Promise<ScimUserRecordRow | undefined> {
    const q = this.tx
      .select()
      .from(scimUser)
      .where(
        and(eq(scimUser.workspaceId, this.ws), eq(scimUser.id, id), isNull(scimUser.deletedAt)),
      )
      .limit(1);
    const rows = forUpdate ? await q.for("update") : await q;
    return rows[0];
  }

  /**
   * Live users whose userName (case-insensitive) or externalId collides, other than `except`:
   * which attribute and which rows.
   */
  async userConflicts(
    userName: string,
    externalId: string | null,
    except?: string,
  ): Promise<{ field: "userName" | "externalId"; ids: string[] } | undefined> {
    const clash = or(
      eq(scimUser.userName, userName),
      externalId === null ? undefined : eq(scimUser.externalId, externalId),
    );
    const rows = await this.tx
      .select({ id: scimUser.id, userName: scimUser.userName })
      .from(scimUser)
      .where(and(eq(scimUser.workspaceId, this.ws), isNull(scimUser.deletedAt), clash))
      .limit(3);
    const others = rows.filter((r) => r.id !== except);
    const first = others[0];
    if (first === undefined) return undefined;
    return {
      field: others.some((r) => r.userName.toLowerCase() === userName.toLowerCase())
        ? "userName"
        : "externalId",
      ids: others.map((r) => r.id),
    };
  }

  async userByMembership(membershipId: string): Promise<ScimUserRecordRow | undefined> {
    const rows = await this.tx
      .select()
      .from(scimUser)
      .where(
        and(
          eq(scimUser.workspaceId, this.ws),
          eq(scimUser.membershipId, membershipId),
          isNull(scimUser.deletedAt),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async insertUser(
    values: ScimUserValues & { membershipId: string; userId: string },
  ): Promise<ScimUserRecordRow> {
    const rows = await this.tx
      .insert(scimUser)
      .values({ ...values, workspaceId: this.ws })
      .returning();
    return rows[0] as ScimUserRecordRow;
  }

  async updateUser(
    id: string,
    patch: Partial<ScimUserValues> & {
      deletedAt?: Date;
      membershipId?: string;
      userId?: string;
    },
  ): Promise<ScimUserRecordRow> {
    const rows = await this.tx
      .update(scimUser)
      .set(patch)
      .where(and(eq(scimUser.workspaceId, this.ws), eq(scimUser.id, id)))
      .returning();
    return rows[0] as ScimUserRecordRow;
  }

  async listUsers(
    where: SQL | undefined,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimUserRecordRow[] }> {
    const cond = and(eq(scimUser.workspaceId, this.ws), isNull(scimUser.deletedAt), where);
    const [c] = await this.tx.select({ n: count() }).from(scimUser).where(cond);
    const rows =
      limit === 0
        ? []
        : await this.tx
            .select()
            .from(scimUser)
            .where(cond)
            .orderBy(asc(scimUser.createdAt), asc(scimUser.id))
            .offset(offset)
            .limit(limit);
    return { total: Number(c?.n ?? 0), rows };
  }

  /** Which of `ids` are live users of this workspace. */
  async liveUserIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.tx
      .select({ id: scimUser.id })
      .from(scimUser)
      .where(
        and(
          eq(scimUser.workspaceId, this.ws),
          isNull(scimUser.deletedAt),
          inArray(scimUser.id, [...ids]),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  async usersByIds(ids: readonly string[]): Promise<ScimUserRecordRow[]> {
    if (ids.length === 0) return [];
    return this.tx
      .select()
      .from(scimUser)
      .where(
        and(
          eq(scimUser.workspaceId, this.ws),
          isNull(scimUser.deletedAt),
          inArray(scimUser.id, [...ids]),
        ),
      );
  }

  // --- groups ------------------------------------------------------------------------------------

  async group(id: string, forUpdate = false): Promise<ScimGroupRecordRow | undefined> {
    const q = this.tx
      .select()
      .from(scimGroup)
      .where(
        and(eq(scimGroup.workspaceId, this.ws), eq(scimGroup.id, id), isNull(scimGroup.deletedAt)),
      )
      .limit(1);
    const rows = forUpdate ? await q.for("update") : await q;
    return rows[0];
  }

  async groupNameTaken(displayName: string, except?: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: scimGroup.id })
      .from(scimGroup)
      .where(
        and(
          eq(scimGroup.workspaceId, this.ws),
          isNull(scimGroup.deletedAt),
          sql`lower(${scimGroup.displayName}) = lower(${displayName})`,
        ),
      )
      .limit(2);
    return rows.some((r) => r.id !== except);
  }

  async insertGroup(values: {
    displayName: string;
    externalId: string | null;
  }): Promise<ScimGroupRecordRow> {
    const rows = await this.tx
      .insert(scimGroup)
      .values({ ...values, workspaceId: this.ws })
      .returning();
    return rows[0] as ScimGroupRecordRow;
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<ScimGroupRecordRow, "displayName" | "externalId" | "role" | "deletedAt">>,
  ): Promise<ScimGroupRecordRow> {
    // `updated_at` moves even when only the members changed (an empty patch still fires the
    // trigger), so meta.lastModified/version track membership too.
    const rows = await this.tx
      .update(scimGroup)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(scimGroup.workspaceId, this.ws), eq(scimGroup.id, id)))
      .returning();
    return rows[0] as ScimGroupRecordRow;
  }

  async listGroups(
    where: SQL | undefined,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimGroupRecordRow[] }> {
    const cond = and(eq(scimGroup.workspaceId, this.ws), isNull(scimGroup.deletedAt), where);
    const [c] = await this.tx.select({ n: count() }).from(scimGroup).where(cond);
    const rows =
      limit === 0
        ? []
        : await this.tx
            .select()
            .from(scimGroup)
            .where(cond)
            .orderBy(asc(scimGroup.createdAt), asc(scimGroup.id))
            .offset(offset)
            .limit(limit);
    return { total: Number(c?.n ?? 0), rows };
  }

  /** Live members of each group: `{ groupId → [{ id, display }] }`. */
  async membersOf(
    groupIds: readonly string[],
  ): Promise<Map<string, { id: string; display: string | null }[]>> {
    const out = new Map<string, { id: string; display: string | null }[]>();
    for (const id of groupIds) out.set(id, []);
    if (groupIds.length === 0) return out;
    const rows = await this.tx
      .select({
        groupId: scimGroupMember.groupId,
        id: scimUser.id,
        displayName: scimUser.displayName,
        userName: scimUser.userName,
      })
      .from(scimGroupMember)
      .innerJoin(scimUser, eq(scimUser.id, scimGroupMember.scimUserId))
      .where(
        and(
          eq(scimGroupMember.workspaceId, this.ws),
          inArray(scimGroupMember.groupId, [...groupIds]),
          isNull(scimUser.deletedAt),
        ),
      )
      .orderBy(asc(scimGroupMember.createdAt), asc(scimUser.id));
    for (const r of rows) {
      out.get(r.groupId)?.push({ id: r.id, display: r.displayName ?? r.userName });
    }
    return out;
  }

  async memberIds(groupId: string): Promise<string[]> {
    const rows = await this.tx
      .select({ id: scimGroupMember.scimUserId })
      .from(scimGroupMember)
      .where(and(eq(scimGroupMember.workspaceId, this.ws), eq(scimGroupMember.groupId, groupId)));
    return rows.map((r) => r.id);
  }

  async addMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.tx
      .insert(scimGroupMember)
      .values(userIds.map((scimUserId) => ({ workspaceId: this.ws, groupId, scimUserId })))
      .onConflictDoNothing();
  }

  async removeMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.tx
      .delete(scimGroupMember)
      .where(
        and(
          eq(scimGroupMember.workspaceId, this.ws),
          eq(scimGroupMember.groupId, groupId),
          inArray(scimGroupMember.scimUserId, [...userIds]),
        ),
      );
  }

  async removeAllMembers(groupId: string): Promise<string[]> {
    const rows = await this.tx
      .delete(scimGroupMember)
      .where(and(eq(scimGroupMember.workspaceId, this.ws), eq(scimGroupMember.groupId, groupId)))
      .returning({ id: scimGroupMember.scimUserId });
    return rows.map((r) => r.id);
  }

  /** Drops a user from every group; returns the group ids it was in. */
  async removeUserFromGroups(scimUserId: string): Promise<string[]> {
    const rows = await this.tx
      .delete(scimGroupMember)
      .where(
        and(eq(scimGroupMember.workspaceId, this.ws), eq(scimGroupMember.scimUserId, scimUserId)),
      )
      .returning({ id: scimGroupMember.groupId });
    return rows.map((r) => r.id);
  }

  /** The mapped roles of the live groups each user belongs to. */
  async mappedRoles(scimUserIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const id of scimUserIds) out.set(id, []);
    if (scimUserIds.length === 0) return out;
    const rows = await this.tx
      .select({ userId: scimGroupMember.scimUserId, role: scimGroup.role })
      .from(scimGroupMember)
      .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMember.groupId))
      .where(
        and(
          eq(scimGroupMember.workspaceId, this.ws),
          inArray(scimGroupMember.scimUserId, [...scimUserIds]),
          isNull(scimGroup.deletedAt),
        ),
      );
    for (const r of rows) if (r.role !== null) out.get(r.userId)?.push(r.role);
    return out;
  }

  // --- admin views -------------------------------------------------------------------------------

  async counts(): Promise<{ users: number; activeUsers: number; groups: number }> {
    const [u] = await this.tx
      .select({
        users: count(),
        active: sql<number>`count(*) FILTER (WHERE ${scimUser.active})`,
      })
      .from(scimUser)
      .where(and(eq(scimUser.workspaceId, this.ws), isNull(scimUser.deletedAt)));
    const [g] = await this.tx
      .select({ n: count() })
      .from(scimGroup)
      .where(and(eq(scimGroup.workspaceId, this.ws), isNull(scimGroup.deletedAt)));
    return {
      users: Number(u?.users ?? 0),
      activeUsers: Number(u?.active ?? 0),
      groups: Number(g?.n ?? 0),
    };
  }

  /** Newest first, keyset on (created_at, id). */
  async adminUsers(
    after: { createdAt: Date; id: string } | undefined,
    limit: number,
  ): Promise<(ScimUserRecordRow & { role: string | null; groups: string[] })[]> {
    const rows = await this.tx
      .select({ u: scimUser, role: membership.role, status: membership.status })
      .from(scimUser)
      .leftJoin(membership, eq(membership.id, scimUser.membershipId))
      .where(
        and(
          eq(scimUser.workspaceId, this.ws),
          isNull(scimUser.deletedAt),
          after === undefined
            ? undefined
            : or(
                lt(scimUser.createdAt, after.createdAt),
                and(eq(scimUser.createdAt, after.createdAt), lt(scimUser.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(scimUser.createdAt), desc(scimUser.id))
      .limit(limit);
    const ids = rows.map((r) => r.u.id);
    const groups = new Map<string, string[]>();
    if (ids.length > 0) {
      const gm = await this.tx
        .select({ userId: scimGroupMember.scimUserId, name: scimGroup.displayName })
        .from(scimGroupMember)
        .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMember.groupId))
        .where(
          and(
            eq(scimGroupMember.workspaceId, this.ws),
            inArray(scimGroupMember.scimUserId, ids),
            isNull(scimGroup.deletedAt),
          ),
        )
        .orderBy(asc(scimGroup.displayName));
      for (const r of gm) groups.set(r.userId, [...(groups.get(r.userId) ?? []), r.name]);
    }
    return rows.map((r) => ({
      ...r.u,
      role: r.status === null || r.status === "revoked" ? null : r.role,
      groups: groups.get(r.u.id) ?? [],
    }));
  }

  async adminGroups(): Promise<(ScimGroupRecordRow & { memberCount: number })[]> {
    const rows = await this.tx
      .select()
      .from(scimGroup)
      .where(and(eq(scimGroup.workspaceId, this.ws), isNull(scimGroup.deletedAt)))
      .orderBy(asc(sql`lower(${scimGroup.displayName})`), asc(scimGroup.id));
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const c = await this.tx
        .select({ groupId: scimGroupMember.groupId, n: count() })
        .from(scimGroupMember)
        .innerJoin(scimUser, eq(scimUser.id, scimGroupMember.scimUserId))
        .where(
          and(
            eq(scimGroupMember.workspaceId, this.ws),
            inArray(
              scimGroupMember.groupId,
              rows.map((r) => r.id),
            ),
            isNull(scimUser.deletedAt),
          ),
        )
        .groupBy(scimGroupMember.groupId);
      for (const r of c) counts.set(r.groupId, Number(r.n));
    }
    return rows.map((r) => ({ ...r, memberCount: counts.get(r.id) ?? 0 }));
  }

  /** Live SCIM users whose group memberships changed, for role recompute. */
  async usersInGroup(groupId: string): Promise<ScimUserRecordRow[]> {
    const rows = await this.tx
      .select({ u: scimUser })
      .from(scimGroupMember)
      .innerJoin(scimUser, eq(scimUser.id, scimGroupMember.scimUserId))
      .where(
        and(
          eq(scimGroupMember.workspaceId, this.ws),
          eq(scimGroupMember.groupId, groupId),
          isNull(scimUser.deletedAt),
        ),
      );
    return rows.map((r) => r.u);
  }
}

/**
 * Bearer lookup by hash in the HOST context (the token names the workspace; `scim_token` has a
 * host SELECT policy). Revoked rows are returned so the caller can tell them apart in logs.
 */
export async function findTokenByHash(tx: Tx, hash: Buffer): Promise<ScimTokenRow | undefined> {
  // A soft-deleted workspace (the purge window) authenticates nothing.
  const rows = await tx
    .select({ t: scimToken })
    .from(scimToken)
    .innerJoin(workspace, eq(workspace.id, scimToken.workspaceId))
    .where(and(eq(scimToken.tokenHash, hash), isNull(workspace.deletedAt)))
    .limit(1);
  return rows[0]?.t;
}
