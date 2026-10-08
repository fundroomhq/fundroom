import { LegalSettingsSchema } from "@fundroom/domain";
import { describe, expect, it } from "vitest";
import {
  applyLegalSettingsPatch,
  type ConsentMode,
  consentModeRank,
  consentModeWeakerThanRegion,
  erasureDueAt,
  erasureWindowDays,
  type PrivacyRegion,
  regionConsentDefault,
} from "./region.js";

/*
 * Decisions 4 and 5 of E2.6, enumerated. Every region (and "not said") × every mode, written out
 * by hand and compared, because the failure mode is a tenant tracking people under the wrong
 * regime without anybody noticing.
 */

const REGIONS = ["eu", "uk", "us", "other", null] as const;
const MODES = ["opt_in", "opt_out", "notice_only"] as const;

describe("regionConsentDefault", () => {
  it.each([
    ["eu", "opt_in"],
    ["uk", "opt_out"],
    ["us", "notice_only"],
    ["other", "opt_in"],
    [null, "opt_in"],
    [undefined, "opt_in"],
  ] as const)("%s → %s", (region, mode) => {
    expect(regionConsentDefault(region)).toBe(mode);
  });
});

describe("consentModeRank", () => {
  it("orders opt_in > opt_out > notice_only, strictly", () => {
    expect(consentModeRank("opt_in")).toBeGreaterThan(consentModeRank("opt_out"));
    expect(consentModeRank("opt_out")).toBeGreaterThan(consentModeRank("notice_only"));
    expect(new Set(MODES.map(consentModeRank)).size).toBe(MODES.length);
  });
});

describe("consentModeWeakerThanRegion", () => {
  const EXPECTED: Readonly<Record<string, boolean>> = {
    "opt_in|eu": false,
    "opt_out|eu": true,
    "notice_only|eu": true,
    "opt_in|uk": false,
    "opt_out|uk": false,
    "notice_only|uk": true,
    "opt_in|us": false,
    "opt_out|us": false,
    "notice_only|us": false,
    "opt_in|other": false,
    "opt_out|other": true,
    "notice_only|other": true,
    "opt_in|null": false,
    "opt_out|null": true,
    "notice_only|null": true,
  };
  for (const mode of MODES) {
    for (const region of REGIONS) {
      const key = `${mode}|${region}`;
      it(key, () => {
        expect(consentModeWeakerThanRegion(mode, region)).toBe(EXPECTED[key]);
      });
    }
  }
  it("the table covers every combination", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(MODES.length * REGIONS.length);
  });
});

describe("erasureDueAt", () => {
  const at = new Date("2026-01-31T12:00:00.000Z");
  it.each([
    ["eu", 30, "2026-03-02T12:00:00.000Z"],
    ["uk", 30, "2026-03-02T12:00:00.000Z"],
    ["other", 30, "2026-03-02T12:00:00.000Z"],
    [null, 30, "2026-03-02T12:00:00.000Z"],
    ["us", 45, "2026-03-17T12:00:00.000Z"],
  ] as const)("%s: +%i days", (region, days, due) => {
    expect(erasureWindowDays(region)).toBe(days);
    expect(erasureDueAt(region, at).toISOString()).toBe(due);
  });

  it("does not mutate its input", () => {
    const input = new Date(at);
    erasureDueAt("us", input);
    expect(input.getTime()).toBe(at.getTime());
  });
});

describe("applyLegalSettingsPatch", () => {
  const base = (over: Partial<{ consentMode: ConsentMode; privacyRegion: PrivacyRegion | null }>) =>
    LegalSettingsSchema.parse(over);

  it("a region with no mode applies the region's suggestion", () => {
    for (const region of REGIONS) {
      const r = applyLegalSettingsPatch(base({ consentMode: "notice_only", privacyRegion: "us" }), {
        privacyRegion: region,
      });
      expect(r.next.privacyRegion).toBe(region);
      expect(r.next.consentMode).toBe(regionConsentDefault(region));
      expect(r.consentModeWeakerThanRegion).toBe(false);
      expect(r.consentModeSource).toBe(region === "us" ? "unchanged" : "region_default");
    }
  });

  it("a region and a mode together keep the admin's mode and warn when it is weaker", () => {
    for (const region of REGIONS) {
      for (const mode of MODES) {
        const r = applyLegalSettingsPatch(base({}), { privacyRegion: region, consentMode: mode });
        expect(r.next.consentMode).toBe(mode);
        expect(r.consentModeSource).toBe("admin");
        expect(r.suggestedConsentMode).toBe(regionConsentDefault(region));
        expect(r.consentModeWeakerThanRegion).toBe(consentModeWeakerThanRegion(mode, region));
      }
    }
  });

  it("re-sending the unchanged region never resets a mode the admin chose", () => {
    const current = base({ privacyRegion: "eu", consentMode: "opt_out" });
    const r = applyLegalSettingsPatch(current, { privacyRegion: "eu", legalHold: true });
    expect(r.next.consentMode).toBe("opt_out");
    expect(r.next.legalHold).toBe(true);
    expect(r.consentModeSource).toBe("unchanged");
    expect(r.consentModeWeakerThanRegion).toBe(true);
  });

  it("a patch without a region leaves the mode alone", () => {
    const current = base({ privacyRegion: "eu", consentMode: "opt_in" });
    const r = applyLegalSettingsPatch(current, { enforceAcceptance: false });
    expect(r.next.consentMode).toBe("opt_in");
    expect(r.next.enforceAcceptance).toBe(false);
    expect(r.consentModeSource).toBe("unchanged");
  });

  it("an explicit undefined is not a change", () => {
    const current = base({ privacyRegion: "uk", consentMode: "opt_out" });
    const r = applyLegalSettingsPatch(current, { privacyRegion: undefined });
    expect(r.next.privacyRegion).toBe("uk");
    expect(r.consentModeSource).toBe("unchanged");
  });

  it("clearing the region (null) falls back to the strict default", () => {
    const current = base({ privacyRegion: "us", consentMode: "notice_only" });
    const r = applyLegalSettingsPatch(current, { privacyRegion: null });
    expect(r.next.privacyRegion).toBeNull();
    expect(r.next.consentMode).toBe("opt_in");
    expect(r.consentModeSource).toBe("region_default");
  });

  it("does not mutate the current settings", () => {
    const current = base({ privacyRegion: "eu", consentMode: "opt_in" });
    const copy = structuredClone(current);
    applyLegalSettingsPatch(current, { privacyRegion: "us" });
    expect(current).toEqual(copy);
  });
});
