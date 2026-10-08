import { describe, expect, it } from "vitest";
import { matchPathMount, type PathMount } from "./path-mount.js";

/* E3.9 path mounts: the allow-list is the gate (ADR-0057). */

const ACME: PathMount = { origin: "https://acme.com", prefix: "/investors" };
const WWW: PathMount = { origin: "https://www.acme.com", prefix: "/investors" };
const PORTAL: PathMount = { origin: "https://caddy.test", prefix: "/portal" };
const DEV: PathMount = { origin: "http://localhost:8080", prefix: "/a/b" };
const MOUNTS = [ACME, WWW, PORTAL, DEV] as const;

/** A header reader that does not validate (the proxy / runtime might not either). */
function raw(h: Record<string, string>) {
  return { get: (name: string) => h[name.toLowerCase()] ?? null };
}

const prefix = (value: string, trustProxy = false, extra: Record<string, string> = {}) =>
  matchPathMount(raw({ "x-forwarded-prefix": value, ...extra }), MOUNTS, trustProxy);

describe("matchPathMount", () => {
  it("matches a configured prefix exactly, with or without one trailing slash", () => {
    const acme = (v: string) => prefix(v, true, { "x-forwarded-host": "acme.com" });
    expect(acme("/investors")).toBe(ACME);
    expect(acme("/investors/")).toBe(ACME);
    expect(acme("  /investors  ")).toBe(ACME);
    expect(prefix("/portal")).toBe(PORTAL);
    expect(prefix("/a/b/")).toBe(DEV);
    expect(matchPathMount(new Headers({ "X-Forwarded-Prefix": "/portal" }), MOUNTS, true)).toBe(
      PORTAL,
    );
  });

  it("is not mounted without the header, with no mounts, or with an empty value", () => {
    expect(matchPathMount(raw({}), MOUNTS, true)).toBeUndefined();
    expect(matchPathMount(raw({ "x-forwarded-prefix": "/investors" }), [], true)).toBeUndefined();
    for (const v of ["", " ", "/", "//"]) expect(prefix(v)).toBeUndefined();
  });

  it("never matches something that is not byte-equal to a prefix", () => {
    for (const v of [
      "/investors//",
      "/Investors",
      "/INVESTORS",
      "investors",
      "/investors/x",
      "/investor",
      "/investorsx",
      "/investors/../x",
      "/investors/..",
      "/x/../investors",
      "/./investors",
      "//investors",
      "//evil.com/investors",
      "//evil",
      "https://acme.com/investors",
      "/%69nvestors",
      "/investors%2F",
      "/investors?x=1",
      "/investors#x",
      "/investors;x",
      "/a",
      "/a/b/c",
      "/ınvestors", // dotless i
      "/ｉnvestors", // full-width i
      "/investors​",
      "/investors\r\nSet-Cookie: x=1",
      "/investors\n",
      "\t/investors\u0000",
      `/investors${"/x".repeat(5000)}`,
      "/".repeat(10_000),
    ]) {
      // With the XFH that would select ACME, so only the prefix comparison can refuse.
      expect(
        prefix(v, true, { "x-forwarded-host": "acme.com" }),
        JSON.stringify(v.slice(0, 40)),
      ).toBeUndefined();
      expect(prefix(v.replace("investors", "portal")), v.slice(0, 40)).toBeUndefined();
    }
  });

  it("ignores a header that carries more than one value (comma or repeated header)", () => {
    expect(prefix("/portal,/portal")).toBeUndefined();
    expect(prefix("/portal, /investors")).toBeUndefined();
    expect(prefix("/evil, /portal")).toBeUndefined();
    const repeated = new Headers();
    repeated.append("X-Forwarded-Prefix", "/portal");
    repeated.append("X-Forwarded-Prefix", "/portal");
    expect(matchPathMount(repeated, MOUNTS, false)).toBeUndefined();
  });

  it("ignores an overlong header before comparing", () => {
    const mounts = [{ origin: "https://a.test", prefix: `/${"a".repeat(2000)}` }];
    expect(
      matchPathMount(raw({ "x-forwarded-prefix": mounts[0]?.prefix ?? "" }), mounts, false),
    ).toBeUndefined();
  });

  it("a single mount with the prefix is used whatever X-Forwarded-Host says", () => {
    for (const trust of [false, true]) {
      expect(prefix("/portal", trust)).toBe(PORTAL);
      for (const host of ["caddy.test", "portal.test", "evil.com", "", "caddy.test:8443"]) {
        expect(prefix("/portal", trust, { "x-forwarded-host": host }), host).toBe(PORTAL);
      }
    }
    expect(prefix("/a/b", true, { "x-forwarded-host": "localhost" })).toBe(DEV);
    // The host never makes an unlisted prefix match.
    expect(prefix("/evil", true, { "x-forwarded-host": "acme.com" })).toBeUndefined();
  });

  it("mounts sharing a prefix: only a believed X-Forwarded-Host picks one, else not mounted", () => {
    // TRUST_PROXY on and naming a mount's host: that mount.
    expect(prefix("/investors", true, { "x-forwarded-host": "acme.com" })).toBe(ACME);
    expect(prefix("/investors", true, { "x-forwarded-host": "www.acme.com" })).toBe(WWW);
    expect(prefix("/investors", true, { "x-forwarded-host": " WWW.ACME.COM " })).toBe(WWW);
    expect(prefix("/investors", true, { "x-forwarded-host": "www.acme.com:443" })).toBe(WWW);
    // Fail closed: no header, header not believed, or naming none of them.
    expect(prefix("/investors", true)).toBeUndefined();
    expect(prefix("/investors", false)).toBeUndefined();
    expect(prefix("/investors", false, { "x-forwarded-host": "www.acme.com" })).toBeUndefined();
    for (const host of [
      "portal.test",
      "evil.com",
      "acme.com.evil.com",
      "www.acme.com:8443",
      "www.acme.com:80",
      "caddy.test",
      "",
      "www.acme.com\r\nx: y",
    ]) {
      expect(prefix("/investors", true, { "x-forwarded-host": host }), host).toBeUndefined();
    }
  });

  it("believes the rightmost X-Forwarded-Host entry (the nearest proxy's), like requestHost", () => {
    expect(prefix("/investors", true, { "x-forwarded-host": "evil.com, www.acme.com" })).toBe(WWW);
    expect(
      prefix("/investors", true, { "x-forwarded-host": "www.acme.com, evil.com" }),
    ).toBeUndefined();
  });

  it("returns the configured object itself (callers compare by identity or fields)", () => {
    const m = prefix("/portal");
    expect(m).toEqual({ origin: "https://caddy.test", prefix: "/portal" });
  });
});
