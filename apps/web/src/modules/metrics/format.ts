import { type MetricDirection, type MetricUnit, parseValue } from "../../lib/metrics-queries.js";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

/*
 * How a KPI reads on screen. Units, currency and locale are the *client's* business (the
 * contract keeps `packages/charts` free of all three and ships values as decimal strings), so
 * this is the one file that turns "1250000.000000" into "€1,250,000".
 *
 * Two rules travel with the numbers and are easy to get wrong:
 *  - a missing value is missing, not zero. `null` renders as an em dash everywhere;
 *  - `direction` says which way is *good*, not which way is up. A falling burn rate is good
 *    news and must not be painted red.
 */

export interface MetricFormat {
  readonly unit: MetricUnit;
  readonly currency: string | null;
  readonly decimals: number;
}

export function formatMetricValue(
  value: string | number | null | undefined,
  format: MetricFormat,
): string {
  const n = typeof value === "number" ? value : parseValue(value ?? undefined);
  if (n === undefined) return m.metrics_no_value();
  const locale = getLocale();
  const digits = { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals };
  switch (format.unit) {
    case "currency":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: format.currency ?? "USD",
        ...digits,
      }).format(n);
    case "percent":
      // The server stores a percentage as the number a person typed (12.5 means 12.5%), so this
      // is the `percent` *unit* (the locale decides where the sign goes and whether a space
      // precedes it), not `style: "percent"`, which would multiply by 100.
      return new Intl.NumberFormat(locale, { style: "unit", unit: "percent", ...digits }).format(n);
    case "days":
      return m.metrics_unit_days_value({ value: new Intl.NumberFormat(locale, digits).format(n) });
    case "months":
      return m.metrics_unit_months_value({
        value: new Intl.NumberFormat(locale, digits).format(n),
      });
    default:
      return new Intl.NumberFormat(locale, digits).format(n);
  }
}

/**
 * Axis ticks: short enough to fit a 56px gutter, so thousands collapse through `Intl`'s compact
 * notation ("12K", "1.2M" in English; the locale's own abbreviations elsewhere). Currency and
 * the percent unit are formatted by the same `Intl.NumberFormat`, never by string suffixes.
 */
export function axisFormatter(format: MetricFormat): (v: number) => string {
  const locale = getLocale();
  const unit: Intl.NumberFormatOptions =
    format.unit === "currency"
      ? { style: "currency", currency: format.currency ?? "USD" }
      : format.unit === "percent"
        ? { style: "unit", unit: "percent" }
        : {};
  return (v: number): string => {
    // Below 10 000 the figure is short already; above it two significant digits ("12K",
    // "1.2M") are what a tick has room for.
    const options: Intl.NumberFormatOptions =
      Math.abs(v) >= 10_000
        ? { notation: "compact", compactDisplay: "short", maximumSignificantDigits: 2 }
        : { minimumFractionDigits: 0, maximumFractionDigits: Math.min(format.decimals, 2) };
    return new Intl.NumberFormat(locale, { ...unit, ...options }).format(v);
  };
}

/**
 * A period's name from its key (`2026-07`, `2026-Q3`, `2026`, `2026-07-01/2026-08-01`), in the
 * reader's locale. The server sends an English `label` too (`Jul 2026`); it is the fallback for
 * a key this client does not recognise, never what is shown when the key can be read.
 */
export function periodKeyLabel(key: string, fallback?: string): string {
  const locale = getLocale();
  const utc = (y: number, m0: number, d = 1) => new Date(Date.UTC(y, m0, d));
  const month = /^(\d{4})-(\d{2})$/u.exec(key);
  if (month) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(utc(Number(month[1]), Number(month[2]) - 1));
  }
  const quarter = /^(\d{4})-Q([1-4])$/u.exec(key);
  if (quarter) {
    return m.metrics_period_quarter_label({
      quarter: quarter[2] ?? "",
      year: new Intl.NumberFormat(locale, { useGrouping: false }).format(Number(quarter[1])),
    });
  }
  if (/^\d{4}$/u.test(key)) {
    return new Intl.DateTimeFormat(locale, { year: "numeric", timeZone: "UTC" }).format(
      utc(Number(key), 0),
    );
  }
  const range = /^(\d{4})-(\d{2})-(\d{2})\/(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
  if (range) {
    const f = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    return m.metrics_period_range({
      start: f.format(utc(Number(range[1]), Number(range[2]) - 1, Number(range[3]))),
      end: f.format(utc(Number(range[4]), Number(range[5]) - 1, Number(range[6]))),
    });
  }
  return fallback ?? key;
}

export type DeltaTone = "good" | "bad" | "neutral";

export interface MetricDelta {
  readonly absolute: number;
  readonly percent: number | undefined;
  readonly tone: DeltaTone;
  readonly rising: boolean;
}

/**
 * The change from `previous` to `latest`, and whether that change is good news. `undefined`
 * when either end is missing — a delta against nothing is not zero, it is unknowable.
 */
export function metricDelta(
  latest: string | null | undefined,
  previous: string | null | undefined,
  direction: MetricDirection,
): MetricDelta | undefined {
  const a = parseValue(latest ?? undefined);
  const b = parseValue(previous ?? undefined);
  if (a === undefined || b === undefined) return undefined;
  const absolute = a - b;
  // Division by a zero baseline has no percentage; the absolute change still does.
  const percent = b === 0 ? undefined : (absolute / Math.abs(b)) * 100;
  const rising = absolute > 0;
  const tone: DeltaTone =
    absolute === 0 || direction === "neutral"
      ? "neutral"
      : (rising && direction === "up_good") || (!rising && direction === "down_good")
        ? "good"
        : "bad";
  return { absolute, percent, tone, rising };
}

export function unitLabel(unit: MetricUnit): string {
  switch (unit) {
    case "currency":
      return m.metrics_unit_currency();
    case "count":
      return m.metrics_unit_count();
    case "percent":
      return m.metrics_unit_percent();
    case "ratio":
      return m.metrics_unit_ratio();
    case "days":
      return m.metrics_unit_days();
    default:
      return m.metrics_unit_months();
  }
}

export function directionLabel(direction: MetricDirection): string {
  switch (direction) {
    case "up_good":
      return m.metrics_direction_up_good();
    case "down_good":
      return m.metrics_direction_down_good();
    default:
      return m.metrics_direction_neutral();
  }
}

export function aggregationLabel(aggregation: "sum" | "last" | "avg"): string {
  switch (aggregation) {
    case "sum":
      return m.metrics_aggregation_sum();
    case "avg":
      return m.metrics_aggregation_avg();
    default:
      return m.metrics_aggregation_last();
  }
}

export function periodKindLabel(kind: "month" | "quarter" | "year" | "custom"): string {
  switch (kind) {
    case "month":
      return m.metrics_period_month();
    case "quarter":
      return m.metrics_period_quarter();
    case "year":
      return m.metrics_period_year();
    default:
      return m.metrics_period_custom();
  }
}

export function sourceLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "manual":
      return m.metrics_source_manual();
    case "csv":
      return m.metrics_source_csv();
    case "sheets":
      return m.metrics_source_sheets();
    case "derived":
      return m.metrics_source_derived();
    // E3.6 KPI sources: the provider is the source.
    case "quickbooks":
      return m.metrics_kpi_provider_quickbooks();
    case "xero":
      return m.metrics_kpi_provider_xero();
    case "stripe":
      return m.metrics_kpi_provider_stripe();
    default:
      return m.metrics_source_unknown();
  }
}
