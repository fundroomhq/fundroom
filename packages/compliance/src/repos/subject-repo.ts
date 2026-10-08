import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

const {
  invite,
  session,
  device,
  shareLinkVisit,
  shareLinkView,
  mailMessage,
  accessGrant,
  dsarRequest,
  scimUser,
  ssoConnection,
  userIdentity,
} = core;

/** Cap on each of the list reads below; the export is built in memory. */
export const MAX_SUBJECT_ROWS = 10_000;

/*
 * Kernel reads for the subject-access export (E2.7 DSAR): the invites that carried the member's
 * address, the audit events they are party to, this workspace's sessions of the person, their
 * share-link visits, the mail sent to them, grants naming them directly and their own DSAR
 * history. Everything else the export needs already has a repository (`MembershipRepo.person`,
 * `AttestationRepo`, `ConsentEventRepo`, the register). Every read runs on the caller's
 * transaction — never a second connection.
 */

/** Largest number of audit events one subject export carries; the zip is built in memory. */
export const MAX_SUBJECT_AUDIT_ROWS = 100_000;

export interface SubjectInviteRow {
  readonly id: string;
  readonly email: string;
  readonly kind: string;
  readonly role: string;
  readonly status: string;
  readonly message: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface SubjectAuditRow {
  readonly seq: number;
  /** The chain's own canonical text — verbatim, so each line can be checked against `hash`. */
  readonly canonical: string;
  readonly hash: string;
}

export class SubjectRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  /**
   * The invite the member accepted and any invite addressed to their email. Never the token hash
   * or the grants blob (the workspace's access design, not a fact about the person).
   */
  async invites(membershipId: string, email: string | null): Promise<SubjectInviteRow[]> {
    const mine = eq(invite.acceptedMembershipId, membershipId);
    return this.tx
      .select({
        id: invite.id,
        email: invite.email,
        kind: invite.kind,
        role: invite.role,
        status: invite.status,
        message: invite.message,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
      })
      .from(invite)
      .where(
        and(
          eq(invite.workspaceId, this.ctx.workspaceId),
          email === null ? mine : or(mine, sql`lower(${invite.email}::text) = lower(${email})`),
        ),
      )
      .orderBy(asc(invite.createdAt), asc(invite.id))
      .limit(1000);
  }

  /**
   * Audit events of this workspace in which the member is the actor, the subject or the person
   * acted for, oldest first, as the chain's canonical text plus the stored hash — the same form
   * `audit.export_rows` hands the signed audit export. `limit + 1` rows so the caller can tell a
   * truncated export from a complete one.
   */
  async auditRows(
    membershipId: string,
    limit = MAX_SUBJECT_AUDIT_ROWS,
  ): Promise<SubjectAuditRow[]> {
    const r = await this.tx.execute(sql`
      SELECT e.seq, audit.canonical(to_jsonb(e), e.prev_hash) AS canonical, encode(e.hash, 'hex') AS hash
      FROM audit.event e
      WHERE e.workspace_id = ${this.ctx.workspaceId}::uuid
        AND (e.actor_membership_id = ${membershipId}::uuid
             OR e.subject_membership_id = ${membershipId}::uuid
             OR e.on_behalf_of_membership_id = ${membershipId}::uuid)
      ORDER BY e.seq
      LIMIT ${limit + 1}`);
    return (r.rows as { seq: string | number; canonical: string; hash: string }[]).map((row) => ({
      seq: Number(row.seq),
      canonical: row.canonical,
      hash: row.hash,
    }));
  }

  /**
   * The person's sessions that last served this workspace (a session serving another workspace is
   * that tenant's fact), with the device name. `core.session`/`core.device` are global tables
   * fenced to the host or the session's own user: the transaction-local `app.user_id` is pointed
   * at the subject for these reads and restored straight after, on the same connection — the
   * same move as `IdentityErasureRepo.revokeWorkspaceSessions` — instead of a host transaction.
   */
  /**
   * E3.8: the SCIM projection of the person in this workspace (by membership or user, deleted rows
   * too) — what the tenant's IdP pushed about them. Never the group mapping's role internals.
   */
  async scimUsers(membershipId: string, userId: string) {
    return this.tx
      .select({
        id: scimUser.id,
        userName: sql<string>`${scimUser.userName}::text`,
        email: sql<string | null>`${scimUser.email}::text`,
        displayName: scimUser.displayName,
        givenName: scimUser.givenName,
        familyName: scimUser.familyName,
        externalId: scimUser.externalId,
        active: scimUser.active,
        createdAt: scimUser.createdAt,
        updatedAt: scimUser.updatedAt,
        deletedAt: scimUser.deletedAt,
      })
      .from(scimUser)
      .where(
        and(
          eq(scimUser.workspaceId, this.ctx.workspaceId),
          or(eq(scimUser.membershipId, membershipId), eq(scimUser.userId, userId)),
        ),
      )
      .orderBy(asc(scimUser.createdAt), asc(scimUser.id))
      .limit(MAX_SUBJECT_ROWS);
  }

  /**
   * E3.8: the person's SSO identities linked through THIS workspace's connections (identifier
   * `<connectionId>|<subject>`). Another workspace's links are that tenant's fact. `user_identity`'s
   * fence admits the user, so `app.user_id` is pointed at them for this read (as for sessions).
   */
  async ssoIdentities(userId: string) {
    const saved = await this.tx.execute(
      sql`SELECT current_setting('app.user_id', true) AS v, set_config('app.user_id', ${userId}, true)`,
    );
    const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
    const connections = this.tx
      .select({ id: sql`${ssoConnection.id}::text` })
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, this.ctx.workspaceId));
    const rows = await this.tx
      .select({
        type: userIdentity.type,
        identifier: userIdentity.identifier,
        verifiedAt: userIdentity.verifiedAt,
        createdAt: userIdentity.createdAt,
      })
      .from(userIdentity)
      .where(
        and(
          eq(userIdentity.userId, userId),
          inArray(userIdentity.type, ["oidc", "saml"]),
          inArray(sql`split_part(${userIdentity.identifier}, '|', 1)`, connections),
        ),
      )
      .orderBy(asc(userIdentity.createdAt), asc(userIdentity.id))
      .limit(MAX_SUBJECT_ROWS);
    await this.tx.execute(sql`SELECT set_config('app.user_id', ${previous}, true)`);
    return rows;
  }

  async sessions(userId: string) {
    const saved = await this.tx.execute(
      sql`SELECT current_setting('app.user_id', true) AS v, set_config('app.user_id', ${userId}, true)`,
    );
    const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
    const rows = await this.tx
      .select({
        id: session.id,
        deviceName: device.name,
        ip: session.ip,
        userAgent: session.userAgent,
        authLevel: session.authLevel,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt: session.revokedAt,
        revokedReason: session.revokedReason,
      })
      .from(session)
      .leftJoin(device, eq(device.id, session.deviceId))
      .where(
        and(
          eq(session.userId, userId),
          or(eq(session.lastWorkspaceId, this.ctx.workspaceId), isNull(session.lastWorkspaceId)),
        ),
      )
      .orderBy(asc(session.createdAt), asc(session.id))
      .limit(MAX_SUBJECT_ROWS);
    await this.tx.execute(sql`SELECT set_config('app.user_id', ${previous}, true)`);
    return rows;
  }

  /** Share links the member redeemed, and each session counted against a link's view budget. */
  async shareLinks(membershipId: string) {
    const ws = this.ctx.workspaceId;
    const visits = await this.tx
      .select({
        linkId: shareLinkVisit.linkId,
        firstSeenAt: shareLinkVisit.firstSeenAt,
        lastSeenAt: shareLinkVisit.lastSeenAt,
        views: shareLinkVisit.views,
        passcodeOkAt: shareLinkVisit.passcodeOkAt,
        revokedAt: shareLinkVisit.revokedAt,
      })
      .from(shareLinkVisit)
      .where(and(eq(shareLinkVisit.workspaceId, ws), eq(shareLinkVisit.membershipId, membershipId)))
      .orderBy(asc(shareLinkVisit.firstSeenAt), asc(shareLinkVisit.id))
      .limit(MAX_SUBJECT_ROWS);
    const views = await this.tx
      .select({
        linkId: shareLinkView.linkId,
        sessionId: shareLinkView.sessionId,
        firstSeenAt: shareLinkView.firstSeenAt,
      })
      .from(shareLinkView)
      .where(and(eq(shareLinkView.workspaceId, ws), eq(shareLinkView.membershipId, membershipId)))
      .orderBy(asc(shareLinkView.firstSeenAt), asc(shareLinkView.sessionId))
      .limit(MAX_SUBJECT_ROWS);
    return { visits, views };
  }

  /** Mail sent to the member through this workspace. Ids and flags only — no body is stored. */
  async mail(membershipId: string) {
    return this.tx
      .select({
        id: mailMessage.id,
        provider: mailMessage.provider,
        stream: mailMessage.stream,
        refKind: mailMessage.refKind,
        refId: mailMessage.refId,
        trackingOpens: mailMessage.trackingOpens,
        trackingClicks: mailMessage.trackingClicks,
        sentAt: mailMessage.sentAt,
      })
      .from(mailMessage)
      .where(
        and(
          eq(mailMessage.workspaceId, this.ctx.workspaceId),
          eq(mailMessage.membershipId, membershipId),
        ),
      )
      .orderBy(asc(mailMessage.sentAt), asc(mailMessage.id))
      .limit(MAX_SUBJECT_ROWS);
  }

  /**
   * Grants naming the member directly (`subject_kind = 'membership'`). Group and role grants are
   * the workspace's access design, not facts about the person; the staff note is left out.
   */
  async directGrants(membershipId: string) {
    return this.tx
      .select({
        id: accessGrant.id,
        resourceKind: accessGrant.resourceKind,
        resourceId: accessGrant.resourceId,
        capability: accessGrant.capability,
        effect: accessGrant.effect,
        validFrom: sql<string | null>`to_json(lower(${accessGrant.validity}))#>>'{}'`,
        validUntil: sql<string | null>`to_json(upper(${accessGrant.validity}))#>>'{}'`,
        maxViews: accessGrant.maxViews,
        createdAt: accessGrant.createdAt,
        revokedAt: accessGrant.revokedAt,
      })
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.workspaceId, this.ctx.workspaceId),
          eq(accessGrant.subjectKind, "membership"),
          eq(accessGrant.subjectId, membershipId),
        ),
      )
      .orderBy(asc(accessGrant.createdAt), asc(accessGrant.id))
      .limit(MAX_SUBJECT_ROWS);
  }

  /**
   * The member's own data-subject requests: kind, clock, outcome and the export digest. The
   * staff-written notes stay on the rows (the workspace's working notes, like `relationship_note`).
   */
  async dataRequests(membershipId: string) {
    return this.tx
      .select({
        id: dsarRequest.id,
        kind: dsarRequest.kind,
        status: dsarRequest.status,
        requestedAt: dsarRequest.requestedAt,
        dueAt: dsarRequest.dueAt,
        completedAt: dsarRequest.completedAt,
        cancelledAt: dsarRequest.cancelledAt,
        exportSha256: dsarRequest.exportSha256,
      })
      .from(dsarRequest)
      .where(
        and(
          eq(dsarRequest.workspaceId, this.ctx.workspaceId),
          eq(dsarRequest.membershipId, membershipId),
        ),
      )
      .orderBy(desc(dsarRequest.requestedAt), desc(dsarRequest.id))
      .limit(MAX_SUBJECT_ROWS);
  }

  /**
   * Whether a subject export of `membershipId` with this sha256 was made (and audited as
   * `compliance.dsar_exported`) in this workspace — what `exportSha256` on an access request's
   * completion must match.
   */
  async wasExported(membershipId: string, sha256: string): Promise<boolean> {
    const r = await this.tx.execute(sql`
      SELECT 1 AS hit FROM audit.event e
      WHERE e.workspace_id = ${this.ctx.workspaceId}::uuid
        AND e.action = 'compliance.dsar_exported'
        AND e.subject_membership_id = ${membershipId}::uuid
        AND e.meta->>'sha256' = ${sha256}
      LIMIT 1`);
    return r.rows.length > 0;
  }
}
