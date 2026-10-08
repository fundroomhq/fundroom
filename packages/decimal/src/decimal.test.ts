import { describe, expect, it } from "vitest";
import {
  add,
  div,
  fits,
  formatFixed,
  MAX_DECIMALS,
  MAX_FIXED,
  mul,
  parseFixed,
  quantize,
  SCALE,
  sub,
} from "./decimal.js";

const fixed = (whole: number, micros = 0): bigint => BigInt(whole) * SCALE + BigInt(micros);

describe("parseFixed", () => {
  it("reads the forms Postgres emits for numeric(20, 6)", () => {
    expect(parseFixed("0")).toBe(0n);
    expect(parseFixed("1")).toBe(SCALE);
    expect(parseFixed("1.000000")).toBe(SCALE);
    expect(parseFixed("-1.500000")).toBe(-fixed(1, 500_000));
    expect(parseFixed("1234567.891234")).toBe(fixed(1_234_567, 891_234));
    expect(parseFixed(".5")).toBe(fixed(0, 500_000));
    expect(parseFixed("+2.25")).toBe(fixed(2, 250_000));
    expect(parseFixed("  3.5  ")).toBe(fixed(3, 500_000));
  });

  it("keeps every one of the six places", () => {
    // The whole point of the file: this is the value a float loses.
    expect(parseFixed("0.000001")).toBe(1n);
    expect(parseFixed("99999999999999.999999")).toBe(fixed(99_999_999_999_999, 999_999));
  });

  it("rounds a seventh place half away from zero rather than truncating it", () => {
    expect(parseFixed("0.0000004")).toBe(0n);
    expect(parseFixed("0.0000005")).toBe(1n);
    expect(parseFixed("0.0000006")).toBe(1n);
    expect(parseFixed("-0.0000005")).toBe(-1n);
    expect(parseFixed("0.3333333333")).toBe(333_333n);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["", " ", "abc", "1e6", "1E6", "NaN", "Infinity", "1,5", "--1", "1.2.3"]) {
      expect(parseFixed(bad)).toBeUndefined();
    }
  });

  it("refuses a value too large for numeric(20, 6)", () => {
    expect(parseFixed("99999999999999.999999")).toBeDefined();
    expect(parseFixed("100000000000000")).toBeUndefined();
    // Leading zeros are not significant digits.
    expect(parseFixed("0000000000000001")).toBe(SCALE);
  });

  it("refuses a value that only overflows *after* the seventh place is rounded", () => {
    /*
     * The integral-width test passes here — fourteen digits — and then the rounding carries
     * into a fifteenth. The column answers `22003`, which is not a `MetricsError`, so it used
     * to leave the route as a 500 on a number somebody typed.
     */
    expect(parseFixed("99999999999999.9999994")).toBe(MAX_FIXED);
    expect(parseFixed("99999999999999.9999996")).toBeUndefined();
    expect(parseFixed("-99999999999999.9999996")).toBeUndefined();
  });
});

describe("fits", () => {
  it("is the numeric(20, 6) range and nothing wider", () => {
    expect(fits(MAX_FIXED)).toBe(true);
    expect(fits(-MAX_FIXED)).toBe(true);
    expect(fits(MAX_FIXED + 1n)).toBe(false);
    expect(fits(-MAX_FIXED - 1n)).toBe(false);
    // 1e14 exactly: what `1250.4`-style rounding produces from a fourteen-digit figure.
    expect(fits(100_000_000_000_000n * SCALE)).toBe(false);
  });
});

describe("quantize", () => {
  it("is the value the column will hold once `decimals` has had its say", () => {
    const typed = parseFixed("1250.4") as bigint;
    expect(quantize(typed, 0)).toBe(1250n * SCALE);
    expect(quantize(typed, 1)).toBe(typed);
    expect(quantize(typed, 6)).toBe(typed);
    // A third, at zero places, is zero — and stays zero however many times it is asked.
    const third = div(SCALE, 3n * SCALE) as bigint;
    expect(third).toBe(333_333n);
    expect(quantize(third, 0)).toBe(0n);
    expect(quantize(quantize(third, 0), 0)).toBe(0n);
  });

  it("is idempotent and agrees with formatFixed, which is what the no-op rule rests on", () => {
    for (let decimals = 0; decimals <= MAX_DECIMALS; decimals++) {
      for (const v of [0n, 1n, 4n, 5n, 333_333n, 1_250_400_000n, -1_250_400_000n, -5n]) {
        const once = quantize(v, decimals);
        expect({ decimals, v, twice: quantize(once, decimals) }).toEqual({
          decimals,
          v,
          twice: once,
        });
        // The stored string and the compared value are one decision: if these ever disagree, a
        // grid save that changes nothing writes a restatement.
        expect(formatFixed(v, decimals)).toBe(formatFixed(once, decimals));
        expect(parseFixed(formatFixed(v, decimals))).toBe(once);
      }
    }
  });

  it("clamps a decimals the column could not have stored, NaN included", () => {
    expect(quantize(1_234_567n, 99)).toBe(1_234_567n);
    expect(quantize(1_234_567n, Number.NaN)).toBe(1_000_000n);
  });
});

describe("formatFixed", () => {
  it("renders exactly `decimals` places, with no exponent", () => {
    expect(formatFixed(fixed(1234, 500_000), 2)).toBe("1234.50");
    expect(formatFixed(fixed(1234, 500_000), 0)).toBe("1235");
    expect(formatFixed(fixed(0, 1), 6)).toBe("0.000001");
    expect(formatFixed(0n, 2)).toBe("0.00");
  });

  it("rounds half away from zero, the way a spreadsheet does", () => {
    expect(formatFixed(fixed(0, 500_000), 0)).toBe("1");
    expect(formatFixed(fixed(1, 500_000), 0)).toBe("2");
    expect(formatFixed(-fixed(0, 500_000), 0)).toBe("-1");
    expect(formatFixed(-fixed(1, 500_000), 0)).toBe("-2");
    expect(formatFixed(fixed(0, 499_999), 0)).toBe("0");
  });

  it("never produces a negative zero", () => {
    expect(formatFixed(-fixed(0, 400_000), 0)).toBe("0");
    expect(formatFixed(-1n, 2)).toBe("0.00");
  });

  it("clamps a decimals value the column could not have stored", () => {
    expect(formatFixed(fixed(1, 234_567), 99)).toBe(formatFixed(fixed(1, 234_567), MAX_DECIMALS));
    expect(formatFixed(fixed(1, 234_567), -3)).toBe("1");
  });

  it("renders a whole number for a decimals that is not a number at all", () => {
    /*
     * `Math.trunc(NaN)` is `NaN` and `Math.min`/`Math.max` keep it, so the clamp used to pass
     * `NaN` straight through to `POW10[6 - NaN]` — `undefined`, hence a divisor and a unit of
     * `1n`, hence the raw micros: `1234.5` rendered as `1234500000`, a figure one million
     * times too large with nothing about it that looks wrong.
     */
    expect(formatFixed(fixed(1234, 500_000), Number.NaN)).toBe("1235");
    expect(formatFixed(fixed(1234, 500_000), Number.POSITIVE_INFINITY)).toBe("1235");
  });
});

describe("parse → format round trip", () => {
  /*
   * The property that matters in production: a value the column can hold at `decimals` places
   * comes back out of `formatFixed` in a form `parseFixed` reads as the same bigint. If this
   * ever fails, a grid save that changes nothing writes a restatement.
   */
  it("survives at every decimals setting", () => {
    const magnitudes = [0n, 1n, 7n, 42n, 999n, 123_456n, 8_675_309n];
    for (let decimals = 0; decimals <= MAX_DECIMALS; decimals++) {
      const step = 10n ** BigInt(MAX_DECIMALS - decimals);
      for (const m of magnitudes) {
        for (const value of [m * step, -m * step]) {
          const text = formatFixed(value, decimals);
          expect({ decimals, text, back: parseFixed(text) }).toEqual({
            decimals,
            text,
            back: value === 0n ? 0n : value,
          });
        }
      }
    }
  });

  it("survives for values that are NOT already exact at `decimals`", () => {
    /*
     * The case above cannot fail: every value it feeds is already a whole multiple of the
     * `decimals` step, so `formatFixed` discards nothing and the round trip is the identity.
     * The values that actually reach `PUT /grid` are not like that — `1250.4` into a
     * `decimals: 0` cell is the default shape of the problem, and `1/3` is the one the
     * recompute produces unattended — and for those the trip is only closed through
     * `quantize`. That is the fixed point the no-op rule needs: store `quantize(v, d)` and
     * the row that comes back parses to exactly the value the next save compares against.
     */
    const awkward = [
      1_250_400_000n,
      -1_250_400_000n,
      333_333n,
      666_667n,
      499_999n,
      500_000n,
      -500_000n,
      1n,
    ];
    for (let decimals = 0; decimals <= MAX_DECIMALS; decimals++) {
      for (const value of awkward) {
        const stored = quantize(value, decimals);
        const text = formatFixed(value, decimals);
        expect({ decimals, value, text, back: parseFixed(text) }).toEqual({
          decimals,
          value,
          text,
          back: stored,
        });
        // And the second save of the same figure compares equal to the row the first one wrote.
        expect(quantize(stored, decimals)).toBe(stored);
      }
    }
  });

  it("does NOT survive at the very top of the range, which is why applyCells tests `fits`", () => {
    /*
     * The one place the round trip legitimately breaks, and the third face of the overflow
     * defect: `99999999999999.6` is a value the column holds, and rounding it to `decimals: 0`
     * is a value it does not. `parseFixed` cannot refuse it — at six places it fits — so the
     * refusal has to happen after the quantise, which is where `applyCells` now makes it.
     */
    const high = parseFixed("99999999999999.6") as bigint;
    expect(fits(high)).toBe(true);
    expect(fits(quantize(high, 0))).toBe(false);
    expect(formatFixed(high, 0)).toBe("100000000000000");
    expect(parseFixed(formatFixed(high, 0))).toBeUndefined();
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    const tenth = parseFixed("0.1");
    const fifth = parseFixed("0.2");
    expect(tenth).toBeDefined();
    expect(fifth).toBeDefined();
    // The canonical float embarrassment: 0.1 + 0.2 is exactly 0.3 here.
    expect(formatFixed(add(tenth ?? 0n, fifth ?? 0n), 6)).toBe("0.300000");
    expect(sub(fixed(5), fixed(8))).toBe(-fixed(3));
  });

  it("multiplies at the shared scale and rounds the excess half away from zero", () => {
    expect(mul(fixed(2), fixed(3))).toBe(fixed(6));
    expect(mul(fixed(0, 500_000), fixed(0, 500_000))).toBe(fixed(0, 250_000));
    // 0.0000005 × 1 rounds up to the last representable place, not down to zero.
    expect(mul(1n, fixed(0, 500_000))).toBe(1n);
    expect(mul(-1n, fixed(0, 500_000))).toBe(-1n);
  });

  it("divides at the shared scale", () => {
    expect(div(fixed(6), fixed(3))).toBe(fixed(2));
    expect(div(fixed(1), fixed(3))).toBe(333_333n);
    expect(div(-fixed(1), fixed(3))).toBe(-333_333n);
    expect(div(fixed(1), -fixed(3))).toBe(-333_333n);
    expect(div(fixed(2), fixed(3))).toBe(666_667n);
  });

  it("answers undefined for division by zero rather than Infinity or zero", () => {
    expect(div(fixed(1000), 0n)).toBeUndefined();
    expect(div(0n, 0n)).toBeUndefined();
    expect(div(-fixed(1), 0n)).toBeUndefined();
  });
});
