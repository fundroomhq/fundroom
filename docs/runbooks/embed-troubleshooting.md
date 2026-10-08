# Runbook: diagnose an embed that will not render

An embed is the portal running in a cross-origin iframe inside a page the customer owns — a Webflow site, a WordPress page, a Notion doc. Almost everything that goes wrong with one is a browser refusing something for a reason it will happily tell you, in a console message nobody has read yet. This runbook is for whoever operates the install: it covers the frame that does not appear, the sign-in that turns into "Open in a new tab", the host site's own policies, and what an `embed.origin_rejected` row in the audit log actually means.

A portal served under a path of the customer's site through their proxy (path mount) fails differently: see [path-mount.md](path-mount.md).

The customer-facing side of all of this is [`docs/embed/`](../embed/README.md).

## What has to be true first

- **You know the three names.** The portal origin (whatever `BASE_URL` says), the workspace slug, and the exact origin of the page doing the framing — scheme and host as a *visitor* sees it in the address bar, not as the editor shows it. Most of this runbook is establishing whether those three agree.
- **You can see Settings → Embed for the workspace.** Reading it needs `embed.read`. Changing it needs `embed.manage` **and a fresh session**: adding or removing an origin changes who may frame the portal, which is the same class of action as changing a custom domain, so expect to re-authenticate even when already signed in.
- **You are testing in a clean browser profile with no extensions.** Ad blockers, privacy extensions and enterprise policies all produce failures that look exactly like our bugs. If you cannot reproduce in a clean profile, the cause is in the profile.
- **You know which snippet is in use.** The loader snippet (`embed.js` plus a container) and the raw-iframe snippet fail differently and are diagnosed differently. Ask, or read the page source.
- **You know whether the host platform adds a frame of its own.** Wix, Framer's Embed component and Notion all wrap embeds in their own iframe, so the portal sits two frames deep and *every* ancestor has to be allow-listed. This is the single most common cause of "it works in preview and not live", and of the reverse.
- For the audit sections, you need access to the workspace's audit log.

## 1. The frame does not render at all

An empty box, or the host platform's own "failed to load" placeholder. Work through these in order; do not skip step 1, because it answers most cases.

1. **Read the browser console on the host page.** The browser says which control refused, and the wording tells you whose problem it is:
   - *"Refused to frame … because an ancestor violates the Content-Security-Policy directive: frame-ancestors …"* → **our** header refused the host. Go to step 2.
   - *"Refused to frame … because it violates the following Content-Security-Policy directive: frame-src …"* → the **host page's** policy refused us. Go to section 3.
   - *"Refused to load the script …"* → the host page's `script-src`, or an extension. Sections 3 and 4.
2. **Ask the portal what it is actually sending.** From anywhere with network access to the portal:

   ```sh
   curl -sSI "https://portal.example/embed/acme" | grep -i 'content-security-policy'
   ```

   The `frame-ancestors` list in that output is the whole answer. If the host origin is not in it, nothing else matters yet.
3. **Compare it with the origin the page is really served from.** Scheme, host and port, exactly. The usual mismatches, in order of how often they turn out to be the cause:
   - `https://www.acme.com` listed but the visitor is on `https://acme.com`, or the reverse. These are different origins. List both.
   - The site is still on a builder preview domain (`*.webflow.io`, `*.framer.website`, `*.wixsite.com`, `*.squarespace.com`) and **Allow builder preview origins** is off.
   - A staging host nobody added.
   - `http://` in the address bar. Go to section 5.
4. **Fix it in Settings → Embed**, not anywhere else. There is no snippet option, query parameter or support override that gets round `frame-ancestors`: it is enforced by the browser on the portal's own response before any of our code runs. The rendered list on that screen is derived on every read rather than stored, so it cannot disagree with the header — if the screen and the `curl` output differ, you are looking at two different installs.
5. **A workspace with nothing configured resolves to `frame-ancestors 'self'`, not `'none'`.** That is deliberate: the honest answer for an unconfigured workspace is "only we may frame this", which is what makes the preview on the settings screen work. So `'self'` alone in the header does not mean the feature is broken — it means nobody has added an origin yet.
6. **Count the ancestors.** In the console of the host page's *frame*, `location.ancestorOrigins` lists them. More than one entry means the platform added a frame of its own; go to section 6.

## 2. Cookies blocked, or "Open in a new tab" where a sign-in form should be

This is the documented fallback, not a failure — but it is worth knowing whether it fired because the browser genuinely refuses partitioned cookies or because something is misconfigured.

1. **Establish which it is.** The frame runs a set-then-read probe on load: it writes a cookie with the same attributes as the session cookie (`SameSite=None; Secure; Partitioned`), reads it back, and deletes it. Three outcomes:
   - **insecure** — the *framed document itself* is not on `https:` and not loopback, which means the portal is being served over plain http. That is an install problem, not an embed problem: fix `BASE_URL` and the edge. An `http:` **host page** is caught earlier and separately, by the loader — see section 5.
   - **blocked** — the write succeeded and the read did not. The browser or a policy is refusing third-party cookies outright.
   - **ok** — the fallback is not what you are looking at; re-read section 1.
2. **Blocked is often correct behaviour.** Partitioned cookies (CHIPS) need Chrome/Edge 115+, Safari 18.4+ (macOS 15.4 / iOS 18.4), or Firefox, which partitions third-party cookies by default. Older Safari, a browser in a hardened privacy mode, or an enterprise policy that blocks third-party cookies wholesale will all land here. Nothing on our side changes that.
3. **What the visitor should do**: click through. "Open in a new tab" opens the same portal on its own origin, where the cookie is first-party and none of this applies. The session continues there. It is not a degraded portal — it is the portal.
4. **What the customer should do** if it happens often: move to subdomain mode. `investors.acme.com` is a CNAME, gives first-party cookies, and removes this entire class of problem. See [custom-domains.md](custom-domains.md).
5. **Do not try to work around it.** There is no configuration that makes a browser accept a cookie it has decided to refuse, and anything that appears to be one is a bug.
6. **One login per (host site × portal origin)** is expected, not a fault. An investor who visits two of the same founder's sites signs in on each; the partition is what keeps one host site from reading the other's session.

## 3. The host site's CSP is blocking the script or the frame

1. **Read what the host site sends:**

   ```sh
   curl -sSI "https://acme.com/investor-relations" | grep -i 'content-security-policy'
   ```

2. **What it needs**, and nothing more:
   - `frame-src https://portal.example` — always.
   - `script-src https://portal.example` — loader snippet only.
   - `connect-src` — **never**. If someone has added it, remove it: that would be the host page talking to our API, which is precisely what the iframe architecture prevents.
3. **Remember the fallback chain.** `frame-src` falls back to `child-src`, which falls back to `default-src`. A host page with `default-src 'self'` and no `frame-src` blocks the frame, and the fix is to add `frame-src` — not to widen `default-src`.
4. **The inline `SeedHost.init(...)` block** is blocked by any nonce- or hash-based policy. Give it the host page's nonce, or move the call into an already-allowed bundled file. Do not reach for `'unsafe-inline'`: it is a far larger change to the host site than the embed needs, and it will outlive the reason it was added.
5. **Check for a second CSP.** Two `Content-Security-Policy` headers on one response are *intersected*, not merged — each must independently allow what happens. A platform-level header rule (Cloudflare Transform Rules, Netlify `[[headers]]`, a Next.js `headers()` entry, a WordPress security plugin) on top of the site's own policy is the usual cause, and the symptom is a policy that looks correct in the source but not in the response.
6. **`Cross-Origin-Embedder-Policy: require-corp` on the host page blocks us outright.** Cross-origin isolation requires every cross-origin subresource, iframes included, to opt in with `Cross-Origin-Resource-Policy: cross-origin`, and the embed document deliberately does not. If the host page is cross-origin isolated — usually enabled for `SharedArrayBuffer` or a wasm library, often years ago and not by the person you are talking to — the embed cannot render there and no setting of ours changes it. The options are to drop isolation on that page or to use subdomain mode.
7. **What we send, for reference:** on `/embed/*`, a per-workspace `frame-ancestors`, **no** `X-Frame-Options` (it has no list form, so any value it could carry would contradict the CSP we just computed), **no** `Cross-Origin-Opener-Policy` (COOP would sever the frame from the host page's browsing context group and kill the bridge), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, and `Cache-Control: private, no-store`. A missing `X-Frame-Options` under `/embed/` is deliberate; anywhere else it is a bug.

## 4. An ad blocker or privacy extension is eating the loader

1. **Confirm it.** Load the page with all extensions disabled, or in a clean profile. If it works there, you are done diagnosing.
2. **Check the network panel** for `embed.js`: blocked-by-extension shows as a failed request with no status, which looks identical to a network error and nothing like a CSP refusal.
3. **There is nothing to whitelist on our side.** The loader is served from the portal's own origin — there is no CDN in this product and no third-party hostname to add to a filter list, which is most of why this is rarer here than with a typical embed. The script is named `embed.js` and served under `/embed/`, with no `/track/` or `/analytics/` in the path, precisely to stay off pattern-matching filter lists.
4. **The durable answer is the raw-iframe snippet.** It has no script for an extension to block. You give up auto-resize, deep-link syncing and per-placement theme tokens; if the customer's audience runs aggressive blockers, that is usually a good trade. See `docs/embed/quickstart.md`.
5. **Whatever the extension does, the visitor is not stranded**: the loader's failure path renders a plain link to the portal's canonical origin. If they see an empty box instead of a link, the *loader itself* never ran — go back to step 2.

## 5. The host page is served over `http:`

1. **The loader refuses to run, by design**, and renders the link fallback with a console explanation. This is not a bug to route around.
2. **The reason is the cookie.** A session cookie with `Secure; Partitioned` cannot be set from an insecure page at all, so an embed on an `http:` page could only ever show the "Open in a new tab" fallback. Refusing up front, with an explanation, beats rendering something that cannot work.
3. **`http://localhost`, `http://127.0.0.1`, `[::1]` and `*.localhost` are exempt**, because browsers treat them as secure contexts. This is the one place an `http:` origin is accepted in the allow-list, and it exists for local development.
4. **`http://dev.acme.test` is not loopback** and will not work. This is the most common local-development surprise; use a `localhost` port or terminate TLS locally.
5. **You cannot store an `http:` customer origin** in Settings → Embed — the field refuses it, for the reason in step 2. If someone reports that a valid-looking origin was rejected, check the scheme first.
6. **Mixed content on an otherwise-https page** (the page is `https:` but something on it is not) does not block the frame, but it will show up in the console next to the real error. Do not spend time on it before you have read section 1.

## 6. The platform double-iframed us

1. **Confirm it**: in the framed document's console, `location.ancestorOrigins.length > 1`. Wix (editor and preview), Framer's native Embed component and Notion all do this.
2. **Every ancestor must be allow-listed**, not just the outermost. The browser walks the whole chain against `frame-ancestors`, so one unlisted intermediate origin refuses the frame with the same message as an unlisted top-level one.
3. **In practice this means the preview wildcard.** **Settings → Embed → Allow builder preview origins** adds six curated patterns — `*.webflow.io`, `*.framer.app`, `*.framer.website`, `*.wixsite.com`, `*.wix.com`, `*.squarespace.com` — which is what makes builder editors and previews work. Two things to say out loud before turning it on:
   - It is one toggle over all six, not a per-builder choice.
   - While it is on, **any** site on any of those domains can frame this workspace's portal.

   Turn it on to get a build unstuck, add the real origin when the site publishes, and turn it off. Nothing turns it off automatically, because a workspace that lives permanently on a builder subdomain is a legitimate configuration.
4. **`*.notion.site` is not on that list and will not be added.** Notion pages are public by default, so a Notion wildcard would let any published Notion page frame the portal. A workspace that wants a Notion embed adds the exact origin by hand and owns that decision. If someone asks you to add the wildcard, this is the answer.
5. **The bridge does not survive an extra frame.** When the platform owns the outer iframe, our frame's immediate parent is the platform's frame rather than the host page, so height syncing, deep links and host-supplied theme tokens do not reach the page. Expect a fixed height and an inner scrollbar, and tell the customer that before they file it as a bug.
6. **Customers cannot enter their own wildcards.** `https://*.acme.com` is refused by the field. That is deliberate: a wildcard over a customer's own zone is a standing trust of every host anyone can ever put under it, including a stale staging box and a subdomain-takeover target, and nobody reads an allow-list entry that way at the time they write it.

## 7. The host's router destroys and re-creates the container

Symptoms: the frame disappears after a client-side navigation; two frames appear; the frame reloads and loses its place; a slow memory climb on a long-lived single-page host.

1. **The loader already watches for this.** A `MutationObserver` detects its container being removed and re-mounts, restoring the current path. If it cannot re-mount, it renders the link fallback rather than leaving an empty box.
2. **A re-mount is a reload.** The frame starts again: the session survives (it is a cookie), the scroll position and any half-filled form do not. A host page that re-renders on every route change will look like it is flickering, and the fix is on the host side.
3. **Tell the integrator to call `destroy()` on unmount.** The observer is a safety net for routers we cannot see into; when the host owns the component, an explicit teardown is cheaper and more predictable. `docs/embed/nextjs.md` has the pattern for React.
4. **Two frames means two `init` calls.** A framework that mounts the component twice, or a `<script src>` included twice, produces two iframes. Include the loader once per page and call `init` once per container.
5. **If the container is `display: none` at `init` time**, the frame is created with no height and the first resize message may report zero. Mount it visible, or set `minHeight`.

## 8. `embed.origin_rejected` in the audit log

This is the one entry in this runbook that is telemetry rather than a fault report, and reading it correctly matters.

1. **What it means.** The embed document was requested with **positive evidence** of a disallowed initiator: a cross-site `Sec-Fetch-Site` together with a `Referer` or `Origin` whose origin is not on the workspace's list. The request was refused and served a minimal, unbranded page explaining the refusal and linking the canonical origin.
2. **What it does not mean.** It is not a security incident on its own, and it is not the framing control. `frame-ancestors` is what actually stops a browser from rendering the frame; this check is defence in depth and, more usefully, the only way an admin ever learns that someone tried. The most common cause by a wide margin is **a customer who pasted the snippet on a page whose origin they have not added yet** — check Settings → Embed against the origin in the row before thinking about anything else.
3. **Absence of rows is not absence of attempts.** The check refuses only on positive evidence, and there is plenty of legitimate traffic that supplies none: a host page sending `Referrer-Policy: no-referrer` gives us nothing to check, and a direct top-level visit to `/embed/<slug>` is a person following the "open in a new tab" fallback. Both are served, deliberately — a disagreement resolves to the weaker answer, so the failure mode is "not verified" rather than "wrongly refused".
4. **The audit write is throttled per (workspace, origin).** One row does not mean one request. The audit log is hash-chained per workspace, so every row is a serialised append; an unthrottled event on an unauthenticated public route would be a remote way to make a workspace's log grow and its writes queue behind each other. If you need the true rate, read the HTTP logs, not the audit log.
5. **When to treat it as an incident.** A sustained stream from an origin the customer does not recognise, especially one whose hostname imitates theirs, is worth a conversation: a phishing wrapper around a real portal is exactly what `frame-ancestors` exists to stop, and the rejection row is the evidence that someone tried. The portal was not framed — that is the point — but the customer should know.
6. **Do not "fix" it by adding the origin.** Add an origin because the customer asked you to and confirmed they own the site. Adding one to make a log line stop is how an allow-list ends up containing a host nobody can account for.

### The other embed audit actions

| Action | Written when | What to check |
|---|---|---|
| `embed.settings_changed` | Someone changed the origin list, the preview toggle, `trustHostIdentity`, or the registered handoff keys | Who, and whether a key disappeared — the key list is a whole-list replace, so saving without a key removes it |
| `embed.origin_rejected` | As above | Section 8 |
| `embed.handoff_accepted` | A signed host assertion minted a session | The email, and that `trustHostIdentity` is on deliberately |
| `embed.handoff_rejected` | An assertion failed verification | The reason. `expired` in bulk usually means clock skew on the host's server or a cached page serving a stale assertion; `unknown_key` means a rotation finished on one side only |

## 9. Signed handoff is not working

1. **`trustHostIdentity` must be on for the workspace**, and it is off by default. It is off by default because the trade is real: turning it on makes a compromise of the host site into investor impersonation in this workspace. That is the founder's decision, not the integrator's, and not yours.
2. **The public key must be registered** in Settings → Embed with the same `kid` the host signs with. The verifier selects the key by `kid` from the registered list and only then verifies — it never reads the token's own `alg` to choose how to verify, which is how JWT verifiers get broken.
3. **`EdDSA` (Ed25519) only.** There is no HS256 path and there will not be one: we store a public key, so there is no secret of ours at rest, nothing secret in the settings that every request already carries, and a database compromise cannot mint an assertion.
4. **Check the host server's clock first.** It is the most common cause and the least obvious. The
   assertion is valid for 60 seconds and the host's clock is allowed to differ from the portal's by
   at most **5 seconds**; beyond that, every handoff is refused as `not_yet` (host clock ahead) or
   `expired` (behind). Run NTP on the host. A site that is five minutes fast fails 100% of the time
   while every other part of the embed works perfectly, which is what makes it hard to spot.
5. **The claims are strict**, and `embed.handoff_rejected` names which one failed: `aud` equal to
   the workspace slug; `exp - iat` no more than 60 seconds; `exp` in the future; `iat` no more than
   5 seconds ahead; `sub` a syntactically valid email; `iss` present and a bare https origin (no
   path — a WordPress install in a subdirectory must send the origin, not `home_url()`); a `jti`
   within its permitted charset. Note that handoff needs the host site to be **https**: the plugin
   refuses to mint over plain http rather than emitting a token the portal would reject.
6. **The API tells you less than the audit log does, deliberately.** `unknown_key` and
   `bad_signature` are both reported to the caller as `invalid_assertion`, because distinguishing
   them on a public endpoint lets a prober enumerate which key ids a workspace has registered. The
   precise reason is in `embed.handoff_rejected`. Debug from the audit log, not the HTTP response.
7. **Each assertion is single use.** A replay is refused. If a host page carrying an assertion is being cached by a page cache or a CDN, the first visitor consumes it and everyone after gets a rejection: exclude those pages from caching. On WordPress, the plugin does this for the pages it knows about — a CDN in front of WordPress is a separate exclusion.
8. **An assertion cannot enrol anyone.** The email must already be a member or an invitee of the workspace; an unknown address is refused, and that refusal is the feature. If a customer reports "handoff does not work for new investors", it is working: invite them first.
9. **The session it mints is the lowest authentication level.** Every step-up gate still asks — the data room's own policy, the freshness requirement on changes, staff MFA. A customer expecting handoff to skip a data-room prompt is expecting the wrong thing.

## Keys and settings this runbook refers to

| Key | Where | Default |
|---|---|---|
| `BASE_URL` | app | the portal's public origin; what the loader's `baseUrl` and the iframe `src` must match |
| `BASE_PATH` | app | empty (path-mount mode only; the bundled edge needs `FUNDROOM_BASE_PATH` to match — see [path-mount.md](path-mount.md)) |
| `TRUST_PROXY` | app | `false`; `true` behind Caddy or a load balancer |
| `settings.embed.origins` | per workspace | empty — resolves to `frame-ancestors 'self'` |
| `settings.embed.allowPreviewOrigins` | per workspace | `false` |
| `settings.embed.trustHostIdentity` | per workspace | `false` |
| `settings.embed.handoffKeys` | per workspace | empty (at most four) |

At most **20 origins** per workspace, each exact, `https://` only except on loopback.
