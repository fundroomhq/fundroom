import { readdirSync, readFileSync } from "node:fs";
import type { PortableImportContext, PortableTable } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { notifyModule } from "./index.js";
import {
  IMPORT_DROPPED_REASON,
  IMPORT_RECONNECT_ERROR,
  IMPORT_SLACK_APP_ERROR,
  notifyPortability,
} from "./portability.js";

const SCHEMA = "notify";
const OLD = "0190f5c2-1111-7000-8000-000000000001";
const NEW = "0190f5c2-2222-7000-8000-000000000002";
const NOW = new Date("2026-09-23T12:00:00.000Z");

const ctx: PortableImportContext = {
  workspaceId: "0190f5c2-3333-7000-8000-000000000003",
  sourceWorkspaceId: "0190f5c2-4444-7000-8000-000000000004",
  now: NOW,
  mapId: (id) => (id === OLD ? NEW : id),
  remapLtree: (p) => p,
  remapKey: (k) => k.replaceAll(OLD, NEW),
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
  const t = notifyPortability.tables.find((x) => x.table === name);
  if (t === undefined) throw new Error(`no spec for ${name}`);
  return t;
}

function imported(name: string, row: JsonObject): JsonObject | null {
  const t = spec(name);
  return t.importRow === undefined ? row : t.importRow(row, ctx);
}

describe("notify portability", () => {
  it("is declared on the manifest", () => {
    expect(notifyModule.portability).toBe(notifyPortability);
  });

  it("covers every table of the migrations, in FK dependency order", () => {
    const { names, refs } = migrationTables();
    const declared = notifyPortability.tables.map((t) => t.table);
    expect([...declared].sort()).toEqual([...names].sort());
    for (const [table, deps] of refs) {
      for (const dep of deps) {
        expect(declared.indexOf(dep), `${dep} before ${table}`).toBeLessThan(
          declared.indexOf(table),
        );
      }
    }
    for (const t of notifyPortability.tables) expect(t.mode).toBe("rows");
  });

  it("carries preferences and member settings untouched", () => {
    const pref = {
      workspace_id: NEW,
      membership_id: NEW,
      event_type: "update.replied",
      cadence: "daily",
    };
    expect(imported("preference", pref)).toEqual(pref);
    const settings = {
      workspace_id: NEW,
      membership_id: NEW,
      timezone: "Europe/Oslo",
      digest_hour: 7,
    };
    expect(imported("member_settings", settings)).toEqual(settings);
  });

  it("closes a claimed-but-unsent digest so the copy never sends it; keeps sent ones", () => {
    const sent = { id: NEW, sent_at: "2026-09-01T08:00:00+00:00", slot: "2026-09-01T08:00:00Z" };
    expect(imported("digest", sent)).toEqual(sent);
    expect(imported("digest", { id: NEW, sent_at: null, slot: "x" })).toEqual({
      id: NEW,
      sent_at: NOW.toISOString(),
      slot: "x",
    });
  });

  it("closes unsent notifications (no instant email from the copy) and remaps dedupe keys", () => {
    const pending = {
      id: NEW,
      dedupe_key: `document.viewed:${OLD}:2026-09-23T11`,
      sent_at: null,
      email_outcome: null,
      deferred_until: "2026-09-23T13:00:00+00:00",
      next_attempt_at: "2026-09-23T12:05:00+00:00",
      attempts: 1,
    };
    expect(imported("notification", pending)).toEqual({
      ...pending,
      dedupe_key: `document.viewed:${NEW}:2026-09-23T11`,
      sent_at: NOW.toISOString(),
      deferred_until: null,
      next_attempt_at: null,
    });
    const done = {
      id: NEW,
      dedupe_key: "k",
      sent_at: "2026-09-20T10:00:00+00:00",
      email_outcome: "emailed",
    };
    expect(imported("notification", done)).toEqual(done);
  });

  it("never exports the webhook URL and imports the channel disabled, needing a reconnect", () => {
    const t = spec("channel");
    expect(t.omitColumns).toEqual(expect.arrayContaining(["url_enc", "encryption"]));
    expect(t.blobs ?? []).toEqual([]);
    const row = {
      id: NEW,
      name: "#fundraise",
      kind: "slack",
      url_hint: "Xy9Z",
      enabled: true,
      disabled_reason: null,
      failure_count: 0,
      event_types: ["analytics.hot_lead"],
    };
    const out = imported("channel", row);
    expect(out).toEqual({
      ...row,
      url_enc: "\\x",
      enabled: false,
      disabled_reason: "invalid_url",
      last_error: IMPORT_RECONNECT_ERROR,
    });
    // Within the table's CHECKs: last_error ≤ 300 chars, disabled_reason in the allowed set.
    expect(IMPORT_RECONNECT_ERROR.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(out)).not.toContain("encryption");
  });

  it("imports a Slack app channel disabled as not_connected, with no URL (E3.6)", () => {
    const row = {
      id: NEW,
      name: "#deals",
      kind: "slack_app",
      url_hint: null,
      slack_channel_id: "C0DEALS",
      slack_channel_name: "deals",
      enabled: true,
      disabled_reason: null,
      failure_count: 0,
      event_types: ["integration.connection_unhealthy"],
    };
    expect(imported("channel", row)).toEqual({
      ...row,
      url_enc: null,
      enabled: false,
      disabled_reason: "not_connected",
      last_error: IMPORT_SLACK_APP_ERROR,
    });
    expect(IMPORT_SLACK_APP_ERROR.length).toBeLessThanOrEqual(300);
  });

  it("drops queued chat posts and remaps source keys; keeps the post log", () => {
    const queued = {
      id: NEW,
      source_key: `round.commitment_created:${OLD}`,
      status: "sending",
      claimed_at: "x",
    };
    expect(imported("channel_delivery", queued)).toEqual({
      id: NEW,
      source_key: `round.commitment_created:${NEW}`,
      status: "dropped",
      claimed_at: null,
      last_error: IMPORT_DROPPED_REASON,
    });
    const sent = { id: NEW, source_key: "analytics.hot_lead:x", status: "sent", last_error: null };
    expect(imported("channel_delivery", sent)).toEqual(sent);
    expect(imported("channel_delivery", { ...sent, status: "pending" })?.["status"]).toBe(
      "dropped",
    );
  });
});
