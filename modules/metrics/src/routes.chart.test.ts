import { createHash } from "node:crypto";
import { ApiError, createApi, errorResponse, isApiError } from "@fundroom/contracts";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { registerMetricsRoutes } from "./routes.js";
import { type ChartTokenPayload, signChartToken } from "./tokens.js";

/*
 * `GET /metrics/chart/{token}.png` on the wire.
 *
 * Two properties are pinned here and nowhere else. The first is the **indistinguishable 404**:
 * a forgery, an expired token, a token naming a rotated-away key and a token for another
 * workspace must all produce byte-identical answers, because the route is public and a
 * distinguishable failure is an oracle — E2.2 shipped exactly that bug on the handoff route
 * (`unknown_key` vs `bad_signature`) and had to collapse the two. The second is that a token
 * minted under a key the workspace has since rotated away from **still renders**, which is the
 * whole reason `kid` is in the payload.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const OTHER_WORKSPACE = "01920000-0000-7000-8000-000000000002";
const CASH = "01920000-0000-7000-8000-0000000000a1";
const CHURN = "01920000-0000-7000-8000-0000000000a2";
const NOW = new Date("2026-09-19T10:00:00.000Z");

/** The key that signed the outstanding tokens; the workspace has since rotated to `key-b`. */
const RETIRED = new Uint8Array(32).fill(7);
const CURRENT = new Uint8Array(32).fill(9);

const payload: ChartTokenPayload = {
  v: 1,
  w: WORKSPACE,
  kid: "key-a",
  d: [CASH],
  k: "month",
  n: 3,
  asOf: "2026-09-18T09:00:00.000Z",
  exp: "2027-03-17T09:00:00.000Z",
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
  decimals: 0,
  formula: null,
  display: {},
  audience: { kind: "staff_only" },
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

/**
 * Sorts **before** `Cash` in `DefinitionRepo.byIds`, which is `ORDER BY sort_order, key` — the
 * editor's order, which has nothing to do with the order the block (and therefore the `alt`
 * text already sitting in somebody's inbox) put them in.
 */
const CHURN_DEFINITION = {
  ...DEFINITION,
  id: CHURN,
  key: "churn",
  name: "Churn",
  unit: "percent",
  currency: null,
  decimals: 1,
  sortOrder: -1,
};

const POINT = {
  id: "p-1",
  definitionId: CASH,
  periodStart: new Date("2026-09-01T00:00:00Z"),
  periodEnd: new Date("2026-10-01T00:00:00Z"),
  value: "1200.000000",
  asOf: NOW,
  sourceId: null,
  sourceKind: "manual",
  revision: 1,
  needsReview: false,
  note: null,
  createdAt: NOW,
};

function app(
  options: {
    readonly keys?: Record<string, { key: Uint8Array; purpose: string }> | undefined;
    /** In the order the repository would return them, not the order the token names. */
    readonly definitions?: readonly Record<string, unknown>[] | undefined;
    readonly points?: readonly Record<string, unknown>[] | undefined;
    /** The instant the route runs at; a year later is how an `exp` is actually reached. */
    readonly now?: Date | undefined;
  } = {},
) {
  const logs: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const renders: Record<string, unknown>[] = [];
  const drawn: { op: string; text?: string }[][] = [];
  const keyring = options.keys ?? {
    "key-a": { key: RETIRED, purpose: "metrics-chart" },
    "key-b": { key: CURRENT, purpose: "metrics-chart" },
  };
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      if (text.includes("FROM metrics.definition")) {
        return { rows: options.definitions ?? [DEFINITION] };
      }
      if (text.includes("DISTINCT ON") || text.includes("FROM metrics.point")) {
        return { rows: options.points ?? [POINT] };
      }
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  const noopMiddleware = async (_c: unknown, next: () => Promise<void>) => {
    await next();
  };
  const services = {
    db: {
      withTenant: <T>(_ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    },
    crypto: {
      async keyById(_tx: unknown, _ctx: unknown, kid: string) {
        const found = keyring[kid];
        return found === undefined ? undefined : { keyId: kid, keyRef: "local", ...found };
      },
    },
    renderer: {
      driver: "fake",
      async renderVector(ops: readonly unknown[], options: Record<string, unknown>) {
        renders.push(options);
        drawn.push(ops as { op: string; text?: string }[]);
        return {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, ops.length & 0xff]),
          width: 600,
          height: 300,
          contentType: "image/png" as const,
        };
      },
    },
    guards: { requirePermission: () => noopMiddleware, requireMember: () => noopMiddleware },
    rateLimiter: {
      async hit() {
        return { allowed: true };
      },
    },
    audit: {
      async record() {
        return {} as never;
      },
    },
    now: () => options.now ?? NOW,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
  } as unknown as ModuleServices;

  const api = createApi<ModuleEnv>();
  api.use("*", async (c, next) => {
    c.set("workspace", { id: WORKSPACE, slug: "acme", settings: {} } as never);
    await next();
  });
  registerMetricsRoutes(api as unknown as ModuleRouter, services);
  api.onError((error, c) =>
    isApiError(error) ? errorResponse(c, error) : errorResponse(c, new ApiError("internal_error")),
  );
  return { api, logs, renders, drawn };
}

/** Every string the renderer was asked to draw, in drawing order. */
const textsOf = (a: ReturnType<typeof app>): string[] =>
  (a.drawn[0] ?? []).flatMap((o) => (o.op === "text" && o.text !== undefined ? [o.text] : []));

const get = (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) =>
  a.api.request(path, { headers });

describe("GET /chart/{token}.png", () => {
  it("renders a token minted under a key the workspace has since rotated away from", async () => {
    // `key-b` is current; this token names `key-a`. Without `kid` in the payload this is a 404
    // for every chart image in every update ever sent.
    const a = app();
    const res = await get(a, `/chart/${signChartToken(RETIRED, payload)}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("rasterises at twice the declared CSS size, for retina mail clients", async () => {
    // The email declares 600 × 300 CSS pixels and clamps them to its 536 px body column, so a
    // 1× bitmap is soft on every phone an investor reads mail on. The geometry is unchanged:
    // `scale` multiplies device pixels, not the layout.
    const a = app();
    await get(a, `/chart/${signChartToken(RETIRED, payload)}.png`);
    expect(a.renders).toEqual([{ width: 600, height: 300, scale: 2 }]);
  });

  it("answers 304 from the token alone, before anything is rendered", async () => {
    const a = app();
    const url = `/chart/${signChartToken(RETIRED, payload)}.png`;
    const etag = (await get(a, url)).headers.get("etag") as string;
    const before = a.renders.length;
    const res = await get(a, url, { "if-none-match": etag });
    expect(res.status).toBe(304);
    // Nothing was rasterised for the 304: the ETag hashes the token, which is immutable.
    expect(a.renders).toHaveLength(before);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });

  it("answers every refusal with one indistinguishable 404", async () => {
    const a = app();
    const expired = signChartToken(RETIRED, { ...payload, exp: "2026-09-19T09:59:59.000Z" });
    const wrongWorkspace = signChartToken(RETIRED, { ...payload, w: OTHER_WORKSPACE });
    const rotatedAway = signChartToken(RETIRED, { ...payload, kid: "key-gone" });
    const forged = signChartToken(CURRENT, payload);
    const responses = await Promise.all(
      [
        `/chart/${signChartToken(RETIRED, payload)}.jpg`,
        "/chart/not-a-token.png",
        `/chart/${rotatedAway}.png`,
        `/chart/${forged}.png`,
        `/chart/${expired}.png`,
        `/chart/${wrongWorkspace}.png`,
      ].map((p) => get(a, p)),
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    // Byte-identical, so nothing about which check failed leaks to a caller who is guessing.
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ error: { code: "not_found" } });
  });

  it("verifies before it answers 304, or `exp` never takes effect for a cached copy", async () => {
    /*
     * The ETag hashes the token, so a matching `If-None-Match` used to answer 304 *before*
     * `resolveChartToken` ran — and an expired token, a forgery, a token for another workspace
     * and the literal string `zzz` all revalidated successfully, for ever. With
     * `Cache-Control: public` that is an image proxy re-serving a chart past its 180-day `exp`
     * indefinitely, while §9.1 says an email read a year later gets a 404.
     */
    const good = signChartToken(RETIRED, payload);
    const fresh = app();
    const etag = (await get(fresh, `/chart/${good}.png`)).headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/u);

    // The real flow: the proxy cached this image while the token was live and comes back to
    // revalidate it after the 180 days are up. §9.1 — an email read a year later gets a 404.
    const later = app({ now: new Date("2027-09-19T10:00:00.000Z") });
    const revalidated = await get(later, `/chart/${good}.png`, { "if-none-match": etag });
    expect(revalidated.status).toBe(404);
    expect(later.renders).toEqual([]);

    /*
     * And the forged cases, where the caller does not need a cached copy at all: the ETag is
     * `sha256(token)`, so anyone can compute the one that "matches" whatever they send. Before
     * the reorder that made a forgery, a wrong-workspace token and the literal string `zzz`
     * revalidate successfully against a route they can never get a 200 out of.
     */
    const etagOf = (t: string) => `"${createHash("sha256").update(t).digest("hex").slice(0, 32)}"`;
    const a = app();
    const forged = signChartToken(CURRENT, payload);
    const wrongWorkspace = signChartToken(RETIRED, { ...payload, w: OTHER_WORKSPACE });
    for (const token of [forged, wrongWorkspace, "zzz"]) {
      const res = await get(a, `/chart/${token}.png`, { "if-none-match": etagOf(token) });
      expect({ token, status: res.status }).toEqual({ token, status: 404 });
    }
    expect(a.renders).toEqual([]);

    // The property the 304 exists for is untouched: a *valid* token with a matching ETag still
    // answers 304, and still rasterises nothing.
    const notModified = await get(a, `/chart/${good}.png`, { "if-none-match": etag });
    expect(notModified.status).toBe(304);
    expect(a.renders).toEqual([]);
  });

  it("draws the series in the token's order, so the email's alt describes this picture", async () => {
    /*
     * `alt` is built by the hydrator from the block's own order and travels in the mail;
     * `buildChartSpec` takes the y axis's unit, currency and decimals from the **first**
     * entry. The route resolved `payload.d` through `DefinitionRepo.byIds`, which is
     * `ORDER BY sort_order, key`, so a block ordered [Cash (USD), Churn (percent)] whose churn
     * row sorts first produced an `alt` reading "Cash: $1.2M … Churn: 3%" against an axis
     * labelled `0.0%`, `500k%`, `1.0M%`. The token already carries the order the sentence was
     * written for, so that is the order that is drawn.
     */
    const a = app({
      // The repository's order, which is the one that used to win.
      definitions: [CHURN_DEFINITION, DEFINITION],
      points: [POINT, { ...POINT, id: "p-2", definitionId: CHURN, value: "3.000000" }],
    });
    const res = await get(
      a,
      `/chart/${signChartToken(RETIRED, { ...payload, d: [CASH, CHURN] })}.png`,
    );
    expect(res.status).toBe(200);

    const texts = textsOf(a);
    // Legend order is series order is `d` order.
    expect(texts.indexOf("Cash")).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf("Cash")).toBeLessThan(texts.indexOf("Churn"));
    // And the y axis is in the first-named metric's unit, which is the unit its `alt` quotes.
    const ticks = texts.filter((t) => /^-?\$/u.test(t));
    expect(ticks.length).toBeGreaterThan(0);
    expect(texts.some((t) => t.endsWith("%"))).toBe(false);
  });

  it("keeps the real reason where only an operator can read it", async () => {
    const a = app();
    await get(a, `/chart/${signChartToken(RETIRED, { ...payload, kid: "key-gone" })}.png`);
    await get(a, `/chart/${signChartToken(CURRENT, payload)}.png`);
    expect(
      a.logs.filter((l) => l.event === "metrics.chart_refused").map((l) => l.fields?.["reason"]),
    ).toEqual(["unknown_key", "bad_signature"]);
  });

  it("refuses a key minted for another purpose as simply absent", async () => {
    // A workspace's unsubscribe key must not verify a chart token.
    const a = app({ keys: { "key-a": { key: RETIRED, purpose: "updates-unsubscribe" } } });
    const res = await get(a, `/chart/${signChartToken(RETIRED, payload)}.png`);
    expect(res.status).toBe(404);
    expect(a.logs.at(-1)?.fields?.["reason"]).toBe("unknown_key");
  });
});
