# @fundroom/e2e

Playwright end-to-end tests against the real image.

```sh
pnpm --filter @fundroom/e2e stack:up          # builds deploy/docker/Dockerfile, boots db + mailpit + app
pnpm --filter @fundroom/e2e exec playwright install chromium   # once
pnpm --filter @fundroom/e2e test
pnpm --filter @fundroom/e2e stack:down
```

The stack (`deploy/compose/compose.ci.yaml`) starts a fresh, un-set-up install with a fixed
`SETUP_TOKEN`; the suite runs serially and in order: `00-setup` drives the first-run wizard,
later files assume an owner exists. Mailpit's API (`:8025`) is the mailbox for sign-in codes
and the wizard's test email. Every wizard step and the admin shell are checked with
`@axe-core/playwright` (WCAG 2.2 AA).

CI runs this on `main` and on pull requests labelled `e2e` (`.github/workflows/ci.yml`).
Traces and screenshots of failures land in `test-results/`.

The package deliberately has **no workspace imports**, so that it exercises the built image
the way a stranger's browser would — anything it needs (TOTP, a DoH-JSON endpoint, a cookie
jar) is re-derived locally rather than imported from `@fundroom/*`.

## Custom domains — a second stack

`tests/10-custom-domains.test.ts` is **not** part of the default run. It needs
`TENANCY_MODE=multi` (nothing else lets a Host header that is not the canonical one resolve a
workspace) and a certificate authority, and `00-setup` asserts the install is single-tenant —
so it gets its own stack, `deploy/compose/compose.acme.yaml` layered on the CI one, and
creates its own owner over the API.

```sh
export E2E_APP_PORT=3100 E2E_MAILPIT_PORT=8125
export E2E_BASE_URL=http://localhost:3100 E2E_MAILPIT_URL=http://localhost:8125
pnpm --filter @fundroom/e2e stack:up:acme
pnpm --filter @fundroom/e2e test:acme
pnpm --filter @fundroom/e2e stack:down:acme     # -v: the run needs a fresh, un-set-up install
```

The overlay adds a local **Pebble** ACME CA, **pebble-challtestsrv** as the fake authoritative
zone, a ~90-line **DoH-JSON shim** in front of it (the app verifies over `DOH_ENDPOINTS` in
the Cloudflare/Google JSON flavour; challtestsrv speaks plain DNS), and **Caddy** with the
shipped `deploy/caddy/Caddyfile` unmodified, `ACME_CA` pointed at Pebble and Pebble's root
trusted through `SSL_CERT_FILE`. See `e2e/acme/README.md` for why each piece is shaped the way
it is.

What the test proves that the integration suite cannot: `ask` refuses issuance for an
unverified hostname and allows it on `dns_ok`; the edge then obtains a real certificate over
RFC 8555 during the first TLS handshake; that certificate chains to this stack's CA and names
the customer's hostname (verified in Node against Pebble's root, with the identity check
pinned to the hostname — not `ignoreHTTPSErrors`); the page it serves names the right
workspace; being served is what promotes the row to `active`; and the hostname then reports as
the workspace's `primaryHost`.

Extra host ports, all overridable: `E2E_CADDY_HTTPS_PORT` (8443) for the edge,
`E2E_CHALLTESTSRV_PORT` (8055) to publish the customer's DNS, `E2E_PEBBLE_MGMT_PORT` (15000)
to fetch the CA's issuing root. Caddy's port 80 is not published — the ACME challenge is
fetched over the Compose network.

## Embedded in someone else's website — a third stack

`tests/20-embed-hosts.test.ts` is **not** part of the default run either. The portal has to have an
origin that host pages are genuinely *cross-site* to, so the stack sets `BASE_URL=https://portal.test`
and puts an edge in front of the app — and `00-setup` drives a wizard on `http://localhost:3000`.
So it gets its own stack, `deploy/compose/compose.hosts.yaml` layered on the CI one, and creates
its own owner and investors over the API.

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

The overlay adds **nginx** serving `e2e/hosts/` — the customer's website in five shapes, including
a strict-CSP page running a hostile tag manager — and **Caddy** terminating TLS for `portal.test`,
`host-a.test`, `host-b.test` and `host-c.test` from its internal CA, plus `insecure-host.test` over
plain http. The browser resolves those names with `--host-resolver-rules` (Chromium) or
`network.dns.localDomains` (Firefox); nothing touches `/etc/hosts`. See `e2e/hosts/README.md` for
why each piece is shaped the way it is, and for the two product defects the harness found.

What the test proves that the unit and integration suites cannot: a sign-in **inside the frame** on
`host-a.test` reaches gated content, and the cookie it sets is `Secure; HttpOnly; SameSite=None;
Partitioned` with a partition key of `https://host-a.test`; that session does **not** exist on
`host-b.test`; taking `host-b.test` off the allow-list makes the *browser* refuse the frame
(`frame-ancestors`), not a page that says no; a hostile script on an allow-listed page gets no
cookie, no API response and no frame DOM; the frame grows to its content without scrolling
internally; `?sh=` restores a deep link and follows the visitor; a double-iframed page renders when
every ancestor is listed; an `http:` page gets the link and never a frame; and axe, in a real
browser, finds nothing inside the frame.

Extra host ports, both overridable: `E2E_HOSTS_HTTPS_PORT` (443) and `E2E_HOSTS_HTTP_PORT` (80).
They default to the real ones because the URLs the browser opens carry no port — Firefox's resolver
override can map a name but not a port, so the Firefox project drops out if you change them.

## Path mounts — a fourth stack

`tests/50-path-mount.test.ts` is **not** part of the default run. The portal runs under
`BASE_PATH=/investors` at `https://portal.test/investors`, and five customer websites serve it
under a path of their own through the recipes the docs publish — nginx and a Cloudflare Worker (in
real `workerd`) at `/investors`, Caddy at `/portal` (the replace shape), a Next.js app's rewrites,
and the WordPress plugin's proxy mode — so it gets its own stack,
`deploy/compose/compose.pathmount.yaml` layered on the CI one, and creates its own owner over the
API.

```sh
export E2E_APP_PORT=3300 E2E_MAILPIT_PORT=8325
export E2E_BASE_URL=http://localhost:3300 E2E_MAILPIT_URL=http://localhost:8325
pnpm --filter @fundroom/e2e stack:up:pathmount
pnpm --filter @fundroom/e2e test:pathmount          # Chromium
pnpm --filter @fundroom/e2e stack:down:pathmount    # -v, removes the workerd and Next.js images, prunes
```

One `describe` per host, so a failure names the recipe. For each: the host's own page, both root
forms of the mount (the document's config, asset URLs), an email-code sign-in *through the mount*,
a lazy route whose chunks must load from `<mount>/assets/`, a deep-link reload, the session cookie
(`__Secure-sid; Path=<prefix>` on the host's origin, nothing on the portal's), what the recipe
forwards to the portal (the Worker and WordPress drop the host's cookies; nginx, Caddy and Next.js
cannot and the docs say so), and a sign-out POST that CSRF must accept. Once, on the Caddy mount:
the owner steps up and sends an invitation through the mount, and its link is `BASE_URL`'s.
`e2e/pathmount/README.md` explains the topology, the recipe files and the deviations.

Extra host port, overridable: `E2E_PATHMOUNT_HTTPS_PORT` (443) for the edge.
