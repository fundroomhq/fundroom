import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

const { integrationOAuthState } = core;

export type OAuthStateRow = typeof integrationOAuthState.$inferSelect;
type NewOAuthState = Omit<typeof integrationOAuthState.$inferInsert, "workspaceId">;

/*
 * `core.integration_oauth_state` (0020). The begin route inserts in the workspace's system
 * context; the two ops routes arrive with no tenant and reach a row only through the SECURITY
 * DEFINER claim functions, called in a HOST transaction (`claimTicket` / `claimState` below). The
 * host has no policy on the table itself.
 */
export class OAuthStateRepo extends TenantRepo<typeof integrationOAuthState> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(integrationOAuthState, ctx, tx);
  }

  async insert(values: NewOAuthState): Promise<OAuthStateRow> {
    return this.insertOne(values);
  }

  /** Handshakes this member started that are still open (the begin route's budget). */
  async openFor(membershipId: string, at: Date): Promise<number> {
    const rows = await this.tx
      .select({ n: count() })
      .from(integrationOAuthState)
      .where(
        this.scope(
          and(
            eq(integrationOAuthState.membershipId, membershipId),
            isNull(integrationOAuthState.consumedAt),
            gt(integrationOAuthState.expiresAt, at),
          ),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** After the ticket claim: the state, browser binding and sealed PKCE verifier. */
  async setStarted(
    id: string,
    patch: Pick<OAuthStateRow, "stateHash" | "browserHash" | "verifierEnc" | "encryption">,
  ): Promise<boolean> {
    const rows = await this.tx
      .update(integrationOAuthState)
      .set(patch)
      .where(
        this.scope(and(eq(integrationOAuthState.id, id), isNull(integrationOAuthState.consumedAt))),
      )
      .returning({ id: integrationOAuthState.id });
    return rows.length > 0;
  }

  /** After the callback: the verified grant waits for the initiator's confirmation. */
  async setPending(
    id: string,
    patch: Pick<OAuthStateRow, "pendingHash" | "pendingEnc" | "pendingExpiresAt" | "encryption">,
  ): Promise<boolean> {
    const rows = await this.tx
      .update(integrationOAuthState)
      .set(patch)
      .where(
        this.scope(
          and(
            eq(integrationOAuthState.id, id),
            isNull(integrationOAuthState.pendingHash),
            isNull(integrationOAuthState.completedAt),
          ),
        ),
      )
      .returning({ id: integrationOAuthState.id });
    return rows.length > 0;
  }

  /** The confirm step: the handshake holding this pending token, locked. */
  async pendingForUpdate(pendingHash: Buffer): Promise<OAuthStateRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationOAuthState)
      .where(this.scope(eq(integrationOAuthState.pendingHash, pendingHash)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * Single use, and the sealed grant and PKCE verifier are dropped with it (fix round 3): a used
   * handshake keeps no token material until the sweep deletes the row.
   */
  async markCompleted(id: string, at: Date): Promise<void> {
    await this.tx
      .update(integrationOAuthState)
      .set({ completedAt: at, pendingEnc: null, verifierEnc: null, encryption: {} })
      .where(this.scope(eq(integrationOAuthState.id, id)));
  }

  async byId(id: string): Promise<OAuthStateRow | undefined> {
    return this.findById(id);
  }

  /**
   * The hourly sweep's claim (fix round 2): handshakes that are unambiguously dead — completed and
   * past `expires_at`, or unconfirmed with the pending grant past `pending_expires_at` (or, never
   * reaching the callback, past `expires_at`) — locked `FOR UPDATE SKIP LOCKED` so a confirm
   * holding its row is never touched.
   */
  async claimDead(at: Date): Promise<OAuthStateRow[]> {
    const t = integrationOAuthState;
    return this.tx
      .select()
      .from(t)
      .where(
        this.scope(
          or(
            and(isNotNull(t.completedAt), lt(t.expiresAt, at)),
            and(
              isNull(t.completedAt),
              or(
                and(isNotNull(t.pendingExpiresAt), lt(t.pendingExpiresAt, at)),
                and(isNull(t.pendingExpiresAt), lt(t.expiresAt, at)),
              ),
            ),
          ),
        ),
      )
      .for("update", { skipLocked: true });
  }

  async deleteIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .delete(integrationOAuthState)
      .where(this.scope(inArray(integrationOAuthState.id, [...ids])))
      .returning({ id: integrationOAuthState.id });
    return rows.length;
  }
}

/** What a claim function returns (raw SQL: bytea as Buffer, timestamps as text). */
export interface ClaimedOAuthState {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly membershipId: string;
  readonly browserHash: Buffer | null;
  readonly verifierEnc: Buffer | null;
  readonly encryption: unknown;
  readonly environment: "production" | "sandbox";
  readonly returnPath: string;
}

function claimed(row: Record<string, unknown> | undefined): ClaimedOAuthState | undefined {
  if (row === undefined) return undefined;
  const buf = (v: unknown) => (v === null || v === undefined ? null : Buffer.from(v as Uint8Array));
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    provider: String(row["provider"]),
    membershipId: String(row["membership_id"]),
    browserHash: buf(row["browser_hash"]),
    verifierEnc: buf(row["verifier_enc"]),
    encryption: row["encryption"],
    environment: row["environment"] === "sandbox" ? "sandbox" : "production",
    returnPath: String(row["return_path"]),
  };
}

/** `core.integration_oauth_ticket_claim` — HOST transaction only. Burns the ticket. */
export async function claimTicket(
  tx: Tx,
  ticketHash: Buffer,
): Promise<ClaimedOAuthState | undefined> {
  const r = await tx.execute(
    sql`SELECT * FROM core.integration_oauth_ticket_claim(${ticketHash}::bytea)`,
  );
  return claimed(r.rows[0] as Record<string, unknown> | undefined);
}

/** `core.integration_oauth_state_claim` — HOST transaction only. Consumes the handshake. */
export async function claimState(
  tx: Tx,
  stateHash: Buffer,
): Promise<ClaimedOAuthState | undefined> {
  const r = await tx.execute(
    sql`SELECT * FROM core.integration_oauth_state_claim(${stateHash}::bytea)`,
  );
  return claimed(r.rows[0] as Record<string, unknown> | undefined);
}
