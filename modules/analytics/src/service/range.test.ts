import { describe, expect, it } from "vitest";
import { dayOf, dayRange, nextBefore } from "./range.js";

describe("dayRange", () => {
  const now = new Date("2026-03-10T08:30:00.000Z");

  it("covers the last N UTC days inclusive of today", () => {
    expect(dayRange(now, 1)).toMatchObject({ fromDay: "2026-03-10", toDay: "2026-03-10" });
    expect(dayRange(now, 30)).toMatchObject({ fromDay: "2026-02-09", toDay: "2026-03-10" });
  });

  it("starts at midnight UTC and ends at the caller's instant", () => {
    const r = dayRange(now, 7);
    expect(r.from.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(r.to.toISOString()).toBe(now.toISOString());
  });

  it("crosses month and year boundaries", () => {
    expect(dayRange(new Date("2026-01-02T00:00:00Z"), 5).fromDay).toBe("2025-12-29");
    expect(dayOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });

  it("never produces an empty window", () => {
    expect(dayRange(now, 0).fromDay).toBe("2026-03-10");
    expect(dayRange(now, -3).fromDay).toBe("2026-03-10");
  });
});

describe("nextBefore", () => {
  const rows = [
    { occurredAtText: "a", id: "id-a" },
    { occurredAtText: "b", id: "id-b" },
    { occurredAtText: "c", id: "id-c" },
  ];

  it("hands back the oldest row's cursor while pages come back full", () => {
    expect(nextBefore(rows, 3)).toEqual({ before: "c", beforeId: "id-c" });
  });

  it("carries the id so a tie on the timestamp is not stepped over", () => {
    // One close beacon flushes several pages at the same microsecond; paging on the timestamp
    // alone would skip the rest of the tie.
    const tied = [
      { occurredAtText: "t", id: "id-3" },
      { occurredAtText: "t", id: "id-2" },
      { occurredAtText: "t", id: "id-1" },
    ];
    expect(nextBefore(tied, 3)).toEqual({ before: "t", beforeId: "id-1" });
  });

  it("is null on a short page (this was the last one)", () => {
    expect(nextBefore(rows, 4)).toBeNull();
    expect(nextBefore([], 50)).toBeNull();
  });
});
