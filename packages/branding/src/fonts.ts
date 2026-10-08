/**
 * Bundled font stacks. A workspace picks one of these, it does not upload or link a font:
 * the app CSP allows no external font origin (design/08 §4 notes fonts only work in embed
 * mode when the host serves them), and self-hosting a customer's licensed webfont needs an
 * upload pipeline plus a licence story that E1.7 does not own. Every stack is composed of
 * fonts already present on mainstream desktop and mobile systems, so nothing is downloaded
 * and there is no flash of unstyled text.
 */

export const BRAND_FONT_STACKS = {
  system:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  humanist:
    '"Optima", "Segoe UI", "Gill Sans", "Gill Sans MT", Candara, "Trebuchet MS", ui-sans-serif, sans-serif',
  geometric:
    '"Futura", "Avenir Next", Avenir, "Century Gothic", "Questrial", ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  slab: '"Rockwell", "Roboto Slab", "Bookman Old Style", ui-serif, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const satisfies Record<string, string>;

export type BrandFontName = keyof typeof BRAND_FONT_STACKS;

/** Corner rounding, as the `--sh-radius-base` dimension the components read. */
export const BRAND_RADIUS_VALUES = {
  sharp: "0rem",
  soft: "0.5rem",
  round: "0.875rem",
} as const satisfies Record<string, string>;

export type BrandRadiusName = keyof typeof BRAND_RADIUS_VALUES;
