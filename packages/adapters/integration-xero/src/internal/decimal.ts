/*
 * Exact decimal arithmetic on strings and bigints — no floats anywhere a money value travels
 * (copied verbatim between the three KPI adapters; see the note in `http.ts`).
 *
 * A `Dec` is `units / 10^scale`. Vendor report cells are parsed with `parseDecimal`, which accepts
 * only a plain `-?digits(.digits)?` spelling (no exponent, no thousands separator, no currency
 * sign) — anything else is the vendor changing shape under us, and the caller answers `malformed`.
 */
export interface Dec {
  units: bigint;
  scale: number;
}

export const ZERO: Dec = { units: 0n, scale: 0 };

const PLAIN = /^(-)?(\d{1,30})(?:\.(\d{1,18}))?$/u;

export function parseDecimal(raw: string): Dec | null {
  const match = PLAIN.exec(raw.trim());
  if (match === null) return null;
  const [, sign, whole = "0", fraction = ""] = match;
  const units = BigInt(`${whole}${fraction}`);
  return { units: sign === "-" ? -units : units, scale: fraction.length };
}

function rescale(value: Dec, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function addDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

export function negateDec(a: Dec): Dec {
  return { units: -a.units, scale: a.scale };
}

/** Integer minor units (e.g. Stripe cents) as a decimal in major units. */
export function fromMinorUnits(units: bigint, exponent: number): Dec {
  return { units, scale: exponent };
}

/** Plain decimal text, never an exponent; `-0` never appears. */
export function formatDec(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Normalises a vendor cell: "" (QuickBooks and Xero leave empty cells blank) is zero. */
export function parseCell(raw: unknown): Dec | null {
  if (raw === undefined || raw === null) return ZERO;
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return ZERO;
  return parseDecimal(raw);
}
