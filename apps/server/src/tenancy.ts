import type { TenancyMode } from "@fundroom/config";

/*
 * Request classification (EXECUTION_PLAN §3.3 step 1, §9.2, ADR-0022). Pure: takes the
 * request's host and path plus the install's canonical host, returns which route tree the
 * request belongs to and which workspace slug (if any) it names. The middleware then does
 * the one indexed lookup.
 *
 *   tree      api      /api/*                    JSON, error envelope
 *                      /embed/<slug>/api/*       …the same, still in the embed context
 *             embed    /embed/<slug>/*           partitioned cookies, frame-ancestors per workspace
 *             asset    /embed/<version>/<file>   the embed loader: no tenant, cross-origin, cached
 *             admin    /admin/*                  never framed, never indexed
 *             app      everything else           investor portal + auth pages
 *             ops      /healthz /readyz /metrics /.well-known/* /csp-report /internal/tls/ask
 *                      /webhooks/email/<driver> (E2.6 ESP delivery webhooks)
 *                      /webhooks/esign/<connection uuid> (E3.5 e-sign vendor callbacks)
 *                      /webhooks/accreditation/<connection uuid> (E3.7 accreditation vendor callbacks)
 *                      /webhooks/integrations/<connection uuid> (E3.6 booking webhooks)
 *                      /oauth/integrations/{start,callback} (E3.6; canonical host only)
 *                      /sso/oidc/<uuid>/callback, /sso/saml/<uuid>/{acs,metadata}
 *                      (E3.8 IdP-facing SSO endpoints; canonical host only)
 *                      /scim/v2 and /scim/v2/* (E3.8 SCIM; canonical host only, the workspace
 *                      comes from the bearer token)
 *                      /webhooks/billing/stripe (E3.10 billing provider webhook; canonical host
 *                      only, the workspace comes from our own stored subscription ids)
 *                      no tenant, no session
 *
 *   (E3.10 central auth, `/auth/central/{start,authorize,finish}`, is deliberately NOT ops: start
 *   and finish need the workspace host's tenant resolution and authorize needs the canonical
 *   session, so they are `app`-tree routes mounted ahead of the SPA — `routes/central-auth.ts`.)
 *
 *   slug      multi mode: `<slug>.<canonical host>` or `/w/<slug>` or `/embed/<slug>`;
 *             single mode: path forms only (must equal the sole workspace; the middleware checks).
 *             On a `<slug>.<canonical>` host a path slug naming ANOTHER workspace is refused
 *             (E3.10): the host wins, exactly as on a custom domain — a request naming two
 *             workspaces names none.
 *   host      canonical | tenant | custom | unknown (multi mode rejects unknown hosts before
 *             any DB work). `custom` is never produced here: `classifyRequest` is sync and pure,
 *             and a verified custom domain can only be recognised by an indexed lookup. The
 *             tenant middleware, which is already async, upgrades an `unknown` host to `custom`
 *             when the lookup finds one (E2.1 §1.12).
 */
export type RouteTree = "api" | "embed" | "asset" | "admin" | "app" | "ops";
export type HostKind = "canonical" | "tenant" | "custom" | "unknown";

export interface Classification {
  readonly tree: RouteTree;
  readonly host: HostKind;
  /** From the host label or the path prefix. */
  readonly slug: string | undefined;
  /**
   * Path with the base path and any `/w/<slug>` prefix removed. The `/embed/<slug>` prefix is
   * kept for the document itself, and stripped for the API underneath it (`/embed/acme/api/v1/me`
   * → `/api/v1/me`, still `embed: true`), so those routes mount as they do everywhere else.
   */
  readonly path: string;
  readonly embed: boolean;
  /**
   * E3.10 FR1 (R1-L2): set when this `/w/<slug>` page request on the canonical host must be
   * answered with a 308 to the workspace's own host instead (`slugHostRedirect`): the target's
   * origin plus base path. The middleware appends the request's RAW (still percent-encoded) path
   * after `/w/<slug>` and its query (`slugHostLocation`, FR3) — never `path`, which is decoded.
   */
  readonly redirect?: string | undefined;
}

export interface ClassifyOptions {
  readonly mode: TenancyMode;
  /** Host (with port when non-default) of BASE_URL, lower-case. */
  readonly canonicalHost: string;
  readonly basePath: string;
  /**
   * E3.10 FR1 (R1-L2), CONTROL_PLANE=on only: the canonical host is the operator console's
   * origin, so it serves NO tenant content. A `/w/<slug>` page there is redirected (308) to
   * `<protocol>//<slug>.<canonical host>` with the same path, and a `/w/<slug>/api/*` call is a
   * 404 — tenant pages and the `__Host-op_sid` cookie never share an origin. `protocol` is
   * BASE_URL's (`https:` in production).
   */
  readonly slugHostRedirect?: { readonly protocol: string } | undefined;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/*
 * The embed loader's namespace inside `/embed/*` (E2.2 §5, ADR-0008 decision 9: this product
 * self-hosts and ships no CDN, so `${basePath}/embed/v1/embed.js` is the delivery mechanism
 * rather than a fallback).
 *
 * `v1` is the rolling channel and `0.1.0` the pinned, immutable one, so both spellings are
 * reserved — and a workspace slug that looks like either is refused outright rather than
 * resolved by shape. `v1` *is* a legal slug under `SLUG_RE`, so without this the namespace
 * would depend on whether a workspace happened to claim it first, and a founder who did could
 * shadow the loader for the whole install.
 *
 * The pinned segment is the package version verbatim, so a pre-release (`1.0.0-rc.0`) has to
 * match too or its pinned URL 404s. A dotted name is never a slug (`SLUG_RE` has no `.`), so
 * the wider shape takes nothing away from workspaces.
 */
const EMBED_VERSION_RE = /^(?:v\d+|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;
/** One flat file under a version: `embed.js`, `embed.mjs`, `manifest.json`. Never a directory. */
const EMBED_ASSET_FILE_RE = /^[A-Za-z0-9._-]+$/u;
const OPS_PATHS: ReadonlySet<string> = new Set([
  "/healthz",
  "/readyz",
  "/metrics",
  "/csp-report",
  "/internal/tls/ask",
  // RFC 9116 §3 legacy location; ops.ts redirects it to /.well-known/security.txt (E2.10).
  "/security.txt",
]);

/** `POST /webhooks/email/<driver>` (E2.6): one driver segment, nothing nested. */
const WEBHOOK_EMAIL_RE = /^\/webhooks\/email\/[a-z0-9-]{1,32}$/u;
/** `POST /webhooks/esign/<connectionId>` (E3.5): one lower-case uuid segment, nothing nested. */
const WEBHOOK_ESIGN_RE =
  /^\/webhooks\/esign\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/**
 * `POST /webhooks/accreditation/<connectionId>` (E3.7): one lower-case uuid segment, nothing
 * nested.
 */
export const WEBHOOK_ACCREDITATION_RE =
  /^\/webhooks\/accreditation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * `POST /webhooks/integrations/<connectionId>` (E3.6 booking webhooks): one lower-case uuid
 * segment, nothing nested.
 */
export const WEBHOOK_INTEGRATIONS_RE =
  /^\/webhooks\/integrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/**
 * The OAuth handshake (E3.6): one redirect URI per install (`${BASE_URL}/oauth/integrations/
 * callback`, registered with each vendor), so both halves answer on the canonical host only —
 * a tenant host, a `/w/<slug>` path or a custom domain is not the ops tree (it falls through to
 * the SPA and 404s there), and the browser-binding cookie is scoped to the one origin.
 */
export const OAUTH_INTEGRATIONS_PATHS: ReadonlySet<string> = new Set([
  "/oauth/integrations/start",
  "/oauth/integrations/callback",
]);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * The IdP-facing SSO endpoints (E3.8, ADR-0056): the OIDC redirect URI, the SAML ACS and the SAML
 * SP metadata, one lower-case connection uuid each. They live on the canonical host (BASE_URL) so a
 * custom-domain change never breaks an IdP registration; the workspace comes from the connection
 * row, never the host.
 */
export const SSO_OPS_RE = new RegExp(
  `^/sso/(?:oidc/${UUID}/callback|saml/${UUID}/(?:acs|metadata))$`,
  "u",
);

/**
 * SCIM 2.0 (E3.8, ADR-0056): `${BASE_URL}/scim/v2` and everything under it. Canonical host only;
 * the workspace comes from the bearer token, never the host.
 */
export function isScimPath(rest: string): boolean {
  return rest === "/scim/v2" || rest.startsWith("/scim/v2/");
}

/**
 * The billing provider's webhook (E3.10, ADR-0058): `POST /webhooks/billing/stripe` on the
 * canonical host. The workspace comes from the subscription / customer ids we stored, never the
 * host.
 */
export const WEBHOOK_BILLING_PATHS: ReadonlySet<string> = new Set(["/webhooks/billing/stripe"]);

export function stripBasePath(path: string, basePath: string): string | undefined {
  if (basePath === "") return path;
  if (path === basePath) return "/";
  if (path.startsWith(`${basePath}/`)) return path.slice(basePath.length);
  return undefined;
}

function hostWithoutDefaultPort(host: string): string {
  const h = host.toLowerCase();
  return h.replace(/:(?:80|443)$/u, "");
}

export function classifyRequest(
  input: { host: string; path: string },
  options: ClassifyOptions,
): Classification | undefined {
  const path = stripBasePath(input.path, options.basePath);
  if (path === undefined) return undefined;

  const requestHost = hostWithoutDefaultPort(input.host);
  const canonical = hostWithoutDefaultPort(options.canonicalHost);
  let host: HostKind = "unknown";
  let slug: string | undefined;
  if (requestHost === canonical) {
    host = "canonical";
  } else if (options.mode === "multi" && requestHost.endsWith(`.${canonical}`)) {
    const label = requestHost.slice(0, -(canonical.length + 1));
    if (SLUG_RE.test(label)) {
      host = "tenant";
      slug = label;
    }
  } else if (options.mode === "single") {
    // A proxy or custom domain in front of a single-tenant install: the operator owns routing.
    host = "canonical";
  }

  let rest = path;
  let embed = false;
  const embedMatch = /^\/embed\/([^/]+)(\/.*)?$/u.exec(rest);
  const wMatch = /^\/w\/([^/]+)(\/.*)?$/u.exec(rest);
  if (embedMatch) {
    const s = embedMatch[1] ?? "";
    // Reserved prefix first, so `/embed/v1/embed.js` is the loader and never workspace `v1`.
    if (EMBED_VERSION_RE.test(s)) {
      const file = (embedMatch[2] ?? "").slice(1);
      // Exactly one file segment, or nothing: `/embed/v1` alone names no artifact and a nested
      // path is not a shape this tree serves. Both are 404 here rather than falling through to
      // the SPA, which would answer an HTML document to a `<script src>`.
      if (file === "" || !EMBED_ASSET_FILE_RE.test(file)) return undefined;
      return { tree: "asset", host, slug: undefined, path: rest, embed: false };
    }
    if (!SLUG_RE.test(s)) return undefined;
    // E3.10: a tenant host already names its workspace; a path naming another one is a 404.
    if (host === "tenant" && s !== slug) return undefined;
    slug = s;
    embed = true;
    /*
     * An `/api` remainder *inside* the embed prefix is an API request that is still in the embed
     * context (E2.2). This is what makes the partitioned session cookie work at all.
     *
     * The cookie recipe is chosen by `cookieModeFor({ embed })`, and `embed` comes from this
     * classification. Before this branch existed, the framed SPA called the API at
     * `/w/<slug>/api/v1` — indistinguishable from a first-party call — so every login made inside
     * the iframe was issued a `SameSite=Lax` cookie the browser then refused to send back from a
     * third-party frame. The session was minted and immediately unusable.
     *
     * The alternative was a client-asserted `X-Fundroom-Embed` header. It degrades safely, but it
     * would let the caller pick its own cookie recipe — and the server already mints `apiBase`
     * into the page config, so the embed context is a fact the server controls. A derived input
     * beats a trusted one whenever both are available.
     *
     * The prefix is stripped from `path` so the API routes mount exactly as they do elsewhere;
     * `embed` stays true and `slug` stays set, so the tree falls out as `api` below.
     */
    const remainder = embedMatch[2] ?? "/";
    if (remainder === "/api" || remainder.startsWith("/api/")) rest = remainder;
  } else if (wMatch) {
    const s = wMatch[1] ?? "";
    if (!SLUG_RE.test(s)) return undefined;
    // E3.10: as for `/embed/<slug>` above — the host slug wins, a different path slug is a 404.
    if (host === "tenant" && s !== slug) return undefined;
    slug = s;
    rest = wMatch[2] ?? "/";
    // E3.10 FR1: no tenant content on the operator console's origin (see `slugHostRedirect`).
    if (host === "canonical" && options.slugHostRedirect !== undefined) {
      if (rest === "/api" || rest.startsWith("/api/")) return undefined;
      const target = `${options.slugHostRedirect.protocol}//${s}.${canonical}${options.basePath}`;
      return { tree: "app", host, slug: s, path: rest, embed: false, redirect: target };
    }
  }

  let tree: RouteTree;
  if (
    OPS_PATHS.has(rest) ||
    rest.startsWith("/.well-known/") ||
    // The ESP posts here; the workspace comes from the provider message id, never the host.
    (slug === undefined && WEBHOOK_EMAIL_RE.test(rest)) ||
    // The e-sign vendor posts here; the workspace comes from the connection row, never the host.
    (slug === undefined && WEBHOOK_ESIGN_RE.test(rest)) ||
    // The accreditation vendor posts here; the workspace comes from the connection row (E3.7).
    (slug === undefined && WEBHOOK_ACCREDITATION_RE.test(rest)) ||
    // The booking vendor posts here; the workspace comes from the connection row (E3.6).
    (slug === undefined && WEBHOOK_INTEGRATIONS_RE.test(rest)) ||
    (slug === undefined && host === "canonical" && OAUTH_INTEGRATIONS_PATHS.has(rest)) ||
    // The IdP returns here (E3.8); the workspace comes from the connection row.
    (slug === undefined && host === "canonical" && SSO_OPS_RE.test(rest)) ||
    // The IdP's provisioning client calls here (E3.8); the workspace comes from the token.
    (slug === undefined && host === "canonical" && isScimPath(rest)) ||
    // The billing provider posts here (E3.10); the workspace comes from our stored ids.
    (slug === undefined && host === "canonical" && WEBHOOK_BILLING_PATHS.has(rest))
  )
    tree = "ops";
  else if (rest === "/api" || rest.startsWith("/api/")) tree = "api";
  else if (embed) tree = "embed";
  else if (rest === "/admin" || rest.startsWith("/admin/")) tree = "admin";
  else tree = "app";

  return { tree, host, slug, path: rest, embed };
}

/**
 * The `Location` of a slug-host redirect (E3.10 FR3): `redirect` (origin + base path) followed by
 * the request URL's own path after `<base>/w/<slug>`, byte for byte — still percent-encoded, so a
 * `%2F` or `%3F` in a segment stays one segment rather than being decoded into a separator — and
 * its query string. `requestUrl` is the raw request URL (`c.req.url`).
 */
export function slugHostLocation(redirect: string, requestUrl: string, basePath: string): string {
  const url = new URL(requestUrl);
  let raw = url.pathname;
  if (basePath !== "" && (raw === basePath || raw.startsWith(`${basePath}/`))) {
    raw = raw.slice(basePath.length);
  }
  const rest = /^\/w\/[^/]+(\/.*)?$/u.exec(raw)?.[1] ?? "/";
  return `${redirect}${rest}${url.search}`;
}

/** `https://investors.acme.com` from a BASE_URL. */
export function canonicalHostOf(baseUrl: URL): string {
  return hostWithoutDefaultPort(baseUrl.host);
}
