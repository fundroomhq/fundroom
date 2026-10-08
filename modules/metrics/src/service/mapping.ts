import { headerIndex, normalizeHeaderCell } from "@fundroom/csv";
import { parseFixed } from "../decimal.js";
import { formatPeriodKey, type PeriodKind, parsePeriodKey } from "../period.js";

/*
 * Turning a rectangle of cells into planned metric points — shared by the CSV importer
 * (§9 `/import`) and by the Google Sheets sync (§8), because a sheet *is* a CSV that arrived
 * over HTTPS and the two must not disagree about what a file means.
 *
 * Pure: no database, no clock, no I/O. Everything it decides is reported per row and per cell
 * with a machine-readable `reason`, so the dry-run preview, the stored import row and the
 * admin screen all read the same vocabulary and nobody has to parse an English sentence.
 *
 * **We enforce our own row cap.** `@fundroom/csv` has none — contract §12 C5 is explicit
 * about that: the invite importer's cap stayed in identity rather than becoming a second,
 * differently-shaped cap on a pure parser. So the ceiling lives here and the refusal says what
 * it is, because "the file was too big" without a number is not actionable.
 */

/**
 * Data rows one import may carry. Generous for the shape this actually is — a metric export is
 * one row per period, so 5 000 rows is four centuries of months — and low enough that the
 * worker's per-row transaction budget stays bounded.
 */
export const METRICS_IMPORT_MAX_ROWS = 5000;

export interface CsvMapping {
  /** Header cell (normalised) holding the period: `2026-03`, `2026-Q1`, `2026`, or a date pair. */
  readonly periodColumn: string;
  readonly periodKind: PeriodKind;
  /** Which remaining columns are which metric, by the definition's stable key. */
  readonly columns: readonly { readonly column: string; readonly key: string }[];
}

export type PlannedCellStatus = "ok" | "skipped" | "error";
export type PlannedRowStatus = "ok" | "skipped" | "error" | "applied" | "failed";

export interface PlannedCell {
  readonly key: string;
  readonly column: string;
  /** The cell text as it will be parsed; `null` when there is nothing to write. */
  readonly value: string | null;
  readonly status: PlannedCellStatus;
  /** `blank` | `not_a_number` | `unknown_metric` | `column_missing`. */
  readonly reason?: string | undefined;
}

export interface PlannedRow {
  /** 1-based line in the file, header included — what the admin sees in their spreadsheet. */
  readonly line: number;
  readonly periodKey: string;
  status: PlannedRowStatus;
  reason?: string | undefined;
  readonly cells: readonly PlannedCell[];
}

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  /** The header as normalised, so a mapping that names no real column can be corrected. */
  readonly columns: readonly string[];
}

export interface PlanSummary {
  readonly ok: number;
  readonly skipped: number;
  readonly error: number;
  readonly values: number;
}

export function summarise(rows: readonly PlannedRow[]): PlanSummary {
  return {
    ok: rows.filter((r) => r.status === "ok").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    error: rows.filter((r) => r.status === "error").length,
    values: rows.reduce(
      (n, r) => n + (r.status === "ok" ? r.cells.filter((c) => c.status === "ok").length : 0),
      0,
    ),
  };
}

const failedFile = (columns: readonly string[], reason: string): ImportPlan => ({
  columns,
  rows: [{ line: 1, periodKey: "", status: "error", reason, cells: [] }],
});

/**
 * Plans every row of `raw` (row 0 is the header).
 *
 * `knownKeys` is the set of live definition keys in the workspace; a mapping naming anything
 * else produces a per-cell `unknown_metric` rather than a whole-file failure, because the
 * common case is one stale column in an otherwise correct mapping and the admin needs to see
 * which one.
 */
export function planImport(
  raw: readonly (readonly string[])[],
  mapping: CsvMapping,
  knownKeys: ReadonlySet<string>,
): ImportPlan {
  const header = (raw[0] ?? []).map(normalizeHeaderCell);
  const index = headerIndex(header);
  if (!index.ok) {
    return failedFile(header, `duplicate_column:${index.duplicateColumn}`);
  }
  const periodAt = index.columns.get(normalizeHeaderCell(mapping.periodColumn));
  if (periodAt === undefined) return failedFile(header, "period_column_missing");

  /*
   * Resolve the mapping against the header once. A column the file does not have, and a key
   * the workspace does not have, are both permanent facts about this run — evaluating them per
   * row would report the same problem 5 000 times.
   */
  const resolved = mapping.columns.map((m) => {
    const at = index.columns.get(normalizeHeaderCell(m.column));
    const reason =
      at === undefined ? "column_missing" : knownKeys.has(m.key) ? undefined : "unknown_metric";
    return { key: m.key, column: m.column, at, reason };
  });

  const rows: PlannedRow[] = [];
  const seenPeriods = new Set<string>();
  let dataRows = 0;
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i] ?? [];
    const line = i + 1;
    if (dataRows >= METRICS_IMPORT_MAX_ROWS) {
      // Report the ceiling once, at the row that crossed it, and stop reading: the same shape
      // `parseInviteCsv` uses, and the message names the number so it is actionable.
      if (dataRows === METRICS_IMPORT_MAX_ROWS) {
        rows.push({
          line,
          periodKey: "",
          status: "error",
          reason: `too_many_rows:${METRICS_IMPORT_MAX_ROWS}`,
          cells: [],
        });
        dataRows += 1;
      }
      break;
    }
    dataRows += 1;

    const periodText = (cells[periodAt] ?? "").trim();
    if (periodText === "") {
      rows.push({ line, periodKey: "", status: "error", reason: "missing_period", cells: [] });
      continue;
    }
    const period = parsePeriodKey(mapping.periodKind, periodText);
    if (period === undefined) {
      rows.push({
        line,
        periodKey: periodText,
        status: "error",
        reason: "unreadable_period",
        cells: [],
      });
      continue;
    }
    const periodKey = formatPeriodKey(period);
    if (seenPeriods.has(periodKey)) {
      /*
       * The last row would win, quietly, and the difference between the two would look like a
       * restatement in the audit trail. Refusing to guess is the honest answer: the admin fixes
       * their file and knows which number they meant.
       */
      rows.push({ line, periodKey, status: "skipped", reason: "duplicate_period", cells: [] });
      continue;
    }
    seenPeriods.add(periodKey);

    const planned: PlannedCell[] = resolved.map((r) => {
      if (r.reason !== undefined) {
        return { key: r.key, column: r.column, value: null, status: "error", reason: r.reason };
      }
      const text = (cells[r.at as number] ?? "").trim();
      if (text === "") {
        // A blank cell is not a zero: the month simply has no figure for this metric.
        return { key: r.key, column: r.column, value: null, status: "skipped", reason: "blank" };
      }
      if (parseFixed(text) === undefined) {
        return {
          key: r.key,
          column: r.column,
          value: text,
          status: "error",
          reason: "not_a_number",
        };
      }
      return { key: r.key, column: r.column, value: text, status: "ok" };
    });

    const usable = planned.some((c) => c.status === "ok");
    const broken = planned.some((c) => c.status === "error");
    rows.push({
      line,
      periodKey,
      // A row with one good number and one bad one still imports the good one; the bad cell is
      // in the preview with its reason. A row with nothing usable says which it was.
      status: usable ? "ok" : broken ? "error" : "skipped",
      ...(usable ? {} : { reason: broken ? "no_usable_values" : "no_values" }),
      cells: planned,
    });
  }
  return { rows, columns: header };
}
