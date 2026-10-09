#!/usr/bin/env node
/*
 * Release tagging and image tags (E-UP-14). Commands, all used by the workflows:
 *
 *   tag [--dry-run]                                   (release.yml, every push to main)
 *     The release is the version of apps/server/package.json (Changesets' fixed group moves every
 *     core package together). It releases when that version (not 0.0.0) has no `v<version>` tag on
 *     origin yet: annotated tag on GITHUB_SHA (the commit this run builds and signs, so the
 *     signature's workflow SHA is the tag's commit), pushed, and a DRAFT GitHub release from the
 *     version's CHANGELOG section (cut to fit GitHub's body limit, linking the rest). It also resumes when the tag is on this commit and the release
 *     is missing or still a draft. Outputs `released`, `version`, `tag`, `prerelease`, `floating`.
 *     One tag per release, not per package: `changeset publish` is never run (its per-package
 *     tags are not release tags). The two public packages, @fundroomhq/tokens and @fundroomhq/ui, are
 *     published at this version by publish-packages.mjs after the image (ADR-0067).
 *
 *   image-meta [--version <v>] [--floating "minor major latest"]          (image.yml, meta job)
 *     Tag NAMES: a release gets `X.Y.Z`, plus `X.Y`/`X`/`latest` as --floating allows, and never
 *     for a prerelease; otherwise `edge` on a push to main, else `sha-<sha7>`. Also the
 *     FUNDROOM_VERSION build-arg (OCI version label): the release version, or
 *     `<package version>+git.<sha7>`. Outputs `tags` (space-separated), `guard` (the tag that may
 *     never move), `oci-version`, `release`, `prerelease`, `latest`.
 *
 *   push-index --image <repo> --digest <d> [--digest <d>…]                (image.yml, manifest)
 *     Merges the per-arch images into one index and pushes it BY DIGEST, untagged (oras).
 *
 *   apply-tags --image <repo> --digest <d> --tags "<names>" [--guard X.Y.Z]   (last step)
 *     After Trivy, signing and attestations: refuses if the guard tag already names another
 *     digest, tags the digest (`oras tag` keeps the manifest bytes, so the digest is the one
 *     signed), and checks every tag resolves to it.
 *
 * Image tags never carry the git tag's `v`. No dependencies; runs on the runner's stock Node.
 * ORAS_BIN and DOCKER_BIN override the tools (tests). Tested in release-version.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** SemVer 2.0.0 without build metadata: the same pattern fundroom-web's release:verify uses. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

/** @param {string} version */
export function parseVersion(version) {
  const m = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!m) throw new Error(`"${version}" is not a release version (SemVer X.Y.Z or X.Y.Z-pre).`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** @param {string} version */
export const isPrerelease = (version) => parseVersion(version).prerelease !== null;

/** @param {string} version */
export function gitTag(version) {
  parseVersion(version);
  return `v${version}`;
}

/** Compares two stable versions (prereleases are never compared here). */
function compareStable(/** @type {string} */ a, /** @type {string} */ b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/**
 * Whether `version` may move `latest`: no prerelease part, and no higher stable `v<semver>` tag
 * among `tags` (refs or names; anything that is not a release tag is ignored).
 *
 * @param {string} version
 * @param {string[]} tags
 */
export function isNewestStable(version, tags) {
  if (isPrerelease(version)) return false;
  for (const raw of tags) {
    const name = raw.replace(/^refs\/tags\//u, "").replace(/\^\{\}$/u, "");
    if (!name.startsWith("v")) continue;
    const v = name.slice(1);
    if (!SEMVER.test(v) || isPrerelease(v)) continue;
    if (compareStable(v, version) > 0) return false;
  }
  return true;
}

/** `refs/tags/vX.Y.Z` (or a peeled `^{}` ref) → `X.Y.Z` when it is a stable release, else null. */
function stableOf(/** @type {string} */ raw) {
  const name = raw.replace(/^refs\/tags\//u, "").replace(/\^\{\}$/u, "");
  if (!name.startsWith("v")) return null;
  const v = name.slice(1);
  return SEMVER.test(v) && !isPrerelease(v) ? v : null;
}

/**
 * Which moving image tags this release may take: `X.Y` only if no higher patch of X.Y is tagged,
 * `X` only if no higher X.* is tagged (and never `0`), `latest` only for the highest stable
 * release. A prerelease takes none. `latest` does move for 0.x (deliberately: there is no 1.x).
 *
 * @param {string} version
 * @param {string[]} tags  remote tag refs or names
 */
export function floatingTags(version, tags) {
  const v = parseVersion(version);
  const none = { minor: false, major: false, latest: false };
  if (v.prerelease !== null) return none;
  const stable = tags
    .map(stableOf)
    .filter((x) => x !== null)
    .map((x) => parseVersion(x));
  const higher = (/** @type {ReturnType<typeof parseVersion>} */ o) =>
    compareStable(`${o.major}.${o.minor}.${o.patch}`, version) > 0;
  return {
    minor: !stable.some((o) => o.major === v.major && o.minor === v.minor && higher(o)),
    major: v.major > 0 && !stable.some((o) => o.major === v.major && higher(o)),
    latest: isNewestStable(version, tags),
  };
}

/**
 * What the release step does for this push. Releases when apps/server's version has no tag yet,
 * or when its tag is on THIS commit and the release is unfinished (no GitHub release, or still a
 * draft: the draft is published only after the image is signed and tagged). It does not look at
 * whether changesets are pending, so a run cancelled under the concurrency group, or a step that
 * failed after pushing the tag, never strands a version.
 *
 * @param {{ version: string, sha: string, remoteTagSha: string | null,
 *   releaseState?: "missing" | "draft" | "published" }} input
 * @returns {{ release: false, reason: string } |
 *   { release: true, tag: string, prerelease: boolean, createTag: boolean, createRelease: boolean }}
 */
export function planTag({ version, sha, remoteTagSha, releaseState }) {
  parseVersion(version);
  if (version === "0.0.0") {
    return { release: false, reason: "apps/server is still 0.0.0: nothing has been versioned yet" };
  }
  const tag = gitTag(version);
  const prerelease = isPrerelease(version);
  if (remoteTagSha === null) {
    return { release: true, tag, prerelease, createTag: true, createRelease: true };
  }
  if (remoteTagSha !== sha) {
    return { release: false, reason: `${tag} is on ${remoteTagSha}: nothing new to release` };
  }
  if (releaseState === "published") {
    return { release: false, reason: `${tag} is already released` };
  }
  if (releaseState !== "draft" && releaseState !== "missing") {
    throw new Error(`${tag} is on this commit; its GitHub release state is needed to resume.`);
  }
  return {
    release: true,
    tag,
    prerelease,
    createTag: false,
    createRelease: releaseState === "missing",
  };
}

/**
 * The image's tags (names, no repository) and OCI version label. The first tag is the one that
 * must never move: `X.Y.Z` for a release.
 *
 * @param {{ version?: string, floating?: { minor?: boolean, major?: boolean, latest?: boolean },
 *   packageVersion: string, sha: string, ref: string, event: string }} input
 */
export function imageMeta({ version, floating = {}, packageVersion, sha, ref, event }) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`"${sha}" is not a commit SHA.`);
  const short = sha.slice(0, 7);
  if (version) {
    const v = parseVersion(version);
    if (version !== packageVersion) {
      throw new Error(
        `Asked to release ${version}, but apps/server/package.json at ${short} is ${packageVersion}.`,
      );
    }
    if (version === "0.0.0") throw new Error("0.0.0 is not a release.");
    const tags = [version];
    const stable = v.prerelease === null;
    if (stable && floating.minor) tags.push(`${v.major}.${v.minor}`);
    if (stable && floating.major && v.major > 0) tags.push(String(v.major));
    if (stable && floating.latest) tags.push("latest");
    return {
      release: true,
      prerelease: !stable,
      latest: tags.includes("latest"),
      tags,
      ociVersion: version,
    };
  }
  parseVersion(packageVersion);
  const tag = ref === "refs/heads/main" && event === "push" ? "edge" : `sha-${short}`;
  return {
    release: false,
    prerelease: false,
    latest: false,
    tags: [tag],
    ociVersion: `${packageVersion}+git.${short}`,
  };
}

/**
 * Before any tag is applied: a release's own version tag must be absent or already on `digest`.
 * A re-run builds a new digest; moving `X.Y.Z` to it would make every pin of the old one an alarm.
 *
 * @param {{ guard: string | null, existing: string | null, digest: string }} input
 */
export function checkGuard({ guard, existing, digest }) {
  if (guard && existing && existing !== digest) {
    throw new Error(
      `${guard} is already published at ${existing}; refusing to move it to ${digest}. ` +
        'A release tag never moves (docs/runbooks/releasing.md, "When something fails").',
    );
  }
}

/**
 * The body of `## <version>` in a Changesets CHANGELOG, up to the next `## ` heading.
 *
 * @param {string} changelog
 * @param {string} version
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * GitHub refuses a release body over 125,000 characters ("body is too long"), which would fail
 * the tag step AFTER the tag push, on every resume too. The first release's section holds every
 * changeset since the start (~130,000 characters for 1.0.0-rc.0). Measured in UTF-16 units,
 * which never undercount, with a margin.
 */
export const RELEASE_BODY_MAX = 120_000;

/**
 * The GitHub release body: the notes, then the image line. Notes that would push it over
 * RELEASE_BODY_MAX are cut before the last top-level entry (`- `) or heading that fits, and end
 * with a link to the whole section in the CHANGELOG at the tag.
 *
 * @param {{ notes: string, version: string, image: string, repository: string,
 *   max?: number }} input
 */
export function releaseBody({ notes, version, image, repository, max = RELEASE_BODY_MAX }) {
  const tail = `\n\nImage: \`${image}:${version}\` (signed by the \`Release\` workflow; verify before you deploy, docs/runbooks/install-and-upgrade.md).\n`;
  if (notes.length + tail.length <= max) return `${notes}${tail}`;
  const more = `\n\n…and more: the full notes are in [apps/server/CHANGELOG.md](https://github.com/${repository}/blob/${gitTag(version)}/apps/server/CHANGELOG.md#${version.replaceAll(".", "")}).`;
  const budget = max - tail.length - more.length;
  if (budget <= 0) throw new Error(`release body limit ${max} is too small`);
  const lines = notes.split("\n");
  let kept = 0;
  let length = 0;
  let cut = 0;
  for (const [i, line] of lines.entries()) {
    const next = length + line.length + (i === 0 ? 0 : 1);
    if (next > budget) break;
    length = next;
    kept = i + 1;
    // A boundary is just before a top-level entry or a heading, so no entry is cut in half.
    if (lines[i + 1] !== undefined && /^(- |#)/u.test(lines[i + 1] ?? "")) cut = kept;
  }
  const body = lines
    .slice(0, cut > 0 ? cut : kept)
    .join("\n")
    .trimEnd();
  return `${body}${more}${tail}`;
}

// --- I/O -------------------------------------------------------------------------------------

/**
 * A file AS COMMITTED at `sha`, never the working tree: changesets/action runs `changeset version`
 * in the same checkout, so while changesets are pending the tree already holds the NEXT version.
 * null when the file does not exist at that commit.
 */
function fileAt(/** @type {string} */ sha, /** @type {string} */ path) {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}
const coreVersionAt = (/** @type {string} */ sha) => {
  const text = fileAt(sha, "apps/server/package.json");
  if (text === null) throw new Error(`apps/server/package.json does not exist at ${sha}`);
  return JSON.parse(text).version;
};

/** @param {Record<string, string | boolean>} outputs */
function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([k, v]) => {
    const s = String(v);
    return s.includes("\n") ? `${k}<<__EOF__\n${s}\n__EOF__` : `${k}=${s}`;
  });
  if (actionsEnv("GITHUB_OUTPUT"))
    appendFileSync(actionsEnv("GITHUB_OUTPUT"), `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The Actions runner's variables (read by name: they are not turbo task inputs). */
const actionsEnv = (/** @type {string} */ name) => process.env[name] || "";

const git = (/** @type {string[]} */ args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** The SHA a remote tag points at (peeled for an annotated tag), or null. */
export function remoteTagSha(/** @type {string} */ lsRemote, /** @type {string} */ tag) {
  let direct = null;
  for (const line of lsRemote.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (ref === `refs/tags/${tag}^{}`) return sha ?? null;
    if (ref === `refs/tags/${tag}`) direct = sha ?? null;
  }
  return direct;
}

/** @returns {"missing" | "draft" | "published"} */
function releaseState(/** @type {string} */ tag) {
  try {
    const out = execFileSync(
      "gh",
      ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return out === "true" ? "draft" : "published";
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? "");
    if (/not found/iu.test(stderr)) return "missing";
    throw error;
  }
}

function tagCommand(/** @type {boolean} */ dryRun) {
  const sha = actionsEnv("GITHUB_SHA") || git(["rev-parse", "HEAD"]);
  const version = coreVersionAt(sha);
  const treeVersion = JSON.parse(
    readFileSync(join(ROOT, "apps/server/package.json"), "utf8"),
  ).version;
  if (treeVersion !== version) {
    // Expected when the version step ran first in this checkout; the commit is what is released.
    console.error(
      `note: the working tree says ${treeVersion} (a pending version bump); ${sha} is ${version}, which is what counts`,
    );
  }
  const lsRemote = git(["ls-remote", "--tags", "origin", "refs/tags/v*"]);
  const remoteTags = lsRemote
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1] ?? "");
  const tagName = version === "0.0.0" ? null : gitTag(version);
  const onRemote = tagName === null ? null : remoteTagSha(lsRemote, tagName);
  const plan = planTag({
    version,
    sha,
    remoteTagSha: onRemote,
    releaseState: tagName !== null && onRemote === sha ? releaseState(tagName) : undefined,
  });
  if (!plan.release) {
    console.error(plan.reason);
    writeOutputs({ released: false, version });
    return;
  }
  const floating = floatingTags(version, remoteTags);
  const changelog = fileAt(sha, "apps/server/CHANGELOG.md");
  const notes = (changelog !== null && releaseNotes(changelog, version)) || `FundRoom ${version}.`;
  const repository = actionsEnv("GITHUB_REPOSITORY") || "fundroomhq/fundroom";
  const image = `ghcr.io/${repository.toLowerCase()}`;
  const body = releaseBody({ notes, version, image, repository });
  if (dryRun) {
    console.error(`dry run: ${JSON.stringify(plan)} at ${sha}`);
  } else {
    if (plan.createTag) {
      git([
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898283+github-actions[bot]@users.noreply.github.com",
        "tag",
        "-f", // only the local ref: a tag deleted on origin after a failed release (releasing.md) may linger here
        "-a",
        plan.tag,
        sha,
        "-m",
        `FundRoom ${version}`,
      ]);
      git(["push", "origin", `refs/tags/${plan.tag}`]);
    }
    if (plan.createRelease) {
      // A draft: image.yml's release-assets job publishes it once the image is signed and tagged.
      execFileSync(
        "gh",
        [
          "release",
          "create",
          plan.tag,
          "--verify-tag",
          "--draft",
          "--title",
          plan.tag,
          "--notes-file",
          "-",
          ...(plan.prerelease ? ["--prerelease"] : []),
        ],
        { cwd: ROOT, input: body, stdio: ["pipe", "inherit", "inherit"] },
      );
    }
  }
  writeOutputs({
    released: true,
    version,
    tag: plan.tag,
    prerelease: plan.prerelease,
    floating: Object.entries(floating)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join(" "),
  });
}

/** @param {string} floating  space-separated subset of "minor major latest" */
export function parseFloating(floating) {
  const words = new Set(
    String(floating ?? "")
      .split(/\s+/u)
      .filter(Boolean),
  );
  for (const w of words) {
    if (!["minor", "major", "latest"].includes(w)) throw new Error(`unknown floating tag "${w}"`);
  }
  return { minor: words.has("minor"), major: words.has("major"), latest: words.has("latest") };
}

/**
 * A release build needs its git tag on origin, on the commit being built. It is checked before
 * anything is built: after `gh release delete --cleanup-tag`, "Re-run failed jobs" would re-run
 * only the image job with the old `released=true` and publish an image with no tag or release.
 *
 * @param {{ version: string, sha: string, remoteTagSha: string | null }} input
 */
export function checkReleaseTag({ version, sha, remoteTagSha }) {
  const tag = gitTag(version);
  if (remoteTagSha === null) {
    throw new Error(
      `${tag} is not on origin: refusing to build release ${version}. If the tag was deleted, re-run all jobs (docs/runbooks/releasing.md).`,
    );
  }
  if (remoteTagSha !== sha) {
    throw new Error(
      `${tag} is on ${remoteTagSha}, not on ${sha}: refusing to build release ${version}.`,
    );
  }
}

function imageMetaCommand(/** @type {Record<string, any>} */ values) {
  if (values.version) {
    const sha = actionsEnv("GITHUB_SHA") || git(["rev-parse", "HEAD"]);
    const tag = gitTag(values.version);
    const lsRemote = git([
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]);
    checkReleaseTag({ version: values.version, sha, remoteTagSha: remoteTagSha(lsRemote, tag) });
  }
  const meta = imageMeta({
    version: values.version || undefined,
    floating: parseFloating(values.floating),
    packageVersion: coreVersionAt(actionsEnv("GITHUB_SHA") || git(["rev-parse", "HEAD"])),
    sha: actionsEnv("GITHUB_SHA") || git(["rev-parse", "HEAD"]),
    ref: actionsEnv("GITHUB_REF") || "",
    event: actionsEnv("GITHUB_EVENT_NAME") || "",
  });
  writeOutputs({
    tags: meta.tags.join(" "),
    guard: meta.release ? meta.tags[0] : "",
    "oci-version": meta.ociVersion,
    release: meta.release,
    prerelease: meta.prerelease,
    latest: meta.latest,
  });
}

// --- registry: oras pushes the index untagged and tags it last ----------------------------------

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const tool = (/** @type {string} */ name, /** @type {string} */ fallback) =>
  actionsEnv(name) || fallback;

/** `oras resolve <image>:<tag>` → digest, or null when the tag does not exist. */
function resolveTag(/** @type {string} */ image, /** @type {string} */ tag) {
  try {
    const out = execFileSync(tool("ORAS_BIN", "oras"), ["resolve", `${image}:${tag}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!DIGEST.test(out))
      throw new Error(`oras resolve ${image}:${tag} said ${JSON.stringify(out)}`);
    return out;
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? "");
    if (/not ?found|manifest unknown/iu.test(stderr)) return null;
    throw error;
  }
}

/**
 * Merges the per-arch digests into one index and pushes it by digest, with NO tag: nothing points
 * at the image until it has been scanned, signed and attested (apply-tags, the last step).
 */
function pushIndexCommand(/** @type {Record<string, any>} */ values) {
  const image = String(values.image ?? "");
  const digests = /** @type {string[]} */ (values.digest ?? []);
  if (!image || digests.length === 0 || !digests.every((d) => DIGEST.test(d))) {
    throw new Error("push-index needs --image and one --digest sha256:… per platform");
  }
  const index = execFileSync(
    tool("DOCKER_BIN", "docker"),
    ["buildx", "imagetools", "create", "--dry-run", ...digests.map((d) => `${image}@${d}`)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const mediaType = JSON.parse(index).mediaType;
  const file = join(mkdtempSync(join(tmpdir(), "index-")), "index.json");
  writeFileSync(file, index);
  const digest = `sha256:${createHash("sha256").update(index).digest("hex")}`;
  execFileSync(
    tool("ORAS_BIN", "oras"),
    ["manifest", "push", "--media-type", mediaType, `${image}@${digest}`, file],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  writeOutputs({ digest });
}

/** Tags the signed digest: refuses to move the release's own tag, then checks every tag landed. */
function applyTagsCommand(/** @type {Record<string, any>} */ values) {
  const image = String(values.image ?? "");
  const digest = String(values.digest ?? "");
  const tags = String(values.tags ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  const guard = values.guard ? String(values.guard) : null;
  if (!image || !DIGEST.test(digest) || tags.length === 0) {
    throw new Error("apply-tags needs --image, --digest sha256:… and --tags");
  }
  if (guard && !tags.includes(guard)) throw new Error(`--guard ${guard} is not among --tags`);
  checkGuard({ guard, existing: guard ? resolveTag(image, guard) : null, digest });
  execFileSync(tool("ORAS_BIN", "oras"), ["tag", `${image}@${digest}`, ...tags], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (const tag of tags) {
    const now = resolveTag(image, tag);
    if (now !== digest) throw new Error(`${image}:${tag} resolves to ${now}, not ${digest}`);
  }
  process.stderr.write(`tagged ${image}@${digest}: ${tags.join(", ")}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      image: { type: "string" },
      version: { type: "string" },
      floating: { type: "string" },
      digest: { type: "string", multiple: true },
      tags: { type: "string" },
      guard: { type: "string" },
    },
  });
  const [command] = positionals;
  if (command === "tag") return tagCommand(Boolean(values["dry-run"]));
  if (command === "image-meta") return imageMetaCommand(values);
  if (command === "push-index") return pushIndexCommand(values);
  if (command === "apply-tags") {
    return applyTagsCommand({ ...values, digest: values.digest?.[0] });
  }
  throw new Error(
    "usage: release-version.mjs tag [--dry-run] | image-meta [--version <v>] [--floating <list>] |\n" +
      "  push-index --image <repo> --digest <d>… | apply-tags --image <repo> --digest <d> --tags <list> [--guard <tag>]",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
