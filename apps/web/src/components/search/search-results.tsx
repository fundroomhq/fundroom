import { Badge, Button, EmptyState, Input, LoadingState, PageHeader } from "@fundroomhq/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Lock, SearchX } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatDate } from "../../lib/format.js";
import { SEARCH_MAX_QUERY, type SearchHit, searchQuery } from "../../lib/search-queries.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import type { SearchTarget } from "./search-field.js";

/** What `@fundroom/search` stores for a title that is empty once cleaned (`SEARCH_UNTITLED`). */
const SEARCH_UNTITLED = "—";

/** How long the results page waits after the last keystroke before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

/** `?q=` for both results routes: a trimmed, bounded string, or absent. */
export function validateSearchParams(search: Record<string, unknown>): { q?: string } {
  const raw = search["q"];
  if (typeof raw !== "string") return {};
  const q = raw.slice(0, SEARCH_MAX_QUERY);
  return q.trim() === "" ? {} : { q };
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "document":
      return m.search_kind_document();
    case "folder":
      return m.search_kind_folder();
    case "page":
      return m.search_kind_page();
    case "post":
      return m.search_kind_post();
    // A Q&A entry's title is its document's or folder's name (E3.3): the badge says what it is.
    case "qa":
      return m.dataroom_qa_search_kind();
    default:
      return kind;
  }
}

/**
 * A snippet is a list of plain-text segments; the matched ones are wrapped in `<mark>`. Text is
 * only ever rendered as React text children — whatever a document contains (markup, script,
 * an `<img onerror>`) shows up as the characters it is.
 */
export function Snippet({ segments }: { segments: SearchHit["snippet"] }) {
  if (segments.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground" data-slot="search-snippet">
      {segments.map((segment, i) =>
        segment.highlight ? (
          <mark key={i} className="rounded-sm bg-warning/40 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function HitItem({ hit }: { hit: SearchHit }) {
  return (
    <li className="space-y-1 border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">
          <Link to={hit.href} className="underline underline-offset-4">
            {hit.title === SEARCH_UNTITLED ? m.search_untitled() : hit.title}
          </Link>
        </h2>
        <Badge variant="secondary">{kindLabel(hit.kind)}</Badge>
        {hit.gated ? (
          <Badge variant="outline" className="gap-1">
            <Lock aria-hidden="true" className="size-3" />
            {m.search_gated()}
          </Badge>
        ) : null}
      </div>
      {hit.gated ? (
        <p className="text-sm text-muted-foreground">{m.search_gated_body()}</p>
      ) : (
        <Snippet segments={hit.snippet} />
      )}
      <p className="text-xs text-muted-foreground">
        {m.search_updated({ date: formatDate(hit.updatedAt) })}
      </p>
    </li>
  );
}

/**
 * The results page (E2.8), shared by the portal (`/search`) and the admin shell
 * (`/admin/search`): the server decides what each principal may find, so staff see
 * staff-only entries here and investors never do. The query lives in the URL; typing in the
 * page's own field updates it after a short pause, replacing the history entry so Back leaves
 * the page instead of stepping through every keystroke.
 */
export function SearchResultsPage({ q, to }: { q: string | undefined; to: SearchTarget }) {
  const ids = useId();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(q ?? "");
  const lastPushed = useRef(q ?? "");
  // The URL changed under us (header search, Back): show what it says.
  useEffect(() => {
    lastPushed.current = q ?? "";
    setDraft(q ?? "");
  }, [q]);
  useEffect(() => {
    const next = draft.trim();
    if (next === lastPushed.current.trim()) return;
    const timer = setTimeout(() => {
      lastPushed.current = next;
      void navigate({ to, search: next === "" ? {} : { q: next }, replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, navigate, to]);

  const query = q?.trim() ?? "";
  const results = useInfiniteQuery(searchQuery(query));
  const hits = results.data?.pages.flatMap((p) => p.hits) ?? [];
  const hasMore = results.hasNextPage;

  let status = "";
  if (query === "") status = "";
  else if (results.data === undefined)
    status = results.isError ? m.search_status_failed() : m.search_status_searching();
  else if (hits.length === 0) status = m.search_status_none({ q: query });
  else if (hasMore) status = m.search_status_more({ q: query, count: String(hits.length) });
  else status = m.search_status_count({ q: query, count: String(hits.length) });

  return (
    <div className="space-y-6">
      <PageHeader title={m.search_title()} description={m.search_subtitle()} />
      {/* biome-ignore lint/a11y/useSemanticElements: `<search>` is not mapped to the search role by jsdom/aria-query (screen tests) or older screen readers; a form with role="search" is the WAI-ARIA landmark pattern */}
      <form
        role="search"
        aria-label={m.search_page_landmark()}
        className="max-w-xl"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          lastPushed.current = next;
          void navigate({ to, search: next === "" ? {} : { q: next }, replace: true });
        }}
      >
        <label htmlFor={`${ids}-q`} className="mb-1 block text-sm font-medium">
          {m.search_page_field_label()}
        </label>
        <Input
          id={`${ids}-q`}
          type="search"
          value={draft}
          maxLength={SEARCH_MAX_QUERY}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          enterKeyHint="search"
        />
      </form>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {status}
      </p>
      {query === "" ? (
        <p className="text-sm text-muted-foreground">{m.search_prompt()}</p>
      ) : results.data === undefined ? (
        results.isError ? (
          <ErrorAlert error={results.error} />
        ) : (
          <LoadingState lines={3} label={m.search_status_searching()} />
        )
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" />}
          title={m.search_empty_title()}
          description={m.search_empty_body()}
        />
      ) : (
        <>
          <ul aria-label={m.search_results_label({ q: query })} className="max-w-3xl">
            {hits.map((hit) => (
              <HitItem key={`${hit.module}:${hit.kind}:${hit.refId}`} hit={hit} />
            ))}
          </ul>
          {results.isFetchNextPageError ? <ErrorAlert error={results.error} /> : null}
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              loading={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
            >
              {m.search_load_more()}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
