import type {
  CaptableFormat,
  CaptableInvestorView,
  CaptableSecurityKind,
  CaptableSnapshotStatus,
  CaptableSource,
} from "../../lib/captable-queries.js";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

/*
 * How a cap table reads on screen (E3.6 §8).
 *
 * Share counts and amounts arrive as decimal strings and are handed to `Intl.NumberFormat`
 * **as strings**: ES2023's `format("12345678.000001")` formats the decimal exactly, where
 * `Number()` first would round a large share count to the nearest double. Nothing here adds or
 * compares two figures — the server computed every total — so no float ever holds a number
 * of shares. Enum labels end in `default: return raw` so an unknown value is shown as sent.
 */

const DECIMAL = /^-?\d+(?:\.\d+)?$/u;

/** A plain decimal string, as `Intl` accepts it: the `numeric` text form never has an exponent. */
type Decimal = `${number}`;

function asDecimal(text: string | null | undefined): Decimal | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? (trimmed as Decimal) : undefined;
}

export function formatShares(shares: string | null | undefined): string {
  const value = asDecimal(shares);
  if (value === undefined) return shares ?? "—";
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 6 }).format(value);
}

export function formatAmount(amount: string | null | undefined, currency: string | null): string {
  const value = asDecimal(amount);
  if (value === undefined) return amount ?? "—";
  const locale = getLocale();
  // Without a (known) currency there are no minor units to go by: keep the stored precision.
  const plain = () => new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  if (currency === null) return plain();
  try {
    // The currency's own minor units (2 for USD, 3 for KWD/BHD, 0 for JPY), never a fixed 2:
    // a KWD principal rounded to fils-tens would misstate what was invested. Whole amounts drop
    // their zeros ("$500,000", not "$500,000.00").
    const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).resolvedOptions();
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits,
    }).format(value);
  } catch {
    // An unknown ISO code throws rather than guessing; the figure still has to be readable.
    return `${plain()} ${currency}`;
  }
}

/** A percentage the server already rounded (4 dp): printed with a `%`, never recomputed here. */
export function formatPercent(percent: string | null | undefined): string {
  const value = asDecimal(percent);
  if (value === undefined) return percent ?? "—";
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)}%`;
}

/** An investor-summary bucket's share, which the server sends to exactly one decimal place. */
export function formatBucketPercent(percent: string): string {
  const value = asDecimal(percent);
  if (value === undefined) return percent;
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

export function bucketLabel(kind: string): string {
  switch (kind) {
    case "common":
      return m.captable_bucket_common();
    case "preferred":
      return m.captable_bucket_preferred();
    case "options":
      return m.captable_bucket_options();
    case "warrants":
      return m.captable_bucket_warrants();
    default:
      return kind;
  }
}

/**
 * An `as of` date (`YYYY-MM-DD`). A calendar date, not an instant: formatted in UTC so a
 * reader west of Greenwich does not see the day before.
 */
export function formatAsOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeZone: "UTC" }).format(d);
}

export function classKindLabel(kind: CaptableSecurityKind | string): string {
  switch (kind) {
    case "common":
      return m.captable_kind_common();
    case "preferred":
      return m.captable_kind_preferred();
    case "option_pool":
      return m.captable_kind_option_pool();
    case "option":
      return m.captable_kind_option();
    case "warrant":
      return m.captable_kind_warrant();
    case "safe":
      return m.captable_kind_safe();
    case "note":
      return m.captable_kind_note();
    default:
      return kind;
  }
}

export function statusLabel(status: CaptableSnapshotStatus | string): string {
  switch (status) {
    case "draft":
      return m.captable_status_draft();
    case "published":
      return m.captable_status_published();
    case "superseded":
      return m.captable_status_superseded();
    default:
      return status;
  }
}

export function statusVariant(
  status: CaptableSnapshotStatus | string,
): "success" | "secondary" | "outline" {
  return status === "published" ? "success" : status === "draft" ? "secondary" : "outline";
}

export function sourceLabel(source: CaptableSource | string): string {
  switch (source) {
    case "csv":
      return m.captable_source_csv();
    case "carta":
      return m.captable_source_carta();
    case "pulley":
      return m.captable_source_pulley();
    default:
      return source;
  }
}

export function formatLabel(format: CaptableFormat): string {
  switch (format) {
    case "template":
      return m.captable_format_template();
    case "carta":
      return m.captable_format_carta();
    case "pulley":
      return m.captable_format_pulley();
  }
}

export function investorViewLabel(view: CaptableInvestorView): string {
  switch (view) {
    case "own_line":
      return m.captable_view_own_line();
    case "summary":
      return m.captable_view_summary();
    case "none":
      return m.captable_view_none();
  }
}

/** Why the server refused a CSV (`captable_import_invalid`'s `reason`). */
export function importReasonLabel(reason: string): string {
  switch (reason) {
    case "empty":
      return m.captable_reason_empty();
    case "too_large":
      return m.captable_reason_too_large();
    case "too_many_rows":
      return m.captable_reason_too_many_rows();
    case "missing_columns":
      return m.captable_reason_missing_columns();
    case "duplicate_column":
      return m.captable_reason_duplicate_column();
    case "invalid_rows":
      return m.captable_reason_invalid_rows();
    default:
      return reason;
  }
}

/** "Line 4, column shares: …" — where a warning or problem is, then what the server said. */
export function problemText(p: {
  line: number | null;
  column: string | null;
  message: string;
}): string {
  if (p.line !== null && p.column !== null)
    return m.captable_problem_line_column({
      line: String(p.line),
      column: p.column,
      message: p.message,
    });
  if (p.line !== null) return m.captable_problem_line({ line: String(p.line), message: p.message });
  if (p.column !== null) return m.captable_problem_column({ column: p.column, message: p.message });
  return p.message;
}
