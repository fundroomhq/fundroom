import { div, formatFixed, mul, parseFixed, SCALE } from "@fundroom/decimal";

/*
 * Formatting and the two or three pieces of arithmetic the round maths needs on top of
 * `@fundroom/decimal`. Internal: nothing here is exported from `index.ts`.
 *
 * Every number that reaches a person goes through one of these functions. The machine-readable
 * fields on `CalculatorResult` and `Allocation` are plain decimal strings (no grouping, no
 * symbol) because they cross the wire and get parsed again; the sentences in `explanation` are
 * written the way a person reads a figure, with thousands separators and cents only when there
 * are cents.
 */

/** 1 at the shared 1e6 scale. */
export const ONE = SCALE;

/** 100 at the shared scale — the divisor that turns a percentage into a fraction. */
export const HUNDRED = 100n * SCALE;

/** A decimal string as fixed point, or `undefined` when it is not one (exponents included). */
export function fixed(text: string | undefined): bigint | undefined {
  return text === undefined ? undefined : parseFixed(text);
}

/** A decimal string as fixed point, or zero. For inputs a schema has already validated. */
export function fixedOr0(text: string | undefined): bigint {
  return fixed(text) ?? 0n;
}

/**
 * `part / whole` as a **percentage** at the shared scale, or `undefined` when the whole is zero
 * or negative — a valuation of nothing buys no answer, and reporting 0 % or ∞ would be a lie in
 * one direction or the other.
 */
export function percentOf(part: bigint, whole: bigint): bigint | undefined {
  if (whole <= 0n) return undefined;
  const fraction = div(part, whole);
  if (fraction === undefined) return undefined;
  return mul(fraction, HUNDRED);
}

/** A percentage at the shared scale as its fraction: 20 % → 0.2. */
export function asFraction(percent: bigint): bigint {
  return div(percent, HUNDRED) ?? 0n;
}

/** `1 - percent`, the multiplier a discount applies to a price. Never negative. */
export function discountFactor(percent: bigint): bigint {
  const factor = ONE - asFraction(percent);
  return factor > 0n ? factor : 0n;
}

/** Percentages are stored and compared at full precision and rendered at two places. */
export function percentText(v: bigint): string {
  return `${formatFixed(v, 2)}%`;
}

/** The wire form of a percentage: two decimals, no symbol. */
export function percentValue(v: bigint): string {
  return formatFixed(v, 2);
}

/** The wire form of an amount of money: two decimals, no symbol, no grouping. */
export function moneyValue(v: bigint): string {
  return formatFixed(v, 2);
}

/** The wire form of a valuation or a share count: whole units. */
export function wholeValue(v: bigint): string {
  return formatFixed(v, 0);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

/**
 * An amount as a person reads it: `$10,000,000`, `$1,234.56`, `-$50`.
 *
 * Cents are dropped when there are none. Every round figure in the product is a whole number of
 * dollars and `$10,000,000.00` in the middle of a sentence reads like a bank statement, not like
 * an explanation.
 *
 * The symbol is `$` because `CalculatorInput` carries no currency (see the README); a round in
 * another currency renders its figures through its own formatter in the UI.
 */
export function money(v: bigint): string {
  const negative = v < 0n;
  const text = formatFixed(negative ? -v : v, 2);
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const cents = dot === -1 ? "00" : text.slice(dot + 1);
  const body = cents === "00" ? group(whole) : `${group(whole)}.${cents}`;
  return `${negative ? "-" : ""}$${body}`;
}

/**
 * A price per share, which is the one figure here that is routinely smaller than a cent:
 * up to six places, trailing zeros trimmed, never fewer than two.
 */
export function sharePrice(v: bigint): string {
  const text = formatFixed(v, 6);
  const trimmed = text.replace(/(\.\d{2}\d*?)0+$/u, "$1");
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const dot = abs.indexOf(".");
  const whole = dot === -1 ? abs : abs.slice(0, dot);
  const rest = dot === -1 ? "" : abs.slice(dot);
  return `${negative ? "-" : ""}$${group(whole)}${rest}`;
}

/** A share count as a person reads it. */
export function shares(v: bigint): string {
  return group(formatFixed(v, 0));
}

/** A bare decimal as a person reads it: trailing zeros trimmed, no symbol. For multiples. */
export function decimalText(v: bigint): string {
  const text = formatFixed(v, 6);
  return text.includes(".") ? text.replace(/\.?0+$/u, "") : text;
}

/** `a / b` at the shared scale, or `undefined` when `b` is zero. */
export function ratio(a: bigint, b: bigint): bigint | undefined {
  return div(a, b);
}

/** `a × b` at the shared scale. */
export function product(a: bigint, b: bigint): bigint {
  return mul(a, b);
}
