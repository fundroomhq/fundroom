import { lockWorkspaceRow, type TenantContext, type Tx } from "@fundroom/db";
import type { SearchEntryInput, SearchIndexService } from "@fundroom/module-kit";
import type { JobQueuePort } from "@fundroom/ports";
import {
  assertKind,
  assertModuleId,
  assertRefId,
  normalizePart,
  rowKey,
  SearchEntryError,
  type SearchRow,
  toSearchRow,
} from "./entry.js";
import {
  clearBodies,
  deleteRef,
  lockModuleIndexShared,
  markReindexRequested,
  moveAclPath,
  upsertRows,
} from "./repos/search-repo.js";

/** The kernel job that rebuilds one (workspace, module); payload `{ workspaceId, module }`. */
export const SEARCH_REINDEX_JOB = "search.reindex";
/** The 10-minute cron that enqueues stale (workspace, module) pairs. */
export const SEARCH_SWEEP_JOB = "search.sweep";

/** Rows per INSERT statement, and the body characters after which a batch is flushed early. */
export const UPSERT_BATCH_ROWS = 200;
export const UPSERT_BATCH_CHARS = 2_000_000;
/** Ref ids per `clearBodies` statement. */
const CLEAR_BATCH = 1_000;

/** Dedupe key of a queued reindex: at most one queued job per (workspace, module). */
export function reindexKey(workspaceId: string, module: string): string {
  return `search:${workspaceId}:${module}`;
}

export interface SearchIndexDeps {
  readonly queue: Pick<JobQueuePort, "sendInTransaction">;
  /**
   * Unused since fix A: `indexed_at` and `requested_at` come from the database clock, which a
   * rebuild compares them with. Kept so existing callers compile.
   */
  readonly now?: (() => Date) | undefined;
}

// An ltree path: dot-separated labels of letters, digits and underscores (as `entry.ts`).
const LTREE_RE = /^[A-Za-z0-9_]{1,256}(\.[A-Za-z0-9_]{1,256}){0,63}$/u;

function assertWriter(ctx: TenantContext, op: string): void {
  if (ctx.viewAs !== undefined)
    throw new SearchEntryError(`search.${op}: refused while viewing as an investor (read only)`);
  if (ctx.actorKind !== "staff" && ctx.actorKind !== "system")
    throw new SearchEntryError(
      `search.${op}: needs a staff or system context (got ${ctx.actorKind}); index from a job or subscriber under systemContext(workspaceId) when an investor's action changes searchable text`,
    );
}

/**
 * Writes `rows` in batches of at most `UPSERT_BATCH_ROWS` rows / `UPSERT_BATCH_CHARS` body
 * characters. Duplicate keys within the call collapse to the last one (an INSERT … ON CONFLICT
 * may not touch one row twice).
 */
export async function writeRows(
  tx: Tx,
  workspaceId: string,
  rows: Iterable<SearchRow>,
): Promise<number> {
  const unique = new Map<string, SearchRow>();
  for (const r of rows) {
    unique.delete(rowKey(r));
    unique.set(rowKey(r), r);
  }
  let batch: SearchRow[] = [];
  let chars = 0;
  for (const r of unique.values()) {
    batch.push(r);
    chars += r.body.length;
    if (batch.length >= UPSERT_BATCH_ROWS || chars >= UPSERT_BATCH_CHARS) {
      await upsertRows(tx, workspaceId, batch);
      batch = [];
      chars = 0;
    }
  }
  if (batch.length > 0) await upsertRows(tx, workspaceId, batch);
  return unique.size;
}

/**
 * `ModuleServices.search` (E2.8): writes `core.search_entry` on the **caller's** transaction, so
 * an entry commits or rolls back with the change that produced it. Never opens a connection of
 * its own. Needs a staff or system context — RLS gives investors read access only. Every write
 * first takes the module's index lock SHARED (held to the caller's commit): writers never wait
 * for each other, only — for at most one page — for a running full rebuild (see reindex.ts).
 *
 * And before that, the workspace row (`lockWorkspaceRow`, E3.5 LX): the global order is
 * workspace row → search index lock / entries → audit chain → outbox. A settings writer holds the
 * row and then writes entries (the data-room PATCH clears unscanned text and Q&A entries); a
 * document rename or trash writes entries and then audits, which takes the row — so without the
 * row first here those two deadlock. The rebuild (`reindex.ts`) writes through `writeRows`
 * under its exclusive index lock and never takes the row, so it cannot close a cycle with it.
 */
async function lockForWrite(tx: Tx, workspaceId: string, module: string): Promise<void> {
  await lockWorkspaceRow(tx, workspaceId);
  await lockModuleIndexShared(tx, workspaceId, module);
}

export class SearchIndex implements SearchIndexService {
  constructor(readonly deps: SearchIndexDeps) {}

  /** Inserts or replaces each entry (keyed by module, kind, refId, part). Other parts are untouched. */
  async upsert(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    entries: readonly SearchEntryInput[],
  ): Promise<void> {
    assertWriter(ctx, "upsert");
    const rows = entries.map((e) => toSearchRow(module, e));
    if (rows.length === 0) return;
    await lockForWrite(tx, ctx.workspaceId, module);
    await writeRows(tx, ctx.workspaceId, rows);
  }

  /**
   * Deletes every part of (module, kind, refId), then inserts `entries` — all of which must be
   * that same kind and refId. An empty `entries` is a remove.
   */
  async replace(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    kind: string,
    refId: string,
    entries: readonly SearchEntryInput[],
  ): Promise<void> {
    assertWriter(ctx, "replace");
    assertModuleId(module);
    assertKind(module, kind);
    assertRefId(module, refId);
    const rows = entries.map((e) => toSearchRow(module, e));
    const ref = refId.toLowerCase();
    for (const r of rows) {
      if (r.kind !== kind || r.refId !== ref)
        throw new SearchEntryError(
          `search(${module}).replace(${kind}/${refId}): entry ${r.kind}/${r.refId} belongs to another ref`,
        );
    }
    await lockForWrite(tx, ctx.workspaceId, module);
    await deleteRef(tx, ctx.workspaceId, module, kind, ref);
    await writeRows(tx, ctx.workspaceId, rows);
  }

  /** Deletes one ref: every part when `ref.part` is undefined, else only that part. Idempotent. */
  async remove(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    ref: { readonly kind: string; readonly refId: string; readonly part?: string | undefined },
  ): Promise<void> {
    assertWriter(ctx, "remove");
    assertModuleId(module);
    assertKind(module, ref.kind);
    assertRefId(module, ref.refId);
    const part = ref.part === undefined ? undefined : normalizePart(module, ref.part);
    await lockForWrite(tx, ctx.workspaceId, module);
    await deleteRef(tx, ctx.workspaceId, module, ref.kind, ref.refId.toLowerCase(), part);
  }

  /**
   * Re-paths the module's `resource` entries at or under `from` to sit under `to`, in one SQL
   * statement (no body read). For subtree moves; the path changes in the caller's transaction.
   */
  async moveAclPath(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    from: string,
    to: string,
  ): Promise<number> {
    assertWriter(ctx, "moveAclPath");
    assertModuleId(module);
    for (const p of [from, to])
      if (typeof p !== "string" || !LTREE_RE.test(p))
        throw new SearchEntryError(
          `search(${module}).moveAclPath: ${JSON.stringify(p)} is not an ltree path`,
        );
    if (from === to) return 0;
    await lockForWrite(tx, ctx.workspaceId, module);
    return moveAclPath(tx, ctx.workspaceId, module, from, to);
  }

  /** Empties the body of every part of `refIds` (title and ACL untouched). */
  async clearBodies(
    tx: Tx,
    ctx: TenantContext,
    module: string,
    kind: string,
    refIds: readonly string[],
  ): Promise<number> {
    assertWriter(ctx, "clearBodies");
    assertModuleId(module);
    assertKind(module, kind);
    for (const id of refIds) assertRefId(module, id);
    if (refIds.length === 0) return 0;
    await lockForWrite(tx, ctx.workspaceId, module);
    let n = 0;
    const ids = [...new Set(refIds.map((id) => id.toLowerCase()))];
    for (let i = 0; i < ids.length; i += CLEAR_BATCH)
      n += await clearBodies(tx, ctx.workspaceId, module, kind, ids.slice(i, i + CLEAR_BATCH));
    return n;
  }

  /**
   * Marks the module's index of this workspace stale (`search_state.requested_at`) and enqueues
   * `search.reindex` in the same transaction. Both roll back with the caller. The queue dedupes on
   * (workspace, module), so a burst of calls costs one rebuild.
   */
  async requestReindex(tx: Tx, ctx: TenantContext, module: string): Promise<void> {
    assertWriter(ctx, "requestReindex");
    assertModuleId(module);
    // Shared lock first: a request stamped before a rebuild's start is then also committed before
    // it, which is what lets the rebuild clear it (search-repo `writeState`).
    await lockForWrite(tx, ctx.workspaceId, module);
    await markReindexRequested(tx, ctx.workspaceId, module);
    await this.deps.queue.sendInTransaction(
      tx,
      SEARCH_REINDEX_JOB,
      { workspaceId: ctx.workspaceId, module },
      { idempotencyKey: reindexKey(ctx.workspaceId, module) },
    );
  }
}

export function createSearchIndex(deps: SearchIndexDeps): SearchIndex {
  return new SearchIndex(deps);
}
