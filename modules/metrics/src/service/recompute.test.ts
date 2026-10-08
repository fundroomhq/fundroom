import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import type { Formula } from "../formula.js";
import type { DefinitionRow } from "../repos/metrics-repo.js";
import { dependencyOrder, recompute } from "./recompute.js";

/*
 * Derived recompute. The half that matters most is negative: a missing input and a division by
 * zero must produce **no point**, not a zero — `evaluate` already answers `undefined` and the
 * test below is what keeps something downstream from coercing it.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const NOW = new Date("2026-03-15T12:00:00.000Z");

const id = (n: number) => `01920000-0000-7000-8000-0000000000${n.toString().padStart(2, "0")}`;
const CASH = id(1);
const BURN = id(2);
const RUNWAY = id(3);

function definition(over: Partial<DefinitionRow> & { id: string; key: string }): DefinitionRow {
  return {
    name: over.key,
    description: null,
    unit: "count",
    currency: null,
    aggregation: "last",
    direction: "up_good",
    periodKind: "month",
    decimals: 2,
    formula: null,
    display: {},
    audience: { kind: "staff_only" },
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...over,
  } as DefinitionRow;
}

const DIVIDE: Formula = {
  op: "div",
  args: [
    { op: "ref", key: "cash" },
    { op: "ref", key: "net_burn" },
  ],
};

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

interface LivePoint {
  readonly definitionId: string;
  readonly periodStart: string;
  readonly value: string;
}

function harness(definitions: readonly DefinitionRow[], live: readonly LivePoint[]) {
  const inserted: { definitionId: string; periodStart: Date; value: string }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("FROM metrics.definition")) {
        return { rows: definitions.map((d) => ({ ...d, formula: d.formula })) };
      }
      if (text.includes("FROM metrics.point_current")) {
        return {
          rows: live.map((p, i) => ({
            id: `live-${i}`,
            definitionId: p.definitionId,
            periodStart: new Date(p.periodStart),
            periodEnd: new Date(p.periodStart),
            value: p.value,
            asOf: new Date(p.periodStart),
            sourceId: null,
            sourceKind: "manual",
            revision: 1,
            needsReview: false,
            note: null,
            createdAt: new Date(p.periodStart),
          })),
        };
      }
      if (text.includes("INSERT INTO metrics.source")) return { rows: [{ id: "source-1" }] };
      if (text.includes("INSERT INTO metrics.point")) {
        inserted.push({
          definitionId: params[1] as string,
          periodStart: params[2] as Date,
          value: params[4] as string,
        });
        return {
          rows: [
            {
              id: `new-${inserted.length}`,
              definitionId: params[1] as string,
              periodStart: params[2] as Date,
              periodEnd: params[3] as Date,
              value: params[4] as string,
              asOf: NOW,
              sourceId: params[6] as string,
              sourceKind: "derived",
              revision: params[7] as number,
              needsReview: params[8] as boolean,
              note: null,
              createdAt: NOW,
            },
          ],
        };
      }
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  const services = {
    audit: {
      async record() {
        return {} as never;
      },
    },
    now: () => NOW,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
  } as unknown as Pick<ModuleServices, "audit" | "now" | "log">;
  return { tx: tx as unknown as Tx, services, inserted, logs };
}

const DEFINITIONS = [
  definition({ id: CASH, key: "cash" }),
  definition({ id: BURN, key: "net_burn" }),
  definition({ id: RUNWAY, key: "runway", formula: DIVIDE }),
];

describe("dependencyOrder", () => {
  it("puts a metric after every derived metric it reads", () => {
    const a: Formula = { op: "ref", key: "raw" };
    const b: Formula = { op: "ref", key: "a" };
    const c: Formula = {
      op: "add",
      args: [
        { op: "ref", key: "b" },
        { op: "ref", key: "a" },
      ],
    };
    const order = dependencyOrder([
      definition({ id: id(9), key: "c", formula: c }),
      definition({ id: id(8), key: "b", formula: b }),
      definition({ id: id(7), key: "a", formula: a }),
    ]);
    expect(order.map((d) => d.key)).toEqual(["a", "b", "c"]);
  });

  it("drops rather than loops over a cycle that somehow reached the table", () => {
    // `wouldCycle` refuses these before they are stored, so reaching here means a hand-edited
    // row — which must not be able to hang a worker.
    const loopA: Formula = { op: "ref", key: "b" };
    const loopB: Formula = { op: "ref", key: "a" };
    const order = dependencyOrder([
      definition({ id: id(7), key: "a", formula: loopA }),
      definition({ id: id(8), key: "b", formula: loopB }),
    ]);
    expect(order).toEqual([]);
  });
});

describe("recompute", () => {
  it("writes a point for a period where every input has a number", async () => {
    const h = harness(DEFINITIONS, [
      { definitionId: CASH, periodStart: "2026-01-01T00:00:00Z", value: "1200.000000" },
      { definitionId: BURN, periodStart: "2026-01-01T00:00:00Z", value: "100.000000" },
    ]);
    const result = await recompute(h.tx, ctx, h.services, [CASH]);
    expect(result.recomputed).toBe(1);
    expect(h.inserted).toEqual([
      { definitionId: RUNWAY, periodStart: new Date("2026-01-01T00:00:00.000Z"), value: "12.00" },
    ]);
  });

  it("writes NO point when a division by zero happened — not a zero", async () => {
    /*
     * `runway = cash / net_burn` with a burn of zero is a company that is not spending money.
     * Reporting its runway as zero would be a lie in the alarming direction, and reporting
     * `Infinity` would put a glyph where a number belongs. The chart shows a gap.
     */
    const h = harness(DEFINITIONS, [
      { definitionId: CASH, periodStart: "2026-02-01T00:00:00Z", value: "1200.000000" },
      { definitionId: BURN, periodStart: "2026-02-01T00:00:00Z", value: "0.000000" },
    ]);
    const result = await recompute(h.tx, ctx, h.services, [BURN]);
    expect(result.recomputed).toBe(1);
    expect(result.written).toBe(0);
    expect(h.inserted).toEqual([]);
  });

  it("writes NO point when an input is missing for that period", async () => {
    const h = harness(DEFINITIONS, [
      { definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1200.000000" },
    ]);
    const result = await recompute(h.tx, ctx, h.services, [CASH]);
    expect(result.recomputed).toBe(1);
    expect(h.inserted).toEqual([]);
  });

  it("skips a period whose answer will not fit the column, and keeps the rest", async () => {
    /*
     * The formula engine can overflow `numeric(20, 6)` with no large input at all: `a + b`
     * with both at 99999999999999 does it. The insert then fails with `22003` — which aborts
     * the **whole** recompute transaction, on every retry, for every other metric and every
     * other period in the workspace. One period that cannot be represented is skipped exactly
     * the way a division by zero is: the chart shows a gap and the rest of the graph still
     * recomputes.
     */
    const SUM: Formula = {
      op: "add",
      args: [
        { op: "ref", key: "cash" },
        { op: "ref", key: "net_burn" },
      ],
    };
    const total = id(5);
    const definitions = [
      definition({ id: CASH, key: "cash" }),
      definition({ id: BURN, key: "net_burn" }),
      definition({ id: total, key: "total", formula: SUM }),
    ];
    const h = harness(definitions, [
      { definitionId: CASH, periodStart: "2026-01-01T00:00:00Z", value: "99999999999999.000000" },
      { definitionId: BURN, periodStart: "2026-01-01T00:00:00Z", value: "99999999999999.000000" },
      { definitionId: CASH, periodStart: "2026-02-01T00:00:00Z", value: "10.000000" },
      { definitionId: BURN, periodStart: "2026-02-01T00:00:00Z", value: "5.000000" },
    ]);
    const result = await recompute(h.tx, ctx, h.services, [CASH]);
    expect(result.recomputed).toBe(1);
    // January is gone; February is still there, which is the property the transaction abort
    // destroyed — one unrepresentable period used to take every other one down with it.
    expect(h.inserted).toEqual([
      { definitionId: total, periodStart: new Date("2026-02-01T00:00:00.000Z"), value: "15.00" },
    ]);
    // Silent to a reader, but an operator can find out why the gap is there.
    expect(h.logs.map((l) => l.event)).toContain("metrics.recompute_overflow");
    expect(h.logs.find((l) => l.event === "metrics.recompute_overflow")?.fields).toMatchObject({
      level: "warn",
      key: "total",
      periodKey: "2026-01",
    });
  });

  it("writes a derived 1/3 once and leaves it alone on every pass after that", async () => {
    /*
     * The unattended restatement storm. `runway = cash / net_burn` with cash 1 and burn 3 is
     * 0.333333, which a `decimals: 0` metric stores as `"0"` — and the comparison used to be
     * made at the full 1e6 scale, so every recompute found `333333 !== 0`, wrote a revision
     * and emitted a `metric.restated`. A recompute runs on every grid save, every CSV import
     * and every nightly sheets sync.
     */
    const coarse = [
      definition({ id: CASH, key: "cash" }),
      definition({ id: BURN, key: "net_burn" }),
      definition({ id: RUNWAY, key: "runway", formula: DIVIDE, decimals: 0 }),
    ];
    const inputs: LivePoint[] = [
      { definitionId: CASH, periodStart: "2026-01-01T00:00:00Z", value: "1.000000" },
      { definitionId: BURN, periodStart: "2026-01-01T00:00:00Z", value: "3.000000" },
    ];

    const fresh = harness(coarse, inputs);
    expect(await recompute(fresh.tx, ctx, fresh.services, [CASH])).toMatchObject({ written: 1 });
    expect(fresh.inserted).toEqual([
      { definitionId: RUNWAY, periodStart: new Date("2026-01-01T00:00:00.000Z"), value: "0" },
    ]);

    // The row that write produced, read back the way Postgres returns it.
    const again = harness(coarse, [
      ...inputs,
      { definitionId: RUNWAY, periodStart: "2026-01-01T00:00:00Z", value: "0.000000" },
    ]);
    const second = await recompute(again.tx, ctx, again.services, [CASH]);
    expect(second).toMatchObject({ recomputed: 1, written: 0, restated: 0 });
    expect(again.inserted).toEqual([]);
  });

  it("leaves derived metrics alone when nothing they read moved", async () => {
    const other = id(4);
    const h = harness([...DEFINITIONS, definition({ id: other, key: "headcount" })], []);
    const result = await recompute(h.tx, ctx, h.services, [other]);
    expect(result).toEqual({ recomputed: 0, written: 0, restated: 0 });
    expect(h.inserted).toEqual([]);
  });

  it("does nothing when the workspace has no derived metrics at all", async () => {
    const h = harness([DEFINITIONS[0] as DefinitionRow], []);
    expect(await recompute(h.tx, ctx, h.services, [CASH])).toEqual({
      recomputed: 0,
      written: 0,
      restated: 0,
    });
  });
});
