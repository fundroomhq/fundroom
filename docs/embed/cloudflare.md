# Cloudflare (path mount)

Cloudflare can put the portal on `acme.com/investors` with a Worker. This is the standard "docs on a subpath" pattern, and of the proxy recipes it is the tidiest: the Worker forwards only the portal's own cookies, so nothing your site stores reaches the portal. Read the caching section before going live — it is where Cloudflare differs from every other host.

Path mount is **supported, not recommended**: the portal ends up inside `acme.com`'s origin and shares its XSS blast radius and cache. Read [what it costs](path-mount.md#what-it-costs); subdomain mode gives first-party cookies with none of that, and on Cloudflare it is one DNS record (see [the end of this page](#the-easier-alternative)). [The shared path-mount page](path-mount.md) explains everything below that is not Cloudflare-specific.

## What the platform allows

- **Workers** on a route — the recipe below.
- **Pages Functions**, for a site on Cloudflare Pages: the same code behind a thin wrapper ([below](#on-cloudflare-pages)). Pages' `_redirects` cannot proxy to another host, so a Function is the only option there.
- **Transform Rules / URL Rewrite Rules** change paths and headers within your own origin; they cannot proxy to another one.

## Plan gating

Workers and Pages Functions run on the free plan within its request limits. A portal is not a high-traffic surface.

## Steps

1. **On the portal** (the "preserve" shape):

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/investors
   BASE_URL=https://acme.com/investors
   TRUST_PROXY=true
   ```

   `BASE_URL` may instead stay the portal's own address; [what that changes](path-mount.md#sign-in-methods-through-a-mount). List **one** mount for the prefix: if `www.acme.com` also serves the site, redirect one hostname to the other in front of the Worker. Two mounts on one prefix are told apart only by a forwarded host the portal's edge trusts, and Cloudflare's egress addresses are shared with every other Cloudflare customer ([why that matters](path-mount.md#several-sites-one-prefix)).

2. **Create the Worker** with this module, changing `PORTAL_ORIGIN` to the portal's origin (and `PREFIX` if the path is not `/investors`):

   ```js
   /*
    * FundRoom path mount — Cloudflare Worker, "preserve" shape.
    *
    * Serves the investor portal at https://<your site>/investors. Deploy on a route that covers
    * your site (e.g. `www.acme.com/*`): /investors and /investors/* are proxied to the portal, every
    * other path goes to your origin untouched. The portal runs with BASE_PATH=/investors and lists
    * https://<your site>/investors in PATH_MOUNTS. Replace PORTAL_ORIGIN with your portal's origin.
    *
    * Only the portal's own cookies are forwarded: your site's cookies (analytics, CMS sessions)
    * never reach the portal, and the portal's cookies are scoped to Path=/investors so your site's
    * other pages never see them.
    */

   const PORTAL_ORIGIN = "https://portal.test";
   const PREFIX = "/investors";

   /** The portal's cookie names (`__Host-`/`__Secure-` + basename). Nothing else is forwarded. */
   const PORTAL_COOKIE = /^__(?:Host|Secure)-(?:sid|did|auth_req|oidc_req|sso_req|sh_intg)$/u;

   /** Connection-level headers: meaningful for one hop only, never forwarded. */
   const HOP_BY_HOP = [
     "connection",
     "keep-alive",
     "proxy-authenticate",
     "proxy-authorization",
     "te",
     "trailer",
     "transfer-encoding",
     "upgrade",
   ];

   function portalCookies(header) {
     if (header === null) return "";
     return header
       .split(";")
       .map((pair) => pair.trim())
       .filter((pair) => PORTAL_COOKIE.test(pair.slice(0, pair.indexOf("="))))
       .join("; ");
   }

   export default {
     async fetch(request) {
       const url = new URL(request.url);
       if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
         return fetch(request); // not the portal: your site as usual
       }
       const site = `https://${url.host}`;

       const headers = new Headers(request.headers);
       for (const name of HOP_BY_HOP) headers.delete(name);
       headers.delete("host");
       const cookies = portalCookies(request.headers.get("cookie"));
       if (cookies === "") headers.delete("cookie");
       else headers.set("cookie", cookies);
       // The visitor's address, appended the way Cloudflare's own proxy does (CF-Connecting-IP is
       // the client; any X-Forwarded-For the visitor sent stays in front of it).
       const client = request.headers.get("cf-connecting-ip");
       if (client !== null) {
         const prior = request.headers.get("x-forwarded-for");
         headers.set("x-forwarded-for", prior === null ? client : `${prior}, ${client}`);
       }
       headers.set("x-forwarded-host", url.host);
       headers.set("x-forwarded-proto", "https");
       headers.set("x-forwarded-prefix", PREFIX);

       const upstream = await fetch(`${PORTAL_ORIGIN}${url.pathname}${url.search}`, {
         method: request.method,
         headers,
         body: request.body,
         redirect: "manual",
       });

       const response = new Response(upstream.body, upstream);
       // Transport policy is your site's, not the portal's: never let the portal's HSTS (which could
       // carry includeSubDomains/preload) or its HTTP/3 advertisement speak for your origin.
       response.headers.delete("strict-transport-security");
       response.headers.delete("alt-svc");
       // An absolute redirect to the portal's own host comes back onto this site.
       const location = response.headers.get("location");
       if (location?.startsWith(`${PORTAL_ORIGIN}${PREFIX}`)) {
         response.headers.set("location", site + location.slice(PORTAL_ORIGIN.length));
       }
       return response;
     },
   };
   ```

   This is `e2e/pathmount/worker/seed-host-mount.js`, run unchanged by the `50-path-mount` end-to-end suite in `workerd`, the open-source runtime Cloudflare's own Workers run on. (In the suite a small harness answers the site's home page itself; on Cloudflare the `fetch(request)` fallthrough reaches your origin.)

3. **Add a route** for the Worker: `acme.com/investors*`. That also matches `/investorsfoo`, which the Worker passes to your origin untouched. A route covering the whole site (`acme.com/*`) works too, at the cost of invoking the Worker on every request.

4. **Add a Cache Rule** for `acme.com/investors*` set to **Bypass cache** (see the next section), then sign in through `https://acme.com/investors`. The session cookie is `__Secure-sid` on `acme.com` with `Path=/investors`.

## What the Worker does

- Proxies `/investors` and `/investors/…` to the portal, path and query unchanged; everything else goes to your origin.
- Forwards **only** the portal's cookies (`__Host-`/`__Secure-` + `sid`, `did`, `auth_req`, `oidc_req`, `sso_req`, `sh_intg`). Your site's analytics ids and CMS sessions never reach the portal. The end-to-end suite checks this.
- Sets `X-Forwarded-Prefix`, `X-Forwarded-Host` and `X-Forwarded-Proto`, and appends the visitor's address (`CF-Connecting-IP`) to `X-Forwarded-For` — which the portal only uses if its edge trusts the Worker's egress addresses; see [rate limits](path-mount.md#rate-limits-and-client-addresses).
- Drops hop-by-hop headers, never follows redirects on the visitor's behalf (`redirect: "manual"` — following them server-side would lose the `Set-Cookie` and `Location` the browser needs), and maps an absolute redirect to the portal's host back onto your site.
- Drops the portal's `Strict-Transport-Security` and `Alt-Svc` from responses: your site's transport policy is Cloudflare's and yours to set.
- Streams request and response bodies; uploads (8 MiB chunks) and large downloads pass through without buffering.

## Caching: Cache Rules, APO and Cache Everything

**Cloudflare's caching is the main risk in this recipe.** Automatic Platform Optimization, "Cache Everything" rules and Tiered Cache can cache an HTML response rendered for one signed-in investor and serve it to the next visitor. Every HTML and API response from the portal is `Cache-Control: private, no-store` with `Vary: Cookie, X-Forwarded-Prefix`, which is the correct instruction — but a "Cache Everything" rule overrides origin cache headers, which is its entire purpose. So, explicitly:

- Add a **Cache Rule** for `acme.com/investors*` set to **Bypass cache**. If the portal's own hostname is also proxied by Cloudflare, bypass it there too.
- If APO is enabled on the zone, confirm the prefix is excluded.
- Do not rely on `Cache-Control` alone. It is a request; a Cache Everything rule is an instruction.

Verify from a clean browser profile: sign in, sign out, request a page under the prefix, and check you get the sign-in screen and a `cf-cache-status` of `BYPASS` or `DYNAMIC`, never `HIT`.

## On Cloudflare Pages

**Not tested in CI.** A Pages Function can hand the request to the same module. Save the recipe as `seed-host-mount.js` at the project root and add `functions/investors/[[path]].js` (the double brackets match `/investors` itself as well as everything under it):

```js
import mount from "../../seed-host-mount.js";

export const onRequest = ({ request }) => mount.fetch(request);
```

Functions under `functions/investors/` only run for that path, so the module's fallthrough to your origin is never reached. Everything else on this page applies unchanged.

## Gotchas

- **Keep the prefix in the upstream URL.** The recipe does (`${PORTAL_ORIGIN}${url.pathname}`). Stripping `/investors` there without also changing `BASE_PATH` and `X-Forwarded-Prefix` half-works: the first HTML response arrives and then every asset, API call and cookie is wrong.
- **Transform Rules that add security headers apply here too.** A zone-wide CSP from a Response Header Transform Rule lands on the portal's responses on top of the CSP it already sent; two CSPs on one response intersect, and the intersection blocks the portal's scripts. Exclude the prefix from every header-adding rule.
- **Rocket Loader and Email Address Obfuscation rewrite HTML.** Turn both off for the prefix with a Configuration Rule. Rocket Loader in particular defers scripts in ways that break the portal's nonce-based CSP.
- **Do not trust Cloudflare's ranges at the portal's edge to get real client addresses.** Listing Cloudflare's published IP ranges in `EDGE_TRUSTED_PROXIES` would make the portal believe `X-Forwarded-*` from *any* Cloudflare Worker, including one an attacker deploys. Accept that mounted investors share a rate-limit budget per Cloudflare egress address.
- **The portal's edge and `BASE_PATH`.** The shipped Caddy edge must know the portal's `BASE_PATH` (`FUNDROOM_BASE_PATH`, set by Compose from `BASE_PATH`); otherwise its health check fails and it answers 503 for everything.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.

## The easier alternative

On Cloudflare specifically, subdomain mode is almost free: create `investors.acme.com` as a CNAME to the portal's edge, **grey-cloud it** (DNS only), and let the portal terminate TLS and obtain its own certificate. That is the whole setup, it gives first-party cookies, and there is no Worker to maintain. See the [custom-domains runbook](../runbooks/custom-domains.md) — and note that an orange-clouded (proxied) record is the one configuration that makes DNS verification harder, because Cloudflare answers with its own addresses and our resolver never sees our target.
