# Runbook: diagnose a path mount

A path mount is the portal served under a path of someone else's site — `https://acme.com/investors` — through a reverse proxy the customer runs (nginx, Caddy, a Cloudflare Worker, Next.js, the WordPress plugin's proxy mode). Three parties have to agree: the customer's proxy, the portal's own edge, and the portal's configuration. Almost every failure is two of them disagreeing about one of four things: the path, the `X-Forwarded-Prefix` header, a cookie's name or `Path`, or a cache.

This runbook is for whoever operates the install. The customer-facing side is [`docs/embed/path-mount.md`](../embed/path-mount.md) and the recipe pages next to it. An iframe embed that will not render is a different problem: [embed-troubleshooting.md](embed-troubleshooting.md).

## What has to be true first

- **You know the four values**: the portal's `BASE_PATH`, its `BASE_URL`, its `PATH_MOUNTS`, and the exact public URL the investor uses (scheme, host, path — `https://www.acme.com/investors` and `https://acme.com/investors` are different mounts).
- **`fundroom doctor` runs clean.** It prints the parsed mounts on its `pathMounts` row, refuses a bad entry (http in production, no path, the same mount twice, more than 16, `TENANCY_MODE=multi`, a mount origin in `CORS_ALLOWED_ORIGINS`), and warns when mounts share a prefix while `TRUST_PROXY` is off.
- **You can reach the portal directly**, not only through the mount, so you can tell "the portal is broken" from "the mount is broken".
- **You can see what the proxy sends.** The quickest way is a request through the mount with the portal's debug logging on; the portal logs an ignored `X-Forwarded-Prefix` once per distinct value per process as `http.path_mount_ignored`. Failing that, ask for the proxy's configuration and compare it with the recipe page line by line.
- **A clean browser profile.** Old cookies from an earlier attempt, on the same origin with a different `Path`, cause exactly the symptoms below.

A quick test of whether a request is mounted, from anywhere that can reach the site:

```sh
curl -s https://acme.com/investors/ | grep -o '<meta name="seed-host:config"[^>]*>'
```

In the config, `basePath` must be the public prefix and `canonicalOrigin` must be the site's origin plus the prefix (`https://acme.com/investors`). If `canonicalOrigin` names the portal's own host, the portal did not treat the request as mounted: go to section 4.

## 1. Every path 404s

Your site's 404, or the portal's, on `/investors` and everything under it.

1. **Whose 404 is it?** The portal's has its own look and a `Content-Security-Policy` with a nonce. Your site's means the proxy rule did not match: the location/route/matcher is wrong or shadowed (nginx: an earlier regex `location`; Caddy: another `handle`; Next.js: a `basePath` prefixing the rewrite source; Cloudflare: no route; WordPress: proxy mode off, or permalinks plain).
2. **The portal's 404 means the path arrived under the wrong prefix.** The portal serves only under `BASE_PATH`. In the preserve shape the proxy must forward the path unchanged (`proxy_pass https://portal.example;` with no URI part); in the replace shape it must rewrite the public prefix to `BASE_PATH`, not strip it. `curl -sI https://portal.example<BASE_PATH>/` directly should answer 200; if it does and the mount does not, the proxy is rewriting the path.
3. **Only the bare path 404s** (`/investors` but not `/investors/`): the proxy handles one spelling. Every recipe forwards both; Next.js needs its bare rewrite rule.

## 2. The page loads, but assets 404 or the page stays blank

1. **Look at the asset URLs.** `curl -s https://acme.com/investors/ | grep -o 'src="[^"]*"'` — every one must start with the public prefix (`/investors/assets/…`). If they start with `/assets/` or with `BASE_PATH` while the public prefix differs, the request was not mounted: section 4.
2. **The URLs are right but 404:** something in front of the proxy serves `…/assets/*` itself — a regex location for static files (nginx), a CDN rule for `*.js`, a static-file handler. Take the prefix out of it.
3. **A blank page with CSP errors in the console:** the site adds its own `Content-Security-Policy` to the proxied responses. Two policies intersect; the portal's scripts are refused. Exclude the prefix from the site's header rules (the recipe pages show where).
4. **A lazily loaded screen fails after a portal upgrade:** a tab from before the upgrade asked for a chunk the new build does not have. The portal reloads once by itself; if it loops, a cache in front is serving an old `index.html` (section 6).

## 3. Sign-in loops, or the investor is signed out on every page

1. **Check the cookie in the browser**, on the site's origin: `__Secure-sid`, `Path=<public prefix>`, `Secure`, `HttpOnly`, `SameSite=Lax`. Its `Path` must match the URL the investor uses, character for character.
2. **No cookie at all:** the proxy dropped `Set-Cookie` (some platforms merge or drop repeated headers), or the site is served over `http` (a `Secure` cookie is refused there). The recipes pass every `Set-Cookie` through.
3. **A cookie with the wrong `Path`** (the portal's `BASE_PATH` instead of the public prefix): the request was not mounted when the cookie was set — section 4. Something rewriting cookie paths (`proxy_cookie_path`) does the same; remove it.
4. **`__Host-sid` instead of `__Secure-sid`:** the request was not mounted and the portal runs at the root of its host (`BASE_PATH` empty). Section 4.
5. **Two `__Secure-sid` cookies** on the site's origin, one of which you did not expect with `Domain=acme.com`: something else on the domain planted it (cookie tossing). Clear it and find the subdomain that set it.
6. **Signed in on the mount but not on the portal's own host, or the reverse:** expected. They are different origins with different cookie jars.
7. **Passkey sign-in missing or refused:** expected everywhere except `BASE_URL`'s origin. A passkey is bound to one origin; use a code.
8. **A magic link says it was requested from a different browser**, or the install-wide OIDC login fails at the callback: the sign-in began on a mount that is not `BASE_URL`. The binding cookie lives where the sign-in began, and the link or the IdP returns to `BASE_URL`. Use the emailed code, or set `BASE_URL` to the mount investors use.

## 4. The request is not mounted: CSRF 403s, wrong links, wrong cookie

The signature: forms and sign-out fail with `403 csrf_rejected` in some browsers, `canonicalOrigin` in the page config names the portal's own host, cookies carry `BASE_PATH` rather than the public prefix. The portal decided the request did not come through a mount. It decides that when:

1. **`X-Forwarded-Prefix` did not arrive.** Platforms whose rewrites cannot set request headers (a Vercel `rewrites` entry, Netlify `_redirects`) never send it; the recipe pages give the variant that does. A proxy that *appends* rather than sets produces `/investors, /investors`, which never matches.
2. **It arrived but is not in `PATH_MOUNTS`.** The comparison is byte for byte after trimming one trailing `/`: `/Investors` is not `/investors`. The portal logs the ignored value once (`http.path_mount_ignored`, debug level). Add the exact public URL to `PATH_MOUNTS` and restart.
3. **Several mounts share the prefix and the forwarded host did not pick one.** With `https://acme.com/investors,https://www.acme.com/investors`, the portal needs `TRUST_PROXY=true` *and* an `X-Forwarded-Host` its own edge kept — the shipped Caddy edge keeps it only from addresses in `EDGE_TRUSTED_PROXIES`. Otherwise the request fails closed and is not mounted. Prefer one mount per prefix (redirect `www` to the apex, or the reverse, at the site).
4. **The portal's own edge dropped the header.** Unusual (the shipped Caddy edge passes it), but a WAF or load balancer in front of the portal may strip unknown `X-Forwarded-*` headers.

Why only *some* browsers fail CSRF: a browser that sends Fetch Metadata marks a form post from the site to its own path `Sec-Fetch-Site: same-origin`, which passes whatever the portal thinks its origin is. Older browsers send only `Origin`, which then has to equal the mount's origin — and the portal accepts the mount's origin only on a mounted request. The site's origin is deliberately never on the portal's static allow-lists (`CORS_ALLOWED_ORIGINS` refuses it, and it is not added even when `BASE_URL` is the mount), so that a browser cannot forge a form post from `acme.com` straight to the portal's own host.

## 5. The portal's edge answers 503 for everything

With `BASE_PATH` set, the shipped Caddy edge's active health check probes `{$FUNDROOM_BASE_PATH}/healthz`. If the edge does not know the base path (`FUNDROOM_BASE_PATH` unset in *its* environment), the probe hits `/healthz`, gets a 404, marks the app unhealthy and answers 503 to every request — direct and mounted alike. Compose passes `BASE_PATH` through as `FUNDROOM_BASE_PATH`; Helm, Coolify or a hand-written edge must do the equivalent. The same variable moves the edge's `/internal/*` and `/metrics` refusals and the on-demand-TLS `ask` URL; `fundroom doctor` warns about it whenever `BASE_PATH` is set.

## 6. Stale pages, or one investor sees another's page

**Treat the second as an incident** ([incident-response.md](incident-response.md)): a cache in front of the site served a private response. The portal marks every HTML and API response `Cache-Control: private, no-store` with `Vary: Cookie, X-Forwarded-Prefix`, so something is overriding it — a Cloudflare "Cache Everything" rule or APO, a WordPress page cache that ignores `DONOTCACHEPAGE`, a CDN with a forced TTL.

1. Find the layer: request a page under the prefix twice while signed out and read the cache headers (`cf-cache-status`, `x-cache`, `age`, `x-litespeed-cache`). A hit on HTML is the bug.
2. Exclude the prefix from that layer explicitly — every recipe page names the switch — and purge it.
3. Revoke the sessions of the investors whose pages may have been served (**People →** the person **→ Sessions**; [incident-response.md](incident-response.md) covers the rest of containment).

Only `<prefix>/assets/*` (content-hashed, `immutable`) may be cached.

## 7. Everyone behind the mount hits a rate limit

Investors signing in through the mount get `429` on code requests while direct sign-ins work. The portal counts per-address limits against the address its edge saw, which for mounted traffic is the customer's proxy: everyone behind it shares one budget. The fix and its trade-off (`EDGE_TRUSTED_PROXIES`, `TRUST_PROXY_HOPS`, and why raising the hop count lets direct clients choose their own address) are in [the path-mount page](../embed/path-mount.md#rate-limits-and-client-addresses). For a one-off spike, waiting out the window is usually the answer.

## 8. Uploads fail through the mount

Uploads through the filesystem storage driver arrive as 8 MiB requests. A `413` means the proxy's body limit is smaller (nginx `client_max_body_size`, the WordPress plugin's *Largest upload*, a platform limit); a `502`/`504` mid-upload is a proxy timeout. With the S3 driver the browser uploads straight to the bucket: a CORS error in the console means the bucket's CORS rules do not list the mount's origin.

## Keys and settings this runbook refers to

| Key | Where | Default |
|---|---|---|
| `BASE_PATH` | app | empty; the path the portal's routes live under |
| `BASE_URL` | app | required; the canonical address — its path ends with `BASE_PATH`, or it is exactly one `PATH_MOUNTS` URL |
| `PATH_MOUNTS` | app | empty; public `origin + prefix` URLs a proxy serves the portal under (max 16, https in staging/prod, single-tenant only) |
| `TRUST_PROXY` | app | `false` (`true` in the image); needed only to tell mounts sharing a prefix apart |
| `TRUST_PROXY_HOPS` | app | `1`; see section 7 before changing it |
| `CORS_ALLOWED_ORIGINS` | app | empty; may not contain a mount's origin |
| `HSTS_INCLUDE_SUBDOMAINS`, `HSTS_PRELOAD` | app | off for a mounted install, and refused if set; mounted responses carry no HSTS at all |
| `FUNDROOM_BASE_PATH` | edge (shipped Caddyfile) | empty; must equal `BASE_PATH` (Compose sets it) |
| `EDGE_TRUSTED_PROXIES` | edge (shipped Caddyfile) | loopback; addresses whose `X-Forwarded-*` the edge keeps |
| `proxy_enabled`, `proxy_prefix`, `proxy_max_body_mb` | WordPress plugin (`seed_host_settings`) | off, `/investors`, 25 |
