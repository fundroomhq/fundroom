import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EMBED_ARTIFACTS, EMBED_VERSION, embedArtifact } from "./artifacts.js";
import { VERSION } from "./index.js";

/*
 * This file runs in the default `unit` environment — Node, no jsdom — and that is the point of the
 * first test: `apps/server` imports `@fundroom/embed/artifacts` at boot, and a module in that
 * graph that touched `window` would take the server down rather than fail a test.
 *
 * The generator is a `.mjs` script so it can run before anything is compiled, so the drift check
 * reaches it through a dynamic import, exactly as `packages/compliance` does.
 */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = pathToFileURL(join(PACKAGE_DIR, "scripts", "build-artifacts.mjs")).href;
const GENERATED = join(PACKAGE_DIR, "src", "generated", "artifacts.ts");

interface Generator {
  readonly GZIP_BUDGET_BYTES: number;
  buildArtifactsModule(): Promise<{
    readonly source: string;
    readonly built: { readonly gzipBytes: number };
  }>;
}

// A non-literal specifier keeps TypeScript from trying to resolve types for the `.mjs` file.
const specifier: string = SCRIPT;
const generator = (await import(specifier)) as Generator;

describe("@fundroom/embed/artifacts", () => {
  it("imports with no browser globals in its module graph", () => {
    expect(globalThis.window).toBeUndefined();
    expect(EMBED_ARTIFACTS.length).toBeGreaterThan(0);
  });

  it("matches what the generator produces from src/ right now", async () => {
    // The drift check. Editing the loader without running `pnpm --filter @fundroom/embed codegen`
    // fails here rather than shipping bytes nobody can see in a diff.
    const { source } = await generator.buildArtifactsModule();
    expect(source).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("keeps the IIFE build inside the 5 KB gzip budget", async () => {
    const { built } = await generator.buildArtifactsModule();
    expect(generator.GZIP_BUDGET_BYTES).toBe(5 * 1024);
    expect(built.gzipBytes).toBeLessThanOrEqual(generator.GZIP_BUDGET_BYTES);
  });

  it("serves the loader in both formats plus the SRI manifest", () => {
    expect(EMBED_ARTIFACTS.map((a) => a.path)).toEqual(["embed.js", "embed.mjs", "manifest.json"]);
    const iife = embedArtifact("embed.js");
    const esm = embedArtifact("embed.mjs");
    expect(iife?.contentType).toBe("text/javascript; charset=utf-8");
    expect(embedArtifact("manifest.json")?.contentType).toBe("application/json; charset=utf-8");
    expect(embedArtifact("nope.js")).toBeUndefined();
    // The IIFE defines the documented global; the ESM build does not.
    expect(iife?.code).toContain("var SeedHost=");
    expect(esm?.code).not.toContain("var SeedHost=");
    expect(esm?.code).toContain("export{");
  });

  it("publishes an integrity value that is usable verbatim as an `integrity` attribute", () => {
    for (const artifact of EMBED_ARTIFACTS) {
      const digest = createHash("sha384")
        .update(Buffer.from(artifact.code, "utf8"))
        .digest("base64");
      expect(artifact.sha384).toBe(`sha384-${digest}`);
      expect(artifact.sha384).toMatch(/^sha384-[A-Za-z0-9+/]+={0,2}$/u);
    }
    const manifest = JSON.parse(embedArtifact("manifest.json")?.code ?? "{}") as {
      version: string;
      artifacts: Record<string, { integrity: string }>;
    };
    expect(manifest.version).toBe(EMBED_VERSION);
    expect(manifest.artifacts["embed.js"]?.integrity).toBe(embedArtifact("embed.js")?.sha384);
  });

  it("pins one version across package.json, the loader and the artifacts", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      version: string;
    };
    // `apps/server/src/version.ts` advertises MIN_EMBED_SDK = "0.1.0" and compares against this.
    expect(pkg.version).toBe(VERSION);
    expect(EMBED_VERSION).toBe(VERSION);
    for (const artifact of EMBED_ARTIFACTS) expect(artifact.version).toBe(VERSION);
  });

  it("gzips to roughly what the manifest reports, so the budget is measured on real bytes", () => {
    const iife = embedArtifact("embed.js");
    const bytes = Buffer.from(iife?.code ?? "", "utf8");
    expect(gzipSync(bytes, { level: 9 }).length).toBeLessThanOrEqual(5 * 1024);
  });
});
