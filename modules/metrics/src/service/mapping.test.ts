import { parseCsv } from "@fundroom/csv";
import { describe, expect, it } from "vitest";
import { type CsvMapping, METRICS_IMPORT_MAX_ROWS, planImport, summarise } from "./mapping.js";

/*
 * The CSV / sheet planner. Pure, so these are the tests that actually decide what an import
 * means; the worker below it only replays what this decided.
 */

const MAPPING: CsvMapping = {
  periodColumn: "period",
  periodKind: "month",
  columns: [
    { column: "cash", key: "cash" },
    { column: "Net Burn", key: "net_burn" },
  ],
};

const KEYS = new Set(["cash", "net_burn"]);
const plan = (csv: string, mapping: CsvMapping = MAPPING, keys = KEYS) =>
  planImport(parseCsv(csv), mapping, keys);

describe("planImport", () => {
  it("maps the admin's chosen columns onto metric keys", () => {
    const p = plan("period,cash,Net Burn\n2026-01,1000,250\n2026-02,900,300\n");
    expect(p.columns).toEqual(["period", "cash", "net_burn"]);
    expect(p.rows.map((r) => [r.line, r.periodKey, r.status])).toEqual([
      [2, "2026-01", "ok"],
      [3, "2026-02", "ok"],
    ]);
    expect(p.rows[0]?.cells).toEqual([
      { key: "cash", column: "cash", value: "1000", status: "ok" },
      { key: "net_burn", column: "Net Burn", value: "250", status: "ok" },
    ]);
    expect(summarise(p.rows)).toEqual({ ok: 2, skipped: 0, error: 0, values: 4 });
  });

  it("normalises header cells the way the admin sees them in the preview", () => {
    // `normalizeHeaderCell` lower-cases and turns runs of whitespace into `_`, so the mapping
    // can name `Net Burn` and the file can spell it `NET  BURN`.
    const p = plan("Period,CASH,NET  BURN\n2026-01,1,2\n");
    expect(p.columns).toEqual(["period", "cash", "net_burn"]);
    expect(p.rows[0]?.status).toBe("ok");
  });

  it("refuses the whole file when the period column is not in it", () => {
    const p = plan("month,cash\n2026-01,1\n");
    expect(p.rows).toEqual([
      { line: 1, periodKey: "", status: "error", reason: "period_column_missing", cells: [] },
    ]);
  });

  it("refuses the whole file when two columns normalise to the same name", () => {
    const p = plan("period,cash,Cash\n2026-01,1,2\n");
    expect(p.rows[0]).toMatchObject({ status: "error", reason: "duplicate_column:cash" });
  });

  it("reports a blank period and an unreadable one differently", () => {
    const p = plan("period,cash\n,1\nnot-a-month,2\n");
    expect(p.rows.map((r) => r.reason)).toEqual(["missing_period", "unreadable_period"]);
    expect(p.rows.every((r) => r.status === "error")).toBe(true);
  });

  it("refuses to guess which of two rows for one period was meant", () => {
    const p = plan("period,cash\n2026-01,1\n2026-01,2\n");
    expect(p.rows[1]).toMatchObject({ status: "skipped", reason: "duplicate_period" });
    // The second row is not applied, so the first value stands and nothing looks like a
    // restatement in the audit trail.
    expect(summarise(p.rows).values).toBe(1);
  });

  it("treats a blank cell as no figure, not as a zero", () => {
    const p = plan("period,cash,Net Burn\n2026-01,,250\n");
    expect(p.rows[0]?.cells[0]).toEqual({
      key: "cash",
      column: "cash",
      value: null,
      status: "skipped",
      reason: "blank",
    });
    expect(p.rows[0]?.status).toBe("ok");
    expect(summarise(p.rows).values).toBe(1);
  });

  it("reports a cell that is not a number without losing the rest of the row", () => {
    const p = plan("period,cash,Net Burn\n2026-01,n/a,250\n");
    expect(p.rows[0]?.cells[0]).toMatchObject({ status: "error", reason: "not_a_number" });
    expect(p.rows[0]?.status).toBe("ok");
    expect(summarise(p.rows).values).toBe(1);
  });

  it("says `no_values` when every cell of a row is blank", () => {
    const p = plan("period,cash,Net Burn\n2026-01,,\n");
    expect(p.rows[0]).toMatchObject({ status: "skipped", reason: "no_values" });
  });

  it("says `no_usable_values` when the row had figures and none could be read", () => {
    const p = plan("period,cash,Net Burn\n2026-01,n/a,tbd\n");
    expect(p.rows[0]).toMatchObject({ status: "error", reason: "no_usable_values" });
  });

  it("names the mapped column the file does not have, once per row and not once per file", () => {
    const p = plan("period,cash\n2026-01,1\n");
    expect(p.rows[0]?.cells[1]).toMatchObject({ key: "net_burn", reason: "column_missing" });
    expect(p.rows[0]?.status).toBe("ok");
  });

  it("names a mapped key the workspace does not define", () => {
    const p = plan("period,cash,Net Burn\n2026-01,1,2\n", MAPPING, new Set(["cash"]));
    expect(p.rows[0]?.cells[1]).toMatchObject({ key: "net_burn", reason: "unknown_metric" });
  });

  it("reads quarters and years when the mapping says so", () => {
    const quarterly: CsvMapping = { ...MAPPING, periodKind: "quarter" };
    expect(plan("period,cash\n2026-Q2,5\n", quarterly).rows[0]).toMatchObject({
      periodKey: "2026-Q2",
      status: "ok",
    });
    const yearly: CsvMapping = { ...MAPPING, periodKind: "year" };
    expect(plan("period,cash\n2026,5\n", yearly).rows[0]).toMatchObject({
      periodKey: "2026",
      status: "ok",
    });
  });

  it("enforces its own row cap and says what it is", () => {
    /*
     * `@fundroom/csv` has no cap (contract §12 C5): the invite importer's stayed in identity,
     * so this module has to carry its own — and the refusal has to name the number, because
     * "too big" without one tells the admin nothing about how to split the file.
     */
    const lines = ["period,cash"];
    for (let i = 0; i < METRICS_IMPORT_MAX_ROWS + 5; i++) {
      lines.push(`2026-01-0${(i % 9) + 1}/2026-02-01,${i}`);
    }
    const custom: CsvMapping = { ...MAPPING, periodKind: "custom" };
    const p = planImport(parseCsv(lines.join("\n")), custom, KEYS);
    const last = p.rows.at(-1);
    expect(last).toMatchObject({
      status: "error",
      reason: `too_many_rows:${METRICS_IMPORT_MAX_ROWS}`,
    });
    // One refusal, not one per surplus row, and nothing past it is read.
    expect(p.rows.filter((r) => r.reason?.startsWith("too_many_rows"))).toHaveLength(1);
    expect(p.rows).toHaveLength(METRICS_IMPORT_MAX_ROWS + 1);
  });

  it("ignores a header-only file rather than inventing a row", () => {
    const p = plan("period,cash\n");
    expect(p.rows).toEqual([]);
    expect(summarise(p.rows)).toEqual({ ok: 0, skipped: 0, error: 0, values: 0 });
  });
});
