import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is a drafting tool here, not the applier (ADR-0004).
 *
 *   pnpm --filter @fundroom/db db:generate --name <change>
 *
 * writes `migrations/core/NNNN_<change>.sql` plus a snapshot under `migrations/core/meta/`.
 * Hand-edit the SQL (RLS, grants, functions, triggers, `CONCURRENTLY` files), then commit.
 * The runner in `src/migrate/` applies `*.sql` in name order and ignores `meta/`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations/core",
  schemaFilter: ["core", "audit"],
  strict: true,
  verbose: true,
});
