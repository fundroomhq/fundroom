#!/usr/bin/env node
/*
 * Pack and publish @fundroomhq/tokens and @fundroomhq/ui (A-6, ADR-0067). Two commands, one per
 * release.yml job, both after the image job succeeded (no package for a version whose image
 * failed). The split keeps the npm credentials (OIDC token, NPM_TOKEN) away from the install and
 * the build: nothing that runs dependency code ever sees them.
 *
 *   pack --version <v> --out <dir> [--sha <sha>]                   (job `pack-packages`)
 *     No npm, no credentials. Both packages' versions AS COMMITTED at --sha (default GITHUB_SHA,
 *     else HEAD) must equal --version (the `tag` job's output); read with `git show`, never the
 *     working tree (a checkout that ran changesets/action holds the NEXT version). The files
 *     packing reads (the packages, PACK_INPUTS) must equal the commit's, tracked and untracked,
 *     before and after packing. Packs both (`pnpm pack` resolves `workspace:`/`catalog:`), runs
 *     pack-check's tarball checks, checks the packed versions, and copies the tarballs to --out.
 *
 *   publish --version <v> --dir <dir> [--floating "<words>"] [--dry-run]   (job `publish-packages`)
 *     No install, no build: runs only `npm view` and `npm publish <tgz>`. Takes the tarballs from
 *     --dir in publish order (tokens, then ui: ui depends on tokens at the exact version), checks
 *     each one's name and version (and that nothing is left unresolved), skips a `name@version`
 *     already on npm, so a re-run finishes a partial publish, and publishes the rest with
 *     provenance (publishConfig). Dist-tag:
 *       - prerelease: `next`, or `next-X.Y` when a higher version is already published;
 *       - stable: `latest` when --floating contains `latest` (the tag job's rule, the one that
 *         moves the image's `latest`), else `release-X.Y`, so a backport never moves `latest`.
 *     Auth: trusted publishing (OIDC; `id-token: write`, npm >= 11.5.1, refused loudly below
 *     that). NODE_AUTH_TOKEN (first publish only; a trusted publisher needs an existing
 *     package) is removed from this process's environment at start and handed to `npm publish`
 *     alone, through a throwaway userconfig that references it (the token never touches disk).
 *     --dry-run: `npm publish --dry-run`, no npm version floor. --no-provenance: only for the
 *     runbook's manual fallback outside Actions (npm cannot attest provenance there).
 *
 * NPM_BIN and PNPM_BIN override the tools (tests). Tested in publish-packages.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  PUBLISHED,
  packAndCheck,
  privateDependencies,
  readTarball,
  unresolvedProtocols,
  // biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
} from "./pack-check.mjs";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test.
import { parseFloating, parseVersion } from "./release-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Workspace files `pnpm pack` and ui's build read besides the packages themselves. */
export const PACK_INPUTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
];

/** Trusted publishing needs npm >= 11.5.1 (docs.npmjs.com/trusted-publishers). */
export const MIN_NPM = "11.5.1";

/** @param {string} a @param {string} b  plain X.Y.Z comparison */
export function versionAtLeast(a, b) {
  const x = a
    .trim()
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

/**
 * SemVer 2.0.0 precedence: < 0, 0, > 0. A prerelease sorts below its release; identifiers
 * compare numerically when both are numeric, numeric below alphanumeric, else as ASCII.
 *
 * @param {string} a @param {string} b
 */
export function compareSemver(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return core;
  if (x.prerelease === null || y.prerelease === null)
    return (x.prerelease === null ? 1 : 0) - (y.prerelease === null ? 1 : 0);
  const p = x.prerelease.split(".");
  const q = y.prerelease.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const s = p[i];
    const t = q[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const sn = /^\d+$/u.test(s);
    const tn = /^\d+$/u.test(t);
    if (sn && tn && Number(s) !== Number(t)) return Number(s) - Number(t);
    if (sn !== tn) return sn ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

/**
 * The npm dist-tag for a release.
 *
 * @param {string} version
 * @param {{ latest: boolean }} floating  the tag job's rule (stable releases only)
 * @param {string[]} published  versions already on npm for this package
 */
export function distTag(version, floating, published = []) {
  const v = parseVersion(version);
  if (v.prerelease !== null) {
    const higher = published.some((p) => SEMVER_SAFE(p) && compareSemver(p, version) > 0);
    return higher ? `next-${v.major}.${v.minor}` : "next";
  }
  return floating.latest ? "latest" : `release-${v.major}.${v.minor}`;
}

/** Registry versions that are not SemVer (ancient junk) never decide a tag. */
const SEMVER_SAFE = (/** @type {string} */ v) => {
  try {
    parseVersion(v);
    return true;
  } catch {
    return false;
  }
};

/**
 * The versions `npm view <name> versions --json` reports. E404 (no such package) → [];
 * anything else that fails (network, auth, registry error) throws, so an outage never turns into
 * a blind publish.
 *
 * @param {{ status: number | null, stdout: string, stderr: string }} r
 * @returns {string[]}
 */
export function parseVersions(r) {
  let json;
  try {
    json = r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  if (r.status === 0) {
    if (Array.isArray(json) && json.every((v) => typeof v === "string")) return json;
    if (typeof json === "string") return [json]; // npm prints a single version as a string
    throw new Error(`npm view versions answered ${JSON.stringify(json)}`);
  }
  if (json?.error?.code === "E404" || /\bE404\b/u.test(r.stderr)) return [];
  throw new Error(
    `npm view failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
  );
}

/** The tarball `pnpm pack` writes for a package, e.g. `fundroomhq-tokens-1.0.0-rc.1.tgz`. */
export const tarballName = (/** @type {string} */ name, /** @type {string} */ version) =>
  `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;

/**
 * What a tarball's packed manifest must say before it is published.
 *
 * @param {Record<string, any>} manifest @param {string} name @param {string} version
 */
export function tarballProblems(manifest, name, version) {
  const problems = [];
  if (manifest.name !== name) problems.push(`is ${manifest.name}, not ${name}`);
  if (manifest.version !== version) problems.push(`is version ${manifest.version}, not ${version}`);
  if (manifest.private === true) problems.push("is private");
  for (const p of unresolvedProtocols(manifest)) problems.push(`has unresolved ${p}`);
  problems.push(...privateDependencies(manifest));
  return problems.map((p) => `${name}: ${p}`);
}

/**
 * Refuses committed versions the fixed group did not move to the release.
 *
 * @param {{ name: string, committed: string }[]} pkgs @param {string} version
 */
export function checkCommitted(pkgs, version) {
  const wrong = pkgs.filter((p) => p.committed !== version);
  if (wrong.length > 0) {
    throw new Error(
      `committed versions ${wrong.map((p) => `${p.name}@${p.committed}`).join(", ")} are not the release ${version}; the fixed group must move them together (.changeset/config.json)`,
    );
  }
}

/**
 * Takes NODE_AUTH_TOKEN out of `env` (so no child process inherits it) and returns it.
 *
 * @param {Record<string, string | undefined>} env
 */
export function takeToken(env) {
  const token = env.NODE_AUTH_TOKEN ?? "";
  delete env.NODE_AUTH_TOKEN;
  return token;
}

/** The runner's variables, read by name (they are not turbo task inputs). */
const envVar = (/** @type {string} */ name) => process.env[name] || "";
const tool = (/** @type {string} */ env, /** @type {string} */ name) => envVar(env) || name;

/** @param {string} name @param {string} cwd */
function registryVersions(name, cwd) {
  try {
    const stdout = execFileSync(
      tool("NPM_BIN", "npm"),
      ["view", name, "versions", "--json", "--prefer-online"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseVersions({ status: 0, stdout, stderr: "" });
  } catch (error) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string }} */ (error);
    if (typeof e.status !== "number") throw error;
    return parseVersions({
      status: e.status,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    });
  }
}

const git = (/** @type {string[]} */ args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** `pack`: see the header. */
function packCommand(/** @type {{ version: string, out: string, sha?: string }} */ o) {
  const sha = git(["rev-parse", "--verify", `${o.sha || envVar("GITHUB_SHA") || "HEAD"}^{commit}`]);
  checkCommitted(
    PUBLISHED.map(({ name, dir }) => ({
      name,
      committed: JSON.parse(git(["show", `${sha}:${dir}/package.json`])).version,
    })),
    o.version,
  );
  // What `pnpm pack` reads must be the commit's: the packages and the workspace files they resolve
  // `catalog:`/`workspace:` and the tsconfig from. Checked again after packing (prepack builds).
  const inputs = [...PUBLISHED.map((p) => p.dir), ...PACK_INPUTS];
  const assertClean = (/** @type {string} */ when) => {
    const changed = git(["diff", "--name-only", sha, "--", ...inputs]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...inputs]);
    const all = [changed, untracked].filter(Boolean).join("\n");
    if (all !== "") throw new Error(`${when}, the checkout differs from ${sha} in:\n${all}`);
  };
  assertClean("before packing");
  const work = mkdtempSync(join(tmpdir(), "fundroom-pack-"));
  try {
    const { tarballs, problems } = packAndCheck(work);
    for (const [name, t] of Object.entries(tarballs))
      problems.push(...tarballProblems(t.manifest, name, o.version));
    assertClean("after packing (stale codegen?)");
    if (problems.length > 0) throw new Error(`refusing to pack:\n- ${problems.join("\n- ")}`);
    mkdirSync(o.out, { recursive: true });
    for (const { name } of PUBLISHED) {
      const tgz = /** @type {{ tgz: string }} */ (tarballs[name]).tgz;
      if (basename(tgz) !== tarballName(name, o.version))
        throw new Error(`pnpm pack wrote ${basename(tgz)}, not ${tarballName(name, o.version)}`);
      copyFileSync(tgz, join(o.out, basename(tgz)));
      process.stdout.write(`packed ${join(o.out, basename(tgz))}\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `publish`: see the header. */
function publishCommand(
  /** @type {{ version: string, dir: string, floating: string, dryRun: boolean, provenance: boolean }} */ o,
) {
  // The manual fallback only: inside Actions a dropped provenance would go unnoticed.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a release script, never a turbo task
  if (!o.provenance && process.env.GITHUB_ACTIONS === "true") {
    throw new Error("--no-provenance is for the runbook's manual fallback, never inside Actions");
  }
  const token = takeToken(process.env);
  const floating = parseFloating(o.floating);
  // npm runs outside the repo: its .npmrc carries pnpm-only keys npm warns about.
  const work = mkdtempSync(join(tmpdir(), "fundroom-publish-"));
  try {
    /** @type {NodeJS.ProcessEnv} */
    const publishEnv = { ...process.env };
    if (token !== "") {
      const userconfig = join(work, ".npmrc");
      // npm expands the variable itself, so the token never touches the disk.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an npmrc env reference, not a template
      writeFileSync(userconfig, "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n", {
        mode: 0o600,
      });
      publishEnv.NODE_AUTH_TOKEN = token;
      publishEnv.npm_config_userconfig = userconfig;
    }
    if (!o.dryRun) {
      const npmVersion = execFileSync(tool("NPM_BIN", "npm"), ["--version"], {
        cwd: work,
        encoding: "utf8",
      });
      if (!versionAtLeast(npmVersion, MIN_NPM))
        throw new Error(
          `npm ${npmVersion.trim()} cannot use trusted publishing; ${MIN_NPM} or later is required`,
        );
    }
    const pkgs = PUBLISHED.map(({ name }) => {
      const tgz = resolve(o.dir, tarballName(name, o.version));
      if (!existsSync(tgz)) throw new Error(`${tgz} is missing (the pack-packages artifact)`);
      return { name, tgz, manifest: readTarball(tgz).manifest };
    });
    const problems = pkgs.flatMap((p) => tarballProblems(p.manifest, p.name, o.version));
    if (problems.length > 0) throw new Error(`refusing to publish:\n- ${problems.join("\n- ")}`);

    const done = [];
    for (const { name, tgz } of pkgs) {
      const versions = registryVersions(name, work);
      if (versions.includes(o.version)) {
        process.stdout.write(`${name}@${o.version} is already on npm; skipped\n`);
        continue;
      }
      const tag = distTag(o.version, floating, versions);
      const args = ["publish", tgz, "--access", "public", "--tag", tag];
      if (o.dryRun) args.push("--dry-run");
      // The manual fallback (runbook) runs outside Actions, where npm cannot attest provenance; a
      // CLI flag beats publishConfig.provenance.
      if (!o.provenance) args.push("--provenance=false");
      process.stdout.write(`npm ${args.join(" ")}\n`);
      try {
        execFileSync(tool("NPM_BIN", "npm"), args, {
          cwd: work,
          env: publishEnv,
          stdio: "inherit",
        });
      } catch (error) {
        // The registry's read side can lag a publish from an earlier attempt.
        if (!o.dryRun && registryVersions(name, work).includes(o.version)) {
          process.stdout.write(`${name}@${o.version} turned out to be on npm already; skipped\n`);
          continue;
        }
        throw error;
      }
      done.push(`${name}@${o.version} (${tag})`);
    }
    process.stdout.write(
      done.length === 0
        ? `nothing to publish for ${o.version}\n`
        : `${o.dryRun ? "dry run: would publish" : "published"} ${done.join(", ")}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      floating: { type: "string", default: "" },
      sha: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-provenance": { type: "boolean", default: false },
    },
  });
  const version = String(values.version ?? "");
  parseVersion(version);
  const command = positionals[0];
  if (command === "pack") {
    if (!values.out) throw new Error("pack needs --out <dir>");
    packCommand({ version, out: resolve(values.out), ...(values.sha ? { sha: values.sha } : {}) });
  } else if (command === "publish") {
    if (!values.dir) throw new Error("publish needs --dir <dir with the tarballs>");
    publishCommand({
      version,
      dir: values.dir,
      floating: String(values.floating ?? ""),
      dryRun: Boolean(values["dry-run"]),
      provenance: !values["no-provenance"],
    });
  } else {
    throw new Error("usage: publish-packages.mjs pack|publish --version <v> … (see the header)");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
