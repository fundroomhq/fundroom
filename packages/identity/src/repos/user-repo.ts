import { core, type Tx, type User, type UserIdentity } from "@fundroom/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { user, userIdentity } = core;

/*
 * Global user + identity rows (host context). Emails are lower-cased here and compared
 * through citext in the database, so `Alice@Example.com` and `alice@example.com` are one
 * identity.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new RangeError("invalid email address");
  return e;
}

export type UserWithIdentity = User & { readonly identity: UserIdentity };

export async function findUserByEmail(
  tx: Tx,
  email: string,
): Promise<UserWithIdentity | undefined> {
  const rows = await tx
    .select({ u: user, i: userIdentity })
    .from(userIdentity)
    .innerJoin(user, eq(user.id, userIdentity.userId))
    .where(
      and(
        eq(userIdentity.type, "email"),
        eq(userIdentity.identifier, normalizeEmail(email)),
        isNull(user.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { ...row.u, identity: row.i } : undefined;
}

export async function findIdentity(
  tx: Tx,
  type: UserIdentity["type"],
  identifier: string,
): Promise<UserWithIdentity | undefined> {
  const rows = await tx
    .select({ u: user, i: userIdentity })
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
  const row = rows[0];
  return row ? { ...row.u, identity: row.i } : undefined;
}

export async function findUserById(tx: Tx, id: string): Promise<User | undefined> {
  const rows = await tx
    .select()
    .from(user)
    .where(and(eq(user.id, id), isNull(user.deletedAt)))
    .limit(1);
  return rows[0];
}

export interface CreateUserInput {
  readonly displayName?: string;
  readonly identity: {
    readonly type: UserIdentity["type"];
    readonly identifier: string;
    readonly verified: boolean;
  };
}

export async function createUser(tx: Tx, input: CreateUserInput): Promise<UserWithIdentity> {
  const users = await tx
    .insert(user)
    .values({ displayName: input.displayName?.trim() ?? "" })
    .returning();
  const u = users[0];
  if (!u) throw new Error("insert returned no row");
  const identities = await tx
    .insert(userIdentity)
    .values({
      userId: u.id,
      type: input.identity.type,
      identifier:
        input.identity.type === "email"
          ? normalizeEmail(input.identity.identifier)
          : input.identity.identifier,
      verifiedAt: input.identity.verified ? new Date() : null,
      isPrimary: true,
    })
    .returning();
  const i = identities[0];
  if (!i) throw new Error("insert returned no row");
  return { ...u, identity: i };
}

export async function addIdentity(
  tx: Tx,
  userId: string,
  input: { type: UserIdentity["type"]; identifier: string; verified: boolean },
): Promise<UserIdentity> {
  const rows = await tx
    .insert(userIdentity)
    .values({
      userId,
      type: input.type,
      identifier: input.type === "email" ? normalizeEmail(input.identifier) : input.identifier,
      verifiedAt: input.verified ? new Date() : null,
      isPrimary: false,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function markIdentityVerified(tx: Tx, identityId: string): Promise<void> {
  await tx
    .update(userIdentity)
    .set({ verifiedAt: new Date() })
    .where(and(eq(userIdentity.id, identityId), isNull(userIdentity.verifiedAt)));
}

/** The address we email the user at: the primary email identity, else any verified email. */
export async function primaryEmail(tx: Tx, userId: string): Promise<string | undefined> {
  const rows = await tx
    .select({ identifier: userIdentity.identifier, isPrimary: userIdentity.isPrimary })
    .from(userIdentity)
    .where(and(eq(userIdentity.userId, userId), eq(userIdentity.type, "email")))
    .orderBy(sql`${userIdentity.isPrimary} DESC`, userIdentity.createdAt);
  return rows[0]?.identifier;
}

export async function bumpSessionVersion(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .update(user)
    .set({ sessionVersion: sql`${user.sessionVersion} + 1` })
    .where(eq(user.id, userId))
    .returning({ v: user.sessionVersion });
  return rows[0]?.v ?? 0;
}

export async function setMfaEnrolled(tx: Tx, userId: string, enrolled: boolean): Promise<void> {
  await tx.update(user).set({ mfaEnrolled: enrolled }).where(eq(user.id, userId));
}

export async function updateDisplayName(
  tx: Tx,
  userId: string,
  displayName: string,
): Promise<void> {
  await tx.update(user).set({ displayName: displayName.trim() }).where(eq(user.id, userId));
}

/**
 * The raw language preferences for an email recipient (E2.8): the user's own choice (by id or
 * by email identity; null for an address with no account) and the workspace default. Host
 * context. The caller negotiates (`recipientLocale`), this only reads.
 */
export async function findLocalePreferences(
  tx: Tx,
  input: {
    readonly userId?: string | undefined;
    readonly email?: string | undefined;
    readonly workspaceId?: string | undefined;
  },
): Promise<{ readonly user: string | null; readonly workspace: string | null }> {
  let userLocale: string | null = null;
  if (input.userId !== undefined) {
    const rows = await tx
      .select({ locale: user.locale })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);
    userLocale = rows[0]?.locale ?? null;
  } else if (input.email !== undefined) {
    // A savepoint: the caller's transaction must survive a lookup Postgres rejects (e.g. an
    // address with a NUL byte, 22021). A bare `.catch()` would swallow the error while the
    // transaction stays aborted, and the caller's next statement would fail with 25P02.
    const email = input.email;
    const found = await tx.transaction((sp) => findUserByEmail(sp, email)).catch(() => undefined);
    userLocale = found?.locale ?? null;
  }
  let workspaceLocale: string | null = null;
  if (input.workspaceId !== undefined) {
    const rows = await tx
      .select({ locale: core.workspace.defaultLocale })
      .from(core.workspace)
      .where(eq(core.workspace.id, input.workspaceId))
      .limit(1);
    workspaceLocale = rows[0]?.locale ?? null;
  }
  return { user: userLocale, workspace: workspaceLocale };
}

/** Sets (or, with null, clears) the user's language (E2.8, `PUT /me/locale`). Host context. */
export async function setUserLocale(tx: Tx, userId: string, locale: string | null): Promise<void> {
  await tx.update(user).set({ locale }).where(eq(user.id, userId));
}
