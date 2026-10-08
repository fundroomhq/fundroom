/*
 * History sync (design/08 §1c "History sync", E2.2 spec §4). The portal lives inside somebody
 * else's page, so a deep link has to be expressible in *their* URL without taking it over:
 *
 *  - `"query"` (default) keeps the path in `?sh=/updates`. One extra search parameter is the
 *    smallest thing that survives a copy-paste, and every host router we know ignores unknown
 *    search parameters.
 *  - `"hash"` is for hosts whose CDN or cache keys on the query string. It **owns the fragment**:
 *    choosing it says the host page has no `#anchor` navigation of its own. The default does not
 *    have that caveat, which is why it is the default.
 *  - `"none"` writes nothing.
 *
 * These are pure string functions so the round-trip is testable without a DOM, and so the loader
 * never has to hand-roll URL parsing on the callback path.
 */

import { isPortalPath } from "./protocol.js";

export type HistoryMode = "query" | "hash" | "none";

/** The parameter name, in both the query and the fragment. Short, and namespaced enough. */
export const HISTORY_PARAM = "sh";

/** The portal path encoded in `href`, if this mode stores one there. */
export function readPathFromUrl(href: string, mode: HistoryMode): string | undefined {
  if (mode === "none") return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const params =
    mode === "query" ? url.searchParams : new URLSearchParams(url.hash.replace(/^#/u, ""));
  // A `?sh=` a stranger crafted is attacker-controlled input that ends up in an iframe `src`, so
  // `//evil.example` must not survive the trip.
  const value = params.get(HISTORY_PARAM);
  return isPortalPath(value) ? value : undefined;
}

/**
 * Splices our parameter into a raw query string, leaving every other pair byte for byte as it
 * was. Not `URLSearchParams`: parsing and re-serialising the host's query rewrites it — `b%20c`
 * becomes `b+c`, `:/@` becomes `%3A%2F%40`, a valueless `y` gains an `=` — and an embed that
 * promised to add one parameter must not mutate the ones a host's analytics, router or signed
 * link reads exactly. The `url.search` setter re-encodes only characters that cannot appear in a
 * query at all, so what goes in here comes out unchanged.
 */
function spliceParam(search: string, value: string): string {
  const pairs = search
    .replace(/^\?/u, "")
    .split("&")
    .filter(
      (pair) => pair.length > 0 && pair !== HISTORY_PARAM && !pair.startsWith(`${HISTORY_PARAM}=`),
    );
  pairs.push(`${HISTORY_PARAM}=${value}`);
  return `?${pairs.join("&")}`;
}

/** `href` with `path` written into it. Returns `href` unchanged for `"none"`. */
export function writePathToUrl(href: string, mode: HistoryMode, path: string): string {
  if (mode === "none") return href;
  const url = new URL(href);
  // `/` is legal unencoded in a query string and in a fragment (RFC 3986 §3.4, §3.5), and
  // `?sh=/updates` is what a person can read and retype.
  const value = encodeURIComponent(path).replace(/%2F/gu, "/");
  if (mode === "query") url.search = spliceParam(url.search, value);
  else url.hash = `${HISTORY_PARAM}=${value}`;
  return url.toString();
}
