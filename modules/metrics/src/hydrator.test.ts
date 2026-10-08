import type { TenantContext, Tx } from "@fundroom/db";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createMetricGridHydrator,
  definitionIdsOf,
  MAX_BLOCK_METRICS,
  type MetricGridHydrated,
  SPARKLINE_PERIODS,
} from "./hydrator.js";
import { resolveChartToken } from "./tokens.js";

/*
 * The `metric_grid` block. The assertion that matters is the negative one: an id the viewer may
 * not see is **dropped, not reported**. No count, no placeholder, nothing an investor could
 * read as "there is a number here you are not allowed to see".
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const tenant: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const OPEN = "01920000-0000-7000-8000-0000000000a1";
const CLOSED = "01920000-0000-7000-8000-0000000000a2";
const GROUPED = "01920000-0000-7000-8000-0000000000a3";
const CHURN = "01920000-0000-7000-8000-0000000000a4";
const GROUP = "01920000-0000-7000-8000-0000000000c1";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const CHART_KEY = new Uint8Array(32).fill(3);
const WORKSPACE_ROW = {
  id: WORKSPACE,
  slug: "acme",
  name: "Acme",
  primaryHost: null,
  settings: {},
  offeringStatus: "reg_d_506b",
};

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

const definition = (over: Record<string, unknown>) => ({
  id: OPEN,
  key: "cash",
  name: "Cash",
  description: null,
  unit: "currency",
  currency: "USD",
  aggregation: "last",
  direction: "up_good",
  periodKind: "month",
  decimals: 0,
  formula: null,
  display: {},
  audience: { kind: "all" },
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...over,
});

const DEFINITIONS = [
  definition({}),
  definition({ id: CLOSED, key: "secret", name: "Secret", audience: { kind: "staff_only" } }),
  definition({
    id: GROUPED,
    key: "board_only",
    name: "Board only",
    audience: { kind: "groups", groupIds: [GROUP] },
  }),
  // Published to everyone, and measured in something a dollar axis cannot express.
  definition({
    id: CHURN,
    key: "churn",
    name: "Churn",
    unit: "percent",
    currency: null,
    decimals: 1,
  }),
];

const point = (definitionId: string, periodStart: string, value: string) => ({
  id: `p-${definitionId}-${periodStart}`,
  definitionId,
  periodStart: new Date(periodStart),
  periodEnd: new Date(periodStart),
  value,
  asOf: new Date(periodStart),
  sourceId: null,
  sourceKind: "manual",
  revision: 1,
  needsReview: false,
  note: null,
  createdAt: new Date(periodStart),
});

function harness(points: readonly ReturnType<typeof point>[], now: Date = NOW) {
  const logs: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      if (text.includes("FROM metrics.definition")) return { rows: DEFINITIONS };
      if (text.includes("FROM metrics.point_current")) return { rows: points };
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  /*
   * `findWorkspaceById` runs a real drizzle query in host context; the chain is faked down to
   * the rows it awaits, so the hydrator's own call path runs and only `packages/db`'s SQL —
   * which has its own tests — is stood in for.
   */
  const hostTx = {
    select: () => hostTx,
    from: () => hostTx,
    where: () => hostTx,
    limit: async () => [WORKSPACE_ROW],
  };
  return {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
      withHost: <T>(fn: (tx: unknown) => Promise<T>) => fn(hostTx),
    },
    crypto: {
      async currentKey(_tx: unknown, _ctx: unknown, purpose: string) {
        return { keyId: "key-a", keyRef: "local", key: CHART_KEY, purpose };
      },
    },
    workspaceUrl: (_ws: unknown, path: string) => new URL(path, "https://acme.example.com"),
    now: () => now,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
    // The array travels on the services object so a test can read it without a second seam.
    __logs: logs,
  } as unknown as ModuleServices;
}

const logsOf = (services: ModuleServices) =>
  (services as unknown as { __logs: { event: string; fields?: Record<string, unknown> }[] }).__logs;

const viewerCtx = (
  kind: "anonymous" | "external" | "staff",
  groupIds: string[] = [],
  medium?: "web" | "email",
  asOf?: Date,
): BlockHydrationContext =>
  ({
    tenant,
    viewer: { kind, groupIds },
    facts: {},
    ...(medium === undefined ? {} : { medium }),
    ...(asOf === undefined ? {} : { asOf }),
  }) as unknown as BlockHydrationContext;

const hydrate = (services: ModuleServices, data: JsonObject, ctx: BlockHydrationContext) =>
  createMetricGridHydrator(services).hydrate(data, ctx) as unknown as Promise<MetricGridHydrated>;

describe("definitionIdsOf", () => {
  it("reads the editor's list and ignores anything that is not a string", () => {
    expect(definitionIdsOf({ definitionIds: [OPEN, 7, null, CLOSED] } as JsonObject)).toEqual([
      OPEN,
      CLOSED,
    ]);
    expect(definitionIdsOf({} as JsonObject)).toEqual([]);
    expect(definitionIdsOf({ definitionIds: "nope" } as JsonObject)).toEqual([]);
  });

  it("reports what the block asked for, cap or no cap", () => {
    // The cap belongs to the hydrator, which can say something when it bites; silently
    // truncating here left a page quietly missing tiles with nowhere for anyone to find out.
    const many = Array.from({ length: 30 }, () => OPEN);
    expect(definitionIdsOf({ definitionIds: many } as JsonObject)).toHaveLength(30);
  });
});

describe("a block larger than the cap", () => {
  it("renders the first 24 and says so where an operator can read it", async () => {
    /*
     * These are metrics the viewer may see and the editor put on the page, and they vanish
     * from it with no tile and no count — the payload cannot say so without becoming the
     * "there is something here you cannot see" signal §10 forbids. So it is said in the log.
     */
    const services = harness([]);
    const payload = await hydrate(
      services,
      { definitionIds: Array.from({ length: 30 }, () => OPEN) } as JsonObject,
      viewerCtx("staff"),
    );
    expect(payload.metrics).toHaveLength(MAX_BLOCK_METRICS);
    expect(logsOf(services).map((l) => l.event)).toEqual(["metrics.block_truncated"]);
    expect(logsOf(services)[0]?.fields).toMatchObject({
      level: "warn",
      asked: 30,
      rendered: MAX_BLOCK_METRICS,
    });
  });

  it("says nothing for a block that fits", async () => {
    const services = harness([]);
    await hydrate(services, { definitionIds: [OPEN, CLOSED] } as JsonObject, viewerCtx("staff"));
    expect(logsOf(services)).toEqual([]);
  });
});

describe("metric_grid hydration", () => {
  const points = [
    point(OPEN, "2026-01-01T00:00:00Z", "1000.000000"),
    point(OPEN, "2026-03-01T00:00:00Z", "1200.000000"),
    point(CLOSED, "2026-03-01T00:00:00Z", "99.000000"),
    point(GROUPED, "2026-03-01T00:00:00Z", "42.000000"),
  ];

  it("drops the ids the viewer may not see, and says nothing about them", async () => {
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN, CLOSED, GROUPED] } as JsonObject,
      viewerCtx("external"),
    );
    expect(payload.metrics.map((m) => m.id)).toEqual([OPEN]);
    // Nothing anywhere in the payload counts, names or hints at the two that were dropped.
    expect(JSON.stringify(payload)).not.toContain(CLOSED);
    expect(JSON.stringify(payload)).not.toContain("Secret");
    expect(Object.keys(payload).sort()).toEqual(["chart", "columns", "metrics"]);
  });

  it("admits a groups metric to a member of that group and to nobody else", async () => {
    const inGroup = await hydrate(
      harness(points),
      { definitionIds: [GROUPED] } as JsonObject,
      viewerCtx("external", [GROUP]),
    );
    expect(inGroup.metrics.map((m) => m.id)).toEqual([GROUPED]);
    const outOfGroup = await hydrate(
      harness(points),
      { definitionIds: [GROUPED] } as JsonObject,
      viewerCtx("external", ["01920000-0000-7000-8000-0000000000c9"]),
    );
    expect(outOfGroup.metrics).toEqual([]);
  });

  it("shows an anonymous reader only what is published to everyone", async () => {
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN, CLOSED, GROUPED] } as JsonObject,
      viewerCtx("anonymous"),
    );
    expect(payload.metrics.map((m) => m.id)).toEqual([OPEN]);
  });

  it("shows staff everything the block names", async () => {
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN, CLOSED, GROUPED] } as JsonObject,
      viewerCtx("staff"),
    );
    expect(payload.metrics.map((m) => m.id)).toEqual([OPEN, CLOSED, GROUPED]);
  });

  it("carries values as decimal strings and gaps as null", async () => {
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN] } as JsonObject,
      viewerCtx("staff"),
    );
    const tile = payload.metrics[0];
    expect(tile?.sparkline).toHaveLength(12);
    // Twelve months to March 2026; January and March have figures, February does not.
    expect(tile?.sparkline.slice(-3)).toEqual(["1000", null, "1200"]);
    expect(tile?.latest).toEqual({ periodKey: "2026-03", periodLabel: "Mar 2026", value: "1200" });
    // `previous` skips the gap: it is the last period that actually had a number.
    expect(tile?.previous).toEqual({ periodKey: "2026-01", value: "1000" });
  });

  it("names the period of every sparkline column, aligned index for index", async () => {
    /*
     * Without this the sparkline is a row of numbers with nothing saying when: `latest` names
     * the period of the latest *value*, not the last column, so an accessible table could only
     * label by position ("3 periods ago"). The email's plain-text table wants the same labels.
     */
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN] } as JsonObject,
      viewerCtx("staff"),
    );
    const tile = payload.metrics[0];
    expect(tile?.periods).toHaveLength(tile?.sparkline.length as number);
    expect(tile?.periods.at(-1)).toEqual({ key: "2026-03", label: "Mar 2026" });
    expect(tile?.periods[0]).toEqual({ key: "2025-04", label: "Apr 2025" });
    // The last column is the newest, and `latest` points into it when it has a value.
    expect(tile?.latest?.periodKey).toBe(tile?.periods.at(-1)?.key);
  });

  it("keeps the author out of the investor-facing payload", async () => {
    // `createdBy` lives on `MetricPoint`, behind `metrics.read`. A tile is rendered for an
    // investor, so no name may reach it.
    const payload = await hydrate(
      harness(points),
      { definitionIds: [OPEN] } as JsonObject,
      viewerCtx("external"),
    );
    expect(JSON.stringify(payload)).not.toContain("createdBy");
    expect(JSON.stringify(payload)).not.toContain("displayName");
  });

  it("reports no latest for a metric with no points rather than a zero", async () => {
    const payload = await hydrate(
      harness([]),
      { definitionIds: [OPEN] } as JsonObject,
      viewerCtx("staff"),
    );
    expect(payload.metrics[0]).toMatchObject({ latest: null, previous: null });
    expect(payload.metrics[0]?.sparkline.every((v) => v === null)).toBe(true);
  });

  it("keeps the editor's order and clamps the column count", async () => {
    const services = harness(points);
    expect(
      (
        await hydrate(services, { definitionIds: [CLOSED, OPEN] } as JsonObject, viewerCtx("staff"))
      ).metrics.map((m) => m.id),
    ).toEqual([CLOSED, OPEN]);
    expect(
      (await hydrate(services, { columns: 9 } as JsonObject, viewerCtx("staff"))).columns,
    ).toBe(4);
    expect(
      (await hydrate(services, { columns: 0 } as JsonObject, viewerCtx("staff"))).columns,
    ).toBe(1);
  });
});

/*
 * The emailed chart. `medium` is the whole gate: a chart token is a capability that works for
 * 180 days, and a 180-day capability belongs in the mail it rides in and nowhere else — a web
 * API response is protected only by a session, and those bytes outlive it.
 */
describe("metric_grid chart", () => {
  const points = [
    point(OPEN, "2026-01-01T00:00:00Z", "1000.000000"),
    point(OPEN, "2026-03-01T00:00:00Z", "1200.000000"),
    point(CLOSED, "2026-03-01T00:00:00Z", "99.000000"),
    point(GROUPED, "2026-03-01T00:00:00Z", "42.000000"),
  ];
  const block = { definitionIds: [OPEN, CLOSED, GROUPED] } as JsonObject;

  /** Reads the token back out of the minted URL. */
  const tokenOf = (url: string) => {
    const last = new URL(url).pathname.split("/").pop() as string;
    return last.slice(0, -".png".length);
  };

  it("mints a chart for email and none for the web", async () => {
    const services = harness(points);
    const email = await hydrate(services, block, viewerCtx("staff", [], "email"));
    expect(email.chart).not.toBeNull();
    expect(email.chart?.url).toMatch(/^https:\/\/acme\.example\.com\/api\/v1\/metrics\/chart\//u);
    expect(email.chart).toMatchObject({ width: 600, height: 300 });

    const web = await hydrate(services, block, viewerCtx("staff", [], "web"));
    expect(web.chart).toBeNull();
  });

  it("treats an absent medium as the web, because the safe default is not to mint", async () => {
    // Every caller that has not opted in gets no capability in its response.
    const payload = await hydrate(harness(points), block, viewerCtx("staff"));
    expect(payload.chart).toBeNull();
  });

  it("mints a URL that actually opens: the token verifies under the workspace's key", async () => {
    // A URL that does not open is worse than no URL — the reader sees a broken image and has
    // no way to tell it from a number the company declined to publish.
    const payload = await hydrate(harness(points), block, viewerCtx("staff", [], "email"));
    const resolved = await resolveChartToken(
      tokenOf(payload.chart?.url as string),
      NOW,
      async (kid) => (kid === "key-a" ? { key: CHART_KEY } : undefined),
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.payload).toMatchObject({
      v: 1,
      w: WORKSPACE,
      kid: "key-a",
      k: "month",
      n: SPARKLINE_PERIODS,
    });
    // 180 days out, and asserted true at the instant the mail was sent.
    expect(resolved.ok && resolved.payload.asOf).toBe(NOW.toISOString());
    expect(resolved.ok && Date.parse(resolved.payload.exp) - NOW.getTime()).toBe(180 * 86_400_000);
  });

  it("carries the layout's own sentence as alt text", async () => {
    // The only copy of the numbers for a reader whose client blocks images.
    const payload = await hydrate(harness(points), block, viewerCtx("staff", [], "email"));
    const alt = payload.chart?.alt as string;
    expect(alt.length).toBeGreaterThan(0);
    expect(alt).toContain("Cash");
  });

  it("charts only the metrics the viewer's audience admitted", async () => {
    /*
     * The gating property. `d` is drawn from the same filtered set the tiles came from, so the
     * capability cannot widen what the reader may see — a token naming a metric the hydrator
     * dropped would hand an investor a picture of a number the founder chose not to show them.
     */
    const payload = await hydrate(harness(points), block, viewerCtx("external"));
    expect(payload.metrics.map((m) => m.id)).toEqual([OPEN]);
    const emailed = await hydrate(harness(points), block, viewerCtx("external", [], "email"));
    const resolved = await resolveChartToken(
      tokenOf(emailed.chart?.url as string),
      NOW,
      async () => ({ key: CHART_KEY }),
    );
    expect(resolved.ok && resolved.payload.d).toEqual([OPEN]);
    expect(resolved.ok && resolved.payload.d).not.toContain(CLOSED);
    expect(resolved.ok && resolved.payload.d).not.toContain(GROUPED);
    // And the URL itself, which is what actually travels, names none of them.
    expect(emailed.chart?.url).not.toContain(CLOSED);
  });

  it("charts only the metrics that share the first one's unit", async () => {
    /*
     * One chart has one y axis, and `buildChartSpec` formats every tick with the **first**
     * series' unit and currency — so a percentage drawn beside a currency came out on an axis
     * reading `0.0%`, `500k%`, `1.0M%` against dollars. `chart.ts` claimed the send path
     * already prevented this; it filtered on `periodKind` alone. Churn keeps its tile and
     * its own numbers; it is simply not on this picture.
     */
    const withChurn = [...points, point(CHURN, "2026-03-01T00:00:00Z", "3.000000")];
    const payload = await hydrate(
      harness(withChurn),
      { definitionIds: [OPEN, CHURN] } as JsonObject,
      viewerCtx("staff", [], "email"),
    );
    expect(payload.metrics.map((m) => m.id)).toEqual([OPEN, CHURN]);
    const resolved = await resolveChartToken(
      tokenOf(payload.chart?.url as string),
      NOW,
      async () => ({ key: CHART_KEY }),
    );
    expect(resolved.ok && resolved.payload.d).toEqual([OPEN]);
    // And the sentence that stands in for the picture describes that same picture: it names
    // the metric the axis belongs to, and not the one that was left off it.
    expect(payload.chart?.alt).toContain("Cash");
    expect(payload.chart?.alt).not.toContain("Churn");
  });

  it("is a function of the send's instant, not of the clock, so a retry is identical", async () => {
    /*
     * Decision D5: everyone in a send who sees the same metrics shares one URL, or the image
     * is a tracking pixel. `modules/updates` re-enqueues a stalled send (`retryLimit: 5`), so
     * a hydrator stamped from `now()` hands two recipients **in the same audience** two
     * different `<img src>` — the recipient list partitioned into retry cohorts.
     */
    const sentAt = new Date("2026-03-15T12:00:00.000Z");
    const first = await hydrate(
      harness(points, sentAt),
      block,
      viewerCtx("staff", [], "email", sentAt),
    );
    // The retry: minutes later, a different process, a clock that has moved on.
    const retry = await hydrate(
      harness(points, new Date("2026-03-15T12:07:31.000Z")),
      block,
      viewerCtx("staff", [], "email", sentAt),
    );
    expect(retry.chart?.url).toBe(first.chart?.url);
    expect(retry.chart?.alt).toBe(first.chart?.alt);
    // The numbers too: the columns are derived from the same instant, so a send that spans
    // midnight — or a month boundary — does not shift the sparkline under half the list.
    expect(JSON.stringify(retry.metrics)).toBe(JSON.stringify(first.metrics));
    const resolved = await resolveChartToken(
      tokenOf(retry.chart?.url as string),
      NOW,
      async () => ({ key: CHART_KEY }),
    );
    expect(resolved.ok && resolved.payload.asOf).toBe(sentAt.toISOString());
  });

  it("falls back to the clock when the caller names no instant", async () => {
    // Every caller that has not opted in keeps exactly the meaning it had.
    const payload = await hydrate(harness(points), block, viewerCtx("staff", [], "email"));
    const resolved = await resolveChartToken(
      tokenOf(payload.chart?.url as string),
      NOW,
      async () => ({ key: CHART_KEY }),
    );
    expect(resolved.ok && resolved.payload.asOf).toBe(NOW.toISOString());
  });

  it("mints nothing when the block has no chartable metric", async () => {
    const empty = await hydrate(
      harness([]),
      { definitionIds: [] } as JsonObject,
      viewerCtx("staff", [], "email"),
    );
    expect(empty.chart).toBeNull();
  });
});
