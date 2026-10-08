import type { ChartSpec } from "@fundroom/charts";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@fundroomhq/ui";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useMemo } from "react";
import { Chart, useChartPalette } from "../../components/charts/index.js";
import { parseValue } from "../../lib/metrics-queries.js";
import { m } from "../../paraglide/messages.js";
import {
  axisFormatter,
  formatMetricValue,
  type MetricFormat,
  metricDelta,
  periodKeyLabel,
} from "./format.js";

/*
 * One KPI as a tile: the latest figure, how it moved against the period before it, and the
 * recent series as a small chart. Used by the investor surface and by the `metric_grid`
 * content block, which is why it takes the frozen §10 tile shape rather than a query result.
 */

/** §10's `MetricGridHydrated.metrics[]`, as the SPA reads it. Frozen — see the contract. */
export interface MetricTileData {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly unit: MetricFormat["unit"];
  readonly currency: string | null;
  readonly decimals: number;
  readonly direction: "up_good" | "down_good" | "neutral";
  readonly latest: {
    readonly periodKey: string;
    readonly periodLabel: string;
    readonly value: string;
  } | null;
  readonly previous: { readonly periodKey: string; readonly value: string } | null;
  readonly sparkline: readonly (string | null)[];
  /** The columns `sparkline` is indexed by, aligned index for index and oldest first. */
  readonly periods: readonly { readonly key: string; readonly label: string }[];
}

/**
 * The delta, in words as well as in colour. Colour alone fails WCAG 1.4.1 and fails anyone
 * reading in monochrome, so "better"/"worse" is spelled out and an arrow says which way the
 * number itself moved — which is not the same question (a falling burn rate is better).
 */
function DeltaBadge({ tile }: { tile: MetricTileData }) {
  const delta = metricDelta(tile.latest?.value, tile.previous?.value, tile.direction);
  if (delta === undefined) return null;
  const Arrow = delta.absolute === 0 ? ArrowRight : delta.rising ? ArrowUp : ArrowDown;
  const format: MetricFormat = {
    unit: tile.unit,
    currency: tile.currency,
    decimals: tile.decimals,
  };
  const magnitude =
    delta.percent === undefined
      ? formatMetricValue(Math.abs(delta.absolute), format)
      : m.metrics_delta_percent({ percent: Math.abs(delta.percent).toFixed(1) });
  const word =
    delta.tone === "good"
      ? m.metrics_delta_better()
      : delta.tone === "bad"
        ? m.metrics_delta_worse()
        : m.metrics_delta_unchanged();
  return (
    <Badge
      variant={delta.tone === "good" ? "success" : delta.tone === "bad" ? "destructive" : "outline"}
    >
      <Arrow aria-hidden="true" className="size-3" />
      {delta.absolute === 0 ? word : m.metrics_delta_summary({ magnitude, word })}
    </Badge>
  );
}

/**
 * Column headings for a sparkline: the period each value belongs to, named the way the rest of
 * the screen names it. These are the headers of the chart's accessible table and the ends of
 * the sentence `layoutChart` writes for its `describedBy`, so a screen-reader user hears
 * "covering Jul 2026 to Sep 2026" rather than "11 periods ago to Latest" — a chart whose axis
 * cannot be named is a chart that user cannot read (§12 C-F.1, now on the payload as
 * `periods`, aligned index for index with `sparkline`).
 *
 * The positional fallback is for a payload from a server older than C-F.1, which sends no
 * `periods` at all: "3 periods ago" at least says *when*, where a bare column number would say
 * nothing. It is per column, so a short array still labels the columns it does cover.
 */
function sparklineLabels(periods: MetricTileData["periods"], count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      (periods[i] ? periodKeyLabel(periods[i].key, periods[i].label) : undefined) ??
      (i === count - 1
        ? m.metrics_period_latest()
        : m.metrics_periods_ago({ count: String(count - 1 - i) })),
  );
}

export function MetricTile({ tile }: { tile: MetricTileData }) {
  const theme = useChartPalette();
  const format: MetricFormat = {
    unit: tile.unit,
    currency: tile.currency,
    decimals: tile.decimals,
  };
  // Memoised on the tile itself: `ChartSvg` memoises the layout on the spec's identity, so a
  // spec rebuilt every render would re-run `layoutChart` on every render.
  const spec = useMemo<ChartSpec | undefined>(() => {
    const points = tile.sparkline.map((v, x) => ({ x, y: parseValue(v ?? undefined) ?? null }));
    if (!points.some((p) => p.y !== null)) return undefined;
    return {
      kind: "line",
      width: 260,
      height: 120,
      series: [
        {
          key: tile.key,
          label: tile.name,
          colour: theme.series[0] ?? theme.palette.text,
          points,
        },
      ],
      xLabels: sparklineLabels(tile.periods, points.length),
      yTickFormat: axisFormatter({
        unit: tile.unit,
        currency: tile.currency,
        decimals: tile.decimals,
      }),
      palette: theme.palette,
    };
  }, [tile, theme]);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{tile.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">
            {formatMetricValue(tile.latest?.value, format)}
          </span>
          {tile.latest ? (
            <span className="text-xs text-muted-foreground">
              {periodKeyLabel(tile.latest.periodKey, tile.latest.periodLabel)}
            </span>
          ) : null}
        </div>
        <DeltaBadge tile={tile} />
        {spec ? (
          <Chart spec={spec} formatValue={(v) => formatMetricValue(v, format)} />
        ) : (
          <p className="text-sm text-muted-foreground">{m.metrics_tile_no_series()}</p>
        )}
      </CardContent>
    </Card>
  );
}
