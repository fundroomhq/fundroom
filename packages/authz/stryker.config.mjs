// @ts-check
/**
 * Mutation testing for the authorization kernel (E2.10). Only the pure resolver is mutated:
 * the DB-touching half (`rebuildEffectiveAccess`, `service.ts`, `repos/*`) is exercised by
 * integration tests that need Docker and are far too slow to run once per mutant.
 *
 *   pnpm --filter @fundroom/authz mutation            # incremental (reuses reports/…json)
 *   pnpm --filter @fundroom/authz mutation --force    # ignore the incremental file
 *
 * Reports land in `reports/mutation/` (gitignored). The incremental file lives there too:
 * it is a local/CI-cache speed-up, not a source of truth, and committing it would churn on
 * every src or test edit.
 *
 * @type {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "pnpm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts", related: false },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/evaluate.ts",
    "src/model.ts",
    // parse, load and RBAC lookups; the docs renderer (148+) is not authorization logic
    "src/matrix.ts:1-146",
    // `delegateNodeRules` … `veiledRow` (incl. `computeEffectiveRows`, `locatedDocumentIds`);
    // `rebuildEffectiveAccess` below them talks to Postgres
    "src/rebuild.ts:67-227",
  ],
  coverageAnalysis: "perTest",
  checkers: [],
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  clearTextReporter: { allowColor: true, logTests: false, maxTestsToLog: 0 },
  // E2.10: 67.06% on the first run, 98.31% after (591 mutants; the 10 survivors are equivalent,
  // listed in README.md). `break` sits a few points under that so a regression fails CI.
  thresholds: { high: 90, low: 80, break: 95 },
  concurrency: 4,
  timeoutMS: 10_000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
