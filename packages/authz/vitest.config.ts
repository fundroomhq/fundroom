import { defineConfig } from "vitest/config";

/**
 * Used ONLY by Stryker (`stryker.config.mjs` → `vitest.configFile`). The root
 * `vitest.config.ts` lists its projects explicitly, so this file is never picked up by
 * `pnpm test`: the package's unit tests keep running once, under the root `unit` project.
 *
 * Stryker runs from a sandbox copy (`.stryker-tmp/sandbox-*`), so the one test that reads a
 * file outside the package (`docs/authz-matrix.md is current`) cannot find it and is skipped
 * here; it still runs under `pnpm test`, and it mutates nothing Stryker measures.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    testNamePattern: /^(?!.*docs\/authz-matrix\.md is current)/u,
  },
});
