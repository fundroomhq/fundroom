# Quickstart

Two snippets. Pick the first if the host platform lets you run a `<script>`; pick the second if it only lets you paste an iframe. Then add your site's origin to the workspace, or neither one will render.

Throughout: `portal.example` is the portal origin, `acme` is the workspace slug, `acme.com` is your site.

## 1. The loader snippet

This is the one to use where you have the choice. The loader creates the iframe for you and then keeps it useful: it resizes the frame to its content, mirrors the visitor's position into `?sh=/updates` so a deep link is shareable, hands the frame your theme tokens, and falls back to a plain link if anything goes wrong.

```html
<div id="investors"></div>

<script src="https://portal.example/embed/v1/embed.js"></script>
<script>
  SeedHost.init({
    workspace: "acme",
    baseUrl: "https://portal.example",
    el: "#investors",
  });
</script>
```

`workspace`, `baseUrl` and `el` are required; everything else has a default. This is exactly what
**Settings → Embed** generates for you, so the two never drift. The full option list is in the
[API reference](api.md).

To open the portal on a particular screen instead of its home, add `path`:

```js
SeedHost.init({ workspace: "acme", baseUrl: "https://portal.example", el: "#investors", path: "/updates" });
```

Only add it for a screen you know the workspace has — a `path` copied between sites is the usual
way an embed ends up opening on nothing.

### The pinned + SRI variant

```html
<div id="investors"></div>

<script
  src="https://portal.example/embed/0.1.0/embed.js"
  integrity="sha384-REPLACE-WITH-THE-VALUE-FROM-SETTINGS"
  crossorigin="anonymous"></script>
<script>
  SeedHost.init({
    workspace: "acme",
    baseUrl: "https://portal.example",
    el: "#investors",
  });
</script>
```

Copy the version, the URL and the `integrity` value from **Settings → Embed**; they are also published at `https://portal.example/embed/v1/manifest.json`. Do not type an `integrity` value you have not copied from the install you are embedding — a wrong hash does not degrade, it blocks the script outright.

**Which to use.** Subresource integrity is only possible on the pinned build, because an SRI hash is a promise that the bytes never change and the rolling `/embed/v1/` URL exists precisely so that they can. So:

- **Rolling (`/embed/v1/embed.js`)** — you get fixes and new bridge messages without touching the snippet. Cached for an hour with `stale-while-revalidate`. Use this unless you have a reason not to. It is the right default for a snippet pasted into a CMS page nobody will ever edit again.
- **Pinned (`/embed/0.1.0/embed.js` + `integrity`)** — the bytes are frozen and the browser verifies them, cached immutably for a year. Use it when a security review asks for SRI, or when your host site's CSP is hash- or integrity-based. The cost is that you now own an upgrade: nothing about the pinned URL will ever change, including its bugs, and you have to come back and bump it.

Both URLs are served by the app itself, from memory. There is no CDN in this product — self-hosted installs serve the same loader, the same pinned URL and the same SRI value from their own origin. If the install runs under a base path, `baseUrl` and the script `src` both carry it: `https://acme.com/investors/embed/v1/embed.js`.

## 2. The raw-iframe snippet

For hosts that allow an iframe but no script — Squarespace code blocks on some plans, Wix's HTML iFrame element, Notion's `/embed`.

```html
<iframe
  src="https://portal.example/embed/acme"
  title="Investor relations portal"
  style="width:100%;height:900px;border:0;display:block"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-write; fullscreen; publickey-credentials-get"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
```

To open on a particular screen, put the path after the slug: `https://portal.example/embed/acme/updates`.

What you give up by not using the loader:

- **A fixed height.** There is no bridge, so nothing resizes the frame. Pick a height that suits the content and accept an inner scrollbar; `900px` is a reasonable start.
- **Deep links.** The host page's URL will not follow the visitor into the frame, and a shared link lands everyone on the same screen.
- **Theme tokens from the page.** The frame still picks up the workspace theme from `/embed/acme/theme.json`; it just cannot be overridden per placement. See [theming](theming.md).
- **The link fallback.** If cookies are blocked the frame still shows its own "Open in a new tab" message, but if the frame is refused outright the visitor sees an empty box rather than a link.

Keep `referrerpolicy` at `strict-origin-when-cross-origin` or leave it off entirely. **Do not set `referrerpolicy="no-referrer"`.** A top-level iframe navigation sends no `Origin` header, so `Referer` is the only signal the portal has about who framed it; suppressing it does not break rendering, but it blinds the origin check and removes the only way an admin ever learns someone else tried to frame their portal.

## 3. Add your origin — this step is not optional

In the portal, go to **Settings → Embed** and add every origin the page will be served from:

```
https://acme.com
https://www.acme.com
```

Rules the field enforces:

- **Origins only.** Scheme and host (and a port if it is not the default). No path, no query, no trailing junk. `https://acme.com/investors` is refused rather than trimmed, because an allow-list that silently widens what you typed is worse than one that rejects it.
- **`https://` only**, except `http://localhost`, `http://127.0.0.1` and `http://*.localhost` for local development. A `Secure; Partitioned` cookie cannot be set from an `http:` page at all, so an `http:` customer origin could only ever produce the fallback.
- **`www.` is a different origin.** So is a different port. List each one.
- **No wildcards.** You cannot enter `https://*.acme.com`. The only wildcards in the product are six curated builder-preview patterns behind a single toggle — see the note on each builder's recipe page.
- At most **20 origins** per workspace.

Changing this list is a step-up action: you will be asked to re-authenticate even if you are already signed in, for the same reason changing a custom domain is.

### What happens if you skip it

The browser refuses to render the frame, and you get an empty box and a console error about `frame-ancestors`.

A workspace with nothing configured resolves to `Content-Security-Policy: frame-ancestors 'self'` — meaning only the portal itself may frame the portal, which is what makes the preview on the settings screen work. Every origin you add is appended to that list. Nothing else is:

```
Content-Security-Policy: frame-ancestors 'self' https://acme.com https://www.acme.com
```

This is enforced by the browser, on the portal's own response, before any of our code runs. There is no snippet option, no query parameter and no support request that gets round it; the fix is always to add the origin. If you are unsure what the portal is actually sending, **Settings → Embed** shows the rendered list, and it is derived on every read rather than stored, so it cannot disagree with the header.

## 4. Check it

1. Load the page. The frame should render and, with the loader, settle to the height of its content.
2. Sign in inside the frame. If you see **"Open in a new tab"** instead of a sign-in form, the browser refused the partitioned cookie — that is the documented fallback, not a failure; see the [runbook](../runbooks/embed-troubleshooting.md).
3. Navigate a screen or two and confirm `?sh=…` appears in the host page's address bar (loader only), then reload and confirm you land back where you were.
