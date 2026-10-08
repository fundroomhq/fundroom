import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./auth.js";

/*
 * F-02 (ASVS 3.7.2): the OIDC callback redirects to `${basePath}${returnTo}`, so anything that a
 * browser would resolve off-origin, or outside the base path, must be refused.
 */
describe("safeReturnPath", () => {
  it("keeps ordinary same-origin paths, query and fragment", () => {
    expect(safeReturnPath("/", "")).toBe("/");
    expect(safeReturnPath("/admin", "")).toBe("/admin");
    expect(safeReturnPath("/admin/people?tab=staff#top", "")).toBe("/admin/people?tab=staff#top");
    expect(safeReturnPath("/admin", "/portal")).toBe("/admin");
    expect(safeReturnPath("/a/./b/../c", "")).toBe("/a/c");
  });

  it("refuses everything that resolves to another origin", () => {
    for (const raw of [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/ /evil.com",
      "/ /evil.com",
      "/ /evil.com",
      "/%5Cevil.com",
      "/%5cevil.com",
      "/%2F/evil.com",
      "https://evil.com",
      "evil.com",
      "javascript:alert(1)",
      "",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(safeReturnPath(raw, ""), JSON.stringify(raw)).toBeUndefined();
      expect(safeReturnPath(raw, "/portal"), JSON.stringify(raw)).toBeUndefined();
    }
    expect(safeReturnPath(undefined, "")).toBeUndefined();
  });

  it("refuses paths that climb out of the base path", () => {
    expect(safeReturnPath("/../other-app", "/portal")).toBeUndefined();
    expect(safeReturnPath("/%2e%2e/other-app", "/portal")).toBeUndefined();
    expect(safeReturnPath("/../portal/admin", "/portal")).toBe("/admin");
    expect(safeReturnPath("/.//evil.com", "")).toBeUndefined(); // dot segment → `//evil.com`
  });

  it("never returns a value whose first segment holds an encoded slash or backslash (R1-06)", () => {
    for (const raw of [
      "/./%2Fevil.com",
      "/./%2fevil.com",
      "/./%5Cevil.com",
      "/a/%2e%2e/%2fevil.com",
      "/a/../%5cevil.com",
      "/x%2F/evil.com",
    ]) {
      expect(safeReturnPath(raw, ""), JSON.stringify(raw)).toBeUndefined();
      expect(safeReturnPath(raw, "/portal"), JSON.stringify(raw)).toBeUndefined();
    }
    // Later segments may carry them (a document name, say): only the first one is ambiguous.
    expect(safeReturnPath("/docs/a%2Fb", "")).toBe("/docs/a%2Fb");
  });

  it("every accepted value stays on the origin when redirected to", () => {
    const origin = "https://investors.acme.test";
    for (const raw of ["/admin", "/a?b=//c", "/x#//y", "/%2e%2e/x", "/.//evil.com"]) {
      const path = safeReturnPath(raw, "");
      if (path === undefined) continue;
      expect(new URL(path, origin).origin).toBe(origin);
    }
  });
});
