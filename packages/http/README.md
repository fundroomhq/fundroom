# @fundroom/http

Kernel HTTP middleware. E0.5 ships the security-headers middleware and the proxy-aware request helpers; E0.6
mounts them in `apps/server` ahead of every route tree.

```ts
import { securityHeaders, requestOrigin, cspNonceOf } from "@fundroom/http";

app.use("*", securityHeaders({
  profile: (c) => c.req.path.startsWith("/embed/") ? "embed"
                : c.req.path.startsWith("/admin") ? "admin"
                : c.req.path.startsWith("/api/") ? "api"
                : c.req.path.startsWith("/assets/") ? "asset" : "app",
  frameAncestors: (c) => embedOriginsFor(c),          // per-workspace allow-list
  robots: config.raw.ROBOTS,
  hsts: {
    enabled: config.raw.HSTS,
    preload: config.raw.HSTS_PRELOAD,
    includeSubDomains: hstsIncludeSubDomains(config.raw), // @fundroom/config
  },
  trustProxy: config.raw.TRUST_PROXY,
  cspReportUri: `${config.basePath}/csp-report`,
  popupAuthPaths: [`${config.basePath}/auth/oidc/popup`],
}));
// in the HTML shell: <script nonce={cspNonceOf(c)}>
```

## Headers per profile

| Header | `app` | `admin` | `embed` | `api` | `asset` |
|---|---|---|---|---|---|
| `Content-Security-Policy` | strict document CSP, `frame-ancestors 'none'` | same | strict document CSP, `frame-ancestors <allow-list>` (`'none'` when empty) | `default-src 'none'; frame-ancestors 'none'` | — |
| `Content-Security-Policy-Report-Only` | only with `trustedTypes: "report"` and `cspReportUri`: `require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard; report-uri …; report-to csp` | same | same | — | — |
| `Reporting-Endpoints` | `csp="<cspReportUri>"` (only with `cspReportUri`) | same | same | — | — |
| `X-Frame-Options` | `DENY` | `DENY` | — (cannot express a list; CSP rules) | `DENY` | `DENY` |
| `Strict-Transport-Security` | on https, non-local host: `max-age=63072000` (+ `, includeSubDomains` unless path-mounted or `HSTS_INCLUDE_SUBDOMAINS=false`, + `, preload` with `HSTS_PRELOAD`); both only on the canonical host and its subdomains, never on a custom domain (R2-02) | same | same | same | same |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | same | `no-referrer` | `no-referrer` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` (`same-origin-allow-popups` on `popupAuthPaths`) | same | — (see below) | `same-origin` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` | `same-origin` | `same-site` (the framed `/embed/<slug>` document; keeps a COEP `require-corp` host on the operator's own registrable domain working) | `same-origin` | `cross-origin` (the embed loader is fetched by host pages) |
| `X-Robots-Tag` | `ROBOTS` (`noindex, nofollow` / `index, follow`) | `noindex, nofollow` | `noindex, nofollow` | `noindex, nofollow` | `ROBOTS` |
| `Cache-Control` | `private, no-store` unless the handler set one | same | same | same | handler's choice |
| `X-Content-Type-Options` | `nosniff` | ← | ← | ← | ← |
| `X-Permitted-Cross-Domain-Policies` | `none` | ← | ← | ← | ← |
| `X-DNS-Prefetch-Control` | `off` | ← | ← | ← | ← |
| `Origin-Agent-Cluster` | `?1` | ← | ← | ← | ← |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()` | ← | ← | ← | ← |

The document CSP is

```
default-src 'self';
script-src 'nonce-<n>' 'strict-dynamic' [scriptSrcExtra] 'unsafe-inline' https: http:;
style-src 'self' 'nonce-<n>' [styleSrc];
img-src 'self' data: blob: [imgSrc];
font-src 'self' [fontSrc];
connect-src 'self' [connectSrc];
worker-src 'none';
frame-src 'none' | [frameSrc];
object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors …;
upgrade-insecure-requests   (https only)
require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard   (trustedTypes "enforce", the default)
report-uri <uri>; report-to csp   (with cspReportUri)
```

`'unsafe-inline' https: http:` after `'strict-dynamic'` are ignored by CSP3 browsers and only
keep CSP2 browsers working with the nonce; they grant nothing where `strict-dynamic` is
understood. `worker-src 'none'` because no document starts a worker; without it
workers would fall back to `script-src` and its CSP2 scheme sources.

Trusted Types are enforced: `trustedTypes` defaults to `"enforce"` (config
`CSP_TRUSTED_TYPES`), which puts the two directives in the enforced document CSP of `app`, `admin`
and `embed`, with or without `cspReportUri`. `"report"` is the rollback switch: the directives move
to `Content-Security-Policy-Report-Only` (sent only when there is a `cspReportUri` to report to).
The allowed policy names are `TRUSTED_TYPES_POLICIES`: `default` (the SPA's own,
`apps/web/src/lib/csp.ts`) and `ProseMirrorClipboard` (prosemirror-view's paste parser). See
`docs/runbooks/csp-reports.md`.

CORP is `same-origin` on `app`, `admin` and `api`: in `TENANCY_MODE=multi`
tenant subdomains are same-site with each other, so `same-site` would let one tenant's pages load
another's no-cors responses. A handler that sets `Cross-Origin-Resource-Policy` itself keeps its
value: the email chart image (`GET /api/v1/metrics/chart/{token}.png`) is loaded by webmail from
another site and needs `cross-origin`.

## Decisions

- **No COOP on `embed`.** `Cross-Origin-Opener-Policy: same-origin` on the framed document
  would sever it from the host page's browsing-context group and kill the `postMessage`
  bridge that the embed exists for. Framing is controlled by
  `frame-ancestors` computed per workspace; the embed route additionally checks
  `Sec-Fetch-Site`/`Referer` and audits rejections.
- **`frame-ancestors` resolves before the handler runs**, so a failing allow-list lookup
  fails the request rather than leaving a framed page unprotected.
- **`includeSubDomains` / `preload` only on the install's own host** (`hsts.canonicalHost`) and
  its subdomains (tenant subdomains). A workspace's custom domain — possibly a customer's zone
  apex — gets plain `max-age`: pinning HTTPS on `*.acme.com` for two years is not ours to decide
  (review R2-02).
- **HSTS never on localhost / IP hosts** even over https, so a dev TLS setup cannot pin the
  browser; `preload` is refused by the config layer for path-mounted installs.
- **Handlers own `Cache-Control`** for assets and may override it elsewhere (document tiles
  set their own `private, no-store` anyway).

## Request helpers

`isSecureRequest(c, trustProxy)`, `requestHost(c, trustProxy)`, `requestOrigin(c, trustProxy)`
read `X-Forwarded-Proto` / `X-Forwarded-Host` only when `TRUST_PROXY` is set, and then the
**rightmost** entry — the one the nearest proxy wrote; anything to its left came from the client. Otherwise the request URL and `Host` header are the truth. `isLocalOrIpHost(host)`
is the HSTS exclusion test.

`forwardedClientIp(header, { hops, clientIpHeader })` is the client address behind a trusted
proxy: the single-valued platform header when one is configured (`CLIENT_IP_HEADER`, e.g.
`Fly-Client-IP`; `X-Forwarded-For` is then never consulted), else the `X-Forwarded-For` entry
`hops` (`TRUST_PROXY_HOPS`, default 1) places from the right. Never the leftmost entry.
`undefined` means "use the socket address".

`CLIENT_IP_HEADER` is believed without any hop check, so it is only as good as the edge's promise
to overwrite it on every request. Fly documents `Fly-Client-IP` as edge-set. Railway's `X-Real-IP`
and Render's `True-Client-IP` (set by Cloudflare) rest on platform staff statements, not
documentation (review R2-07); deploy/render/README.md and deploy/railway/README.md carry a
forged-header sign-in check to run once after deploy. A value that is not exactly one address
(two values, garbage) falls back to the socket address, never to `X-Forwarded-For`.

`Reporting-Endpoints` is sent with an absolute URL (a path `cspReportUri` is resolved against the
request's own origin) and only when that URL is https or loopback (`localhost`, `*.localhost`,
`127.x.y.z`, `[::1]`), which is all the Reporting API accepts, and when the host is a plain
hostname or IP literal (the Host header is reflected); `report-uri` keeps the value as given.

Not here: request ids, the error envelope, CORS allow-list, tenant resolution, the
`/csp-report` collector, `/healthz`/`/readyz`.
