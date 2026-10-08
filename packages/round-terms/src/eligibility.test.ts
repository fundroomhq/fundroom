import { describe, expect, it } from "vitest";
import { type EligibilityInput, eligibility, US_MIN_INVESTMENT } from "./eligibility.js";

const input = (extra: Partial<EligibilityInput> = {}): EligibilityInput => ({
  offeringStatus: "506c",
  subject: "individual",
  amount: "250000",
  currency: "USD",
  ...extra,
});

describe("eligibility — the statuses where the round module is switched off", () => {
  it("throws for `none`, because the route should have answered 404", () => {
    expect(() => eligibility(input({ offeringStatus: "none" }))).toThrow(RangeError);
  });

  it("throws for `informational`", () => {
    expect(() => eligibility(input({ offeringStatus: "informational" }))).toThrow(RangeError);
  });

  it("names the status in the message so the bug is findable", () => {
    expect(() => eligibility(input({ offeringStatus: "informational" }))).toThrow(/informational/u);
  });
});

describe("eligibility — 506(b)", () => {
  it("self-attests, with the questionnaire, whatever the amount", () => {
    for (const amount of ["1000", "200000", "5000000"]) {
      const result = eligibility(input({ offeringStatus: "506b", amount }));
      expect(result.path, amount).toBe("self_attested");
      expect(result.questionnaire).toBe(true);
      expect(result.thresholdMet).toBe(false);
    }
  });

  it("names no threshold: the minimum-investment rule is a 506(c) rule", () => {
    expect(eligibility(input({ offeringStatus: "506b" })).threshold).toBeUndefined();
  });

  it("explains itself without naming a regulation", () => {
    const result = eligibility(input({ offeringStatus: "506b" }));
    expect(result.reason).toContain("questionnaire");
    expect(result.reason).not.toContain("506");
  });

  it("does not depend on the subject", () => {
    const individual = eligibility(input({ offeringStatus: "506b", subject: "individual" }));
    const entity = eligibility(input({ offeringStatus: "506b", subject: "entity" }));
    expect(individual.path).toBe(entity.path);
  });
});

describe("eligibility — 506(c) and the minimum-investment safe harbour", () => {
  it("pins the two figures from the no-action letter", () => {
    expect(US_MIN_INVESTMENT).toEqual({ individual: "200000", entity: "1000000" });
  });

  it("self-certifies an individual at exactly $200,000 — at or above, not above", () => {
    const result = eligibility(input({ subject: "individual", amount: "200000" }));
    expect(result.path).toBe("self_certified");
    expect(result.thresholdMet).toBe(true);
    expect(result.threshold).toEqual({ amount: "200000", currency: "USD" });
  });

  it("self-certifies an individual above the figure", () => {
    expect(eligibility(input({ subject: "individual", amount: "200000.01" })).path).toBe(
      "self_certified",
    );
  });

  it("requires verification a cent below the figure", () => {
    const result = eligibility(input({ subject: "individual", amount: "199999.99" }));
    expect(result.path).toBe("verification_required");
    expect(result.thresholdMet).toBe(false);
  });

  it("self-certifies an entity at exactly $1,000,000", () => {
    const result = eligibility(input({ subject: "entity", amount: "1000000" }));
    expect(result.path).toBe("self_certified");
    expect(result.thresholdMet).toBe(true);
    expect(result.threshold).toEqual({ amount: "1000000", currency: "USD" });
  });

  it("holds an entity to the higher figure: $200,000 is not enough", () => {
    const result = eligibility(input({ subject: "entity", amount: "200000" }));
    expect(result.path).toBe("verification_required");
    expect(result.threshold?.amount).toBe("1000000");
  });

  it("requires verification for a small 506(c) investment", () => {
    const result = eligibility(input({ amount: "5000" }));
    expect(result.path).toBe("verification_required");
    expect(result.questionnaire).toBe(true);
    expect(result.thresholdMet).toBe(false);
  });

  it("still requires verification for a large investment in another currency", () => {
    const result = eligibility(input({ amount: "5000000", currency: "EUR" }));
    expect(result.path).toBe("verification_required");
    expect(result.thresholdMet).toBe(false);
    // The safe harbour is a dollar figure; the round is not in dollars, so it cannot apply.
    expect(result.reason).not.toContain("Investing at least");
  });

  it("reads the currency case-insensitively and past stray whitespace", () => {
    expect(eligibility(input({ amount: "200000", currency: " usd " })).path).toBe("self_certified");
  });

  it("records the answers either way: the questionnaire is shown on both 506(c) paths", () => {
    expect(eligibility(input({ amount: "10" })).questionnaire).toBe(true);
    expect(eligibility(input({ amount: "1000000" })).questionnaire).toBe(true);
  });

  it("requires verification when the amount is not a number it can read", () => {
    for (const amount of ["", "2e5", "lots"]) {
      expect(eligibility(input({ amount })).path, amount).toBe("verification_required");
    }
  });

  it("offers the written-representation route in the reason when the round is in dollars", () => {
    expect(eligibility(input({ amount: "1000" })).reason).toContain("Investing at least $200,000");
  });

  it("names the figure with separators in the self-certified reason", () => {
    expect(eligibility(input({ subject: "entity", amount: "2000000" })).reason).toContain(
      "$1,000,000",
    );
  });
});

describe("eligibility — outside the United States", () => {
  it("asks for nothing and shows no questionnaire", () => {
    const result = eligibility(input({ offeringStatus: "non_us", amount: "5000000" }));
    expect(result.path).toBe("none");
    expect(result.questionnaire).toBe(false);
    expect(result.thresholdMet).toBe(false);
    expect(result.threshold).toBeUndefined();
  });

  it("uses neutral copy with no US prompts", () => {
    const result = eligibility(input({ offeringStatus: "non_us" }));
    expect(result.reason).toContain("outside the United States");
    expect(result.reason).not.toContain("accredited status has to be verified");
  });
});
