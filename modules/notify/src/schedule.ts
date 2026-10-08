/*
 * Pure time rules for notifications (E2.6): when a member's daily or weekly digest is due, and
 * whether an instant email falls inside their quiet hours — both in the member's own IANA
 * timezone, across DST changes, with quiet windows that may wrap midnight.
 *
 * No I/O and no clock: every function takes `now`. Timezone arithmetic goes through
 * `Intl.DateTimeFormat`, which is the only tz database a Node process ships with; there is no
 * dependency to keep current.
 *
 * Two DST rules, chosen so a slot is never skipped and never fires twice:
 *  - a wall-clock time that does not exist (the spring-forward gap) resolves to the instant just
 *    after the gap — 02:00 on a night that jumps 02:00→03:00 is 03:00;
 *  - a wall-clock time that happens twice (the fall-back overlap) resolves to its first
 *    occurrence.
 */

export const DEFAULT_TIMEZONE = "UTC";
/** Local hour the daily (and weekly) digest goes out when the member never chose one. */
export const DEFAULT_DIGEST_HOUR = 8;
/** 0 = Sunday … 6 = Saturday (the JavaScript convention); Monday by default. */
export const DEFAULT_WEEKLY_DAY = 1;

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `tz` is an IANA zone this runtime knows (`UTC` included). */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** A stored timezone that has since become unknown falls back to UTC rather than throwing. */
function safeZone(tz: string): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

export interface WallClock {
  readonly year: number;
  /** 1–12 */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall clock in `tz` at instant `at`. */
export function wallClock(at: Date, tz: string): WallClock {
  const parts = formatter(safeZone(tz)).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** The wall clock read as if it were UTC, in ms — the arithmetic currency below. */
function wallMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** UTC offset of `tz` at instant `ms`, in ms (east positive). Whole seconds only. */
function offsetAt(ms: number, tz: string): number {
  const at = new Date(Math.floor(ms / 1000) * 1000);
  return wallMs(wallClock(at, tz)) - at.getTime();
}

/**
 * The instant at which the wall clock in `tz` reads `local` (given as ms-as-if-UTC). The
 * offsets a day either side are the only two a transition near `local` can produce; each gives
 * a candidate, a candidate is valid when it reads back as `local`, and the earliest valid one
 * wins (fall-back overlap → first occurrence). No valid candidate means `local` is inside a
 * spring-forward gap: the pre-transition offset maps it to just after the gap.
 */
function zonedToUtc(local: number, tz: string): Date {
  const zone = safeZone(tz);
  const before = offsetAt(local - DAY_MS, zone);
  const after = offsetAt(local + DAY_MS, zone);
  const valid: number[] = [];
  for (const o of before === after ? [before] : [before, after]) {
    const t = local - o;
    if (wallMs(wallClock(new Date(t), zone)) === local) valid.push(t);
  }
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(local - before);
}

/** Midnight (as ms-as-if-UTC) of the local date `daysFromToday` away from `at`'s local date. */
function localMidnight(at: Date, tz: string, daysFromToday = 0): number {
  const w = wallClock(at, tz);
  return Date.UTC(w.year, w.month - 1, w.day + daysFromToday);
}

/**
 * The most recent digest slot at or before `now`: today's (or the latest `weekday`'s) local
 * `hour:00` in `tz`, else the one before it.
 */
export function latestSlot(
  now: Date,
  tz: string,
  hour: number,
  weekday?: number | null | undefined,
): Date {
  const zone = safeZone(tz);
  const today = localMidnight(now, zone);
  let back = 0;
  if (weekday !== undefined && weekday !== null) {
    const dow = new Date(today).getUTCDay();
    back = (dow - weekday + 7) % 7;
  }
  const step = weekday === undefined || weekday === null ? 1 : 7;
  let slot = zonedToUtc(today - back * DAY_MS + hour * 3_600_000, zone);
  if (slot.getTime() > now.getTime()) {
    slot = zonedToUtc(today - (back + step) * DAY_MS + hour * 3_600_000, zone);
  }
  return slot;
}

export interface DigestSchedule {
  readonly timezone: string;
  /** Local hour 0–23. */
  readonly hour: number;
  /** Weekly digests only: 0 = Sunday … 6 = Saturday. */
  readonly weekday?: number | null | undefined;
}

/**
 * Whether a digest is due now.
 *
 * Due when a slot has passed that this member has not yet been served: the latest slot is
 * after the last digest (`last`), or — for a member who never had one — after the oldest row
 * waiting for it. The second baseline is what stops a first digest going out at 03:00 because
 * yesterday's 08:00 slot "was missed": the rows did not exist then.
 *
 * Because the test is "a slot has passed", not "this is the slot hour", an hour the job did not
 * run (a deploy, a crash) is caught up on the next run instead of waiting a day.
 */
export function isDigestDue(
  now: Date,
  schedule: DigestSchedule,
  last: Date | null,
  oldestPending: Date | null,
): boolean {
  const baseline = last ?? oldestPending;
  if (baseline === null) return false;
  const slot = latestSlot(now, schedule.timezone, schedule.hour, schedule.weekday);
  return slot.getTime() > baseline.getTime();
}

export interface QuietHours {
  readonly timezone: string;
  /** Local hour the quiet window starts (inclusive). */
  readonly start: number | null;
  /** Local hour it ends (exclusive). Before `start` means the window wraps midnight. */
  readonly end: number | null;
}

/** Both ends set, both in range and not equal — anything else means "no quiet hours". */
function quietWindow(q: QuietHours): { start: number; end: number } | undefined {
  const { start, end } = q;
  if (start === null || end === null || start === end) return undefined;
  if (start < 0 || start > 23 || end < 0 || end > 23) return undefined;
  return { start, end };
}

/** Whether `now` falls inside the member's quiet hours. */
export function inQuietHours(now: Date, q: QuietHours): boolean {
  const w = quietWindow(q);
  if (w === undefined) return false;
  const h = wallClock(now, q.timezone).hour;
  return w.start < w.end ? h >= w.start && h < w.end : h >= w.start || h < w.end;
}

/**
 * When the current quiet window ends: the next local `end:00` after `now`. `undefined` when
 * `now` is not in quiet hours (nothing to wait for).
 */
export function nextQuietEnd(now: Date, q: QuietHours): Date | undefined {
  const w = quietWindow(q);
  if (w === undefined || !inQuietHours(now, q)) return undefined;
  const zone = safeZone(q.timezone);
  for (let d = 0; d <= 2; d++) {
    const candidate = zonedToUtc(localMidnight(now, zone, d) + w.end * 3_600_000, zone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  /* c8 ignore next -- unreachable: a window is at most 23 hours long */
  return new Date(now.getTime() + DAY_MS);
}
