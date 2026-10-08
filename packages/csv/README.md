# @fundroom/csv

The one CSV reader. Extracted verbatim from the bulk-invite importer when the KPI
importer became its second consumer; a second hand-rolled parser is the next person's bug. No
dependencies, no I/O — callers hand it a string they already decoded.

- `parseCsv` — RFC 4180-ish: quoted fields, doubled `""` escapes, CRLF or LF (or a bare CR), a
  leading BOM stripped, all-blank rows dropped. Never throws.
- `normalizeHeaderCell` / `headerIndex` — the header row read the way importers read it
  (`trim`, lower-case, inner whitespace to `_`), as a column-name → index map. Duplicate columns
  are refused by name rather than resolved first-wins: an import that writes the wrong column is
  worse than one that will not start.

The parser keeps three quirks that are not RFC 4180 because they are quirks we already shipped
and an existing CSV must keep meaning what it meant: a bare `"` inside an unquoted field opens
quote mode and is dropped, an unterminated quote at EOF yields the partial cell instead of an
error, and a lone `\r` separates rows. `parse.test.ts` pins all three.

The invite-specific column mapping, the `INVITE_IMPORT_MAX_ROWS` cap and the invite reason codes
stayed in `packages/identity`: they are policy, not parsing.
