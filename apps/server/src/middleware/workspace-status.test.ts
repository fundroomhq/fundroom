import { describe, expect, it } from "vitest";
import { statusAllows } from "./workspace-status.js";

/*
 * What a suspended / held workspace still serves (E3.10). The integration test drives the whole
 * chain; this pins the allow-list itself.
 */
const api = (path: string, method = "GET", billingHolder = false) =>
  statusAllows({ tree: "api", path, method, billingHolder });

describe("statusAllows", () => {
  it("serves the pages and assets whatever the path", () => {
    for (const tree of ["app", "admin", "embed", "asset", undefined]) {
      expect(
        statusAllows({ tree, path: "/admin/people", method: "GET", billingHolder: false }),
      ).toBe(true);
    }
  });

  it("serves sign-in, the caller's own account and the bootstrap", () => {
    expect(api("/api/v1/auth/otp/start", "POST")).toBe(true);
    expect(api("/api/v1/auth/logout", "POST")).toBe(true);
    expect(api("/api/v1/me")).toBe(true);
    expect(api("/api/v1/me/sessions/abc", "DELETE")).toBe(true);
    expect(api("/api/v1/modules")).toBe(true);
    expect(api("/api/v1/branding/logo")).toBe(true);
    expect(api("/api/v1/i18n/en")).toBe(true);
    // Reads only: the bootstrap's neighbours are not writable through the exception.
    expect(api("/api/v1/modules/enablement", "PUT")).toBe(false);
    expect(api("/api/v1/modules", "POST")).toBe(false);
  });

  it("serves billing and usage to billing holders only", () => {
    expect(api("/api/v1/billing", "GET", true)).toBe(true);
    expect(api("/api/v1/billing/checkout", "POST", true)).toBe(true);
    expect(api("/api/v1/usage", "GET", true)).toBe(true);
    expect(api("/api/v1/billing", "GET", false)).toBe(false);
    expect(api("/api/v1/billingx", "GET", true)).toBe(false);
  });

  it("serves GET /residency to staff during a relocation only (E3.11)", () => {
    const reloc = (path: string, method = "GET", staffDuringRelocation = true) =>
      statusAllows({ tree: "api", path, method, billingHolder: false, staffDuringRelocation });
    expect(reloc("/api/v1/residency")).toBe(true);
    expect(reloc("/api/v1/residency", "POST")).toBe(false);
    expect(reloc("/api/v1/residency", "GET", false)).toBe(false);
    expect(reloc("/api/v1/residencyx")).toBe(false);
    expect(reloc("/api/v1/compliance/templates/dpa")).toBe(false);
    expect(api("/api/v1/residency")).toBe(false);
  });

  it("refuses everything else", () => {
    expect(api("/api/v1/data-room/folders")).toBe(false);
    expect(api("/api/v1/access/members")).toBe(false);
    expect(api("/api/v1/links/abc/redeem", "POST")).toBe(false);
    expect(api("/api/v1/mex")).toBe(false);
    expect(api("/api/v1/authz")).toBe(false);
  });
});
