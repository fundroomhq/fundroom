#!/usr/bin/env node
/*
 * Prepares the release list the release index is built from (B-11): GitHub's releases
 * (`gh api --paginate --slurp repos/<repo>/releases`), each `v*` release given `notes`, the
 * `## <version>` section of apps/server/CHANGELOG.md at its tag (`releaseNotes`, the same cut the
 * tag job writes release notes from). The index builder looks for a security changeset there, not
 * in the GitHub release body, which is cut at GitHub's size limit and loses its trailing entries.
 * The body is dropped from the output.
 *
 *   node scripts/release/release-index.mjs prepare --releases gh-releases.json --out releases.json
 *
 * Runs in the workflow's build job: no environment, no secrets, a full clone (tags). The index is
 * then built and uploaded by @fundroom/update-check's bundled publisher,
 * `node packages/update-check/dist/release-index.mjs --releases releases.json …`, in a job that
 * installs nothing. A published `v*` release whose tag is not in the clone is an error; a tag with
 * no CHANGELOG section gets `notes: null` (not a security release by its notes).
 * Exit 0 = written; 1 = failed; 2 = usage. docs/runbooks/releasing.md, "Release index".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import { releaseNotes } from "./release-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHANGELOG = "apps/server/CHANGELOG.md";
/** The tags this reads notes for; anything else is passed through with `notes: null`. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * One page or `--slurp` pages, flattened.
 *
 * @param {unknown} json
 * @returns {Record<string, unknown>[]}
 */
export function flattenReleases(json) {
  if (!Array.isArray(json)) throw new Error("GitHub releases: expected a JSON array");
  return json.every(Array.isArray) ? json.flat() : json;
}

/**
 * The releases with `notes` attached, `body` dropped.
 *
 * @param {Record<string, unknown>[]} releases
 * @param {(tag: string) => string | null} changelogAt apps/server/CHANGELOG.md at `tag`, or null
 */
export function prepareReleases(releases, changelogAt) {
  return releases.map((r) => {
    const { body: _body, ...rest } = r;
    const tag = String(r.tag_name ?? "");
    const published = r.draft === false && typeof r.published_at === "string";
    if (!published || !RELEASE_TAG.test(tag)) return { ...rest, notes: null };
    const changelog = changelogAt(tag);
    return { ...rest, notes: changelog === null ? null : releaseNotes(changelog, tag.slice(1)) };
  });
}

/**
 * apps/server/CHANGELOG.md at `tag` in the repository at `cwd`; null when the file is not there.
 * Throws when the tag itself is missing (a shallow clone, or a tag deleted after its release).
 *
 * @param {string} tag
 * @param {string} [cwd]
 */
export function changelogAt(tag, cwd = ROOT) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error(`tag ${tag} is not in this clone (fetch it: actions/checkout fetch-depth: 0)`);
  }
  try {
    return git(["show", `refs/tags/${tag}:${CHANGELOG}`]);
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { releases: { type: "string" }, out: { type: "string" } },
  });
  if (positionals[0] !== "prepare" || !values.releases || !values.out) {
    process.stderr.write(
      "usage: node scripts/release/release-index.mjs prepare --releases <gh.json> --out <file>\n",
    );
    return 2;
  }
  const releases = flattenReleases(JSON.parse(readFileSync(values.releases, "utf8")));
  const prepared = prepareReleases(releases, (tag) => changelogAt(tag));
  writeFileSync(values.out, `${JSON.stringify(prepared, null, 2)}\n`);
  const withNotes = prepared.filter((r) => typeof r.notes === "string").length;
  process.stderr.write(`prepared ${prepared.length} releases (${withNotes} with notes)\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
