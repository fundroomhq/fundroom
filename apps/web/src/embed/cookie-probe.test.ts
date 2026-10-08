import { describe, expect, it } from "vitest";
import { PROBE_COOKIE, probeCookies } from "./cookie-probe.js";

function jar(accept: boolean) {
  let store = "";
  return {
    get cookie() {
      return store;
    },
    set cookie(v: string) {
      if (!accept) return;
      const [pair = ""] = v.split(";");
      const [name = ""] = pair.split("=");
      if (/Max-Age=0/u.test(v))
        store = store.replace(new RegExp(`${name}=[^;]*;?`, "u"), "").trim();
      else store = pair;
    },
    location: { protocol: "https:", hostname: "portal.test" },
  };
}

describe("probeCookies", () => {
  it("is ok when the cookie round-trips and cleans up", () => {
    const doc = jar(true);
    expect(probeCookies(doc)).toBe("ok");
    expect(doc.cookie).not.toContain(PROBE_COOKIE);
  });
  it("is blocked when the cookie does not stick", () => {
    expect(probeCookies(jar(false))).toBe("blocked");
  });
  it("is insecure on http except localhost", () => {
    const doc = jar(true);
    doc.location = { protocol: "http:", hostname: "acme.test" };
    expect(probeCookies(doc)).toBe("insecure");
    doc.location = { protocol: "http:", hostname: "localhost" };
    expect(probeCookies(doc)).toBe("ok");
  });
  it("is blocked when the setter throws", () => {
    const doc = {
      get cookie(): string {
        return "";
      },
      set cookie(_v: string) {
        throw new Error("denied");
      },
      location: { protocol: "https:", hostname: "x" },
    };
    expect(probeCookies(doc)).toBe("blocked");
  });
});
