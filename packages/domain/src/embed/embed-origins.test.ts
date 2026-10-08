import { describe, expect, it } from "vitest";
import {
  EmbedSettingsSchema,
  embedFrameAncestors,
  isAllowedEmbedOrigin,
  isEmbedConfigured,
  MAX_EMBED_ORIGINS,
  normalizeEmbedOrigin,
  originMatchesPattern,
  PREVIEW_ORIGIN_PATTERNS,
} from "./embed-origins.js";

const settings = (over: Record<string, unknown> = {}) => EmbedSettingsSchema.parse(over);

describe("normalizeEmbedOrigin", () => {
  it.each([
    ["https://acme.com", "https://acme.com"],
    ["https://www.acme.com", "https://www.acme.com"],
    ["HTTPS://ACME.COM", "https://acme.com"],
    ["https://acme.com/", "https://acme.com"],
    ["  https://acme.com  ", "https://acme.com"],
    ["https://acme.com:8443", "https://acme.com:8443"],
    ["https://a.b.c.acme.co.uk", "https://a.b.c.acme.co.uk"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173"],
    ["http://host-a.localhost", "http://host-a.localhost"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeEmbedOrigin(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["acme.com", "no scheme"],
    ["http://acme.com", "plain http off loopback cannot set a Partitioned cookie"],
    ["ftp://acme.com", "wrong scheme"],
    ["javascript:alert(1)", "not an origin"],
    ["data:text/html,x", "not an origin"],
    ["https://acme.com/investors", "carries a path"],
    ["https://acme.com?a=1", "carries a query"],
    ["https://acme.com#x", "carries a fragment"],
    ["https://user:pw@acme.com", "carries credentials"],
    ["https://*.acme.com", "customer wildcard"],
    ["https://*", "bare wildcard"],
    ["null", "the opaque origin"],
    ["*", "everything"],
    ["https://acme.com:0", "port 0"],
    ["https://acme com", "space in host"],
    ["https://acme.com;https://evil.com", "would forge a CSP directive"],
  ])("refuses %s (%s)", (input) => {
    expect(normalizeEmbedOrigin(input)).toBeUndefined();
  });

  it("refuses an origin whose rendering would break buildCsp", () => {
    // packages/http's buildCsp throws on a source containing [;,\s]; nothing that survives
    // normalisation may contain one, or a stored value could take the whole header down.
    for (const candidate of ["https://a.com", "http://localhost:1", "https://a.b.example:65535"]) {
      const normalized = normalizeEmbedOrigin(candidate);
      expect(normalized).toBeDefined();
      expect(normalized).not.toMatch(/[;,\s]/u);
    }
  });
});

describe("EmbedSettingsSchema", () => {
  it("defaults to a closed configuration", () => {
    expect(settings()).toEqual({
      origins: [],
      allowPreviewOrigins: false,
      trustHostIdentity: false,
      handoffKeys: [],
    });
  });

  it("normalises origins as it parses them", () => {
    expect(settings({ origins: ["HTTPS://Acme.com/"] }).origins).toEqual(["https://acme.com"]);
  });

  it("rejects a wildcard origin", () => {
    expect(EmbedSettingsSchema.safeParse({ origins: ["https://*.acme.com"] }).success).toBe(false);
  });

  it(`caps the list at ${MAX_EMBED_ORIGINS}`, () => {
    const many = Array.from({ length: MAX_EMBED_ORIGINS + 1 }, (_, i) => `https://h${i}.acme.com`);
    expect(EmbedSettingsSchema.safeParse({ origins: many }).success).toBe(false);
  });

  it("accepts a 32-byte base64url Ed25519 public key and refuses a short one", () => {
    const key = {
      id: "wp-1",
      publicKey: "A".repeat(43),
      addedAt: "2026-09-13T00:00:00.000Z",
    };
    expect(EmbedSettingsSchema.safeParse({ handoffKeys: [key] }).success).toBe(true);
    expect(
      EmbedSettingsSchema.safeParse({ handoffKeys: [{ ...key, publicKey: "A".repeat(42) }] })
        .success,
    ).toBe(false);
  });
});

describe("embedFrameAncestors", () => {
  it("always allows our own origin so the admin preview works before any origin is listed", () => {
    expect(embedFrameAncestors(settings())).toEqual(["'self'"]);
  });

  it("lists configured origins after 'self'", () => {
    expect(embedFrameAncestors(settings({ origins: ["https://acme.com"] }))).toEqual([
      "'self'",
      "https://acme.com",
    ]);
  });

  it("adds the curated preview wildcards only when the toggle is on", () => {
    const on = embedFrameAncestors(settings({ allowPreviewOrigins: true }));
    expect(on).toEqual(["'self'", ...PREVIEW_ORIGIN_PATTERNS]);
    expect(embedFrameAncestors(settings({ allowPreviewOrigins: false }))).not.toContain(
      "https://*.webflow.io",
    );
  });

  it("never contains a character that would forge a CSP directive", () => {
    const sources = embedFrameAncestors(
      settings({ origins: ["https://acme.com"], allowPreviewOrigins: true }),
    );
    for (const s of sources) expect(s).not.toMatch(/[;,\s]/u);
  });
});

describe("originMatchesPattern", () => {
  it("matches a subdomain", () => {
    expect(originMatchesPattern("https://*.webflow.io", "https://acme.webflow.io")).toBe(true);
    expect(originMatchesPattern("https://*.webflow.io", "https://a.b.webflow.io")).toBe(true);
  });

  it("does not match the bare domain", () => {
    expect(originMatchesPattern("https://*.webflow.io", "https://webflow.io")).toBe(false);
  });

  it("does not match a suffix collision", () => {
    expect(originMatchesPattern("https://*.webflow.io", "https://evilwebflow.io")).toBe(false);
    expect(originMatchesPattern("https://*.webflow.io", "https://webflow.io.evil.com")).toBe(false);
  });

  it("does not match across schemes or with a port", () => {
    expect(originMatchesPattern("https://*.webflow.io", "http://acme.webflow.io")).toBe(false);
  });

  it("treats an exact pattern as exact", () => {
    expect(originMatchesPattern("https://acme.com", "https://acme.com")).toBe(true);
    expect(originMatchesPattern("https://acme.com", "https://www.acme.com")).toBe(false);
  });
});

describe("isAllowedEmbedOrigin", () => {
  const self = "https://portal.example";

  it("allows our own origin", () => {
    expect(isAllowedEmbedOrigin(settings(), self, self)).toBe(true);
  });

  it("allows a listed origin, case-insensitively", () => {
    const s = settings({ origins: ["https://acme.com"] });
    expect(isAllowedEmbedOrigin(s, "https://acme.com", self)).toBe(true);
    expect(isAllowedEmbedOrigin(s, "HTTPS://ACME.COM", self)).toBe(true);
    expect(isAllowedEmbedOrigin(s, "https://www.acme.com", self)).toBe(false);
  });

  it("refuses the opaque origin and the empty string", () => {
    const s = settings({ origins: ["https://acme.com"] });
    expect(isAllowedEmbedOrigin(s, "null", self)).toBe(false);
    expect(isAllowedEmbedOrigin(s, "", self)).toBe(false);
  });

  it("honours the preview toggle", () => {
    expect(isAllowedEmbedOrigin(settings(), "https://acme.webflow.io", self)).toBe(false);
    expect(
      isAllowedEmbedOrigin(
        settings({ allowPreviewOrigins: true }),
        "https://acme.webflow.io",
        self,
      ),
    ).toBe(true);
  });
});

describe("isEmbedConfigured", () => {
  it("is false until an origin or the preview toggle exists", () => {
    expect(isEmbedConfigured(settings())).toBe(false);
    expect(isEmbedConfigured(settings({ origins: ["https://acme.com"] }))).toBe(true);
    expect(isEmbedConfigured(settings({ allowPreviewOrigins: true }))).toBe(true);
  });
});
