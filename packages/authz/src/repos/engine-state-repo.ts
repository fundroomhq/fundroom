import { randomUUID } from "node:crypto";
import {
  core,
  type Database,
  listLiveWorkspaceIds,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type { RelationshipSnapshot } from "@fundroom/ports";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { parseTimestamptz } from "./access-repo.js";
import { buildRelationshipSnapshot } from "./snapshot.js";

const { authzEngineState, membership, workspace } = core;

/*
 * `core.authz_engine_state` (core migration 0026, E3.13): one row per workspace with the store and
 * model the external relationship engine holds and the acl_version it last synced. System context
 * only (tenant fence + `system` policy); a cross-workspace pass iterates workspaces one system
 * transaction each.
 */

export interface EngineStateRow {
  readonly driver: string;
  readonly storeRef: string | null;
  readonly modelRef: string | null;
  readonly syncedAclVersion: number;
  readonly syncedAt: Date | null;
  readonly lastErrorCode: string | null;
}

/** The engine state plus the workspace's live facts, read in one statement pair. */
export interface EngineView {
  readonly state: EngineStateRow | undefined;
  readonly aclVersion: number;
  /** Soft-deleted (or gone): nothing to sync. */
  readonly deleted: boolean;
}

export async function readEngineView(tx: Tx, ctx: TenantContext): Promise<EngineView> {
  const ws = (
    await tx
      .select({ aclVersion: workspace.aclVersion, deletedAt: workspace.deletedAt })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1)
  )[0];
  const state = (
    await tx
      .select()
      .from(authzEngineState)
      .where(eq(authzEngineState.workspaceId, ctx.workspaceId))
      .limit(1)
  )[0];
  return {
    state:
      state === undefined
        ? undefined
        : {
            driver: state.driver,
            storeRef: state.storeRef,
            modelRef: state.modelRef,
            syncedAclVersion: Number(state.syncedAclVersion),
            syncedAt: state.syncedAt,
            lastErrorCode: state.lastErrorCode,
          },
    aclVersion: Number(ws?.aclVersion ?? 0),
    deleted: ws === undefined || ws.deletedAt !== null,
  };
}

/** A successful sync: refs, version, time; clears the last error. */
export async function recordEngineSynced(
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly driver: string;
    readonly storeRef: string | null;
    readonly modelRef: string | null;
    readonly syncedAclVersion: number;
    readonly at: Date;
    /** The sync lease this sync holds (FIX2 C9): the row is written only while it still owns it. */
    readonly leaseOwner?: string | null | undefined;
  },
): Promise<boolean> {
  const values = {
    driver: input.driver,
    storeRef: input.storeRef,
    modelRef: input.modelRef,
    syncedAclVersion: input.syncedAclVersion,
    syncedAt: input.at,
    lastErrorCode: null,
  };
  const owner = input.leaseOwner ?? null;
  const rows = await tx
    .insert(authzEngineState)
    .values({ workspaceId: ctx.workspaceId, ...values })
    .onConflictDoUpdate({
      target: authzEngineState.workspaceId,
      set: values,
      // Monotonic (E3.13 R3-4): an older snapshot finishing last never rolls the version back;
      // fenced (FIX2 C9): a sync whose lease was taken over records nothing.
      setWhere:
        owner === null
          ? sql`${authzEngineState.syncedAclVersion} <= ${input.syncedAclVersion}`
          : sql`${authzEngineState.syncedAclVersion} <= ${input.syncedAclVersion}
                AND ${authzEngineState.leaseOwner} = ${owner}`,
    })
    .returning({ id: authzEngineState.workspaceId });
  return rows.length > 0;
}

/**
 * Claims the workspace's sync lease (FIX2 C9) for `ttlMs` when it is free, expired or already
 * ours: one conditional upsert, no lock held afterwards — safe under transaction pooling.
 */
export async function claimSyncLease(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly driver: string; readonly owner: string; readonly ttlMs: number },
): Promise<boolean> {
  const until = sql`now() + make_interval(secs => ${input.ttlMs / 1000})`;
  const rows = await tx
    .insert(authzEngineState)
    .values({
      workspaceId: ctx.workspaceId,
      driver: input.driver,
      leaseOwner: input.owner,
      leaseUntil: until,
    })
    .onConflictDoUpdate({
      target: authzEngineState.workspaceId,
      set: { leaseOwner: input.owner, leaseUntil: until },
      setWhere: sql`${authzEngineState.leaseOwner} IS NULL
        OR ${authzEngineState.leaseUntil} < now()
        OR ${authzEngineState.leaseOwner} = ${input.owner}`,
    })
    .returning({ id: authzEngineState.workspaceId });
  return rows.length > 0;
}

/** Releases the lease if `owner` still holds it. */
export async function releaseSyncLease(tx: Tx, ctx: TenantContext, owner: string): Promise<void> {
  await tx
    .update(authzEngineState)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(
      and(
        eq(authzEngineState.workspaceId, ctx.workspaceId),
        eq(authzEngineState.leaseOwner, owner),
      ),
    );
}

/** Folder ids of the workspace created at or before `before` (at most `limit + 1` rows). */
export async function foldersCreatedBefore(
  tx: Tx,
  ctx: TenantContext,
  before: Date,
  limit: number,
): Promise<string[]> {
  const present = await tx.execute(
    sql`SELECT to_regclass('dataroom.folder') IS NOT NULL AS present`,
  );
  if ((present.rows[0] as { present?: boolean } | undefined)?.present !== true) return [];
  const r = await tx.execute(
    sql`SELECT id::text AS id FROM dataroom.folder
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND created_at <= ${before.toISOString()}::timestamptz
         LIMIT ${limit + 1}`,
  );
  return (r.rows as { id: string }[]).map((x) => x.id);
}

/** A failed sync: keeps the refs and version, sets `last_error_code`. */
export async function recordEngineError(
  tx: Tx,
  ctx: TenantContext,
  driver: string,
  code: string,
): Promise<void> {
  await tx
    .insert(authzEngineState)
    .values({ workspaceId: ctx.workspaceId, driver, lastErrorCode: code })
    .onConflictDoUpdate({
      target: authzEngineState.workspaceId,
      set: { driver, lastErrorCode: code },
    });
}

export async function deleteEngineState(tx: Tx, ctx: TenantContext): Promise<void> {
  await tx.delete(authzEngineState).where(eq(authzEngineState.workspaceId, ctx.workspaceId));
}

/** kind/role of one membership of the current workspace (who the engine may answer for). */
export async function membershipShape(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<{ readonly kind: "staff" | "external"; readonly role: string } | undefined> {
  const rows = await tx
    .select({ kind: membership.kind, role: membership.role })
    .from(membership)
    .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.id, membershipId)))
    .limit(1);
  return rows[0];
}

/** The data-room root folder's id (path `r`), or undefined (no data room / no root yet). */
export async function rootFolderId(tx: Tx, ctx: TenantContext): Promise<string | undefined> {
  const present = await tx.execute(
    sql`SELECT to_regclass('dataroom.folder') IS NOT NULL AS present`,
  );
  if ((present.rows[0] as { present?: boolean } | undefined)?.present !== true) return undefined;
  const r = await tx.execute(
    sql`SELECT id::text AS id FROM dataroom.folder
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND path = 'r'::ltree LIMIT 1`,
  );
  return (r.rows as { id: string }[])[0]?.id;
}

/**
 * Workspaces soft-deleted since `since` (host context): the reconciler drops their engine stores.
 * Bounded so the hourly pass does not grow with every workspace ever deleted.
 */
export async function recentlyDeletedWorkspaceIds(db: Database, since: Date): Promise<string[]> {
  return db.withHost(async (tx) => {
    const rows = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(isNotNull(workspace.deletedAt), gt(workspace.deletedAt, since)))
      .orderBy(workspace.deletedAt);
    return rows.map((r) => r.id);
  });
}

/**
 * Everything `withRelationshipEngine` reads and writes, one short transaction per call (never
 * nested, never held across an engine call). A seam so the wrapper's logic is unit-testable.
 */
export interface EngineStore {
  view(workspaceId: string): Promise<EngineView>;
  /** The view and the snapshot in ONE transaction; undefined when the workspace is deleted. */
  snapshot(workspaceId: string): Promise<
    | {
        readonly view: EngineView;
        readonly snapshot: RelationshipSnapshot;
        /** The snapshot transaction's DB time (`now()`): what the sync records as `synced_at`. */
        readonly at: Date;
      }
    | undefined
  >;
  shape(
    workspaceId: string,
    membershipId: string,
  ): Promise<{ readonly kind: "staff" | "external"; readonly role: string } | undefined>;
  recordSynced(
    workspaceId: string,
    input: Parameters<typeof recordEngineSynced>[2],
  ): Promise<boolean>;
  claimLease(workspaceId: string, driver: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(workspaceId: string, owner: string): Promise<void>;
  /** Folder ids created at or before `before`; more than `limit` → `undefined` (over budget). */
  foldersBefore(workspaceId: string, before: Date, limit: number): Promise<string[] | undefined>;
  recordError(workspaceId: string, driver: string, code: string): Promise<void>;
  deleteState(workspaceId: string): Promise<void>;
  liveWorkspaceIds(): Promise<string[]>;
  recentlyDeletedWorkspaceIds(since: Date): Promise<string[]>;
  rootFolderId(workspaceId: string): Promise<string | undefined>;
}

export function createEngineStore(
  db: Database,
  options: { readonly kinds?: (() => Iterable<string>) | undefined } = {},
): EngineStore {
  const inTx = <T>(workspaceId: string, fn: (tx: Tx, ctx: TenantContext) => Promise<T>) => {
    const ctx = systemContext(workspaceId);
    return db.withTenant(ctx, (tx) => fn(tx, ctx));
  };
  return {
    view: (ws) => inTx(ws, readEngineView),
    snapshot: (ws) =>
      inTx(ws, async (tx, ctx) => {
        const view = await readEngineView(tx, ctx);
        if (view.deleted) return undefined;
        // FIX3 RR2-2: DB clock, same as the folders' `created_at` it is compared with.
        const clock = await tx.execute(sql`SELECT now()::text AS at`);
        const at = parseTimestamptz((clock.rows[0] as { at: string }).at) ?? new Date();
        const snapshot = await buildRelationshipSnapshot(tx, ctx, { kinds: options.kinds?.() });
        return { view, snapshot, at };
      }),
    shape: (ws, m) => inTx(ws, (tx, ctx) => membershipShape(tx, ctx, m)),
    recordSynced: (ws, input) => inTx(ws, (tx, ctx) => recordEngineSynced(tx, ctx, input)),
    claimLease: (ws, driver, owner, ttlMs) =>
      inTx(ws, (tx, ctx) => claimSyncLease(tx, ctx, { driver, owner, ttlMs })),
    releaseLease: (ws, owner) => inTx(ws, (tx, ctx) => releaseSyncLease(tx, ctx, owner)),
    foldersBefore: async (ws, before, limit) => {
      const ids = await inTx(ws, (tx, ctx) => foldersCreatedBefore(tx, ctx, before, limit));
      return ids.length > limit ? undefined : ids;
    },
    recordError: (ws, driver, code) =>
      inTx(ws, (tx, ctx) => recordEngineError(tx, ctx, driver, code)),
    deleteState: (ws) => inTx(ws, deleteEngineState),
    liveWorkspaceIds: () => listLiveWorkspaceIds(db),
    recentlyDeletedWorkspaceIds: (since) => recentlyDeletedWorkspaceIds(db, since),
    rootFolderId: (ws) => inTx(ws, rootFolderId),
  };
}

/** What `syncLock` answers when another sync of the workspace holds the lock. */
export const SYNC_BUSY: unique symbol = Symbol("authz.engine_sync busy");

/** Runs `fn` holding the workspace's sync lock; `fn` gets the lease token to fence its record. */
export type SyncLock = <T>(
  workspaceId: string,
  fn: (leaseOwner: string | null) => Promise<T>,
) => Promise<T | typeof SYNC_BUSY>;

/** Default lease: longer than any sync should take; an expired one is taken over (crash). */
export const SYNC_LEASE_TTL_MS = 20 * 60_000;

/**
 * The cross-process sync lock (FIX2 C9): a lease row on `core.authz_engine_state` claimed by a
 * conditional upsert in a short system transaction — no session state, so it works through a
 * transaction-pooling PgBouncer, and nothing is held across the engine call. A crashed holder's
 * lease expires after `ttlMs` and is taken over; the sync records only while it still owns its lease.
 */
export function createLeaseSyncLock(
  store: Pick<EngineStore, "claimLease" | "releaseLease">,
  driver: string,
  ttlMs: number = SYNC_LEASE_TTL_MS,
): SyncLock {
  return async (workspaceId, fn) => {
    const owner = randomUUID().replace(/-/gu, "");
    if (!(await store.claimLease(workspaceId, driver, owner, ttlMs))) return SYNC_BUSY;
    try {
      return await fn(owner);
    } finally {
      await store.releaseLease(workspaceId, owner).catch(() => undefined);
    }
  };
}

/** The in-process fallback: one sync per workspace in this process. */
export function createLocalSyncLock(): SyncLock {
  const running = new Set<string>();
  return async (workspaceId, fn) => {
    if (running.has(workspaceId)) return SYNC_BUSY;
    running.add(workspaceId);
    try {
      return await fn(null);
    } finally {
      running.delete(workspaceId);
    }
  };
}
