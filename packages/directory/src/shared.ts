import { ApiError } from "@fundroom/contracts";
import { createDatabase, type Database } from "@fundroom/db";
import type {
  DirectoryCell,
  DirectoryEntryState,
  DirectoryMove,
  DirectoryMoves,
  DirectoryPort,
} from "@fundroom/ports";
import { directoryHostname } from "./hostname.js";
import { listLocalCells } from "./repos/local-cells-repo.js";
import {
  activateEntry,
  casMove,
  claimHostname,
  type EntryRow,
  extendLease,
  hasLiveMove,
  insertEntry,
  insertMove,
  inTx,
  isForeignKeyViolation,
  isUniqueViolation,
  isUuid,
  leaseHeld,
  lockEntry,
  markSwitched,
  type Queryable,
  rebindEntry,
  releaseEntry,
  releaseEntryById,
  releaseHostname,
  releaseStaleReservations,
  renameEntry,
  selectCellIdByHost,
  selectCellOwner,
  selectCells,
  selectEntriesOfCells,
  selectEntryBySlug,
  selectEntryByWorkspace,
  selectEntryMovedFrom,
  selectHostnamesOfCells,
  selectMove,
  selectMoves,
  setEntryState,
  takeLease,
  updateEntry,
  upsertCell,
} from "./repos/shared-repo.js";

/*
 * `shared` mode (DIRECTORY_DATABASE_URL set): the directory database decides slug and hostname
 * uniqueness across cells and routes cross-cell requests. Semantics are the port's
 * (`@fundroom/ports` directory.ts) plus the notes in the E3.11 handshake:
 *
 *  - Every failure THROWS. Nothing here swallows a directory error; best-effort callers decide.
 *    (Only the tenant-resolution cache, `routing.ts`, turns errors into misses.)
 *  - A slug is unique among non-deleted entries (`workspace_slug_live_idx`); a claim never
 *    reclaims a stale `reserved` entry — the reconcile sweep releases this cell's reservations
 *    older than an hour that have no local workspace.
 *  - Moves are CAS transitions with leases (owner token + expiry on the directory's clock);
 *    `switchover` rebinds the entry and marks the move `switched` in one transaction, so the slug
 *    and every hostname (rows keyed on the entry) follow the workspace atomically.
 */

export interface SharedDirectoryOptions {
  /** DIRECTORY_DATABASE_URL. */
  readonly url: string;
  /** DIRECTORY_DATABASE_POOL_MAX. */
  readonly poolMax: number;
  /** This cell database: `listCells` marks the cells present in its `core.cell` `local: true`. */
  readonly db: Database;
  /** CELL_ID. */
  readonly cellId: string;
  /**
   * This deployment's export public keys (`exportPublicKeys(keyRing)`, current first): the proof
   * that a directory cell row is ours. A row published with another key belongs to another cell
   * database that happens to use the same id (every database seeds `default`): we never
   * overwrite it and never claim entries on it. Empty = no ownership check (tests).
   */
  readonly ownerKeys?: readonly string[] | undefined;
  /** Pool error sink (idle connection dropped). Default: ignored. */
  readonly onError?: ((error: Error) => void) | undefined;
}

/** What the reconcile sweep may repair in an entry. */
export type EnsureEntryResult =
  | "unchanged"
  | "created"
  | "repaired"
  /** Another live entry holds the slug (logged by the sweep; the local slug is not changed). */
  | "slug_taken"
  /** The entry is bound to a cell this database does not serve (a move rebound it): left alone. */
  | "elsewhere"
  /** The entry was released (purge): the sweep never revives it. */
  | "released"
  /** The local facts changed between the sweep's read and its write: nothing written. */
  | "stale";

/** The shared directory: the port plus what the reconcile sweep and the routing cache need. */
export interface SharedDirectory extends DirectoryPort {
  readonly mode: "shared";
  /** Subscribes to this instance's own writes (the routing cache clears on them). */
  onWrite(listener: () => void): () => void;
  /**
   * Sweep: make the workspace's entry `state` (default `active`; `dormant` for a soft-deleted
   * workspace) with this slug on this cell. Never steals a slug — except from a local soft-deleted
   * workspace listed in `displace` (same database = evidence) — and never revives a released entry.
   */
  ensureEntry(input: {
    readonly workspaceId: string;
    readonly slug: string;
    readonly cellId: string;
    /** Cells this database serves; an entry bound elsewhere is never pulled back. */
    readonly localCellIds: readonly string[];
    readonly state?: "active" | "dormant" | undefined;
    /** Local soft-deleted workspace ids whose entries a live workspace may take the slug from. */
    readonly displace?: readonly string[] | undefined;
    /** Re-reads the local facts inside the directory transaction; false → nothing written. */
    readonly confirm?: (() => Promise<boolean>) | undefined;
  }): Promise<EnsureEntryResult>;
  /** Sweep: every hostname bound to a non-deleted entry of these cells. */
  hostnamesOfCells(
    cellIds: readonly string[],
  ): Promise<{ readonly hostname: string; readonly workspaceId: string }[]>;
  /** Sweep: `reserved` entries of `cellIds` older than `olderThan` not in `keep` → deleted. */
  releaseStaleReservations(input: {
    readonly cellIds: readonly string[];
    readonly olderThan: Date;
    readonly keep: readonly string[];
  }): Promise<string[]>;
  /** Sweep / CLI: every entry of these cells. */
  entriesOfCells(cellIds: readonly string[]): Promise<EntryRow[]>;
}

export function isSharedDirectory(port: DirectoryPort): port is SharedDirectory {
  return (
    port.mode === "shared" &&
    typeof (port as Partial<SharedDirectory>).ensureEntry === "function" &&
    typeof (port as Partial<SharedDirectory>).onWrite === "function"
  );
}

function cellConflict(cellId: string): ApiError {
  return new ApiError(
    "directory_unavailable",
    `cell ${cellId} is published in the cell directory by another cell database (cell ids must be unique across the directory)`,
    { reason: "cell_conflict" },
  );
}

function cellNotPublished(cellId: string): ApiError {
  return new ApiError(
    "directory_unavailable",
    `cell ${cellId} is not published in the cell directory yet`,
    { reason: "cell_not_published" },
  );
}

export function createSharedDirectory(options: SharedDirectoryOptions): SharedDirectory {
  /*
   * A pool of its own, no role switch (the directory database has no RLS and no app role), a
   * bounded connect and a client-side bound on every query: a black-holed directory must fail
   * a request's lookup quickly, never hang it.
   */
  const dirDb = createDatabase({
    connectionString: options.url,
    poolMax: options.poolMax,
    switchRole: false,
    statementTimeoutMs: 5_000,
    connectionTimeoutMs: 3_000,
    clientTimeoutMs: 10_000,
    onIdleError: options.onError,
    onActiveError: options.onError,
  });
  const pool = dirDb.pool;
  const ownerKeys = options.ownerKeys ?? [];
  /** Cells proven ours (published with one of our keys) — ownership never moves. */
  const owned = new Set<string>();

  /**
   * Before an entry names `cellId`: the cell must be published and ours. A local cell not yet
   * published (added a moment ago; the heartbeat publishes within 5 min) is published here.
   */
  async function ensureCellOwned(cellId: string): Promise<void> {
    if (owned.has(cellId)) return;
    const row = await selectCellOwner(pool, cellId);
    if (row === undefined) {
      const local = (await listLocalCells(options.db)).find((c) => c.id === cellId);
      if (local === undefined || local.region === "default") throw cellNotPublished(cellId);
      const ok = await upsertCell(
        pool,
        {
          id: local.id,
          region: local.region,
          regionLabel: local.regionLabel,
          jurisdiction: local.jurisdiction,
          publicOrigin: local.publicOrigin,
          status: local.status,
          exportPublicKey: ownerKeys[0] ?? null,
        },
        ownerKeys,
      );
      if (!ok) throw cellConflict(cellId);
    } else if (
      ownerKeys.length > 0 &&
      row.exportPublicKey !== null &&
      !ownerKeys.includes(row.exportPublicKey)
    ) {
      throw cellConflict(cellId);
    }
    owned.add(cellId);
  }
  const listeners = new Set<() => void>();
  function wrote(): void {
    for (const l of listeners) {
      try {
        l();
      } catch {
        // a cache listener must never fail a write
      }
    }
  }
  async function write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      wrote();
    }
  }

  const moves: DirectoryMoves = {
    async request(input) {
      if (!isUuid(input.workspaceId)) return "unknown_workspace";
      return write(async () => {
        try {
          return await inTx(pool, async (client) => {
            const entry = await selectEntryByWorkspace(client, input.workspaceId, {
              forUpdate: true,
            });
            if (entry === undefined || entry.state === "deleted") return "unknown_workspace";
            return insertMove(client, {
              entryId: entry.entryId,
              sourceWorkspaceId: input.workspaceId,
              slug: entry.slug,
              sourceCellId: input.sourceCellId,
              targetCellId: input.targetCellId,
              requestedBy: input.requestedBy,
              carried: input.carried,
            });
          });
        } catch (error) {
          if (isUniqueViolation(error, "move_live_entry_idx")) return "busy";
          throw error;
        }
      });
    },
    async get(id) {
      return (await selectMove(pool, id)) ?? null;
    },
    async list(filter) {
      const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100), 1), 500);
      return selectMoves(pool, {
        cellId: filter.cellId,
        role: filter.role,
        states: filter.states,
        workspaceId: filter.workspaceId,
        limit,
      });
    },
    async transition(id, t) {
      return write(async () => (await casMove(pool, id, t)) ?? null);
    },
    async acquireLease(id, owner, ttlMs, from) {
      return (await takeLease(pool, id, owner, ttlMs, from)) ?? null;
    },
    async heartbeat(id, owner, ttlMs) {
      return extendLease(pool, id, owner, ttlMs);
    },
    async switchover(id, owner) {
      if (!isUuid(id)) return null;
      return write(async () => {
        try {
          return await inTx(pool, async (client): Promise<DirectoryMove | null> => {
            const move = await selectMove(client, id, { forUpdate: true });
            if (move === undefined || move.state !== "imported") return null;
            if (move.targetWorkspaceId === null) return null;
            if (!(await leaseHeld(client, id, owner))) return null;
            const entry = await lockEntry(client, move.entryId);
            if (entry === undefined || entry.state === "deleted") return null;
            await rebindEntry(client, move.entryId, {
              workspaceId: move.targetWorkspaceId,
              cellId: move.targetCellId,
            });
            return (await markSwitched(client, id)) ?? null;
          });
        } catch (error) {
          // Another entry already carries the target workspace id (it claimed a slug of its own).
          if (isUniqueViolation(error)) return null;
          if (isForeignKeyViolation(error)) return null;
          throw error;
        }
      });
    },
  };

  async function localCellIds(): Promise<Set<string>> {
    return new Set((await listLocalCells(options.db)).map((c) => c.id));
  }

  return {
    mode: "shared",
    async listCells(): Promise<DirectoryCell[]> {
      const [cells, local] = await Promise.all([selectCells(pool), localCellIds()]);
      // A row another cell database published under the same id is not ours, whatever our
      // `core.cell` says (every database seeds `default`).
      const ours = (key: string | null) =>
        ownerKeys.length === 0 || key === null || ownerKeys.includes(key);
      return cells.map((c) => ({ ...c, local: local.has(c.id) && ours(c.exportPublicKey) }));
    },
    async publishCell(cell) {
      const keys =
        ownerKeys.length > 0
          ? ownerKeys
          : cell.exportPublicKey === null
            ? []
            : [cell.exportPublicKey];
      if (!(await upsertCell(pool, cell, keys))) throw cellConflict(cell.id);
    },
    async lookupSlug(slug) {
      const entry = await selectEntryBySlug(pool, slug.toLowerCase());
      // A dormant (soft-deleted) entry holds the slug but answers exactly like no entry (R2-3).
      if (entry === undefined || entry.state === "deleted" || entry.state === "dormant")
        return null;
      return { cellId: entry.cellId, state: entry.state };
    },
    async lookupHost(hostname) {
      const key = directoryHostname(hostname);
      if (key === undefined) return null;
      const cellId = await selectCellIdByHost(pool, key);
      return cellId === undefined ? null : { cellId };
    },
    async lookupWorkspace(workspaceId) {
      if (!isUuid(workspaceId)) return null;
      const entry =
        (await selectEntryByWorkspace(pool, workspaceId)) ??
        (await selectEntryMovedFrom(pool, workspaceId));
      return entry === undefined
        ? null
        : { entryId: entry.entryId, cellId: entry.cellId, state: entry.state };
    },
    async claimSlug(input) {
      if (!isUuid(input.workspaceId)) throw new Error("directory: workspaceId must be a uuid");
      await ensureCellOwned(input.cellId);
      return write(async () => {
        try {
          return await inTx(pool, async (client) => {
            const mine = await selectEntryByWorkspace(client, input.workspaceId, {
              forUpdate: true,
            });
            if (mine === undefined) {
              await insertEntry(client, { ...input, state: "reserved" });
              return "claimed" as const;
            }
            if (mine.state === "deleted") {
              // A released entry of the same workspace id (a restore after a release): revive it.
              await updateEntry(client, mine.entryId, {
                slug: input.slug,
                cellId: input.cellId,
                state: "reserved",
              });
              return "claimed" as const;
            }
            // Idempotent retry of the same claim.
            if (mine.slug === input.slug && mine.cellId === input.cellId) return "claimed" as const;
            // The workspace already holds another live entry: a claim is not a rename.
            return "taken" as const;
          });
        } catch (error) {
          if (isUniqueViolation(error, "workspace_slug_live_idx")) return "taken";
          // Two claims for the same workspace id raced; the loser re-reads.
          if (isUniqueViolation(error, "workspace_workspace_id_key")) {
            const mine = await selectEntryByWorkspace(pool, input.workspaceId);
            return mine !== undefined && mine.slug === input.slug && mine.cellId === input.cellId
              ? "claimed"
              : "taken";
          }
          if (isForeignKeyViolation(error)) throw cellNotPublished(input.cellId);
          throw error;
        }
      });
    },
    async activate(workspaceId) {
      if (!isUuid(workspaceId)) return;
      await write(() => activateEntry(pool, workspaceId));
    },
    async renameSlug(input) {
      if (!isUuid(input.workspaceId)) throw new Error("directory: workspaceId must be a uuid");
      return write(async () => {
        try {
          const renamed = await renameEntry(pool, input.workspaceId, input.to);
          if (renamed > 0) return "renamed";
          // No live entry (a workspace from before the directory, not swept yet): refuse a slug
          // that is live elsewhere; otherwise let the local write go ahead — the sweep creates
          // the entry with the new slug.
          return (await selectEntryBySlug(pool, input.to)) === undefined ? "renamed" : "taken";
        } catch (error) {
          if (isUniqueViolation(error, "workspace_slug_live_idx")) return "taken";
          throw error;
        }
      });
    },
    async release(workspaceId) {
      if (!isUuid(workspaceId)) return;
      await write(() => inTx(pool, (client) => releaseEntry(client, workspaceId)));
    },
    async setState(workspaceId, state) {
      if (!isUuid(workspaceId)) return;
      await write(() => setEntryState(pool, workspaceId, state));
    },
    async claimHost(input) {
      const hostname = directoryHostname(input.hostname);
      if (hostname === undefined) throw new Error("directory: not a hostname");
      if (!isUuid(input.workspaceId)) throw new Error("directory: workspaceId must be a uuid");
      return write(async () => {
        const entry = await selectEntryByWorkspace(pool, input.workspaceId);
        if (entry === undefined || entry.state === "deleted") {
          throw new ApiError(
            "directory_unavailable",
            "the workspace has no directory entry yet (the reconcile sweep repairs it)",
            { reason: "no_entry" },
          );
        }
        const holder = await claimHostname(pool, hostname, entry.entryId);
        return holder === entry.entryId ? "claimed" : "taken";
      });
    },
    async releaseHost(input) {
      const hostname = directoryHostname(input.hostname);
      if (hostname === undefined || !isUuid(input.workspaceId)) return;
      await write(() => releaseHostname(pool, hostname, input.workspaceId));
    },
    moves,
    async close() {
      listeners.clear();
      await dirDb.close();
    },

    onWrite(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ensureEntry(input) {
      await ensureCellOwned(input.cellId);
      const local = new Set(input.localCellIds);
      const displace = new Set(input.displace ?? []);
      const target = input.state ?? "active";
      /** R2-10: the local facts the sweep read are re-checked right before the write. */
      const confirmed = async () => (input.confirm === undefined ? true : input.confirm());
      /** R2-5: a live workspace takes the slug over from a local soft-deleted holder. */
      async function displaceHolder(client: Queryable): Promise<void> {
        const holder = await selectEntryBySlug(client, input.slug);
        if (
          holder !== undefined &&
          holder.workspaceId !== input.workspaceId &&
          displace.has(holder.workspaceId) &&
          local.has(holder.cellId)
        ) {
          await releaseEntryById(client, holder.entryId);
        }
      }
      const attempt = (withSlug: boolean) =>
        inTx(pool, async (client): Promise<EnsureEntryResult> => {
          const entry = await selectEntryByWorkspace(client, input.workspaceId, {
            forUpdate: true,
          });
          if (entry === undefined) {
            if (!withSlug) return "slug_taken";
            await displaceHolder(client);
            if (!(await confirmed())) return "stale";
            await insertEntry(client, { ...input, state: target });
            return "created";
          }
          // A released entry is never revived by the sweep (R2-10): a purge released it, or a
          // restore will claim it explicitly.
          if (entry.state === "deleted") return "released";
          if (!local.has(entry.cellId)) return "elsewhere";
          const set: { slug?: string; cellId?: string; state?: DirectoryEntryState } = {};
          if (withSlug && entry.slug !== input.slug) set.slug = input.slug;
          if (entry.cellId !== input.cellId) set.cellId = input.cellId;
          if (entry.state === "moving") {
            // A move that failed without putting the entry back.
            if (!(await hasLiveMove(client, entry.entryId))) set.state = target;
          } else if (entry.state !== target) {
            set.state = target;
          }
          if (Object.keys(set).length === 0) return withSlug ? "unchanged" : "slug_taken";
          if (set.slug !== undefined) await displaceHolder(client);
          if (!(await confirmed())) return "stale";
          await updateEntry(client, entry.entryId, set);
          return withSlug ? "repaired" : "slug_taken";
        });
      return write(async () => {
        try {
          return await attempt(true);
        } catch (error) {
          if (isUniqueViolation(error, "workspace_slug_live_idx")) return attempt(false);
          if (isForeignKeyViolation(error)) throw cellNotPublished(input.cellId);
          throw error;
        }
      });
    },
    async hostnamesOfCells(cellIds) {
      return selectHostnamesOfCells(pool, cellIds);
    },
    async releaseStaleReservations(input) {
      return write(() => releaseStaleReservations(pool, input));
    },
    async entriesOfCells(cellIds) {
      return selectEntriesOfCells(pool, cellIds);
    },
  };
}
