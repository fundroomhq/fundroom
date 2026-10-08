import type {
  IntegrationAdapter,
  IntegrationAdapterDeps,
  IntegrationAdapterFactory,
  IntegrationAuth,
  IntegrationProviderMeta,
  IntegrationResult,
  KpiReadRequest,
  KpiReadValue,
  KpiSourceMetric,
  OAuthClient,
  OAuthTokenSet,
} from "@fundroom/ports";
import { type Dec, formatDec, parseCell, ZERO } from "./internal/decimal.js";
import {
  basicAuth,
  type Failure,
  fail,
  isRecord,
  MAX_PAGES,
  requestJson,
  send,
  withSignal,
} from "./internal/http.js";
import {
  chunk,
  firstDay,
  formatMonth,
  fullYear,
  lastDay,
  monthFromName,
  requestedMonths,
  type Ym,
} from "./internal/months.js";
import { lifetimeSeconds, tokenRequest } from "./internal/oauth.js";

/*
 * QuickBooks Online Accounting API v3, read-only, over OAuth 2.0 (E3.6, ADR-0054).
 *
 * What is read: the ProfitAndLoss and BalanceSheet reports with `summarize_column_by=Month`, and
 * CompanyInfo for the account label. Nothing is written, ever.
 *
 * Report parsing is by *meaning*, not position:
 * - columns are mapped to months from their `MetaData` `StartDate`/`EndDate` (falling back to a
 *   "Mon YYYY" `ColTitle`); a column spanning more than one month (the "Total" column) is skipped;
 * - rows are found by their `group` anywhere in the tree: `Income` → revenue, `Expenses` →
 *   expenses, `NetIncome` → net_income (P&L), `BankAccounts` → cash (Balance Sheet), and the value
 *   is that section's `Summary` cell in the month's column;
 * - a missing Income/Expenses/BankAccounts section means "nothing booked there" = 0; a report with
 *   data but no NetIncome section is `malformed`; `NoReportData=true` is all zeros.
 */

export const QUICKBOOKS_MINOR_VERSION = "75";
const PRODUCTION_API = "https://quickbooks.api.intuit.com";
const SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
/** Months per report request. QuickBooks has no documented column cap; 12 keeps each body small. */
const MONTHS_PER_REQUEST = 12;
const REALM_ID = /^\d{1,30}$/u;

export const quickbooksMetrics: readonly KpiSourceMetric[] = [
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
];

export const quickbooksMeta: IntegrationProviderMeta = {
  provider: "quickbooks",
  displayName: "QuickBooks Online",
  capabilities: ["kpi"],
  auth: "oauth2",
  oauth: {
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: ["com.intuit.quickbooks.accounting"],
    // Intuit documents no PKCE support; the confidential client secret, the single-use `state`
    // and the browser-binding cookie protect the code instead.
    pkce: false,
    scopeSeparator: " ",
  },
  scopeExplanation: [
    "Reads your monthly Profit and Loss totals (total income, total expenses, net income).",
    "Reads your Balance Sheet bank-account total at each month end.",
    "Reads your company name so you can see which company is connected.",
    "Never creates, changes or deletes anything in QuickBooks, and never reads individual transactions, customers or invoices.",
    "QuickBooks' permission screen says “accounting” because Intuit offers no narrower read-only scope; this app only ever calls the two report endpoints and company info.",
  ],
  subProcessor: {
    name: "Intuit Inc. (QuickBooks Online)",
    purpose: "Source of monthly revenue, expenses, net income and cash figures read into Metrics",
    region: "United States",
    dpaUrl: "https://www.intuit.com/privacy/statement/",
    jurisdiction: "us",
  },
};

export interface QuickbooksAdapterOptions {
  /** TESTS ONLY: replaces both the production and the sandbox API origin. */
  apiBaseUrl?: string;
  /** TESTS ONLY */
  tokenUrl?: string;
  /** TESTS ONLY */
  revokeUrl?: string;
}

type Metric = "revenue" | "expenses" | "net_income" | "cash";
const PL_GROUPS: Record<Exclude<Metric, "cash">, string> = {
  revenue: "Income",
  expenses: "Expenses",
  net_income: "NetIncome",
};
const METRIC_KEYS = new Set<string>(quickbooksMetrics.map((m) => m.key));

export function createQuickbooksAdapter(
  deps: IntegrationAdapterDeps,
  options: QuickbooksAdapterOptions = {},
): IntegrationAdapter {
  const log = deps.log;
  const tokenUrl = options.tokenUrl ?? TOKEN_URL;
  const revokeUrl = options.revokeUrl ?? REVOKE_URL;
  const apiBase = (auth: IntegrationAuth): string =>
    options.apiBaseUrl ?? (auth.environment === "sandbox" ? SANDBOX_API : PRODUCTION_API);

  function toTokenSet(
    parsed: {
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
      scope: string | null;
      body: Record<string, unknown>;
    },
    realmId: string | null,
    now: Date,
  ): OAuthTokenSet {
    const extra: Record<string, string> = {};
    const refreshLifetime = lifetimeSeconds(parsed.body["x_refresh_token_expires_in"]);
    if (refreshLifetime !== null) {
      extra["refreshTokenExpiresAt"] = new Date(
        now.getTime() + refreshLifetime * 1000,
      ).toISOString();
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      // Intuit's token response carries no `scope`; the grant is always the one we asked for.
      scope: parsed.scope ?? quickbooksMeta.oauth?.scopes.join(" ") ?? null,
      externalAccountId: realmId,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  }

  /** GET a v3 resource; a 200 carrying `Fault` is still a failure (QuickBooks does that). */
  async function qboGet(
    auth: IntegrationAuth,
    path: string,
    where: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: Record<string, unknown> } | Failure> {
    const got = await requestJson(
      deps.fetch,
      `${apiBase(auth)}${path}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${auth.accessToken}`, accept: "application/json" },
        ...withSignal(signal),
      },
      where,
      log,
    );
    if (!got.ok) return got;
    if (!isRecord(got.value))
      return fail("malformed", `${where} did not answer with a JSON object`);
    const fault = got.value["Fault"] ?? got.value["fault"];
    if (fault !== undefined) return faultFailure(fault, where);
    return { ok: true, value: got.value };
  }

  async function readReport(
    auth: IntegrationAuth,
    realmId: string,
    report: "ProfitAndLoss" | "BalanceSheet",
    months: readonly Ym[],
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; value: ParsedReport } | Failure> {
    const first = months[0];
    const last = months[months.length - 1];
    if (first === undefined || last === undefined) return fail("malformed", "empty month chunk");
    const query = new URLSearchParams({
      start_date: firstDay(first),
      end_date: lastDay(last),
      summarize_column_by: "Month",
      minorversion: QUICKBOOKS_MINOR_VERSION,
    });
    const where = `the QuickBooks ${report} report`;
    const got = await qboGet(
      auth,
      `/v3/company/${realmId}/reports/${report}?${query}`,
      where,
      signal,
    );
    if (!got.ok) return got;
    return parseReport(got.value, where);
  }

  return {
    meta: quickbooksMeta,

    async exchangeCode(input: {
      code: string;
      redirectUri: string;
      codeVerifier: string | null;
      query: Record<string, string>;
      client: OAuthClient;
    }): Promise<IntegrationResult<OAuthTokenSet>> {
      // Intuit appends `realmId` (the company id) to the redirect; it is the account we read.
      const realmId = input.query["realmId"];
      if (realmId === undefined || !REALM_ID.test(realmId)) {
        return fail("malformed", "the QuickBooks callback carried no valid realmId");
      }
      const now = deps.now();
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      };
      if (input.codeVerifier !== null) form["code_verifier"] = input.codeVerifier;
      const token = await tokenRequest(
        deps.fetch,
        tokenUrl,
        input.client,
        form,
        now,
        "the QuickBooks token endpoint",
        log,
      );
      if (!token.ok) return token;
      if (token.value.refreshToken === null) {
        return fail("malformed", "the QuickBooks token endpoint answered without a refresh token");
      }
      return { ok: true, value: toTokenSet(token.value, realmId, now) };
    },

    async refresh(input: {
      refreshToken: string;
      client: OAuthClient;
    }): Promise<IntegrationResult<OAuthTokenSet>> {
      const now = deps.now();
      const token = await tokenRequest(
        deps.fetch,
        tokenUrl,
        input.client,
        { grant_type: "refresh_token", refresh_token: input.refreshToken },
        now,
        "the QuickBooks token endpoint",
        log,
      );
      if (!token.ok) return token;
      // Intuit rotates refresh tokens; when a response ever omits one, the current one stays valid.
      const value = toTokenSet(
        { ...token.value, refreshToken: token.value.refreshToken ?? input.refreshToken },
        null,
        now,
      );
      return { ok: true, value };
    },

    async revoke(input: { token: string; client: OAuthClient | null }): Promise<void> {
      if (input.client === null) return; // Intuit's revoke endpoint needs client authentication.
      try {
        await send(
          deps.fetch,
          revokeUrl,
          {
            method: "POST",
            headers: {
              authorization: basicAuth(input.client.clientId, input.client.clientSecret),
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ token: input.token }),
          },
          "the QuickBooks revoke endpoint",
          log,
        );
      } catch {
        // best effort, never throws
      }
    },

    async verify(auth: IntegrationAuth) {
      const realmId = auth.externalAccountId;
      if (realmId === null || !REALM_ID.test(realmId)) {
        return fail("not_found", "no QuickBooks company (realmId) is selected");
      }
      const got = await qboGet(
        auth,
        `/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${QUICKBOOKS_MINOR_VERSION}`,
        "QuickBooks CompanyInfo",
      );
      if (!got.ok) return got;
      const info = got.value["CompanyInfo"];
      if (!isRecord(info))
        return fail("malformed", "QuickBooks CompanyInfo answered without CompanyInfo");
      const label = [info["CompanyName"], info["LegalName"]].find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      return {
        ok: true as const,
        value: {
          accountLabel: (label?.trim() ?? `QuickBooks company ${realmId}`).slice(0, 200),
          externalAccountId: realmId,
        },
      };
    },

    kpi: {
      metrics: quickbooksMetrics,
      async read(
        auth: IntegrationAuth,
        req: KpiReadRequest,
      ): Promise<IntegrationResult<KpiReadValue>> {
        const realmId = auth.externalAccountId;
        if (realmId === null || !REALM_ID.test(realmId)) {
          return fail("not_found", "no QuickBooks company (realmId) is selected");
        }
        const unknown = req.metrics.find((m) => !METRIC_KEYS.has(m));
        if (unknown !== undefined)
          return fail("not_found", `unknown QuickBooks metric "${unknown}"`);
        const months = requestedMonths(req.fromMonth, req.toMonth, deps.now());
        if (months === null) return fail("malformed", "the requested month range is invalid");
        const wanted = [...new Set(req.metrics)] as Metric[];
        const needPl = wanted.some((m) => m !== "cash");
        const needBs = wanted.includes("cash");
        const chunks = chunk(months, MONTHS_PER_REQUEST);
        const pages = chunks.length * ((needPl ? 1 : 0) + (needBs ? 1 : 0));
        if (pages > MAX_PAGES) {
          return fail("too_large", `the request needs ${pages} report pages (cap ${MAX_PAGES})`);
        }

        const values = new Map<Metric, Map<string, Dec>>(wanted.map((m) => [m, new Map()]));
        let currency: string | null = null;
        for (const part of chunks) {
          if (needPl) {
            const report = await readReport(auth, realmId, "ProfitAndLoss", part, req.signal);
            if (!report.ok) return report;
            currency ??= report.value.currency;
            for (const metric of wanted) {
              if (metric === "cash") continue;
              const picked = pick(report.value, PL_GROUPS[metric], part, metric === "net_income");
              if (!picked.ok) return picked;
              for (const [month, value] of picked.value) values.get(metric)?.set(month, value);
            }
          }
          if (needBs) {
            const report = await readReport(auth, realmId, "BalanceSheet", part, req.signal);
            if (!report.ok) return report;
            currency ??= report.value.currency;
            const picked = pick(report.value, "BankAccounts", part, false);
            if (!picked.ok) return picked;
            for (const [month, value] of picked.value) values.get("cash")?.set(month, value);
          }
        }
        return {
          ok: true,
          value: {
            currency,
            series: wanted.map((metric) => ({
              metric,
              points: months.map((ym) => {
                const month = formatMonth(ym);
                return { month, value: formatDec(values.get(metric)?.get(month) ?? ZERO) };
              }),
            })),
          },
        };
      },
    },
  };
}

// Compile-time proof that the extra (test-only) options parameter keeps the frozen factory shape.
const _factory: IntegrationAdapterFactory = createQuickbooksAdapter;
void _factory;

// ── report parsing ──────────────────────────────────────────────────────────────────────────

interface ParsedReport {
  currency: string | null;
  noData: boolean;
  /** month (YYYY-MM) → column index in every row's ColData */
  columns: Map<string, number>;
  rows: unknown;
}

function faultFailure(fault: unknown, where: string): Failure {
  const type =
    isRecord(fault) && typeof fault["type"] === "string" ? fault["type"].toLowerCase() : "";
  if (type.includes("authentication"))
    return fail("unauthorized", `${where} answered an authentication fault`);
  if (type.includes("authorization"))
    return fail("forbidden", `${where} answered an authorization fault`);
  return fail("malformed", `${where} answered a fault`);
}

function metaValue(column: Record<string, unknown>, name: string): string | undefined {
  const meta = column["MetaData"];
  if (!Array.isArray(meta)) return undefined;
  for (const entry of meta) {
    if (isRecord(entry) && entry["Name"] === name && typeof entry["Value"] === "string") {
      return entry["Value"];
    }
  }
  return undefined;
}

const ISO_DATE = /^(\d{4})-(\d{2})-\d{2}$/u;
const TITLE_MONTH = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/u;

function columnMonth(column: Record<string, unknown>): string | null {
  const start = metaValue(column, "StartDate");
  const end = metaValue(column, "EndDate");
  const s = start === undefined ? null : ISO_DATE.exec(start);
  const e = end === undefined ? null : ISO_DATE.exec(end);
  if (s !== null || e !== null) {
    const sm = s === null ? null : `${s[1]}-${s[2]}`;
    const em = e === null ? null : `${e[1]}-${e[2]}`;
    if (sm !== null && em !== null && sm !== em) return null; // spans months: the Total column
    return em ?? sm;
  }
  const key = metaValue(column, "ColKey");
  if (key === "total" || key === "account") return null;
  const title =
    typeof column["ColTitle"] === "string" ? TITLE_MONTH.exec(column["ColTitle"].trim()) : null;
  if (title === null) return null;
  const month = monthFromName(title[1] ?? "");
  if (month === null) return null;
  return formatMonth({ year: fullYear(title[2] ?? ""), month });
}

function parseReport(
  body: Record<string, unknown>,
  where: string,
): { ok: true; value: ParsedReport } | Failure {
  const header = body["Header"];
  const columnsObj = body["Columns"];
  if (!isRecord(header) || !isRecord(columnsObj) || !Array.isArray(columnsObj["Column"])) {
    return fail("malformed", `${where} has no Header/Columns`);
  }
  const rowsObj = body["Rows"];
  if (rowsObj !== undefined && !isRecord(rowsObj))
    return fail("malformed", `${where} has non-object Rows`);
  const options = header["Option"];
  const noData =
    Array.isArray(options) &&
    options.some(
      (o) =>
        isRecord(o) && o["Name"] === "NoReportData" && String(o["Value"]).toLowerCase() === "true",
    );
  const columns = new Map<string, number>();
  columnsObj["Column"].forEach((column: unknown, index: number) => {
    if (!isRecord(column)) return;
    const month = columnMonth(column);
    if (month !== null && !columns.has(month)) columns.set(month, index);
  });
  const rawCurrency = header["Currency"];
  const currency =
    typeof rawCurrency === "string" && /^[A-Za-z]{3}$/u.test(rawCurrency)
      ? rawCurrency.toUpperCase()
      : null;
  return { ok: true, value: { currency, noData, columns, rows: rowsObj?.["Row"] ?? [] } };
}

/** Depth-first search for the section whose `group` is `group`. */
function findGroup(rows: unknown, group: string, depth = 0): Record<string, unknown> | undefined {
  if (!Array.isArray(rows) || depth > 12) return undefined;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row["group"] === group) return row;
    const nested = row["Rows"];
    if (isRecord(nested)) {
      const found = findGroup(nested["Row"], group, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function hasAnyRow(rows: unknown): boolean {
  return Array.isArray(rows) && rows.some((row) => isRecord(row));
}

/** The group's Summary value for each month of `months`. */
function pick(
  report: ParsedReport,
  group: string,
  months: readonly Ym[],
  required: boolean,
): { ok: true; value: Map<string, Dec> } | Failure {
  const out = new Map<string, Dec>();
  if (report.noData || !hasAnyRow(report.rows)) {
    for (const ym of months) out.set(formatMonth(ym), ZERO);
    return { ok: true, value: out };
  }
  const section = findGroup(report.rows, group);
  if (section === undefined) {
    if (required) return fail("malformed", `the QuickBooks report has no ${group} section`);
    for (const ym of months) out.set(formatMonth(ym), ZERO);
    return { ok: true, value: out };
  }
  const summary = section["Summary"];
  const cells = isRecord(summary) ? summary["ColData"] : undefined;
  if (!Array.isArray(cells))
    return fail("malformed", `the QuickBooks ${group} section has no Summary`);
  for (const ym of months) {
    const month = formatMonth(ym);
    const index = report.columns.get(month);
    if (index === undefined)
      return fail("malformed", `the QuickBooks report has no column for ${month}`);
    const cell: unknown = cells[index];
    const value = parseCell(isRecord(cell) ? cell["value"] : undefined);
    if (value === null)
      return fail("malformed", `the QuickBooks ${group} value for ${month} is not a plain decimal`);
    out.set(month, value);
  }
  return { ok: true, value: out };
}
