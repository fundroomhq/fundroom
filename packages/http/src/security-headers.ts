import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { buildCsp, type CspDirectives, frameAncestorsSources } from "./csp.js";
import { isLocalOrIpHost, isSecureRequest, requestHost, requestOrigin } from "./request.js";

/*
 * Security headers (EXECUTION_PLAN §3.3 step 6, §10 "Frontend"; design/02 §5; design/08 §5
 * threat table; ADR-0008 embed is an iframe, ADR-0009 partitioned embed sessions,
 * ADR-0022 path mount). One middleware, five profiles chosen per request by the route tree:
 *
 *   app    first-party SPA / HTML at the canonical origin (investor portal, auth pages)
 *   admin  the admin SPA: never framed, never indexed
 *   embed  `/embed/*` documents framed by the workspace's allow-listed host origins
 *   api    `/api/*` JSON: nothing renders, nothing frames, nothing caches
 *   asset  hashed static files, including the embed loader that host pages fetch
 *
 * The CSP nonce is generated before the handler runs (`c.get("cspNonce")` for the HTML
 * shell); every other header is applied after `next()` so a handler can pre-empt
 * `Cache-Control`. Headers are set with `c.header(name, value)` — Hono overwrites, so a
 * handler that wants a different value sets it after this middleware in its own chain.
 */
export type HeaderProfile = "app" | "admin" | "embed" | "api" | "asset";

export interface HeaderVariables {
  cspNonce: string;
}

export type SecurityHeadersEnv = { Variables: HeaderVariables };

export interface HstsOptions {
  readonly enabled: boolean;
  /** Default 2 years (63 072 000 s), the preload-list minimum. */
  readonly maxAgeSeconds?: number | undefined;
  /** Adds `preload` (which implies `includeSubDomains`). Only for a standalone domain the operator owns. */
  readonly preload?: boolean | undefined;
  /**
   * Adds `includeSubDomains` without `preload` (ASVS 3.4.1, E2.10 F-15). Config
   * `HSTS_INCLUDE_SUBDOMAINS`, which defaults on for a host-mounted install. Default false here.
   */
  readonly includeSubDomains?: boolean | undefined;
  /**
   * The install's own host (BASE_URL's, port ignored). When set, `includeSubDomains`/`preload`
   * are sent only on this host and its subdomains (tenant subdomains in multi mode); any other
   * host — a workspace's verified custom domain, possibly a customer's zone apex — gets plain
   * `max-age`, so we never pin HTTPS on subdomains of a domain we do not own (review R2-02).
   * Unset = the directives go to every host.
   */
  readonly canonicalHost?: string | undefined;
}

export interface CspSources {
  readonly connectSrc?: readonly string[] | undefined;
  readonly imgSrc?: readonly string[] | undefined;
  readonly fontSrc?: readonly string[] | undefined;
  readonly styleSrc?: readonly string[] | undefined;
  readonly frameSrc?: readonly string[] | undefined;
  /** Extra script sources beyond the nonce (a hashed inline bootstrap, a Vite dev host). */
  readonly scriptSrcExtra?: readonly string[] | undefined;
}

export interface SecurityHeadersOptions {
  readonly profile: (c: Context) => HeaderProfile;
  /** Embed profile only: origins allowed to frame this workspace's `/embed/*` pages. */
  readonly frameAncestors?:
    | ((c: Context) => readonly string[] | Promise<readonly string[]>)
    | undefined;
  /** From config `ROBOTS`; embed, admin and api are always `noindex, nofollow`. */
  readonly robots: "noindex" | "index";
  readonly hsts?: HstsOptions | undefined;
  /**
   * E3.9: true ⇒ no `Strict-Transport-Security` on this response. For a request served through a
   * path mount (`X-Forwarded-Prefix`): the host site owns its own transport policy, and a pin
   * (let alone `includeSubDomains`) on a domain we do not own is not ours to send. Evaluated after
   * the handler.
   */
  readonly omitHsts?: ((c: Context) => boolean) | undefined;
  readonly trustProxy: boolean;
  /**
   * Absolute or path URL of the CSP report collector (E0.6 mounts `/csp-report`). `report-uri`
   * carries it as given. `Reporting-Endpoints` must name an absolute, potentially trustworthy URL
   * (the Reporting API ignores anything else), so a path is resolved against the request's own
   * origin — the canonical host or the workspace's custom domain, which keeps delivery
   * same-origin — and the header is left out on plain http to a non-local host.
   *
   * A function is resolved once per request (E3.9 path mounts: the collector URL follows the
   * request's public origin and base). Its answer is used for `report-uri`, the report-only
   * header and `Reporting-Endpoints` alike; an answer carrying anything a CSP source or a quoted
   * header value cannot hold (whitespace, `;`, `,`, quotes, backslash, controls, non-ASCII) is
   * treated as no report URI for that response rather than failing the request.
   */
  readonly cspReportUri?: string | ((c: Context) => string | undefined) | undefined;
  /**
   * Config `CSP_TRUSTED_TYPES` (E3.2). `enforce` (the default) puts
   * `require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard` in the
   * enforced CSP of every document profile (app, admin, embed), with or without a report URI.
   * `report` sends the same two directives in `Content-Security-Policy-Report-Only` instead,
   * which needs `cspReportUri` to be of any use (without one nothing is sent). API and asset
   * responses never carry either.
   */
  readonly trustedTypes?: "enforce" | "report" | undefined;
  readonly csp?: CspSources | undefined;
  /** Paths (exact, after base path) that open OAuth/passkey popups: COOP `same-origin-allow-popups`. */
  readonly popupAuthPaths?: readonly string[] | undefined;
  /** Default 16 (128-bit nonce). */
  readonly nonceBytes?: number | undefined;
}

export const HSTS_DEFAULT_MAX_AGE = 63_072_000;
/*
 * Everything off, with one exception (E2.2, design/08 §5).
 *
 * `publickey-credentials-get=(self)` is what lets a passkey ceremony run *inside* the embed
 * iframe: the host page delegates the feature with `allow="publickey-credentials-get"` on the
 * frame, and the framed document then has to permit it for its own origin or the browser
 * refuses anyway. `(self)` is our origin only — the delegation is the host's decision to make,
 * not ours to widen — and the top-level popup on the portal origin stays the guaranteed path,
 * because a host that does not delegate is the common case and must keep working.
 */
export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=(), publickey-credentials-get=(self)";
export const ROBOTS_NOINDEX = "noindex, nofollow";
export const CSP_REPORT_GROUP = "csp";
/*
 * The Trusted Types policies the SPA may create (E2.10), listed in the `trusted-types`
 * directive; any other `createPolicy` name is refused (enforced) or reported (report-only).
 *
 *   default               the SPA's own (apps/web/src/lib/csp.ts): passes an explicit list of
 *                         third-party literals (Radix Select's viewport CSS) at implicit sinks
 *                         and reports everything else
 *   ProseMirrorClipboard  prosemirror-view parses pasted HTML in a detached document through it
 *
 * No 'allow-duplicates': each is created once per document. Enforced since E3.2
 * (`trustedTypes: "enforce"`, config `CSP_TRUSTED_TYPES`); `report` is the rollback switch.
 * See docs/runbooks/csp-reports.md.
 */
export const TRUSTED_TYPES_POLICIES = ["default", "ProseMirrorClipboard"] as const;

export function cspNonceOf(c: Context): string | undefined {
  const value = (c as Context<SecurityHeadersEnv>).get("cspNonce");
  return typeof value === "string" ? value : undefined;
}

function documentCsp(input: {
  readonly nonce: string;
  readonly frameAncestors: readonly string[];
  readonly secure: boolean;
  readonly sources: CspSources;
  readonly reportUri: string | undefined;
  readonly enforceTrustedTypes: boolean;
}): CspDirectives {
  const s = input.sources;
  const directives: Record<string, readonly string[] | true> = {
    "default-src": ["'self'"],
    // 'strict-dynamic' makes CSP3 browsers ignore the host/scheme sources and 'unsafe-inline'
    // that follow; those stay only so CSP2 browsers (no strict-dynamic) still run our
    // nonced scripts instead of blocking everything.
    "script-src": [
      `'nonce-${input.nonce}'`,
      "'strict-dynamic'",
      ...(s.scriptSrcExtra ?? []),
      "'unsafe-inline'",
      "https:",
      "http:",
    ],
    "style-src": ["'self'", `'nonce-${input.nonce}'`, ...(s.styleSrc ?? [])],
    "img-src": ["'self'", "data:", "blob:", ...(s.imgSrc ?? [])],
    "font-src": ["'self'", ...(s.fontSrc ?? [])],
    "connect-src": ["'self'", ...(s.connectSrc ?? [])],
    // No document starts a Worker, SharedWorker or service worker (E2.10 ZAP-01). Without this
    // directive workers fall back to script-src, whose CSP2 fallbacks include `https: http:`.
    "worker-src": ["'none'"],
    "frame-src": s.frameSrc && s.frameSrc.length > 0 ? s.frameSrc : ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": input.frameAncestors,
  };
  if (input.secure) directives["upgrade-insecure-requests"] = true;
  if (input.enforceTrustedTypes) {
    directives["require-trusted-types-for"] = ["'script'"];
    directives["trusted-types"] = TRUSTED_TYPES_POLICIES;
  }
  if (input.reportUri !== undefined) {
    directives["report-uri"] = [input.reportUri];
    directives["report-to"] = [CSP_REPORT_GROUP];
  }
  return directives;
}

const API_CSP = buildCsp({ "default-src": ["'none'"], "frame-ancestors": ["'none'"] });

/** `host` without port and trailing dot, lower-case. */
function hostnameOf(host: string): string {
  let name = host.trim().toLowerCase();
  if (!name.startsWith("[")) {
    const colon = name.lastIndexOf(":");
    if (colon !== -1) name = name.slice(0, colon);
  }
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function hstsValue(hsts: HstsOptions, host: string): string {
  const maxAge = hsts.maxAgeSeconds ?? HSTS_DEFAULT_MAX_AGE;
  if (hsts.canonicalHost !== undefined) {
    const own = hostnameOf(hsts.canonicalHost);
    const name = hostnameOf(host);
    if (name !== own && !name.endsWith(`.${own}`)) return `max-age=${maxAge}`;
  }
  if (hsts.preload) return `max-age=${maxAge}; includeSubDomains; preload`;
  return hsts.includeSubDomains ? `max-age=${maxAge}; includeSubDomains` : `max-age=${maxAge}`;
}

const REPORT_URI_RE = /^[\x21\x23-\x26\x28-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u;

/** A per-request report URI, or undefined when it could forge a directive or header value. */
function safeReportUri(value: string | undefined): string | undefined {
  return value !== undefined && REPORT_URI_RE.test(value) ? value : undefined;
}

/** The `Reporting-Endpoints` URL for `reportUri`, or undefined when the API would ignore it. */
function reportingEndpoint(c: Context, reportUri: string, trustProxy: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(reportUri, `${requestOrigin(c, trustProxy)}/`);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  // The origin comes from the request's Host; WHATWG URL lets `"` and other header-breaking
  // characters through, so only a plain hostname or IP literal is reflected (review R2-09).
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/u.test(host)) return undefined;
  if (url.protocol === "https:") return url.href;
  // http is "potentially trustworthy" only for loopback (dev), per the Secure Contexts spec.
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
    host === "[::1]";
  return url.protocol === "http:" && loopback ? url.href : undefined;
}

/*
 * CORP (E2.10 ZAP-02). `same-site` would let every sibling subdomain load the response
 * no-cors, and in TENANCY_MODE=multi the tenant subdomains *are* same-site with each other,
 * so the SPA shell, `/assets/*` (always root-relative, so same-origin with the page that loads
 * them) and the API are `same-origin`.
 *
 *   asset  `cross-origin`: the embed loader is fetched by third-party host pages.
 *   embed  stays `same-site`: the embed document is a framed navigation, which CORP governs only
 *          when the host page sets COEP `require-corp`; `same-site` keeps a COEP host on the
 *          operator's own registrable domain (acme.com framing investors.acme.com) working.
 */
function corpFor(profile: HeaderProfile): "cross-origin" | "same-site" | "same-origin" {
  if (profile === "asset") return "cross-origin";
  if (profile === "embed") return "same-site";
  return "same-origin";
}

export function securityHeaders(
  options: SecurityHeadersOptions,
): MiddlewareHandler<SecurityHeadersEnv> {
  const nonceBytes = options.nonceBytes ?? 16;
  const popupPaths = new Set(options.popupAuthPaths ?? []);
  const sources = options.csp ?? {};
  const enforceTrustedTypes = (options.trustedTypes ?? "enforce") === "enforce";

  return async (c, next) => {
    const nonce = randomBytes(nonceBytes).toString("base64");
    c.set("cspNonce", nonce);
    const profile = options.profile(c);
    // Resolve before the handler: a failing allow-list lookup must not leave a framed page
    // without frame-ancestors.
    const frameAncestors =
      profile === "embed" && options.frameAncestors
        ? frameAncestorsSources(await options.frameAncestors(c))
        : ["'none'"];

    await next();

    const secure = isSecureRequest(c, options.trustProxy);
    const isDocument = profile === "app" || profile === "admin" || profile === "embed";
    const reportUri =
      typeof options.cspReportUri === "function"
        ? isDocument
          ? safeReportUri(options.cspReportUri(c))
          : undefined
        : options.cspReportUri;

    // --- CSP ---------------------------------------------------------------
    if (isDocument) {
      const directives = documentCsp({
        nonce,
        frameAncestors,
        secure,
        sources,
        reportUri,
        enforceTrustedTypes,
      });
      c.header("Content-Security-Policy", buildCsp(directives));
      if (reportUri !== undefined) {
        // `report`: the E2.10 rollout stage (design/02 §5), kept as a rollback switch.
        if (!enforceTrustedTypes) {
          c.header(
            "Content-Security-Policy-Report-Only",
            buildCsp({
              "require-trusted-types-for": ["'script'"],
              "trusted-types": TRUSTED_TYPES_POLICIES,
              "report-uri": [reportUri],
              "report-to": [CSP_REPORT_GROUP],
            }),
          );
        }
        const endpoint = reportingEndpoint(c, reportUri, options.trustProxy);
        if (endpoint !== undefined)
          c.header("Reporting-Endpoints", `${CSP_REPORT_GROUP}="${endpoint}"`);
      }
    } else if (profile === "api") {
      // An API handler that serves an HTML document of its own (the accreditation handoff page, E3.7)
      // keeps the policy it set; every other API response gets the locked-down API policy.
      const ownDocumentCsp =
        c.res.headers.has("Content-Security-Policy") &&
        (c.res.headers.get("Content-Type") ?? "").startsWith("text/html");
      if (!ownDocumentCsp) c.header("Content-Security-Policy", API_CSP);
    }

    // --- framing -----------------------------------------------------------
    if (profile !== "embed") c.header("X-Frame-Options", "DENY");

    // --- transport ---------------------------------------------------------
    const host = requestHost(c, options.trustProxy);
    if (
      options.hsts?.enabled &&
      secure &&
      !isLocalOrIpHost(host) &&
      !(options.omitHsts?.(c) ?? false)
    ) {
      c.header("Strict-Transport-Security", hstsValue(options.hsts, host));
    }

    // --- isolation ---------------------------------------------------------
    c.header(
      "Referrer-Policy",
      profile === "embed" || profile === "api" ? "no-referrer" : "strict-origin-when-cross-origin",
    );
    if (profile === "embed") {
      // An iframe with COOP same-origin would be severed from the host page's browsing
      // context group and the postMessage bridge (design/08 §5) would stop working. The
      // bridge is the embed's whole point, so the embed profile sets no COOP; the host
      // origin allow-list (frame-ancestors) is the framing control.
    } else if (popupPaths.has(c.req.path)) {
      c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    } else {
      c.header("Cross-Origin-Opener-Policy", "same-origin");
    }
    // A handler may widen CORP for a resource made to be embedded elsewhere — the email chart
    // PNG (`GET /api/v1/metrics/chart/{token}.png`) is loaded by webmail from another site.
    if (!c.res.headers.has("Cross-Origin-Resource-Policy")) {
      c.header("Cross-Origin-Resource-Policy", corpFor(profile));
    }
    c.header("Origin-Agent-Cluster", "?1");

    // --- hygiene -----------------------------------------------------------
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Permissions-Policy", PERMISSIONS_POLICY);
    c.header(
      "X-Robots-Tag",
      profile === "app" || profile === "asset"
        ? options.robots === "index"
          ? "index, follow"
          : ROBOTS_NOINDEX
        : ROBOTS_NOINDEX,
    );
    if (profile !== "asset" && !c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "private, no-store");
    }
  };
}
