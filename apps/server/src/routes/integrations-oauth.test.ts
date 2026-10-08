import { describe, expect, it } from "vitest";
import { bindingCookieName, bindingCookieSecure } from "./integrations-oauth.js";

describe("the OAuth binding cookie recipe (fix round 1)", () => {
  it("is Secure with the __Host-/__Secure- prefix on https and loopback", () => {
    for (const base of [
      "https://investors.example.com",
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://app.localhost",
    ]) {
      expect(bindingCookieSecure(new URL(base)), base).toBe(true);
    }
    expect(bindingCookieName("", true)).toBe("__Host-sh_intg");
    expect(bindingCookieName("/portal", true)).toBe("__Secure-sh_intg");
  });
  it("drops Secure (and so the prefix) on a plain-http non-loopback install", () => {
    expect(bindingCookieSecure(new URL("http://portal.example.test"))).toBe(false);
    expect(bindingCookieName("", false)).toBe("sh_intg");
    expect(bindingCookieName("/portal", false)).toBe("sh_intg");
  });
});
