import type { VectorOp } from "@fundroom/ports";
import { describeChart } from "./describe.js";
import { niceTicks } from "./ticks.js";
import type { ChartLayout, ChartSpec } from "./types.js";

/**
 * Chart geometry (E2.4 contract §7, ADR-0042). One layout pass, two dumb interpreters.
 *
 * `layoutChart` answers with a flat list of drawing operations. The SPA turns each one into a
 * React SVG element; `DocumentRenderPort.renderVector` turns each one into a pdf-lib call and
 * rasterises the page through PDFium. **Neither interpreter makes a layout decision**, so the
 * PNG in an investor's inbox and the chart on the portal cannot drift apart — which is the
 * whole point of the design. The rejected alternative was rendering SVG in the browser and
 * re-implementing "roughly the same chart" server-side for the email; two implementations of a
 * y axis is two y axes, and the one nobody is looking at is the one that is wrong.
 *
 * Coordinates are **top-left origin, pixels**, because that is what SVG uses and what a reader
 * of the React component expects. PDF is bottom-left origin; the pdf-lib interpreter flips y
 * once, in one place, and says so there. Nothing in this file knows PDF exists.
 *
 * The package holds no palette and no locale: colours arrive as `#rrggbb` on the spec and
 * numbers arrive already formatted by `yTickFormat`.
 */

const PAD = 8;
const GAP = 6;
const TITLE_SIZE = 13;
const TICK_SIZE = 10;
const LEGEND_SIZE = 10;
const AXIS_LABEL_SIZE = 10;
const LINE_WIDTH = 2;
const GRID_WIDTH = 1;
/** A bar for a very small (or zero) value still has to be visible as a bar. */
const MIN_BAR = 1;
/** Fraction of a column a bar group occupies; the rest is the gutter between columns. */
const BAR_SLOT_FILL = 0.72;
/** Below these the axes have nowhere to live; callers get a bigger canvas, not an exception. */
const MIN_WIDTH = 160;
const MIN_HEIGHT = 100;
const MIN_PLOT = 32;
const MAX_Y_LABEL_WIDTH = 56;
const MAX_X_LABEL_OVERHANG = 32;

/**
 * Mean glyph advance as a fraction of the font size, for a sans-serif face at label sizes.
 *
 * There is no text measurement here and there must not be: this package is pure, and the two
 * interpreters do not even use the same font — the browser draws the workspace's theme face,
 * PDFium draws base-14 Helvetica. Measuring in one of them would produce a layout that is
 * wrong in the other, so *both* get the same estimate and the same structural mitigations:
 * the y-label gutter is capped, and x labels are thinned (every n-th) rather than rotated or
 * ellipsised, because thinning is the one collision fix that needs no metric to be correct.
 */
const GLYPH_WIDTH = 0.6;

function estWidth(text: string, size: number): number {
  return text.length * size * GLYPH_WIDTH;
}

/** Two decimals: enough for sub-pixel placement, few enough that output bytes are stable. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Domain {
  readonly lo: number;
  readonly hi: number;
  readonly empty: boolean;
}

/**
 * The raw extent the ticks then widen. Bars include zero because a bar's length *is* its value
 * measured from zero — a bar chart whose axis starts at 40 000 is the classic misleading
 * chart. A line shows a trend, and forcing zero into a line of headcounts between 48 and 52
 * flattens the only thing the reader came for, so lines do not force it (contract §7).
 */
function domainOf(spec: ChartSpec, columns: number): Domain {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  if (spec.kind === "stacked-bar") {
    for (let c = 0; c < columns; c++) {
      let pos = 0;
      let neg = 0;
      let any = false;
      for (const series of spec.series) {
        for (const p of series.points) {
          if (p.x !== c || p.y === null) continue;
          any = true;
          if (p.y >= 0) pos += p.y;
          else neg += p.y;
        }
      }
      if (!any) continue;
      lo = Math.min(lo, neg);
      hi = Math.max(hi, pos);
    }
  } else {
    for (const series of spec.series) {
      for (const p of series.points) {
        if (p.y === null || !Number.isFinite(p.y)) continue;
        lo = Math.min(lo, p.y);
        hi = Math.max(hi, p.y);
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, empty: true };
  if (spec.kind !== "line") return { lo: Math.min(lo, 0), hi: Math.max(hi, 0), empty: false };
  return { lo, hi, empty: false };
}

/** The value at each column for one series, `null` where the period has no point. */
function byColumn(
  series: ChartSpec["series"][number],
  columns: number,
): readonly (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(columns).fill(null);
  for (const p of series.points) {
    if (!Number.isInteger(p.x) || p.x < 0 || p.x >= columns) continue;
    out[p.x] = p.y === null || !Number.isFinite(p.y) ? null : p.y;
  }
  return out;
}

export function layoutChart(spec: ChartSpec): ChartLayout {
  const width = Math.max(MIN_WIDTH, Math.round(spec.width));
  const height = Math.max(MIN_HEIGHT, Math.round(spec.height));

  let columns = spec.xLabels.length;
  for (const series of spec.series) {
    for (const p of series.points) {
      if (Number.isInteger(p.x) && p.x + 1 > columns) columns = p.x + 1;
    }
  }

  const domain = domainOf(spec, columns);
  const hasTitle = spec.title !== undefined && spec.title.trim() !== "";
  const hasAxisLabel = spec.yAxisLabel !== undefined && spec.yAxisLabel.trim() !== "";
  const drawLegend = spec.series.length > 1;

  const top = PAD + (hasTitle ? TITLE_SIZE + GAP : 0);
  const legendBand = drawLegend ? LEGEND_SIZE + GAP : 0;
  const bottom = PAD + TICK_SIZE + GAP + legendBand;
  const plotH = Math.max(MIN_PLOT, height - top - bottom);

  // ~44px between gridlines: closer and the labels crowd, further and a reader has to
  // interpolate. The tick count is derived from the plot, never hard-coded, so a 180px
  // sparkline and a 600px chart both stay readable.
  const scale = niceTicks(domain.lo, domain.hi, Math.max(2, Math.floor(plotH / 44)));
  const tickLabels = scale.ticks.map((t) => spec.yTickFormat(t));
  const yLabelWidth = Math.min(
    MAX_Y_LABEL_WIDTH,
    Math.max(0, ...tickLabels.map((t) => estWidth(t, TICK_SIZE))),
  );
  const widestX = Math.max(0, ...spec.xLabels.map((t) => estWidth(t, TICK_SIZE)));
  // On a line chart the first and last points sit *on* the plot edges, so their centred labels
  // hang half a label over the side; bar labels are centred in a column and never do.
  const right = PAD + (spec.kind === "line" ? Math.min(widestX / 2, MAX_X_LABEL_OVERHANG) : 0);
  const left = Math.min(
    PAD + (hasAxisLabel ? AXIS_LABEL_SIZE + GAP : 0) + yLabelWidth + GAP,
    Math.max(PAD, width - right - MIN_PLOT),
  );
  const plot = { x: r2(left), y: r2(top), w: r2(width - left - right), h: r2(plotH) };

  const span = scale.max - scale.min;
  const yAt = (v: number): number =>
    r2(Math.min(plot.y + plot.h, Math.max(plot.y, plot.y + plot.h * (1 - (v - scale.min) / span))));
  const slotW = plot.w / Math.max(1, columns);
  const xAt = (i: number): number =>
    r2(
      spec.kind === "line"
        ? columns <= 1
          ? plot.x + plot.w / 2
          : plot.x + (plot.w * i) / (columns - 1)
        : plot.x + slotW * (i + 0.5),
    );

  const ops: VectorOp[] = [];
  const p = spec.palette;

  ops.push({ op: "rect", x: 0, y: 0, w: width, h: height, fill: p.background });

  if (hasTitle) {
    ops.push({
      op: "text",
      x: PAD,
      y: r2(PAD + TITLE_SIZE * 0.85),
      text: (spec.title ?? "").trim(),
      size: TITLE_SIZE,
      fill: p.text,
      weight: "bold",
      anchor: "start",
    });
  }

  const zeroInside = scale.min < 0 && scale.max > 0;
  scale.ticks.forEach((t, i) => {
    const y = yAt(t);
    if (!(zeroInside && t === 0)) {
      ops.push({
        op: "line",
        x1: plot.x,
        y1: y,
        x2: r2(plot.x + plot.w),
        y2: y,
        stroke: p.grid,
        strokeWidth: GRID_WIDTH,
      });
    }
    ops.push({
      op: "text",
      x: r2(plot.x - GAP),
      // SVG and pdf-lib both place text by its baseline, so one nudge centres the label on the
      // gridline in both interpreters.
      y: r2(y + TICK_SIZE * 0.36),
      text: tickLabels[i] ?? "",
      size: TICK_SIZE,
      fill: p.muted,
      anchor: "end",
    });
  });

  if (zeroInside) {
    const y = yAt(0);
    ops.push({
      op: "line",
      x1: plot.x,
      y1: y,
      x2: r2(plot.x + plot.w),
      y2: y,
      stroke: p.axis,
      strokeWidth: GRID_WIDTH,
    });
  }
  ops.push({
    op: "line",
    x1: plot.x,
    y1: plot.y,
    x2: plot.x,
    y2: r2(plot.y + plot.h),
    stroke: p.axis,
    strokeWidth: GRID_WIDTH,
  });
  ops.push({
    op: "line",
    x1: plot.x,
    y1: r2(plot.y + plot.h),
    x2: r2(plot.x + plot.w),
    y2: r2(plot.y + plot.h),
    stroke: p.axis,
    strokeWidth: GRID_WIDTH,
  });

  if (!domain.empty) {
    if (spec.kind === "line") drawLines(ops, spec, columns, xAt, yAt);
    else if (spec.kind === "bar")
      drawBars(ops, spec, columns, slotW, yAt, scale.min, scale.max, plot);
    else drawStacked(ops, spec, columns, slotW, yAt, plot);
  }

  // Thinning, not rotation or ellipsis: with no font metric the only honest way to stop labels
  // colliding is to draw fewer of them. Anchored on the *last* column so the most recent period
  // — the one a reader looks for first — always carries a label.
  const fits = Math.max(1, Math.floor(plot.w / Math.max(1, widestX + GAP + 2)));
  const every = Math.max(1, Math.ceil(columns / fits));
  const labelBaseline = r2(plot.y + plot.h + GAP + TICK_SIZE * 0.8);
  for (let i = 0; i < columns; i++) {
    if ((columns - 1 - i) % every !== 0) continue;
    const label = spec.xLabels[i];
    if (label === undefined || label === "") continue;
    ops.push({
      op: "text",
      x: xAt(i),
      y: labelBaseline,
      text: label,
      size: TICK_SIZE,
      fill: p.muted,
      anchor: "middle",
    });
  }

  if (hasAxisLabel) {
    ops.push({
      op: "text",
      x: r2(PAD + AXIS_LABEL_SIZE * 0.8),
      y: r2(plot.y + plot.h / 2),
      text: (spec.yAxisLabel ?? "").trim(),
      size: AXIS_LABEL_SIZE,
      fill: p.muted,
      anchor: "middle",
      // Degrees clockwise about (x, y) — SVG's sign. The pdf-lib interpreter negates it, in the
      // same place it flips y.
      rotate: -90,
    });
  }

  const legend = spec.series.map((s) => ({ label: s.label, colour: s.colour }));
  if (drawLegend) {
    const baseline = r2(height - PAD - 2);
    const swatch = 8;
    let x = plot.x;
    for (const item of legend) {
      const w = swatch + 4 + estWidth(item.label, LEGEND_SIZE);
      if (x + w > width - PAD && x > plot.x) break;
      ops.push({
        op: "rect",
        x: r2(x),
        y: r2(baseline - swatch + 1),
        w: swatch,
        h: swatch,
        fill: item.colour,
      });
      ops.push({
        op: "text",
        x: r2(x + swatch + 4),
        y: baseline,
        text: item.label,
        size: LEGEND_SIZE,
        fill: p.muted,
        anchor: "start",
      });
      x += w + GAP * 2;
    }
  }

  return { ops, plot, legend, describedBy: describeChart(spec, columns) };
}

type Scale = (v: number) => number;
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawLines(
  ops: VectorOp[],
  spec: ChartSpec,
  columns: number,
  xAt: Scale,
  yAt: Scale,
): void {
  for (const series of spec.series) {
    const values = byColumn(series, columns);
    let run: [number, number][] = [];
    const flush = (): void => {
      const only = run[0];
      if (run.length >= 2) {
        ops.push({ op: "polyline", points: run, stroke: series.colour, strokeWidth: LINE_WIDTH });
      } else if (only !== undefined) {
        // A point with a gap either side has no segment to live on, so it is drawn as a mark.
        // Without this a series of alternating values and nulls renders as an empty plot.
        const d = LINE_WIDTH * 2;
        ops.push({
          op: "rect",
          x: r2(only[0] - d / 2),
          y: r2(only[1] - d / 2),
          w: d,
          h: d,
          fill: series.colour,
        });
      }
      run = [];
    };
    for (let i = 0; i < columns; i++) {
      const v = values[i];
      // `null` breaks the line. It is never bridged and never drawn as zero: a missing month is
      // missing, and a line that walks through it invents a number nobody entered.
      if (v === null || v === undefined) {
        flush();
        continue;
      }
      run.push([xAt(i), yAt(v)]);
    }
    flush();
  }
}

function drawBars(
  ops: VectorOp[],
  spec: ChartSpec,
  columns: number,
  slotW: number,
  yAt: Scale,
  min: number,
  max: number,
  plot: Rect,
): void {
  const base = yAt(Math.min(max, Math.max(min, 0)));
  const groupW = slotW * BAR_SLOT_FILL;
  const barW = groupW / Math.max(1, spec.series.length);
  spec.series.forEach((series, s) => {
    const values = byColumn(series, columns);
    for (let i = 0; i < columns; i++) {
      const v = values[i];
      // A gap is an absent bar, not a zero-height one at the axis (contract §7).
      if (v === null || v === undefined) continue;
      const edge = yAt(v);
      const y = v >= 0 ? edge : base;
      const h = Math.max(MIN_BAR, Math.abs(edge - base));
      ops.push({
        op: "rect",
        x: r2(plot.x + slotW * i + (slotW - groupW) / 2 + barW * s),
        y: r2(Math.min(y, plot.y + plot.h - MIN_BAR)),
        w: r2(Math.max(1, barW)),
        h: r2(h),
        fill: series.colour,
      });
    }
  });
}

function drawStacked(
  ops: VectorOp[],
  spec: ChartSpec,
  columns: number,
  slotW: number,
  yAt: Scale,
  plot: Rect,
): void {
  const groupW = slotW * BAR_SLOT_FILL;
  const values = spec.series.map((series) => byColumn(series, columns));
  for (let i = 0; i < columns; i++) {
    let pos = 0;
    let neg = 0;
    for (let s = 0; s < spec.series.length; s++) {
      const series = spec.series[s];
      if (series === undefined) continue;
      const v = values[s]?.[i];
      // A gap contributes nothing to the stack and draws nothing; the segments above it keep
      // their places, which is the honest reading of "we have no figure for this one".
      if (v === null || v === undefined) continue;
      const from = v >= 0 ? pos : neg + v;
      const to = v >= 0 ? pos + v : neg;
      if (v >= 0) pos += v;
      else neg += v;
      const yTop = yAt(to);
      const h = Math.max(MIN_BAR, yAt(from) - yTop);
      ops.push({
        op: "rect",
        x: r2(plot.x + slotW * i + (slotW - groupW) / 2),
        y: r2(Math.min(yTop, plot.y + plot.h - MIN_BAR)),
        w: r2(Math.max(1, groupW)),
        h: r2(h),
        fill: series.colour,
      });
    }
  }
}
