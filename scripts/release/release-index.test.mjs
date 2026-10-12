// node --test scripts/release/release-index.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changelogAt,
  flattenReleases,
  prepareReleases,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
} from "./release-index.mjs";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import { RELEASE_BODY_MAX, releaseBody } from "./release-version.mjs";

const SECURITY_ENTRY =
  "- [#41](https://github.com/fundroomhq/fundroom/pull/41) [`1a2b3c4`](https://github.com/fundroomhq/fundroom/commit/1a2b3c4) Thanks [@fundroomio](https://github.com/fundroomio)! - **Security:** sign-out clears every session cookie.";

const gh = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/fundroomhq/fundroom/releases/tag/${tag}`,
  published_at: "2026-10-27T12:00:00Z",
  draft: false,
  body: "release body",
  ...extra,
});

test("flattens one page or --slurp pages", () => {
  assert.equal(flattenReleases([gh("v1.0.0")]).length, 1);
  assert.equal(flattenReleases([[gh("v1.0.0")], [gh("v1.0.1")]]).length, 2);
  assert.throws(() => flattenReleases({ message: "Bad credentials" }), /array/u);
});

test("notes come from the CHANGELOG section at the tag; the body is dropped", () => {
  const changelog = `# @fundroom/server\n\n## 1.0.1\n\n### Patch Changes\n\n${SECURITY_ENTRY}\n\n## 1.0.0\n\n### Major Changes\n\n- 1.0\n`;
  const asked = [];
  const out = prepareReleases(
    [gh("v1.0.1"), gh("v1.0.0"), gh("chart-v0.1.0"), gh("v1.0.2", { draft: true })],
    (tag) => {
      asked.push(tag);
      return changelog;
    },
  );
  assert.deepEqual(asked, ["v1.0.1", "v1.0.0"]);
  assert.match(out[0].notes, /\*\*Security:\*\* sign-out/u);
  assert.equal(out[1].notes, "### Major Changes\n\n- 1.0");
  assert.equal(out[2].notes, null);
  assert.equal(out[3].notes, null);
  for (const r of out) assert.equal("body" in r, false);
  assert.equal(prepareReleases([gh("v1.0.3")], () => null)[0].notes, null);
});

test("a security entry the truncated release body lost is still in the notes", () => {
  // A release whose notes overflow GitHub's body limit: the tag job cuts trailing entries, and the
  // patch section (where a security fix sits) comes last.
  const big = Array.from({ length: 400 }, (_, i) => `- change ${i} ${"x".repeat(400)}`).join("\n");
  const section = `### Minor Changes\n\n${big}\n\n### Patch Changes\n\n${SECURITY_ENTRY}`;
  const body = releaseBody({
    notes: section,
    version: "1.1.0",
    image: "ghcr.io/fundroomhq/fundroom",
    repository: "fundroomhq/fundroom",
  });
  assert.ok(body.length <= RELEASE_BODY_MAX);
  assert.equal(body.includes("**Security:**"), false);
  const [prepared] = prepareReleases([gh("v1.1.0", { body })], () => `## 1.1.0\n\n${section}\n`);
  assert.match(prepared.notes, /\*\*Security:\*\*/u);
});

test("changelogAt reads the file at the tag; a missing tag throws, a missing file is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-index-git-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  git("init", "-q");
  writeFileSync(join(dir, "README"), "x");
  git("add", ".");
  git("commit", "-qm", "no changelog");
  git("tag", "v0.9.0");
  execFileSync("mkdir", ["-p", join(dir, "apps/server")]);
  writeFileSync(join(dir, "apps/server/CHANGELOG.md"), "## 1.0.0\n\n- one\n");
  git("add", ".");
  git("commit", "-qm", "changelog");
  git("tag", "v1.0.0");
  writeFileSync(join(dir, "apps/server/CHANGELOG.md"), "## 1.0.1\n\n- later\n");
  git("commit", "-qam", "later");
  assert.equal(changelogAt("v1.0.0", dir), "## 1.0.0\n\n- one\n");
  assert.equal(changelogAt("v0.9.0", dir), null);
  assert.throws(() => changelogAt("v2.0.0", dir), /not in this clone/u);
});
