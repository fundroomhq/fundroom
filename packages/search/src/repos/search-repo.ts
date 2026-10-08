import type { Tx } from "@fundroom/db";
import { type SQL, sql } from "drizzle-orm";
import type { SearchRow } from "../entry.js";
import type { SearchQueries } from "../text.js";

/*
 * Every statement `@fundroom/search` runs against `core.search_entry` / `core.search_state`
 * (the only file in the package that may import drizzle — dependency-cruiser
 * `only-repos-touch-drizzle`). All of it runs on a transaction the caller opened under a tenant
 * context, so RLS (tenant fence + the actor-kind policies of migration 0013) applies to every
 * read and write; the explicit `workspace_id` predicates are belt and braces, and what lets the
 * planner use the unique index.
 *
 * Arrays are bound as Postgres array literals (`'{a,b}'::text[]`) because drizzle expands a JS
 * array parameter into a comma list. Every element is validated upstream to a shape that needs
 * no quoting (uuid, kebab-case module id, `[a-z0-9_-]` kind).
 */

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;
/** Raw `tx.execute` returns timestamptz as text. */
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const arrayLiteral = (items: readonly string[]): string => `{${items.join(",")}}`;

function valuesOf(workspaceId: string, r: SearchRow): SQL {
  return sql`(${workspaceId}::uuid, ${r.module}, ${r.kind}, ${r.refId}::uuid, ${r.part}, ${r.title}, ${r.body}, ${r.href}, ${r.aclKind},
    ${r.aclGroups === null ? null : arrayLiteral(r.aclGroups)}::uuid[], ${r.aclResourceKind}, ${r.aclResourceId}::uuid,
    ${r.aclPath}::ltree, ${r.sourceUpdatedAt.toISOString()}::timestamptz, clock_timestamp())`;
}

/**
 * Inserts or replaces `rows` (keys must be unique within the call — the caller dedupes), keyed on
 * `search_entry_ref_idx` (workspace_id, module, kind, ref_id, part). `indexed_at` is the
 * database's `clock_timestamp()`, never an app clock: a full rebuild deletes the rows it did not
 * touch by comparing `indexed_at` with its own start, read from the same clock (see reindex.ts).
 */
export async function upsertRows(
  tx: Tx,
  workspaceId: string,
  rows: readonly SearchRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO core.search_entry
      (workspace_id, module, kind, ref_id, part, title, body, href, acl_kind, acl_groups,
       acl_resource_kind, acl_resource_id, acl_path, source_updated_at, indexed_at)
    VALUES ${sql.join(
      rows.map((r) => valuesOf(workspaceId, r)),
      sql`, `,
    )}
    ON CONFLICT (workspace_id, module, kind, ref_id, part) DO UPDATE SET
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      href = EXCLUDED.href,
      acl_kind = EXCLUDED.acl_kind,
      acl_groups = EXCLUDED.acl_groups,
      acl_resource_kind = EXCLUDED.acl_resource_kind,
      acl_resource_id = EXCLUDED.acl_resource_id,
      acl_path = EXCLUDED.acl_path,
      source_updated_at = EXCLUDED.source_updated_at,
      indexed_at = EXCLUDED.indexed_at`);
}

/** Deletes one ref's entries: every part, or only `part` when given. Returns rows deleted. */
export async function deleteRef(
  tx: Tx,
  workspaceId: string,
  module: string,
  kind: string,
  refId: string,
  part?: string | undefined,
): Promise<number> {
  const r = await tx.execute(sql`
    DELETE FROM core.search_entry
     WHERE workspace_id = ${workspaceId}::uuid AND module = ${module} AND kind = ${kind}
       AND ref_id = ${refId}::uuid ${part === undefined ? sql`` : sql`AND part = ${part}`}`);
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/** Deletes every entry of one module in the workspace (a module that no longer indexes). */
export async function deleteModuleEntries(
  tx: Tx,
  workspaceId: string,
  module: string,
): Promise<number> {
  const r = await tx.execute(sql`
    DELETE FROM core.search_entry WHERE workspace_id = ${workspaceId}::uuid AND module = ${module}`);
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * The end of a full rebuild: deletes the module's entries that neither the rebuild nor any
 * writer touched since `since` (the rebuild's start, a `clock_timestamp()` text read under the
 * module's exclusive lock). Returns rows deleted.
 */
export async function deleteStaleEntries(
  tx: Tx,
  workspaceId: string,
  module: string,
  since: string,
): Promise<number> {
  const r = await tx.execute(sql`
    DELETE FROM core.search_entry
     WHERE workspace_id = ${workspaceId}::uuid AND module = ${module}
       AND indexed_at < ${since}::timestamptz`);
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * Re-paths the module's `resource` entries at or under `from` to the same place under `to`, in
 * SQL (no body read). `indexed_at` is left alone: the rows are not re-derived.
 */
export async function moveAclPath(
  tx: Tx,
  workspaceId: string,
  module: string,
  from: string,
  to: string,
): Promise<number> {
  const r = await tx.execute(sql`
    UPDATE core.search_entry SET acl_path =
        CASE WHEN nlevel(acl_path) = nlevel(${from}::ltree) THEN ${to}::ltree
             ELSE ${to}::ltree || subpath(acl_path, nlevel(${from}::ltree)) END
     WHERE workspace_id = ${workspaceId}::uuid AND module = ${module}
       AND acl_kind = 'resource' AND acl_path <@ ${from}::ltree`);
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/** Empties the body of every part of `refIds` (uuids, validated upstream). */
export async function clearBodies(
  tx: Tx,
  workspaceId: string,
  module: string,
  kind: string,
  refIds: readonly string[],
): Promise<number> {
  if (refIds.length === 0) return 0;
  const r = await tx.execute(sql`
    UPDATE core.search_entry SET body = ''
     WHERE workspace_id = ${workspaceId}::uuid AND module = ${module} AND kind = ${kind}
       AND ref_id = ANY(${arrayLiteral(refIds)}::uuid[]) AND body <> ''`);
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

/**
 * Workspace purge (E2.7 lifecycle): drops the workspace's whole index and its reindex state.
 * Search text is derived from content the purge makes unreadable, so it must not outlive it.
 */
export async function deleteWorkspaceSearch(
  tx: Tx,
  workspaceId: string,
): Promise<{ entries: number; states: number }> {
  const e = await tx.execute(
    sql`DELETE FROM core.search_entry WHERE workspace_id = ${workspaceId}::uuid`,
  );
  const s = await tx.execute(
    sql`DELETE FROM core.search_state WHERE workspace_id = ${workspaceId}::uuid`,
  );
  return {
    entries: (e as { rowCount?: number | null }).rowCount ?? 0,
    states: (s as { rowCount?: number | null }).rowCount ?? 0,
  };
}

/**
 * Stamps `requested_at` with the database clock (creating the state row at version 0 — "never
 * built" — if missing), keeping the LATEST request: a rebuild clears `requested_at` only when it
 * is older than the rebuild's start, so the newest request is the one that must survive. The
 * caller holds the module's shared index lock, so a request stamped before a rebuild's start
 * was also committed before it (see reindex.ts).
 */
export async function markReindexRequested(
  tx: Tx,
  workspaceId: string,
  module: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.search_state (workspace_id, module, version, indexed_at, requested_at)
    VALUES (${workspaceId}::uuid, ${module}, 0, clock_timestamp(), clock_timestamp())
    ON CONFLICT (workspace_id, module) DO UPDATE SET
      requested_at = GREATEST(core.search_state.requested_at, EXCLUDED.requested_at)`);
}

export interface SearchStateRow {
  readonly module: string;
  readonly version: number;
  readonly indexedAt: Date;
  readonly requestedAt: Date | null;
}

export async function readStates(tx: Tx, workspaceId: string): Promise<SearchStateRow[]> {
  const rows = rowsOf<{
    module: string;
    version: number;
    indexed_at: unknown;
    requested_at: unknown;
  }>(
    await tx.execute(sql`
      SELECT module, version, indexed_at, requested_at FROM core.search_state
       WHERE workspace_id = ${workspaceId}::uuid ORDER BY module`),
  );
  return rows.map((r) => ({
    module: r.module,
    version: Number(r.version),
    indexedAt: asDate(r.indexed_at),
    requestedAt: r.requested_at === null ? null : asDate(r.requested_at),
  }));
}

/**
 * Records a finished rebuild. `requested_at` is cleared only when the (latest) request predates
 * `startedAt`, the rebuild's start: such a request committed before any page was read, so the
 * rebuild covered it. A request stamped after the start stays outstanding and the next sweep
 * rebuilds again.
 */
export async function writeState(
  tx: Tx,
  workspaceId: string,
  module: string,
  version: number,
  startedAt: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.search_state (workspace_id, module, version, indexed_at, requested_at)
    VALUES (${workspaceId}::uuid, ${module}, ${version}::int, clock_timestamp(), NULL)
    ON CONFLICT (workspace_id, module) DO UPDATE SET
      version = EXCLUDED.version,
      indexed_at = EXCLUDED.indexed_at,
      requested_at = CASE
        WHEN core.search_state.requested_at >= ${startedAt}::timestamptz
          THEN core.search_state.requested_at
        ELSE NULL END`);
}

/** The database clock as text (full microsecond precision; compared back as `::timestamptz`). */
export async function dbClock(tx: Tx): Promise<string> {
  const rows = rowsOf<{ t: string }>(await tx.execute(sql`SELECT clock_timestamp()::text AS t`));
  const t = rows[0]?.t;
  if (t === undefined) throw new Error("search: clock_timestamp() returned nothing");
  return t;
}

export async function deleteState(tx: Tx, workspaceId: string, module: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM core.search_state WHERE workspace_id = ${workspaceId}::uuid AND module = ${module}`);
}

/** Whether the workspace exists and is not soft-deleted (or purged). */
export async function isWorkspaceLive(tx: Tx, workspaceId: string): Promise<boolean> {
  const rows = rowsOf<{ live: boolean }>(
    await tx.execute(sql`
      SELECT (deleted_at IS NULL AND purged_at IS NULL) AS live
        FROM core.workspace WHERE id = ${workspaceId}::uuid`),
  );
  return rows[0]?.live === true;
}

const indexLockKey = (workspaceId: string, module: string) =>
  sql`hashtextextended(${`search:${workspaceId}:${module}`}, 0)`;

/**
 * The per-(workspace, module) index lock, transaction-scoped. Every incremental write (upsert,
 * replace, remove, re-path, body clear, reindex request) takes it SHARED — writers never wait for
 * each other — and every short transaction of a full rebuild (its start, each page, its end)
 * takes it EXCLUSIVE. So a rebuild page's read of the source and its write of the index are
 * atomic with respect to writers: a writer that indexed before the page waits for nothing and
 * the page (read committed, reading after the lock) sees its committed source; a writer that
 * indexes after the page waits at most one page and then overwrites with its newer data.
 */
export async function lockModuleIndex(tx: Tx, workspaceId: string, module: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${indexLockKey(workspaceId, module)})`);
}

export async function lockModuleIndexShared(
  tx: Tx,
  workspaceId: string,
  module: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${indexLockKey(workspaceId, module)})`);
}

export interface CandidateRow {
  readonly id: string;
  readonly module: string;
  readonly kind: string;
  readonly refId: string;
  readonly title: string;
  readonly href: string;
  readonly sourceUpdatedAt: Date;
  readonly aclKind: string;
  readonly aclResourceKind: string | null;
  readonly aclResourceId: string | null;
  readonly aclPath: string | null;
  /**
   * 0 = full-text hit, 1 = title fallback (trigram, or CJK substring). In `titleCandidates` both
   * are computed from the title alone.
   */
  readonly tier: 0 | 1;
  /** `ts_rank_cd(…, 32)` for tier 0, `word_similarity` for tier 1 (higher first). */
  readonly score: number;
}

export interface CandidateQuery {
  readonly workspaceId: string;
  readonly queries: SearchQueries;
  readonly modules: readonly string[];
  readonly kinds?: readonly string[] | undefined;
  readonly limit: number;
  /** `word_similarity` floor of the title fallback. */
  readonly trigramThreshold: number;
  /** Run the trigram title fallback at all (short queries match everything). */
  readonly trigram: boolean;
  /**
   * `"<resourceKind>:<resourceId>"` of `resource` rows to leave out (the engine's resources the
   * caller may not open in full), so they take no place under `limit`.
   */
  readonly excludeResources?: readonly string[] | undefined;
}

type RawCandidate = {
  id: string;
  module: string;
  kind: string;
  ref_id: string;
  title: string;
  href: string;
  source_updated_at: unknown;
  acl_kind: string;
  acl_resource_kind: string | null;
  acl_resource_id: string | null;
  acl_path: string | null;
  tier: number;
  score: number | string;
};

const toCandidate = (r: RawCandidate): CandidateRow => ({
  id: r.id,
  module: r.module,
  kind: r.kind,
  refId: r.ref_id,
  title: r.title,
  href: r.href,
  sourceUpdatedAt: asDate(r.source_updated_at),
  aclKind: r.acl_kind,
  aclResourceKind: r.acl_resource_kind,
  aclResourceId: r.acl_resource_id,
  aclPath: r.acl_path,
  tier: Number(r.tier) === 1 ? 1 : 0,
  score: Number(r.score),
});

const CANDIDATE_COLUMNS = sql`e.id, e.module, e.kind, e.ref_id, e.title, e.href, e.source_updated_at, e.acl_kind,
             e.acl_resource_kind, e.acl_resource_id, e.acl_path::text AS acl_path`;

/** `LIKE` pattern matching `text` anywhere (`\\` is the default escape). */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

function filters(q: CandidateQuery): { where: SQL; fallback: SQL } {
  const kindFilter =
    q.kinds === undefined || q.kinds.length === 0
      ? sql``
      : sql`AND e.kind = ANY(${arrayLiteral(q.kinds)}::text[])`;
  const exclude =
    q.excludeResources === undefined || q.excludeResources.length === 0
      ? sql``
      : sql`AND NOT (e.acl_kind = 'resource'
              AND (e.acl_resource_kind || ':' || e.acl_resource_id::text) = ANY(${arrayLiteral(q.excludeResources)}::text[]))`;
  const where = sql`e.workspace_id = ${q.workspaceId}::uuid
           AND e.module = ANY(${arrayLiteral(q.modules)}::text[]) ${kindFilter} ${exclude}`;
  // The title fallback: trigram word similarity, plus — for CJK/Thai, which `simple` cannot split
  // into words — the query as a title substring.
  const parts: SQL[] = [];
  if (q.trigram) parts.push(sql`${q.queries.plain} <% e.title`);
  if (q.queries.unspaced) parts.push(sql`e.title ILIKE ${containsPattern(q.queries.plain)}`);
  const fallback = parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` OR `)})`;
  return { where, fallback };
}

async function setTrigramThreshold(tx: Tx, q: CandidateQuery): Promise<void> {
  // `<%` uses the trigram GIN index; its threshold is a GUC, set for this transaction only.
  if (q.trigram)
    await tx.execute(
      sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(q.trigramThreshold)}, true)`,
    );
}

/**
 * Ranked candidates by the WHOLE entry (title and body): full-text hits (`ts_rank_cd(tsv, q, 32)`
 * then recency) followed by title-fallback matches that are not already hits. Every part is a
 * row; the caller dedupes per (module, kind, ref) after the ACL post-filter. No body is read here.
 * Only rows the caller may open in full may be taken from this list (see `titleCandidates`).
 */
export async function searchCandidates(tx: Tx, q: CandidateQuery): Promise<CandidateRow[]> {
  if (q.modules.length === 0) return [];
  await setTrigramThreshold(tx, q);
  const { where, fallback } = filters(q);
  const rows = rowsOf<RawCandidate>(
    await tx.execute(sql`
      WITH qq AS (SELECT ${q.queries.all}::tsquery AS q)
      SELECT * FROM (
        SELECT ${CANDIDATE_COLUMNS}, 0 AS tier, ts_rank_cd(e.tsv, qq.q, 32)::float8 AS score
          FROM core.search_entry e, qq
         WHERE ${where} AND e.tsv @@ qq.q
        UNION ALL
        SELECT ${CANDIDATE_COLUMNS}, 1 AS tier,
               word_similarity(${q.queries.plain}, e.title)::float8 AS score
          FROM core.search_entry e, qq
         WHERE ${where} AND ${fallback} AND NOT (e.tsv @@ qq.q)
      ) c
      ORDER BY tier, score DESC, source_updated_at DESC, id
      LIMIT ${q.limit}::int`),
  );
  return rows.map(toCandidate);
}

/**
 * Ranked `resource` candidates by the TITLE ALONE — the only list a gated hit may come from, so
 * nothing about a gated entry's body can change whether it is returned, where, or what else is:
 * title full-text hits (`tsv @@ q` restricted to weight A, i.e. the title's lexemes; ranked by
 * `ts_rank_cd` over the title's own vector) then title-fallback matches that are not.
 */
export async function titleCandidates(tx: Tx, q: CandidateQuery): Promise<CandidateRow[]> {
  if (q.modules.length === 0) return [];
  await setTrigramThreshold(tx, q);
  const { where, fallback } = filters(q);
  const rows = rowsOf<RawCandidate>(
    await tx.execute(sql`
      WITH qq AS (SELECT ${q.queries.all}::tsquery AS q, ${q.queries.title}::tsquery AS tq)
      SELECT * FROM (
        SELECT ${CANDIDATE_COLUMNS}, 0 AS tier,
               ts_rank_cd(setweight(to_tsvector('simple'::regconfig, e.title), 'A'), qq.q, 32)::float8 AS score
          FROM core.search_entry e, qq
         WHERE ${where} AND e.acl_kind = 'resource' AND e.tsv @@ qq.tq
        UNION ALL
        SELECT ${CANDIDATE_COLUMNS}, 1 AS tier,
               word_similarity(${q.queries.plain}, e.title)::float8 AS score
          FROM core.search_entry e, qq
         WHERE ${where} AND e.acl_kind = 'resource' AND ${fallback} AND NOT (e.tsv @@ qq.tq)
      ) c
      ORDER BY tier, score DESC, source_updated_at DESC, id
      LIMIT ${q.limit}::int`),
  );
  return rows.map(toCandidate);
}

/**
 * The lexemes Postgres's `simple` configuration makes of each query word — the same parser and
 * dictionary that built `tsv` — in word order. `words` is bound as one jsonb parameter.
 */
export async function queryLexemes(tx: Tx, words: readonly string[]): Promise<string[][]> {
  if (words.length === 0) return [];
  const rows = rowsOf<{ ord: number | string; lexeme: string }>(
    await tx.execute(sql`
      SELECT w.ord, t.lexeme
        FROM jsonb_array_elements_text(${JSON.stringify(words)}::jsonb) WITH ORDINALITY AS w(word, ord),
             LATERAL unnest(to_tsvector('simple'::regconfig, w.word)) AS t
       ORDER BY w.ord, t.lexeme`),
  );
  const groups: string[][] = words.map(() => []);
  for (const r of rows) groups[Number(r.ord) - 1]?.push(r.lexeme);
  return groups;
}

/**
 * `ts_headline` fragments for the entries in `ids` whose body contains any query word; entries
 * without a body match are absent from the result. `options` carries the control-character
 * StartSel/StopSel (bound as a parameter, never spliced).
 */
export async function headlines(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  queries: SearchQueries,
  options: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<{ id: string; h: string }>(
    await tx.execute(sql`
      SELECT e.id, ts_headline('simple', e.body, ${queries.all}::tsquery, ${options}) AS h
        FROM core.search_entry e
       WHERE e.workspace_id = ${workspaceId}::uuid
         AND e.id = ANY(${arrayLiteral(ids)}::uuid[])
         AND e.tsv @@ ${queries.bodyAny}::tsquery`),
  );
  return new Map(rows.map((r) => [r.id, r.h]));
}
