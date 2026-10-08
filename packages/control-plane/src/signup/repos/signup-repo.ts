import { type AuthChallenge, core, type Tx } from "@fundroom/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

const { authChallenge } = core;

/*
 * The signup email code (E3.10): a `core.auth_challenge` row of kind `signup`, host-level
 * (`workspace_id` NULL — the workspace does not exist yet), holding the HMAC of the code and, in
 * `data`, what the applicant asked for (company, legal name, country, slug, locale). Host context.
 */

export interface SignupChallengeData {
  readonly companyName: string;
  readonly legalName: string;
  readonly country: string;
  readonly slug: string;
  readonly locale: string | null;
  /** The terms version accepted at `start` (R1-L3); the attestation is written from this. */
  readonly termsVersion: number;
  /** ISO timestamp of that acceptance. */
  readonly termsAcceptedAt: string;
}

/** Retires every open signup code of the address (a new start supersedes the old one). */
export async function invalidateSignupChallenges(tx: Tx, email: string, at: Date): Promise<void> {
  await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(
      and(
        eq(authChallenge.kind, "signup"),
        isNull(authChallenge.workspaceId),
        eq(authChallenge.email, email),
        isNull(authChallenge.consumedAt),
      ),
    );
}

export async function insertSignupChallenge(
  tx: Tx,
  values: {
    readonly email: string;
    readonly secretHash: Buffer;
    readonly data: SignupChallengeData;
    readonly maxAttempts: number;
    readonly ip: string | null;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await tx.insert(authChallenge).values({
    kind: "signup",
    workspaceId: null,
    email: values.email,
    secretHash: values.secretHash,
    data: values.data,
    maxAttempts: values.maxAttempts,
    ip: values.ip,
    createdAt: values.createdAt,
    expiresAt: values.expiresAt,
  });
}

/** The newest open, unexpired signup code of the address, row-locked for the attempt. */
export async function lockOpenSignupChallenge(
  tx: Tx,
  email: string,
  now: Date,
): Promise<AuthChallenge | undefined> {
  const rows = await tx
    .select()
    .from(authChallenge)
    .where(
      and(
        eq(authChallenge.kind, "signup"),
        isNull(authChallenge.workspaceId),
        eq(authChallenge.email, email),
        isNull(authChallenge.consumedAt),
        gt(authChallenge.expiresAt, now),
      ),
    )
    .orderBy(desc(authChallenge.createdAt))
    .limit(1)
    .for("update");
  return rows[0];
}

/** Counts an attempt; returns the new count. */
export async function countSignupAttempt(tx: Tx, id: string): Promise<number> {
  const rows = await tx
    .update(authChallenge)
    .set({ attempts: sql`${authChallenge.attempts} + 1` })
    .where(eq(authChallenge.id, id))
    .returning({ attempts: authChallenge.attempts });
  return rows[0]?.attempts ?? Number.MAX_SAFE_INTEGER;
}

/** Single use: false when somebody consumed it first. */
export async function consumeSignupChallenge(tx: Tx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(and(eq(authChallenge.id, id), isNull(authChallenge.consumedAt)))
    .returning({ id: authChallenge.id });
  return rows.length > 0;
}
