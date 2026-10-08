/*
 * Calendar months as `YYYY-MM` strings, always UTC (copied verbatim between the three KPI adapters;
 * see the note in `http.ts`).
 */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
/** 50 years of months; a wider request is a caller bug, not a report to build. */
export const MAX_MONTHS = 600;

export interface Ym {
  year: number;
  month: number; // 1..12
}

export function parseMonth(value: string): Ym | null {
  const match = MONTH.exec(value);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatMonth(ym: Ym): string {
  return `${String(ym.year).padStart(4, "0")}-${String(ym.month).padStart(2, "0")}`;
}

export function addMonths(ym: Ym, delta: number): Ym {
  const index = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function compareMonths(a: Ym, b: Ym): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

export function currentMonth(now: Date): Ym {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** `YYYY-MM-01` */
export function firstDay(ym: Ym): string {
  return `${formatMonth(ym)}-01`;
}

/** 28..31 */
export function daysInMonth(ym: Ym): number {
  return new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
}

/** `YYYY-MM-DD` of the month's last day. */
export function lastDay(ym: Ym): string {
  return `${formatMonth(ym)}-${String(daysInMonth(ym)).padStart(2, "0")}`;
}

/** Unix seconds of the first instant of the month (UTC). */
export function monthStartUnix(ym: Ym): number {
  return Date.UTC(ym.year, ym.month - 1, 1) / 1000;
}

export function monthOfUnix(seconds: number): string {
  const date = new Date(seconds * 1000);
  return formatMonth({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
}

/**
 * The months a KPI read covers: `from..to` inclusive, clamped to the current month (a report for a
 * month that has not started is all zeros or, for a balance, today's balance — neither is data).
 * `null` = the request itself is invalid.
 */
export function requestedMonths(fromMonth: string, toMonth: string, now: Date): Ym[] | null {
  const from = parseMonth(fromMonth);
  const to = parseMonth(toMonth);
  if (from === null || to === null) return null;
  const current = currentMonth(now);
  const last = compareMonths(to, current) > 0 ? current : to;
  const count = compareMonths(last, from) + 1;
  if (count > MAX_MONTHS) return null;
  const months: Ym[] = [];
  for (let i = 0; i < count; i += 1) months.push(addMonths(from, i));
  return months;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/** "Jan", "January", "Sept" → 1..12, else null. */
export function monthFromName(name: string): number | null {
  const key = name.trim().toLowerCase().slice(0, 3);
  const index = MONTH_NAMES.indexOf(key as (typeof MONTH_NAMES)[number]);
  return index === -1 ? null : index + 1;
}

/** Two-digit years are 20xx (report headers such as "Apr 26"). */
export function fullYear(raw: string): number {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}
