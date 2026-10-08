import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { MetricsError } from "../errors.js";
import type { Formula } from "../formula.js";
import { createGridService, type GridCellInput } from "./grid.js";

/*
 * `PUT /grid` end to end through the service: which requests it refuses, and the three save
 * rules counted the way the route reports them. `applyCells` has its own tests; what is pinned
 * here is the translation from a request cell to a write, which is where a period key, a
 * period *kind* and a derived metric all have to be refused rather than guessed at.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const actor = { membershipId: "01920000-0000-7000-8000-0000000000b1" };
const CASH = "01920000-0000-7000-8000-0000000000a1";
const RUNWAY = "01920000-0000-7000-8000-0000000000a3";
const QUARTERLY = "01920000-0000-7000-8000-0000000000a4";

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

const definition = (over: Record<string, unknown>) => ({
  id: CASH,
  key: "cash",
  name: "Cash",
  description: null,
  unit: "currency",
  currency: "USD",
  aggregation: "last",
  direction: "up_good",
  periodKind: "month",
  decimals: 2,
  formula: null as Formula | null,
  display: {},
  audience: { kind: "staff_only" },
  sortOrder: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  ...over,
});

const DEFINITIONS = [
  definition({}),
  definition({ id: RUNWAY, key: "runway", formula: { op: "ref", key: "cash" } }),
  definition({ id: QUARTERLY, key: "bookings", periodKind: "quarter" }),
];

const AUTHOR = "01920000-0000-7000-8000-0000000000b1";

function harness(
  live: readonly { definitionId: string; periodStart: string; value: string }[],
  options: { readonly createdBy?: string | null | undefined } = {},
) {
  const inserted: { value: string; revision: number }[] = [];
  const audits: { action: string; meta?: Record<string, unknown> }[] = [];
  const outbox: { topic: string }[] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("FROM metrics.definition")) return { rows: DEFINITIONS };
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
            createdBy: options.createdBy === undefined ? AUTHOR : options.createdBy,
            createdAt: new Date(p.periodStart),
          })),
        };
      }
      if (text.includes("FROM metrics.point p")) {
        // `revisionsAt` reads history, not the live view: every revision of one cell, newest
        // first, which is what makes a restatement provable.
        return {
          rows: live.map((p, i) => ({
            id: `rev-${i}`,
            definitionId: p.definitionId,
            periodStart: new Date(p.periodStart),
            periodEnd: new Date(p.periodStart),
            value: p.value,
            asOf: new Date(p.periodStart),
            sourceId: null,
            sourceKind: "manual",
            revision: live.length - i,
            needsReview: false,
            note: null,
            createdBy: options.createdBy === undefined ? AUTHOR : options.createdBy,
            createdAt: new Date(p.periodStart),
          })),
        };
      }
      if (text.includes("INSERT INTO metrics.source")) return { rows: [{ id: "source-1" }] };
      if (text.includes("INSERT INTO metrics.point")) {
        inserted.push({ value: params[4] as string, revision: params[7] as number });
        return {
          rows: [
            {
              id: `new-${inserted.length}`,
              definitionId: params[1] as string,
              periodStart: params[2] as Date,
              periodEnd: params[3] as Date,
              value: params[4] as string,
              asOf: new Date(),
              sourceId: params[6] as string,
              sourceKind: "manual",
              revision: params[7] as number,
              needsReview: params[8] as boolean,
              note: null,
              createdAt: new Date(),
            },
          ],
        };
      }
      if (text.includes("UPDATE metrics.point SET superseded_by")) return { rows: [] };
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          return {
            async returning() {
              outbox.push({ topic: v["topic"] as string });
              return [{ id: outbox.length }];
            },
          };
        },
      };
    },
  };
  const selects: unknown[] = [];
  /** `MembershipRepo.namesFor` is a drizzle builder chain, faked down to the rows it awaits. */
  const nameChain = {
    from: () => nameChain,
    innerJoin: () => nameChain,
    leftJoin: () => nameChain,
    where: async () => [
      { id: AUTHOR, kind: "staff", role: "admin", displayName: "Ada Lovelace", email: null },
    ],
  };
  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => {
        const select = (...args: unknown[]) => {
          selects.push(args);
          return nameChain;
        };
        return fn({ ...tx, select } as unknown as Tx);
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: { action: string }) {
        audits.push(input);
        return {} as never;
      },
    },
    now: () => new Date("2026-04-02T09:00:00Z"),
  } as unknown as ModuleServices;
  return { services, inserted, audits, outbox, selects };
}

const cell = (over: Partial<GridCellInput> = {}): GridCellInput => ({
  definitionId: CASH,
  periodKey: "2026-03",
  value: "1300",
  ...over,
});

const save = (h: ReturnType<typeof harness>, cells: GridCellInput[]) =>
  createGridService(h.services).save(ctx, { periodKind: "month", cells }, actor);

describe("grid save", () => {
  it("writes a new cell, announces it once and records a save summary", async () => {
    const h = harness([]);
    const out = await save(h, [cell()]);
    expect(out).toMatchObject({ written: 1, restated: 0, unchanged: 0, skipped: 0 });
    expect(h.inserted).toEqual([{ value: "1300.00", revision: 1 }]);
    expect(h.outbox.map((o) => o.topic)).toEqual(["metric.points_changed"]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.points_saved"]);
  });

  it("writes nothing, announces nothing and audits nothing when the value has not moved", async () => {
    const h = harness([
      { definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1300.000000" },
    ]);
    const out = await save(h, [cell()]);
    expect(out).toMatchObject({ written: 0, restated: 0, unchanged: 1 });
    expect(h.inserted).toEqual([]);
    // No event either: an investor must not be told a number changed when it did not.
    expect(h.outbox).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("restates a cell that differs and reports it as a restatement", async () => {
    const h = harness([
      { definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1250.000000" },
    ]);
    const out = await save(h, [cell()]);
    expect(out).toMatchObject({ written: 0, restated: 1 });
    expect(h.inserted).toEqual([{ value: "1300.00", revision: 2 }]);
    expect(h.audits.map((a) => a.action)).toEqual([
      "metrics.point_restated",
      "metrics.points_saved",
    ]);
    expect(h.outbox.map((o) => o.topic)).toEqual(["metric.restated", "metric.points_changed"]);
  });

  it("writes nothing for a null cell and leaves the live point alone", async () => {
    const h = harness([
      { definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1250.000000" },
    ]);
    const out = await save(h, [cell({ value: null })]);
    expect(out).toMatchObject({ skipped: 1, written: 0, restated: 0, unchanged: 0 });
    expect(h.inserted).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it("refuses a hand-typed value for a derived metric", async () => {
    // A recompute would silently replace it, and the admin would watch their correction vanish.
    const h = harness([]);
    const failure = await save(h, [cell({ definitionId: RUNWAY })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect(failure).toBeInstanceOf(MetricsError);
    expect((failure as MetricsError).details).toMatchObject({ key: "runway", derived: true });
  });

  it("refuses a metric reported at another period kind", async () => {
    const h = harness([]);
    const failure = await save(h, [cell({ definitionId: QUARTERLY })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect((failure as MetricsError).details).toMatchObject({ periodKind: "quarter" });
  });

  it("refuses a period key that is not of the metric's kind", async () => {
    const h = harness([]);
    const failure = await save(h, [cell({ periodKey: "2026-Q1" })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect((failure as MetricsError).details).toMatchObject({ periodKey: "2026-Q1" });
  });

  it("refuses an unreadable figure rather than skipping the cell the admin came to fix", async () => {
    const h = harness([]);
    const failure = await save(h, [cell({ value: "1,300" })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect((failure as MetricsError).code).toBe("validation_failed");
    expect((failure as MetricsError).details).toMatchObject({ field: "value" });
  });

  it("refuses a figure too wide for the column, and says so rather than 'is not a number'", async () => {
    /*
     * The only inputs that reach `parseFixed` here are well-formed decimals — `DecimalSchema`
     * refused the rest at the route — so "is not a number" described a case that cannot
     * happen and hid the one that can. Fifteen integral digits is a 400 naming the range, not
     * a `22003` from Postgres arriving as a 500.
     */
    const h = harness([]);
    const failure = await save(h, [cell({ value: "100000000000000" })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect((failure as MetricsError).code).toBe("validation_failed");
    expect((failure as MetricsError).message).toMatch(/out of range/u);
    expect((failure as MetricsError).message).toMatch(/14 digits/u);
    expect(h.inserted).toEqual([]);
  });

  it("refuses a value that only overflows once this metric's decimals round it", async () => {
    // `99999999999999.6` fits the column; at `decimals: 2` — this grid's metric — it still
    // does, so what is pinned is the round trip through `applyCells`, which is where the
    // refusal lives for a metric whose rounding would carry it out of range.
    const h = harness([]);
    const failure = await save(h, [cell({ value: "99999999999999.999" })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect((failure as MetricsError).code).toBe("validation_failed");
    expect((failure as MetricsError).details).toMatchObject({
      definitionId: CASH,
      periodKey: "2026-03",
      field: "value",
    });
    expect(h.inserted).toEqual([]);
  });

  it("refuses a body that names one cell twice instead of 500ing on the unique index", async () => {
    /*
     * Both copies read the same live point, so both computed the same `revision` and the
     * second insert raised `point_revision_unique` — an `internal_error` on a body a client
     * can send by accident. Refusing beats last-one-wins: two different numbers for one cell
     * is a request that cannot mean one thing, and committing one of them silently would
     * publish a figure the admin never chose.
     */
    const h = harness([]);
    const failure = await save(h, [cell({ value: "1300" }), cell({ value: "1400" })]).catch(
      (e: unknown) => e as MetricsError,
    );
    expect(failure).toBeInstanceOf(MetricsError);
    expect((failure as MetricsError).code).toBe("validation_failed");
    expect((failure as MetricsError).details).toMatchObject({
      definitionId: CASH,
      key: "cash",
      periodKey: "2026-03",
    });
    // Nothing was written: the refusal happens while the save is still being planned.
    expect(h.inserted).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it("compares the period a row would be written for, not the text of the key", async () => {
    /*
     * The uniqueness the index enforces is on `(workspace, definition, period, revision)`, so
     * the check is keyed on the parsed period and runs at whatever kind the grid is. Two
     * cells for one quarter are one cell twice however they were spelled.
     */
    const h = harness([]);
    const failure = await createGridService(h.services)
      .save(
        ctx,
        {
          periodKind: "quarter",
          cells: [
            { definitionId: QUARTERLY, periodKey: "2026-Q1", value: "1" },
            { definitionId: QUARTERLY, periodKey: "2026-Q1", value: "2" },
          ],
        },
        actor,
      )
      .catch((e: unknown) => e as MetricsError);
    expect(failure).toBeInstanceOf(MetricsError);
    expect((failure as MetricsError).details).toMatchObject({
      key: "bookings",
      periodKey: "2026-Q1",
    });
    expect(h.inserted).toEqual([]);
  });

  it("refuses a definition that is not this workspace's", async () => {
    const h = harness([]);
    const failure = await save(h, [
      cell({ definitionId: "01920000-0000-7000-8000-00000000ffff" }),
    ]).catch((e: unknown) => e as MetricsError);
    expect((failure as MetricsError).code).toBe("validation_failed");
  });
});

/*
 * Who wrote a revision. A restatement register that can prove *what* changed and *from which
 * source* but not *who* answers three quarters of the question an auditor is asking.
 */
describe("restatement authorship", () => {
  const history = (h: ReturnType<typeof harness>) =>
    createGridService(h.services).history(ctx, CASH, { periodKey: "2026-03", limit: 50 });

  it("resolves the author of each revision to a name", async () => {
    const h = harness([
      { definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1250.000000" },
    ]);
    const result = await history(h);
    expect(result.points[0]?.author).toEqual({
      membershipId: AUTHOR,
      displayName: "Ada Lovelace",
    });
  });

  it("reports no author for a revision no person wrote", async () => {
    // A sheets sync and a derived recompute have a source but genuinely have no author; a
    // placeholder name there would invent a person who did not touch the number.
    const h = harness(
      [{ definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1250.000000" }],
      { createdBy: null },
    );
    const result = await history(h);
    expect(result.points[0]?.author).toBeNull();
  });

  it("resolves the whole page in one lookup, not one per revision", async () => {
    /*
     * The N+1 this guards against is invisible until the workspace with the longest history
     * opens the dialog: a dozen revisions, a dozen round trips, on a screen somebody opens per
     * metric per period.
     */
    const h = harness(
      Array.from({ length: 12 }, (_, i) => ({
        definitionId: CASH,
        periodStart: "2026-03-01T00:00:00Z",
        value: `${1000 + i}.000000`,
      })),
    );
    const result = await history(h);
    expect(result.points).toHaveLength(12);
    expect(result.points.every((p) => p.author?.displayName === "Ada Lovelace")).toBe(true);
    expect(h.selects).toHaveLength(1);
  });

  it("asks for no names at all when nothing had an author", async () => {
    const h = harness(
      [{ definitionId: CASH, periodStart: "2026-03-01T00:00:00Z", value: "1250.000000" }],
      { createdBy: null },
    );
    await history(h);
    expect(h.selects).toHaveLength(0);
  });
});
