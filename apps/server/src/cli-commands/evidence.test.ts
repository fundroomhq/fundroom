import type { Database } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { breakGlassCommand } from "./break-glass.js";
import { accessReviewEntry, evidenceCommand } from "./evidence.js";

const WS = { id: "ws-1", slug: "alpha", name: "Alpha", createdAt: "2026-01-01T00:00:00.000Z" };
const review = {
  id: "r-1",
  completedAt: "2026-05-01T00:00:00.000Z",
  reportSha256: "a".repeat(64),
  reviewerMembershipId: "m-1",
  reviewerName: "Ada",
  memberCount: 3,
  flaggedCount: 0,
};

describe("accessReviewEntry", () => {
  it("is due one interval after the last review and overdue after that", () => {
    const due = accessReviewEntry(WS, review, [], new Date("2026-07-29T00:00:00Z"), 90);
    expect(due).toMatchObject({
      nextDueAt: "2026-07-30T00:00:00.000Z",
      overdue: false,
      daysOverdue: 0,
      neverReviewed: false,
      lastReview: { reportSha256: "a".repeat(64), reviewerName: "Ada" },
    });
    const late = accessReviewEntry(WS, review, [review], new Date("2026-08-09T12:00:00Z"), 90);
    expect(late).toMatchObject({ overdue: true, daysOverdue: 10 });
    expect(late["reviewsInPeriod"]).toHaveLength(1);
  });

  it("counts a never-reviewed workspace from its creation", () => {
    const e = accessReviewEntry(WS, undefined, [], new Date("2026-04-02T00:00:00Z"), 90);
    expect(e).toMatchObject({
      neverReviewed: true,
      lastReview: null,
      nextDueAt: "2026-04-01T00:00:00.000Z",
      overdue: true,
      daysOverdue: 1,
    });
  });
});

describe("accessReviewEntry on a plan without access_reviews (A-3)", () => {
  it("is never overdue and says why", () => {
    const e = accessReviewEntry(WS, undefined, [], new Date("2026-09-02T00:00:00Z"), 90, false);
    expect(e).toMatchObject({
      neverReviewed: true,
      nextDueAt: "2026-04-01T00:00:00.000Z",
      overdue: false,
      daysOverdue: 0,
      notOnPlan: true,
    });
    expect(accessReviewEntry(WS, undefined, [], new Date(), 90)["notOnPlan"]).toBe(false);
  });
});

describe("CLI usage paths never touch the database", () => {
  // Any property access on this throws, so a usage error that reached the database would fail.
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("database touched");
      },
    },
  ) as Database;
  const quiet = { err: () => {}, out: () => {} };

  it("evidence", async () => {
    expect(await evidenceCommand([], { db, ...quiet })).toBe(2);
    expect(await evidenceCommand(["nope"], { db, ...quiet })).toBe(2);
    expect(
      await evidenceCommand(["access-reviews", "--since", "yesterday-ish"], { db, ...quiet }),
    ).toBe(2);
  });

  it("break-glass", async () => {
    const deps = { db, audit: {} as never, mailer: {} as never, osUser: "ops", ...quiet };
    expect(await breakGlassCommand([], deps)).toBe(2);
    expect(await breakGlassCommand(["open", "--workspace", "a"], deps)).toBe(2);
    expect(
      await breakGlassCommand(
        ["open", "--workspace", "a", "--ticket", "has space", "--reason", "long enough reason"],
        deps,
      ),
    ).toBe(2);
    expect(
      await breakGlassCommand(["sql", "--session", "not-a-uuid", "--query", "SELECT 1"], deps),
    ).toBe(2);
    const id = "01920000-0000-7000-8000-000000000001";
    // Neither or both of --query/--file.
    expect(await breakGlassCommand(["sql", "--session", id], deps)).toBe(2);
    expect(
      await breakGlassCommand(
        ["sql", "--session", id, "--query", "SELECT 1", "--file", "x.sql"],
        deps,
      ),
    ).toBe(2);
    // DML without --write and empty text exit 2 before any role check or audit. (Whether a
    // statement may run at all — COMMIT, DO, SET … — is Postgres's call: the integration test.)
    expect(
      await breakGlassCommand(["sql", "--session", id, "--query", "DELETE FROM t"], deps),
    ).toBe(2);
    expect(
      await breakGlassCommand(["sql", "--session", id, "--query", "  ", "--write"], deps),
    ).toBe(2);
    expect(await breakGlassCommand(["close"], deps)).toBe(2);
  });
});
