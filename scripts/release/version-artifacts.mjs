#!/usr/bin/env node
/*
 * Regenerates every committed file that carries a package version, right after `changeset
 * version` has moved the versions (the root `version-packages` script; changesets/action runs it
 * for the version PR). Without this the version PR is the one PR that cannot pass its own CI: the
 * generated-files and OpenAPI drift checks compare against bytes that still name the old version.
 *
 *   - packages/embed/src/generated/{version,artifacts}.ts — the loader's VERSION, its banner, the
 *     pinned URL segment and the SRI digests (`@fundroom/embed`'s own codegen; esbuild only).
 *   - packages/sdk/openapi.json `info.version` — apps/server's version (`SERVER_VERSION`). The
 *     document is otherwise produced by `node apps/server/dist/cli.js openapi`, which needs the
 *     whole server built; the version is the only part a version bump changes, so it is stamped
 *     in place rather than regenerated, and `openapi:check` in CI still compares the full document.
 *
 * Only cheap, deterministic generators belong here: it runs on the release runner after a bare
 * `pnpm install`, with nothing built. Running it with no version change rewrites nothing.
 * Tested in version-artifacts.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_PACKAGE = join(ROOT, "apps", "server", "package.json");
const OPENAPI = join(ROOT, "packages", "sdk", "openapi.json");
const EMBED_CODEGEN = join(ROOT, "packages", "embed", "scripts", "build-artifacts.mjs");

/**
 * `text` (the committed, Biome-formatted document) with `info.version` set to `version`, every
 * other byte untouched. Throws rather than guess when the document is not the expected shape.
 */
export function stampOpenApiVersion(text, version) {
  const doc = JSON.parse(text);
  if (typeof doc?.info?.version !== "string") throw new Error("openapi.json has no info.version");
  if (doc.info.version === version) return text;
  // `info`'s own `version`: the first one after `"info": {` without entering a nested object
  // (`license`, `contact`). The parse-and-compare below proves nothing else moved.
  const re = /("info": \{[^{}]*?"version": )"[^"\n]*"/u;
  if (!re.test(text)) throw new Error("openapi.json: cannot find info.version to stamp");
  const out = text.replace(re, `$1${JSON.stringify(version)}`);
  const after = JSON.parse(out);
  doc.info.version = version;
  if (JSON.stringify(after) !== JSON.stringify(doc)) {
    throw new Error("openapi.json: stamping info.version changed something else");
  }
  return out;
}

function main() {
  execFileSync(process.execPath, [EMBED_CODEGEN], { stdio: "inherit" });

  const version = JSON.parse(readFileSync(SERVER_PACKAGE, "utf8")).version;
  const before = readFileSync(OPENAPI, "utf8");
  const after = stampOpenApiVersion(before, version);
  if (after !== before) writeFileSync(OPENAPI, after, "utf8");
  process.stdout.write(
    `version-artifacts: openapi.json info.version ${after === before ? "already" : "now"} ${version}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
