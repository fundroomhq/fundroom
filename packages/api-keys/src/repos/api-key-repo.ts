import {
  type ApiKeyRow,
  core,
  type Membership,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ApiKeyRecord, ApiKeyRevokedReason, ApiKeyWithCreator } from "../types.js";

const { apiKey, membership, user } = core;

/*
 * Data access over `core.api_key` (migration `core/0018_api_keys_webhooks.sql` — the SQL is
 * authoritative). The only file in the package that imports drizzle.
 *
 *  - The query builder only, never `tx.execute`: the raw path returns `timestamptz` as text.
 *  - The plaintext token never arrives here; callers pass `apiKeyTokenHash(token)`.
 *  - Rows are mapped to `ApiKeyRecord`, so the token hash can never reach a route.
 *  - `TenantRepo.scope()` adds `workspace_id = ctx.workspaceId` on top of RLS.
 */

export function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason ?? null,
    replacedById: row.replacedById,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    note: row.note,
  };
}

export interface NewApiKeyValues {
  readonly name: string;
  /** `apiKeyTokenHash(token)`: 32 bytes. */
  readonly tokenHash: Uint8Array;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly createdByMembershipId: string;
  readonly expiresAt: Date | null;
  readonly note: string | null;
}

export interface ApiKeyPatch {
  readonly name?: string | undefined;
  readonly note?: string | null | undefined;
}

/** "Display name, else the name the inviter gave, else null" — as `MembershipRepo` computes it. */
const creatorNameExpr = sql<
  string | null
>`NULLIF(COALESCE(NULLIF(${user.displayName}, ''), ${membership.profile}->>'displayName', ''), '')`;

export class ApiKeyRepo extends TenantRepo<typeof apiKey> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(apiKey, ctx, tx);
  }

  async insert(values: NewApiKeyValues): Promise<ApiKeyRecord> {
    const row = await this.insertOne({
      name: values.name,
      tokenHash: Buffer.from(values.tokenHash),
      prefix: values.prefix,
      scopes: [...values.scopes],
      createdByMembershipId: values.createdByMembershipId,
      expiresAt: values.expiresAt,
      note: values.note,
    });
    return toApiKeyRecord(row);
  }

  async byId(id: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.findById(id);
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /** `SELECT … FOR UPDATE` on one key (lock order: the key row first). */
  async byIdForUpdate(id: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.tx
      .select()
      .from(apiKey)
      .where(this.scope(eq(apiKey.id, id)))
      .limit(1)
      .for("update");
    const row = rows[0];
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /**
   * THE lookup. Finds revoked and expired keys too — the caller decides, so an unknown and a
   * revoked key cost the same work and answer the same 401.
   */
  async findByTokenHash(tokenHash: Uint8Array): Promise<ApiKeyRecord | undefined> {
    const rows = await this.tx
      .select()
      .from(apiKey)
      .where(this.scope(eq(apiKey.tokenHash, Buffer.from(tokenHash))))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /**
   * THE lookup, with the creator's membership in the same statement (E3.4-A): one indexed
   * probe whatever the answer, so an unknown, a revoked and an expired key cost the same work.
   * Revoked and expired keys are returned; the caller decides.
   */
  async findByTokenHashWithCreator(
    tokenHash: Uint8Array,
  ): Promise<{ key: ApiKeyRecord; creator: Membership | undefined } | undefined> {
    const rows = await this.tx
      .select({ key: apiKey, creator: membership })
      .from(apiKey)
      .leftJoin(membership, eq(membership.id, apiKey.createdByMembershipId))
      .where(this.scope(eq(apiKey.tokenHash, Buffer.from(tokenHash))))
      .limit(1);
    const r = rows[0];
    return r === undefined
      ? undefined
      : { key: toApiKeyRecord(r.key), creator: r.creator ?? undefined };
  }

  /**
   * One page of the workspace's keys, newest first, keyset on `id` (uuidv7, so id order is
   * creation order): rows with `id < before` when a cursor is given.
   */
  async pageWithCreators(before: string | undefined, limit: number): Promise<ApiKeyWithCreator[]> {
    const rows = await this.tx
      .select({ key: apiKey, creatorDisplayName: creatorNameExpr })
      .from(apiKey)
      .innerJoin(membership, eq(membership.id, apiKey.createdByMembershipId))
      .innerJoin(user, eq(user.id, membership.userId))
      .where(this.scope(before === undefined ? undefined : lt(apiKey.id, before)))
      .orderBy(desc(apiKey.id))
      .limit(limit);
    return rows.map((r) => ({
      key: toApiKeyRecord(r.key),
      creatorDisplayName: r.creatorDisplayName ?? null,
    }));
  }

  /**
   * The hourly sweep's candidates: every unrevoked key with its creator's membership facts,
   * row-locked `FOR UPDATE SKIP LOCKED` (key rows first, before any audit entry: the E3.3 lock
   * order). A key a concurrent request holds is simply picked up next hour.
   */
  async lockUnrevokedWithCreators(): Promise<
    { key: ApiKeyRecord; creator: Pick<Membership, "kind" | "status" | "expiresAt"> | undefined }[]
  > {
    // Two statements: Postgres refuses `FOR UPDATE OF` a schema-qualified name, and locking the
    // join would lock the creators' membership rows too, which is not ours to hold.
    const keys = await this.tx
      .select()
      .from(apiKey)
      .where(this.scope(isNull(apiKey.revokedAt)))
      .orderBy(apiKey.id)
      .for("update", { skipLocked: true });
    if (keys.length === 0) return [];
    const ids = [...new Set(keys.map((k) => k.createdByMembershipId))];
    const creators = await this.tx
      .select({
        id: membership.id,
        kind: membership.kind,
        status: membership.status,
        expiresAt: membership.expiresAt,
      })
      .from(membership)
      .where(and(eq(membership.workspaceId, this.ctx.workspaceId), inArray(membership.id, ids)));
    const byId = new Map(creators.map((c) => [c.id, c]));
    return keys.map((k) => {
      const c = byId.get(k.createdByMembershipId);
      return {
        key: toApiKeyRecord(k),
        creator:
          c === undefined ? undefined : { kind: c.kind, status: c.status, expiresAt: c.expiresAt },
      };
    });
  }

  /** Unrevoked keys one member created, row-locked in id order (erasure). */
  async lockUnrevokedByCreator(membershipId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.tx
      .select()
      .from(apiKey)
      .where(
        this.scope(and(eq(apiKey.createdByMembershipId, membershipId), isNull(apiKey.revokedAt))),
      )
      .orderBy(apiKey.id)
      .for("update");
    return rows.map(toApiKeyRecord);
  }

  /** Every key of the workspace, newest first, with its creator's display name. */
  async listWithCreators(): Promise<ApiKeyWithCreator[]> {
    const rows = await this.tx
      .select({ key: apiKey, creatorDisplayName: creatorNameExpr })
      .from(apiKey)
      .innerJoin(membership, eq(membership.id, apiKey.createdByMembershipId))
      .innerJoin(user, eq(user.id, membership.userId))
      .where(this.scope())
      .orderBy(desc(apiKey.createdAt), desc(apiKey.id));
    return rows.map((r) => ({
      key: toApiKeyRecord(r.key),
      creatorDisplayName: r.creatorDisplayName ?? null,
    }));
  }

  async byIdWithCreator(id: string): Promise<ApiKeyWithCreator | undefined> {
    const rows = await this.tx
      .select({ key: apiKey, creatorDisplayName: creatorNameExpr })
      .from(apiKey)
      .innerJoin(membership, eq(membership.id, apiKey.createdByMembershipId))
      .innerJoin(user, eq(user.id, membership.userId))
      .where(this.scope(eq(apiKey.id, id)))
      .limit(1);
    const r = rows[0];
    return r === undefined
      ? undefined
      : { key: toApiKeyRecord(r.key), creatorDisplayName: r.creatorDisplayName ?? null };
  }

  /**
   * The live-key cap's own lock (E3.4 fix round 1): a transaction-scoped advisory lock, keyed on
   * the workspace, taken by create, rotate and identity erasure (`lockApiKeysOfMember`) — always
   * FIRST, before any key row and before the workspace row / audit chain. It serialises the cap's
   * read-then-insert without an explicit workspace-row lock taken early (the global order, E3.5
   * LX, is workspace row → audit chain, and every audit takes the row: a key create holding the
   * row across its reads would block every auditor of the workspace for no gain). Every taker
   * takes it before anything else it locks, so it cannot close a cycle.
   */
  async lockCap(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`api_keys.cap:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  /** The liveness facts of a would-be key creator, read under the cap lock (fix round 2). */
  async creatorFacts(
    membershipId: string,
  ): Promise<Pick<Membership, "kind" | "status" | "expiresAt"> | undefined> {
    const rows = await this.tx
      .select({ kind: membership.kind, status: membership.status, expiresAt: membership.expiresAt })
      .from(membership)
      .where(and(eq(membership.workspaceId, this.ctx.workspaceId), eq(membership.id, membershipId)))
      .limit(1);
    return rows[0];
  }

  /** Unrevoked keys that have not expired at `now` (the 50-key cap counts these). */
  async countLive(now: Date): Promise<number> {
    const rows = await this.tx
      .select({ n: count() })
      .from(apiKey)
      .where(
        this.scope(
          and(isNull(apiKey.revokedAt), or(isNull(apiKey.expiresAt), gt(apiKey.expiresAt, now))),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** Name and note only; scopes are immutable. */
  async update(id: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | undefined> {
    const set: Partial<typeof apiKey.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.note !== undefined) set.note = patch.note;
    if (Object.keys(set).length === 0) return this.byId(id);
    const rows = await this.tx
      .update(apiKey)
      .set(set)
      .where(this.scope(eq(apiKey.id, id)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /**
   * Revokes a key that is not revoked yet. Returns the updated row, or undefined when it was
   * already revoked or does not exist (idempotency is the caller's: re-read with `byId`).
   */
  async revoke(
    id: string,
    reason: ApiKeyRevokedReason,
    at: Date = new Date(),
  ): Promise<ApiKeyRecord | undefined> {
    const rows = await this.tx
      .update(apiKey)
      .set({ revokedAt: at, revokedReason: reason })
      .where(this.scope(and(eq(apiKey.id, id), isNull(apiKey.revokedAt))))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /** Rotation: link `oldId → newId` and set the old key's (earlier) expiry. */
  async markReplaced(
    oldId: string,
    newId: string,
    expiresAt: Date | null,
  ): Promise<ApiKeyRecord | undefined> {
    const rows = await this.tx
      .update(apiKey)
      .set({ replacedById: newId, expiresAt })
      .where(this.scope(eq(apiKey.id, oldId)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toApiKeyRecord(row);
  }

  /** Unrevoked keys one member created (sweep, erasure). */
  async listUnrevokedByCreator(membershipId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.tx
      .select()
      .from(apiKey)
      .where(
        this.scope(and(eq(apiKey.createdByMembershipId, membershipId), isNull(apiKey.revokedAt))),
      )
      .orderBy(apiKey.id);
    return rows.map(toApiKeyRecord);
  }

  /** Every unrevoked key of the workspace (the hourly sweep checks their creators). */
  async listUnrevoked(): Promise<ApiKeyRecord[]> {
    const rows = await this.tx
      .select()
      .from(apiKey)
      .where(this.scope(isNull(apiKey.revokedAt)))
      .orderBy(apiKey.id);
    return rows.map(toApiKeyRecord);
  }

  /**
   * Records a use at most once per `throttleSeconds` per key (one conditional UPDATE; no row
   * lock is held unless the write happens). Run it on its own short transaction, never inside a
   * handler's. Returns whether a row was written.
   */
  async touchLastUsed(id: string, ip: string | null, throttleSeconds = 60): Promise<boolean> {
    const rows = await this.tx
      .update(apiKey)
      .set({ lastUsedAt: sql`now()`, lastUsedIp: ip })
      .where(
        this.scope(
          and(
            eq(apiKey.id, id),
            or(
              isNull(apiKey.lastUsedAt),
              lt(apiKey.lastUsedAt, sql`now() - make_interval(secs => ${throttleSeconds})`),
            ),
          ),
        ),
      )
      .returning({ id: apiKey.id });
    return rows.length > 0;
  }
}
