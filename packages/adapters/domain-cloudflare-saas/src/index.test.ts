import type { OutboundFetch } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_BUDGET_KEY,
  CLOUDFLARE_CALL_BUDGET,
  CLOUDFLARE_DEFAULT_RETRY_AFTER_MS,
  CLOUDFLARE_INTERACTIVE_BUDGET,
  CLOUDFLARE_INTERACTIVE_BUDGET_KEY,
  CLOUDFLARE_WORKSPACE_BUDGET,
  CloudflareApiError,
  cloudflareWorkspaceBudgetKey,
  createCloudflareSaasProvider,
  mapCustomHostname,
  parseRetryAfter,
} from "./index.js";

/*
 * A fake Cloudflare custom-hostnames API: an in-memory zone behind the same routes and envelope
 * the real one uses (e310-vendors §2), so the adapter is exercised through its HTTP surface.
 */

const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const BASE = "https://cf.test/client/v4";
const TOKEN = "cf-token-secret-value";
const HOST = "ir.acme.test";

interface Row {
  id: string;
  hostname: string;
  status: string;
  ssl: {
    status: string;
    method: string;
    validation_records?: { txt_name?: string; txt_value?: string }[];
    validation_errors?: { message: string }[];
  };
  ownership_verification?: { type: string; name: string; value: string };
  verification_errors?: string[];
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function envelope(
  result: unknown,
  status = 200,
  errors: { code: number; message: string }[] = [],
  resultInfo?: { page: number; per_page: number; total_pages: number; total_count: number },
) {
  return new Response(
    JSON.stringify({
      success: errors.length === 0,
      errors,
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * `filter`: how the fake's list honours the search. `exact` is Cloudflare's `hostname.exact`;
 * `ignored` returns the whole zone, paged — what the adapter must survive if the filter ever
 * stopped applying.
 */
function fakeCloudflare(options: { filter?: "exact" | "ignored" } = {}) {
  const rows = new Map<string, Row>();
  const calls: Call[] = [];
  /** Responses to return before the fake's own behaviour (429s, error envelopes…). */
  const queued: Response[] = [];
  let seq = 0;
  const fetch: OutboundFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url: url.toString(), body, auth: headers.get("authorization") });
    const next = queued.shift();
    if (next !== undefined) return next;
    const prefix = `/client/v4/zones/${ZONE}/custom_hostnames`;
    if (!url.pathname.startsWith(prefix))
      return envelope(null, 404, [{ code: 7003, message: "No route" }]);
    const rest = url.pathname.slice(prefix.length);
    if (method === "POST" && rest === "") {
      const b = body as { hostname: string; ssl: { method: string } };
      if ([...rows.values()].some((r) => r.hostname === b.hostname)) {
        return envelope(null, 409, [{ code: 1406, message: "Duplicate custom hostname found." }]);
      }
      seq++;
      const row: Row = {
        id: `ch-${seq}`,
        hostname: b.hostname,
        status: "pending",
        ssl: {
          status: "pending_validation",
          method: b.ssl.method,
          validation_records: [{ txt_name: `_acme-challenge.${b.hostname}`, txt_value: "dcv-1" }],
        },
        ownership_verification: {
          type: "txt",
          name: `_cf-custom-hostname.${b.hostname}`,
          value: "own-1",
        },
      };
      rows.set(row.id, row);
      return envelope(row, 201);
    }
    if (method === "GET" && rest === "") {
      const want = url.searchParams.get("hostname.exact");
      const all = [...rows.values()].filter(
        (r) => options.filter === "ignored" || want === null || r.hostname === want,
      );
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const page = Number(url.searchParams.get("page") ?? "1");
      return envelope(all.slice((page - 1) * perPage, page * perPage), 200, [], {
        page,
        per_page: perPage,
        total_count: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
      });
    }
    if (method === "GET" && rest.startsWith("/")) {
      const row = rows.get(decodeURIComponent(rest.slice(1)));
      return row === undefined
        ? envelope(null, 404, [{ code: 1436, message: "Custom hostname not found" }])
        : envelope(row);
    }
    if (method === "DELETE" && rest.startsWith("/")) {
      const id = decodeURIComponent(rest.slice(1));
      if (!rows.delete(id)) return envelope(null, 404, [{ code: 1436, message: "Not found" }]);
      return envelope({ id });
    }
    return envelope(null, 400, [{ code: 1400, message: "Bad request" }]);
  };
  return { fetch, rows, calls, queued };
}

function provider(
  fetch: OutboundFetch,
  now: () => Date = () => new Date("2026-09-27T12:00:00Z"),
  rateLimiter?: Parameters<typeof createCloudflareSaasProvider>[0]["rateLimiter"],
) {
  return createCloudflareSaasProvider({
    fetch,
    apiBase: `${BASE}/`,
    apiToken: TOKEN,
    zoneId: ZONE,
    cnameTarget: "customers.fundroom.test",
    now,
    rateLimiter,
  });
}

describe("createCloudflareSaasProvider", () => {
  it("shows our two records under the current challenge label only (A-2)", () => {
    // It used to spell `_seedhost-challenge` out by hand instead of using the constant, which is
    // how a rename leaves one provider telling customers to publish the old record.
    const records = provider(fakeCloudflare().fetch).instructions({ hostname: HOST, token: "tok" });
    expect(records).toEqual([
      { type: "CNAME", name: HOST, value: "customers.fundroom.test", required: true },
      { type: "TXT", name: `_fundroom-challenge.${HOST}`, value: "tok", required: true },
    ]);
    expect(JSON.stringify(records)).not.toContain("_seedhost-challenge");
  });

  it("creates the custom hostname with http DV and returns Cloudflare's TXT records as optional", async () => {
    const cf = fakeCloudflare();
    const out = await provider(cf.fetch).activate(HOST);
    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/zones/${ZONE}/custom_hostnames`,
      auth: `Bearer ${TOKEN}`,
      body: { hostname: HOST, ssl: { method: "http", type: "dv" } },
    });
    expect(out).toEqual({
      records: [
        { type: "TXT", name: `_cf-custom-hostname.${HOST}`, value: "own-1", required: false },
        { type: "TXT", name: `_acme-challenge.${HOST}`, value: "dcv-1", required: false },
      ],
      // Cloudflare's id, for the caller to store and address the hostname by.
      ref: "ch-1",
    });
  });

  it("is idempotent: a duplicate (409 / 1406) adopts the existing hostname", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    await p.activate(HOST);
    // A decoy that a `contains` filter also returns: only the exact name may be adopted.
    cf.rows.set("decoy", {
      id: "decoy",
      hostname: `x${HOST}`,
      status: "active",
      ssl: { status: "active", method: "http" },
    });
    const again = await p.activate(HOST);
    expect(cf.calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
    expect(new URL(cf.calls[2]?.url ?? "").searchParams.get("hostname.exact")).toBe(HOST);
    expect(again).toEqual({
      records: expect.arrayContaining([expect.objectContaining({ value: "own-1" })]),
      ref: "ch-1",
    });
    expect(cf.rows.size).toBe(2);
  });

  it("a search pages through result_info and adopts only the exact name", async () => {
    // The filter ignored: 120 other hostnames ahead of ours, 50 per page.
    const cf = fakeCloudflare({ filter: "ignored" });
    for (let i = 0; i < 120; i++) {
      cf.rows.set(`other-${i}`, {
        id: `other-${i}`,
        hostname: `x${i}${HOST}`,
        status: "active",
        ssl: { status: "active", method: "http" },
      });
    }
    cf.rows.set("mine", {
      id: "mine",
      hostname: HOST,
      status: "pending",
      ssl: { status: "pending_validation", method: "http" },
    });
    const out = await provider(cf.fetch).status(HOST);
    expect(out).toMatchObject({ state: "pending", ref: "mine" });
    expect(cf.calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("status and deactivate with a ref address the hostname by id — no search", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    const { ref } = (await p.activate(HOST)) as { ref: string };
    const status = await p.status(HOST, ref);
    expect(status).toMatchObject({ state: "pending", ref });
    expect(cf.calls.at(-1)).toMatchObject({
      method: "GET",
      url: `${BASE}/zones/${ZONE}/custom_hostnames/${ref}`,
    });
    await p.deactivate(HOST, ref);
    expect(cf.calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(cf.rows.size).toBe(0);
    // By id, Cloudflare's 404 is its own answer: the hostname is gone.
    const gone = await p.status(HOST, ref);
    expect(gone.state).toBe("failed");
    // …and deleting it again is done, not an error.
    await expect(p.deactivate(HOST, ref)).resolves.toBeUndefined();
  });

  it("surfaces a validation error envelope as a CloudflareApiError without the token", async () => {
    const cf = fakeCloudflare();
    cf.queued.push(
      envelope(null, 400, [
        {
          code: 1432,
          message:
            "The validation method is not supported. Only `http`, `email`, or `txt` are accepted.",
        },
      ]),
    );
    const error = await provider(cf.fetch)
      .activate(HOST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    const e = error as CloudflareApiError;
    expect(e.status).toBe(400);
    expect(e.codes).toEqual([1432]);
    expect(e.message).toMatch(/1432 The validation method is not supported/u);
    expect(e.message).not.toContain(TOKEN);
    expect(e.rateLimited).toBe(false);
  });

  it("treats success:false inside a 200 as a failure", async () => {
    const cf = fakeCloudflare();
    cf.queued.push(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "nope" }] }), {
        status: 200,
      }),
    );
    await expect(provider(cf.fetch).status(HOST)).rejects.toThrow(/1000 nope/u);
  });

  it("on 429 honours retry-after with a breaker that fails fast without calling the API", async () => {
    const cf = fakeCloudflare();
    let now = new Date("2026-09-27T12:00:00Z");
    const p = provider(cf.fetch, () => now);
    cf.queued.push(new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const first = (await p.status(HOST).catch((e: unknown) => e)) as CloudflareApiError;
    expect(first).toBeInstanceOf(CloudflareApiError);
    expect(first.rateLimited).toBe(true);
    expect(first.retryAfterMs).toBe(30_000);
    expect(cf.calls).toHaveLength(1);

    // Inside the window: refused locally, no request made.
    now = new Date(now.getTime() + 10_000);
    const second = (await p.activate(HOST).catch((e: unknown) => e)) as CloudflareApiError;
    expect(second.rateLimited).toBe(true);
    expect(second.retryAfterMs).toBe(20_000);
    expect(cf.calls).toHaveLength(1);

    // After it: calls go through again.
    now = new Date(now.getTime() + 20_001);
    await p.activate(HOST);
    expect(cf.calls).toHaveLength(2);
  });

  it("on 429 without retry-after blocks for Cloudflare's five minutes", async () => {
    const cf = fakeCloudflare();
    cf.queued.push(new Response("", { status: 429 }));
    const e = (await provider(cf.fetch)
      .status(HOST)
      .catch((x: unknown) => x)) as CloudflareApiError;
    expect(e.retryAfterMs).toBe(CLOUDFLARE_DEFAULT_RETRY_AFTER_MS);
  });

  it("status walks pending → active as Cloudflare validates, then stops showing records", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    await p.activate(HOST);
    const row = [...cf.rows.values()][0] as Row;

    const pending = await p.status(HOST);
    expect(pending.state).toBe("pending");
    expect(pending.detail).toMatch(/hostname pending, certificate pending validation/u);
    expect(pending.records).toHaveLength(2);

    row.status = "active";
    row.verification_errors = [];
    const halfway = await p.status(HOST);
    expect(halfway.state).toBe("pending");
    // Ownership is done; only the certificate record is still worth showing.
    expect(halfway.records.map((r) => r.name)).toEqual([`_acme-challenge.${HOST}`]);

    row.ssl.status = "active";
    expect(await p.status(HOST)).toEqual({
      state: "active",
      detail: null,
      records: [],
      ref: "ch-1",
    });
  });

  it("a search that finds nothing is unknown (throws), never failed", async () => {
    const cf = fakeCloudflare();
    const error = await provider(cf.fetch)
      .status(HOST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).message).toMatch(/did not list/u);
  });

  it("every request draws on the install-wide budget; over it nothing is sent", async () => {
    const cf = fakeCloudflare();
    const hits: { key: string; rule: unknown }[] = [];
    let allowed = true;
    const p = provider(cf.fetch, undefined, {
      hit: (key, rule) => {
        hits.push({ key, rule });
        return Promise.resolve({ allowed, remaining: 0, retryAfterMs: allowed ? 0 : 42_000 });
      },
    });
    await p.activate(HOST);
    expect(hits).toEqual([{ key: CLOUDFLARE_BUDGET_KEY, rule: CLOUDFLARE_CALL_BUDGET }]);
    allowed = false;
    const e = (await p.status(HOST, "ch-1").catch((x: unknown) => x)) as CloudflareApiError;
    expect(e).toBeInstanceOf(CloudflareApiError);
    expect(e.rateLimited).toBe(true);
    expect(e.retryAfterMs).toBe(42_000);
    expect(cf.calls).toHaveLength(1);
  });

  it("without a shared limiter the budget is an in-process window of the same size", async () => {
    const cf = fakeCloudflare();
    let now = new Date("2026-09-27T12:00:00Z");
    const p = provider(cf.fetch, () => now);
    const { ref } = (await p.activate(HOST)) as { ref: string };
    for (let i = 1; i < CLOUDFLARE_CALL_BUDGET.max; i++) await p.status(HOST, ref);
    expect(cf.calls).toHaveLength(CLOUDFLARE_CALL_BUDGET.max);
    const e = (await p.status(HOST, ref).catch((x: unknown) => x)) as CloudflareApiError;
    expect(e.rateLimited).toBe(true);
    expect(cf.calls).toHaveLength(CLOUDFLARE_CALL_BUDGET.max);
    now = new Date(now.getTime() + CLOUDFLARE_CALL_BUDGET.windowMs);
    await p.status(HOST, ref);
    expect(cf.calls).toHaveLength(CLOUDFLARE_CALL_BUDGET.max + 1);
  });

  it("a workspace's calls draw on its own 60 / 5 min before the install's (FR3)", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    const { ref } = (await p.activate(HOST)) as { ref: string };
    const a = { workspaceId: "ws-a", priority: "background" as const };
    for (let i = 0; i < CLOUDFLARE_WORKSPACE_BUDGET.max; i++) await p.status(HOST, ref, a);
    const calls = cf.calls.length;
    const e = (await p.status(HOST, ref, a).catch((x: unknown) => x)) as CloudflareApiError;
    expect(e.rateLimited).toBe(true);
    expect(e.message).toMatch(/this workspace's/u);
    expect(cf.calls).toHaveLength(calls);
    // Another workspace is unaffected.
    await p.status(HOST, ref, { workspaceId: "ws-b" });
    expect(cf.calls).toHaveLength(calls + 1);
  });

  it("interactive calls stop at 600, leaving the rest of the 900 to the background sweep (FR3)", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    const { ref } = (await p.activate(HOST)) as { ref: string };
    for (let i = 0; i < CLOUDFLARE_INTERACTIVE_BUDGET.max; i++) {
      await p.status(HOST, ref, { priority: "interactive" });
    }
    const refused = (await p
      .status(HOST, ref, { priority: "interactive" })
      .catch((x: unknown) => x)) as CloudflareApiError;
    expect(refused.rateLimited).toBe(true);
    expect(refused.message).toMatch(/interactive/u);
    // The sweep still gets its reserve.
    await p.status(HOST, ref, { priority: "background" });
    await p.status(HOST, ref);
    // activate + 600 interactive + 2 background.
    expect(cf.calls).toHaveLength(1 + CLOUDFLARE_INTERACTIVE_BUDGET.max + 2);
  });

  it("checks the buckets innermost first, and admit pays for exactly one later call (FR3)", async () => {
    const cf = fakeCloudflare();
    const keys: string[] = [];
    const p = provider(cf.fetch, undefined, {
      hit: (key) => {
        keys.push(key);
        return Promise.resolve({ allowed: true, remaining: 1, retryAfterMs: 0 });
      },
    });
    await p.activate(HOST, { workspaceId: "ws-a", priority: "interactive" });
    expect(keys).toEqual([
      cloudflareWorkspaceBudgetKey("ws-a"),
      CLOUDFLARE_INTERACTIVE_BUDGET_KEY,
      CLOUDFLARE_BUDGET_KEY,
    ]);
    keys.length = 0;
    const context = { workspaceId: "ws-a", priority: "background" as const };
    await p.admit?.(context);
    expect(keys).toEqual([cloudflareWorkspaceBudgetKey("ws-a"), CLOUDFLARE_BUDGET_KEY]);
    keys.length = 0;
    // The prepaid DELETE: no draw at all (the caller holds a transaction the limiter must not
    // wait behind)…
    await p.deactivate(HOST, "ch-1", { ...context, admitted: true });
    expect(keys).toEqual([]);
    expect(cf.calls.at(-1)?.method).toBe("DELETE");
    // …but only that one: a search it has to make first is charged as usual.
    await p.activate(HOST);
    keys.length = 0;
    await p.deactivate(HOST, undefined, { ...context, admitted: true });
    expect(cf.calls.slice(-2).map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(keys).toEqual([cloudflareWorkspaceBudgetKey("ws-a"), CLOUDFLARE_BUDGET_KEY]);
  });

  it("deactivate deletes by id, and a missing hostname or a 404 is success", async () => {
    const cf = fakeCloudflare();
    const p = provider(cf.fetch);
    await p.activate(HOST);
    await p.deactivate(HOST);
    expect(cf.rows.size).toBe(0);
    expect(cf.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${BASE}/zones/${ZONE}/custom_hostnames/ch-1`,
    });
    // Nothing there any more: a lookup, no DELETE.
    await p.deactivate(HOST);
    expect(cf.calls.at(-1)?.method).toBe("GET");
    // Found, but gone by the time the DELETE lands.
    await p.activate(HOST);
    cf.queued.push(
      envelope([{ id: "ch-2", hostname: HOST, status: "pending", ssl: { status: "x" } }], 200, [], {
        page: 1,
        per_page: 50,
        total_count: 1,
        total_pages: 1,
      }),
      envelope(null, 404, [{ code: 1436, message: "Not found" }]),
    );
    await expect(p.deactivate(HOST)).resolves.toBeUndefined();
  });

  it("deactivate still throws a real failure", async () => {
    const cf = fakeCloudflare();
    cf.queued.push(envelope(null, 403, [{ code: 1404, message: "forbidden" }]));
    await expect(provider(cf.fetch).deactivate(HOST)).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe("mapCustomHostname", () => {
  const row = (status: string, ssl: string) => ({
    id: "1",
    hostname: HOST,
    status,
    ssl: { status: ssl },
  });
  it.each([
    ["moved", "active"],
    ["deleted", "active"],
    ["blocked", "pending_validation"],
    ["pending_blocked", "initializing"],
    ["active", "validation_timed_out"],
    ["active", "expired"],
  ])("%s / %s is failed", (status, ssl) => {
    const out = mapCustomHostname(row(status, ssl));
    expect(out.state).toBe("failed");
    expect(out.detail).not.toBeNull();
  });
  it.each([
    ["active", "active", "active"],
    ["active_redeploying", "active", "active"],
    ["pending", "active", "pending"],
    ["active", "pending_deployment", "pending"],
    ["pending", "initializing", "pending"],
  ])("%s / %s is %s", (status, ssl, state) => {
    expect(mapCustomHostname(row(status, ssl)).state).toBe(state);
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sun, 27 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});
