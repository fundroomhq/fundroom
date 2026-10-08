import {
  type AuthChallenge,
  type AuthChallengeKind,
  core,
  type Membership,
  type NewAuthChallenge,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

const {
  ssoConnection,
  ssoDomain,
  ssoAssertionReplay,
  authChallenge,
  user,
  userIdentity,
  membership,
  workspace,
} = core;

/*
 * Every query `@fundroom/sso` runs (`migrations/core/0022_sso_scim.sql` is authoritative for the
 * tables, their RLS and CHECKs). Query builder only, except for the advisory lock.
 *
 *  - Tenant repos (`SsoConnectionRepo`, `SsoDomainRepo`) run in the workspace's system context.
 *  - Host functions run in `db.withHost`: the IdP-facing ops routes look a connection up by id
 *    before they know the workspace (host SELECT policy), the challenge rows live in
 *    `core.auth_challenge` (host, like every other login flow), the replay cache admits the host
 *    both ways, and user / identity rows are global.
 */

export type SsoConnectionRow = typeof ssoConnection.$inferSelect;
export type SsoDomainRow = typeof ssoDomain.$inferSelect;
export type NewSsoConnectionValues = Omit<typeof ssoConnection.$inferInsert, "workspaceId">;
export type SsoConnectionPatch = Partial<Omit<typeof ssoConnection.$inferInsert, "workspaceId">>;

export class SsoConnectionRepo extends TenantRepo<typeof ssoConnection> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(ssoConnection, ctx, tx);
  }

  /**
   * The connection singleton's advisory lock (`sso.connection:<ws>`), held to commit. First in the
   * global lock order: before the connection row, the workspace row and the audit chain.
   */
  async lockSingleton(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sso.connection:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async live(): Promise<SsoConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(ssoConnection)
      .where(this.scope(isNull(ssoConnection.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async liveForUpdate(): Promise<SsoConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(ssoConnection)
      .where(this.scope(isNull(ssoConnection.deletedAt)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async byId(id: string): Promise<SsoConnectionRow | undefined> {
    return this.findById(id);
  }

  /**
   * The row `FOR SHARE` (finish's link transaction): every writer (save / setState / delete)
   * takes it `FOR UPDATE` under the feature lock, so a login and a disable serialise.
   */
  async byIdForShare(id: string): Promise<SsoConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(ssoConnection)
      .where(this.scope(eq(ssoConnection.id, id)))
      .limit(1)
      .for("share");
    return rows[0];
  }

  async insert(values: NewSsoConnectionValues): Promise<SsoConnectionRow> {
    return this.insertOne(values);
  }

  async update(id: string, patch: SsoConnectionPatch): Promise<SsoConnectionRow | undefined> {
    const rows = await this.tx
      .update(ssoConnection)
      .set(patch)
      .where(this.scope(eq(ssoConnection.id, id)))
      .returning();
    return rows[0];
  }

  /** `jit_role` of the live connection, if any. */
  async liveJitRole(): Promise<SsoConnectionRow["jitRole"] | undefined> {
    const rows = await this.tx
      .select({ jitRole: ssoConnection.jitRole })
      .from(ssoConnection)
      .where(this.scope(isNull(ssoConnection.deletedAt)))
      .limit(1);
    return rows[0]?.jitRole;
  }
}

export class SsoDomainRepo extends TenantRepo<typeof ssoDomain> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(ssoDomain, ctx, tx);
  }

  async list(): Promise<SsoDomainRow[]> {
    return this.tx.select().from(ssoDomain).where(this.scope()).orderBy(asc(ssoDomain.domain));
  }

  async count(): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ssoDomain)
      .where(this.scope());
    return rows[0]?.n ?? 0;
  }

  async byId(id: string): Promise<SsoDomainRow | undefined> {
    return this.findById(id);
  }

  async byIdForUpdate(id: string): Promise<SsoDomainRow | undefined> {
    const rows = await this.tx
      .select()
      .from(ssoDomain)
      .where(this.scope(eq(ssoDomain.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async byDomain(domain: string): Promise<SsoDomainRow | undefined> {
    const rows = await this.tx
      .select()
      .from(ssoDomain)
      .where(this.scope(eq(ssoDomain.domain, domain)))
      .limit(1);
    return rows[0];
  }

  async insert(values: { domain: string; token: string }): Promise<SsoDomainRow> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<Pick<SsoDomainRow, "status" | "verifiedAt" | "lastCheckedAt" | "lastError">>,
  ): Promise<SsoDomainRow | undefined> {
    const rows = await this.tx
      .update(ssoDomain)
      .set(patch)
      .where(this.scope(eq(ssoDomain.id, id)))
      .returning();
    return rows[0];
  }

  async remove(id: string): Promise<number> {
    return this.deleteById(id);
  }

  async verified(): Promise<string[]> {
    const rows = await this.tx
      .select({ domain: ssoDomain.domain })
      .from(ssoDomain)
      .where(this.scope(eq(ssoDomain.status, "verified")))
      .orderBy(asc(ssoDomain.domain));
    return rows.map((r) => r.domain);
  }

  async isVerified(domain: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: ssoDomain.id })
      .from(ssoDomain)
      .where(this.scope(and(eq(ssoDomain.domain, domain), eq(ssoDomain.status, "verified"))))
      .limit(1);
    return rows.length > 0;
  }
}

/**
 * Mirrors the live connection onto the workspace row the tenant resolver reads: `sso_enforced`,
 * and — while it is ENABLED — its id and version (null otherwise). Session resolution admits a
 * bound session only while these match what it was minted under. An UPDATE of the workspace row:
 * callers place it right before their audit (global lock order: feature lock → entity rows →
 * workspace row → audit chain).
 */
export async function setWorkspaceSsoMirror(
  tx: Tx,
  workspaceId: string,
  live: Pick<SsoConnectionRow, "id" | "version" | "enabled" | "enforce"> | undefined,
): Promise<void> {
  const on = live?.enabled === true ? live : undefined;
  const enforced = on?.enforce === "staff";
  const connectionId = on?.id ?? null;
  const version = on?.version ?? null;
  await tx
    .update(workspace)
    .set({ ssoEnforced: enforced, ssoConnectionId: connectionId, ssoConnectionVersion: version })
    .where(
      and(
        eq(workspace.id, workspaceId),
        sql`(${workspace.ssoEnforced}, ${workspace.ssoConnectionId}, ${workspace.ssoConnectionVersion}) IS DISTINCT FROM (${enforced}, ${connectionId}::uuid, ${version}::integer)`,
      ),
    );
}

// --- host context ------------------------------------------------------------------------------

/** A connection by id, live or deleted (host SELECT policy). */
export async function hostFindConnection(
  tx: Tx,
  id: string,
): Promise<SsoConnectionRow | undefined> {
  const rows = await tx.select().from(ssoConnection).where(eq(ssoConnection.id, id)).limit(1);
  return rows[0];
}

export async function insertChallenge(tx: Tx, values: NewAuthChallenge): Promise<AuthChallenge> {
  const rows = await tx.insert(authChallenge).values(values).returning();
  const row = rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

export async function findChallenge(
  tx: Tx,
  kind: AuthChallengeKind,
  secretHash: Buffer,
): Promise<AuthChallenge | undefined> {
  const rows = await tx
    .select()
    .from(authChallenge)
    .where(and(eq(authChallenge.kind, kind), eq(authChallenge.secretHash, secretHash)))
    .limit(1);
  return rows[0];
}

/** Marks a challenge used; `false` when it already was (single use, atomic). */
export async function consumeChallenge(tx: Tx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(and(eq(authChallenge.id, id), isNull(authChallenge.consumedAt)))
    .returning({ id: authChallenge.id });
  return rows.length > 0;
}

/** Records a SAML assertion id; `false` when it was already there (a replay). */
export async function recordAssertion(
  tx: Tx,
  values: { workspaceId: string; connectionId: string; assertionId: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await tx
    .insert(ssoAssertionReplay)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: ssoAssertionReplay.assertionId });
  return rows.length > 0;
}

export async function sweepAssertions(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .delete(ssoAssertionReplay)
    .where(lt(ssoAssertionReplay.expiresAt, before))
    .returning({ id: ssoAssertionReplay.assertionId });
  return rows.length;
}

/** The live user an identity row names, if any. */
export async function findUserByIdentity(
  tx: Tx,
  type: "oidc" | "saml" | "email",
  identifier: string,
): Promise<string | undefined> {
  const rows = await tx
    .select({ id: user.id })
    .from(userIdentity)
    .innerJoin(user, eq(user.id, userIdentity.userId))
    .where(
      and(
        eq(userIdentity.type, type),
        eq(userIdentity.identifier, identifier),
        isNull(user.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/** Links an SSO identity to a user; `false` when the (type, identifier) pair is already taken. */
export async function addSsoIdentity(
  tx: Tx,
  userId: string,
  type: "oidc" | "saml",
  identifier: string,
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .insert(userIdentity)
    .values({ userId, type, identifier, verifiedAt: at, isPrimary: false })
    .onConflictDoNothing()
    .returning({ id: userIdentity.id });
  return rows.length > 0;
}

// --- workspace (system) context: memberships -----------------------------------------------------

/** The user's non-revoked membership in the context's workspace (one per user by constraint). */
export async function findLiveMembership(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
): Promise<Membership | undefined> {
  const rows = await tx
    .select()
    .from(membership)
    .where(
      and(
        eq(membership.workspaceId, ctx.workspaceId),
        eq(membership.userId, userId),
        sql`${membership.status} <> 'revoked'`,
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Locks the membership `FOR SHARE` (erasure and revocation take it `FOR UPDATE` / `NO KEY
 * UPDATE`, so they serialise with the caller's transaction) and says whether it is still a live
 * staff seat. Workspace (system) context.
 */
export async function lockLiveStaffMembership(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ kind: membership.kind, status: membership.status })
    .from(membership)
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)))
    .limit(1)
    .for("share");
  const m = rows[0];
  return (
    m !== undefined && m.kind === "staff" && m.status !== "revoked" && m.status !== "suspended"
  );
}

/** A membership row of the context's workspace (no lock). */
export async function findMembershipById(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
  options: { readonly share?: boolean } = {},
): Promise<Membership | undefined> {
  const q = tx
    .select()
    .from(membership)
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)))
    .limit(1);
  const rows = options.share === true ? await q.for("share") : await q;
  return rows[0];
}
