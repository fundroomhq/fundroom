import { describe, expect, it } from "vitest";
import { niceStep, niceTicks } from "./ticks.js";

const MAGNITUDES = [1e-3, 1e-2, 0.1, 1, 10, 1e3, 1e6, 1e9];

describe("niceStep", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.1)).toBe(2);
    expect(niceStep(2)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(6)).toBe(10);
    expect(niceStep(23_871)).toBe(50_000);
    expect(niceStep(0.00031)).toBeCloseTo(0.0005, 10);
  });

  it("never returns zero or a NaN for hostile input", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
    expect(niceStep(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("niceTicks", () => {
  it("covers the domain with round labels from 0.001 to 1e9", () => {
    for (const m of MAGNITUDES) {
      const s = niceTicks(0, 7.3 * m, 5);
      expect(s.min).toBeLessThanOrEqual(0);
      expect(s.max).toBeGreaterThanOrEqual(7.3 * m);
      expect(s.ticks[0]).toBe(s.min);
      expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
      expect(s.ticks.length).toBeGreaterThanOrEqual(3);
      expect(s.ticks.length).toBeLessThanOrEqual(12);
      for (const t of s.ticks) {
        // Every label is an exact multiple of the step — no 0.30000000000000004 reaching a
        // reader's eye, at any magnitude.
        expect(String(t)).not.toMatch(/\d{12}/u);
        expect(Math.abs(Math.round(t / s.step) - t / s.step)).toBeLessThan(1e-6);
      }
    }
  });

  it("handles negative and straddling domains", () => {
    const below = niceTicks(-980, -120, 4);
    expect(below.min).toBeLessThanOrEqual(-980);
    expect(below.max).toBeGreaterThanOrEqual(-120);
    const straddle = niceTicks(-40, 120, 4);
    expect(straddle.min).toBeLessThanOrEqual(-40);
    expect(straddle.max).toBeGreaterThanOrEqual(120);
    expect(straddle.ticks).toContain(0);
  });

  it("answers the degenerate domains instead of throwing", () => {
    expect(niceTicks(0, 0, 4)).toMatchObject({ min: 0, max: 1 });
    const flat = niceTicks(42, 42, 4);
    expect(flat.min).toBeLessThan(42);
    expect(flat.max).toBeGreaterThan(42);
    const negFlat = niceTicks(-42, -42, 4);
    expect(negFlat.min).toBeLessThan(-42);
    expect(negFlat.max).toBeGreaterThan(-42);
    expect(niceTicks(Number.NaN, 5, 4)).toMatchObject({ min: 0, max: 1 });
    expect(niceTicks(0, Number.POSITIVE_INFINITY, 4)).toMatchObject({ min: 0, max: 1 });
  });

  it("accepts a reversed domain and clamps the tick target", () => {
    expect(niceTicks(100, 0, 5)).toMatchObject({ min: 0 });
    expect(niceTicks(0, 100, 1).ticks.length).toBeGreaterThanOrEqual(2);
    expect(niceTicks(0, 100, 1000).ticks.length).toBeLessThanOrEqual(65);
  });
});
