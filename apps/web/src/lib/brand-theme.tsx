import { useTheme } from "@fundroomhq/ui";
import { applyThemeTokens } from "@fundroomhq/ui/theme";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useWebConfig } from "./config-context.js";

/*
 * Runtime theming for the workspace brand (design/08 §4, E1.7).
 *
 * The tokens arrive with the boot config, not from `GET /branding`, so there is nothing to
 * wait for: this applies them as inline custom properties on <html>, which beat the
 * stylesheet's `:root` / `.dark` rules, in a LAYOUT effect so the branded palette is in place
 * before the browser paints the first frame of the app. A plain effect would paint the
 * default blue first and repaint — exactly the flash this exists to avoid.
 *
 * The two palettes are separate maps and only the resolved mode's map is applied. Applying
 * `light` while the member is in dark mode would be worse than applying nothing, because the
 * inline properties win and the whole dark palette would be overridden by light values.
 *
 * Precedence is host-posted > workspace theme > defaults. The host's tokens arrive later (a
 * postMessage from the embedding page, handled in `EmbedFrame`), so the plain "apply last
 * wins" ordering gets it right on the way in — but a theme flip re-runs this effect long
 * after that message, so the names the host has claimed are recorded here and skipped.
 */
const hostOwned = new Set<string>();

/**
 * Records the token names an embedding host has posted, so the workspace brand never
 * overwrites them on a later re-apply. Call it with what `applyThemeTokens` returned.
 */
export function noteHostTokens(names: readonly string[]): void {
  for (const name of names) hostOwned.add(name);
}

/** Applies the workspace brand's tokens for the resolved theme. Renders nothing. */
export function BrandTheme() {
  const config = useWebConfig();
  const { resolvedTheme } = useTheme();
  const applied = useRef<readonly string[]>([]);
  const tokens = useMemo(
    () => config.branding?.tokens[resolvedTheme] ?? {},
    [config.branding, resolvedTheme],
  );

  useLayoutEffect(() => {
    const root = document.documentElement;
    const next: Record<string, string> = {};
    for (const [name, value] of Object.entries(tokens)) {
      if (!hostOwned.has(name)) next[name] = value;
    }
    // A token the previous palette set and this one does not must go back to the
    // stylesheet default rather than linger as a light value under a dark class.
    for (const name of applied.current) {
      if (!(name in next)) root.style.removeProperty(name);
    }
    applied.current = applyThemeTokens(next, root);
  }, [tokens]);

  return null;
}
