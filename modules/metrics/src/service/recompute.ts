import { createHash } from "node:crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { EventHandler } from "@fundroom/events";
import { onceByKey } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { fits, quantize } from "../decimal.js";
import { evaluate, type Formula, referencedKeys } from "../formula.js";
import type { CalendarPeriodKind } from "../period.js";
import { DefinitionRepo, type DefinitionRow, PointRepo } from "../repos/metrics-repo.js";
import { applyCells, type CellWrite } from "./points.js";
import { foldValues, type PeriodColumn, periodColumns } from "./series.js";

/*
 * Derived metrics, recomputed from the outbox (E2.4 §6).
 *
 * Writing points emits `metric.points_changed`; the module subscribes to **its own topic** and
 * recomputes every derived definition whose formula reads one of the metrics that moved, in
 * dependency order. Doing it here rather than inline in the writer is what keeps a grid save
 * fast and what makes a CSV import, a Sheets sync and a hand edit all produce the same cascade
 * without three copies of it.
 *
 * Two properties are worth stating because the obvious implementations lose them.
 *
 * **It does not re-publish.** One pass walks the whole dependency graph in topological order,
 * so a metric derived from a metric derived from a raw number is correct after a single event.
 * Emitting `metric.points_changed` for the points *this* handler writes would be a cascade that
 * terminates only because `wouldCycle` refused the loops — which is true, but it would also be
 * N jobs deep for an N-deep graph, each redoing the work of the last.
 *
 * **A missing input or a division by zero yields no point, never a zero.** `evaluate` already
 * answers `undefined` (§6), and nothing between it and the column may coerce that: `runway =
 * cash / net_burn` in a month with no burn is not a company with no runway, and a zero there
 * would be a lie in the alarming direction. A derived period with no point is a gap in the
 * chart, which is what actually happened.
 */

/**
 * How far back a recompute looks, in periods of the derived metric's own kind. Ten years of
 * months. A bound rather than "all history" because this runs on every points write: without
 * one, a workspace that has been publishing for a decade re-evaluates its whole past every
 * time somebody fixes last month's headcount.
 */
export const RECOMPUTE_WINDOW_PERIODS = 120;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Derived definitions in dependency order: a metric comes after every derived metric it reads.
 *
 * Kahn's algorithm over the derived keys only — a reference to a manual metric is a leaf. The
 * graph is acyclic by construction (`wouldCycle` refuses a formula that would close a loop
 * before it is ever stored), and anything left over after the queue drains is dropped rather
 * than looped over: a cycle that somehow reached the table must not be able to hang a worker.
 */
export function dependencyOrder(derived: readonly DefinitionRow[]): DefinitionRow[] {
  const byKey = new Map(derived.map((d) => [d.key.toLowerCase(), d]));
  const pending = new Map<string, Set<string>>();
  for (const d of derived) {
    const formula = d.formula as Formula;
    const needs = new Set(
      referencedKeys(formula)
        .map((k) => k.toLowerCase())
        .filter((k) => byKey.has(k) && k !== d.key.toLowerCase()),
    );
    pending.set(d.key.toLowerCase(), needs);
  }
  const out: DefinitionRow[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [key, needs] of pending) {
      if (done.has(key)) continue;
      if ([...needs].every((n) => done.has(n))) {
        const row = byKey.get(key);
        if (row !== undefined) out.push(row);
        done.add(key);
        progressed = true;
      }
    }
  }
  return out;
}

/** The inputs one formula reads in one period, folded to the derived metric's own columns. */
function inputsFor(
  formula: Formula,
  byKey: ReadonlyMap<string, DefinitionRow>,
  pointsByDefinition: ReadonlyMap<string, readonly { periodStart: Date; value: bigint }[]>,
  column: PeriodColumn,
): Map<string, bigint> {
  const inputs = new Map<string, bigint>();
  const start = column.period.start.getTime();
  const end = column.period.end.getTime();
  for (const key of referencedKeys(formula)) {
    const definition = byKey.get(key.toLowerCase());
    if (definition === undefined) continue;
    const points = pointsByDefinition.get(definition.id) ?? [];
    const inside = points.filter((p) => {
      const at = p.periodStart.getTime();
      return at >= start && at < end;
    });
    // The input may be entered at a finer grain than the derived metric is reported at, which
    // is exactly what `aggregation` is for; when the kinds match this is the identity.
    const folded = foldValues(definition.aggregation, inside);
    if (folded !== undefined) inputs.set(key, folded);
  }
  return inputs;
}

export interface RecomputeResult {
  readonly recomputed: number;
  readonly written: number;
  readonly restated: number;
}

/** Recomputes every derived metric affected by `changedIds`, inside the caller's transaction. */
export async function recompute(
  tx: Tx,
  ctx: TenantContext,
  services: Pick<ModuleServices, "audit" | "now" | "log">,
  changedIds: readonly string[],
): Promise<RecomputeResult> {
  const definitions = new DefinitionRepo(ctx, tx);
  const all = await definitions.list();
  const byKey = new Map(all.map((d) => [d.key.toLowerCase(), d]));
  const derived = all.filter((d) => d.formula !== null);
  if (derived.length === 0) return { recomputed: 0, written: 0, restated: 0 };

  const changed = new Set(
    all.filter((d) => changedIds.includes(d.id)).map((d) => d.key.toLowerCase()),
  );
  if (changed.size === 0) return { recomputed: 0, written: 0, restated: 0 };

  const points = new PointRepo(ctx, tx);
  const now = services.now();
  let recomputed = 0;
  let written = 0;
  let restated = 0;

  for (const definition of dependencyOrder(derived)) {
    const formula = definition.formula as Formula;
    const refs = referencedKeys(formula).map((k) => k.toLowerCase());
    if (!refs.some((k) => changed.has(k))) continue;
    // Its own output becomes an input that moved, so a metric derived from this one is
    // recomputed later in the same pass rather than by a second event.
    changed.add(definition.key.toLowerCase());
    recomputed += 1;

    /*
     * `custom` has no canonical column series, so a derived metric cannot be reported at it:
     * there is no rule that says which arbitrary range this period's answer belongs to. The
     * definition is left alone rather than half-computed.
     */
    if (definition.periodKind === "custom") continue;
    const kind = definition.periodKind as CalendarPeriodKind;
    const columns = periodColumns(kind, now, RECOMPUTE_WINDOW_PERIODS);
    const first = columns[0];
    if (first === undefined) continue;

    const inputIds = refs
      .map((k) => byKey.get(k))
      .filter((d): d is DefinitionRow => d !== undefined)
      .map((d) => d.id);
    if (inputIds.length === 0) continue;
    // Reads `metrics.point_current` inside this transaction, so an input written moments ago by
    // the same grid save — or by an earlier metric in this very loop — is already visible.
    const live = await points.series(inputIds, first.period.start);
    const byDefinition = new Map<string, { periodStart: Date; value: bigint }[]>();
    for (const p of live) {
      const bucket = byDefinition.get(p.definitionId);
      if (bucket === undefined) byDefinition.set(p.definitionId, [p]);
      else bucket.push(p);
    }

    const cells: CellWrite[] = [];
    for (const column of columns) {
      const inputs = inputsFor(formula, byKey, byDefinition, column);
      if (inputs.size === 0) continue;
      const value = evaluate(formula, inputs);
      // `undefined` here is a missing input or a division by zero. It is not a zero and it must
      // not become one: no cell is queued, so `applyCells` writes nothing for this period.
      if (value === undefined) continue;
      /*
       * A formula can overflow `numeric(20, 6)` with no large input at all — `a + b` with both
       * at 99999999999999 does it — and the insert then fails with `22003`, aborting the whole
       * recompute transaction on every retry, for every other metric in the workspace. One
       * period that cannot be represented is skipped exactly the way a division by zero is:
       * the chart shows a gap, which is the truth, and the rest of the graph still recomputes.
       */
      if (!fits(quantize(value, definition.decimals))) {
        services.log("metrics.recompute_overflow", {
          level: "warn",
          workspaceId: ctx.workspaceId,
          definitionId: definition.id,
          key: definition.key,
          periodKey: column.key,
        });
        continue;
      }
      cells.push({
        definitionId: definition.id,
        period: column.period,
        value,
        decimals: definition.decimals,
      });
    }
    if (cells.length === 0) continue;

    const outcome = await applyCells(
      tx,
      ctx,
      { audit: services.audit, now: services.now },
      {
        cells,
        sourceKind: "derived",
        sourceRef: { formulaSha256: sha256(JSON.stringify(formula)), inputs: inputIds },
        reviewPolicy: "never",
      },
    );
    written += outcome.written;
    restated += outcome.restated;
  }
  return { recomputed, written, restated };
}

/**
 * The `metric.points_changed` subscriber.
 *
 * Deduped on the outbox row id the way `modules/analytics/src/ingest.ts:42-50` does, because
 * the relay delivers at least once: a redelivery that recomputed again would be harmless for
 * the numbers (an equal value writes nothing) but would race the first delivery's inserts
 * against the one-live-point-per-period exclusion constraint.
 */
export function createRecomputeHandler(getServices: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx, job }) => {
    if (ctx.actorKind === "host") return;
    const tenant = ctx as TenantContext;
    const payload = event.payload as { definitionIds?: unknown };
    const ids = Array.isArray(payload.definitionIds)
      ? payload.definitionIds.filter((x): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) return;
    const services = getServices();
    const fromJob = Number.parseInt(
      String((job.data as { outboxId?: unknown }).outboxId ?? ""),
      10,
    );
    const outboxId = Number.isFinite(fromJob) ? fromJob : event.outboxId;
    const claimed = await onceByKey(tx, tenant, `metrics.recompute:${outboxId}`, () =>
      recompute(tx, tenant, services, ids),
    );
    if (claimed.skipped) return;
    if (claimed.result.recomputed > 0) {
      services.log("metrics.recomputed", {
        workspaceId: tenant.workspaceId,
        ...claimed.result,
      });
    }
  };
}
