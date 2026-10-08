import { describe, expect, it } from "vitest";
import { buildChartSpec, CHART_SERIES_COLOURS, formatTick } from "./chart.js";
import { parseFixed } from "./decimal.js";
import type { DefinitionRow } from "./repos/metrics-repo.js";
import { periodColumns } from "./service/series.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const fixed = (t: string) => parseFixed(t) as bigint;

const definition = (over: Partial<DefinitionRow>): DefinitionRow =>
  ({
    id: "01920000-0000-7000-8000-0000000000a1",
    key: "cash",
    name: "Cash",
    description: null,
    unit: "currency",
    currency: "USD",
    aggregation: "last",
    direction: "up_good",
    periodKind: "month",
    decimals: 0,
    formula: null,
    display: {},
    audience: { kind: "staff_only" },
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...over,
  }) as DefinitionRow;

describe("buildChartSpec", () => {
  const columns = periodColumns("month", NOW, 3);

  it("indexes points by column, which is what `ChartSeries.points[].x` means (C-E.7)", () => {
    const spec = buildChartSpec({
      columns,
      entries: [{ definition: definition({}), values: [fixed("10"), fixed("20"), fixed("30")] }],
    });
    expect(spec.series[0]?.points).toEqual([
      { x: 0, y: 10 },
      { x: 1, y: 20 },
      { x: 2, y: 30 },
    ]);
    expect(spec.xLabels).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
  });

  it("carries a gap as `y: null`, never as a zero", () => {
    const spec = buildChartSpec({
      columns,
      entries: [{ definition: definition({}), values: [fixed("10"), undefined, fixed("30")] }],
    });
    expect(spec.series[0]?.points[1]).toEqual({ x: 1, y: null });
  });

  it("prefers the workspace's accent for the first series and the palette for the rest", () => {
    const spec = buildChartSpec({
      columns,
      entries: [
        { definition: definition({}), values: [] },
        { definition: definition({ id: "b", key: "burn" }), values: [] },
      ],
      accentColor: "#123456",
    });
    expect(spec.series.map((s) => s.colour)).toEqual(["#123456", CHART_SERIES_COLOURS[1]]);
  });

  it("draws one column as a bar, because a line through one point is not a line", () => {
    const one = periodColumns("month", NOW, 1);
    expect(buildChartSpec({ columns: one, entries: [] }).kind).toBe("bar");
    expect(buildChartSpec({ columns, entries: [] }).kind).toBe("line");
  });
});

describe("formatTick", () => {
  it("compacts large numbers and keeps the unit legible", () => {
    expect(formatTick(1_250_000, "currency", "USD", 0)).toBe("$1.3M");
    expect(formatTick(42_000, "count", null, 0)).toBe("42k");
    expect(formatTick(12.5, "percent", null, 1)).toBe("12.5%");
    expect(formatTick(-2_000_000_000, "currency", "EUR", 0)).toBe("-€2.0B");
  });

  it("falls back to no symbol for a currency it has no glyph for", () => {
    // WinAnsi encodes the Latin-1 block and pdf-lib maps anything else to `?` (C-E.8); an
    // unknown code is simply left off the axis rather than risking a row of question marks.
    expect(formatTick(1000, "currency", "ZAR", 0)).toBe("1000");
  });
});
