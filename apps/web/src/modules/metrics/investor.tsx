import type { ChartSpec } from "@fundroom/charts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, BarChart3 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Chart, useChartPalette } from "../../components/charts/index.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  CALENDAR_PERIOD_KINDS,
  type CalendarPeriodKind,
  type MetricPeriod,
  type MetricSeriesEntry,
  metricSeriesQuery,
  parseValue,
} from "../../lib/metrics-queries.js";
import { m } from "../../paraglide/messages.js";
import {
  axisFormatter,
  formatMetricValue,
  type MetricFormat,
  metricDelta,
  periodKeyLabel,
  periodKindLabel,
} from "./format.js";

/*
 * KPIs, reader side (E2.4). `GET /metrics/series` is `member`, not a permission: what an
 * investor sees is decided by each metric's **audience**, in RLS, not by RBAC.
 *
 * So this screen renders exactly what came back and nothing else. There is no "hidden metric"
 * placeholder and no count of what was withheld — that would tell a reader that a number
 * exists which the workspace chose not to show them, which is most of what a per-metric
 * audience is for. A reader admitted to nothing sees an empty state, indistinguishable from a
 * workspace that publishes no KPIs at all.
 */

function latestIndex(values: readonly (string | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

function previousIndex(values: readonly (string | null)[], before: number): number {
  for (let i = before - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

function SeriesCard({
  entry,
  periods,
}: {
  entry: MetricSeriesEntry;
  periods: readonly MetricPeriod[];
}) {
  const theme = useChartPalette();
  const format: MetricFormat = {
    unit: entry.unit,
    currency: entry.currency,
    decimals: entry.decimals,
  };
  const last = latestIndex(entry.values);
  const prev = previousIndex(entry.values, last);
  const delta = metricDelta(
    last < 0 ? null : entry.values[last],
    prev < 0 ? null : entry.values[prev],
    entry.direction,
  );
  const spec = useMemo<ChartSpec | undefined>(() => {
    const points = entry.values.map((v, x) => ({ x, y: parseValue(v ?? undefined) ?? null }));
    if (!points.some((p) => p.y !== null)) return undefined;
    return {
      kind: "line",
      width: 520,
      height: 220,
      series: [
        {
          key: entry.key,
          label: entry.name,
          colour: theme.series[0] ?? theme.palette.text,
          points,
        },
      ],
      xLabels: periods.map((p) => periodKeyLabel(p.key, p.label)),
      yTickFormat: axisFormatter({
        unit: entry.unit,
        currency: entry.currency,
        decimals: entry.decimals,
      }),
      palette: theme.palette,
    };
  }, [entry, periods, theme]);

  const lastPeriod = last >= 0 ? periods[last] : undefined;
  const Arrow =
    delta === undefined || delta.absolute === 0 ? ArrowRight : delta.rising ? ArrowUp : ArrowDown;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry.name}</CardTitle>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-2xl font-semibold tabular-nums">
            {formatMetricValue(last < 0 ? null : entry.values[last], format)}
          </span>
          {lastPeriod ? (
            <span className="text-xs text-muted-foreground">
              {periodKeyLabel(lastPeriod.key, lastPeriod.label)}
            </span>
          ) : null}
          {delta === undefined ? null : (
            <Badge
              variant={
                delta.tone === "good" ? "success" : delta.tone === "bad" ? "destructive" : "outline"
              }
            >
              <Arrow aria-hidden="true" className="size-3" />
              {delta.absolute === 0
                ? m.metrics_delta_unchanged()
                : m.metrics_delta_summary({
                    magnitude:
                      delta.percent === undefined
                        ? formatMetricValue(Math.abs(delta.absolute), format)
                        : m.metrics_delta_percent({ percent: Math.abs(delta.percent).toFixed(1) }),
                    word:
                      delta.tone === "good"
                        ? m.metrics_delta_better()
                        : delta.tone === "bad"
                          ? m.metrics_delta_worse()
                          : m.metrics_delta_unchanged(),
                  })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {spec ? (
          <Chart spec={spec} formatValue={(v) => formatMetricValue(v, format)} />
        ) : (
          <p className="text-sm text-muted-foreground">{m.metrics_tile_no_series()}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function MetricsInvestor() {
  const [periodKind, setPeriodKind] = useState<CalendarPeriodKind>("month");
  const [periods, setPeriods] = useState(12);
  const kindId = useId();
  const countId = useId();
  const series = useQuery(metricSeriesQuery(periodKind, periods));
  const entries = series.data?.series ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title={m.metrics_investor_title()} description={m.metrics_investor_subtitle()} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={kindId} className="text-sm font-medium">
            {m.metrics_grid_period_kind()}
          </label>
          <NativeSelect
            id={kindId}
            value={periodKind}
            className="w-40"
            onChange={(e) => setPeriodKind(e.target.value as CalendarPeriodKind)}
          >
            {CALENDAR_PERIOD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {periodKindLabel(kind)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor={countId} className="text-sm font-medium">
            {m.metrics_grid_period_count()}
          </label>
          <NativeSelect
            id={countId}
            value={String(periods)}
            className="w-28"
            onChange={(e) => setPeriods(Number(e.target.value))}
          >
            {[6, 12, 24, 36].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {series.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {series.isError ? <ErrorAlert error={series.error} /> : null}
      {series.data ? (
        entries.length === 0 ? (
          <EmptyState
            icon={<BarChart3 aria-hidden="true" />}
            title={m.metrics_investor_empty_title()}
            description={m.metrics_investor_empty_body()}
          />
        ) : (
          <ul className="grid list-none gap-6 lg:grid-cols-2">
            {entries.map((entry) => (
              <li key={entry.definitionId}>
                <SeriesCard entry={entry} periods={series.data.periods} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
