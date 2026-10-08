import { core, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

const { accessRequest, accessRequestChallenge, invite } = core;

/** `core.access_request` rows (derived here: `@fundroom/db`'s top level does not re-export them). */
export type AccessRequest = typeof accessRequest.$inferSelect;
export type NewAccessRequest = typeof accessRequest.$inferInsert;
export type AccessRequestChallenge = typeof accessRequestChallenge.$inferSelect;
export type NewAccessRequestChallenge = typeof accessRequestChallenge.$inferInsert;

/*
 * `core.access_request` and `core.access_request_challenge` (E3.1): the public "request access"
 * form, its emailed codes and the approval queue. Only this file touches drizzle for them
 * (dependency-cruiser `only-repos-touch-drizzle`).
 *
 * Every read and write runs on the caller's transaction; nothing here opens a connection of its
 * own (the pool-deadlock rule).
 */

/** The partial unique index that admits one `pending` row per address. */
export const ACCESS_REQUEST_OPEN_EMAIL_UQ = "access_request_open_email_uq";

/** A decoded keyset cursor: the row's `created_at` at microsecond precision (UTC) and its id. */
export interface AccessRequestCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` exactly, as `to_char` printed it. */
  readonly createdAt: string;
  readonly id: string;
}

export interface AccessRequestPageRow {
  readonly row: AccessRequest;
  /** The row's own cursor position (what `nextCursor` is built from). */
  readonly cursorCreatedAt: string;
}

/** `created_at` printed in UTC at full precision: a JS `Date` would drop the microseconds. */
const createdAtText = sql<string>`to_char(${accessRequest.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * An erased address, in the shape the invite scrub uses (`erased+<row id, hex>@erased.invalid`):
 * keyed on the row, never on the address, so it cannot be reversed with a candidate list.
 */
const erasedEmail = sql`'erased+' || replace(${accessRequest.id}::text, '-', '') || '@erased.invalid'`;

export class AccessRequestRepo extends TenantRepo<typeof accessRequest> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accessRequest, ctx, tx);
  }

  async byId(id: string): Promise<AccessRequest | undefined> {
    return this.findById(id);
  }

  /** Row-locks the request for the rest of the transaction (decisions, verification). */
  async lockById(id: string): Promise<AccessRequest | undefined> {
    const rows = await this.tx
      .select()
      .from(accessRequest)
      .where(this.scope(eq(accessRequest.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /** The `pending` row for an address, locked. At most one exists. */
  async lockPendingByEmail(email: string): Promise<AccessRequest | undefined> {
    const rows = await this.tx
      .select()
      .from(accessRequest)
      .where(this.scope(and(eq(accessRequest.email, email), eq(accessRequest.status, "pending"))))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * Identity erasure's pre-lock (E3.5 R3B): every request `scrubForSubject` will rewrite — the
   * ones that became the membership or carried the address — row-locked in id order, and the
   * address's emailed challenges consumed. Taken BEFORE the workspace row / audit chain, like
   * every other access-request path (verify, approve, deny: the request row, then the challenges,
   * then the workspace row). The challenges cannot be row-locked (`UPDATE` is revoked on the
   * table and row locks need it), so they are deleted here instead: they are ten-minute codes,
   * the erasure deletes them anyway, and a verification racing this one waits on the rows and
   * then finds them gone (its "not consumed" answer).
   */
  async prelockForErasure(membershipId: string, email: string | null): Promise<void> {
    const mine = eq(accessRequest.membershipId, membershipId);
    const match =
      email === null ? mine : or(mine, sql`lower(${accessRequest.email}::text) = lower(${email})`);
    await this.tx
      .select({ id: accessRequest.id })
      .from(accessRequest)
      .where(this.scope(match))
      .orderBy(accessRequest.id)
      .for("update");
    if (email !== null) {
      await this.tx
        .delete(accessRequestChallenge)
        .where(
          and(
            eq(accessRequestChallenge.workspaceId, this.ctx.workspaceId),
            sql`lower(${accessRequestChallenge.email}::text) = lower(${email})`,
          ),
        );
    }
  }

  /** Whether the address has a `pending` row (unlocked read, for planning). */
  async hasPending(email: string): Promise<boolean> {
    const rows = await this.tx
      .select({ id: accessRequest.id })
      .from(accessRequest)
      .where(this.scope(and(eq(accessRequest.email, email), eq(accessRequest.status, "pending"))))
      .limit(1);
    return rows.length > 0;
  }

  async insert(values: Omit<NewAccessRequest, "workspaceId">): Promise<AccessRequest> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    values: Partial<Omit<NewAccessRequest, "id" | "workspaceId" | "createdAt">>,
  ): Promise<AccessRequest | undefined> {
    const rows = await this.tx
      .update(accessRequest)
      .set(values)
      .where(this.scope(eq(accessRequest.id, id)))
      .returning();
    return rows[0];
  }

  async delete(id: string): Promise<number> {
    return this.deleteById(id);
  }

  /**
   * Invitation acceptance (E3.1 C5): the address joined, so a request still waiting in the queue
   * is moot. Closes it as `expired` (decided now) and returns the ids closed.
   */
  async closePendingForEmail(email: string, now: Date): Promise<string[]> {
    const rows = await this.tx
      .update(accessRequest)
      .set({ status: "expired", decidedAt: now })
      .where(this.scope(and(eq(accessRequest.email, email), eq(accessRequest.status, "pending"))))
      .returning({ id: accessRequest.id });
    return rows.map((r) => r.id);
  }

  /** Pending rows in this workspace, counted no further than `cap` (the queue-size ceiling). */
  async countPending(cap: number): Promise<number> {
    const r = await this.tx.execute(
      sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${accessRequest}
          WHERE ${accessRequest.workspaceId} = ${this.ctx.workspaceId}::uuid
            AND ${accessRequest.status} = 'pending' LIMIT ${cap}) s`,
    );
    return Number((r.rows[0] as { n: number | string } | undefined)?.n ?? 0);
  }

  /** Whether the address was denied here at or after `since` (the deny cooldown). */
  async deniedSince(email: string, since: Date): Promise<boolean> {
    const rows = await this.tx
      .select({ id: accessRequest.id })
      .from(accessRequest)
      .where(
        this.scope(
          and(
            eq(accessRequest.email, email),
            eq(accessRequest.status, "denied"),
            gt(accessRequest.decidedAt, since),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** One page of the admin queue, newest first, keyset over (created_at, id). */
  async page(
    status: "pending" | "approved" | "denied" | "expired",
    cursor: AccessRequestCursor | undefined,
    limit: number,
  ): Promise<AccessRequestPageRow[]> {
    const after =
      cursor === undefined
        ? undefined
        : sql`(${accessRequest.createdAt}, ${accessRequest.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
    const rows = await this.tx
      .select({ row: accessRequest, cursorCreatedAt: createdAtText })
      .from(accessRequest)
      .where(this.scope(and(eq(accessRequest.status, status), after)))
      .orderBy(desc(accessRequest.createdAt), desc(accessRequest.id))
      .limit(limit);
    return rows;
  }

  /** Link the membership an approved request turned into (invite accepted). */
  async linkMembership(id: string, membershipId: string): Promise<void> {
    await this.tx
      .update(accessRequest)
      .set({ membershipId })
      .where(this.scope(eq(accessRequest.id, id)));
  }

  // --- sweeper ---------------------------------------------------------------------------------

  /** Moves up to `batch` overdue `pending` rows to `expired`; returns their ids. */
  async expireOverdue(now: Date, batch: number): Promise<string[]> {
    const victims = this.tx
      .select({ id: accessRequest.id })
      .from(accessRequest)
      .where(
        this.scope(and(eq(accessRequest.status, "pending"), lte(accessRequest.expiresAt, now))),
      )
      .limit(batch)
      .for("update", { skipLocked: true });
    const rows = await this.tx
      .update(accessRequest)
      .set({ status: "expired", decidedAt: now })
      .where(
        this.scope(and(inArray(accessRequest.id, victims), eq(accessRequest.status, "pending"))),
      )
      .returning({ id: accessRequest.id });
    return rows.map((r) => r.id);
  }

  /**
   * Deletes up to `batch` retired rows decided (or lapsed) before `before`: `denied`, `expired`,
   * and `approved` ones that never became a membership (E3.1 S7) — their invitation is gone,
   * accepted elsewhere, revoked or lapsed (`now` decides "lapsed"), so nothing will ever link them
   * and they would otherwise keep a stranger's name and address forever. An approved row that did
   * become a membership is that member's history and goes with the member (erasure).
   */
  async deleteRetired(before: Date, now: Date, batch: number): Promise<number> {
    const liveInvite = sql`EXISTS (SELECT 1 FROM ${invite} i
      WHERE i.id = ${accessRequest.inviteId}
        AND i.workspace_id = ${accessRequest.workspaceId}
        AND i.status = 'pending'
        AND i.expires_at > ${now}::timestamptz)`;
    const victims = this.tx
      .select({ id: accessRequest.id })
      .from(accessRequest)
      .where(
        this.scope(
          or(
            and(eq(accessRequest.status, "denied"), lt(accessRequest.decidedAt, before)),
            and(
              eq(accessRequest.status, "expired"),
              lt(sql`coalesce(${accessRequest.decidedAt}, ${accessRequest.expiresAt})`, before),
            ),
            and(
              eq(accessRequest.status, "approved"),
              isNull(accessRequest.membershipId),
              lt(accessRequest.decidedAt, before),
              sql`NOT ${liveInvite}`,
            ),
          ),
        ),
      )
      .limit(batch);
    const rows = await this.tx
      .delete(accessRequest)
      .where(this.scope(inArray(accessRequest.id, victims)))
      .returning({ id: accessRequest.id });
    return rows.length;
  }

  // --- DSAR ------------------------------------------------------------------------------------

  /** The subject's requests: those that became `membershipId`, or that carried `email`. */
  async forSubject(membershipId: string, email: string | null): Promise<AccessRequest[]> {
    const mine = eq(accessRequest.membershipId, membershipId);
    return this.tx
      .select()
      .from(accessRequest)
      .where(
        this.scope(
          email === null
            ? mine
            : or(mine, sql`lower(${accessRequest.email}::text) = lower(${email})`),
        ),
      )
      .orderBy(accessRequest.createdAt, accessRequest.id)
      .limit(1000);
  }

  /**
   * Erasure: the subject's requests are pseudonymised — address → `erased+<row id>@erased.invalid`,
   * name → `[erased]`, firm/reason/staff notes → null, the ip hash dropped — and a pending one is
   * closed (`expired`, decided now) so it does not sit in the queue under a pseudonym. The
   * address's unexpired challenges (`core.access_request_challenge`) are deleted outright.
   */
  async scrubForSubject(membershipId: string, email: string | null, now: Date): Promise<number> {
    // The address's emailed challenges carry the same PII and are not requests yet: gone.
    if (email !== null) {
      await this.tx
        .delete(accessRequestChallenge)
        .where(
          and(
            eq(accessRequestChallenge.workspaceId, this.ctx.workspaceId),
            sql`lower(${accessRequestChallenge.email}::text) = lower(${email})`,
          ),
        );
    }
    const mine = eq(accessRequest.membershipId, membershipId);
    const match =
      email === null ? mine : or(mine, sql`lower(${accessRequest.email}::text) = lower(${email})`);
    const rows = await this.tx
      .update(accessRequest)
      .set({
        email: erasedEmail,
        name: "[erased]",
        firm: null,
        reason: null,
        decisionNote: null,
        relationshipNote: null,
        clientIpHash: null,
        status: sql`CASE WHEN ${accessRequest.status} = 'pending' THEN 'expired'::core.access_request_status ELSE ${accessRequest.status} END`,
        decidedAt: sql`CASE WHEN ${accessRequest.status} = 'pending' THEN ${now}::timestamptz ELSE coalesce(${accessRequest.decidedAt}, ${now}::timestamptz) END`,
      })
      .where(
        this.scope(
          and(match, sql`${accessRequest.email}::text NOT LIKE 'erased+%@erased.invalid'`),
        ),
      )
      .returning({ id: accessRequest.id });
    return rows.length;
  }
}

/**
 * `core.access_request_challenge` (E3.1): one row per public submission, carrying that
 * submission's text and its code's keyed hash. System actor only (RLS). Never updated.
 */
export class AccessRequestChallengeRepo extends TenantRepo<typeof accessRequestChallenge> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(accessRequestChallenge, ctx, tx);
  }

  async insert(values: Omit<NewAccessRequestChallenge, "workspaceId">): Promise<void> {
    await this.insertOne(values);
  }

  /**
   * The address's challenges that have not expired, newest first. Bounded by the start budget
   * (a handful per hour); `limit` is a ceiling, not a working size.
   */
  async live(email: string, now: Date, limit: number): Promise<AccessRequestChallenge[]> {
    return this.tx
      .select()
      .from(accessRequestChallenge)
      .where(
        this.scope(
          and(eq(accessRequestChallenge.email, email), gt(accessRequestChallenge.expiresAt, now)),
        ),
      )
      .orderBy(desc(accessRequestChallenge.createdAt), desc(accessRequestChallenge.id))
      .limit(limit);
  }

  /**
   * Deletes every challenge of the address (a code was proven, or erasure) and returns their ids.
   * Two correct verifications racing each other serialise on these row locks; the second finds
   * nothing to delete and so knows it lost.
   */
  async deleteForEmail(email: string): Promise<string[]> {
    const rows = await this.tx
      .delete(accessRequestChallenge)
      .where(this.scope(eq(accessRequestChallenge.email, email)))
      .returning({ id: accessRequestChallenge.id });
    return rows.map((r) => r.id);
  }

  /** Sweeper: deletes up to `batch` expired challenges. */
  async deleteExpired(now: Date, batch: number): Promise<number> {
    const victims = this.tx
      .select({ id: accessRequestChallenge.id })
      .from(accessRequestChallenge)
      .where(this.scope(lte(accessRequestChallenge.expiresAt, now)))
      .limit(batch);
    const rows = await this.tx
      .delete(accessRequestChallenge)
      .where(this.scope(inArray(accessRequestChallenge.id, victims)))
      .returning({ id: accessRequestChallenge.id });
    return rows.length;
  }
}
