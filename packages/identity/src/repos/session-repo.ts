import { core, type NewSession, type Session, type Tx } from "@fundroom/db";
import type { AuthPopulation } from "@fundroom/ports";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

const { session, user } = core;

export interface SessionWithUser extends Session {
  readonly userSessionVersion: number;
  readonly userDeletedAt: Date | null;
  readonly displayName: string;
  readonly mfaEnrolled: boolean;
  readonly locale: string | null;
}

const withUser = {
  s: session,
  userSessionVersion: user.sessionVersion,
  userDeletedAt: user.deletedAt,
  displayName: user.displayName,
  mfaEnrolled: user.mfaEnrolled,
  locale: user.locale,
};

function flatten(row: {
  s: Session;
  userSessionVersion: number;
  userDeletedAt: Date | null;
  displayName: string;
  mfaEnrolled: boolean;
  locale: string | null;
}): SessionWithUser {
  return {
    ...row.s,
    userSessionVersion: row.userSessionVersion,
    userDeletedAt: row.userDeletedAt,
    displayName: row.displayName,
    mfaEnrolled: row.mfaEnrolled,
    locale: row.locale,
  };
}

export async function insertSession(tx: Tx, values: NewSession): Promise<Session> {
  const rows = await tx.insert(session).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function findSessionByTokenHash(
  tx: Tx,
  tokenHash: Buffer,
): Promise<SessionWithUser | undefined> {
  const rows = await tx
    .select(withUser)
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  return row ? flatten(row) : undefined;
}

export async function findSessionById(tx: Tx, id: string): Promise<SessionWithUser | undefined> {
  const rows = await tx
    .select(withUser)
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(eq(session.id, id))
    .limit(1);
  const row = rows[0];
  return row ? flatten(row) : undefined;
}

export async function findSessionByRevokeTokenHash(
  tx: Tx,
  hash: Buffer,
): Promise<Session | undefined> {
  const rows = await tx.select().from(session).where(eq(session.revokeTokenHash, hash)).limit(1);
  return rows[0];
}

/** The one-click revoke token is single use. */
export async function clearRevokeToken(tx: Tx, id: string): Promise<void> {
  await tx.update(session).set({ revokeTokenHash: null }).where(eq(session.id, id));
}

export async function touchSession(
  tx: Tx,
  id: string,
  patch: { lastSeenAt: Date; idleExpiresAt: Date },
): Promise<void> {
  await tx.update(session).set(patch).where(eq(session.id, id));
}

export async function setSessionWorkspace(tx: Tx, id: string, workspaceId: string): Promise<void> {
  await tx.update(session).set({ lastWorkspaceId: workspaceId }).where(eq(session.id, id));
}

export async function setSessionAuth(
  tx: Tx,
  id: string,
  patch: { authLevel: number; authTime: Date; tokenHash?: Buffer },
): Promise<void> {
  await tx.update(session).set(patch).where(eq(session.id, id));
}

const active = () => isNull(session.revokedAt);

/** Returns true when the row was live and is now revoked. */
export async function revokeSession(tx: Tx, id: string, reason: string): Promise<boolean> {
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.id, id), active()))
    .returning({ id: session.id });
  return rows.length > 0;
}

/**
 * The live sessions minted FROM `sourceSessionId` (E3.10 FR1, R2-L1: central-auth handoffs — and
 * operator mints — record the canonical session they came from). Revoked with it: signing out on
 * the canonical host ends what that sign-in handed to workspace hosts. One level deep — a derived
 * session is never itself a source (a bound session is no session on the canonical host).
 */
export async function revokeDerivedSessions(
  tx: Tx,
  sourceSessionId: string,
  reason: string,
): Promise<{ readonly id: string; readonly userId: string }[]> {
  return tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.sourceSessionId, sourceSessionId), active()))
    .returning({ id: session.id, userId: session.userId });
}

/**
 * The live sessions minted from ANY of `sourceIds`, revoked (FR4: the bulk revocations — by
 * workspace, SSO connection, device, user — cascade like a single sign-out). One level deep.
 */
export async function revokeDerivedOf(
  tx: Tx,
  sourceIds: readonly string[],
  reason = "source_revoked",
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(inArray(session.sourceSessionId, [...sourceIds]), active()))
    .returning({ id: session.id });
  return rows.length;
}

/**
 * Whether a session may be the source of a derived session of `population` (FR4). An operator
 * session is minted only from a canonical session (not SSO- or workspace-bound) at auth level 2,
 * so it may only ever hang off one.
 */
export function mayBeSourceFor(
  source: Pick<Session, "ssoWorkspaceId" | "boundWorkspaceId" | "authLevel">,
  population: string,
): boolean {
  if (population !== "operator") return true;
  return (
    source.ssoWorkspaceId === null && source.boundWorkspaceId === null && source.authLevel >= 2
  );
}

/**
 * A fresh login of the SAME user in the same browser replaced `fromSessionId` (FR3 RR1-M2): what
 * the old session handed out now hangs off the new one, so signing the new one out still ends it.
 * A derived session the new one may not be the source of (FR4, `mayBeSourceFor` — an operator
 * session under an SSO-/workspace-bound or level-1 login) is revoked (`source_revoked`) instead.
 */
export async function reparentDerivedSessions(
  tx: Tx,
  fromSessionId: string,
  to: Pick<Session, "id" | "ssoWorkspaceId" | "boundWorkspaceId" | "authLevel">,
): Promise<{ readonly moved: number; readonly revoked: { id: string; userId: string }[] }> {
  const derived = await tx
    .select({ id: session.id, userId: session.userId, population: session.population })
    .from(session)
    .where(and(eq(session.sourceSessionId, fromSessionId), active()))
    .for("update");
  const revoked: { id: string; userId: string }[] = [];
  let moved = 0;
  for (const d of derived) {
    if (mayBeSourceFor(to, d.population)) {
      await tx.update(session).set({ sourceSessionId: to.id }).where(eq(session.id, d.id));
      moved++;
    } else if (await revokeSession(tx, d.id, "source_revoked")) {
      revoked.push({ id: d.id, userId: d.userId });
    }
  }
  return { moved, revoked };
}

export async function revokeSessionsForUser(
  tx: Tx,
  userId: string,
  reason: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const where = options.exceptSessionId
    ? and(eq(session.userId, userId), active(), sql`${session.id} <> ${options.exceptSessionId}`)
    : and(eq(session.userId, userId), active());
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(where)
    .returning({ id: session.id });
  // Derived sessions are the same user's, so revoked above already; kept for symmetry (FR4).
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/**
 * The sessions a membership change in `workspaceId` ends (§13.2): those that last served this
 * workspace, and every session bound to it — minted by its SSO (E3.8) or by a central-auth
 * handoff for it (E3.10) — which can serve no other workspace, so it is this workspace's whatever
 * it last touched. Never an operator session (it serves no workspace at all), and (E3.10 FR3,
 * RR1-L2) never a canonical session that has served no workspace yet: a tenant suspending or
 * deprovisioning a member must not sign that person out of the canonical host (or, through its
 * derived sessions, out of every other workspace). Such a session gains nothing here — the
 * middleware re-checks the membership on every request.
 */
function workspaceSessions(userId: string, workspaceId: string) {
  return and(
    eq(session.userId, userId),
    active(),
    sql`${session.population} <> 'operator'`,
    or(
      eq(session.lastWorkspaceId, workspaceId),
      eq(session.boundWorkspaceId, workspaceId),
      eq(session.ssoWorkspaceId, workspaceId),
    ),
  );
}

/** Sessions that last served this workspace or are bound to it (§13.2; see `workspaceSessions`). */
export async function revokeSessionsForWorkspace(
  tx: Tx,
  userId: string,
  workspaceId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(workspaceSessions(userId, workspaceId))
    .returning({ id: session.id });
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/**
 * `revokeSessionsForWorkspace` on a **tenant** transaction (E3.8 suspension / SCIM): `core.session`
 * is a global table whose fence admits the host or the session's own user, so the
 * transaction-local `app.user_id` is pointed at the subject for this one statement and restored
 * straight after, on the same connection — the way the identity-erasure step does it — rather
 * than opening a host transaction (a second pool connection under the caller's). Session rows are
 * only ever locked by host transactions that take no workspace row, so this cannot close a cycle.
 */
export async function revokeSessionsForWorkspaceAsSubject(
  tx: Tx,
  userId: string,
  workspaceId: string,
  reason: string,
): Promise<number> {
  const saved = await tx.execute(
    sql`SELECT current_setting('app.user_id', true) AS v, set_config('app.user_id', ${userId}, true)`,
  );
  const previous = (saved.rows[0] as { v: string | null } | undefined)?.v ?? "";
  // No `finally`: on an error the transaction is aborted and rolling back reverts the setting.
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(workspaceSessions(userId, workspaceId))
    .returning({ id: session.id });
  // Derived sessions are the subject's own, so still inside the fence set above (FR4).
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  await tx.execute(sql`SELECT set_config('app.user_id', ${previous}, true)`);
  return rows.length;
}

/** Every live session minted by one SSO connection (E3.8: the connection was deleted). */
export async function revokeSessionsForSsoConnection(
  tx: Tx,
  connectionId: string,
  reason: string,
): Promise<{ readonly userId: string; readonly workspaceId: string | null }[]> {
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.ssoConnectionId, connectionId), active()))
    .returning({ id: session.id, userId: session.userId, workspaceId: session.ssoWorkspaceId });
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ userId: r.userId, workspaceId: r.workspaceId }));
}

/** The SSO binding a session row carries (both columns or neither, by CHECK). */
export function ssoBindingOf(
  row: Pick<Session, "ssoWorkspaceId" | "ssoConnectionId" | "ssoConnectionVersion">,
):
  | {
      readonly workspaceId: string;
      readonly connectionId: string;
      readonly connectionVersion?: number | undefined;
    }
  | undefined {
  if (row.ssoWorkspaceId === null || row.ssoConnectionId === null) return undefined;
  return {
    workspaceId: row.ssoWorkspaceId,
    connectionId: row.ssoConnectionId,
    ...(row.ssoConnectionVersion === null ? {} : { connectionVersion: row.ssoConnectionVersion }),
  };
}

export async function revokeSessionsForDevice(
  tx: Tx,
  deviceId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(session)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(session.deviceId, deviceId), active()))
    .returning({ id: session.id });
  await revokeDerivedOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/** Live sessions (not revoked, not past absolute expiry), newest activity first. */
export async function listSessionsForUser(
  tx: Tx,
  userId: string,
  now = new Date(),
): Promise<Session[]> {
  return tx
    .select()
    .from(session)
    .where(
      and(
        eq(session.userId, userId),
        active(),
        gt(session.absoluteExpiresAt, now),
        gt(session.idleExpiresAt, now),
      ),
    )
    .orderBy(desc(session.lastSeenAt));
}

/**
 * Which sessions one concurrent-session cap counts (E3.10 FR1). A login counts only the user's
 * sessions of its own population that are NOT bound to a workspace by central auth — so an
 * operator mint never evicts a staff session and a staff login never evicts an operator one,
 * and a custom-domain handoff never evicts the canonical session it came from. A central mint
 * counts only the sessions bound to the same workspace (its own small cap).
 */
export type SessionCapScope =
  | { readonly population: AuthPopulation; readonly boundWorkspaceId?: undefined }
  | { readonly boundWorkspaceId: string };

/** Enforces the concurrent-session cap: revokes the least recently seen beyond `keep`. */
export async function revokeSessionsBeyond(
  tx: Tx,
  userId: string,
  keep: number,
  scope: SessionCapScope,
  now = new Date(),
): Promise<number> {
  const live = await tx
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.userId, userId),
        active(),
        gt(session.absoluteExpiresAt, now),
        gt(session.idleExpiresAt, now),
        scope.boundWorkspaceId === undefined
          ? and(eq(session.population, scope.population), isNull(session.boundWorkspaceId))
          : eq(session.boundWorkspaceId, scope.boundWorkspaceId),
      ),
    )
    .orderBy(asc(session.lastSeenAt));
  const excess = live.length - keep;
  if (excess <= 0) return 0;
  let n = 0;
  for (const row of live.slice(0, excess)) {
    if (await revokeSession(tx, row.id, "concurrent_limit")) {
      n++;
      // What the evicted session handed out goes with it (FR3 RR1-L1), as on a sign-out.
      await revokeDerivedSessions(tx, row.id, "source_revoked");
    }
  }
  return n;
}

/** Cleanup (E0.4 job): drop rows nobody can use any more. */
export async function deleteDeadSessions(tx: Tx, before: Date): Promise<number> {
  const rows = await tx
    .delete(session)
    .where(or(lt(session.absoluteExpiresAt, before), lt(session.revokedAt, before)))
    .returning({ id: session.id });
  return rows.length;
}

// --- view as investor (E2.7) --------------------------------------------------------------------

export interface SessionViewAsRow {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly startedAt: Date;
  readonly until: Date;
}

export function viewAsOf(row: Session): SessionViewAsRow | undefined {
  if (
    row.viewAsWorkspaceId === null ||
    row.viewAsMembershipId === null ||
    row.viewAsStartedAt === null ||
    row.viewAsUntil === null
  ) {
    return undefined;
  }
  return {
    workspaceId: row.viewAsWorkspaceId,
    membershipId: row.viewAsMembershipId,
    startedAt: row.viewAsStartedAt,
    until: row.viewAsUntil,
  };
}

/** Locks a live session row for a read-modify-write of its view-as state. */
export async function lockLiveSession(tx: Tx, id: string): Promise<Session | undefined> {
  const rows = await tx
    .select()
    .from(session)
    .where(and(eq(session.id, id), active()))
    .for("update")
    .limit(1);
  return rows[0];
}

export async function setSessionViewAs(
  tx: Tx,
  id: string,
  viewAs: SessionViewAsRow | null,
): Promise<void> {
  await tx
    .update(session)
    .set({
      viewAsWorkspaceId: viewAs?.workspaceId ?? null,
      viewAsMembershipId: viewAs?.membershipId ?? null,
      viewAsStartedAt: viewAs?.startedAt ?? null,
      viewAsUntil: viewAs?.until ?? null,
    })
    .where(eq(session.id, id));
}
