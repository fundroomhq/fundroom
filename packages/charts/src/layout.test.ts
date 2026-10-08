import type { VectorOp } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { layoutChart } from "./layout.js";
import type { ChartLayout, ChartSpec } from "./types.js";

const PALETTE = {
  axis: "#111111",
  grid: "#eeeeee",
  text: "#000000",
  muted: "#666666",
  background: "#ffffff",
} as const;

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    kind: "line",
    width: 600,
    height: 300,
    series: [{ key: "mrr", label: "MRR", colour: "#2b6cb0", points: [] }],
    xLabels: [],
    yTickFormat: (v) => String(v),
    palette: PALETTE,
    ...over,
  };
}

function months(n: number): string[] {
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return Array.from({ length: n }, (_, i) => `${names[i % 12] ?? "?"} 2026`);
}

function pts(ys: readonly (number | null)[]): { x: number; y: number | null }[] {
  return ys.map((y, x) => ({ x, y }));
}

/** Every coordinate an op names must be inside the canvas — nothing is drawn off-page. */
function expectInBounds(layout: ChartLayout, width: number, height: number): void {
  const inX = (v: number): void => {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(width);
  };
  const inY = (v: number): void => {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(height);
  };
  for (const op of layout.ops) {
    switch (op.op) {
      case "rect":
        inX(op.x);
        inX(op.x + op.w);
        inY(op.y);
        inY(op.y + op.h);
        break;
      case "line":
        inX(op.x1);
        inX(op.x2);
        inY(op.y1);
        inY(op.y2);
        break;
      case "polyline":
        for (const [x, y] of op.points) {
          inX(x);
          inY(y);
        }
        break;
      case "text":
        inX(op.x);
        inY(op.y);
        break;
    }
  }
}

const texts = (ops: readonly VectorOp[]): string[] =>
  ops.flatMap((o) => (o.op === "text" ? [o.text] : []));
const gridlines = (l: ChartLayout) =>
  l.ops.flatMap((o) => (o.op === "line" && o.stroke === PALETTE.grid ? [o] : []));
const polylines = (l: ChartLayout) => l.ops.flatMap((o) => (o.op === "polyline" ? [o] : []));
/** Rects inside the plot: the marks, never the background or a legend swatch. */
const bars = (l: ChartLayout, colour: string) =>
  l.ops.flatMap((o) =>
    o.op === "rect" && o.fill === colour && o.y < l.plot.y + l.plot.h ? [o] : [],
  );

describe("layoutChart — frame", () => {
  it("draws a known small chart in a stable, readable order", () => {
    const l = layoutChart(
      spec({
        width: 300,
        height: 200,
        title: "MRR",
        xLabels: months(3),
        series: [{ key: "mrr", label: "MRR", colour: "#2b6cb0", points: pts([10, 20, 30]) }],
      }),
    );
    const kinds = l.ops.map((o) => o.op);
    expect(kinds[0]).toBe("rect"); // background first
    expect(l.ops[0]).toMatchObject({ op: "rect", x: 0, y: 0, w: 300, h: 200, fill: "#ffffff" });
    expect(l.ops[1]).toMatchObject({ op: "text", text: "MRR", weight: "bold" });
    expect(kinds.filter((k) => k === "polyline")).toHaveLength(1);
    // Grid and axes before the data, labels after it: painter's order, one pass.
    expect(kinds.lastIndexOf("line")).toBeLessThan(kinds.indexOf("polyline"));
    expect(texts(l.ops)).toContain("Jan 2026");
    expect(l.legend).toEqual([{ label: "MRR", colour: "#2b6cb0" }]);
    expectInBounds(l, 300, 200);
  });

  it("keeps every op inside the canvas across sizes, kinds and titles", () => {
    for (const kind of ["line", "bar", "stacked-bar"] as const) {
      for (const [w, h] of [
        [160, 100],
        [320, 180],
        [600, 300],
        [1200, 700],
        [40, 20],
      ] as const) {
        const l = layoutChart(
          spec({
            kind,
            width: w,
            height: h,
            title: "A very long chart title that will not fit on a narrow canvas",
            yAxisLabel: "EUR",
            xLabels: months(12),
            series: [
              {
                key: "a",
                label: "New business",
                colour: "#2b6cb0",
                points: pts([1, -2, 3, null, 5, 6, 7, 8, 9, 10, 11, 12]),
              },
              {
                key: "b",
                label: "Expansion",
                colour: "#38a169",
                points: pts([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]),
              },
            ],
          }),
        );
        expectInBounds(l, Math.max(160, w), Math.max(100, h));
      }
    }
  });

  it("maps the axis minimum to the bottom of the plot and the maximum to the top", () => {
    const l = layoutChart(
      spec({
        kind: "bar",
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([0, 50, 100]) }],
      }),
    );
    const ys = gridlines(l).map((g) => g.y1);
    expect(Math.max(...ys)).toBe(l.plot.y + l.plot.h);
    expect(Math.min(...ys)).toBe(l.plot.y);
  });

  it("gives bar charts a zero baseline but does not force zero onto a line", () => {
    const shared = {
      xLabels: months(3),
      series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([48, 50, 52]) }],
    };
    const bar = layoutChart(spec({ ...shared, kind: "bar" }));
    const line = layoutChart(spec({ ...shared, kind: "line" }));
    expect(texts(bar.ops)).toContain("0");
    // The line's axis starts near the data; flattening 48→52 against a zero baseline would
    // hide the only movement the reader came for.
    expect(texts(line.ops)).not.toContain("0");
  });

  it("thins x labels rather than assuming a font metric", () => {
    const wide = layoutChart(
      spec({
        xLabels: months(12),
        width: 900,
        series: [
          { key: "a", label: "A", colour: "#2b6cb0", points: pts(months(12).map((_, i) => i)) },
        ],
      }),
    );
    const narrow = layoutChart(
      spec({
        xLabels: months(12),
        width: 240,
        series: [
          { key: "a", label: "A", colour: "#2b6cb0", points: pts(months(12).map((_, i) => i)) },
        ],
      }),
    );
    const drawn = (l: ChartLayout) => texts(l.ops).filter((t) => t.endsWith("2026"));
    expect(drawn(wide).length).toBeGreaterThan(drawn(narrow).length);
    // The most recent period always keeps its label.
    expect(drawn(wide)).toContain("Dec 2026");
    expect(drawn(narrow)).toContain("Dec 2026");
  });
});

describe("layoutChart — gaps are never zero", () => {
  it("breaks a line at a null and does not bridge it", () => {
    const l = layoutChart(
      spec({
        xLabels: months(5),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([10, 20, null, 40, 50]) }],
      }),
    );
    const lines = polylines(l);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.points).toHaveLength(2);
    expect(lines[1]?.points).toHaveLength(2);
    // Nothing at all is drawn in the gap column: no vertex, no mark, no bar at the baseline.
    const gapX = l.plot.x + (l.plot.w * 2) / 4;
    for (const p of lines.flatMap((pl) => pl.points)) expect(p[0]).not.toBeCloseTo(gapX, 5);
    expect(bars(l, "#2b6cb0")).toHaveLength(0);
  });

  it("draws an isolated point as a mark so a sparse series is not an empty plot", () => {
    const l = layoutChart(
      spec({
        xLabels: months(5),
        series: [
          { key: "a", label: "A", colour: "#2b6cb0", points: pts([null, 20, null, 40, null]) },
        ],
      }),
    );
    expect(polylines(l)).toHaveLength(0);
    expect(bars(l, "#2b6cb0")).toHaveLength(2);
  });

  it("omits the bar entirely for a null and keeps one for a genuine zero", () => {
    const l = layoutChart(
      spec({
        kind: "bar",
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([10, null, 0]) }],
      }),
    );
    const rects = bars(l, "#2b6cb0");
    expect(rects).toHaveLength(2);
    // The zero bar is a hairline on the baseline; the null contributes no rect at all.
    expect(rects[1]?.h).toBe(1);
  });

  it("skips a null inside a stack without shifting the segments above it", () => {
    const l = layoutChart(
      spec({
        kind: "stacked-bar",
        xLabels: months(2),
        series: [
          { key: "a", label: "A", colour: "#2b6cb0", points: pts([10, 10]) },
          { key: "b", label: "B", colour: "#38a169", points: pts([null, 10]) },
        ],
      }),
    );
    expect(bars(l, "#38a169")).toHaveLength(1);
    expect(bars(l, "#2b6cb0")).toHaveLength(2);
  });
});

describe("layoutChart — degenerate series", () => {
  it("draws a frame for an empty spec and says so", () => {
    const l = layoutChart(spec({ series: [], xLabels: [] }));
    expect(polylines(l)).toHaveLength(0);
    expect(l.describedBy).toBe("Line chart with no data.");
    expectInBounds(l, 600, 300);
  });

  it("draws a frame for a series that is entirely null", () => {
    const l = layoutChart(
      spec({
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([null, null, null]) }],
      }),
    );
    expect(polylines(l)).toHaveLength(0);
    expect(bars(l, "#2b6cb0")).toHaveLength(0);
    expect(l.describedBy).toContain("no data");
  });

  it("centres a single point and still labels its axis", () => {
    const l = layoutChart(
      spec({
        xLabels: ["Mar 2026"],
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([7]) }],
      }),
    );
    const dot = bars(l, "#2b6cb0")[0];
    expect(dot).toBeDefined();
    expect(dot?.x).toBeCloseTo(l.plot.x + l.plot.w / 2 - 2, 5);
    expect(l.describedBy).toContain("7 in Mar 2026");
    expectInBounds(l, 600, 300);
  });

  it("gives a flat series a band around it instead of a zero-height axis", () => {
    const l = layoutChart(
      spec({
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([42, 42, 42]) }],
      }),
    );
    const line = polylines(l)[0];
    expect(line?.points.map((p) => p[1])).toEqual([
      l.plot.y + l.plot.h / 2,
      l.plot.y + l.plot.h / 2,
      l.plot.y + l.plot.h / 2,
    ]);
    expect(l.describedBy).toContain("unchanged at 42");
  });

  it("handles an all-zero series", () => {
    const l = layoutChart(
      spec({
        kind: "bar",
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([0, 0, 0]) }],
      }),
    );
    expect(bars(l, "#2b6cb0")).toHaveLength(3);
    expect(texts(l.ops)).toContain("0");
    expectInBounds(l, 600, 300);
  });

  it("straddles zero with a marked baseline", () => {
    const l = layoutChart(
      spec({
        kind: "bar",
        xLabels: months(3),
        series: [{ key: "a", label: "A", colour: "#2b6cb0", points: pts([-40, 20, 60]) }],
      }),
    );
    const axisLines = l.ops.filter((o) => o.op === "line" && o.stroke === PALETTE.axis);
    // left axis + bottom axis + the zero rule
    expect(axisLines).toHaveLength(3);
    const negative = bars(l, "#2b6cb0")[0];
    expect(negative?.y).toBeGreaterThan(l.plot.y + l.plot.h / 2);
  });
});

describe("layoutChart — describedBy", () => {
  it("names the first and last value, the direction and the span", () => {
    const l = layoutChart(
      spec({
        title: "Monthly recurring revenue",
        xLabels: months(3),
        yTickFormat: (v) => `€${v}`,
        series: [{ key: "a", label: "MRR", colour: "#2b6cb0", points: pts([100, 150, 200]) }],
      }),
    );
    expect(l.describedBy).toBe(
      "Monthly recurring revenue. Line chart covering Jan 2026 to Mar 2026, 3 periods. MRR: €100 in Jan 2026, rising to €200 in Mar 2026 (up 100%).",
    );
  });

  it("counts the gaps so a flat stretch is not mistaken for a flat business", () => {
    const l = layoutChart(
      spec({
        xLabels: months(4),
        series: [{ key: "a", label: "Burn", colour: "#2b6cb0", points: pts([90, null, null, 30]) }],
      }),
    );
    expect(l.describedBy).toContain("falling to 30 in Apr 2026 (down 67%)");
    expect(l.describedBy).toContain("2 periods have no value for Burn.");
  });

  it("summarises every series of a multi-series chart", () => {
    const l = layoutChart(
      spec({
        kind: "stacked-bar",
        xLabels: months(2),
        series: [
          { key: "a", label: "New", colour: "#2b6cb0", points: pts([1, 2]) },
          { key: "b", label: "Churn", colour: "#e53e3e", points: pts([null, null]) },
        ],
      }),
    );
    expect(l.describedBy).toContain("Stacked bar chart covering Jan 2026 to Feb 2026, 2 periods.");
    expect(l.describedBy).toContain("New: 1 in Jan 2026, rising to 2 in Feb 2026 (up 100%).");
    expect(l.describedBy).toContain("Churn: no data.");
  });
});
