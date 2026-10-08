import { core, type PlatformOperatorRow, type Tx } from "@fundroom/db";
import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

const { credential, platformOperator, session, user, userIdentity } = core;

/*
 * `core.platform_operator` (E3.10). Host context only: the table's fence admits nothing else, so
 * a tenant transaction reads no row even for its own user.
 */

/** The user's live (unrevoked) operator row, if any. */
export async function findLiveOperator(
  tx: Tx,
  userId: string,
): Promise<PlatformOperatorRow | undefined> {
  const rows = await tx
    .select()
    .from(platformOperator)
    .where(and(eq(platformOperator.userId, userId), isNull(platformOperator.revokedAt)))
    .limit(1);
  return rows[0];
}

/** The user's operator row, live or revoked, locked for the grant/revoke that follows. */
export async function lockOperatorRow(
  tx: Tx,
  userId: string,
): Promise<PlatformOperatorRow | undefined> {
  const rows = await tx
    .select()
    .from(platformOperator)
    .where(eq(platformOperator.userId, userId))
    .limit(1)
    .for("update");
  return rows[0];
}

/** Inserts the row, or re-grants a revoked one (a fresh `created_at` / `created_by`). */
export async function writeOperatorGrant(
  tx: Tx,
  userId: string,
  createdBy: string,
  existing: boolean,
): Promise<PlatformOperatorRow> {
  const rows = existing
    ? await tx
        .update(platformOperator)
        .set({ revokedAt: null, createdAt: new Date(), createdBy })
        .where(eq(platformOperator.userId, userId))
        .returning()
    : await tx.insert(platformOperator).values({ userId, createdBy }).returning();
  const row = rows[0];
  if (row === undefined) throw new Error("operator write returned no row");
  return row;
}

export async function writeOperatorRevoke(
  tx: Tx,
  userId: string,
  at: Date,
): Promise<PlatformOperatorRow | undefined> {
  const rows = await tx
    .update(platformOperator)
    .set({ revokedAt: at })
    .where(and(eq(platformOperator.userId, userId), isNull(platformOperator.revokedAt)))
    .returning();
  return rows[0];
}

/**
 * Ends every live operator session of the user (a revoke must not leave one usable for the rest
 * of its 12 hours — `requirePlatformOperator()` re-checks the row anyway). Tenant sessions stay.
 */
export async function revokeOperatorSessions(tx: Tx, userId: string, at: Date): Promise<number> {
  const rows = await tx
    .update(session)
    .set({ revokedAt: at, revokedReason: "admin" })
    .where(
      and(
        eq(session.userId, userId),
        eq(session.population, "operator"),
        isNull(session.revokedAt),
      ),
    )
    .returning({ id: session.id });
  return rows.length;
}

export interface OperatorListRow {
  readonly userId: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly revokedAt: Date | null;
}

/** Every operator row with the user's primary email address, oldest grant first. */
export async function listOperatorRows(tx: Tx): Promise<OperatorListRow[]> {
  const rows = await tx
    .select({
      userId: platformOperator.userId,
      email: sql<string | null>`(
        SELECT ui.identifier::text FROM core.user_identity ui
         WHERE ui.user_id = core.platform_operator.user_id AND ui.type = 'email'
         ORDER BY ui.is_primary DESC, ui.created_at
         LIMIT 1)`,
      createdAt: platformOperator.createdAt,
      createdBy: platformOperator.createdBy,
      revokedAt: platformOperator.revokedAt,
    })
    .from(platformOperator)
    .orderBy(asc(platformOperator.createdAt), asc(platformOperator.userId));
  return rows;
}

// --- global users (host context) ----------------------------------------------------------------

/** The live user owning this (normalised) email identity, if any. */
export async function findUserIdByEmail(tx: Tx, email: string): Promise<string | undefined> {
  const rows = await tx
    .select({ id: user.id })
    .from(userIdentity)
    .innerJoin(user, eq(user.id, userIdentity.userId))
    .where(
      and(
        eq(userIdentity.type, "email"),
        eq(userIdentity.identifier, email),
        isNull(user.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/**
 * Creates a user with a verified primary email identity (the CLI operator vouches for the address;
 * signup has just proven control of it with an emailed code).
 */
export async function insertEmailUser(tx: Tx, email: string, at: Date): Promise<string> {
  const users = await tx.insert(user).values({ displayName: "" }).returning({ id: user.id });
  const id = users[0]?.id;
  if (id === undefined) throw new Error("user insert returned no row");
  await tx
    .insert(userIdentity)
    .values({ userId: id, type: "email", identifier: email, verifiedAt: at, isPrimary: true });
  return id;
}

/** Marks an unverified email identity verified (its owner just proved control of it). */
export async function markEmailVerified(tx: Tx, email: string, at: Date): Promise<void> {
  await tx
    .update(userIdentity)
    .set({ verifiedAt: at })
    .where(
      and(
        eq(userIdentity.type, "email"),
        eq(userIdentity.identifier, email),
        isNull(userIdentity.verifiedAt),
      ),
    );
}

/** The user's display name and primary email (for `GET /platform/me`). */
export async function findUserFacts(
  tx: Tx,
  userId: string,
): Promise<{ displayName: string; email: string | null } | undefined> {
  const rows = await tx
    .select({
      displayName: user.displayName,
      email: sql<string | null>`(
        SELECT ui.identifier::text FROM core.user_identity ui
         WHERE ui.user_id = core."user".id AND ui.type = 'email'
         ORDER BY ui.is_primary DESC, ui.created_at
         LIMIT 1)`,
    })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .limit(1);
  return rows[0];
}

// --- second factors (host context) --------------------------------------------------------------

/**
 * Whether the user holds a factor that proves auth level 2 on its own: a live passkey or a
 * confirmed TOTP (recovery codes only back those up). `fundroom operator grant` requires one.
 */
export async function hasStrongFactor(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: credential.id })
    .from(credential)
    .where(
      and(
        eq(credential.userId, userId),
        isNull(credential.revokedAt),
        or(
          eq(credential.kind, "passkey"),
          and(eq(credential.kind, "totp"), isNotNull(credential.confirmedAt)),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface ProofFactorRow {
  readonly kind: "passkey" | "totp" | "recovery_codes";
  /** When the factor became usable: a TOTP's confirmation, else its creation. */
  readonly usableSince: Date;
}

/**
 * The user's level-2 factors used at or after `since` — the candidates for the proof that raised
 * a session to level 2 (every step-up and passkey sign-in stamps the factor's `last_used_at` just
 * before it stamps the session's `auth_time`).
 */
export async function proofFactorsUsedSince(
  tx: Tx,
  userId: string,
  since: Date,
): Promise<ProofFactorRow[]> {
  const rows = await tx
    .select({
      kind: credential.kind,
      createdAt: credential.createdAt,
      confirmedAt: credential.confirmedAt,
    })
    .from(credential)
    .where(
      and(
        eq(credential.userId, userId),
        isNull(credential.revokedAt),
        inArray(credential.kind, ["passkey", "totp", "recovery_codes"]),
        isNotNull(credential.lastUsedAt),
        gte(credential.lastUsedAt, since),
      ),
    );
  return rows.map((r) => ({
    kind: r.kind as ProofFactorRow["kind"],
    usableSince:
      r.confirmedAt !== null && r.confirmedAt.getTime() > r.createdAt.getTime()
        ? r.confirmedAt
        : r.createdAt,
  }));
}
