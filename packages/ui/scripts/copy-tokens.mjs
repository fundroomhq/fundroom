#!/usr/bin/env node
/**
 * `@fundroomhq/tokens`' DTCG source → src/theme/default-tokens.json (ADR-0067).
 *
 * `DEFAULT_TOKENS` in `@fundroomhq/ui/theme` is built from this copy. It lives under src/ so tsc
 * emits it into dist/ (the published `./tokens.json` export and `dist/theme/tokens.js` both use
 * it) and the browser bundle needs no JSON import from another package. The tokens package
 * renders the same document to tokens.css (`pnpm --filter @fundroomhq/tokens codegen`).
 * `--check` exits 1 when the copy is behind (CI runs it through `codegen:check`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = createRequire(import.meta.url).resolve("@fundroomhq/tokens/tokens.json");
const copy = join(here, "..", "src", "theme", "default-tokens.json");

const raw = readFileSync(source, "utf8");
JSON.parse(raw); // refuse to copy a broken document

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(copy, "utf8");
  } catch {
    /* missing → stale */
  }
  if (current !== raw) {
    console.error(
      "src/theme/default-tokens.json is stale; run `pnpm --filter @fundroomhq/ui codegen`",
    );
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(copy, raw);
