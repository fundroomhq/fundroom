import {
  type Database,
  listLiveWorkspaceIds,
  pgErrorCode,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type { JobDefinition, JsonObject, KmsPort } from "@fundroom/ports";
import { WorkspaceKeyRepo } from "./repos/workspace-key-repo.js";

/*
 * Per-workspace data keys (ADR-0016). `currentKey` is what writers call before encrypting
 * an object; the returned `keyId` goes on the blob row. Readers call `keyById` with that id
 * and get the same DEK even after rotation. Plaintext DEKs live only in this process's
 * cache (TTL-bounded, keyed by workspace + key id) and in the caller's stack.
 */
export const DEFAULT_PURPOSE = "workspace-dek";
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

export interface WorkspaceDataKey {
  readonly keyId: string;
  readonly keyRef: string;
  readonly purpose: string;
  /** 32 bytes. Do not persist, do not log. */
  readonly key: Uint8Array;
}

export interface EnvelopeServiceOptions {
  readonly db: Database;
  readonly kms: KmsPort;
  /** How long an unwrapped DEK stays in memory. Default 10 min. */
  readonly cacheTtlMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Structured log hook; never receives key material. */
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface EnvelopeStats {
  readonly cached: number;
  readonly hits: number;
  readonly misses: number;
}

export interface EnvelopeService {
  /** The active key for the workspace of `ctx`, created on first use. */
  currentKey(tx: Tx, ctx: TenantContext, purpose?: string): Promise<WorkspaceDataKey>;
  /** A specific key (active or retired); `undefined` when the workspace has no such key. */
  keyById(tx: Tx, ctx: TenantContext, keyId: string): Promise<WorkspaceDataKey | undefined>;
  /**
   * Every key the workspace holds for `purpose`, retired ones included, oldest first; empty when
   * none exists yet (never creates one). For derivations that must still *match* after a rotation
   * — an HMAC lookup index is checked under every key its rows were written with.
   */
  keysFor(tx: Tx, ctx: TenantContext, purpose: string): Promise<WorkspaceDataKey[]>;
  /** Retires the active key and creates a new one. Returns the new key. */
  rotate(tx: Tx, ctx: TenantContext, purpose?: string): Promise<WorkspaceDataKey>;
  /** Rewraps every key not wrapped under `kms.currentKeyRef`. Returns how many. */
  rewrap(tx: Tx, ctx: TenantContext): Promise<number>;
  /** Drops cached plaintext keys for one workspace, or all. */
  invalidate(workspaceId?: string): void;
  stats(): EnvelopeStats;
}

interface CacheEntry {
  readonly value: WorkspaceDataKey;
  readonly expiresAt: number;
}

export function createEnvelopeService(options: EnvelopeServiceOptions): EnvelopeService {
  const { kms } = options;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const cache = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;

  const cacheKey = (workspaceId: string, keyId: string) => `${workspaceId}:${keyId}`;

  function remember(workspaceId: string, value: WorkspaceDataKey): WorkspaceDataKey {
    cache.set(cacheKey(workspaceId, value.keyId), { value, expiresAt: now().getTime() + ttl });
    return value;
  }

  function recall(workspaceId: string, keyId: string): WorkspaceDataKey | undefined {
    const hit = cache.get(cacheKey(workspaceId, keyId));
    if (!hit) {
      misses += 1;
      return undefined;
    }
    if (hit.expiresAt <= now().getTime()) {
      cache.delete(cacheKey(workspaceId, keyId));
      misses += 1;
      return undefined;
    }
    hits += 1;
    return hit.value;
  }

  async function unwrapRow(
    ctx: TenantContext,
    row: { id: string; kmsKeyRef: string; wrappedDek: Uint8Array; purpose: string },
    useCache = true,
  ): Promise<WorkspaceDataKey> {
    const cached = useCache ? recall(ctx.workspaceId, row.id) : undefined;
    if (cached) return cached;
    const key = await kms.unwrapDataKey(row.wrappedDek, row.kmsKeyRef, {
      workspaceId: ctx.workspaceId,
      purpose: row.purpose,
    });
    return remember(ctx.workspaceId, {
      keyId: row.id,
      keyRef: row.kmsKeyRef,
      purpose: row.purpose,
      key,
    });
  }

  async function create(
    repo: WorkspaceKeyRepo,
    ctx: TenantContext,
    purpose: string,
    rotatedFromId: string | null,
  ): Promise<WorkspaceDataKey> {
    const generated = await kms.generateDataKey({ workspaceId: ctx.workspaceId, purpose });
    const row = await repo.insert({
      purpose,
      kmsKeyRef: generated.keyRef,
      wrappedDek: Buffer.from(generated.wrapped),
      rotatedFromId,
    });
    log("crypto.key_created", {
      workspaceId: ctx.workspaceId,
      keyId: row.id,
      keyRef: row.kmsKeyRef,
      purpose,
      rotatedFromId,
    });
    return remember(ctx.workspaceId, {
      keyId: row.id,
      keyRef: row.kmsKeyRef,
      purpose,
      key: generated.plaintext,
    });
  }

  return {
    async currentKey(tx, ctx, purpose = DEFAULT_PURPOSE) {
      const repo = new WorkspaceKeyRepo(ctx, tx);
      const existing = await repo.findActive(purpose);
      if (existing) return unwrapRow(ctx, existing);
      try {
        // In a SAVEPOINT: when two writers race on first use, the loser's INSERT fails on the
        // partial unique index, and without the savepoint that error aborts the caller's whole
        // transaction (25P02) — the re-read below and everything after it would fail too.
        return await tx.transaction((sp) =>
          create(new WorkspaceKeyRepo(ctx, sp), ctx, purpose, null),
        );
      } catch (error) {
        // Two writers raced on first use: the partial unique index let one through.
        if (pgErrorCode(error) !== "23505") throw error;
        const winner = await repo.findActive(purpose);
        if (!winner) throw error;
        return unwrapRow(ctx, winner);
      }
    },

    async keyById(tx, ctx, keyId) {
      const cached = recall(ctx.workspaceId, keyId);
      if (cached) return cached;
      const row = await new WorkspaceKeyRepo(ctx, tx).byId(keyId);
      if (!row) return undefined;
      return unwrapRow(ctx, row, false);
    },

    async keysFor(tx, ctx, purpose) {
      const rows = await new WorkspaceKeyRepo(ctx, tx).listAll(purpose);
      const keys: WorkspaceDataKey[] = [];
      for (const row of rows) keys.push(await unwrapRow(ctx, row));
      return keys;
    },

    async rotate(tx, ctx, purpose = DEFAULT_PURPOSE) {
      const repo = new WorkspaceKeyRepo(ctx, tx);
      const active = await repo.findActive(purpose);
      if (active) await repo.retire(active.id, now());
      const next = await create(repo, ctx, purpose, active?.id ?? null);
      log("crypto.key_rotated", {
        workspaceId: ctx.workspaceId,
        purpose,
        retiredKeyId: active?.id ?? null,
        keyId: next.keyId,
      });
      return next;
    },

    async rewrap(tx, ctx) {
      const repo = new WorkspaceKeyRepo(ctx, tx);
      let count = 0;
      for (const row of await repo.listAll()) {
        if (!kms.needsRewrap(row.kmsKeyRef)) continue;
        const context = { workspaceId: ctx.workspaceId, purpose: row.purpose };
        const plaintext = await kms.unwrapDataKey(row.wrappedDek, row.kmsKeyRef, context);
        const wrapped = await kms.wrapDataKey(plaintext, context);
        await repo.updateWrapped(row.id, Buffer.from(wrapped.wrapped), wrapped.keyRef);
        cache.delete(cacheKey(ctx.workspaceId, row.id));
        count += 1;
        log("crypto.key_rewrapped", {
          workspaceId: ctx.workspaceId,
          keyId: row.id,
          from: row.kmsKeyRef,
          to: wrapped.keyRef,
        });
      }
      return count;
    },

    invalidate(workspaceId) {
      if (workspaceId === undefined) {
        cache.clear();
        return;
      }
      for (const k of cache.keys()) if (k.startsWith(`${workspaceId}:`)) cache.delete(k);
    },

    stats() {
      return { cached: cache.size, hits, misses };
    },
  };
}

export interface CryptoJobOptions {
  readonly db: Database;
  readonly envelope: EnvelopeService;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/**
 * `crypto.rewrap` (daily 03:20 UTC): after a KEK rotation (`SECRET_KEY_RING=v2:…,v1:…`, or a
 * new key in a remote KMS) every workspace's wrapped DEKs are moved to the current KEK, one
 * workspace per transaction. A no-op when nothing is stale, so it is safe to run daily.
 */
export function createCryptoJobs(options: CryptoJobOptions): JobDefinition[] {
  return [
    {
      name: "crypto.rewrap",
      cron: "20 3 * * *",
      handler: async () => {
        let workspaces = 0;
        let keys = 0;
        for (const workspaceId of await listLiveWorkspaceIds(options.db)) {
          const n = await options.db.withTenant(systemContext(workspaceId), (tx) =>
            options.envelope.rewrap(tx, systemContext(workspaceId)),
          );
          workspaces += 1;
          keys += n;
        }
        options.log?.("crypto.rewrapped", { workspaces, keys });
      },
    },
  ] satisfies JobDefinition<JsonObject>[];
}
