import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  exportSheetConnectionRow,
  IMPORT_INTERRUPTED,
  importImportRow,
  importSheetConnectionRow,
  importSourceBindingRow,
  metricsPortability,
  SHEETS_RECONNECT,
} from "./portability.js";
import {
  definition,
  metricImport,
  point,
  sheetConnection,
  source,
  sourceBinding,
} from "./schema/metrics.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const ctx = {
  workspaceId: "w2",
  sourceWorkspaceId: "w1",
  now: NOW,
  mapId: (id: string) => id,
  remapLtree: (p: string) => p,
  remapKey: (k: string) => k,
};

describe("metrics portability spec", () => {
  it("lists every table of the schema in FK order, all carried as rows", () => {
    const tables = [definition, source, point, metricImport, sheetConnection, sourceBinding].map(
      (t) => getTableConfig(t).name,
    );
    expect(metricsPortability.tables.map((t) => t.table)).toEqual(tables);
    expect(metricsPortability.tables.every((t) => t.mode === "rows")).toBe(true);
  });

  it("the sheets credential never leaves: exportRow blanks the ciphertext and its descriptor", () => {
    const row = {
      id: "c1",
      spreadsheet_id: "sheet",
      credential_enc: "\\xdeadbeef",
      encryption: { format: "she1", keyId: "k1", keyRef: "local" },
      service_account_email: "sa@example.iam.gserviceaccount.com",
    };
    const spec = metricsPortability.tables.find((t) => t.table === "sheet_connection");
    const out = spec?.exportRow?.(row);
    expect(out).toEqual({ ...row, credential_enc: "\\x", encryption: {} });
    expect(exportSheetConnectionRow(row)).toEqual(out);
  });

  it("an imported connection is disabled and says how to reconnect", () => {
    const spec = metricsPortability.tables.find((t) => t.table === "sheet_connection");
    const row = {
      credential_enc: "\\x",
      encryption: {},
      enabled: true,
      status: "ok",
      last_error: null,
      consecutive_failures: 3,
      mapping: { rows: [] },
    };
    const out = spec?.importRow?.(row, ctx);
    expect(out).toEqual({
      credential_enc: "\\x",
      encryption: {},
      enabled: false,
      status: "failed",
      last_error: SHEETS_RECONNECT,
      consecutive_failures: 0,
      mapping: { rows: [] },
    });
    expect(importSheetConnectionRow(row)).toEqual(out);
    expect(SHEETS_RECONNECT.length).toBeLessThanOrEqual(1000);
  });

  it("a CSV import caught mid-run comes back failed; finished ones are untouched", () => {
    const spec = metricsPortability.tables.find((t) => t.table === "import");
    for (const status of ["pending", "running"]) {
      expect(spec?.importRow?.({ status, finished_at: null, last_error: null }, ctx)).toEqual({
        status: "failed",
        finished_at: NOW.toISOString(),
        last_error: IMPORT_INTERRUPTED,
      });
    }
    const done = { status: "done" };
    expect(importImportRow(done, NOW)).toBe(done);
  });

  it("a KPI binding travels without its health, so the target's first sync backfills (E3.6)", () => {
    const spec = metricsPortability.tables.find((t) => t.table === "source_binding");
    const row = {
      id: "b1",
      definition_id: "d1",
      provider: "stripe",
      source_metric: "mrr",
      enabled: true,
      status: "failed",
      last_sync_at: "2026-09-20T04:55:00.000Z",
      last_success_at: "2026-09-19T04:55:00.000Z",
      last_error: "not connected",
      consecutive_failures: 2,
    };
    const out = spec?.importRow?.(row, ctx);
    expect(out).toEqual({
      ...row,
      status: "idle",
      last_sync_at: null,
      last_success_at: null,
      last_error: null,
      consecutive_failures: 0,
      history_from: null,
      history_note: null,
    });
    expect(importSourceBindingRow(row)).toEqual(out);
    expect(spec?.exportRow).toBeUndefined();
  });
});
