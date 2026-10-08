#!/usr/bin/env node
/*
 * Every changeset must bump the core (E-UP-14 review). A release is the version of
 * apps/server/package.json, which moves only when a changeset names a member of Changesets'
 * `fixed` group in .changeset/config.json. A changeset naming only packages outside it (a module,
 * @fundroom/embed, @fundroom/compliance, …) is consumed by the version PR, bumps nothing in
 * apps/server, and so releases nothing, silently. This fails CI on such a changeset; add
 * `"@fundroom/server": patch` (or the bump the change deserves) to it.
 *
 * An empty changeset (no packages between the `---` lines) is allowed: it says "no release".
 * A core entry with bump `none` does not count. `#` comments in the front matter are ignored.
 *
 *   node scripts/release/check-changesets.mjs [--dir .changeset]
 *
 * Exit 0 = every changeset bumps the core; 1 = at least one does not (each is listed).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The `{ name, bump }` entries in a changeset's front matter. `#` comment lines and trailing
 * comments are ignored.
 *
 * @param {string} text
 */
export function changesetEntries(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*$/mu.exec(text);
  if (!m || text.slice(0, m.index).trim() !== "") {
    throw new Error("no front matter (a changeset starts with a --- block)");
  }
  /** @type {{ name: string, bump: string }[]} */
  const entries = [];
  for (const raw of (m[1] ?? "").split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, "").trim();
    if (line === "") continue;
    const entry = /^(["']?)([^"':\s]+)\1\s*:\s*(major|minor|patch|none)$/u.exec(line);
    if (!entry) throw new Error(`unreadable front-matter line: ${JSON.stringify(raw)}`);
    entries.push({
      name: /** @type {string} */ (entry[2]),
      bump: /** @type {string} */ (entry[3]),
    });
  }
  return entries;
}

/** @param {string} text */
export const changesetPackages = (text) => changesetEntries(text).map((e) => e.name);

/**
 * The changesets in `files` (name → text) that name packages but none of `core`.
 *
 * @param {Record<string, string>} files
 * @param {string[]} core
 * @returns {{ file: string, problem: string }[]}
 */
export function findProblems(files, core) {
  const coreSet = new Set(core);
  const problems = [];
  for (const [file, text] of Object.entries(files)) {
    let entries;
    try {
      entries = changesetEntries(text);
    } catch (error) {
      problems.push({ file, problem: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // Only a core entry that actually bumps counts: `"@fundroom/server": none` releases nothing.
    if (entries.length > 0 && !entries.some((e) => coreSet.has(e.name) && e.bump !== "none")) {
      problems.push({
        file,
        problem: `bumps no package of the fixed group (${entries.map((e) => `${e.name}: ${e.bump}`).join(", ")}): it would release nothing. Add "@fundroom/server": patch (or the right bump).`,
      });
    }
  }
  return problems;
}

/** @param {string} dir */
export function readChangesets(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    files[name] = readFileSync(join(dir, name), "utf8");
  }
  return files;
}

/** @param {string} dir */
export function coreGroup(dir) {
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const group = (config.fixed ?? []).find((/** @type {string[]} */ g) =>
    g.includes("@fundroom/server"),
  );
  if (!group) throw new Error(`${dir}/config.json: no fixed group contains @fundroom/server`);
  return group;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { dir: { type: "string", default: join(ROOT, ".changeset") } },
  });
  const dir = resolve(String(values.dir));
  const problems = findProblems(readChangesets(dir), coreGroup(dir));
  for (const { file, problem } of problems)
    console.error(`::error file=.changeset/${file}::${file} ${problem}`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write("every changeset bumps the core release\n");
}
