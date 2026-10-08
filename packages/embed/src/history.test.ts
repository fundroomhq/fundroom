import { describe, expect, it } from "vitest";
import { HISTORY_PARAM, readPathFromUrl, writePathToUrl } from "./history.js";

describe("history sync", () => {
  it("writes a readable `?sh=/path` and reads it back", () => {
    const href = writePathToUrl("https://host.example/investors", "query", "/updates/2026-q2");
    expect(href).toBe("https://host.example/investors?sh=/updates/2026-q2");
    expect(readPathFromUrl(href, "query")).toBe("/updates/2026-q2");
  });

  it("leaves the host's own query parameters alone", () => {
    const href = writePathToUrl("https://host.example/p?utm=x&ref=%2Fa%2Fb", "query", "/data-room");
    // The host's `%2F` is still encoded: only our parameter is serialised by hand.
    expect(href).toContain("utm=x");
    expect(href).toContain("ref=%2Fa%2Fb");
    expect(readPathFromUrl(href, "query")).toBe("/data-room");
  });

  it("replaces its own parameter rather than appending a second one", () => {
    const once = writePathToUrl("https://host.example/p?sh=/updates", "query", "/round");
    expect(once).toBe("https://host.example/p?sh=/round");
    expect(once.match(new RegExp(`${HISTORY_PARAM}=`, "gu"))).toHaveLength(1);
  });

  it("round-trips through the fragment in hash mode", () => {
    const href = writePathToUrl("https://host.example/p#whatever", "hash", "/updates");
    expect(href).toBe("https://host.example/p#sh=/updates");
    expect(readPathFromUrl(href, "hash")).toBe("/updates");
  });

  it("writes nothing and reads nothing in none mode", () => {
    expect(writePathToUrl("https://host.example/p", "none", "/updates")).toBe(
      "https://host.example/p",
    );
    expect(readPathFromUrl("https://host.example/p?sh=/updates", "none")).toBeUndefined();
  });

  it("refuses a path in the URL that is not an in-app path", () => {
    expect(readPathFromUrl("https://host.example/p?sh=//evil.example", "query")).toBeUndefined();
    expect(readPathFromUrl("https://host.example/p?sh=updates", "query")).toBeUndefined();
    expect(readPathFromUrl("https://host.example/p", "query")).toBeUndefined();
    expect(readPathFromUrl("not a url", "query")).toBeUndefined();
  });

  it("refuses a `..` path from the URL, which would repoint the frame", () => {
    // Regression: a shared link carrying `?sh=/../../embed/victim` must not survive the read.
    for (const sh of ["/..", "/../../admin", "/../../embed/victim", "/.%2e/%2e./admin"]) {
      const href = `https://host.example/p?sh=${encodeURIComponent(sh).replace(/%2F/gu, "/")}`;
      expect(readPathFromUrl(href, "query")).toBeUndefined();
      expect(readPathFromUrl(`https://host.example/p#sh=${sh}`, "hash")).toBeUndefined();
    }
  });

  it("leaves the host's other parameters byte for byte as they were", () => {
    // Regression: round-tripping the query through `URLSearchParams` rewrote it on every
    // `replaceState` — `b%20c` → `b+c`, `:/@` → `%3A%2F%40`, a valueless `y` gaining an `=`.
    const cases: [string, string][] = [
      ["?a=b%20c&d=:/@", "?a=b%20c&d=:/@&sh=/updates"],
      ["?x=%E2%82%AC&y", "?x=%E2%82%AC&y&sh=/updates"],
      ["?b=+2&c=%2B3", "?b=+2&c=%2B3&sh=/updates"],
      ["", "?sh=/updates"],
    ];
    for (const [search, expected] of cases) {
      const href = writePathToUrl(`https://host.example/p${search}`, "query", "/updates");
      expect(href).toBe(`https://host.example/p${expected}`);
    }
    // And writing twice does not accumulate or re-encode anything.
    const once = writePathToUrl("https://host.example/p?a=b%20c", "query", "/updates");
    expect(writePathToUrl(once, "query", "/round")).toBe(
      "https://host.example/p?a=b%20c&sh=/round",
    );
  });

  it("survives a path with a query and a fragment of its own", () => {
    const href = writePathToUrl("https://host.example/p", "query", "/updates?tab=all");
    expect(readPathFromUrl(href, "query")).toBe("/updates?tab=all");
  });
});
