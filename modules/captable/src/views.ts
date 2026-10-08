import type { ImportPlan } from "./import-plan.js";
import {
  type CaptableSummary,
  type CurrencyAmount,
  computeSummary,
  decimalText,
  fullyDilutedByClass,
  fullyDilutedByLine,
  holderKey,
  parseQuantity,
  percentText,
  SHARES_INTEGRAL_DIGITS,
  type SummaryClass,
  type SummaryLine,
  totalOf,
} from "./model.js";
import type { ClassRow, HoldingRow, SnapshotRow } from "./repos/captable-repo.js";

/*
 * Response shaping (pure). Rows in, the JSON the contracts describe out. The stored `totals` is
 * the summary computed at import; a snapshot is immutable, so it is returned as stored — except
 * that a summary that does not parse (hand-edited, a future schema) is recomputed from the rows
 * by the caller rather than served half-read.
 */

/** A numeric column's text → fixed point. A value the column held always parses. */
export const fixed = (v: string | null): bigint | null => {
  if (v === null) return null;
  const parsed = parseQuantity(v, SHARES_INTEGRAL_DIGITS);
  if (parsed === undefined) throw new Error(`unparseable numeric ${JSON.stringify(v)}`);
  return parsed;
};

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function isSummary(v: unknown): v is CaptableSummary {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["fullyDilutedShares"] === "string" &&
    Array.isArray(o["classes"]) &&
    Array.isArray(o["convertiblesOutstanding"]) &&
    typeof o["holderCount"] === "number"
  );
}

const EMPTY_SUMMARY: CaptableSummary = computeSummary([], []);

export function snapshotBody(row: SnapshotRow, summary?: CaptableSummary) {
  return {
    id: row.id,
    asOf: row.asOf,
    source: row.source,
    status: row.status,
    note: row.note,
    importedBy: row.importedBy,
    createdAt: row.createdAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    summary: summary ?? (isSummary(row.totals) ? row.totals : EMPTY_SUMMARY),
  };
}

/** Rows of a snapshot as the summary functions take them. */
export function summaryInputs(
  classes: readonly ClassRow[],
  holdings: readonly HoldingRow[],
): { classes: SummaryClass[]; lines: SummaryLine[] } {
  const index = new Map(classes.map((c, i) => [c.id, i]));
  return {
    classes: classes.map((c) => ({ name: c.name, kind: c.kind, position: c.position })),
    lines: holdings.map((h) => ({
      classIndex: index.get(h.classId) ?? -1,
      holderName: h.holderName,
      holderEmail: h.holderEmail,
      membershipId: h.membershipId,
      shares: fixed(h.shares),
      amount: fixed(h.amount),
      currency: h.currency,
    })),
  };
}

function amountsOf(lines: readonly SummaryLine[]): CurrencyAmount[] {
  const by = new Map<string, bigint>();
  for (const l of lines) {
    if (l.amount === null || l.currency === null) continue;
    by.set(l.currency, (by.get(l.currency) ?? 0n) + l.amount);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount: decimalText(amount) }));
}

export function snapshotDetailBody(
  row: SnapshotRow,
  classRows: readonly ClassRow[],
  holdings: readonly HoldingRow[],
) {
  const { classes, lines } = summaryInputs(classRows, holdings);
  const byLine = fullyDilutedByLine(classes, lines);
  const total = totalOf(fullyDilutedByClass(classes, lines));
  const groups = new Map<string, { first: HoldingRow; idx: number[] }>();
  holdings.forEach((h, i) => {
    const key = holderKey(h);
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { first: h, idx: [i] });
    else g.idx.push(i);
  });
  const holders = [...groups.entries()]
    .map(([key, g]) => {
      const fd = totalOf(g.idx.map((i) => byLine[i] ?? 0n));
      return {
        key,
        holderName: g.first.holderName,
        holderEmail: g.first.holderEmail,
        membershipId: g.first.membershipId,
        fd,
        fullyDilutedShares: decimalText(fd),
        percentFullyDiluted: percentText(fd, total),
        amounts: amountsOf(g.idx.map((i) => lines[i]).filter((l) => l !== undefined)),
        lines: g.idx.length,
      };
    })
    .sort((a, b) =>
      a.fd === b.fd ? a.holderName.localeCompare(b.holderName) : a.fd > b.fd ? -1 : 1,
    )
    .map(({ fd: _fd, ...rest }) => rest);
  const classById = new Map(classRows.map((c) => [c.id, c]));
  return {
    snapshot: snapshotBody(
      row,
      isSummary(row.totals) ? row.totals : computeSummary(classes, lines),
    ),
    holders,
    holdings: holdings.map((h) => ({
      id: h.id,
      classId: h.classId,
      className: classById.get(h.classId)?.name ?? "",
      kind: classById.get(h.classId)?.kind ?? "common",
      holderName: h.holderName,
      holderEmail: h.holderEmail,
      membershipId: h.membershipId,
      shares: h.shares === null ? null : decimalText(fixed(h.shares) ?? 0n),
      amount: h.amount === null ? null : decimalText(fixed(h.amount) ?? 0n),
      currency: h.currency,
      issuedOn: h.issuedOn,
      erased: h.erasedAt !== null,
    })),
  };
}

export function previewBody(plan: ImportPlan, asOf: string) {
  return {
    format: plan.format,
    source: plan.source,
    asOf,
    rows: plan.rows,
    matched: plan.matched,
    unmatched: plan.unmatched,
    summary: plan.summary,
    warnings: plan.warnings.map((w) => ({ ...w })),
    lines: plan.lines.map((l) => {
      const c = plan.classes[l.classIndex];
      return {
        line: l.line,
        holderName: l.holderName,
        holderEmail: l.holderEmail,
        membershipId: l.membershipId,
        className: c?.name ?? "",
        kind: c?.kind ?? "common",
        shares: l.shares === null ? null : decimalText(l.shares),
        amount: l.amount === null ? null : decimalText(l.amount),
        currency: l.currency,
        issuedOn: l.issuedOn,
      };
    }),
  };
}
