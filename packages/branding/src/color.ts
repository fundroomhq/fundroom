/**
 * The colour maths behind derived brand tokens. sRGB hex in, sRGB hex out, with OKLCH as the
 * working space: adjusting a brand colour for the dark palette by scaling lightness in OKLCH
 * keeps its hue, where the same move in HSL visibly shifts blues towards purple and makes
 * yellows muddy. Contrast is WCAG 2.2 relative luminance, which is what the AA thresholds the
 * design system targets are defined against.
 *
 * No dependencies and no I/O: both the server (email, SSR token injection) and the browser
 * (live preview in the branding form) run exactly this code.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  /** Hue in degrees, 0–360. Undefined hue (achromatic) is carried as 0 with `c === 0`. */
  readonly h: number;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/** Parses `#abc` or `#aabbcc` into 0–1 channels; null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim();
  if (!HEX_RE.test(value)) return null;
  const body = value.slice(1);
  const full =
    body.length === 3
      ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
      : body.toLowerCase();
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const channelHex = (n: number): string =>
  Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, "0");

/** Always six lowercase digits, so stored values and derived values compare equal. */
export function toHex(rgb: Rgb): string {
  return `#${channelHex(rgb.r)}${channelHex(rgb.g)}${channelHex(rgb.b)}`;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const fromLinear = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

/** WCAG 2.2 relative luminance (sRGB). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 2.2 contrast ratio, 1–21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = la > lb ? la : lb;
  const darker = la > lb ? lb : la;
  return (lighter + 0.05) / (darker + 0.05);
}

export function srgbToOklch(rgb: Rgb): Oklch {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(okA * okA + okB * okB);
  const h = c < 1e-7 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360;
  return { l: okL, c, h };
}

function oklchToLinear(colour: Oklch): { r: number; g: number; b: number } {
  const hRad = (colour.h * Math.PI) / 180;
  const a = colour.c * Math.cos(hRad);
  const bb = colour.c * Math.sin(hRad);
  const l = (colour.l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (colour.l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (colour.l - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const inGamut = (c: { r: number; g: number; b: number }): boolean =>
  c.r >= -1e-4 &&
  c.r <= 1 + 1e-4 &&
  c.g >= -1e-4 &&
  c.g <= 1 + 1e-4 &&
  c.b >= -1e-4 &&
  c.b <= 1 + 1e-4;

/**
 * OKLCH back to sRGB. A lightened or darkened brand colour often lands outside the sRGB
 * gamut; rather than clipping the channels (which shifts the hue towards a primary and can
 * flatten two different brand colours onto the same value) chroma is reduced by bisection
 * until the colour fits, which is the standard CSS Color 4 gamut-mapping move.
 */
export function oklchToSrgb(colour: Oklch): Rgb {
  const direct = oklchToLinear(colour);
  if (inGamut(direct)) {
    return {
      r: clamp01(fromLinear(direct.r)),
      g: clamp01(fromLinear(direct.g)),
      b: clamp01(fromLinear(direct.b)),
    };
  }
  let low = 0;
  let high = colour.c;
  let best = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    const candidate = oklchToLinear({ ...colour, c: mid });
    if (inGamut(candidate)) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }
  return {
    r: clamp01(fromLinear(best.r)),
    g: clamp01(fromLinear(best.g)),
    b: clamp01(fromLinear(best.b)),
  };
}

/** Same hue and chroma, new OKLCH lightness (0–1). */
export function withLightness(rgb: Rgb, lightness: number): Rgb {
  const base = srgbToOklch(rgb);
  return oklchToSrgb({ ...base, l: clamp01(lightness) });
}

export const WHITE: Rgb = { r: 1, g: 1, b: 1 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Whichever of the candidates contrasts best with `background`; ties keep the first. */
export function bestContrast(background: Rgb, candidates: readonly Rgb[]): Rgb {
  let winner = candidates[0] ?? WHITE;
  let best = contrastRatio(background, winner);
  for (const candidate of candidates.slice(1)) {
    const ratio = contrastRatio(background, candidate);
    if (ratio > best) {
      best = ratio;
      winner = candidate;
    }
  }
  return winner;
}

/**
 * Walks OKLCH lightness towards `direction` until the colour clears `target` contrast against
 * `against`, keeping hue. Returns the closest it got if the target is unreachable — a brand
 * colour is never rejected outright for being hard to read, it is adjusted as far as it goes
 * and the admin form warns separately.
 */
export function adjustForContrast(
  colour: Rgb,
  against: Rgb,
  target: number,
  direction: "darken" | "lighten",
): Rgb {
  if (contrastRatio(colour, against) >= target) return colour;
  const base = srgbToOklch(colour);
  const step = direction === "darken" ? -0.02 : 0.02;
  let bestColour = colour;
  let bestRatio = contrastRatio(colour, against);
  for (let i = 1; i <= 50; i += 1) {
    const lightness = base.l + step * i;
    if (lightness <= 0 || lightness >= 1) break;
    const candidate = oklchToSrgb({ ...base, l: lightness });
    const ratio = contrastRatio(candidate, against);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestColour = candidate;
    }
    if (ratio >= target) return candidate;
  }
  return bestColour;
}
