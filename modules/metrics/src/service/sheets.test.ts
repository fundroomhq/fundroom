import { generateKeyPairSync } from "node:crypto";
import { encryptBytes } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { SpreadsheetReadResult } from "@fundroom/ports";
import { beforeAll, describe, expect, it } from "vitest";
import { MetricsError } from "../errors.js";
import type { CsvMapping } from "./mapping.js";
import { createSheetsService, SHEETS_KEY_PURPOSE } from "./sheets.js";

/*
 * The Sheets connection. Two properties are pinned because both are easy to lose in a refactor
 * and neither fails loudly when it is lost:
 *
 *  - the pasted credential is **validated before it is encrypted**, so a typo fails at the
 *    admin's keyboard rather than at 04:35 in a cron job nobody is watching;
 *  - a sync that disagrees with a number a person typed writes a new revision flagged
 *    `needs_review` — and a failure records itself on the connection row and **sends no mail**.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const actor = { membershipId: "01920000-0000-7000-8000-0000000000b1" };
const CASH = "01920000-0000-7000-8000-0000000000a1";
const SPREADSHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const KEY = new Uint8Array(32).fill(5);
const NOW = new Date("2026-03-15T12:00:00.000Z");

let credentialJson: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  credentialJson = JSON.stringify({
    type: "service_account",
    client_email: "kpis@acme.iam.gserviceaccount.com",
    private_key: privateKey,
  });
});

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

function sqlParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object" || node instanceof Date) {
    out.push(node);
    return out;
  }
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlParams(k, out);
    return out;
  }
  if ("encoder" in c) {
    out.push(c["value"]);
    return out;
  }
  if (Array.isArray(c["value"])) return out;
  out.push(node);
  return out;
}

const MAPPING: CsvMapping = {
  periodColumn: "period",
  periodKind: "month",
  columns: [{ column: "cash", key: "cash" }],
};

const DEFINITION = {
  id: CASH,
  key: "cash",
  name: "Cash",
  description: null,
  unit: "currency",
  currency: "USD",
  aggregation: "last",
  direction: "up_good",
  periodKind: "month",
  decimals: 2,
  formula: null,
  display: {},
  audience: { kind: "staff_only" },
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

interface Options {
  readonly connection?: boolean | undefined;
  readonly live?: readonly { value: string }[] | undefined;
  readonly liveSourceKind?: string | undefined;
  readonly read?: SpreadsheetReadResult | undefined;
  readonly credentialEnc?: Uint8Array | undefined;
  readonly keyMissing?: boolean | undefined;
  readonly enabled?: boolean | undefined;
  /** E3.6: the CASH definition is fed by a KPI binding. */
  readonly bound?: boolean | undefined;
}

async function harness(options: Options = {}) {
  const enc = options.credentialEnc ?? (await encryptBytes(KEY, Buffer.from(credentialJson)));
  const syncs: { status: string; error: string | null }[] = [];
  const audits: { action: string }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const inserted: { value: string; revision: number; needsReview: boolean }[] = [];
  const mails: unknown[] = [];
  const keyCalls: string[] = [];
  const upserts: Record<string, unknown>[] = [];

  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM metrics.source_binding")) {
        return {
          rows:
            options.bound === true
              ? [
                  {
                    id: "binding-1",
                    definitionId: CASH,
                    provider: "quickbooks",
                    sourceMetric: "cash",
                    enabled: true,
                    status: "ok",
                    lastSyncAt: null,
                    lastSuccessAt: null,
                    lastError: null,
                    consecutiveFailures: 0,
                    createdAt: NOW,
                    updatedAt: NOW,
                  },
                ]
              : [],
        };
      }
      if (text.includes("FROM metrics.sheet_connection")) {
        if (options.connection === false) return { rows: [] };
        return {
          rows: [
            {
              id: "conn-1",
              spreadsheetId: SPREADSHEET,
              range: "KPIs!A1:B10",
              mapping: MAPPING,
              credentialEnc: Buffer.from(enc),
              encryption: { format: "she1", keyId: "key-1", keyRef: "local" },
              serviceAccountEmail: "kpis@acme.iam.gserviceaccount.com",
              status: "idle",
              enabled: options.enabled ?? true,
              lastSyncAt: null,
              lastError: null,
              consecutiveFailures: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        };
      }
      if (text.includes("INSERT INTO metrics.sheet_connection")) {
        upserts.push({ spreadsheetId: params[1], range: params[2] });
        return {
          rows: [
            {
              id: "conn-1",
              spreadsheetId: params[1],
              range: params[2],
              mapping: MAPPING,
              credentialEnc: Buffer.from(enc),
              encryption: {},
              serviceAccountEmail: params[6],
              status: "idle",
              enabled: true,
              lastSyncAt: null,
              lastError: null,
              consecutiveFailures: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        };
      }
      if (text.includes("UPDATE metrics.sheet_connection SET")) {
        syncs.push({ status: params[0] as string, error: params[1] as string | null });
        return { rows: [] };
      }
      if (text.includes("FROM metrics.definition")) return { rows: [DEFINITION] };
      if (text.includes("FROM metrics.point_current")) {
        return {
          rows: (options.live ?? []).map((p, i) => ({
            id: `live-${i}`,
            definitionId: CASH,
            periodStart: new Date("2026-01-01T00:00:00Z"),
            periodEnd: new Date("2026-02-01T00:00:00Z"),
            value: p.value,
            asOf: NOW,
            sourceId: null,
            sourceKind: options.liveSourceKind ?? "manual",
            revision: 1,
            needsReview: false,
            note: null,
            createdAt: NOW,
          })),
        };
      }
      if (text.includes("INSERT INTO metrics.source")) return { rows: [{ id: "source-1" }] };
      if (text.includes("INSERT INTO metrics.point")) {
        inserted.push({
          value: params[4] as string,
          revision: params[7] as number,
          needsReview: params[8] as boolean,
        });
        return {
          rows: [
            {
              id: `new-${inserted.length}`,
              definitionId: params[1] as string,
              periodStart: params[2] as Date,
              periodEnd: params[3] as Date,
              value: params[4] as string,
              asOf: NOW,
              sourceId: params[6] as string,
              sourceKind: "sheets",
              revision: params[7] as number,
              needsReview: params[8] as boolean,
              note: null,
              createdAt: NOW,
            },
          ],
        };
      }
      if (text.includes("UPDATE metrics.point SET superseded_by")) return { rows: [] };
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
    insert() {
      return { values: () => ({ returning: async () => [{ id: 1 }] }) };
    },
  };

  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    crypto: {
      async currentKey(_tx: unknown, _ctx: unknown, purpose: string) {
        keyCalls.push(purpose);
        return { keyId: "key-1", keyRef: "local", key: KEY, purpose };
      },
      async keyById() {
        return options.keyMissing === true
          ? undefined
          : { keyId: "key-1", keyRef: "local", key: KEY, purpose: SHEETS_KEY_PURPOSE };
      },
    },
    spreadsheets: {
      driver: "fake",
      async read() {
        return (
          options.read ?? {
            ok: true,
            range: {
              rows: [
                ["period", "cash"],
                ["2026-01", "1400"],
              ],
            },
          }
        );
      },
      async healthCheck() {},
    },
    mailer: {
      async send(message: unknown) {
        mails.push(message);
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: { action: string }) {
        audits.push(input);
        return {} as never;
      },
    },
    now: () => NOW,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
  } as unknown as ModuleServices;

  return { services, syncs, audits, logs, inserted, mails, keyCalls, upserts };
}

describe("sheets connection", () => {
  it("refuses a mapping that names a metric a KPI integration feeds (409 source_overlap)", async () => {
    const h = await harness({ bound: true });
    await expect(
      createSheetsService(h.services).put(
        ctx,
        { spreadsheetId: SPREADSHEET, range: "KPIs!A1:B10", mapping: MAPPING, credentialJson },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "source_overlap", keys: ["cash"] },
    });
    expect(h.keyCalls).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("validates what the admin pasted before anything is encrypted", async () => {
    const h = await harness();
    const svc = createSheetsService(h.services);
    const input = { spreadsheetId: SPREADSHEET, range: "KPIs!A1:B10", mapping: MAPPING };

    await expect(
      svc.put(ctx, { ...input, spreadsheetId: "https://docs.google.com/…", credentialJson }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "spreadsheetId" } });
    await expect(
      svc.put(ctx, { ...input, range: "A1:B2:C3!!", credentialJson }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "range" } });
    await expect(
      svc.put(ctx, { ...input, credentialJson: "{not json" }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "credentialJson" } });

    // The decisive assertion: no data key was even asked for, so nothing was stored.
    expect(h.keyCalls).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("stores the credential under the metrics-sheets purpose and returns the address to share with", async () => {
    const h = await harness();
    const row = await createSheetsService(h.services).put(
      ctx,
      {
        spreadsheetId: SPREADSHEET,
        range: "KPIs!A1:B10",
        mapping: MAPPING,
        credentialJson,
      },
      actor,
    );
    expect(h.keyCalls).toEqual([SHEETS_KEY_PURPOSE]);
    expect(row.serviceAccountEmail).toBe("kpis@acme.iam.gserviceaccount.com");
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.sheets_connected"]);
  });
});

describe("sheets sync", () => {
  it("never silently overwrites a figure a person typed", async () => {
    const h = await harness({ live: [{ value: "1250.000000" }], liveSourceKind: "manual" });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome).toMatchObject({ status: "ok", restated: 1, needsReview: 1 });
    expect(h.inserted).toEqual([{ value: "1400.00", revision: 2, needsReview: true }]);
    expect(h.syncs).toEqual([{ status: "ok", error: null }]);
    expect(h.audits.map((a) => a.action)).toEqual([
      "metrics.point_restated",
      "metrics.sheets_synced",
    ]);
  });

  it("does not flag a figure the sheet itself wrote last night", async () => {
    const h = await harness({ live: [{ value: "1250.000000" }], liveSourceKind: "sheets" });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome.needsReview).toBe(0);
    expect(h.inserted[0]?.needsReview).toBe(false);
  });

  it("records a refusal on the connection, warns, and sends no mail", async () => {
    /*
     * There is no admin-alert channel in the product yet (§8), and inventing one here would be
     * E2.6's decision taken in the wrong place. The connection row and the log are the record.
     */
    const h = await harness({
      read: { ok: false, reason: "unauthorized", detail: "share the sheet with the account" },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("unauthorized");
    expect(h.syncs).toEqual([
      { status: "failed", error: "unauthorized: share the sheet with the account" },
    ]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.sheets_sync_failed"]);
    expect(h.logs.find((l) => l.event === "metrics.sheets_sync_failed")?.fields).toMatchObject({
      level: "warn",
    });
    expect(h.mails).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("treats a missing data key as a recorded failure, not an exception", async () => {
    // `updates.sending_domain`'s rule, verbatim: a missing key logs a warning and returns
    // undefined. A throw here would take the whole nightly sweep down with one bad workspace.
    const h = await harness({ keyMissing: true });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome.status).toBe("failed");
    expect(h.logs.some((l) => l.event === "metrics.sheets_key_missing")).toBe(true);
    expect(h.mails).toEqual([]);
  });

  it("a sheet whose numbers are all formatted currency FAILS, and says which cell did it", async () => {
    /*
     * The defect this replaces: `valueRenderOption=FORMATTED_VALUE` handed back the cell **as
     * displayed**, so a founder who formats their MRR column as currency — the common case,
     * and the one a finance lead will always do — got "$12,400", `parseFixed` refused every
     * one of them, the loop dropped them with a bare `continue`, and the connection reported
     * `status: "ok"` with nothing imported and nowhere to see why.
     *
     * The adapter now asks for `UNFORMATTED_VALUE`, so this shape should no longer arrive from
     * Google. It can still arrive from a *text* column, which no render option can fix, and
     * the honest answer is the same either way: not `ok`, and a sentence naming the column and
     * the cell, because that sentence is the whole diagnosis for the person with the sheet.
     */
    const h = await harness({
      read: {
        ok: true,
        range: {
          rows: [
            ["period", "cash"],
            ["2026-01", "$12,400"],
            ["2026-02", "12,900"],
          ],
        },
      },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);

    expect(outcome.status).toBe("failed");
    expect(outcome.unparsed).toBe(2);
    expect(outcome.written).toBe(0);
    expect(outcome.error).toContain("imported nothing");
    expect(outcome.error).toContain("2 of 2 rows unusable");
    expect(outcome.error).toContain("cash");
    expect(outcome.error).toContain("$12,400");
    expect(h.inserted).toEqual([]);
    expect(h.syncs[0]?.status).toBe("failed");
    // The stored sentence is the one the admin screen shows, not a bare reason code.
    expect(h.syncs[0]?.error).toContain("plain number");
    expect(h.mails).toEqual([]);
  });

  it("imports the good numbers when only some cells are unreadable", async () => {
    // One bad cell must not discard nine good ones — the counts carry the rest of the story.
    const h = await harness({
      read: {
        ok: true,
        range: {
          rows: [
            ["period", "cash"],
            ["2026-01", "1400"],
            ["2026-02", "12.5%"],
            ["2026-03", ""],
          ],
        },
      },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome).toMatchObject({ status: "ok", written: 1, unparsed: 1, skipped: 1 });
    expect(h.inserted).toEqual([{ value: "1400.00", revision: 1, needsReview: false }]);
  });

  it("a blank sheet is still ok: nothing to import is not the same as nothing imported", async () => {
    const h = await harness({
      read: {
        ok: true,
        range: {
          rows: [
            ["period", "cash"],
            ["2026-01", ""],
          ],
        },
      },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome).toMatchObject({ status: "ok", written: 0, unparsed: 0, skipped: 1 });
    expect(h.syncs).toEqual([{ status: "ok", error: null }]);
  });

  it("a period column nobody can read is a failure that names the row", async () => {
    // A row that never reaches its cells counts once: it is one thing the admin has to fix.
    const h = await harness({
      read: {
        ok: true,
        range: {
          rows: [
            ["period", "cash"],
            ["last month", "1400"],
          ],
        },
      },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome.status).toBe("failed");
    expect(outcome.unparsed).toBe(1);
    expect(outcome.error).toContain("last month");
    expect(outcome.error).toContain("row 2");
  });

  it("a value with more precision than the definition renders is rounded, not refused", async () => {
    // `UNFORMATTED_VALUE` hands numeric cells back as JSON numbers and the adapter is the one
    // place they become text (pinned there); `parseFixed` is still the only door into a
    // stored value, and a sheet exporting more decimals than the column renders is ordinary.
    const h = await harness({
      read: {
        ok: true,
        range: {
          rows: [
            ["period", "cash"],
            ["2026-01", "1400.505"],
          ],
        },
      },
    });
    const outcome = await createSheetsService(h.services).sync(ctx, actor);
    expect(outcome).toMatchObject({ status: "ok", written: 1 });
    expect(h.inserted).toEqual([{ value: "1400.51", revision: 1, needsReview: false }]);
  });

  it("refuses to sync a connection the admin switched off", async () => {
    // `enabled: false` is how an admin stops the nightly sweep without deleting the
    // credential; a sync that ran anyway would be the switch not being a switch.
    const h = await harness({ enabled: false });
    await expect(createSheetsService(h.services).sync(ctx, actor)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.syncs).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it("refuses to sync a workspace that has no connection", async () => {
    const h = await harness({ connection: false });
    await expect(createSheetsService(h.services).sync(ctx, actor)).rejects.toBeInstanceOf(
      MetricsError,
    );
  });
});
