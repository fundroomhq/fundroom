import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { type MetricsSettings, parseWorkspaceSettings } from "@fundroom/domain";
import { sql } from "drizzle-orm";
import { parseFixed } from "../decimal.js";
import { type Formula, FormulaSchema } from "../formula.js";
import {
  type Aggregation,
  type Direction,
  type ImportStatus,
  type KpiProvider,
  type MetricAudience,
  parseAudience,
  type SourceKind,
  type SyncStatus,
  type UnitKind,
} from "../model.js";
import type { PeriodKind } from "../period.js";
import {
  definition,
  metricImport,
  point,
  sheetConnection,
  source,
  sourceBinding,
} from "../schema/metrics.js";

/*
 * Repositories over `metrics.*` (design/06 §3: the only place in this module that touches
 * drizzle or SQL). Everything runs inside the caller's tenant transaction, so RLS decides what
 * an external reader sees — `definition_external_read` and `point_external_read` consult the
 * audience — and these queries never re-implement that check in TypeScript. A staff-facing
 * route and an investor-facing one call the same method and get different rows, which is the
 * point of putting the gate in the database.
 */

type Rows<T> = { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => (r as Rows<T>).rows;

/*
 * `tx.execute()` bypasses drizzle's column mapping and its raw query config hands *two* types
 * back as Postgres text: timestamptz ("2026-09-12 10:15:30.123456+00") and numeric ("1234.5").
 * Both traps are live in this module, and both are coerced here so nothing downstream sees a
 * driver value:
 *
 *  - `asDate`, the same coercion `modules/analytics/src/repos/analytics-repo.ts:28-34` records.
 *  - `asFixed`, which is the more dangerous of the two because the naive fix is wrong: a
 *    `Number()` on a `numeric(20, 6)` reads plausibly and loses the last places. Every value
 *    leaves this file as a fixed-point bigint (`../decimal.js`) and returns to Postgres as a
 *    decimal string.
 */
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

const asFixed = (v: unknown): bigint => {
  const parsed = parseFixed(String(v));
  // The column is NOT NULL numeric(20, 6) with a CHECK behind it, so a value this cannot read
  // means the row was written by something that bypassed this module. Failing loudly beats
  // charting a silently-substituted zero.
  if (parsed === undefined) throw new Error(`metrics.point.value is not a decimal: ${String(v)}`);
  return parsed;
};

/** The workspace's metrics settings, read inside the tenant transaction. */
export async function readMetricsSettings(tx: Tx, workspaceId: string): Promise<MetricsSettings> {
  const rows = rowsOf<{ settings: unknown }>(
    await tx.execute(sql`SELECT settings FROM core.workspace WHERE id = ${workspaceId}::uuid`),
  );
  return parseWorkspaceSettings(rows[0]?.settings).metrics;
}

// --- definitions --------------------------------------------------------------------------------
export interface DefinitionRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly unit: UnitKind;
  readonly currency: string | null;
  readonly aggregation: Aggregation;
  readonly direction: Direction;
  readonly periodKind: PeriodKind;
  readonly decimals: number;
  readonly formula: Formula | null;
  readonly display: Record<string, unknown>;
  readonly audience: MetricAudience;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface NewDefinition {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly unit: UnitKind;
  readonly currency?: string | null | undefined;
  readonly aggregation?: Aggregation | undefined;
  readonly direction?: Direction | undefined;
  readonly periodKind?: PeriodKind | undefined;
  readonly decimals?: number | undefined;
  readonly formula?: Formula | null | undefined;
  readonly display?: Record<string, unknown> | undefined;
  readonly audience?: MetricAudience | undefined;
  readonly sortOrder?: number | undefined;
  readonly createdBy?: string | null | undefined;
}

/** Fields `PATCH /definitions/{id}` may move; `key` is absent on purpose (see `update`). */
export interface DefinitionPatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly unit?: UnitKind | undefined;
  readonly currency?: string | null | undefined;
  readonly aggregation?: Aggregation | undefined;
  readonly direction?: Direction | undefined;
  readonly periodKind?: PeriodKind | undefined;
  readonly decimals?: number | undefined;
  readonly formula?: Formula | null | undefined;
  readonly display?: Record<string, unknown> | undefined;
  readonly audience?: MetricAudience | undefined;
  readonly sortOrder?: number | undefined;
}

const DEFINITION_COLUMNS = sql.raw(
  `id, key, name, description, unit, currency, aggregation, direction,
   period_kind AS "periodKind", decimals, formula, display, audience,
   sort_order AS "sortOrder", created_at AS "createdAt", updated_at AS "updatedAt",
   deleted_at AS "deletedAt"`,
);

interface RawDefinition extends Omit<DefinitionRow, "audience" | "formula"> {
  readonly audience: unknown;
  readonly formula: unknown;
}

/**
 * `audience` goes through `parseAudience`, which closes on anything it cannot read — the
 * TypeScript half of `metrics.audience_admits_current`'s `ELSE false`.
 *
 * A `formula` that no longer validates becomes `null`, which makes the definition inert: it
 * stops being recomputed and keeps the points it already has. The alternative — throwing —
 * would make one unreadable row take down the whole grid for everybody, and the row is
 * unreadable precisely when somebody needs the screen to fix it.
 */
function hydrateDefinition(r: RawDefinition): DefinitionRow {
  const formula = r.formula === null ? undefined : FormulaSchema.safeParse(r.formula);
  return {
    ...r,
    decimals: Number(r.decimals),
    sortOrder: Number(r.sortOrder),
    formula: formula?.success === true ? formula.data : null,
    audience: parseAudience(r.audience),
    createdAt: asDate(r.createdAt),
    updatedAt: asDate(r.updatedAt),
    deletedAt: r.deletedAt === null ? null : asDate(r.deletedAt),
  };
}

export class DefinitionRepo extends TenantRepo<typeof definition> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(definition, ctx, tx);
  }

  /** Live definitions in grid order. RLS drops the ones an external reader's audience excludes. */
  async list(): Promise<DefinitionRow[]> {
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        SELECT ${DEFINITION_COLUMNS} FROM metrics.definition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
        ORDER BY sort_order, key`),
    );
    return rows.map(hydrateDefinition);
  }

  async byIds(ids: readonly string[]): Promise<DefinitionRow[]> {
    if (ids.length === 0) return [];
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        SELECT ${DEFINITION_COLUMNS} FROM metrics.definition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND id = ANY(${sql.param([...ids])}::uuid[])
        ORDER BY sort_order, key`),
    );
    return rows.map(hydrateDefinition);
  }

  /** Named `find`, not `findById`: `TenantRepo` already has a protected `findById`. */
  async find(id: string): Promise<DefinitionRow | undefined> {
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        SELECT ${DEFINITION_COLUMNS} FROM metrics.definition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateDefinition(row);
  }

  /** `key` is citext, so this is the same lookup a CSV header or a formula `ref` performs. */
  async findByKey(key: string): Promise<DefinitionRow | undefined> {
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        SELECT ${DEFINITION_COLUMNS} FROM metrics.definition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND key = ${key}::citext
          AND deleted_at IS NULL`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateDefinition(row);
  }

  /** The derived-metric dependency graph, keyed the way `wouldCycle` wants it. */
  async formulaGraph(): Promise<Map<string, Formula>> {
    const rows = rowsOf<{ key: string; formula: unknown }>(
      await this.tx.execute(sql`
        SELECT key, formula FROM metrics.definition
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND deleted_at IS NULL
          AND formula IS NOT NULL`),
    );
    const graph = new Map<string, Formula>();
    for (const r of rows) {
      const parsed = FormulaSchema.safeParse(r.formula);
      if (parsed.success) graph.set(r.key, parsed.data);
    }
    return graph;
  }

  async insert(d: NewDefinition): Promise<DefinitionRow> {
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        INSERT INTO metrics.definition (
          workspace_id, key, name, description, unit, currency, aggregation, direction,
          period_kind, decimals, formula, display, audience, sort_order, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${d.key}::citext, ${d.name}::text,
          ${d.description ?? null}::text, ${d.unit}::metrics.unit_kind,
          ${d.currency ?? null}::text, ${d.aggregation ?? "last"}::metrics.aggregation,
          ${d.direction ?? "up_good"}::metrics.direction,
          ${d.periodKind ?? "month"}::metrics.period_kind, ${d.decimals ?? 0}::smallint,
          ${d.formula === undefined || d.formula === null ? null : JSON.stringify(d.formula)}::jsonb,
          ${JSON.stringify(d.display ?? {})}::jsonb,
          ${JSON.stringify(d.audience ?? { kind: "staff_only" })}::jsonb,
          ${d.sortOrder ?? 0}::integer, ${d.createdBy ?? null}::uuid)
        RETURNING ${DEFINITION_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("metrics.definition insert returned no row");
    return hydrateDefinition(row);
  }

  /**
   * Partial update. `key` is not patchable here and that is the model, not an oversight: a CSV
   * column map, a formula `ref` and a chart token all address a metric by its key, so renaming
   * one is a migration of other people's stored data rather than a field edit.
   */
  async update(id: string, patch: DefinitionPatch): Promise<DefinitionRow | undefined> {
    const rows = rowsOf<RawDefinition>(
      await this.tx.execute(sql`
        UPDATE metrics.definition SET
          name = COALESCE(${patch.name ?? null}::text, name),
          description = CASE WHEN ${patch.description !== undefined}::boolean
            THEN ${patch.description ?? null}::text ELSE description END,
          unit = COALESCE(${patch.unit ?? null}::metrics.unit_kind, unit),
          currency = CASE WHEN ${patch.currency !== undefined}::boolean
            THEN ${patch.currency ?? null}::text ELSE currency END,
          aggregation = COALESCE(${patch.aggregation ?? null}::metrics.aggregation, aggregation),
          direction = COALESCE(${patch.direction ?? null}::metrics.direction, direction),
          period_kind = COALESCE(${patch.periodKind ?? null}::metrics.period_kind, period_kind),
          decimals = COALESCE(${patch.decimals ?? null}::smallint, decimals),
          formula = CASE WHEN ${patch.formula !== undefined}::boolean
            THEN ${patch.formula == null ? null : JSON.stringify(patch.formula)}::jsonb
            ELSE formula END,
          display = COALESCE(${patch.display === undefined ? null : JSON.stringify(patch.display)}::jsonb, display),
          audience = COALESCE(${patch.audience === undefined ? null : JSON.stringify(patch.audience)}::jsonb, audience),
          sort_order = COALESCE(${patch.sortOrder ?? null}::integer, sort_order)
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL
        RETURNING ${DEFINITION_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateDefinition(row);
  }

  /**
   * Soft delete. The row stays so its points keep their foreign key and an audit reader can
   * still see what the series meant; `definition_key_active_idx` frees the key for reuse.
   */
  async softDelete(id: string): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE metrics.definition SET deleted_at = now()
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND deleted_at IS NULL
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

// --- sources ------------------------------------------------------------------------------------
export interface NewSource {
  readonly kind: SourceKind;
  readonly ref?: Record<string, unknown> | undefined;
  readonly importedBy?: string | null | undefined;
}

export class SourceRepo extends TenantRepo<typeof source> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(source, ctx, tx);
  }

  /** One row per import run, sync or recompute — not one per point it produced. */
  async insert(s: NewSource): Promise<string> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        INSERT INTO metrics.source (workspace_id, kind, ref, imported_by)
        VALUES (${this.ctx.workspaceId}::uuid, ${s.kind}::metrics.source_kind,
                ${JSON.stringify(s.ref ?? {})}::jsonb, ${s.importedBy ?? null}::uuid)
        RETURNING id`),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("metrics.source insert returned no row");
    return id;
  }

  async kindOf(sourceId: string): Promise<SourceKind | undefined> {
    const rows = rowsOf<{ kind: SourceKind }>(
      await this.tx.execute(sql`
        SELECT kind FROM metrics.source
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${sourceId}::uuid`),
    );
    return rows[0]?.kind;
  }
}

// --- points -------------------------------------------------------------------------------------
export interface PointRow {
  readonly id: string;
  readonly definitionId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Fixed-point at scale 1e6 — never a JS number (§5). */
  readonly value: bigint;
  readonly asOf: Date;
  readonly sourceId: string | null;
  readonly sourceKind: SourceKind | null;
  readonly revision: number;
  readonly needsReview: boolean;
  readonly note: string | null;
  /** Membership that wrote this revision; null for a sheets sync or a derived recompute. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface NewPoint {
  readonly definitionId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly value: string;
  readonly revision?: number | undefined;
  readonly asOf?: Date | undefined;
  readonly sourceId?: string | null | undefined;
  readonly needsReview?: boolean | undefined;
  readonly note?: string | null | undefined;
  readonly createdBy?: string | null | undefined;
}

const POINT_COLUMNS = sql.raw(
  `p.id, p.definition_id AS "definitionId", lower(p.period) AS "periodStart",
   upper(p.period) AS "periodEnd", p.value::text AS value, p.as_of AS "asOf",
   p.source_id AS "sourceId", s.kind AS "sourceKind", p.revision,
   p.needs_review AS "needsReview", p.note, p.created_by AS "createdBy",
   p.created_at AS "createdAt"`,
);

interface RawPoint extends Omit<PointRow, "value"> {
  readonly value: string;
}

const hydratePoint = (r: RawPoint): PointRow => ({
  ...r,
  periodStart: asDate(r.periodStart),
  periodEnd: asDate(r.periodEnd),
  asOf: asDate(r.asOf),
  createdAt: asDate(r.createdAt),
  revision: Number(r.revision),
  value: asFixed(r.value),
});

export class PointRepo extends TenantRepo<typeof point> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(point, ctx, tx);
  }

  /**
   * The live series for a set of definitions, oldest first, from `from` (inclusive) onwards.
   *
   * Reading `metrics.point_current` rather than filtering here is not a shortcut: the view
   * carries `security_invoker`, so an external reader gets exactly the rows
   * `point_external_read` admits, and a future caller who forgets `superseded_by IS NULL`
   * cannot accidentally chart a restated number next to the one that replaced it.
   */
  async series(definitionIds: readonly string[], from: Date): Promise<PointRow[]> {
    if (definitionIds.length === 0) return [];
    return rowsOf<RawPoint>(
      await this.tx.execute(sql`
        SELECT ${POINT_COLUMNS} FROM metrics.point_current p
        LEFT JOIN metrics.source s ON s.id = p.source_id
        WHERE p.workspace_id = ${this.ctx.workspaceId}::uuid
          AND p.definition_id = ANY(${sql.param([...definitionIds])}::uuid[])
          AND p.period_start >= ${from}::timestamptz
        ORDER BY p.definition_id, p.period_start`),
    ).map(hydratePoint);
  }

  /** The live point for one cell of the grid, or `undefined` when the cell is empty. */
  async currentAt(definitionId: string, periodStart: Date): Promise<PointRow | undefined> {
    const rows = rowsOf<RawPoint>(
      await this.tx.execute(sql`
        SELECT ${POINT_COLUMNS} FROM metrics.point_current p
        LEFT JOIN metrics.source s ON s.id = p.source_id
        WHERE p.workspace_id = ${this.ctx.workspaceId}::uuid
          AND p.definition_id = ${definitionId}::uuid
          AND p.period_start = ${periodStart}::timestamptz`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydratePoint(row);
  }

  /**
   * What the series looked like at `asOf`: per period, the highest revision written on or
   * before that instant. This is what a chart in an already-sent email renders (§9.1) — a
   * restatement made afterwards must not rewrite a picture somebody already has in their
   * inbox, so this reads *history*, not `point_current`.
   */
  async seriesAsOf(definitionIds: readonly string[], asOf: Date, from: Date): Promise<PointRow[]> {
    if (definitionIds.length === 0) return [];
    return rowsOf<RawPoint>(
      await this.tx.execute(sql`
        SELECT ${POINT_COLUMNS} FROM (
          SELECT DISTINCT ON (definition_id, period_start) *
          FROM metrics.point
          WHERE workspace_id = ${this.ctx.workspaceId}::uuid
            AND definition_id = ANY(${sql.param([...definitionIds])}::uuid[])
            AND period_start >= ${from}::timestamptz
            AND created_at <= ${asOf}::timestamptz
          ORDER BY definition_id, period_start, revision DESC
        ) p
        LEFT JOIN metrics.source s ON s.id = p.source_id
        ORDER BY p.definition_id, p.period_start`),
    ).map(hydratePoint);
  }

  /**
   * Appends a point. `value` arrives as a decimal string (`formatFixed`), never a number, and
   * lands straight in the `numeric(20, 6)` column.
   */
  async insert(p: NewPoint): Promise<PointRow> {
    const rows = rowsOf<RawPoint>(
      await this.tx.execute(sql`
        WITH inserted AS (
          INSERT INTO metrics.point (
            workspace_id, definition_id, period, value, as_of, source_id, revision,
            needs_review, note, created_by)
          VALUES (
            ${this.ctx.workspaceId}::uuid, ${p.definitionId}::uuid,
            tstzrange(${p.periodStart}::timestamptz, ${p.periodEnd}::timestamptz, '[)'),
            ${p.value}::numeric, COALESCE(${p.asOf ?? null}::timestamptz, now()),
            ${p.sourceId ?? null}::uuid, ${p.revision ?? 1}::integer,
            ${p.needsReview ?? false}::boolean, ${p.note ?? null}::text,
            ${p.createdBy ?? null}::uuid)
          RETURNING *
        )
        SELECT ${POINT_COLUMNS} FROM inserted p
        LEFT JOIN metrics.source s ON s.id = p.source_id`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("metrics.point insert returned no row");
    return hydratePoint(row);
  }

  /**
   * Links an old point at its replacement — the only UPDATE `metrics.point` accepts, and the
   * reason the table cannot simply REVOKE UPDATE the way `audit.event` does. The trigger
   * refuses everything else, including clearing the link again, so this method is the whole
   * mutable surface of the series.
   */
  async supersede(oldId: string, newId: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE metrics.point SET superseded_by = ${newId}::uuid
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${oldId}::uuid`);
  }

  /** Every revision of one cell, newest first: the restatement history an admin screen shows. */
  async revisionsAt(definitionId: string, periodStart: Date): Promise<PointRow[]> {
    return rowsOf<RawPoint>(
      await this.tx.execute(sql`
        SELECT ${POINT_COLUMNS} FROM metrics.point p
        LEFT JOIN metrics.source s ON s.id = p.source_id
        WHERE p.workspace_id = ${this.ctx.workspaceId}::uuid
          AND p.definition_id = ${definitionId}::uuid
          AND p.period_start = ${periodStart}::timestamptz
        ORDER BY p.revision DESC`),
    ).map(hydratePoint);
  }
}

// --- CSV imports --------------------------------------------------------------------------------
export interface ImportRow {
  readonly id: string;
  readonly sourceId: string | null;
  readonly status: ImportStatus;
  readonly defaults: Record<string, unknown>;
  readonly rows: readonly unknown[];
  readonly total: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly lastError: string | null;
}

export interface ImportProgress {
  readonly status?: ImportStatus | undefined;
  readonly rows?: readonly unknown[] | undefined;
  readonly total?: number | undefined;
  readonly applied?: number | undefined;
  readonly skipped?: number | undefined;
  readonly failed?: number | undefined;
  readonly startedAt?: Date | null | undefined;
  readonly finishedAt?: Date | null | undefined;
  readonly lastError?: string | null | undefined;
}

const IMPORT_COLUMNS = sql.raw(
  `id, source_id AS "sourceId", status, defaults, rows, total, applied, skipped, failed,
   created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt",
   last_error AS "lastError"`,
);

const hydrateImport = (r: ImportRow): ImportRow => ({
  ...r,
  createdAt: asDate(r.createdAt),
  startedAt: r.startedAt === null ? null : asDate(r.startedAt),
  finishedAt: r.finishedAt === null ? null : asDate(r.finishedAt),
});

export class ImportRepo extends TenantRepo<typeof metricImport> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(metricImport, ctx, tx);
  }

  async insert(input: {
    readonly sourceId?: string | null | undefined;
    readonly defaults?: Record<string, unknown> | undefined;
    readonly rows?: readonly unknown[] | undefined;
    readonly total?: number | undefined;
    readonly createdBy?: string | null | undefined;
  }): Promise<ImportRow> {
    const rows = rowsOf<ImportRow>(
      await this.tx.execute(sql`
        INSERT INTO metrics.import (workspace_id, source_id, defaults, rows, total, created_by)
        VALUES (${this.ctx.workspaceId}::uuid, ${input.sourceId ?? null}::uuid,
                ${JSON.stringify(input.defaults ?? {})}::jsonb,
                ${JSON.stringify(input.rows ?? [])}::jsonb,
                ${input.total ?? 0}::integer, ${input.createdBy ?? null}::uuid)
        RETURNING ${IMPORT_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("metrics.import insert returned no row");
    return hydrateImport(row);
  }

  async find(id: string): Promise<ImportRow | undefined> {
    const rows = rowsOf<ImportRow>(
      await this.tx.execute(sql`
        SELECT ${IMPORT_COLUMNS} FROM metrics.import
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateImport(row);
  }

  async recent(limit: number): Promise<ImportRow[]> {
    return rowsOf<ImportRow>(
      await this.tx.execute(sql`
        SELECT ${IMPORT_COLUMNS} FROM metrics.import
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid
        ORDER BY created_at DESC LIMIT ${limit}`),
    ).map(hydrateImport);
  }

  async progress(id: string, p: ImportProgress): Promise<void> {
    await this.tx.execute(sql`
      UPDATE metrics.import SET
        status = COALESCE(${p.status ?? null}::metrics.import_status, status),
        rows = COALESCE(${p.rows === undefined ? null : JSON.stringify(p.rows)}::jsonb, rows),
        total = COALESCE(${p.total ?? null}::integer, total),
        applied = COALESCE(${p.applied ?? null}::integer, applied),
        skipped = COALESCE(${p.skipped ?? null}::integer, skipped),
        failed = COALESCE(${p.failed ?? null}::integer, failed),
        started_at = CASE WHEN ${p.startedAt !== undefined}::boolean
          THEN ${p.startedAt ?? null}::timestamptz ELSE started_at END,
        finished_at = CASE WHEN ${p.finishedAt !== undefined}::boolean
          THEN ${p.finishedAt ?? null}::timestamptz ELSE finished_at END,
        last_error = CASE WHEN ${p.lastError !== undefined}::boolean
          THEN ${p.lastError ?? null}::text ELSE last_error END
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid`);
  }
}

// --- Google Sheets connection -------------------------------------------------------------------
export interface SheetConnectionRow {
  readonly id: string;
  readonly spreadsheetId: string;
  readonly range: string;
  readonly mapping: Record<string, unknown>;
  readonly credentialEnc: Uint8Array;
  readonly encryption: Record<string, unknown>;
  readonly serviceAccountEmail: string;
  readonly status: SyncStatus;
  readonly enabled: boolean;
  readonly lastSyncAt: Date | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SheetConnectionInput {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly mapping?: Record<string, unknown> | undefined;
  readonly credentialEnc: Uint8Array;
  readonly encryption: Record<string, unknown>;
  readonly serviceAccountEmail: string;
  readonly enabled?: boolean | undefined;
  readonly createdBy?: string | null | undefined;
}

const CONNECTION_COLUMNS = sql.raw(
  `id, spreadsheet_id AS "spreadsheetId", range, mapping, credential_enc AS "credentialEnc",
   encryption, service_account_email AS "serviceAccountEmail", status, enabled,
   last_sync_at AS "lastSyncAt", last_error AS "lastError",
   consecutive_failures AS "consecutiveFailures", created_at AS "createdAt",
   updated_at AS "updatedAt"`,
);

interface RawConnection extends Omit<SheetConnectionRow, "credentialEnc"> {
  readonly credentialEnc: Buffer;
}

const hydrateConnection = (r: RawConnection): SheetConnectionRow => ({
  ...r,
  credentialEnc: new Uint8Array(r.credentialEnc),
  consecutiveFailures: Number(r.consecutiveFailures),
  lastSyncAt: r.lastSyncAt === null ? null : asDate(r.lastSyncAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class SheetConnectionRepo extends TenantRepo<typeof sheetConnection> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(sheetConnection, ctx, tx);
  }

  async find(): Promise<SheetConnectionRow | undefined> {
    const rows = rowsOf<RawConnection>(
      await this.tx.execute(sql`
        SELECT ${CONNECTION_COLUMNS} FROM metrics.sheet_connection
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateConnection(row);
  }

  /** One row per workspace, so a re-link replaces the credential rather than adding a second. */
  async upsert(input: SheetConnectionInput): Promise<SheetConnectionRow> {
    const rows = rowsOf<RawConnection>(
      await this.tx.execute(sql`
        INSERT INTO metrics.sheet_connection (
          workspace_id, spreadsheet_id, range, mapping, credential_enc, encryption,
          service_account_email, enabled, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.spreadsheetId}::text, ${input.range}::text,
          ${JSON.stringify(input.mapping ?? {})}::jsonb,
          ${Buffer.from(input.credentialEnc)}::bytea,
          ${JSON.stringify(input.encryption)}::jsonb,
          ${input.serviceAccountEmail}::text, ${input.enabled ?? true}::boolean,
          ${input.createdBy ?? null}::uuid)
        ON CONFLICT (workspace_id) DO UPDATE SET
          spreadsheet_id = EXCLUDED.spreadsheet_id,
          range = EXCLUDED.range,
          mapping = EXCLUDED.mapping,
          credential_enc = EXCLUDED.credential_enc,
          encryption = EXCLUDED.encryption,
          service_account_email = EXCLUDED.service_account_email,
          enabled = EXCLUDED.enabled,
          status = 'idle',
          last_error = NULL,
          consecutive_failures = 0
        RETURNING ${CONNECTION_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("metrics.sheet_connection upsert returned no row");
    return hydrateConnection(row);
  }

  async remove(): Promise<boolean> {
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        DELETE FROM metrics.sheet_connection
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * Records the outcome of a sync. A failure increments `consecutive_failures` rather than
   * setting a flag: the sweep needs to know how long something has been broken to decide
   * whether it is a blip or a spreadsheet somebody un-shared, and a boolean cannot say.
   */
  async recordSync(outcome: {
    readonly status: SyncStatus;
    readonly error?: string | null | undefined;
  }): Promise<void> {
    await this.tx.execute(sql`
      UPDATE metrics.sheet_connection SET
        status = ${outcome.status}::metrics.sync_status,
        last_sync_at = now(),
        last_error = ${outcome.error ?? null}::text,
        consecutive_failures = CASE WHEN ${outcome.status}::metrics.sync_status = 'failed'
          THEN consecutive_failures + 1 ELSE 0 END
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid`);
  }
}

// --- KPI source bindings (E3.6 §5) -------------------------------------------------------------
export interface SourceBindingRow {
  readonly id: string;
  readonly definitionId: string;
  readonly provider: KpiProvider;
  readonly sourceMetric: string;
  readonly enabled: boolean;
  readonly status: SyncStatus;
  readonly lastSyncAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  /** Earliest month written by a sync (`YYYY-MM`), or null. */
  readonly historyFrom: string | null;
  /** Why the history is shorter than the backfill window; survives later 3-month syncs. */
  readonly historyNote: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SourceBindingInput {
  readonly definitionId: string;
  readonly provider: KpiProvider;
  readonly sourceMetric: string;
  readonly enabled: boolean;
  readonly createdBy?: string | null | undefined;
}

const BINDING_COLUMNS = sql.raw(
  `b.id, b.definition_id AS "definitionId", b.provider, b.source_metric AS "sourceMetric",
   b.enabled, b.status, b.last_sync_at AS "lastSyncAt", b.last_success_at AS "lastSuccessAt",
   b.last_error AS "lastError", b.consecutive_failures AS "consecutiveFailures",
   b.history_from AS "historyFrom", b.history_note AS "historyNote", b.created_at AS "createdAt", b.updated_at AS "updatedAt"`,
);

const hydrateBinding = (r: SourceBindingRow): SourceBindingRow => ({
  ...r,
  consecutiveFailures: Number(r.consecutiveFailures),
  lastSyncAt: r.lastSyncAt === null ? null : asDate(r.lastSyncAt),
  lastSuccessAt: r.lastSuccessAt === null ? null : asDate(r.lastSuccessAt),
  createdAt: asDate(r.createdAt),
  updatedAt: asDate(r.updatedAt),
});

export class SourceBindingRepo extends TenantRepo<typeof sourceBinding> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(sourceBinding, ctx, tx);
  }

  /**
   * Bindings of **live** definitions, grid order. A soft-deleted definition keeps its row (the
   * FK cascades only on a hard delete) but is neither listed nor synced.
   */
  async list(): Promise<SourceBindingRow[]> {
    const rows = rowsOf<SourceBindingRow>(
      await this.tx.execute(sql`
        SELECT ${BINDING_COLUMNS} FROM metrics.source_binding b
        JOIN metrics.definition d ON d.id = b.definition_id AND d.deleted_at IS NULL
        WHERE b.workspace_id = ${this.ctx.workspaceId}::uuid
        ORDER BY d.sort_order, d.key`),
    );
    return rows.map(hydrateBinding);
  }

  /**
   * Serialises changes to *where a metric's numbers come from* in one workspace: a KPI binding
   * and the Google Sheets mapping must never feed the same definition (they would restate each
   * other every night), and the check-then-write in either direction is only sound if the other
   * direction cannot commit in between. Taken first in `putBinding` and `sheets.put`.
   */
  async lockSourceConfig(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`metrics.source_config:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  /**
   * The write half of a sync, taken first in its transaction: a per-workspace advisory lock (a
   * nightly sweep and a "sync now" must not both compute revision N+1 of one cell and collide on
   * `point_revision_unique`), then the named bindings `FOR UPDATE`, re-read with their
   * definitions. A binding deleted, disabled or re-pointed while the vendor read was in flight
   * comes back missing or changed, and the caller writes nothing for it.
   */
  async lockForSync(ids: readonly string[]): Promise<
    (SourceBindingRow & {
      readonly periodKind: PeriodKind;
      readonly derived: boolean;
    })[]
  > {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`metrics.kpi_sync:${this.ctx.workspaceId}`}::text, 0))`,
    );
    if (ids.length === 0) return [];
    const rows = rowsOf<SourceBindingRow & { periodKind: PeriodKind; derived: boolean }>(
      await this.tx.execute(sql`
        SELECT ${BINDING_COLUMNS}, d.period_kind AS "periodKind", (d.formula IS NOT NULL) AS derived
        FROM metrics.source_binding b
        JOIN metrics.definition d ON d.id = b.definition_id AND d.deleted_at IS NULL
        WHERE b.workspace_id = ${this.ctx.workspaceId}::uuid
          AND b.id = ANY(${sql.param([...ids])}::uuid[])
        ORDER BY b.id
        FOR UPDATE OF b FOR SHARE OF d`),
    );
    return rows.map((r) => ({
      ...hydrateBinding(r),
      periodKind: r.periodKind,
      derived: r.derived,
    }));
  }

  async findByDefinition(definitionId: string): Promise<SourceBindingRow | undefined> {
    const rows = rowsOf<SourceBindingRow>(
      await this.tx.execute(sql`
        SELECT ${BINDING_COLUMNS} FROM metrics.source_binding b
        WHERE b.workspace_id = ${this.ctx.workspaceId}::uuid
          AND b.definition_id = ${definitionId}::uuid`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateBinding(row);
  }

  /**
   * One binding per definition. Re-pointing it at another provider or series resets its health
   * and its `last_success_at`, so the next sync backfills the new series in full; toggling only
   * `enabled` keeps both.
   */
  async upsert(input: SourceBindingInput): Promise<SourceBindingRow> {
    const rows = rowsOf<SourceBindingRow>(
      await this.tx.execute(sql`
        INSERT INTO metrics.source_binding AS b (
          workspace_id, definition_id, provider, source_metric, enabled, created_by)
        VALUES (
          ${this.ctx.workspaceId}::uuid, ${input.definitionId}::uuid, ${input.provider}::text,
          ${input.sourceMetric}::text, ${input.enabled}::boolean, ${input.createdBy ?? null}::uuid)
        ON CONFLICT (definition_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          provider = EXCLUDED.provider,
          source_metric = EXCLUDED.source_metric,
          status = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.status ELSE 'idle' END,
          last_error = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.last_error ELSE NULL END,
          consecutive_failures = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.consecutive_failures ELSE 0 END,
          last_success_at = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.last_success_at ELSE NULL END,
          history_from = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.history_from ELSE NULL END,
          history_note = CASE WHEN (b.provider, b.source_metric) = (EXCLUDED.provider, EXCLUDED.source_metric)
            THEN b.history_note ELSE NULL END
        RETURNING ${BINDING_COLUMNS}`),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("metrics.source_binding upsert returned no row");
    return hydrateBinding(row);
  }

  async remove(definitionId: string): Promise<SourceBindingRow | undefined> {
    const rows = rowsOf<SourceBindingRow>(
      await this.tx.execute(sql`
        DELETE FROM metrics.source_binding b
        WHERE b.workspace_id = ${this.ctx.workspaceId}::uuid
          AND b.definition_id = ${definitionId}::uuid
        RETURNING ${BINDING_COLUMNS}`),
    );
    const row = rows[0];
    return row === undefined ? undefined : hydrateBinding(row);
  }

  /**
   * A binding whose read was not attempted (the job's time budget ran out): says so in
   * `last_error` and touches nothing else — not a failure, not a sync.
   */
  async recordDeferred(
    id: string,
    expect: { readonly provider: KpiProvider; readonly sourceMetric: string },
    note: string,
  ): Promise<void> {
    await this.tx.execute(sql`
      UPDATE metrics.source_binding SET last_error = ${note}::text
      WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
        AND provider = ${expect.provider}::text AND source_metric = ${expect.sourceMetric}::text`);
  }

  /**
   * Records one binding's sync outcome. Guarded by `(provider, source_metric)` as they were
   * when the sync loaded the binding: an admin who re-points it while the vendor read is in
   * flight must not have the old series' outcome stamped onto the new one.
   */
  async recordSync(
    id: string,
    expect: { readonly provider: KpiProvider; readonly sourceMetric: string },
    outcome: {
      readonly status: SyncStatus;
      readonly error?: string | null | undefined;
      /** Earliest month this sync wrote; merged as the minimum with what is stored. */
      readonly historyFrom?: string | undefined;
      /** `undefined` keeps the stored note; `null` clears it (a full backfill succeeded). */
      readonly historyNote?: string | null | undefined;
    },
  ): Promise<boolean> {
    const setNote = outcome.historyNote !== undefined;
    const rows = rowsOf<{ id: string }>(
      await this.tx.execute(sql`
        UPDATE metrics.source_binding SET
          status = ${outcome.status}::metrics.sync_status,
          last_sync_at = now(),
          last_success_at = CASE WHEN ${outcome.status}::metrics.sync_status = 'ok'
            THEN now() ELSE last_success_at END,
          last_error = ${outcome.error ?? null}::text,
          consecutive_failures = CASE WHEN ${outcome.status}::metrics.sync_status = 'failed'
            THEN consecutive_failures + 1 ELSE 0 END,
          history_from = CASE
            WHEN ${outcome.historyFrom ?? null}::text IS NULL THEN history_from
            WHEN history_from IS NULL OR ${outcome.historyFrom ?? null}::text < history_from
              THEN ${outcome.historyFrom ?? null}::text
            ELSE history_from END,
          history_note = CASE WHEN ${setNote}::boolean THEN ${outcome.historyNote ?? null}::text
            ELSE history_note END
        WHERE workspace_id = ${this.ctx.workspaceId}::uuid AND id = ${id}::uuid
          AND provider = ${expect.provider}::text AND source_metric = ${expect.sourceMetric}::text
        RETURNING id`),
    );
    return rows.length > 0;
  }
}
