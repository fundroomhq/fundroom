# e2e/hosts — the customer's website, in five shapes

Support files for `deploy/compose/compose.hosts.yaml`, which puts an edge and a static web
server in front of the CI stack so `tests/20-embed-hosts.test.ts` can frame the portal from
*other sites* — the only place the partitioned session cookie, `frame-ancestors` and the
postMessage bridge are real.

```sh
export E2E_APP_PORT=3200 E2E_MAILPIT_PORT=8225
export E2E_BASE_URL=http://localhost:3200 E2E_MAILPIT_URL=http://localhost:8225
pnpm --filter @fundroom/e2e stack:up:hosts
pnpm --filter @fundroom/e2e test:hosts             # Chromium
pnpm --filter @fundroom/e2e stack:down:hosts       # -v: the next run needs a fresh install
pnpm --filter @fundroom/e2e stack:up:hosts
pnpm --filter @fundroom/e2e test:hosts:firefox     # the same spec, Firefox
pnpm --filter @fundroom/e2e stack:down:hosts
```

One browser at a time, with the stack reset in between, because the spec drives a **first-run**
install: it creates the owner, invites the investors and sets the allow-list, and its first
assertion is that setup has not been done. A second project starting against the same stack finds
one that has, and says so.

## Why any of this exists

Cookie partitioning is keyed on the **site**, not the origin and certainly not the port. So a
harness that framed `localhost:3000` from `localhost:8081` would prove nothing at all: the two
are the same site, the frame is not third-party to anything, and every assertion about
`Partitioned` cookies would pass for the wrong reason. The suite needs genuinely different
hostnames.

Which then forces TLS. A `Secure; HttpOnly; SameSite=None; Partitioned` cookie is only stored
in a secure context, and off loopback that means `https:`. So: four hostnames, an edge that
terminates TLS for them, and the app behind it.

## The topology

```
                                    ┌───────────────────────────── docker ─────────────┐
  browser                           │                                                  │
   │  MAP *.test 127.0.0.1          │   caddy  ──── portal.test ────────▶ app:3000     │
   ├── https://portal.test/embed/…  │     │                                            │
   ├── https://host-a.test/…        │     ├──── host-a.test  ┐                         │
   ├── https://host-b.test/…        │     ├──── host-b.test  ├─────────▶ hosts:80      │
   ├── https://host-c.test/…        │     ├──── host-c.test  │          (nginx serving │
   └── http://insecure-host.test/…  │     └──── insecure-host.test (http)   this dir)  │
                                    └──────────────────────────────────────────────────┘
```

| Name | What it is |
|---|---|
| `portal.test` | The portal. The one origin the session cookie is ever set on. `BASE_URL` names it, so `frame-ancestors 'self'`, the "open in a new tab" link and every minted URL agree with what the browser sees. |
| `host-a.test` | The customer's site. Everything that has to *work* happens here. |
| `host-b.test` | A **second site**, and the whole reason it exists is to be a different one. A session established on `host-a.test` must not be there, and the last test in the file takes it off the allow-list to watch the browser refuse the frame. |
| `host-c.test` | The inner document of the double-iframe (Wix/Framer/Notion) shape, so the ancestor chain is two deep and both entries have to be allow-listed. |
| `insecure-host.test` | The same files over plain `http:`, so the loader has something to refuse. Declared in the Caddyfile with an explicit `http://` scheme, which is what stops Caddy adding its usual redirect — a page that redirected would test the redirect and not the refusal. |

## The pages

nginx serves this directory exactly as it is on disk. There is no build step and no templating
on purpose: a host page in this harness has to be the same static HTML a customer pastes into a
CMS, hostnames and slug included. The workspace is `acme-inc` and the portal is
`https://portal.test`, hard-coded in every page, and `fixtures/hosts.ts` asserts the slug it
creates is the one the pages name.

| File | What it is |
|---|---|
| `plain.html` | The documented loader snippet (`docs/embed/quickstart.md` §1), character for character apart from the slug and the base URL. A heading and a paragraph above the frame, a paragraph below it — the one below is what makes a layout shift measurable. |
| `deep-link.html` | The same loader with `path: "/settings"` in the snippet, loaded as `?sh=/updates`. The URL has to win: `path` is the default for a visitor arriving without a deep link, `?sh=` is the link *this* visitor followed. |
| `iframe.html` | The raw-iframe snippet (§2): no script at all. The snippet with the fewest moving parts, so a sign-in here proves the cookie, the header and the API prefix on their own, with no loader in the way to have compensated for any of them. |
| `hostile.html` | A page that is both strict and hostile. Strict: a CSP with no `'unsafe-inline'` anywhere, which the loader has to survive — it is why the loader styles its iframe through CSSOM property writes rather than a `style` attribute. Hostile: it loads `tag-manager.js`. |
| `nested.html` + `inner.html` | The builder shape: `host-a.test` frames `host-c.test`, which frames the portal. `frame-ancestors` is checked against the whole chain, so this only renders because both are listed. |
| `insecure.html` | The documented snippet on the `http:` origin. The loader must render the link and never a frame, because a sign-in there would succeed on the server and be forgotten by the browser — a silent failure with no visible cause. |
| `tag-manager.js` | The third-party marketing snippet that is on every real page, written as if its author wanted the investor data: read `document.cookie`, reach into the frame's DOM and location, `fetch()` the portal API with credentials, fetch the embed document itself, and post garbage over the bridge. Everything it obtains goes into `window.__hostile`; the test asserts that record is empty. |
| `mount.js` | `hostile.html`'s copy of the snippet, in a file because its CSP has no `'unsafe-inline'` in `script-src`. Same call, same options. |
| `instrument.js` | Test instrumentation, which a customer never has. It wraps `SeedHost.init` instead of being called by the page, so the documented snippet stays the thing under test, and records the heights the child asked for, the paths it reported, and where the paragraph below the frame sat at mount and at ready. |
| `host.css` | The host site's stylesheet. A file rather than a `<style>` block so `hostile.html` can send `style-src 'self'`. |
| `Caddyfile` | The edge. **Not** the shipped `deploy/caddy/Caddyfile` — that one is the product's edge and the custom-domain suite tests it unmodified; this one is scaffolding whose only job is to put four real origins in front of two containers. |
| `nginx.conf` | `Cache-Control: no-store` on everything. The pages change between runs and the browser keeps its cache across them; a stale page shows up as a baffling assertion failure three tests later. |

## Two decisions worth the paragraph each

### Resolving the hostnames: the browser, not `/etc/hosts`

Chromium is launched with `--host-resolver-rules=MAP *.test 127.0.0.1` (`fixtures/hosts.ts`
builds it, and adds ports when the edge is not on 443/80). Nothing is written to `/etc/hosts`:
that needs root, it outlives the run, and on a hosted runner it is a step that can be forgotten.
Everything downstream of the resolver is the real thing — SNI, the `Host` header, the document
origin, the cookie's partition key — because only the address lookup was replaced.

Firefox says the same thing as `network.dns.localDomains`, which maps names but **cannot carry a
port**; that is why the edge defaults to 443/80 and why `playwright.config.ts` registers the
Firefox project only while both are the defaults, rather than letting it fail as a DNS timeout
that reads like a product bug.

### Why not a trusted root: `ignoreHTTPSErrors`

The certificates come from Caddy's internal CA and the browser is told to accept them
(`test.use({ ignoreHTTPSErrors: true })`). We could have installed Caddy's root instead — it is
one `caddy trust` — but into three different trust stores (Chromium's NSS db, a Firefox profile
policy, WebKit's) on two operating systems, all for a property the suite does not test.

Nothing here is weakened by it, and the reason is worth stating precisely rather than assuming:
**an `https:` origin is a potentially-trustworthy origin regardless of whether its certificate
verifies**, so the page is a secure context, `Secure` cookies are stored, and CHIPS partitioning
applies exactly as it would with a real certificate. The things this file asserts — the cookie's
attributes, the partition key, `frame-ancestors`, CORS, the bridge — are all decided after that
point.

Where certificate *verification* is the subject, the suite does not do this: `10-custom-domains`
verifies the edge's chain in Node against the issuing root with the identity check pinned to the
hostname, precisely because `ignoreHTTPSErrors` would have waved through the failure it exists to
catch. Different question, different tool.

## The Safari gap

There is no WebKit project, and that is a statement rather than an omission. Playwright's WebKit
has no resolver override, so these hostnames could only be reached by editing `/etc/hosts` — and
even with that, Playwright's WebKit is not Safari: it does not reproduce ITP, the Storage Access
prompt, or Safari's own CHIPS behaviour. A green run there would say *something* works and be
read as "Safari works", which is the one inference nobody should draw from a headless build.

The plan calls for a weekly real-Safari run on a device cloud (BrowserStack / LambdaTest) for
exactly the scenarios in this file. It is not wired up yet. When it is, it needs to cover, on a
real macOS Safari and a real iOS Safari:

1. Sign-in inside the frame on `host-a` — the CHIPS path, which is the one ITP changes.
2. The same page a week later, to see whether the partitioned cookie survived ITP's cap on
   script-writable storage.
3. `document.requestStorageAccess()` behind the "Continue with existing session" button, which
   Safari prompts for every time and Chrome gates on a recent top-level visit.
4. The cookie probe's fallback: if the cookie cannot be kept, the frame must offer "Open in a new
   tab" rather than a sign-in form that will not stick.

Those runs need a publicly resolvable host, so they belong against a deployed preview rather than
against this rig. Until then the honest claim for Safari is "designed for, not verified".

## What this harness found

Two product defects, neither of which the existing suites can see. Both are reported rather than
worked around silently; the first has a `test.fail()` test of its own so that fixing it is loud.

### 1. Signing in from a gated route bounces back to the sign-in screen

Not embed-specific — the frame just hits it every time, because a framed visitor always lands on
`/` first and is redirected to `/login`.

`routes/_auth/login/verify.tsx`'s `onSuccess` calls
`queryClient.invalidateQueries({ queryKey: meQuery.queryKey })`. That marks the query stale
without refetching it: nothing on the login screen observes `me`, so there is no active observer
to refetch. It then navigates to `returnTo`, and `_portal`'s `beforeLoad` calls
`ensureQueryData(meQuery)` — which resolves from the cache whenever data *exists*, stale or not.
The cached value is the `null` written by the `/me` that 401'd before the sign-in, so the guard
redirects to `/login` again. The session is real: the cookie is set, and the very next page load
lands correctly.

Reproduced at the top level too, with no embed involved: open `https://portal.test/` signed out,
sign in with a code, and you are returned to the sign-in screen. `00-setup` misses it because it
opens `/login` directly and so never caches a `null`.

`20-embed-hosts.test.ts` reopens the host page once after signing in, and the test named
*"signing in inside the frame lands on the portal without reopening the page"* is marked
`test.fail()` — it passes while the defect is there and fails the day it is fixed, which is the
signal to delete both.

### 2. An invited investor is greeted "Welcome,"

The `displayName` typed on the invitation is stored on `core.membership.profile.displayName`, and
the account created by the first verified login keeps `core.user.display_name = ''`:

```
 display_name |   kind   |   role   | status |              profile
--------------+----------+----------+--------+-----------------------------------
 Sam Founder  | staff    | owner    | active | {}
              | external | investor | active | {"displayName": "Ada Investor"}
```

The portal's home heading is `m.home_welcome({ name: me.session.user.displayName })`, so every
invited investor is greeted by name-shaped punctuation and nothing else. Either the first login
should copy the invitation's profile onto the user, or the greeting should prefer the membership
profile. The suite matches `/^Welcome/` rather than the name, so it will not have to change when
this is fixed.

### And one thing worth a look, not yet a defect

Every page load inside the frame logs two CSP violations to the console:

```
Applying inline style violates the following Content-Security-Policy directive
'style-src 'self' 'nonce-…''
```

Something in the SPA sets a `style` attribute rather than mutating CSSOM properties (CSSOM writes
are not subject to `style-src`), so whatever it was trying to style is unstyled. It is not
embed-specific — the nonce-based policy is the same on the app profile — and nothing visible is
broken in these scenarios, which is exactly why it is worth finding before a customer does.
