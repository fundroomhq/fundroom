import { type ChartLayout, type ChartSpec, layoutChart } from "@fundroom/charts";
import { cn } from "@fundroomhq/ui";
import { type JSX, useId, useMemo } from "react";
import { m } from "../../paraglide/messages.js";

/*
 * The SVG half of "one geometry, two dumb interpreters" (E2.4 §7).
 *
 * `layoutChart` decides every coordinate; this file decides nothing. It walks
 * `ChartLayout.ops` in paint order and emits one SVG element per op, and the pdf-lib
 * interpreter in `packages/adapters/render-pdfium` walks the same list. That is the whole
 * design: the PNG in an investor's inbox and the chart on the portal are the *same* drawing,
 * so they cannot disagree about where a y axis starts or which month a bar belongs to. If you
 * find yourself wanting to nudge a coordinate here, the nudge belongs in `packages/charts`,
 * where both interpreters will see it.
 *
 * ── CSP ───────────────────────────────────────────────────────────────────────────────────
 * Presentation attributes and classes: `fill=`, `stroke=`, `stroke-width=`, `transform=`, and
 * Tailwind classes for everything else. The app is served under `style-src 'self' 'nonce-…'`,
 * which refuses `<style>` elements without the nonce and `style="…"` attributes that arrive as
 * *markup*. It does not govern a style React sets from the `style` prop — React writes those
 * through the CSSOM (`el.style.setProperty`), which CSP allows — so `packages/ui`'s
 * `VisuallyHidden` is CSP-safe too; the data table uses `sr-only` because it is simpler.
 * (E2.4 blamed VisuallyHidden for the "two violations per page load" E2.2 recorded. They were
 * sonner injecting its stylesheet as an unnonced `<style>`, fixed in E2.10:
 * apps/web/vite.config.ts `sonnerWithoutRuntimeCss`, checked by e2e/tests/40-csp.test.ts.)
 *
 * ── Accessibility ─────────────────────────────────────────────────────────────────────────
 * A chart is where accessibility is usually skipped, and a chart must never be the only place
 * a number exists (§7). So the `<svg>` is `role="img"` with `layout.describedBy` as its name,
 * and the same figures are rendered as a real `<table>` beside it — visually hidden by
 * default, `variant="visible"` when the screen wants the numbers on show. A reader who cannot
 * see the picture gets the sentence *and* the table; nobody has to take our word for a pixel.
 *
 * ── Colour ────────────────────────────────────────────────────────────────────────────────
 * Colours arrive on the spec, resolved from design-system tokens by `./palette.ts`. Nothing
 * here knows a hex. Read the warning in that file before changing one: jsdom computes no
 * colours, so axe's `color-contrast` rule is off and no test in this repo can see a chart
 * drawn in a colour nobody can read.
 */

export type ChartTableVariant = "hidden" | "visible" | "none";

export interface ChartSvgProps {
  readonly spec: ChartSpec;
  /** Class on the wrapper. The `<svg>` itself is always `h-auto w-full` inside it. */
  readonly className?: string | undefined;
  /**
   * How the numbers appear as text beside the picture. `"none"` is only correct when the same
   * values are already on the page in a table of the caller's own — the metric tiles do that.
   */
  readonly table?: ChartTableVariant | undefined;
  /** Cell formatter for the data table; defaults to the spec's axis formatter. */
  readonly formatValue?: ((v: number) => string) | undefined;
}

/** `[v, v]` → `"v v"`; an empty dash array means a solid line and emits no attribute. */
function dashOf(dash: readonly number[] | undefined): string | undefined {
  return dash === undefined || dash.length === 0 ? undefined : dash.join(" ");
}

function opElement(op: ChartLayout["ops"][number], key: number): JSX.Element | null {
  switch (op.op) {
    case "rect":
      return (
        <rect
          key={key}
          x={op.x}
          y={op.y}
          width={op.w}
          height={op.h}
          fill={op.fill ?? "none"}
          stroke={op.stroke}
          strokeWidth={op.strokeWidth}
        />
      );
    case "line":
      return (
        <line
          key={key}
          x1={op.x1}
          y1={op.y1}
          x2={op.x2}
          y2={op.y2}
          stroke={op.stroke}
          strokeWidth={op.strokeWidth}
          strokeDasharray={dashOf(op.dash)}
        />
      );
    case "polyline":
      return (
        <polyline
          key={key}
          points={op.points.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke={op.stroke}
          strokeWidth={op.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "text":
      return (
        <text
          key={key}
          x={op.x}
          y={op.y}
          fontSize={op.size}
          fill={op.fill}
          textAnchor={op.anchor ?? "start"}
          fontWeight={op.weight === "bold" ? 700 : undefined}
          /*
           * C-E.6: `rotate` is degrees **clockwise about (x, y)** — SVG's own sign — and is
           * emitted verbatim with no sign change of our own. The pdf-lib interpreter negates
           * it in the same place it flips y, because PDF turns the other way. A left-hand y
           * axis label arrives here as -90 and must stay -90.
           */
          transform={op.rotate === undefined ? undefined : `rotate(${op.rotate} ${op.x} ${op.y})`}
        >
          {op.text}
        </text>
      );
    default:
      // A newer `packages/charts` emitting an op this build does not know draws nothing
      // rather than throwing: the data table beside it still carries every number.
      return null;
  }
}

/** Columns the layout used: `xLabels`, widened by any series that reaches past them (C-E.7). */
function columnCount(spec: ChartSpec): number {
  let columns = spec.xLabels.length;
  for (const series of spec.series) {
    for (const p of series.points) {
      if (Number.isInteger(p.x) && p.x + 1 > columns) columns = p.x + 1;
    }
  }
  return columns;
}

function ChartTable({
  spec,
  columns,
  caption,
  format,
  variant,
}: {
  spec: ChartSpec;
  columns: number;
  caption: string;
  format: (v: number) => string;
  variant: Exclude<ChartTableVariant, "none">;
}) {
  const headers = Array.from({ length: columns }, (_, i) => spec.xLabels[i] ?? String(i + 1));
  return (
    <div className={variant === "hidden" ? "sr-only" : "mt-3 overflow-x-auto"}>
      <table className={variant === "visible" ? "w-full text-sm" : undefined}>
        <caption className={variant === "visible" ? "sr-only" : undefined}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{m.metrics_chart_series_column()}</th>
            {headers.map((label, i) => (
              <th
                key={`${label}-${i}`}
                scope="col"
                className={variant === "visible" ? "px-2 py-1 text-right font-medium" : undefined}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.series.map((series) => {
            const byColumn = new Array<number | null>(columns).fill(null);
            for (const p of series.points) {
              if (Number.isInteger(p.x) && p.x >= 0 && p.x < columns) byColumn[p.x] = p.y;
            }
            return (
              <tr key={series.key}>
                <th
                  scope="row"
                  className={variant === "visible" ? "px-2 py-1 text-left font-medium" : undefined}
                >
                  {series.label}
                </th>
                {byColumn.map((v, i) => (
                  <td
                    key={`${series.key}-${i}`}
                    className={
                      variant === "visible" ? "px-2 py-1 text-right tabular-nums" : undefined
                    }
                  >
                    {/* A gap is a gap: §7 says `y: null` is missing data, never a zero. */}
                    {v === null ? m.metrics_no_value() : format(v)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Replays a `ChartLayout` as SVG. Default-exported so `./index.tsx` can `React.lazy` it and
 * keep `@fundroom/charts` out of the investor entry chunk.
 */
export default function ChartSvg({
  spec,
  className,
  table = "hidden",
  formatValue,
}: ChartSvgProps): JSX.Element {
  const layout = useMemo(() => layoutChart(spec), [spec]);
  const titleId = useId();
  const columns = columnCount(spec);
  const format = formatValue ?? spec.yTickFormat;
  const width = Math.max(160, Math.round(spec.width));
  const height = Math.max(100, Math.round(spec.height));
  return (
    <div className={cn("w-full", className)}>
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="h-auto w-full"
        // `preserveAspectRatio` is an attribute, not a style: the chart scales with its
        // container without a single inline declaration.
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{layout.describedBy}</title>
        {layout.ops.map((op, i) => opElement(op, i))}
      </svg>
      {table === "none" ? null : (
        <ChartTable
          spec={spec}
          columns={columns}
          caption={layout.describedBy}
          format={format}
          variant={table}
        />
      )}
    </div>
  );
}
