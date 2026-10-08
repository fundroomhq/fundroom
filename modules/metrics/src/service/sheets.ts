import { randomUUID } from "node:crypto";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { SpreadsheetCredential } from "@fundroom/ports";
import {
  isValidRange,
  isValidSpreadsheetId,
  parseServiceAccountJson,
} from "@fundroom/sheets-google";
import { parseFixed } from "../decimal.js";
import { type Actor, MetricsError } from "../errors.js";
import type { SyncStatus } from "../model.js";
import { parsePeriodKey } from "../period.js";
import {
  DefinitionRepo,
  SheetConnectionRepo,
  type SheetConnectionRow,
  SourceBindingRepo,
} from "../repos/metrics-repo.js";
import {
  type CsvMapping,
  METRICS_IMPORT_MAX_ROWS,
  type PlannedCell,
  type PlannedRow,
  planImport,
  summarise,
} from "./mapping.js";
import { announcePointsChanged, applyCells, type CellWrite } from "./points.js";

/*
 * Google Sheets connection and sync (E2.4 §8, D7).
 *
 * The admin pastes a service-account JSON; we keep the private key envelope-encrypted under
 * the workspace DEK and show them `client_email` so they can share the sheet with it. Storage
 * copies `updates.sending_domain`'s DKIM key exactly (`modules/updates/src/service/domains.ts`
 * :184-194 to write, :290-309 to read) — including the rule that a **missing key logs a warning
 * and returns `undefined`, never throws**: a workspace whose key has gone is a connection that
 * stops syncing and says so on the admin screen, not a 500 in a nightly cron.
 *
 * Two behaviours here are the ones the contract singles out:
 *
 *  - the credential is **validated before it is encrypted** (C-D.4). Encrypting first would
 *    store a typo that only fails at 04:35, in a job nobody is watching;
 *  - a sync that finds a different number for a period whose current point came from a person
 *    writes the new revision with `needs_review = true` — **never a silent overwrite**. That is
 *    `reviewPolicy: "when_manual"` in `applyCells`, and design/06 §7 requires it.
 *
 * A failure records `status='failed'`, `last_error`, `consecutive_failures++`, an audit row and
 * a `level:"warn"` log — and sends **no mail**. There is no admin-alert channel in the product
 * yet and inventing one here would be E2.6's decision taken in the wrong place.
 */

/** Envelope purpose for the service-account private key (§3.6). */
export const SHEETS_KEY_PURPOSE = "metrics-sheets";

/** Mirrors `updates.sending_domain`'s `encryption` jsonb, field for field. */
interface Encryption {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

export interface SheetSyncOutcome {
  readonly status: SyncStatus;
  readonly rows: number;
  readonly written: number;
  readonly unchanged: number;
  readonly restated: number;
  readonly needsReview: number;
  /**
   * Cells the sync read and deliberately passed over: a blank month, a duplicate period. Not a
   * problem, but the difference between "nothing to import" and "nothing imported".
   */
  readonly skipped: number;
  /**
   * Cells — and whole rows that never got as far as their cells — the sync read and could not
   * turn into a number. **This is the field that makes a silent failure impossible**: before it
   * existed, a currency-formatted column produced zero points and `status: "ok"`, which is a
   * green light on an integration that imported nothing.
   */
  readonly unparsed: number;
  readonly error: string | null;
}

export interface PutSheetsInput {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly mapping: CsvMapping;
  readonly credentialJson: string;
  readonly enabled?: boolean | undefined;
}

/*
 * Saying which column and which cell defeated the import.
 *
 * This sentence is the entire diagnosis for the person who has to fix the sheet, and it is
 * worth the code: "the sync imported nothing" sends them looking at permissions, at the
 * service account, at the range — everywhere except the one cell that is formatted as currency.
 * So the message names the column, the row and the text we could not read.
 *
 * The cell text is quoted back, capped at forty characters. A KPI cell is the workspace's own
 * number shown to the workspace's own admin, and without it the message is a shrug; the cap is
 * there because `last_error` is also a log line and a 500-character cell helps nobody.
 */
const QUOTED_MAX = 40;
const quoted = (text: string): string =>
  `"${text.length > QUOTED_MAX ? `${text.slice(0, QUOTED_MAX)}...` : text}"`;

function cellProblem(line: number, cell: PlannedCell): string {
  if (cell.reason === "column_missing") {
    return `the sheet has no column called ${quoted(cell.column)}, which the mapping sends to the metric "${cell.key}"`;
  }
  if (cell.reason === "unknown_metric") {
    return `column ${quoted(cell.column)} is mapped to "${cell.key}", which is not a metric in this workspace`;
  }
  return `column ${quoted(cell.column)} on row ${line} holds ${quoted(cell.value ?? "")}, which is not a plain decimal — a currency, percent or thousands-separated column renders as text, so format it as a plain number and sync again`;
}

function rowProblem(row: PlannedRow): string {
  const reason = row.reason ?? "";
  if (reason.startsWith("duplicate_column:")) {
    return `the header row has two columns called ${quoted(reason.slice("duplicate_column:".length))}`;
  }
  if (reason.startsWith("too_many_rows:")) {
    return `the range holds more than ${METRICS_IMPORT_MAX_ROWS} data rows`;
  }
  if (reason === "period_column_missing") {
    return "the sheet has no period column under the name the mapping gives it";
  }
  if (reason === "missing_period") return `row ${row.line} has nothing in the period column`;
  if (reason === "unreadable_period") {
    return `row ${row.line}'s period ${quoted(row.periodKey)} is not a period we can read (try 2026-01, 2026-Q1 or 2026)`;
  }
  return `row ${row.line} carried no usable value`;
}

/** `metrics.sheet_connection.last_error` is CHECKed at 1 000 characters. */
const trimError = (text: string): string =>
  text.length > 1000 ? `${text.slice(0, 997)}...` : text;

export function createSheetsService(services: ModuleServices) {
  const { db, crypto } = services;

  /**
   * The stored credential, or `undefined`.
   *
   * Never throws for a missing key: the DEK can be gone because a workspace was restored from a
   * backup taken before it existed, and the honest outcome is a connection that reports itself
   * broken, not an exception that takes a whole sweep down with it.
   */
  async function credentialOf(
    tx: Tx,
    ctx: TenantContext,
    row: SheetConnectionRow,
  ): Promise<SpreadsheetCredential | undefined> {
    const enc = row.encryption as Partial<Encryption>;
    if (enc.keyId === undefined) return undefined;
    const key = await crypto.keyById(tx, ctx, enc.keyId);
    if (key === undefined) {
      services.log("metrics.sheets_key_missing", { level: "warn", keyId: enc.keyId });
      return undefined;
    }
    const json = Buffer.from(await decryptBytes(key.key, row.credentialEnc)).toString("utf8");
    const parsed = parseServiceAccountJson(json);
    return parsed.ok ? parsed.credential : undefined;
  }

  async function recordFailure(
    ctx: TenantContext,
    connectionId: string,
    error: string,
    actor?: Actor,
    counts: { rows: number; skipped: number; unparsed: number } = {
      rows: 0,
      skipped: 0,
      unparsed: 0,
    },
  ): Promise<SheetSyncOutcome> {
    await db.withTenant(ctx, async (tx) => {
      await new SheetConnectionRepo(ctx, tx).recordSync({
        status: "failed",
        error: trimError(error),
      });
      await services.audit.record(tx, ctx, {
        action: "metrics.sheets_sync_failed",
        resourceKind: "metric_sheet_connection",
        resourceId: connectionId,
        outcome: "failure",
        ...(actor === undefined
          ? { actorKind: "system" as const, actorMembershipId: null }
          : { actorMembershipId: actor.membershipId }),
        meta: { error: trimError(error) },
      });
    });
    services.log("metrics.sheets_sync_failed", {
      level: "warn",
      workspaceId: ctx.workspaceId,
      connectionId,
      error,
    });
    return {
      status: "failed",
      rows: counts.rows,
      written: 0,
      unchanged: 0,
      restated: 0,
      needsReview: 0,
      skipped: counts.skipped,
      unparsed: counts.unparsed,
      error,
    };
  }

  async function sync(ctx: TenantContext, actor?: Actor): Promise<SheetSyncOutcome> {
    const loaded = await db.withTenant(ctx, async (tx) => {
      const connection = await new SheetConnectionRepo(ctx, tx).find();
      if (connection === undefined) return undefined;
      const definitions = await new DefinitionRepo(ctx, tx).list();
      return { connection, definitions, credential: await credentialOf(tx, ctx, connection) };
    });
    if (loaded === undefined) throw new MetricsError("not_found", "no sheet connection");
    const { connection, definitions, credential } = loaded;
    if (!connection.enabled) {
      throw new MetricsError("conflict", "the sheet connection is switched off", {
        connectionId: connection.id,
      });
    }
    if (credential === undefined) {
      return recordFailure(
        ctx,
        connection.id,
        "the stored credential could not be read; re-paste the service-account JSON",
        actor,
      );
    }

    // The network call happens outside any transaction: a 10-second remote read must not hold a
    // tenant transaction (and its row locks) open while Google decides whether to answer.
    const read = await services.spreadsheets.read(
      credential,
      connection.spreadsheetId,
      connection.range,
    );
    if (!read.ok) {
      const detail = read.detail === undefined ? "" : `: ${read.detail}`;
      return recordFailure(ctx, connection.id, `${read.reason}${detail}`, actor);
    }

    const mapping = connection.mapping as unknown as CsvMapping;
    const manual = definitions.filter((d) => d.formula === null);
    const plan = planImport(
      read.range.rows,
      mapping,
      new Set(manual.map((d) => d.key.toLowerCase())),
    );
    const byKey = new Map(manual.map((d) => [d.key.toLowerCase(), d]));
    const cells: CellWrite[] = [];
    /*
     * Everything the plan could not use is counted, and the first thing that went wrong is
     * remembered. Every one of these was a bare `continue` before: the sync dropped the cell
     * and reported `ok`, so a sheet whose MRR column is formatted as currency imported nothing
     * and said so nowhere. A count nobody looks at is still not enough — the counts decide the
     * status below.
     */
    let skipped = 0;
    let unparsed = 0;
    const problems: string[] = [];
    for (const row of plan.rows) {
      if (row.status === "error" || row.status === "skipped") {
        // A row that never reached its cells (no period, an unreadable one, the row cap) counts
        // once: it is one thing the admin has to fix, and it produced no cells to count instead.
        if (row.cells.length === 0) {
          if (row.status === "error") {
            unparsed += 1;
            problems.push(rowProblem(row));
          } else {
            skipped += 1;
          }
          continue;
        }
      }
      for (const cell of row.cells) {
        if (cell.status === "error") {
          unparsed += 1;
          problems.push(cellProblem(row.line, cell));
          continue;
        }
        if (cell.status !== "ok" || cell.value === null) {
          skipped += 1;
          continue;
        }
        const definition = byKey.get(cell.key.toLowerCase());
        if (definition === undefined) {
          unparsed += 1;
          problems.push(
            `column ${quoted(cell.column)} is mapped to "${cell.key}", which is not a metric in this workspace`,
          );
          continue;
        }
        /*
         * The definition's own period kind, not the mapping's: a quarterly metric fed from a
         * monthly column is a mapping mistake, and it has to be said rather than dropped.
         */
        const period = parsePeriodKey(definition.periodKind, row.periodKey);
        const value = parseFixed(cell.value);
        if (period === undefined || value === undefined) {
          unparsed += 1;
          problems.push(
            period === undefined
              ? `row ${row.line}'s period ${quoted(row.periodKey)} is not a ${definition.periodKind} that "${definition.key}" can hold`
              : cellProblem(row.line, cell),
          );
          continue;
        }
        cells.push({ definitionId: definition.id, period, value, decimals: definition.decimals });
      }
    }

    /*
     * **A sync that read rows and parsed no value out of them is `failed`, not `ok`.**
     *
     * `SyncStatus` has four members and this is the one that means "the connection is not
     * doing its job": the admin screen shows it, `consecutive_failures` climbs, and the
     * `last_error` sentence names the column and the cell that defeated it. The alternative —
     * a green connection that imports nothing — is the defect this whole branch exists to end.
     *
     * The condition is deliberately narrow. Nothing parsed **and** something was unreadable. A
     * sheet with only a header row, or one whose figures are simply not filled in yet, parses
     * nothing and has nothing wrong with it: that stays `ok`, which is what a founder sees on
     * the day they connect a blank sheet. And a sheet that parsed *some* values is `ok` with
     * the counts telling the rest of the story — one bad cell must not discard nine good ones.
     */
    const summary = summarise(plan.rows);
    if (cells.length === 0 && unparsed > 0) {
      const detail = problems[0] ?? "nothing in the range parsed as a number";
      const extra = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
      return recordFailure(
        ctx,
        connection.id,
        `read ${read.range.rows.length} rows from the sheet and imported nothing (${summary.error} of ${plan.rows.length} rows unusable): ${detail}${extra}`,
        actor,
        { rows: plan.rows.length, skipped, unparsed },
      );
    }

    const syncId = randomUUID();
    const outcome = await db.withTenant(ctx, async (tx) => {
      const applied = await applyCells(
        tx,
        ctx,
        { audit: services.audit, now: services.now },
        {
          cells,
          sourceKind: "sheets",
          sourceRef: {
            connectionId: connection.id,
            spreadsheetId: connection.spreadsheetId,
            range: connection.range,
            syncId,
          },
          ...(actor === undefined ? {} : { actor }),
          /*
           * The whole point of the flag: a number a person typed is not replaced by a sheet
           * behind their back. The new revision is written — the sheet is the source of record
           * going forward — but it carries `needs_review` so the admin screen can show the two
           * figures side by side and let them decide.
           */
          reviewPolicy: "when_manual",
        },
      );
      await announcePointsChanged(tx, ctx, applied.definitionIds);
      await new SheetConnectionRepo(ctx, tx).recordSync({ status: "ok", error: null });
      await services.audit.record(tx, ctx, {
        action: "metrics.sheets_synced",
        resourceKind: "metric_sheet_connection",
        resourceId: connection.id,
        ...(actor === undefined
          ? { actorKind: "system" as const, actorMembershipId: null }
          : { actorMembershipId: actor.membershipId }),
        meta: {
          syncId,
          rows: plan.rows.length,
          written: applied.written,
          restated: applied.restated,
          unchanged: applied.unchanged,
          needsReview: applied.needsReview,
          // A partly-readable sheet is still worth a record: this is how "half my numbers
          // stopped arriving in March" becomes answerable six months later.
          skipped,
          unparsed,
        },
      });
      return applied;
    });

    return {
      status: "ok",
      rows: plan.rows.length,
      written: outcome.written,
      unchanged: outcome.unchanged,
      restated: outcome.restated,
      needsReview: outcome.needsReview,
      skipped,
      unparsed,
      error: null,
    };
  }

  return {
    get(ctx: TenantContext): Promise<SheetConnectionRow | undefined> {
      return db.withTenant(ctx, (tx) => new SheetConnectionRepo(ctx, tx).find());
    },

    /**
     * Links (or re-links) the workspace's sheet. Everything the admin pasted is validated
     * *before* anything is encrypted or stored — a spreadsheet id, an A1 range and a
     * service-account JSON are all free-form input that ends up in a URL or a signed assertion.
     */
    async put(
      ctx: TenantContext,
      input: PutSheetsInput,
      actor: Actor,
    ): Promise<SheetConnectionRow> {
      if (!isValidSpreadsheetId(input.spreadsheetId)) {
        throw new MetricsError(
          "validation_failed",
          "that is not a spreadsheet id; paste the id out of the sheet's URL, not the whole URL",
          { field: "spreadsheetId" },
        );
      }
      if (!isValidRange(input.range)) {
        throw new MetricsError(
          "validation_failed",
          "that is not an A1 range (for example `KPIs!A1:M40`)",
          { field: "range" },
        );
      }
      const parsed = parseServiceAccountJson(input.credentialJson);
      if (!parsed.ok) {
        // The adapter's detail names the expected shape and never quotes the input back, so it
        // is safe to pass through — the key must not reach a log line or an error body.
        throw new MetricsError(
          "validation_failed",
          parsed.detail ?? "the service-account credential is not usable",
          { field: "credentialJson", reason: parsed.reason },
        );
      }
      return db.withTenant(ctx, async (tx) => {
        /*
         * E3.6: a metric fed by a KPI integration cannot also be in the sheet mapping — the two
         * syncs would restate each other every night. Checked under the same lock `putBinding`
         * takes, so neither side can slip in between the other's check and its write.
         */
        const bindings = new SourceBindingRepo(ctx, tx);
        await bindings.lockSourceConfig();
        const bound = await bindings.list();
        if (bound.length > 0) {
          const boundKeys = new Map(
            (await new DefinitionRepo(ctx, tx).byIds(bound.map((b) => b.definitionId))).map((d) => [
              d.key.toLowerCase(),
              bound.find((b) => b.definitionId === d.id)?.provider,
            ]),
          );
          const overlap = input.mapping.columns.filter((c) => boundKeys.has(c.key.toLowerCase()));
          const first = overlap[0];
          if (first !== undefined) {
            throw new MetricsError(
              "conflict",
              `\`${first.key}\` is fed by ${boundKeys.get(first.key.toLowerCase()) ?? "an integration"}; remove that binding or drop the column from the mapping`,
              { reason: "source_overlap", keys: overlap.map((c) => c.key), source: "integration" },
            );
          }
        }
        const dek = await crypto.currentKey(tx, ctx, SHEETS_KEY_PURPOSE);
        const enc = await encryptBytes(dek.key, Buffer.from(input.credentialJson, "utf8"));
        const encryption: Encryption = { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
        const row = await new SheetConnectionRepo(ctx, tx).upsert({
          spreadsheetId: input.spreadsheetId,
          range: input.range,
          mapping: input.mapping as unknown as Record<string, unknown>,
          credentialEnc: enc,
          encryption: encryption as unknown as Record<string, unknown>,
          serviceAccountEmail: parsed.credential.clientEmail,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "metrics.sheets_connected",
          resourceKind: "metric_sheet_connection",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: {
            spreadsheetId: row.spreadsheetId,
            range: row.range,
            serviceAccountEmail: row.serviceAccountEmail,
            metrics: input.mapping.columns.length,
          },
        });
        return row;
      });
    },

    async remove(ctx: TenantContext, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const repo = new SheetConnectionRepo(ctx, tx);
        const row = await repo.find();
        if (row === undefined) throw new MetricsError("not_found", "no sheet connection");
        await repo.remove();
        await services.audit.record(tx, ctx, {
          action: "metrics.sheets_disconnected",
          resourceKind: "metric_sheet_connection",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: { spreadsheetId: row.spreadsheetId },
        });
      });
    },

    sync,
  };
}

export type SheetsService = ReturnType<typeof createSheetsService>;
