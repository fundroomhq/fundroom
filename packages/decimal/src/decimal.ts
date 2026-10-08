/*
 * Fixed-point decimal arithmetic. Pure: no drizzle, no pg, no dependencies.
 *
 * Written for `metrics.point.value` (E2.4 §5) and promoted here unchanged in E2.5, when round
 * terms became the second thing in the product that has to add money without a `Number()` in
 * the path. `modules/metrics` re-exports this file; the doc comments below still name the
 * metrics callers because they are the bugs that shaped each decision.
 *
 * The column is `numeric(20, 6)` and `pg` hands it back as a **string**, not a number — and
 * that is the only reason this file exists. A `Number()` anywhere on the path turns 0.1 + 0.2
 * into 0.30000000000000004 and a six-place rate into a number that no longer round-trips to
 * the row it came from. It is the same class of bug as the timestamptz-as-text trap recorded
 * in `modules/analytics/src/repos/analytics-repo.ts:28-34`, and the answer is the same:
 * coerce once, in the repo, and let nothing downstream see the raw driver value.
 *
 * So every number in this module is a `bigint` scaled by 1e6. The alternatives were both
 * worse. A decimal library (decimal.js, big.js) is a dependency and a second numeric type to
 * teach every reader; `number` is the bug above. `bigint` is in the language, exact, and the
 * scale is the column's own.
 *
 * Rounding is **half away from zero** everywhere ("half-up" in the accounting sense): 0.5
 * rounds to 1 and -0.5 to -1. Banker's rounding would be defensible for statistics and is
 * wrong here — a founder checking a rendered figure against their own spreadsheet expects the
 * rule their spreadsheet uses, and Sheets and Excel both round half away from zero.
 */

/** Fixed-point scale: 1e6, the `numeric(20, 6)` column's own. */
export const SCALE = 1_000_000n;

/** Fraction digits the storage carries. `decimals` on a definition may render fewer, never more. */
export const SCALE_DECIMALS = 6;

/**
 * Precision a definition may ask for; mirrors `definition_decimals_range`.
 *
 * `decimals` is the precision a metric is **kept and compared at**, not merely rendered at, and
 * the difference is the whole of §12's no-op rule. A writer stores `formatFixed(value,
 * decimals)`, so the column already discards everything past `decimals`; comparing the incoming
 * value at the full 1e6 scale against a row that was rounded on the way in makes "is this the
 * same number?" answer *no* for every value that was not already exact — typing `1250.4` into a
 * `decimals: 0` cell writes a revision every time, and a derived `1/3` restates itself on every
 * recompute, unattended. One function decides, `quantize`, and both the comparison and the store
 * go through it so the two cannot disagree.
 */
export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 6;

const POW10: readonly bigint[] = [1n, 10n, 100n, 1_000n, 10_000n, 100_000n, 1_000_000n];

/** Largest magnitude `numeric(20, 6)` holds, at scale 1e6: 14 integral digits and 6 fractional. */
export const MAX_FIXED = 10n ** 20n - 1n;

/**
 * Whether `v` is a value the column can actually store.
 *
 * Wanted in three places, all of which used to hand Postgres a number it refuses with `22003`
 * — which is not a `MetricsError`, so it left the route as a 500 on a figure the user typed.
 */
export function fits(v: bigint): boolean {
  return v <= MAX_FIXED && v >= -MAX_FIXED;
}

/**
 * Rendering precision, clamped into 0…6.
 *
 * `Number.isFinite` is not decoration: `Math.trunc(NaN)` is `NaN`, `Math.min`/`Math.max` keep it,
 * and `POW10[6 - NaN]` is `undefined` — so a `NaN` fell through to a divisor and a unit of `1n`
 * and rendered the raw micros, i.e. a figure one million times too large. A `decimals` that is
 * not a number renders a whole number instead.
 */
function clampDecimals(decimals: number): number {
  const places = Math.trunc(decimals);
  if (!Number.isFinite(places)) return MIN_DECIMALS;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, places));
}

/**
 * `v` rounded to `decimals` fraction places, still at scale 1e6.
 *
 * The single point of truth for what a metric's value *is* at its declared precision:
 * `formatFixed(v, d)` renders `quantize(v, d)` and `applyCells` compares and stores
 * `quantize(v, d)`, so a value that renders unchanged is a value that compares equal and
 * writes nothing. Rounding is half away from zero, like everything else here.
 */
export function quantize(v: bigint, decimals: number): bigint {
  const step = POW10[SCALE_DECIMALS - clampDecimals(decimals)] ?? 1n;
  return divRoundHalfUp(v, step) * step;
}

/**
 * Plain decimal text, sign optional. Exponent notation is deliberately refused: Postgres never
 * emits it for a `numeric(20, 6)`, so a value in that form did not come from the column and
 * accepting it would silently widen what `PUT /grid` takes.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/** Digits either side of the point that still fit `numeric(20, 6)` — 14 integral, 6 fractional. */
const MAX_INTEGRAL_DIGITS = 20 - SCALE_DECIMALS;

/** `n / d` rounded half away from zero. `d` must be positive; both signs of `n` are handled. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const quotient = abs / d;
  const remainder = abs % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parses a decimal string — what `pg` returns for a `numeric`, or what a CSV cell holds —
 * into the fixed-point representation. `undefined` for anything that is not a plain decimal
 * or does not fit the column; a caller that gets `undefined` writes no point rather than a
 * zero, because "we could not read this" and "the number is zero" are different facts.
 *
 * More than six fraction digits round rather than fail: a spreadsheet exporting 1/3 as
 * `0.3333333333` is a normal CSV, not a malformed one, and the column would round it anyway.
 */
export function parseFixed(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (!DECIMAL_RE.test(trimmed)) return undefined;
  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/u, "");
  const dot = unsigned.indexOf(".");
  const integral = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
  if (integral.replace(/^0+/u, "").length > MAX_INTEGRAL_DIGITS) return undefined;
  // Pad to the scale, then fold the overflow back in as a rounding decision rather than
  // truncating it: dropping digits would bias every imported average downwards.
  const kept = fraction.slice(0, SCALE_DECIMALS).padEnd(SCALE_DECIMALS, "0");
  const scaled = BigInt(`${integral === "" ? "0" : integral}${kept}`);
  const overflow = fraction.slice(SCALE_DECIMALS);
  const roundUp = overflow.length > 0 && (overflow.codePointAt(0) ?? 0) >= 0x35;
  const magnitude = roundUp ? scaled + 1n : scaled;
  // After the rounding, not before it. The integral-width test above passes for
  // `99999999999999.9999996`, and then the seventh place carries into a fifteenth integral
  // digit — a value `numeric(20, 6)` refuses with `22003`, which reached the caller as a 500.
  if (!fits(magnitude)) return undefined;
  return negative ? -magnitude : magnitude;
}

/**
 * Back to the canonical string Postgres accepts and a reader reads: no exponent, exactly
 * `decimals` fraction digits, and no `-0`. `decimals` outside 0…6 — or not a number at all —
 * is clamped rather than thrown, because this is a render path: a row that somehow escaped the
 * column's CHECK should still put a number on the screen instead of a 500.
 *
 * The string is `quantize(v, decimals)` spelled out, which is what makes the store and the
 * equality test in `applyCells` the same decision.
 */
export function formatFixed(v: bigint, decimals: number): string {
  const places = clampDecimals(decimals);
  const divisor = POW10[SCALE_DECIMALS - places] ?? 1n;
  const rounded = divRoundHalfUp(v, divisor);
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;
  const unit = POW10[places] ?? 1n;
  const whole = (abs / unit).toString();
  const sign = negative && abs !== 0n ? "-" : "";
  if (places === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${(abs % unit).toString().padStart(places, "0")}`;
}

export function add(a: bigint, b: bigint): bigint {
  return a + b;
}

export function sub(a: bigint, b: bigint): bigint {
  return a - b;
}

/** Product at the shared scale; the extra 1e6 the multiplication introduces is rounded off. */
export function mul(a: bigint, b: bigint): bigint {
  return divRoundHalfUp(a * b, SCALE);
}

/**
 * Quotient at the shared scale, or `undefined` when `b` is zero.
 *
 * `undefined`, never `Infinity` and never `0`: `runway = cash / net_burn` with a burn of zero
 * is a company that is not spending money, and reporting its runway as zero months would be a
 * lie in the alarming direction. No point is written and the chart shows a gap (§6).
 */
export function div(a: bigint, b: bigint): bigint | undefined {
  if (b === 0n) return undefined;
  const negativeDivisor = b < 0n;
  const numerator = negativeDivisor ? -(a * SCALE) : a * SCALE;
  return divRoundHalfUp(numerator, negativeDivisor ? -b : b);
}
