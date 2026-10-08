import type { TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { add, div, SCALE } from "../decimal.js";
import type { Aggregation } from "../model.js";
import {
  type CalendarPeriodKind,
  formatPeriodKey,
  type Period,
  periodLabel,
  periodSeries,
} from "../period.js";
import {
  DefinitionRepo,
  type DefinitionRow,
  PointRepo,
  type PointRow,
} from "../repos/metrics-repo.js";

/*
 * Reading a series (E2.4 §9 `GET /series`, and the shape the grid, the hydrator and the chart
 * all want underneath).
 *
 * `GET /series` is `member`, not a permission, and that is the whole access decision: what an
 * investor sees is settled by the metric's audience inside RLS
 * (`metrics.audience_admits_current`), not by RBAC. Staff calling it see everything, which is
 * exactly why the admin screens use `/grid` and `/definitions` — `/series` is the portal's and
 * the email's shape, not the editor's.
 *
 * Nothing here re-implements the audience check in TypeScript. The repo runs in the caller's
 * tenant context and the database drops the rows; a second check up here would be a second
 * place to get it wrong, and the one that matters is the one a raw `SELECT` also obeys.
 */

/** A column: the period itself plus the two strings every consumer renders. */
export interface PeriodColumn {
  readonly period: Period;
  readonly key: string;
  readonly label: string;
}

export function periodColumns(kind: CalendarPeriodKind, end: Date, count: number): PeriodColumn[] {
  return periodSeries(kind, end, count).map((period) => ({
    period,
    key: formatPeriodKey(period),
    label: periodLabel(period),
  }));
}

/**
 * Folds the points that fall inside one column.
 *
 * This is what `aggregation` is for: a metric entered monthly, charted quarterly. When the
 * requested period kind matches the definition's, every bucket holds at most one point and all
 * three rules are the identity — so the common case costs nothing and the uncommon one is
 * still honest.
 *
 * An empty bucket is `undefined`, not zero (§6). `avg` divides by the points that *exist*, not
 * by the length of the period: three months of data in a quarter averages three numbers, and
 * pretending the missing month was a zero would drag the average towards it.
 */
export function foldValues(
  aggregation: Aggregation,
  points: readonly { readonly periodStart: Date; readonly value: bigint }[],
): bigint | undefined {
  if (points.length === 0) return undefined;
  switch (aggregation) {
    case "sum":
      return points.reduce((acc, p) => add(acc, p.value), 0n);
    case "avg": {
      const total = points.reduce((acc, p) => add(acc, p.value), 0n);
      // Through `div`, not `/`: BigInt division truncates towards zero, and this module rounds
      // half away from zero everywhere because that is what the founder's spreadsheet does.
      return div(total, BigInt(points.length) * SCALE);
    }
    default: {
      let latest = points[0] as { periodStart: Date; value: bigint };
      for (const p of points)
        if (p.periodStart.getTime() >= latest.periodStart.getTime()) latest = p;
      return latest.value;
    }
  }
}

/**
 * One definition's values, aligned with `columns` and oldest first. `undefined` is a gap.
 *
 * The points are bucketed by which column's half-open range contains their `period_start`,
 * which is what lets a monthly series answer a quarterly question without the caller knowing
 * anything about calendars.
 */
export function alignSeries(
  definition: Pick<DefinitionRow, "aggregation">,
  points: readonly PointRow[],
  columns: readonly PeriodColumn[],
): (bigint | undefined)[] {
  return columns.map((column) => {
    const start = column.period.start.getTime();
    const end = column.period.end.getTime();
    const inside = points.filter((p) => {
      const at = p.periodStart.getTime();
      return at >= start && at < end;
    });
    return foldValues(definition.aggregation, inside);
  });
}

export interface SeriesQueryInput {
  readonly periodKind: CalendarPeriodKind;
  readonly periods: number;
  readonly end?: Date | undefined;
  /** Restrict to these definition ids; ids the reader may not see simply do not come back. */
  readonly ids?: readonly string[] | undefined;
}

export interface SeriesEntry {
  readonly definition: DefinitionRow;
  readonly values: readonly (bigint | undefined)[];
}

export interface SeriesResult {
  readonly columns: readonly PeriodColumn[];
  readonly entries: readonly SeriesEntry[];
}

export function createSeriesService(services: ModuleServices) {
  const { db } = services;

  /**
   * `asOf` reads *history* rather than the live view: a chart already sitting in somebody's
   * inbox must keep showing what was true when the mail was sent, so a restatement made
   * afterwards does not silently rewrite a message they already received (§9.1).
   */
  async function read(
    ctx: TenantContext,
    input: SeriesQueryInput,
    asOf?: Date,
  ): Promise<SeriesResult> {
    const columns = periodColumns(input.periodKind, input.end ?? services.now(), input.periods);
    const first = columns[0];
    if (first === undefined) return { columns: [], entries: [] };
    return db.withTenant(ctx, async (tx) => {
      const definitions = new DefinitionRepo(ctx, tx);
      // `byIds` and `list` both run under the caller's RLS, so an id the reader may not see
      // returns no row and is dropped — it is never reported as "hidden", which would tell an
      // investor that a metric they cannot see exists.
      const rows =
        input.ids === undefined ? await definitions.list() : await definitions.byIds(input.ids);
      if (rows.length === 0) return { columns, entries: [] };
      const points = new PointRepo(ctx, tx);
      const ids = rows.map((r) => r.id);
      const all =
        asOf === undefined
          ? await points.series(ids, first.period.start)
          : await points.seriesAsOf(ids, asOf, first.period.start);
      const byDefinition = new Map<string, PointRow[]>();
      for (const p of all) {
        const bucket = byDefinition.get(p.definitionId);
        if (bucket === undefined) byDefinition.set(p.definitionId, [p]);
        else bucket.push(p);
      }
      return {
        columns,
        entries: rows.map((definition) => ({
          definition,
          values: alignSeries(definition, byDefinition.get(definition.id) ?? [], columns),
        })),
      };
    });
  }

  return { read };
}

export type SeriesService = ReturnType<typeof createSeriesService>;
