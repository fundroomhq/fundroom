import { describe, expect, it } from "vitest";
import { workspaceOrigins } from "./central-auth-wiring.js";

/*
 * Which origins central auth hands a code to (E3.10 §5.6): the workspace's `<slug>.<canonical>`
 * host and its ACTIVE primary custom domain — with BASE_URL's scheme and port — and nothing in
 * single-tenant mode.
 */
describe("workspaceOrigins", () => {
  const ws = { slug: "acme", primaryHost: null };

  it("is the slug host in multi mode, plus the active primary custom domain", () => {
    const base = new URL("https://portal.example.com");
    expect(workspaceOrigins(base, "multi", ws)).toEqual(["https://acme.portal.example.com"]);
    expect(workspaceOrigins(base, "multi", { ...ws, primaryHost: "IR.Acme.com" })).toEqual([
      "https://acme.portal.example.com",
      "https://ir.acme.com",
    ]);
  });

  it("keeps BASE_URL's scheme and non-default port, and drops a default one", () => {
    expect(
      workspaceOrigins(new URL("http://portal.test:8080"), "multi", {
        ...ws,
        primaryHost: "ir.acme.com",
      }),
    ).toEqual(["http://acme.portal.test:8080", "http://ir.acme.com:8080"]);
    expect(workspaceOrigins(new URL("https://portal.test:443/base"), "multi", ws)).toEqual([
      "https://acme.portal.test",
    ]);
  });

  it("is empty in single-tenant mode (no workspace host besides the canonical one)", () => {
    expect(
      workspaceOrigins(new URL("https://portal.example.com"), "single", {
        ...ws,
        primaryHost: "ir.acme.com",
      }),
    ).toEqual([]);
  });
});
