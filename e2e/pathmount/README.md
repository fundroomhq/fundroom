# e2e/pathmount — the portal under a path of someone else's site

Support files for `deploy/compose/compose.pathmount.yaml`, which puts five real reverse proxies
and a TLS edge in front of the CI stack so `tests/50-path-mount.test.ts` can sign an investor in
*through* `https://<host site>/<prefix>` and check everything the browser sees there.

```sh
export E2E_APP_PORT=3300 E2E_MAILPIT_PORT=8325
export E2E_BASE_URL=http://localhost:3300 E2E_MAILPIT_URL=http://localhost:8325
pnpm --filter @fundroom/e2e stack:up:pathmount     # builds the app, workerd and Next.js images
pnpm --filter @fundroom/e2e test:pathmount         # Chromium (project pathmount-chromium)
pnpm --filter @fundroom/e2e stack:down:pathmount   # -v, removes the two host images, prunes
```

The spec drives a **first-run** install (owner, TOTP, offering, invitations over the API), so run
it on a fresh stack. It keeps the owner's TOTP secret in `e2e/.state/pathmount.json` so that a
worker restart after one host's failure does not take the other hosts down with it. The edge
binds 443 by default; set `E2E_PATHMOUNT_HTTPS_PORT` (for both the stack and the suite) if it is
taken — Chromium's resolver rules carry the port.

## The recipes are the files in this directory

Each host container runs a recipe file **verbatim** — mounted read-only, or copied into the
Next.js image — and `docs/embed/*` publishes the same files. Change a recipe here and the docs
change with it; never paraphrase one in the docs.

| Host | Shape | Recipe (documented) | Harness wrapping (not documented) |
|---|---|---|---|
| `nginx.test/investors` | preserve | `nginx/seed-host-mount.conf` (a `location` block) | `nginx/nginx.conf` (the `server`, the marketing page) |
| `caddy.test/portal` | **replace** `/portal` → `/investors` | `caddy/seed-host-mount.caddy` (directives for a site block) | `caddy/Caddyfile` (global options, `http://` site address, marketing page) |
| `worker.test/investors` | preserve | `worker/seed-host-mount.js` (`export default { fetch }`) | `worker/harness.js`, `worker/config.capnp`, `worker/start.sh`, `worker/Dockerfile` |
| `next.test/investors` | preserve | `next/next.config.mjs` (`rewrites()`, bare + `/:path*`) and `next/proxy.js` (headers) | `next/app/*`, `next/Dockerfile`, `next/package*.json` |
| `wp.test/investors` | preserve | the plugin's proxy mode (`plugins/wordpress`), enabled by the WP-CLI in `wp/setup.sh` | `wp/mu-plugins/seed-host-e2e.php` |

What every recipe does: forward `<prefix>` and `<prefix>/*` to `https://portal.test` with
`X-Forwarded-Prefix: <prefix>`, `X-Forwarded-Host: <site host>` and `X-Forwarded-Proto: https`,
and pass the response back (status, `Set-Cookie`, `Location`, cache headers). The app lists
every mount in `PATH_MOUNTS`; the request is "mounted" only when the prefix matches an entry —
and, where several entries share the prefix (four hosts here share `/investors`), when a believed
`X-Forwarded-Host` picks one of them; otherwise it fails closed. Mounted, the portal presents
itself under the mount: router base, asset URLs, `__Secure-sid; Path=<prefix>`, CSRF accepting
the site's origin.

**Cookies.** The Worker and WordPress recipes forward only the portal's own cookies
(`__Secure-`/`__Host-` + `sid`, `did`, `auth_req`, `oidc_req`, `sso_req`, `sh_intg`). nginx, Caddy
and Next.js cannot filter the `Cookie` header by name without extra machinery, so every cookie of
the site on `Path=/` reaches the portal; the docs say so and the spec asserts both halves (a
recipe that starts or stops filtering is noticed).

**Next.js.** A rewrite cannot add request headers, so the recipe is two files: `rewrites()` and a
`proxy.js` (Next.js 16's name for middleware) that adds the three `X-Forwarded-*` headers on the
mount's paths. Next.js redirects `/investors/` to `/investors` (its default `trailingSlash:
false`); both forms still reach the portal. Vercel's `vercel.json` rewrites are doc-only here.

## Topology

```
                         ┌──────────────────────────── docker (seed-host-ci) ─────────────────────────┐
browser                  │                                                                            │
 MAP *.test 127.0.0.1    │  edge (Caddy, tls internal)                                                │
 https://nginx.test/… ───┼─▶ nginx.test ─▶ nginx:80 ──────┐                                           │
 https://caddy.test/… ───┼─▶ caddy.test ─▶ hostcaddy:80 ──┤                                           │
 https://worker.test/… ──┼─▶ worker.test ─▶ worker:8787 ──┼── https://portal.test ─▶ edge ─▶ app:3000   │
 https://next.test/… ────┼─▶ next.test ─▶ next:3000 ──────┤   (network alias of the edge;             │
 https://wp.test/… ──────┼─▶ wp.test ─▶ wordpress:80 ─────┘    verified TLS, internal CA)             │
                         └────────────────────────────────────────────────────────────────────────────┘
```

- **One edge, two roles.** Only one container can own :443, so the edge terminates TLS for the
  host sites (standing in for each site's own TLS) *and* is the portal's front door. Every host
  proxies to `https://portal.test`, a network alias of the edge, so the hop from the recipe to
  the portal is TLS into the portal's own edge — as it is from a customer's server on the internet.
- **Verified TLS, not `insecure_skip_verify`.** The edge's healthcheck copies its internal CA's
  public root into the `edge_ca` volume; the hosts trust it the way each platform trusts a CA
  (nginx: the recipe's `proxy_ssl_trusted_certificate` path; Caddy: `SSL_CERT_FILE`; Node.js:
  `NODE_EXTRA_CA_CERTS`; workerd: `tlsOptions.trustedCertificates`; WordPress: the plugin's
  `seed_host_proxy_ca_file` filter from a harness mu-plugin). In production the portal has a
  public certificate and none of this exists.
- **The portal's own edge.** The edge trusts the private Compose ranges (`trusted_proxies static
  private_ranges`), so the `X-Forwarded-Host` a host proxy sends survives to the app. Without it
  Caddy overwrites the header with `portal.test`, which names none of the four mounts sharing
  `/investors`, so their requests would not be mounted (a prefix with a single mount, like
  `/portal`, needs no forwarded host). The shipped `deploy/caddy/Caddyfile` has the same knob as
  `EDGE_TRUSTED_PROXIES`; the docs recommend one mount per prefix instead, because a Cloudflare,
  Vercel or WordPress host's egress addresses cannot sensibly be listed there.
- **The echo.** `https://portal.test/investors/__e2e/echo` is answered by the edge itself (it never
  reaches the app) and prints the `Cookie` and `X-Forwarded-*` headers it received. Through a mount
  (`<mount>/__e2e/echo`) that is exactly what the recipe forwarded — which is how the spec checks
  cookie filtering and the headers without instrumenting the app.
- **HSTS belongs to the host.** The app omits `Strict-Transport-Security` on mounted responses
  and the spec asserts no response through any mount carries it. The echo is answered *with* HSTS
  (standing in for a portal edge that adds it): the Worker and WordPress recipes strip it (and
  `Alt-Svc`); nginx, Caddy and Next.js pass it through, and the docs tell the site owner to drop it.
- **CF-Connecting-IP.** The edge's `worker.test` block sets it, as Cloudflare's edge does; the
  Worker recipe appends it to `X-Forwarded-For`, and the spec checks it arrives first in the list.
- **Marketing pages.** Every host answers `/` with a page that sets `host_session=…; Path=/`
  (WordPress also sets a `wordpress_logged_in_e2e` cookie), so there is a host cookie to leak.

## Deviations and choices

- **workerd, not `wrangler dev`.** The Worker runs in `workerd` itself — Cloudflare's open-source
  runtime, the same engine production uses — pinned (`workerd@1.20260918.1`, binary only) in a
  small image built at `up` time. Wrangler would add a CLI, a bundler and a second copy of workerd
  for nothing the recipe needs. On Cloudflare the recipe's `fetch(request)` fallthrough reaches
  the site's origin; here `harness.js` answers `/` itself and hands everything else to the recipe.
- **WordPress over https, through the edge.** The plugin proxies to `base_url =
  https://portal.test/investors`, exactly as configured in production, not to `http://app:3000`.
  WordPress learns it is https from the edge's `X-Forwarded-Proto` (`WORDPRESS_CONFIG_EXTRA`), and
  trusts the edge's CA through the plugin's own filter.
- **No page cache in front of WordPress.** The plugin's proxy responses carry
  `Cache-Control: private, no-store` and `DONOTCACHEPAGE`, which is what a caching plugin keys on;
  the harness does not run one.
- **Chromium only.** What this rig tests is five proxies and the app's per-request presentation; a
  `SameSite=Lax` first-party cookie on the site's own origin behaves the same in every engine.
  `20-embed-hosts` carries the cross-engine cookie coverage.

## Versions

nginx 1.29 (alpine), Caddy 2 (the digest compose.hosts.yaml pins), workerd 1.20260918.1 on
node:24-slim, Next.js 16.3.5 + React 19.3.0 on node:24-alpine (exact versions, lockfile
committed), WordPress 7.1.2 (php8.3-apache), WP-CLI 2.12.0, MariaDB 11.8.9. Every image is pinned
by digest in the overlay; versions were picked at least a week old (the workspace's
`minimumReleaseAge` rule, applied by hand here since these are not pnpm dependencies).
