/**
 * `@fundroom/branding` — the pure half of E1.7.
 *
 * A workspace stores a very small brand (one colour, a font choice, a corner radius, a
 * logo). Everything the portal and the emails actually render is derived from it here, with
 * no I/O and no dependencies, so the server (SSR token injection, email rendering, the
 * theme document) and the browser (live preview in the branding form) cannot disagree about
 * what a brand looks like.
 */

export {
  adjustForContrast,
  BLACK,
  bestContrast,
  contrastRatio,
  type Oklch,
  oklchToSrgb,
  parseHex,
  type Rgb,
  relativeLuminance,
  srgbToOklch,
  toHex,
  WHITE,
  withLightness,
} from "./color.js";
export {
  type BrandInput,
  type BrandMode,
  type BrandThemeTokens,
  brandThemeDocument,
  brandThemeTokens,
  brandTokens,
  type ContrastFinding,
  contrastReport,
  DEFAULT_ACCENT_HEX,
  type DerivedPalette,
  derivePalette,
} from "./derive.js";
export {
  BRAND_FONT_STACKS,
  BRAND_RADIUS_VALUES,
  type BrandFontName,
  type BrandRadiusName,
} from "./fonts.js";
export {
  checkLogo,
  type ImageInfo,
  LOGO_MAX_BYTES,
  LOGO_MAX_PIXELS,
  LOGO_MIN_PIXELS,
  type LogoCheck,
  type LogoContentType,
  type LogoRejection,
  logoCandidates,
  sniffImage,
} from "./image.js";
