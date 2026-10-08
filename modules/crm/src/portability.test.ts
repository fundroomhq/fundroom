import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crmModule } from "./index.js";
import { crmPortability } from "./portability.js";

/*
 * The spec must name every table the migrations create, in an order where each table comes
 * after the tables it references — so a new table without a portability decision fails here,
 * in the module's own unit test, before the kernel-wide completeness test ever runs.
 */
const SCHEMA = "crm";

function migrationTables(): { names: string[]; refs: Map<string, Set<string>> } {
  const dir = new URL("../migrations/", import.meta.url);
  const sqlText = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
  const names: string[] = [];
  const refs = new Map<string, Set<string>>();
  const create = new RegExp(
    `CREATE TABLE ${SCHEMA}\\.([a-z_][a-z0-9_]*) \\(([\\s\\S]*?)\\n\\)`,
    "gu",
  );
  for (const m of sqlText.matchAll(create)) {
    const name = m[1] as string;
    names.push(name);
    const deps = new Set<string>();
    for (const r of (m[2] as string).matchAll(
      new RegExp(`REFERENCES ${SCHEMA}\\.([a-z_][a-z0-9_]*)`, "gu"),
    )) {
      if (r[1] !== name) deps.add(r[1] as string);
    }
    refs.set(name, deps);
  }
  for (const m of sqlText.matchAll(
    new RegExp(`DROP TABLE (?:IF EXISTS )?${SCHEMA}\\.([a-z_][a-z0-9_]*)`, "gu"),
  )) {
    names.splice(names.indexOf(m[1] as string), 1);
  }
  return { names, refs };
}

describe("crm portability", () => {
  it("is declared on the manifest", () => {
    expect(crmModule.portability).toBe(crmPortability);
  });

  it("covers every table of the migrations, in FK dependency order", () => {
    const { names, refs } = migrationTables();
    const declared = crmPortability.tables.map((t) => t.table);
    expect([...declared].sort()).toEqual([...names].sort());
    for (const [table, deps] of refs) {
      for (const dep of deps) {
        expect(declared.indexOf(dep), `${dep} before ${table}`).toBeLessThan(
          declared.indexOf(table),
        );
      }
    }
  });

  it("carries every table as rows with no transform (nothing secret, keyed or blob-backed)", () => {
    for (const t of crmPortability.tables) {
      expect(t.mode).toBe("rows");
      expect(t.omitColumns ?? []).toEqual([]);
      expect(t.blobs ?? []).toEqual([]);
      expect(t.importRow).toBeUndefined();
      expect(t.includeWhen).toBeUndefined();
    }
    expect(crmPortability.after ?? []).toEqual([]);
  });

  it("relies on the engine stripping contact.search_tsv, which is GENERATED", () => {
    const sqlText = readFileSync(new URL("../migrations/0001_crm.sql", import.meta.url), "utf8");
    expect(sqlText).toMatch(/search_tsv tsvector GENERATED ALWAYS AS/u);
  });
});
