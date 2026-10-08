import type { ModulePortability } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";

/*
 * Workspace export/import (E2.8).
 *
 *  - `definition`, `source`, `point`, `import`: rows. The series is the product — every revision
 *    of every point with its provenance — and none of it is derived (derived *definitions* keep
 *    their computed points, which were true when they were written, exactly as the source has
 *    them). FK order: definition → source → point (→ definition, source) → import (→ source).
 *    `point.superseded_by` names the next revision of the same cell, a later row; it is DEFERRABLE
 *    INITIALLY DEFERRED since 0003 and resolves at the import's COMMIT, beside the (already
 *    deferred) one-live-point exclusion. The append-only trigger fires on UPDATE/DELETE only, so
 *    inserting history as exported is legal. `point.period_start` is GENERATED (stripped).
 *    `source.ref` ids (`importId`, `connectionId`, formula `inputs`) are whole jsonb strings and
 *    are remapped by the engine's generic id remap.
 *    A CSV `import` caught mid-run comes back `failed` (its job does not travel).
 *  - `sheet_connection`: rows, **without the credential**. `credential_enc` is the Google
 *    service-account private key sealed under the source workspace's DEK; it is NOT NULL, so it
 *    cannot be an `omitColumns` entry — `exportRow` blanks it (empty bytea) and empties the
 *    envelope descriptor before it ever reaches the archive. With no `keyId` the service reads
 *    the connection as "the stored credential could not be read; re-paste the service-account
 *    JSON" (sheets.ts `credentialOf`), and `importRow` makes the state explicit: disabled (the
 *    nightly sweep skips it), `failed`, with an error naming the fix. Spreadsheet, range, mapping
 *    and the service-account address survive, so reconnecting is one paste.
 *
 *  - `source_binding` (E3.6): rows, health reset (see `importSourceBindingRow`).
 *
 * `metrics.point_current` is a view, not a table, and is not listed.
 */
export const SHEETS_RECONNECT =
  "Imported from another workspace without its credential: paste the service-account JSON again to reconnect.";

export const IMPORT_INTERRUPTED =
  "interrupted by a workspace export/import before it finished; upload the file again";

/**
 * A CSV import still `pending`/`running` at export time is driven by a queued job that does not
 * travel, so on the target nothing would ever finish it: it comes back `failed`, saying why.
 * The points it had already applied travel with `point` and stay.
 */
export function importImportRow(row: JsonObject, now: Date): JsonObject {
  if (row["status"] !== "pending" && row["status"] !== "running") return row;
  return {
    ...row,
    status: "failed",
    last_error: IMPORT_INTERRUPTED,
    finished_at: typeof row["finished_at"] === "string" ? row["finished_at"] : now.toISOString(),
  };
}

export function exportSheetConnectionRow(row: JsonObject): JsonObject {
  return { ...row, credential_enc: "\\x", encryption: {} };
}

export function importSheetConnectionRow(row: JsonObject): JsonObject {
  return {
    ...row,
    credential_enc: "\\x",
    encryption: {},
    enabled: false,
    status: "failed",
    last_error: SHEETS_RECONNECT,
    consecutive_failures: 0,
  };
}

/**
 * A KPI binding (E3.6) travels — which metric is fed by which provider series is the
 * workspace's configuration — but its health does not: the connection it synced through is a
 * vendor credential that portability never carries (`core.integration_connection` is skipped).
 * It arrives idle with no success on record, so once the target workspace connects the
 * provider its first sync backfills 24 months; until then the sync records "not connected".
 */
export function importSourceBindingRow(row: JsonObject): JsonObject {
  return {
    ...row,
    status: "idle",
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    history_from: null,
    history_note: null,
  };
}

export const metricsPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "definition", mode: "rows" },
    { table: "source", mode: "rows" },
    { table: "point", mode: "rows" },
    { table: "import", mode: "rows", importRow: (row, ctx) => importImportRow(row, ctx.now) },
    {
      table: "sheet_connection",
      mode: "rows",
      exportRow: (row) => exportSheetConnectionRow(row),
      importRow: (row) => importSheetConnectionRow(row),
    },
    // → definition (FK).
    { table: "source_binding", mode: "rows", importRow: (row) => importSourceBindingRow(row) },
  ],
};
