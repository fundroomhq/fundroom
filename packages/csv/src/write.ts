/*
 * The one CSV *writer* guard. Every CSV this product hands a person may be opened in a
 * spreadsheet, and a tenant- or member-controlled cell beginning `=`, `+`, `-`, `@`, TAB or CR is
 * a formula there (CSV injection). Prefixing an apostrophe is the fix everybody lands on; it is
 * visible in the cell, which is the point, and it is applied *before* quoting so the apostrophe
 * itself is inside the field.
 *
 * `packages/compliance` (`csvField`), `modules/analytics` and `modules/round` carry older copies
 * of the same two regexes; new writers import this one.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;
const NEEDS_QUOTES = /[",\r\n]/u;

/** One RFC 4180 field: formula-guarded, then quoted when it contains `"`, `,`, CR or LF. */
export function csvField(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One CRLF-terminated record. */
export function csvRecord(values: readonly string[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}
