import { describe, expect, it } from "vitest";
import { compareVersions, isSemVer, parseSemVer } from "./semver.js";

describe("parseSemVer", () => {
  it("accepts strict x.y.z and x.y.z-pre", () => {
    expect(parseSemVer("1.4.2")).toEqual({ major: 1, minor: 4, patch: 2, prerelease: [] });
    expect(parseSemVer("2.0.0-rc.1")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ["rc", 1],
    });
    expect(isSemVer("0.0.0")).toBe(true);
    expect(isSemVer("1.0.0-alpha-beta.0x1")).toBe(true);
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "1",
      "1.2",
      "v1.2.3",
      "1.2.3.4",
      "01.2.3",
      "1.02.3",
      "1.2.3-",
      "1.2.3-01",
      "1.2.3+build.5",
      " 1.2.3",
      "1.2.3 ",
      "1.2.3-rc..1",
      "99999999999999999.0.0",
      `1.2.3-${"a".repeat(64)}`,
    ]) {
      expect(parseSemVer(bad), bad).toBeUndefined();
    }
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("1.4.2", "1.4.2")).toBe(0);
  });

  it("follows SemVer §11 for prereleases", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i] as string;
      const b = ordered[i + 1] as string;
      expect(compareVersions(a, b), `${a} < ${b}`).toBe(-1);
      expect(compareVersions(b, a), `${b} > ${a}`).toBe(1);
    }
  });

  it("throws on an invalid version", () => {
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(RangeError);
  });
});
