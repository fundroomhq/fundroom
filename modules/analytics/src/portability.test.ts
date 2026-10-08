import { readdirSync, readFileSync } from "node:fs";
import type { ModuleServices, PortableImportContext, PortableTable } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { analyticsModule } from "./index.js";
import { PARTITION_MONTHS_AHEAD } from "./jobs.js";
import {
  analyticsPortability,
  IMPORT_PARTITION_MONTHS_BACK,
  importEventWindow,
  importedSessionKey,
} from "./portability.js";

const SCHEMA = "analytics";
const NEW = "0190f5c2-2222-7000-8000-000000000002";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const RAW = ["view_session", "event", "page_open"];

const ctx: PortableImportContext = {
  workspaceId: "0190f5c2-3333-7000-8000-000000000003",
  sourceWorkspaceId: "0190f5c2-4444-7000-8000-000000000004",
  now: NOW,
  mapId: (id) => id,
  remapLtree: (p) => p,
  remapKey: (k) => k,
};

function migrationTables(): { names: string[]; refs: Map<string, Set<string>> } {
  const dir = new URL("../migrations/", import.meta.url);
  const sqlText = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
  const names: string[] = [];
  const refs = new Map<string, Set<string>>();
  const create = new RegExp(
    `CREATE TABLE ${SCHEMA}\\.([a-z_][a-z0-9_]*) \\(([\\s\\S]*?)\\n\\)`,
    "gu",
  );
  for (const m of sqlText.matchAll(create)) {
    const name = m[1] as string;
    names.push(name);
    const deps = new Set<string>();
    for (const r of (m[2] as string).matchAll(
      new RegExp(`REFERENCES ${SCHEMA}\\.([a-z_][a-z0-9_]*)`, "gu"),
    )) {
      if (r[1] !== name) deps.add(r[1] as string);
    }
    refs.set(name, deps);
  }
  for (const m of sqlText.matchAll(
    new RegExp(`DROP TABLE (?:IF EXISTS )?${SCHEMA}\\.([a-z_][a-z0-9_]*)`, "gu"),
  )) {
    names.splice(names.indexOf(m[1] as string), 1);
  }
  return { names, refs };
}

function spec(name: string): PortableTable {
  const t = analyticsPortability.tables.find((x) => x.table === name);
  if (t === undefined) throw new Error(`no spec for ${name}`);
  return t;
}

function imported(name: string, row: JsonObject): JsonObject | null {
  const t = spec(name);
  return t.importRow === undefined ? row : t.importRow(row, ctx);
}

describe("analytics portability", () => {
  it("is declared on the manifest", () => {
    expect(analyticsModule.portability).toBe(analyticsPortability);
  });

  it("covers every table of the migrations (partitions excluded), in FK dependency order", () => {
    const { names, refs } = migrationTables();
    const declared = analyticsPortability.tables.map((t) => t.table);
    expect([...declared].sort()).toEqual([...names].sort());
    expect(names).not.toContain("event_202609");
    for (const [table, deps] of refs) {
      for (const dep of deps) {
        expect(declared.indexOf(dep), `${dep} before ${table}`).toBeLessThan(
          declared.indexOf(table),
        );
      }
    }
  });

  it("exports raw tables only with includeRawAnalytics; rollups and the cursor always", () => {
    for (const t of analyticsPortability.tables) {
      expect(t.mode).toBe("rows");
      expect(t.includeWhen).toBe(RAW.includes(t.table) ? "rawAnalytics" : undefined);
    }
  });

  it("omits the keyed ip hash and the session hash, and mints a fresh 32-byte session key", () => {
    expect(spec("view_session").omitColumns).toEqual(
      expect.arrayContaining(["ip_hash", "session_key"]),
    );
    const row = {
      id: NEW,
      workspace_id: ctx.workspaceId,
      membership_id: NEW,
      ua_family: "firefox",
    };
    const out = imported("view_session", row);
    expect(out).toEqual({ ...row, session_key: importedSessionKey(NEW) });
    expect(out?.["session_key"]).toMatch(/^\\x[0-9a-f]{64}$/u);
    expect(importedSessionKey(NEW)).not.toBe(importedSessionKey(ctx.workspaceId));
    expect(out).not.toHaveProperty("ip_hash");
  });

  it("keeps events inside the partition window and drops the rest", () => {
    const w = importEventWindow(NOW);
    expect(w.from.toISOString()).toBe("2016-09-01T00:00:00.000Z");
    expect(w.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const ev = (occurred_at: string | null): JsonObject => ({
      id: NEW,
      occurred_at,
      type: "document_viewed",
    });
    expect(imported("event", ev("2026-09-23T10:00:00.123456+00:00"))).toEqual(
      ev("2026-09-23T10:00:00.123456+00:00"),
    );
    expect(imported("event", ev("2016-09-01T00:00:00+00:00"))).not.toBeNull();
    expect(imported("event", ev("2016-08-31T23:59:59+00:00"))).toBeNull();
    expect(imported("event", ev("2027-01-01T00:00:00+00:00"))).toBeNull();
    expect(imported("event", ev(null))).toBeNull();
  });

  it("carries rollups, the page buffer and the cursor untouched", () => {
    for (const name of [
      "page_open",
      "viewer_resource_rollup",
      "daily_resource_rollup",
      "rollup_cursor",
      "page_rollup",
      "page_viewer",
      "hot_lead_alert",
    ]) {
      expect(spec(name).importRow).toBeUndefined();
      expect(spec(name).omitColumns ?? []).toEqual([]);
    }
  });

  it("beforeImport creates partitions for the whole window only when events are imported", async () => {
    const calls: string[] = [];
    const tx = {
      execute: async (q: { queryChunks?: unknown[] }) => {
        calls.push(JSON.stringify(q.queryChunks ?? q));
        return { rows: [{ n: 0 }] };
      },
    };
    const services = { now: () => NOW, log: () => {} } as unknown as ModuleServices;
    const hook = analyticsPortability.beforeImport;
    if (hook === undefined) throw new Error("no beforeImport");
    const tenant = { workspaceId: ctx.workspaceId } as never;
    await hook({ tx: tx as never, ctx: tenant, services, rows: { event: 0, view_session: 3 } });
    expect(calls).toEqual([]);
    await hook({ tx: tx as never, ctx: tenant, services, rows: { event: 5 } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(String(IMPORT_PARTITION_MONTHS_BACK));
    expect(calls[0]).toContain("2016-08-01");
    expect(calls[1]).toContain(String(PARTITION_MONTHS_AHEAD + 1));
  });
});
