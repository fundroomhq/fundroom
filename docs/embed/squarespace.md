# Squarespace

Squarespace is the one platform where the answer depends entirely on the plan, and where for some customers the answer is "not with an embed".

## What the platform allows

| Capability | Plans |
|---|---|
| Code blocks with **HTML and CSS** | All plans |
| Code blocks with **JavaScript and iframes** | Core, Plus, Advanced, Business, Commerce |
| **Code Injection** (site-wide head/footer) | Core, Plus, Advanced — **not** Business |

Read those two rows together, because the combination is what bites: a Business-plan site can paste an iframe into a code block but cannot use site-wide code injection, so the whole snippet has to live in the block.

## Plan gating — the Basic plan cannot embed at all

There is no iframe and no JavaScript on Basic, which means there is no version of this page that works. **Point the customer at subdomain mode instead**: a CNAME for `investors.acme.com`, set up in the portal's **Settings → Domains** (see [the custom-domains runbook](../runbooks/custom-domains.md)). It costs them one DNS record rather than a plan upgrade, gives first-party cookies, avoids every third-party-cookie problem on this page, and they can link to it from any Squarespace button on any plan.

That is not a workaround offered grudgingly. Subdomain mode is the recommended default for everyone; the embed exists for customers who need the portal to appear *inside* an existing page, and a Basic-plan site cannot express that wish at all.

## Steps

On Core, Plus, Advanced, Business or Commerce:

1. Edit the page, add a **Code** block where the portal should appear.
2. Paste the snippet below. Turn **Display Source** off.
3. Save and view the live page — a code block does not render in the editor.
4. In the portal, **Settings → Embed**, add the origins below.

## Snippet

The loader, if your plan allows JavaScript (Core and above, including Business):

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

Or the raw iframe, which needs no JavaScript at all — useful if a script is being stripped and you want to eliminate a variable:

```html
<iframe
  src="https://portal.example/embed/acme/updates"
  title="Investor relations portal"
  style="width:100%;height:900px;border:0;display:block"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-write; fullscreen; publickey-credentials-get"></iframe>
```

The raw iframe gives up auto-resize, deep-link syncing and per-placement theme tokens. See [the quickstart](quickstart.md#2-the-raw-iframe-snippet) for the full list of what you trade away.

## Origins to add

```
https://acme.com
https://www.acme.com
```

**The preview wildcard.** An unpublished Squarespace site lives on `*.squarespace.com`, so **Settings → Embed → Allow builder preview origins** is how you test before the domain is connected. It adds all six curated builder patterns at once — `*.squarespace.com`, `*.webflow.io`, `*.framer.app`, `*.framer.website`, `*.wixsite.com`, `*.wix.com` — and while it is on, any site on any of them can frame this workspace's portal. Add the real origin as soon as the domain is connected and turn the toggle off. You cannot enter a narrower wildcard of your own.

## Gotchas

- **Check the live page, not the editor.** Code blocks are inert while editing.
- **Business plan and no code injection**: keep the `<script src>` tag inside the same code block as the `init` call. Do not split it across blocks expecting order — blocks on a page do execute in order, but a later layout edit can reorder them and the failure looks like "the snippet stopped working for no reason".
- **Squarespace's own consent banner** is the host CMP as far as we are concerned. The embed never shows a banner of its own; if you want product analytics in the portal, wire the banner's answer to `portal.setConsent({ analytics: true })`. Withheld is the default, and a Global Privacy Control signal from the browser overrides a "yes" from any banner.
