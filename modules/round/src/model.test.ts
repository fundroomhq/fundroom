import { describe, expect, it } from "vitest";
import {
  ACCREDITATION_PATHS,
  COMMITMENT_STATUSES,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  evidenceKeyFor,
  evidenceRef,
  INTEREST_STATUSES,
  isEvidenceContentType,
  methodNeedsFile,
  NON_ACCREDITED_LIMIT,
  PROFESSIONAL_LETTER_VALID_DAYS,
  ROUND_DISABLED_WHEN,
  ROUND_STATUSES,
  roundDisabledFor,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  VERIFICATION_VALID_MONTHS,
  verificationExpiry,
} from "./model.js";

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const VERIFICATION = "01920000-0000-7000-8000-0000000000b1";

describe("the vocabularies", () => {
  it("mirrors the PG enums exactly, in the migration's order", () => {
    expect([...ROUND_STATUSES]).toEqual(["planning", "open", "closed"]);
    expect([...INTEREST_STATUSES]).toEqual(["submitted", "accepted", "declined", "withdrawn"]);
    expect([...VERIFICATION_STATUSES]).toEqual(["pending", "verified", "rejected", "expired"]);
    expect([...VERIFICATION_METHODS]).toEqual([
      "document_review",
      "third_party",
      "professional_letter",
      "minimum_investment",
    ]);
  });

  it("re-exports the shared ones rather than declaring a second copy", () => {
    // These four live in `@fundroom/round-terms` because the browser's calculator and the
    // eligibility preview need the same words. A second list here is a list that can be wrong.
    expect([...ACCREDITATION_PATHS]).toEqual([
      "none",
      "self_attested",
      "self_certified",
      "verification_required",
    ]);
    expect([...COMMITMENT_STATUSES]).toEqual(["soft", "verbal", "signed", "wired", "withdrawn"]);
  });

  it("counts 35 non-accredited purchasers, per Rule 506(b)", () => {
    expect(NON_ACCREDITED_LIMIT).toBe(35);
  });
});

describe("ROUND_DISABLED_WHEN", () => {
  /*
   * The pin `permits(status).roundAndTerms === false` asks for, spelled as a literal.
   *
   * `@fundroom/compliance` is deliberately **not** a dependency of this module and must not
   * become one: a module that imported it could reach `core.*` through it, which is the coupling
   * ADR-0033 forbids. So the list is pinned here as a literal and the integration suite proves
   * the behaviour end to end — the 404 for a staff caller in an `informational` workspace is what
   * shows the two agree.
   */
  it("is exactly the statuses where permits(s).roundAndTerms is false", () => {
    expect([...ROUND_DISABLED_WHEN]).toEqual(["none", "informational"]);
  });

  it("switches the module off for those two and leaves the other three alone", () => {
    expect(roundDisabledFor("none")).toBe(true);
    expect(roundDisabledFor("informational")).toBe(true);
    expect(roundDisabledFor("506b")).toBe(false);
    expect(roundDisabledFor("506c")).toBe(false);
    expect(roundDisabledFor("non_us")).toBe(false);
  });
});

describe("evidence", () => {
  it("accepts a PDF, a PNG and a JPEG and nothing else", () => {
    expect([...EVIDENCE_CONTENT_TYPES]).toEqual(["application/pdf", "image/png", "image/jpeg"]);
    for (const type of EVIDENCE_CONTENT_TYPES) expect(isEvidenceContentType(type)).toBe(true);
    // SVG is a script carrier and a heic is something no reviewer can open; both are refused.
    expect(isEvidenceContentType("image/svg+xml")).toBe(false);
    expect(isEvidenceContentType("image/heic")).toBe(false);
    expect(isEvidenceContentType("application/octet-stream")).toBe(false);
    expect(isEvidenceContentType("")).toBe(false);
  });

  it("caps an upload at 10 MiB", () => {
    expect(EVIDENCE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("keys one object per verification, under the workspace", () => {
    expect(evidenceKeyFor(WORKSPACE, VERIFICATION)).toBe(
      `round/verification/${WORKSPACE}/${VERIFICATION}`,
    );
  });

  it("names a file by its key and a note by its hash, and nothing by neither", () => {
    // The reference outlives the file: once the purge has run, `storage:<key>` is still what
    // the attestation says was read, which is what keeps the verification provable.
    expect(evidenceRef({ key: "round/verification/a/b" })).toBe("storage:round/verification/a/b");
    expect(evidenceRef({ noteSha256: "abc123" })).toBe("note:abc123");
    // A key wins: a decision reached from a document names the document.
    expect(evidenceRef({ key: "k", noteSha256: "abc123" })).toBe("storage:k");
    expect(evidenceRef({})).toBeUndefined();
  });
});

describe("verification methods", () => {
  it("asks for a file where the paper *is* the evidence", () => {
    // "I saw a bank statement" is a claim about evidence, not evidence.
    expect(methodNeedsFile("document_review")).toBe(true);
    expect(methodNeedsFile("professional_letter")).toBe(true);
  });

  it("takes a note where the record is the words", () => {
    expect(methodNeedsFile("third_party")).toBe(false);
    expect(methodNeedsFile("minimum_investment")).toBe(false);
  });

  it("expires a professional letter after 90 days", () => {
    const decided = new Date("2026-03-15T12:00:00.000Z");
    expect(PROFESSIONAL_LETTER_VALID_DAYS).toBe(90);
    expect(verificationExpiry("professional_letter", decided).toISOString()).toBe(
      "2026-06-13T12:00:00.000Z",
    );
  });

  it("expires every other method after twelve calendar months", () => {
    const decided = new Date("2026-03-15T12:00:00.000Z");
    expect(VERIFICATION_VALID_MONTHS).toBe(12);
    for (const method of ["document_review", "third_party", "minimum_investment"] as const) {
      expect(verificationExpiry(method, decided).toISOString()).toBe("2027-03-15T12:00:00.000Z");
    }
  });

  it("counts calendar months, not 365 days, so a leap year does not drift", () => {
    expect(verificationExpiry("third_party", new Date("2024-02-29T00:00:00.000Z")).toISOString())
      // Postgres and JavaScript disagree about 29 February + 12 months; JavaScript rolls into
      // March, and rolling *forward* is the safe direction for an expiry.
      .toBe("2025-03-01T00:00:00.000Z");
  });
});
