import {
  type Database,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  systemContext,
} from "@fundroom/db";
import type { ModuleManifest, SearchEntryInput } from "@fundroom/module-kit";
import type { JobDefinition, JobQueuePort, JsonObject } from "@fundroom/ports";
import { assertModuleId, isUuid, SearchEntryError, type SearchRow, toSearchRow } from "./entry.js";
import {
  reindexKey,
  SEARCH_REINDEX_JOB,
  SEARCH_SWEEP_JOB,
  UPSERT_BATCH_CHARS,
  UPSERT_BATCH_ROWS,
  writeRows,
} from "./index-service.js";
import {
  dbClock,
  deleteModuleEntries,
  deleteStaleEntries,
  deleteState,
  isWorkspaceLive,
  lockModuleIndex,
  readStates,
  writeState,
} from "./repos/search-repo.js";

/*
 * Full rebuilds (E2.8 contract §3 "Jobs"; redesigned by fix A so a rebuild never blocks writers).
 *
 *  - `search.reindex {workspaceId, module}` rebuilds one module's entries of one workspace in a
 *    series of SHORT system-context transactions, one connection at a time (the pool-deadlock
 *    rule: nothing opens a second connection while one is held):
 *      1. start: skip a deleted/purged workspace; take the module's index lock EXCLUSIVE; read
 *         `G = clock_timestamp()` (the rebuild's generation). Writers hold the lock SHARED until
 *         they commit, so every index write committed before G is visible to every page below.
 *      2. pages: per `manifest.search.page` call (or, for a provider with only `entries`, the
 *         whole stream in ONE transaction — fine for small modules, and the reason large ones
 *         implement `page`): lock EXCLUSIVE, read the page through that tx, upsert it
 *         (`indexed_at = clock_timestamp() > G`). No delete up front: entries stay searchable
 *         throughout, and a page's row locks last one page.
 *      3. end: lock EXCLUSIVE, delete the module's entries with `indexed_at < G` — rows neither
 *         a page nor a writer touched since G, i.e. what the provider no longer produces — and
 *         record `core.search_state` (version, indexed_at; `requested_at` cleared only if older
 *         than G).
 *    Ordering (why a stale page never overwrites a newer write): a page's source read and its
 *    upsert run under the exclusive lock, so a writer's index write lands either before the page
 *    started (committed — the page, reading in read-committed mode after taking the lock, sees
 *    the writer's source change too) or after the page committed (the writer waited for the lock
 *    and overwrites with its own, newer data). A writer's rows carry `indexed_at > G`, so step 3
 *    keeps them. Two rebuilds of one pair may interleave safely: each deletes only rows older
 *    than its own G, and every live row is re-stamped by the later one's pages.
 *    A module that no longer declares `search` (or is no longer compiled in) has its entries and
 *    state deleted. Modules a workspace switched off are indexed all the same — the query path
 *    filters by enablement, so switching a module back on needs no rebuild.
 *  - `search.sweep` (every 10 minutes) lists live workspaces in host context and, per workspace
 *    under `systemContext`, enqueues a rebuild of every searchable module whose state is missing,
 *    built at another version, or has `requested_at` set — plus a clean-up rebuild for state rows
 *    of modules that no longer index. Enqueued after the read transaction, deduplicated per
 *    (workspace, module) by the queue's `short` policy.
 */

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface SearchJobsDeps {
  readonly db: Database;
  /** The compiled-in manifests (read lazily: tests may swap the registry). */
  readonly modules: () => readonly ModuleManifest[];
  readonly queue: Pick<JobQueuePort, "send">;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

export interface ReindexResult {
  readonly status: "indexed" | "removed" | "skipped";
  readonly entries: number;
  /** Entries the provider yielded that failed validation (skipped and logged). */
  readonly invalid: number;
}

function isAsyncIterable<T>(v: unknown): v is AsyncIterable<T> {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in v;
}

/** Most pages one rebuild reads (a provider whose cursor never ends must not loop forever). */
const MAX_PAGES = 1_000_000;

/** Rebuilds (workspace, module) in short system-context transactions (see the header). */
export async function reindexWorkspaceModule(
  deps: Pick<SearchJobsDeps, "db" | "modules" | "now" | "log">,
  workspaceId: string,
  module: string,
): Promise<ReindexResult> {
  if (!isUuid(workspaceId))
    throw new Error(`search.reindex: workspaceId ${workspaceId} is not a uuid`);
  assertModuleId(module);
  const manifest = deps.modules().find((m) => m.id === module);
  const search = manifest?.search;
  const ctx = systemContext(workspaceId);
  const db = deps.db;

  // 1. Start (or, for a module that no longer indexes, the whole clean-up).
  const start = await db.withTenant(ctx, async (tx) => {
    if (!(await isWorkspaceLive(tx, workspaceId))) return { skip: true as const };
    await lockModuleIndex(tx, workspaceId, module);
    if (search === undefined) {
      await deleteModuleEntries(tx, workspaceId, module);
      await deleteState(tx, workspaceId, module);
      return { removed: true as const };
    }
    return { generation: await dbClock(tx) };
  });
  if ("skip" in start)
    return log(deps, workspaceId, module, { status: "skipped", entries: 0, invalid: 0 });
  if ("removed" in start || search === undefined)
    return log(deps, workspaceId, module, { status: "removed", entries: 0, invalid: 0 });
  const generation = start.generation;

  let total = 0;
  let invalid = 0;
  const validRows = (entries: Iterable<SearchEntryInput>): SearchRow[] => {
    const rows: SearchRow[] = [];
    for (const e of entries) {
      try {
        rows.push(toSearchRow(module, e));
      } catch (error) {
        // One malformed entry must not keep the whole module out of the index (a throw here would
        // roll back, retry, dead-letter, and be re-enqueued by every sweep). Logged, skipped.
        if (!(error instanceof SearchEntryError)) throw error;
        invalid += 1;
        if (invalid <= 5)
          deps.log?.("search.entry_invalid", { workspaceId, module, error: error.message });
      }
    }
    return rows;
  };

  // 2. Pages.
  if (search.page !== undefined) {
    const page = search.page.bind(search);
    let cursor: string | null = null;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      const at: string | null = cursor;
      const next: string | null = await db.withTenant(ctx, async (tx) => {
        await lockModuleIndex(tx, workspaceId, module);
        const got = await page({ tx, ctx, cursor: at });
        total += await writeRows(tx, workspaceId, validRows(got.entries));
        return got.next;
      });
      if (next === null) break;
      if (next === at) throw new Error(`search.reindex(${module}): page cursor did not advance`);
      cursor = next;
    }
  } else {
    await db.withTenant(ctx, async (tx) => {
      await lockModuleIndex(tx, workspaceId, module);
      const produced = search.entries({ tx, ctx });
      let batch: SearchEntryInput[] = [];
      let chars = 0;
      const flush = async () => {
        total += await writeRows(tx, workspaceId, validRows(batch));
        batch = [];
        chars = 0;
      };
      const take = async (e: SearchEntryInput) => {
        batch.push(e);
        chars += typeof e?.body === "string" ? e.body.length : 0;
        if (batch.length >= UPSERT_BATCH_ROWS || chars >= UPSERT_BATCH_CHARS) await flush();
      };
      if (isAsyncIterable<SearchEntryInput>(produced)) {
        for await (const e of produced) await take(e);
      } else {
        for (const e of await produced) await take(e);
      }
      await flush();
    });
  }

  // 3. End: drop what nobody re-stamped since the start, record the state.
  await db.withTenant(ctx, async (tx) => {
    await lockModuleIndex(tx, workspaceId, module);
    await deleteStaleEntries(tx, workspaceId, module, generation);
    await writeState(tx, workspaceId, module, search.version, generation);
  });
  return log(deps, workspaceId, module, { status: "indexed", entries: total, invalid });
}

function log(
  deps: Pick<SearchJobsDeps, "log">,
  workspaceId: string,
  module: string,
  result: ReindexResult,
): ReindexResult {
  deps.log?.("search.reindexed", { workspaceId, module, ...result });
  return result;
}

export interface SweepResult {
  readonly workspaces: number;
  readonly enqueued: readonly { readonly workspaceId: string; readonly module: string }[];
}

/** One sweep pass: enqueues a rebuild of every stale (workspace, module) pair. */
export async function sweepSearchIndex(deps: SearchJobsDeps): Promise<SweepResult> {
  const searchable = deps.modules().filter((m) => m.search !== undefined);
  const ids = (await listLiveWorkspaceIds(deps.db)).filter((id) => !isPlatformWorkspace(id));
  const enqueued: { workspaceId: string; module: string }[] = [];
  for (const workspaceId of ids) {
    const ctx = systemContext(workspaceId);
    const stale = await deps.db.withTenant(ctx, async (tx) => {
      const states = new Map((await readStates(tx, workspaceId)).map((s) => [s.module, s]));
      const out: string[] = [];
      for (const m of searchable) {
        const st = states.get(m.id);
        if (st === undefined || st.version !== m.search?.version || st.requestedAt !== null)
          out.push(m.id);
        states.delete(m.id);
      }
      // State left over from a module that no longer indexes: a rebuild removes its entries.
      out.push(...states.keys());
      return out;
    });
    // Sent after the read transaction closed: the queue takes its own connection.
    for (const module of stale) {
      await deps.queue.send(
        SEARCH_REINDEX_JOB,
        { workspaceId, module },
        { idempotencyKey: reindexKey(workspaceId, module) },
      );
      enqueued.push({ workspaceId, module });
    }
  }
  deps.log?.("search.sweep_run", { workspaces: ids.length, enqueued: enqueued.length });
  return { workspaces: ids.length, enqueued };
}

/** The two kernel jobs, for `container.ts`'s `jobs`. */
export function createSearchJobs(deps: SearchJobsDeps): JobDefinition<JsonObject>[] {
  return [
    {
      name: SEARCH_REINDEX_JOB,
      // At most one *queued* rebuild per (workspace, module); one may run while another waits.
      queue: { policy: "short", retryLimit: 3, expireInSeconds: 30 * 60 },
      work: { concurrency: 2 },
      handler: async (job) => {
        const { workspaceId, module } = job.data;
        if (typeof workspaceId !== "string" || typeof module !== "string")
          throw new Error("search.reindex: payload must be { workspaceId, module }");
        await reindexWorkspaceModule(deps, workspaceId, module);
      },
    },
    {
      name: SEARCH_SWEEP_JOB,
      cron: "*/10 * * * *",
      handler: async () => {
        await sweepSearchIndex(deps);
      },
    },
  ];
}
