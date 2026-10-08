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
import { type Dec, formatDec, negateDec, parseCell, ZERO } from "./internal/decimal.js";
import {
  basicAuth,
  type Failure,
  fail,
  isRecord,
  MAX_PAGES,
  send,
  statusFailure,
  withSignal,
} from "./internal/http.js";
import {
  daysInMonth,
  firstDay,
  formatMonth,
  fullYear,
  lastDay,
  monthFromName,
  requestedMonths,
  type Ym,
} from "./internal/months.js";
import { type ParsedToken, tokenRequest } from "./internal/oauth.js";

/*
 * Xero Accounting API, read-only, over OAuth 2.0 with PKCE (E3.6, ADR-0054).
 *
 * What is read: `GET /connections` (which organisations the grant covers), `Organisation` (name and
 * base currency), and the ProfitAndLoss and BalanceSheet reports with `timeframe=MONTH`. Nothing
 * is written, ever.
 *
 * Scopes: Xero retired the broad `accounting.reports.read` for apps created on/after 2026-03-02
 * (existing apps must migrate by September 2027), so we ask for the granular
 * `accounting.reports.profitandloss.read` + `accounting.reports.balancesheet.read`, plus
 * `accounting.settings.read` (Organisation) and `offline_access` (refresh token). `openid` is
 * kept so the grant yields an id_token (Xero's recommended baseline); no profile/email is read.
 *
 * Reports come back as a tree of `Section`/`Row`/`SummaryRow` with a `Header` row naming the
 * columns. Xero derives comparison periods from the anchor's DAY NUMBER (an anchor on the 30th
 * yields "30 Aug", "30 Jul" columns — truncated months), so multi-month requests are anchored only
 * on 31-day months, other months are requested alone, and every column is validated to end on its
 * month's last day; refused columns are re-read one month at a time (see `planGroups` and
 * `parseReport`). Rows are found by their label (requested with `standardLayout=true`, so a
 * custom report layout cannot rename them): "Total Income" (revenue), "Total Operating Expenses"
 * (expenses), "Net Profit" (net_income), "Total Bank" (cash). Missing income/expense/bank sections
 * are zero; a report with rows but no net profit line is `malformed`.
 */

const API_BASE = "https://api.xero.com";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const REVOKE_URL = "https://identity.xero.com/connect/revocation";
/** Xero allows up to 11 comparison `periods` (12 columns) per report. */
const MONTHS_PER_REQUEST = 12;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ACCOUNTS = 50;

export const xeroMetrics: readonly KpiSourceMetric[] = [
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
];

export const XERO_SCOPES = [
  "openid",
  "offline_access",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.settings.read",
] as const;

export const xeroMeta: IntegrationProviderMeta = {
  provider: "xero",
  displayName: "Xero",
  capabilities: ["kpi"],
  auth: "oauth2",
  oauth: {
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: XERO_SCOPES,
    pkce: true,
    scopeSeparator: " ",
  },
  scopeExplanation: [
    "Reads your monthly Profit and Loss totals (total income, total operating expenses, net profit).",
    "Reads your Balance Sheet bank total at each month end.",
    "Reads your organisation's name and base currency, and the list of organisations you chose to connect.",
    "All access is read-only: nothing in Xero is ever created, changed or deleted, and no invoices, contacts or bank transactions are read.",
  ],
  subProcessor: {
    name: "Xero Limited",
    purpose: "Source of monthly revenue, expenses, net profit and cash figures read into Metrics",
    region: "United States / Australia (Xero-hosted)",
    dpaUrl: "https://www.xero.com/us/legal/terms/data-processing/",
    jurisdiction: "varies",
  },
};

export interface XeroAdapterOptions {
  /** TESTS ONLY: replaces `https://api.xero.com` (connections and the accounting API). */
  apiBaseUrl?: string;
  /** TESTS ONLY */
  tokenUrl?: string;
  /** TESTS ONLY */
  revokeUrl?: string;
}

type Metric = "revenue" | "expenses" | "net_income" | "cash";
const METRIC_KEYS = new Set<string>(xeroMetrics.map((m) => m.key));
const RATE_LIMIT_PROBLEMS = new Set(["minute", "day", "concurrent", "appminute"]);

export function createXeroAdapter(
  deps: IntegrationAdapterDeps,
  options: XeroAdapterOptions = {},
): IntegrationAdapter {
  const log = deps.log;
  const apiBase = options.apiBaseUrl ?? API_BASE;
  const tokenUrl = options.tokenUrl ?? TOKEN_URL;
  const revokeUrl = options.revokeUrl ?? REVOKE_URL;

  async function xeroGet(
    accessToken: string,
    tenantId: string | null,
    path: string,
    where: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: Record<string, unknown> | unknown[] } | Failure> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    };
    if (tenantId !== null) headers["xero-tenant-id"] = tenantId;
    const sent = await send(
      deps.fetch,
      `${apiBase}${path}`,
      { method: "GET", headers, ...withSignal(signal) },
      where,
      log,
    );
    if (!sent.ok) return sent;
    const { status, json, headers: responseHeaders } = sent.value;
    if (status === 429) {
      const problem = responseHeaders.get("x-rate-limit-problem")?.toLowerCase() ?? "";
      return fail(
        "rate_limited",
        RATE_LIMIT_PROBLEMS.has(problem)
          ? `${where} answered HTTP 429 (Xero ${problem} limit)`
          : `${where} answered HTTP 429`,
      );
    }
    if (status < 200 || status >= 300) return statusFailure(status, where);
    if (typeof json !== "object" || json === null) {
      return fail("malformed", `${where} did not answer with JSON`);
    }
    return { ok: true, value: json as Record<string, unknown> | unknown[] };
  }

  async function organisation(
    auth: IntegrationAuth,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: { name: string | null; currency: string | null } } | Failure> {
    const got = await xeroGet(
      auth.accessToken,
      tenantId,
      "/api.xro/2.0/Organisation",
      "Xero Organisation",
      signal,
    );
    if (!got.ok) return got;
    const list = isRecord(got.value) ? got.value["Organisations"] : undefined;
    const org: unknown = Array.isArray(list) ? list[0] : undefined;
    if (!isRecord(org))
      return fail("malformed", "Xero Organisation answered without an organisation");
    const name =
      typeof org["Name"] === "string" && org["Name"].trim() !== "" ? org["Name"].trim() : null;
    const base = org["BaseCurrency"];
    const currency =
      typeof base === "string" && /^[A-Za-z]{3}$/u.test(base) ? base.toUpperCase() : null;
    return { ok: true, value: { name, currency } };
  }

  /** The organisations this grant covers, the ones from THIS consent first. */
  async function listTenants(
    accessToken: string,
  ): Promise<{ ok: true; value: { id: string; name: string }[] } | Failure> {
    const got = await xeroGet(accessToken, null, "/connections", "Xero connections");
    if (!got.ok) return got;
    if (!Array.isArray(got.value))
      return fail("malformed", "Xero connections did not answer a list");
    const authEventId = jwtClaim(accessToken, "authentication_event_id");
    const tenants: { id: string; name: string; current: boolean }[] = [];
    for (const entry of got.value) {
      if (!isRecord(entry)) continue;
      const id = entry["tenantId"];
      const type = entry["tenantType"];
      if (typeof id !== "string" || !TENANT_ID.test(id)) continue;
      if (typeof type === "string" && type.toUpperCase() !== "ORGANISATION") continue;
      if (tenants.some((t) => t.id === id)) continue;
      const rawName = entry["tenantName"];
      const name =
        typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim().slice(0, 200) : id;
      tenants.push({
        id,
        name,
        current: authEventId !== null && entry["authEventId"] === authEventId,
      });
    }
    const ordered = [...tenants.filter((t) => t.current), ...tenants.filter((t) => !t.current)];
    return {
      ok: true,
      value: ordered.slice(0, MAX_ACCOUNTS).map(({ id, name }) => ({ id, name })),
    };
  }

  async function revokeToken(token: string, client: OAuthClient): Promise<void> {
    try {
      await send(
        deps.fetch,
        revokeUrl,
        {
          method: "POST",
          headers: {
            authorization: basicAuth(client.clientId, client.clientSecret),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token }).toString(),
        },
        "the Xero revocation endpoint",
        log,
      );
    } catch {
      // best effort, never throws
    }
  }

  function tokenSet(
    parsed: ParsedToken,
    externalAccountId: string | null,
    extra?: Record<string, string>,
  ): OAuthTokenSet {
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      scope: parsed.scope,
      externalAccountId,
      ...(extra === undefined ? {} : { extra }),
    };
  }

  async function readReport(
    auth: IntegrationAuth,
    tenantId: string,
    report: ReportKind,
    months: readonly Ym[],
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; value: ParsedReport } | Failure> {
    const newest = months[months.length - 1];
    if (newest === undefined) return fail("malformed", "empty month chunk");
    const query = new URLSearchParams();
    if (report === "ProfitAndLoss") {
      query.set("fromDate", firstDay(newest));
      query.set("toDate", lastDay(newest));
    } else {
      query.set("date", lastDay(newest));
    }
    if (months.length > 1) {
      query.set("periods", String(months.length - 1));
      query.set("timeframe", "MONTH");
    }
    query.set("standardLayout", "true");
    const where = `the Xero ${report} report`;
    const got = await xeroGet(
      auth.accessToken,
      tenantId,
      `/api.xro/2.0/Reports/${report}?${query}`,
      where,
      signal,
    );
    if (!got.ok) return got;
    return parseReport(got.value, months, where);
  }

  return {
    meta: xeroMeta,

    async exchangeCode(input: {
      code: string;
      redirectUri: string;
      codeVerifier: string | null;
      query: Record<string, string>;
      client: OAuthClient;
    }): Promise<IntegrationResult<OAuthTokenSet>> {
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
        deps.now(),
        "the Xero token endpoint",
        log,
      );
      if (!token.ok) return token;
      if (token.value.refreshToken === null) {
        return fail(
          "malformed",
          "the Xero token endpoint answered without a refresh token (offline_access missing?)",
        );
      }
      const tenants = await listTenants(token.value.accessToken);
      if (!tenants.ok) {
        // Do not leave an orphaned grant at Xero for a connection the kernel will not store.
        await revokeToken(token.value.refreshToken, input.client);
        return tenants;
      }
      return {
        ok: true,
        value: tokenSet(token.value, tenants.value[0]?.id ?? null, {
          accounts: JSON.stringify(tenants.value),
        }),
      };
    },

    async refresh(input: {
      refreshToken: string;
      client: OAuthClient;
    }): Promise<IntegrationResult<OAuthTokenSet>> {
      const token = await tokenRequest(
        deps.fetch,
        tokenUrl,
        input.client,
        { grant_type: "refresh_token", refresh_token: input.refreshToken },
        deps.now(),
        "the Xero token endpoint",
        log,
      );
      if (!token.ok) return token;
      // Xero rotates refresh tokens (the old one stays usable for a 30-minute grace period only).
      return {
        ok: true,
        value: tokenSet(
          { ...token.value, refreshToken: token.value.refreshToken ?? input.refreshToken },
          null,
        ),
      };
    },

    async revoke(input: { token: string; client: OAuthClient | null }): Promise<void> {
      if (input.client === null) return; // Xero's revocation endpoint needs client authentication.
      await revokeToken(input.token, input.client);
    },

    async verify(auth: IntegrationAuth) {
      const tenantId = auth.externalAccountId;
      if (tenantId === null || !TENANT_ID.test(tenantId)) {
        return fail("not_found", "no Xero organisation is selected");
      }
      const org = await organisation(auth, tenantId);
      if (!org.ok) return org;
      return {
        ok: true as const,
        value: {
          accountLabel: (org.value.name ?? `Xero organisation ${tenantId}`).slice(0, 200),
          externalAccountId: tenantId,
        },
      };
    },

    kpi: {
      metrics: xeroMetrics,
      async read(
        auth: IntegrationAuth,
        req: KpiReadRequest,
      ): Promise<IntegrationResult<KpiReadValue>> {
        const tenantId = auth.externalAccountId;
        if (tenantId === null || !TENANT_ID.test(tenantId)) {
          return fail("not_found", "no Xero organisation is selected");
        }
        const unknown = req.metrics.find((m) => !METRIC_KEYS.has(m));
        if (unknown !== undefined) return fail("not_found", `unknown Xero metric "${unknown}"`);
        const months = requestedMonths(req.fromMonth, req.toMonth, deps.now());
        if (months === null) return fail("malformed", "the requested month range is invalid");
        const wanted = [...new Set(req.metrics)] as Metric[];
        if (months.length === 0) {
          return {
            ok: true,
            value: { currency: null, series: wanted.map((metric) => ({ metric, points: [] })) },
          };
        }
        const needPl = wanted.some((m) => m !== "cash");
        const needBs = wanted.includes("cash");
        const kinds: ReportKind[] = [
          ...(needPl ? (["ProfitAndLoss"] as const) : []),
          ...(needBs ? (["BalanceSheet"] as const) : []),
        ];
        const groups = planGroups(months);
        const planned = 1 + groups.length * kinds.length;
        if (planned > MAX_PAGES) {
          return fail("too_large", `the request needs ${planned} Xero calls (cap ${MAX_PAGES})`);
        }

        const org = await organisation(auth, tenantId, req.signal);
        if (!org.ok) return org;
        let calls = 1;
        const values = new Map<Metric, Map<string, Dec>>(wanted.map((m) => [m, new Map()]));
        const record = (kind: ReportKind, report: ParsedReport, verified: Ym[]): Failure | null => {
          const metrics =
            kind === "BalanceSheet" ? (["cash"] as Metric[]) : wanted.filter((m) => m !== "cash");
          for (const metric of metrics) {
            const picked = pick(report, metric, verified);
            if (!picked.ok) return picked;
            for (const [month, value] of picked.value) values.get(metric)?.set(month, value);
          }
          return null;
        };
        for (const kind of kinds) {
          const retry: Ym[] = [];
          for (const group of groups) {
            calls += 1;
            const report = await readReport(auth, tenantId, kind, group, req.signal);
            if (!report.ok) return report;
            const columns = report.value.columns;
            const verified = group.filter((ym) => columns.has(formatMonth(ym)));
            retry.push(...group.filter((ym) => !columns.has(formatMonth(ym))));
            const failed = record(kind, report.value, verified);
            if (failed !== null) return failed;
          }
          // Columns whose header did not prove a whole calendar month: ask for each month alone.
          for (const ym of retry) {
            const month = formatMonth(ym);
            calls += 1;
            if (calls > MAX_PAGES) {
              return fail(
                "too_large",
                `re-reading ${month} on its own would exceed ${MAX_PAGES} Xero calls`,
              );
            }
            log?.("integration.xero.month_rerequested", { report: kind, month });
            const report = await readReport(auth, tenantId, kind, [ym], req.signal);
            if (!report.ok) return report;
            if (!report.value.columns.has(month)) {
              return fail(
                "malformed",
                `the Xero ${kind} column for ${month} does not cover the whole month (its header does not end on the month's last day)`,
              );
            }
            const failed = record(kind, report.value, [ym]);
            if (failed !== null) return failed;
          }
        }
        return {
          ok: true,
          value: {
            currency: org.value.currency,
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
const _factory: IntegrationAdapterFactory = createXeroAdapter;
void _factory;

/** Reads one claim from a JWT payload WITHOUT verifying it — used only to order a list. */
function jwtClaim(token: string, claim: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length > 8192) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const value = isRecord(payload) ? payload[claim] : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

// ── report parsing ──────────────────────────────────────────────────────────────────────────

interface Line {
  kind: "Row" | "SummaryRow";
  label: string;
  section: string;
  cells: unknown[];
}

interface ParsedReport {
  /**
   * month (YYYY-MM) → index into a line's Cells, ONLY for columns proven to cover the whole
   * calendar month (see `parseReport`). Months missing here must be re-read one at a time.
   */
  columns: Map<string, number>;
  lines: Line[];
}

type ReportKind = "ProfitAndLoss" | "BalanceSheet";

/**
 * Request groups, newest first. Xero derives comparison periods from the anchor's DAY NUMBER, so
 * a multi-month request is anchored only on a 31-day month (an anchor on the 30th cuts every
 * 31-day comparison month short, a February anchor up to three days of every month); any other
 * month is requested alone. The columns are still validated — see `parseReport`.
 */
function planGroups(months: readonly Ym[]): Ym[][] {
  const groups: Ym[][] = [];
  let end = months.length - 1;
  while (end >= 0) {
    const anchor = months[end];
    if (anchor === undefined) break;
    const size = daysInMonth(anchor) === 31 ? Math.min(MONTHS_PER_REQUEST, end + 1) : 1;
    groups.push(months.slice(end - size + 1, end + 1));
    end -= size;
  }
  return groups;
}

const HEADER_DATE = /^(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?[\s-]+(\d{2}|\d{4})$/u;

/** "31 Aug 2026" → {ym: 2026-08, day: 31}; "Aug 2026" → day null. */
function headerDate(raw: unknown): { ym: Ym; day: number | null } | null {
  if (typeof raw !== "string") return null;
  const match = HEADER_DATE.exec(raw.trim());
  if (match === null) return null;
  const month = monthFromName(match[2] ?? "");
  if (month === null) return null;
  const day = match[1] === undefined ? null : Number(match[1]);
  return { ym: { year: fullYear(match[3] ?? ""), month }, day };
}

function cellValue(cell: unknown): unknown {
  return isRecord(cell) ? cell["Value"] : undefined;
}

/**
 * Column → month mapping, trusting a column only when it provably covers a whole month:
 * - its header names a day and that day is the month's last day ("31 Aug 2026", "28 Feb 2026");
 *   "30 Aug 2026" is a truncated period and is refused;
 * - or the request asked for that single month (explicit `fromDate`/`toDate`, or `date`), so a
 *   header without a day ("Aug 2026") or one unlabelled column is that month by construction.
 * Refused or unknown columns are absent from `columns`; the caller re-reads those months singly.
 */
function parseReport(
  body: Record<string, unknown> | unknown[],
  months: readonly Ym[],
  where: string,
): { ok: true; value: ParsedReport } | Failure {
  const reports = isRecord(body) ? body["Reports"] : undefined;
  const report: unknown = Array.isArray(reports) ? reports[0] : undefined;
  if (!isRecord(report) || !Array.isArray(report["Rows"])) {
    return fail("malformed", `${where} has no Reports[0].Rows`);
  }
  const rows = report["Rows"] as unknown[];
  const header = rows.find((r) => isRecord(r) && r["RowType"] === "Header");
  const headerCells =
    isRecord(header) && Array.isArray(header["Cells"]) ? (header["Cells"] as unknown[]) : null;
  if (headerCells === null) return fail("malformed", `${where} has no Header row`);

  const expected = new Set(months.map(formatMonth));
  const single = months.length === 1;
  const columns = new Map<string, number>();
  const labels = headerCells.slice(1).map((cell) => headerDate(cellValue(cell)));
  labels.forEach((label, i) => {
    if (label === null) return;
    const month = formatMonth(label.ym);
    if (!expected.has(month) || columns.has(month)) return;
    const whole = label.day === null ? single : label.day === daysInMonth(label.ym);
    if (whole) columns.set(month, i + 1);
  });
  const only = months[0];
  const unlabelledSingle =
    single && only !== undefined && labels.length === 1 && labels[0] === null;
  if (unlabelledSingle) columns.set(formatMonth(only), 1);

  const lines: Line[] = [];
  const walk = (list: unknown[], section: string, depth: number): boolean => {
    if (depth > 8) return false;
    for (const row of list) {
      if (!isRecord(row)) continue;
      const type = row["RowType"];
      if (type === "Section") {
        const title = typeof row["Title"] === "string" ? row["Title"] : "";
        const nested = row["Rows"] ?? [];
        if (!Array.isArray(nested)) return false;
        if (!walk(nested, title, depth + 1)) return false;
      } else if (type === "Row" || type === "SummaryRow") {
        if (!Array.isArray(row["Cells"])) return false;
        const cells = row["Cells"] as unknown[];
        const label = cellValue(cells[0]);
        lines.push({
          kind: type,
          label: typeof label === "string" ? label.trim() : "",
          section: section.trim(),
          cells,
        });
      }
    }
    return true;
  };
  if (!walk(rows, "", 0))
    return fail("malformed", `${where} has a section or row of the wrong shape`);
  // An unlabelled single column is only trusted when every line really has one value cell.
  if (unlabelledSingle && lines.some((line) => line.cells.length !== 2)) columns.clear();
  return { ok: true, value: { columns, lines } };
}

const REVENUE_TOTAL = /^total\s+(trading\s+)?(income|revenue|turnover|sales)$/iu;
const REVENUE_SECTION = /^(trading\s+)?(income|revenue|turnover|sales)$/iu;
const EXPENSES_TOTAL =
  /^total\s+(operating\s+expenses|expenses|overheads|administrative\s+(costs|expenses))$/iu;
const EXPENSES_SECTION =
  /^(less\s+)?(operating\s+expenses|expenses|overheads|administrative\s+(costs|expenses))$/iu;
const NET = /^net\s+(profit|income|loss)(\s*\/\s*\(?loss\)?)?$/iu;
const BANK_TOTAL = /^total\s+(bank|cash\s+and\s+cash\s+equivalents|bank\s+accounts)$/iu;
const BANK_SECTION = /^(bank|bank\s+accounts|cash\s+and\s+cash\s+equivalents)$/iu;

function findLine(
  report: ParsedReport,
  metric: Metric,
): { line: Line; negate: boolean } | undefined {
  const lines = report.lines;
  const summaryOf = (section: RegExp) =>
    lines.find((l) => l.kind === "SummaryRow" && section.test(l.section));
  let line: Line | undefined;
  switch (metric) {
    case "revenue":
      line =
        lines.find((l) => l.kind === "SummaryRow" && REVENUE_TOTAL.test(l.label)) ??
        summaryOf(REVENUE_SECTION);
      break;
    case "expenses":
      line =
        lines.find((l) => l.kind === "SummaryRow" && EXPENSES_TOTAL.test(l.label)) ??
        summaryOf(EXPENSES_SECTION);
      break;
    case "net_income":
      line = lines.find((l) => NET.test(l.label));
      break;
    case "cash":
      line =
        lines.find((l) => l.kind === "SummaryRow" && BANK_TOTAL.test(l.label)) ??
        summaryOf(BANK_SECTION);
      break;
  }
  if (line === undefined) return undefined;
  // "Net Loss" spelled out with a positive figure is a loss; "Net Profit" carries its own sign.
  const negate = metric === "net_income" && /^net\s+loss$/iu.test(line.label);
  return { line, negate };
}

function pick(
  report: ParsedReport,
  metric: Metric,
  months: readonly Ym[],
): { ok: true; value: Map<string, Dec> } | Failure {
  const out = new Map<string, Dec>();
  const found = findLine(report, metric);
  if (found === undefined) {
    // An organisation with nothing booked yet answers only the header and empty sections.
    if (metric === "net_income" && report.lines.length > 0) {
      return fail("malformed", "the Xero Profit and Loss report has no Net Profit line");
    }
    for (const ym of months) out.set(formatMonth(ym), ZERO);
    return { ok: true, value: out };
  }
  for (const ym of months) {
    const month = formatMonth(ym);
    const index = report.columns.get(month);
    if (index === undefined) return fail("malformed", `the Xero report has no column for ${month}`);
    const value = parseCell(cellValue(found.line.cells[index]));
    if (value === null)
      return fail("malformed", `the Xero ${metric} value for ${month} is not a plain decimal`);
    out.set(month, found.negate ? negateDec(value) : value);
  }
  return { ok: true, value: out };
}
