/*
 * Pure helpers shared by the read services: the UTC day window an overview covers and the
 * keyset cursor a timeline page hands back. No I/O, unit tested next door.
 */

/** UTC `YYYY-MM-DD` of an instant. */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export interface DayRange {
  /** Inclusive first UTC day of the window (`YYYY-MM-DD`). */
  readonly fromDay: string;
  /** Inclusive last UTC day of the window (`YYYY-MM-DD`). */
  readonly toDay: string;
  /** Midnight UTC at the start of `fromDay`; the lower bound for raw event reads. */
  readonly from: Date;
  /** `now`, the upper bound reported to the caller. */
  readonly to: Date;
}

/** The last `days` UTC days, ending with the day `now` falls in (`days = 1` is today only). */
export function dayRange(now: Date, days: number): DayRange {
  const span = Math.max(1, Math.floor(days));
  const to = new Date(now.getTime());
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)),
  );
  return { fromDay: dayOf(from), toDay: dayOf(to), from, to };
}

export interface TimelineCursor {
  /** Microsecond timestamp of the oldest row on the page. */
  readonly before: string;
  /** That row's id: part of the sort key, so it must be part of the cursor. */
  readonly beforeId: string;
}

/**
 * The cursor for the next timeline page: the oldest row's microsecond timestamp *and id* when
 * the page came back full, otherwise `null` (this was the last page). The id matters because
 * rows are ordered `(occurred_at DESC, id DESC)` and one close beacon flushes several pages at
 * the same microsecond — a timestamp-only cursor steps over the rest of the tie and loses it.
 */
export function nextBefore(
  rows: readonly { readonly occurredAtText: string; readonly id: string }[],
  limit: number,
): TimelineCursor | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  return last === undefined ? null : { before: last.occurredAtText, beforeId: last.id };
}
