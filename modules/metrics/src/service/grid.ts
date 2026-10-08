import type { TenantContext } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { parseFixed } from "../decimal.js";
import { type Actor, MetricsError } from "../errors.js";
import { type CalendarPeriodKind, parsePeriodKey } from "../period.js";
import {
  DefinitionRepo,
  type DefinitionRow,
  PointRepo,
  type PointRow,
} from "../repos/metrics-repo.js";
import { announcePointsChanged, applyCells, type CellWrite, type WriteOutcome } from "./points.js";
import { type PeriodColumn, periodColumns } from "./series.js";

/*
 * The period grid (E2.4 §9 `GET/PUT /grid`) — metrics down, periods across, which is the
 * screen an admin actually types numbers into.
 *
 * Its save rules are the substance of this file and each one is pinned by a test:
 *
 *  - a cell sent as `null` writes **nothing**. It is not a zero and it is not a delete:
 *    `metrics.point` is append-only, so the only way to change a published figure is to
 *    restate it to another figure;
 *  - a cell equal to the live point writes **nothing**, so pressing save twice is not a
 *    restatement storm and an investor is not told a number changed when it did not. Equality
 *    is asked at the metric's own `decimals`, which is the precision the value is kept at —
 *    `applyCells` quantises once and compares and stores that, so a figure that renders
 *    unchanged writes nothing even when the admin typed more places than the metric holds;
 *  - a cell that differs writes revision + 1 and supersedes the old row, inside **one**
 *    transaction with its audit row and its outbox event (contract §12 C2: the exclusion
 *    constraint is DEFERRABLE INITIALLY DEFERRED precisely so those two rows can coexist
 *    mid-transaction).
 *
 * All three live in `applyCells`; this file's job is to turn a request into cells, and to
 * refuse the requests that cannot mean what they say.
 */

export interface GridCellInput {
  readonly definitionId: string;
  readonly periodKey: string;
  /** Decimal text, or `null` for "there is no point for this cell". */
  readonly value: string | null;
  readonly note?: string | null | undefined;
}

export interface GridView {
  readonly periodKind: CalendarPeriodKind;
  readonly columns: readonly PeriodColumn[];
  readonly definitions: readonly DefinitionRow[];
  readonly cells: readonly { readonly periodKey: string; readonly point: PointRow }[];
}

/** Who wrote a revision, resolved once for the whole page (see `authorsOf`). */
export interface PointAuthor {
  readonly membershipId: string;
  readonly displayName: string;
}

export interface PointHistory {
  readonly definition: DefinitionRow;
  readonly points: readonly {
    readonly point: PointRow;
    readonly current: boolean;
    /** `null` for a revision no person wrote — a sheets sync, a derived recompute. */
    readonly author: PointAuthor | null;
  }[];
}

/** Turns one request cell into a `CellWrite`, or refuses it with a field-level error. */
function planCell(
  cell: GridCellInput,
  definition: DefinitionRow,
  expected: CalendarPeriodKind,
): CellWrite {
  if (definition.formula !== null) {
    /*
     * A derived metric's points are computed from its inputs every time one of them moves
     * (§6). Accepting a hand-typed value would store a number that the next recompute silently
     * replaces, which is worse than refusing: the admin would watch their correction disappear
     * overnight with nothing to explain it.
     */
    throw new MetricsError(
      "validation_failed",
      `\`${definition.key}\` is derived from a formula; edit its inputs instead`,
      { definitionId: definition.id, key: definition.key, derived: true },
    );
  }
  if (definition.periodKind !== expected) {
    throw new MetricsError(
      "validation_failed",
      `\`${definition.key}\` is a ${definition.periodKind} metric and this grid is ${expected}`,
      { definitionId: definition.id, key: definition.key, periodKind: definition.periodKind },
    );
  }
  const period = parsePeriodKey(definition.periodKind, cell.periodKey);
  if (period === undefined) {
    throw new MetricsError(
      "validation_failed",
      `\`${cell.periodKey}\` is not a ${definition.periodKind} period`,
      { definitionId: definition.id, periodKey: cell.periodKey },
    );
  }
  const value = cell.value === null ? undefined : parseFixed(cell.value);
  if (cell.value !== null && value === undefined) {
    /*
     * Refused rather than skipped: silently dropping the one cell the admin came to fix, and
     * reporting success, is the failure mode this route must not have.
     *
     * The message says *out of range* rather than "is not a number", because for the only
     * inputs that reach here that is what happened. `DecimalSchema` has already refused
     * anything that is not plain decimal text, so `parseFixed` can only answer `undefined`
     * for a well-formed figure the column cannot hold — 15 integral digits, or a seventh
     * place that rounds up into one.
     */
    throw new MetricsError(
      "validation_failed",
      `\`${cell.value}\` is out of range for a metric value: at most 14 digits before the decimal point and 6 after`,
      {
        definitionId: definition.id,
        periodKey: cell.periodKey,
        field: "value",
      },
    );
  }
  return {
    definitionId: definition.id,
    period,
    value,
    decimals: definition.decimals,
    ...(cell.note === undefined ? {} : { note: cell.note }),
  };
}

export function createGridService(services: ModuleServices) {
  const { db } = services;

  /**
   * Names for the authors of a page of revisions: **one** query for the whole page, not one
   * per row. A revision dialog is a dozen rows written by two or three people, so the lookup
   * is tiny — but it is on a screen somebody opens per metric per period, and an N+1 there is
   * the kind that only shows up on the workspace with the longest history.
   *
   * It runs in the caller's own tenant context rather than escalating to `system` the way
   * `modules/updates` does for reply threads: that escalation exists so an *external* reader
   * can see a staff author's name, and this route is staff-only (`metrics.read`), so there is
   * nothing to escalate for.
   */
  async function authorsOf(
    ctx: TenantContext,
    tx: Parameters<Parameters<typeof db.withTenant>[1]>[0],
    points: readonly PointRow[],
  ): Promise<Map<string, PointAuthor>> {
    const ids = [...new Set(points.flatMap((p) => (p.createdBy === null ? [] : [p.createdBy])))];
    const out = new Map<string, PointAuthor>();
    if (ids.length === 0) return out;
    for (const [membershipId, row] of await new MembershipRepo(ctx, tx).namesFor(ids)) {
      out.set(membershipId, { membershipId, displayName: row.displayName });
    }
    return out;
  }

  async function save(
    ctx: TenantContext,
    input: {
      readonly periodKind: CalendarPeriodKind;
      readonly cells: readonly GridCellInput[];
      readonly note?: string | undefined;
    },
    actor: Actor,
  ): Promise<WriteOutcome> {
    // One transaction for the whole save: the insert, the supersede, the audit row and the
    // outbox row commit together or not at all (§12 C2).
    return db.withTenant(ctx, async (tx) => {
      const definitions = new DefinitionRepo(ctx, tx);
      const ids = [...new Set(input.cells.map((c) => c.definitionId))];
      const rows = await definitions.byIds(ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const planned: CellWrite[] = [];
      const seen = new Set<string>();
      for (const cell of input.cells) {
        const definition = byId.get(cell.definitionId);
        if (definition === undefined) {
          throw new MetricsError("validation_failed", "no such metric in this workspace", {
            definitionId: cell.definitionId,
          });
        }
        /*
         * A body naming one cell twice is **refused**, not silently collapsed. The live points
         * are read once for the whole batch, so both copies computed the same `revision` and
         * the second insert raised `point_revision_unique` (`23505`) — a 500 on a body a client
         * can send by accident. Refusing beats last-one-wins because two different numbers for
         * one cell is a request that cannot mean one thing, and committing one of them silently
         * would publish a figure the admin never chose; naming the cell is what lets the form
         * point at it. (`applyCells` still collapses duplicates for the non-interactive writers,
         * where failing a whole nightly sync over a repeated row would be worse.)
         */
        const write = planCell(cell, definition, input.periodKind);
        // Keyed on the *parsed* period, not on the text: two spellings of one period are one
        // cell, and it is the period a row is written for that the unique index is on.
        const key = `${write.definitionId}|${write.period.start.getTime()}`;
        if (seen.has(key)) {
          throw new MetricsError(
            "validation_failed",
            `\`${definition.key}\` appears twice for \`${cell.periodKey}\`; send one value per cell`,
            { definitionId: cell.definitionId, key: definition.key, periodKey: cell.periodKey },
          );
        }
        seen.add(key);
        planned.push(write);
      }
      const outcome = await applyCells(
        tx,
        ctx,
        { audit: services.audit, now: services.now },
        { cells: planned, sourceKind: "manual", actor, reviewPolicy: "never" },
      );
      if (outcome.definitionIds.length > 0) {
        await announcePointsChanged(tx, ctx, outcome.definitionIds);
        /*
         * One summary row per save, beside the per-restatement rows `applyCells` writes. The
         * restatements are the accountable events and each gets its own row with both figures;
         * this one answers "who pressed save, and how much did it move" without an auditor
         * having to count.
         */
        await services.audit.record(tx, ctx, {
          action: "metrics.points_saved",
          resourceKind: "workspace",
          resourceId: ctx.workspaceId,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
          meta: {
            source: "grid",
            periodKind: input.periodKind,
            written: outcome.written,
            restated: outcome.restated,
            unchanged: outcome.unchanged,
            skipped: outcome.skipped,
            metrics: outcome.definitionIds.length,
            ...(input.note === undefined ? {} : { note: input.note }),
          },
        });
      }
      return outcome;
    });
  }

  return {
    /**
     * The grid for one period kind. Definitions of another kind are absent rather than shown
     * with empty cells: a quarterly metric has no March column, and a row of blanks would read
     * as "nobody has entered this yet".
     */
    async read(
      ctx: TenantContext,
      input: {
        readonly periodKind: CalendarPeriodKind;
        readonly periods: number;
        readonly end?: Date | undefined;
      },
    ): Promise<GridView> {
      const columns = periodColumns(input.periodKind, input.end ?? services.now(), input.periods);
      const first = columns[0];
      return db.withTenant(ctx, async (tx) => {
        const all = await new DefinitionRepo(ctx, tx).list();
        const definitions = all.filter((d) => d.periodKind === input.periodKind);
        if (first === undefined || definitions.length === 0) {
          return { periodKind: input.periodKind, columns, definitions, cells: [] };
        }
        const points = await new PointRepo(ctx, tx).series(
          definitions.map((d) => d.id),
          first.period.start,
        );
        const byStart = new Map(columns.map((c) => [c.period.start.getTime(), c.key]));
        const cells = points.flatMap((point) => {
          const periodKey = byStart.get(point.periodStart.getTime());
          // A point whose period is not one of this grid's columns (a custom range, or a row
          // written at a different kind) is simply not a cell of this grid.
          return periodKey === undefined ? [] : [{ periodKey, point }];
        });
        return { periodKind: input.periodKind, columns, definitions, cells };
      });
    },

    save,

    /** `PUT /definitions/{id}/points`: the same rules, for one metric at whatever kind it is. */
    async savePoints(
      ctx: TenantContext,
      definitionId: string,
      points: readonly {
        readonly periodKey: string;
        readonly value: string | null;
        readonly note?: string | null | undefined;
      }[],
      actor: Actor,
    ): Promise<WriteOutcome> {
      const definition = await db.withTenant(ctx, (tx) =>
        new DefinitionRepo(ctx, tx).find(definitionId),
      );
      if (definition === undefined) throw new MetricsError("not_found", "no such metric");
      if (definition.periodKind === "custom") {
        throw new MetricsError(
          "validation_failed",
          "a custom-period metric's points carry explicit bounds; use the period key `<from>/<to>`",
          { definitionId, periodKind: "custom" },
        );
      }
      return save(
        ctx,
        {
          periodKind: definition.periodKind,
          cells: points.map((p) => ({ ...p, definitionId })),
        },
        actor,
      );
    },

    /**
     * The restatement trail (§D3). With `periodKey` this is every revision of one cell, newest
     * first — both rows of a restatement, each with its own source and `createdAt`, which is
     * what makes the restatement *provable* rather than merely claimed.
     *
     * `current` is derived from the revision number rather than read from `superseded_by`,
     * which the repo does not project: the table is append-only and every new revision
     * supersedes the one before it, so the highest revision of a cell is the live one.
     */
    async history(
      ctx: TenantContext,
      definitionId: string,
      query: {
        readonly periodKey?: string | undefined;
        readonly from?: Date | undefined;
        readonly limit: number;
      },
    ): Promise<PointHistory> {
      return db.withTenant(ctx, async (tx) => {
        const definition = await new DefinitionRepo(ctx, tx).find(definitionId);
        if (definition === undefined) throw new MetricsError("not_found", "no such metric");
        const repo = new PointRepo(ctx, tx);
        if (query.periodKey !== undefined) {
          const period = parsePeriodKey(definition.periodKind, query.periodKey);
          if (period === undefined) {
            throw new MetricsError(
              "validation_failed",
              `\`${query.periodKey}\` is not a ${definition.periodKind} period`,
              { periodKey: query.periodKey },
            );
          }
          const revisions = await repo.revisionsAt(definitionId, period.start);
          const top = revisions.reduce((max, p) => Math.max(max, p.revision), 0);
          const page = revisions.slice(0, query.limit);
          const authors = await authorsOf(ctx, tx, page);
          return {
            definition,
            points: page.map((point) => ({
              point,
              current: point.revision === top,
              author: point.createdBy === null ? null : (authors.get(point.createdBy) ?? null),
            })),
          };
        }
        const from = query.from ?? new Date(0);
        const live = await repo.series([definitionId], from);
        // `series` reads `metrics.point_current`, so everything it returns is by construction
        // the live revision of its period.
        const page = live.slice(-query.limit);
        const authors = await authorsOf(ctx, tx, page);
        return {
          definition,
          points: page.map((point) => ({
            point,
            current: true,
            author: point.createdBy === null ? null : (authors.get(point.createdBy) ?? null),
          })),
        };
      });
    },
  };
}

export type GridService = ReturnType<typeof createGridService>;
