# Loader API reference

`@fundroom/embed`, version `0.1.0`. Served by the install at `${baseUrl}/embed/v1/embed.js` (IIFE, defines `window.SeedHost`) and `${baseUrl}/embed/v1/embed.mjs` (ESM). TypeScript declarations ship with the package.

The loader is budgeted at **5 KB gzip** and the build fails if it goes over. That budget is why it does one thing: create an iframe on the portal origin and talk to it. Everything else is in the frame.

## `SeedHost.init(options)`

Returns a promise for the instance. It resolves when the frame has posted `ready`; it does not reject when the frame fails to appear — a failed embed renders the link fallback and warns on the console instead, because a rejected promise in a snippet pasted into a CMS is an unhandled rejection nobody will see.

```js
const portal = await SeedHost.init({
  workspace: "acme",
  baseUrl: "https://portal.example",
  el: "#investors",
  path: "/updates",
});
```

### Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `workspace` | `string` | — | **Required.** The workspace slug. This is what selects the tenant; there is no key beside it. |
| `baseUrl` | `string` | — | **Required.** The portal's origin, including a base path if the install has one (`https://acme.com/investors`). Required rather than inferred because this product is self-hostable and there is no single hostname to guess. |
| `el` | `string \| HTMLElement` | — | **Required.** A CSS selector or the element itself. The iframe is created inside it. |
| `path` | `string` | `"/"` | The screen to open on. Must start with a single `/`. |
| `theme` | `Record<string, string>` | none | `--sh-*` token overrides, posted to the frame. Outranks the workspace brand. See [theming](theming.md). |
| `locale` | `string` | the frame decides | Passed to the frame so it matches the host page's language. |
| `consent` | `{ analytics: boolean }` | essential only | The host CMP's answer for product analytics. Withheld unless you pass it. |
| `history` | `"query" \| "hash" \| "none"` | `"query"` | How the visitor's position in the frame is reflected in the host page's URL. `"query"` writes `?sh=/updates`; `"hash"` writes a fragment; `"none"` leaves the host URL alone. |
| `minHeight` | `number` | a skeleton height | Floor for the auto-resize, in CSS pixels. Set it to the height you expect so the page does not shift as the frame settles. |
| `maxHeight` | `number` | none | Ceiling for the auto-resize. Past it the frame scrolls internally. |
| `title` | `string` | `"Investor relations portal"` | The iframe's `title`. Screen readers read it; change it if the page already says "Investor relations" above the frame. |
| `handoff` | `string` | none | A signed host-identity assertion, posted over the bridge. Never put one in a URL. See [WordPress](wordpress.md) and [Next.js](nextjs.md). |
| `onEvent` | `(e) => void` | none | Called for every message the frame sends, including ones this version of the loader does not know about. |

There is no `mode` option. Embed mode is an iframe on the portal origin, full stop; an option whose only legal value is its default would be a promise of a second security model we are not making.

There is no `openDocument(id)` in v1 either. `navigate("/data-room/<id>")` covers deep links, and an identifier whose route shape is not yet frozen is a compatibility trap in a snippet that will never be edited again.

### What the loader sets on the iframe

You do not configure these, and the recipes repeat them for anyone pasting a raw iframe:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups
         allow-popups-to-escape-sandbox allow-downloads"
allow="clipboard-write; fullscreen; publickey-credentials-get"
style="width:100%;border:0;display:block"
title="<your title>"
```

`allow-same-origin` is required: without it the frame gets an opaque origin and cannot have cookies at all, so there would be no session to partition. `allow-top-navigation` is never set. `loading="lazy"` is set only when the container starts below the fold. `publickey-credentials-get` in `allow` is what makes passkeys possible inside the frame — it works only if the host page delegates the feature *and* the portal's own `Permissions-Policy` grants it, which it does; the top-level popup stays the guaranteed path because the delegation depends on a host we do not control.

The loader **does not** suppress the referrer, deliberately. A top-level iframe navigation sends no `Origin` header, so `Referer` is the only initiator signal the portal's origin check has.

## Instance methods

| Method | Effect |
|---|---|
| `portal.on(type, cb)` | Subscribe to a message from the frame. |
| `portal.off(type, cb)` | Unsubscribe the same function reference. |
| `portal.navigate(path)` | Send the frame to `path`. Must start with a single `/`. |
| `portal.setTheme(tokens)` | Replace the host-supplied token overrides. |
| `portal.setConsent({ analytics })` | Tell the frame the CMP's answer changed. Call it when your banner changes, not only on load. |
| `portal.logout()` | Ask the frame to end the session. |
| `portal.destroy()` | Remove the iframe, drop the message listener, stop the resize and history syncing. Call it from your framework's unmount hook. |

## The bridge protocol

Every message in both directions is `{ v: 1, type, payload }`. Messages are posted to exactly one explicit origin — never `"*"` — and each side validates the sender: the frame checks `event.origin` against the workspace's embed origin list, the loader checks it against the portal origin.

**An unknown `type` is ignored, never thrown, in both directions.** That is the contract, and a test pins it. The reason is that `@fundroom/embed` versions independently of the portal, and the snippet lives in someone else's CMS: a host page will run a loader older or newer than the portal it frames, sometimes for years, and nobody is going to update it. So an old snippet keeps working against a newer portal, a new snippet keeps working against an older portal, and adding a message type is a minor version on both sides rather than a break.

The practical consequence for you: **do not treat the absence of a message as an error.** If you subscribe to something this portal does not send yet, your callback simply never fires.

### Frame → host

Subscribe with `portal.on(type, cb)`, or take them all through `onEvent`.

| `type` | `payload` | When |
|---|---|---|
| `ready` | `{ path: string }` | The frame has mounted. This is what resolves `init()`. |
| `resize` | `{ height: number }` | The frame's content changed height. The loader sets the iframe height from it, clamped to `minHeight`/`maxHeight`. |
| `navigate` | `{ path: string }` | The visitor moved to another screen. The loader writes it into the host URL according to `history`. |
| `auth` | `{ state: "anonymous" \| "authenticated" \| "expired" }` | The session state changed. Useful for showing or hiding your own "sign in" call to action around the frame. |
| `open-external` | `{ url: string }` | Something in the frame needs a top-level context — a sensitive action that must not happen inside an iframe. The loader opens it. |
| `event` | `{ name: string, data: object }` | A product event, for your own analytics. **Identifiers and counts only — never titles, never file bytes.** Do not build a dashboard that expects document names here; they are not coming. |
| `scroll-to` | `{ y: number }` | An anchor link inside the frame wants the *host page* scrolled, because the frame is as tall as its content and has no scroll of its own. |

### Host → frame

Sent by the methods above; listed so you can reason about ordering.

| `type` | `payload` | Sent by |
|---|---|---|
| `theme` | `{ tokens: Record<string, string> }` | `init({ theme })` and `setTheme()`. May include the pseudo-token `--sh-color-scheme: "light" \| "dark" \| "auto"`. |
| `navigate` | `{ path: string }` | `navigate()` |
| `consent` | `{ analytics: boolean, gpc?: boolean }` | `init({ consent })` and `setConsent()` |
| `handoff` | `{ assertion: string }` | `init({ handoff })` |
| `logout` | `{}` | `logout()` |

### Consent is a floor, not a switch

The rule on both sides is `granted = analytics && !gpc`. A host CMP can turn product analytics **off** over any signal; it can never turn it **on** over a Global Privacy Control signal. The server enforces this independently of the client, and the client says the same thing so the two cannot disagree. If your CMP reports consent and the browser sends GPC, the answer is no.

The embed never shows a consent banner of its own. It defers to the host page's CMP, which is the only one the visitor saw.

## Failure behaviour

The loader gives up in favour of a plain link — "Open investor portal", pointing at the workspace's canonical origin — in each of these cases. All of them also log a console warning that names the cause.

| Condition | How it is detected |
|---|---|
| The host page is served over `http:` | Checked before anything is created. A `Secure; Partitioned` cookie cannot be set from an insecure page, so the frame could only ever show the fallback. The loader refuses to embed rather than render something that cannot work. |
| The frame never posts `ready` | 5-second timeout. Usually the host CSP refusing the frame, or `frame-ancestors` refusing the host. |
| The script or the frame failed to load | `onerror` on the iframe. Usually an ad blocker or a CSP. |
| The host's router destroyed the container | A `MutationObserver`. The loader re-mounts and restores the current path; if it cannot, it falls back to the link. |

The link fallback is not a degraded portal — it is the same portal, first-party, on its own origin, where every one of these problems is absent. That is why subdomain mode is the recommended default and why every fallback points at it.
