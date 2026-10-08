import type { TenantContext, Tx } from "@fundroom/db";
import type {
  IntegrationConnectionSummary,
  IntegrationServices,
  ModuleServices,
} from "@fundroom/module-kit";
import type { KpiReadRequest, KpiReadValue, KpiSourceMetric } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import type { DefinitionRow, SourceBindingRow } from "../repos/metrics-repo.js";
import {
  CONFLICT_RETRY,
  createKpiSourcesService,
  DEFERRED,
  HISTORY_TOO_LARGE,
  KPI_BACKFILL_MONTHS,
  KPI_TRAILING_MONTHS,
  kpiSyncKey,
  NOT_CONNECTED,
  planKpiCells,
} from "./kpi-sources.js";

/*
 * KPI sources (E3.6 §5). The pure planner pins the window, `historical: false` and the currency
 * rule; the service harness pins the sync's shape — the vendor read outside any transaction,
 * the 24-then-3-month window, a failed read recorded on the bindings with no mail, and a binding
 * to a non-monthly or formula metric refused with `binding_period_unsupported`.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const actor = { membershipId: "01920000-0000-7000-8000-0000000000b1" };
const REVENUE = "01920000-0000-7000-8000-0000000000a1";
const MRR = "01920000-0000-7000-8000-0000000000a2";
const CONN = "01920000-0000-7000-8000-0000000000c1";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const CATALOGUE: KpiSourceMetric[] = [
  { key: "gross_volume", label: "Gross volume", kind: "flow", unit: "currency", historical: true },
  { key: "new_customers", label: "New customers", kind: "flow", unit: "count", historical: true },
  { key: "mrr", label: "MRR", kind: "stock", unit: "currency", historical: false },
];

function definitionRow(over: Partial<DefinitionRow> & { id: string; key: string }): DefinitionRow {
  return {
    name: over.key,
    description: null,
    unit: "currency",
    currency: "USD",
    aggregation: "sum",
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
    ...over,
  } as DefinitionRow;
}

function bindingRow(over: Partial<SourceBindingRow> & { id: string; definitionId: string }) {
  return {
    provider: "stripe",
    sourceMetric: "gross_volume",
    enabled: true,
    status: "idle",
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as SourceBindingRow;
}

describe("planKpiCells", () => {
  const definitions = new Map([
    [REVENUE, definitionRow({ id: REVENUE, key: "revenue" })],
    [MRR, definitionRow({ id: MRR, key: "mrr" })],
  ]);
  const base = {
    definitions,
    catalogue: CATALOGUE,
    fromMonth: "2026-07",
    toMonth: "2026-09",
    currentMonth: "2026-09",
  };

  it("writes the window's months and skips what falls outside or does not parse", () => {
    const [planned] = planKpiCells({
      ...base,
      bindings: [bindingRow({ id: "b1", definitionId: REVENUE })],
      value: {
        currency: "usd",
        series: [
          {
            metric: "gross_volume",
            points: [
              { month: "2026-06", value: "1" },
              { month: "2026-07", value: "100.50" },
              { month: "2026-08", value: "-20" },
              { month: "2026-09", value: "1e5" },
            ],
          },
        ],
      },
    });
    expect(planned?.error).toBeNull();
    expect(planned?.cells.map((c) => c.period.start.toISOString())).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    expect(planned?.cells.map((c) => c.value)).toEqual([100_500_000n, -20_000_000n]);
    expect(planned?.skipped).toBe(2);
  });

  it("a historical:false series writes only the current month", () => {
    const [planned] = planKpiCells({
      ...base,
      bindings: [bindingRow({ id: "b2", definitionId: MRR, sourceMetric: "mrr" })],
      value: {
        currency: "USD",
        series: [
          {
            metric: "mrr",
            points: [
              { month: "2026-08", value: "900" },
              { month: "2026-09", value: "1000" },
            ],
          },
        ],
      },
    });
    expect(planned?.cells).toHaveLength(1);
    expect(planned?.cells[0]?.period.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(planned?.skipped).toBe(1);
  });

  it("refuses a currency the metric is not kept in, and a unit that does not match", () => {
    const eur = planKpiCells({
      ...base,
      bindings: [bindingRow({ id: "b1", definitionId: REVENUE })],
      value: { currency: "EUR", series: [{ metric: "gross_volume", points: [] }] },
    });
    expect(eur[0]?.error).toMatch(/reports EUR/u);
    expect(eur[0]?.cells).toEqual([]);

    const count = planKpiCells({
      ...base,
      bindings: [bindingRow({ id: "b1", definitionId: REVENUE, sourceMetric: "new_customers" })],
      value: { currency: "USD", series: [{ metric: "new_customers", points: [] }] },
    });
    expect(count[0]?.error).toMatch(/is a count/u);
  });

  it("a missing series, a vanished catalogue key and a no-longer-monthly metric fail the binding", () => {
    const value: KpiReadValue = { currency: "USD", series: [] };
    expect(
      planKpiCells({
        ...base,
        bindings: [bindingRow({ id: "b", definitionId: REVENUE })],
        value,
      })[0]?.error,
    ).toMatch(/returned no `gross_volume` series/u);
    expect(
      planKpiCells({
        ...base,
        bindings: [bindingRow({ id: "b", definitionId: REVENUE, sourceMetric: "arr" })],
        value,
      })[0]?.error,
    ).toMatch(/no longer offers `arr`/u);
    expect(
      planKpiCells({
        ...base,
        definitions: new Map([
          [REVENUE, definitionRow({ id: REVENUE, key: "revenue", periodKind: "quarter" })],
        ]),
        bindings: [bindingRow({ id: "b", definitionId: REVENUE })],
        value,
      })[0]?.error,
    ).toMatch(/only a monthly metric/u);
  });
});

// --- the service, over a fake transaction --------------------------------------------------------

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

interface HarnessOptions {
  readonly lastSuccessAt?: Date | null;
  readonly connected?: boolean;
  readonly read?: Awaited<ReturnType<IntegrationServices["readKpi"]>>;
  readonly definition?: Partial<DefinitionRow>;
  /** Replaces the one default binding (each on its own copy of the definition). */
  readonly bindings?: readonly SourceBindingRow[];
  /** Runs before each vendor read (e.g. advancing a fake clock). */
  readonly beforeRead?: () => void;
  /** Answers each vendor read; default: the canned gross volume. */
  readonly readFn?: (req: KpiReadRequest) => Awaited<ReturnType<IntegrationServices["readKpi"]>>;
  /** Thrown by the point insert (a concurrent writer won the cell). */
  readonly pointInsertError?: Error;
  readonly catalogue?: readonly KpiSourceMetric[];
  /** Definition keys the (fake) Google Sheet mapping writes. */
  readonly sheetKeys?: readonly string[];
}

function harness(options: HarnessOptions = {}) {
  const definition = definitionRow({ id: REVENUE, key: "revenue", ...options.definition });
  const binding = bindingRow({
    id: "01920000-0000-7000-8000-0000000000d1",
    definitionId: REVENUE,
    lastSuccessAt: options.lastSuccessAt ?? null,
  });
  const bindings = options.bindings ?? [binding];
  const definitions = bindings.map((b) => ({ ...definition, id: b.definitionId }));
  const reads: KpiReadRequest[] = [];
  const syncs: {
    status: unknown;
    error: unknown;
    id?: unknown;
    historyFrom?: unknown;
    historyNote?: unknown;
  }[] = [];
  const audits: { action: string; meta?: unknown }[] = [];
  const inserted: { value: unknown; needsReview: unknown }[] = [];
  const mails: unknown[] = [];
  const queued: { name: string; data: unknown; key: string | undefined }[] = [];
  const upserts: unknown[][] = [];
  let inTx = 0;

  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM metrics.sheet_connection")) {
        if (options.sheetKeys === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: "sheet-1",
              mapping: { columns: options.sheetKeys.map((key) => ({ column: key, key })) },
              credentialEnc: Buffer.alloc(0),
              lastSyncAt: null,
              createdAt: NOW,
              updatedAt: NOW,
              consecutiveFailures: 0,
            },
          ],
        };
      }
      if (text.includes("INSERT INTO metrics.source_binding")) {
        upserts.push(params);
        return { rows: [{ ...binding, provider: params[2], sourceMetric: params[3] }] };
      }
      if (text.includes("FOR UPDATE OF b")) {
        return {
          rows: bindings.map((b) => ({ ...b, periodKind: definition.periodKind, derived: false })),
        };
      }
      if (text.includes("FROM metrics.source_binding")) return { rows: [...bindings] };
      if (text.includes("UPDATE metrics.source_binding SET") && !text.includes("last_sync_at")) {
        // recordDeferred: [note, workspace, id, provider, metric]
        syncs.push({ status: "(kept)", error: params[0], id: params[2] });
        return { rows: [] };
      }
      if (text.includes("UPDATE metrics.source_binding SET")) {
        // [status×2, error, status, historyFrom×3, setNote, note, workspace, id, provider, metric]
        syncs.push({
          status: params[0],
          error: params[2],
          id: params[10],
          historyFrom: params[4],
          historyNote: params[7] === true ? params[8] : "(kept)",
        });
        return { rows: [{ id: params[10] }] };
      }
      if (text.includes("FROM metrics.definition")) return { rows: definitions };
      if (text.includes("FROM metrics.point_current")) return { rows: [] };
      if (text.includes("INSERT INTO metrics.source")) return { rows: [{ id: "source-1" }] };
      if (text.includes("INSERT INTO metrics.point")) {
        if (options.pointInsertError !== undefined) throw options.pointInsertError;
        inserted.push({ value: params[4], needsReview: params[8] });
        return {
          rows: [
            {
              id: `new-${inserted.length}`,
              definitionId: params[1],
              periodStart: params[2],
              periodEnd: params[3],
              value: params[4],
              asOf: NOW,
              sourceId: params[6],
              sourceKind: "stripe",
              revision: params[7],
              needsReview: params[8],
              note: null,
              createdAt: NOW,
            },
          ],
        };
      }
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
    insert() {
      return { values: () => ({ returning: async () => [{ id: 1 }] }) };
    },
  };

  const summary: IntegrationConnectionSummary = {
    id: CONN,
    provider: "stripe",
    status: "active",
    accountLabel: "Acme Inc.",
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
  const integrations: IntegrationServices = {
    connection: async () => (options.connected === false ? undefined : summary),
    kpiMetrics: (p) => (p === "stripe" ? (options.catalogue ?? CATALOGUE) : []),
    readKpi: async (_ctx, _provider, req) => {
      // The decisive property: the vendor read never happens inside a transaction.
      expect(inTx).toBe(0);
      options.beforeRead?.();
      reads.push(req);
      if (options.readFn !== undefined) return options.readFn(req);
      return (
        options.read ?? {
          ok: true,
          value: {
            currency: "USD",
            series: [
              {
                metric: "gross_volume",
                points: [
                  { month: "2026-08", value: "1200" },
                  { month: "2026-09", value: "1300" },
                ],
              },
            ],
          },
        }
      );
    },
    slackChannels: async () => ({ ok: false, reason: "not_connected" }),
    slackPost: async () => ({ ok: false, reason: "not_connected" }),
    booking: async () => undefined,
  };

  const services = {
    db: {
      withTenant: async <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => {
        inTx += 1;
        try {
          return await fn(tx as unknown as Tx);
        } finally {
          inTx -= 1;
        }
      },
    },
    integrations,
    queue: {
      async sendInTransaction(
        _tx: unknown,
        name: string,
        data: unknown,
        opts?: { idempotencyKey?: string },
      ) {
        queued.push({ name, data, key: opts?.idempotencyKey });
        return "job-1";
      },
      async send(name: string, data: unknown, opts?: { idempotencyKey?: string }) {
        queued.push({ name, data, key: opts?.idempotencyKey });
        return "job-1";
      },
    },
    mailer: {
      async send(message: unknown) {
        mails.push(message);
      },
    },
    audit: {
      async record(_tx: unknown, _ctx: unknown, input: { action: string; meta?: unknown }) {
        audits.push(input);
        return {} as never;
      },
    },
    now: () => NOW,
    log: () => undefined,
  } as unknown as ModuleServices;

  return {
    svc: createKpiSourcesService(services),
    reads,
    syncs,
    audits,
    inserted,
    mails,
    upserts,
    queued,
  };
}

describe("KPI sync", () => {
  it(`a first sync reads the trailing ${KPI_BACKFILL_MONTHS} months through the current one`, async () => {
    const h = harness();
    const out = await h.svc.sync(ctx);
    expect(h.reads).toEqual([
      { metrics: ["gross_volume"], fromMonth: "2024-10", toMonth: "2026-09" },
    ]);
    expect(out.providers[0]).toMatchObject({ provider: "stripe", status: "ok", written: 2 });
    expect(h.inserted.map((p) => p.value)).toEqual(["1200.00", "1300.00"]);
    expect(h.syncs).toEqual([
      // A full backfill: history from its first written month, and no note.
      {
        status: "ok",
        error: null,
        id: expect.any(String),
        historyFrom: "2026-08",
        historyNote: null,
      },
    ]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.kpi_synced"]);
  });

  it(`a later sync reads the trailing ${KPI_TRAILING_MONTHS}`, async () => {
    const h = harness({ lastSuccessAt: new Date("2026-09-14T04:55:00Z") });
    await h.svc.sync(ctx);
    expect(h.reads[0]).toMatchObject({ fromMonth: "2026-07", toMonth: "2026-09" });
  });

  it("a failed read records the failure on the binding, audits it and sends no mail", async () => {
    const h = harness({ read: { ok: false, reason: "unauthorized", detail: "token revoked" } });
    const out = await h.svc.sync(ctx);
    expect(out.providers[0]).toMatchObject({
      status: "failed",
      error: "unauthorized: token revoked",
    });
    expect(h.syncs).toMatchObject([{ status: "failed", error: "unauthorized: token revoked" }]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.kpi_sync_failed"]);
    expect(h.inserted).toEqual([]);
    expect(h.mails).toEqual([]);
  });

  it("no connection records `not connected` without calling the vendor", async () => {
    const h = harness({ connected: false });
    const out = await h.svc.sync(ctx);
    expect(h.reads).toEqual([]);
    expect(out.providers[0]).toMatchObject({ status: "failed", error: NOT_CONNECTED });
    expect(h.syncs).toMatchObject([{ status: "failed", error: NOT_CONNECTED }]);
  });
});

describe("binding a definition", () => {
  it("refuses a quarterly or a formula metric with binding_period_unsupported", async () => {
    for (const definition of [
      { periodKind: "quarter" as const },
      { formula: { op: "ref", key: "cash" } as unknown as DefinitionRow["formula"] },
    ]) {
      const h = harness({ definition });
      await expect(
        h.svc.putBinding(ctx, REVENUE, { provider: "stripe", sourceMetric: "gross_volume" }, actor),
      ).rejects.toMatchObject({ code: "binding_period_unsupported" });
      expect(h.upserts).toEqual([]);
    }
  });

  it("refuses a series the provider does not offer, and a unit mismatch", async () => {
    const h = harness();
    await expect(
      h.svc.putBinding(ctx, REVENUE, { provider: "stripe", sourceMetric: "arr" }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "sourceMetric" } });
    await expect(
      h.svc.putBinding(ctx, REVENUE, { provider: "stripe", sourceMetric: "new_customers" }, actor),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "sourceMetric" } });
    expect(h.upserts).toEqual([]);
  });

  it("binds a monthly manual metric and audits it", async () => {
    const h = harness();
    const row = await h.svc.putBinding(
      ctx,
      REVENUE,
      { provider: "stripe", sourceMetric: "gross_volume" },
      actor,
    );
    expect(row).toMatchObject({ provider: "stripe", sourceMetric: "gross_volume" });
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.kpi_binding_set"]);
  });
});

describe("per-binding windows (review R2)", () => {
  const OLD = "01920000-0000-7000-8000-0000000000d1";
  const NEW = "01920000-0000-7000-8000-0000000000d2";
  const two = [
    bindingRow({ id: OLD, definitionId: REVENUE, lastSuccessAt: new Date("2026-09-14T04:55:00Z") }),
    bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume" }),
  ];
  const catalogueWithNet: KpiSourceMetric[] = [
    ...CATALOGUE,
    { key: "net_volume", label: "Net volume", kind: "flow", unit: "currency", historical: true },
  ];
  const ok = (req: KpiReadRequest) => ({
    ok: true as const,
    value: {
      currency: "USD",
      series: req.metrics.map((metric) => ({ metric, points: [{ month: "2026-09", value: "1" }] })),
    },
  });

  it("an established binding reads 3 months while a new one backfills 24, in separate reads", async () => {
    const again = harness({ bindings: two, readFn: ok, catalogue: catalogueWithNet });
    const res = await again.svc.sync(ctx);
    expect(again.reads).toEqual([
      { metrics: ["gross_volume"], fromMonth: "2026-07", toMonth: "2026-09" },
      { metrics: ["net_volume"], fromMonth: "2024-10", toMonth: "2026-09" },
    ]);
    expect(res.providers[0]).toMatchObject({ status: "ok", fromMonth: "2024-10", bindings: 2 });
  });

  it("a failing backfill does not drag the established binding down with it", async () => {
    const h = harness({
      bindings: two,
      catalogue: catalogueWithNet,
      readFn: (req) => (req.fromMonth === "2024-10" ? { ok: false, reason: "malformed" } : ok(req)),
    });
    const res = await h.svc.sync(ctx);
    expect(h.syncs).toMatchObject([
      { status: "ok", error: null, id: OLD, historyNote: "(kept)" },
      { status: "failed", error: "malformed", id: NEW },
    ]);
    expect(res.providers[0]).toMatchObject({ status: "ok", failedBindings: 1, error: "malformed" });
  });

  it("a too_large backfill goes straight to 3 months for the group, noted — no per-series 24s", async () => {
    const A = "01920000-0000-7000-8000-0000000000e1";
    const B = "01920000-0000-7000-8000-0000000000e2";
    const h = harness({
      bindings: [
        bindingRow({ id: A, definitionId: REVENUE }),
        bindingRow({ id: B, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      readFn: (req) => (req.fromMonth === "2024-10" ? { ok: false, reason: "too_large" } : ok(req)),
    });
    const res = await h.svc.sync(ctx);
    expect(h.reads.map((r) => [r.metrics.join(","), r.fromMonth])).toEqual([
      ["gross_volume,net_volume", "2024-10"],
      ["gross_volume,net_volume", "2026-07"],
    ]);
    expect(h.syncs).toEqual([
      { status: "ok", error: null, id: A, historyFrom: "2026-09", historyNote: HISTORY_TOO_LARGE },
      { status: "ok", error: null, id: B, historyFrom: "2026-09", historyNote: HISTORY_TOO_LARGE },
    ]);
    expect(res.providers[0]).toMatchObject({ status: "ok", error: HISTORY_TOO_LARGE, written: 2 });
  });

  it("a later 3-month success keeps the truncation note", async () => {
    const h = harness({ lastSuccessAt: new Date("2026-09-14T04:55:00Z") });
    await h.svc.sync(ctx);
    expect(h.syncs).toMatchObject([{ status: "ok", historyNote: "(kept)" }]);
  });

  it("a concurrent writer winning the cell (23505) is a recorded failure, not an exception", async () => {
    const clash = Object.assign(new Error("duplicate key"), { code: "23505" });
    const h = harness({ pointInsertError: clash });
    const res = await h.svc.sync(ctx);
    expect(res.providers[0]).toMatchObject({ status: "failed", error: CONFLICT_RETRY });
    expect(h.syncs).toMatchObject([{ status: "failed", error: CONFLICT_RETRY }]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.kpi_sync_failed"]);
  });

  it("refuses to bind a metric the Google Sheet mapping already feeds (409 source_overlap)", async () => {
    const h = harness({ sheetKeys: ["Revenue"] });
    await expect(
      h.svc.putBinding(ctx, REVENUE, { provider: "stripe", sourceMetric: "gross_volume" }, actor),
    ).rejects.toMatchObject({ code: "conflict", details: { reason: "source_overlap" } });
    expect(h.upserts).toEqual([]);
  });

  it("sync-now only enqueues one job per bound provider, under the nightly key, and audits it", async () => {
    const h = harness({ bindings: two, readFn: ok, catalogue: catalogueWithNet });
    expect(await h.svc.requestSync(ctx, actor)).toEqual(["stripe"]);
    expect(h.reads).toEqual([]);
    expect(h.queued).toEqual([
      {
        name: "metrics.kpi_sync_provider",
        data: { workspaceId: WORKSPACE, provider: "stripe" },
        key: kpiSyncKey(WORKSPACE, "stripe"),
      },
    ]);
    expect(h.audits.map((a) => a.action)).toEqual(["metrics.kpi_sync_requested"]);
  });

  it("a combined read that fails is re-read per series, and one series failing keeps the others", async () => {
    const A = "01920000-0000-7000-8000-0000000000e1";
    const B = "01920000-0000-7000-8000-0000000000e2";
    const h = harness({
      bindings: [
        bindingRow({ id: A, definitionId: REVENUE }),
        bindingRow({ id: B, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      readFn: (req) =>
        req.metrics.length > 1
          ? { ok: false, reason: "malformed", detail: "bad page" }
          : req.metrics[0] === "net_volume"
            ? { ok: false, reason: "malformed" }
            : ok(req),
    });
    const res = await h.svc.sync(ctx);
    expect(h.reads.map((r) => r.metrics.join(","))).toEqual([
      "gross_volume,net_volume",
      "gross_volume",
      "net_volume",
    ]);
    expect(h.syncs).toMatchObject([
      { status: "failed", error: "malformed", id: B },
      { status: "ok", error: null, id: A },
    ]);
    expect(res.providers[0]).toMatchObject({ status: "ok", written: 1, failedBindings: 1 });
  });

  it("a refused credential is not retried per series", async () => {
    const h = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE }),
        bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      readFn: () => ({ ok: false, reason: "unauthorized" }),
    });
    await h.svc.sync(ctx);
    expect(h.reads).toHaveLength(1);
    expect(h.syncs).toMatchObject([
      { status: "failed", error: "unauthorized" },
      { status: "failed", error: "unauthorized" },
    ]);
  });

  it("after the 20-minute budget no new read starts: the rest is deferred, not failed", async () => {
    let now = 0;
    const h = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE }),
        bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      // The backfill read takes 21 minutes and is too large: the 3-month retry would start
      // after the cutoff, so it is not started — deferred, not failed.
      beforeRead: () => {
        now += 21 * 60_000;
      },
      readFn: () => ({ ok: false, reason: "too_large" }),
    });
    const res = await h.svc.syncProvider(ctx, "stripe", { clock: () => now });
    expect(h.reads).toHaveLength(1);
    expect(h.syncs).toEqual([
      { status: "(kept)", error: DEFERRED, id: OLD },
      { status: "(kept)", error: DEFERRED, id: NEW },
    ]);
    expect(res).toMatchObject({ status: "ok", deferredBindings: 2, failedBindings: 0 });
  });

  it("passes the job's abort signal to every vendor read", async () => {
    const signal = new AbortController().signal;
    const h = harness();
    await h.svc.syncProvider(ctx, "stripe", { signal });
    expect(h.reads[0]?.signal).toBe(signal);
  });

  it("an aborted read is deferred, not failed", async () => {
    const h = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE }),
        bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      readFn: () => ({ ok: false, reason: "unavailable", detail: "aborted" }),
    });
    const res = await h.svc.syncProvider(ctx, "stripe");
    expect(h.reads).toHaveLength(1);
    expect(h.syncs).toEqual([
      { status: "(kept)", error: DEFERRED, id: OLD },
      { status: "(kept)", error: DEFERRED, id: NEW },
    ]);
    expect(res).toMatchObject({ deferredBindings: 2, failedBindings: 0 });
  });

  it("rate_limited fails the provider once, without per-series re-reads", async () => {
    const h = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE }),
        bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume" }),
      ],
      catalogue: catalogueWithNet,
      readFn: () => ({ ok: false, reason: "rate_limited" }),
    });
    await h.svc.sync(ctx);
    expect(h.reads).toHaveLength(1);
    expect(h.syncs).toMatchObject([
      { status: "failed", error: "rate_limited" },
      { status: "failed", error: "rate_limited" },
    ]);
  });

  it("bindings deferred last time are read first on the next run", async () => {
    const done = new Date("2026-09-14T04:55:00Z");
    // Series order: net_volume (deferred last time) before gross_volume.
    const h = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE, lastSuccessAt: done }),
        bindingRow({
          id: NEW,
          definitionId: MRR,
          sourceMetric: "net_volume",
          lastSuccessAt: done,
          lastError: DEFERRED,
        }),
      ],
      catalogue: catalogueWithNet,
      readFn: (req) => (req.metrics.length > 1 ? { ok: false, reason: "malformed" } : ok(req)),
    });
    await h.svc.sync(ctx);
    expect(h.reads.map((r) => r.metrics.join(","))).toEqual([
      "net_volume,gross_volume",
      "net_volume",
      "gross_volume",
    ]);
    // And a group holding a deferred binding runs before the other group.
    const g = harness({
      bindings: [
        bindingRow({ id: OLD, definitionId: REVENUE, lastSuccessAt: done }),
        bindingRow({ id: NEW, definitionId: MRR, sourceMetric: "net_volume", lastError: DEFERRED }),
      ],
      catalogue: catalogueWithNet,
      readFn: ok,
    });
    await g.svc.sync(ctx);
    expect(g.reads.map((r) => [r.metrics.join(","), r.fromMonth])).toEqual([
      ["net_volume", "2024-10"],
      ["gross_volume", "2026-07"],
    ]);
  });
});
