import type { ModuleManifest, PortableTable } from "@fundroom/module-kit";
import { KERNEL_TABLES, type KernelTable } from "./kernel-tables.js";

/*
 * The table plan: kernel tables first, then every module's in `after` order (a module's tables
 * after those of the modules it names), each module's own tables in the order it declared them.
 * The same function drives the export (entry order, manifest order) and the import (insert order),
 * and `findUndeclared` is what makes "a table without a portability decision" a hard error.
 */

export const KERNEL_OWNER = "core";

export interface PlannedTable {
  /** `core` or the module id. */
  readonly owner: string;
  readonly schema: string;
  readonly table: string;
  /** `<schema>.<table>`. */
  readonly name: string;
  readonly spec: PortableTable;
  readonly kernel?: KernelTable | undefined;
}

export class PortabilityPlanError extends Error {
  override readonly name = "PortabilityPlanError";
}

/** Modules with a portability section, dependencies (`after`) first, otherwise registry order. */
export function orderModules(modules: readonly ModuleManifest[]): ModuleManifest[] {
  const portable = modules.filter((m) => m.portability !== undefined);
  const byId = new Map(portable.map((m) => [m.id, m]));
  const out: ModuleManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: ModuleManifest, path: readonly string[]) => {
    const s = state.get(m.id);
    if (s === "done") return;
    if (s === "visiting")
      throw new PortabilityPlanError(`portability "after" cycle: ${[...path, m.id].join(" → ")}`);
    state.set(m.id, "visiting");
    for (const dep of m.portability?.after ?? []) {
      const d = byId.get(dep);
      if (d) visit(d, [...path, m.id]);
    }
    state.set(m.id, "done");
    out.push(m);
  };
  for (const m of portable) visit(m, []);
  return out;
}

export function planTables(modules: readonly ModuleManifest[]): PlannedTable[] {
  const plan: PlannedTable[] = KERNEL_TABLES.map((k) => ({
    owner: KERNEL_OWNER,
    schema: k.schema,
    table: k.table,
    name: `${k.schema}.${k.table}`,
    spec: k,
    kernel: k,
  }));
  for (const m of orderModules(modules)) {
    const schema = m.schema;
    if (schema === undefined)
      throw new PortabilityPlanError(`module ${m.id} declares portability but no schema`);
    for (const t of m.portability?.tables ?? []) {
      plan.push({ owner: m.id, schema, table: t.table, name: `${schema}.${t.table}`, spec: t });
    }
  }
  const seen = new Set<string>();
  for (const p of plan) {
    if (seen.has(p.name)) throw new PortabilityPlanError(`${p.name} is declared twice`);
    seen.add(p.name);
  }
  return plan;
}

/**
 * Tables in the catalog that nobody declared: any `core`/`audit` table with a `workspace_id`
 * column (the global identity tables have none and are not tenant data), and every table of a
 * schema a compiled-in module owns. `<schema>.<table>` names.
 */
export function findUndeclared(
  catalog: readonly {
    readonly schema: string;
    readonly table: string;
    readonly hasWorkspaceId: boolean;
  }[],
  plan: readonly PlannedTable[],
  modules: readonly ModuleManifest[],
): string[] {
  const declared = new Set(plan.map((p) => p.name));
  const moduleSchemas = new Set(
    modules.flatMap((m) =>
      m.schema !== undefined && m.migrations !== undefined ? [m.schema] : [],
    ),
  );
  const out: string[] = [];
  for (const t of catalog) {
    const name = `${t.schema}.${t.table}`;
    if (declared.has(name)) continue;
    const kernel = (t.schema === "core" || t.schema === "audit") && t.hasWorkspaceId;
    if (kernel || moduleSchemas.has(t.schema)) out.push(name);
  }
  return out;
}
