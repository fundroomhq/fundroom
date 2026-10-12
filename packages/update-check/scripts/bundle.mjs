/**
 * Bundles the release workflow's publisher (src/release-index-bin.ts) and its dependencies into
 * one file, so the workflow's publish job runs it with Node alone (no install next to the R2
 * keys). Not part of `build`: the image never needs it, and the image's install runs with
 * `--ignore-scripts`, where pnpm's shim for the esbuild CLI runs the native binary through Node.
 * The JS API has no shim.
 *
 *   pnpm --filter @fundroom/update-check bundle [outfile]   (default dist/release-index.mjs)
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = new URL("../", import.meta.url);

export async function bundle(outfile = fileURLToPath(new URL("dist/release-index.mjs", pkg))) {
  await build({
    entryPoints: [fileURLToPath(new URL("src/release-index-bin.ts", pkg))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle(process.argv[2]);
}
