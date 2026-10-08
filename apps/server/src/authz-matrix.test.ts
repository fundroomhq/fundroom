import { readFileSync } from "node:fs";
import { loadAuthzMatrix, requirementTag } from "@fundroom/authz";
import { createModuleRegistry } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./api.js";
import { COMPILED_IN_MODULES } from "./modules.js";

/*
 * The generated authz matrix test (§6.4 "CI fails if any OpenAPI route lacks a matrix
 * entry"). Three facts are pinned:
 *  1. every operation in the generated document carries `x-requires` and it equals the
 *     matrix row (`<requires>` or `<requires>+fresh`);
 *  2. every matrix row corresponds to a real operation (no stale docs);
 *  3. every permission a compiled-in module declares has a matrix entry, so no role can
 *     silently hold nothing (or everything) for it.
 */
describe("authz matrix ⟷ OpenAPI", () => {
  const matrix = loadAuthzMatrix();
  const registry = createModuleRegistry(COMPILED_IN_MODULES);
  const doc = generateOpenApiDocument(registry);
  const ops: { method: string; path: string; requires: unknown }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        ops.push({ method: method.toUpperCase(), path, requires: op["x-requires"] });
      }
    }
  }

  it("every operation declares x-requires and matches its matrix row", () => {
    const problems: string[] = [];
    for (const op of ops) {
      const row = matrix.routes.find((r) => r.method === op.method && r.path === op.path);
      if (row === undefined) problems.push(`${op.method} ${op.path}: no row in authz-matrix.yaml`);
      else if (op.requires !== requirementTag(row))
        problems.push(
          `${op.method} ${op.path}: x-requires ${String(op.requires)} ≠ matrix ${requirementTag(row)}`,
        );
    }
    expect(problems).toEqual([]);
    expect(ops.length).toBeGreaterThan(60);
  });

  it("every matrix row is a real operation", () => {
    const missing = matrix.routes
      .filter((r) => !ops.some((op) => op.method === r.method && op.path === r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it("every compiled-in permission has a matrix entry", () => {
    const missing = [...registry.permissions.keys()].filter((p) => !matrix.permissions.has(p));
    expect(missing).toEqual([]);
  });

  it("the committed openapi.json carries the same x-requires (fundroom openapi is current)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../../packages/sdk/openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    for (const op of ops) {
      expect(committed.paths[op.path]?.[op.method.toLowerCase()]?.["x-requires"]).toBe(op.requires);
    }
  });
});
