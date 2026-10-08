import { MetricsError } from "./errors.js";

/*
 * Calendar periods (E2.4 §4, decision D1). Pure: no drizzle, no pg, no locale.
 *
 * Every range is half-open `[start, end)` and canonicalised in **UTC**, and there is no
 * fiscal-year setting. That is a decision, not an omission. A fiscal-year start re-buckets
 * *stored history* the moment somebody changes it: the `tstzrange` already written keeps its
 * bounds while the label the UI derives from it moves, so a number that was published as Q1
 * silently becomes Q2 and no migration can tell which reading a reader saw. Companies whose
 * year does not start in January use `custom` ranges, which say what they mean.
 *
 * All arithmetic goes through `Date.UTC`, never through the local-time constructor: the server
 * that renders a chart is in whatever zone the operator's host is in, and a month boundary
 * computed there is the wrong instant for every other reader.
 */

export const PERIOD_KINDS = ["month", "quarter", "year", "custom"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** Kinds with a canonical range derivable from an instant — everything but `custom`. */
export type CalendarPeriodKind = Exclude<PeriodKind, "custom">;

export interface Period {
  readonly kind: PeriodKind;
  readonly start: Date;
  readonly end: Date;
}

/** Locale-independent month abbreviations: the same three letters in an email and on screen. */
const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/u;
const QUARTER_KEY_RE = /^(\d{4})-Q([1-4])$/u;
const YEAR_KEY_RE = /^(\d{4})$/u;
const CUSTOM_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})\/(\d{4})-(\d{2})-(\d{2})$/u;

const utc = (year: number, month: number, day = 1): Date =>
  new Date(Date.UTC(year, month, day, 0, 0, 0, 0));

/**
 * `Date.UTC` happily accepts 2026-02-30 and rolls it into March, which would turn a typo in a
 * CSV into a period that is off by a day and looks fine. Round-tripping the components is the
 * cheapest way to refuse it.
 */
function utcDateOrUndefined(year: number, month1: number, day: number): Date | undefined {
  if (year < 1 || month1 < 1 || month1 > 12 || day < 1 || day > 31) return undefined;
  const d = utc(year, month1 - 1, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month1 - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return d;
}

/**
 * The canonical half-open UTC range containing `instant`.
 *
 * Throws for `custom`, which has no canonical range by definition — the caller supplies its
 * bounds. The type already excludes it; the runtime check is there because the kind usually
 * arrives from a database column and the type system does not reach that far.
 */
export function periodFor(kind: CalendarPeriodKind, instant: Date): Period {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  switch (kind) {
    case "month":
      return { kind, start: utc(year, month), end: utc(year, month + 1) };
    case "quarter": {
      const firstMonth = Math.floor(month / 3) * 3;
      return { kind, start: utc(year, firstMonth), end: utc(year, firstMonth + 3) };
    }
    case "year":
      return { kind, start: utc(year, 0), end: utc(year + 1, 0) };
    default:
      throw new MetricsError(
        "validation_failed",
        "a custom period has no canonical range; supply its bounds",
        { kind },
      );
  }
}

/**
 * `2026-03` | `2026-Q1` | `2026` — the spelling used on the wire, in CSV headers and in a
 * chart token. A `custom` period has no such name, so it spells out its own bounds as the ISO
 * date pair `2026-01-05/2026-02-09`; the second date is the **exclusive** end, matching the
 * range the row stores.
 */
export function formatPeriodKey(p: Period): string {
  const year = p.start.getUTCFullYear().toString().padStart(4, "0");
  switch (p.kind) {
    case "month":
      return `${year}-${(p.start.getUTCMonth() + 1).toString().padStart(2, "0")}`;
    case "quarter":
      return `${year}-Q${Math.floor(p.start.getUTCMonth() / 3) + 1}`;
    case "year":
      return year;
    default:
      return `${isoDate(p.start)}/${isoDate(p.end)}`;
  }
}

function isoDate(d: Date): string {
  const year = d.getUTCFullYear().toString().padStart(4, "0");
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

/**
 * Parses the three calendar spellings and the custom date pair. `undefined` for anything else,
 * and it never throws: this runs on a CSV cell and on a query string, where a bad value is a
 * row to report, not a request to fail.
 */
export function parsePeriodKey(kind: PeriodKind, key: string): Period | undefined {
  switch (kind) {
    case "month": {
      const m = MONTH_KEY_RE.exec(key);
      const yearText = m?.[1];
      const monthText = m?.[2];
      if (yearText === undefined || monthText === undefined) return undefined;
      const year = Number(yearText);
      const month = Number(monthText);
      if (year < 1 || month < 1 || month > 12) return undefined;
      return { kind, start: utc(year, month - 1), end: utc(year, month) };
    }
    case "quarter": {
      const m = QUARTER_KEY_RE.exec(key);
      const yearText = m?.[1];
      const quarterText = m?.[2];
      if (yearText === undefined || quarterText === undefined) return undefined;
      const year = Number(yearText);
      if (year < 1) return undefined;
      const firstMonth = (Number(quarterText) - 1) * 3;
      return { kind, start: utc(year, firstMonth), end: utc(year, firstMonth + 3) };
    }
    case "year": {
      const yearText = YEAR_KEY_RE.exec(key)?.[1];
      if (yearText === undefined) return undefined;
      const year = Number(yearText);
      if (year < 1) return undefined;
      return { kind, start: utc(year, 0), end: utc(year + 1, 0) };
    }
    default: {
      const m = CUSTOM_KEY_RE.exec(key);
      if (m === null) return undefined;
      const [, y1, m1, d1, y2, m2, d2] = m;
      if (y1 === undefined || m1 === undefined || d1 === undefined) return undefined;
      if (y2 === undefined || m2 === undefined || d2 === undefined) return undefined;
      const start = utcDateOrUndefined(Number(y1), Number(m1), Number(d1));
      const end = utcDateOrUndefined(Number(y2), Number(m2), Number(d2));
      if (start === undefined || end === undefined) return undefined;
      // Half-open and non-empty: `2026-01-05/2026-01-05` is a period containing no instant,
      // which the `point_period_nonempty` CHECK would reject anyway.
      if (start.getTime() >= end.getTime()) return undefined;
      return { kind, start, end };
    }
  }
}

/**
 * `n` periods ending with the one containing `instant`, oldest first — the sparkline window
 * and the x axis of a chart. Walking back by calendar step rather than by a fixed number of
 * milliseconds is what makes February and a leap year come out right.
 */
export function periodSeries(kind: CalendarPeriodKind, instant: Date, n: number): Period[] {
  const count = Math.trunc(n);
  if (count <= 0) return [];
  const last = periodFor(kind, instant);
  const step = kind === "month" ? 1 : kind === "quarter" ? 3 : 12;
  const year = last.start.getUTCFullYear();
  const month = last.start.getUTCMonth();
  const out: Period[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const first = month - i * step;
    out.push({ kind, start: utc(year, first), end: utc(year, first + step) });
  }
  return out;
}

/**
 * What a reader sees above a number: "Mar 2026", "Q1 2026", "2026". Deliberately not
 * `toLocaleDateString` — this string is rendered on the server into an email that is read
 * anywhere, so a label that depends on the *server's* locale would be arbitrary rather than
 * localised. Real localisation belongs in the SPA's message catalogue, from the period key.
 */
export function periodLabel(p: Period): string {
  const year = p.start.getUTCFullYear();
  switch (p.kind) {
    case "month":
      return `${MONTH_ABBREVIATIONS[p.start.getUTCMonth()] ?? "?"} ${year}`;
    case "quarter":
      return `Q${Math.floor(p.start.getUTCMonth() / 3) + 1} ${year}`;
    case "year":
      return `${year}`;
    default:
      return `${longDate(p.start)} – ${longDate(p.end)}`;
  }
}

function longDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_ABBREVIATIONS[d.getUTCMonth()] ?? "?"} ${d.getUTCFullYear()}`;
}
