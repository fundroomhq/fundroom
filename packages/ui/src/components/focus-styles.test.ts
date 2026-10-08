import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Forced-colours focus guard (C-10 finding, plan §12 E-UP-5). In Tailwind v4 `outline-none` is
 * `outline-style: none`, and forced-colours mode drops box-shadow rings, so a control that shows
 * focus only by ring/border shows nothing there. `outline-hidden` is `outline-style: none` plus,
 * under `@media (forced-colors: active)`, `outline: 2px solid transparent` — which the browser
 * paints in a system colour. Unprefixed it paints on every element all the time (verified in
 * Chromium with forced colours emulated), so it must sit behind the same focus variant as the
 * ring: `focus-visible:outline-hidden` / `focus:outline-hidden`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(
  (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && !f.endsWith(".stories.tsx"),
);

/** Elements where `outline-none` is deliberate. Key: `file` + the exact class string. */
const ALLOWED_OUTLINE_NONE: Record<string, string> = {
  // The skip link's programmatic focus target (`tabIndex={-1}`, never in the tab order). Focus
  // lands on the whole content region; outlining the page body would only add noise, and the
  // skip link itself shows focus.
  "app-shell.tsx: flex-1 p-4 outline-none md:p-8": "skip-link target, not tabbable",
};

function classTokens(source: string): string[][] {
  // Every string literal; class lists are plain "..." strings (cva, cn, className=).
  return [...source.matchAll(/"([^"\n]*)"/gu)].map((m) => (m[1] ?? "").split(/\s+/u));
}

function utility(token: string): string {
  // Strip variants (`focus-visible:`, `data-[active=true]:`, …) and the important marker.
  return token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/gu, "");
}

describe("focus styles survive forced-colours mode", () => {
  it("finds the component sources", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s uses no outline-none outside the allow-list", (file) => {
    const source = readFileSync(join(here, file), "utf8");
    const offenders = classTokens(source)
      .filter((tokens) => tokens.some((t) => utility(t) === "outline-none"))
      .map((tokens) => `${file}: ${tokens.join(" ")}`)
      .filter((key) => !(key in ALLOWED_OUTLINE_NONE));
    expect(offenders).toEqual([]);
  });

  it("keeps every allow-list entry live", () => {
    for (const key of Object.keys(ALLOWED_OUTLINE_NONE)) {
      const [file, classes] = key.split(": ") as [string, string];
      expect(readFileSync(join(here, file), "utf8"), key).toContain(`"${classes}"`);
    }
  });

  it.each(files)("%s never uses outline-hidden without a variant", (file) => {
    const source = readFileSync(join(here, file), "utf8");
    const bare = classTokens(source)
      .flat()
      .filter((t) => t === "outline-hidden" || t === "!outline-hidden");
    expect(bare).toEqual([]);
  });

  it.each(files)("%s pairs every variant ring with a forced-colours outline", (file) => {
    const tokens = classTokens(readFileSync(join(here, file), "utf8")).flat();
    const variantsWithRing = new Set(
      tokens
        .filter((t) => t.includes(":") && /^ring-(\[|\d)/u.test(utility(t)))
        .map((t) => t.slice(0, t.lastIndexOf(":"))),
    );
    for (const variant of variantsWithRing) {
      const hasOutline = tokens.some(
        (t) => t.startsWith(`${variant}:`) && /^outline-(hidden|\d|\[)/u.test(utility(t)),
      );
      expect(hasOutline, `${file}: ${variant}:ring-* without ${variant}:outline-hidden`).toBe(true);
    }
  });
});
