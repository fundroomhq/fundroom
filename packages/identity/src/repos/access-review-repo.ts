import {
  type AccessReview,
  core,
  type MembershipKind,
  type MembershipRole,
  type MembershipStatus,
  type NewAccessReview,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";

const {
  accessReview,
  accessGrant,
  attestation,
  effectiveAccess,
  group,
  groupMember,
  auditEvent,
  membership,
  user,
  userIdentity,
  workspace,
} = core;

/*
 * Tenant-context reads behind the access review report (E2.7 package B1) and the append-only
 * `core.access_review` records. One transaction gathers every tenant fact; the session facts
 * come from a separate host transaction afterwards (see admin-session-repo.ts).
 */

export interface ReviewMemberRow {
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly userErased: boolean;
  readonly kind: MembershipKind;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly lastSeenAt: Date | null;
  readonly expiresAt: Date | null;
}

export interface ReviewAttestationRow {
  readonly membershipId: string;
  readonly kind: string;
  readonly signedAt: Date;
  readonly expiresAt: Date | null;
}

export class AccessReviewRepo extends TenantRepo<typeof accessReview> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accessReview, ctx, tx);
  }

  /** Every non-revoked membership, oldest first, at most `limit`. */
  async members(limit: number): Promise<ReviewMemberRow[]> {
    const rows = await this.tx
      .select({
        membershipId: membership.id,
        userId: membership.userId,
        name: sql<string>`COALESCE(NULLIF(${user.displayName}, ''), ${membership.profile}->>'displayName', '')`,
        email: userIdentity.identifier,
        userDeletedAt: user.deletedAt,
        kind: membership.kind,
        role: membership.role,
        status: membership.status,
        lastSeenAt: membership.lastSeenAt,
        expiresAt: membership.expiresAt,
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
      .where(
        and(eq(membership.workspaceId, this.ctx.workspaceId), ne(membership.status, "revoked")),
      )
      .orderBy(asc(membership.createdAt), asc(membership.id))
      .limit(limit);
    return rows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      name: r.name,
      email: r.email ?? null,
      userErased: r.userDeletedAt !== null,
      kind: r.kind,
      role: r.role,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Live group ids and names per membership, names alphabetical. */
  async groups(ids: readonly string[]): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({ membershipId: groupMember.membershipId, id: group.id, name: group.name })
      .from(groupMember)
      .innerJoin(group, eq(group.id, groupMember.groupId))
      .where(
        and(
          eq(groupMember.workspaceId, this.ctx.workspaceId),
          isNull(groupMember.revokedAt),
          isNull(group.deletedAt),
          inArray(groupMember.membershipId, [...ids]),
        ),
      )
      .orderBy(asc(group.name));
    for (const r of rows)
      out.set(r.membershipId, [...(out.get(r.membershipId) ?? []), { id: r.id, name: r.name }]);
    return out;
  }

  /** Live grants whose subject is the membership itself. */
  async directGrantCounts(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({ subjectId: accessGrant.subjectId, n: sql<string>`count(*)` })
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.workspaceId, this.ctx.workspaceId),
          eq(accessGrant.subjectKind, "membership"),
          isNull(accessGrant.revokedAt),
          inArray(accessGrant.subjectId, [...ids]),
        ),
      )
      .groupBy(accessGrant.subjectId);
    for (const r of rows) if (r.subjectId !== null) out.set(r.subjectId, Number(r.n));
    return out;
  }

  /** Non-revoked `nda:*` and `accredited` attestations (expired ones included), newest first. */
  async attestations(ids: readonly string[]): Promise<ReviewAttestationRow[]> {
    if (ids.length === 0) return [];
    return this.tx
      .select({
        membershipId: attestation.membershipId,
        kind: attestation.kind,
        signedAt: attestation.signedAt,
        expiresAt: attestation.expiresAt,
      })
      .from(attestation)
      .where(
        and(
          eq(attestation.workspaceId, this.ctx.workspaceId),
          isNull(attestation.revokedAt),
          inArray(attestation.membershipId, [...ids]),
          or(like(attestation.kind, "nda:%"), eq(attestation.kind, "accredited")),
        ),
      )
      .orderBy(desc(attestation.signedAt));
  }

  /** The `pending_gates` arrays of every materialised row that still has any. */
  async pendingGates(ids: readonly string[]): Promise<{ membershipId: string; gates: unknown }[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx
      .select({ membershipId: effectiveAccess.membershipId, gates: effectiveAccess.pendingGates })
      .from(effectiveAccess)
      .where(
        and(
          eq(effectiveAccess.workspaceId, this.ctx.workspaceId),
          inArray(effectiveAccess.membershipId, [...ids]),
          sql`jsonb_array_length(${effectiveAccess.pendingGates}) > 0`,
        ),
      );
    return rows;
  }

  async insert(values: Omit<NewAccessReview, "workspaceId">): Promise<AccessReview> {
    return this.insertOne(values);
  }

  /** One completed review of this workspace (another workspace's id reads as none). */
  async byId(id: string): Promise<AccessReview | undefined> {
    const rows = await this.tx
      .select()
      .from(accessReview)
      .where(and(this.scope(), eq(accessReview.id, id)))
      .limit(1);
    return rows[0];
  }

  /** When this workspace was created (the tenant fence shows a tenant its own row only). */
  async workspaceCreatedAt(): Promise<Date | undefined> {
    const rows = await this.tx
      .select({ createdAt: workspace.createdAt })
      .from(workspace)
      .where(eq(workspace.id, this.ctx.workspaceId))
      .limit(1);
    return rows[0]?.createdAt;
  }

  /**
   * Serialises the overdue reminder per workspace until the transaction ends (two concurrent
   * runs cannot both pass `overdueReminderSent`).
   */
  async lockOverdueReminder(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`access_review.overdue:${this.ctx.workspaceId}`}, 0))`,
    );
  }

  /**
   * Whether the `access.review_overdue` audit row for ISO week `week` (its `meta.week`) exists.
   * At most one row per week ever exists, so the (workspace, action) index keeps this cheap.
   */
  async overdueReminderSent(week: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.workspaceId, this.ctx.workspaceId),
          eq(auditEvent.action, "access.review_overdue"),
          sql`${auditEvent.meta}->>'week' = ${week}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Newest first. */
  async latest(limit: number): Promise<AccessReview[]> {
    return this.tx
      .select()
      .from(accessReview)
      .where(this.scope())
      .orderBy(desc(accessReview.completedAt), desc(accessReview.id))
      .limit(limit);
  }
}

/** Every live workspace (id, created_at), oldest first. Host context. */
export async function liveWorkspacesForReview(tx: Tx): Promise<{ id: string; createdAt: Date }[]> {
  return tx
    .select({ id: workspace.id, createdAt: workspace.createdAt })
    .from(workspace)
    .where(isNull(workspace.deletedAt))
    .orderBy(asc(workspace.createdAt));
}
