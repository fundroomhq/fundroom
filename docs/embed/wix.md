# Wix

## What the platform allows

Two mechanisms:

- The **HTML iFrame element** (Embed → Embed a widget / Embed HTML), which takes either a URL to frame or a block of HTML to run. This is the one to use.
- **Custom Elements**, which register a custom tag backed by JavaScript you host. More work, and gated.

## Plan gating

The HTML iFrame element is available on any plan. **Custom Elements require a Premium plan, a connected domain, and no Wix ads**, and the JavaScript must be served over HTTPS. Since the HTML iFrame element does everything we need, the gate rarely matters — reach for a Custom Element only if the customer already has one for other reasons.

## Steps

1. In the editor, **Add → Embed Code → Embed HTML**, and place the element where the portal should go. Give it a generous width and height; Wix elements do not grow with their content.
2. Choose **Code** (not **Website address**) if you are using the loader, or **Website address** with `https://portal.example/embed/acme` if you want the simplest possible thing.
3. Paste the snippet below, apply, and **publish**.
4. In the portal, **Settings → Embed**, add the origins below, including the preview wildcard — you will need it, because Wix frames its own embeds in the editor.
5. View the published site.

## Snippet

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

With **Website address** mode instead, Wix creates the iframe itself and there is no loader — set the element's height to something that suits the content and expect an inner scrollbar.

## Origins to add

```
https://acme.com
https://www.acme.com
```

**The preview wildcard is effectively required on Wix.** Wix serves unpublished and free sites from `*.wixsite.com` and runs the editor and preview on `*.wix.com` origins, so without the toggle the frame is blank every time you look at it in the editor. **Settings → Embed → Allow builder preview origins** adds both — along with `*.webflow.io`, `*.framer.app`, `*.framer.website` and `*.squarespace.com`, because it is one toggle over six curated patterns and not a per-builder choice.

While it is on, any site on any of those six domains can frame this workspace's portal. Turn it off once the customer's real domain is connected and listed. You cannot register your own wildcard; customer origins are exact.

## Gotchas

- **Wix double-iframes your embed.** In the editor and in preview, Wix wraps HTML embeds in its own iframe, so the portal is two frames deep and *both* ancestors must be allow-listed. This is what the preview wildcard is actually for, and it is why "blank in the editor, fine when published" is the normal Wix experience rather than a bug.
- **Nested frames break the bridge.** When Wix owns the outer frame, our frame's immediate parent is Wix's frame and not your page, so height syncing and deep links do not reach the host URL. Set an explicit element height rather than hoping auto-resize takes over.
- **Wix elements have fixed dimensions by design.** Even with the loader, the iframe can only grow inside the HTML element's box; if the element is 400px tall the frame is 400px tall. Size the element, then let `maxHeight` decide whether the frame scrolls internally.
- **Mobile layout is a separate editor.** Set the element's size in the mobile editor too, or the frame will be a sliver on phones.
