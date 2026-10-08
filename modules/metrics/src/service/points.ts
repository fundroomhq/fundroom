import type { TenantContext, Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { fits, formatFixed, quantize } from "../decimal.js";
import { type Actor, MetricsError } from "../errors.js";
import type { SourceKind } from "../model.js";
import type { Period } from "../period.js";
import { formatPeriodKey } from "../period.js";
import { PointRepo, type PointRow, SourceRepo } from "../repos/metrics-repo.js";

/*
 * The one place a `metrics.point` is written (E2.4 §9, D3). Every writer — the period grid,
 * the per-definition points route, the CSV worker, the Sheets sync and the derived recompute
 * — goes through `applyCells`, because the three rules below are the whole model and a second
 * implementation of them would eventually get one wrong:
 *
 *  1. **`undefined` writes nothing.** A cell with no value is not a zero. `formula.evaluate`
 *     already returns `undefined` for a missing input or a division by zero (§6), a blank CSV
 *     cell is `undefined`, and a cleared grid cell is `undefined`; all four mean "there is no
 *     number for this period", which is a gap in the chart and the truth.
 *  2. **An equal value writes nothing.** Re-saving the grid must not be a restatement storm:
 *     a workspace that types twelve numbers and presses save twice has restated nothing.
 *  3. **A different value is a restatement**, never an overwrite: revision + 1, the old row
 *     superseded, an audit row carrying both figures, and a `metric.restated` event.
 *
 * Rule 2 is only true if "equal" is asked at the precision the value is *kept* at. This used
 * to compare `existing.value !== c.value` at the full 1e6 scale while storing
 * `formatFixed(value, decimals)` with the rest thrown away, so a stored row could never equal
 * the cell that produced it whenever `decimals < 6` — and 0 is the column's default. Typing
 * `1250.4` into a `decimals: 0` cell wrote a revision every single time, each with an audit row
 * reading `old:'1250', new:'1250'`; worse, `runway = cash / net_burn` evaluating to `0.333333`
 * at `decimals: 0` restated itself on **every** recompute, and a recompute runs on every grid
 * save, every CSV import and every nightly sheets sync. So the comparison and the store are one
 * decision now: `quantize(value, decimals)`, applied here, once, for every writer.
 *
 * Rule 3 is why the caller must already be inside **one** `withTenant` transaction. The
 * exclusion constraint `point_one_live_per_period` is DEFERRABLE INITIALLY DEFERRED (contract
 * §12 C2) precisely so the new row and the supersede of the old one can both exist mid
 * transaction; split them across two transactions and the insert fails, or worse, succeeds
 * and leaves two live rows for one period if the second never runs.
 */

/** What the writer is told about one `(definition, period)` cell. */
export interface CellWrite {
  readonly definitionId: string;
  readonly period: Period;
  /** Fixed-point at scale 1e6, or `undefined` for "no point here" — never coerced to zero. */
  readonly value: bigint | undefined;
  /** Render precision, for the decimal strings that go on the audit row. */
  readonly decimals: number;
  readonly note?: string | null | undefined;
  /** When the value was asserted to be true; defaults to now. */
  readonly asOf?: Date | undefined;
}

export interface WriteOutcome {
  readonly written: number;
  readonly unchanged: number;
  readonly restated: number;
  readonly skipped: number;
  readonly needsReview: number;
  /** Definitions actually touched — the payload of `metric.points_changed`. */
  readonly definitionIds: readonly string[];
}

/**
 * When a differing value should be flagged for a human.
 *
 * `when_manual` is the Sheets rule (§8, design/06 §7): a sync that finds a different number for
 * a period whose current point came from a person writes the new revision with
 * `needs_review = true`, so the admin screen can say "the sheet disagrees with what you typed"
 * instead of the number changing under them overnight. Everything else writes `false`.
 */
export type ReviewPolicy = "never" | "when_manual";

/** The two kernel services a write needs; taken as a slice so tests can hand in a pair. */
export type ApplyDeps = Pick<ModuleServices, "audit" | "now">;

export interface ApplyInput {
  readonly cells: readonly CellWrite[];
  readonly sourceKind: SourceKind;
  /** `metrics.source.ref`: which import run, which sync, which formula (§3.2). */
  readonly sourceRef?: Record<string, unknown> | undefined;
  readonly actor?: Actor | undefined;
  readonly reviewPolicy?: ReviewPolicy | undefined;
}

const cellKey = (definitionId: string, periodStart: Date) =>
  `${definitionId}|${periodStart.getTime()}`;

/**
 * Collapses two statements about one `(definition, period)` cell, last one winning.
 *
 * The live points are read once for the whole batch, so two copies of a cell computed the same
 * `revision` and the second insert hit `point_revision_unique` — a `23505` the route turned
 * into a 500 on a body a client can send by accident. `PUT /grid` refuses a duplicate outright
 * and names it (`GridService.save`), because two different numbers for one cell is a request
 * that cannot mean one thing; this is the structural guard behind that for the non-interactive
 * writers, where aborting a whole nightly sync over a repeated row would be the worse answer.
 */
function dedupe(cells: readonly CellWrite[]): CellWrite[] {
  const byCell = new Map<string, CellWrite>();
  for (const c of cells) byCell.set(cellKey(c.definitionId, c.period.start), c);
  return [...byCell.values()];
}

/**
 * Applies a batch of cells inside the caller's transaction and returns what it did.
 *
 * The live points are read **once** for the whole batch rather than per cell: a 20 × 12 grid
 * save is one query here and 240 with the obvious loop, and the difference is visible on a
 * screen an admin saves every few minutes.
 */
export async function applyCells(
  tx: Tx,
  ctx: TenantContext,
  deps: ApplyDeps,
  input: ApplyInput,
): Promise<WriteOutcome> {
  const deduped = dedupe(input.cells);
  /*
   * Quantised once, here, at the precision the definition declares — the value that is compared
   * below and the value that is stored are now the same bigint by construction.
   */
  const live = deduped.flatMap((c) =>
    c.value === undefined ? [] : [{ ...c, value: quantize(c.value, c.decimals) }],
  );
  const skipped = deduped.length - live.length;
  if (live.length === 0) {
    return { written: 0, unchanged: 0, restated: 0, skipped, needsReview: 0, definitionIds: [] };
  }

  const points = new PointRepo(ctx, tx);
  const definitionIds = [...new Set(live.map((c) => c.definitionId))];
  const earliest = new Date(Math.min(...live.map((c) => c.period.start.getTime())));
  const current = new Map<string, PointRow>();
  for (const row of await points.series(definitionIds, earliest)) {
    current.set(cellKey(row.definitionId, row.periodStart), row);
  }

  // Decide first, then write: a source row for a batch that turns out to be entirely no-ops
  // would be provenance for nothing, and `metrics.source` is meant to be readable.
  const changes = live.filter((c) => {
    const existing = current.get(cellKey(c.definitionId, c.period.start));
    // The stored side is quantised too. A row written before the definition's `decimals` was
    // narrowed carries finer places than the metric is now kept at; restating it would be a
    // change nobody made and nobody can see.
    return existing === undefined || quantize(existing.value, c.decimals) !== c.value;
  });
  const unchanged = live.length - changes.length;
  if (changes.length === 0) {
    return { written: 0, unchanged, restated: 0, skipped, needsReview: 0, definitionIds: [] };
  }

  /*
   * Decide first, then write — the same rule the no-op check above follows, and here it also
   * means a batch is refused whole rather than half-inserted. `numeric(20, 6)` would refuse
   * one of these with `22003`, which is not a `MetricsError`, so `rethrow` passed it to the
   * caller as a 500 on a number they typed. Rounding to `decimals` is what carries a value
   * over the edge — `99999999999999.6` at `decimals: 0` is 10^14 — so the test belongs after
   * the quantise, and it names the cell so a form can point at it.
   */
  for (const cell of changes) {
    if (fits(cell.value)) continue;
    throw new MetricsError(
      "validation_failed",
      `\`${formatFixed(cell.value, cell.decimals)}\` is too large for a metric value (at most 14 digits before the decimal point)`,
      {
        definitionId: cell.definitionId,
        periodKey: formatPeriodKey(cell.period),
        field: "value",
      },
    );
  }

  const sourceId = await new SourceRepo(ctx, tx).insert({
    kind: input.sourceKind,
    ref: input.sourceRef ?? {},
    importedBy: input.actor?.membershipId ?? null,
  });

  const touched = new Set<string>();
  let written = 0;
  let restated = 0;
  let needsReviewCount = 0;
  for (const cell of changes) {
    const value = cell.value;
    const existing = current.get(cellKey(cell.definitionId, cell.period.start));
    const needsReview =
      existing !== undefined &&
      input.reviewPolicy === "when_manual" &&
      existing.sourceKind === "manual";
    const inserted = await points.insert({
      definitionId: cell.definitionId,
      periodStart: cell.period.start,
      periodEnd: cell.period.end,
      value: formatFixed(value, cell.decimals),
      revision: (existing?.revision ?? 0) + 1,
      asOf: cell.asOf ?? deps.now(),
      sourceId,
      needsReview,
      note: cell.note ?? null,
      createdBy: input.actor?.membershipId ?? null,
    });
    touched.add(cell.definitionId);
    if (needsReview) needsReviewCount += 1;

    if (existing === undefined) {
      written += 1;
      continue;
    }
    // Insert first, then link: the old row's `superseded_by` must name a row that exists, and
    // the deferred exclusion constraint is what makes the window between the two legal.
    await points.supersede(existing.id, inserted.id);
    restated += 1;
    await deps.audit.record(tx, ctx, {
      action: "metrics.point_restated",
      resourceKind: "metric_definition",
      resourceId: cell.definitionId,
      ...(input.actor === undefined
        ? { actorKind: "system" as const, actorMembershipId: null }
        : { actorMembershipId: input.actor.membershipId }),
      ...(input.actor?.requestId === undefined ? {} : { requestId: input.actor.requestId }),
      ...(input.actor?.apiKeyId === undefined ? {} : { apiKeyId: input.actor.apiKeyId }),
      meta: {
        periodKey: formatPeriodKey(cell.period),
        periodStart: cell.period.start.toISOString(),
        fromRevision: existing.revision,
        toRevision: inserted.revision,
        // Decimal *strings* (§5). A JSON number here would round the very figure the audit row
        // exists to prove, and this row is the record an auditor reads.
        oldValue: formatFixed(existing.value, cell.decimals),
        newValue: formatFixed(value, cell.decimals),
        sourceKind: input.sourceKind,
        needsReview,
      },
    });
    await publish(tx, ctx, "metric.restated", {
      definitionId: cell.definitionId,
      periodStart: cell.period.start.toISOString(),
      fromRevision: existing.revision,
      toRevision: inserted.revision,
      sourceKind: input.sourceKind,
    });
  }

  return {
    written,
    unchanged,
    restated,
    skipped,
    needsReview: needsReviewCount,
    definitionIds: [...touched],
  };
}

/**
 * Announces a points write so the derived metrics that read them are recomputed (§6).
 *
 * Deliberately separate from `applyCells` and called **once per batch**: the recompute handler
 * walks the whole dependency graph in one pass, so one event per grid save is enough and one
 * event per cell would be 240 jobs that each do the same work.
 */
export async function announcePointsChanged(
  tx: Tx,
  ctx: TenantContext,
  definitionIds: readonly string[],
): Promise<void> {
  if (definitionIds.length === 0) return;
  // The catalogue caps the payload at 500 ids; a workspace with more metrics than that in one
  // write is not a shape this product has, and truncating beats failing the whole transaction.
  await publish(tx, ctx, "metric.points_changed", { definitionIds: definitionIds.slice(0, 500) });
}
