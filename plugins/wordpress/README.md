# FundRoom WordPress plugin

The GPLv2-or-later WordPress plugin that embeds a FundRoom portal in a page. User-facing
documentation is `readme.txt` (the file wp.org renders); this file is for people working on it.

Everything in this directory is **GPLv2 or later** (`LICENSE`). The rest of the repository is MIT.
That asymmetry is deliberate and required: distributing through the wp.org directory requires
GPL-compatible licensing, and MIT is compatible in that direction.

It is excluded from the JavaScript toolchain on purpose — `pnpm-workspace.yaml` does not list it and
`biome.json` ignores it — so `pnpm install` never walks in here and Biome never reformats PHP.

## What it does, and what it deliberately does not

`seed-host.php` registers hooks. `includes/class-embed.php` is the **one** renderer: the shortcode
(`includes/class-shortcode.php`) and the block (`blocks/portal/render.php`) both call it, so they
cannot drift. It emits an empty `<div>`, enqueues the locally bundled loader, and calls
`SeedHost.init()`; the loader creates a cross-origin iframe on the portal's origin.

Four constraints shape the whole thing, all from wp.org guideline 8:

1. **The loader is a file in this plugin**, `assets/js/embed.js`, put there at build time from
   `packages/embed/dist/embed.js`. Never a `<script src>` to another host. An *iframe* to a
   documented service is fine; a remote script is not.
2. **No request to the portal until an admin has entered a workspace, and no server-side request
   at all except in the opt-in proxy mode.** No scheduled event, no default option row; the
   activation/deactivation hooks only drop cached rewrite rules when proxy mode is on. The one
   server-side HTTP client is `includes/class-proxy.php`, which does nothing unless an
   administrator has turned proxy mode on. An unconfigured install renders nothing.
3. **The settings screen is native wp-admin**, built on the Settings API. Iframing our own
   dashboard into wp-admin is explicitly disallowed.
4. **GPLv2-or-later on every file**, plus `LICENSE` and the `License:`/`License URI:` lines in
   `readme.txt`.

## Proxy mode (advanced, opt-in)

`includes/class-proxy.php` (WordPress glue, cURL streaming) and `includes/class-proxy-rules.php`
(pure rules, unit-tested without WordPress) serve the portal under a path of this site instead
of in an iframe — the WordPress recipe for the portal's path-mount mode.

Settings (keys of the `seed_host_settings` array option, re-validated on every read so WP-CLI is
safe): `proxy_enabled` (bool, default false), `proxy_prefix` (full public path, default
`/investors`, validated like the portal's `BASE_PATH` and refused for anything WordPress owns),
`proxy_max_body_mb` (default 25). The upstream is `base_url`, the portal's address **including**
its base path. The portal must list `https://<this site><prefix>` in `PATH_MOUNTS`.

```sh
wp option update seed_host_settings '{"base_url":"https://portal.example.com/investors","workspace":"acme","proxy_enabled":true,"proxy_prefix":"/investors","proxy_max_body_mb":25}' --format=json
wp rewrite flush --hard   # optional: the plugin drops cached rules itself when these keys change
```

What a proxied request does:

- Matched on the raw request path in `parse_request` (priority 0) — before any query or theme
  output — and `exit`s. A rewrite rule `^<prefix>(?:/.*)?$ → index.php?seed_host_proxy=1` and the
  query var are registered too, but the raw-path match decides.
- `GET HEAD POST PUT PATCH DELETE` only (else 405). Dot segments after the prefix, raw or
  percent-encoded, are a 400: the portal's origin may serve internal endpoints outside its base path.
- Upstream URL = `base_url` + rest of path + original query. Sends `X-Forwarded-Prefix: <prefix>`,
  `X-Forwarded-Host` (this request's `Host`), `X-Forwarded-Proto` (`is_ssl()`), `X-Forwarded-For`
  (appended), an allow-list of request headers (`Seed_Host_Proxy_Rules::FORWARDED_REQUEST_HEADERS`)
  and **only** cookies named `__Secure-`/`__Host-` + `sid|did|auth_req|oidc_req|sso_req|sh_intg`.
  No `Accept-Encoding` (the portal answers identity; this web server compresses).
- Response: status, all `Set-Cookie`s, every other header except hop-by-hop ones, `Date`,
  `Server`, `X-Powered-By` and caching headers. An absolute `Location` under `base_url` is mapped
  to `<this origin><prefix>`; relative ones pass through (the portal already prefixed them).
  Caching: `DONOTCACHEPAGE`/`DONOTCACHEOBJECT`/`DONOTCACHEDB`, LiteSpeed's `litespeed_control_set_nocache`
  and `X-LiteSpeed-Cache-Control`, WP Rocket's `do_rocket_generate_caching_files`,
  `nocache_headers()`, `Cache-Control: private, no-store`, `Vary: Cookie` (merged with the
  portal's) — except a 200 the portal marks `public, …, immutable` with no `Set-Cookie` (its
  content-hashed `assets/*`), which keeps the portal's `Cache-Control`.
- Streaming: cURL with header/write callbacks echoes each chunk and `flush()`es after dropping
  output buffers, so a 300 MB download passes through a 40 MB `memory_limit`. The WordPress HTTP
  API cannot hand over body chunks as they arrive (it buffers to memory or a file), so this is
  the documented exception; see `Seed_Host_Proxy::transfer()`. Request bodies are spooled to
  `php://temp` (2 MB in memory, then disk) up to the cap (413 beyond), then streamed upstream.
- Redirects are never followed. Timeouts: 10 s connect, 300 s total (`seed_host_proxy_timeout`),
  abandoned after 60 s below 1 byte/s. Upstream failure before any byte → plain-text 502 with no
  upstream detail (logged only under `WP_DEBUG`).
- Upstream must be https, except loopback, `*.localhost`, `*.test`, or `WP_ENVIRONMENT_TYPE`
  `local`/`development`. TLS verifies against the system CA store (`seed_host_proxy_ca_file` filter
  for a PEM bundle). Needs ext-curl; without it the settings screen refuses to enable the mode.

Threat model, stated on the settings screen: the portal shares this site's origin, so XSS
anywhere on the WordPress site reaches investor data; caches in front of the site must exclude
the prefix.

## Tests

```sh
composer test              # php tests/run.php: pure rules + cURL transfer against `php -S`
```

No WordPress needed (PHP ≥ 8.1 with ext-curl). `tests/upstream.php` is the stand-in portal.
Without a local PHP:
`docker run --rm -v "$PWD":/app -w /app php:8.1-cli php tests/run.php`.

## Versioning

`readme.txt`'s `Stable tag` is the single source of truth. The build stamps it into the `Version:`
plugin header and the `SEED_HOST_VERSION` constant. The plugin is **not** managed by Changesets
(`.changeset/README.md` says so): bump `Stable tag` and add a `== Changelog ==` entry in the same
commit, and leave the core packages' versions alone.

`Tested up to` should be raised when a new WordPress release has actually been tested against, not
speculatively.

## Build

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
pnpm --filter @fundroom/embed build          # produces packages/embed/dist/embed.js
node scripts/build-wordpress-plugin.mjs       # → plugins/wordpress/dist/seed-host.zip
```

The build fails, loudly, if the loader has not been built — that file is the guideline 8 compliance
story, so a zip without it must not exist. The zip is deterministic (fixed entry timestamps), so
the same tree always produces the same bytes and a release artefact can be checksummed.

`assets/js/embed.js` is committed as a placeholder that logs an error, not as a stale copy of the
loader: a checked-in build silently disagreeing with the portal it was built against is worse than
an obvious absence.

## Lint

```sh
composer install
composer run lint          # phpcs, WPCS + PHPCompatibilityWP, config in phpcs.xml.dist
composer run lint:fix      # phpcbf
```

`composer.json` is development-only; the shipped plugin has no autoloader and no PHP package
dependencies. Signing uses `sodium`, which has been part of PHP core since 7.2.

Quick syntax check without composer:

```sh
find plugins/wordpress -name '*.php' -print0 | xargs -0 -n1 php -l
```

## Manual test plan

There is no PHPUnit suite here yet (`composer test` covers proxy mode's rules without WordPress);
E2.2's `e2e/hosts` harness is where a real WordPress is driven end to end. Until then:

1. **Fresh install.** Activate on a site with no settings. Confirm no HTTP request leaves the site
   (`wp_remote_*` is not called anywhere — grep for it), the block and shortcode render nothing for
   a logged-out visitor, and an administrator sees the "not connected" note.
2. **Configured.** Set the portal address and workspace. Add the WordPress origin to the workspace's
   allowed embed origins in the portal. Confirm the iframe renders, grows to fit its content, and
   that `?sh=/updates`-style history sync works if the loader is configured for it.
3. **Two embeds on one page.** Confirm both get distinct container ids and both initialise.
4. **Misconfigured deliberately.** Blank the workspace: the front end must show nothing rather than
   a broken frame.
5. **Handoff.** Generate a keypair, register the public key in the portal, enable
   `trustHostIdentity` there, log in as a WordPress user whose email is a member of the workspace,
   and confirm the frame arrives authenticated. Then confirm: a logged-out visitor gets no
   assertion at all; the same page served twice mints two different `jti` values; and the response
   carrying an assertion is not cacheable.
6. **Handoff on http.** Confirm nothing is minted and the admin notice explains why.
7. **Uninstall.** Delete the plugin and confirm all four `seed_host_*` options are gone, including
   `seed_host_handoff_secret_key`.
8. **Proxy mode.** Enable it with a portal whose `PATH_MOUNTS` lists this site's
   `https://<host>/investors`. Sign in at `/investors`, confirm the session cookie is
   `__Secure-sid; Path=/investors` on this site, a WordPress login cookie never reaches the portal,
   a data room download streams, responses carry `Cache-Control: private, no-store`, and that
   saving `/wp-admin` as the path is refused. Turn it off and confirm `/investors` is WordPress's
   again. The path-mount e2e harness (`e2e/pathmount/`) drives this end to end.

## The handoff assertion

Minted by `includes/class-handoff.php` at render time and passed to `SeedHost.init({ handoff })`,
which posts it into the frame. Never in a URL. Verified by
`packages/identity/src/services/handoff.ts`, which is the authority on what is acceptable:

```
header  { "alg": "EdDSA", "typ": "JWT", "kid": "wp-<16 hex>" }
claims  { "iss": "https://example.com",   // this site's origin: https, no path, lower-cased
          "aud": "<workspace slug>",
          "sub": "<logged-in user's email>",
          "iat": <unix seconds>,
          "exp": <iat + 60>,
          "jti": "<24 base64url chars>" }
```

Signed with `sodium_crypto_sign_detached` over `base64url(header) + "." + base64url(claims)`. The
private key lives in the `seed_host_handoff_secret_key` option with `autoload` off and never leaves
the site; only the key id and public key are shown, for pasting into the portal.

Things that will get an assertion rejected, and are therefore checked here first: a non-https or
path-carrying `iss`, a lifetime over 60 s, a `jti` outside `^[A-Za-z0-9_.-]{8,200}$`, an `aud` that
is not exactly the workspace slug, and a `kid` the portal does not have registered.
