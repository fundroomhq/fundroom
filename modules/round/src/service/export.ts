import type { CommitmentRecord, RoundRecord } from "../repos/round-repo.js";

/*
 * The commitments CSV (§R). Step-up guarded and audited on the route, because a list of who put
 * in how much is the single most sensitive export this product has — design/05 §122 names
 * "cap-table/round export" as the example of what step-up is for.
 *
 * Written here rather than pulled from a package so the column order is a *frozen* part of the
 * export: somebody has a spreadsheet keyed on it, and a library that grew a quoting option
 * would silently move their columns.
 */

/** The header row, and the order every data row follows. */
export const CSV_COLUMNS = [
  "id",
  "name",
  "status",
  "amount",
  "currency",
  "created_at",
  "wired_at",
] as const;

/**
 * RFC 4180 quoting, plus one hardening rule: a field whose first character could be read as a
 * formula by a spreadsheet is prefixed with a single quote.
 *
 * A commitment's `display_name` is tenant-supplied free text, and a name beginning `=` or `+`
 * opens as a live formula in Excel and Sheets — the CSV-injection class of bug. Prefixing costs
 * a leading apostrophe in a cell nobody computes on and removes the class entirely.
 */
export function csvField(value: string | null | undefined): string {
  const raw = value ?? "";
  const guarded = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/u.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

const iso = (d: Date | null): string => (d === null ? "" : d.toISOString());

/**
 * One row per commitment, newest first — including withdrawn ones.
 *
 * The export is the *record*, not the tracker: a withdrawal is a thing that happened and a
 * finance team reconciling a bank statement needs to see it, even though `allocation()`
 * deliberately excludes it from every bucket. `status` is the column that tells them apart.
 */
export function commitmentsCsv(
  round: Pick<RoundRecord, "currency">,
  commitments: readonly CommitmentRecord[],
  names: ReadonlyMap<string, string>,
): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const c of commitments) {
    const name =
      c.displayName ?? (c.membershipId === null ? null : (names.get(c.membershipId) ?? null));
    lines.push(
      [
        csvField(c.id),
        csvField(name),
        csvField(c.status),
        csvField(c.amount),
        csvField(round.currency),
        csvField(iso(c.createdAt)),
        csvField(iso(c.wiredAt)),
      ].join(","),
    );
  }
  // Trailing newline: a CSV without one is a file whose last line some tools drop.
  return `${lines.join("\r\n")}\r\n`;
}

/** `round-<slug-ish name>-commitments.csv`, safe for a `Content-Disposition` filename. */
export function csvFilename(round: Pick<RoundRecord, "name">): string {
  const slug =
    round.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "round";
  return `${slug}-commitments.csv`;
}
