import { expectedRecords } from "@fundroom/custom-domains";
import type {
  CustomDomainProviderPort,
  CustomDomainProviderStatus,
  DnsInstruction,
  OutboundFetch,
  ProviderCallContext,
  RateLimiterPort,
  SubProcessorMeta,
} from "@fundroom/ports";

/**
 * E3.11: Cloudflare for SaaS terminates TLS for customers' custom domains and proxies their
 * traffic through its global edge, so where a request is processed depends on where the visitor
 * is — `varies`, never a single country.
 */
export const CLOUDFLARE_SAAS_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Cloudflare, Inc.",
  purpose: "Custom domains: TLS certificates and proxying of portal traffic (Cloudflare for SaaS)",
  dataProcessed:
    "Traffic to the workspace's custom domain in transit: visitor IP addresses, request metadata and page content",
  location: "Global edge network (the data centre nearest each visitor)",
  jurisdiction: "varies",
  dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/",
};

/*
 * `@fundroom/domain-cloudflare-saas` (E3.10, ADR-0058). Cloudflare for SaaS custom hostnames:
 * Cloudflare terminates TLS for the customer's hostname and forwards to our origin, so the
 * certificate is Cloudflare's to issue and ours only to ask for.
 *
 * The order is the security property. Our `_fundroom-challenge` TXT (and the CNAME) prove
 * control of the name BEFORE `activate` is ever called — `@fundroom/custom-domains` calls it on
 * `pending → dns_ok` only — so Cloudflare is never asked to issue for a hostname nobody proved
 * they own. `status` then maps the custom hostname's `status` + `ssl.status` to
 * pending/active/failed (both `active` = active, the documented readiness rule), and the domain
 * stays `dns_ok` until it says `active`.
 *
 * Wire facts (e310-vendors §2): create is idempotent here because a 409 (codes 1406/1439) is
 * answered by looking the hostname up with `?hostname.exact=` (paged through `result_info`) and
 * adopting that row; `moved`, `deleted` and the `*blocked` states are failures; the API allows
 * 1 200 requests per 5 minutes per user and a 429 blocks every call for the next five minutes, so
 * a 429 opens a local breaker until `retry-after` and every call before then fails fast WITHOUT a
 * request (the verify sweep moves on to its next row rather than sleeping or hammering a blocked
 * API).
 *
 * Cloudflare's id for the custom hostname is the `ref` (E3.10 FR1): `activate` returns it, the
 * caller stores it, and `status` / `deactivate` then address the hostname by id — one GET or
 * DELETE, no search. A search is only the fallback for a caller with no id (a row registered
 * before ids were stored, or a create answered 409), and a search that finds nothing is
 * "unknown": it throws rather than reporting `failed`, because a listing that has not caught up
 * with a create (or a filter this code misread) is not Cloudflare saying the hostname is gone.
 * By id, a 404 IS authoritative (Cloudflare deletes a hostname a week after it went `moved`), so
 * that one is `failed`.
 *
 * Every request first takes a token from an install-wide budget (`CLOUDFLARE_CALL_BUDGET`, 900
 * per 5 minutes: three quarters of Cloudflare's per-user limit, the rest left for the operator's
 * own tooling on the same token). The budget lives in the shared Postgres rate limiter when one is
 * passed, so every process of the install draws from the same bucket; an exhausted budget is a
 * local rate limit, answered exactly like a 429 but without sending anything.
 *
 * Two sub-budgets sit in front of it (E3.10 FR3), checked first: a call made for a workspace draws
 * on that workspace's own 60 per 5 minutes (`CLOUDFLARE_WORKSPACE_BUDGET`), so one tenant cannot
 * spend the install's share, and an `interactive` call (an admin's "Verify now") also draws on
 * `CLOUDFLARE_INTERACTIVE_BUDGET` (600), so admin traffic can never take the last 300 tokens the
 * background verify sweep and release job depend on. A call refused by an inner bucket may still
 * have been counted by an outer one; that only errs towards calling Cloudflare less.
 */

export interface CloudflareSaasDeps {
  /** A guarded outbound fetch: 5 s, 1 MiB, no redirects. */
  readonly fetch: OutboundFetch;
  /** `CLOUDFLARE_API_BASE`. */
  readonly apiBase: string;
  readonly apiToken: string;
  readonly zoneId: string;
  /** What customers CNAME to (`CUSTOM_DOMAIN_CNAME_TARGET`, else the canonical host). */
  readonly cnameTarget: string;
  /** Test seam for the 429 breaker. */
  readonly now?: (() => Date) | undefined;
  /**
   * Where the install-wide call budget is kept (`container.rateLimiter`, Postgres). Absent: an
   * in-process window of the same size (unit tests, a single-process install).
   */
  readonly rateLimiter?: Pick<RateLimiterPort, "hit"> | undefined;
}

/** Cloudflare's conflict codes for "that hostname already exists on the zone". */
export const CLOUDFLARE_DUPLICATE_CODES: readonly number[] = [1406, 1439];

/** When a 429 carries no usable `retry-after`: Cloudflare blocks for five minutes. */
export const CLOUDFLARE_DEFAULT_RETRY_AFTER_MS = 5 * 60_000;
/** Ceiling on a `retry-after` we honour, so a garbage header cannot park the driver for days. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
/**
 * The install-wide budget for Cloudflare API requests: 900 per 5 minutes, against Cloudflare's
 * 1 200 per 5 minutes per user (e310-vendors §2.8). Every request counts, a search page included.
 */
export const CLOUDFLARE_CALL_BUDGET = { max: 900, windowMs: 5 * 60_000 } as const;
/** The rate-limiter key the budget is kept under (hashed by the limiter; not PII). */
export const CLOUDFLARE_BUDGET_KEY = "domains:cloudflare-saas:api";
/** Per workspace, checked before the install's (FR3). */
export const CLOUDFLARE_WORKSPACE_BUDGET = { max: 60, windowMs: 5 * 60_000 } as const;
export function cloudflareWorkspaceBudgetKey(workspaceId: string): string {
  return `domains:cloudflare-saas:ws:${workspaceId}`;
}
/**
 * Interactive calls' ceiling inside the install's 900: the other 300 are only ever spent by the
 * background sweep / release job, which therefore always has tokens left (FR3).
 */
export const CLOUDFLARE_INTERACTIVE_BUDGET = { max: 600, windowMs: 5 * 60_000 } as const;
export const CLOUDFLARE_INTERACTIVE_BUDGET_KEY = "domains:cloudflare-saas:interactive";
/**
 * Search page size, and how many pages one search may read. An exact filter answers in one page;
 * the cap only matters if Cloudflare ever ignored the filter, and then a search that ran out of
 * pages throws ("unknown") instead of reporting the hostname absent.
 */
const SEARCH_PER_PAGE = 50;
const SEARCH_MAX_PAGES = 20;
/** Operator-facing sentences are clamped; `custom_domain.last_detail` CHECKs 1 000. */
const DETAIL_MAX = 300;

/**
 * A Cloudflare API failure. Its message is built from Cloudflare's own `errors[].message` and
 * the HTTP status — never from the request, so it can never carry the API token.
 */
export class CloudflareApiError extends Error {
  override readonly name = "CloudflareApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly codes: readonly number[],
    /** Set on a 429 (or a call refused by the open breaker): when calling again is allowed. */
    readonly retryAfterMs?: number | undefined,
  ) {
    super(message);
  }
  get rateLimited(): boolean {
    return this.retryAfterMs !== undefined;
  }
}

/** The fields of a custom hostname we read (e310-vendors §2.3). Everything else is ignored. */
interface CustomHostname {
  readonly id: string;
  readonly hostname: string;
  readonly status?: string | undefined;
  readonly verification_errors?: readonly string[] | undefined;
  readonly ownership_verification?:
    | { readonly type?: string; readonly name?: string; readonly value?: string }
    | undefined;
  readonly ssl?:
    | {
        readonly status?: string | undefined;
        readonly validation_records?:
          | readonly { readonly txt_name?: string; readonly txt_value?: string }[]
          | undefined;
        readonly validation_errors?: readonly { readonly message?: string }[] | undefined;
      }
    | undefined;
}

interface Envelope<T> {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: T | null;
  readonly result_info?: { readonly page?: number; readonly total_pages?: number } | undefined;
}

/** Hostname states that serve traffic. `active_redeploying` is active with a change applied. */
const HOSTNAME_ACTIVE = new Set([
  "active",
  "active_redeploying",
  "test_active",
  "test_active_apex",
]);
/**
 * Hostname states that will not become active on their own. `moved` = not pointing at the
 * fallback origin after the whole validation backoff (7 days); `deleted` follows a week in
 * `moved`; the `*blocked` states are Cloudflare refusing the name.
 */
const HOSTNAME_FAILED = new Set([
  "moved",
  "deleted",
  "pending_deletion",
  "blocked",
  "pending_blocked",
  "test_blocked",
  "test_failed",
]);
/** Certificate states that will not become active without a retry (a PATCH / re-create). */
const SSL_FAILED = new Set([
  "initializing_timed_out",
  "validation_timed_out",
  "issuance_timed_out",
  "deployment_timed_out",
  "deletion_timed_out",
  "expired",
  "deleted",
  "pending_deletion",
  "deactivating",
  "inactive",
]);

function clamp(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/** `retry-after` as delta-seconds or an HTTP date; `undefined` when absent or unusable. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/**
 * Cloudflare's own view of a custom hostname, as the port's pending/active/failed.
 * Exported for tests: the mapping is the part most worth pinning down.
 */
export function mapCustomHostname(row: CustomHostname): CustomDomainProviderStatus {
  const status = row.status ?? "pending";
  const ssl = row.ssl?.status ?? "initializing";
  const records = recordsOf(row);
  const ref = typeof row.id === "string" && row.id !== "" ? { ref: row.id } : {};
  if (HOSTNAME_FAILED.has(status)) {
    return {
      state: "failed",
      detail: clamp(`Cloudflare reports the custom hostname as ${status.replaceAll("_", " ")}.`),
      records,
      ...ref,
    };
  }
  if (SSL_FAILED.has(ssl)) {
    return {
      state: "failed",
      detail: clamp(`Cloudflare's certificate for it is ${ssl.replaceAll("_", " ")}.`),
      records,
      ...ref,
    };
  }
  if (HOSTNAME_ACTIVE.has(status) && ssl === "active") {
    return { state: "active", detail: null, records: [], ...ref };
  }
  // Pending: say what Cloudflare is waiting on, in its own words when it gave any.
  const why =
    row.verification_errors?.find((e) => e.trim() !== "") ??
    row.ssl?.validation_errors?.find((e) => (e.message ?? "").trim() !== "")?.message;
  const base = `Cloudflare is setting it up (hostname ${status.replaceAll("_", " ")}, certificate ${ssl.replaceAll("_", " ")}).`;
  return {
    state: "pending",
    detail: clamp(why === undefined ? base : `${base} ${why}`),
    records,
    ...ref,
  };
}

/**
 * Cloudflare's ownership and certificate-validation TXT records, for the admin screen.
 *
 * `required: false` on purpose: with the CNAME in place (which our own verification already
 * established) Cloudflare validates by traffic and HTTP DCV on its own, so these are the
 * alternative path for a customer who cannot wait, or whose zone blocks HTTP validation — never
 * something our verdict gates on. Omitted once the part they validate is active.
 */
function recordsOf(row: CustomHostname): DnsInstruction[] {
  const out: DnsInstruction[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined, value: string | undefined) => {
    if (name === undefined || value === undefined || name === "" || value === "") return;
    const key = `${name.toLowerCase()} ${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type: "TXT", name, value, required: false });
  };
  const own = row.ownership_verification;
  if (!HOSTNAME_ACTIVE.has(row.status ?? "") && (own?.type ?? "txt").toLowerCase() === "txt") {
    push(own?.name, own?.value);
  }
  if (row.ssl?.status !== "active") {
    for (const r of row.ssl?.validation_records ?? []) push(r.txt_name, r.txt_value);
  }
  return out;
}

/** `status` is always present on this provider, which is what makes the verify job poll it. */
export type CloudflareSaasProvider = CustomDomainProviderPort &
  Required<Pick<CustomDomainProviderPort, "status">>;

/** The Cloudflare for SaaS provider. */
export function createCloudflareSaasProvider(deps: CloudflareSaasDeps): CloudflareSaasProvider {
  const now = deps.now ?? (() => new Date());
  const base = `${deps.apiBase.replace(/\/+$/u, "")}/zones/${encodeURIComponent(deps.zoneId)}/custom_hostnames`;
  /** The 429 breaker: epoch ms before which no request is sent. */
  let blockedUntil = 0;
  const budget = deps.rateLimiter ?? createLocalBudget(now);

  /** Draws one token from each bucket that applies, innermost first; throws when one is dry. */
  async function charge(context: ProviderCallContext | undefined): Promise<void> {
    const buckets: [string, { max: number; windowMs: number }, string][] = [];
    if (context?.workspaceId !== undefined) {
      buckets.push([
        cloudflareWorkspaceBudgetKey(context.workspaceId),
        CLOUDFLARE_WORKSPACE_BUDGET,
        "this workspace's Cloudflare call budget",
      ]);
    }
    if (context?.priority === "interactive") {
      buckets.push([
        CLOUDFLARE_INTERACTIVE_BUDGET_KEY,
        CLOUDFLARE_INTERACTIVE_BUDGET,
        "the install's Cloudflare budget for interactive calls",
      ]);
    }
    buckets.push([
      CLOUDFLARE_BUDGET_KEY,
      CLOUDFLARE_CALL_BUDGET,
      "the install's Cloudflare call budget",
    ]);
    for (const [key, rule, what] of buckets) {
      const token = await budget.hit(key, rule);
      if (!token.allowed) {
        throw new CloudflareApiError(
          `${what} is used up: waiting before calling the API again`,
          429,
          [],
          Math.max(1, token.retryAfterMs),
        );
      }
    }
  }

  /**
   * The budget step for one method invocation: charges every request, except the first one when
   * `admit` already paid for it (`context.admitted`).
   */
  function payer(context: ProviderCallContext | undefined): () => Promise<void> {
    let prepaid = context?.admitted === true;
    return async () => {
      if (prepaid) {
        prepaid = false;
        return;
      }
      await charge(context);
    };
  }

  async function call<T>(
    pay: () => Promise<void>,
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<{
    status: number;
    result: T | null;
    codes: number[];
    info: Envelope<T>["result_info"];
  }> {
    const at = now().getTime();
    if (at < blockedUntil) {
      throw new CloudflareApiError(
        "Cloudflare rate limit: waiting before calling the API again",
        429,
        [],
        blockedUntil - at,
      );
    }
    // The budgets, before the request: over any of them, nothing is sent.
    await pay();
    const response = await deps.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${deps.apiToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 429) {
      await response.body?.cancel();
      const wait = Math.min(
        parseRetryAfter(response.headers.get("retry-after"), now()) ??
          CLOUDFLARE_DEFAULT_RETRY_AFTER_MS,
        MAX_RETRY_AFTER_MS,
      );
      blockedUntil = now().getTime() + wait;
      throw new CloudflareApiError(
        `Cloudflare rate limit (429): retrying in ${Math.ceil(wait / 1000)} s`,
        429,
        [],
        wait,
      );
    }
    let envelope: Envelope<T> | undefined;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
    const codes = errors.map((e) => e.code).filter((c): c is number => typeof c === "number");
    const ok = response.ok && envelope !== undefined && envelope.success !== false;
    if (!ok) {
      const said = errors
        .map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim())
        .filter((m) => m !== "")
        .join("; ");
      throw new CloudflareApiError(
        clamp(
          `Cloudflare API ${method} failed (${response.status})${said === "" ? "" : `: ${said}`}`,
        ),
        response.status,
        codes,
      );
    }
    return {
      status: response.status,
      result: envelope?.result ?? null,
      codes,
      info: envelope?.result_info,
    };
  }

  /**
   * Exact-hostname search (`hostname.exact`, e310-vendors §2.1), paged through `result_info`
   * until the row turns up. The match is re-checked here as well: a filter this code misreads
   * must widen the search, never adopt somebody else's hostname.
   */
  async function find(
    pay: () => Promise<void>,
    hostname: string,
  ): Promise<CustomHostname | undefined> {
    const want = hostname.toLowerCase();
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const url = `${base}?hostname.exact=${encodeURIComponent(hostname)}&per_page=${SEARCH_PER_PAGE}&page=${page}`;
      const { result, info } = await call<CustomHostname[]>(pay, "GET", url);
      const rows = Array.isArray(result) ? result : [];
      const hit = rows.find((r) => r.hostname?.toLowerCase() === want);
      if (hit !== undefined) return hit;
      const pages = typeof info?.total_pages === "number" ? info.total_pages : 1;
      if (rows.length === 0 || page >= pages) return undefined;
    }
    throw new CloudflareApiError(
      `Cloudflare search for the hostname did not finish within ${SEARCH_MAX_PAGES} pages`,
      0,
      [],
    );
  }

  /** One custom hostname by Cloudflare id; `undefined` on a 404 (it is gone). */
  async function byId(pay: () => Promise<void>, ref: string): Promise<CustomHostname | undefined> {
    try {
      const { result } = await call<CustomHostname>(
        pay,
        "GET",
        `${base}/${encodeURIComponent(ref)}`,
      );
      return result ?? undefined;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  function isDuplicate(error: unknown): boolean {
    return (
      error instanceof CloudflareApiError &&
      (error.status === 409 || error.codes.some((c) => CLOUDFLARE_DUPLICATE_CODES.includes(c)))
    );
  }

  return {
    driver: "cloudflare-saas",
    subProcessor: CLOUDFLARE_SAAS_SUB_PROCESSOR,
    // Both: the TXT is the proof of control that must precede asking Cloudflare to issue, and the
    // CNAME is what makes traffic (and therefore HTTP DCV) reach Cloudflare at all.
    requires: { cname: true, txt: true },

    admit: charge,

    async activate(hostname, context) {
      const pay = payer(context);
      let row: CustomHostname | undefined;
      try {
        const created = await call<CustomHostname>(pay, "POST", base, {
          hostname,
          // `http`: activate runs only after our verification saw the CNAME (or a flattened apex)
          // pointing at the SaaS target, so Cloudflare can serve the CA's HTTP token itself. The
          // TXT alternative is surfaced as optional records either way.
          ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
        });
        row = created.result ?? undefined;
      } catch (error) {
        // Idempotent: a retried activation, or a hostname left behind by an earlier run.
        if (!isDuplicate(error)) throw error;
        row = await find(pay, hostname);
        if (row === undefined) throw error;
      }
      return {
        records: row === undefined ? [] : recordsOf(row),
        ...(typeof row?.id === "string" && row.id !== "" ? { ref: row.id } : {}),
      };
    },

    async status(hostname, ref, context) {
      const pay = payer(context);
      if (ref !== undefined && ref !== "") {
        const row = await byId(pay, ref);
        if (row === undefined) {
          // By id, a 404 is Cloudflare's own answer: the hostname was deleted (a week after it
          // went `moved`, or by hand). An admin retry re-registers it.
          return {
            state: "failed",
            detail:
              "Cloudflare has no custom hostname for this domain any more (it may have been deleted after failing validation).",
            records: [],
          };
        }
        return mapCustomHostname(row);
      }
      const row = await find(pay, hostname);
      if (row === undefined) {
        // A search that found nothing is not a verdict: "unknown", which the caller records as a
        // failed call and asks again later — never a failure of the domain.
        throw new CloudflareApiError(
          "Cloudflare did not list a custom hostname for this domain yet",
          404,
          [],
        );
      }
      return mapCustomHostname(row);
    },

    async deactivate(hostname, ref, context) {
      const pay = payer(context);
      const id = ref !== undefined && ref !== "" ? ref : (await find(pay, hostname))?.id;
      if (id === undefined) return;
      try {
        await call(pay, "DELETE", `${base}/${encodeURIComponent(id)}`);
      } catch (error) {
        // Already gone (a concurrent removal, or Cloudflare's own clean-up) is the goal state.
        if (error instanceof CloudflareApiError && error.status === 404) return;
        throw error;
      }
    },

    instructions({ hostname, token }): readonly DnsInstruction[] {
      // Our two records, from the one place that names the TXT label: this used to spell the
      // label out by hand, which is how a rename leaves one provider showing the old record.
      return expectedRecords({ hostname, token, cnameTarget: deps.cnameTarget });
    },
  };
}

/**
 * The in-process stand-in for the shared budget: the same fixed window, counted in memory. Only
 * for a caller that passed no rate limiter (unit tests); the server always passes the Postgres
 * one so the budget is the install's, not the process's.
 */
function createLocalBudget(now: () => Date): Pick<RateLimiterPort, "hit"> {
  const windows = new Map<string, { start: number; used: number }>();
  return {
    hit(key, rule) {
      const at = now().getTime();
      let w = windows.get(key);
      if (w === undefined || at - w.start >= rule.windowMs) {
        w = { start: at, used: 0 };
        windows.set(key, w);
      }
      if (w.used >= rule.max) {
        return Promise.resolve({
          allowed: false,
          remaining: 0,
          retryAfterMs: w.start + rule.windowMs - at,
        });
      }
      w.used++;
      return Promise.resolve({ allowed: true, remaining: rule.max - w.used, retryAfterMs: 0 });
    },
  };
}
