import {
  type AuthChallenge,
  type AuthChallengeKind,
  core,
  type NewAuthChallenge,
  type Tx,
} from "@fundroom/db";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

const { authChallenge } = core;

export async function insertChallenge(tx: Tx, values: NewAuthChallenge): Promise<AuthChallenge> {
  const rows = await tx.insert(authChallenge).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function findChallengeById(tx: Tx, id: string): Promise<AuthChallenge | undefined> {
  const rows = await tx.select().from(authChallenge).where(eq(authChallenge.id, id)).limit(1);
  return rows[0];
}

export async function findChallengeBySecretHash(
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

function scope(kind: AuthChallengeKind, workspaceId: string | null, email: string) {
  return and(
    eq(authChallenge.kind, kind),
    workspaceId === null
      ? isNull(authChallenge.workspaceId)
      : eq(authChallenge.workspaceId, workspaceId),
    eq(authChallenge.email, email),
    isNull(authChallenge.consumedAt),
  );
}

/** Newest unconsumed, unexpired challenge for an email in a workspace (or host-level when null). */
export async function findLatestChallengeForEmail(
  tx: Tx,
  kind: AuthChallengeKind,
  workspaceId: string | null,
  email: string,
  now = new Date(),
): Promise<AuthChallenge | undefined> {
  const rows = await tx
    .select()
    .from(authChallenge)
    .where(and(scope(kind, workspaceId, email), gt(authChallenge.expiresAt, now)))
    .orderBy(desc(authChallenge.createdAt))
    .limit(1);
  return rows[0];
}

/** Atomically counts an attempt; returns the new count so the caller can compare to max. */
export async function recordAttempt(tx: Tx, id: string): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ attempts: sql`${authChallenge.attempts} + 1` })
    .where(eq(authChallenge.id, id))
    .returning({ attempts: authChallenge.attempts });
  return rows[0]?.attempts ?? Number.MAX_SAFE_INTEGER;
}

/** Marks the challenge used. Returns false if it was already consumed (single use). */
export async function consumeChallenge(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: new Date() })
    .where(and(eq(authChallenge.id, id), isNull(authChallenge.consumedAt)))
    .returning({ id: authChallenge.id });
  return rows.length > 0;
}

/** Invalidates every open challenge of a kind for an email (new request supersedes old ones). */
export async function invalidateChallenges(
  tx: Tx,
  kind: AuthChallengeKind,
  workspaceId: string | null,
  email: string,
): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: new Date() })
    .where(scope(kind, workspaceId, email))
    .returning({ id: authChallenge.id });
  return rows.length;
}

export async function invalidateChallengesForUser(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: new Date() })
    .where(and(eq(authChallenge.userId, userId), isNull(authChallenge.consumedAt)))
    .returning({ id: authChallenge.id });
  return rows.length;
}

export async function deleteExpiredChallenges(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .delete(authChallenge)
    .where(lt(authChallenge.expiresAt, before))
    .returning({ id: authChallenge.id });
  return rows.length;
}
