import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_KEY_TOKEN_LENGTH,
  API_KEY_TOKEN_PREFIX,
  apiKeyTokenHash,
  displayPrefix,
  isPlausibleApiKey,
  looksLikeApiKey,
  mintApiKeyToken,
} from "./token.js";
import { apiKeyStatus, toApiKeyView } from "./types.js";

describe("API key tokens", () => {
  it("mints frk_ + 43 base64url characters, never twice the same", () => {
    const a = mintApiKeyToken();
    const b = mintApiKeyToken();
    expect(API_KEY_TOKEN_PREFIX).toBe("frk_");
    expect(a).toMatch(/^frk_[A-Za-z0-9_-]{43}$/u);
    expect(a).toHaveLength(API_KEY_TOKEN_LENGTH);
    expect(a).not.toBe(b);
    expect(isPlausibleApiKey(a)).toBe(true);
  });

  it("hashes the whole token with sha256 (32 bytes)", () => {
    const token = mintApiKeyToken();
    const hash = apiKeyTokenHash(token);
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(hash.equals(apiKeyTokenHash(`${token.slice(0, -1)}A`))).toBe(false);
  });

  it("guards the shape before any database work", () => {
    const ok = `frk_${"a".repeat(43)}`;
    expect(isPlausibleApiKey(ok)).toBe(true);
    for (const bad of [
      undefined,
      42,
      "",
      "frk_",
      `frk_${"a".repeat(42)}`,
      `frk_${"a".repeat(44)}`,
      `frk_${"a".repeat(42)}=`,
      `frk_${"a".repeat(42)}+`,
      `FRK_${"a".repeat(43)}`,
      `SHK_${"a".repeat(43)}`,
      `frs_${"a".repeat(43)}`,
      `shs_${"a".repeat(43)}`,
      ` ${ok}`,
      `${ok}\n`,
    ]) {
      expect(isPlausibleApiKey(bad)).toBe(false);
    }
    expect(looksLikeApiKey("frk_x")).toBe(true);
    expect(looksLikeApiKey("metrics-token")).toBe(false);
  });

  it("still accepts a legacy shk_ key minted before the rename (A-2)", () => {
    const legacy = `shk_${"a".repeat(43)}`;
    expect(isPlausibleApiKey(legacy)).toBe(true);
    expect(looksLikeApiKey("shk_x")).toBe(true);
    for (const bad of ["shk_", `shk_${"a".repeat(42)}`, `shk_${"a".repeat(42)}=`]) {
      expect(isPlausibleApiKey(bad)).toBe(false);
    }
    expect(displayPrefix(`shk_Ab3dE6gH${"x".repeat(35)}`)).toBe("shk_Ab3dE6gH");
  });

  it("keeps the first 12 characters for display", () => {
    expect(displayPrefix(`frk_Ab3dE6gH${"x".repeat(35)}`)).toBe("frk_Ab3dE6gH");
    expect(displayPrefix(mintApiKeyToken())).toMatch(/^frk_[A-Za-z0-9_-]{8}$/u);
  });
});

describe("apiKeyStatus / toApiKeyView", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const base = {
    id: "01920000-0000-7000-8000-000000000001",
    workspaceId: "01920000-0000-7000-8000-000000000002",
    name: "Zapier",
    prefix: "frk_Ab3dE6gH",
    scopes: ["metrics.read"],
    createdByMembershipId: "01920000-0000-7000-8000-000000000003",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    lastUsedAt: null,
    lastUsedIp: "203.0.113.0",
    note: null,
  } as const;

  it("revoked beats expired; expiry is exclusive of the instant", () => {
    expect(apiKeyStatus(base, now)).toBe("live");
    expect(apiKeyStatus({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(apiKeyStatus({ ...base, expiresAt: new Date(now.getTime() + 1) }, now)).toBe("live");
    expect(apiKeyStatus({ ...base, expiresAt: new Date(0), revokedAt: new Date(0) }, now)).toBe(
      "revoked",
    );
  });

  it("renders the contract shape without the last-used address", () => {
    const view = toApiKeyView(base, "Ada", now);
    expect(view).toEqual({
      id: base.id,
      name: "Zapier",
      prefix: "frk_Ab3dE6gH",
      scopes: ["metrics.read"],
      status: "live",
      createdAt: "2026-09-01T00:00:00.000Z",
      createdBy: { membershipId: base.createdByMembershipId, displayName: "Ada" },
      expiresAt: null,
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      lastUsedAt: null,
      note: null,
    });
  });
});
