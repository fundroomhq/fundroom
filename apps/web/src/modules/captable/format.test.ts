import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatAsOf,
  formatBucketPercent,
  formatPercent,
  formatShares,
  problemText,
} from "./format.js";

describe("cap table formatting", () => {
  it("formats share counts from the decimal string, never through a double", () => {
    expect(formatShares("8000000.000000")).toBe("8,000,000");
    expect(formatShares("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(formatShares("0.5")).toBe("0.5");
    expect(formatShares(null)).toBe("—");
    // Not a plain decimal: shown as sent rather than as NaN.
    expect(formatShares("1e6")).toBe("1e6");
  });

  it("prints money in its own currency and survives an unknown code", () => {
    expect(formatAmount("500000.000000", "USD")).toBe("$500,000");
    expect(formatAmount("1234.5", "EUR")).toBe("€1,234.5");
    expect(formatAmount("10", "ZZZZ")).toBe("10 ZZZZ");
    // Three-decimal currencies keep their fils: nothing is rounded to two places.
    expect(formatAmount("1234.567000", "KWD")).toMatch(/^KWD\s1,234\.567$/u);
    expect(formatAmount("250000.125", "BHD")).toMatch(/^BHD\s250,000\.125$/u);
    // …and a zero-decimal currency shows none.
    expect(formatAmount("1000000.000000", "JPY")).toBe("¥1,000,000");
    expect(formatAmount("0.123456", null)).toBe("0.123456");
  });

  it("prints the server's percentage with a % and no recomputation", () => {
    expect(formatPercent("18.1818")).toBe("18.1818%");
    expect(formatPercent("50.0000")).toBe("50.00%");
    // Investor buckets arrive at one place and are printed at one place, never padded.
    expect(formatBucketPercent("76.4")).toBe("76.4%");
    expect(formatBucketPercent("5.0")).toBe("5.0%");
  });

  it("formats an as-of date as a calendar date in every time zone", () => {
    expect(formatAsOf("2026-09-01")).toBe("Sep 1, 2026");
    expect(formatAsOf("not a date")).toBe("not a date");
  });

  it("says where a problem is before what it is", () => {
    expect(problemText({ line: 3, column: "shares", message: "not a number" })).toBe(
      "Line 3, column shares: not a number",
    );
    expect(problemText({ line: null, column: null, message: "empty" })).toBe("empty");
  });
});
