// node --test scripts/release/release-version.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkGuard,
  checkReleaseTag,
  floatingTags,
  gitTag,
  imageMeta,
  isNewestStable,
  isPrerelease,
  parseFloating,
  planTag,
  RELEASE_BODY_MAX,
  releaseBody,
  releaseNotes,
  remoteTagSha,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
} from "./release-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const SCRIPT = join(here, "release-version.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const ALL = { minor: true, major: true, latest: true };
const release = (version, floating = ALL, packageVersion = version) =>
  imageMeta({ version, floating, packageVersion, sha: SHA, ref: "refs/heads/main", event: "push" });

// `yaml` is a dependency of @fundroom/authz; scripts/ has no package.json (as in
// scripts/render-deploy-templates.test.mjs).
const { parse: parseYaml } = createRequire(join(ROOT, "packages/authz/package.json"))("yaml");

test("a release is one v<version> git tag; non-SemVer is refused", () => {
  assert.equal(gitTag("1.0.0-rc.1"), "v1.0.0-rc.1");
  assert.throws(() => gitTag("v1.0.0"));
  assert.throws(() => gitTag("1.0"));
  assert.throws(() => gitTag("1.0.0+build"));
  assert.equal(isPrerelease("1.0.0-rc.1"), true);
  assert.equal(isPrerelease("1.0.0"), false);
});

test("planTag: release when untagged, resume when the tag is on this commit and unfinished", () => {
  const base = { version: "1.0.0", sha: SHA };
  assert.equal(planTag({ ...base, version: "0.0.0", remoteTagSha: null }).release, false);
  assert.deepEqual(planTag({ ...base, remoteTagSha: null }), {
    release: true,
    tag: "v1.0.0",
    prerelease: false,
    createTag: true,
    createRelease: true,
  });
  // Tag pushed, then the release call failed: resume, create the release, keep the tag.
  assert.deepEqual(planTag({ ...base, remoteTagSha: SHA, releaseState: "missing" }), {
    release: true,
    tag: "v1.0.0",
    prerelease: false,
    createTag: false,
    createRelease: true,
  });
  // Tag and draft exist (the image never finished): resume, build the image again.
  assert.equal(planTag({ ...base, remoteTagSha: SHA, releaseState: "draft" }).release, true);
  assert.equal(planTag({ ...base, remoteTagSha: SHA, releaseState: "draft" }).createRelease, false);
  // Done, or a later commit with the same version: nothing.
  assert.equal(planTag({ ...base, remoteTagSha: SHA, releaseState: "published" }).release, false);
  assert.equal(planTag({ ...base, remoteTagSha: OTHER }).release, false);
  assert.throws(() => planTag({ ...base, remoteTagSha: SHA }));
  assert.equal(planTag({ ...base, version: "1.0.0-rc.1", remoteTagSha: null }).prerelease, true);
});

test("remoteTagSha prefers the peeled commit of an annotated tag", () => {
  const ls = `${OTHER}\trefs/tags/v1.0.0\n${SHA}\trefs/tags/v1.0.0^{}\n${OTHER}\trefs/tags/v1.0.1\n`;
  assert.equal(remoteTagSha(ls, "v1.0.0"), SHA);
  assert.equal(remoteTagSha(ls, "v1.0.1"), OTHER);
  assert.equal(remoteTagSha(ls, "v2.0.0"), null);
});

test("a prerelease image gets its exact version only, whatever floating says", () => {
  const meta = release("1.0.0-rc.1");
  assert.deepEqual(meta.tags, ["1.0.0-rc.1"]);
  assert.equal(meta.prerelease, true);
  assert.equal(meta.latest, false);
  assert.equal(meta.ociVersion, "1.0.0-rc.1");
});

test("a stable release gets X.Y.Z, and X.Y, X, latest only as floating allows", () => {
  assert.deepEqual(release("1.4.2").tags, ["1.4.2", "1.4", "1", "latest"]);
  assert.deepEqual(release("1.4.2", { minor: true }).tags, ["1.4.2", "1.4"]);
  assert.deepEqual(release("1.4.2", {}).tags, ["1.4.2"]);
  assert.deepEqual(release("0.3.0").tags, ["0.3.0", "0.3", "latest"]);
  for (const t of release("2.0.0").tags) assert.doesNotMatch(t, /^v/u);
});

test("floating tags: each only for the highest release in its line; none for a prerelease", () => {
  const remote = [
    "refs/tags/v1.0.0",
    "refs/tags/v1.1.0",
    "refs/tags/v1.1.0^{}",
    "refs/tags/v2.0.0-rc.1",
    "refs/tags/chart-v9.0.0",
  ];
  assert.deepEqual(floatingTags("1.2.0", remote), ALL);
  assert.deepEqual(floatingTags("1.1.0", remote), ALL);
  // A patch to an older minor line: its own X.Y only.
  assert.deepEqual(floatingTags("1.0.1", remote), { minor: true, major: false, latest: false });
  // A patch below a newer patch of the same line: nothing moves.
  assert.deepEqual(floatingTags("1.0.1", [...remote, "refs/tags/v1.0.2"]), {
    minor: false,
    major: false,
    latest: false,
  });
  // An older major line keeps its X but not latest.
  assert.deepEqual(floatingTags("1.2.0", [...remote, "refs/tags/v2.0.0"]), {
    minor: true,
    major: true,
    latest: false,
  });
  assert.deepEqual(floatingTags("2.0.0-rc.2", remote), {
    minor: false,
    major: false,
    latest: false,
  });
  // 0.x: no `0` tag, but latest moves (deliberate: there is no 1.x yet).
  assert.deepEqual(floatingTags("0.3.0", []), { minor: true, major: false, latest: true });
  assert.equal(isNewestStable("1.0.0", []), true);
  assert.deepEqual(parseFloating("minor latest"), { minor: true, major: false, latest: true });
  assert.throws(() => parseFloating("edge"));
});

test("a release must match apps/server/package.json and cannot be 0.0.0", () => {
  assert.throws(() => release("1.0.0", ALL, "1.0.1"), /package\.json/u);
  assert.throws(() => release("0.0.0"));
});

test("non-release builds: edge on push to main, sha-<sha7> otherwise; label is version+git", () => {
  const edge = imageMeta({
    packageVersion: "1.0.0",
    sha: SHA,
    ref: "refs/heads/main",
    event: "push",
  });
  assert.deepEqual(edge.tags, ["edge"]);
  assert.equal(edge.release, false);
  assert.equal(edge.ociVersion, "1.0.0+git.0123456");
  const dispatched = imageMeta({
    packageVersion: "1.0.0",
    sha: SHA,
    ref: "refs/heads/feature",
    event: "workflow_dispatch",
  });
  assert.deepEqual(dispatched.tags, ["sha-0123456"]);
});

test("checkReleaseTag: a release build needs v<version> on origin, on this commit", () => {
  assert.doesNotThrow(() => checkReleaseTag({ version: "1.0.0", sha: SHA, remoteTagSha: SHA }));
  assert.throws(
    () => checkReleaseTag({ version: "1.0.0", sha: SHA, remoteTagSha: null }),
    /not on origin/u,
  );
  assert.throws(
    () => checkReleaseTag({ version: "1.0.0", sha: SHA, remoteTagSha: OTHER }),
    /not on/u,
  );
});

test("checkGuard: a release tag never moves to another digest", () => {
  const d1 = `sha256:${"1".repeat(64)}`;
  const d2 = `sha256:${"2".repeat(64)}`;
  assert.doesNotThrow(() => checkGuard({ guard: "1.0.0", existing: null, digest: d1 }));
  assert.doesNotThrow(() => checkGuard({ guard: "1.0.0", existing: d1, digest: d1 }));
  assert.throws(
    () => checkGuard({ guard: "1.0.0", existing: d1, digest: d2 }),
    /refusing to move/u,
  );
  assert.doesNotThrow(() => checkGuard({ guard: null, existing: null, digest: d2 }));
});

test("release notes come from the version's CHANGELOG section", () => {
  const changelog =
    "# @fundroom/server\n\n## 1.1.0\n\n### Minor Changes\n\n- b\n\n## 1.0.0\n\n- a\n";
  assert.equal(releaseNotes(changelog, "1.1.0"), "### Minor Changes\n\n- b");
  assert.equal(releaseNotes(changelog, "1.0.0"), "- a");
  assert.equal(releaseNotes(changelog, "2.0.0"), null);
});

test("release body: whole notes when they fit; else cut before an entry, linking the CHANGELOG", () => {
  const args = { version: "1.0.0-rc.0", image: "ghcr.io/o/r", repository: "o/r" };
  const small = releaseBody({ ...args, notes: "- a" });
  assert.match(small, /^- a\n\nImage: `ghcr\.io\/o\/r:1\.0\.0-rc\.0`/u);
  const entry = (i) => `- entry ${i}\n  ${"x".repeat(200)}\n  - nested ${i}`;
  const notes = `### Major Changes\n\n${Array.from({ length: 1000 }, (_, i) => entry(i)).join("\n")}`;
  assert.ok(notes.length > 125_000, "the fixture exceeds GitHub's limit");
  const body = releaseBody({ ...args, notes });
  assert.ok(body.length <= RELEASE_BODY_MAX, `${body.length} > ${RELEASE_BODY_MAX}`);
  assert.ok(RELEASE_BODY_MAX <= 125_000);
  // Cut between entries: the last kept entry is complete (its nested line is there).
  const kept = body.split("\n").filter((l) => l.startsWith("- entry ")).length;
  assert.ok(kept > 100);
  assert.match(body, new RegExp(`  - nested ${kept - 1}\\n\\n…and more`, "u"));
  assert.match(
    body,
    /\(https:\/\/github\.com\/o\/r\/blob\/v1\.0\.0-rc\.0\/apps\/server\/CHANGELOG\.md#100-rc0\)/u,
  );
  assert.match(body, /Image: `ghcr\.io\/o\/r:1\.0\.0-rc\.0`.*\n$/u);
  // A small limit still never exceeds itself.
  assert.ok(releaseBody({ ...args, notes, max: 2000 }).length <= 2000);
});

// --- image.yml: nothing is named before it is scanned, signed and attested ---------------------

test("image.yml: the index is pushed untagged and the tags are applied in the LAST step", () => {
  const wf = parseYaml(readFileSync(join(ROOT, ".github/workflows/image.yml"), "utf8"));
  const steps = wf.jobs.manifest.steps;
  const at = (pred, what) => {
    const i = steps.findIndex(pred);
    assert.notEqual(i, -1, `image.yml manifest job has no ${what} step`);
    return i;
  };
  const run = (s) => String(s.run ?? "");
  const index = at((s) => run(s).includes("push-index"), "push-index");
  const trivy = at((s) => String(s.uses ?? "").startsWith("aquasecurity/trivy-action"), "Trivy");
  const sign = at((s) => run(s).includes("cosign sign"), "cosign sign");
  const attest = at((s) => run(s).includes("cosign attest"), "cosign attest");
  const provenance = at(
    (s) => String(s.uses ?? "").startsWith("actions/attest-build-provenance"),
    "provenance",
  );
  const tags = at((s) => run(s).includes("apply-tags"), "apply-tags");
  assert.equal(tags, steps.length - 1, "apply-tags must be the last step");
  for (const [name, i] of Object.entries({ trivy, sign, attest, provenance })) {
    assert.ok(index < i && i < tags, `${name} must run between push-index and apply-tags`);
  }
  assert.match(run(steps[tags]), /--guard "\$GUARD"/u);
  // No other step in any job pushes a tag.
  for (const [job, def] of Object.entries(wf.jobs)) {
    for (const [i, s] of (def.steps ?? []).entries()) {
      if (job === "manifest" && i === tags) continue;
      assert.doesNotMatch(
        run(s),
        /imagetools create(?![^\n]*--dry-run)|oras tag|crane tag/u,
        `${job} step ${i} pushes a tag`,
      );
    }
  }
  // The release is published only after the image is tagged.
  assert.deepEqual(wf.jobs["release-assets"].needs, ["meta", "manifest"]);
  assert.match(
    wf.jobs["release-assets"].steps.at(-1).run,
    /gh release edit "v\$\{VERSION\}" --draft=false/u,
  );
});

test("image.yml: edge runs queue per ref; a release build has its own group", () => {
  const wf = parseYaml(readFileSync(join(ROOT, ".github/workflows/image.yml"), "utf8"));
  assert.equal(wf.concurrency["cancel-in-progress"], false);
  assert.match(wf.concurrency.group, /format\('release-\{0\}', inputs\.version\)/u);
  assert.match(wf.concurrency.group, /\|\| github\.ref/u);
});

test("the verifier's anchors are intact (fundroom-web release:verify, ADR-0015)", () => {
  const rel = parseYaml(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));
  assert.equal(rel.name, "Release");
  assert.deepEqual(Object.keys(rel.on), ["push"]);
  assert.deepEqual(rel.on.push.branches, ["main"]);
  assert.equal(rel.jobs.image.uses, "./.github/workflows/image.yml");
  assert.equal(rel.jobs.tag.steps.find((s) => s.id === "tag").if, undefined);
  // The version PR is independent of the release, and never runs on a re-run.
  assert.deepEqual(rel.jobs.image.needs, "tag");
  assert.equal(rel.jobs["version-pr"].needs, undefined);
  assert.match(rel.jobs["version-pr"].if, /github\.run_attempt == 1/u);
  assert.ok(!rel.jobs.tag.steps.some((s) => String(s.uses ?? "").startsWith("changesets/")));
});

// --- the registry commands against a stand-in oras / docker ------------------------------------

function fakeTools(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const state = join(dir, "registry.json");
  writeFileSync(state, "{}");
  const node = process.execPath;
  writeFileSync(
    join(bin, "oras"),
    `#!${node}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const [cmd, ...a] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "oras.log"))}, [cmd, ...a].join(" ") + "\\n");
if (cmd === "resolve") { const t = a[0].split(":").pop(); if (!s[t]) { process.stderr.write("Error: " + a[0] + ": not found\\n"); process.exit(1); } console.log(s[t]); }
else if (cmd === "tag") { const d = a[0].split("@")[1]; for (const t of a.slice(1)) s[t] = d; save(); }
else if (cmd === "manifest") { const ref = a[a.length - 2]; s["@" + ref.split("@")[1]] = fs.readFileSync(a[a.length - 1], "utf8"); save(); }
else process.exit(2);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!${node}
process.stdout.write(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: process.argv.slice(6).map((r) => ({ digest: r.split("@")[1] })) }));
`,
    { mode: 0o755 },
  );
  const run = (args) =>
    spawnSync(node, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORAS_BIN: join(bin, "oras"),
        DOCKER_BIN: join(bin, "docker"),
        GITHUB_OUTPUT: "",
      },
    });
  return {
    run,
    registry: () => JSON.parse(readFileSync(state, "utf8")),
    log: () => readFileSync(join(dir, "oras.log"), "utf8"),
  };
}

test("push-index pushes by digest with no tag; apply-tags tags it, and never moves X.Y.Z", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-oras-"));
  try {
    const t = fakeTools(dir);
    const img = "ghcr.io/fundroomhq/fundroom";
    const a = `sha256:${"a".repeat(64)}`;
    const b = `sha256:${"b".repeat(64)}`;
    const pushed = t.run(["push-index", "--image", img, "--digest", a, "--digest", b]);
    assert.equal(pushed.status, 0, pushed.stderr);
    const digest = /digest=(sha256:[0-9a-f]{64})/u.exec(pushed.stdout)?.[1];
    assert.ok(digest);
    assert.deepEqual(Object.keys(t.registry()), [`@${digest}`], "the index must be untagged");

    const tag = (d) =>
      t.run([
        "apply-tags",
        "--image",
        img,
        "--digest",
        d,
        "--tags",
        "1.0.0 1.0 1 latest",
        "--guard",
        "1.0.0",
      ]);
    assert.equal(tag(digest).status, 0);
    const reg = t.registry();
    for (const n of ["1.0.0", "1.0", "1", "latest"]) assert.equal(reg[n], digest);
    // Same digest again (re-run of the last step): fine.
    assert.equal(tag(digest).status, 0);
    // A rebuilt image: refused before any tag moves.
    const rebuilt = `sha256:${"c".repeat(64)}`;
    const refused = tag(rebuilt);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to move/u);
    assert.equal(t.registry().latest, digest);
    assert.equal(
      t
        .log()
        .split("\n")
        .filter((l) => l.startsWith("tag ")).length,
      2,
    );
    // Edge has no guard and moves freely.
    assert.equal(
      t.run(["apply-tags", "--image", img, "--digest", rebuilt, "--tags", "edge", "--guard", ""])
        .status,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the `tag` command end to end: a throwaway repo, a bare origin, and a stand-in `gh` --------

function sandbox(version) {
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const bin = join(dir, "bin");
  const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
  run("git", ["init", "--bare", "-q", origin], dir);
  mkdirSync(join(work, "scripts/release"), { recursive: true });
  mkdirSync(join(work, "apps/server"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(SCRIPT, join(work, "scripts/release/release-version.mjs"));
  const setVersion = (v) => {
    writeFileSync(
      join(work, "apps/server/package.json"),
      JSON.stringify({ name: "@fundroom/server", version: v }),
    );
    writeFileSync(
      join(work, "apps/server/CHANGELOG.md"),
      `# @fundroom/server\n\n## ${v}\n\n- notes for ${v}\n`,
    );
  };
  setVersion(version);
  // `gh` keeps releases in a JSON file: view (by tag, drafts included), create, edit.
  const ghState = join(dir, "gh.json");
  const ghLog = join(dir, "gh.log");
  writeFileSync(ghState, "{}");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(ghState)}, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, a.join(" ") + "\\n");
if (process.env.GH_FAIL && a[1] === "create") { process.stderr.write("HTTP 502\\n"); process.exit(1); }
if (a[1] === "view") { const r = s[a[2]]; if (!r) { process.stderr.write("release not found\\n"); process.exit(1); } console.log(String(r.draft)); }
else if (a[1] === "create") { const notes = fs.readFileSync(0, "utf8"); if (notes.length > 125000) { process.stderr.write("HTTP 422: Validation Failed (body is too long (maximum is 125000 characters))\\n"); process.exit(1); } s[a[2]] = { draft: a.includes("--draft"), prerelease: a.includes("--prerelease"), notes }; }
else if (a[1] === "edit") { s[a[2]].draft = !a.includes("--draft=false"); }
fs.writeFileSync(${JSON.stringify(ghState)}, JSON.stringify(s));
`,
    { mode: 0o755 },
  );
  const commit = (message) => {
    run("git", ["add", "-A"]);
    run("git", [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      message,
    ]);
    run("git", ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    return run("git", ["rev-parse", "HEAD"]);
  };
  run("git", ["init", "-q", "-b", "main"]);
  run("git", ["remote", "add", "origin", origin]);
  const tag = (sha, extraEnv = {}) => {
    const out = join(dir, `out-${Math.random()}`);
    writeFileSync(out, "");
    const res = spawnSync(process.execPath, ["scripts/release/release-version.mjs", "tag"], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_SHA: sha,
        GITHUB_OUTPUT: out,
        ...extraEnv,
      },
    });
    return {
      status: res.status,
      out: Object.fromEntries(
        readFileSync(out, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("=")),
      ),
    };
  };
  const remoteTag = (name) => run("git", ["rev-parse", `${name}^{commit}`], origin);
  const releases = () => JSON.parse(readFileSync(ghState, "utf8"));
  const deleteRelease = (t) => {
    run("git", ["push", "-q", "origin", `:refs/tags/${t}`]);
    const st = JSON.parse(readFileSync(ghState, "utf8"));
    delete st[t];
    writeFileSync(ghState, JSON.stringify(st));
  };
  const publish = (t) => execFileSync(join(bin, "gh"), ["release", "edit", t, "--draft=false"]);
  const gh = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "");
  const imageMetaRun = (sha, version) =>
    spawnSync(
      process.execPath,
      ["scripts/release/release-version.mjs", "image-meta", "--version", version],
      {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: "" },
      },
    );
  const remoteTags = () => run("git", ["ls-remote", "--tags", origin]);
  return {
    dir,
    commit,
    imageMetaRun,
    tag,
    remoteTag,
    remoteTags,
    releases,
    publish,
    deleteRelease,
    gh,
    setVersion,
  };
}

test("tag: one annotated v<version> on GITHUB_SHA and a DRAFT release; done once published", () => {
  const box = sandbox("1.0.0-rc.1");
  try {
    const sha = box.commit("chore(release): version packages");
    assert.deepEqual(box.tag(sha).out, {
      released: "true",
      version: "1.0.0-rc.1",
      tag: "v1.0.0-rc.1",
      prerelease: "true",
      floating: "",
    });
    assert.equal(box.remoteTag("v1.0.0-rc.1"), sha);
    assert.deepEqual(
      {
        draft: box.releases()["v1.0.0-rc.1"].draft,
        prerelease: box.releases()["v1.0.0-rc.1"].prerelease,
      },
      { draft: true, prerelease: true },
    );
    assert.match(box.releases()["v1.0.0-rc.1"].notes, /- notes for 1\.0\.0-rc\.1/u);
    // While the release is a draft, a re-run on the same commit resumes (the image is not done).
    assert.equal(box.tag(sha).out.released, "true");
    box.publish("v1.0.0-rc.1");
    assert.deepEqual(box.tag(sha).out, { released: "false", version: "1.0.0-rc.1" });
    // A later push with the same version releases nothing.
    const later = box.commit("fix: something else");
    assert.deepEqual(box.tag(later).out, { released: "false", version: "1.0.0-rc.1" });
    assert.equal(box.remoteTag("v1.0.0-rc.1"), sha);
    assert.equal(box.gh().match(/release create/gu).length, 1);
    // A stable version after it takes every floating tag.
    box.setVersion("1.0.0");
    const stable = box.commit("chore(release): version packages");
    assert.equal(box.tag(stable).out.floating, "minor major latest");
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("tag: a failed release call after the tag push resumes on re-run instead of stranding", () => {
  const box = sandbox("1.0.0");
  try {
    const sha = box.commit("chore(release): version packages");
    const failed = box.tag(sha, { GH_FAIL: "1" });
    assert.notEqual(failed.status, 0);
    assert.equal(box.remoteTag("v1.0.0"), sha, "the tag was pushed before the failure");
    const retried = box.tag(sha);
    assert.equal(retried.status, 0);
    assert.equal(retried.out.released, "true");
    assert.equal(box.releases()["v1.0.0"].draft, true);
    // Only one tag push: the resume did not try to tag again.
    assert.equal(box.remoteTag("v1.0.0"), sha);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("tag: reads the version from the commit, not a tree the version step already bumped", () => {
  const box = sandbox("0.0.0");
  try {
    const first = box.commit("feat: something with a changeset");
    // What changesets/action does in the same checkout: bump, uncommitted.
    box.setVersion("0.1.0");
    const dirty = box.tag(first);
    assert.equal(dirty.status, 0);
    assert.deepEqual(dirty.out, { released: "false", version: "0.0.0" });
    assert.equal(box.remoteTags(), "", "no tag for the dirty version");
    // The version PR merges: now the commit carries 0.1.0, and it is tagged there.
    const merge = box.commit("chore(release): version packages");
    assert.equal(box.tag(merge).out.released, "true");
    assert.equal(box.remoteTag("v0.1.0"), merge);
    assert.match(box.releases()["v0.1.0"].notes, /notes for 0\.1\.0/u);
    box.publish("v0.1.0");
    // Next feature push with a pending bump to 0.2.0 in the tree: nothing.
    const next = box.commit("feat: more");
    box.setVersion("0.2.0");
    assert.deepEqual(box.tag(next).out, { released: "false", version: "0.1.0" });
    assert.doesNotMatch(box.remoteTags(), /v0\.2\.0/u);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("tag: after a failure before Apply tags, deleting the draft and the tag lets a re-run re-tag cleanly", () => {
  const box = sandbox("1.0.0");
  try {
    const sha = box.commit("chore(release): version packages");
    assert.equal(box.tag(sha).out.released, "true");
    assert.equal(box.imageMetaRun(sha, "1.0.0").status, 0);
    // The tag was deleted (the fix ships as a new version): "Re-run failed jobs" would re-run
    // only the image job with the stale released=true. image-meta refuses before any build.
    box.deleteRelease("v1.0.0");
    const stale = box.imageMetaRun(sha, "1.0.0");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /v1\.0\.0 is not on origin/u);
    // A tag on another commit is refused too.
    const later = box.commit("fix: later");
    assert.match(box.imageMetaRun(later, "1.0.0").stderr, /not on origin|is on/u);
    const again = box.tag(sha); // "Re-run all jobs" on the same commit re-tags it
    assert.equal(again.status, 0);
    assert.equal(again.out.released, "true");
    assert.equal(box.remoteTag("v1.0.0"), sha);
    assert.equal(box.releases()["v1.0.0"].draft, true);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("tag: a first release whose notes exceed GitHub's body limit still creates the draft", () => {
  const box = sandbox("1.0.0-rc.0");
  try {
    const big = Array.from({ length: 800 }, (_, i) => `- change ${i} ${"y".repeat(200)}`).join(
      "\n",
    );
    writeFileSync(
      join(box.dir, "work/apps/server/CHANGELOG.md"),
      `# @fundroom/server\n\n## 1.0.0-rc.0\n\n${big}\n`,
    );
    const sha = box.commit("chore(release): version packages");
    const res = box.tag(sha);
    assert.equal(res.status, 0);
    assert.equal(res.out.released, "true");
    const notes = box.releases()["v1.0.0-rc.0"].notes;
    assert.ok(notes.length <= RELEASE_BODY_MAX);
    assert.match(notes, /^- change 0 /u);
    assert.match(notes, /…and more: the full notes are in/u);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test("tag: 0.0.0 releases nothing", () => {
  const box = sandbox("0.0.0");
  try {
    const sha = box.commit("init");
    assert.deepEqual(box.tag(sha).out, { released: "false", version: "0.0.0" });
    assert.equal(box.gh(), "");
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});
