import { describe, expect, it } from "vitest";
import { sendFailure } from "./closing.js";

/** An `ESignError` as the kernel throws it: a code, an HTTP status and details. */
const kernelError = (code: string, status: number, details: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { code, status, details });

describe("what a failed send may have left at the vendor (E3.5 fix C2)", () => {
  it("a clean kernel refusal leaves nothing behind", () => {
    expect(sendFailure(kernelError("esign_not_configured", 409))).toEqual({
      code: "esign_not_configured",
      orphanRisk: false,
    });
    expect(
      sendFailure(kernelError("esign_provider_error", 502, { providerCode: "rejected" })),
    ).toEqual({ code: "esign_provider_error", orphanRisk: false });
    expect(
      sendFailure(kernelError("esign_provider_error", 502, { providerCode: "rate_limited" }))
        .orphanRisk,
    ).toBe(false);
  });

  it("a timeout, an unreadable answer or anything unstructured may have created the envelope", () => {
    for (const providerCode of ["unavailable", "invalid_response"])
      expect(
        sendFailure(kernelError("esign_provider_error", 502, { providerCode })).orphanRisk,
        providerCode,
      ).toBe(true);
    expect(sendFailure(new Error("connection terminated"))).toEqual({
      code: "internal",
      orphanRisk: true,
    });
    expect(sendFailure(Object.assign(new Error("x"), { code: "57P01" })).orphanRisk).toBe(true);
    expect(sendFailure(undefined).orphanRisk).toBe(true);
  });
});
