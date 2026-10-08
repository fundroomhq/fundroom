import { type AuthChallenge, core, type Tx } from "@fundroom/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { authChallenge } = core;

/*
 * A new operator's enrolment (E3.10 fix round 2): `core.auth_challenge` rows of kind
 * `operator_enrol`, host-level (`workspace_id` NULL), in two phases:
 *
 *   link      minted by `fundroom operator enrol-link <email>`: the HASH of the printed token,
 *             the address it is for, and — once `start` emailed one — the HMAC of the email code
 *   session   minted when token + address + code check out: the hash of the enrolment cookie and
 *             the user it may add a first factor for (15 minutes)
 *
 * Host context only (the fence admits the host for host-level challenge rows).
 */

export type EnrolPhase = "link" | "session";

export interface EnrolLinkData {
  readonly phase: "link";
  readonly createdBy: string;
  /** Hex HMAC of the emailed code (`hashCode`), once `start` sent one. */
  readonly codeHash?: string | undefined;
  readonly codeExpiresAt?: string | undefined;
  /** How many codes this link has sent (capped). */
  readonly sends?: number | undefined;
}

export interface EnrolSessionData {
  readonly phase: "session";
  readonly linkId: string;
}

/** Retires every open enrolment link for the address (a new link supersedes the old one). */
export async function retireEnrolLinks(tx: Tx, email: string, at: Date): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(
      and(
        eq(authChallenge.kind, "operator_enrol"),
        isNull(authChallenge.workspaceId),
        eq(authChallenge.email, email),
        isNull(authChallenge.consumedAt),
        sql`${authChallenge.data}->>'phase' = 'link'`,
      ),
    )
    .returning({ id: authChallenge.id });
  return rows.length;
}

export async function insertEnrolChallenge(
  tx: Tx,
  values: {
    readonly email: string;
    readonly userId: string | null;
    readonly secretHash: Buffer;
    readonly data: EnrolLinkData | EnrolSessionData;
    readonly maxAttempts: number;
    readonly ip: string | null;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<AuthChallenge> {
  const rows = await tx
    .insert(authChallenge)
    .values({
      kind: "operator_enrol",
      workspaceId: null,
      email: values.email,
      userId: values.userId,
      secretHash: values.secretHash,
      data: values.data,
      maxAttempts: values.maxAttempts,
      ip: values.ip,
      createdAt: values.createdAt,
      expiresAt: values.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("enrolment challenge insert returned no row");
  return row;
}

/** The open (unconsumed, unexpired) row of that phase with this secret hash, row-locked. */
export async function lockOpenEnrolChallenge(
  tx: Tx,
  secretHash: Buffer,
  phase: EnrolPhase,
  now: Date,
): Promise<AuthChallenge | undefined> {
  const rows = await tx
    .select()
    .from(authChallenge)
    .where(
      and(
        eq(authChallenge.kind, "operator_enrol"),
        eq(authChallenge.secretHash, secretHash),
        isNull(authChallenge.workspaceId),
        isNull(authChallenge.consumedAt),
        sql`${authChallenge.expiresAt} > ${now.toISOString()}::timestamptz`,
        sql`${authChallenge.data}->>'phase' = ${phase}`,
      ),
    )
    .limit(1)
    .for("update");
  return rows[0];
}

export async function writeEnrolData(
  tx: Tx,
  id: string,
  data: EnrolLinkData | EnrolSessionData,
): Promise<void> {
  await tx.update(authChallenge).set({ data }).where(eq(authChallenge.id, id));
}

/** Counts a code attempt; returns the new count. */
export async function countEnrolAttempt(tx: Tx, id: string): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ attempts: sql`${authChallenge.attempts} + 1` })
    .where(eq(authChallenge.id, id))
    .returning({ attempts: authChallenge.attempts });
  return rows[0]?.attempts ?? Number.MAX_SAFE_INTEGER;
}

/** Single use: false when somebody consumed it first. */
export async function consumeEnrolChallenge(tx: Tx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(and(eq(authChallenge.id, id), isNull(authChallenge.consumedAt)))
    .returning({ id: authChallenge.id });
  return rows.length > 0;
}
