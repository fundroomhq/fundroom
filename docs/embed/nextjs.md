# Next.js

Next.js is the one host where both modes are genuinely easy, so it is also the one where you have to choose. Start with the embed; move to path mount only if one origin is a requirement rather than a preference.

## What the platform allows

Anything: a client component with the loader, a raw iframe, or `rewrites()` proxying a path prefix to the portal. There is no plan gating.

## Mode 1 — embed (recommended)

### Steps

1. Add a client component that mounts the loader and tears it down on unmount.
2. Render it wherever the portal belongs.
3. In the portal, **Settings → Embed**, add your origins — production, preview deployments if you use them (each as an exact origin), and `http://localhost:3000`.

### Snippet

```tsx
"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    SeedHost?: { init: (o: Record<string, unknown>) => Promise<{ destroy: () => void }> };
  }
}

export function InvestorPortal({ path = "/updates" }: { path?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready || !el.current || !window.SeedHost) return;
    let destroy: (() => void) | undefined;
    void window.SeedHost.init({
      workspace: "acme",
      baseUrl: "https://portal.example",
      el: el.current,
      path,
      minHeight: 600,
    }).then((portal) => {
      destroy = portal.destroy;
    });
    return () => destroy?.();
  }, [ready, path]);

  return (
    <>
      <Script src="https://portal.example/embed/v1/embed.js" onLoad={() => setReady(true)} />
      <div ref={el} />
    </>
  );
}
```

The cleanup function matters here in a way it does not on a static site. The App Router unmounts and remounts components freely, and every remount that does not tear down the previous frame leaves an orphaned iframe and a message listener behind. The loader does watch for its container being destroyed and re-mounts itself, but that safety net exists for host routers we cannot see into — when you own the component, call `destroy()`.

### Signed identity handoff

If your Next.js app already knows who the visitor is, mint an assertion in a route handler and pass it as `handoff`. The shape is the same as [the WordPress plugin's](wordpress.md#signed-identity-handoff): a compact JWS, `alg` `EdDSA` (Ed25519), with `iss` your https origin, `aud` the workspace slug, `sub` the investor's email, `iat`, `exp` no more than 60 seconds after `iat`, and a unique `jti`. Register the **public** key in **Settings → Embed** and turn on **Trust host identity**.

Fetch the assertion from your own server on the client and hand it straight to `init({ handoff })` — never put it in the iframe URL, and never cache the response that carries it. It is single use, it expires in a minute, and it only ever resolves to an email that is already a member or an invitee of the workspace.

## Mode 2 — path mount (`acme.com/investors`)

Supported, not recommended. What you gain is first-party cookies and one origin in the address bar. What you pay is on [the shared path-mount page](path-mount.md#what-it-costs); the short version:

- The portal now shares the host's origin, which means it shares the host's **XSS blast radius**, cookie jar and CDN cache. An injection anywhere on `acme.com` is an injection in the portal.
- Next.js forwards **every cookie** your site sets on `Path=/` to the portal.
- Someone has to own the proxy for as long as the portal exists, and it needs configuration **on the portal** too, so it is not something a web team can do alone.

### Steps

1. **On the portal** (the "preserve" shape: the path reaches the portal unchanged):

   ```
   BASE_PATH=/investors
   PATH_MOUNTS=https://acme.com/investors
   BASE_URL=https://acme.com/investors
   TRUST_PROXY=true
   ```

   `BASE_URL` may instead stay the portal's own address; [what that changes](path-mount.md#sign-in-methods-through-a-mount). List one mount per prefix: redirect `www` to the apex (or the reverse) before the rewrite rather than listing both ([why](path-mount.md#several-sites-one-prefix)).

2. **`next.config.mjs`** — two rewrites, the bare path and everything under it, to the portal (replace `portal.test` with the portal's host):

   ```js
   /*
    * FundRoom path mount — Next.js, "preserve" shape. Pair with `proxy.js`.
    *
    * Serves the investor portal at https://<your site>/investors: both the bare path and everything
    * under it are rewritten to the portal, path unchanged. The portal runs with BASE_PATH=/investors
    * and lists https://<your site>/investors in PATH_MOUNTS. Replace portal.test with your portal's
    * host. Next.js forwards every cookie of your site to the portal: keep secrets out of Path=/
    * cookies on this site. (On Vercel the same two rules can live in vercel.json instead; the
    * headers still need `proxy.js`.)
    */
   const PORTAL_ORIGIN = "https://portal.test";

   /** @type {import("next").NextConfig} */
   const nextConfig = {
     async rewrites() {
       return [
         { source: "/investors", destination: `${PORTAL_ORIGIN}/investors` },
         { source: "/investors/:path*", destination: `${PORTAL_ORIGIN}/investors/:path*` },
       ];
     },
   };

   export default nextConfig;
   ```

3. **`proxy.js`** next to it (Next.js 16's name for middleware). A rewrite cannot add request headers, and without `X-Forwarded-Prefix` the portal does not know it is mounted:

   ```js
   /*
    * FundRoom path mount — Next.js request headers for the rewrites in `next.config.mjs`.
    *
    * A rewrite alone cannot add request headers, and the portal needs two: `X-Forwarded-Prefix`
    * (which mount this is) and `X-Forwarded-Host` (your site's host, not the portal's). This proxy
    * (Next.js 16's name for middleware) adds them on the mount's paths only.
    */
   import { NextResponse } from "next/server";

   export function proxy(request) {
     const headers = new Headers(request.headers);
     headers.set("x-forwarded-prefix", "/investors");
     headers.set("x-forwarded-host", request.headers.get("host") ?? request.nextUrl.host);
     headers.set("x-forwarded-proto", "https");
     return NextResponse.next({ request: { headers } });
   }

   export const config = {
     matcher: ["/investors", "/investors/:path*"],
   };
   ```

   These are `e2e/pathmount/next/next.config.mjs` and `e2e/pathmount/next/proxy.js`, built with `next build` and served by `next start` (Next.js 16.3.5) in the `50-path-mount` end-to-end suite, unchanged. On Next.js 15 and earlier the same code goes in `middleware.js` with the function named `middleware`.

4. Make sure no site-wide `headers()` entry applies to `/investors/*` (see gotchas).
5. Deploy, then sign in through `https://acme.com/investors`: the session cookie is `__Secure-sid` on your site's origin with `Path=/investors`.

The same two files work on Vercel, where `proxy.js` runs as Routing Middleware; that deployment target is not part of CI.

### Gotchas

- **The bare rule is not optional.** A Next.js rewrite with an external destination does not add the trailing slash an origin might expect (`vercel/next.js#63948`), so with only the `/:path*` rule `/investors` 404s while `/investors/updates` works. The portal accepts both spellings; Next is the side that needs both rules. With the default `trailingSlash: false`, Next.js itself redirects `/investors/` to `/investors` (308) before the rewrite — harmless.
- **The `proxy.js` matcher must cover exactly the rewrite sources.** A path that is rewritten without passing through the proxy reaches the portal without the header: the page loads, but under the portal's own presentation, and a POST from your site is refused as cross-origin.
- **`basePath` in `next.config` prefixes rewrite sources and matchers.** If your app sets one, the source becomes `<basePath>/investors` unless you pass `basePath: false` on the rule. Symptom: the rewrite appears to do nothing at all.
- **Site-wide security headers break the portal.** A `headers()` entry — or a Vercel or CDN header rule — that applies a CSP to `/(.*)` also applies it to the proxied portal responses, on top of the CSP the portal sent. Two CSPs on one response intersect, and the intersection blocks the portal's scripts. Exclude the prefix explicitly. The same goes for `Strict-Transport-Security`: the portal sends none on a mounted response, but its edge may and a Caddy edge advertises HTTP/3 in `Alt-Svc`; if you see either on `/investors` responses, remove them in `proxy.js`'s response or at your CDN.
- **Nothing under the prefix may be cached**, except `/investors/assets/*` (content-hashed, `immutable`). Every HTML and API response from the portal is `Cache-Control: private, no-store` with `Vary: Cookie, X-Forwarded-Prefix`. If anything in your stack overrides cache headers on rewrites, fix that before going live: a CDN that caches one investor's page and serves it to another is a data breach with a 200 status code.
- **Uploads and downloads go through the rewrite.** Uploads are 8 MiB requests; downloads stream. A serverless platform with a small request-body limit or a short response timeout will fail on them before the portal sees anything — check your platform's limits against your largest documents.
- **The portal's edge and `BASE_PATH`.** The shipped Caddy edge in front of the portal must know `BASE_PATH` (`FUNDROOM_BASE_PATH`, set by Compose); otherwise it answers 503 for everything.

When it does not work, [the path-mount runbook](../runbooks/path-mount.md) goes symptom by symptom.

## Vercel without Next.js: `vercel.json`

**Doc-only: not tested in CI**, because the suite cannot run Vercel's edge. Written from Vercel's `vercel.json` reference; test it on a preview deployment before relying on it.

A `rewrites` entry in `vercel.json` **cannot set request headers**, so on its own it forwards requests without `X-Forwarded-Prefix`. The portal then does not treat them as mounted:

- the pages still render under `/investors` if `BASE_PATH` is `/investors` (the preserve shape), because that is the portal's own presentation — this is why a plain rewrite *looks* like it works;
- but the portal judges requests against its own origin, not your site's: logins, sign-out and every form post from `acme.com` are refused as cross-origin (`403 csrf_rejected`) in browsers that do not send Fetch Metadata, cookies and links may name the wrong prefix in the replace shape, and "open in a new tab" and the sign-in popup point at the portal's own host rather than your site;
- the replace shape (a public path different from `BASE_PATH`) cannot work at all.

So a plain `rewrites` entry is **not supported**. Vercel's `routes` can do it, because a route may carry `transforms` that set request headers:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "routes": [
    {
      "src": "^/investors(/.*)?$",
      "dest": "https://portal.example/investors$1",
      "transforms": [
        { "type": "request.headers", "op": "set", "target": { "key": "x-forwarded-prefix" }, "args": "/investors" },
        { "type": "request.headers", "op": "set", "target": { "key": "x-forwarded-proto" }, "args": "https" },
        { "type": "response.headers", "op": "delete", "target": { "key": "strict-transport-security" } },
        { "type": "response.headers", "op": "delete", "target": { "key": "alt-svc" } }
      ]
    }
  ]
}
```

Portal settings as in step 1 above, with the mount being your Vercel domain. What to know:

- It forwards **every cookie** of your site to the portal; a transform can only drop the whole `Cookie` header, which would sign everyone out.
- It sends no `X-Forwarded-Host`, so keep one mount per prefix.
- `routes` run before the filesystem, so a file or page at `/investors` in your project is shadowed — which is what you want.
- If you would rather keep `rewrites`, the headers can come from Vercel Routing Middleware instead, as `proxy.js` does for Next.js; see Vercel's middleware documentation for setting request headers in your framework.
- Vercel documents `set` as setting the header "if missing". If that means a visitor's own `X-Forwarded-Prefix` survives, the worst they can do is spoil their own response (a value that is not your prefix is ignored) — but check it on a preview deployment with `curl -H 'X-Forwarded-Prefix: /x'`.
