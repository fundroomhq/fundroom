#!/usr/bin/env node
/**
 * SQL hygiene rules that Biome cannot express (design/06 §3, §9; design/02 §3):
 *
 *  1. No session-level `SET` in application code or migrations. With pooled connections
 *     (PgBouncer transaction mode) a plain SET leaks the tenant context to the next client.
 *     Use `SET LOCAL …` or `set_config(name, value, true)`.
 *  2. No `set_config(…, false)` for the same reason.
 *
 * Scans *.ts/*.mjs/*.sql under apps/, packages/, modules/, scripts/ (not node_modules/dist).
 * Usage: node scripts/check-sql-hygiene.mjs [root]. Exit 1 on findings.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["apps", "packages", "modules"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", "generated"]);
const EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|sql)$/u;

/**
 * `SET x` at statement start (file start, after `;`, or start of a string/template) that is not
 * SET LOCAL. `SET TRANSACTION …` and `SET CONSTRAINTS …` are exempt: both are transaction-scoped
 * by definition (E2.7's read-only view-as transactions use the first, E2.8's workspace import the
 * second).
 */
export const SESSION_SET_RE =
  /(?:^|;|`|"|')\s*SET\s+(?!LOCAL\b|TRANSACTION\b|CONSTRAINTS\b)(?:SESSION\s+)?[A-Za-z_"]/gmu;
export const SET_CONFIG_FALSE_RE = /set_config\s*\([^)]*,\s*false\s*\)/giu;

export function findViolations(text) {
  const out = [];
  for (const m of text.matchAll(SESSION_SET_RE)) {
    out.push({ index: m.index, rule: "session-level SET (use SET LOCAL)" });
  }
  for (const m of text.matchAll(SET_CONFIG_FALSE_RE)) {
    out.push({ index: m.index, rule: "set_config(…, false) (use is_local = true)" });
  }
  return out;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name));
    } else if (EXT.test(e.name)) {
      yield join(dir, e.name);
    }
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function main(root) {
  let count = 0;
  for (const base of ROOTS) {
    const dir = join(root, base);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(dir)) {
      const text = readFileSync(file, "utf8");
      // The checker itself and its tests legitimately contain the forbidden patterns.
      if (/sql-hygiene-allow\b/u.test(text)) continue;
      for (const v of findViolations(text)) {
        count++;
        console.error(`${relative(root, file)}:${lineOf(text, v.index)}: ${v.rule}`);
      }
    }
  }
  if (count > 0) {
    console.error(`sql hygiene: ${count} problem(s)`);
    process.exitCode = 1;
  } else {
    console.error("sql hygiene: OK");
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/u, ""))) {
  main(process.argv[2] ?? process.cwd());
}
