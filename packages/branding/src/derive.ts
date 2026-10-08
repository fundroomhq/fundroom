/**
 * Derives the `--sh-*` overrides a workspace's brand implies, one palette at a time.
 *
 * The workspace stores ONE colour. Everything else — the button foreground, the tinted
 * surface, the focus ring, the dark-palette variant — is computed here so that a brand can
 * never produce an unreadable portal: each derived pair is pushed to a WCAG AA ratio before
 * it is emitted, rather than being stored by an admin who checked it against one background
 * on one monitor. It also means the default token set can change without stranding stored
 * themes, because nothing per-workspace is frozen except the colour itself.
 *
 * Only the names below are emitted. Everything else keeps the stylesheet default, so a
 * workspace cannot set the foreground to the background, and a token added to the design
 * system later needs no migration of stored brands.
 */

import {
  adjustForContrast,
  bestContrast,
  contrastRatio,
  oklchToSrgb,
  parseHex,
  type Rgb,
  srgbToOklch,
  toHex,
  WHITE,
  withLightness,
} from "./color.js";
import {
  BRAND_FONT_STACKS,
  BRAND_RADIUS_VALUES,
  type BrandFontName,
  type BrandRadiusName,
} from "./fonts.js";

export type BrandMode = "light" | "dark";

/**
 * Structural view of the `branding` settings block (`@fundroom/domain`). Declared
 * structurally rather than imported so this package stays dependency-free and can be used
 * from the browser bundle without pulling zod in.
 */
export interface BrandInput {
  readonly accentColor: string | null;
  readonly fontFamily: BrandFontName;
  readonly radius: BrandRadiusName;
}

/** The stylesheet's own palette anchors; derived colours are measured against these. */
const GROUND: Record<BrandMode, { bg: Rgb; ink: Rgb }> = {
  light: { bg: { r: 1, g: 1, b: 1 }, ink: parseHex("#0f172a") as Rgb },
  dark: { bg: parseHex("#0b1120") as Rgb, ink: parseHex("#e2e8f0") as Rgb },
};

/** sRGB as it will actually be written: `derivePalette` emits hex, so 8 bits per channel. */
const quantise = (rgb: Rgb): Rgb => parseHex(toHex(rgb)) as Rgb;

/** Text and icons on a coloured fill: AA for normal text. */
const AA_TEXT = 4.5;

export const DEFAULT_ACCENT_HEX = "#1d4ed8";

/**
 * Finds a lightness for the brand hue where the fill reads against the page AND a label
 * reads against the fill. Scored on the weaker of the two ratios, so the result is the
 * lightness that makes the worse pair as good as it can be rather than one that wins on an
 * average while leaving button text illegible. Walks from the brand's own lightness outwards
 * so an already-compliant colour is returned untouched.
 */
function solveFill(
  accent: Rgb,
  background: Rgb,
  direction: "darken" | "lighten",
): { fill: Rgb; label: Rgb } {
  const labels = [WHITE, GROUND.light.ink] as const;
  const base = srgbToOklch(accent);
  const step = direction === "darken" ? -0.02 : 0.02;
  let best: { fill: Rgb; label: Rgb; score: number } | null = null;
  for (let i = 0; i <= 50; i += 1) {
    const lightness = base.l + step * i;
    // The brand colour itself is always scored (i === 0), even when it sits at the very top
    // or bottom of the lightness range: pure black and pure white land exactly on 0 and 1,
    // and skipping them here would return them unadjusted and unreadable.
    if (i > 0 && (lightness <= 0 || lightness >= 1)) break;
    // Scored on the QUANTISED colour, because that is what ships: `derivePalette` returns
    // hex, and an 8-bit round trip moves a ratio by a hair. Scoring the unrounded value let
    // a hue land on 4.4999 after quantisation while the solver believed it had cleared AA,
    // and `contrastReport` — which reads the hex back — then said it failed. The report and
    // the derivation now measure the same bytes.
    const fill = quantise(i === 0 ? accent : oklchToSrgb({ ...base, l: lightness }));
    const label = bestContrast(fill, labels);
    const score = Math.min(contrastRatio(fill, background), contrastRatio(label, fill));
    if (score >= AA_TEXT) return { fill, label };
    if (best === null || score > best.score) best = { fill, label, score };
  }
  return best === null
    ? { fill: accent, label: bestContrast(accent, labels) }
    : { fill: best.fill, label: best.label };
}

export interface DerivedPalette {
  readonly primary: string;
  readonly primaryFg: string;
  readonly ring: string;
  readonly surface: string;
  readonly surfaceFg: string;
  readonly sidebarAccent: string;
  readonly sidebarAccentFg: string;
}

/** The colour half of the derivation, exposed on its own so the admin form can report on it. */
export function derivePalette(accentHex: string | null, mode: BrandMode): DerivedPalette | null {
  const accent = parseHex(accentHex ?? "");
  if (accent === null) return null;
  const { bg, ink } = GROUND[mode];

  // A brand colour legible on white is usually too dark on near-black, so each palette
  // moves the same hue in its own direction rather than reusing one value in both. The fill
  // and its label are solved TOGETHER: pushing the fill just far enough to clear the page
  // background lands mid-tone hues (red, violet) where neither white nor ink reads on top,
  // so both constraints are satisfied at once or the best compromise is kept.
  const { fill: primary, label: primaryFg } = solveFill(
    accent,
    bg,
    mode === "light" ? "darken" : "lighten",
  );

  // The tinted surface (`accent` in the token vocabulary) is the same hue at a fixed
  // lightness, so hovers and selected rows stay recognisably the brand without competing
  // with the primary fill.
  const surface = withLightness(accent, mode === "light" ? 0.94 : 0.3);
  const surfaceFg =
    mode === "light"
      ? adjustForContrast(accent, surface, AA_TEXT, "darken")
      : adjustForContrast(accent, surface, AA_TEXT, "lighten");
  const sidebarAccent = withLightness(accent, mode === "light" ? 0.92 : 0.26);
  const sidebarAccentFg = bestContrast(sidebarAccent, [ink, GROUND.light.ink, WHITE]);

  return {
    primary: toHex(primary),
    primaryFg: toHex(primaryFg),
    ring: toHex(primary),
    surface: toHex(surface),
    surfaceFg: toHex(surfaceFg),
    sidebarAccent: toHex(sidebarAccent),
    sidebarAccentFg: toHex(sidebarAccentFg),
  };
}

/**
 * The `--sh-*` overrides for one palette. An unset or unparseable accent contributes no
 * colour tokens at all (the stylesheet default shows through) rather than a fallback blue,
 * so "no brand chosen" and "brand chosen that happens to match the default" stay distinct.
 */
export function brandTokens(brand: BrandInput, mode: BrandMode): Record<string, string> {
  const tokens: Record<string, string> = {};
  const palette = derivePalette(brand.accentColor, mode);
  if (palette !== null) {
    tokens["--sh-color-primary"] = palette.primary;
    tokens["--sh-color-primary-fg"] = palette.primaryFg;
    tokens["--sh-color-ring"] = palette.ring;
    tokens["--sh-color-accent"] = palette.surface;
    tokens["--sh-color-accent-fg"] = palette.surfaceFg;
    tokens["--sh-color-sidebar-accent"] = palette.sidebarAccent;
    tokens["--sh-color-sidebar-accent-fg"] = palette.sidebarAccentFg;
    tokens["--sh-color-chart-1"] = palette.primary;
  }
  const stack = BRAND_FONT_STACKS[brand.fontFamily];
  if (stack !== undefined && brand.fontFamily !== "system") tokens["--sh-font-sans"] = stack;
  const radius = BRAND_RADIUS_VALUES[brand.radius];
  if (radius !== undefined && brand.radius !== "soft") tokens["--sh-radius-base"] = radius;
  return tokens;
}

export interface BrandThemeTokens {
  readonly light: Record<string, string>;
  readonly dark: Record<string, string>;
}

/** Both palettes at once — what the SPA needs to theme before first paint. */
export function brandThemeTokens(brand: BrandInput): BrandThemeTokens {
  return { light: brandTokens(brand, "light"), dark: brandTokens(brand, "dark") };
}

/**
 * The same derivation as a W3C Design Tokens document (design/08 §4). This is the "theme
 * JSON" the plan asks for and the shape E2.2 will serve at `/embed/<ws>/theme.json`; it
 * carries only the overridden names, so a consumer merges it over the defaults.
 */
export function brandThemeDocument(brand: BrandInput): Record<string, unknown> {
  const light = derivePalette(brand.accentColor, "light");
  const dark = derivePalette(brand.accentColor, "dark");
  const colourGroup = (palette: DerivedPalette): Record<string, unknown> => ({
    primary: { $value: palette.primary },
    "primary-fg": { $value: palette.primaryFg },
    ring: { $value: palette.ring },
    accent: { $value: palette.surface },
    "accent-fg": { $value: palette.surfaceFg },
    "sidebar-accent": { $value: palette.sidebarAccent },
    "sidebar-accent-fg": { $value: palette.sidebarAccentFg },
    "chart-1": { $value: palette.primary },
  });
  const doc: Record<string, unknown> = {
    $schema: "https://tr.designtokens.org/format/",
    $description: "Workspace brand overrides; merge over the FundRoom default theme.",
  };
  if (light !== null && dark !== null) {
    doc["color"] = { $type: "color", light: colourGroup(light), dark: colourGroup(dark) };
  }
  if (brand.fontFamily !== "system") {
    doc["font"] = {
      $type: "fontFamily",
      sans: { $value: BRAND_FONT_STACKS[brand.fontFamily].split(", ") },
    };
  }
  if (brand.radius !== "soft") {
    const rem = Number.parseFloat(BRAND_RADIUS_VALUES[brand.radius]);
    doc["radius"] = { $type: "dimension", base: { $value: { value: rem, unit: "rem" } } };
  }
  return doc;
}

export interface ContrastFinding {
  /** Token pair this measures, e.g. `primary on background`. */
  readonly pair: string;
  readonly mode: BrandMode;
  readonly ratio: number;
  readonly required: number;
  readonly passes: boolean;
}

/**
 * What the branding form shows next to the colour picker. A brand colour is never refused —
 * the derivation already pushes each pair as far as the hue allows — but a colour whose hue
 * simply cannot reach AA against both grounds (a mid-tone yellow, typically) should say so
 * rather than quietly producing something the founder will not notice is illegible.
 */
export function contrastReport(brand: BrandInput): readonly ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  for (const mode of ["light", "dark"] as const) {
    const palette = derivePalette(brand.accentColor, mode);
    if (palette === null) continue;
    const primary = parseHex(palette.primary) as Rgb;
    const primaryFg = parseHex(palette.primaryFg) as Rgb;
    findings.push({
      pair: "primary on background",
      mode,
      ratio: contrastRatio(primary, GROUND[mode].bg),
      required: AA_TEXT,
      passes: contrastRatio(primary, GROUND[mode].bg) >= AA_TEXT,
    });
    findings.push({
      pair: "label on primary",
      mode,
      ratio: contrastRatio(primaryFg, primary),
      required: AA_TEXT,
      passes: contrastRatio(primaryFg, primary) >= AA_TEXT,
    });
  }
  return findings;
}
