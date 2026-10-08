# Path mount: the portal under a path of your site

A path mount serves the portal at `https://acme.com/investors` instead of on its own hostname: a reverse proxy on `acme.com` forwards everything under `/investors` to the portal and passes the answers back. The investor sees one origin in the address bar, and the portal's cookies are first-party on it.

This page is the part every recipe shares — what the portal needs, what the proxy must do, and what it costs. The recipes are the platform-specific halves:

| Host | Recipe | Tested in CI | Forwards your site's cookies to the portal |
|---|---|---|---|
| nginx | [nginx.md](nginx.md) | yes | **all of them** |
| Caddy | [caddy.md](caddy.md) | yes (the "replace" shape) | **all of them** |
| Cloudflare Workers | [cloudflare.md](cloudflare.md) | yes, in `workerd` | only the portal's |
| Next.js (`rewrites()` + `proxy.js`) | [nextjs.md](nextjs.md) | yes | **all of them** |
| Vercel `vercel.json` without Next.js | [nextjs.md](nextjs.md#vercel-without-nextjs-verceljson) | no | **all of them** |
| Netlify (Edge Function wrapping the Worker) | [netlify.md](netlify.md) | no | only the portal's |
| WordPress (plugin proxy mode) | [wordpress.md](wordpress.md#proxy-mode-the-portal-at-acmecominvestors) | yes | only the portal's |

"Tested in CI" means the snippet on the recipe page is byte for byte a file under [`e2e/pathmount/`](../../e2e/pathmount/README.md) that a real server of that kind runs in the `50-path-mount` end-to-end suite, where an investor signs in *through* the mount, opens a lazily loaded screen, reloads a deep link and signs out. Change the file there and the docs change with it.

Path mount is **supported, not recommended**. Read [the costs](#what-it-costs) before building one. If one origin is a preference rather than a requirement, subdomain mode (`investors.acme.com`, a CNAME) gives first-party cookies with none of them.

## Two shapes

- **Preserve** — the proxy forwards the path unchanged: `acme.com/investors/x` → `portal.example/investors/x`. The portal runs with `BASE_PATH=/investors`. Every recipe except Caddy's uses this shape.
- **Replace** — the proxy swaps the prefix: `acme.com/portal/x` → `portal.example/investors/x` (or → `portal.example/x` for a portal at the root of its host, `BASE_PATH` empty). The public prefix differs from the portal's own, and only `X-Forwarded-Prefix` tells the portal what it is. The Caddy recipe is the tested example.

In both, the proxy sends **`X-Forwarded-Prefix: <public prefix>`**. The header *replaces* the portal's base path for presentation; it is never appended to it. So nginx in the preserve shape sending `/investors` to a portal with `BASE_PATH=/investors` gives `/investors`, not `/investors/investors`.

## What the portal needs

| Setting | Value | Why |
|---|---|---|
| `TENANCY_MODE` | `single` | `PATH_MOUNTS` is refused with `multi`. Per-workspace mounts on a multi-tenant install belong to the managed-host control plane. |
| `BASE_PATH` | the path the portal itself serves under, e.g. `/investors`; empty for the root | Routes are registered under it. In the preserve shape it equals the public prefix. |
| `PATH_MOUNTS` | every public URL a proxy serves the portal under, comma-separated: `https://acme.com/investors,https://www.acme.com/investors` | **The gate.** A request is treated as mounted only when its `X-Forwarded-Prefix` names one of these prefixes byte for byte. Any other value is ignored (and logged once at debug level). `https` only in staging and production; at most 16 entries; the same URL twice is refused. |
| `BASE_URL` | the canonical address: either the portal's own (its path ending with `BASE_PATH`; with `BASE_PATH` empty, no path at all), or **one of the `PATH_MOUNTS` URLs** exactly | Everything that is not an answer to the current request — email and magic links, invitations, OIDC and SAML callbacks, vendor webhooks, `security.txt`'s `Canonical`, passkeys — is built from `BASE_URL`, never from request headers. Pick the address investors should end up on. |
| `TRUST_PROXY` | `true` behind the portal's own edge, as always | Not needed for the gate. It decides whether `X-Forwarded-Host` is believed, which only matters when [several sites share one prefix](#several-sites-one-prefix). |
| `CORS_ALLOWED_ORIGINS` | must **not** contain a mount's origin | Refused at boot. A host site's origin is never trusted for credentialed cross-origin calls; a mounted request is same-origin with its site anyway. |
| `FUNDROOM_BASE_PATH` (shipped Caddy edge) | the same value as `BASE_PATH` | The edge's on-demand-TLS `ask` URL, its `/internal/*` and `/metrics` refusals and its health check live under the base path. The Compose stack sets it from `BASE_PATH` for you; any other edge needs the equivalent. `fundroom doctor` reminds you whenever `BASE_PATH` is set. |
| `HSTS_INCLUDE_SUBDOMAINS`, `HSTS_PRELOAD` | leave unset | On a mounted install (`PATH_MOUNTS`, `BASE_PATH` or a `BASE_URL` path set) `includeSubDomains` is off by default and turning it or `preload` on is refused: they would pin every subdomain of a domain the portal does not own. A mounted *response* carries no `Strict-Transport-Security` at all — your site owns its transport policy. |

`fundroom doctor` prints the parsed mounts (`pathMounts`), so a typo shows up before an investor finds it.

## What the proxy must do

1. Forward **both** `/investors` and `/investors/…` — the portal serves both spellings.
2. Send `X-Forwarded-Prefix` with exactly one value, the public prefix. A header with a comma in it (a client's value plus the proxy's, or two proxies appending) never matches — so the proxy must **set** the header, not append to it.
3. Send `X-Forwarded-Proto: https`, and connect to the portal over https with its certificate verified and `Host` set to the portal's hostname (the portal's edge picks its site and certificate by it).
4. Send `X-Forwarded-Host: <your site's host>` where the platform allows. With one mount per prefix it is not needed; it matters only when [several sites share a prefix](#several-sites-one-prefix).
5. Append the visitor's address to `X-Forwarded-For` (see [per-IP limits](#rate-limits-and-client-addresses)).
6. Pass the response back: status, every `Set-Cookie`, `Location`, `Cache-Control`, `Vary`, `Content-Security-Policy`. Do not follow redirects on the portal's behalf. Map an *absolute* `Location` on the portal's own host back onto your site (the portal's own redirects are relative, but its edge's may not be). Drop `Strict-Transport-Security` and `Alt-Svc`: they describe the portal's transport, not your site's. The app sends no HSTS on a mounted response, but an edge in front of it may, and Caddy advertises HTTP/3 in `Alt-Svc` by default. The Worker and WordPress recipes drop both; for the others, the recipe page says how.
7. Not cache anything under the prefix (see [Caching](#caching)).

Then list the mount in `PATH_MOUNTS` and restart the portal.

## What a mounted request changes

Only the presentation of that one response:

- the SPA's router base, API base and every asset URL are under the public prefix (the server rewrites `index.html`; lazily loaded chunks resolve relative to the entry script, so they follow any prefix without a rebuild);
- the session cookies are `__Secure-sid` and friends with `Path=<public prefix>` on your site's origin (`__Host-` is impossible there: it forbids a non-root `Path`);
- relative redirects, the CSP report endpoint and the logo URL are on the mount;
- the CSRF check accepts your site's origin — for this request only. A request that reaches the portal without the header (directly, or a browser forging a form post from your site) is judged against the portal's own origin, and your site's origin is never on the portal's static allow-lists, even when `BASE_URL` is the mount.

Nothing is stored. Emails, magic links and callbacks still go to `BASE_URL`.

## Several sites, one prefix

`PATH_MOUNTS=https://acme.com/investors,https://www.acme.com/investors` is accepted, but think before using it. The mount's origin is what the portal presents — the CSRF origin, the "open in a new tab" address, the logo URL — so when two mounts share a prefix the portal must know which site a request came through, and `X-Forwarded-Prefix` alone cannot say. It tells them apart only by a **believed `X-Forwarded-Host`**: `TRUST_PROXY=true`, and the portal's own edge keeping the header your proxy sent. The shipped Caddy edge keeps it only from addresses in `EDGE_TRUSTED_PROXIES`, so your host proxy's egress addresses have to be listed there. When the forwarded host does not pick one of the mounts, the request is **not mounted** at all (it fails closed, with the symptoms of a missing header); `fundroom doctor` warns about shared prefixes when `TRUST_PROXY` is off, because then they can never be told apart.

A Cloudflare, Vercel, Netlify or shared-hosting WordPress egress address is not something you can list. So the practical rule is **one mount per prefix**: redirect `www.acme.com` to `acme.com` (or the reverse) at your site before the proxy, and list only the address that serves the portal; or give each site its own prefix. A prefix with a single mount needs no forwarded host at all.

## Cookies

The portal's cookies are `Secure; HttpOnly; SameSite=Lax; Path=/investors` on your site's origin. Your site's other pages never receive them, and its JavaScript cannot read them.

The reverse is not automatic. **Every cookie your site scopes to `Path=/` is sent to `/investors` too**, and a proxy that forwards the `Cookie` header forwards them to the portal: CMS sessions, analytics ids, anything. The portal ignores them, but they reach its logs' neighbourhood and its operator's network. nginx, Caddy, Next.js and Vercel cannot filter the header by cookie name without extra machinery; the Cloudflare Worker and the WordPress plugin forward only the portal's own cookies (`__Secure-`/`__Host-` + `sid`, `did`, `auth_req`, `oidc_req`, `sso_req`, `sh_intg`). The end-to-end suite checks both halves.

**Cookie tossing.** `Path=/investors` is not a security boundary against your own domain. Any host under `acme.com` that can set cookies — a forgotten subdomain taken over through a dangling CNAME, a user-content subdomain, a compromised marketing microsite — can plant `__Secure-sid; Domain=acme.com; Path=/investors`, and browsers send it to the mount alongside or instead of the real one. That can sign a visitor in as the attacker's account (whatever they then upload or submit goes to the attacker) or shadow their real session. The `__Host-` prefix that prevents this on the portal's own host cannot be used under a path. Keep every subdomain of the site's domain under control, or use subdomain mode.

A session on the mount is separate from one on the portal's own host: different origins, different cookie jars. An investor signed in at `acme.com/investors` is not signed in at `portal.example`, and signing out on one does not sign out the other. Signing out through a mount does not send `Clear-Site-Data` either, because that header would wipe your whole site's storage, not just the portal's.

## Caching

Every HTML and API response from the portal is `Cache-Control: private, no-store` (or `private`) with `Vary: Cookie, X-Forwarded-Prefix`. The content-hashed files under `assets/` are `public, immutable` and identical under every prefix, so caching those is safe.

A cache in front of your site that ignores `private` — a "cache everything" rule, WordPress APO, a misconfigured CDN — will serve one investor's page to the next visitor. That is a data breach with a 200 status code. Exclude the prefix from every cache layer explicitly; do not rely on the header alone. Verify from a clean profile: signed out, a page under the prefix must show the sign-in screen, and the CDN's cache status must not be a hit.

## Content-Security-Policy and other headers

The portal sends its own strict CSP (nonces, `strict-dynamic`, Trusted Types). If your proxy or CDN adds a site-wide CSP, the browser enforces **both**, and the intersection blocks the portal's scripts: the page stays blank with CSP errors in the console. Scope site-wide security headers to everything *except* the prefix. The same goes for header-rewriting features that inject scripts or minify HTML (Cloudflare Rocket Loader, "optimisation" plugins).

## Uploads and large documents

Everything goes through the proxy — pages, API calls, document views and downloads, and uploads:

- With the filesystem storage driver (the Compose default), uploads are resumable tus requests of **8 MiB** each. Allow request bodies of at least that (the recipes use 25 MB).
- With the S3 driver, upload parts go from the browser straight to the bucket; add each mount origin to the bucket's CORS allowed origins next to the portal's own. (Not covered by the end-to-end suite.)
- Downloads are streamed. A proxy that buffers whole responses (some serverless platforms, PHP without streaming) will struggle with large files; the WordPress plugin streams and was checked with a 300 MB file.
- Set generous read timeouts (the recipes use 300 s where the platform allows).

## Sign-in methods through a mount

`BASE_URL` decides most of this, so set it to the address investors actually use.

- **Email codes** (and passwords, where enabled) work through any mount and on the portal's own host.
- **Magic links and invitations** point at `BASE_URL`. A magic link is bound to the browser that asked for it by a cookie on the origin where it was asked for, so it completes only when that origin is `BASE_URL`'s. Asked for on another mount, the link opens on `BASE_URL` and says it was requested elsewhere; the email's code, typed on the mount, still works.
- **Install-wide OIDC** (`OIDC_ISSUER_URL`) completes only when `BASE_URL` *is* the mount the user started on. The IdP always returns to `BASE_URL`, and the browser-binding cookie set when the login began lives on the origin it began on; begun anywhere else, the callback finds no cookie and the login fails.
- **Per-workspace staff SSO** finishes on the origin the user began on, mount included.
- **Passkeys** work only on `BASE_URL`'s origin — a passkey is bound to one origin and the install has one. Elsewhere (another mount, or the portal's own host when `BASE_URL` is a mount) the portal does not offer them and refuses a passkey ceremony up front; the investor uses a code.

## What it costs

- **Your site's XSS is the portal's XSS.** The portal now shares `acme.com`'s origin. Script injected anywhere on that origin — a vulnerable plugin, a compromised analytics tag, a marketing tool with a template injection — can open `/investors` in a hidden frame or `fetch` it with the investor's cookies and read whatever they can see. `HttpOnly` stops it reading the cookie; it does not stop it *using* the session. The iframe embed and subdomain mode do not have this property.
- **Your site's cookies reach the portal** unless the recipe filters them (above).
- **Your caches can leak investor pages** unless they exclude the prefix (above).
- **Your headers stack on the portal's** (above).
- **Someone has to own the proxy** for as long as the portal exists, and every change to the portal's `BASE_PATH`, `PATH_MOUNTS` or `BASE_URL` has to be matched there.
- **Per-IP limits see the proxy** unless you do the work below.

## Rate limits and client addresses

The portal's per-address rate limits (sign-in codes among them) and its audit log use the client address from `X-Forwarded-For`: with `TRUST_PROXY=true`, the entry `TRUST_PROXY_HOPS` places from the right. A mount adds a hop. Out of the box, mounted traffic therefore shows your proxy's address — or, when the portal's edge does not trust your proxy (`EDGE_TRUSTED_PROXIES`), the edge replaces the header with the proxy's address outright — and every investor behind that proxy shares one budget. A busy site can exhaust it.

To see real addresses, all three have to hold: your proxy appends the visitor's address to `X-Forwarded-For` (nginx's `$proxy_add_x_forwarded_for`, the Worker from `CF-Connecting-IP`, the WordPress plugin from `REMOTE_ADDR`); the portal's edge trusts your proxy's egress addresses so it appends rather than replaces; and `TRUST_PROXY_HOPS` counts the extra hop.

The trade-off is that `TRUST_PROXY_HOPS` is install-wide. Raised by one for the mount, it is one too many for anyone reaching the portal's own host directly: for them, the entry it picks is whatever they put in their own `X-Forwarded-For`, so they choose the address their limits are counted against. Only raise it if the portal's own host is not reachable except through the mount (firewall it to your proxy's addresses). Otherwise accept the shared budget, which fails towards "too strict", not "too loose".

## When it goes wrong

[The path-mount runbook](../runbooks/path-mount.md) walks through the symptoms: everything 404s, assets 404, a sign-in loop, CSRF refusals, a 503 from the portal's edge, and stale or wrong pages from a cache.
