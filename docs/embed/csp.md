# CSP checklist for the host site

Two policies meet at an embed: the host page's, which decides whether the frame and the loader are allowed to load, and the portal's, which decides who is allowed to frame it. Both have to agree. This page is the first one; the second is [in the quickstart](quickstart.md#3-add-your-origin--this-step-is-not-optional).

If the host site sends no `Content-Security-Policy` at all — which is most Webflow, Squarespace, Wix and Notion sites — none of this applies and you can skip to [what we send](#what-the-portal-sends-back). Read it anyway before you add a CSP later.

## What the host page has to allow

Substitute `portal.example` for the portal origin. Add only the origin; a path in a CSP source list is matched as a prefix and buys you nothing here.

| Directive | Value to allow | Needed when |
|---|---|---|
| `frame-src` | `https://portal.example` | Always. This is the iframe. |
| `child-src` | `https://portal.example` | Only if you support browsers old enough to lack `frame-src`. Harmless to include. |
| `script-src` | `https://portal.example` | Loader snippet only. The raw-iframe snippet needs no script at all — which is exactly why it exists. |
| `connect-src` | *nothing* | Never needed. The frame does its own fetching, on its own origin. If a reviewer asks you to allow `connect-src` for the portal, the answer is no — that would be the host page talking to our API, which is the thing the architecture prevents. |
| `img-src`, `font-src`, `style-src` | *nothing* | Never needed. Everything the frame renders is fetched by the frame. |

`frame-src` falls back to `child-src`, and `child-src` falls back to `default-src`. So a host page with `default-src 'self'` and no `frame-src` blocks the frame, and the fix is to add `frame-src`, not to widen `default-src`.

A minimal working host policy:

```
Content-Security-Policy:
  default-src 'self';
  frame-src https://portal.example;
  script-src 'self' https://portal.example;
```

### The inline `SeedHost.init(...)` block

The loader snippet has two scripts: an external one and an inline one that calls `init`. A host policy with a nonce or hash allow-list will block the inline one. Three ways out, best first:

1. **Give it the host page's nonce**: `<script nonce="{{cspNonce}}">SeedHost.init({…})</script>`.
2. **Move the call into your own bundled JS file**, which is already allow-listed.
3. Add the hash of the inline block to `script-src`. Works, and you will forget to update it the first time you change an option.

Do not reach for `'unsafe-inline'` to make an embed snippet work. It is a much larger change to the host site's security posture than the embed needs, and it is the sort of thing that gets pasted into a template and never removed.

### Pinned builds and `integrity`

If your policy uses `require-sri-for script` — or your review process asks for SRI — you need [the pinned loader URL and its `integrity` value](quickstart.md#the-pinned--sri-variant). SRI is not available on the rolling `/embed/v1/` URL, because an SRI hash is a promise that bytes never change and the rolling URL exists so that they can.

`crossorigin="anonymous"` is required alongside `integrity`, and it is why the loader is served from the `asset` header profile with `Cross-Origin-Resource-Policy: cross-origin`: a host page has to be able to fetch it cross-origin without credentials.

### `Cross-Origin-Embedder-Policy` on the host page will block the frame

This one is easy to trip over on a site that enabled cross-origin isolation for something unrelated (`SharedArrayBuffer`, a wasm library, a performance profiler). A host document with `Cross-Origin-Embedder-Policy: require-corp` requires every cross-origin subresource — the iframe included — to opt in with `Cross-Origin-Resource-Policy: cross-origin`, and the embed document deliberately does not send that. If the host page is cross-origin isolated, the embed will not render there, and no setting on our side changes it.

### Do not set `Referrer-Policy: no-referrer` on the host page

It will not break rendering. What it breaks is the portal's ability to see who framed it: a top-level iframe navigation sends no `Origin` header, so `Referer` is the only initiator signal there is. With it suppressed, the portal cannot tell an allow-listed host from anyone else, so it serves the page (absence of evidence is never treated as rejection) and the workspace admin loses the only signal that would have told them somebody else tried. `strict-origin-when-cross-origin` — the browser default — sends the origin and nothing more, which is all the check needs.

### `Permissions-Policy` and passkeys

Passkeys work inside the frame only if the host delegates the feature to it. The loader sets `allow="publickey-credentials-get"` on the iframe; if the host page's own `Permissions-Policy` withholds `publickey-credentials-get` from itself, it cannot delegate what it does not have. If you want passkeys in the frame, the host page needs `publickey-credentials-get=(self "https://portal.example")` or no restriction at all.

This is worth getting right but never worth blocking on: sign-in inside the frame also works with a magic link and an OTP, and anything that genuinely needs a top-level context opens a popup on the portal origin instead.

## What the portal sends back

On `/embed/<slug>` documents (the `embed` header profile):

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `… frame-ancestors 'self' https://acme.com …` | The framing control. Computed per request from the workspace's origin list, *before* the handler runs, so a failed lookup can never serve a framed page with no `frame-ancestors`. |
| `X-Frame-Options` | **not sent** | See below. |
| `Cross-Origin-Opener-Policy` | **not sent** | COOP `same-origin` would sever the frame from the host page's browsing context group and the `postMessage` bridge would stop working. The bridge is the embed's entire purpose. |
| `Referrer-Policy` | `no-referrer` | Nothing downstream of the portal needs to know which screen an investor was on. |
| `X-Robots-Tag` | `noindex, nofollow` | Embedded pages are never indexed. The host page around them stays indexable — it is a different response. |
| `Permissions-Policy` | everything off except `publickey-credentials-get=(self)` | The single exception, so a delegating host can offer passkeys in the frame. |
| `Cache-Control` | `private, no-store` | Every HTML and API response. A host CDN that caches one investor's page for another is the failure this prevents. |

On the loader (`/embed/v1/embed.js`, the `asset` profile): `Cross-Origin-Resource-Policy: cross-origin`, no CSP, and the handler's own `Cache-Control` — one hour with `stale-while-revalidate` on the rolling URL, a year and `immutable` on a pinned one.

On `/embed/<slug>/theme.json`: public, `Access-Control-Allow-Origin: *`, `max-age=300`, no credentials. It contains brand tokens and nothing else.

### Why no `X-Frame-Options`

Because it cannot express the answer. `X-Frame-Options` has exactly two useful values, `DENY` and `SAMEORIGIN`, and the thing we need to say is "these three origins may frame this page and nobody else may". Any value we could send would contradict the CSP we just computed, and on a browser that honours the older header the frame would be refused outright — so the embed route sends none, and `frame-ancestors` is the only framing header there.

Every other route still sends `X-Frame-Options: DENY`, including the admin tree, which is never framed by anything. If you are looking at a response with no `X-Frame-Options` and wondering whether it is a mistake, check the path: under `/embed/` it is deliberate, anywhere else it is a bug.

## Checking your work

From the host site's own network, not from a browser with extensions:

```sh
curl -sSI "https://portal.example/embed/acme" | grep -i -E 'content-security-policy|x-frame|referrer|robots'
```

The `frame-ancestors` list in that output is what the browser will enforce. If your origin is not in it, nothing about the host page's CSP matters yet — go and add the origin.
