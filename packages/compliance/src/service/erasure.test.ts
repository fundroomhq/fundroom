import { describe, expect, it } from "vitest";
import {
  decodeErasureCursor,
  encodeErasureCursor,
  erasureSatisfied,
  sanitizeErasureCounts,
} from "./erasure.js";

describe("erasureSatisfied", () => {
  it("nothing expected is satisfied at once", () => {
    expect(erasureSatisfied([], [])).toBe(true);
  });
  it("needs every expected module, in any order", () => {
    expect(erasureSatisfied(["analytics", "notify"], ["notify"])).toBe(false);
    expect(erasureSatisfied(["analytics", "notify"], ["notify", "analytics"])).toBe(true);
  });
  it("an unexpected report neither helps nor hurts", () => {
    expect(erasureSatisfied(["crm"], ["updates"])).toBe(false);
    expect(erasureSatisfied(["crm"], ["updates", "crm"])).toBe(true);
  });
});

describe("sanitizeErasureCounts", () => {
  it("keeps non-negative finite numbers, floored, and drops everything else", () => {
    expect(
      sanitizeErasureCounts({
        events: 12,
        partial: 2.7,
        negative: -1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        text: "3",
        "": 1,
        [`k${"x".repeat(64)}`]: 1,
      }),
    ).toEqual({ events: 12, partial: 2 });
  });
  it("bounds the number of keys", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, i]));
    expect(Object.keys(sanitizeErasureCounts(many))).toHaveLength(64);
  });
});

describe("erasure cursor", () => {
  it("round-trips both ORDER BY columns", () => {
    const row = {
      requestedAt: new Date("2026-09-22T10:00:00.123Z"),
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    };
    expect(decodeErasureCursor(encodeErasureCursor(row))).toEqual(row);
  });
  it("rejects garbage", () => {
    for (const bad of ["", "nope", Buffer.from("x|y").toString("base64url")]) {
      expect(decodeErasureCursor(bad)).toBeUndefined();
    }
    const badId = Buffer.from("2026-09-22T10:00:00.000Z|not-a-uuid").toString("base64url");
    expect(decodeErasureCursor(badId)).toBeUndefined();
  });
});
