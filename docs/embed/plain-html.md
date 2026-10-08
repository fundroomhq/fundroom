# Plain HTML

The reference case: a static site, a hand-written page, a template in any server framework. Everything is possible, so this page is mostly about doing it properly.

## What the platform allows

Anything. Scripts, iframes, your own CSP, your own nonces, and full control of the container element.

## Plan gating

None.

## Steps

1. Put a container where the portal should appear.
2. Load the loader and call `init`.
3. In the portal, **Settings → Embed**, add every origin the page is served from — production, `www`, staging, and `http://localhost:5173` (or whichever port) if you develop locally.

## Snippet

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Investor relations — Acme</title>
  </head>
  <body>
    <h1>Investor relations</h1>

    <div id="investors"></div>

    <script src="https://portal.example/embed/v1/embed.js"></script>
    <script>
      SeedHost.init({
        workspace: "acme",
        baseUrl: "https://portal.example",
        el: "#investors",
        path: "/updates",
        minHeight: 600,
        maxHeight: 1400,
      });
    </script>
  </body>
</html>
```

Set `lang` on the host page and pass `locale` if the portal should match a language the host page has already chosen.

### With ES modules

```html
<div id="investors"></div>
<script type="module">
  import { init } from "https://portal.example/embed/v1/embed.mjs";
  const portal = await init({
    workspace: "acme",
    baseUrl: "https://portal.example",
    el: "#investors",
  });
  portal.on("auth", ({ state }) => {
    document.body.dataset.portalAuth = state;
  });
</script>
```

### The raw iframe

If you would rather have no JavaScript at all — the smallest possible surface, and nothing for an ad blocker or a CSP to object to:

```html
<iframe
  src="https://portal.example/embed/acme/updates"
  title="Investor relations portal"
  style="width:100%;height:900px;border:0;display:block"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-write; fullscreen; publickey-credentials-get"></iframe>
```

Do not remove `allow-same-origin` from that sandbox list. Without it the frame gets an opaque origin, cannot hold a cookie, and no one can sign in — a change that looks like tightening security and actually breaks authentication outright.

## Origins to add

```
https://acme.com
https://www.acme.com
https://staging.acme.com
http://localhost:5173
```

`http://` is accepted **only** on loopback — `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`, which browsers treat as secure contexts. Every other origin must be `https://`, because a `Secure; Partitioned` cookie cannot be set from an insecure page at all, so an `http://acme.com` entry could never produce anything but the fallback. There is no preview wildcard to reach for here, and no way to enter one of your own: each origin is exact, up to twenty per workspace.

## Gotchas

- **Your own CSP is the thing most likely to break this.** See the [CSP checklist](csp.md); the short version is `frame-src https://portal.example` and, for the loader, `script-src https://portal.example` plus a nonce on the inline `init` block.
- **Serve the page over HTTPS, even locally on a real hostname.** The loader refuses to run on an `http:` page that is not loopback and renders a link instead, because a partitioned cookie cannot be set there. This is the most common local-development surprise: `http://dev.acme.test` is not loopback and will not work, `http://localhost:5173` will.
- **Call `destroy()` if the page is a single-page app.** A framework that unmounts your container without telling us leaves a listener behind. The loader does watch for its element being destroyed and re-mounts, but an explicit `destroy()` in the unmount hook is cheaper and more predictable — see [Next.js](nextjs.md) for the pattern.
- **One loader, many frames.** To put two portal views on one page, include the script once and call `init` twice with different containers.
