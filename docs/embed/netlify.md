# Netlify (path mount)

**Not tested in CI, and the one-line `_redirects` proxy is not supported.** Netlify can put the portal on `acme.com/investors`, but only with an Edge Function; this page explains why and gives one built from the tested Cloudflare Worker. Treat it as best-effort and test it end to end before promising it to anyone.

Path mount is **supported, not recommended**. On Netlify, read that twice — and read [what it costs](path-mount.md#what-it-costs). [The shared path-mount page](path-mount.md) explains everything below that is not Netlify-specific.

## What the platform allows

- `_redirects` (or `[[redirects]]` in `netlify.toml`) with status `200`: a rewrite that proxies to another host. It can set **response** headers elsewhere (`_headers`), but not request headers.
- Edge Functions: code that runs in front of the site and may call `fetch` — the variant below.
- Netlify Functions (serverless): possible, but they buffer bodies and time out, which is wrong for uploads and downloads.

## Why a plain `_redirects` proxy is not enough

The portal learns that a request came through your site from **`X-Forwarded-Prefix`**, and a `_redirects` rule cannot add it. Without it the request is not mounted:

- pages still render under `/investors` if `BASE_PATH` is `/investors`, because that is the portal's own presentation — which is why the rule *looks* like it works;
- but the portal judges requests against its own origin, not yours: in browsers that do not send Fetch Metadata every sign-in and form post from `acme.com` is refused as cross-origin, and "open in a new tab" and the sign-in popup point at the portal's own host;
- a public path different from `BASE_PATH` cannot work at all.

Earlier versions of these docs recommended the one-line rule and warned that cookie forwarding through Netlify's proxy was inconsistent. The missing header is the more basic problem. Do not use it.

## Plan gating

Edge Functions are available on every plan, within its invocation limits.

## Steps (Edge Function)

1. **On the portal** (the "preserve" shape):

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/investors
   BASE_URL=https://acme.com/investors
   TRUST_PROXY=true
   ```

   `BASE_URL` may instead stay the portal's own address; [what that changes](path-mount.md#sign-in-methods-through-a-mount). One mount per prefix: pick the apex or `www` and redirect the other with a normal `301` rule.

2. **Copy the Cloudflare Worker recipe** from [cloudflare.md](cloudflare.md#steps) — `e2e/pathmount/worker/seed-host-mount.js`, the file CI runs — into your repository as `seed-host-mount.js`, with `PORTAL_ORIGIN` set to the portal's origin. It uses only web-standard `fetch`, `Request`, `Response` and `Headers`, which Netlify's Deno-based runtime provides.

3. **Add `netlify/edge-functions/seed-host-mount.js`:**

   ```js
   import mount from "../../seed-host-mount.js";

   export default (request) => mount.fetch(request);

   export const config = { path: ["/investors", "/investors/*"] };
   ```

   The `path` list means the function only runs for the portal, so the module's fallthrough to your site is never reached.

4. **Remove any `_redirects` or `netlify.toml` rule for `/investors`**, deploy, and test the round trip below before anything else.

## Test the round trip first

1. Open a clean browser profile and go to `https://acme.com/investors`. View the page source: the `seed-host:config` meta tag's `basePath` must be `/investors` and its `canonicalOrigin` `https://acme.com/investors`. If `canonicalOrigin` names the portal's own host, the header is not arriving (step 3 is not running).
2. Sign in. In devtools → Application → Cookies, a `__Secure-sid` cookie must exist on `acme.com` with `Path=/investors`.
3. Reload; you must still be signed in. Open a document, go to another screen, reload again, and sign out — sign-out is a POST, so it proves the portal accepts your site's origin.

Put that test in CI if the customer depends on the mount. It is the kind of thing that works on the day you ship it and stops working after a platform update nobody told you about.

## What this variant does and does not do

- It forwards **only the portal's own cookies**; your site's never reach the portal.
- It sends no `X-Forwarded-For`, because the Worker builds it from Cloudflare's `CF-Connecting-IP`, which Netlify does not send. Every mounted investor therefore shares one rate-limit budget per Netlify egress address ([why](path-mount.md#rate-limits-and-client-addresses)). Netlify's equivalent header is `x-nf-client-connection-ip`, if you want to adapt the copy — at which point it is no longer the tested file.
- It drops `Strict-Transport-Security` and `Alt-Svc` from the portal's responses.

## Gotchas

- **Netlify's own header rules apply to proxied responses.** A `[[headers]]` block or `_headers` entry with a site-wide CSP lands on the portal's responses on top of the CSP the portal already sent; the intersection of two CSPs blocks its scripts. Exclude the prefix.
- **Nothing under the prefix may be cached** except `/investors/assets/*`. The portal sends `Cache-Control: private, no-store` with `Vary: Cookie, X-Forwarded-Prefix` on every HTML and API response. Do not add a caching header for the prefix, and do not put a CDN with its own rules in front.
- **Limits.** Edge Functions have execution-time and memory limits. Uploads arrive in 8 MiB requests and are streamed, as are downloads, but check the current limits against your largest documents.
- **Deploy previews are separate origins** (`deploy-preview-42--site.netlify.app`) that are not in `PATH_MOUNTS`, so a preview shows the portal unmounted. Test on the production domain.
- **The portal's edge and `BASE_PATH`.** The shipped Caddy edge in front of the portal must know `BASE_PATH` (`FUNDROOM_BASE_PATH`, set by Compose); otherwise it answers 503 for everything.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.

## The alternative that works everywhere

Embed mode needs nothing from Netlify at all: paste [the loader snippet](quickstart.md#1-the-loader-snippet) into a page, add `https://acme.com` to **Settings → Embed**, and you are done — no proxy, nothing to break on a platform update. The cookie is partitioned instead of first-party, which is the documented trade. Subdomain mode (`investors.acme.com`, a CNAME) gives first-party cookies without a proxy.
