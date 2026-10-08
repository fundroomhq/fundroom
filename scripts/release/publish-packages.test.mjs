// node --test scripts/release/publish-packages.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCommitted,
  compareSemver,
  distTag,
  parseVersions,
  takeToken,
  tarballName,
  tarballProblems,
  versionAtLeast,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
} from "./publish-packages.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "publish-packages.mjs");
const NO = { latest: false };
const YES = { latest: true };

test("SemVer precedence, prereleases included", () => {
  const order = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1-rc.0",
    "1.1.0",
  ];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareSemver(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.ok(compareSemver(order[i + 1], order[i]) > 0);
  }
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-rc.1"), 0);
});

test("dist-tag: next (or next-X.Y under a higher version) for a prerelease; latest only when allowed", () => {
  assert.equal(distTag("1.0.0-rc.1", NO, []), "next");
  assert.equal(distTag("1.0.0-rc.2", YES, ["1.0.0-rc.1"]), "next");
  assert.equal(distTag("1.0.1-rc.1", NO, ["1.0.0", "1.1.0-rc.1"]), "next-1.0");
  assert.equal(distTag("1.0.0-rc.3", NO, ["1.0.0"]), "next-1.0");
  assert.equal(distTag("1.0.0-rc.3", NO, ["garbage", "1.0.0-rc.2"]), "next");
  assert.equal(distTag("1.2.3", YES, ["1.2.2"]), "latest");
  // A patch to an older line never moves `latest` backwards.
  assert.equal(distTag("1.2.3", NO, ["2.0.0"]), "release-1.2");
  assert.throws(() => distTag("v1.2.3", YES));
});

test("npm view versions: a list, a single string and E404 are read; anything else throws", () => {
  assert.deepEqual(parseVersions({ status: 0, stdout: '["1.0.0-rc.1","1.0.0"]', stderr: "" }), [
    "1.0.0-rc.1",
    "1.0.0",
  ]);
  assert.deepEqual(parseVersions({ status: 0, stdout: '"1.0.0-rc.1"\n', stderr: "" }), [
    "1.0.0-rc.1",
  ]);
  const e404 = JSON.stringify({ error: { code: "E404", summary: "Not Found" } });
  assert.deepEqual(parseVersions({ status: 1, stdout: e404, stderr: "npm error code E404" }), []);
  assert.deepEqual(parseVersions({ status: 1, stdout: "", stderr: "npm error code E404\n" }), []);
  assert.throws(
    () => parseVersions({ status: 1, stdout: "", stderr: "npm error code ECONNRESET" }),
    /npm view failed/u,
  );
  assert.throws(
    () =>
      parseVersions({ status: 1, stdout: JSON.stringify({ error: { code: "E401" } }), stderr: "" }),
    /npm view failed/u,
  );
  assert.throws(() => parseVersions({ status: 0, stdout: "{}", stderr: "" }), /answered/u);
});

test("committed versions must all be the release", () => {
  const v = "1.0.0-rc.1";
  checkCommitted(
    [
      { name: "@fundroomhq/tokens", committed: v },
      { name: "@fundroomhq/ui", committed: v },
    ],
    v,
  );
  assert.throws(
    () => checkCommitted([{ name: "@fundroomhq/tokens", committed: "0.0.0" }], v),
    /@fundroomhq\/tokens@0\.0\.0/u,
  );
});

test("tarball names and manifests", () => {
  assert.equal(tarballName("@fundroomhq/tokens", "1.0.0-rc.1"), "fundroomhq-tokens-1.0.0-rc.1.tgz");
  const ok = {
    name: "@fundroomhq/ui",
    version: "1.0.0",
    dependencies: { "@fundroomhq/tokens": "1.0.0" },
  };
  assert.deepEqual(tarballProblems(ok, "@fundroomhq/ui", "1.0.0"), []);
  const bad = { ...ok, version: "0.0.0", private: true, dependencies: { x: "workspace:*" } };
  assert.equal(tarballProblems(bad, "@fundroomhq/ui", "1.0.0").length, 3);
  const confused = { ...ok, dependencies: { "@fundroom/tokens": "1.0.0" } };
  assert.match(tarballProblems(confused, "@fundroomhq/ui", "1.0.0").join(), /not ours/u);
});

test("the token leaves the environment", () => {
  const env = { NODE_AUTH_TOKEN: "s3cret", PATH: "/bin" };
  assert.equal(takeToken(env), "s3cret");
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(takeToken({}), "");
});

test("npm version floor for trusted publishing", () => {
  assert.equal(versionAtLeast("11.5.1\n", "11.5.1"), true);
  assert.equal(versionAtLeast("11.19.0", "11.5.1"), true);
  assert.equal(versionAtLeast("12.0.0", "11.5.1"), true);
  assert.equal(versionAtLeast("11.5.0", "11.5.1"), false);
  assert.equal(versionAtLeast("10.9.2", "11.5.1"), false);
});

/**
 * `publish` against a fake npm: it logs every call with whether the token reached it, answers
 * `view` from $FAKE_PUBLISHED (a JSON list, or E404 when unset) and `--version` from $FAKE_NPM.
 */
function fakeRig(/** @type {string} */ version) {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-publish-test-"));
  const tarballs = join(dir, "tarballs");
  mkdirSync(tarballs);
  for (const name of ["@fundroomhq/tokens", "@fundroomhq/ui"]) {
    const src = join(dir, "src", name.replace("/", "_"), "package");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name, version }));
    execFileSync("tar", [
      "-czf",
      join(tarballs, tarballName(name, version)),
      "-C",
      dirname(src),
      "package",
    ]);
  }
  const log = join(dir, "npm.log");
  const npm = join(dir, "npm");
  writeFileSync(
    npm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.NODE_AUTH_TOKEN ?? null }) + "\\n");
if (args[0] === "--version") { console.log(process.env.FAKE_NPM || "11.19.0"); process.exit(0); }
if (args[0] === "view") {
  if (process.env.FAKE_PUBLISHED) { console.log(process.env.FAKE_PUBLISHED); process.exit(0); }
  console.log(JSON.stringify({ error: { code: "E404" } })); console.error("npm error code E404"); process.exit(1);
}
if (args[0] === "publish") process.exit(0);
process.exit(2);
`,
  );
  chmodSync(npm, 0o755);
  const run = (/** @type {string[]} */ extra, /** @type {Record<string, string>} */ env = {}) =>
    spawnSync(
      process.execPath,
      [SCRIPT, "publish", "--version", version, "--dir", tarballs, ...extra],
      {
        encoding: "utf8",
        env: { ...process.env, NPM_BIN: npm, NODE_AUTH_TOKEN: "s3cret", ...env },
      },
    );
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { dir, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("publish: tokens then ui under next; only npm view and npm publish; the token reaches publish alone", () => {
  const rig = fakeRig("1.0.0-rc.1");
  try {
    const r = rig.run([]);
    assert.equal(r.status, 0, r.stderr);
    const calls = rig.calls();
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ["--version", "view", "publish", "view", "publish"],
    );
    const publishes = calls.filter((c) => c.args[0] === "publish");
    assert.match(publishes[0].args[1], /fundroomhq-tokens-1\.0\.0-rc\.1\.tgz$/u);
    assert.match(publishes[1].args[1], /fundroomhq-ui-1\.0\.0-rc\.1\.tgz$/u);
    for (const p of publishes)
      assert.deepEqual(p.args.slice(2), ["--access", "public", "--tag", "next"]);
    for (const c of calls) assert.equal(c.token, c.args[0] === "publish" ? "s3cret" : null);
  } finally {
    rig.cleanup();
  }
});

test("publish: a re-run skips versions already on npm", () => {
  const rig = fakeRig("1.0.0-rc.1");
  try {
    const r = rig.run([], { FAKE_PUBLISHED: '["1.0.0-rc.1"]' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rig.calls().filter((c) => c.args[0] === "publish").length, 0);
    assert.match(r.stdout, /nothing to publish/u);
  } finally {
    rig.cleanup();
  }
});

test("publish: refuses an old npm, a wrong version and a missing tarball", () => {
  const rig = fakeRig("1.0.0-rc.1");
  try {
    assert.match(rig.run([], { FAKE_NPM: "10.9.2" }).stderr, /11\.5\.1 or later/u);
    const wrong = spawnSync(
      process.execPath,
      [SCRIPT, "publish", "--version", "1.0.0", "--dir", join(rig.dir, "tarballs")],
      { encoding: "utf8", env: { ...process.env, NPM_BIN: join(rig.dir, "npm") } },
    );
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /fundroomhq-tokens-1\.0\.0\.tgz is missing/u);
    assert.equal(rig.calls().filter((c) => c.args[0] === "publish").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("publish: --no-provenance only outside Actions", () => {
  const rig = fakeRig("1.0.0-rc.1");
  try {
    const inCi = rig.run(["--no-provenance"], { GITHUB_ACTIONS: "true" });
    assert.equal(inCi.status, 1);
    assert.match(inCi.stderr, /never inside Actions/u);
    assert.throws(() => rig.calls(), /ENOENT/u);
    const manual = rig.run(["--no-provenance"], { GITHUB_ACTIONS: "" });
    assert.equal(manual.status, 0, manual.stderr);
    for (const p of rig.calls().filter((c) => c.args[0] === "publish"))
      assert.ok(p.args.includes("--provenance=false"), p.args.join(" "));
  } finally {
    rig.cleanup();
  }
});
