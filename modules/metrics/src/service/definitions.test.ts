import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { MetricsError } from "../errors.js";
import type { Formula } from "../formula.js";
import { createDefinitionService } from "./definitions.js";

/*
 * Definition CRUD, and specifically the three refusals §9 asks for by name: an unknown
 * reference, a cycle and the `aggregation = 'last'` rule. Each has to come back as a
 * `validation_failed` naming the offending key — not as a 500 from a CHECK constraint, and not
 * as a recompute that loops.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const actor = { membershipId: "01920000-0000-7000-8000-0000000000b1" };

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

function sqlParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object" || node instanceof Date) {
    out.push(node);
    return out;
  }
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlParams(k, out);
    return out;
  }
  if ("encoder" in c) {
    out.push(c["value"]);
    return out;
  }
  if (Array.isArray(c["value"])) return out;
  out.push(node);
  return out;
}

interface Existing {
  readonly id: string;
  readonly key: string;
  readonly formula?: Formula | undefined;
}

const rowOf = (e: Existing) => ({
  id: e.id,
  key: e.key,
  name: e.key,
  description: null,
  unit: "count",
  currency: null,
  aggregation: "last",
  direction: "up_good",
  periodKind: "month",
  decimals: 0,
  formula: e.formula ?? null,
  display: {},
  audience: { kind: "staff_only" },
  sortOrder: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
});

function harness(existing: readonly Existing[]) {
  const audits: { action: string }[] = [];
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("SELECT key, formula FROM metrics.definition")) {
        return { rows: existing.filter((e) => e.formula !== undefined).map(rowOf) };
      }
      if (text.includes("INSERT INTO metrics.definition")) {
        const row = {
          ...rowOf({ id: "new-id", key: params[1] as string }),
          name: params[2] as string,
          unit: params[4],
          currency: params[5],
          aggregation: params[6],
          formula: params[10] === null ? null : JSON.parse(params[10] as string),
        };
        inserted.push(row);
        return { rows: [row] };
      }
      if (text.includes("FROM metrics.definition")) {
        if (text.includes("AND id =")) {
          const hit = existing.find((e) => e.id === params[1]);
          return { rows: hit === undefined ? [] : [rowOf(hit)] };
        }
        if (text.includes("AND key =")) {
          const hit = existing.find((e) => e.key === params[1]);
          return { rows: hit === undefined ? [] : [rowOf(hit)] };
        }
        return { rows: existing.map(rowOf) };
      }
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: { action: string }) {
        audits.push(input);
        return {} as never;
      },
    },
    now: () => new Date("2026-03-01T00:00:00Z"),
  } as unknown as ModuleServices;
  return { services, audits, inserted };
}

const REF = (key: string): Formula => ({ op: "ref", key });
const DIV = (a: string, b: string): Formula => ({ op: "div", args: [REF(a), REF(b)] });

const base = { name: "Runway", unit: "months" as const };

describe("createDefinitionService.create", () => {
  it("creates a plain metric and audits it", async () => {
    const h = harness([]);
    const created = await createDefinitionService(h.services).create(
      ctx,
      { key: "cash", name: "Cash", unit: "currency", currency: "USD" },
      actor,
    );
    expect(created.key).toBe("cash");
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.definition_created"]);
  });

  it("refuses a formula that names a metric the workspace does not have, and says which", async () => {
    const h = harness([{ id: "1", key: "cash" }]);
    const svc = createDefinitionService(h.services);
    const failure = await svc
      .create(ctx, { ...base, key: "runway", formula: DIV("cash", "net_burn") }, actor)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MetricsError);
    const error = failure as MetricsError;
    expect(error.code).toBe("validation_failed");
    expect(error.details).toMatchObject({ field: "formula", key: "net_burn" });
    expect(error.message).toContain("net_burn");
    expect(h.inserted).toEqual([]);
  });

  it("refuses a formula that reads the metric it defines", async () => {
    const h = harness([{ id: "1", key: "cash" }]);
    const failure = await createDefinitionService(h.services)
      .create(ctx, { ...base, key: "runway", formula: DIV("runway", "cash") }, actor)
      .catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).details).toMatchObject({ key: "runway", cycle: true });
  });

  it("refuses a formula that would close a loop through another metric", async () => {
    /*
     * The recompute cascade terminates *because* the graph is acyclic, so this is not a nicety:
     * a cycle admitted here would be a loop inside a background job.
     */
    const h = harness([
      { id: "1", key: "cash" },
      { id: "2", key: "alpha", formula: REF("beta") },
      { id: "3", key: "beta", formula: REF("gamma") },
    ]);
    const failure = await createDefinitionService(h.services)
      .create(ctx, { ...base, key: "gamma", formula: REF("alpha") }, actor)
      .catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).code).toBe("validation_failed");
    expect((failure as MetricsError).details).toMatchObject({ key: "gamma", cycle: true });
    expect(h.inserted).toEqual([]);
  });

  it("refuses a derived metric that claims to sum across periods", async () => {
    const h = harness([{ id: "1", key: "cash" }]);
    const failure = await createDefinitionService(h.services)
      .create(ctx, { ...base, key: "runway", formula: REF("cash"), aggregation: "sum" }, actor)
      .catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).details).toMatchObject({ field: "aggregation" });
  });

  it("forces `last` on a derived metric that says nothing about aggregation", async () => {
    const h = harness([{ id: "1", key: "cash" }]);
    await createDefinitionService(h.services).create(
      ctx,
      { ...base, key: "runway", formula: REF("cash") },
      actor,
    );
    expect(h.inserted[0]?.["aggregation"]).toBe("last");
  });

  it("refuses a duplicate key as a conflict rather than letting the index raise", async () => {
    const h = harness([{ id: "1", key: "cash" }]);
    const failure = await createDefinitionService(h.services)
      .create(ctx, { key: "cash", name: "Cash", unit: "count" }, actor)
      .catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).code).toBe("conflict");
  });

  it("spells out the currency CHECK as a field error", async () => {
    const h = harness([]);
    const svc = createDefinitionService(h.services);
    await expect(
      svc.create(ctx, { key: "arr", name: "ARR", unit: "currency" }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "currency" } });
    await expect(
      svc.create(ctx, { key: "heads", name: "Headcount", unit: "count", currency: "USD" }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "currency" } });
  });
});

describe("createDefinitionService.remove", () => {
  it("refuses while another metric's formula still reads this one", async () => {
    const h = harness([
      { id: "1", key: "cash" },
      { id: "2", key: "runway", formula: REF("cash") },
    ]);
    const failure = await createDefinitionService(h.services)
      .remove(ctx, "1", actor)
      .catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).code).toBe("conflict");
    expect((failure as MetricsError).details).toMatchObject({ dependents: ["runway"] });
  });
});
