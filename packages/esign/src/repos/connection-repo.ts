import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, count, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

const { esignConnection, esignEnvelope, legalDocument } = core;

export type ESignConnectionRow = typeof esignConnection.$inferSelect;
export type NewESignConnectionValues = Omit<typeof esignConnection.$inferInsert, "workspaceId">;
export type ESignConnectionPatch = Partial<
  Pick<
    ESignConnectionRow,
    | "baseUrlEnc"
    | "baseUrlHost"
    | "credentialsEnc"
    | "callbackSecretEnc"
    | "encryption"
    | "credentialHints"
    | "status"
    | "lastVerifiedAt"
    | "lastError"
    | "deletedAt"
  >
>;

/*
 * `core.esign_connection` (migration `core/0019_esign.sql`; the SQL is authoritative). Query
 * builder only — the raw `tx.execute` path returns `timestamptz` as text — except for the
 * advisory lock, which returns nothing.
 */
export class ESignConnectionRepo extends TenantRepo<typeof esignConnection> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(esignConnection, ctx, tx);
  }

  /**
   * The connection singleton's advisory lock (`esign.connection:<ws>`), held to commit. Taken by
   * every write of the connection row, by envelope creation (so no envelope appears while the
   * connection is replaced or deleted, or while a member's envelopes are being erased), and by
   * identity erasure BEFORE it locks the member's envelope rows. Never the workspace row.
   */
  async lockSingleton(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`esign.connection:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async live(): Promise<ESignConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(esignConnection)
      .where(this.scope(isNull(esignConnection.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async liveForUpdate(): Promise<ESignConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(esignConnection)
      .where(this.scope(isNull(esignConnection.deletedAt)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /** By id, deleted or not (an envelope keeps talking to the connection it was created on). */
  async byId(id: string): Promise<ESignConnectionRow | undefined> {
    return this.findById(id);
  }

  async insert(values: NewESignConnectionValues): Promise<ESignConnectionRow> {
    return this.insertOne(values);
  }

  async update(id: string, patch: ESignConnectionPatch): Promise<ESignConnectionRow | undefined> {
    const rows = await this.tx
      .update(esignConnection)
      .set(patch)
      .where(this.scope(eq(esignConnection.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * Envelopes on this connection that a vendor still holds open (or may): `draft`, `sent`,
   * `delivered`, and an `error` row that has a vendor ref — `error` is a failed pull, not a
   * terminal state, and the envelope may well still be live at the vendor (E3.5 fix A10).
   */
  async countOpenEnvelopes(connectionId: string): Promise<number> {
    const rows = await this.tx
      .select({ n: count() })
      .from(esignEnvelope)
      .where(
        and(
          eq(esignEnvelope.workspaceId, this.ctx.workspaceId),
          eq(esignEnvelope.connectionId, connectionId),
          or(
            inArray(esignEnvelope.status, ["draft", "sent", "delivered"]),
            and(eq(esignEnvelope.status, "error"), isNotNull(esignEnvelope.providerRef)),
          ),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Live legal documents whose ceremony is `esign`. */
  async countEsignCeremonyDocuments(): Promise<number> {
    const rows = await this.tx
      .select({ n: count() })
      .from(legalDocument)
      .where(
        and(
          eq(legalDocument.workspaceId, this.ctx.workspaceId),
          eq(legalDocument.ceremony, "esign"),
          isNull(legalDocument.deletedAt),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}

/**
 * The vendor callback's first read: which workspace owns connection `id`. Runs in a HOST
 * transaction (`db.withHost`), because the callback carries no tenant; it reads three columns of a
 * live row and nothing else. Everything after it runs in that workspace's system context. Needs
 * the host-read policy on `core.esign_connection` (see the E3.5 handshake).
 */
export async function findConnectionForCallback(
  tx: Tx,
  id: string,
): Promise<{ id: string; workspaceId: string; driver: ESignConnectionRow["driver"] } | undefined> {
  const rows = await tx
    .select({
      id: esignConnection.id,
      workspaceId: esignConnection.workspaceId,
      driver: esignConnection.driver,
    })
    .from(esignConnection)
    .where(and(eq(esignConnection.id, id), isNull(esignConnection.deletedAt)))
    .limit(1);
  return rows[0];
}
