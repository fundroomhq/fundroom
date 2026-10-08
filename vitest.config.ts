import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - unit: fast, no I/O, runs everywhere. `*.test.ts`
 *  - ui / web: jsdom component and screen tests (own configs under packages/ui, apps/web)
 *  - integration: needs Docker (Testcontainers Postgres 18, later Garage / Mailpit / ClamAV).
 *    `*.integration.test.ts`. Run with `pnpm test:integration`.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "test-results/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "modules/*/src/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.stories.tsx",
        "**/*.d.ts",
        "**/generated/**",
        "**/paraglide/**",
        "**/*.gen.ts",
        "**/test/**",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["{apps,packages,modules}/**/*.test.ts"],
          exclude: [
            "**/*.integration.test.ts",
            "**/node_modules/**",
            "**/dist/**",
            "**/.stryker-tmp/**",
            "apps/web/**",
            "packages/ui/**",
          ],
          environment: "node",
          setupFiles: ["scripts/vitest-tmpdir.setup.mjs"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["{apps,packages,modules}/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/.stryker-tmp/**"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 180_000,
          pool: "forks",
          setupFiles: ["scripts/vitest-tmpdir.setup.mjs"],
        },
      },
      // Browser-ish projects (jsdom, React plugin, Tailwind) carry their own config.
      "packages/ui/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
  },
});
