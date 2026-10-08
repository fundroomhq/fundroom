=== FundRoom ===
Contributors: seedhost
Tags: investor relations, embed, investors, portal, block
Requires at least: 6.4
Tested up to: 6.9
Requires PHP: 8.1
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Put your FundRoom investor portal on a WordPress page with a block or a shortcode, and optionally sign logged-in members straight in.

== Description ==

[FundRoom](https://github.com/fundroomhq/fundroom) is a self-hostable investor relations portal: updates, a gated data room, KPIs and an investor list. This plugin puts that portal inside a page on your WordPress site, so your investor area lives at `yoursite.com/investors` instead of on a separate address.

The portal renders in a frame served from your portal's own address. Your WordPress site does not proxy it, does not store any of it, and never sees a document, an investor list or an access log. The only thing this plugin adds to a page is an empty container and a small script — included in this plugin, not loaded from anywhere else — that creates the frame.

An **advanced, opt-in proxy mode** can instead serve the portal directly under a path of your site, such as `yoursite.com/investors`, with no frame. It is off by default and changes the security picture — see *Proxy mode* below before turning it on.

**What you get**

* An **Investor portal** block, and a `[seed_host]` shortcode for classic editor and page-builder content.
* A native settings screen: your portal address, your workspace, the page the embed opens at, and how much height to reserve.
* Automatic height: the portal reports its own height, so the page has no inner scrollbar and no dead space.
* Optional **identity handoff**: if someone is logged in to your WordPress site, your server can tell the portal who they are, so they do not sign in twice. It is off by default — see Privacy below, and read it before turning it on.
* Optional **proxy mode** (advanced): forward everything under one path of your site to the portal. Off by default.

**Requirements**

* A FundRoom portal you or your host runs, and a workspace on it.
* Your WordPress site's address must be added to that workspace's list of allowed embed origins, in the portal's own settings. Until it is, the portal refuses to be framed by your site — that allow-list is the security boundary and this plugin cannot and does not change it for you.

**Not for the general public.** Investor content sits behind a login inside the frame. Placing the block on a public page is expected and safe; the frame shows a sign-in screen to anyone who is not a member.

== Installation ==

1. Install and activate the plugin.
2. Go to **Settings → FundRoom** and enter your portal address (for example `https://portal.example.com`) and your workspace slug. Both are on the Embed screen in your portal workspace settings.
3. In the portal, add this site's address (for example `https://www.example.com`) to the workspace's allowed embed origins.
4. Edit a page, add the **Investor portal** block — or paste `[seed_host]` — and publish.

Nothing in this plugin contacts the portal until you have completed step 2: on a fresh install, and while the settings are empty, the block and the shortcode render nothing at all.

**Optional: identity handoff**

1. On **Settings → FundRoom**, tick *Sign in logged-in users* and press *Generate a keypair*.
2. Copy the **key ID** and **public key** shown, and add them to Embed → Handoff keys in your portal workspace settings.
3. In the portal, turn on *trust host identity* for that workspace.

Your site keeps the private half of the key and never sends it anywhere. Handoff requires HTTPS on this site.

**Optional, advanced: proxy mode**

1. On **Settings → FundRoom**, set the portal address to the portal's full address, including its base path if it has one (for example `https://portal.example.com/investors`).
2. Under *Advanced: proxy mode*, tick *Serve the portal from this site*, choose the path (default `/investors`) and save.
3. Add the address the screen shows — for example `https://www.example.com/investors` — to the portal's `PATH_MOUNTS` setting and restart the portal.
4. Exclude that path from every page cache and CDN rule in front of this site.

Proxy mode needs an https portal address and the PHP cURL extension. It requires pretty permalinks or a web server that sends unknown paths to WordPress's `index.php` (the default for Apache with WordPress's `.htaccess`, and for the usual nginx `try_files` setup).

== Frequently Asked Questions ==

= Does my investor data go through WordPress? =

Not with the block or the shortcode. The portal is rendered in a frame served by the portal itself, on the portal's own address. WordPress sends the visitor's browser an empty container; the browser then talks to the portal directly. No document, update, investor name or view record passes through this site or is stored in its database.

In **proxy mode** it does pass through: your server forwards each request under the portal path to the portal and streams the answer back. Nothing is stored — not in the database, not in a cache, not on disk beyond PHP's own temporary spooling of an upload in progress — but the bytes cross your server.

= What does proxy mode change about security? =

The portal then lives on your WordPress site's own origin. Browsers isolate sites by origin, so anything that can run script on any page of your WordPress site — a vulnerable plugin, a compromised theme, an administrator's custom code — can read what a signed-in investor can see and act as them. With the frame, the portal keeps its own origin and that is not possible. Your page caches and CDN must also leave the portal path alone: the plugin marks every proxied page private and uncacheable, but a cache configured to ignore that would hand one investor's pages to another. WordPress's own cookies are never forwarded to the portal; only the portal's are. Use proxy mode when an address on your own domain matters more than that isolation, and keep this site's plugins up to date.

= Does this plugin load anything from your servers? =

No script, no stylesheet, no font, no tracking. The loader script is a file inside this plugin. The visitor's browser does load a page from your portal's address, because that is what an embedded portal is.

= Can I put the portal on more than one page? =

Yes, and more than one on the same page. Each block or shortcode can open at a different path, for example `[seed_host path="/updates"]` and `[seed_host path="/data-room"]`.

= What does the height setting do? =

It reserves space so the page does not jump while the portal loads. After that the frame resizes itself to fit its content, so the number is a floor rather than a fixed height.

= Nothing appears on the page. =

Three usual causes, in order: the settings are empty (the plugin then renders nothing on purpose — administrators see a note in its place); this site's address is not in the portal workspace's allowed embed origins; or the page is cached and was cached before you configured the plugin. Your browser's console will name the first two.

= Can I use this with a page caching plugin? =

Yes. Pages that carry a handoff assertion mark themselves as uncacheable (`DONOTCACHEPAGE` plus no-cache headers), because such an assertion names one person and is valid for sixty seconds. Pages without handoff cache normally.

In proxy mode, every proxied response is marked uncacheable (`DONOTCACHEPAGE`, `Cache-Control: private, no-store`, `Vary: Cookie`, and LiteSpeed's and WP Rocket's own switches); only the portal's fingerprinted script and style files keep their long-lived public caching. Still add the portal path to your caching plugin's and CDN's exclusions — see the question above.

= Is the portal itself included? =

No. This plugin embeds a portal you run. FundRoom is open source (MIT) and self-hostable; this plugin is GPLv2 or later.

== Privacy ==

This plugin sends **no data to the plugin authors**, contains no analytics, no telemetry and no external requests of its own. It sets no cookies of its own. What follows is everything that leaves your site as a result of installing it.

**1. Your settings, stored on your site.** Your portal address, workspace slug, default path, default height, the handoff on/off flag, and — if you generate one — a signing key pair. These are rows in your own `wp_options` table. The private key never leaves your server. Uninstalling the plugin deletes all of them, the private key included.

**2. Every page with an embed on it: the visitor's browser loads a frame from your portal's address.** As with any embedded page, that means the visitor's browser makes a request to your portal, and your portal therefore receives what any web server receives: the visitor's IP address, their user agent, and the address of the page the frame is on (as the `Referer`). The portal uses that last one to check that it is being embedded by a site you allowed. If the visitor signs in to the portal inside the frame, the portal sets its own cookie on its own address — this plugin is not involved and WordPress cannot read it. **No data about the visitor is sent from WordPress itself**: the embed is a container and a script, and the browser does the rest.

**3. Only if you turn on identity handoff, and only for visitors who are logged in to WordPress: the email address of the logged-in user is sent to the portal, signed by your server.** Nothing else about the user — not their WordPress username, display name, roles, ID or any other profile field or metadata. In detail, your server puts the address into a signed statement (a JSON Web Signature) that also carries your site's address, your workspace slug, the time, an expiry sixty seconds later, and a random single-use identifier. It is signed with the Ed25519 private key stored on your site, handed to the loader script, and passed to the frame with `postMessage` — never in a URL, so it does not appear in server logs, browser history or referrer headers. The portal accepts it only if the workspace has been configured to trust this site, the key is registered there, and the address already belongs to one of its members; it then records the sign-in in its audit log. For visitors who are not logged in to WordPress, nothing is sent and nothing is signed.

Turning handoff on has a security consequence you should weigh: anyone who can administer this WordPress site can cause the portal to sign them in as any existing member of that workspace. That is inherent to one site vouching for identities to another. It is off by default on both sides.

**4. Only if you turn on proxy mode, and only for requests under the portal path: your server forwards the request to your portal.** That is the only case in which this plugin makes a server-side request. What is forwarded: the method, path and query string; the request body (capped, 25 MB by default); the headers a browser needs for pages, downloads and uploads (such as `Accept`, `Accept-Language`, `Content-Type`, `Origin`, `Referer`, `User-Agent`, range and conditional-request headers, and `Authorization` when an API client sends one); the visitor's IP address, appended to `X-Forwarded-For`; this site's host name and the portal path; and **only the portal's own cookies**. WordPress's login, comment and other cookies are never forwarded. The portal's answer — including the cookies it sets, on your site's address, under the portal path — is streamed back to the visitor and not stored. Requests anywhere else on your site are not affected.

Your portal's own privacy notice covers what it does with the above; this plugin adds nothing to it.

== Source code ==

This plugin is developed in the open at https://github.com/fundroomhq/fundroom, under `plugins/wordpress/`. Every file shipped here is human-readable source as written, with one exception: `assets/js/embed.js` is a compiled bundle of `packages/embed/` from the same repository (MIT licensed), produced by `scripts/build-wordpress-plugin.mjs`. That script, the loader's sources and its build configuration are all in the repository.

== Changelog ==

= 0.2.0 =
* New, advanced and off by default: proxy mode serves the portal under a path of this site (for example `/investors`) instead of in a frame. Streams responses, forwards only the portal's cookies, never caches proxied pages. Read the proxy mode FAQ before enabling it.

= 0.1.0 =
* First release: Investor portal block, `[seed_host]` shortcode, native settings screen, automatic height, optional Ed25519 identity handoff.

== Upgrade Notice ==

= 0.2.0 =
Adds an optional proxy mode. Nothing changes unless you turn it on.

= 0.1.0 =
First release.
