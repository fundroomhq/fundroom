/*
 * The hot-list CSV (E2.6, design/03 G2 "export"). Pure, unit tested next door.
 *
 * Two escaping jobs, and they are not the same job (the reasoning is the compliance register's,
 * packages/compliance/src/service/register.ts). RFC 4180 quoting makes the file *parseable*; it
 * does nothing about Excel, LibreOffice and Google Sheets executing a cell that begins `=`, `+`,
 * `-` or `@` (or a tab or carriage return before one) as a formula. A display name is chosen by
 * the member it names — an investor calling themselves `=HYPERLINK("http://evil","x")` would
 * otherwise run in the admin's spreadsheet. The apostrophe prefix is applied *before* quoting,
 * so it sits inside the field and is visible in the cell, which is the point.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;
const NEEDS_QUOTES = /[",\r\n]/u;

export function csvField(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export const HOT_LIST_CSV_COLUMNS = [
  "rank",
  "membership_id",
  "name",
  "role",
  "score",
  "views",
  "dwell_seconds",
  "downloads",
  "human_opens",
  "clicks",
  "automated_opens",
  "last_activity_at",
] as const;

export interface HotListCsvRow {
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: string;
  readonly score: number;
  readonly counts: {
    readonly views: number;
    readonly dwellMs: number;
    readonly downloads: number;
    readonly humanOpens: number;
    readonly clicks: number;
    readonly automatedOpens: number;
  };
  readonly lastActivityAt: string | null;
}

/** RFC 4180, CRLF line endings, UTF-8 BOM (Excel mangles a non-ASCII name without it). */
export function hotListCsv(rows: readonly HotListCsvRow[]): string {
  const lines = [HOT_LIST_CSV_COLUMNS.join(",")];
  rows.forEach((r, i) => {
    lines.push(
      [
        String(i + 1),
        r.membershipId,
        r.displayName,
        r.role,
        String(r.score),
        String(r.counts.views),
        String(Math.round(r.counts.dwellMs / 1000)),
        String(r.counts.downloads),
        String(r.counts.humanOpens),
        String(r.counts.clicks),
        String(r.counts.automatedOpens),
        r.lastActivityAt ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  });
  return `﻿${lines.join("\r\n")}\r\n`;
}
