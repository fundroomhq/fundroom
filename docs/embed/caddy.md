# Caddy (path mount)

Caddy does a path mount in a dozen lines, with verified TLS to the portal and sensible forwarded headers by default. This recipe also shows the second shape the portal supports: the public path differs from the portal's own. Your site serves the portal at `acme.com/portal`; the portal itself runs under `/investors`.

Path mount is **supported, not recommended**: read [what it costs](path-mount.md#what-it-costs) first. [The shared path-mount page](path-mount.md) explains everything below that is not Caddy-specific.

## What the platform allows

Everything, as with nginx. Caddy's `reverse_proxy` streams, verifies the upstream certificate against the system roots, and sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` itself.

## Plan gating

None.

## Steps

1. **On the portal** (the "replace" shape: the proxy swaps `/portal` for `/investors` and says so in `X-Forwarded-Prefix`):

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/portal
   TRUST_PROXY=true
   ```

   `BASE_URL` stays the portal's own address (`https://portal.example/investors`), or becomes `https://acme.com/portal` if that is where emails and sign-in callbacks should land — it must then be one of the `PATH_MOUNTS` URLs exactly.

2. **In your Caddyfile**, inside the site block for `acme.com` (or save the snippet as a file and `import` it there), replacing `portal.test` with the portal's host:

   ```caddy
   # FundRoom path mount — Caddy, "replace" shape.
   #
   # Serves the investor portal at https://<your site>/portal although the portal itself runs under
   # /investors: /portal/x → https://portal.test/investors/x, with `X-Forwarded-Prefix: /portal` so
   # the portal presents itself (links, assets, cookie Path) under /portal. The portal runs with
   # BASE_PATH=/investors and lists https://<your site>/portal in PATH_MOUNTS. Paste inside your
   # site block (or `import` this file there); replace portal.test with your portal's host. Caddy
   # forwards every cookie of your site to the portal: keep secrets out of Path=/ cookies here.
   @fundroom path /portal /portal/*
   handle @fundroom {
   	uri path_regexp ^/portal /investors
   	reverse_proxy https://portal.test {
   		header_up Host {upstream_hostport}
   		header_up X-Forwarded-Prefix /portal
   		# An absolute redirect to the portal's own host comes back onto this site.
   		header_down Location ^https://portal\.test/investors /portal
   	}
   }
   ```

   This is `e2e/pathmount/caddy/seed-host-mount.caddy`, imported unchanged by the Caddy site the `50-path-mount` end-to-end suite runs.

   In production also add `header_down -Strict-Transport-Security` and `header_down -Alt-Svc` inside the `reverse_proxy` block: the portal sends no HSTS on a mounted response, but its edge may, and a Caddy edge advertises HTTP/3 by default — neither should speak for `acme.com`.

3. `caddy validate` and reload, then sign in through `https://acme.com/portal`. The session cookie is `__Secure-sid` on `acme.com` with `Path=/portal` — the *public* prefix, not the portal's own.

## What the snippet does

- **`@fundroom path /portal /portal/*`** matches both spellings and nothing like `/portalx`.
- **`uri path_regexp ^/portal /investors`** turns `/portal/x` into `/investors/x` before proxying. A preserve-shape mount (public prefix = `BASE_PATH`) simply leaves this line out.
- **`header_up Host {upstream_hostport}`** sends the portal's own hostname, so its edge picks the right site and certificate. `reverse_proxy` already sends `X-Forwarded-Host` (your site's host), `X-Forwarded-Proto` and `X-Forwarded-For`.
- **`header_up X-Forwarded-Prefix /portal`** is the whole signal. It must name the *public* prefix exactly as listed in `PATH_MOUNTS`; the portal uses it instead of `BASE_PATH` for links, assets, cookie `Path` and the CSRF origin.
- **`header_down Location …`** maps an absolute redirect to the portal's host back onto your site. The portal's own redirects are relative (and already under `/portal`); this is for anything in front of it.

## Cookies

Caddy forwards **every** cookie your site sets on `Path=/` to the portal; it has no built-in way to filter the `Cookie` header by name. The portal ignores them, but they leave your server. Keep secrets out of `Path=/` cookies on this site. The end-to-end suite asserts that Caddy does forward them.

## Caching

Caddy does not cache unless you add a cache module. If you have one, or a CDN in front, exclude `/portal*`: every HTML and API response is `private, no-store` with `Vary: Cookie, X-Forwarded-Prefix`, and only `/portal/assets/*` (content-hashed, `immutable`) is safe to cache.

## Gotchas

- **Forwarded headers from Caddy's own clients.** Caddy passes on an inbound `X-Forwarded-*` only from addresses in its `trusted_proxies`; otherwise it writes its own. Leave it that way unless a CDN in front of your Caddy really is trusted.
- **Site-wide `header` directives apply here too.** A `header Content-Security-Policy …` in the site block lands on the portal's responses on top of its own CSP, and the intersection blocks the portal's scripts. Put site-wide headers in a `handle` that excludes the prefix, or remove them inside `handle @fundroom` with `header -Content-Security-Policy`.
- **`handle` blocks are mutually exclusive, first match by specificity.** A broader `handle /portal*` or a `file_server` in another `handle` that also matches will shadow this one; `caddy adapt` shows the order Caddy chose.
- **Request body size.** Caddy has no default limit; if you set `request_body { max_size … }` site-wide, allow at least 8 MiB for uploads under the prefix.
- **The portal's edge and `BASE_PATH`.** The shipped Caddy edge in front of the *portal* (not this one) must know the portal's `BASE_PATH` through `FUNDROOM_BASE_PATH` — Compose sets it for you. A custom edge that does not answers 503 (health check) or exposes `/internal/*`.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.
