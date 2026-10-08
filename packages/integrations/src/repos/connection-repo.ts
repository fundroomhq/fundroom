import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

const { integrationConnection } = core;

export type ConnectionRow = typeof integrationConnection.$inferSelect;
export type NewConnectionValues = Omit<typeof integrationConnection.$inferInsert, "workspaceId">;
export type ConnectionPatch = Partial<
  Pick<
    ConnectionRow,
    | "credentialsEnc"
    | "encryption"
    | "accessExpiresAt"
    | "scope"
    | "externalAccountId"
    | "accountLabel"
    | "webhookSecretEnc"
    | "webhookSubscriptionId"
    | "status"
    | "consecutiveFailures"
    | "lastSuccessAt"
    | "lastFailureAt"
    | "lastError"
    | "refreshLeaseUntil"
    | "webhookRotationLeaseUntil"
    | "webhookRotationLeaseToken"
    | "deletedAt"
  >
>;

/*
 * `core.integration_connection` (migration `core/0020_integrations.sql`; the SQL is authoritative).
 * Query builder only (the raw `tx.execute` path returns `timestamptz` as text), except for the
 * advisory lock, which returns nothing.
 */
export class ConnectionRepo extends TenantRepo<typeof integrationConnection> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(integrationConnection, ctx, tx);
  }

  /**
   * The per-(workspace, provider) singleton advisory lock, held to commit. Taken FIRST by connect,
   * reconnect (OAuth callback), disconnect, account selection and webhook-secret rotation, so two
   * of them can never interleave (a disconnect racing a connect leaves exactly one outcome). Never
   * the workspace row.
   */
  async lockSingleton(provider: ConnectionRow["provider"]): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`integration.connection:${this.ctx.workspaceId}:${provider}`}::text, 0))`,
    );
  }

  async live(provider: ConnectionRow["provider"]): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationConnection)
      .where(
        this.scope(
          and(
            eq(integrationConnection.provider, provider),
            isNull(integrationConnection.deletedAt),
          ),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async liveForUpdate(provider: ConnectionRow["provider"]): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationConnection)
      .where(
        this.scope(
          and(
            eq(integrationConnection.provider, provider),
            isNull(integrationConnection.deletedAt),
          ),
        ),
      )
      .limit(1)
      .for("update");
    return rows[0];
  }

  async allLive(): Promise<ConnectionRow[]> {
    return this.tx
      .select()
      .from(integrationConnection)
      .where(this.scope(isNull(integrationConnection.deletedAt)))
      .orderBy(asc(integrationConnection.provider));
  }

  /** A live row by id, locked (`FOR UPDATE`): every write after a vendor call re-checks here. */
  async lockLiveById(id: string): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationConnection)
      .where(
        this.scope(and(eq(integrationConnection.id, id), isNull(integrationConnection.deletedAt))),
      )
      .limit(1)
      .for("update");
    return rows[0];
  }

  async liveById(id: string): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .select()
      .from(integrationConnection)
      .where(
        this.scope(and(eq(integrationConnection.id, id), isNull(integrationConnection.deletedAt))),
      )
      .limit(1);
    return rows[0];
  }

  async insert(values: NewConnectionValues): Promise<ConnectionRow> {
    return this.insertOne(values);
  }

  async update(id: string, patch: ConnectionPatch): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .update(integrationConnection)
      .set(patch)
      .where(this.scope(eq(integrationConnection.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * Claims the webhook-secret rotation lease of a LIVE connection for `token` (fix rounds 2–3):
   * free or expired leases only. Every later write of the lease is conditional on the token, so a
   * rotation whose lease expired and was taken over can never extend, clear or act under it.
   */
  async claimRotationLease(
    id: string,
    token: string,
    leaseMs: number,
  ): Promise<ConnectionRow | undefined> {
    const c = integrationConnection;
    const rows = await this.tx
      .update(c)
      .set({
        webhookRotationLeaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        webhookRotationLeaseToken: token,
      })
      .where(
        this.scope(
          and(
            eq(c.id, id),
            isNull(c.deletedAt),
            or(isNull(c.webhookRotationLeaseUntil), lt(c.webhookRotationLeaseUntil, sql`now()`)),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  /** Heartbeat: extends the lease only while `token` still holds it. */
  async extendRotationLease(id: string, token: string, leaseMs: number): Promise<boolean> {
    const c = integrationConnection;
    const rows = await this.tx
      .update(c)
      .set({ webhookRotationLeaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
      .where(
        this.scope(and(eq(c.id, id), isNull(c.deletedAt), eq(c.webhookRotationLeaseToken, token))),
      )
      .returning({ id: c.id });
    return rows.length > 0;
  }

  /** Clears the lease only if `token` still holds it. */
  async releaseRotationLease(id: string, token: string): Promise<void> {
    const c = integrationConnection;
    await this.tx
      .update(c)
      .set({ webhookRotationLeaseUntil: null, webhookRotationLeaseToken: null })
      .where(this.scope(and(eq(c.id, id), eq(c.webhookRotationLeaseToken, token))));
  }

  /**
   * Claims the refresh lease of a LIVE connection: only one process refreshes a rotating refresh
   * token at a time. Returns the row when this caller won (the lease now runs `leaseMs` from the
   * database's clock).
   */
  async claimRefreshLease(id: string, leaseMs: number): Promise<ConnectionRow | undefined> {
    const rows = await this.tx
      .update(integrationConnection)
      .set({ refreshLeaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
      .where(
        this.scope(
          and(
            eq(integrationConnection.id, id),
            isNull(integrationConnection.deletedAt),
            or(
              isNull(integrationConnection.refreshLeaseUntil),
              lt(integrationConnection.refreshLeaseUntil, sql`now()`),
            ),
          ),
        ),
      )
      .returning();
    return rows[0];
  }
}

/**
 * The booking webhook's first read: which workspace owns connection `id`. Runs in a HOST
 * transaction (`db.withHost`) — the webhook carries no tenant — and reads three columns of a live
 * row (0020's host SELECT arm). Everything after it runs in that workspace's system context.
 */
export async function findConnectionForWebhook(
  tx: Tx,
  id: string,
): Promise<{ id: string; workspaceId: string; provider: ConnectionRow["provider"] } | undefined> {
  const rows = await tx
    .select({
      id: integrationConnection.id,
      workspaceId: integrationConnection.workspaceId,
      provider: integrationConnection.provider,
    })
    .from(integrationConnection)
    .where(and(eq(integrationConnection.id, id), isNull(integrationConnection.deletedAt)))
    .limit(1);
  return rows[0];
}
