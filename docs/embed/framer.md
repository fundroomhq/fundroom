# Framer

## What the platform allows

Three routes, in increasing order of control:

- The native **Embed** component, which takes a URL and renders it in an iframe of Framer's own making.
- **HTML embeds**, which take arbitrary markup — this is where the loader snippet goes.
- **Site Settings → Custom Code**, with head and body slots for the whole site.

Framer also supports code components in TypeScript, so a designer-friendly wrapper around the loader is possible; there is no packaged one today.

## Plan gating

Sources conflict and Framer's pricing has moved more than once. Treat it as: **custom code needs a paid plan**; check the Embed component against current pricing before promising it on a free site. If the customer is on a free plan and the fields are locked, use subdomain mode.

## Steps

1. Add an **Embed** component where the portal should go, or an HTML embed if you want the loader.
2. For the Embed component, set the URL to `https://portal.example/embed/acme` and give the component a fixed height.
3. For the HTML embed, paste the snippet below.
4. In the portal, **Settings → Embed**, add the origins below — including the preview wildcard while you are building, because Framer previews are the double-iframe case (see gotchas).
5. Publish and check on the published domain.

## Snippet

Loader, in an HTML embed:

```html
<div id="investors"></div>
<script src="https://portal.example/embed/v1/embed.js"></script>
<script>
  SeedHost.init({
    workspace: "acme",
    baseUrl: "https://portal.example",
    el: "#investors",
    path: "/updates",
    minHeight: 600,
  });
</script>
```

With the native Embed component, use the URL form instead, and set the height on the component: `https://portal.example/embed/acme/updates`.

## Origins to add

```
https://acme.com
https://www.acme.com
```

**The preview wildcard.** Framer serves previews and unpublished sites from `*.framer.app` and `*.framer.website`, and until the customer publishes to their own domain the final origin does not exist. **Settings → Embed → Allow builder preview origins** covers both patterns — but it also adds `*.webflow.io`, `*.wixsite.com`, `*.wix.com` and `*.squarespace.com` at the same time, and while it is on, any site on any of those six domains can frame this workspace's portal. Turn it on to build, add the real origin when you publish, turn it off. You cannot register a narrower wildcard of your own; customer origins are exact.

## Gotchas

- **Framer double-iframes you.** The native Embed component wraps your URL in *its own* iframe, so the portal ends up nested two frames deep: `acme.com` → Framer's frame → ours. Every ancestor in that chain has to be allow-listed, not just the outermost one, or the browser refuses to render. In practice this means the preview wildcard is genuinely required while the site lives on `*.framer.website`, and it is why Framer sites are the most common source of "it works in preview and not live" (or the reverse). If a frame is blank, check `ancestorOrigins` in the console — more than one entry means you are in this case.
- **The bridge does not cross Framer's frame.** A double-iframed portal cannot resize itself or sync deep links into the host URL, because the loader is not the frame's immediate parent. Use a fixed height on the Framer component and accept an inner scrollbar, or use an HTML embed with the loader so that our frame is a direct child of the page.
- **Publish before you judge it.** Framer's canvas does not run embedded code the way the published site does.
