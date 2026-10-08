import { describe, expect, it } from "vitest";
import {
  clearCookie,
  cookieModeFor,
  cookieName,
  isPathScopedMode,
  MAX_COOKIE_AGE_SECONDS,
  parseCookies,
  readCookie,
  serializeCookie,
} from "./cookies.js";

describe("cookie recipes (§6.3)", () => {
  it("standalone / subdomain: __Host-, Lax, root path", () => {
    expect(serializeCookie("session", "abc", { mode: "first_party" })).toBe(
      "__Host-sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
  });

  it("embed iframe: __Host-, SameSite=None, Partitioned", () => {
    expect(serializeCookie("session", "abc", { mode: "partitioned", maxAgeSeconds: 3600 })).toBe(
      "__Host-sid=abc; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=3600",
    );
  });

  it("path mount: __Secure- with the base path (no __Host- possible)", () => {
    expect(serializeCookie("session", "abc", { mode: "path_mount", basePath: "/investors" })).toBe(
      "__Secure-sid=abc; Path=/investors; Secure; HttpOnly; SameSite=Lax",
    );
    expect(() => serializeCookie("session", "abc", { mode: "path_mount" })).toThrow(/basePath/u);
  });

  it("names every cookie kind consistently per mode", () => {
    expect(cookieName("device", "first_party")).toBe("__Host-did");
    expect(cookieName("authRequest", "partitioned")).toBe("__Host-auth_req");
    expect(cookieName("device", "path_mount")).toBe("__Secure-did");
    // E3.8: the staff SSO binding is its own cookie, beside the install-wide OIDC one.
    expect(cookieName("oidcRequest", "first_party")).toBe("__Host-oidc_req");
    expect(cookieName("ssoRequest", "first_party")).toBe("__Host-sso_req");
    expect(cookieName("ssoRequest", "path_mount")).toBe("__Secure-sso_req");
    // E3.10: the central-auth verifier on the workspace host.
    expect(cookieName("centralRequest", "first_party")).toBe("__Host-auth_creq");
  });

  it("caps Max-Age at 400 days and rejects illegal values", () => {
    expect(
      serializeCookie("device", "abc", { mode: "first_party", maxAgeSeconds: 10 ** 9 }),
    ).toContain(`Max-Age=${MAX_COOKIE_AGE_SECONDS}`);
    expect(() => serializeCookie("session", "a b", { mode: "first_party" })).toThrow(/forbidden/u);
    expect(() => serializeCookie("session", "a;b", { mode: "first_party" })).toThrow(/forbidden/u);
  });

  it("clears with Max-Age=0 and the same attributes", () => {
    expect(clearCookie("session", { mode: "partitioned" })).toBe(
      "__Host-sid=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0",
    );
  });

  it("picks the mode from embed + the request's public base", () => {
    expect(cookieModeFor({ embed: true, basePath: "/x" })).toBe("partitioned_path_mount");
    expect(cookieModeFor({ embed: false, basePath: "/x" })).toBe("path_mount");
    expect(cookieModeFor({ embed: false })).toBe("first_party");
    expect(cookieModeFor({ embed: false, basePath: "" })).toBe("first_party");
    expect(cookieModeFor({ embed: true })).toBe("partitioned");
    expect(cookieModeFor({ embed: true, basePath: "" })).toBe("partitioned");
    expect(cookieModeFor({ embed: true, basePath: undefined })).toBe("partitioned");
    expect(isPathScopedMode("path_mount")).toBe(true);
    expect(isPathScopedMode("partitioned_path_mount")).toBe(true);
    expect(isPathScopedMode("first_party")).toBe(false);
    expect(isPathScopedMode("partitioned")).toBe(false);
  });

  it("E3.9: embed under a base is __Secure-, Path=<base>, SameSite=None; Partitioned", () => {
    const mode = cookieModeFor({ embed: true, basePath: "/investors" });
    expect(serializeCookie("session", "abc", { mode, basePath: "/investors" })).toBe(
      "__Secure-sid=abc; Path=/investors; Secure; HttpOnly; SameSite=None; Partitioned",
    );
    expect(clearCookie("device", { mode, basePath: "/investors" })).toBe(
      "__Secure-did=; Path=/investors; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0",
    );
    expect(cookieName("session", mode)).toBe("__Secure-sid");
    expect(() => serializeCookie("session", "abc", { mode })).toThrow(/basePath/u);
  });

  it("E3.9: a path-mount prefix is the cookie Path (nested prefixes too)", () => {
    const mode = cookieModeFor({ embed: false, basePath: "/ir/portal" });
    expect(
      serializeCookie("authRequest", "t", { mode, basePath: "/ir/portal", maxAgeSeconds: 600 }),
    ).toBe("__Secure-auth_req=t; Path=/ir/portal; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
  });

  it("refuses a base that is not BASE_PATH-shaped (no attribute injection via Path)", () => {
    for (const basePath of [
      "investors",
      "/investors/",
      "/",
      "//evil",
      "/a;Domain=evil.com",
      "/a; SameSite=None",
      "/a\r\nSet-Cookie: x=1",
      "/a b",
      "/ä",
      "/a,b",
    ]) {
      expect(
        () => serializeCookie("session", "abc", { mode: "path_mount", basePath }),
        basePath,
      ).toThrow(/basePath/u);
      expect(
        () => clearCookie("session", { mode: "partitioned_path_mount", basePath }),
        basePath,
      ).toThrow(/basePath/u);
    }
    // The root modes ignore basePath entirely.
    expect(serializeCookie("session", "abc", { mode: "first_party", basePath: "/x;y" })).toBe(
      "__Host-sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
  });

  it("E3.9: a direct-origin session is not read on a mounted request, nor the reverse", () => {
    const direct = "__Host-sid=direct";
    const mounted = "__Secure-sid=mounted";
    const both = `${direct}; ${mounted}`;
    const mountMode = cookieModeFor({ embed: false, basePath: "/investors" });
    const rootMode = cookieModeFor({ embed: false, basePath: "" });
    expect(readCookie(direct, "session", mountMode)).toBeUndefined();
    expect(readCookie(mounted, "session", rootMode)).toBeUndefined();
    expect(readCookie(both, "session", mountMode)).toBe("mounted");
    expect(readCookie(both, "session", rootMode)).toBe("direct");
    // An embed session under a base reads its own name, never the root partitioned one.
    expect(readCookie(direct, "session", "partitioned_path_mount")).toBeUndefined();
    expect(readCookie(mounted, "session", "partitioned_path_mount")).toBe("mounted");
  });

  it("parses request cookies and reads by kind", () => {
    const header = "a=1; __Host-sid=tok; broken; __Host-did = dev ;a=2";
    expect([...parseCookies(header)]).toEqual([
      ["a", "2"],
      ["__Host-sid", "tok"],
      ["__Host-did", "dev"],
    ]);
    expect(readCookie(header, "session", "first_party")).toBe("tok");
    expect(readCookie(header, "session", "path_mount")).toBeUndefined();
    expect(readCookie(undefined, "session", "first_party")).toBeUndefined();
  });
});
