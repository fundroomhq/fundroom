#!/usr/bin/env node
/**
 * Builds the distributable WordPress plugin zip (E2.2, ADR-0023).
 *
 * Three steps, in this order, because each one can fail in a way that must not produce a zip:
 *
 *  1. **Copy the loader in.** `packages/embed/dist/embed.js` becomes
 *     `plugins/wordpress/assets/js/embed.js`. wp.org guideline 8 requires non-service JavaScript to
 *     be bundled locally, so this file *is* the compliance story and its absence is a hard error —
 *     never a skipped step. A zip built without it would install, render a container, and do
 *     nothing.
 *  2. **Stamp the version.** `readme.txt`'s `Stable tag` is the single source of truth (the plugin
 *     is versioned by its own readme, not by Changesets — see `.changeset/README.md`), and it is
 *     written into the `Version:` plugin header and the `SEED_HOST_VERSION` constant. Both must
 *     already exist, or the regex silently matched nothing and the zip ships the wrong number.
 *  3. **Zip it**, under a top-level `seed-host/` directory, excluding everything that is
 *     development-only.
 *
 * No dependencies: `node:zlib` has deflate and the ZIP container is ~60 lines, which is cheaper
 * than a dependency in a repository whose supply chain is audited (and cheaper than shelling out
 * to a `zip` binary that is not installed everywhere CI runs).
 *
 * Usage: `node scripts/build-wordpress-plugin.mjs [--out <dir>]`. Exit 1 on any failure.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = join(ROOT, "plugins", "wordpress");
const LOADER_SOURCE = join(ROOT, "packages", "embed", "dist", "embed.js");
const LOADER_TARGET = join(PLUGIN_DIR, "assets", "js", "embed.js");
const README = join(PLUGIN_DIR, "readme.txt");
const MAIN_FILE = join(PLUGIN_DIR, "seed-host.php");

/** The plugin slug, which is also the directory name inside the zip and on wp.org. */
const SLUG = "seed-host";

/**
 * Never shipped. `composer.json`/`phpcs.xml.dist` are the linter's, `README.md` is for developers
 * (`readme.txt` is the one wp.org renders), and `dist/` is this script's own output.
 */
const EXCLUDED_FILES = new Set([
  ".distignore",
  ".gitignore",
  "composer.json",
  "composer.lock",
  "phpcs.xml.dist",
  "README.md",
]);
const EXCLUDED_DIRS = new Set(["dist", "node_modules", "vendor", ".git", "tests"]);

/**
 * Banner prepended to the copied loader.
 *
 * A wp.org reviewer opening a bundled build wants to know what it is and where its source lives;
 * saying so in the file is the difference between "minified blob" and "documented artefact". The
 * loader is MIT and stays MIT — bundling it into a GPLv2-or-later distribution is compatible in
 * that direction, and the plugin as a whole is GPLv2-or-later.
 */
function banner(version, sha384) {
  return [
    "/*!",
    ` * FundRoom portal loader ${version} — generated file, do not edit.`,
    " *",
    " * Built from packages/embed/ in https://github.com/fundroomhq/fundroom by",
    " * scripts/build-wordpress-plugin.mjs. Licensed MIT (the plugin around it is GPLv2-or-later).",
    ` * Upstream integrity: ${sha384}`,
    " */",
  ].join("\n");
}

function fail(message) {
  process.stderr.write(`build-wordpress-plugin: ${message}\n`);
  process.exit(1);
}

/** `Stable tag: 1.2.3` from readme.txt — the plugin's one version number. */
function readVersion(readmeText) {
  const match = /^Stable tag:\s*(\S+)\s*$/mu.exec(readmeText);
  if (!match?.[1]) {
    fail(`no "Stable tag:" line in ${relative(ROOT, README)}`);
  }
  const version = match[1];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`"Stable tag: ${version}" in readme.txt is not a version number`);
  }
  return version;
}

/**
 * Replaces exactly one occurrence of `re` in `text`, or fails loudly.
 *
 * The count matters more than the replacement: a version line that has been reworded is a regex
 * that silently matches nothing, and the zip then ships whatever number was last hard-coded. `re`
 * must carry the `g` flag so `matchAll` counts occurrences rather than capture groups.
 */
function substituteOnce(text, re, replacement, what) {
  const count = [...text.matchAll(re)].length;
  if (count !== 1) {
    fail(`expected exactly one ${what} in seed-host.php, found ${count}`);
  }
  return text.replace(re, replacement);
}

/** Every file to ship, as `{ name, body }` with POSIX names relative to the plugin root. */
function collectFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(join(dir, entry.name), posix.join(prefix, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(entry.name)) continue;
    out.push({
      name: posix.join(prefix, entry.name),
      body: readFileSync(join(dir, entry.name)),
    });
  }
  return out;
}

// --- ZIP writer ----------------------------------------------------------------------------
// Stored/deflated entries, no data descriptors, no zip64: a plugin is a few dozen small files.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xff_ff_ff_ff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * A fixed MS-DOS timestamp (1980-01-01 00:00) rather than each file's mtime, so two builds of the
 * same tree produce byte-identical zips. A release artefact whose checksum changes because it was
 * built at a different second cannot be verified by anyone.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x21; // (1980 - 1980) << 9 | 1 << 5 | 1

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.body;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x08_00, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(0x03_1e, 4); // made by: UNIX, spec 3.0 — makes the mode below meaningful
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x08_00, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // `>>> 0`: the shift lands above 2^31 and JS bitwise operators are signed.
    central.writeUInt32LE((0o10_0644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

// --- main ----------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { outDir: join(PLUGIN_DIR, "dist") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      const value = argv[i + 1];
      if (!value) fail("--out needs a directory");
      out.outDir = resolve(process.cwd(), value);
      i += 1;
    } else {
      fail(`unknown argument ${argv[i]}`);
    }
  }
  return out;
}

function main() {
  const { outDir } = parseArgs(process.argv.slice(2));

  let readmeText;
  try {
    readmeText = readFileSync(README, "utf8");
  } catch {
    fail(`cannot read ${relative(ROOT, README)}`);
  }
  const version = readVersion(readmeText);

  // 1. The loader. Missing is an error with the command that fixes it, because the most likely
  // reason is that `packages/embed` has not been built in this checkout yet.
  let loader;
  try {
    loader = readFileSync(LOADER_SOURCE);
  } catch {
    fail(
      `${relative(ROOT, LOADER_SOURCE)} is missing.\n` +
        "  The plugin must ship the loader locally (wp.org guideline 8), so this is not\n" +
        "  an optional step. Build the package first:\n" +
        "    pnpm --filter @fundroom/embed build",
    );
  }
  if (loader.length === 0) fail(`${relative(ROOT, LOADER_SOURCE)} is empty`);
  const sha384 = `sha384-${createHash("sha384").update(loader).digest("base64")}`;
  writeFileSync(LOADER_TARGET, `${banner(version, sha384)}\n${loader.toString("utf8")}`);

  // 2. The version, in the two places PHP reads it.
  let main_php = readFileSync(MAIN_FILE, "utf8");
  main_php = substituteOnce(
    main_php,
    /^( \* Version:[ \t]+)\S+$/gmu,
    `$1${version}`,
    '"Version:" plugin header',
  );
  main_php = substituteOnce(
    main_php,
    /^(define\( 'SEED_HOST_VERSION', ')[^']+(' \);)$/gmu,
    `$1${version}$2`,
    "SEED_HOST_VERSION definition",
  );
  writeFileSync(MAIN_FILE, main_php);

  // 3. The zip, every path under `seed-host/` so it unpacks into a plugin directory.
  const files = collectFiles(PLUGIN_DIR);
  if (!files.some((f) => f.name === "seed-host.php")) fail("seed-host.php is not in the file list");
  if (!files.some((f) => f.name === "readme.txt")) fail("readme.txt is not in the file list");
  if (!files.some((f) => f.name === "LICENSE")) fail("LICENSE is not in the file list");

  const archive = zip(files.map((f) => ({ name: posix.join(SLUG, f.name), body: f.body })));
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `${SLUG}.zip`);
  writeFileSync(zipPath, archive);

  const lines = [
    `version       ${version} (from readme.txt "Stable tag")`,
    `loader        ${relative(ROOT, LOADER_SOURCE)} → ${relative(ROOT, LOADER_TARGET)} (${loader.length} B)`,
    `              ${sha384}`,
    `files         ${files.length}`,
    `zip           ${relative(ROOT, zipPath)} (${archive.length} B)`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  for (const file of files) process.stdout.write(`  ${SLUG}/${file.name}\n`);
}

main();
