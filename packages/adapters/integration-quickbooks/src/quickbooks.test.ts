import { readFileSync } from "node:fs";
import type { IntegrationAuth, OAuthClient } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createQuickbooksAdapter, quickbooksMeta, quickbooksMetrics } from "./index.js";
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
const fixture = (name: string): Json =>
  JSON.parse(
    readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Json;

const NOW = new Date("2026-04-15T12:00:00Z");
const REALM = "9130357766900456";
const auth: IntegrationAuth = {
  accessToken: "qbo-access",
  externalAccountId: REALM,
  environment: "production",
};
const client: OAuthClient = {
  clientId: "ABclient",
  clientSecret: "shh",
  environment: "production",
};

const REPORT_BASE = `/v3/company/${REALM}/reports`;
const happy: Handler = router({
  [`GET /v3/company/${REALM}/companyinfo/${REALM}`]: () => json(fixture("company-info")),
  [`GET ${REPORT_BASE}/ProfitAndLoss`]: () => json(fixture("profit-and-loss")),
  [`GET ${REPORT_BASE}/BalanceSheet`]: () => json(fixture("balance-sheet")),
});

function adapter(handler: Handler, now = NOW) {
  const fake = fakeFetch(handler);
  return { fake, adapter: createQuickbooksAdapter({ fetch: fake.fetch, now: () => now }) };
}

const Q1 = { fromMonth: "2026-01", toMonth: "2026-03" };
const ALL = ["revenue", "expenses", "net_income", "cash"] as const;

runAdapterContract({
  provider: "quickbooks",
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
      label: "Expenses (Total Expenses)",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    { key: "net_income", label: "Net income", kind: "flow", unit: "currency", historical: true },
    {
      key: "cash",
      label: "Cash (bank accounts, month end)",
      kind: "stock",
      unit: "currency",
      historical: true,
    },
  ],
  create: (fetch, now) => createQuickbooksAdapter({ fetch, now: () => now }),
  auth,
  now: NOW,
  kpiRequest: { metrics: [...ALL], ...Q1 },
  hosts: ["quickbooks.api.intuit.com", "sandbox-quickbooks.api.intuit.com"],
  happy,
});

/** A P&L or balance sheet for arbitrary months, shaped like the recorded fixtures. */
function buildReport(kind: "ProfitAndLoss" | "BalanceSheet", start: string, end: string): Json {
  const months: string[] = [];
  const [sy, sm] = start.split("-").map(Number) as [number, number];
  const [ey, em] = end.split("-").map(Number) as [number, number];
  for (let i = sy * 12 + sm - 1; i <= ey * 12 + em - 1; i += 1) {
    months.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  }
  const columns = [
    { ColTitle: "", ColType: "Account", MetaData: [{ Name: "ColKey", Value: "account" }] },
    ...months.map((month) => ({
      ColTitle: month,
      ColType: "Money",
      MetaData: [
        { Name: "StartDate", Value: `${month}-01` },
        { Name: "EndDate", Value: `${month}-28` },
      ],
    })),
  ];
  const cells = (label: string, f: (month: string) => string) => ({
    ColData: [{ value: label }, ...months.map((month) => ({ value: f(month) }))],
  });
  const n = (month: string) => Number(month.slice(5));
  const rows =
    kind === "ProfitAndLoss"
      ? [
          {
            group: "Income",
            type: "Section",
            Summary: cells("Total Income", (m) => `${n(m)}000.00`),
          },
          {
            group: "Expenses",
            type: "Section",
            Summary: cells("Total Expenses", (m) => `${n(m)}00.00`),
          },
          {
            group: "NetIncome",
            type: "Section",
            Summary: cells("Net Income", (m) => `${n(m) * 900}.00`),
          },
        ]
      : [
          {
            group: "BankAccounts",
            type: "Section",
            Summary: cells("Total Bank Accounts", (m) => `${m.slice(0, 4)}.${m.slice(5)}`),
          },
        ];
  return {
    Header: { ReportName: kind, Currency: "EUR", SummarizeColumnsBy: "Month", Option: [] },
    Columns: { Column: columns },
    Rows: { Row: rows },
  };
}

const dynamicReports: Handler = (req: RecordedRequest) => {
  const kind = req.url.pathname.endsWith("BalanceSheet") ? "BalanceSheet" : "ProfitAndLoss";
  const start = req.url.searchParams.get("start_date") ?? "";
  const end = req.url.searchParams.get("end_date") ?? "";
  return json(buildReport(kind, start.slice(0, 7), end.slice(0, 7)));
};

describe("quickbooksMeta", () => {
  it("asks for the accounting scope on Intuit's endpoints, without PKCE", () => {
    expect(quickbooksMeta.oauth).toEqual({
      authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
      tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      revokeUrl: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
      scopes: ["com.intuit.quickbooks.accounting"],
      pkce: false,
      scopeSeparator: " ",
    });
    expect(quickbooksMetrics.map((m) => m.key)).toEqual([
      "revenue",
      "expenses",
      "net_income",
      "cash",
    ]);
  });
});

describe("exchangeCode", () => {
  it("exchanges the code with client_secret_basic and takes realmId from the callback query", async () => {
    const { fake, adapter: qbo } = adapter(() => json(fixture("token")));
    const result = await qbo.exchangeCode?.({
      code: "AB11code",
      redirectUri: "https://seed.example/oauth/integrations/callback",
      codeVerifier: null,
      query: { realmId: REALM },
      client,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: "eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0..access",
        refreshToken: "AB11700000000refreshrotated",
        expiresAt: new Date(NOW.getTime() + 3600_000),
        scope: "com.intuit.quickbooks.accounting",
        externalAccountId: REALM,
        extra: { refreshTokenExpiresAt: new Date(NOW.getTime() + 8726400_000).toISOString() },
      },
    });
    const [call] = fake.calls;
    expect(call?.url.href).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(call?.method).toBe("POST");
    expect(call?.redirect).toBe("manual");
    expect(call?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("ABclient:shh").toString("base64")}`,
    );
    expect(formOf(call as RecordedRequest)).toEqual({
      grant_type: "authorization_code",
      code: "AB11code",
      redirect_uri: "https://seed.example/oauth/integrations/callback",
    });
  });

  it("forwards a PKCE verifier when the kernel has one", async () => {
    const { fake, adapter: qbo } = adapter(() => json(fixture("token")));
    await qbo.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: "v".repeat(43),
      query: { realmId: REALM },
      client,
    });
    expect(formOf(fake.calls[0] as RecordedRequest)["code_verifier"]).toBe("v".repeat(43));
  });

  it.each([[{}], [{ realmId: "../../evil" }], [{ realmId: "" }]])(
    "refuses a callback without a numeric realmId (%j) without calling Intuit",
    async (query) => {
      const { fake, adapter: qbo } = adapter(() => json(fixture("token")));
      const result = await qbo.exchangeCode?.({
        code: "c",
        redirectUri: "https://x/cb",
        codeVerifier: null,
        query,
        client,
      });
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([
    [400, { error: "invalid_grant" }, "unauthorized"],
    [401, { error: "invalid_client" }, "unavailable"],
    [401, {}, "unavailable"],
    [400, { error: "invalid_request", error_description: "redirect_uri mismatch" }, "malformed"],
    [429, {}, "rate_limited"],
    [502, {}, "unavailable"],
  ] as const)("maps a token-endpoint %i %j to %s", async (status, body, reason) => {
    const { adapter: qbo } = adapter(() => json(body, status));
    const result = await qbo.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: { realmId: REALM },
      client,
    });
    expect(result).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain("redirect_uri mismatch");
  });

  it.each([
    [{ token_type: "bearer", expires_in: 3600 }],
    [{ access_token: "a", expires_in: 3600 }],
    [{ access_token: "", refresh_token: "r" }],
    [{ access_token: "a", refresh_token: 12 }],
  ])("answers malformed for an unusable token response %j", async (body) => {
    const { adapter: qbo } = adapter(() => json(body));
    const result = await qbo.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: { realmId: REALM },
      client,
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("tolerates a missing or odd expires_in (no expiry rather than a wrong one)", async () => {
    const { adapter: qbo } = adapter(() =>
      json({ access_token: "a", refresh_token: "r", expires_in: "soon" }),
    );
    const result = await qbo.exchangeCode?.({
      code: "c",
      redirectUri: "https://x/cb",
      codeVerifier: null,
      query: { realmId: REALM },
      client,
    });
    expect(result).toMatchObject({ ok: true, value: { expiresAt: null, refreshToken: "r" } });
  });
});

describe("refresh", () => {
  it("returns the rotated refresh token", async () => {
    const { fake, adapter: qbo } = adapter(() =>
      json({ ...fixture("token"), refresh_token: "rotated-2" }),
    );
    const result = await qbo.refresh?.({ refreshToken: "old", client });
    expect(result).toMatchObject({
      ok: true,
      value: { refreshToken: "rotated-2", externalAccountId: null },
    });
    expect(formOf(fake.calls[0] as RecordedRequest)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old",
    });
  });

  it("keeps the current refresh token when the response omits one", async () => {
    const { adapter: qbo } = adapter(() => json({ access_token: "new", expires_in: "3600" }));
    const result = await qbo.refresh?.({ refreshToken: "old", client });
    expect(result).toMatchObject({
      ok: true,
      value: {
        accessToken: "new",
        refreshToken: "old",
        expiresAt: new Date(NOW.getTime() + 3600_000),
      },
    });
  });

  it("maps invalid_grant to unauthorized (the kernel's reauth signal)", async () => {
    const { adapter: qbo } = adapter(() => json({ error: "invalid_grant" }, 400));
    expect(await qbo.refresh?.({ refreshToken: "old", client })).toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });
});

describe("revoke", () => {
  it("posts the token as JSON with client authentication", async () => {
    const { fake, adapter: qbo } = adapter(() => new Response(null, { status: 200 }));
    await qbo.revoke?.({ token: "refresh-1", client });
    const [call] = fake.calls;
    expect(call?.url.href).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    expect(JSON.parse(call?.body ?? "")).toEqual({ token: "refresh-1" });
    expect(call?.headers.get("authorization")).toMatch(/^Basic /u);
  });

  it("does nothing without a client and never throws", async () => {
    const quiet = adapter(() => json({}));
    await quiet.adapter.revoke?.({ token: "t", client: null });
    expect(quiet.fake.calls).toHaveLength(0);
    const broken = adapter(() => {
      throw new Error("down");
    });
    await expect(broken.adapter.revoke?.({ token: "t", client })).resolves.toBeUndefined();
  });
});

describe("verify", () => {
  it("labels the account with the company name", async () => {
    const { fake, adapter: qbo } = adapter(happy);
    expect(await qbo.verify(auth)).toEqual({
      ok: true,
      value: { accountLabel: "Acme Robotics Inc", externalAccountId: REALM },
    });
    const [call] = fake.calls;
    expect(call?.url.hostname).toBe("quickbooks.api.intuit.com");
    expect(call?.url.searchParams.get("minorversion")).toBe("75");
    expect(call?.headers.get("authorization")).toBe("Bearer qbo-access");
  });

  it("uses the sandbox API for a sandbox connection", async () => {
    const { fake, adapter: qbo } = adapter(happy);
    await qbo.verify({ ...auth, environment: "sandbox" });
    expect(fake.calls[0]?.url.hostname).toBe("sandbox-quickbooks.api.intuit.com");
  });

  it("falls back to the legal name, then to the realm id", async () => {
    const legal = adapter(() => json({ CompanyInfo: { CompanyName: " ", LegalName: "Acme LLC" } }));
    expect(await legal.adapter.verify(auth)).toMatchObject({ value: { accountLabel: "Acme LLC" } });
    const bare = adapter(() => json({ CompanyInfo: {} }));
    expect(await bare.adapter.verify(auth)).toMatchObject({
      value: { accountLabel: `QuickBooks company ${REALM}` },
    });
    const none = adapter(() => json({ QueryResponse: {} }));
    expect(await none.adapter.verify(auth)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses without a realm id, and never puts a non-numeric one in a URL", async () => {
    for (const externalAccountId of [null, "1/../../evil"]) {
      const { fake, adapter: qbo } = adapter(happy);
      expect(await qbo.verify({ ...auth, externalAccountId })).toMatchObject({
        ok: false,
        reason: "not_found",
      });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it.each([
    ["AUTHENTICATION", "unauthorized"],
    ["AuthorizationFault", "forbidden"],
    ["ValidationFault", "malformed"],
  ])("maps a 200 carrying a %s fault to %s", async (type, reason) => {
    const body = { ...fixture("fault-authentication"), Fault: { Error: [], type } };
    const { adapter: qbo } = adapter(() => json(body));
    expect(await qbo.verify(auth)).toMatchObject({ ok: false, reason });
  });
});

describe("kpi.read", () => {
  it("reads the recorded P&L and balance sheet by group, not position", async () => {
    const { fake, adapter: qbo } = adapter(happy);
    const result = await qbo.kpi?.read(auth, { metrics: [...ALL], ...Q1 });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: "USD",
        series: [
          {
            metric: "revenue",
            points: [
              { month: "2026-01", value: "15000.00" },
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
              { month: "2026-03", value: "-24755.35" },
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
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([
      `${REPORT_BASE}/ProfitAndLoss`,
      `${REPORT_BASE}/BalanceSheet`,
    ]);
    const params = Object.fromEntries(fake.calls[0]?.url.searchParams ?? []);
    expect(params).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      summarize_column_by: "Month",
      minorversion: "75",
    });
  });

  it("finds groups regardless of their order in the report", async () => {
    const pl = fixture("profit-and-loss");
    const rows = (pl["Rows"] as { Row: unknown[] }).Row;
    (pl["Rows"] as { Row: unknown[] }).Row = [...rows].reverse();
    const { adapter: qbo } = adapter(() => json(pl));
    const result = await qbo.kpi?.read(auth, { metrics: ["revenue", "net_income"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [
          { points: [{ value: "15000.00" }, {}, {}] },
          { points: [{ value: "-8387.66" }, {}, {}] },
        ],
      },
    });
  });

  it("only requests the reports the metrics need", async () => {
    const { fake, adapter: qbo } = adapter(happy);
    await qbo.kpi?.read(auth, { metrics: ["cash"], ...Q1 });
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([`${REPORT_BASE}/BalanceSheet`]);
  });

  it("pages a long range in 12-month reports and stitches the months", async () => {
    const { fake, adapter: qbo } = adapter(dynamicReports);
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2024-04",
      toMonth: "2026-03",
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.currency).toBe("EUR");
    const [revenue, cash] = result.value.series;
    expect(revenue?.points).toHaveLength(24);
    expect(revenue?.points[0]).toEqual({ month: "2024-04", value: "4000.00" });
    expect(revenue?.points[23]).toEqual({ month: "2026-03", value: "3000.00" });
    expect(cash?.points[12]).toEqual({ month: "2025-04", value: "2025.04" });
    const ranges = fake.calls.map(
      (c) =>
        `${c.url.pathname.split("/").pop()} ${c.url.searchParams.get("start_date")}..${c.url.searchParams.get("end_date")}`,
    );
    expect(ranges).toEqual([
      "ProfitAndLoss 2024-04-01..2025-03-31",
      "BalanceSheet 2024-04-01..2025-03-31",
      "ProfitAndLoss 2025-04-01..2026-03-31",
      "BalanceSheet 2025-04-01..2026-03-31",
    ]);
  });

  it("clamps the range to the current month", async () => {
    const { fake, adapter: qbo } = adapter(dynamicReports);
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue"],
      fromMonth: "2026-03",
      toMonth: "2026-12",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ month: "2026-03" }, { month: "2026-04" }] }] },
    });
    expect(fake.calls[0]?.url.searchParams.get("end_date")).toBe("2026-04-30");
  });

  it("answers an empty series for a range entirely in the future", async () => {
    const { fake, adapter: qbo } = adapter(dynamicReports);
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue"],
      fromMonth: "2027-01",
      toMonth: "2027-03",
    });
    expect(result).toEqual({
      ok: true,
      value: { currency: null, series: [{ metric: "revenue", points: [] }] },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads NoReportData as zeros for every month", async () => {
    const { adapter: qbo } = adapter(() => json(fixture("profit-and-loss-no-data")));
    const result = await qbo.kpi?.read(auth, { metrics: ["revenue", "net_income"], ...Q1 });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: "GBP",
        series: ["revenue", "net_income"].map((metric) => ({
          metric,
          points: ["2026-01", "2026-02", "2026-03"].map((month) => ({ month, value: "0" })),
        })),
      },
    });
  });

  it("reads a missing Expenses or BankAccounts section as zero", async () => {
    const pl = fixture("profit-and-loss");
    const rows = (pl["Rows"] as { Row: Json[] }).Row;
    (pl["Rows"] as { Row: Json[] }).Row = rows.filter((r) => r["group"] !== "Expenses");
    const bs = {
      ...fixture("balance-sheet"),
      Rows: { Row: [{ group: "TotalAssets", type: "Section", Summary: { ColData: [] } }] },
    };
    const { adapter: qbo } = adapter((req) =>
      json(req.url.pathname.endsWith("BalanceSheet") ? bs : pl),
    );
    const result = await qbo.kpi?.read(auth, { metrics: ["expenses", "cash"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [
          { points: [{ value: "0" }, { value: "0" }, { value: "0" }] },
          { points: [{ value: "0" }, { value: "0" }, { value: "0" }] },
        ],
      },
    });
  });

  it("reads an empty summary cell as zero", async () => {
    const pl = fixture("profit-and-loss");
    const income = (pl["Rows"] as { Row: Json[] }).Row[0] as {
      Summary: { ColData: { value: string }[] };
    };
    (income.Summary.ColData[2] as { value: string }).value = "";
    const { adapter: qbo } = adapter(() => json(pl));
    const result = await qbo.kpi?.read(auth, { metrics: ["revenue"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{}, { value: "0" }, {}] }] },
    });
  });

  const mutate = (f: (pl: Json) => void) => {
    const pl = fixture("profit-and-loss");
    f(pl);
    return pl;
  };
  const rowsOf = (pl: Json) => (pl["Rows"] as { Row: Json[] }).Row;

  it.each([
    ["no Columns", mutate((pl) => delete pl["Columns"])],
    ["no Header", mutate((pl) => delete pl["Header"])],
    ["Rows is a string", mutate((pl) => (pl["Rows"] = "x"))],
    [
      "no NetIncome section",
      mutate((pl) => (pl["Rows"] = { Row: rowsOf(pl).filter((r) => r["group"] !== "NetIncome") })),
    ],
    [
      "a section without Summary",
      mutate(
        (pl) => delete (rowsOf(pl).find((r) => r["group"] === "NetIncome") as Json)["Summary"],
      ),
    ],
    [
      "an exponent value",
      mutate(
        (pl) =>
          (((rowsOf(pl)[0] as { Summary: { ColData: Json[] } }).Summary.ColData[1] as Json)[
            "value"
          ] = "1.5e3"),
      ),
    ],
    [
      "a thousands separator",
      mutate(
        (pl) =>
          (((rowsOf(pl)[0] as { Summary: { ColData: Json[] } }).Summary.ColData[1] as Json)[
            "value"
          ] = "15,000.00"),
      ),
    ],
    [
      "a numeric value",
      mutate(
        (pl) =>
          (((rowsOf(pl)[0] as { Summary: { ColData: Json[] } }).Summary.ColData[1] as Json)[
            "value"
          ] = 15000),
      ),
    ],
    [
      "no column for a month",
      mutate((pl) => (pl["Columns"] as { Column: unknown[] }).Column.splice(2, 1)),
    ],
  ])("answers malformed for %s", async (_name, body) => {
    const { adapter: qbo } = adapter(() => json(body));
    const result = await qbo.kpi?.read(auth, { metrics: ["revenue", "net_income"], ...Q1 });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("maps columns by their title when MetaData has no dates", async () => {
    const pl = fixture("profit-and-loss");
    for (const column of (pl["Columns"] as { Column: Json[] }).Column) delete column["MetaData"];
    const { adapter: qbo } = adapter(() => json(pl));
    const result = await qbo.kpi?.read(auth, { metrics: ["revenue"], ...Q1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        series: [{ points: [{ value: "15000.00" }, { value: "18600.50" }, { value: "-250.25" }] }],
      },
    });
  });

  it("answers too_large before calling Intuit when the range needs more than 50 reports", async () => {
    const { fake, adapter: qbo } = adapter(dynamicReports, new Date("2060-01-01T00:00:00Z"));
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2026-01",
      toMonth: "2051-12",
    });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(fake.calls).toHaveLength(0);
  });

  it("stops between report pages when the signal aborts", async () => {
    const controller = new AbortController();
    const { fake, adapter: qbo } = adapter((req) => {
      controller.abort();
      return dynamicReports(req);
    });
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2024-04",
      toMonth: "2026-03",
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "aborted" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.signal).toBe(controller.signal);
  });

  it("stops at the first failing report", async () => {
    let n = 0;
    const { fake, adapter: qbo } = adapter((req) =>
      ++n === 2 ? json({}, 429) : dynamicReports(req),
    );
    const result = await qbo.kpi?.read(auth, {
      metrics: ["revenue", "cash"],
      fromMonth: "2024-04",
      toMonth: "2026-03",
    });
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(fake.calls).toHaveLength(2);
  });

  it("maps a 200 authentication fault on a report to unauthorized", async () => {
    const { adapter: qbo } = adapter(() => json(fixture("fault-authentication")));
    expect(await qbo.kpi?.read(auth, { metrics: ["revenue"], ...Q1 })).toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });
});
