/*
 * Workspace search (E2.8, EXECUTION_PLAN §15 "Postgres FTS with ACL filtering and extracted
 * text"). See README.md for the model: what is indexed, the ACL kinds, how modules contribute,
 * the reindex job and the sweep, and the limits.
 */
export {
  CANDIDATE_CAP,
  HEADLINE_OPTIONS,
  MAX_EXCLUSION_ROUNDS,
  runSearch,
  type SearchEngineDeps,
  type SearchHit,
  SearchQueryError,
  type SearchRequest,
  type SearchResults,
  TRIGRAM_MIN_CHARS,
  TRIGRAM_THRESHOLD,
} from "./engine.js";
export {
  SEARCH_KIND_RE,
  SEARCH_MODULE_RE,
  SEARCH_UNTITLED,
  SearchEntryError,
  type SearchRow,
  toSearchRow,
} from "./entry.js";
export {
  createSearchIndex,
  reindexKey,
  SEARCH_REINDEX_JOB,
  SEARCH_SWEEP_JOB,
  SearchIndex,
  type SearchIndexDeps,
} from "./index-service.js";
export {
  createSearchJobs,
  type ReindexResult,
  reindexWorkspaceModule,
  type SearchJobsDeps,
  type SweepResult,
  sweepSearchIndex,
} from "./reindex.js";
export { deleteWorkspaceSearch, readStates, type SearchStateRow } from "./repos/search-repo.js";
export {
  buildQueries,
  cleanText,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  hasUnspacedScript,
  MAX_BODY_CHARS,
  MAX_QUERY_LEXEMES,
  MAX_QUERY_TERMS,
  MAX_SNIPPET_CHARS,
  MAX_TITLE_CHARS,
  queryWords,
  quoteLexeme,
  type SearchQueries,
  type SnippetSegment,
  splitHeadline,
  truncateChars,
} from "./text.js";
