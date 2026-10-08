import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { div, formatFixed, parseFixed, SCALE } from "../decimal.js";
import { MetricsError } from "../errors.js";
import type { Period } from "../period.js";
import { announcePointsChanged, applyCells, type CellWrite } from "./points.js";

/*
 * The three save rules of §9, pinned against the real `applyCells` and the real repositories.
 *
 * The seam is a fake `Tx` that answers the module's own SQL: the queries, the parameter order
 * and the hydration all run for real, so a change to `PointRepo.insert` that broke the
 * revision or the value string would fail here rather than in a Docker-bound integration test.
 * Matching on the statement text is deliberate — it is what makes an unexpected query loud
 * instead of silently answering `{ rows: [] }`.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const CASH = "01920000-0000-7000-8000-0000000000a1";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };

const MARCH: Period = {
  kind: "month",
  start: new Date("2026-03-01T00:00:00.000Z"),
  end: new Date("2026-04-01T00:00:00.000Z"),
};

/** Concatenates the literal fragments of a drizzle `sql` template. */
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

/** The bound parameters, in the order the statement interpolates them. */
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

interface LiveRow {
  readonly id: string;
  readonly definitionId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly value: string;
  readonly revision: number;
  readonly sourceKind: string | null;
}

interface InsertedPoint {
  readonly definitionId: string;
  readonly value: string;
  readonly revision: number;
  readonly needsReview: boolean;
  readonly sourceId: string | null;
}

interface AuditRow {
  readonly action: string;
  readonly meta: Record<string, unknown>;
}

function harness(live: readonly LiveRow[]) {
  const inserted: InsertedPoint[] = [];
  const superseded: { old: string; next: string }[] = [];
  const sources: string[] = [];
  const audits: AuditRow[] = [];
  const outbox: { topic: string; payload: Record<string, unknown> }[] = [];
  let ids = 0;

  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("FROM metrics.point_current")) {
        return {
          rows: live.map((r) => ({
            id: r.id,
            definitionId: r.definitionId,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            value: r.value,
            asOf: r.periodStart,
            sourceId: "old-source",
            sourceKind: r.sourceKind,
            revision: r.revision,
            needsReview: false,
            note: null,
            createdAt: r.periodStart,
          })),
        };
      }
      if (text.includes("INSERT INTO metrics.source")) {
        const id = `source-${sources.length + 1}`;
        sources.push(id);
        return { rows: [{ id }] };
      }
      if (text.includes("INSERT INTO metrics.point")) {
        const id = `point-${++ids}`;
        const row = {
          definitionId: params[1] as string,
          value: params[4] as string,
          sourceId: params[6] as string | null,
          revision: params[7] as number,
          needsReview: params[8] as boolean,
        };
        inserted.push(row);
        return {
          rows: [
            {
              id,
              definitionId: row.definitionId,
              periodStart: params[2] as Date,
              periodEnd: params[3] as Date,
              value: row.value,
              asOf: (params[5] as Date | null) ?? new Date(),
              sourceId: row.sourceId,
              sourceKind: null,
              revision: row.revision,
              needsReview: row.needsReview,
              note: params[9] as string | null,
              createdAt: new Date(),
            },
          ],
        };
      }
      if (text.includes("UPDATE metrics.point SET superseded_by")) {
        superseded.push({ old: params[2] as string, next: params[0] as string });
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          return {
            async returning() {
              outbox.push({ topic: v["topic"] as string, payload: v["payload"] as never });
              return [{ id: outbox.length }];
            },
          };
        },
      };
    },
  };

  const deps = {
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: AuditRow) {
        audits.push(input);
        return {} as never;
      },
    },
    now: () => new Date("2026-04-02T09:00:00.000Z"),
  } as unknown as Pick<ModuleServices, "audit" | "now">;

  return { tx: tx as unknown as Tx, deps, inserted, superseded, sources, audits, outbox };
}

const cell = (value: string | undefined, decimals = 2): CellWrite => ({
  definitionId: CASH,
  period: MARCH,
  value: value === undefined ? undefined : (parseFixed(value) as bigint),
  decimals,
});

const liveCash = (value: string, revision = 1, sourceKind: string | null = "manual"): LiveRow => ({
  id: "old-point",
  definitionId: CASH,
  periodStart: MARCH.start,
  periodEnd: MARCH.end,
  value,
  revision,
  sourceKind,
});

describe("applyCells", () => {
  it("writes nothing at all for a cell with no value — a blank is not a zero", async () => {
    const h = harness([]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell(undefined)],
      sourceKind: "manual",
    });
    expect(out).toMatchObject({ written: 0, restated: 0, unchanged: 0, skipped: 1 });
    expect(h.inserted).toEqual([]);
    // Not even a provenance row: a source for a batch that wrote nothing is a record of nothing.
    expect(h.sources).toEqual([]);
    expect(out.definitionIds).toEqual([]);
  });

  it("writes nothing when the value equals the live point, so saving twice is not a restatement storm", async () => {
    const h = harness([liveCash("1250.000000")]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("1250")],
      sourceKind: "manual",
    });
    expect(out).toMatchObject({ written: 0, restated: 0, unchanged: 1, skipped: 0 });
    expect(h.inserted).toEqual([]);
    expect(h.sources).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it("treats trailing zeros as the same number, because the column does", async () => {
    // `1250` and `1250.00` are one value in `numeric(20, 6)`; comparing the text would restate.
    const h = harness([liveCash("1250.000000")]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("1250.00")],
      sourceKind: "manual",
    });
    expect(out.unchanged).toBe(1);
    expect(h.inserted).toEqual([]);
  });

  it("writes revision 1 and supersedes nothing for a cell that had no point", async () => {
    const h = harness([]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("42")],
      sourceKind: "manual",
    });
    expect(out).toMatchObject({ written: 1, restated: 0, unchanged: 0, skipped: 0 });
    expect(h.inserted).toEqual([
      { definitionId: CASH, value: "42.00", revision: 1, needsReview: false, sourceId: "source-1" },
    ]);
    expect(h.superseded).toEqual([]);
    // A first value is not a restatement, so there is no restatement row to read.
    expect(h.audits).toEqual([]);
    expect(out.definitionIds).toEqual([CASH]);
  });

  it("restates a differing cell: revision + 1, the old row superseded, both figures audited", async () => {
    const h = harness([liveCash("1250.000000")]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("1300.5")],
      sourceKind: "manual",
      actor: { membershipId: "01920000-0000-7000-8000-0000000000b1", requestId: "req-1" },
    });
    expect(out).toMatchObject({ written: 0, restated: 1, unchanged: 0 });
    expect(h.inserted[0]).toMatchObject({ revision: 2, value: "1300.50" });
    // Insert first, then link: the old row's `superseded_by` must name a row that exists.
    expect(h.superseded).toEqual([{ old: "old-point", next: "point-1" }]);

    const audit = h.audits[0];
    expect(audit?.action).toBe("metrics.point_restated");
    expect(audit?.meta).toMatchObject({
      periodKey: "2026-03",
      fromRevision: 1,
      toRevision: 2,
      sourceKind: "manual",
    });
    // Decimal *strings*: a JSON number here would round the figure the row exists to prove.
    expect(audit?.meta["oldValue"]).toBe("1250.00");
    expect(audit?.meta["newValue"]).toBe("1300.50");
    expect(typeof audit?.meta["oldValue"]).toBe("string");

    expect(h.outbox).toEqual([
      {
        topic: "metric.restated",
        payload: {
          definitionId: CASH,
          periodStart: "2026-03-01T00:00:00.000Z",
          fromRevision: 1,
          toRevision: 2,
          sourceKind: "manual",
        },
      },
    ]);
  });

  it("shares one source row across the cells of a batch", async () => {
    const h = harness([]);
    await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("1"), { ...cell("2"), definitionId: "01920000-0000-7000-8000-0000000000a2" }],
      sourceKind: "csv",
      sourceRef: { importId: "imp-1", line: 7 },
    });
    expect(h.sources).toEqual(["source-1"]);
    expect(h.inserted.map((i) => i.sourceId)).toEqual(["source-1", "source-1"]);
  });

  describe("a sheets sync never silently overwrites a number a person typed", () => {
    it("flags the new revision for review when the live point came from a human", async () => {
      const h = harness([liveCash("1250.000000", 1, "manual")]);
      const out = await applyCells(h.tx, ctx, h.deps, {
        cells: [cell("1400")],
        sourceKind: "sheets",
        reviewPolicy: "when_manual",
      });
      expect(out.needsReview).toBe(1);
      expect(h.inserted[0]).toMatchObject({ revision: 2, needsReview: true, value: "1400.00" });
      // The number still changes — the sheet is the source of record going forward — but the
      // admin screen can show both figures instead of the change happening overnight.
      expect(out.restated).toBe(1);
      expect(h.audits[0]?.meta).toMatchObject({ needsReview: true, sourceKind: "sheets" });
    });

    it("does not flag a value the sheet itself wrote last night", async () => {
      const h = harness([liveCash("1250.000000", 1, "sheets")]);
      const out = await applyCells(h.tx, ctx, h.deps, {
        cells: [cell("1400")],
        sourceKind: "sheets",
        reviewPolicy: "when_manual",
      });
      expect(out.needsReview).toBe(0);
      expect(h.inserted[0]?.needsReview).toBe(false);
    });

    it("does not flag anything under the grid's own policy", async () => {
      const h = harness([liveCash("1250.000000", 1, "manual")]);
      const out = await applyCells(h.tx, ctx, h.deps, {
        cells: [cell("1400")],
        sourceKind: "manual",
        reviewPolicy: "never",
      });
      expect(out.needsReview).toBe(0);
      expect(h.inserted[0]?.needsReview).toBe(false);
    });
  });

  describe("the no-op rule holds at the precision the metric is kept at", () => {
    /*
     * The defect this replaced: the comparison asked `existing.value !== c.value` at the full
     * 1e6 scale while the store wrote `formatFixed(value, decimals)` with the rest discarded,
     * so a stored row could never equal the cell that produced it whenever `decimals < 6` —
     * and 0 is the column's default. Every one of these cases wrote a revision, an audit row
     * reading `old:'1250', new:'1250'` and a `metric.restated` event, for ever.
     */
    it("writes once for `1250.4` at decimals 0 and never again, however often it is typed", async () => {
      const first = harness([]);
      const out = await applyCells(first.tx, ctx, first.deps, {
        cells: [cell("1250.4", 0)],
        sourceKind: "manual",
      });
      expect(out).toMatchObject({ written: 1, restated: 0, unchanged: 0 });
      // What the column will hold, not what was typed: the stored figure and the compared
      // figure are the same number now.
      expect(first.inserted[0]?.value).toBe("1250");

      // The row the first save wrote, read back exactly as Postgres returns it.
      const stored = harness([liveCash("1250.000000")]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const again = await applyCells(stored.tx, ctx, stored.deps, {
          cells: [cell("1250.4", 0)],
          sourceKind: "manual",
        });
        expect({ attempt, ...again }).toMatchObject({
          attempt,
          written: 0,
          restated: 0,
          unchanged: 1,
        });
      }
      expect(stored.inserted).toEqual([]);
      expect(stored.audits).toEqual([]);
      expect(stored.outbox).toEqual([]);
    });

    it("does the same at decimals 2, where the third place is the one thrown away", async () => {
      const h = harness([liveCash("1250.460000")]);
      const out = await applyCells(h.tx, ctx, h.deps, {
        cells: [cell("1250.4567", 2)],
        sourceKind: "manual",
      });
      expect(out).toMatchObject({ written: 0, restated: 0, unchanged: 1 });
      expect(h.inserted).toEqual([]);
    });

    it("restates only when the figure moves at that precision", async () => {
      // 1250.4 → 1250.6 is invisible at decimals 0 and is not a restatement; → 1251.4 is.
      const same = harness([liveCash("1250.000000")]);
      expect(
        await applyCells(same.tx, ctx, same.deps, {
          cells: [cell("1250.4", 0)],
          sourceKind: "manual",
        }),
      ).toMatchObject({ unchanged: 1, restated: 0 });

      const moved = harness([liveCash("1250.000000")]);
      expect(
        await applyCells(moved.tx, ctx, moved.deps, {
          cells: [cell("1251.4", 0)],
          sourceKind: "manual",
        }),
      ).toMatchObject({ unchanged: 0, restated: 1 });
      expect(moved.inserted[0]?.value).toBe("1251");
    });

    it("leaves a derived `1/3` alone on every recompute after the first", async () => {
      /*
       * The unattended one. `runway = cash / net_burn` with cash 1 and burn 3 evaluates to
       * 0.333333, stores `"0"` at decimals 0, and used to restate itself on every recompute —
       * and a recompute runs on every grid save, every CSV import and every nightly sheets
       * sync. Revision numbers and audit rows grew without bound with nobody touching a thing.
       */
      const third = div(SCALE, 3n * SCALE) as bigint;
      expect(formatFixed(third, 0)).toBe("0");

      const fresh = harness([]);
      await applyCells(fresh.tx, ctx, fresh.deps, {
        cells: [{ definitionId: CASH, period: MARCH, value: third, decimals: 0 }],
        sourceKind: "derived",
      });
      expect(fresh.inserted[0]?.value).toBe("0");

      const stored = harness([liveCash("0.000000")]);
      const out = await applyCells(stored.tx, ctx, stored.deps, {
        cells: [{ definitionId: CASH, period: MARCH, value: third, decimals: 0 }],
        sourceKind: "derived",
      });
      expect(out).toMatchObject({ written: 0, restated: 0, unchanged: 1 });
      expect(stored.inserted).toEqual([]);
      expect(stored.audits).toEqual([]);
      expect(stored.outbox).toEqual([]);
    });

    it("does not restate a row that was written before `decimals` was narrowed", async () => {
      // The live row carries six places because the metric used to; it now renders "1250",
      // and so does the incoming value. Nothing a reader can see has changed.
      const h = harness([liveCash("1250.490000")]);
      expect(
        await applyCells(h.tx, ctx, h.deps, { cells: [cell("1250.4", 0)], sourceKind: "manual" }),
      ).toMatchObject({ unchanged: 1, restated: 0 });
      expect(h.inserted).toEqual([]);
    });
  });

  it("refuses a value the column cannot hold instead of letting Postgres 500 it", async () => {
    /*
     * `99999999999999.6` is a figure `numeric(20, 6)` holds and `parseFixed` accepts — and
     * rounding it to this metric's `decimals: 0` makes it 10^14, which the column refuses with
     * `22003`. That is not a `MetricsError`, so `rethrow` passed it through and the caller got
     * a 500 on a number they typed. It is refused here, after the quantise and before the
     * insert, naming the cell so a form can point at it.
     */
    const h = harness([]);
    const attempt = applyCells(h.tx, ctx, h.deps, {
      cells: [cell("99999999999999.6", 0)],
      sourceKind: "manual",
    });
    await expect(attempt).rejects.toBeInstanceOf(MetricsError);
    await expect(attempt).rejects.toMatchObject({
      code: "validation_failed",
      details: { definitionId: CASH, periodKey: "2026-03", field: "value" },
    });
    expect(h.inserted).toEqual([]);
  });

  it("collapses a repeated cell instead of racing itself into a unique violation", async () => {
    /*
     * The live points are read once for the whole batch, so two copies of one cell computed
     * the same `revision` and the second insert hit `point_revision_unique` (`23505`) — an
     * `internal_error` on a body a client can send by accident. `PUT /grid` refuses a
     * duplicate outright and names it; here, where the caller is a CSV worker or a nightly
     * sync, the last statement about the cell is taken as the caller's final word.
     */
    const h = harness([]);
    const out = await applyCells(h.tx, ctx, h.deps, {
      cells: [cell("1"), cell("2")],
      sourceKind: "csv",
    });
    expect(out).toMatchObject({ written: 1, restated: 0, unchanged: 0, skipped: 0 });
    expect(h.inserted).toEqual([
      { definitionId: CASH, value: "2.00", revision: 1, needsReview: false, sourceId: "source-1" },
    ]);
  });

  it("stores the value at the definition's precision, as text", async () => {
    const h = harness([]);
    await applyCells(h.tx, ctx, h.deps, {
      cells: [{ ...cell("1234.56789", 4) }],
      sourceKind: "manual",
    });
    expect(h.inserted[0]?.value).toBe("1234.5679");
    expect(formatFixed(parseFixed("1234.56789") as bigint, 4)).toBe("1234.5679");
  });
});

describe("announcePointsChanged", () => {
  it("publishes one event for a whole batch", async () => {
    const h = harness([]);
    await announcePointsChanged(h.tx, ctx, [CASH, "01920000-0000-7000-8000-0000000000a2"]);
    expect(h.outbox).toEqual([
      {
        topic: "metric.points_changed",
        payload: { definitionIds: [CASH, "01920000-0000-7000-8000-0000000000a2"] },
      },
    ]);
  });

  it("says nothing when nothing moved", async () => {
    const h = harness([]);
    await announcePointsChanged(h.tx, ctx, []);
    expect(h.outbox).toEqual([]);
  });
});
