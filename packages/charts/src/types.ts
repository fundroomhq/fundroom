import type { VectorOp } from "@fundroom/ports";

/**
 * The chart description the caller builds and the geometry the package answers with
 * (E2.4 contract §7). Deliberately free of colour tokens, locale and I/O: the caller resolves
 * theme tokens to `#rrggbb` and formats numbers, this package only decides where things go.
 */

/**
 * One line / bar series. `x` is the index of the point's column in `ChartSpec.xLabels` — KPI
 * series are periods, which are ordinal, not a continuous axis, so there is nothing to
 * interpolate between columns and a bar chart and a line chart can share one x scale.
 *
 * `y: null` is a **gap**, not a zero. A month nobody entered a number for and a month whose
 * number is genuinely 0 are different facts and a chart that conflates them is lying
 * (contract §6: a derived metric with a missing input yields no point, and that is the truth).
 */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  /** `#rrggbb`, resolved by the caller from theme tokens; this package holds no palette. */
  readonly colour: string;
  readonly points: readonly { readonly x: number; readonly y: number | null }[];
}

export interface ChartPalette {
  readonly axis: string;
  readonly grid: string;
  readonly text: string;
  readonly muted: string;
  readonly background: string;
}

export interface ChartSpec {
  readonly kind: "line" | "bar" | "stacked-bar";
  /** Canvas size in pixels (top-left origin, SVG's convention). */
  readonly width: number;
  readonly height: number;
  readonly series: readonly ChartSeries[];
  readonly xLabels: readonly string[];
  /** Formats an axis value. The caller owns units, currency and locale; §5 keeps the money in
   * fixed point, so this is where a scaled number becomes "€1.2M". */
  readonly yTickFormat: (v: number) => string;
  readonly title?: string | undefined;
  readonly yAxisLabel?: string | undefined;
  readonly palette: ChartPalette;
}

export interface ChartLayout {
  /** The complete drawing, in paint order. Both interpreters replay it verbatim. */
  readonly ops: readonly VectorOp[];
  /** The plot rectangle, for a consumer that overlays hit targets or a tooltip crosshair. */
  readonly plot: { x: number; y: number; w: number; h: number };
  /**
   * The same key the legend ops draw, as data. Returned separately so the SPA can render an
   * accessible HTML list (series toggles, a key beside the chart) without parsing `ops`; a
   * consumer that simply replays `ops` already has the legend drawn and should not draw it twice.
   */
  readonly legend: readonly { readonly label: string; readonly colour: string }[];
  /** A plain-language summary: the `aria-label` on screen and the `alt` on the email image. */
  readonly describedBy: string;
}
