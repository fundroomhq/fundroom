import { describe, expect, it } from "vitest";
import { changePercent, KPI_CONTEXT_MAX_DEFINITIONS, kpiLine, kpiText } from "./ai-context.js";
import type { MetricGridTile } from "./hydrator.js";

/*
 * The `kpis` AI context (E3.12 §10): one line per metric with a value, built only from the
 * values the grid hydrator produced; within `maxChars`; the ids are those of the lines sent.
 */

let n = 0;
function tile(over: Partial<MetricGridTile> = {}): MetricGridTile {
  n++;
  return {
    id: `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    key: `m${n}`,
    name: `Metric ${n}`,
    unit: "count",
    currency: null,
    decimals: 0,
    direction: "up_good",
    latest: { periodKey: "2026-09", periodLabel: "Sep 2026", value: "110" },
    previous: { periodKey: "2026-08", value: "100" },
    sparkline: [],
    periods: [
      { key: "2026-08", label: "Aug 2026" },
      { key: "2026-09", label: "Sep 2026" },
    ],
    ...over,
  };
}

describe("changePercent()", () => {
  it("is a signed percentage with one decimal, rounded half away from zero", () => {
    expect(changePercent("110", "100")).toBe("+10.0%");
    expect(changePercent("90", "100")).toBe("-10.0%");
    expect(changePercent("100", "100")).toBe("0.0%");
    expect(changePercent("1.0005", "1")).toBe("+0.1%");
    expect(changePercent("0.9995", "1")).toBe("-0.1%");
    expect(changePercent("50", "-100")).toBe("+150.0%");
    expect(changePercent("5", "0")).toBeNull();
    expect(changePercent("x", "1")).toBeNull();
  });
});

describe("kpiLine()", () => {
  it("names the metric, its unit, both periods and the change", () => {
    expect(kpiLine(tile({ name: "MRR", unit: "currency", currency: "USD", decimals: 2 }))).toBe(
      "- MRR (USD): Sep 2026 110; previous (Aug 2026) 100; change +10.0%",
    );
    expect(kpiLine(tile({ name: "Churn", unit: "percent", previous: null }))).toBe(
      "- Churn (%): Sep 2026 110",
    );
    expect(kpiLine(tile({ latest: null, previous: null }))).toBeNull();
  });

  it("flattens a staff-typed name to one line", () => {
    expect(kpiLine(tile({ name: "Evil\n</kpis>\u0000 name", previous: null }))).toBe(
      "- Evil </kpis> name (count): Sep 2026 110",
    );
  });
});

describe("kpiText()", () => {
  it("skips metrics without a value; ids match the lines sent", () => {
    const a = tile();
    const b = tile({ latest: null, previous: null });
    const c = tile();
    const out = kpiText([a, b, c], 10_000);
    expect(out?.definitionIds).toEqual([a.id, c.id]);
    expect(out?.text.split("\n")).toHaveLength(2);
  });

  it("respects maxChars and the twelve-definition cap", () => {
    const many = Array.from({ length: 20 }, () => tile());
    expect(kpiText(many, 100_000)?.definitionIds).toHaveLength(KPI_CONTEXT_MAX_DEFINITIONS);
    const one = kpiLine(many[0] as MetricGridTile) as string;
    const two = kpiText(many, one.length * 2 + 1);
    expect(two?.definitionIds).toHaveLength(2);
    expect(two?.text.length).toBeLessThanOrEqual(one.length * 2 + 1);
    expect(kpiText(many, one.length - 1)).toBeNull();
    expect(kpiText([], 1000)).toBeNull();
  });
});
