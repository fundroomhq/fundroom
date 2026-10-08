import type { TenantContext, Tx } from "@fundroom/db";
import { type SQL, sql } from "drizzle-orm";

/*
 * Retrieval for the `qa_answer` AI task (E3.12, ADR-0060): which documents a question can draw
 * on, and which of their pages match it. Read as system (the task runs in the job, not as the
 * asker); the asker's access is decided by the caller with `AuthzPort.check()` — outside any
 * transaction — before a single page is searched. Nothing here widens what a caller may see.
 */

/** One live document whose current version has servable page text. */
export interface QaAiSourceDocument {
  readonly id: string;
  readonly title: string;
  /** The ltree path authz evaluates for a document (its folder's). */
  readonly folderPath: string;
  readonly versionId: string;
}

/** One matching page of a current version, best first. */
export interface QaAiPageHit {
  readonly versionId: string;
  readonly pageNo: number;
  readonly text: string;
}

/** Characters of the question handed to the Postgres parser (subject + body is ≤ 5 200). */
const QUERY_MAX = 6000;

/** A question lexeme and its rarity weight in the scope, `ln(1 + N / df)`. */
export interface QaAiLexemeWeight {
  readonly l: string;
  readonly w: number;
}

/**
 * How a question matches. `all`: `websearch_to_tsquery` — every term, ranked by `ts_rank_cd`.
 * `any` (the fallback when `all` yields nothing usable): any of the question's lexemes (Postgres's
 * `simple` parser — no stop-words), each weighted by its RARITY among the scoped documents
 * (fix round 3, RR3-M2): a page scores the sum of `ln(1 + N/df)` over the distinct question
 * lexemes it contains, then `ts_rank_cd` — so filler words every document has (`what`, `board`,
 * `plan`) weigh almost nothing and the page that names what was asked comes first.
 */
export type QaAiMatchMode =
  | { readonly kind: "all" }
  | { readonly kind: "any"; readonly weights: readonly QaAiLexemeWeight[] };

/** Where the question looks: one document, or the live documents under a folder path. */
export type QaAiScope = { readonly documentId: string } | { readonly underPath: string };

/** Question lexemes considered for weights (a 5 000-character question has a few hundred). */
const LEXEMES_MAX = 256;

export class QaAiSourceRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  /**
   * FROM + WHERE over the pages (`pt`) of scoped documents (`d`) and their current versions (`v`):
   * live, under no binned folder and under no staff-only folder (the veil, in SQL too), with a
   * `ready`, servable current version (clean, or unscanned while the workspace accepts that).
   */
  private scopedPages(scope: QaAiScope): SQL {
    const inScope =
      "documentId" in scope
        ? sql`d.id = ${scope.documentId}`
        : sql`d.folder_path <@ ${scope.underPath}::ltree`;
    return sql`FROM dataroom.document d
        JOIN dataroom.document_version v
          ON v.id = d.current_version_id AND v.workspace_id = d.workspace_id
        JOIN dataroom.blob b ON b.id = v.blob_id AND b.workspace_id = d.workspace_id
        JOIN dataroom.page_text pt ON pt.workspace_id = d.workspace_id AND pt.version_id = v.id
       WHERE d.workspace_id = ${this.ctx.workspaceId}
         AND d.deleted_at IS NULL
         AND ${inScope}
         AND v.render_status = 'ready'
         AND (b.scan_status = 'clean' OR (b.scan_status = 'skipped' AND COALESCE(
               (SELECT (w.settings -> 'dataRoom' ->> 'allowUnscanned')::boolean
                  FROM core.workspace w WHERE w.id = d.workspace_id), false)))
         AND NOT EXISTS (SELECT 1 FROM dataroom.folder f
               WHERE f.workspace_id = d.workspace_id AND f.deleted_at IS NOT NULL
                 AND f.path @> d.folder_path)
         AND NOT dataroom.under_staff_only(d.folder_path)`;
  }

  /**
   * The rarity weight of each question lexeme among the scoped documents (`any` mode). Lexemes
   * no scoped page contains are left out. One pass over the scoped pages' lexemes.
   */
  async lexemeWeights(scope: QaAiScope, question: string): Promise<QaAiLexemeWeight[]> {
    const q = question.slice(0, QUERY_MAX);
    const res = await this.tx.execute(sql`
      WITH lx AS (
             SELECT DISTINCT lexeme AS l FROM unnest(to_tsvector('simple', ${q}))
              WHERE lexeme !~ '[\\'':&|!()<>*]' LIMIT ${LEXEMES_MAX}),
           pages AS (SELECT d.id AS doc, pt.tsv ${this.scopedPages(scope)}),
           n AS (SELECT count(DISTINCT doc)::float8 AS n FROM pages),
           df AS (SELECT t.l, count(DISTINCT p.doc)::float8 AS df
                    FROM pages p CROSS JOIN LATERAL unnest(tsvector_to_array(p.tsv)) AS t(l)
                   WHERE t.l IN (SELECT l FROM lx)
                   GROUP BY t.l)
      SELECT df.l, ln(1 + n.n / df.df) AS w FROM df CROSS JOIN n ORDER BY df.l`);
    return (res.rows as { l: string; w: number | string }[]).map((r) => ({
      l: r.l,
      w: Number(r.w),
    }));
  }

  /** `q` (the tsquery) as a CTE, and the per-page rank (an array, compared lexicographically). */
  private terms(question: string, mode: QaAiMatchMode): { cte: SQL; rank: SQL } {
    if (mode.kind === "all")
      return {
        cte: sql`q AS (SELECT websearch_to_tsquery('simple', ${question.slice(0, QUERY_MAX)}) AS tq)`,
        rank: sql`ARRAY[0::float8, ts_rank_cd(pt.tsv, (SELECT tq FROM q), 1)::float8]`,
      };
    const json = JSON.stringify(mode.weights);
    return {
      cte: sql`wt AS (SELECT l, w FROM jsonb_to_recordset(${json}::jsonb) AS x(l text, w float8)),
        q AS (SELECT COALESCE((SELECT string_agg(chr(39) || l || chr(39), ' | ') FROM wt),
                              chr(39) || chr(39))::tsquery AS tq)`,
      rank: sql`ARRAY[(SELECT COALESCE(sum(wt.w), 0) FROM wt
                        WHERE wt.l = ANY(tsvector_to_array(pt.tsv)))::float8,
                      ts_rank_cd(pt.tsv, (SELECT tq FROM q), 1)::float8]`,
    };
  }

  /**
   * Candidate documents that MATCH the question on some page of the current version, best page
   * first, before any access check (the caller checks each, outside any transaction). Paged by
   * `offset` — the caller stops after a bounded number of checks.
   */
  async matchingDocuments(
    scope: QaAiScope,
    question: string,
    mode: QaAiMatchMode,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<QaAiSourceDocument[]> {
    const { cte, rank } = this.terms(question, mode);
    const res = await this.tx.execute(sql`
      WITH ${cte}
      SELECT d.id, d.title, d.folder_path::text AS folder_path, v.id AS version_id,
             max(${rank}) AS rank
        ${this.scopedPages(scope)}
         AND pt.tsv @@ (SELECT tq FROM q)
       GROUP BY d.id, d.title, d.folder_path, v.id
       ORDER BY rank DESC, d.id
       LIMIT ${page.limit} OFFSET ${page.offset}`);
    return (
      res.rows as { id: string; title: string; folder_path: string; version_id: string }[]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      folderPath: r.folder_path,
      versionId: r.version_id,
    }));
  }

  /** The best-matching pages of these versions (`mode` as for the candidates), best first. */
  async searchPages(
    versionIds: readonly string[],
    question: string,
    mode: QaAiMatchMode,
    limit: number,
  ): Promise<QaAiPageHit[]> {
    if (versionIds.length === 0) return [];
    const { cte, rank } = this.terms(question, mode);
    const res = await this.tx.execute(sql`
      WITH ${cte}
      SELECT pt.version_id, pt.page_no, pt.text
        FROM dataroom.page_text pt CROSS JOIN q
       WHERE pt.workspace_id = ${this.ctx.workspaceId}
         AND pt.version_id = ANY(${`{${versionIds.join(",")}}`}::uuid[])
         AND pt.tsv @@ q.tq
       ORDER BY ${rank} DESC, pt.version_id, pt.page_no
       LIMIT ${limit}`);
    return (res.rows as { version_id: string; page_no: number; text: string }[]).map((r) => ({
      versionId: r.version_id,
      pageNo: r.page_no,
      text: r.text,
    }));
  }

  /** The question's lexemes as the `simple` parser sees them (to window a long page). */
  async lexemes(question: string): Promise<string[]> {
    const q = question.slice(0, QUERY_MAX);
    const res = await this.tx.execute(
      sql`SELECT DISTINCT lexeme FROM unnest(to_tsvector('simple', ${q})) ORDER BY lexeme`,
    );
    return (res.rows as { lexeme: string }[]).map((r) => r.lexeme);
  }
}
