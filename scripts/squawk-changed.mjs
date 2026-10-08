#!/usr/bin/env node
/*
 * Squawk on the migration files a push or pull request adds or changes. Applied migrations are
 * checksummed and immutable, so only new SQL is linted: an old file's findings cannot be fixed.
 *
 * The diff base, from the GitHub event (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF_NAME):
 *  - pull_request: the merge base of the PR's base commit and HEAD.
 *  - merge_group: the queue's base commit.
 *  - push: `before`, or the merge base with it after a force push. A push that creates a branch
 *    (`before` is all zeros) diffs against the default branch; one that creates the default
 *    branch itself is the repository's first push, which has no earlier state to diff against,
 *    so nothing is linted. A `before` that is not in the clone falls back to HEAD's parent.
 *  - `--base <rev>` overrides all of that (local use).
 *
 * Transactional files (the runner wraps each in one transaction) are linted with
 * --assume-in-transaction; `-- seedhost: no-transaction` files run in autocommit and are not.
 * Settings and excluded rules live in .squawk.toml. SQUAWK_BIN overrides the pinned squawk-cli.
 *
 *   node scripts/squawk-changed.mjs [--base <rev>]
 *
 * Exit 0 = no changed migration, or every changed migration is clean; 1 = findings.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SQUAWK_VERSION = "2.68.0";
export const MIGRATION_PATHSPEC = ":(glob)**/migrations/**/*.sql";
/** Mirrors `excluded_rules` in .squawk.toml. */
export const EXCLUDED_RULES = ["require-lock-timeout"];
/** Same marker the runner reads (packages/db/src/migrate/parse.ts). */
export const NO_TRANSACTION_MARKER = /^--\s*seedhost:\s*no-transaction\s*$/imu;
const ZERO_SHA = /^0+$/u;
// Read once: a CI script, never a turbo task.
const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF_NAME, SQUAWK_BIN } = process.env;

/**
 * @typedef {{ ok: boolean, out: string }} GitResult
 * @typedef {(args: string[]) => GitResult} Git
 * @typedef {{ base: string | null, reason: string }} BaseChoice
 */

/** @param {Git} git @param {string} rev */
const commitExists = (git, rev) => git(["cat-file", "-e", `${rev}^{commit}`]).ok;

/** @param {Git} git @param {string} a @param {string} b */
function mergeBase(git, a, b) {
  const r = git(["merge-base", a, b]);
  return r.ok && r.out ? r.out : null;
}

/** @param {Git} git @param {string} why */
function parentOrNothing(git, why) {
  return commitExists(git, "HEAD^")
    ? { base: "HEAD^", reason: `${why}; diffing against HEAD's parent` }
    : { base: null, reason: `${why}, and HEAD is a root commit: nothing to diff against` };
}

/**
 * Which revision the changed migrations are diffed against.
 *
 * @param {{ eventName?: string, event?: any, refName?: string, override?: string }} ctx
 * @param {Git} git
 * @returns {BaseChoice}
 */
export function chooseBase({ eventName, event, refName, override }, git) {
  if (override) return { base: override, reason: `--base ${override}` };
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const sha = event?.pull_request?.base?.sha;
    if (!sha || !commitExists(git, sha)) return parentOrNothing(git, "PR base commit not in clone");
    const mb = mergeBase(git, sha, "HEAD");
    return mb
      ? { base: mb, reason: `merge base with the PR base ${sha}` }
      : parentOrNothing(git, `no merge base with the PR base ${sha}`);
  }
  if (eventName === "merge_group") {
    const sha = event?.merge_group?.base_sha;
    return sha && commitExists(git, sha)
      ? { base: sha, reason: `merge queue base ${sha}` }
      : parentOrNothing(git, "merge queue base not in clone");
  }
  if (eventName === "push") {
    const before = String(event?.before ?? "");
    if (before === "" || ZERO_SHA.test(before)) {
      const defaultBranch = event?.repository?.default_branch;
      if (!defaultBranch || refName === defaultBranch) {
        return {
          base: null,
          reason:
            "this push created the default branch (the repository's first push): there is no earlier state, so its migrations are the baseline",
        };
      }
      const remote = `refs/remotes/origin/${defaultBranch}`;
      const mb = commitExists(git, remote) ? mergeBase(git, remote, "HEAD") : null;
      return mb
        ? { base: mb, reason: `new branch: merge base with ${defaultBranch}` }
        : parentOrNothing(git, `new branch with no merge base with ${defaultBranch}`);
    }
    if (!commitExists(git, before)) return parentOrNothing(git, `before ${before} not in clone`);
    if (git(["merge-base", "--is-ancestor", before, "HEAD"]).ok) {
      return { base: before, reason: `push range ${before}..HEAD` };
    }
    const mb = mergeBase(git, before, "HEAD");
    return mb
      ? { base: mb, reason: `force push: merge base with ${before}` }
      : parentOrNothing(git, `force push with no merge base with ${before}`);
  }
  return parentOrNothing(git, `event ${eventName ?? "(none)"} has no diff base`);
}

/**
 * Added, modified, renamed or copied migration files between `base` and HEAD.
 *
 * @param {Git} git @param {string} base
 */
export function changedMigrations(git, base) {
  const r = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    base,
    "HEAD",
    "--",
    MIGRATION_PATHSPEC,
  ]);
  if (!r.ok) throw new Error(`git diff ${base} HEAD failed: ${r.out}`);
  return r.out.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Splits files by how the runner applies them.
 *
 * @param {string[]} files @param {(f: string) => string} read
 */
export function splitByTransaction(files, read) {
  /** @type {string[]} */ const transactional = [];
  /** @type {string[]} */ const autocommit = [];
  for (const f of files) (NO_TRANSACTION_MARKER.test(read(f)) ? autocommit : transactional).push(f);
  return { transactional, autocommit };
}

/** @param {string} line */
const say = (line) => process.stdout.write(`${line}\n`);

/** @type {Git} */
function realGit(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.status === 0 ? "" : (r.stderr ?? "")}`.trim(),
  };
}

/**
 * Runs the pinned Squawk; it annotates findings itself when GITHUB_ACTIONS is set.
 *
 * @param {string[]} args
 */
function squawk(args) {
  const [cmd, pre] = SQUAWK_BIN
    ? [SQUAWK_BIN, []]
    : ["pnpm", ["--silent", "dlx", `squawk-cli@${SQUAWK_VERSION}`]];
  const r = spawnSync(cmd, [...pre, `--config=${join(ROOT, ".squawk.toml")}`, ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const choice = chooseBase(
    {
      eventName: GITHUB_EVENT_NAME,
      event: GITHUB_EVENT_PATH ? JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8")) : undefined,
      refName: GITHUB_REF_NAME,
      override: values.base,
    },
    realGit,
  );
  say(`diff base: ${choice.base ?? "none"} (${choice.reason})`);
  if (choice.base === null) process.exit(0);
  const files = changedMigrations(realGit, choice.base);
  if (files.length === 0) {
    say("no added or changed migration files");
    process.exit(0);
  }
  const { transactional, autocommit } = splitByTransaction(files, (f) =>
    readFileSync(join(ROOT, f), "utf8"),
  );
  let failed = false;
  for (const [group, flags] of /** @type {const} */ ([
    [transactional, ["--assume-in-transaction"]],
    // Autocommit chunks cannot scope a statement_timeout either: SET LOCAL has no effect outside
    // a transaction. A CLI --exclude replaces .squawk.toml's list, so it is repeated here.
    [autocommit, [`--exclude=${[...EXCLUDED_RULES, "require-statement-timeout"].join(",")}`]],
  ])) {
    if (group.length === 0) continue;
    say(`squawk ${[...flags, ...group].join(" ")}`);
    if (squawk([...flags, ...group]) !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
