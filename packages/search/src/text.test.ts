import { describe, expect, it } from "vitest";
import {
  buildQueries,
  cleanText,
  HIGHLIGHT_STOP as E,
  hasUnspacedScript,
  MAX_QUERY_LEXEMES,
  MAX_QUERY_TERMS,
  MAX_SNIPPET_CHARS,
  queryWords,
  quoteLexeme,
  HIGHLIGHT_START as S,
  splitHeadline,
  truncateChars,
} from "./text.js";

/**
 * Splits tsquery input into operands, honouring quotes: every operand must be ONE quoted string
 * (with `''` / `\\` escapes inside) plus an optional `:*`/weight label — nothing else.
 */
function operands(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    expect(q[i], `operand starts with a quote at ${i} in ${q}`).toBe("'");
    let j = i + 1;
    for (;;) {
      if (j >= q.length) throw new Error(`unterminated operand in ${q}`);
      if (q[j] === "\\") j += 2;
      else if (q[j] === "'" && q[j + 1] === "'") j += 2;
      else if (q[j] === "'") break;
      else j += 1;
    }
    const label = /^(:\*?[AC]?)?/u.exec(q.slice(j + 1))?.[0] ?? "";
    out.push(q.slice(i, j + 1 + label.length));
    i = j + 1 + label.length;
    const sep = /^ [&|] /u.exec(q.slice(i));
    if (sep === null) break;
    i += sep[0].length;
  }
  expect(i, `trailing text in ${q}`).toBe(q.length);
  return out;
}

describe("queryWords", () => {
  it("splits on whitespace only: compound tokens reach the Postgres parser whole", () => {
    expect(queryWords("john.doe@acme.com  report_final.pdf\tQ3-2025 $1.5M")).toEqual([
      "john.doe@acme.com",
      "report_final.pdf",
      "Q3-2025",
      "$1.5M",
    ]);
    expect(queryWords("Überblick 東京 данные")).toEqual(["Überblick", "東京", "данные"]);
  });

  it("normalises to NFC and replaces control characters", () => {
    expect(queryWords("cafe\u0301")).toEqual(["café"]);
    expect(queryWords("a\u0002b\u0003")).toEqual(["a", "b"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(queryWords("Deck deck DECK plan")).toEqual(["Deck", "plan"]);
  });

  it("returns nothing for blank queries", () => {
    for (const q of ["", "   ", "\u0000\u0002\u0003", "\n\t"]) expect(queryWords(q)).toEqual([]);
  });

  it("caps the number of words", () => {
    const many = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    expect(queryWords(many)).toHaveLength(MAX_QUERY_TERMS);
  });

  it("handles a huge input quickly", () => {
    const q = "lorem ipsum ".repeat(200_000);
    const t0 = Date.now();
    expect(queryWords(q)).toEqual(["lorem", "ipsum"]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("spots scripts written without spaces", () => {
    expect(hasUnspacedScript("秘密保持契約書")).toBe(true);
    expect(hasUnspacedScript("カタカナ")).toBe(true);
    expect(hasUnspacedScript("한국어")).toBe(true);
    expect(hasUnspacedScript("données naïve")).toBe(false);
  });
});

describe("quoteLexeme", () => {
  it("quotes a lexeme as one literal tsquery operand", () => {
    expect(quoteLexeme("pitch")).toBe("'pitch'");
    expect(quoteLexeme("it's")).toBe("'it''s'");
    expect(quoteLexeme("a\\b")).toBe("'a\\\\b'");
    expect(quoteLexeme("x':* | !y")).toBe("'x'':* | !y'");
  });
});

describe("buildQueries", () => {
  it("ANDs lexemes, the last word's as prefixes, and derives title/body variants", () => {
    expect(buildQueries([["pitch"], ["de"]], "pitch de")).toEqual({
      all: "'pitch' & 'de':*",
      title: "'pitch':A & 'de':*A",
      bodyAny: "'pitch':C | 'de':*C",
      plain: "pitch de",
      unspaced: false,
    });
  });

  it("prefixes every lexeme of a compound last word (a partly typed Q3-20 still matches)", () => {
    expect(buildQueries([["revenue"], ["-20", "q3"]], "revenue Q3-20")?.all).toBe(
      "'revenue' & '-20':* & 'q3':*",
    );
  });

  it("drops words that produced no lexeme; undefined when none did", () => {
    expect(buildQueries([["run"], []], "run !!!")?.all).toBe("'run':*");
    expect(buildQueries([[], []], "!!! ???")).toBeUndefined();
    expect(buildQueries([], "")).toBeUndefined();
  });

  it("dedupes and caps lexemes, keeping the last word's", () => {
    const head = Array.from({ length: 60 }, (_, i) => [`w${i}`]);
    const built = buildQueries([...head, ["tail"]], "x");
    const ops = operands(built?.all ?? "");
    expect(ops).toHaveLength(MAX_QUERY_LEXEMES);
    expect(ops.at(-1)).toBe("'tail':*");
    expect(buildQueries([["a"], ["a"]], "a a")?.all).toBe("'a':*");
  });

  it("never lets a lexeme's characters act as tsquery syntax", () => {
    // Whatever Postgres's parser returns as a lexeme (URLs, paths and hosts keep punctuation) is
    // one quoted operand: each variant parses back into exactly one operand per lexeme.
    const hostile = [
      "foo':*",
      "a|b",
      "!x",
      "(y)",
      "<->",
      "'; DROP TABLE core.search_entry; --",
      "back\\slash'",
      "💥",
      "$$",
    ];
    const built = buildQueries([hostile.slice(0, 5), hostile.slice(5)], "x");
    for (const key of ["all", "title", "bodyAny"] as const) {
      expect(operands(built?.[key] ?? "")).toHaveLength(hostile.length);
    }
  });

  it("flags CJK/Thai queries for the title substring fallback", () => {
    expect(buildQueries([["契約"]], "契約")?.unspaced).toBe(true);
  });
});

describe("cleanText / truncateChars", () => {
  it("replaces control characters (incl. the highlight delimiters) but keeps tab/newline", () => {
    expect(cleanText(`a\u0000b${S}c${E}d\te\nf\rg\u007f`)).toBe("a b c d\te\nf\rg ");
  });

  it("never splits a surrogate pair", () => {
    const s = `ab${"😀".repeat(3)}`; // a b + 3 × (2 units)
    expect(truncateChars(s, 3)).toBe("ab");
    expect(truncateChars(s, 4)).toBe("ab😀");
    expect(truncateChars(s, 100)).toBe(s);
    const cut = truncateChars("😀".repeat(150_000), 200_000);
    expect(cut.length).toBe(200_000);
    expect(cut.isWellFormed()).toBe(true);
    const odd = truncateChars(`x${"😀".repeat(150_000)}`, 200_000);
    expect(odd.length).toBe(199_999);
    expect(odd.isWellFormed()).toBe(true);
  });
});

describe("splitHeadline", () => {
  it("splits delimited highlights into segments", () => {
    expect(splitHeadline(`The ${S}runway${E} is 18 months of ${S}run${E}way`)).toEqual([
      { text: "The ", highlight: false },
      { text: "runway", highlight: true },
      { text: " is 18 months of ", highlight: false },
      { text: "run", highlight: true },
      { text: "way", highlight: false },
    ]);
  });

  it("collapses whitespace and trims the ends", () => {
    expect(splitHeadline(`\n  a\n\n  ${S}b${E}  \t c  \n`)).toEqual([
      { text: "a ", highlight: false },
      { text: "b", highlight: true },
      { text: " c", highlight: false },
    ]);
  });

  it("never yields markup-bearing structure: HTML in the body stays literal text", () => {
    const segs = splitHeadline(`<script>alert(1)</script> ${S}<b>x</b>${E}`);
    expect(segs).toEqual([
      { text: "<script>alert(1)</script> ", highlight: false },
      { text: "<b>x</b>", highlight: true },
    ]);
  });

  it("tolerates unbalanced and repeated delimiters", () => {
    expect(splitHeadline(`${E}a${S}${S}b${E}${E}c${S}`)).toEqual([
      { text: "a", highlight: false },
      { text: "b", highlight: true },
      { text: "c", highlight: false },
    ]);
    expect(splitHeadline(`${S}${E}`)).toEqual([]);
    expect(splitHeadline("")).toEqual([]);
  });

  it("merges adjacent segments of the same kind and drops stray control characters", () => {
    expect(splitHeadline(`${S}a${E}${S}b${E}\u0001c`)).toEqual([
      { text: "ab", highlight: true },
      { text: " c", highlight: false },
    ]);
  });

  it("caps the snippet length", () => {
    const segs = splitHeadline(`${"x ".repeat(5_000)}${S}hit${E}`);
    const total = segs.reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });
});
