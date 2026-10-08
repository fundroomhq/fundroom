import { z } from "zod";
import type { QaAiPassage } from "./prompt.js";

/*
 * Turning the model's JSON into the stored `qa_answer` result (E3.12, ADR-0060). The model is
 * not trusted to cite honestly: a citation survives only when its source id is one of the
 * passages actually sent AND its quote (folded: NFKC, lower case, whitespace collapsed) occurs in
 * that passage's text and is long enough to prove something (≥ 24 characters and ≥ 4 words; a
 * quote without spaces — Chinese, Japanese — needs ≥ 12 CJK characters). The quote stored is the
 * PAGE's own text span that matched, never the model's wording.
 *
 * The answer text keeps its own characters (fix round 2, RR2-M2: `10⁶`, `m²`, `Section 4(3)` stay
 * exactly as written). Only invisible characters are removed and runs of spaces collapsed. A
 * source list the model wrote after its answer ("Sources:", "### References", "Quellen", "出典",
 * …) is removed, as are trailing footnote lines; only the server writes a Sources footer. Citation
 * markers are found on a width-folded VIEW of the text (fullwidth `［Ｓ１］` counts) and edited in
 * the original: `[S1]`, `(S2)`, `【S3】`, `[Source 4]`, `[S1-S3]` → verified sources renumbered
 * `[1]..[n]` by first use, anything else removed; a bare `[n]` / `【n】` is removed (it would read as
 * a citation), a parenthesised number never is. An answer that is `answered` without a verified
 * citation — or left empty — is stored as `unsupported`.
 *
 * Everything here is linear in the input: the answer is capped before any pattern runs, and no
 * pattern has two adjacent unbounded quantifiers over the same characters (RR2-M1).
 */

export const QA_AI_BODY_MAX = 20_000;
export const QA_AI_QUOTE_MAX = 300;
export const QA_AI_QUOTE_MIN = 24;
export const QA_AI_QUOTE_MIN_WORDS = 4;
export const QA_AI_QUOTE_MIN_CJK = 12;
/** Characters of the model's answer looked at (the body is capped at 20 000 anyway). */
export const QA_AI_ANSWER_INPUT_MAX = 40_000;
/** Characters of a model quote looked at (a shown quote is ≤ 300). */
const QUOTE_INPUT_MAX = 2000;
export const QA_AI_MAX_CITATIONS = 12;
/** Citation entries looked at (a flood of entries is not a reason to do unbounded work). */
const CITATIONS_EXAMINED = 64;

/** What the model must return (lenient on extra keys and a missing `citations`). */
export const QaAiOutputSchema = z.object({
  outcome: z.enum(["answered", "insufficient"]),
  answer: z.string(),
  citations: z.array(z.object({ source: z.string(), quote: z.string() })).default([]),
});
export type QaAiOutput = z.infer<typeof QaAiOutputSchema>;

export type QaAiCitation = {
  readonly n: number;
  readonly documentId: string;
  readonly versionId: string;
  readonly pageNo: number;
  readonly documentTitle: string;
  readonly quote: string;
};

export type QaAiAnswerResult = {
  readonly kind: "qa_answer";
  readonly outcome: "answered" | "insufficient" | "unsupported";
  readonly body: string;
  readonly citations: QaAiCitation[];
  readonly droppedCitations: number;
  readonly searchedDocuments: number;
};

/**
 * Invisible or direction-changing characters, and C0/C1 controls except `\n` and `\t`: bidi
 * embeddings/overrides/isolates and marks, zero-width characters, word joiner and invisible
 * operators, BOM, soft hyphen, interlinear annotations, Unicode tag characters (hidden "ASCII
 * smuggling") and variation selectors.
 */
const INVISIBLE_CLASS = String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]`;
const INVISIBLE = new RegExp(INVISIBLE_CLASS, "gu");
const INVISIBLE_ONE = new RegExp(INVISIBLE_CLASS, "u");

/** Text safe to show: invisible and control characters removed (`\n`, `\t` kept). */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "");
}

/** Folded text plus, per UTF-16 unit, the span of the original it came from. */
interface Folded {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/**
 * NFKC + lower case per code point, invisible characters dropped, whitespace runs collapsed to one
 * space, trimmed — with a map back to the original, so a match can be shown as the page wrote it.
 * Used to COMPARE only; nothing folded is ever stored.
 */
function fold(s: string): Folded {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of s) {
    const at = i;
    i += ch.length;
    if (INVISIBLE_ONE.test(ch)) continue;
    const f = ch.normalize("NFKC").toLowerCase();
    if (f.length === 0) continue;
    if (/^\s+$/u.test(f)) {
      if (text.length > 0 && !text.endsWith(" ")) {
        text += " ";
        from.push(at);
        to.push(i);
      }
      continue;
    }
    text += f;
    for (let k = 0; k < f.length; k++) {
      from.push(at);
      to.push(i);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { text, from, to };
}

const QUOTE_MARKS = new Set([..."\"'“”‘’„‚«»‹›`…"]);

/** Folded, then surrounding quote marks, ellipses (`…`, `...`) and spaces stripped. */
export function normaliseQuote(s: string): string {
  const t = fold(s).text; // single spaces, trimmed
  let a = 0;
  let b = t.length;
  for (;;) {
    const before = [a, b];
    while (a < b && (QUOTE_MARKS.has(t[a] as string) || t[a] === " ")) a++;
    while (b > a && (QUOTE_MARKS.has(t[b - 1] as string) || t[b - 1] === " ")) b--;
    // an ellipsis is 2+ dots; a single full stop at the end is the sentence's own
    if (t.startsWith("..", a)) while (a < b && t[a] === ".") a++;
    if (b - a >= 2 && t[b - 1] === "." && t[b - 2] === ".") while (b > a && t[b - 1] === ".") b--;
    if (before[0] === a && before[1] === b) break;
  }
  return t.slice(a, b);
}

/** The passage text as quotes are compared against it (same folding, nothing stripped). */
export function normalisePassage(s: string): string {
  return fold(s).text;
}

/** Characters of scripts written without spaces between words. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Enough of a quote to prove something: ≥ 24 characters and ≥ 4 words (`Intl.Segmenter` word
 * segments), or ≥ 12 characters of a script written without spaces (Chinese, Japanese, Thai …).
 */
function quoteLongEnough(quote: string): boolean {
  if ((quote.match(UNSPACED) ?? []).length >= QA_AI_QUOTE_MIN_CJK) return true;
  if (quote.length < QA_AI_QUOTE_MIN) return false;
  let words = 0;
  for (const seg of WORDS.segment(quote)) if (seg.isWordLike === true) words++;
  return words >= QA_AI_QUOTE_MIN_WORDS;
}

/** `S3`, `[S3]`, ` s3 `, `Source 3` → `S3`; anything else → null. */
function sourceIdOf(raw: string): string | null {
  const m = /^\[?\s?(?:[Ss]|[Ss]ource\s?)(\d{1,3})\s?\]?$/u.exec(raw.trim().slice(0, 40));
  return m === null ? null : `S${Number(m[1])}`;
}

const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

/**
 * The marker view — one UTF-16 unit for one, so an index in the view is the same index in the
 * original: fullwidth ASCII (U+FF01–FF5E) → ASCII, every Unicode space separator (NBSP, thin,
 * ideographic …) → a space, and the superscript citation form `⁽²⁾` → `[2]` (its digits and
 * parentheses only; a lone `²` as in `m²` is left alone because it is not bracketed).
 */
function markerView(s: string): string {
  return s
    .replace(/[！-～]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\p{Zs}/gu, " ")
    .replace(/⁽/gu, "[")
    .replace(/⁾/gu, "]")
    .replace(/[⁰¹²³⁴-⁹]/gu, (c) => SUPERSCRIPT_DIGITS[c] ?? c);
}

/** One id or a range: `S1`, `Source 2`, `s 4`, `3`, `S1-S3`, `1–2`. */
const ONE = String.raw`(?:[Ss]ource ?|[Ss] ?)?\d{1,3}(?: ?[-–] ?(?:[Ss]ource ?|[Ss] ?)?\d{1,3})?`;
const LIST = `${ONE}(?: ?[,;] ?${ONE}){0,11}`;
/**
 * A marker on the view: square or CJK lenticular/tortoise-shell brackets around ids or numbers,
 * or parentheses around ids that name a source (`(S1)`, never `(1)` or `4(3)`). `《…》` (a book
 * title in CJK prose) is not a marker. Bounded quantifiers only.
 */
const MARKER = new RegExp(
  String.raw`[\[【〔〖⟦〘] ?\^?(${LIST}) ?[\]】〕〗⟧〙]|\( ?((?:[Ss]ource ?|[Ss] ?)\d{1,3}(?: ?[-–,;] ?(?:[Ss]ource ?|[Ss] ?)?\d{1,3}){0,11}) ?\)`,
  "gu",
);

/** The source ids a marker's inside names (`S1-S3` expanded, ≤ 12); bare numbers name none. */
function idsOf(inside: string): string[] {
  const out: string[] = [];
  for (const part of inside.split(/[,;]/u)) {
    const m =
      /^ ?((?:[Ss]ource ?|[Ss] ?)?)(\d{1,3})(?: ?[-–] ?((?:[Ss]ource ?|[Ss] ?)?)(\d{1,3}))? ?$/u.exec(
        part,
      );
    if (m === null || (m[1] ?? "") === "") continue; // a bare number is not a source id
    const lo = Number(m[2]);
    const hi = m[4] === undefined ? lo : Number(m[4]);
    for (let n = lo; n <= Math.min(hi, lo + 11); n++) out.push(`S${n}`);
  }
  return out;
}

/** Headings that open a model-written source list (a line that is ONLY one of these). */
const LIST_HEADINGS = new Set([
  "source",
  "sources",
  "sources used",
  "sources cited",
  "references",
  "citations",
  "footnotes",
  "bibliography",
  "documents consulted",
  "documents cited",
  "works cited",
  "quellen",
  "fuentes",
  "références",
  "fonti",
  "bronnen",
  "källor",
  "kilder",
  "źródła",
  "出典",
  "参考",
  "参考文献",
  "来源",
  "出处",
  "출처",
  "참고문헌",
]);

const EDGE_DECORATION = "#*_ \t:：-–—";

/**
 * Whether a line is solely a source-list heading: optional markdown `#`s and bold/italic, one of
 * `LIST_HEADINGS`, an optional trailing `:` / `-` / `–`. A bulleted line (`- Reference: …`) never is.
 */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 60 || /^[-*•·–] /u.test(t)) return false;
  let a = 0;
  let b = t.length;
  while (a < b && EDGE_DECORATION.includes(t[a] as string)) a++;
  while (b > a && EDGE_DECORATION.includes(t[b - 1] as string)) b--;
  return LIST_HEADINGS.has(t.slice(a, b).toLowerCase());
}

/**
 * The model's answer without its own source list (fix round 3, RR3-M1: one simple rule): a
 * trailing block whose first line is solely a source-list heading, that comes after some answer
 * text, runs to the end, and names no source id anywhere (`[S2]` in it means it is answer text).
 * Nothing else is ever removed. One pass backwards, one forwards (linear, RR3-L2).
 */
function withoutModelFooter(lines: readonly string[]): string[] {
  // idFree[i]: no line from i to the end carries a source-id marker
  const idFree = new Array<boolean>(lines.length + 1).fill(true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const view = markerView(lines[i] as string);
    let ids = false;
    for (const m of view.matchAll(MARKER))
      if (idsOf(m[1] ?? m[2] ?? "").length > 0) {
        ids = true;
        break;
      }
    idFree[i] = !ids && (idFree[i + 1] as boolean);
  }
  let seenText = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (seenText && idFree[i] === true && isHeadingLine(line)) return lines.slice(0, i);
    if (line.trim() !== "") seenText = true;
  }
  return [...lines];
}

/**
 * Verify, renumber and render. `passages` are exactly the passages sent (ids `S1..Sn`);
 * `searchedDocuments` = documents that passed the asker's access check.
 */
export function finishAnswer(
  output: QaAiOutput,
  passages: readonly QaAiPassage[],
  searchedDocuments: number,
): QaAiAnswerResult {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const folded = new Map<string, Folded>();
  const foldedOf = (p: QaAiPassage): Folded => {
    let f = folded.get(p.id);
    if (f === undefined) {
      f = fold(p.text);
      folded.set(p.id, f);
    }
    return f;
  };

  // 1. verify each citation entry; the first verified quote of a source is the one shown — as
  //    the page wrote it (the original span the folded match maps back to)
  const verified = new Map<string, string>(); // source id → quote
  const citedOrder: string[] = [];
  let dropped = 0;
  const entries = output.citations;
  for (const [i, c] of entries.entries()) {
    if (i >= CITATIONS_EXAMINED) {
      dropped += entries.length - CITATIONS_EXAMINED;
      break;
    }
    const id = sourceIdOf(c.source);
    const p = id === null ? undefined : byId.get(id);
    const quote = normaliseQuote(c.quote.slice(0, QUOTE_INPUT_MAX));
    const f = p === undefined ? undefined : foldedOf(p);
    const at = f === undefined ? -1 : f.text.indexOf(quote);
    if (id === null || p === undefined || f === undefined || !quoteLongEnough(quote) || at === -1) {
      dropped += 1;
      continue;
    }
    if (!verified.has(id)) {
      const span = p.text.slice(f.from[at], f.to[at + quote.length - 1]);
      const shown = stripInvisible(span).replace(/\s+/gu, " ").trim();
      verified.set(id, shown.slice(0, QA_AI_QUOTE_MAX));
      citedOrder.push(id);
    }
  }

  // 2. the answer: capped, invisible characters out, space runs collapsed (all linear), the
  //    model's own source list out — the text itself is never rewritten
  const lines = withoutModelFooter(
    stripInvisible(output.answer.slice(0, QA_AI_ANSWER_INPUT_MAX).replace(/\r\n?/gu, "\n"))
      .replace(/[ \t]{2,}/gu, " ")
      .split("\n")
      .map((l) => l.trimEnd()),
  );
  const text = lines.join("\n").replace(/\n{3,}/gu, "\n\n");

  // 3. markers, found on the width-folded view (same indices), numbered by first use of a
  //    verified source, then the verified sources the answer never marks, in citation order
  const view = markerView(text);
  const found = [...view.matchAll(MARKER)].map((m) => ({
    at: m.index,
    end: m.index + m[0].length,
    ids: idsOf(m[1] ?? m[2] ?? ""),
  }));
  const numbers = new Map<string, number>();
  const use = (id: string) => {
    if (verified.has(id) && !numbers.has(id) && numbers.size < QA_AI_MAX_CITATIONS)
      numbers.set(id, numbers.size + 1);
  };
  for (const f of found) for (const id of f.ids) use(id);
  for (const id of citedOrder) use(id);

  // 4. rewrite markers in the ORIGINAL text: verified ones → [n][m]; the rest vanish, with the
  //    single space before them
  let answer = "";
  let pos = 0;
  for (const f of found) {
    const ns = [
      ...new Set(f.ids.map((id) => numbers.get(id)).filter((n): n is number => n !== undefined)),
    ];
    let cut = f.at;
    if (ns.length === 0 && cut > pos && text[cut - 1] === " ") cut -= 1;
    answer += text.slice(pos, cut);
    if (ns.length > 0) answer += ns.map((n) => `[${n}]`).join("");
    pos = f.end;
    // a removed marker that opened a line takes the space after it too
    if (ns.length === 0 && (f.at === 0 || text[f.at - 1] === "\n") && text[pos] === " ") pos += 1;
  }
  answer += text.slice(pos);
  answer = answer
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();

  // 5. the citations and the Sources footer (the only one in the body)
  const citations: QaAiCitation[] = [...numbers.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => {
      const p = byId.get(id) as QaAiPassage;
      return {
        n,
        documentId: p.documentId,
        versionId: p.versionId,
        pageNo: p.pageNo,
        documentTitle: p.documentTitle,
        quote: verified.get(id) ?? "",
      };
    });
  const footer =
    citations.length === 0
      ? ""
      : `\n\nSources:\n${citations
          .map((c) => `[${c.n}] ${titleLine(c.documentTitle)}, p. ${c.pageNo}`)
          .join("\n")}`;
  const outcome =
    output.outcome === "answered" &&
    (citations.length === 0 || answer.replace(/\[\d{1,2}\]/gu, "").trim().length === 0)
      ? "unsupported"
      : output.outcome;
  const body = `${answer.slice(0, Math.max(0, QA_AI_BODY_MAX - footer.length)).trimEnd()}${footer}`;
  return {
    kind: "qa_answer",
    outcome,
    body,
    citations,
    droppedCitations: dropped,
    searchedDocuments,
  };
}

function titleLine(s: string): string {
  return stripInvisible(s).replace(/\s+/gu, " ").trim().slice(0, 200);
}
