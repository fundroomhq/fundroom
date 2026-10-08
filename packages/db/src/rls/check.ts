import type { Pool } from "pg";

/**
 * Catalog assertions (EXECUTION_PLAN §7 "CI asserts every table with workspace_id has
 * RLS + fence policy"; design/06 §9 CI check). Backed by core.check_tenant_fence().
 *
 * Findings, all of which fail CI (`fundroom-db check-rls`):
 *  - a workspace_id table without ENABLE / FORCE ROW LEVEL SECURITY
 *  - a workspace_id table without a RESTRICTIVE policy named tenant_fence
 *  - an app table seedhost_app cannot SELECT (a migration ran as a different owner
 *    without GRANTs, so the app would fail at runtime)
 *  - a jsonb column without its `<name>_schema_version` sibling
 */
export interface RlsFinding {
  readonly schema: string;
  readonly table: string;
  readonly problem: string;
}

export async function checkRlsCatalog(pool: Pool): Promise<RlsFinding[]> {
  const exists = await pool.query<{ ok: boolean }>(
    "SELECT to_regprocedure('core.check_tenant_fence()') IS NOT NULL AS ok",
  );
  if (!exists.rows[0]?.ok) {
    return [
      {
        schema: "core",
        table: "*",
        problem: "core.check_tenant_fence() missing; run migrations first",
      },
    ];
  }
  const r = await pool.query<{ schema_name: string; table_name: string; problem: string }>(
    "SELECT schema_name, table_name, problem FROM core.check_tenant_fence()",
  );
  return r.rows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    problem: row.problem,
  }));
}

/** Every tenant table (has a workspace_id column) in app schemas, for behavioural RLS tests. */
export async function listTenantTables(pool: Pool): Promise<{ schema: string; table: string }[]> {
  const r = await pool.query<{ schema: string; table: string }>(`
    SELECT n.nspname AS schema, c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname NOT LIKE 'pg_%'
    ORDER BY 1, 2`);
  return r.rows;
}

export function formatRlsFindings(findings: readonly RlsFinding[]): string {
  if (findings.length === 0) return "RLS catalog: OK";
  return [
    `RLS catalog: ${findings.length} problem(s)`,
    ...findings.map((f) => `  ${f.schema}.${f.table}: ${f.problem}`),
  ].join("\n");
}
