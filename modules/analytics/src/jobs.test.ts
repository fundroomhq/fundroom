import { describe, expect, it } from "vitest";
import { foldBatch } from "./jobs.js";
import type { CursorRow } from "./repos/analytics-repo.js";
import { NO_VERSION } from "./schema/analytics.js";

/*
 * `foldBatch` is the whole of the rollup's arithmetic: one keyset batch of raw events folded
 * into per-(member, resource) and per-(day, resource) deltas that the repo then adds onto the
 * stored rows. Everything else in the job is I/O.
 */
const at = (iso: string) => new Date(iso);

let n = 0;
function row(over: Partial<CursorRow> & Pick<CursorRow, "type" | "occurredAt">): CursorRow {
  n += 1;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    membershipId: "m1",
    resourceKind: "document",
    resourceId: "r1",
    versionId: null,
    pageNo: null,
    durationMs: null,
    occurredAtText: over.occurredAt.toISOString(),
    ...over,
  };
}

describe("foldBatch", () => {
  it("returns nothing for an empty batch", () => {
    expect(foldBatch([])).toEqual({ viewers: [], daily: [], pages: [] });
  });

  it("counts views and downloads, and only page_viewed carries dwell", () => {
    const { viewers, daily } = foldBatch([
      row({ type: "document_viewed", occurredAt: at("2026-03-01T10:00:00Z") }),
      row({ type: "document_downloaded", occurredAt: at("2026-03-01T10:01:00Z") }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-01T10:02:00Z"),
        pageNo: 3,
        durationMs: 4000,
      }),
      // durations on non-dwell rows are ignored: only `page_viewed` measures reading.
      row({ type: "document_viewed", occurredAt: at("2026-03-01T10:03:00Z"), durationMs: 99_000 }),
    ]);
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({
      membershipId: "m1",
      resourceId: "r1",
      views: 2,
      downloads: 1,
      totalMs: 4000,
      maxPageReached: 3,
      pagesSeen: [3],
    });
    expect(daily).toEqual([
      {
        day: "2026-03-01",
        resourceKind: "document",
        resourceId: "r1",
        views: 2,
        downloads: 1,
        totalMs: 4000,
      },
    ]);
  });

  it("keeps first/last from the batch order-independently and dedupes pages seen", () => {
    const { viewers } = foldBatch([
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-02T12:00:00Z"),
        pageNo: 7,
        durationMs: 1,
      }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-02T09:00:00Z"),
        pageNo: 2,
        durationMs: 2,
      }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-02T15:00:00Z"),
        pageNo: 7,
        durationMs: 3,
      }),
    ]);
    const v = viewers[0];
    expect(v?.firstAt.toISOString()).toBe("2026-03-02T09:00:00.000Z");
    expect(v?.lastAt.toISOString()).toBe("2026-03-02T15:00:00.000Z");
    expect(v?.pagesSeen).toEqual([7, 2]);
    expect(v?.maxPageReached).toBe(7);
    expect(v?.totalMs).toBe(6);
    expect(v?.views).toBe(0);
  });

  it("splits by member, by resource and by UTC day", () => {
    const { viewers, daily } = foldBatch([
      row({ type: "document_viewed", occurredAt: at("2026-03-03T23:59:00Z") }),
      row({ type: "document_viewed", occurredAt: at("2026-03-04T00:01:00Z") }),
      row({ type: "document_viewed", occurredAt: at("2026-03-04T01:00:00Z"), membershipId: "m2" }),
      row({
        type: "update_viewed",
        occurredAt: at("2026-03-04T02:00:00Z"),
        resourceKind: "post",
        resourceId: "p1",
      }),
    ]);
    expect(viewers.map((v) => `${v.membershipId}:${v.resourceId}:${v.views}`)).toEqual([
      "m1:r1:2",
      "m2:r1:1",
      "m1:p1:1",
    ]);
    expect(daily.map((d) => `${d.day}:${d.resourceId}:${d.views}`)).toEqual([
      "2026-03-03:r1:1",
      "2026-03-04:r1:2",
      "2026-03-04:p1:1",
    ]);
  });
});

describe("foldBatch: page heatmap (E2.6)", () => {
  it("sums dwell and reads per (resource, version, page), listing each reader once", () => {
    const v1 = "00000000-0000-0000-0000-0000000000a1";
    const v2 = "00000000-0000-0000-0000-0000000000a2";
    const { pages } = foldBatch([
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:00:00Z"),
        pageNo: 1,
        durationMs: 4000,
        versionId: v1,
      }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:01:00Z"),
        pageNo: 1,
        durationMs: 6000,
        versionId: v1,
      }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:02:00Z"),
        pageNo: 1,
        durationMs: 1000,
        versionId: v1,
        membershipId: "m2",
      }),
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:03:00Z"),
        pageNo: 2,
        durationMs: 500,
        versionId: v1,
      }),
      // Page 1 of another version is a different page.
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:04:00Z"),
        pageNo: 1,
        durationMs: 700,
        versionId: v2,
      }),
      // No version reported: its own bucket under the sentinel key.
      row({
        type: "page_viewed",
        occurredAt: at("2026-03-05T10:05:00Z"),
        pageNo: 1,
        durationMs: 300,
      }),
      // Opens and downloads are not page reads.
      row({ type: "document_viewed", occurredAt: at("2026-03-05T10:06:00Z"), versionId: v1 }),
    ]);
    expect(pages).toEqual([
      {
        resourceKind: "document",
        resourceId: "r1",
        versionKey: v1,
        pageNo: 1,
        totalMs: 11_000,
        views: 3,
        membershipIds: ["m1", "m2"],
      },
      {
        resourceKind: "document",
        resourceId: "r1",
        versionKey: v1,
        pageNo: 2,
        totalMs: 500,
        views: 1,
        membershipIds: ["m1"],
      },
      {
        resourceKind: "document",
        resourceId: "r1",
        versionKey: v2,
        pageNo: 1,
        totalMs: 700,
        views: 1,
        membershipIds: ["m1"],
      },
      {
        resourceKind: "document",
        resourceId: "r1",
        versionKey: NO_VERSION,
        pageNo: 1,
        totalMs: 300,
        views: 1,
        membershipIds: ["m1"],
      },
    ]);
  });

  it("email opens and clicks are not reads: no viewer row, no daily count, no heatmap cell", () => {
    const folded = foldBatch([
      row({
        type: "email_opened",
        occurredAt: at("2026-03-06T10:00:00Z"),
        resourceKind: "post",
        resourceId: "p1",
      }),
      row({
        type: "email_clicked",
        occurredAt: at("2026-03-06T10:01:00Z"),
        resourceKind: "post",
        resourceId: "p1",
      }),
    ]);
    expect(folded).toEqual({ viewers: [], daily: [], pages: [] });
  });
});
