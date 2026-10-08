import { describe, expect, it } from "vitest";
import {
  adjustForContrast,
  BLACK,
  bestContrast,
  contrastRatio,
  oklchToSrgb,
  parseHex,
  relativeLuminance,
  srgbToOklch,
  toHex,
  WHITE,
  withLightness,
} from "./color.js";

/*
 * The colour maths under the whole epic. Nothing here is about the brand vocabulary — it is
 * about the two properties everything else leans on: a colour survives the round trip through
 * OKLCH unchanged, and `contrastRatio` agrees with the WCAG definition on the pairs whose
 * answers are published (black on white is exactly 21:1, a colour on itself is exactly 1:1).
 */
describe("parseHex / toHex", () => {
  it("round-trips every channel of a hex colour", () => {
    for (const hex of ["#000000", "#ffffff", "#1d4ed8", "#ff0080", "#123456", "#fedcba"]) {
      expect(toHex(parseHex(hex) as never)).toBe(hex);
    }
  });

  it("accepts the shorthand and upper case, and normalises both", () => {
    expect(toHex(parseHex("#FFF") as never)).toBe("#ffffff");
    expect(toHex(parseHex("  #1D4ED8  ") as never)).toBe("#1d4ed8");
  });

  it("refuses anything that is not a colour", () => {
    for (const bad of ["", "red", "#12345", "#gggggg", "1d4ed8", "#1d4ed8ff "]) {
      expect(parseHex(bad)).toBeNull();
    }
  });
});

describe("srgbToOklch / oklchToSrgb", () => {
  it("round-trips a sweep of hues to the same hex", () => {
    for (let hue = 0; hue < 360; hue += 15) {
      // A mid lightness and a chroma every hue can actually carry, so the round trip is not
      // testing the gamut clamp instead of the conversion.
      const rgb = oklchToSrgb({ l: 0.55, c: 0.1, h: hue });
      const back = oklchToSrgb(srgbToOklch(rgb));
      expect(toHex(back)).toBe(toHex(rgb));
    }
  });

  it("round-trips the achromatic ends", () => {
    for (const hex of ["#000000", "#808080", "#ffffff"]) {
      const rgb = parseHex(hex) as never;
      expect(toHex(oklchToSrgb(srgbToOklch(rgb)))).toBe(hex);
    }
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
  });

  it("matches the published luminance of the sRGB primaries", () => {
    expect(relativeLuminance(parseHex("#ff0000") as never)).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance(parseHex("#00ff00") as never)).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance(parseHex("#0000ff") as never)).toBeCloseTo(0.0722, 4);
  });
});

describe("bestContrast / adjustForContrast / withLightness", () => {
  it("picks the candidate that reads best on the ground", () => {
    expect(toHex(bestContrast(WHITE, [WHITE, BLACK]))).toBe("#000000");
    expect(toHex(bestContrast(BLACK, [WHITE, BLACK]))).toBe("#ffffff");
  });

  it("pushes a colour until it clears the target ratio", () => {
    const ground = parseHex("#ffffff") as never;
    // A yellow nobody can read on white, darkened until it can be read.
    const fixed = adjustForContrast(parseHex("#ffee00") as never, ground, 4.5, "darken");
    expect(contrastRatio(fixed, ground)).toBeGreaterThanOrEqual(4.5);
  });

  it("moves lightness without losing the hue", () => {
    const base = parseHex("#1d4ed8") as never;
    const lighter = withLightness(base, 0.9);
    expect(srgbToOklch(lighter).l).toBeCloseTo(0.9, 2);
    expect(srgbToOklch(lighter).h).toBeCloseTo(srgbToOklch(base).h, 0);
  });
});
