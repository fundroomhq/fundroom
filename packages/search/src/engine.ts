import type { Database, TenantContext } from "@fundroom/db";
import type { AccessDecision, AuthzPrincipal, RequestFacts, ResourceRef } from "@fundroom/ports";
import {
  type CandidateQuery,
  type CandidateRow,
  headlines,
  queryLexemes,
  searchCandidates,
  titleCandidates,
} from "./repos/search-repo.js";
import {
  buildQueries,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  queryWords,
  type SnippetSegment,
  splitHeadline,
} from "./text.js";

/*
 * The query engine behind `GET /api/v1/search` (E2.8 contract §3; hardened by fix A).
 *
 *  1. Split the query on whitespace; each word goes through Postgres's own parser
 *     (`to_tsvector('simple', word)`, a bound parameter) — the one that built the index — and the
 *     tsquery is assembled from the resulting lexemes, each a quoted operand cast with
 *     `::tsquery` (never re-parsed): lexemes AND-ed, the last word's as prefixes. Nothing the
 *     caller types is ever read as tsquery syntax, and `john.doe@acme.com` or `Q3-2025` match as
 *     typed.
 *  2. One read transaction under the caller's own tenant context — RLS admits only the entries
 *     their ACL allows (members / live group membership / `core.has_access` grants; staff all) —
 *     collects two ranked candidate lists, without bodies:
 *       a. by the WHOLE entry: full-text hits by `ts_rank_cd(tsv, q, 32)` then recency, then
 *          title-fallback matches (trigram `word_similarity ≥ 0.4`; CJK substring) that were not
 *          hits. Only hits the caller may open in full are taken from this list.
 *       b. (external callers only) `resource` entries by the TITLE ALONE: title full-text hits
 *          ranked by the title's own `ts_rank_cd`, then title-fallback matches. Gated hits come
 *          ONLY from here.
 *  3. With no transaction held (the authz service reads through its own connection), external
 *     callers' `resource` rows are re-checked with `authz.check(…, "view", requestFacts)`:
 *     allowed → "full", gated (NDA, accreditation…) → "gated", else dropped. The two lists are
 *     merged in rank order: a row of (a) is kept only when "full", a row of (b) only when
 *     "gated" (title only: `gated: true`, no snippet). Then one hit per (module, kind, ref): the
 *     best-ranked admitted part. So for a gated (or denied) entry NOTHING in the response —
 *     inclusion, order, `hasMore` — depends on its body: its rows in (a) are skipped, and if (a)
 *     came back full (the cap) and ran out before the page was filled, it is re-read with every
 *     not-openable resource excluded, so those rows cannot have displaced openable ones.
 *  4. A second read transaction computes `ts_headline` snippets for the page's non-gated hits whose
 *     body matched, with control-character delimiters split into `{ text, highlight }` segments.
 *
 * Read-only throughout: it writes nothing, so it works under view-as (a READ ONLY transaction).
 */

export class SearchQueryError extends Error {
  override readonly name = "SearchQueryError";
}

/** Candidate rows read per list per search; bounds work for `offset` ≤ 500 and a sparse ACL. */
export const CANDIDATE_CAP = 1_000;
/** Re-reads of list (a) with more not-openable resources excluded (see step 3). */
export const MAX_EXCLUSION_ROUNDS = 8;
/** `word_similarity` floor of the trigram title fallback. */
export const TRIGRAM_THRESHOLD = 0.4;
/** Queries shorter than this (in characters) skip the trigram fallback: it would match everything. */
export const TRIGRAM_MIN_CHARS = 3;

export const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}, MaxFragments=2, MaxWords=24, MinWords=8, ShortWord=2, FragmentDelimiter=" … "`;

export interface SearchHit {
  readonly module: string;
  readonly kind: string;
  readonly refId: string;
  readonly title: string;
  readonly snippet: SnippetSegment[];
  readonly href: string;
  readonly updatedAt: string;
  readonly gated: boolean;
}

export interface SearchResults {
  readonly query: string;
  readonly hits: SearchHit[];
  readonly hasMore: boolean;
}

export interface SearchRequest {
  readonly q: string;
  readonly limit: number;
  readonly offset: number;
  readonly kinds?: readonly string[] | undefined;
  /** Module ids whose entries this caller may see (enabled, not offering-disabled, not hidden). */
  readonly modules: readonly string[];
}

export interface SearchEngineDeps {
  readonly db: Pick<Database, "withTenant">;
  /** `AuthzPort.check`; only called for external callers' `resource` hits. */
  readonly check: (
    principal: AuthzPrincipal,
    resource: ResourceRef,
    capability: "view",
    facts?: RequestFacts,
  ) => Promise<Pick<AccessDecision, "allowed" | "reason">>;
  readonly facts?: RequestFacts | undefined;
}

type Verdict = "full" | "gated" | "drop";

/** SQL's `ORDER BY tier, score DESC, source_updated_at DESC, id`, for merging the two lists. */
function compareRank(a: CandidateRow, b: CandidateRow): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.score !== b.score) return b.score - a.score;
  const ta = a.sourceUpdatedAt.getTime();
  const tb = b.sourceUpdatedAt.getTime();
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const resourceKey = (row: CandidateRow): string | undefined =>
  row.aclResourceKind === null || row.aclResourceId === null
    ? undefined
    : `${row.aclResourceKind}:${row.aclResourceId}`;

/** Runs one search as `ctx`. Throws `SearchQueryError` when the query has no searchable word. */
export async function runSearch(
  deps: SearchEngineDeps,
  ctx: TenantContext,
  req: SearchRequest,
): Promise<SearchResults> {
  const words = queryWords(req.q);
  if (words.length === 0) throw new SearchQueryError("the query has no searchable word");
  const want = req.offset + req.limit + 1;
  const external = ctx.actorKind === "external";
  const base = (queries: CandidateQuery["queries"]): Omit<CandidateQuery, "excludeResources"> => ({
    workspaceId: ctx.workspaceId,
    queries,
    modules: req.modules,
    kinds: req.kinds,
    limit: CANDIDATE_CAP,
    trigram: queries.plain.length >= TRIGRAM_MIN_CHARS,
    trigramThreshold: TRIGRAM_THRESHOLD,
  });

  const first = await deps.db.withTenant(ctx, async (tx) => {
    const queries = buildQueries(await queryLexemes(tx, words), words.join(" "));
    if (queries === undefined || req.modules.length === 0) return { queries };
    const q = base(queries);
    const full = await searchCandidates(tx, q);
    const byTitle = external ? await titleCandidates(tx, q) : [];
    return { queries, full, byTitle };
  });
  const queries = first.queries;
  if (queries === undefined)
    throw new SearchQueryError("the query has no searchable word (letters or digits)");
  if (first.full === undefined) return { query: req.q, hits: [], hasMore: false };
  let full = first.full;
  const byTitle = first.byTitle;

  const principal: AuthzPrincipal | undefined =
    external && ctx.membershipId !== undefined
      ? { workspaceId: ctx.workspaceId, membershipId: ctx.membershipId }
      : undefined;
  const decisions = new Map<string, Promise<Verdict>>();
  const resourceVerdict = (row: CandidateRow): Promise<Verdict> => {
    if (principal === undefined || row.aclResourceKind === null || row.aclResourceId === null)
      return Promise.resolve("drop");
    const key = `${row.aclResourceKind}:${row.aclResourceId}:${row.aclPath ?? ""}`;
    let v = decisions.get(key);
    if (v === undefined) {
      const resource: ResourceRef = {
        kind: row.aclResourceKind,
        id: row.aclResourceId,
        ...(row.aclPath === null ? {} : { path: row.aclPath }),
      };
      v = deps
        .check(principal, resource, "view", deps.facts)
        .then((d): Verdict => (d.allowed ? "full" : d.reason === "gated" ? "gated" : "drop"));
      decisions.set(key, v);
    }
    return v;
  };
  const verdictOf = async (row: CandidateRow): Promise<Verdict> => {
    if (!external) return "full";
    // RLS already refused `staff` rows and non-members of `groups`; this is the belt.
    if (row.aclKind === "staff") return "drop";
    if (row.aclKind === "resource") return resourceVerdict(row);
    return "full";
  };

  // Resources the caller may not open in full (gated or denied), excluded from list (a) when it
  // is re-read: their rows there are never used, so they must not take a place under the cap.
  const notOpenable = new Set<string>();
  let excludedInQuery = 0;
  let kept: { row: CandidateRow; gated: boolean }[] = [];
  for (let round = 0; ; round += 1) {
    kept = [];
    const seen = new Set<string>();
    let ia = 0;
    let ib = 0;
    while (kept.length < want) {
      const a = full[ia];
      const b = byTitle[ib];
      if (a === undefined && b === undefined) break;
      const fromFull = b === undefined || (a !== undefined && compareRank(a, b) <= 0);
      const row = (fromFull ? a : b) as CandidateRow;
      if (fromFull) ia += 1;
      else ib += 1;
      const ref = `${row.module}\u0000${row.kind}\u0000${row.refId}`;
      if (seen.has(ref)) continue;
      const verdict = await verdictOf(row);
      if (verdict !== "full") {
        const key = resourceKey(row);
        if (row.aclKind === "resource" && key !== undefined) notOpenable.add(key);
      }
      // (a) gives only openable hits; (b) only gated ones — a gated entry is judged by its title
      // alone, never by its body. Another part of the same ref may still qualify.
      if (fromFull ? verdict !== "full" : verdict !== "gated") continue;
      seen.add(ref);
      kept.push({ row, gated: verdict === "gated" });
    }
    const truncatedAndExhausted =
      kept.length < want && full.length >= CANDIDATE_CAP && ia >= full.length;
    if (!truncatedAndExhausted || notOpenable.size === excludedInQuery) break;
    if (round >= MAX_EXCLUSION_ROUNDS) break;
    excludedInQuery = notOpenable.size;
    const exclude = [...notOpenable];
    full = await deps.db.withTenant(ctx, (tx) =>
      searchCandidates(tx, { ...base(queries), excludeResources: exclude }),
    );
  }

  const page = kept.slice(req.offset, req.offset + req.limit);
  const snippetIds = page.filter((k) => !k.gated).map((k) => k.row.id);
  const heads =
    snippetIds.length === 0
      ? new Map<string, string>()
      : await deps.db.withTenant(ctx, (tx) =>
          headlines(tx, ctx.workspaceId, snippetIds, queries, HEADLINE_OPTIONS),
        );

  return {
    query: req.q,
    hasMore: kept.length > req.offset + req.limit,
    hits: page.map(({ row, gated }) => {
      const h = gated ? undefined : heads.get(row.id);
      return {
        module: row.module,
        kind: row.kind,
        refId: row.refId,
        title: row.title,
        snippet: h === undefined ? [] : splitHeadline(h),
        href: row.href,
        updatedAt: row.sourceUpdatedAt.toISOString(),
        gated,
      };
    }),
  };
}
