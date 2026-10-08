import type { AccreditationCredentialField } from "@fundroom/ports";
import { AccreditationProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { AccreditationError } from "./errors.js";
import {
  accreditationCallbackUrl,
  asProviderError,
  boundRefs,
  checkCredentials,
  credentialHint,
  credentialHints,
  environmentOf,
  isCredentialFailure,
  isUuid,
  providerDetail,
} from "./policy.js";

const FIELDS: readonly AccreditationCredentialField[] = [
  { key: "apiToken", label: "API token", kind: "secret", required: true },
  { key: "webhookSecret", label: "Webhook secret", kind: "secret", required: false },
  {
    key: "environment",
    label: "Environment",
    kind: "select",
    options: ["staging", "production"],
    required: true,
  },
  { key: "portalName", label: "Portal name", kind: "text", required: false },
];

function codeOf(fn: () => unknown): { code: string; details: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AccreditationError);
    const e = error as AccreditationError;
    return { code: e.code, details: { ...e.details } };
  }
  throw new Error("did not throw");
}

describe("credential hints", () => {
  it("never show more than the last four characters of a long secret", () => {
    expect(credentialHint({ kind: "secret" }, "vi-token-0123456789abcd")).toBe("••••abcd");
    expect(credentialHint({ kind: "secret" }, "short-secret")).toBe("••••");
    expect(credentialHint({ kind: "text" }, "Acme portal")).toBe("Acme portal");
    expect(credentialHint({ kind: "select" }, "production")).toBe("production");
  });

  it("are built for present fields only", () => {
    expect(
      credentialHints(FIELDS, {
        apiToken: "vi-token-0123456789abcd",
        environment: "staging",
      }),
    ).toEqual({ apiToken: "••••abcd", environment: "staging" });
  });
});

describe("checkCredentials", () => {
  it("accepts a complete form and trims values", () => {
    expect(
      checkCredentials(FIELDS, { apiToken: " tok ", environment: "production", portalName: "" }),
    ).toEqual({ apiToken: "tok", environment: "production" });
  });

  it("refuses unknown keys (400) — in the form or in clearCredentials", () => {
    expect(codeOf(() => checkCredentials(FIELDS, { apiToken: "t", nope: "x" }))).toMatchObject({
      code: "validation_failed",
      details: { reason: "unknown_field", fields: ["nope"] },
    });
    expect(
      codeOf(() => checkCredentials(FIELDS, { apiToken: "t", environment: "staging" }, {}, ["x"])),
    ).toMatchObject({ code: "validation_failed" });
  });

  it("names a missing required field or an invalid option (422 credentials_invalid)", () => {
    expect(codeOf(() => checkCredentials(FIELDS, { environment: "staging" }))).toMatchObject({
      code: "accreditation_credentials_invalid",
      details: { reason: "missing_field", fields: ["apiToken"] },
    });
    expect(
      codeOf(() => checkCredentials(FIELDS, { apiToken: "t", environment: "sandbox" })),
    ).toMatchObject({
      code: "accreditation_credentials_invalid",
      details: { reason: "invalid_option", fields: ["environment"] },
    });
  });

  it("keeps a stored secret left blank; a plain field only when omitted, not when sent blank", () => {
    const previous = {
      apiToken: "stored",
      webhookSecret: "hook",
      environment: "production",
      portalName: "Old",
    };
    expect(
      checkCredentials(FIELDS, { apiToken: "", environment: "staging", portalName: "" }, previous),
    ).toEqual({ apiToken: "stored", webhookSecret: "hook", environment: "staging" });
    expect(checkCredentials(FIELDS, {}, previous)).toEqual(previous);
    // Without a stored connection of this driver nothing is filled in.
    expect(() => checkCredentials(FIELDS, { environment: "staging" })).toThrow(AccreditationError);
  });

  it("clears an optional plain field on request", () => {
    const previous = { apiToken: "stored", environment: "staging", portalName: "Old" };
    expect(checkCredentials(FIELDS, {}, previous, ["portalName"])).toEqual({
      apiToken: "stored",
      environment: "staging",
    });
  });

  it("clears an optional secret only on request, and refuses to clear a required one", () => {
    const previous = { apiToken: "stored", webhookSecret: "hook" };
    expect(
      checkCredentials(FIELDS, { environment: "staging" }, previous, ["webhookSecret"]),
    ).toEqual({ apiToken: "stored", environment: "staging" });
    expect(
      codeOf(() => checkCredentials(FIELDS, { environment: "staging" }, previous, ["apiToken"])),
    ).toMatchObject({ code: "validation_failed", details: { reason: "cannot_clear_required" } });
    expect(
      codeOf(() =>
        checkCredentials(FIELDS, { environment: "staging", webhookSecret: "new" }, previous, [
          "webhookSecret",
        ]),
      ),
    ).toMatchObject({ code: "validation_failed", details: { reason: "clear_conflict" } });
  });

  it("bounds a value's length", () => {
    expect(
      codeOf(() =>
        checkCredentials(FIELDS, { apiToken: "x".repeat(16 * 1024 + 1), environment: "staging" }),
      ),
    ).toMatchObject({
      code: "accreditation_credentials_invalid",
      details: { reason: "field_too_long" },
    });
  });
});

describe("vendor failures", () => {
  it("wraps anything that is not a provider error as a retryable unavailable", () => {
    const e = asProviderError(new TypeError("fetch failed"));
    expect(e).toBeInstanceOf(AccreditationProviderError);
    expect(e.code).toBe("unavailable");
    expect(e.retryable).toBe(true);
  });

  it("tells wrong credentials from an unreachable vendor", () => {
    const err = (code: AccreditationProviderError["code"]) =>
      new AccreditationProviderError("x", code, false);
    expect(isCredentialFailure(err("unauthorized"))).toBe(true);
    expect(isCredentialFailure(err("invalid_request"))).toBe(true);
    expect(isCredentialFailure(err("unavailable"))).toBe(false);
    expect(isCredentialFailure(err("rate_limited"))).toBe(false);
  });

  it("words last_error without a URL query and within 500 characters", () => {
    const d = providerDetail(
      new AccreditationProviderError(
        `GET https://api.example/v?token=abc failed ${"y".repeat(600)}`,
        "unauthorized",
        false,
        401,
      ),
    );
    expect(d).not.toContain("token=abc");
    expect(d.startsWith("unauthorized (401): ")).toBe(true);
    expect(d.length).toBeLessThanOrEqual(500);
  });
});

describe("callbacks", () => {
  it("bounds refs to 20 unique strings of 1..200 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => `r${i}`);
    expect(boundRefs(many)).toHaveLength(20);
    expect(boundRefs(["a", "a", "", 3, "x".repeat(201), "b"])).toEqual(["a", "b"]);
  });

  it("recognises only lower-case uuids", () => {
    expect(isUuid("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a")).toBe(true);
    expect(isUuid("0192F1A0-5C3E-7D2A-9A3B-1F2E3D4C5B6A")).toBe(false);
    expect(isUuid("../../etc")).toBe(false);
  });

  it("builds the callback URL on the canonical origin", () => {
    expect(accreditationCallbackUrl(new URL("https://portal.example/app/"), "abc")).toBe(
      "https://portal.example/webhooks/accreditation/abc",
    );
  });

  it("stores the environment field, defaulting to production", () => {
    expect(environmentOf({ environment: "demo" })).toBe("demo");
    expect(environmentOf({})).toBe("production");
  });
});
