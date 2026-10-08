#!/usr/bin/env node
/*
 * The npm packages, packed and used the way a consumer would (A-6, ADR-0067).
 *
 *   node scripts/release/pack-check.mjs [--skip-consumer] [--keep]       (`pnpm packages:pack-check`)
 *
 * 1. Every workspace package except PUBLISHED stays private, and no published package depends on
 *    a private one, nor on anything in the @fundroom npm scope (someone else owns it; ours is
 *    @fundroomhq, ADR-0067 amendment).
 * 2. `pnpm pack`s @fundroomhq/tokens and @fundroomhq/ui into a temp dir (their `prepack` checks the
 *    tokens codegen and rebuilds ui's dist from clean).
 * 3. Asserts the tarball contract fundroom-web's `sync-tokens --package` relies on (tokens: exactly
 *    package.json, tokens.css byte-identical to packages/tokens/tokens.css, fundroom.tokens.json,
 *    README.md, LICENSE; the exports map), ui's file list (dist only: no sources, tests, stories,
 *    source maps or tsbuildinfo; every export target present), that no `workspace:`/`catalog:`
 *    specifier survived packing, and that the published stylesheets reach nothing outside the
 *    package.
 * 4. Installs both tarballs into a throwaway consumer (React 19 + Vite + Tailwind v4 at the exact
 *    versions pnpm-lock.yaml resolved for packages/ui, the repo's minimumReleaseAge for everything
 *    else; from the pnpm store when it can, `--offline` then `--prefer-offline`) and builds a page that renders
 *    a Button and imports the tokens CSS. The built CSS must carry the tokens and `bg-primary`,
 *    a class only ui's compiled components use, which proves the published `@source` works.
 *
 * The pure checks are exported for scripts/release/publish-packages.mjs and tested in
 * pack-check.test.mjs. Exit 0 = all good; 1 = problems (each listed).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The packages published to npm, in publish order (ui depends on tokens). */
export const PUBLISHED = [
  { name: "@fundroomhq/tokens", dir: "packages/tokens" },
  { name: "@fundroomhq/ui", dir: "packages/ui" },
];

export const REPOSITORY_URL = "git+https://github.com/fundroomhq/fundroom.git";

/** The @fundroomhq/tokens tarball, exactly (fundroom-web's sync-tokens reads it). */
export const TOKENS_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/fundroom.tokens.json",
  "package/package.json",
  "package/tokens.css",
];
export const TOKENS_EXPORTS = {
  "./tokens.css": "./tokens.css",
  "./tokens.json": "./fundroom.tokens.json",
  "./package.json": "./package.json",
};

/** Paths a published ui tarball must never contain. */
const UI_FORBIDDEN = [
  [/^package\/(?!dist\/|package\.json$|README\.md$|LICENSE$)/u, "outside dist/"],
  [/\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.d\.ts$/u, "a test"],
  [/\.stories\./u, "a story"],
  [/tsbuildinfo/u, "a tsbuildinfo"],
  [/\.map$/u, "a source map (its sources are not shipped)"],
  [/(^|\/)test\//u, "a test helper"],
];

/**
 * Every `workspace:` / `catalog:` specifier left in a packed manifest, as `field.name: spec`.
 *
 * @param {Record<string, unknown>} manifest
 */
export function unresolvedProtocols(manifest) {
  const found = [];
  const walk = (/** @type {unknown} */ node, /** @type {string} */ path) => {
    if (typeof node === "string") {
      if (/\b(workspace|catalog):/u.test(node)) found.push(`${path}: ${node}`);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(manifest, "");
  return found;
}

/**
 * Fields every published manifest needs (npm provenance matches `repository.url` exactly).
 *
 * Runtime dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`) may name no
 * workspace package except a published one. `@fundroom/*` is never allowed: the workspace's private
 * packages use that scope, but on npm it belongs to someone else, so a consumer installing such a
 * dependency would get a stranger's code (dependency confusion). Ours publish as `@fundroomhq/*`.
 *
 * @param {Record<string, any>} manifest
 * @param {string} name
 * @param {string} dir
 * @param {string[]} [published]
 */
export function checkManifest(manifest, name, dir, published = PUBLISHED.map((p) => p.name)) {
  const problems = [];
  if (manifest.name !== name)
    problems.push(`name is ${JSON.stringify(manifest.name)}, not ${name}`);
  if (manifest.private !== false && manifest.private !== undefined)
    problems.push("is private (npm refuses to publish it)");
  if (manifest.license !== "MIT") problems.push("license is not MIT");
  if (manifest.type !== "module") problems.push('type is not "module"');
  if (manifest.repository?.url !== REPOSITORY_URL)
    problems.push(`repository.url is not ${REPOSITORY_URL} (provenance requires an exact match)`);
  if (manifest.repository?.directory !== dir) problems.push(`repository.directory is not ${dir}`);
  if (manifest.publishConfig?.access !== "public")
    problems.push("publishConfig.access is not public");
  if (manifest.publishConfig?.provenance !== true)
    problems.push("publishConfig.provenance is not true");
  if (typeof manifest.homepage !== "string") problems.push("no homepage");
  for (const p of unresolvedProtocols(manifest)) problems.push(`unresolved specifier ${p}`);
  problems.push(...privateDependencies(manifest, published));
  return problems;
}

/**
 * Runtime dependencies naming a workspace package that is not published: any `@fundroom/*` (the
 * private packages' scope, which on npm belongs to someone else) and any unpublished
 * `@fundroomhq/*`.
 *
 * @param {Record<string, any>} manifest
 * @param {string[]} [published]
 */
export function privateDependencies(manifest, published = PUBLISHED.map((p) => p.name)) {
  const problems = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep.startsWith("@fundroom/"))
        problems.push(
          `${field}.${dep} is a private workspace package (and @fundroom on npm is not ours)`,
        );
      else if (dep.startsWith("@fundroomhq/") && !published.includes(dep))
        problems.push(`${field}.${dep} is a private workspace package`);
    }
  }
  return problems;
}

/** Export targets of a manifest (strings and condition objects, flattened). */
function exportTargets(/** @type {unknown} */ exports) {
  if (typeof exports === "string") return [exports];
  if (exports && typeof exports === "object") return Object.values(exports).flatMap(exportTargets);
  return [];
}

/**
 * The `@fundroomhq/tokens` tarball contract.
 *
 * @param {{ files: string[], manifest: Record<string, any>, tokensCss: string, sourceCss: string }} t
 */
export function checkTokensTarball({ files, manifest, tokensCss, sourceCss }) {
  const problems = checkManifest(manifest, "@fundroomhq/tokens", "packages/tokens");
  const got = [...files].sort();
  if (JSON.stringify(got) !== JSON.stringify(TOKENS_FILES))
    problems.push(`files are ${got.join(", ")}; the contract is ${TOKENS_FILES.join(", ")}`);
  if (JSON.stringify(manifest.exports) !== JSON.stringify(TOKENS_EXPORTS))
    problems.push(
      `exports are ${JSON.stringify(manifest.exports)}, not ${JSON.stringify(TOKENS_EXPORTS)}`,
    );
  if (JSON.stringify(manifest.sideEffects) !== JSON.stringify(["*.css"]))
    problems.push('sideEffects is not ["*.css"]');
  if (tokensCss !== sourceCss)
    problems.push("package/tokens.css differs from packages/tokens/tokens.css");
  if (!/--sh-color-primary:/u.test(tokensCss))
    problems.push("package/tokens.css has no --sh-color-primary");
  return problems;
}

/**
 * The `@fundroomhq/ui` tarball: dist only, every export present, nothing private depended on.
 *
 * @param {{ files: string[], manifest: Record<string, any>, published?: string[] }} t
 */
export function checkUiTarball({ files, manifest, published = PUBLISHED.map((p) => p.name) }) {
  const problems = checkManifest(manifest, "@fundroomhq/ui", "packages/ui", published);
  for (const file of files) {
    const hit = UI_FORBIDDEN.find(([re]) => re.test(file));
    if (hit) problems.push(`${file} is ${hit[1]}`);
  }
  const have = new Set(files);
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"])
    if (!have.has(required)) problems.push(`${required} is missing`);
  for (const target of exportTargets(manifest.exports)) {
    const path = posix.join("package", target);
    if (!have.has(path)) problems.push(`export target ${target} is not in the tarball`);
  }
  if (manifest.exports?.["./styles.css"] !== "./dist/styles/index.css")
    problems.push("./styles.css does not point at dist/styles/index.css (publishConfig.exports)");
  if (!manifest.peerDependencies?.tailwindcss)
    problems.push("tailwindcss is not a peer dependency");
  return problems;
}

/**
 * `@import` / `@source` paths in a published stylesheet that leave the package.
 *
 * @param {string} css
 * @param {string} file the stylesheet's path inside the tarball, e.g. `package/dist/styles/index.css`
 */
export function stylesheetEscapes(css, file) {
  const problems = [];
  for (const m of css.matchAll(/@(import|source)\s+(?:url\()?["']([^"']+)["']/gu)) {
    const target = /** @type {string} */ (m[2]);
    if (!target.startsWith(".")) continue; // a package import resolves in the consumer's node_modules
    const joined = posix.normalize(posix.join(posix.dirname(file), target));
    if (joined !== "package" && !joined.startsWith("package/"))
      problems.push(`${file}: @${m[1]} "${target}" leaves the package`);
  }
  return problems;
}

/**
 * Workspace packages other than `published` that are not private.
 *
 * @param {{ name: string, private?: boolean }[]} manifests
 * @param {string[]} published
 */
export function publicStrays(manifests, published = PUBLISHED.map((p) => p.name)) {
  return manifests
    .filter((m) => m.private !== true && !published.includes(m.name))
    .map((m) => `${m.name} is not private; only ${published.join(", ")} are published`);
}

/** Every workspace package.json (pnpm-workspace.yaml's globs, one level deep). */
export function workspaceManifests(root = ROOT) {
  const out = [];
  for (const base of ["apps", "packages", "packages/adapters", "modules"]) {
    let entries = [];
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        out.push(JSON.parse(readFileSync(join(root, base, e.name, "package.json"), "utf8")));
      } catch {
        /* not a package */
      }
    }
  }
  try {
    out.push(JSON.parse(readFileSync(join(root, "e2e", "package.json"), "utf8")));
  } catch {
    /* none */
  }
  return out;
}

/** A tool's path from the environment (read by name: not a turbo task input), else its name. */
const tool = (/** @type {string} */ env, /** @type {string} */ name) => process.env[env] || name;

/** `pnpm pack` one package into `dest`; returns the tarball path. */
export function pack(/** @type {string} */ dir, /** @type {string} */ dest, root = ROOT) {
  const out = execFileSync(
    tool("PNPM_BIN", "pnpm"),
    ["pack", "--json", "--pack-destination", dest],
    {
      cwd: join(root, dir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  // prepack output precedes the JSON on stdout.
  const json = JSON.parse(out.slice(out.indexOf("\n{") + 1 || out.indexOf("{")));
  return /** @type {string} */ (json.filename);
}

/** File list and readers for a tarball. */
export function readTarball(/** @type {string} */ tgz) {
  const files = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith("/"));
  const read = (/** @type {string} */ path) =>
    execFileSync("tar", ["-xzOf", tgz, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { files, read, manifest: JSON.parse(read("package/package.json")) };
}

/**
 * Pack both packages and run every tarball check. Returns the tarballs and problems.
 *
 * @param {string} dest
 */
export function packAndCheck(dest, root = ROOT) {
  const problems = publicStrays(workspaceManifests(root));
  /** @type {Record<string, { tgz: string, manifest: Record<string, any> }>} */
  const tarballs = {};
  for (const { name, dir } of PUBLISHED) {
    const tgz = pack(dir, dest, root);
    const t = readTarball(tgz);
    tarballs[name] = { tgz, manifest: t.manifest };
    const prefix = (/** @type {string} */ p) => `${name}: ${p}`;
    if (name === "@fundroomhq/tokens") {
      problems.push(
        ...checkTokensTarball({
          files: t.files,
          manifest: t.manifest,
          tokensCss: t.read("package/tokens.css"),
          sourceCss: readFileSync(join(root, dir, "tokens.css"), "utf8"),
        }).map(prefix),
      );
    } else {
      problems.push(...checkUiTarball({ files: t.files, manifest: t.manifest }).map(prefix));
      for (const css of t.files.filter((f) => f.endsWith(".css")))
        problems.push(...stylesheetEscapes(t.read(css), css).map(prefix));
      if (
        t.files.includes("package/dist/styles/tokens.css") &&
        t.read("package/dist/styles/tokens.css") !==
          readFileSync(join(root, "packages/tokens/tokens.css"), "utf8")
      )
        problems.push(prefix("dist/styles/tokens.css differs from packages/tokens/tokens.css"));
      const tokensDep = t.manifest.dependencies?.["@fundroomhq/tokens"];
      if (tokensDep !== t.manifest.version)
        problems.push(
          prefix(`depends on @fundroomhq/tokens ${tokensDep}, not ${t.manifest.version}`),
        );
    }
  }
  const versions = new Set(Object.values(tarballs).map((t) => t.manifest.version));
  if (versions.size !== 1)
    problems.push(
      `the packages have different versions (${[...versions].join(", ")}); they are one fixed group`,
    );
  return { tarballs, problems };
}

/**
 * The exact versions an importer resolved in pnpm-lock.yaml (v9 layout: `importers:` →
 * `  <path>:` → `    <field>:` → `      <name>:` → `        version: X(peer suffix)`).
 *
 * @param {string} lock the lockfile text
 * @param {string} importer e.g. `packages/ui`
 * @param {string[]} names
 */
export function lockedVersions(lock, importer, names) {
  const lines = lock.split(/\r?\n/u);
  const at = lines.indexOf(`  ${importer}:`);
  if (at < 0 || lines.slice(0, at).every((l) => l !== "importers:"))
    throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
  let end = lines.findIndex((l, i) => i > at && /^ {0,2}\S/u.test(l));
  if (end < 0) end = lines.length;
  const block = lines.slice(at + 1, end);
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of names) {
    const i = block.findIndex((l) => l === `      ${name}:` || l === `      '${name}':`);
    const m = i < 0 ? null : /^ {8}version: '?([^'(\s]+)/u.exec(block[i + 2] ?? "");
    if (!m) throw new Error(`pnpm-lock.yaml: ${importer} has no locked version of ${name}`);
    out[name] = /** @type {string} */ (m[1]);
  }
  return out;
}

/** `minimumReleaseAge` from pnpm-workspace.yaml (minutes), so the consumer keeps the floor. */
export function minimumReleaseAge(/** @type {string} */ yaml) {
  const m = /^minimumReleaseAge:\s*(\d+)\s*$/mu.exec(yaml);
  if (!m) throw new Error("pnpm-workspace.yaml has no minimumReleaseAge");
  return Number(m[1]);
}

/**
 * Install the tarballs into a throwaway Vite + Tailwind v4 + React 19 app and build it.
 * Returns problems with the built output.
 *
 * @param {string} dir an empty directory
 * @param {{ tokens: string, ui: string }} tgz
 */
export function buildConsumer(dir, tgz, root = ROOT) {
  // Exactly what the repo builds ui with, so CI never picks up a release a few hours old; the
  // transitive deps keep the repo's minimumReleaseAge (the consumer's pnpm-workspace.yaml).
  const v = lockedVersions(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), "packages/ui", [
    "react",
    "react-dom",
    "vite",
    "tailwindcss",
    "@tailwindcss/vite",
  ]);
  const age = minimumReleaseAge(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
  const file = (/** @type {string} */ p) => `file:${p}`;
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "fundroom-pack-consumer",
        private: true,
        type: "module",
        // The repo's pnpm, not whatever a version-switching shim picks outside the repo (pnpm 9
        // ignores minimumReleaseAge and pnpm-workspace.yaml overrides).
        packageManager: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
        dependencies: {
          "@fundroomhq/tokens": file(tgz.tokens),
          "@fundroomhq/ui": file(tgz.ui),
          ...v,
        },
      },
      null,
      2,
    )}\n`,
  );
  // ui depends on @fundroomhq/tokens@<version>, which is not on the registry yet.
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    [
      `minimumReleaseAge: ${age}`,
      "overrides:",
      `  "@fundroomhq/tokens": ${JSON.stringify(file(tgz.tokens))}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "vite.config.js"),
    'import tailwindcss from "@tailwindcss/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [tailwindcss()] });\n',
  );
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>pack check</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "main.js"),
    [
      'import "@fundroomhq/tokens/tokens.css";',
      'import "./app.css";',
      'import { Button } from "@fundroomhq/ui";',
      'import { DEFAULT_TOKENS } from "@fundroomhq/ui/theme";',
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      "",
      'const root = document.getElementById("root");',
      "if (root) {",
      "  createRoot(root).render(",
      '    createElement(Button, { variant: "destructive", title: DEFAULT_TOKENS.light["--sh-color-primary"] }, "Pack check"),',
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  // The consumer's own classes only; ui's come from its stylesheet's @source.
  writeFileSync(join(dir, "src", "app.css"), '@import "@fundroomhq/ui/styles.css";\n');

  const install = (/** @type {string} */ mode) =>
    execFileSync(tool("PNPM_BIN", "pnpm"), ["install", mode, "--config.strict-dep-builds=false"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  // --offline needs full registry metadata in the cache, which a frozen install never fetches.
  let mode = "--offline";
  try {
    install(mode);
  } catch {
    mode = "--prefer-offline";
    install(mode);
  }
  process.stdout.write(`pack check: consumer installed with ${mode}\n`);
  execFileSync(join(dir, "node_modules", ".bin", "vite"), ["build", "--logLevel", "error"], {
    cwd: dir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const assets = join(dir, "dist", "assets");
  const read = (/** @type {RegExp} */ re) =>
    readdirSync(assets)
      .filter((f) => re.test(f))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
  return checkConsumerOutput({ css: read(/\.css$/u), js: read(/\.js$/u) });
}

/**
 * What the consumer build must contain.
 *
 * @param {{ css: string, js: string }} out
 */
export function checkConsumerOutput({ css, js }) {
  const problems = [];
  if (!/--sh-color-primary:/u.test(css))
    problems.push("built CSS has no --sh-color-primary (tokens.css)");
  if (!/\.bg-destructive\b/u.test(css))
    problems.push("built CSS has no .bg-destructive (the rendered Button)");
  // Only ui's compiled components use bg-primary: present only if the published @source works.
  if (!/\.bg-primary\b/u.test(css))
    problems.push(
      "built CSS has no .bg-primary: Tailwind did not scan @fundroomhq/ui's dist (@source)",
    );
  if (!/\.bg-primary\{[^}]*var\(--sh-color-primary\)/u.test(css))
    problems.push("built .bg-primary does not use var(--sh-color-primary) (ui's @theme inline)");
  if (!js.includes("Pack check")) problems.push("built JS does not render the Button");
  if (!js.includes("data-slot")) problems.push("built JS has no ui component (data-slot)");
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "skip-consumer": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });
  const work = mkdtempSync(join(tmpdir(), "fundroom-pack-check-"));
  let failed = false;
  try {
    const tarballs = join(work, "tarballs");
    mkdirSync(tarballs);
    const { tarballs: packed, problems } = packAndCheck(tarballs);
    if (!values["skip-consumer"] && problems.length === 0) {
      const consumer = join(work, "consumer");
      mkdirSync(consumer);
      problems.push(
        ...buildConsumer(consumer, {
          tokens: /** @type {any} */ (packed["@fundroomhq/tokens"]).tgz,
          ui: /** @type {any} */ (packed["@fundroomhq/ui"]).tgz,
        }).map((p) => `consumer: ${p}`),
      );
    }
    for (const p of problems) console.error(`::error::pack check: ${p}`);
    failed = problems.length > 0;
    if (!failed) {
      const list = Object.entries(packed)
        .map(([n, t]) => `${n}@${t.manifest.version}`)
        .join(", ");
      process.stdout.write(
        `pack check: ${list} packed, contract holds${values["skip-consumer"] ? "" : ", consumer builds"}\n`,
      );
    }
  } finally {
    if (values.keep) process.stdout.write(`kept ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}
