import { sha256 } from "@fundroom/identity";
import { describe, expect, it } from "vitest";
import {
  cappedDwellMs,
  HEARTBEAT_MAX_MS,
  ipHashOf,
  isUnscoredLink,
  sessionKeyOf,
  syntheticSessionKey,
  tracksFor,
  uaFamilyOf,
} from "./privacy.js";

describe("uaFamilyOf", () => {
  it("classifies the common browsers by family only", () => {
    expect(
      uaFamilyOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      ),
    ).toBe("edge");
    expect(
      uaFamilyOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe("chrome");
    expect(
      uaFamilyOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe("safari");
    expect(
      uaFamilyOf("Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0"),
    ).toBe("firefox");
    expect(
      uaFamilyOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("chrome");
    expect(uaFamilyOf("curl/8.4.0")).toBe("other");
    expect(uaFamilyOf("")).toBe("other");
    expect(uaFamilyOf(undefined)).toBe("other");
  });
});

describe("session keys", () => {
  it("hashes the session id and never equals it", () => {
    const id = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
    const key = sessionKeyOf(id);
    expect(key).toHaveLength(32);
    expect(key.toString("hex")).not.toContain(id.replace(/-/gu, ""));
    expect(sessionKeyOf(id).equals(key)).toBe(true);
    expect(sessionKeyOf("other").equals(key)).toBe(false);
  });

  it("synthetic keys are per member and per UTC day", () => {
    const a = syntheticSessionKey("m1", new Date("2026-09-12T23:59:00Z"));
    expect(a.equals(syntheticSessionKey("m1", new Date("2026-09-12T00:01:00Z")))).toBe(true);
    expect(a.equals(syntheticSessionKey("m1", new Date("2026-09-13T00:01:00Z")))).toBe(false);
    expect(a.equals(syntheticSessionKey("m2", new Date("2026-09-12T12:00:00Z")))).toBe(false);
  });
});

describe("tracksFor", () => {
  it("grows with the mode", () => {
    expect(tracksFor("off")).toEqual([]);
    expect(tracksFor("essential")).toEqual(["document_views", "downloads", "update_views"]);
    expect(tracksFor("engagement")).toContain("page_dwell");
    expect(tracksFor("engagement")).toContain("hashed_ip");
  });

  it("discloses email opens, clicks and the engagement score under `engagement` only", () => {
    for (const key of ["email_opens", "email_clicks", "engagement_score"]) {
      expect(tracksFor("engagement")).toContain(key);
      expect(tracksFor("essential")).not.toContain(key);
    }
  });
});

describe("isUnscoredLink", () => {
  it("flags the unsubscribe page and any /api/ path, on any origin", () => {
    expect(isUnscoredLink("https://acme.example/unsubscribe")).toBe(true);
    expect(isUnscoredLink("https://acme.example/unsubscribe/abc")).toBe(true);
    expect(isUnscoredLink("https://acme.example/UNSUBSCRIBE")).toBe(true);
    expect(isUnscoredLink("https://acme.example/api/v1/mail/unsubscribe")).toBe(true);
    expect(isUnscoredLink("https://acme.example//api/x")).toBe(true);
    expect(isUnscoredLink("/api/v1/x")).toBe(true);
  });

  it("leaves real content links alone", () => {
    expect(isUnscoredLink(null)).toBe(false);
    expect(isUnscoredLink("https://acme.example/deck")).toBe(false);
    expect(isUnscoredLink("https://acme.example/apis")).toBe(false);
    expect(isUnscoredLink("https://acme.example/unsubscribed-faq")).toBe(false);
    expect(isUnscoredLink("https://acme.example/updates/api")).toBe(false);
  });
});

describe("ipHashOf", () => {
  const keyA = new Uint8Array(32).fill(1);
  const keyB = new Uint8Array(32).fill(2);

  it("is keyed per workspace, stable, and never returns the address", () => {
    const a = ipHashOf(keyA, "203.0.113.7");
    expect(a).not.toBeNull();
    expect(a?.length).toBe(32);
    // Two workspaces never hash the same visitor alike: the key differs, not just a salt.
    expect(a?.equals(ipHashOf(keyB, "203.0.113.7") as Buffer)).toBe(false);
    expect(a?.equals(ipHashOf(keyA, "203.0.113.7") as Buffer)).toBe(true);
    expect(a?.equals(ipHashOf(keyA, "203.0.113.8") as Buffer)).toBe(false);
    expect(a?.toString("utf8")).not.toContain("203.0.113.7");
  });

  it("is a keyed MAC, not a digest anyone holding the database could recompute", () => {
    // IPv4 is only 2^32 wide, so an unkeyed digest over public inputs is enumerable from a
    // dump alone. Knowing the workspace id and the address must not be enough.
    expect(ipHashOf(keyA, "203.0.113.7")?.equals(sha256("ip:203.0.113.7"))).toBe(false);
  });

  it("is null when there is no address to hash", () => {
    expect(ipHashOf(keyA, undefined)).toBeNull();
    expect(ipHashOf(keyA, null)).toBeNull();
    expect(ipHashOf(keyA, "")).toBeNull();
  });
});

describe("cappedDwellMs", () => {
  it("caps one beat at the ceiling and floors the rest", () => {
    expect(cappedDwellMs(4_500)).toBe(4_500);
    expect(cappedDwellMs(4_500.9)).toBe(4_500);
    expect(cappedDwellMs(120_000)).toBe(HEARTBEAT_MAX_MS);
  });

  it("treats nonsense as no dwell at all", () => {
    expect(cappedDwellMs(0)).toBe(0);
    expect(cappedDwellMs(-1)).toBe(0);
    expect(cappedDwellMs(Number.NaN)).toBe(0);
    expect(cappedDwellMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
