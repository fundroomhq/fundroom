import { readFileSync } from "node:fs";
import type { IntegrationAuth, OAuthClient } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createXeroAdapter, xeroMeta, xeroMetrics } from "./index.js";
import { runAdapterContract } from "./test/contract.js";
import {
  fakeFetch,
  formOf,
  type Handler,
  json,
  type RecordedRequest,
  router,
} from "./test/fake-fetch.js";

type Json = Record<string, unknown>;
const fixture = <T = Json>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8")) as T;

const NOW = new Date("2026-04-15T12:00:00Z");
const TENANT = "4f2d7b1e-6a3c-4e8d-9b0a-1c2d3e4f5a6b";
const auth: IntegrationAuth = {
  accessToken: "xero-access",
  externalAccountId: TENANT,
  environment: "production",
};
const client: OAuthClient = {
  clientId: "XEROCLIENT",
  clientSecret: "shh",
  environment: "production",
};
const Q1 = { fromMonth: "2026-01", toMonth: "2026-03" };
const ALL = ["revenue", "expenses", "net_income", "cash"] as const;

const happy: Handler = router({
  "GET /api.xro/2.0/Organisation": () => json(fixture("organisation")),
  "GET /api.xro/2.0/Reports/ProfitAndLoss": () => json(fixture("profit-and-loss")),
  "GET /api.xro/2.0/Reports/BalanceSheet": () => json(fixture("balance-sheet")),
  "GET /connections": () => json(fixture("connections")),
  "POST /connect/token": () => json(fixture("token")),
  "POST /connect/revocation": () => new Response(null, { status: 200 }),
});

function adapter(handler: Handler, now = NOW) {
  const fake = fakeFetch(handler);
  return { fake, adapter: createXeroAdapter({ fetch: fake.fetch, now: () => now }) };
}

runAdapterContract({
  provider: "xero",
  metrics: [
    {
      key: "revenue",
      label: "Revenue (Total Income)",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    {
      key: "expenses",
      label: "Expenses (Total Operating Expenses)",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    {
      key: "net_income",
      label: "Net income (Net Profit)",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    {
      key: "cash",
      label: "Cash (bank accounts, month end)",
      kind: "stock",
      unit: "currency",
      historical: true,
    },
  ],
  create: (fetch, now) => createXeroAdapter({ fetch, now: () => now }),
  auth,
  now: NOW,
  kpiRequest: { metrics: [...ALL], ...Q1 },
  hosts: ["api.xero.com", "identity.xero.com"],
  happy,
});

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Xero's header for a comparison month: the anchor's day number, clamped to the month's length. */
const xeroLabel = (y: number, m: number, anchorDay: number) =>
  `${Math.min(anchorDay, daysIn(y, m))} ${MONTH_NAMES[m - 1]} ${y}`;

/** A report for the request's newest month and `periods` earlier ones, newest first, like Xero. */
function buildReport(
  req: RecordedRequest,
  label: (y: number, m: number, anchorDay: number) => string = xeroLabel,
): Json {
  const kind = req.url.pathname.endsWith("BalanceSheet") ? "BalanceSheet" : "ProfitAndLoss";
  const anchorDate = req.url.searchParams.get(kind === "BalanceSheet" ? "date" : "toDate") ?? "";
  const anchor = anchorDate.slice(0, 7);
  const anchorDay = Number(anchorDate.slice(8, 10));
  const periods = Number(req.url.searchParams.get("periods") ?? "0");
  let [y, m] = anchor.split("-").map(Number) as [number, number];
  const months: [number, number][] = [];
  for (let i = 0; i <= periods; i += 1) {
    months.push([y, m]);
    [y, m] = m === 1 ? [y - 1, 12] : [y, m - 1];
  }
  const cells = (text: string, f: (y: number, m: number) => string) => [
    { Value: text },
    ...months.map(([yy, mm]) => ({ Value: f(yy, mm) })),
  ];
  const header = {
    RowType: "Header",
    Cells: [{ Value: "" }, ...months.map(([yy, mm]) => ({ Value: label(yy, mm, anchorDay) }))],
  };
  const rows =
    kind === "ProfitAndLoss"
      ? [
          header,
          {
            RowType: "Section",
            Title: "Income",
            Rows: [
              { RowType: "SummaryRow", Cells: cells("Total Income", (_y, mm) => `${mm}000.00`) },
            ],
          },
          {
            RowType: "Section",
            Title: "",
            Rows: [{ RowType: "Row", Cells: cells("Net Profit", (_y, mm) => `-${mm}.50`) }],
          },
        ]
      : [
          header,
          {
            RowType: "Section",
            Title: "Bank",
            Rows: [
              {
                RowType: "SummaryRow",
                Cells: cells("Total Bank", (yy, mm) => `${yy}.${String(mm).padStart(2, "0")}`),
              },
            ],
          },
        ];
  return { Reports: [{ ReportType: kind, Rows: rows }] };
}

const dynamic: Handler = (req) =>
  req.url.pathname.endsWith("/Organisation")
    ? json(fixture("organisation"))
    : json(buildReport(req));

describe("xeroMeta", () => {
  it("asks for the granular read-only report scopes with PKCE", () => {
    expect(xeroMeta.oauth).toEqual({
      authorizeUrl: "https://login.xero.com/identity/connect/authorize",
      tokenUrl: "https://identity.xero.com/connect/token",
      revokeUrl: "https://identity.xero.com/connect/revocation",
      scopes: [
        "openid",
        "offline_access",
        "accounting.reports.profitandloss.read",
        "accounting.reports.balancesheet.read",
        "accounting.settings.read",
      ],
      pkce: true,
      scopeSeparator: " ",
    });
    // The broad scopes Xero retired for new apps (2026-03-02) must never be requested.
    expect(xeroMeta.oauth?.scopes).not.toContain("accounting.reports.read");
    expect(xeroMeta.oauth?.scopes).not.toContain("accounting.transactions");
    expect(xeroMetrics.map((m) => m.key)).toEqual(["revenue", "expenses", "net_income", "cash"]);
  });
});

describe("exchangeCode", () => {
  it("exchanges the code (PKCE), lists the organisations and picks this consent's first", async () => {
    const { fake, adapter: xero } = adapter(happy);
    const result = await xero.exchangeCode?.({
      code: "xero-code",
      redirectUri: "https://seed.example/oauth/integrations/callback",
      codeVerifier: "v".repeat(64),
      query: {},
      client,
    });
    const token = fixture<{ access_token: string }>("token");
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: token.access_token,
        refreshToken: "xero-refresh-1",
        expiresAt: new Date(NOW.getTime() + 1800_000),
        scope:
          "openid offline_access accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.settings.read",
        externalAccountId: TENANT,
        extra: {
          accounts: JSON.stringify([
            { id: TENANT, name: "Acme Robotics Ltd" },
            { id: "6b3e2a1d-2222-4c5d-9e6f-7a8b9c0d1e2f", name: "Older Org Pty" },
          ]),
        },
      },
    });
    const [tokenCall, connectionsCall] = fake.calls;
    expect(tokenCall?.url.href).toBe("https://identity.xero.com/connect/token");
    expect(tokenCall?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("XEROCLIENT:shh").toString("base64")}`,
    );
    expect(formOf(tokenCall as RecordedRequest)).toEqual({
      grant_type: "authorization_code",
      code: "xero-code",
      redirect_uri: "https://seed.example/oauth/integrations/callback",
      code_verifier: "v".repeat(64),
    });
    expect(connectionsCall?.url.href).toBe("https://api.xero.com/connections");
    expect(connectionsCall?.headers.get("authorization")).toBe(`Bearer ${token.access_token}`);
    expect(connectionsCall?.headers.get("xero-tenant-id")).toBeNull();
  });

  it("keeps Xero's order when the access token is not a readable JWT", async () => {
    const { adapter: xero } = adapter(
      router({
        "POST /connect/token": () => json({ ...fixture<Json>("token"), access_token: "opaque" }),
        "GET /connections": () => json(fixture("connections")),
      }),
    );
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { externalAccountId: "6b3e2a1d-2222-4c5d-9e6f-7a8b9c0d1e2f" },
    });
  });

  it("drops non-organisation tenants, bad ids and duplicates, and caps the list at 50", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      tenantId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      tenantType: "ORGANISATION",
      tenantName: `Org ${i}`,
    }));
    const odd = [
      { tenantId: "../evil", tenantType: "ORGANISATION" },
      { tenantId: many[0]?.tenantId, tenantType: "ORGANISATION" },
      "x",
      null,
    ];
    const { adapter: xero } = adapter(
      router({
        "POST /connect/token": () => json(fixture("token")),
        "GET /connections": () => json([...many, ...odd]),
      }),
    );
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const accounts = JSON.parse(result.value.extra?.["accounts"] ?? "[]") as { id: string }[];
    expect(accounts).toHaveLength(50);
    expect(new Set(accounts.map((a) => a.id)).size).toBe(50);
  });

  it("answers ok with no account when the grant covers no organisation", async () => {
    const { adapter: xero } = adapter(
      router({
        "POST /connect/token": () => json(fixture("token")),
        "GET /connections": () => json([]),
      }),
    );
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { externalAccountId: null, extra: { accounts: "[]" } },
    });
  });

  it("revokes the fresh grant and fails when the organisations cannot be listed", async () => {
    const { fake, adapter: xero } = adapter(
      router({
        "POST /connect/token": () => json(fixture("token")),
        "GET /connections": () => json({ Title: "Unauthorized" }, 403),
        "POST /connect/revocation": () => new Response(null, { status: 200 }),
      }),
    );
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    const revoke = fake.calls[2];
    expect(revoke?.url.pathname).toBe("/connect/revocation");
    expect(formOf(revoke as RecordedRequest)).toEqual({ token: "xero-refresh-1" });
  });

  it("refuses a grant without a refresh token (offline_access missing)", async () => {
    const { fake, adapter: xero } = adapter(() => json({ access_token: "a", expires_in: 1800 }));
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    [400, { error: "invalid_grant" }, "unauthorized"],
    [400, { error: "invalid_client" }, "unavailable"],
    [400, { error: "unsupported_grant_type" }, "malformed"],
    [429, {}, "rate_limited"],
    [500, {}, "unavailable"],
  ] as const)("maps a token-endpoint %i %j to %s", async (status, body, reason) => {
    const { adapter: xero } = adapter(() => json(body, status));
    const result = await xero.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: {},
      client,
    });
    expect(result).toMatchObject({ ok: false, reason });
  });
});

describe("refresh", () => {
  it("returns the rotated refresh token and no account change", async () => {
    const { fake, adapter: xero } = adapter(() =>
      json({ ...fixture<Json>("token"), refresh_token: "rotated" }),
    );
    const result = await xero.refresh?.({ refreshToken: "old", client });
    expect(result).toMatchObject({
      ok: true,
      value: { refreshToken: "rotated", externalAccountId: null },
    });
    expect(formOf(fake.calls[0] as RecordedRequest)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps the current refresh token when none comes back", async () => {
    const { adapter: xero } = adapter(() =>
      json({ access_token: "a", expires_in: 1800, token_type: "Bearer" }),
    );
    expect(await xero.refresh?.({ refreshToken: "old", client })).toMatchObject({
      ok: true,
      value: { refreshToken: "old" },
    });
  });

  it("maps invalid_grant to unauthorized", async () => {
    const { adapter: xero } = adapter(() => json({ error: "invalid_grant" }, 400));
    expect(await xero.refresh?.({ refreshToken: "old", client })).toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });
});

describe("revoke", () => {
  it("posts the token form-encoded with client authentication; skips without a client; never throws", async () => {
    const ok = adapter(happy);
    await ok.adapter.revoke?.({ token: "refresh", client });
    expect(ok.fake.calls[0]?.url.href).toBe("https://identity.xero.com/connect/revocation");
    expect(formOf(ok.fake.calls[0] as RecordedRequest)).toEqual({ token: "refresh" });
    const none = adapter(happy);
    await none.adapter.revoke?.({ token: "refresh", client: null });
    expect(none.fake.calls).toHaveLength(0);
    const broken = adapter(() => {
      throw new Error("down");
    });
    await expect(broken.adapter.revoke?.({ token: "t", client })).resolves.toBeUndefined();
  });
});

describe("verify", () => {
  it("labels the account with the organisation name and sends xero-tenant-id", async () => {
    const { fake, adapter: xero } = adapter(happy);
    expect(await xero.verify(auth)).toEqual({
      ok: true,
      value: { accountLabel: "Acme Robotics Ltd", externalAccountId: TENANT },
    });
    expect(fake.calls[0]?.headers.get("xero-tenant-id")).toBe(TENANT);
    expect(fake.calls[0]?.url.href).toBe("https://api.xero.com/api.xro/2.0/Organisation");
  });

  it("refuses without a valid tenant id and never sends one that is not a uuid", async () => {
    for (const externalAccountId of [null, "x\r\nevil: 1"]) {
      const { fake, adapter: xero } = adapter(happy);
      expect(await xero.verify({ ...auth, externalAccountId })).toMatchObject({
        ok: false,
        reason: "not_found",
      });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("answers malformed without an organisation, and labels an unnamed one by id", async () => {
    expect(await adapter(() => json({ Organisations: [] })).adapter.verify(auth)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(
      await adapter(() => json({ Organisations: [{ Name: "" }] })).adapter.verify(auth),
    ).toMatchObject({
      ok: true,
      value: { accountLabel: `Xero organisation ${TENANT}` },
    });
  });

  it("names Xero's rate-limit problem, and only a known one", async () => {
    const minute = adapter(() =>
      json({}, 429, { "x-rate-limit-problem": "minute", "retry-after": "20" }),
    );
    expect(await minute.adapter.verify(auth)).toEqual({
      ok: false,
      reason: "rate_limited",
      detail: "Xero Organisation answered HTTP 429 (Xero minute limit)",
    });
    const odd = adapter(() => json({}, 429, { "x-rate-limit-problem": "<script>" }));
    expect(await odd.adapter.verify(auth)).toEqual({
      ok: false,
      reason: "rate_limited",
      detail: "Xero Organisation answered HTTP 429",
    });
  });
});

describe("kpi.read", () => {
  it("reads the recorded reports by label, mapping newest-first columns to months", async () => {
    const { fake, adapter: xero } = adapter(happy);
    const result = await xero.kpi?.read(auth, { metrics: [...ALL], ...Q1 });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: "GBP",
        series: [
          {
            metric: "revenue",
            points: [
              { month: "2026-01", value: "15012.34" },
              { month: "2026-02", value: "18600.50" },
              { month: "2026-03", value: "-250.25" },
            ],
          },
          {
            metric: "expenses",
            points: [
              { month: "2026-01", value: "22500.00" },
              { month: "2026-02", value: "22500.00" },
              { month: "2026-03", value: "23500.00" },
            ],
          },
          {
            metric: "net_income",
            points: [
              { month: "2026-01", value: "-8387.66" },
              { month: "2026-02", value: "-4849.50" },
              { month: "2026-03", value: "-24760.35" },
            ],
          },
          {
            metric: "cash",
            points: [
              { month: "2026-01", value: "350000.00" },
              { month: "2026-02", value: "331260.75" },
              { month: "2026-03", value: "203500.10" },
            ],
          },
        ],
      },
    });
    const [org, pl, bs] = fake.calls;
    expect(org?.url.pathname).toBe("/api.xro/2.0/Organisation");
    expect(Object.fromEntries(pl?.url.searchParams ?? [])).toEqual({
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
      periods: "2",
      timeframe: "MONTH",
      standardLayout: "true",
    });
    expect(Object.fromEntries(bs?.url.searchParams ?? [])).toEqual({
      date: "2026-03-31",
      periods: "2",
      timeframe: "MONTH",
      standardLayout: "true",
    });
    for (const call of fake.calls) expect(call.headers.get("xero-tenant-id")).toBe(TENANT);
  });

  it("pages 24 months as two 12-column reports per kind", async () => {
    const { fake, adapter: xero } = adapter(dynamic);
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue", "net_income", "cash"],
      fromMonth: "2024-04",
      toMonth: "2026-03",
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const [revenue, net, cash] = result.value.series;
    expect(revenue?.points).toHaveLength(24);
    expect(revenue?.points[0]).toEqual({ month: "2024-04", value: "4000.00" });
    expect(revenue?.points[23]).toEqual({ month: "2026-03", value: "3000.00" });
    expect(net?.points[1]).toEqual({ month: "2024-05", value: "-5.50" });
    expect(cash?.points[11]).toEqual({ month: "2025-03", value: "2025.03" });
    const reports = fake.calls
      .slice(1)
      .map(
        (c) =>
          `${c.url.pathname.split("/").pop()} ${c.url.searchParams.get("toDate") ?? c.url.searchParams.get("date")} p${c.url.searchParams.get("periods")}`,
      );
    expect(reports).toEqual([
      "ProfitAndLoss 2026-03-31 p11",
      "ProfitAndLoss 2025-03-31 p11",
      "BalanceSheet 2026-03-31 p11",
      "BalanceSheet 2025-03-31 p11",
    ]);
  });

  it("asks for a single month without periods/timeframe", async () => {
    const { fake, adapter: xero } = adapter(dynamic);
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue"],
      fromMonth: "2026-02",
      toMonth: "2026-02",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ month: "2026-02", value: "2000.00" }] }] },
    });
    expect(fake.calls[1]?.url.searchParams.has("periods")).toBe(false);
    expect(fake.calls[1]?.url.searchParams.has("timeframe")).toBe(false);
  });

  it.each([
    [
      "30 Apr 2026",
      (y: number, m: number) => `${[31, 28, 31, 30][m - 1] ?? 30} ${MONTH_NAMES[m - 1]} ${y}`,
    ],
    ["Apr-26", (y: number, m: number) => `${MONTH_NAMES[m - 1]}-${String(y).slice(2)}`],
    [
      "April 2026",
      (y: number, m: number) => `${["January", "February", "March", "April"][m - 1] ?? "x"} ${y}`,
    ],
  ])("understands %s column headers", async (_name, label) => {
    const { adapter: xero } = adapter((req) =>
      req.url.pathname.endsWith("/Organisation")
        ? json(fixture("organisation"))
        : json(buildReport(req, label)),
    );
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue"],
      fromMonth: "2026-01",
      toMonth: "2026-04",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [
          {
            points: [
              { value: "1000.00" },
              { value: "2000.00" },
              { value: "3000.00" },
              { value: "4000.00" },
            ],
          },
        ],
      },
    });
  });

  it("never trusts unlabelled multi-month columns: re-reads each month alone", async () => {
    const { fake, adapter: xero } = adapter((req) =>
      req.url.pathname.endsWith("/Organisation")
        ? json(fixture("organisation"))
        : json(buildReport(req, () => "Period")),
    );
    const result = await xero.kpi?.read(auth, { metrics: ["revenue"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [{ points: [{ value: "1000.00" }, { value: "2000.00" }, { value: "3000.00" }] }],
      },
    });
    // Organisation, the refused 3-month report, then Jan, Feb and Mar on their own.
    expect(fake.calls.map((c) => c.url.searchParams.get("toDate"))).toEqual([
      null,
      "2026-03-31",
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(fake.calls.slice(2).every((c) => !c.url.searchParams.has("periods"))).toBe(true);
  });

  describe("whole-month columns (Xero derives comparison periods from the anchor's day)", () => {
    const LATE = new Date("2026-10-10T12:00:00Z");
    const org = (req: RecordedRequest) => req.url.pathname.endsWith("/Organisation");
    const shape = (c: RecordedRequest) =>
      `${c.url.pathname.split("/").pop()} ${c.url.searchParams.get("fromDate") ?? "-"}..${c.url.searchParams.get("toDate") ?? c.url.searchParams.get("date")} p${c.url.searchParams.get("periods") ?? 0}`;

    it("anchors multi-month requests only on 31-day months; other months go alone", async () => {
      const { fake, adapter: xero } = adapter(dynamic, LATE);
      const result = await xero.kpi?.read(auth, {
        metrics: ["revenue", "cash"],
        fromMonth: "2026-07",
        toMonth: "2026-09",
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          series: [
            { points: [{ value: "7000.00" }, { value: "8000.00" }, { value: "9000.00" }] },
            { points: [{ value: "2026.07" }, { value: "2026.08" }, { value: "2026.09" }] },
          ],
        },
      });
      expect(fake.calls.slice(1).map(shape)).toEqual([
        "ProfitAndLoss 2026-09-01..2026-09-30 p0",
        "ProfitAndLoss 2026-08-01..2026-08-31 p1",
        "BalanceSheet -..2026-09-30 p0",
        "BalanceSheet -..2026-08-31 p1",
      ]);
    });

    const TRUNCATED = ["30 Sep 2026", "30 Aug 2026", "30 Jul 2026"];
    /** The probe's answer: every multi-month report ends each column on the 30th, values poisoned. */
    const probe = (req: RecordedRequest) => {
      if (org(req)) return json(fixture("organisation"));
      if (!req.url.searchParams.has("periods")) return json(buildReport(req));
      return json(buildReport(req, (_y, m) => TRUNCATED[9 - m] ?? "30 Jun 2026"));
    };

    it("refuses the probe's truncated '30 Sep / 30 Aug / 30 Jul' columns and re-reads each month alone", async () => {
      const truncated = (req: RecordedRequest) => {
        if (org(req)) return json(fixture("organisation"));
        if (!req.url.searchParams.has("periods")) return json(buildReport(req));
        const body = buildReport(req, (_y, m) => TRUNCATED[9 - m] ?? "x");
        return json(JSON.parse(JSON.stringify(body).replace(/"\d+000\.00"/gu, '"999.00"')) as Json);
      };
      const { fake, adapter: xero } = adapter(truncated, LATE);
      const result = await xero.kpi?.read(auth, {
        metrics: ["revenue"],
        fromMonth: "2026-07",
        toMonth: "2026-09",
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          series: [{ points: [{ value: "7000.00" }, { value: "8000.00" }, { value: "9000.00" }] }],
        },
      });
      expect(JSON.stringify(result)).not.toContain("999.00");
      expect(fake.calls.slice(1).map(shape)).toEqual([
        "ProfitAndLoss 2026-09-01..2026-09-30 p0",
        "ProfitAndLoss 2026-08-01..2026-08-31 p1",
        "ProfitAndLoss 2026-07-01..2026-07-31 p0",
        "ProfitAndLoss 2026-08-01..2026-08-31 p0",
      ]);
    });

    it("answers malformed when even a single-month report ends before the month's last day", async () => {
      const always = (req: RecordedRequest) =>
        org(req)
          ? json(fixture("organisation"))
          : json(buildReport(req, (_y, m) => TRUNCATED[9 - m] ?? "x"));
      const { adapter: xero } = adapter(always, LATE);
      const result = await xero.kpi?.read(auth, {
        metrics: ["revenue"],
        fromMonth: "2026-07",
        toMonth: "2026-09",
      });
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
      expect(result?.ok === false && result.detail).toMatch(
        /2026-0[78] does not cover the whole month/u,
      );
    });

    it("refuses a balance sheet 'as at the 30th' for a 31-day month", async () => {
      const { adapter: xero } = adapter(probe, LATE);
      const bs = (req: RecordedRequest) =>
        org(req) ? json(fixture("organisation")) : json(buildReport(req, () => "30 Aug 2026"));
      const { adapter: strict } = adapter(bs, LATE);
      expect(
        await strict.kpi?.read(auth, {
          metrics: ["cash"],
          fromMonth: "2026-08",
          toMonth: "2026-08",
        }),
      ).toMatchObject({
        ok: false,
        reason: "malformed",
      });
      expect(
        await xero.kpi?.read(auth, { metrics: ["cash"], fromMonth: "2026-07", toMonth: "2026-09" }),
      ).toMatchObject({
        ok: true,
        value: {
          series: [{ points: [{ value: "2026.07" }, { value: "2026.08" }, { value: "2026.09" }] }],
        },
      });
    });

    it("keeps a clamped February (28th) but re-reads a January cut to the 28th", async () => {
      // Cumulative derivation: 31 Mar → 28 Feb → 28 Jan.
      let day = 31;
      const cumulative = (req: RecordedRequest) => {
        if (org(req)) return json(fixture("organisation"));
        day = 31;
        return json(
          buildReport(req, (y, m, anchorDay) => {
            day = Math.min(req.url.searchParams.has("periods") ? day : anchorDay, daysIn(y, m));
            return `${day} ${MONTH_NAMES[m - 1]} ${y}`;
          }),
        );
      };
      const { fake, adapter: xero } = adapter(cumulative);
      const result = await xero.kpi?.read(auth, { metrics: ["revenue"], ...Q1 });
      expect(result).toMatchObject({
        ok: true,
        value: {
          series: [{ points: [{ value: "1000.00" }, { value: "2000.00" }, { value: "3000.00" }] }],
        },
      });
      expect(fake.calls.slice(1).map(shape)).toEqual([
        "ProfitAndLoss 2026-03-01..2026-03-31 p2",
        "ProfitAndLoss 2026-01-01..2026-01-31 p0",
      ]);
    });

    it("answers too_large naming the month when re-reads would pass the call cap", async () => {
      const everything = (req: RecordedRequest) =>
        org(req)
          ? json(fixture("organisation"))
          : json(
              buildReport(
                req,
                req.url.searchParams.has("periods") ? () => "1 Jan 2000" : xeroLabel,
              ),
            );
      const { fake, adapter: xero } = adapter(everything);
      const result = await xero.kpi?.read(auth, {
        metrics: ["revenue", "cash"],
        fromMonth: "2024-04",
        toMonth: "2026-03",
      });
      expect(result).toMatchObject({ ok: false, reason: "too_large" });
      expect(result?.ok === false && result.detail).toMatch(/\d{4}-\d{2}/u);
      expect(fake.calls.length).toBeLessThanOrEqual(50);
    });
  });

  it("reads an empty organisation (header and empty sections only) as zeros", async () => {
    const { adapter: xero } = adapter((req) =>
      json(
        req.url.pathname.endsWith("/Organisation")
          ? fixture("organisation")
          : fixture("profit-and-loss-empty"),
      ),
    );
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue", "expenses", "net_income"],
      ...Q1,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [0, 1, 2].map(() => ({ points: [{ value: "0" }, { value: "0" }, { value: "0" }] })),
      },
    });
  });

  it("reads a missing Bank section as zero cash", async () => {
    const bs = fixture("balance-sheet");
    const report = (bs["Reports"] as Json[])[0] as { Rows: Json[] };
    report.Rows = report.Rows.filter((r) => r["Title"] !== "Bank");
    const { adapter: xero } = adapter((req) =>
      json(req.url.pathname.endsWith("/Organisation") ? fixture("organisation") : bs),
    );
    const result = await xero.kpi?.read(auth, { metrics: ["cash"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "0" }, { value: "0" }, { value: "0" }] }] },
    });
  });

  it("negates a 'Net Loss' line and keeps a signed 'Net Profit'", async () => {
    const pl = fixture("profit-and-loss");
    const rows = (
      (pl["Reports"] as Json[])[0] as { Rows: { Rows?: { Cells: { Value: string }[] }[] }[] }
    ).Rows;
    const net = rows[5]?.Rows?.[0];
    if (net === undefined) throw new Error("fixture changed");
    net.Cells = [
      { Value: "Net Loss" },
      { Value: "24760.35" },
      { Value: "4849.50" },
      { Value: "8387.66" },
    ];
    const { adapter: xero } = adapter((req) =>
      json(req.url.pathname.endsWith("/Organisation") ? fixture("organisation") : pl),
    );
    const result = await xero.kpi?.read(auth, { metrics: ["net_income"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [
          { points: [{ value: "-8387.66" }, { value: "-4849.50" }, { value: "-24760.35" }] },
        ],
      },
    });
  });

  const plWith = (f: (report: { Rows: Json[] }) => void) => {
    const pl = fixture("profit-and-loss");
    f((pl["Reports"] as Json[])[0] as { Rows: Json[] });
    return pl;
  };

  it.each([
    ["no Reports", { Status: "OK" }],
    ["Reports[0].Rows not a list", { Reports: [{ Rows: {} }] }],
    ["no Header row", plWith((r) => (r.Rows = r.Rows.filter((x) => x["RowType"] !== "Header")))],
    ["no Net Profit line", plWith((r) => (r.Rows = r.Rows.slice(0, 5)))],
    ["a section whose Rows is not a list", plWith((r) => ((r.Rows[1] as Json)["Rows"] = "x"))],
    [
      "a row without Cells",
      plWith((r) => ((r.Rows[1] as { Rows: Json[] }).Rows[0] = { RowType: "Row" })),
    ],
    [
      "an exponent value",
      plWith(
        (r) =>
          (((r.Rows[1] as { Rows: { Cells: Json[] }[] }).Rows[2]?.Cells[3] as Json)["Value"] =
            "1.5E4"),
      ),
    ],
    [
      "a missing month column",
      plWith((r) => ((r.Rows[0] as { Cells: Json[] }).Cells[2] = { Value: "Dec 2025" })),
    ],
    [
      "too few unlabelled columns",
      plWith((r) => ((r.Rows[0] as { Cells: Json[] }).Cells = [{ Value: "" }, { Value: "x" }])),
    ],
  ])("answers malformed for %s", async (_name, body) => {
    const { adapter: xero } = adapter((req) =>
      json(req.url.pathname.endsWith("/Organisation") ? fixture("organisation") : body),
    );
    const result = await xero.kpi?.read(auth, { metrics: ["revenue", "net_income"], ...Q1 });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("answers too_large before calling Xero when the range needs more than 50 calls", async () => {
    const { fake, adapter: xero } = adapter(dynamic, new Date("2060-01-01T00:00:00Z"));
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2026-01",
      toMonth: "2050-12",
    });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(fake.calls).toHaveLength(0);
  });

  it("answers an empty series for a future range without calling Xero", async () => {
    const { fake, adapter: xero } = adapter(dynamic);
    const result = await xero.kpi?.read(auth, {
      metrics: ["cash"],
      fromMonth: "2026-06",
      toMonth: "2026-08",
    });
    expect(result).toEqual({
      ok: true,
      value: { currency: null, series: [{ metric: "cash", points: [] }] },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("stops between report pages when the signal aborts", async () => {
    const controller = new AbortController();
    let n = 0;
    const { fake, adapter: xero } = adapter((req) => {
      n += 1;
      if (n === 2) controller.abort();
      return dynamic(req);
    });
    const result = await xero.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2024-04",
      toMonth: "2026-03",
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "aborted" });
    // Organisation, then the first report; the second report is never sent.
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) expect(call.signal).toBe(controller.signal);
  });

  it("refuses without a tenant", async () => {
    const { fake, adapter: xero } = adapter(happy);
    expect(
      await xero.kpi?.read({ ...auth, externalAccountId: null }, { metrics: ["revenue"], ...Q1 }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.calls).toHaveLength(0);
  });
});
