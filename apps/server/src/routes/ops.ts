import { timingSafeEqual } from "node:crypto";
import { ApiError, errorResponse } from "@fundroom/contracts";
import { requestHost } from "@fundroom/http";
import { type Counter, metrics } from "@opentelemetry/api";
import { type Context, type Handler, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { addVary, canonicalBaseOf, canonicalPathOf, publicBaseOf } from "../path-mount.js";
import type { Readiness } from "../readiness.js";
import type { Telemetry } from "../telemetry.js";
import { API_VERSION, MIN_EMBED_SDK, SERVER_VERSION } from "../version.js";

/*
 * Operational endpoints outside `/api/v1` (design/07 §5): liveness, readiness, Prometheus
 * metrics, the capability document, security.txt, the CSP report collector. No tenant, no
 * session.
 */
export interface SecurityTxtOptions {
  /** Config `SECURITY_TXT`; false answers 404. */
  readonly enabled: boolean;
  /** Config `SECURITY_TXT_CONTACT` (mailto:/https: URIs); unset → the project's own. */
  readonly contact?: readonly string[] | undefined;
  /** Config `SECURITY_TXT_POLICY` (https URL); unset → the project's SECURITY.md. */
  readonly policy?: string | undefined;
  /**
   * BASE_URL; `Canonical` is BASE_URL (its path included, E3.9 §2) + `/.well-known/security.txt`,
   * and is only written when the file is fetched from that host and base: RFC 9116 §2.5.2 tells readers to distrust a
   * file whose retrieval URI is not listed, so a workspace's custom domain gets no `Canonical`
   * rather than one naming another host (review R2-09).
   */
  readonly baseUrl: URL;
  /** TRUST_PROXY: read the host from `X-Forwarded-Host`. */
  readonly trustProxy?: boolean | undefined;
}

export const SECURITY_TXT_DEFAULT_CONTACT = [
  "mailto:security@fundroom.com",
  "https://github.com/fundroomhq/fundroom/security/advisories/new",
] as const;
export const SECURITY_TXT_DEFAULT_POLICY =
  "https://github.com/fundroomhq/fundroom/blob/main/SECURITY.md";
/** RFC 9116 §2.5.5 recommends an `Expires` less than a year out; it rolls with every request. */
export const SECURITY_TXT_TTL_DAYS = 180;
export interface OpsOptions {
  readonly readiness: Readiness;
  readonly telemetry: Telemetry;
  readonly metricsEnabled: boolean;
  readonly metricsToken: string | undefined;
  readonly tenancy: "single" | "multi";
  readonly features: readonly string[];
  readonly authMethods: readonly ("email_otp" | "magic_link" | "passkey" | "password" | "oidc")[];
  readonly passkeyRpId: string;
  /** BASE_PATH; the public base when no path mount matched (the request's own is preferred). */
  readonly basePath: string;
  readonly log: Log;
  readonly startedAt: number;
  /** Host (with non-default port) of BASE_URL, lower-case; `ask`'s free answer. */
  readonly canonicalHost: string;
  /**
   * Is a certificate allowed for this hostname? True for a `dns_ok` or `active` custom domain
   * (E2.1 decision 3: gating on `active` deadlocks, because the certificate cannot exist before
   * the first handshake).
   *
   * Backed by the bounded, 60-second lookup cache, **which also carries the rate limit** — it
   * counts database reads, globally, and answers "not issuable" once over budget. That is why
   * this route has no limiter of its own; see `LOOKUP_MISS_MAX_PER_WINDOW`.
   */
  readonly issuable: (hostname: string) => Promise<boolean>;
  /** `GET /.well-known/security.txt` (E2.10); absent → 404, as if `SECURITY_TXT=false`. */
  readonly securityTxt?: SecurityTxtOptions | undefined;
  /** Test seam for security.txt `Expires`. */
  readonly now?: (() => number) | undefined;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const CSP_REPORT_MAX_BYTES = 16 * 1024;
const CSP_REPORT_LOG_PER_MINUTE = 60;
/** Distinct (directive, blocked, disposition) label sets before new ones count as `other`. */
export const CSP_LABEL_SETS_MAX = 200;
/** Reports taken from one Reporting API batch (browsers batch; a forged body could be huge). */
const CSP_REPORTS_PER_BODY = 20;

/** One violation, reduced to what an operator needs and nothing that identifies a visitor. */
export interface CspViolation {
  /** `effective-directive` (`style-src-elem`, `require-trusted-types-for`, …). */
  readonly directive: string;
  /** A CSP keyword (`inline`, `eval`, `trusted-types-sink`, …) or origin + path, no query. */
  readonly blockedURI: string;
  /** Path of the page, identifier-shaped segments replaced by `:id`, no query, no fragment. */
  readonly documentURI: string;
  /** Script that caused it: origin + path, no query. Empty when the browser gave none. */
  readonly sourceFile: string;
  readonly disposition: "enforce" | "report" | "unknown";
  /**
   * Trusted Types only: the sink (`Element innerHTML`) or the refused policy name. The rest of
   * the browser's `sample` is the value that was assigned, so it is dropped.
   */
  readonly trustedTypes?: string | undefined;
}

const KEYWORD_RE = /^[a-z][a-z0-9-]{0,39}$/u;
const TT_SAMPLE_RE = /^[A-Za-z][A-Za-z0-9 .-]{0,59}$/u;
const MAX_PATH_SEGMENTS = 8;
/** A uuid, a long hex/base64url token, a number, or anything with an `@`: never logged. */
const IDENTIFIER_SEGMENT_RE = /^(?:[0-9a-f-]{16,}|[A-Za-z0-9_-]{20,}|\d+|.*@.*)$/iu;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function redactPath(pathname: string): string {
  const segments = pathname.split("/").slice(1);
  const kept = segments.slice(0, MAX_PATH_SEGMENTS).map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep the raw segment for the test below
    }
    return IDENTIFIER_SEGMENT_RE.test(decoded) ? ":id" : segment.slice(0, 64);
  });
  return `/${kept.join("/")}${segments.length > MAX_PATH_SEGMENTS ? "/…" : ""}`;
}

/** URL → origin + redacted path; a CSP keyword stays as it is; anything else is `invalid`. */
function uriField(value: string, pathOnly: boolean): string {
  if (value === "") return "";
  if (KEYWORD_RE.test(value) && !value.includes(":")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol.slice(0, -1);
  return pathOnly ? redactPath(url.pathname) : `${url.origin}${redactPath(url.pathname)}`;
}

function blockedLabel(blockedURI: string): string {
  if (blockedURI === "" || !blockedURI.includes("://")) return blockedURI || "none";
  return new URL(blockedURI).origin;
}

function directiveOf(effective: string, violated: string): string {
  const name = (effective || violated.split(" ")[0] || "").toLowerCase();
  return KEYWORD_RE.test(name) ? name : "unknown";
}

function violation(fields: {
  effective: string;
  violated: string;
  blocked: string;
  document: string;
  source: string;
  disposition: string;
  sample: string;
}): CspViolation {
  const directive = directiveOf(fields.effective, fields.violated);
  const tt = directive === "require-trusted-types-for" || directive === "trusted-types";
  const ttSample = tt ? (fields.sample.split("|")[0] ?? "").trim() : "";
  return {
    directive,
    blockedURI: uriField(fields.blocked, false),
    documentURI: uriField(fields.document, true),
    sourceFile: uriField(fields.source, false),
    disposition:
      fields.disposition === "enforce" || fields.disposition === "report"
        ? fields.disposition
        : "unknown",
    ...(tt && TT_SAMPLE_RE.test(ttSample) ? { trustedTypes: ttSample } : {}),
  };
}

/**
 * Both report formats → normalised violations. Anything that is neither (or a Reporting API
 * entry of another `type`) yields nothing: a malformed body is not worth a log line.
 */
export function normalizeCspReports(body: unknown): CspViolation[] {
  if (Array.isArray(body)) {
    const out: CspViolation[] = [];
    for (const entry of body.slice(0, CSP_REPORTS_PER_BODY)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (e["type"] !== "csp-violation") continue;
      const b = (typeof e["body"] === "object" && e["body"] !== null ? e["body"] : {}) as Record<
        string,
        unknown
      >;
      out.push(
        violation({
          effective: str(b["effectiveDirective"]),
          violated: "",
          blocked: str(b["blockedURL"]),
          document: str(b["documentURL"]) || str(e["url"]),
          source: str(b["sourceFile"]),
          disposition: str(b["disposition"]),
          sample: str(b["sample"]),
        }),
      );
    }
    return out;
  }
  if (typeof body !== "object" || body === null) return [];
  const r = (body as Record<string, unknown>)["csp-report"];
  if (typeof r !== "object" || r === null) return [];
  const f = r as Record<string, unknown>;
  return [
    violation({
      effective: str(f["effective-directive"]),
      violated: str(f["violated-directive"]),
      blocked: str(f["blocked-uri"]),
      document: str(f["document-uri"]),
      source: str(f["source-file"]),
      disposition: str(f["disposition"]),
      sample: str(f["script-sample"]),
    }),
  ];
}

/** RFC 9116 body. Pure; `now` in ms. */
export function renderSecurityTxt(
  options: SecurityTxtOptions,
  now: number,
  /** Served on BASE_URL's host and base (write `Canonical`), or elsewhere (omit it). */
  onCanonicalHost = true,
): string {
  const contact =
    options.contact !== undefined && options.contact.length > 0
      ? options.contact
      : SECURITY_TXT_DEFAULT_CONTACT;
  const expires = new Date(now + SECURITY_TXT_TTL_DAYS * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");
  const lines = [
    ...contact.map((uri) => `Contact: ${uri}`),
    `Expires: ${expires}`,
    `Policy: ${options.policy ?? SECURITY_TXT_DEFAULT_POLICY}`,
    "Preferred-Languages: en",
    ...(onCanonicalHost
      ? [`Canonical: ${canonicalBaseOf(options.baseUrl)}/.well-known/security.txt`]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * E3.9 FR1 B3: a base-dependent public document answered through a path mount is `private,
 * no-store` — a host site's CDN may ignore `Vary` and would hand one mount's body to another.
 */
function cacheFor(c: Context<AppEnv>, publicValue: string): string {
  return c.get("pathMount") === undefined ? publicValue : "private, no-store";
}

/** The capability document's path (`GET`, public, cached 5 minutes). */
export const WELL_KNOWN_CAPABILITIES_PATH = "/.well-known/fundroom.json";
/** Its pre-rename path, served by the same handler for one minor release (A-2). */
export const LEGACY_WELL_KNOWN_CAPABILITIES_PATH = "/.well-known/seed-host.json";

export function opsRoutes(options: OpsOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/healthz", (c) => {
    const draining = options.readiness.draining;
    return c.json(
      {
        status: draining ? "draining" : "ok",
        version: SERVER_VERSION,
        uptimeSeconds: Math.floor((Date.now() - options.startedAt) / 1000),
      },
      draining ? 503 : 200,
    );
  });

  app.get("/readyz", async (c) => {
    const { ready, checks } = await options.readiness.run();
    const status = options.readiness.draining ? "draining" : ready ? "ready" : "not_ready";
    return c.json({ status, version: SERVER_VERSION, checks }, ready ? 200 : 503);
  });

  app.get("/metrics", async (c) => {
    if (!options.metricsEnabled)
      return errorResponse(c, new ApiError("not_found", "metrics disabled"));
    if (
      options.metricsToken !== undefined &&
      !tokenMatches(c.req.header("authorization"), options.metricsToken)
    ) {
      return errorResponse(c, new ApiError("unauthenticated", "metrics require a bearer token"));
    }
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.body(await options.telemetry.metricsText());
  });

  /*
   * The capability document. `/.well-known/fundroom.json` is its name; the pre-rename
   * `/.well-known/seed-host.json` (A-2, ADR-0062) is served by the same handler for one minor
   * release so an older reader keeps working, then removed.
   */
  const capabilities: Handler<AppEnv> = (c) => {
    c.header("Cache-Control", cacheFor(c, "public, max-age=300"));
    // `apiBase` is the request's public face (E3.9): a shared cache must key on the mount.
    addVary(c, "X-Forwarded-Prefix");
    return c.json({
      apiVersion: API_VERSION,
      serverVersion: SERVER_VERSION,
      minEmbedSdk: MIN_EMBED_SDK,
      apiBase: `${publicBaseOf(c, options.basePath)}/api/${API_VERSION}`,
      tenancy: options.tenancy,
      features: [...options.features],
      auth: { methods: [...options.authMethods], passkeyRpId: options.passkeyRpId },
    });
  };
  app.get(WELL_KNOWN_CAPABILITIES_PATH, capabilities);
  app.get(LEGACY_WELL_KNOWN_CAPABILITIES_PATH, capabilities);

  /*
   * Caddy on-demand TLS `ask` (design/07 §2.1, ADR-0010, E2.1 §1.11): 200 lets Caddy issue a
   * certificate for `?domain=`, anything else aborts the handshake.
   *
   * This endpoint sits on the TLS handshake path of a request that has not been authenticated
   * and, because the Caddy catch-all block proxies every path to the app, may have arrived from
   * the public internet (the site blocks refuse `/internal/*`, but that is one layer). With a
   * database lookup behind it, it is both a domain-enumeration oracle and an unauthenticated
   * load vector, so it is defended twice over:
   *
   *  1. **The canonical host is answered before anything else** — no cache, no database, no
   *     rate-limit budget spent. That is the overwhelmingly common case on a self-hosted install,
   *     and it must stay free.
   *  2. **A rate limit on the database, not on the caller.** The limiter lives inside the lookup
   *     (`LOOKUP_MISS_MAX_PER_WINDOW`) and counts cache *misses* — the reads that actually reach
   *     Postgres — as one global counter, behind the negative cache. It is deliberately not
   *     `RateLimiterPort`: a Postgres limiter would put a database round trip on the TLS
   *     handshake path in order to protect the database from a round trip on the TLS handshake
   *     path, implementing the very DoS it is meant to prevent.
   *
   *     It is also deliberately **not keyed on the client IP**, which is what this route used to
   *     do (E2.1 S3). Back then `clientIp()` read the *first* `X-Forwarded-For` entry, which
   *     the client writes (E2.10 F-07 changed that to the proxy-written one), so it was
   *     attacker-supplied: one request per spoofed value bought a fresh bucket and the limiter never fired, while every *legitimate* ask shared
   *     one bucket keyed on Caddy's own container IP — so a bot spraying random SNI could spend
   *     real customers' budget and abort their first handshake. A global counter cannot be
   *     inflated by a header, and unique-hostname traffic is then bounded by real database load.
   *
   * Over budget the answer is 404, not 429: Caddy treats any non-2xx as "do not issue", and a 404
   * does not tell a prober they found a rate limit.
   */
  app.get("/internal/tls/ask", async (c) => {
    const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
    const canonical = options.canonicalHost.replace(/:\d+$/u, "");
    // Fast path, ahead of the cache and the lookup: a string compare that cannot fail.
    if (domain !== "" && domain === canonical) return c.body(null, 200);
    if (domain === "") return c.body(null, 404);
    // A lookup failure is not a reason to hand out a certificate for somebody else's hostname.
    const ok = await options.issuable(domain).catch((error: unknown) => {
      options.log("tls.ask_failed", { level: "error", domain, error: String(error) });
      return false;
    });
    return c.body(null, ok ? 200 : 404);
  });

  app.get("/.well-known/security.txt", (c) => {
    const txt = options.securityTxt;
    if (txt === undefined || !txt.enabled) {
      return errorResponse(c, new ApiError("not_found", "security.txt disabled"));
    }
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", cacheFor(c, "public, max-age=86400"));
    addVary(c, "X-Forwarded-Prefix");
    // The file's public location must be the one `Canonical` names: BASE_URL's host AND base. A
    // mounted request's host is the mount's (from config), never a forwarded header.
    const mount = c.get("pathMount");
    const host = (
      mount === undefined ? requestHost(c, txt.trustProxy ?? false) : new URL(mount.origin).host
    ).replace(/:\d+$/u, "");
    const onCanonicalHost =
      host === txt.baseUrl.hostname.toLowerCase() &&
      publicBaseOf(c, options.basePath) === canonicalPathOf(txt.baseUrl);
    return c.body(renderSecurityTxt(txt, (options.now ?? Date.now)(), onCanonicalHost));
  });

  // RFC 9116 §3: the file lives under /.well-known/, but a client may try the root first; the
  // legacy location redirects rather than serving a second copy (one Canonical, one answer).
  app.get("/security.txt", (c) => {
    const txt = options.securityTxt;
    if (txt === undefined || !txt.enabled) {
      return errorResponse(c, new ApiError("not_found", "security.txt disabled"));
    }
    c.header("Cache-Control", cacheFor(c, "public, max-age=86400"));
    addVary(c, "X-Forwarded-Prefix");
    return c.redirect(`${publicBaseOf(c, options.basePath)}/.well-known/security.txt`, 301);
  });

  /*
   * CSP / Reporting API collector (E0.5 `cspReportUri`, hardened in E2.10). Browsers post two
   * shapes here: the legacy `report-uri` body (`application/csp-report`, one report) and the
   * Reporting API's (`application/reports+json`, an array, from `report-to csp`). Both are
   * reduced to the same five fields by `normalizeCspReport`, which keeps no query string, no
   * fragment, no script sample and no identifier-shaped path segment — a report is
   * browser-generated from the visitor's URL, so it carries whatever that URL carried (a share
   * token, an email in `/login/verify?email=`), and none of that belongs in a log.
   *
   * Every normalised report increments `fundroom.csp.violations{directive, blocked,
   * disposition}` — the aggregate an operator reads (docs/runbooks/csp-reports.md). Anyone can
   * post here, so the label values are bounded: `blocked` is an origin or a CSP keyword, and
   * after `CSP_LABEL_SETS_MAX` distinct label sets every new one is counted as `other`. The
   * log line is capped at 60 a minute **for the whole process**, never per client: anyone can
   * post here from as many addresses as they like, so a per-IP budget bounds nothing (E2.1
   * lesson; the client address itself is now the proxy-written entry, E2.10 F-07).
   * The answer is always 204 (413 once the body passes 16 KiB, checked as it streams, so an
   * oversized or endless chunked body is never buffered): nothing here is an oracle.
   */
  const violations: Counter = metrics
    .getMeter("fundroom.csp")
    .createCounter("fundroom.csp.violations", {
      description: "CSP violation reports received, by directive, blocked origin and disposition",
    });
  const labelSets = new Set<string>();
  let window = 0;
  let count = 0;
  app.post(
    "/csp-report",
    // Enforced while the body streams in (ASVS F-14): a chunked request has no Content-Length,
    // and reading it whole before truncating let one unauthenticated POST buffer any size.
    bodyLimit({ maxSize: CSP_REPORT_MAX_BYTES, onError: (c) => c.body(null, 413) }),
    async (c) => {
      const text = await c.req.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.body(null, 204);
      }
      const reports = normalizeCspReports(body);
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== window) {
        window = minute;
        count = 0;
      }
      for (const report of reports) {
        const key = `${report.directive} ${blockedLabel(report.blockedURI)} ${report.disposition}`;
        if (!labelSets.has(key) && labelSets.size < CSP_LABEL_SETS_MAX) labelSets.add(key);
        const known = labelSets.has(key);
        violations.add(1, {
          directive: known ? report.directive : "other",
          blocked: known ? blockedLabel(report.blockedURI) : "other",
          disposition: report.disposition,
        });
        if (count < CSP_REPORT_LOG_PER_MINUTE) {
          count += 1;
          options.log("csp.report", { level: "warn", ...report });
        }
      }
      return c.body(null, 204);
    },
  );

  return app;
}
