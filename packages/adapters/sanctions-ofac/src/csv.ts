/*
 * OFAC's legacy "CSV" files (E3.10; vendors file §3.1): no header row, every text field quoted,
 * `-0-` (sometimes padded: `-0- `) for an empty field, quotes inside a field doubled, line breaks
 * inside a quoted remark, CRLF line ends, and a DOS end-of-file byte (0x1A) on the last line of
 * the older exports. The parser is strict where a truncated or mangled download would show — an
 * unterminated quote or stray text after a closing quote throws — and lenient about the rest.
 */

export class OfacCsvError extends Error {
  override readonly name = "OfacCsvError";
}

/** Splits a whole file into rows of raw field strings (quotes removed, `-0-` kept). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  const endField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    // A blank line (or the lone EOF byte) is no row.
    if (!(row.length === 1 && row[0]?.trim() === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      // CRLF: the LF ends the row; a lone CR is treated as a line end too.
      if (text[i + 1] !== "\n") endRow();
    } else if (ch === "\n") {
      endRow();
      line++;
    } else if (ch === "\u001a") {
      // DOS end-of-file marker.
    } else if (ch === '"') {
      if (field.trim() !== "" || afterQuote) {
        throw new OfacCsvError(`line ${line}: quote inside an unquoted field`);
      }
      field = "";
      quoted = true;
    } else if (afterQuote) {
      if (ch !== " " && ch !== "\t") {
        throw new OfacCsvError(`line ${line}: text after a closing quote`);
      }
    } else {
      field += ch;
    }
  }
  if (quoted) throw new OfacCsvError(`line ${line}: unterminated quoted field (truncated file?)`);
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** A field's value: trimmed, `-0-` → null. */
export function value(field: string | undefined): string | null {
  if (field === undefined) return null;
  const v = field.trim();
  return v === "" || v === "-0-" ? null : v;
}

/** `SDGT] [IFSR` / `[CUBA]` → `["SDGT", "IFSR"]`. */
export function programsOf(field: string | undefined): string[] {
  const v = value(field);
  if (v === null) return [];
  return v
    .split(/\]\s*\[/u)
    .map((p) => p.replace(/[[\]]/gu, "").trim())
    .filter((p) => p.length > 0);
}
