/*
 * Pure text handling for workspace search (E2.8): the query tokeniser, the tsquery builders and
 * the snippet splitter. No I/O, so every edge (injection strings, huge inputs, surrogate pairs)
 * is unit-tested here rather than against Postgres.
 */

/** Longest body the index stores, in characters (the `search_entry_body_length` CHECK). */
export const MAX_BODY_CHARS = 200_000;
/** Longest title the index stores; longer titles are truncated, never refused. */
export const MAX_TITLE_CHARS = 1_000;
/**
 * Snippet delimiters handed to `ts_headline` (StartSel/StopSel). Control characters rather than
 * markup, so a snippet is never HTML at any point: the splitter turns them into
 * `{ text, highlight }` segments and the client renders text. Stored text never contains them —
 * `cleanText` strips every C0 control but tab/newline/carriage return on the way in.
 */
export const HIGHLIGHT_START = "\u0002";
export const HIGHLIGHT_STOP = "\u0003";

// C0 controls except \t \n \r, plus DEL. NUL is also refused by Postgres text outright.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Replaces control characters (including the highlight delimiters) with a space. */
export function cleanText(s: string): string {
  return s.replace(CONTROL_RE, " ");
}

/**
 * Cuts `s` to at most `max` UTF-16 units without splitting a surrogate pair. Postgres counts
 * code points (`char_length`), and a string of ≤ `max` UTF-16 units has ≤ `max` code points, so
 * the result always satisfies the CHECK.
 */
export function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  // A high surrogate at the cut: its low half would be dropped, leaving a lone surrogate.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Most whitespace-separated query words kept; the rest are ignored. */
export const MAX_QUERY_TERMS = 12;
/** Most lexemes one query is built from (a compound word such as `Q3-2025` yields several). */
export const MAX_QUERY_LEXEMES = 32;

/**
 * The query's words: the text NFC-normalised, control characters replaced, split on whitespace,
 * de-duplicated case-insensitively (first spelling kept), at most `MAX_QUERY_TERMS`. Punctuation
 * is NOT stripped here: each word goes to Postgres's own parser (`to_tsvector('simple', word)`,
 * bound as a parameter) — the function that built the index — so `john.doe@acme.com`,
 * `report_final.pdf`, `3.5`, `$1.5M`, `Q3-2025` and `2025-09-23` produce exactly the lexemes a
 * document containing them has. Nothing typed is ever parsed as tsquery syntax: the tsquery is
 * assembled from those lexemes, each a quoted operand (`quoteLexeme`).
 */
export function queryWords(q: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of cleanText(q.normalize("NFC")).split(/\s+/u)) {
    if (word.length === 0) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

// Scripts written without spaces between words: the `simple` parser sees a whole run as one
// word, so the only useful partial match is a title substring (see the engine's CJK fallback).
const UNSPACED_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Whether the query contains a script written without spaces between words (CJK, Thai). */
export function hasUnspacedScript(q: string): boolean {
  return UNSPACED_RE.test(q);
}

/**
 * One operand of tsquery *input* syntax for `lexeme` as-is: single-quoted, `'` doubled and `\`
 * escaped. The text is cast with `::tsquery` (never `to_tsquery`), so it is not re-parsed or
 * re-normalised — the lexeme is taken literally, whatever characters it holds.
 */
export function quoteLexeme(lexeme: string): string {
  return `'${lexeme.replace(/\\/gu, "\\\\").replace(/'/gu, "''")}'`;
}

export interface SearchQueries {
  /** Every lexeme AND-ed, the last word's as prefixes: what a hit must match. */
  readonly all: string;
  /** The same, restricted to the title (weight A): "the title itself matched". */
  readonly title: string;
  /** Any lexeme in the body (weight C), OR-ed: whether a body snippet exists. */
  readonly bodyAny: string;
  /** The words joined by spaces, for the trigram (and CJK substring) title fallback. */
  readonly plain: string;
  /** The query holds CJK/Thai: also match titles containing `plain` as a substring. */
  readonly unspaced: boolean;
}

/**
 * tsquery input texts, cast with `$1::tsquery` (always bound as a parameter). `groups` are the
 * lexemes of each query word in order (what `to_tsvector('simple', word)` produced; words that
 * produced none are dropped by the caller). Lexemes of the LAST word are prefixes (`:*`) — all of
 * them, so a partly typed compound (`Q3-20`) still matches `Q3-2025`. At most
 * `MAX_QUERY_LEXEMES`, the last word's kept first.
 */
export function buildQueries(
  groups: readonly (readonly string[])[],
  plain: string,
): SearchQueries | undefined {
  const nonEmpty = groups.filter((g) => g.length > 0);
  const last = nonEmpty.at(-1);
  if (last === undefined) return undefined;
  const prefix = [...new Set(last)].slice(0, MAX_QUERY_LEXEMES);
  const exact = [...new Set(nonEmpty.slice(0, -1).flat())]
    .filter((l) => !prefix.includes(l))
    .slice(0, MAX_QUERY_LEXEMES - prefix.length);
  const ops = (weight: string) => [
    ...exact.map((l) => `${quoteLexeme(l)}${weight === "" ? "" : `:${weight}`}`),
    ...prefix.map((l) => `${quoteLexeme(l)}:*${weight}`),
  ];
  return {
    all: ops("").join(" & "),
    title: ops("A").join(" & "),
    bodyAny: ops("C").join(" | "),
    plain,
    unspaced: hasUnspacedScript(plain),
  };
}

export interface SnippetSegment {
  readonly text: string;
  readonly highlight: boolean;
}

/** Longest snippet returned, in characters, across its segments. */
export const MAX_SNIPPET_CHARS = 480;

/**
 * Splits a `ts_headline` result (delimited with `HIGHLIGHT_START`/`HIGHLIGHT_STOP`) into plain
 * text segments. Whitespace runs collapse to one space; adjacent segments of the same kind merge;
 * any stray control character is dropped; an unbalanced delimiter simply toggles nothing. The
 * total is capped at `MAX_SNIPPET_CHARS`. Never produces markup.
 */
export function splitHeadline(headline: string): SnippetSegment[] {
  const raw: SnippetSegment[] = [];
  let highlight = false;
  let buf = "";
  const flush = () => {
    if (buf.length > 0) raw.push({ text: buf, highlight });
    buf = "";
  };
  for (const ch of headline) {
    if (ch === HIGHLIGHT_START) {
      if (!highlight) {
        flush();
        highlight = true;
      }
    } else if (ch === HIGHLIGHT_STOP) {
      if (highlight) {
        flush();
        highlight = false;
      }
    } else {
      buf += ch;
    }
  }
  flush();

  const out: { text: string; highlight: boolean }[] = [];
  let total = 0;
  for (const seg of raw) {
    let text = cleanText(seg.text).replace(/\s+/gu, " ");
    if (out.length === 0) text = text.replace(/^ /u, "");
    if (text.length === 0) continue;
    if (total + text.length > MAX_SNIPPET_CHARS) {
      text = truncateChars(text, MAX_SNIPPET_CHARS - total);
      if (text.length === 0) break;
    }
    total += text.length;
    const prev = out.at(-1);
    if (prev !== undefined && prev.highlight === seg.highlight) prev.text += text;
    else out.push({ text, highlight: seg.highlight });
    if (total >= MAX_SNIPPET_CHARS) break;
  }
  const last = out.at(-1);
  if (last !== undefined) {
    last.text = last.text.replace(/ $/u, "");
    if (last.text.length === 0) out.pop();
  }
  return out;
}
