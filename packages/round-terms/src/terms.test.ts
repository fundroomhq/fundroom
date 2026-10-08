import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Decimal,
  INSTRUMENT_KINDS,
  NoteTermsSchema,
  PricedTermsSchema,
  parseTerms,
  ROUND_STAGES,
  SafeTermsSchema,
  TERMS_SCHEMA_VERSION,
  TermsSchema,
} from "./terms.js";

describe("vocabularies", () => {
  it("names the three instruments, in the order the enum declares them", () => {
    expect(INSTRUMENT_KINDS).toEqual(["safe", "note", "priced"]);
  });

  it("names the six round stages", () => {
    expect(ROUND_STAGES).toEqual(["pre_seed", "seed", "series_a", "series_b", "bridge", "other"]);
  });

  it("pins the stored schema version, which the column records alongside every row", () => {
    expect(TERMS_SCHEMA_VERSION).toBe(1);
  });
});

describe("Decimal", () => {
  it("takes the forms Postgres emits for numeric(20, 6)", () => {
    for (const text of ["0", "10000000", "-1", "+2.5", ".5", "1.", "0.000001"]) {
      expect(Decimal.safeParse(text).success, text).toBe(true);
    }
  });

  it("refuses exponent notation, which no numeric(20, 6) column ever produced", () => {
    for (const text of ["1e7", "1E7", "1.5e-3", "2e+6"]) {
      expect(Decimal.safeParse(text).success, text).toBe(false);
    }
  });

  it("refuses text that is not a number at all", () => {
    for (const text of ["", " ", "ten", "1,000", "$100", "1 000", "NaN", "Infinity"]) {
      expect(Decimal.safeParse(text).success, text).toBe(false);
    }
  });

  it("refuses a string longer than the column can hold", () => {
    expect(Decimal.safeParse("1".repeat(33)).success).toBe(false);
  });
});

describe("SafeTermsSchema", () => {
  it("defaults mfn and proRata to false rather than leaving them absent", () => {
    const terms = SafeTermsSchema.parse({
      kind: "safe",
      variant: "post_money",
      valuationCap: "10000000",
    });
    expect(terms).toEqual({
      kind: "safe",
      variant: "post_money",
      valuationCap: "10000000",
      mfn: false,
      proRata: false,
    });
  });

  it("accepts a SAFE with neither a cap nor a discount", () => {
    expect(SafeTermsSchema.safeParse({ kind: "safe", variant: "pre_money" }).success).toBe(true);
  });

  it("refuses an unknown variant", () => {
    expect(SafeTermsSchema.safeParse({ kind: "safe", variant: "post-money" }).success).toBe(false);
  });

  it("refuses an unknown key, because the row is round-tripped as jsonb", () => {
    const parsed = SafeTermsSchema.safeParse({
      kind: "safe",
      variant: "post_money",
      valuationCapp: "10000000",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a discount above 100 per cent", () => {
    expect(
      SafeTermsSchema.safeParse({
        kind: "safe",
        variant: "post_money",
        discountPercent: "100.000001",
      }).success,
    ).toBe(false);
  });

  it("refuses a negative discount", () => {
    expect(
      SafeTermsSchema.safeParse({ kind: "safe", variant: "post_money", discountPercent: "-1" })
        .success,
    ).toBe(false);
  });

  it("accepts the ends of the percentage range", () => {
    for (const percent of ["0", "100", "99.999999"]) {
      expect(
        SafeTermsSchema.safeParse({
          kind: "safe",
          variant: "post_money",
          discountPercent: percent,
        }).success,
        percent,
      ).toBe(true);
    }
  });

  it("refuses a discount written in exponent notation", () => {
    expect(
      SafeTermsSchema.safeParse({ kind: "safe", variant: "post_money", discountPercent: "2e1" })
        .success,
    ).toBe(false);
  });
});

describe("NoteTermsSchema", () => {
  it("requires an interest rate and a maturity", () => {
    expect(NoteTermsSchema.safeParse({ kind: "note", valuationCap: "5000000" }).success).toBe(
      false,
    );
  });

  it("holds a maturity between one and 120 months", () => {
    const base = { kind: "note", interestRatePercent: "6" };
    expect(NoteTermsSchema.safeParse({ ...base, maturityMonths: 0 }).success).toBe(false);
    expect(NoteTermsSchema.safeParse({ ...base, maturityMonths: 1 }).success).toBe(true);
    expect(NoteTermsSchema.safeParse({ ...base, maturityMonths: 120 }).success).toBe(true);
    expect(NoteTermsSchema.safeParse({ ...base, maturityMonths: 121 }).success).toBe(false);
    expect(NoteTermsSchema.safeParse({ ...base, maturityMonths: 12.5 }).success).toBe(false);
  });

  it("refuses an interest rate above 100 per cent", () => {
    expect(
      NoteTermsSchema.safeParse({
        kind: "note",
        interestRatePercent: "101",
        maturityMonths: 24,
      }).success,
    ).toBe(false);
  });
});

describe("PricedTermsSchema", () => {
  it("requires a pre-money valuation and defaults the preference to 1×", () => {
    const terms = PricedTermsSchema.parse({ kind: "priced", preMoneyValuation: "8000000" });
    expect(terms.liquidationPreferenceMultiple).toBe("1");
    expect(terms.participating).toBe(false);
  });

  it("refuses a priced round with no pre-money valuation", () => {
    expect(PricedTermsSchema.safeParse({ kind: "priced", pricePerShare: "1.25" }).success).toBe(
      false,
    );
  });
});

describe("TermsSchema", () => {
  it("picks the arm by kind", () => {
    expect(TermsSchema.parse({ kind: "priced", preMoneyValuation: "8000000" }).kind).toBe("priced");
  });

  it("refuses a body with no kind at all", () => {
    expect(TermsSchema.safeParse({ valuationCap: "10000000" }).success).toBe(false);
  });
});

describe("parseTerms", () => {
  it("parses a body that matches the round's instrument", () => {
    const terms = parseTerms("note", {
      kind: "note",
      interestRatePercent: "6",
      maturityMonths: 24,
    });
    expect(terms.kind).toBe("note");
  });

  it("refuses a note body for a round whose instrument is a SAFE", () => {
    expect(() =>
      parseTerms("safe", { kind: "note", interestRatePercent: "6", maturityMonths: 24 }),
    ).toThrow(z.ZodError);
  });

  it("refuses a SAFE body for a priced round", () => {
    expect(() => parseTerms("priced", { kind: "safe", variant: "post_money" })).toThrow(z.ZodError);
  });

  it("refuses an instrument kind that is not one of the three", () => {
    expect(() =>
      parseTerms("convertible" as unknown as "safe", { kind: "safe", variant: "post_money" }),
    ).toThrow(RangeError);
  });

  it("applies the same defaults the schema does", () => {
    expect(parseTerms("safe", { kind: "safe", variant: "pre_money" })).toEqual({
      kind: "safe",
      variant: "pre_money",
      mfn: false,
      proRata: false,
    });
  });
});
