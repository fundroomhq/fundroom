import type { ChartPalette } from "@fundroom/charts";
import { useTheme } from "@fundroomhq/ui";
import { useMemo } from "react";

/*
 * Chart colours for the SVG interpreter (E2.4 §7).
 *
 * `layoutChart` holds no palette on purpose — the caller resolves theme tokens to `#rrggbb`
 * and the geometry is the same whether it ends up in the browser or in an emailed PNG. So
 * this file is where the design system meets the chart, and the rule is: colours come from
 * `packages/tokens/tokens.css` (`@fundroomhq/tokens`), never from a hex typed into a component.
 *
 * Resolving, not referencing, is forced by the contract: an op carries a colour *string*, so
 * `var(--sh-color-chart-1)` cannot travel in one. `getComputedStyle` turns the custom
 * property into the literal the token holds. It answers `""` whenever the stylesheet is not
 * there — jsdom (the `web` vitest project sets `css: false`), a server-rendered first paint,
 * an embed whose host sheet has not applied yet — so every token has a fallback below. Those
 * fallbacks are a *transcription* of tokens.css for the two themes, not a second palette;
 * when a token moves, move it here too.
 *
 * ── The thing the tests cannot tell you ──────────────────────────────────────────────────
 * jsdom computes no colours, so axe's `color-contrast` rule is disabled in
 * `src/test/a11y.ts` and **no automated check in this repo can see a low-contrast chart**.
 * E2.1 shipped a real contrast failure that every test passed. The five series colours are
 * `--sh-color-chart-1…5` precisely because those five are the tokens the design system has
 * already contrast-checked against the page in both themes; the axis, grid and label colours
 * are the same `--sh-color-fg` / `--sh-color-muted-fg` / `--sh-color-border` the rest of the
 * UI uses. Substituting a colour that has not been through that check is a change no test
 * here will refuse — take it to a real browser.
 */

/** Custom properties this module reads, and the value tokens.css gives each per theme. */
const FALLBACK = {
  light: {
    "--sh-color-fg": "#0f172a",
    "--sh-color-muted-fg": "#475569",
    "--sh-color-border": "#e2e8f0",
    "--sh-color-card": "#ffffff",
    "--sh-color-chart-1": "#2563eb",
    "--sh-color-chart-2": "#0d9488",
    "--sh-color-chart-3": "#d97706",
    "--sh-color-chart-4": "#7c3aed",
    "--sh-color-chart-5": "#db2777",
  },
  dark: {
    "--sh-color-fg": "#e2e8f0",
    "--sh-color-muted-fg": "#a3b1c6",
    "--sh-color-border": "#1f2937",
    "--sh-color-card": "#111827",
    "--sh-color-chart-1": "#60a5fa",
    "--sh-color-chart-2": "#2dd4bf",
    "--sh-color-chart-3": "#fbbf24",
    "--sh-color-chart-4": "#a78bfa",
    "--sh-color-chart-5": "#f472b6",
  },
} as const satisfies Record<"light" | "dark", Record<string, string>>;

type TokenName = keyof (typeof FALLBACK)["light"];

export interface ChartTheme {
  readonly palette: ChartPalette;
  /** Series colours in order; the caller cycles them. Five distinct, contrast-checked hues. */
  readonly series: readonly string[];
  /** The delta colours a KPI tile paints "better" and "worse" with. */
  readonly good: string;
  readonly bad: string;
}

function readToken(
  name: TokenName,
  theme: "light" | "dark",
  computed: CSSStyleDeclaration | undefined,
): string {
  const raw = computed?.getPropertyValue(name).trim() ?? "";
  return raw === "" ? FALLBACK[theme][name] : raw;
}

/**
 * Resolves the chart tokens against `root` (the element the theme class sits on). Exported
 * for tests and for the non-React callers; components should use {@link useChartPalette}.
 */
export function resolveChartTheme(theme: "light" | "dark", root?: Element | null): ChartTheme {
  let computed: CSSStyleDeclaration | undefined;
  try {
    const element =
      root ?? (typeof document === "undefined" ? undefined : document.documentElement);
    computed = element ? getComputedStyle(element) : undefined;
  } catch {
    // A detached document or a sandbox without a view: the fallbacks are the answer.
    computed = undefined;
  }
  const token = (name: TokenName): string => readToken(name, theme, computed);
  return {
    palette: {
      axis: token("--sh-color-muted-fg"),
      grid: token("--sh-color-border"),
      text: token("--sh-color-fg"),
      muted: token("--sh-color-muted-fg"),
      background: token("--sh-color-card"),
    },
    series: [
      token("--sh-color-chart-1"),
      token("--sh-color-chart-2"),
      token("--sh-color-chart-3"),
      token("--sh-color-chart-4"),
      token("--sh-color-chart-5"),
    ],
    // `success` / `destructive` are the semantic pair, and a delta badge is exactly the
    // semantics they exist for. Colour is never the only carrier: the badge also says
    // "better" or "worse" in words (see `metric-tile.tsx`).
    good: theme === "dark" ? "#4ade80" : "#15803d",
    bad: theme === "dark" ? "#f87171" : "#b91c1c",
  };
}

export function useChartPalette(): ChartTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(() => resolveChartTheme(resolvedTheme), [resolvedTheme]);
}
