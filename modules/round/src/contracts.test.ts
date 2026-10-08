import { parseTerms } from "@fundroom/round-terms";
import { describe, expect, it } from "vitest";
import { RoundTermsSchema } from "./contracts.js";

/*
 * The wire schemas restate the three instrument shapes in the OpenAPI flavour of zod (see the
 * comment in `contracts.ts`). Restating is only safe while the two agree, so this is where they
 * are held to it: for every payload below, the request validator and `parseTerms` — which is
 * what actually decides what reaches the column — must make the same decision.
 *
 * A failure here means a body the API would accept and the service would refuse (a 500 on a
 * valid-looking request) or, worse, the other way round.
 */

const SAFE = { kind: "safe", variant: "post_money", valuationCap: "10000000" } as const;
const NOTE = {
  kind: "note",
  valuationCap: "8000000",
  interestRatePercent: "5",
  maturityMonths: 24,
} as const;
const PRICED = { kind: "priced", preMoneyValuation: "20000000", pricePerShare: "1.25" } as const;

const accepted: readonly [string, unknown][] = [
  ["a post-money SAFE with a cap", SAFE],
  [
    "a pre-money SAFE with a discount",
    { kind: "safe", variant: "pre_money", discountPercent: "20" },
  ],
  ["a SAFE with both, and the flags", { ...SAFE, discountPercent: "15", mfn: true, proRata: true }],
  ["a note", NOTE],
  ["a 0 % note", { ...NOTE, interestRatePercent: "0" }],
  ["a note at the maturity ceiling", { ...NOTE, maturityMonths: 120 }],
  ["a priced round", PRICED],
  [
    "a priced round with a pool and a participating preference",
    {
      ...PRICED,
      optionPoolPercent: "10",
      liquidationPreferenceMultiple: "1.5",
      participating: true,
    },
  ],
];

const refused: readonly [string, unknown][] = [
  ["an unknown instrument", { kind: "convertible", valuationCap: "1" }],
  ["a SAFE with no variant", { kind: "safe", valuationCap: "10000000" }],
  ["a SAFE with an unknown variant", { kind: "safe", variant: "at_close" }],
  ["a discount over 100 %", { ...SAFE, discountPercent: "120" }],
  ["a negative discount", { ...SAFE, discountPercent: "-1" }],
  ["an exponent cap", { ...SAFE, valuationCap: "1e7" }],
  ["a numeric cap", { ...SAFE, valuationCap: 10_000_000 }],
  ["an extra key", { ...SAFE, board: "two seats" }],
  ["a note with no rate", { kind: "note", valuationCap: "8000000", maturityMonths: 24 }],
  ["a note past the maturity ceiling", { ...NOTE, maturityMonths: 121 }],
  ["a note with a fractional maturity", { ...NOTE, maturityMonths: 18.5 }],
  ["a priced round with no pre-money", { kind: "priced", pricePerShare: "1.25" }],
];

const parses = (kind: unknown, data: unknown): boolean => {
  if (kind !== "safe" && kind !== "note" && kind !== "priced") return false;
  try {
    parseTerms(kind, data);
    return true;
  } catch {
    return false;
  }
};

describe("RoundTerms on the wire agrees with parseTerms", () => {
  it.each(accepted)("accepts %s", (_name, payload) => {
    expect(RoundTermsSchema.safeParse(payload).success).toBe(true);
    expect(parses((payload as { kind: unknown }).kind, payload)).toBe(true);
  });

  it.each(refused)("refuses %s", (_name, payload) => {
    expect(RoundTermsSchema.safeParse(payload).success).toBe(false);
    expect(parses((payload as { kind: unknown }).kind, payload)).toBe(false);
  });

  it("fills the same defaults", () => {
    // The flags default to `false` and a liquidation preference to `1` on both sides, so a
    // stored row and a validated body describe the same instrument.
    const wire = RoundTermsSchema.parse(SAFE);
    expect(wire).toEqual(parseTerms("safe", SAFE));
    expect(wire).toMatchObject({ mfn: false, proRata: false });
    expect(RoundTermsSchema.parse(PRICED)).toEqual(parseTerms("priced", PRICED));
    expect(RoundTermsSchema.parse(PRICED)).toMatchObject({
      liquidationPreferenceMultiple: "1",
      participating: false,
    });
  });

  it("refuses a note body under the SAFE schema, which is what stops a mismatched row", () => {
    // `parseTerms` picks the schema by the round's own `instrument_kind`, so this is the check
    // that keeps a note's terms off a SAFE round.
    expect(() => parseTerms("safe", NOTE)).toThrow();
    expect(() => parseTerms("note", SAFE)).toThrow();
  });
});
