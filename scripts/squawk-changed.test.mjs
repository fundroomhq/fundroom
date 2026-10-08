// node --test scripts/squawk-changed.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import * as squawkChanged from "./squawk-changed.mjs";

const { EXCLUDED_RULES, changedMigrations, chooseBase, splitByTransaction } = squawkChanged;
const here = dirname(fileURLToPath(import.meta.url));

const ZERO = "0000000000000000000000000000000000000000";

/** A throwaway repository: main with a root commit and one more, plus a feature branch. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "squawk-changed-"));
  /** @param {string[]} args */
  const run = (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  /** @param {string} path @param {string} text */
  const write = (path, text) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  /** @param {string} msg */
  const commit = (msg) => {
    run(["add", "-A"]);
    run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg]);
    return run(["rev-parse", "HEAD"]);
  };
  run(["init", "-q", "-b", "main"]);
  write("packages/db/migrations/core/0000_kernel.sql", "CREATE TABLE a (id bigint);\n");
  write("modules/x/migrations/0001_x.sql", "CREATE TABLE x (id bigint);\n");
  const root = commit("root");
  write("modules/x/migrations/0002_y.sql", "CREATE TABLE y (id bigint);\n");
  write("modules/x/README.md", "not sql\n");
  const second = commit("second");
  /** @type {import("./squawk-changed.mjs").Git} */
  const git = (args) => {
    try {
      return { ok: true, out: run(args) };
    } catch (e) {
      return { ok: false, out: String(e) };
    }
  };
  return {
    dir,
    run,
    write,
    commit,
    git,
    root,
    second,
    done: () => rmSync(dir, { recursive: true }),
  };
}

test("first push of the default branch lints nothing; a root commit never crashes", () => {
  const f = fixture();
  try {
    const event = { before: ZERO, repository: { default_branch: "main" } };
    assert.equal(chooseBase({ eventName: "push", event, refName: "main" }, f.git).base, null);
    f.run(["checkout", "-q", f.root]);
    assert.equal(chooseBase({ eventName: "push", event: {}, refName: "x" }, f.git).base, null);
    assert.equal(chooseBase({ eventName: "workflow_dispatch" }, f.git).base, null);
  } finally {
    f.done();
  }
});

test("a push diffs against before: only the files the push added", () => {
  const f = fixture();
  try {
    const event = { before: f.root, repository: { default_branch: "main" } };
    const { base } = chooseBase({ eventName: "push", event, refName: "main" }, f.git);
    assert.equal(base, f.root);
    assert.deepEqual(changedMigrations(f.git, /** @type {string} */ (base)), [
      "modules/x/migrations/0002_y.sql",
    ]);
  } finally {
    f.done();
  }
});

test("a before that is not in the clone falls back to HEAD's parent", () => {
  const f = fixture();
  try {
    const event = { before: "1".repeat(40), repository: { default_branch: "main" } };
    assert.equal(chooseBase({ eventName: "push", event, refName: "main" }, f.git).base, "HEAD^");
  } finally {
    f.done();
  }
});

test("a force push diffs against the merge base with before", () => {
  const f = fixture();
  try {
    f.run(["checkout", "-q", "-b", "rewritten", f.root]);
    f.write("modules/x/migrations/0002_z.sql", "CREATE TABLE z (id bigint);\n");
    f.commit("rewrite");
    const event = { before: f.second, repository: { default_branch: "main" } };
    const { base } = chooseBase({ eventName: "push", event, refName: "rewritten" }, f.git);
    assert.equal(base, f.root);
    assert.deepEqual(changedMigrations(f.git, /** @type {string} */ (base)), [
      "modules/x/migrations/0002_z.sql",
    ]);
  } finally {
    f.done();
  }
});

test("a new branch diffs against the default branch; PRs and merge queues against their base", () => {
  const f = fixture();
  try {
    f.run(["update-ref", "refs/remotes/origin/main", f.second]);
    f.run(["checkout", "-q", "-b", "feature"]);
    f.write("packages/db/migrations/core/0001_new.sql", "CREATE TABLE n (id bigint);\n");
    f.commit("feature");
    const push = { before: ZERO, repository: { default_branch: "main" } };
    assert.equal(
      chooseBase({ eventName: "push", event: push, refName: "feature" }, f.git).base,
      f.second,
    );
    const pr = { pull_request: { base: { sha: f.second } } };
    const { base } = chooseBase({ eventName: "pull_request", event: pr }, f.git);
    assert.equal(base, f.second);
    assert.deepEqual(changedMigrations(f.git, /** @type {string} */ (base)), [
      "packages/db/migrations/core/0001_new.sql",
    ]);
    const mg = { merge_group: { base_sha: f.second } };
    assert.equal(chooseBase({ eventName: "merge_group", event: mg }, f.git).base, f.second);
    assert.equal(chooseBase({ override: "HEAD~2" }, f.git).base, "HEAD~2");
  } finally {
    f.done();
  }
});

test("no-transaction files are linted without --assume-in-transaction", () => {
  const text = /** @type {Record<string, string>} */ ({
    "a.sql": "CREATE TABLE a (id bigint);\n",
    "b.sql": "-- seedhost: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON a (id);\n",
  });
  assert.deepEqual(
    splitByTransaction(["a.sql", "b.sql"], (f) => /** @type {string} */ (text[f])),
    { transactional: ["a.sql"], autocommit: ["b.sql"] },
  );
});

test("the excluded rules match .squawk.toml", () => {
  const toml = readFileSync(join(here, "..", ".squawk.toml"), "utf8");
  const m = /^excluded_rules\s*=\s*(\[[^\]]*\])/mu.exec(toml);
  assert.ok(m, "excluded_rules in .squawk.toml");
  assert.deepEqual(JSON.parse(/** @type {string} */ (m[1])), EXCLUDED_RULES);
});
