# nginx (path mount)

The most faithful path mount there is: nginx proxies bytes, streams survive, and nothing rewrites your headers behind your back. If the customer has an nginx they control, this is the recipe to use.

Path mount is **supported, not recommended**. Before you build it, read [what it costs](path-mount.md#what-it-costs): the portal ends up inside `acme.com`'s origin, so it shares that origin's XSS blast radius, cookie jar and CDN cache, and someone owns the proxy for as long as the portal exists. Subdomain mode gives first-party cookies with none of that. Choose this when one origin is a requirement, not a preference. [The shared path-mount page](path-mount.md) explains everything below that is not nginx-specific.

## What the platform allows

Everything: streaming, long-lived connections, exact header control.

## Plan gating

None.

## Steps

1. **On the portal** (the "preserve" shape: the path reaches the portal unchanged):

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/investors
   BASE_URL=https://acme.com/investors
   TRUST_PROXY=true
   ```

   `PATH_MOUNTS` is what makes the portal believe the proxy's `X-Forwarded-Prefix`; a prefix that is not listed is ignored. `BASE_URL` is where emails, invitations and sign-in callbacks point — make it the mount if that is where investors should land, or leave it on the portal's own address (`https://portal.example/investors`). On the shipped Compose stack the portal's edge picks up `BASE_PATH` by itself; any other edge must know it too ([the table](path-mount.md#what-the-portal-needs)). Restart the portal; `fundroom doctor` lists the mount under `pathMounts`.

2. **In nginx**, paste this inside your site's `server { … }` block and replace `portal.test` (three places) with the portal's host:

   ```nginx
   # FundRoom path mount — nginx, "preserve" shape.
   #
   # Serves the investor portal at https://<your site>/investors. Paste this inside your site's
   # `server { … }` block. The path is forwarded unchanged: /investors/x → https://portal.test/investors/x.
   # The portal runs with BASE_PATH=/investors and lists https://<your site>/investors in PATH_MOUNTS.
   # Replace portal.test with your portal's host. nginx forwards every cookie of your site to the
   # portal (it cannot filter the Cookie header by name without extra modules): keep secrets out of
   # cookies scoped to Path=/ on this site, or use the Worker or WordPress recipe, which filter.
   location ~ ^/investors(?:/|$) {
       proxy_pass https://portal.test;              # no URI part: the path is passed through as is
       proxy_http_version 1.1;
       proxy_set_header Connection "";

       # Verify the portal's certificate (nginx does not by default) and send SNI.
       proxy_ssl_server_name on;
       proxy_ssl_verify on;
       proxy_ssl_verify_depth 3;
       proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;

       proxy_set_header Host portal.test;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Prefix /investors;

       # An absolute redirect to the portal's own host comes back onto this site.
       proxy_redirect https://portal.test/investors /investors;

       # Data-room uploads; match the portal's own limit if you raised it.
       client_max_body_size 25m;
   }
   ```

   This is `e2e/pathmount/nginx/seed-host-mount.conf`, the file the `50-path-mount` end-to-end suite runs in a real nginx, unchanged.

   Two lines are worth adding in production, inside the same block: `proxy_hide_header Strict-Transport-Security;` and `proxy_hide_header Alt-Svc;`. The portal itself sends no HSTS on a mounted response, but an edge in front of it may, and Caddy advertises HTTP/3 in `Alt-Svc` by default — neither should speak for `acme.com`.

3. `nginx -t && nginx -s reload`, then sign in through `https://acme.com/investors`. The session cookie is `__Secure-sid` on `acme.com` with `Path=/investors`.

## What the snippet does, line by line

- **One regex location covers both spellings**, `/investors` and `/investors/…`, and nothing like `/investorsfoo`. `proxy_pass` has no URI part, so nginx passes the request path through untouched — the preserve shape.
- **`X-Forwarded-Prefix /investors`** is set, not appended, which is what the portal needs: a header with two values never matches. It is the whole signal; without it, the portal presents itself for its own host.
- **`X-Forwarded-Host $host`** names your site. With one mount per prefix the portal does not need it; it only tells [mounts sharing a prefix](path-mount.md#several-sites-one-prefix) apart.
- **`Host portal.test`** and `proxy_ssl_server_name on` make the TLS handshake and the portal edge's site selection work; `proxy_ssl_verify on` makes nginx actually check the certificate, which it does not do by default.
- **`X-Forwarded-For $proxy_add_x_forwarded_for`** appends the visitor's address; see [rate limits](path-mount.md#rate-limits-and-client-addresses) for what the portal does with it.
- **`proxy_redirect`** maps an absolute redirect to the portal's host back onto your site. The portal's own redirects are relative; this is for anything in front of it.
- **`client_max_body_size 25m`** covers uploads, which arrive in 8 MiB chunks with the default storage driver.

## Cookies

nginx forwards **every** cookie your site sets on `Path=/` to the portal: it cannot filter the `Cookie` header by name without extra modules. The portal ignores them, but they leave your server. Keep secrets out of `Path=/` cookies on this site, or use the [Cloudflare Worker](cloudflare.md) recipe in front of it, which filters. The end-to-end suite asserts that nginx does forward them, so this page cannot silently go stale.

The portal's own cookies are `__Secure-sid` and friends with `Path=/investors`. Do not rewrite their `Path` (`proxy_cookie_path`), do not add a `Domain`, and do not let anything downstream "normalise" them.

## Caching

Every HTML and API response under the prefix is `Cache-Control: private, no-store` with `Vary: Cookie, X-Forwarded-Prefix`; files under `/investors/assets/` are content-hashed and `immutable`. Do not add a `proxy_cache` over the prefix — if one is configured in an enclosing block, put `proxy_cache off;` in the portal's location — and if a CDN sits in front of nginx, exclude the prefix there. A cache that serves one investor's page to another is a data breach with a 200 status code.

## Gotchas

- **Regex locations are matched in order, and the first one wins.** A `location ~* \.(js|css|png)$ { expires 1y; … }` for your own static files, declared *above* this block, captures `/investors/assets/*.js` and serves it from your disk: the portal loads a blank page and every asset 404s. Put this block before any other regex location.
- **Your site-wide CSP must not cover the prefix.** `add_header Content-Security-Policy … always` in the `server` block applies to the proxied responses too, on top of the CSP the portal sent. Two CSPs on one response intersect, and the intersection blocks the portal's scripts. Scope the header to the locations that need it.
- **`add_header` in a child block replaces the parent's set, it does not merge.** If you add any header inside the portal's `location`, you silently drop every `add_header` from the enclosing block (usually what you want here, but check). See what the response actually carries: `curl -sSI https://acme.com/investors/`.
- **TLS to the upstream.** A handshake failure shows up as a 502 with nothing useful in the access log — read the error log. `proxy_ssl_trusted_certificate` points at the system bundle on Debian and Alpine images; other distributions keep it elsewhere.
- **`www` and the apex.** If both `acme.com` and `www.acme.com` serve the site, redirect one to the other *before* this location and list only the one that serves the portal in `PATH_MOUNTS`. Two mounts on one prefix need the portal's edge to trust nginx's egress address ([why](path-mount.md#several-sites-one-prefix)).
- **The portal's edge and `BASE_PATH`.** The shipped Caddy edge reads `FUNDROOM_BASE_PATH` (Compose sets it from `BASE_PATH`) for its health check, its on-demand-TLS `ask` URL and its refusal of `/internal/*` and `/metrics`. A custom edge must do the same, or it answers 503 for everything (health check failing) and exposes the internal routes.
- **Stale tabs after a portal upgrade** reload themselves once when a lazily loaded chunk has gone; nothing to configure here.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.
