# Notion

Notion embeds work, and they are the case that most needs reading before pasting — because a Notion page is public by default and the portal is not.

## What the platform allows

Type `/embed` on a Notion page, paste a URL, and Notion builds an iframe for it (it resolves the URL through Iframely first). There is no way to run a script, so there is no loader here: only the URL form.

## Plan gating

None. Embeds work on every Notion plan.

## Read this first: public pages and the login wall

A Notion page that has been **shared to the web is public to anyone with the link**, and search engines may index it. The portal inside the frame is not — investors sign in *inside the frame*, and nothing gated renders before they do. That is what makes the arrangement safe, and it is also the only thing that makes it safe. Two consequences:

- **The login happens in the frame.** A visitor to the Notion page sees a sign-in prompt, not content. Do not expect the embed to be a teaser: it will not render round terms, documents, or anything else pre-authentication, and that is by design.
- **Expect the partitioned-cookie fallback to fire more often here** than on a normal website. If the browser refuses the partitioned cookie, the frame shows "Open in a new tab" and the visitor continues on the portal's own origin, first-party. Put a plain link to the portal next to the embed so there is always an obvious way through.

If you want a teaser on a public Notion page, write it in Notion. The frame is for the gated part.

## Steps

1. On the Notion page, type `/embed` and press Enter.
2. Paste `https://portal.example/embed/acme` (add a path for a specific screen: `https://portal.example/embed/acme/updates`).
3. Drag the block's bottom edge to a sensible height. Notion embeds do not resize themselves and there is no loader to make them.
4. In the portal, **Settings → Embed**, add the exact Notion origin you will be serving the page from (below).

## Origins to add

The exact origin, and nothing else:

```
https://acme.notion.site
```

…or `https://www.notion.so` if the page is shared from a `notion.so` URL. Check the address bar of the page as a *visitor* sees it and add that origin.

**There is no preview wildcard for Notion, deliberately.** The builder-preview toggle covers six curated patterns — `*.webflow.io`, `*.framer.app`, `*.framer.website`, `*.wixsite.com`, `*.wix.com`, `*.squarespace.com` — and `*.notion.site` is **not** among them, and will not be. A Notion site wildcard would mean any Notion page anyone publishes could frame this workspace's portal, and Notion pages are public by default, so the blast radius is the whole of Notion rather than one customer's builder account. A workspace that wants a Notion embed types the exact origin and owns that decision.

So: do not turn the preview toggle on hoping it will help here. It will not, and it will widen the allow-list in six directions that have nothing to do with Notion.

## Gotchas

- **"Failed to load" usually means `frame-ancestors`.** Notion renders its own error box when the framed page refuses to be framed; it does not tell you why. Add the exact Notion origin and reload. Notion caches the resolved embed, so give it a hard refresh before concluding it did not work.
- **Notion builds its own iframe**, so the portal may be two frames deep and every ancestor has to be allow-listed. If the embed block is inside a synced block or a toggle, that does not add a frame — but a Notion page embedded inside *another* page's embed does.
- **No auto-resize, no deep links.** No script means no bridge to the host page. Size the block by hand, and accept that the Notion page's URL will not follow the visitor into the frame.
- **Nothing in the frame is indexed.** The embed sends `X-Robots-Tag: noindex, nofollow`. The Notion page around it is Notion's business and may well be indexed — check the page's own sharing settings if that matters.
