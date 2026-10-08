import { describe, expect, it } from "vitest";
import {
  ACCREDITATION_CATEGORIES,
  ACCREDITATION_QUESTIONNAIRE_VERSION,
  ACCREDITATION_VALID_MONTHS,
  AccreditationAnswersSchema,
  accreditationAttestations,
  accreditationExpiry,
  isAccreditationCategory,
} from "./accreditation.js";

const NOW = new Date("2026-09-14T10:30:00.000Z");

const ACCEPTANCE = Object.freeze({
  documentId: "01920000-0000-7000-8000-0000000000d0",
  slug: "accreditation",
  versionNo: 2,
  bodySha256: "ab".repeat(32),
  acceptedAt: NOW.toISOString(),
});

describe("accreditationAttestations", () => {
  it("writes two rows, because agreeing to a text and being accredited are different facts", () => {
    const [clickwrap, accredited] = accreditationAttestations({
      stamp: "accreditation:v2",
      signedAt: NOW,
      answers: { categories: ["us.income"] },
      acceptance: ACCEPTANCE,
    });
    expect(clickwrap.kind).toBe("accreditation:v2");
    expect(accredited.kind).toBe("accredited");
  });

  it("leaves the click-wrap row without an expiry, so six years of evidence never lapses", () => {
    const [clickwrap] = accreditationAttestations({
      stamp: "accreditation:v2",
      signedAt: NOW,
      answers: { categories: ["us.net_worth"] },
      acceptance: ACCEPTANCE,
    });
    expect(clickwrap.expiresAt).toBeNull();
  });

  it("expires only the `accredited` row, twelve months on, because that is the dated claim", () => {
    const [, accredited] = accreditationAttestations({
      stamp: "accreditation:v2",
      signedAt: NOW,
      answers: { categories: ["us.net_worth"] },
      acceptance: ACCEPTANCE,
    });
    expect(accredited.expiresAt?.toISOString()).toBe("2027-09-14T10:30:00.000Z");
    expect(accredited.data["validMonths"]).toBe(ACCREDITATION_VALID_MONTHS);
  });

  it("carries the category answers as data on both rows, never as a code enum", () => {
    const [clickwrap, accredited] = accreditationAttestations({
      stamp: "accreditation:v2",
      signedAt: NOW,
      answers: {
        categories: ["us.income", "uk.high_net_worth"],
        section: "us",
        note: "angel syndicate since 2019",
      },
      acceptance: ACCEPTANCE,
    });
    for (const row of [clickwrap, accredited]) {
      expect(row.data["accreditation"]).toEqual({
        categories: ["us.income", "uk.high_net_worth"],
        section: "us",
        note: "angel syndicate since 2019",
        questionnaireVersion: ACCREDITATION_QUESTIONNAIRE_VERSION,
      });
      // The click-wrap evidence rides on both rows so either alone is self-describing.
      expect(row.data["bodySha256"]).toBe(ACCEPTANCE.bodySha256);
    }
  });

  it("records the method as self-certified, because 506(c) verification is not this", () => {
    const [, accredited] = accreditationAttestations({
      stamp: "accreditation:v1",
      signedAt: NOW,
      answers: { categories: [] },
      acceptance: ACCEPTANCE,
    });
    expect(accredited.data["method"]).toBe("self_certified");
  });

  it('keeps "none of these apply" as an answer, since 506(b) acts on it', () => {
    const [, accredited] = accreditationAttestations({
      stamp: "accreditation:v1",
      signedAt: NOW,
      answers: { categories: [] },
      acceptance: ACCEPTANCE,
    });
    expect(accredited.data["accreditation"]).toMatchObject({ categories: [] });
  });
});

describe("accreditationExpiry", () => {
  it("adds twelve calendar months, so the date matches the form's own renewal clause", () => {
    expect(accreditationExpiry(new Date("2026-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-31T00:00:00.000Z",
    );
  });

  it("clamps 29 February to 28 February rather than rolling into March", () => {
    expect(accreditationExpiry(new Date("2028-02-29T12:00:00.000Z")).toISOString()).toBe(
      "2029-02-28T12:00:00.000Z",
    );
  });
});

describe("the question set", () => {
  it("is data with stable ids, so a regulator's amended list is not a code change", () => {
    const ids = ACCREDITATION_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isAccreditationCategory("us.income")).toBe(true);
    expect(isAccreditationCategory("us.made_up")).toBe(false);
  });

  it("covers every section the shipped questionnaire asks about", () => {
    const sections = new Set(ACCREDITATION_CATEGORIES.map((c) => c.section));
    expect([...sections].sort()).toEqual(["ca", "eu", "uk", "us"]);
  });

  it("accepts a category id the shipped set does not know, so a tenant's edit survives", () => {
    const parsed = AccreditationAnswersSchema.safeParse({ categories: ["jp.qualified_investor"] });
    expect(parsed.success).toBe(true);
  });

  it("rejects a category id that is not an id at all", () => {
    expect(AccreditationAnswersSchema.safeParse({ categories: ["=cmd|calc"] }).success).toBe(false);
  });
});
