import { describe, expect, it } from "vitest";
import {
  createScimService,
  effectiveRole,
  errorFields,
  isPlausibleScimToken,
  SCIM_TOKEN_RE,
  scimTokenHash,
} from "./index.js";
import {
  LEGACY_SCIM_TOKEN_PREFIX,
  mintScimToken,
  SCIM_TOKEN_PREFIX,
  scimDisplayPrefix,
} from "./token.js";

describe("@fundroom/scim", () => {
  it("exports the service factory", () => {
    expect(typeof createScimService).toBe("function");
  });

  it("mints frs_ tokens of 256 bits, hashed with sha256", () => {
    const t = mintScimToken();
    expect(SCIM_TOKEN_PREFIX).toBe("frs_");
    expect(t).toMatch(/^frs_[A-Za-z0-9_-]{43}$/u);
    expect(t).toMatch(SCIM_TOKEN_RE);
    expect(isPlausibleScimToken(t)).toBe(true);
    expect(isPlausibleScimToken(`shk_${t.slice(4)}`)).toBe(false);
    expect(isPlausibleScimToken(`frk_${t.slice(4)}`)).toBe(false);
    expect(isPlausibleScimToken(`FRS_${t.slice(4)}`)).toBe(false);
    expect(isPlausibleScimToken(`${t}x`)).toBe(false);
    expect(isPlausibleScimToken(undefined)).toBe(false);
    expect(scimTokenHash(t)).toHaveLength(32);
    expect(scimTokenHash(t).equals(scimTokenHash(t))).toBe(true);
    expect(scimDisplayPrefix(t)).toBe(t.slice(0, 12));
    expect(mintScimToken()).not.toBe(t);
  });

  it("still accepts a legacy shs_ token minted before the rename (A-2)", () => {
    const legacy = `${LEGACY_SCIM_TOKEN_PREFIX}${mintScimToken().slice(4)}`;
    expect(legacy.startsWith("shs_")).toBe(true);
    expect(isPlausibleScimToken(legacy)).toBe(true);
    expect(isPlausibleScimToken(`${legacy}x`)).toBe(false);
    expect(scimDisplayPrefix(legacy)).toBe(legacy.slice(0, 12));
  });

  it("picks the effective role by precedence admin > legal > finance > editor > viewer", () => {
    expect(effectiveRole([], "editor")).toBe("editor");
    expect(effectiveRole(["viewer", "editor"], "viewer")).toBe("editor");
    expect(effectiveRole(["finance", "legal", "editor"], "viewer")).toBe("legal");
    expect(effectiveRole(["legal", "admin"], "viewer")).toBe("admin");
    expect(effectiveRole(["viewer"], "legal")).toBe("viewer");
  });
});

describe("errorFields (R2-M5)", () => {
  it("keeps the pg code and constraint, never the message", () => {
    const pg = Object.assign(new Error("duplicate key … params: jane@acme.test"), {
      code: "23505",
      constraint: "scim_user_user_name_idx",
    });
    const wrapped = Object.assign(new Error("Failed query: insert … params: jane@acme.test"), {
      cause: pg,
    });
    const f = errorFields(wrapped);
    expect(f).toEqual({
      errorName: "Error",
      pgCode: "23505",
      constraint: "scim_user_user_name_idx",
    });
    expect(JSON.stringify(f)).not.toContain("jane");
  });
});
