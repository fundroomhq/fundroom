/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  // Layering rules from EXECUTION_PLAN §5 and design/06 §3. Biome has no import-boundary
  // rule, so dependency-cruiser carries these; `pnpm lint:deps` runs them (CI: static job).
  forbidden: [
    {
      name: "no-cross-module-imports",
      severity: "error",
      comment:
        "Modules communicate through the outbox, never by importing each other. " +
        "Shared code belongs in packages/*.",
      from: { path: "^modules/([^/]+)/" },
      to: { path: "^modules/([^/]+)/", pathNot: "^modules/$1/" },
    },
    {
      name: "application-imports-ports-only",
      severity: "error",
      comment: "packages/application depends on ports and domain only (§5.2).",
      from: { path: "^packages/application/" },
      to: {
        path: "^(packages|apps|modules)/",
        pathNot: "^packages/(application|ports|domain)/",
      },
    },
    {
      name: "domain-has-no-io",
      severity: "error",
      comment: "packages/domain is pure: no I/O, no other workspace packages.",
      from: { path: "^packages/domain/" },
      to: { path: "^(packages|apps|modules)/", pathNot: "^packages/domain/" },
    },
    {
      name: "adapters-do-not-import-adapters",
      severity: "error",
      from: { path: "^packages/adapters/([^/]+)/" },
      to: { path: "^packages/adapters/([^/]+)/", pathNot: "^packages/adapters/$1/" },
    },
    {
      name: "only-repos-touch-drizzle",
      severity: "error",
      comment:
        "No raw queries outside repositories: only packages/db, */repos/*, " +
        "*/schema/* and migration code may import drizzle-orm or pg. Everything else goes " +
        "through withTenant() and a TenantRepo.",
      from: {
        path: "^(apps|packages|modules)/",
        pathNot: "^packages/db/|/repos?/|/schema/|/migrations?/",
      },
      to: { path: "node_modules/(drizzle-orm|pg)(/|$)" },
    },
    {
      name: "no-db-internals",
      severity: "error",
      comment: "Import @fundroom/db's public surface, not its src files.",
      from: { pathNot: "^packages/db/" },
      to: { path: "^packages/db/src/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Run `pnpm build` (or typecheck) first: workspace packages resolve through dist/.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "\\.test\\.(ts|mjs)$",
          "/cli\\.ts$",
          "/healthcheck\\.ts$", // the image HEALTHCHECK: a standalone script, imports nothing
          "\\.config\\.(ts|mjs|cjs|js)$",
          "^e2e/", // Playwright suites run against a booted stack; no layering to enforce
          "^scripts/",
          "^deploy/platforms/", // the env catalogue, read by scripts/render-deploy-templates.mjs
          // The WordPress plugin is PHP. Its JavaScript is enqueued by WordPress and loaded by a
          // browser, so nothing in this graph imports it and every file there is an orphan by
          // construction, not by mistake (ADR-0023; the directory is excluded from Biome too).
          "^plugins/",
          "/src/test/",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // node_modules stays in the graph as leaves (doNotFollow) so rules can target packages.
    // scripts/ are plain Node tools with their own node --test suite, not layered code.
    // load/k6 runs inside the k6 binary, whose `k6/*` modules exist nowhere on disk (E2.10).
    exclude: {
      path: [
        "/dist/",
        "\\.test\\.tsx?$",
        "\\.stories\\.tsx$",
        "/coverage/",
        "/\\.turbo/",
        "^scripts/",
        "^load/k6/",
        // e2e/pathmount/next runs inside its own Docker image, where `next` is installed (E3.9).
        "^e2e/pathmount/next/",
        "/src/paraglide/",
        "/storybook-static/",
        "/\\.storybook/",
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
