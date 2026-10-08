import { createHash } from "node:crypto";
import { parseCsv } from "@fundroom/csv";
import { systemContext, type TenantContext } from "@fundroom/db";
import { onceByKey } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { parseFixed } from "../decimal.js";
import { type Actor, MetricsError } from "../errors.js";
import { parsePeriodKey } from "../period.js";
import { DefinitionRepo, ImportRepo, type ImportRow } from "../repos/metrics-repo.js";
import {
  type CsvMapping,
  type ImportPlan,
  METRICS_IMPORT_MAX_ROWS,
  type PlannedRow,
  type PlanSummary,
  planImport,
  summarise,
} from "./mapping.js";
import { announcePointsChanged, applyCells, type CellWrite } from "./points.js";

/*
 * CSV import of metric values (E2.4 §9 `/import`), following E1.1's bulk-invite importer
 * closely on purpose (`packages/identity/src/services/invite-import.ts`): the CSV arrives as
 * **pasted text in a JSON body**, never multipart; a dry run validates every row against the
 * workspace and writes nothing; starting stores the validated plan and enqueues a job whose
 * worker applies one row at a time, idempotently, recording per-row status.
 *
 * What is different from invites is the mapping. An invite file has fixed column names; a
 * metrics export has whatever the founder's accounting package emitted, so the admin chooses
 * which column is the period and which columns are which metrics, and that choice is stored on
 * `metrics.source.ref` with the file's digest. A point can then say not merely "a CSV" but
 * *which column of which file, on which line* — which is the difference between provenance and
 * a label.
 */

export const JOB_IMPORT = "metrics.import";

export { METRICS_IMPORT_MAX_ROWS };

export interface ImportDefaults {
  readonly mapping: CsvMapping;
  readonly fileSha256: string;
  readonly note?: string | undefined;
  readonly importedBy?: string | undefined;
}

export interface DryRunResult extends ImportPlan {
  readonly summary: PlanSummary;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function createImportService(services: ModuleServices) {
  const { db } = services;

  /** Plans a file against the workspace's live definitions; touches nothing. */
  async function plan(ctx: TenantContext, csv: string, mapping: CsvMapping): Promise<ImportPlan> {
    const definitions = await db.withTenant(ctx, (tx) => new DefinitionRepo(ctx, tx).list());
    const keys = new Set(
      definitions.filter((d) => d.formula === null).map((d) => d.key.toLowerCase()),
    );
    return planImport(parseCsv(csv), mapping, keys);
  }

  /**
   * The worker. Safe to redeliver: each line is claimed by
   * `metrics.import:<importId>:<line>` in the same transaction that writes its points, so a
   * retry after a crash resumes where it stopped and never doubles a restatement.
   */
  async function run(importId: string, workspaceId: string): Promise<void> {
    const ctx = systemContext(workspaceId);
    const imp = await db.withTenant(ctx, async (tx) => {
      const repo = new ImportRepo(ctx, tx);
      const row = await repo.find(importId);
      if (row === undefined || row.status === "done" || row.status === "failed") return undefined;
      await repo.progress(importId, { status: "running", startedAt: row.startedAt ?? new Date() });
      return row;
    });
    if (imp === undefined) return;

    const defaults = imp.defaults as unknown as ImportDefaults;
    const rows = imp.rows as unknown as PlannedRow[];
    const definitions = await db.withTenant(ctx, (tx) => new DefinitionRepo(ctx, tx).list());
    const byKey = new Map(definitions.map((d) => [d.key.toLowerCase(), d]));
    const touched = new Set<string>();

    for (const row of rows) {
      if (row.status !== "ok") continue;
      try {
        const claimed = await db.withTenant(ctx, async (tx) =>
          onceByKey(tx, ctx, `metrics.import:${importId}:${row.line}`, async () => {
            const cells: CellWrite[] = [];
            for (const cell of row.cells) {
              if (cell.status !== "ok" || cell.value === null) continue;
              const definition = byKey.get(cell.key.toLowerCase());
              if (definition === undefined) continue;
              const period = parsePeriodKey(definition.periodKind, row.periodKey);
              const value = parseFixed(cell.value);
              if (period === undefined || value === undefined) continue;
              cells.push({
                definitionId: definition.id,
                period,
                value,
                decimals: definition.decimals,
              });
            }
            if (cells.length === 0) return [] as readonly string[];
            const outcome = await applyCells(
              tx,
              ctx,
              { audit: services.audit, now: services.now },
              {
                cells,
                sourceKind: "csv",
                /*
                 * One source row per *line*, not per point (§3.2): a line writes several
                 * metrics and they share a provenance, but two lines are two assertions about
                 * two different periods and `line` is what makes the trail navigable back to
                 * the file the founder still has on their desk.
                 */
                sourceRef: {
                  importId,
                  columnMap: defaults.mapping.columns,
                  fileSha256: defaults.fileSha256,
                  line: row.line,
                },
                ...(defaults.importedBy === undefined
                  ? {}
                  : { actor: { membershipId: defaults.importedBy } }),
                reviewPolicy: "never",
              },
            );
            return outcome.definitionIds;
          }),
        );
        if (!claimed.skipped) for (const id of claimed.result) touched.add(id);
        row.status = "applied";
      } catch (error) {
        row.status = "failed";
        row.reason = error instanceof MetricsError ? error.code : "write_failed";
        services.log("metrics.import_row_failed", {
          level: "warn",
          importId,
          line: row.line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await db.withTenant(ctx, (tx) =>
        new ImportRepo(ctx, tx).progress(importId, {
          rows,
          applied: rows.filter((r) => r.status === "applied").length,
          failed: rows.filter((r) => r.status === "failed").length,
        }),
      );
    }

    const applied = rows.filter((r) => r.status === "applied").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const skipped = rows.filter((r) => r.status === "skipped" || r.status === "error").length;
    await db.withTenant(ctx, async (tx) => {
      await new ImportRepo(ctx, tx).progress(importId, {
        rows,
        status: "done",
        applied,
        failed,
        skipped,
        finishedAt: services.now(),
      });
      // One event for the whole run: the recompute handler walks the dependency graph in a
      // single pass, so one per line would be N jobs doing the same work N times.
      await announcePointsChanged(tx, ctx, [...touched]);
      await services.audit.record(tx, ctx, {
        action: "metrics.import_finished",
        resourceKind: "metric_import",
        resourceId: importId,
        actorKind: "system",
        actorMembershipId: null,
        meta: { applied, skipped, failed, total: rows.length, metrics: touched.size },
      });
    });
    services.log("metrics.import_finished", { importId, workspaceId, applied, skipped, failed });
  }

  return {
    async dryRun(ctx: TenantContext, csv: string, mapping: CsvMapping): Promise<DryRunResult> {
      const planned = await plan(ctx, csv, mapping);
      return { ...planned, summary: summarise(planned.rows) };
    },

    async start(
      ctx: TenantContext,
      input: {
        readonly csv: string;
        readonly mapping: CsvMapping;
        readonly note?: string | undefined;
      },
      actor: Actor,
    ): Promise<ImportRow> {
      const planned = await plan(ctx, input.csv, input.mapping);
      const summary = summarise(planned.rows);
      if (summary.ok === 0) {
        /*
         * Refusing rather than queueing an empty job is the kinder failure: a job that finishes
         * having written nothing looks like success on the progress screen, and the admin would
         * go looking for their numbers instead of at their mapping.
         */
        throw new MetricsError(
          "validation_failed",
          "no row in this file has a usable value; check the column mapping and run a dry run",
          { summary, columns: planned.columns },
        );
      }
      return db.withTenant(ctx, async (tx) => {
        const created = await new ImportRepo(ctx, tx).insert({
          defaults: {
            mapping: input.mapping,
            fileSha256: sha256(input.csv),
            ...(input.note === undefined ? {} : { note: input.note }),
            importedBy: actor.membershipId,
          } as unknown as Record<string, unknown>,
          rows: planned.rows,
          total: planned.rows.length,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "metrics.import_started",
          resourceKind: "metric_import",
          resourceId: created.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
          meta: {
            total: planned.rows.length,
            ok: summary.ok,
            skipped: summary.skipped,
            error: summary.error,
            values: summary.values,
            periodKind: input.mapping.periodKind,
          },
        });
        // In the same transaction as the row it names: an import that exists but was never
        // enqueued sits `pending` forever, and an enqueue for a row that rolled back fails on
        // its first read.
        await services.queue.sendInTransaction(
          tx,
          JOB_IMPORT,
          { importId: created.id, workspaceId: ctx.workspaceId },
          { idempotencyKey: `metrics.import:${created.id}` },
        );
        return created;
      });
    },

    async get(ctx: TenantContext, id: string): Promise<ImportRow> {
      const found = await db.withTenant(ctx, (tx) => new ImportRepo(ctx, tx).find(id));
      if (found === undefined) throw new MetricsError("not_found", "no such import");
      return found;
    },

    run,
  };
}

export type ImportService = ReturnType<typeof createImportService>;
