import { API_ERROR_CODES } from "@fundroom/contracts";
import { describe, expect, it } from "vitest";
import { RoundError, type RoundErrorCode } from "./errors.js";

/*
 * The error table. `routes.ts` owns the translation from a `RoundErrorCode` to an
 * `ApiErrorCode`, and this file pins the two properties that make that translation safe: every
 * round code has a status, and every status is one the module's routes actually declare.
 *
 * The table is restated here rather than imported because `routes.ts` cannot be imported into a
 * unit test without dragging the whole OpenAPI app in. A drift shows up as a code missing from
 * one side or the other.
 */
const API_CODE: Readonly<Record<RoundErrorCode, string>> = {
  not_found: "not_found",
  conflict: "conflict",
  validation_failed: "validation_failed",
  forbidden: "forbidden",
  rate_limited: "rate_limited",
  round_not_open: "conflict",
  round_already_open: "conflict",
  terms_missing: "conflict",
  below_minimum: "conflict",
  accreditation_required: "conflict",
  evidence_required: "validation_failed",
  unsupported_media_type: "unsupported_media_type",
  payload_too_large: "payload_too_large",
  scan_failed: "validation_failed",
  signature_request_open: "conflict",
  signature_request_pending: "conflict",
  envelope_not_open: "envelope_not_open",
  commitment_not_signable: "conflict",
  commitment_not_wired: "conflict",
  signer_email_missing: "signer_email_missing",
  esign_not_configured: "esign_not_configured",
  esign_template_unsupported: "esign_template_unsupported",
  subscription_template_missing: "conflict",
  verification_pending: "conflict",
  verification_not_vendor: "conflict",
  member_erased: "conflict",
};

/**
 * The statuses the round routes declare: `ERRORS` in `routes.ts` plus the closing routes' 422
 * (`signer_email_missing`, `esign_template_unsupported`).
 */
const DECLARED = [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503];

describe("RoundError", () => {
  it("carries its code, its message and its details", () => {
    const error = new RoundError("below_minimum", "too small", { minimum: "50000.00" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RoundError");
    expect(error.code).toBe("below_minimum");
    expect(error.message).toBe("too small");
    expect(error.details).toEqual({ minimum: "50000.00" });
  });

  it("defaults its details to an empty object, so a caller can always spread them", () => {
    expect(new RoundError("not_found", "gone").details).toEqual({});
  });
});

describe("the API code table", () => {
  it("maps every round code onto a status the routes declare", () => {
    for (const [code, apiCode] of Object.entries(API_CODE)) {
      const status = (API_ERROR_CODES as Record<string, number>)[apiCode];
      expect(status, `${code} → ${apiCode}`).toBeDefined();
      expect(DECLARED, `${code} → ${apiCode} (${String(status)})`).toContain(status);
    }
  });

  it("keeps the refusals an investor can act on distinguishable", () => {
    /*
     * Four different refusals all answer 409, and that is the point of carrying the round code
     * through in `details.reason`: "this round is not open", "you are below the minimum",
     * "another round is already open" and "this investor has to be verified first" are one
     * status and four completely different sentences on screen.
     */
    const conflicts = Object.entries(API_CODE)
      .filter(([, apiCode]) => apiCode === "conflict")
      .map(([code]) => code);
    expect(conflicts).toEqual([
      "conflict",
      "round_not_open",
      "round_already_open",
      "terms_missing",
      "below_minimum",
      "accreditation_required",
      // E3.5 closing: five more sentences behind one status.
      "signature_request_open",
      "signature_request_pending",
      "commitment_not_signable",
      "commitment_not_wired",
      "subscription_template_missing",
      // E3.7 vendor verification.
      "verification_pending",
      "verification_not_vendor",
      "member_erased",
    ]);
  });

  it("gives an upload its own two statuses rather than folding them into 400", () => {
    // 413 and 415 are the ones a file picker can act on without reading a message.
    expect(API_ERROR_CODES[API_CODE.payload_too_large as "payload_too_large"]).toBe(413);
    expect(API_ERROR_CODES[API_CODE.unsupported_media_type as "unsupported_media_type"]).toBe(415);
  });

  it("reports a rate limit as 429, which is the one clients retry on", () => {
    expect(API_ERROR_CODES[API_CODE.rate_limited as "rate_limited"]).toBe(429);
  });

  it("reports a failed scan as the caller's problem, not the server's", () => {
    // A file the scanner refused is a thing the investor can fix by uploading another; a 500
    // would invite them to retry the same bytes for ever.
    expect(API_ERROR_CODES[API_CODE.scan_failed as "validation_failed"]).toBe(400);
  });
});
