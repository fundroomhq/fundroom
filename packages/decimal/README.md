# @fundroom/decimal

Fixed-point decimal arithmetic on `bigint`, scaled by 1e6 — the scale of the `numeric(20, 6)`
columns the product stores money and metric values in. No dependencies, no I/O.

It exists because `pg` returns `numeric` as a **string**, and the obvious coercion (`Number()`)
turns `0.1 + 0.2` into `0.30000000000000004` and a six-place rate into a value that no longer
round-trips to the row it came from. Everything here is exact.

- `parseFixed(text)` — a plain decimal string to the fixed-point representation, `undefined` for
  anything that is not one or does not fit the column. Exponent notation is refused on purpose:
  Postgres never emits it for a `numeric(20, 6)`, so a value in that form did not come from the
  column. More than six fraction digits round rather than fail.
- `formatFixed(v, decimals)` — back to the canonical string Postgres accepts and a person reads:
  no exponent, exactly `decimals` fraction digits, no `-0`.
- `quantize(v, decimals)` — the single point of truth for what a value *is* at a declared
  precision, so a value that renders unchanged is a value that compares equal.
- `add` / `sub` / `mul` / `div` — `div` answers `undefined` rather than `Infinity` or `0` when
  the divisor is zero, because "we cannot say" and "the answer is zero" are different facts.
- `fits`, `SCALE`, `SCALE_DECIMALS`, `MIN_DECIMALS`, `MAX_DECIMALS`, `MAX_FIXED`.

Rounding is **half away from zero** everywhere ("half-up" in the accounting sense): 0.5 → 1 and
-0.5 → -1. Banker's rounding would be defensible for statistics and is wrong here — a founder
checking a rendered figure against their own spreadsheet expects the rule their spreadsheet
uses, and Sheets and Excel both round half away from zero.

Promoted from `modules/metrics/src/decimal.ts` in E2.5 when `@fundroom/round-terms`
became its second consumer; metrics re-exports it, so there is still exactly one implementation.
