import { describe, expect, it } from "vitest";
import { formatFixed, parseFixed } from "../decimal.js";
import type { DefinitionRow, PointRow } from "../repos/metrics-repo.js";
import { alignSeries, foldValues, periodColumns } from "./series.js";

const fixed = (text: string) => parseFixed(text) as bigint;

const at = (iso: string, value: string) => ({ periodStart: new Date(iso), value: fixed(value) });

const point = (iso: string, value: string): PointRow =>
  ({
    id: `p-${iso}`,
    definitionId: "d1",
    periodStart: new Date(iso),
    periodEnd: new Date(iso),
    value: fixed(value),
    asOf: new Date(iso),
    sourceId: null,
    sourceKind: null,
    revision: 1,
    needsReview: false,
    note: null,
    createdBy: null,
    createdAt: new Date(iso),
  }) satisfies PointRow;

const definition = (aggregation: DefinitionRow["aggregation"]) =>
  ({ aggregation }) as Pick<DefinitionRow, "aggregation">;

describe("foldValues", () => {
  it("is undefined for an empty bucket — a period with no point has no number", () => {
    expect(foldValues("sum", [])).toBeUndefined();
    expect(foldValues("last", [])).toBeUndefined();
    expect(foldValues("avg", [])).toBeUndefined();
  });

  it("sums, takes the latest and averages", () => {
    const bucket = [
      at("2026-01-01T00:00:00Z", "10"),
      at("2026-02-01T00:00:00Z", "20"),
      at("2026-03-01T00:00:00Z", "33"),
    ];
    expect(formatFixed(foldValues("sum", bucket) as bigint, 2)).toBe("63.00");
    expect(formatFixed(foldValues("last", bucket) as bigint, 2)).toBe("33.00");
    expect(formatFixed(foldValues("avg", bucket) as bigint, 2)).toBe("21.00");
  });

  it("averages the points that exist, not the months that might have had one", () => {
    // Two months of data in a quarter averages two numbers; treating the third as zero would
    // drag the average towards it and report a fall nobody measured.
    const bucket = [at("2026-01-01T00:00:00Z", "10"), at("2026-02-01T00:00:00Z", "20")];
    expect(formatFixed(foldValues("avg", bucket) as bigint, 2)).toBe("15.00");
  });

  it("rounds an average half away from zero, the way a spreadsheet does", () => {
    const bucket = [at("2026-01-01T00:00:00Z", "1"), at("2026-02-01T00:00:00Z", "2")];
    // 1.5 at the column's own precision, not the 1 a truncating BigInt division would give.
    expect(formatFixed(foldValues("avg", bucket) as bigint, 1)).toBe("1.5");
  });

  it("takes the latest by period, not by array order", () => {
    const bucket = [at("2026-03-01T00:00:00Z", "33"), at("2026-01-01T00:00:00Z", "10")];
    expect(formatFixed(foldValues("last", bucket) as bigint, 0)).toBe("33");
  });
});

describe("alignSeries", () => {
  const march = new Date("2026-03-15T12:00:00Z");

  it("puts each point in the column whose half-open range contains it, and leaves gaps", () => {
    const columns = periodColumns("month", march, 3);
    expect(columns.map((c) => c.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const values = alignSeries(
      definition("last"),
      [point("2026-01-01T00:00:00Z", "10"), point("2026-03-01T00:00:00Z", "30")],
      columns,
    );
    // February is `undefined`, not 0: nobody entered a number for it.
    expect(values.map((v) => (v === undefined ? null : formatFixed(v, 0)))).toEqual([
      "10",
      null,
      "30",
    ]);
  });

  it("folds a monthly metric into quarterly columns with its own aggregation", () => {
    const columns = periodColumns("quarter", march, 1);
    expect(columns[0]?.key).toBe("2026-Q1");
    const points = [
      point("2026-01-01T00:00:00Z", "10"),
      point("2026-02-01T00:00:00Z", "20"),
      point("2026-03-01T00:00:00Z", "30"),
    ];
    expect(formatFixed(alignSeries(definition("sum"), points, columns)[0] as bigint, 0)).toBe("60");
    expect(formatFixed(alignSeries(definition("last"), points, columns)[0] as bigint, 0)).toBe(
      "30",
    );
  });

  it("excludes a point that sits exactly on the next column's start", () => {
    // The ranges are half-open `[start, end)`; an inclusive upper bound would count April's
    // figure in March and again in April.
    const columns = periodColumns("month", march, 1);
    expect(alignSeries(definition("sum"), [point("2026-04-01T00:00:00Z", "99")], columns)).toEqual([
      undefined,
    ]);
  });
});
