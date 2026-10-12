import { describe, expect, it } from "vitest";
import {
  buildReleaseIndex,
  type GitHubRelease,
  hasSecurityEntry,
  parseGitHubReleases,
  versionOfTag,
} from "./index-builder.js";
import {
  MAX_INDEX_BYTES,
  MAX_RELEASES,
  parseReleaseIndex,
  type ReleaseIndex,
} from "./release-index.js";

const gh = (tag: string, published = "2026-10-09T18:30:00Z", notes = ""): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/fundroomhq/fundroom/releases/tag/${tag}`,
  published_at: published,
  draft: false,
  notes,
});

// What @changesets/changelog-github writes for a changeset whose summary starts with the marker.
const SECURITY_NOTES = [
  "### Patch Changes",
  "",
  "- [#41](https://github.com/fundroomhq/fundroom/pull/41) [`1a2b3c4`](https://github.com/fundroomhq/fundroom/commit/1a2b3c4) Thanks [@fundroomio](https://github.com/fundroomio)! - **Security:** session cookies were not cleared on sign-out.",
].join("\n");

const build = (opts: Parameters<typeof buildReleaseIndex>[0]) => {
  const r = buildReleaseIndex(opts);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("hasSecurityEntry", () => {
  it("finds the marker at the start of a changelog entry, whatever links precede it", () => {
    expect(hasSecurityEntry(SECURITY_NOTES)).toBe(true);
    expect(hasSecurityEntry("- **Security:** fixed")).toBe(true);
    expect(hasSecurityEntry("- [`1a2b3c4`](https://x) - **Security:** fixed")).toBe(true);
    expect(hasSecurityEntry("- 1a2b3c4: **Security:** fixed")).toBe(true);
    expect(hasSecurityEntry("- [#41](https://x/pull/41) - **Security:** fixed")).toBe(true);
    expect(
      hasSecurityEntry("- Thanks [@a](https://x/a), [@b-c](https://x/b-c)! - **Security:** fixed"),
    ).toBe(true);
  });

  it("ignores the marker anywhere else, and empty notes", () => {
    expect(hasSecurityEntry("- Thanks! - Documents the **Security** convention")).toBe(false);
    expect(hasSecurityEntry("- Fixes x. **Security:** not at the start")).toBe(false);
    expect(hasSecurityEntry("  continuation line\n**Security:** heading")).toBe(false);
    // Text before the marker that is not a changelog writer's prefix: the changeset's summary
    // did not start with it, so check-changesets would not call it a security changeset either.
    expect(hasSecurityEntry("- Fix x - **Security:** y")).toBe(false);
    expect(
      hasSecurityEntry("- [#1](https://x/1) Thanks [@a](https://x/a)! - Fix - **Security:** y"),
    ).toBe(false);
    expect(hasSecurityEntry("- Thanks [@a](https://x/a)! - Fix! - **Security:** y")).toBe(false);
    expect(hasSecurityEntry("- Thanks for x! - **Security:** y")).toBe(false);
    expect(hasSecurityEntry("- [link](https://x) - **Security:** y")).toBe(false);
    expect(hasSecurityEntry("* **Security:** y")).toBe(false);
    expect(hasSecurityEntry(null)).toBe(false);
    expect(hasSecurityEntry(undefined)).toBe(false);
  });
});

describe("parseGitHubReleases / versionOfTag", () => {
  it("reads one page or gh --paginate --slurp pages", () => {
    expect(parseGitHubReleases([gh("v1.0.0")])).toHaveLength(1);
    expect(parseGitHubReleases([[gh("v1.0.0")], [gh("v1.0.1"), gh("v1.0.2")]])).toHaveLength(3);
    expect(parseGitHubReleases([])).toEqual([]);
  });

  it("refuses what is not a release list", () => {
    expect(() => parseGitHubReleases({ message: "Bad credentials" })).toThrow(/array/u);
    expect(() => parseGitHubReleases([{ tag_name: "v1.0.0" }])).toThrow(/entry 0/u);
  });

  it("strict versions only", () => {
    expect(versionOfTag("v1.0.0-rc.0")).toBe("1.0.0-rc.0");
    expect(versionOfTag("1.0.0")).toBe("1.0.0");
    expect(versionOfTag("chart-v0.1.0")).toBeUndefined();
    expect(versionOfTag("v01.0.0")).toBeUndefined();
  });
});

describe("buildReleaseIndex", () => {
  it("before 1.0: every rc listed, newest first, no latest, valid for the reader", () => {
    const r = build({
      releases: [
        gh("v1.0.0-rc.0", "2026-10-09T23:59:59Z"),
        gh("v1.0.0-rc.1", "2026-10-13T00:00:01+02:00"),
        { ...gh("v1.0.0-rc.2"), draft: true },
        { ...gh("v1.0.0-rc.3"), published_at: null },
        gh("chart-v0.1.0"),
        gh("wp-v1.0.0"),
      ],
    });
    expect(r.index).toEqual({
      schemaVersion: 1,
      releases: [
        {
          version: "1.0.0-rc.1",
          // The publish date in UTC, not the offset's local date.
          date: "2026-10-12",
          url: "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0-rc.1",
          security: false,
        },
        {
          version: "1.0.0-rc.0",
          date: "2026-10-09",
          url: "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0-rc.0",
          security: false,
        },
      ],
    });
    expect(r.skippedTags).toEqual(["chart-v0.1.0", "wp-v1.0.0"]);
    expect(r.added).toEqual(["1.0.0-rc.1", "1.0.0-rc.0"]);
    expect(r.body.endsWith("}\n")).toBe(true);
    expect(parseReleaseIndex(r.body)).toEqual({ ok: true, index: r.index });
  });

  it("latest is the highest stable release, by precedence rather than date or order", () => {
    const r = build({
      releases: [gh("v1.0.0"), gh("v1.10.0"), gh("v1.9.0"), gh("v1.11.0-rc.0"), gh("v2.0.0-rc.1")],
    });
    expect(r.index.latest).toBe("1.10.0");
    expect(r.index.releases.map((x) => x.version)).toEqual([
      "2.0.0-rc.1",
      "1.11.0-rc.0",
      "1.10.0",
      "1.9.0",
      "1.0.0",
    ]);
  });

  it("is deterministic: the same inputs give the same bytes", () => {
    const releases = [gh("v1.0.1", undefined, SECURITY_NOTES), gh("v1.0.0")];
    const a = build({ releases });
    const b = build({ releases: [...releases].reverse() });
    expect(a.body).toBe(b.body);
    expect(build({ current: a.index, releases }).body).toBe(a.body);
  });

  describe("security", () => {
    it("a new release is flagged by a security entry in its notes", () => {
      const r = build({ releases: [gh("v1.0.1", undefined, SECURITY_NOTES), gh("v1.0.0")] });
      expect(r.index.releases.map((x) => [x.version, x.security])).toEqual([
        ["1.0.1", true],
        ["1.0.0", false],
      ]);
    });

    it("a listed release keeps its published flag; its notes are not read again", () => {
      const current = build({ releases: [gh("v1.0.0")] }).index;
      const flagged: ReleaseIndex = {
        ...current,
        releases: [
          { ...(current.releases[0] as ReleaseIndex["releases"][number]), security: true },
        ],
      };
      // 1.0.0 now has marker-free notes and is still flagged; the notes of 1.0.0 gaining a
      // marker later would not flag it either (dispatch does that).
      const r = build({ current: flagged, releases: [gh("v1.0.1"), gh("v1.0.0")] });
      expect(r.index.releases.find((x) => x.version === "1.0.0")?.security).toBe(true);
      const unflagged = build({ current, releases: [gh("v1.0.0", undefined, SECURITY_NOTES)] });
      expect(unflagged.index.releases[0]?.security).toBe(false);
    });

    it("dispatch marks and clears, overriding both, and the result is carried over", () => {
      const first = build({ releases: [gh("v1.0.1", undefined, SECURITY_NOTES), gh("v1.0.0")] });
      const r = build({
        current: first.index,
        releases: [gh("v1.0.1", undefined, SECURITY_NOTES), gh("v1.0.0")],
        markSecurity: ["v1.0.0"],
        clearSecurity: ["1.0.1"],
      });
      expect(r.index.releases.map((x) => [x.version, x.security])).toEqual([
        ["1.0.1", false],
        ["1.0.0", true],
      ]);
      const next = build({
        current: r.index,
        releases: [gh("v1.0.2"), gh("v1.0.1", undefined, SECURITY_NOTES), gh("v1.0.0")],
      });
      expect(next.index.releases.map((x) => [x.version, x.security])).toEqual([
        ["1.0.2", false],
        ["1.0.1", false],
        ["1.0.0", true],
      ]);
    });

    it("refuses unknown, malformed or contradictory dispatch versions", () => {
      const releases = [gh("v1.0.0")];
      const reason = (o: Partial<Parameters<typeof buildReleaseIndex>[0]>) => {
        const r = buildReleaseIndex({ releases, ...o });
        return r.ok ? "" : r.reason;
      };
      expect(reason({ markSecurity: ["1.0.9"] })).toMatch(/1\.0\.9 is not a published release/u);
      expect(reason({ markSecurity: ["latest"] })).toMatch(/not a version/u);
      expect(reason({ markSecurity: ["1.0.0"], clearSecurity: ["v1.0.0"] })).toMatch(/both/u);
    });
  });

  it("carries summaries over", () => {
    const first = build({ releases: [gh("v1.0.0")] }).index;
    const current: ReleaseIndex = {
      ...first,
      releases: [{ ...(first.releases[0] as ReleaseIndex["releases"][number]), summary: "First" }],
    };
    expect(build({ current, releases: [gh("v1.0.0")] }).index.releases[0]?.summary).toBe("First");
  });

  it("refuses to drop a listed version unless removal is allowed", () => {
    const current = build({ releases: [gh("v1.0.1"), gh("v1.0.0")] }).index;
    const r = buildReleaseIndex({ current, releases: [gh("v1.0.0")] });
    expect(r.ok ? "" : r.reason).toMatch(/1\.0\.1, which GitHub no longer lists/u);
    const allowed = build({ current, releases: [gh("v1.0.0")], allowRemoval: true });
    expect(allowed.removed).toEqual(["1.0.1"]);
    expect(allowed.index.latest).toBe("1.0.0");
  });

  it("refuses a new release with no notes (the list was not prepared), not a listed one", () => {
    const { notes: _n, ...unprepared } = gh("v1.0.1");
    const current = build({ releases: [gh("v1.0.0")] }).index;
    const r = buildReleaseIndex({
      current,
      releases: [unprepared, { ...gh("v1.0.0"), notes: undefined }],
    });
    expect(r.ok ? "" : r.reason).toMatch(/v1\.0\.1 has no notes/u);
    expect(build({ current, releases: [{ ...gh("v1.0.0"), notes: undefined }] }).index.latest).toBe(
      "1.0.0",
    );
  });

  it("refuses nothing to publish, duplicates, bad dates and non-https URLs", () => {
    const reason = (releases: GitHubRelease[]) => {
      const r = buildReleaseIndex({ releases });
      return r.ok ? "" : r.reason;
    };
    expect(reason([])).toMatch(/no published/u);
    expect(reason([{ ...gh("v1.0.0"), draft: true }])).toMatch(/no published/u);
    expect(reason([gh("v1.0.0"), gh("v1.0.0")])).toMatch(/twice/u);
    expect(reason([gh("v1.0.0", "yesterday")])).toMatch(/not a date/u);
    expect(reason([{ ...gh("v1.0.0"), html_url: "http://example.com/r" }])).toMatch(
      /does not validate/u,
    );
  });

  it("over the bounds, drops the oldest prereleases first, never a stable release", () => {
    const stable = Array.from({ length: 10 }, (_, i) => gh(`v1.${i}.0`));
    const rcs = Array.from({ length: MAX_RELEASES }, (_, i) => gh(`v1.9.1-rc.${i}`));
    const r = build({ releases: [...rcs, ...stable] });
    expect(r.index.releases).toHaveLength(MAX_RELEASES);
    const versions = r.index.releases.map((x) => x.version);
    expect(versions).toContain("1.0.0");
    expect(versions).toContain(`1.9.1-rc.${MAX_RELEASES - 1}`);
    expect(versions).not.toContain("1.9.1-rc.0");
    expect(versions).not.toContain("1.9.1-rc.9");
    expect(versions).toContain("1.9.1-rc.10");

    const tooMany = Array.from({ length: MAX_RELEASES + 1 }, (_, i) => gh(`v1.0.${i}`));
    const refused = buildReleaseIndex({ releases: tooMany });
    expect(refused.ok ? "" : refused.reason).toMatch(/does not fit/u);
  });

  it("drops prereleases to stay under the byte cap too", () => {
    // Long URLs make few releases heavy: the byte cap binds before the count does.
    const heavy = (tag: string) => ({
      ...gh(tag),
      html_url: `https://github.com/fundroomhq/fundroom/releases/tag/${tag}?${"x".repeat(1900)}`,
    });
    const releases = [
      heavy("v1.0.0"),
      ...Array.from({ length: 200 }, (_, i) => heavy(`v1.0.1-rc.${i}`)),
    ];
    const r = build({ releases });
    expect(Buffer.byteLength(r.body, "utf8")).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    expect(r.index.releases.length).toBeLessThan(201);
    expect(r.index.latest).toBe("1.0.0");
    expect(r.index.releases.at(-1)?.version).toBe("1.0.0");
  });
});
