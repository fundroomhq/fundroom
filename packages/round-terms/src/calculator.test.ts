import { describe, expect, it } from "vitest";
import { calculate } from "./calculator.js";
import { parseTerms, type Terms } from "./terms.js";

const safe = (extra: Record<string, unknown> = {}): Terms =>
  parseTerms("safe", { kind: "safe", variant: "post_money", ...extra });
const note = (extra: Record<string, unknown> = {}): Terms =>
  parseTerms("note", { kind: "note", interestRatePercent: "6", maturityMonths: 24, ...extra });
const priced = (extra: Record<string, unknown> = {}): Terms =>
  parseTerms("priced", { kind: "priced", preMoneyValuation: "8000000", ...extra });

const sentences = (result: { explanation: readonly string[] }): string =>
  result.explanation.join(" ");
const notes = (result: { assumptions: readonly string[] }): string => result.assumptions.join(" ");

describe("calculate — SAFE, post-money cap", () => {
  it("divides the amount by the cap and says so in a sentence a person can check", () => {
    const result = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(result.kind).toBe("safe");
    expect(result.ownershipPercentLow).toBe("1.00");
    expect(result.ownershipPercentHigh).toBe("1.00");
    expect(result.effectiveValuation).toBe("10000000");
    expect(result.explanation[0]).toBe(
      "At a $10,000,000 post-money cap, $100,000 buys about 1.00% of the company.",
    );
  });

  it("ignores the round target: a post-money cap already includes the round", () => {
    const withTarget = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "5000000",
    });
    const withoutTarget = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(withTarget.ownershipPercentLow).toBe(withoutTarget.ownershipPercentLow);
    expect(withTarget.effectiveValuation).toBe("10000000");
  });

  it("carries the estimate note and the option-pool caveat", () => {
    const result = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(notes(result)).toContain("option pool");
    expect(result.assumptions.at(-1)).toContain("not investment advice");
  });

  it("rounds the percentage to two places, half away from zero", () => {
    const result = calculate({
      terms: safe({ valuationCap: "3000000" }),
      amount: "100000",
      roundTarget: "0",
    });
    // 100000 / 3000000 = 3.3333…%
    expect(result.ownershipPercentLow).toBe("3.33");
  });

  it("answers with no percentage when the cap is zero rather than dividing by it", () => {
    const result = calculate({
      terms: safe({ valuationCap: "0" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(result.ownershipPercentLow).toBeUndefined();
    expect(result.effectiveValuation).toBeUndefined();
    expect(sentences(result)).toContain("no valuation cap");
  });
});

describe("calculate — SAFE, pre-money cap", () => {
  it("adds the round target to the cap before working out the share", () => {
    const result = calculate({
      terms: parseTerms("safe", {
        kind: "safe",
        variant: "pre_money",
        valuationCap: "8000000",
      }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(result.ownershipPercentLow).toBe("1.00");
    expect(result.effectiveValuation).toBe("10000000");
    expect(sentences(result)).toContain("A pre-money cap of $8,000,000 plus a $2,000,000 round");
  });

  it("gives a bigger share than the same number as a post-money cap", () => {
    const pre = calculate({
      terms: parseTerms("safe", { kind: "safe", variant: "pre_money", valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    const post = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(Number(pre.ownershipPercentLow)).toBeLessThan(Number(post.ownershipPercentLow));
  });

  it("says out loud that it assumed the whole target is raised", () => {
    const result = calculate({
      terms: parseTerms("safe", { kind: "safe", variant: "pre_money", valuationCap: "8000000" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(notes(result)).toContain("Assumes the full round target of $2,000,000 is raised");
  });
});

describe("calculate — SAFE, discount", () => {
  it("gives a range when a cap and a discount are both set, the cap being the floor", () => {
    const result = calculate({
      terms: safe({ valuationCap: "10000000", discountPercent: "20" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(result.ownershipPercentLow).toBe("1.00");
    expect(result.ownershipPercentHigh).toBe("1.25");
    expect(sentences(result)).toContain("a better price than the cap");
  });

  it("estimates nothing from a discount alone, and explains what the discount buys", () => {
    const result = calculate({
      terms: safe({ discountPercent: "20" }),
      amount: "100000",
      roundTarget: "2000000",
    });
    expect(result.ownershipPercentLow).toBeUndefined();
    expect(result.ownershipPercentHigh).toBeUndefined();
    expect(result.effectiveValuation).toBeUndefined();
    expect(sentences(result)).toContain(
      "$100,000 buys as much of that round as $125,000 of new money would",
    );
    expect(notes(result)).toContain("price of the next priced round is unknown");
  });

  it("treats a zero discount as no discount", () => {
    const zero = calculate({
      terms: safe({ valuationCap: "10000000", discountPercent: "0" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(zero.ownershipPercentHigh).toBe(zero.ownershipPercentLow);
  });

  it("does not divide by zero on a 100 per cent discount", () => {
    const result = calculate({
      terms: safe({ valuationCap: "10000000", discountPercent: "100" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(result.ownershipPercentLow).toBe("1.00");
    expect(result.ownershipPercentHigh).toBe("1.00");
    expect(sentences(result)).toContain("100.00% discount");
  });

  it("says a capless, discountless SAFE converts with the next round", () => {
    const result = calculate({ terms: safe(), amount: "100000", roundTarget: "2000000" });
    expect(result.ownershipPercentLow).toBeUndefined();
    expect(sentences(result)).toContain("no valuation cap and no discount");
  });

  it("mentions MFN and pro-rata only when the terms carry them", () => {
    const plain = calculate({ terms: safe({ valuationCap: "1" }), amount: "1", roundTarget: "1" });
    expect(sentences(plain)).not.toContain("most-favoured-nation");
    expect(sentences(plain)).not.toContain("Pro-rata");
    const both = calculate({
      terms: safe({ valuationCap: "10000000", mfn: true, proRata: true }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(sentences(both)).toContain("most-favoured-nation");
    expect(sentences(both)).toContain("Pro-rata rights");
  });
});

describe("calculate — convertible note", () => {
  it("adds simple interest over the term and converts the larger number", () => {
    const result = calculate({
      terms: note({ valuationCap: "5000000" }),
      amount: "100000",
      roundTarget: "1000000",
    });
    expect(result.kind).toBe("note");
    // 6 % of 100,000 for two years = 12,000
    expect(result.explanation[0]).toBe(
      "Simple interest of 6.00% a year over 24 months adds about $12,000 to your $100,000, so about $112,000 converts.",
    );
    expect(result.ownershipPercentLow).toBe("2.24");
    expect(result.effectiveValuation).toBe("5000000");
  });

  it("pro-rates the interest over a part year", () => {
    const result = calculate({
      terms: note({ valuationCap: "5000000", interestRatePercent: "8", maturityMonths: 6 }),
      amount: "100000",
      roundTarget: "0",
    });
    // 8 % for six months = 4,000
    expect(sentences(result)).toContain("adds about $4,000");
  });

  it("states that the interest is simple, not compounded", () => {
    const result = calculate({ terms: note(), amount: "100000", roundTarget: "0" });
    expect(notes(result)).toContain("simple, not compounded");
    expect(notes(result)).toContain("full 24-month term");
  });

  it("matches a SAFE with the same cap when the rate is zero", () => {
    const zeroRate = calculate({
      terms: note({ valuationCap: "5000000", interestRatePercent: "0", maturityMonths: 12 }),
      amount: "100000",
      roundTarget: "0",
    });
    const equivalent = calculate({
      terms: safe({ valuationCap: "5000000" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(zeroRate.ownershipPercentLow).toBe(equivalent.ownershipPercentLow);
    expect(sentences(zeroRate)).toContain("0.00% simple interest");
  });

  it("gives a cap-and-discount range on the accrued amount", () => {
    const result = calculate({
      terms: note({ valuationCap: "5000000", discountPercent: "25" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(result.ownershipPercentLow).toBe("2.24");
    // 112,000 / (5,000,000 × 0.75)
    expect(result.ownershipPercentHigh).toBe("2.99");
  });

  it("estimates nothing from an uncapped note and says why", () => {
    const result = calculate({
      terms: note({ discountPercent: "20" }),
      amount: "100000",
      roundTarget: "0",
    });
    expect(result.ownershipPercentLow).toBeUndefined();
    expect(sentences(result)).toContain("This note has no valuation cap");
  });
});

describe("calculate — priced round", () => {
  it("divides by the post-money valuation, which is pre-money plus the round", () => {
    const result = calculate({
      terms: priced(),
      amount: "250000",
      roundTarget: "2000000",
    });
    expect(result.kind).toBe("priced");
    expect(result.ownershipPercentLow).toBe("2.50");
    expect(result.ownershipPercentHigh).toBe("2.50");
    expect(result.effectiveValuation).toBe("10000000");
  });

  it("estimates shares when a price per share is set", () => {
    const result = calculate({
      terms: priced({ pricePerShare: "1.25" }),
      amount: "250000",
      roundTarget: "2000000",
    });
    expect(result.sharesEstimate).toBe("200000");
    expect(sentences(result)).toContain("At $1.25 a share that is about 200,000 shares.");
  });

  it("omits the share count, and says why, when no price per share is set", () => {
    const result = calculate({
      terms: priced(),
      amount: "250000",
      roundTarget: "2000000",
    });
    expect(result.sharesEstimate).toBeUndefined();
    expect(notes(result)).toContain("No price per share is set");
  });

  it("keeps sub-cent share prices instead of rounding them to nothing", () => {
    const result = calculate({
      terms: priced({ pricePerShare: "0.0625" }),
      amount: "1000",
      roundTarget: "0",
    });
    expect(result.sharesEstimate).toBe("16000");
    expect(sentences(result)).toContain("At $0.0625 a share");
  });

  it("spells out the liquidation preference in words", () => {
    const plain = calculate({ terms: priced(), amount: "1", roundTarget: "0" });
    expect(sentences(plain)).toContain("A 1× non-participating liquidation preference");
    const participating = calculate({
      terms: priced({ liquidationPreferenceMultiple: "1.5", participating: true }),
      amount: "1",
      roundTarget: "0",
    });
    expect(sentences(participating)).toContain("A 1.5× participating liquidation preference");
    expect(sentences(participating)).toContain("share what is left alongside them");
  });

  it("explains where the option pool comes from when the terms name one", () => {
    const withPool = calculate({
      terms: priced({ optionPoolPercent: "10" }),
      amount: "250000",
      roundTarget: "2000000",
    });
    expect(notes(withPool)).toContain("A 10.00% option pool comes out of the pre-money valuation");
    const withoutPool = calculate({ terms: priced(), amount: "250000", roundTarget: "2000000" });
    expect(notes(withoutPool)).toContain("Ignores any new or enlarged option pool");
  });

  it("answers with no percentage rather than dividing by a zero valuation", () => {
    const result = calculate({
      terms: priced({ preMoneyValuation: "0" }),
      amount: "250000",
      roundTarget: "0",
    });
    expect(result.ownershipPercentLow).toBeUndefined();
    expect(sentences(result)).toContain("add up to nothing");
  });
});

describe("calculate — inputs it must survive", () => {
  it("treats an unreadable amount as nothing rather than throwing", () => {
    const result = calculate({
      terms: safe({ valuationCap: "10000000" }),
      amount: "1e5",
      roundTarget: "2000000",
    });
    expect(result.ownershipPercentLow).toBe("0.00");
  });

  it("treats an unreadable round target as nothing", () => {
    const result = calculate({
      terms: parseTerms("safe", { kind: "safe", variant: "pre_money", valuationCap: "10000000" }),
      amount: "100000",
      roundTarget: "not a number",
    });
    expect(result.effectiveValuation).toBe("10000000");
  });

  it("always returns at least one sentence and the estimate note", () => {
    for (const terms of [safe(), note(), priced()]) {
      const result = calculate({ terms, amount: "0", roundTarget: "0" });
      expect(result.explanation.length).toBeGreaterThan(0);
      expect(result.assumptions.length).toBeGreaterThan(1);
      expect(result.assumptions.at(-1)).toContain("not an offer of these terms");
    }
  });
});
