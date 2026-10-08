import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { accreditationConnection } = core;

export type AccreditationConnectionRow = typeof accreditationConnection.$inferSelect;
export type NewAccreditationConnectionValues = Omit<
  typeof accreditationConnection.$inferInsert,
  "workspaceId"
>;
export type AccreditationConnectionPatch = Partial<
  Pick<
    AccreditationConnectionRow,
    | "environment"
    | "credentialsEnc"
    | "encryption"
    | "credentialHints"
    | "status"
    | "lastVerifiedAt"
    | "lastError"
    | "lastCallbackAt"
    | "deletedAt"
  >
>;

/*
 * `core.accreditation_connection` (migration `core/0021_accreditation.sql`; the SQL is
 * authoritative). Query builder only, except for the advisory lock.
 */
export class AccreditationConnectionRepo extends TenantRepo<typeof accreditationConnection> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accreditationConnection, ctx, tx);
  }

  /**
   * The connection singleton's advisory lock (`accreditation.connection:<ws>`), held to commit.
   * Taken by every write of the connection row, before the row lock and before the audit chain.
   * Never the workspace row.
   */
  async lockSingleton(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`accreditation.connection:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  async live(): Promise<AccreditationConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(accreditationConnection)
      .where(this.scope(isNull(accreditationConnection.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async liveForUpdate(): Promise<AccreditationConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(accreditationConnection)
      .where(this.scope(isNull(accreditationConnection.deletedAt)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  async byId(id: string): Promise<AccreditationConnectionRow | undefined> {
    return this.findById(id);
  }

  async insert(values: NewAccreditationConnectionValues): Promise<AccreditationConnectionRow> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: AccreditationConnectionPatch,
  ): Promise<AccreditationConnectionRow | undefined> {
    const rows = await this.tx
      .update(accreditationConnection)
      .set(patch)
      .where(this.scope(eq(accreditationConnection.id, id)))
      .returning();
    return rows[0];
  }
}

/**
 * The vendor callback's first read: which workspace owns live connection `id`. Runs in a HOST
 * transaction (`db.withHost`) because the callback carries no tenant; it reads three columns of a
 * live row and nothing else (the host-read policy of 0021). Everything after it runs in that
 * workspace's system context.
 */
export async function findConnectionForCallback(
  tx: Tx,
  id: string,
): Promise<
  { id: string; workspaceId: string; driver: AccreditationConnectionRow["driver"] } | undefined
> {
  const rows = await tx
    .select({
      id: accreditationConnection.id,
      workspaceId: accreditationConnection.workspaceId,
      driver: accreditationConnection.driver,
    })
    .from(accreditationConnection)
    .where(and(eq(accreditationConnection.id, id), isNull(accreditationConnection.deletedAt)))
    .limit(1);
  return rows[0];
}
