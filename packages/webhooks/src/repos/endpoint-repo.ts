import {
  core,
  type TenantContext,
  TenantRepo,
  type Tx,
  type WebhookEndpointRow,
} from "@fundroom/db";
import { and, arrayContains, asc, count, eq, sql } from "drizzle-orm";
import {
  ENDPOINT_ENCRYPTION_SCHEMA_VERSION,
  type EndpointEncryption,
  type WebhookDisabledReason,
  type WebhookEndpointRecord,
} from "../types.js";

const { webhookEndpoint } = core;

/*
 * Data access over `core.webhook_endpoint` (migration `core/0018_api_keys_webhooks.sql`). One of
 * the two files in the package that import drizzle. Sealed columns pass through as bytes; the
 * service seals and unseals them under the `webhook-secret` workspace key.
 */

export function toEndpointRecord(row: WebhookEndpointRow): WebhookEndpointRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    description: row.description,
    urlEnc: row.urlEnc,
    encryption: (row.encryption ?? {}) as EndpointEncryption,
    urlHost: row.urlHost,
    urlHint: row.urlHint,
    secretEnc: row.secretEnc,
    secretPrevEnc: row.secretPrevEnc,
    secretPrevExpiresAt: row.secretPrevExpiresAt,
    events: row.events,
    enabled: row.enabled,
    disabledReason: row.disabledReason ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewEndpointValues {
  readonly description: string | null;
  readonly urlEnc: Uint8Array;
  readonly urlHost: string;
  readonly urlHint: string;
  readonly secretEnc: Uint8Array;
  readonly encryption: EndpointEncryption;
  readonly events: readonly string[];
  readonly createdByMembershipId: string | null;
}

/** Columns a service may change; `undefined` = leave alone. */
export interface EndpointPatch {
  readonly description?: string | null | undefined;
  readonly urlEnc?: Uint8Array | undefined;
  readonly urlHost?: string | undefined;
  readonly urlHint?: string | undefined;
  readonly secretEnc?: Uint8Array | undefined;
  readonly secretPrevEnc?: Uint8Array | null | undefined;
  readonly secretPrevExpiresAt?: Date | null | undefined;
  readonly encryption?: EndpointEncryption | undefined;
  readonly events?: readonly string[] | undefined;
  /** Set both together: `enabled` ⇔ `disabledReason === null` (the table's CHECK). */
  readonly enabled?: boolean | undefined;
  readonly disabledReason?: WebhookDisabledReason | null | undefined;
  readonly consecutiveFailures?: number | undefined;
  readonly lastSuccessAt?: Date | null | undefined;
  readonly lastFailureAt?: Date | null | undefined;
}

export class WebhookEndpointRepo extends TenantRepo<typeof webhookEndpoint> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(webhookEndpoint, ctx, tx);
  }

  async insert(values: NewEndpointValues): Promise<WebhookEndpointRecord> {
    const row = await this.insertOne({
      description: values.description,
      urlEnc: Buffer.from(values.urlEnc),
      urlHost: values.urlHost,
      urlHint: values.urlHint,
      secretEnc: Buffer.from(values.secretEnc),
      encryption: values.encryption as Record<string, unknown>,
      encryptionSchemaVersion: ENDPOINT_ENCRYPTION_SCHEMA_VERSION,
      events: [...values.events],
      createdByMembershipId: values.createdByMembershipId,
    });
    return toEndpointRecord(row);
  }

  async byId(id: string): Promise<WebhookEndpointRecord | undefined> {
    const row = await this.findById(id);
    return row === undefined ? undefined : toEndpointRecord(row);
  }

  /** `SELECT … FOR UPDATE` (lock order: the endpoint row first). */
  async byIdForUpdate(id: string): Promise<WebhookEndpointRecord | undefined> {
    const rows = await this.tx
      .select()
      .from(webhookEndpoint)
      .where(this.scope(eq(webhookEndpoint.id, id)))
      .limit(1)
      .for("update");
    const row = rows[0];
    return row === undefined ? undefined : toEndpointRecord(row);
  }

  /** Every endpoint of the workspace, oldest first. */
  async list(): Promise<WebhookEndpointRecord[]> {
    const rows = await this.tx
      .select()
      .from(webhookEndpoint)
      .where(this.scope())
      .orderBy(asc(webhookEndpoint.createdAt), asc(webhookEndpoint.id));
    return rows.map(toEndpointRecord);
  }

  async count(): Promise<number> {
    const rows = await this.tx.select({ n: count() }).from(webhookEndpoint).where(this.scope());
    return rows[0]?.n ?? 0;
  }

  /** Enabled endpoints subscribed to `topic` (fan-out). */
  async listSubscribed(topic: string): Promise<WebhookEndpointRecord[]> {
    const rows = await this.tx
      .select()
      .from(webhookEndpoint)
      .where(
        this.scope(
          and(eq(webhookEndpoint.enabled, true), arrayContains(webhookEndpoint.events, [topic])),
        ),
      )
      .orderBy(asc(webhookEndpoint.id));
    return rows.map(toEndpointRecord);
  }

  async update(id: string, patch: EndpointPatch): Promise<WebhookEndpointRecord | undefined> {
    const set: Partial<typeof webhookEndpoint.$inferInsert> = {};
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.urlEnc !== undefined) set.urlEnc = Buffer.from(patch.urlEnc);
    if (patch.urlHost !== undefined) set.urlHost = patch.urlHost;
    if (patch.urlHint !== undefined) set.urlHint = patch.urlHint;
    if (patch.secretEnc !== undefined) set.secretEnc = Buffer.from(patch.secretEnc);
    if (patch.secretPrevEnc !== undefined) {
      set.secretPrevEnc = patch.secretPrevEnc === null ? null : Buffer.from(patch.secretPrevEnc);
    }
    if (patch.secretPrevExpiresAt !== undefined)
      set.secretPrevExpiresAt = patch.secretPrevExpiresAt;
    if (patch.encryption !== undefined) {
      set.encryption = patch.encryption as Record<string, unknown>;
    }
    if (patch.events !== undefined) set.events = [...patch.events];
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.disabledReason !== undefined) set.disabledReason = patch.disabledReason;
    if (patch.consecutiveFailures !== undefined) {
      set.consecutiveFailures = patch.consecutiveFailures;
    }
    if (patch.lastSuccessAt !== undefined) set.lastSuccessAt = patch.lastSuccessAt;
    if (patch.lastFailureAt !== undefined) set.lastFailureAt = patch.lastFailureAt;
    if (Object.keys(set).length === 0) return this.byId(id);
    const rows = await this.tx
      .update(webhookEndpoint)
      .set(set)
      .where(this.scope(eq(webhookEndpoint.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toEndpointRecord(row);
  }

  /** Deletes the endpoint (its deliveries cascade). Returns rows deleted (0 or 1). */
  async delete(id: string): Promise<number> {
    return this.deleteById(id);
  }

  /**
   * Serialises endpoint creation per workspace (the 20-endpoint cap): a transaction-scoped
   * advisory lock rather than the workspace row, which every insert under a workspace FK
   * key-share-locks. Taken first, before anything else the create touches.
   */
  async lockCreation(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`webhooks.endpoints:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }
}
