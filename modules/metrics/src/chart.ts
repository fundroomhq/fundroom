import { type ChartLayout, type ChartSeries, type ChartSpec, layoutChart } from "@fundroom/charts";
import type { DocumentRenderPort, RenderedImage } from "@fundroom/ports";
import { SCALE } from "./decimal.js";
import type { UnitKind } from "./model.js";
import type { DefinitionRow } from "./repos/metrics-repo.js";
import type { PeriodColumn } from "./service/series.js";

/*
 * Turning a resolved series into a picture (E2.4 §7, D4, §9.1).
 *
 * `packages/charts` decides where everything goes and answers drawing operations; the render
 * adapter replays them through pdf-lib → PDFium → sharp. Nothing in this file computes
 * geometry, and nothing in `packages/charts` knows what a KPI is — which is what keeps the
 * email PNG and the on-screen SVG from ever disagreeing, since both replay the same ops.
 *
 * Three frozen details from WP-E are honoured here rather than worked around:
 *  - a series point's `x` is the **column index into `xLabels`** (C-E.7), not an instant;
 *  - `y: null` is a gap and the line breaks there — never a zero;
 *  - chart text is WinAnsi and an unencodable character becomes `?` in the adapter (C-E.8).
 *    We do **not** sanitise on top of that: a metric named with an arrow must not take an
 *    update email down, and `describedBy` plus the email's text part carry the true string.
 */

/** 600 × 300 is the size §D4 measured (warm p50 4.0 ms in the shipped image) and email likes. */
export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 300;

/**
 * Categorical series colours. Chosen for a light card in an email client, and distinguishable
 * in greyscale as well as in colour, because a printed or high-contrast reader still has to
 * tell two lines apart. The workspace's own accent replaces the first when it has one.
 */
export const CHART_SERIES_COLOURS: readonly string[] = [
  "#2563eb",
  "#c2410c",
  "#15803d",
  "#7c3aed",
  "#b91c1c",
  "#0f766e",
];

/** Neutral light palette; the image is rendered once and read in whatever client opens it. */
export const CHART_PALETTE = {
  axis: "#6b7280",
  grid: "#e5e7eb",
  text: "#111827",
  muted: "#6b7280",
  background: "#ffffff",
} as const;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * Fixed-point to the float a pixel coordinate needs.
 *
 * This is the **one** place in the module where a metric becomes a JS number, and it is
 * allowed here for the reason §5 forbids it everywhere else: the output is a y coordinate in a
 * 300-pixel box, not a value anybody reads or stores. Every number a human sees still travels
 * as a decimal string.
 */
const toFloat = (v: bigint): number => Number(v) / Number(SCALE);

/** Axis labels: short enough to fit, honest about magnitude. */
export function formatTick(
  value: number,
  unit: UnitKind,
  currency: string | null,
  decimals: number,
): string {
  const prefix = unit === "currency" ? (CURRENCY_SYMBOLS[currency ?? ""] ?? "") : "";
  const suffix = unit === "percent" ? "%" : "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const scaled =
    abs >= 1e9
      ? `${(abs / 1e9).toFixed(1)}B`
      : abs >= 1e6
        ? `${(abs / 1e6).toFixed(1)}M`
        : abs >= 1e4
          ? `${Math.round(abs / 1e3)}k`
          : abs.toFixed(Math.min(decimals, 2));
  return `${sign}${prefix}${scaled}${suffix}`;
}

export interface ChartEntry {
  readonly definition: DefinitionRow;
  /** Aligned with `columns`, oldest first. `undefined` is a gap, never a zero. */
  readonly values: readonly (bigint | undefined)[];
}

export interface ChartInput {
  readonly columns: readonly PeriodColumn[];
  readonly entries: readonly ChartEntry[];
  /** `branding.accentColor`, when the workspace has picked one. */
  readonly accentColor?: string | null | undefined;
  readonly title?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/**
 * Builds the spec. `kind` is `line` for a multi-period series and `bar` for a single column,
 * because a line through one point is not a line.
 *
 * The y axis is formatted from the **first** series' unit, currency and decimals. A chart
 * mixing a currency and a percentage has no single honest axis, so the send path hands us only
 * metrics that share the first one's unit *and* currency (`chartFor` in `hydrator.ts`, which
 * also settles the period kind) — and the text part of the email carries every figure with its
 * own unit regardless (§10). A caller that builds a spec by hand can still mix them; the entry
 * order decides the axis, which is why the chart route rebuilds in the token's order and not
 * in the repository's.
 */
export function buildChartSpec(input: ChartInput): ChartSpec {
  const first = input.entries[0]?.definition;
  const unit: UnitKind = first?.unit ?? "count";
  const currency = first?.currency ?? null;
  const decimals = first?.decimals ?? 0;
  const series: ChartSeries[] = input.entries.map((entry, i) => ({
    key: entry.definition.key,
    label: entry.definition.name,
    colour:
      i === 0 && input.accentColor
        ? input.accentColor
        : (CHART_SERIES_COLOURS[i % CHART_SERIES_COLOURS.length] as string),
    points: entry.values.map((value, x) => ({
      x,
      y: value === undefined ? null : toFloat(value),
    })),
  }));
  return {
    kind: input.columns.length > 1 ? "line" : "bar",
    width: input.width ?? CHART_WIDTH,
    height: input.height ?? CHART_HEIGHT,
    series,
    xLabels: input.columns.map((c) => c.label),
    yTickFormat: (v: number) => formatTick(v, unit, currency, decimals),
    ...(input.title === undefined ? {} : { title: input.title }),
    palette: CHART_PALETTE,
  };
}

export interface RenderedChart {
  readonly image: RenderedImage;
  /** The screen-reader sentence and the email image's `alt`: a chart is never the only copy. */
  readonly describedBy: string;
  readonly layout: ChartLayout;
}

/**
 * `scale` multiplies the **bitmap**, never the geometry: the layout is still computed at
 * `spec.width` × `spec.height`, so a 2× render is the same picture at twice the device pixels
 * and the caller keeps declaring the CSS size it always did.
 */
export async function renderChart(
  renderer: DocumentRenderPort,
  input: ChartInput,
  scale = 1,
): Promise<RenderedChart> {
  const spec = buildChartSpec(input);
  const layout = layoutChart(spec);
  const image = await renderer.renderVector(layout.ops, {
    width: spec.width,
    height: spec.height,
    scale,
  });
  return { image, describedBy: layout.describedBy, layout };
}
