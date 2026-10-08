import { describe, expect, it } from "vitest";
import type { EventType } from "../schema/analytics.js";
import {
  DWELL_CAP_MS,
  decay,
  HOT_WEIGHTS,
  type HotSignal,
  hotScore,
  SCORE_SCALE,
} from "./scoring.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const opts = { now: NOW, windowDays: 14 };

function sig(type: EventType, over: Partial<HotSignal> = {}): HotSignal {
  return { type, at: NOW, count: 1, durationMs: 0, automated: false, ...over };
}

const expectedScore = (raw: number) => Math.round(100 * (1 - Math.exp(-raw / SCORE_SCALE)));

describe("hotScore", () => {
  it("scores nothing as 0 with no last activity", () => {
    expect(hotScore([], opts)).toMatchObject({ score: 0, lastActivityAt: null });
  });

  it("weights each component and saturates onto 0-100", () => {
    const h = hotScore(
      [
        sig("document_viewed", { count: 2 }),
        sig("update_viewed"),
        sig("page_viewed", { durationMs: 5 * 60_000 }),
        sig("document_downloaded"),
        sig("email_opened"),
        sig("email_clicked", { count: 2 }),
      ],
      opts,
    );
    const raw =
      3 * HOT_WEIGHTS.view +
      5 * HOT_WEIGHTS.dwellPerMinute +
      HOT_WEIGHTS.download +
      HOT_WEIGHTS.open +
      2 * HOT_WEIGHTS.click;
    expect(h.points).toEqual({ views: 9, dwell: 10, downloads: 5, opens: 2, clicks: 8 });
    expect(h.score).toBe(expectedScore(raw));
    expect(h.counts).toEqual({
      views: 3,
      dwellMs: 300_000,
      downloads: 1,
      humanOpens: 1,
      clicks: 2,
      automatedOpens: 0,
      automatedClicks: 0,
    });
    // However much happens, the score never passes 100.
    expect(hotScore([sig("document_downloaded", { count: 10_000 })], opts).score).toBe(100);
  });

  it("never counts automated opens or clicks (MPP prefetch, link scanners)", () => {
    const automated = hotScore(
      [
        sig("email_opened", { count: 50, automated: true }),
        sig("email_clicked", { count: 20, automated: true }),
      ],
      opts,
    );
    expect(automated.score).toBe(0);
    expect(automated.points).toEqual({ views: 0, dwell: 0, downloads: 0, opens: 0, clicks: 0 });
    // Counted, so the admin can see it happened, but worth nothing.
    expect(automated.counts).toMatchObject({
      automatedOpens: 50,
      automatedClicks: 20,
      humanOpens: 0,
      clicks: 0,
    });
    // …and it is not "activity" either.
    expect(automated.lastActivityAt).toBeNull();

    const human = hotScore([sig("email_opened")], opts);
    const mixed = hotScore(
      [sig("email_opened"), sig("email_opened", { count: 9, automated: true })],
      opts,
    );
    expect(mixed.score).toBe(human.score);
    expect(mixed.points).toEqual(human.points);
  });

  it("decays with age: half the worth at half the window, nothing past the window", () => {
    const fresh = hotScore([sig("document_downloaded", { at: ago(0) })], opts);
    const half = hotScore([sig("document_downloaded", { at: ago(7) })], opts);
    const edge = hotScore([sig("document_downloaded", { at: ago(14) })], opts);
    const stale = hotScore([sig("document_downloaded", { at: ago(14.01), count: 1000 })], opts);
    expect(fresh.points.downloads).toBe(5);
    expect(half.points.downloads).toBe(2.5);
    expect(edge.points.downloads).toBe(1.3); // ¼, rounded to one decimal
    expect(stale.score).toBe(0);
    expect(stale.counts.downloads).toBe(0);
    expect(fresh.score).toBeGreaterThan(half.score);
    expect(half.score).toBeGreaterThan(edge.score);
  });

  it("a recent light reader can outrank an old heavy one", () => {
    const old = hotScore([sig("document_viewed", { at: ago(12), count: 4 })], opts);
    const recent = hotScore([sig("document_viewed", { at: ago(0), count: 2 })], opts);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("caps dwell per signal, so a tab left open overnight is not interest", () => {
    const night = hotScore([sig("page_viewed", { durationMs: 10 * 60 * 60_000 })], opts);
    const capped = hotScore([sig("page_viewed", { durationMs: DWELL_CAP_MS })], opts);
    expect(night.points.dwell).toBe(capped.points.dwell);
    expect(night.counts.dwellMs).toBe(10 * 60 * 60_000);
  });

  it("reports the latest human activity and treats future timestamps as now", () => {
    const h = hotScore(
      [
        sig("document_viewed", { at: ago(3) }),
        sig("document_viewed", { at: ago(1) }),
        sig("email_opened", { at: ago(0.5), automated: true }),
      ],
      opts,
    );
    expect(h.lastActivityAt?.toISOString()).toBe(ago(1).toISOString());
    const future = hotScore(
      [sig("document_downloaded", { at: new Date(NOW.getTime() + DAY) })],
      opts,
    );
    expect(future.points.downloads).toBe(5);
  });
});

describe("decay", () => {
  it("is 1 now, 0.5 at half the window, 0 past it", () => {
    expect(decay(0, 10)).toBe(1);
    expect(decay(5, 10)).toBe(0.5);
    expect(decay(10, 10)).toBe(0.25);
    expect(decay(10.5, 10)).toBe(0);
    expect(decay(-3, 10)).toBe(1);
  });
});
