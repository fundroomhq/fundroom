import { describe, expect, it } from "vitest";
import { MAX_INDEX_BYTES, MAX_RELEASES, parseReleaseIndex } from "./release-index.js";
import { deriveUpdateStatus, disabledStatus, errorStatus, formatUpdateStatus } from "./status.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const rel = (version: string, security = false) => ({
  version,
  date: "2026-10-01",
  url: `https://github.com/fundroomhq/fundroom/releases/tag/v${version}`,
  security,
  summary: `Release ${version}`,
});

const indexOf = (latest: string, releases: ReturnType<typeof rel>[]) => {
  const parsed = parseReleaseIndex(JSON.stringify({ schemaVersion: 1, latest, releases }));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.index;
};

describe("parseReleaseIndex", () => {
  it("accepts a v1 index and drops unknown fields", () => {
    const parsed = parseReleaseIndex(
      JSON.stringify({
        schemaVersion: 1,
        latest: "1.4.2",
        extra: { future: true },
        releases: [{ ...rel("1.4.2"), channel: "stable" }, rel("1.4.1", true)],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.index.latest).toBe("1.4.2");
    expect(parsed.index.releases[0]).not.toHaveProperty("channel");
    expect(parsed.index).not.toHaveProperty("extra");
  });

  it("refuses malformed, oversized and hostile indexes without throwing", () => {
    const ok = { schemaVersion: 1, latest: "1.4.2", releases: [rel("1.4.2")] };
    const cases: [string, string][] = [
      ["not json", "<html>Gateway timeout</html>"],
      ["wrong schema version", JSON.stringify({ ...ok, schemaVersion: 2 })],
      ["loose version", JSON.stringify({ ...ok, latest: "v1.4.2" })],
      ["latest missing from releases", JSON.stringify({ ...ok, latest: "1.4.3" })],
      [
        "prerelease latest",
        JSON.stringify({ ...ok, latest: "1.5.0-rc.1", releases: [rel("1.5.0-rc.1")] }),
      ],
      [
        "javascript: url",
        JSON.stringify({ ...ok, releases: [{ ...rel("1.4.2"), url: "javascript:alert(1)" }] }),
      ],
      [
        "http url",
        JSON.stringify({ ...ok, releases: [{ ...rel("1.4.2"), url: "http://example.com/" }] }),
      ],
      ["bad date", JSON.stringify({ ...ok, releases: [{ ...rel("1.4.2"), date: "2026-13-45" }] })],
      [
        "security not boolean",
        JSON.stringify({ ...ok, releases: [{ ...rel("1.4.2"), security: "yes" }] }),
      ],
      ["duplicate release", JSON.stringify({ ...ok, releases: [rel("1.4.2"), rel("1.4.2")] })],
      ["no releases", JSON.stringify({ ...ok, releases: [] })],
      [
        "too many releases",
        JSON.stringify({
          ...ok,
          releases: Array.from({ length: MAX_RELEASES + 1 }, (_, i) => rel(`1.4.${i}`)),
        }),
      ],
      [
        "summary too long",
        JSON.stringify({ ...ok, releases: [{ ...rel("1.4.2"), summary: "x".repeat(501) }] }),
      ],
      ["oversized", " ".repeat(MAX_INDEX_BYTES + 1)],
      ["array", "[]"],
      ["null", "null"],
    ];
    for (const [name, body] of cases) {
      const parsed = parseReleaseIndex(body);
      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) expect(parsed.reason, name).toMatch(/index/u);
    }
  });
});

describe("deriveUpdateStatus", () => {
  const index = indexOf("1.4.2", [
    rel("1.4.2"),
    rel("1.4.1", true),
    rel("1.4.0"),
    rel("1.3.0", true),
  ]);

  it("a development build (0.0.0) is unknown, with the latest release still reported", () => {
    expect(deriveUpdateStatus("0.0.0", index, NOW)).toEqual({
      status: "unknown",
      currentVersion: "0.0.0",
      latestVersion: "1.4.2",
      checkedAt: NOW.toISOString(),
      releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
    });
  });

  it("a prerelease or unparseable build is unknown", () => {
    expect(deriveUpdateStatus("1.5.0-rc.1", index, NOW).status).toBe("unknown");
    expect(deriveUpdateStatus("1.4.0-rc.1", index, NOW).status).toBe("unknown");
    expect(deriveUpdateStatus("dev", index, NOW).status).toBe("unknown");
  });

  it("the latest release, or a build ahead of the index, is current", () => {
    expect(deriveUpdateStatus("1.4.2", index, NOW)).toMatchObject({
      status: "current",
      latestVersion: "1.4.2",
    });
    expect(deriveUpdateStatus("1.4.2", index, NOW)).not.toHaveProperty("securityReleases");
    expect(deriveUpdateStatus("1.5.0", index, NOW).status).toBe("current");
  });

  it("a newer release with no newer security release is update_available", () => {
    expect(deriveUpdateStatus("1.4.1", index, NOW)).toMatchObject({
      status: "update_available",
      currentVersion: "1.4.1",
      latestVersion: "1.4.2",
    });
  });

  it("any security release newer than this build wins, even when latest is not one", () => {
    expect(deriveUpdateStatus("1.4.0", index, NOW)).toMatchObject({
      status: "security_update",
      latestVersion: "1.4.2",
      securityReleases: ["1.4.1"],
      releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
    });
    // Newest first, and only the ones newer than this build.
    expect(deriveUpdateStatus("1.2.9", index, NOW).securityReleases).toEqual(["1.4.1", "1.3.0"]);
  });

  it("prerelease security releases in the index do not count", () => {
    const pre = indexOf("1.4.2", [rel("1.4.2"), rel("1.5.0-rc.1", true)]);
    expect(deriveUpdateStatus("1.4.2", pre, NOW).status).toBe("current");
  });
});

describe("formatUpdateStatus", () => {
  const index = indexOf("1.4.2", [rel("1.4.2"), rel("1.4.1", true)]);
  it("says one line per status, loudly for a security update", () => {
    expect(formatUpdateStatus(deriveUpdateStatus("1.4.2", index, NOW))).toBe(
      "Update check: up to date (1.4.2; latest release 1.4.2)",
    );
    expect(formatUpdateStatus(deriveUpdateStatus("1.4.1", index, NOW))).toMatch(
      /^Update check: 1\.4\.2 is available \(running 1\.4\.1\) — https:/u,
    );
    expect(formatUpdateStatus(deriveUpdateStatus("1.4.0", index, NOW))).toMatch(
      /SECURITY UPDATE — 1\.4\.1 fixes security issues \(running 1\.4\.0; latest 1\.4\.2\)/u,
    );
    expect(formatUpdateStatus(deriveUpdateStatus("0.0.0", index, NOW))).toContain("development");
    expect(formatUpdateStatus(disabledStatus("1.4.0", "opted_out"))).toBe(
      "Update check: off (UPDATE_CHECK=false)",
    );
    expect(formatUpdateStatus(errorStatus("1.4.0", NOW))).toContain("does not fail doctor");
  });
});
