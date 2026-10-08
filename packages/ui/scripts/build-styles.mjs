#!/usr/bin/env node
/**
 * The published stylesheets (ADR-0067), written into dist/styles/ after `tsc`:
 *
 *   src/styles/index.css            →  dist/styles/index.css   (`@fundroomhq/ui/styles.css` once packed)
 *   @fundroomhq/tokens/tokens.css     →  dist/styles/tokens.css  (`@fundroomhq/ui/tokens.css`)
 *
 * In the monorepo `./styles.css` resolves to src/styles/index.css, whose `@source "../components"`
 * lets Tailwind see the component sources. The tarball ships no sources, so the copy's `@source`
 * points at the compiled components next to it instead (`dist/`); every other line, including
 * the `@import "@fundroomhq/tokens/tokens.css"`, is a package import that resolves the same way in
 * a consumer's node_modules. The rewrite refuses to guess: the source line must appear exactly
 * once, or the build fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export const SOURCE_LINE = '@source "../components";';
export const PUBLISHED_SOURCE_LINE = '@source "../";';
export const PUBLISHED_COMMENT =
  "/* The compiled components (this package's dist/); apps add their own `@source` lines. */";

/** @param {string} css */
export function publishedStyles(css) {
  const count = css.split(SOURCE_LINE).length - 1;
  if (count !== 1) {
    throw new Error(
      `src/styles/index.css must contain \`${SOURCE_LINE}\` exactly once (found ${count}); update scripts/build-styles.mjs with it`,
    );
  }
  if (/@import\s+["']\.\.?\//u.test(css)) {
    throw new Error(
      "src/styles/index.css imports a relative file, which the tarball does not ship",
    );
  }
  // The comment above the line describes the monorepo layout; say what the tarball does.
  const published = css.replace(SOURCE_LINE, PUBLISHED_SOURCE_LINE);
  const comment = /\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\r?\n(?=@source "\.\.\/";)/u;
  const note = `${PUBLISHED_COMMENT}\n`;
  return comment.test(published)
    ? published.replace(comment, note)
    : published.replace(PUBLISHED_SOURCE_LINE, `${note}${PUBLISHED_SOURCE_LINE}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(root, "dist", "styles");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "index.css"),
    publishedStyles(readFileSync(join(root, "src", "styles", "index.css"), "utf8")),
  );
  const tokens = createRequire(import.meta.url).resolve("@fundroomhq/tokens/tokens.css");
  writeFileSync(join(out, "tokens.css"), readFileSync(tokens));
}
