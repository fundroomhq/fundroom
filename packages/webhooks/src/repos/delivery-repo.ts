import {
  core,
  type TenantContext,
  TenantRepo,
  type Tx,
  WEBHOOK_DELIVERY_STATUSES,
  type WebhookDeliveryRow,
} from "@fundroom/db";
import type { JsonObject } from "@fundroom/ports";
import { and, count, desc, eq, gte, inArray, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";
import {
  type DeliveryStatusCounts,
  WEBHOOK_PAYLOAD_SCHEMA_VERSION,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStatus,
} from "../types.js";

const { webhookDelivery } = core;

/*
 * Data access over `core.webhook_delivery` (migration `core/0018_api_keys_webhooks.sql`).
 *
 * Claiming is per workspace: the table is fenced (RLS) and a host transaction sees no tenant row,
 * so the due sweep walks the active workspaces and claims each one's due rows in its own short
 * `system` transaction (`claimDue`: `FOR UPDATE SKIP LOCKED`, then `sending` + a lease). A worker
 * that dies mid-POST leaves a `sending` row whose lease goes stale after 5 minutes and is claimed
 * again: at-least-once, which is what `webhook-id` exists for.
 */

export function toDeliveryRecord(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    endpointId: row.endpointId,
    topic: row.topic,
    eventId: row.eventId,
    payload: row.payload as JsonObject,
    payloadSchemaVersion: row.payloadSchemaVersion,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    claimedAt: row.claimedAt,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    lastResponseExcerpt: row.lastResponseExcerpt,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    manual: row.manual,
  };
}

export interface NewDeliveryValues {
  /** Optional: a caller that needs the id before insert (the body carries it) may mint one. */
  readonly id?: string | undefined;
  readonly endpointId: string;
  readonly topic: string;
  readonly eventId: string;
  readonly payload: JsonObject;
  readonly nextAttemptAt: Date;
  readonly manual: boolean;
}

/**
 * Keyset position: the id of the last row of the previous page. The row's own
 * `(created_at, id)` is read back in SQL — a JS `Date` carries milliseconds and `created_at`
 * microseconds, so a cursor built from the `Date` would skip rows inside that millisecond.
 */
export interface DeliveryCursor {
  readonly id: string;
}

export interface DeliveryListFilter {
  readonly endpointId?: string | undefined;
  readonly status?: WebhookDeliveryStatus | undefined;
  readonly topic?: string | undefined;
  readonly cursor?: DeliveryCursor | undefined;
  /** Rows to return (the caller asks for limit + 1 to know whether there is a next page). */
  readonly limit: number;
}

export interface DeliveryPatch {
  readonly status?: WebhookDeliveryStatus | undefined;
  readonly attempts?: number | undefined;
  readonly nextAttemptAt?: Date | null | undefined;
  readonly claimedAt?: Date | null | undefined;
  readonly lastStatusCode?: number | null | undefined;
  readonly lastError?: string | null | undefined;
  readonly lastDurationMs?: number | null | undefined;
  readonly lastResponseExcerpt?: string | null | undefined;
  readonly deliveredAt?: Date | null | undefined;
}

export class WebhookDeliveryRepo extends TenantRepo<typeof webhookDelivery> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(webhookDelivery, ctx, tx);
  }

  private values(v: NewDeliveryValues) {
    return {
      ...(v.id === undefined ? {} : { id: v.id }),
      workspaceId: this.ctx.workspaceId,
      endpointId: v.endpointId,
      topic: v.topic,
      eventId: v.eventId,
      payload: v.payload,
      payloadSchemaVersion: WEBHOOK_PAYLOAD_SCHEMA_VERSION,
      status: "pending" as const,
      nextAttemptAt: v.nextAttemptAt,
      manual: v.manual,
    };
  }

  /**
   * Fan-out insert: `ON CONFLICT DO NOTHING` on (endpoint_id, event_id) for non-manual rows, so an
   * outbox redelivery cannot double-send. Returns the rows actually inserted.
   */
  async insertFanout(values: readonly NewDeliveryValues[]): Promise<WebhookDeliveryRecord[]> {
    if (values.length === 0) return [];
    const rows = await this.tx
      .insert(webhookDelivery)
      .values(values.map((v) => this.values({ ...v, manual: false })))
      .onConflictDoNothing()
      .returning();
    return rows.map(toDeliveryRecord);
  }

  /** A manual row (redeliver, ping): outside the dedupe. */
  async insertManual(value: Omit<NewDeliveryValues, "manual">): Promise<WebhookDeliveryRecord> {
    const rows = await this.tx
      .insert(webhookDelivery)
      .values(this.values({ ...value, manual: true }))
      .returning();
    return toDeliveryRecord(rows[0] as WebhookDeliveryRow);
  }

  async byId(id: string): Promise<WebhookDeliveryRecord | undefined> {
    const row = await this.findById(id);
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  /** Newest first, keyset on (created_at desc, id desc). */
  async list(filter: DeliveryListFilter): Promise<WebhookDeliveryRecord[]> {
    const where: SQL[] = [];
    if (filter.endpointId !== undefined)
      where.push(eq(webhookDelivery.endpointId, filter.endpointId));
    if (filter.status !== undefined) where.push(eq(webhookDelivery.status, filter.status));
    if (filter.topic !== undefined) where.push(eq(webhookDelivery.topic, filter.topic));
    if (filter.cursor !== undefined) {
      where.push(
        sql`(${webhookDelivery.createdAt}, ${webhookDelivery.id}) < (SELECT c.created_at, c.id FROM core.webhook_delivery c WHERE c.id = ${filter.cursor.id}::uuid AND c.workspace_id = ${this.ctx.workspaceId}::uuid)`,
      );
    }
    const rows = await this.tx
      .select()
      .from(webhookDelivery)
      .where(this.scope(where.length === 0 ? undefined : and(...where)))
      .orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id))
      .limit(filter.limit);
    return rows.map(toDeliveryRecord);
  }

  /** One endpoint's deliveries created since `since`, counted by status (every status present). */
  async countsByStatusSince(endpointId: string, since: Date): Promise<DeliveryStatusCounts> {
    const rows = await this.tx
      .select({ status: webhookDelivery.status, n: count() })
      .from(webhookDelivery)
      .where(
        this.scope(
          and(eq(webhookDelivery.endpointId, endpointId), gte(webhookDelivery.createdAt, since)),
        ),
      )
      .groupBy(webhookDelivery.status);
    const out = Object.fromEntries(WEBHOOK_DELIVERY_STATUSES.map((s) => [s, 0])) as Record<
      WebhookDeliveryStatus,
      number
    >;
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  async update(id: string, patch: DeliveryPatch): Promise<WebhookDeliveryRecord | undefined> {
    const set: Partial<typeof webhookDelivery.$inferInsert> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (set as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(set).length === 0) return this.byId(id);
    const rows = await this.tx
      .update(webhookDelivery)
      .set(set)
      .where(this.scope(eq(webhookDelivery.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  /** Cancels an endpoint's queued rows (auto-disable, manual disable). Returns how many. */
  async cancelQueuedForEndpoint(endpointId: string): Promise<number> {
    const rows = await this.tx
      .update(webhookDelivery)
      .set({ status: "cancelled", nextAttemptAt: null, claimedAt: null })
      .where(
        this.scope(
          and(
            eq(webhookDelivery.endpointId, endpointId),
            inArray(webhookDelivery.status, ["pending"]),
          ),
        ),
      )
      .returning({ id: webhookDelivery.id });
    return rows.length;
  }

  /**
   * Retention: deletes up to `batch` finished rows (`succeeded`, `failed`, `cancelled`) created
   * before `before`. A row still `pending`/`sending` is live work, however old. Returns how many.
   */
  async deleteCreatedBefore(before: Date, batch = 1000): Promise<number> {
    const victims = this.tx
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(
        this.scope(
          and(
            lt(webhookDelivery.createdAt, before),
            inArray(webhookDelivery.status, ["succeeded", "failed", "cancelled"]),
          ),
        ),
      )
      .limit(batch);
    const rows = await this.tx
      .delete(webhookDelivery)
      .where(this.scope(inArray(webhookDelivery.id, victims)))
      .returning({ id: webhookDelivery.id });
    return rows.length;
  }

  /**
   * Claims up to `limit` due rows of this workspace — `pending` and due, or `sending` whose lease
   * went stale — and marks them `sending` with `claimed_at = now` and one more attempt.
   *
   * The per-endpoint cap (`perEndpoint` in flight, counting fresh claims other workers hold) is
   * applied in SQL **before** the LIMIT: each endpoint's due rows are ranked and only as many as
   * it has room for are candidates, so one backed-up endpoint cannot fill every batch and starve
   * the others. The candidates are then locked `FOR UPDATE SKIP LOCKED` (window functions and
   * row locks cannot share a statement), re-checking that they are still due; two workers never
   * claim one row and neither waits. Locks delivery rows only, never an endpoint row.
   */
  async claimDue(
    now: Date,
    staleBefore: Date,
    limit: number,
    perEndpoint: number,
  ): Promise<WebhookDeliveryRecord[]> {
    const ws = this.ctx.workspaceId;
    const ranked = await this.tx.execute(sql`
      WITH in_flight AS (
        SELECT endpoint_id, count(*)::int AS n
          FROM core.webhook_delivery
         WHERE workspace_id = ${ws}::uuid AND status = 'sending' AND claimed_at >= ${staleBefore}
         GROUP BY endpoint_id
      ), due AS (
        SELECT id, endpoint_id, next_attempt_at,
               row_number() OVER (PARTITION BY endpoint_id ORDER BY next_attempt_at, id) AS rn
          FROM core.webhook_delivery
         WHERE workspace_id = ${ws}::uuid
           AND ((status = 'pending' AND next_attempt_at <= ${now})
             OR (status = 'sending' AND claimed_at < ${staleBefore}))
      )
      SELECT due.id FROM due LEFT JOIN in_flight USING (endpoint_id)
       WHERE due.rn + coalesce(in_flight.n, 0) <= ${perEndpoint}
       ORDER BY due.next_attempt_at, due.id
       LIMIT ${limit}`);
    const candidates = (ranked.rows as { id: string }[]).map((r) => r.id);
    if (candidates.length === 0) return [];
    const due = or(
      and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.nextAttemptAt, now)),
      and(eq(webhookDelivery.status, "sending"), lt(webhookDelivery.claimedAt, staleBefore)),
    );
    const locked = await this.tx
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(this.scope(and(inArray(webhookDelivery.id, candidates), due)))
      .for("update", { skipLocked: true });
    if (locked.length === 0) return [];
    const rows = await this.tx
      .update(webhookDelivery)
      .set({
        status: "sending",
        claimedAt: now,
        attempts: sql`${webhookDelivery.attempts} + 1`,
      })
      .where(
        this.scope(
          inArray(
            webhookDelivery.id,
            locked.map((r) => r.id),
          ),
        ),
      )
      .returning();
    return rows.map(toDeliveryRecord);
  }

  /** Whether anything of this workspace is due (the sweep's cheap probe before enqueueing). */
  async hasDue(now: Date, staleBefore: Date): Promise<boolean> {
    const rows = await this.tx
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(
        this.scope(
          or(
            and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.nextAttemptAt, now)),
            and(eq(webhookDelivery.status, "sending"), lt(webhookDelivery.claimedAt, staleBefore)),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Renews this worker's lease right before its POST: `claimed_at = at`, only while the row is
   * still `sending` under the claim `claimedAt`. False when the claim was lost (re-claimed after
   * a stale lease, cancelled, deleted) — the caller must then not send.
   */
  async restampClaim(id: string, claimedAt: Date, at: Date): Promise<boolean> {
    const rows = await this.tx
      .update(webhookDelivery)
      .set({ claimedAt: at })
      .where(
        this.scope(
          and(
            eq(webhookDelivery.id, id),
            eq(webhookDelivery.status, "sending"),
            eq(webhookDelivery.claimedAt, claimedAt),
          ),
        ),
      )
      .returning({ id: webhookDelivery.id });
    return rows.length === 1;
  }

  /**
   * Records an attempt's outcome, but only while the row is still the claim this worker made
   * (`sending` with this `claimed_at`): a row cancelled meanwhile, or re-claimed after a stale
   * lease, is left alone. `undefined` when it was not ours any more.
   */
  async finishClaim(
    id: string,
    claimedAt: Date,
    patch: DeliveryPatch,
  ): Promise<WebhookDeliveryRecord | undefined> {
    const rows = await this.tx
      .update(webhookDelivery)
      .set({
        ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<
          typeof webhookDelivery.$inferInsert
        >),
        claimedAt: null,
      })
      .where(
        this.scope(
          and(
            eq(webhookDelivery.id, id),
            eq(webhookDelivery.status, "sending"),
            eq(webhookDelivery.claimedAt, claimedAt),
          ),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toDeliveryRecord(row);
  }

  /**
   * Erasure (DSAR): deletes every delivery not yet `succeeded` whose payload mentions the
   * member's id anywhere under `data` (`membershipId`, `membershipIds[]`, `byMembershipId`, …),
   * so nothing queued or dead-lettered can carry them to a receiver after the request. What was
   * already delivered stays in the log as the record of what left.
   *
   * `SKIP LOCKED`: the erasure transaction usually holds the audit-chain lock already, and a
   * delivery being recorded right now holds its row and waits for that same lock when it
   * auto-disables its endpoint — waiting here would close the cycle. A row skipped this way is
   * mid-attempt; it is left to finish.
   */
  async deleteUnsentReferencing(membershipId: string): Promise<number> {
    const victims = this.tx
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(
        this.scope(
          and(
            ne(webhookDelivery.status, "succeeded"),
            sql`jsonb_path_exists(${webhookDelivery.payload} -> 'data', '$.** ? (@ == $m)', jsonb_build_object('m', ${membershipId}::text))`,
          ),
        ),
      )
      .for("update", { skipLocked: true });
    const rows = await this.tx
      .delete(webhookDelivery)
      .where(this.scope(inArray(webhookDelivery.id, victims)))
      .returning({ id: webhookDelivery.id });
    return rows.length;
  }
}
