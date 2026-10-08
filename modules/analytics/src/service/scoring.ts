import type { EventType } from "../schema/analytics.js";

/*
 * The hot-list score (E2.6, design/03 G2 "hot-list ranking"). Pure: the repo hands over one
 * signal per (member, event type, UTC day, automated) bucket and this decides what they are
 * worth. No I/O, unit tested next door.
 *
 * What it is and is not. A score is a *sort key* for a staff list ("who has been reading the
 * deck this fortnight"), not a prediction and not a decision about anybody — it is a weighted
 * count of things the member did, each worth less the longer ago it happened, squashed onto
 * 0–100 so a threshold means the same thing in a quiet workspace and a busy one. The weights
 * are published (`HOT_WEIGHTS`) so the breakdown on every row can be checked by hand.
 *
 * Two rules are load-bearing:
 *  - **Automated never counts.** An `email_opened`/`email_clicked` signal flagged `automated`
 *    (Apple Mail Privacy Protection prefetches every pixel; corporate link scanners follow
 *    every link) contributes zero points. It is counted separately so the admin can see it
 *    happened, but a member whose mail client opened the update on its own is not a lead.
 *  - **Outside the window is nothing.** A signal older than `windowDays` scores zero however
 *    heavy it was; inside the window its worth halves every `windowDays / 2` days.
 */
export const HOT_WEIGHTS = {
  /** An opened document or update (`document_viewed`, `update_viewed`). */
  view: 3,
  /** Per minute of page dwell (`page_viewed`), capped per signal at `DWELL_CAP_MS`. */
  dwellPerMinute: 2,
  /** A downloaded document. */
  download: 5,
  /** A human email open (MPP/scanner opens are worth nothing). */
  open: 2,
  /** A human link click. */
  click: 4,
} as const;

/** Dwell counted per signal (one member, one UTC day): a tab left open overnight is not interest. */
export const DWELL_CAP_MS = 30 * 60_000;
/** Raw points at which the score reaches ~63; the curve saturates towards 100, never past it. */
export const SCORE_SCALE = 30;

const DAY_MS = 86_400_000;

export interface HotSignal {
  readonly type: EventType;
  /** When it happened (a day bucket's start is fine: decay is measured in days). */
  readonly at: Date;
  /** How many events the signal stands for. */
  readonly count: number;
  /** Summed dwell for `page_viewed`, 0 otherwise. */
  readonly durationMs: number;
  /** MPP prefetch / link scanner (email events only). */
  readonly automated: boolean;
}

export interface ScoreOptions {
  readonly now: Date;
  readonly windowDays: number;
}

/** Decayed points per component; they sum to the raw total behind `score`. */
export interface ScorePoints {
  readonly views: number;
  readonly dwell: number;
  readonly downloads: number;
  readonly opens: number;
  readonly clicks: number;
}

/** Undecayed counts inside the window, for the breakdown columns. */
export interface ScoreCounts {
  readonly views: number;
  readonly dwellMs: number;
  readonly downloads: number;
  readonly humanOpens: number;
  readonly clicks: number;
  readonly automatedOpens: number;
  readonly automatedClicks: number;
}

export interface HotScore {
  /** 0–100, integer. */
  readonly score: number;
  readonly points: ScorePoints;
  readonly counts: ScoreCounts;
  /** Latest human signal inside the window; `null` when there is none. */
  readonly lastActivityAt: Date | null;
}

/** The weight of a signal `ageDays` old: 1 now, ½ at half the window, 0 past the window. */
export function decay(ageDays: number, windowDays: number): number {
  const window = Math.max(1, windowDays);
  const age = Math.max(0, ageDays);
  if (age > window) return 0;
  return 0.5 ** (age / (window / 2));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function hotScore(signals: readonly HotSignal[], opts: ScoreOptions): HotScore {
  const points = { views: 0, dwell: 0, downloads: 0, opens: 0, clicks: 0 };
  const counts = {
    views: 0,
    dwellMs: 0,
    downloads: 0,
    humanOpens: 0,
    clicks: 0,
    automatedOpens: 0,
    automatedClicks: 0,
  };
  let last: Date | null = null;
  for (const s of signals) {
    const ageDays = (opts.now.getTime() - s.at.getTime()) / DAY_MS;
    const w = decay(ageDays, opts.windowDays);
    if (w === 0) continue;
    const n = Math.max(0, s.count);
    const isEmail = s.type === "email_opened" || s.type === "email_clicked";
    if (isEmail && s.automated) {
      if (s.type === "email_opened") counts.automatedOpens += n;
      else counts.automatedClicks += n;
      continue;
    }
    switch (s.type) {
      case "document_viewed":
      case "update_viewed":
        counts.views += n;
        points.views += w * n * HOT_WEIGHTS.view;
        break;
      case "page_viewed": {
        const ms = Math.min(Math.max(0, s.durationMs), DWELL_CAP_MS);
        counts.dwellMs += Math.max(0, s.durationMs);
        points.dwell += w * (ms / 60_000) * HOT_WEIGHTS.dwellPerMinute;
        break;
      }
      case "document_downloaded":
        counts.downloads += n;
        points.downloads += w * n * HOT_WEIGHTS.download;
        break;
      case "email_opened":
        counts.humanOpens += n;
        points.opens += w * n * HOT_WEIGHTS.open;
        break;
      case "email_clicked":
        counts.clicks += n;
        points.clicks += w * n * HOT_WEIGHTS.click;
        break;
    }
    if (last === null || s.at > last) last = s.at;
  }
  const raw = points.views + points.dwell + points.downloads + points.opens + points.clicks;
  const score = Math.min(100, Math.max(0, Math.round(100 * (1 - Math.exp(-raw / SCORE_SCALE)))));
  return {
    score,
    points: {
      views: round1(points.views),
      dwell: round1(points.dwell),
      downloads: round1(points.downloads),
      opens: round1(points.opens),
      clicks: round1(points.clicks),
    },
    counts,
    lastActivityAt: last,
  };
}
