/*
 * The one CSV reader (E2.4 §2 D6). This parser was private to the bulk-invite importer
 * (`packages/identity/src/services/invite-import.ts`) until the KPI importer needed the same
 * bytes read the same way; a second copy is the next person's bug, so it moved here verbatim
 * rather than being rewritten. Behaviour is pinned by `parse.test.ts` against the output the
 * invite importer produced before the move — bulk investor invitations are parsed by this
 * function and a quiet change would mis-address real mail.
 *
 * No dependencies and no I/O: callers hand it a string they already decoded. A third-party
 * parser was the rejected alternative — every candidate is larger than this file, and the
 * quirks below (a bare quote mid-field, an unterminated quote at EOF) are quirks *we already
 * shipped*, so adopting a stricter parser would change what an existing CSV means.
 */

/** A leading UTF-8 BOM, which Excel writes and which is not part of the first header cell. */
const BOM = "\uFEFF";

/**
 * RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Returns rows of cells.
 *
 * Deliberate departures from RFC 4180, all of them long-standing invite-import behaviour:
 * a bare `"` inside an unquoted field opens quote mode and is dropped rather than raising;
 * an unterminated quote at EOF yields the partial cell instead of an error; a lone `\r` is a
 * row separator (classic-Mac files); and rows whose cells are all blank are dropped, so a
 * trailing newline or a blank line between records costs nothing.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((r) => r.cells);
}

/** One record of `parseCsvRecords`: its cells and the physical line it starts on. */
export interface CsvRecord {
  readonly cells: string[];
  /**
   * 1-based physical line of the file on which the record begins. A quoted field spanning
   * lines makes the next record start further down; blank lines still count. CRLF, LF and a
   * lone CR are each one line break.
   */
  readonly line: number;
}

/**
 * `parseCsv` with each record's starting line (for error messages a person can find in their
 * editor). Same parsing, same blank-row dropping — `parseCsv` is this minus the line numbers.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        cell += ch;
        // A line break inside a quoted field is data, but still a physical line of the file.
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line += 1;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push({ cells: row, line: rowLine });
      line += 1;
      rowLine = line;
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push({ cells: row, line: rowLine });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim().length > 0));
}

/**
 * The column name a header cell stands for: trimmed, lower-cased, inner runs of whitespace
 * collapsed to `_`. `" Expires At "` and `"expires_at"` are the same column, which is what a
 * human filling in a spreadsheet expects and what the invite importer has always done.
 */
export function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/gu, "_");
}

/**
 * The outcome of reading a header row. A duplicate is a refusal rather than a silent
 * first-wins pick: when a file carries two `value` columns nobody can say which one the
 * importer read, and an import that writes the wrong column is worse than one that will not
 * start. The failure names the column so the caller can say which one.
 */
export type HeaderIndex =
  | { readonly ok: true; readonly columns: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly duplicateColumn: string };

/**
 * Builds the column-name → index map a header-driven importer reads rows through.
 *
 * Blank cells are skipped rather than indexed: a trailing comma in the header row is a
 * formatting accident, it names no column, and two of them must not read as a duplicate.
 */
export function headerIndex(cells: readonly string[]): HeaderIndex {
  const columns = new Map<string, number>();
  for (let i = 0; i < cells.length; i++) {
    const name = normalizeHeaderCell(cells[i] ?? "");
    if (name.length === 0) continue;
    if (columns.has(name)) return { ok: false, duplicateColumn: name };
    columns.set(name, i);
  }
  return { ok: true, columns };
}
