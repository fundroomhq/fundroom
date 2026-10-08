import { type AuthChallenge, core, type Tx } from "@fundroom/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { authChallenge } = core;

/*
 * The two `core.auth_challenge` writes central auth (E3.10) needs beyond `challenge-repo.ts`:
 * consumption stamped with the service's clock (the shared `consumeChallenge` uses the wall clock),
 * and recording which session a handoff minted, so a replay of that handoff can revoke it
 * (RFC 9700 §4.1.1 / §2.1.1: a redeemed code presented again means it leaked).
 */

/** Marks one challenge of `kind` used at `at`. False if it was already consumed (single use). */
export async function consumeCentralChallenge(
  tx: Tx,
  id: string,
  kind: AuthChallenge["kind"],
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .update(authChallenge)
    .set({ consumedAt: at })
    .where(
      and(eq(authChallenge.id, id), eq(authChallenge.kind, kind), isNull(authChallenge.consumedAt)),
    )
    .returning({ id: authChallenge.id });
  return rows.length > 0;
}

/** Stores the id of the session a handoff minted in its `data.minted` (the sealed part is kept). */
export async function recordHandoffSession(tx: Tx, id: string, sessionId: string): Promise<void> {
  await tx
    .update(authChallenge)
    .set({
      data: sql`${authChallenge.data} || jsonb_build_object('minted', ${sessionId}::text)`,
    })
    .where(and(eq(authChallenge.id, id), eq(authChallenge.kind, "central_handoff")));
}
