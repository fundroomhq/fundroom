# WordPress

The only platform with a first-party plugin, because it is the only one where a snippet is not enough: WordPress sites have page caches, a block editor, and — often — their own logged-in members whose identity you may want to carry into the portal.

## What the platform allows

Self-hosted WordPress (`wordpress.org`, not a `wordpress.com` plan below Business) will run a plugin, which gives you a shortcode, a block, a server that can hold a private key, and — as an advanced opt-in since plugin 0.2.0 — a proxy that serves the portal under a path of the site ([proxy mode](#proxy-mode-the-portal-at-acmecominvestors)). Requirements: **WordPress 6.4+ and PHP 8.1+** (proxy mode also needs the PHP cURL extension).

Two constraints from the wordpress.org plugin guidelines shape what the plugin is allowed to be, and they are worth knowing because they explain choices that would otherwise look odd:

- **Guideline 8 — non-service JavaScript must be bundled locally.** So the plugin ships its own copy of `embed.js` and enqueues it from your site, rather than loading it from the portal. An iframe pointing at a documented service is uncontroversial; a script loaded from one is what reviewers reject.
- **Admin pages may not be iframes of a remote dashboard.** So the plugin's settings screen is a native WordPress settings page, not our admin UI in a frame.

The plugin is GPLv2-or-later, as the directory requires.

## Plan gating

None, on self-hosted WordPress. On `wordpress.com`, plugins require the Business plan or above; below that, use the [raw-iframe snippet](quickstart.md#2-the-raw-iframe-snippet) in a Custom HTML block, or subdomain mode.

## Steps

1. Install and activate the **FundRoom** plugin.
2. **Settings → FundRoom**: enter the portal base URL (`https://portal.example`) and the workspace slug (`acme`). The plugin contacts nothing until you do — it cannot, by guideline, and there is no key to enter because there is no embed key.
3. In the portal, **Settings → Embed**, add your site's origins (below).
4. Put the portal on a page, either way:

   **Block editor** — add the **FundRoom Portal** block and set the path and height in the sidebar.

   **Shortcode** — in a classic editor, a widget, or a theme template:

   ```
   [seed_host path="/updates"]
   ```

5. Load the page as a logged-out visitor, in a private window. A page cache will happily serve you an admin-only variant otherwise.

## The snippet, if you would rather not use the plugin

Works in a Custom HTML block. You lose the block, the shortcode and the handoff; you keep everything else.

```html
<div id="investors"></div>
<script src="https://portal.example/embed/v1/embed.js"></script>
<script>
  SeedHost.init({
    workspace: "acme",
    baseUrl: "https://portal.example",
    el: "#investors",
    path: "/updates",
  });
</script>
```

## Origins to add

```
https://acme.com
https://www.acme.com
```

Add the staging site too if there is one (`https://staging.acme.com`), as its own exact entry. There is no preview wildcard for WordPress — the builder-preview toggle covers hosted site builders, not self-hosted WordPress — and you cannot enter `https://*.acme.com` yourself. That refusal is deliberate: a wildcard over your own zone is a standing trust of every host anyone can ever put under it, including the staging box nobody decommissioned and the subdomain-takeover target you have not noticed.

## Signed identity handoff

Optional, and the one thing only a server-side plugin can do: if a visitor is already logged in to WordPress, tell the portal who they are so they do not sign in twice.

How it works: the plugin generates an Ed25519 key pair with PHP's `sodium` (core since 7.2 — no dependency), keeps the private half, and you register the **public** half in the portal. For each logged-in visitor the plugin mints a short-lived signed assertion and hands it to the loader, which posts it into the frame over the bridge. It is never put in a URL, because URLs are logged, refereed, shared, and kept in history.

To enable it:

1. In **Settings → FundRoom**, generate a key pair and copy the public key and its key id.
2. In the portal, **Settings → Embed**, add the key (id, public key, and a label like `acme.com WordPress`) and turn on **Trust host identity**. Both are step-up actions.
3. Tick **Send signed identity** in the plugin.

What it buys, and what it costs:

- It **cannot enrol anyone.** The email in the assertion must already be a member or an invitee of the workspace; an unknown address is refused. A compromised WordPress site can impersonate an investor the founder already invited — it cannot invite one.
- The session it mints is at the **lowest authentication level**, so every step-up gate in the product still asks: the data room's own policy, the freshness requirement on changes, staff MFA.
- An assertion lives **60 seconds** and is **single use**. Replaying one is refused.
- Every acceptance and every rejection is in the audit log.

**Trust host identity is off by default and should stay off unless you want that trade.** It is a real one: a WordPress site is a large attack surface, and turning this on makes a compromise of it into investor impersonation in this workspace. It is the founder's decision, not the web team's.

Registered keys are a whole-list replace: saving the list removes any key you left out. Rotation is add-new, deploy, remove-old, and you can hold up to four keys at once — two is enough for a rotation, four is slack.

## Gotchas

- **Page caches will serve the wrong HTML.** WP Rocket, LiteSpeed Cache, Cloudflare APO and friends cache the rendered page, including whatever the plugin put in it. The embed markup is the same for every visitor so this is usually harmless — but a **signed handoff is per visitor and must never be cached**. The plugin excludes pages carrying one; if you have a cache layer in front of WordPress that it does not know about (a CDN, a reverse proxy), exclude those pages there too. A cached assertion is either expired (harmless, and the visitor just signs in) or served to the wrong person (not harmless). Verify by loading the page as two different logged-in users.
- **Security plugins strip headers and rewrite HTML.** Wordfence, iThemes and several "optimisation" plugins add their own CSP, minify inline scripts, or defer them. If the frame does not appear, disable them one at a time before reading anything else — this is the single most common cause on WordPress.
- **The classic editor eats raw HTML.** If you are pasting the snippet rather than using the plugin, use a Custom HTML block; the visual editor will mangle a `<script>` tag and sometimes drop it entirely.
- **Proxy mode is a different trade**, covered in its own section below. Everything above is about the frame.
- **Multisite**: each site in the network is its own origin. Add each one.

## Proxy mode: the portal at `acme.com/investors`

Plugin 0.2.0 adds an **advanced, off-by-default** mode that serves the portal directly under a path of the WordPress site, with no frame: the WordPress recipe for path mount. WordPress then forwards each request under the path to the portal and streams the answer back. It is tested in CI — the `50-path-mount` end-to-end suite runs the plugin in the official WordPress image and signs an investor in through it.

**Read [what path mount costs](path-mount.md#what-it-costs) before you turn it on.** The portal then lives on the WordPress site's own origin, and a WordPress site is a large attack surface: anything that can run script on any page of it — a vulnerable plugin, a compromised theme, an administrator's custom code — can act as a signed-in investor and read what they can see. The frame does not have that property. The settings screen says so next to the switch.

### Steps

1. **On the portal**:

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/investors
   TRUST_PROXY=true
   ```

   Optionally `BASE_URL=https://acme.com/investors`, so that emails, invitations and sign-in callbacks land on the WordPress site ([what that changes](path-mount.md#sign-in-methods-through-a-mount)). List one mount for the prefix: if both `acme.com` and `www.acme.com` serve WordPress, WordPress already redirects to its configured Site Address — list that one.

2. **In WordPress**, **Settings → FundRoom**: set the portal address to the portal's full address **including its base path** (`https://portal.example/investors`). Under *Advanced: proxy mode*, tick *Serve the portal from this site*, keep or change the path (default `/investors`) and save. The screen shows the exact URL to put in `PATH_MOUNTS`.

   The same from WP-CLI, as the end-to-end suite does it (`e2e/pathmount/wp/setup.sh`; replace the portal address and workspace):

   ```sh
   wp option update seed_host_settings \
     '{"base_url":"https://portal.test/investors","workspace":"acme-inc","proxy_enabled":true,"proxy_prefix":"/investors","proxy_max_body_mb":25}' \
     --format=json
   wp rewrite structure '/%postname%/' --hard
   wp rewrite flush --hard
   ```

   The plugin drops WordPress's cached rewrite rules itself whenever these settings change; the flush is belt and braces. Values set this way are validated when they are read, so WP-CLI cannot store something the settings screen would refuse.

3. **Exclude the path from every cache** in front of WordPress — caching plugins, the host's page cache, the CDN (below).
4. Sign in through `https://acme.com/investors`. The session cookie is `__Secure-sid` on `acme.com` with `Path=/investors`.

Requirements: an `https` portal address, the PHP cURL extension, and pretty permalinks or a web server that sends unknown paths to `index.php` (the default for Apache with WordPress's `.htaccess`, and for the usual nginx `try_files` setup). The path may not be one WordPress owns (`/wp-admin`, `/wp-json`, …); the settings screen refuses those.

### What the proxy does

- Runs before WordPress queries anything or prints a theme, and exits: none of your theme's output surrounds the portal.
- Forwards `GET`, `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE` (anything else is a `405`); refuses dot segments after the prefix (`400`), so a request cannot climb out of the portal's base path.
- Sends `X-Forwarded-Prefix`, `X-Forwarded-Host`, `X-Forwarded-Proto` and appends the visitor's address to `X-Forwarded-For`.
- Forwards **only the portal's own cookies** (`__Secure-`/`__Host-` + `sid`, `did`, `auth_req`, `oidc_req`, `sso_req`, `sh_intg`). `wordpress_logged_in_*` and every other cookie of your site stay on your server. `Authorization` is forwarded only when it is a portal API key or SCIM token (`Bearer frk_…`/`frs_…`, or the pre-rename `shk_…`/`shs_…`), never Basic credentials meant for WordPress.
- Passes back the status, every `Set-Cookie` and the portal's other headers, except hop-by-hop ones and `Strict-Transport-Security` and `Alt-Svc` (your site's transport policy is yours). An absolute redirect to the portal is mapped onto your site.
- Streams both directions with cURL: a 300 MB download passes through a 40 MB PHP memory limit. Request bodies are capped (default 25 MB, *Largest upload* on the settings screen; uploads arrive in 8 MiB pieces, so the default is ample). Timeouts: 10 s to connect, 300 s in total (filter `seed_host_proxy_timeout`).
- If the portal is unreachable, answers a plain `502` without upstream detail (logged under `WP_DEBUG`).
- Verifies the portal's certificate against the system CA store; a private CA can be supplied as a PEM file with the `seed_host_proxy_ca_file` filter.

### Caching

Every proxied response is marked uncacheable — `DONOTCACHEPAGE`, `nocache_headers()`, `Cache-Control: private, no-store`, `Vary: Cookie`, and the switches LiteSpeed Cache and WP Rocket read — except the portal's content-hashed `assets/*` files, which keep their long-lived public caching. **Still add the path to your caching plugin's exclusions and to every CDN rule** (Cloudflare APO in particular): a cache configured to ignore those signals would hand one investor's pages to the next visitor.

### Gotchas

- **Security plugins and optimisers** that add a CSP, minify or defer scripts, or rewrite HTML must leave the path alone. The proxy exits before most of them run, but server-level rules (a Wordfence firewall, a host's HTML optimiser, a CDN feature) still apply. Two CSPs on one response intersect and block the portal's scripts.
- **A WordPress behind a TLS-terminating proxy or CDN** must know it is on https (`is_ssl()`), or it tells the portal `X-Forwarded-Proto: http`. The usual `wp-config.php` fix — trusting the CDN's `X-Forwarded-Proto` — is the one the end-to-end suite uses.
- **Rate limits.** The portal sees your WordPress server's address for every investor unless its edge trusts that address ([details](path-mount.md#rate-limits-and-client-addresses)).
- **Disabling proxy mode** (or deactivating the plugin) returns the path to WordPress, which then 404s it. Remove the mount from `PATH_MOUNTS` too.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.
