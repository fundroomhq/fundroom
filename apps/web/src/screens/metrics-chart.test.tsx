import type { ChartSpec } from "@fundroom/charts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChartSvg from "../components/charts/chart-svg.js";
import { Chart } from "../components/charts/index.js";
import { resolveChartTheme } from "../components/charts/palette.js";
import { expectNoA11yViolations } from "../test/a11y.js";

/*
 * The React SVG interpreter (E2.4 §7). What these tests pin:
 *
 *  - it draws what `layoutChart` decided and **decides nothing itself** — the ops are replayed,
 *    so a coordinate here is a coordinate the pdf-lib interpreter drew too;
 *  - it emits **no `style` attribute anywhere** — a house rule for the SVG interpreter (see
 *    chart-svg.tsx; React's `style` prop goes through the CSSOM, which CSP allows, so this is
 *    about keeping the drawing in attributes, not a violation. E2.2's "two violations per page
 *    load" were sonner's injected <style>, fixed in E2.10);
 *  - `rotate` is passed through unchanged as SVG's clockwise degrees (C-E.6);
 *  - the numbers are reachable **as text**, not only as pixels;
 *  - axe is clean.
 *
 * What these tests deliberately do NOT claim: anything about colour. jsdom computes no
 * colours, so `color-contrast` is disabled in `src/test/a11y.ts` and a chart drawn in pale
 * yellow on white would pass every assertion below. The colours come from
 * `--sh-color-chart-1…5`, which the design system has already contrast-checked; that is the
 * only guarantee there is, and it is not an automated one.
 */

const theme = resolveChartTheme("light");

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    kind: "line",
    width: 520,
    height: 220,
    series: [
      {
        key: "arr",
        label: "ARR",
        colour: theme.series[0] ?? "#2563eb",
        // The middle period is a gap, not a zero.
        points: [
          { x: 0, y: 1_200_000 },
          { x: 1, y: null },
          { x: 2, y: 1_250_000 },
        ],
      },
    ],
    xLabels: ["Jul 2026", "Aug 2026", "Sep 2026"],
    yTickFormat: (v) => `$${Math.round(v / 1000)}k`,
    yAxisLabel: "ARR",
    palette: theme.palette,
    ...over,
  };
}

describe("chart interpreter", () => {
  it("names itself for a screen reader and puts the numbers in text as well as pixels", async () => {
    const r = render(<ChartSvg spec={spec()} formatValue={(v) => `$${v}`} />);
    const svg = r.container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    // `describedBy` is the sentence the email's `alt` uses too, so it carries the figures.
    expect(svg?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(r.container.querySelector("svg title")?.textContent).toContain("ARR");
    expect(r.container.querySelector("svg title")?.textContent).toContain("$1200k");

    // A chart is never the only place a number exists: the same series is a real table.
    const table = r.container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("Jul 2026");
    expect(table?.textContent).toContain("$1200000");
    expect(table?.textContent).toContain("$1250000");
    // The gap stays a gap. A dash, never a zero.
    expect(table?.textContent).toContain("—");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("emits presentation attributes and never an inline style (CSP)", async () => {
    /*
     * Two joined months, then a gap, then a lone month. The join is a `polyline`; the lone
     * month is a mark, because a point with a gap either side has no segment to live on. What
     * there is never is a line walking through the gap at zero.
     */
    const r = render(
      <ChartSvg
        spec={spec({
          series: [
            {
              key: "arr",
              label: "ARR",
              colour: theme.series[0] ?? "#2563eb",
              points: [
                { x: 0, y: 1_100_000 },
                { x: 1, y: 1_200_000 },
                { x: 2, y: null },
                { x: 3, y: 1_250_000 },
              ],
            },
          ],
          xLabels: ["Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"],
        })}
      />,
    );
    const svg = r.container.querySelector("svg");
    expect(svg).not.toBeNull();
    // The house rule, asserted rather than assumed: not one element under the chart carries a
    // `style` attribute — everything is a presentation attribute or a class.
    expect(r.container.querySelectorAll("[style]")).toHaveLength(0);
    const polylines = svg?.querySelectorAll("polyline") ?? [];
    expect(polylines).toHaveLength(1);
    const polyline = polylines[0];
    expect(polyline).toHaveAttribute("fill", "none");
    expect(polyline).toHaveAttribute("stroke", theme.series[0] ?? "#2563eb");
    expect(polyline).toHaveAttribute("stroke-width");
    // Exactly two coordinate pairs: the gap is not bridged.
    expect(polyline?.getAttribute("points")?.split(" ")).toHaveLength(2);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("passes `rotate` through unchanged as SVG's clockwise degrees (C-E.6)", async () => {
    const r = render(<ChartSvg spec={spec()} />);
    const rotated = [...r.container.querySelectorAll("svg text")].filter((t) =>
      t.getAttribute("transform")?.startsWith("rotate("),
    );
    // The y-axis label is the one rotated op the layout emits, and it arrives as -90.
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.getAttribute("transform")).toMatch(/^rotate\(-90 [\d.]+ [\d.]+\)$/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says so rather than drawing nothing when a series has no data", async () => {
    const r = render(
      <ChartSvg
        spec={spec({
          series: [{ key: "arr", label: "ARR", colour: "#2563eb", points: [] }],
        })}
      />,
    );
    expect(r.container.querySelector("svg title")?.textContent).toContain("no data");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("loads lazily through <Chart> and still renders the same drawing", async () => {
    const r = render(<Chart spec={spec()} />);
    // The interpreter is a separate chunk (`React.lazy`), so it resolves a tick later.
    expect(await screen.findByRole("img", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(r.container.querySelectorAll("[style]")).toHaveLength(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("resolves its colours from the design-system tokens, not from literals", async () => {
    // The fallback table is a transcription of `packages/tokens/tokens.css`, and the
    // two themes must not collapse into one palette — a chart that ignored the theme would
    // be unreadable in half the app. (Contrast itself is unverifiable here: see the header.)
    const light = resolveChartTheme("light");
    const dark = resolveChartTheme("dark");
    expect(light.series).toHaveLength(5);
    expect(new Set(light.series).size).toBe(5);
    expect(light.palette.text).not.toBe(dark.palette.text);
    expect(light.series[0]).not.toBe(dark.series[0]);
    for (const colour of [...light.series, ...dark.series])
      expect(colour).toMatch(/^#[0-9a-f]{6}$/u);
  }, 20_000);
});
