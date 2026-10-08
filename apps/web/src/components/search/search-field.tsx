import { Input } from "@fundroomhq/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { SEARCH_MAX_QUERY } from "../../lib/search-queries.js";
import { m } from "../../paraglide/messages.js";

export type SearchTarget = "/search" | "/admin/search";

/** True when a keystroke belongs to whatever the user is typing into, not to a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "file", "color", "range"].includes(
    type,
  );
}

/**
 * The header search box (E2.8): a `search` landmark with a labelled field. `/` and Ctrl/Cmd+K
 * put the caret in it from anywhere on the page — except while the user is typing into another
 * field, where both keys mean what they always mean — and Enter opens the results page with the
 * query in the URL, so results can be bookmarked, shared and reached with Back.
 */
export function HeaderSearch({ to }: { to: SearchTarget }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const urlQuery = useRouterState({
    select: (s) => {
      const q = (s.location.search as { q?: unknown }).q;
      return s.location.pathname === to && typeof q === "string" ? q : undefined;
    },
  });
  const [value, setValue] = useState(urlQuery ?? "");
  // Follow the results page's own field (and Back/Forward) while it is on screen.
  useEffect(() => {
    if (urlQuery !== undefined) setValue(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
      const modK =
        (event.key === "k" || event.key === "K") &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (!slash && !modK) return;
      if (isTypingTarget(event.target)) return;
      // A modal owns the keyboard while it is open; do not pull focus out from under it.
      if (event.target instanceof Element && event.target.closest("[role=dialog]")) return;
      const field = input.current;
      if (field === null) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = value.trim();
    if (q === "") return;
    void navigate({ to, search: { q } });
  };

  return (
    <div className="min-w-0 flex-1 md:max-w-sm">
      {/* biome-ignore lint/a11y/useSemanticElements: `<search>` is not mapped to the search role by jsdom/aria-query (screen tests) or older screen readers; a form with role="search" is the WAI-ARIA landmark pattern */}
      <form role="search" aria-label={m.search_landmark()} onSubmit={submit} className="relative">
        <label htmlFor={`${id}-q`} className="sr-only">
          {m.search_field_label()}
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={input}
          id={`${id}-q`}
          type="search"
          name="q"
          value={value}
          maxLength={SEARCH_MAX_QUERY}
          onChange={(e) => setValue(e.target.value)}
          placeholder={m.search_field_placeholder()}
          aria-keyshortcuts="/ Control+K Meta+K"
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          enterKeyHint="search"
          className="h-9 pl-8"
        />
        <span id={`${id}-hint`} className="sr-only">
          {m.search_field_hint()}
        </span>
      </form>
    </div>
  );
}
