#!/usr/bin/env node
/*
 * Generates the `en-XA` pseudo-locale (E2.8) from each catalogue's `en.json`:
 *   apps/web/messages/en.json            -> apps/web/messages/en-XA.json   (Paraglide / inlang)
 *   packages/i18n/src/messages/en.json   -> packages/i18n/src/messages/en-XA.json (server emails)
 *
 * Deterministic and idempotent: the output depends on `en.json` alone, keys in the same order.
 * Never hand-edit an `en-XA.json`.
 *
 *   node scripts/i18n-pseudo.mjs          write both files
 *   node scripts/i18n-pseudo.mjs --check  exit 1 when a committed file is stale (CI)
 *
 * The transform lives in `packages/i18n/src/pseudo.ts` (loaded as TypeScript: Node 24 strips
 * types), so the SPA's pseudo-locale and the emails' are the same function.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/useImportExtensions: a .ts source loaded by Node's type stripping (no build step needed in CI's lint job).
import { pseudoLocalizeValue } from "../packages/i18n/src/pseudo.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CATALOGUES = [
  { en: "apps/web/messages/en.json", pseudo: "apps/web/messages/en-XA.json" },
  { en: "packages/i18n/src/messages/en.json", pseudo: "packages/i18n/src/messages/en-XA.json" },
];

/** The pseudo-locale file content for one `en.json` object (keys in the same order). */
export function pseudoCatalogue(en) {
  const out = {};
  for (const [key, value] of Object.entries(en)) {
    // inlang's `$schema` pointer is metadata, not a message.
    out[key] = key === "$schema" ? value : pseudoLocalizeValue(value);
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function run(check) {
  let stale = 0;
  for (const c of CATALOGUES) {
    const enPath = join(root, c.en);
    const pseudoPath = join(root, c.pseudo);
    const want = pseudoCatalogue(JSON.parse(readFileSync(enPath, "utf8")));
    let have;
    try {
      have = readFileSync(pseudoPath, "utf8");
    } catch {
      have = undefined;
    }
    if (have === want) continue;
    if (check) {
      stale += 1;
      console.error(
        `${relative(root, pseudoPath)} is stale: run \`node scripts/i18n-pseudo.mjs\` and commit it`,
      );
    } else {
      writeFileSync(pseudoPath, want);
      process.stdout.write(`wrote ${relative(root, pseudoPath)}` + "\n");
    }
  }
  if (stale > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.includes("--check"));
}
