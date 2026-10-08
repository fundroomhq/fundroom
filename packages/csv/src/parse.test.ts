import { describe, expect, it } from "vitest";
import { headerIndex, normalizeHeaderCell, parseCsv, parseCsvRecords } from "./parse.js";

const BOM = "\uFEFF";

/*
 * These assertions are the extraction's contract: every one was captured from the parser while
 * it still lived in `packages/identity/src/services/invite-import.ts` (E2.4 §2 D6) and must keep
 * passing. Bulk investor invitations are addressed from this output — a quiet change here
 * mis-sends real mail — so the surprising cases are pinned deliberately, not incidentally.
 */
describe("parseCsv", () => {
  it("reads a plain LF file", () => {
    expect(parseCsv("email,name\na@x.test,Ann\nb@x.test,Bob")).toEqual([
      ["email", "name"],
      ["a@x.test", "Ann"],
      ["b@x.test", "Bob"],
    ]);
  });

  it("reads CRLF, LF and a mixed file identically", () => {
    const expected = [
      ["email", "name"],
      ["a@x.test", "Ann"],
      ["b@x.test", "Bob"],
    ];
    expect(parseCsv("email,name\r\na@x.test,Ann\r\nb@x.test,Bob")).toEqual(expected);
    expect(parseCsv("email,name\na@x.test,Ann\nb@x.test,Bob")).toEqual(expected);
    expect(parseCsv("email,name\r\na@x.test,Ann\nb@x.test,Bob")).toEqual(expected);
  });

  it("treats a lone CR as a row separator (classic-Mac files)", () => {
    expect(parseCsv("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not split a CRLF into two rows", () => {
    expect(parseCsv("a\r\nb\r\n")).toEqual([["a"], ["b"]]);
  });

  it("strips a leading BOM but leaves one in the middle of the file alone", () => {
    expect(parseCsv(`${BOM}email,name\na@x.test,Ann`)).toEqual([
      ["email", "name"],
      ["a@x.test", "Ann"],
    ]);
    expect(parseCsv(`email,na${BOM}me`)).toEqual([["email", `na${BOM}me`]]);
  });

  it("reads quoted fields containing commas, newlines and doubled quotes", () => {
    expect(parseCsv('email,name\na@x.test,"Doe, Ann"')).toEqual([
      ["email", "name"],
      ["a@x.test", "Doe, Ann"],
    ]);
    expect(parseCsv('email,note\na@x.test,"line one\nline two"')).toEqual([
      ["email", "note"],
      ["a@x.test", "line one\nline two"],
    ]);
    expect(parseCsv('email,note\r\na@x.test,"line one\r\nline two"\r\n')).toEqual([
      ["email", "note"],
      ["a@x.test", "line one\r\nline two"],
    ]);
    expect(parseCsv('email,note\na@x.test,"she said ""hi"""')).toEqual([
      ["email", "note"],
      ["a@x.test", 'she said "hi"'],
    ]);
  });

  it("keeps a whitespace-only quoted cell but drops the row if every cell is blank", () => {
    expect(parseCsv('email,name\na@x.test,"   "')).toEqual([
      ["email", "name"],
      ["a@x.test", "   "],
    ]);
    expect(parseCsv('a,b\n"   ","  "')).toEqual([["a", "b"]]);
  });

  it("does not trim unquoted cells", () => {
    expect(parseCsv("email , name \n a@x.test , Ann ")).toEqual([
      ["email ", " name "],
      [" a@x.test ", " Ann "],
    ]);
  });

  /*
   * Not RFC 4180 — RFC 4180 calls a bare quote in an unquoted field an error. This parser opens
   * quote mode instead and drops the character, so `Ann"Marie` reads as `AnnMarie`. Pinned, not
   * endorsed: files already in the wild were imported under this rule and must keep their
   * meaning. If it ever changes, it changes as a deliberate, announced break.
   */
  it("swallows a bare quote in the middle of an unquoted field", () => {
    expect(parseCsv('email,name\na@x.test,Ann"Marie')).toEqual([
      ["email", "name"],
      ["a@x.test", "AnnMarie"],
    ]);
    expect(parseCsv('"a"x,b')).toEqual([["ax", "b"]]);
  });

  /* Also not RFC 4180: an unterminated quote yields the partial cell rather than raising. */
  it("closes an unterminated quote at end of input instead of throwing", () => {
    expect(parseCsv('email,name\na@x.test,"Ann')).toEqual([
      ["email", "name"],
      ["a@x.test", "Ann"],
    ]);
    expect(parseCsv('"')).toEqual([]);
    expect(parseCsv('email,name\n"')).toEqual([["email", "name"]]);
  });

  it("returns no rows for empty, blank and separator-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n")).toEqual([]);
    expect(parseCsv("\r\n")).toEqual([]);
    expect(parseCsv(BOM)).toEqual([]);
    expect(parseCsv(",,,\n")).toEqual([]);
    expect(parseCsv('""\n')).toEqual([]);
  });

  it("reads a header-only file, with or without a trailing newline", () => {
    const expected = [["email", "name", "firm"]];
    expect(parseCsv("email,name,firm")).toEqual(expected);
    expect(parseCsv("email,name,firm\n")).toEqual(expected);
    expect(parseCsv("email,name,firm\r\n")).toEqual(expected);
  });

  it("drops blank and whitespace-only rows wherever they appear", () => {
    expect(parseCsv("email,name\n\na@x.test,Ann\n\n\nb@x.test,Bob\n")).toEqual([
      ["email", "name"],
      ["a@x.test", "Ann"],
      ["b@x.test", "Bob"],
    ]);
    expect(parseCsv("email,name\n   ,\t\na@x.test,Ann")).toEqual([
      ["email", "name"],
      ["a@x.test", "Ann"],
    ]);
  });

  it("keeps ragged rows ragged — padding is the caller's policy, not the parser's", () => {
    expect(parseCsv("a,b,c\n1,2\n3,4,5,6\n7")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["3", "4", "5", "6"],
      ["7"],
    ]);
  });

  it("keeps empty leading and trailing cells", () => {
    expect(parseCsv(",email,name\n,a@x.test,Ann")).toEqual([
      ["", "email", "name"],
      ["", "a@x.test", "Ann"],
    ]);
    expect(parseCsv("email,name,\na@x.test,Ann,")).toEqual([
      ["email", "name", ""],
      ["a@x.test", "Ann", ""],
    ]);
  });

  it("passes non-ASCII through untouched", () => {
    expect(parseCsv("email,name\nzoë@x.test,Zoë ☃")).toEqual([
      ["email", "name"],
      ["zoë@x.test", "Zoë ☃"],
    ]);
  });
});

describe("parseCsvRecords", () => {
  it("gives each record the physical line it starts on (quoted line breaks and blank lines count)", () => {
    const text = 'h1,h2\r\na,"multi\r\nline\nfield"\n\n  \nb,c\rd,"x\ry"\ne,f';
    expect(parseCsvRecords(text)).toEqual([
      { cells: ["h1", "h2"], line: 1 },
      { cells: ["a", "multi\r\nline\nfield"], line: 2 },
      { cells: ["b", "c"], line: 7 },
      { cells: ["d", "x\ry"], line: 8 },
      { cells: ["e", "f"], line: 10 },
    ]);
  });

  it("parses exactly what parseCsv parses", () => {
    const text = '\uFEFFa,b\n"q""x",\n,,\nlast';
    expect(parseCsvRecords(text).map((r) => r.cells)).toEqual(parseCsv(text));
  });
});

describe("normalizeHeaderCell", () => {
  it("trims, lower-cases and collapses inner whitespace to underscores", () => {
    expect(normalizeHeaderCell("  Expires At  ")).toBe("expires_at");
    expect(normalizeHeaderCell("expires_at")).toBe("expires_at");
    expect(normalizeHeaderCell("Period\tKey")).toBe("period_key");
    expect(normalizeHeaderCell("A   B")).toBe("a_b");
    expect(normalizeHeaderCell("   ")).toBe("");
  });

  it("matches the mapping the invite importer has always used", () => {
    const identity = (h: string) => h.trim().toLowerCase().replace(/\s+/gu, "_");
    for (const h of ["email", " Name ", "FIRM", "Groups", "expires at", "Note", "", "  a  b  "])
      expect(normalizeHeaderCell(h)).toBe(identity(h));
  });
});

describe("headerIndex", () => {
  it("maps normalised column names to their position", () => {
    const result = headerIndex(["Email", " Display Name ", "GROUPS"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.columns]).toEqual([
      ["email", 0],
      ["display_name", 1],
      ["groups", 2],
    ]);
  });

  it("refuses a duplicate column by name rather than picking one", () => {
    expect(headerIndex(["period", "value", " Value "])).toEqual({
      ok: false,
      duplicateColumn: "value",
    });
  });

  it("skips blank cells, so trailing commas in the header are not a duplicate", () => {
    const result = headerIndex(["period", "value", "", "   "]);
    expect(result).toEqual({
      ok: true,
      columns: new Map([
        ["period", 0],
        ["value", 1],
      ]),
    });
  });

  it("returns an empty map for an empty header row", () => {
    const result = headerIndex([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.columns.size).toBe(0);
  });
});
