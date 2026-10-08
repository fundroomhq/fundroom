# Embedding the portal in someone else's site

The portal is a complete application on its own hostname. Embedding is how you put it *inside* a page the customer already has — a Webflow marketing site, a WordPress page, a Notion doc — without moving the investor data into that page.

These docs are for the person pasting the snippet: the founder's web person, the agency, or whoever runs `acme.com`. If you operate the install and something is failing, read [the troubleshooting runbook](../runbooks/embed-troubleshooting.md) instead.

## The security model, in one paragraph

Gated content — updates, KPIs, the data room, anything behind a login — renders **only inside a cross-origin iframe served by the portal origin**. It is never rendered into the host page's DOM, and no token, session or credential is ever handed to host-page JavaScript. The session cookie is `HttpOnly` and partitioned to the pair (host site × portal origin), so script on `acme.com` cannot read it; the API accepts credentialed calls only from the portal origin, so script on `acme.com` cannot use it either; and embed origins are deliberately **not** added to the CORS or CSRF allow-lists, which is what keeps a compromised host page from forging API calls. What the host page *can* do is drive the UI over a `postMessage` bridge: tell the frame to navigate, hand it theme tokens, tell it the visitor withdrew analytics consent. It can drive, it cannot read. That asymmetry is the whole architecture, and it is why there is no "render it in my own DOM" option.

The cost is honest to state: an embed is recognisably a different surface. Look and feel comes from design tokens you set, never from the host page's CSS or fonts, and an investor who visits two of the same founder's sites signs in on each of them.

## The three deployment modes

| Mode | What the customer does | Cookies | Pick it when |
|---|---|---|---|
| **Subdomain** | Points `investors.acme.com` at the portal with a CNAME | First-party (`__Host-sid; SameSite=Lax`) | Default. Nothing to paste, nothing to maintain, no third-party-cookie exposure at all. Also the target of every "open in a new tab" fallback in the other two modes. |
| **Embed (iframe)** | Pastes a snippet into a page | Partitioned (`__Host-sid; SameSite=None; Partitioned`) | The portal has to appear *inside* an existing page, and the customer's site is on a builder they cannot run infrastructure on. Works on every host platform in these docs. |
| **Path mount** | Proxies `acme.com/investors/*` to the portal at their edge, and the operator lists that URL in `PATH_MOUNTS` | First-party, path-scoped (`__Secure-sid; Path=/investors`) | The customer runs their own edge (nginx, Caddy, Cloudflare, Next.js, WordPress) and wants one origin. Highest fidelity, most moving parts, and it puts the portal inside the host's origin — so the host's XSS blast radius is now the portal's too. Supported, not recommended. Start with [path-mount.md](path-mount.md). |

Subdomain mode is set up in **Settings → Domains** and has [its own runbook](../runbooks/custom-domains.md); it needs nothing from these pages. Everything else here is embed or path mount.

## Start here

- **[Quickstart](quickstart.md)** — the two snippets, copy-pasteable, and the one setting you must change before either works.
- **[Loader API reference](api.md)** — every `SeedHost.init` option, the instance methods, and both directions of the bridge protocol.
- **[CSP checklist](csp.md)** — what the host site's own Content-Security-Policy has to allow, and what we send back.
- **[Theming](theming.md)** — design tokens, precedence, dark mode, and what does not work inside a frame.
- **[Path mount](path-mount.md)** — what every proxy recipe shares: the portal's settings (`BASE_PATH`, `PATH_MOUNTS`, `BASE_URL`), what the proxy must send, cookies, caching, sign-in methods, and what it costs.

## Recipes

One page per platform. Each says what the platform allows, whether it costs a plan upgrade, the exact steps, the snippet, the origins to add, and the gotchas. Every path-mount snippet marked "CI" below is a file under `e2e/pathmount/` that a real server of that kind runs in the end-to-end suite, copied into the page unchanged.

| Platform | Mode | Page | Plan gating |
|---|---|---|---|
| WordPress | Embed (plugin); path mount (plugin proxy mode, CI) | [wordpress.md](wordpress.md) | None — self-hosted WordPress 6.4+, PHP 8.1+; proxy mode needs plugin 0.2.0 and PHP cURL |
| Webflow | Embed | [webflow.md](webflow.md) | Custom code needs a paid Site plan; free Starter cannot |
| Framer | Embed | [framer.md](framer.md) | Custom code has historically needed a paid plan — check current pricing |
| Squarespace | Embed | [squarespace.md](squarespace.md) | **Basic cannot embed at all** → use subdomain mode |
| Wix | Embed | [wix.md](wix.md) | HTML iFrame element on any plan; Custom Element needs Premium |
| Notion | Embed | [notion.md](notion.md) | None |
| Plain HTML | Embed | [plain-html.md](plain-html.md) | — |
| Next.js | Embed; path mount (`rewrites()` + `proxy.js`, CI) | [nextjs.md](nextjs.md) | — |
| Vercel (no Next.js) | Path mount (`vercel.json` `routes`, untested) | [nextjs.md](nextjs.md#vercel-without-nextjs-verceljson) | — |
| nginx | Path mount (CI) | [nginx.md](nginx.md) | — |
| Caddy | Path mount, public path ≠ portal path (CI) | [caddy.md](caddy.md) | — |
| Cloudflare | Path mount (Worker, CI in `workerd`) | [cloudflare.md](cloudflare.md) | Workers or Pages Functions |
| Netlify | Path mount (Edge Function, untested) | [netlify.md](netlify.md) | — (a plain `_redirects` proxy is not supported) |

## Conventions in these docs

`portal.example` is the portal's origin — on your install it is whatever `BASE_URL` says, and on a self-hosted install it is the customer's own hostname. `acme` is the workspace slug and `acme.com` is the customer's site. Substitute all three.

There is **no embed key**. If you have seen a `?k=pk_…` parameter in an older design note, it was never built: the workspace slug is already public, so a public key hides nothing and gates nothing, and rotating one would silently break every snippet already pasted into pages nobody remembers. The framing control is the origin allow-list plus `frame-ancestors`.
