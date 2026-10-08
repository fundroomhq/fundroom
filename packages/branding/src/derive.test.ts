import { describe, expect, it } from "vitest";
import { contrastRatio, oklchToSrgb, parseHex, type Rgb, toHex } from "./color.js";
import {
  type BrandInput,
  brandThemeDocument,
  brandThemeTokens,
  brandTokens,
  contrastReport,
  derivePalette,
} from "./derive.js";

/*
 * The promise this package makes is not "the colours look nice" — that is a matter of taste
 * and belongs to the founder. It is that **no colour a founder can pick produces an
 * unreadable portal**, in either palette. The sweep below is that promise as a test: every
 * hue on the circle plus the achromatic ends, both palettes, both pairs, WCAG AA.
 */
const AA = 4.5;
const brandOf = (accentColor: string | null): BrandInput => ({
  accentColor,
  fontFamily: "system",
  radius: "soft",
});

/** Every hue on the circle at a chroma real brands use, plus black and white. */
function hueSweep(): string[] {
  const hexes: string[] = ["#000000", "#ffffff", "#808080"];
  for (let hue = 0; hue < 360; hue += 10) {
    hexes.push(toHex(oklchToSrgb({ l: 0.6, c: 0.15, h: hue })));
    hexes.push(toHex(oklchToSrgb({ l: 0.85, c: 0.12, h: hue })));
  }
  return hexes;
}

describe("derivePalette", () => {
  it("contributes nothing for an unset or unparseable accent", () => {
    expect(derivePalette(null, "light")).toBeNull();
    expect(derivePalette("chartreuse", "dark")).toBeNull();
    expect(brandTokens(brandOf(null), "light")).toEqual({});
  });

  it("keeps primary and ring in step: the focus ring is the brand fill", () => {
    const palette = derivePalette("#1d4ed8", "light");
    expect(palette?.ring).toBe(palette?.primary);
  });

  it("moves the same hue in opposite directions for the two palettes", () => {
    const light = derivePalette("#1d4ed8", "light");
    const dark = derivePalette("#1d4ed8", "dark");
    // Not an assertion about which is lighter — only that the two palettes are not the same
    // value reused, which is the bug this derivation exists to prevent.
    expect(light?.surface).not.toBe(dark?.surface);
  });
});

describe("contrastReport", () => {
  it("reports nothing at all when no accent is set", () => {
    expect(contrastReport(brandOf(null))).toEqual([]);
  });

  it("passes AA on both pairs, in both palettes, for a sweep of hues", () => {
    const failures: string[] = [];
    for (const hex of hueSweep()) {
      for (const finding of contrastReport(brandOf(hex))) {
        if (!finding.passes) {
          failures.push(`${hex} ${finding.mode} ${finding.pair} = ${finding.ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("measures what it claims to measure", () => {
    for (const mode of ["light", "dark"] as const) {
      const palette = derivePalette("#1d4ed8", mode);
      const finding = contrastReport(brandOf("#1d4ed8")).find(
        (f) => f.mode === mode && f.pair === "label on primary",
      );
      const primary = parseHex(palette?.primary ?? "") as Rgb;
      const label = parseHex(palette?.primaryFg ?? "") as Rgb;
      expect(finding?.ratio).toBeCloseTo(contrastRatio(label, primary), 6);
      expect(finding?.required).toBe(AA);
    }
  });
});

describe("brandTokens", () => {
  it("emits only the allow-listed names", () => {
    const tokens = brandTokens(
      { accentColor: "#1d4ed8", fontFamily: "serif", radius: "sharp" },
      "light",
    );
    for (const name of Object.keys(tokens)) expect(name.startsWith("--sh-")).toBe(true);
    expect(tokens["--sh-font-sans"]).toBeDefined();
    expect(tokens["--sh-radius-base"]).toBeDefined();
  });

  it("omits the font and radius tokens when the choice is the stylesheet default", () => {
    const tokens = brandTokens(brandOf("#1d4ed8"), "light");
    expect(tokens["--sh-font-sans"]).toBeUndefined();
    expect(tokens["--sh-radius-base"]).toBeUndefined();
  });

  it("gives both palettes at once", () => {
    const both = brandThemeTokens(brandOf("#1d4ed8"));
    expect(Object.keys(both.light).length).toBeGreaterThan(0);
    expect(both.light["--sh-color-primary"]).not.toBe(both.dark["--sh-color-primary"]);
  });
});

describe("brandThemeDocument", () => {
  it("carries only the overrides, as a DTCG document", () => {
    const doc = brandThemeDocument({
      accentColor: "#1d4ed8",
      fontFamily: "mono",
      radius: "round",
    });
    expect(doc["$schema"]).toBe("https://tr.designtokens.org/format/");
    const colour = doc["color"] as Record<string, Record<string, { $value: string }>>;
    expect(colour["light"]?.["primary"]?.$value).toMatch(/^#[0-9a-f]{6}$/u);
    expect(doc["font"]).toBeDefined();
    expect(doc["radius"]).toBeDefined();
  });

  it("omits every group the workspace has not overridden", () => {
    const doc = brandThemeDocument(brandOf(null));
    expect(doc["color"]).toBeUndefined();
    expect(doc["font"]).toBeUndefined();
    expect(doc["radius"]).toBeUndefined();
  });
});
