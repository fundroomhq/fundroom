# Webflow

## What the platform allows

Everything you need. Webflow's **Code Embed** element takes arbitrary HTML on a single element, and **Site Settings → Custom Code** (and per-page custom code) takes head and body snippets for the whole site. Nothing blocks external scripts or iframes, so the [loader snippet](quickstart.md#1-the-loader-snippet) is the right choice here.

Custom code is limited to **50,000 characters** per field. The snippet is a few hundred, so this only matters if you are sharing the field with other tooling.

## Plan gating

Custom code requires a **paid Site plan** (Basic and above). On the free Starter plan the custom-code fields show "Upgrade required" and nothing you paste will publish. If the customer is on Starter and does not want to upgrade, use subdomain mode — `investors.acme.com` costs them a DNS record instead of a plan.

## Steps

1. In the Designer, drop a **Code Embed** element where the portal should appear. Give it full width.
2. Paste the snippet below into it.
3. **Publish.** Then open the published site (or the `.webflow.io` staging domain) and check it there.
4. In the portal, **Settings → Embed**, add the origins below.

Site-wide custom code works too, if you would rather keep all embeds in one place: put the `<script src>` tag in Site Settings → Custom Code → Footer Code, and leave only the `<div>` plus the `init` call in the Code Embed element.

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

`minHeight` matters more on Webflow than elsewhere: the surrounding layout is usually built to exact heights, and a frame that starts at zero and then jumps to 900px will shove the rest of the page around on every load.

## Origins to add

The published site, and the staging domain if you use it:

```
https://acme.com
https://www.acme.com
```

**The preview wildcard.** Webflow publishes to `<site>.webflow.io` before it goes to the real domain, and until the customer publishes to their own domain nobody knows the final origin. **Settings → Embed** has one toggle, **Allow builder preview origins**, to cover that. Read what it actually does before turning it on:

- It adds **all six** curated builder patterns at once — `*.webflow.io`, `*.framer.app`, `*.framer.website`, `*.wixsite.com`, `*.wix.com`, `*.squarespace.com` — not just the Webflow one.
- While it is on, **any site on any of those domains can frame this workspace's portal**, not only yours. That is what a wildcard means and there is no narrower version of it; you cannot enter `https://*.acme.com` or even `https://acme.webflow.io`-only as a pattern, because customer-entered origins are exact by design.
- Nothing turns it off for you.

So: turn it on while you are building, add the real origin the moment you publish to it, and turn it off. A workspace that stays on a `.webflow.io` domain permanently is a legitimate configuration — it just means accepting the trade knowingly.

## Gotchas

- **Check the published site, not the Designer canvas.** Embedded code is not executed while you are editing. What you see in the Designer is a placeholder, and it is not evidence of anything.
- **Two `<script src>` tags on one page is one too many.** If you embed the portal twice on one page, load the loader once (site-wide footer code) and call `SeedHost.init` twice with different containers.
- **The container needs a width.** A Code Embed inside a narrow column inherits that column's width; the frame is `width: 100%` of whatever you put it in.
