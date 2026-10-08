# @fundroom/server

The server: Hono API, composition root, request pipeline, health/telemetry, and the `fundroom`
CLI.

```
fundroom serve                       run ROLES (api,web,worker); waits for the DB, MIGRATE_ON_START applies migrations first
fundroom migrate [--dry-run]         kernel + module migrations, then exit
fundroom doctor                      validate the environment, print the resolved config (secrets redacted)
fundroom setup-token                 print the first-run setup token while setup is required
fundroom seed-demo [--slug s] [--name n] [--owner e] [--investors n] [--seed n] [--reset] [--yes]
fundroom openapi [--out f] [--check] write packages/sdk/openapi.json (or fail when it is stale)
fundroom audit verify|checkpoint     wraps @fundroom/audit for the product CLI
```

`serve` and `migrate` are the container's entrypoints (`deploy/docker/Dockerfile`): before
loading config they resolve the master key from `DATA_DIR` (`ensureSecretKey`: generate once
into `secret.key`, reuse afterwards, never when a key variable is set), then wait up to
`DATABASE_WAIT_TIMEOUT_MS` for Postgres. `dist/instrumentation.js` is the `--import` preload
that registers pg/undici OpenTelemetry instrumentation when `OTEL_EXPORTER_OTLP_ENDPOINT` is
set; `dist/healthcheck.js` is the image's `HEALTHCHECK`.

## First-run setup (`src/setup/`, `src/routes/setup.ts`)

Setup is required while no live workspace exists (`createSetupGate`, cached 15 s, invalidated
by the wizard). While it is, every SPA page carries `setupRequired: true`, `serve` prints the
setup token banner to stderr, and `/api/v1/setup/*` is the only privileged surface:

| Route | Guard | Does |
|---|---|---|
| `GET /setup/status` | none | `required`, tenancy, drivers, `tokenSource`, probe state, and `progress: { owner, mail, storage, branding, offering }` — computed from the facts, never stored: the wizard resumes at the first flag still false (kernel facts only, so this route never reads a module's tables) |
| `POST /setup/token/verify` | token, 10/15 min per address | pre-flight for the UI; `conflict` after setup |
| `POST /setup/owner` | token | workspace + `staff/owner` membership + level-1 session (cookie); rolls the workspace back if the owner fails; retires the token |
| `POST /setup/probes/mail` | session, staff owner/admin | sends the `notification` template to the owner (or `to`), primes `/readyz` |
| `POST /setup/probes/storage` | session, staff owner/admin | put → get → delete of `setup/probe-<uuid>.txt`, primes `/readyz` |

Token sources in order: `SETUP_TOKEN`, `<DATA_DIR>/setup-token` (0600, emptied on completion),
generated in memory (logs only). `seed-demo` (`src/demo/`) provisions a synthetic workspace
through the same identity helpers (`provisionUser`, `provisionMembership`) with reserved-domain
addresses only.

## Access management (`src/routes/access.ts`, `src/middleware/authz.ts`)

`/api/v1/access/*`: people (list, detail, role/profile/expiry, revoke, groups),
invitations (create in bulk, resend, revoke), CSV dry-run + import job, groups and members,
grants, policy gates, `resources/{kind}/{id}/who` and `/explain`, workspace access settings,
`/access/my`. Every operation carries `x-requires` and mounts `requirePermission(p)` (signed in
→ live staff member → session strong enough for the role and the workspace's MFA setting →
role holds `p` per `packages/authz/matrix/authz-matrix.yaml`; `+fresh` adds the 10-minute
step-up) or `requireMember()`. External kinds hitting a staff route get 404; staff without the
permission get 403. `authz-matrix.test.ts` fails when an operation and the matrix disagree;
`access.integration.test.ts` covers the flows and the cross-tenant replay fuzz. The `access`
manifest in `src/modules.ts` is `required` (cannot be disabled) and carries the admin nav slots.

## Branding and module enablement (`src/routes/branding.ts`, `src/routes/kernel.ts`)

`/api/v1/branding/*`: read the brand with the `--sh-*` tokens and the contrast report
derived from it, `PATCH` the small stored brand (only the brand is settable — the tokens come
back read-only, so a workspace cannot post a palette that makes its own portal unreadable),
upload a logo, import one from the company website, delete it. `GET /branding/logo` and
`GET /branding/theme` are **public** by design: the logo is what an update email's `<img src>`
points at and a mail client carries no session, and the sign-in page themes itself before anyone
has signed in. The mutations carry `x-requires: branding.manage` and the read `branding.read`;
the website import runs the page fetch *and every candidate URL it finds* through the
SSRF-guarded outbound client, and `checkLogo` decides the content type from the bytes because the
stored value is echoed as a response header on a public route. The `branding` manifest in
`src/modules.ts` is `required` for the third time and the same reason as `access` and `compliance`: every fact it owns lives on `core.workspace`.

`GET /modules/enablement` and `PATCH /modules/{id}` back the wizard's checklist and
`/admin/modules`. Both are `owner-or-admin` rather than a new permission — turning the data room
off is a decision about the shape of the whole workspace, not a capability within a module — and
a change that would leave the workspace inconsistent is a 409: a `required` module, one another
enabled module `dependsOn`, or one whose own dependency is off.

## Request pipeline (`src/app.ts`)

1. `X-Request-Id` (client value when well-formed, else UUID) → access log line → metrics → spans.
2. **Tenant resolution** (`src/tenancy.ts`): classify by host and path into a route tree
   (`api`, `embed`, `admin`, `app`, `ops`) and a workspace slug; one indexed lookup; unknown
   hosts (multi mode) and slugs are 404 before any session work. Single mode routes every
   request to the sole workspace and accepts any host (the proxy owns routing); multi mode
   accepts `<slug>.<canonical host>`, `/w/<slug>/…` and `/embed/<slug>/…`, and the canonical
   host itself as the workspace-less host origin.
3. **Security headers** by tree (`@fundroom/http` profiles; `frame-ancestors` from
   `container.embedOrigins()`, the embed seam).
4. Ops routes answer here: `/healthz`, `/readyz`, `/metrics`, `/.well-known/fundroom.json`
   (also at the pre-rename `/.well-known/seed-host.json`, same handler, until the next minor
   release), `/csp-report`.
5. **Session → membership → tenant context** (`src/middleware/auth.ts`): cookie recipe from the
   tree (`__Host-sid`, partitioned on embed, `__Secure-sid` on a base path), one host read
   fenced to the acting user for the membership, then `c.get("tenant")` for `withTenant()`.
   CSRF check on every cookie-backed mutation.
6. `/api/v1`: CORS exact-match allow-list, 1 MiB JSON body limit, kernel routes, module routes
   behind the enablement guard, error envelope on everything (`src/middleware/errors.ts`).
7. `web` role (`src/web.ts`): the built SPA from `WEB_DIST_PATH`, or a placeholder page when it
   is unset. See "Serving the web app" below.

## Serving the web app (`src/web.ts`)

`apps/web` is built once by Vite with `html.cspNonce: "__CSP_NONCE__"` and `base: "/"`. The
server reads `index.html` from `WEB_DIST_PATH` at startup (a set path without an `index.html`
is a startup error) and renders it per request on the `app`, `admin` and `embed` trees
(GET/HEAD; `api` and `ops` never get HTML):

- every `__CSP_NONCE__` becomes the request's CSP nonce, so `script-src 'nonce-…'
  'strict-dynamic'` holds without `'unsafe-inline'`;
- under `BASE_PATH`, root-relative `src="/…"` / `href="/…"` attributes get the prefix
  (protocol-relative and already-prefixed URLs are left alone);
- a `<meta name="seed-host:config" content="…">` tag (HTML-escaped JSON) is inserted before
  `</head>`. The SPA boots from it instead of guessing the deployment mode:

  | field | meaning |
  |---|---|
  | `v` | `1` |
  | `instanceName`, `serverVersion`, `tenancy` | as configured |
  | `basePath` | `BASE_PATH` (`""` or `/x`) |
  | `routerBase` | `basePath` + `""` / `/w/<slug>` / `/embed/<slug>` — the client router's base |
  | `apiBase` | prefix in front of `/api/v1` for this page: `basePath`, or `basePath/w/<slug>` when the workspace is named by the path (`/w/<slug>` pages, and `/embed/<slug>` on the canonical host in multi mode, whose own host resolves no workspace) |
  | `tree` | `app` / `admin` / `embed` |
  | `workspace` | `{ slug, name }` or `null` (host-level page, or single mode before setup) |
  | `branding` | name, tagline, logo URL and the derived `--sh-*` tokens for **both** palettes, from the already-resolved workspace row, so it costs no extra query and the SPA themes `<html>` on its first paint instead of waiting for `GET /branding` — no flash of unbranded content; `null` without a workspace |
  | `canonicalOrigin` | absolute portal root for the workspace ("open in a new tab" from an embed) |
  | `embedOrigins` | host origins allowed to frame this page (embed tree only) |
  | `auth` | `{ methods, passkeyRpId }`, the same values as the capability doc |
  | `setupRequired` | single mode with no workspace yet |

Caching: the document is `private, no-store`; `assets/*` (content-hashed) are
`public, max-age=31536000, immutable`; other files copied from `public/` (`favicon.svg`) are
`public, max-age=3600`. A missing asset is a plain 404, never the index. `/api/<other>` stays a
JSON 404. Page routes on unknown hosts or slugs 404 before any of this runs (tenant resolution).

## Container (`src/container.ts`)

Adapters from config, no DI framework: database + workspace resolver, local KMS + envelope
service, `storage-fs`/`storage-s3`, SMTP (or the log mailer in dev/test without `SMTP_URL`)
wrapped by the templated mailer, SSRF-guarded fetch (also handed to HIBP and OIDC discovery),
Postgres rate limiter, audit service (with `audit.recorded` publishing when sinks are
configured), identity service, the authz service (`@fundroom/authz`: matrix, evaluator,
`effective_access` rebuild subscriber + hourly reconcile), pg-boss queue, outbox relay, job
definitions from every kernel package plus modules. `start()` opens the queue, ensures queues, registers handlers on `worker`
nodes and starts the relay on `api` nodes; `stop()` drains in reverse.

## Observability

pino JSON on stdout with redaction (`src/logger.ts`); every kernel `log(event, fields)` hook is a
pino child, level inferred from the event name. OpenTelemetry (`src/telemetry.ts`): metrics
always (Prometheus text at `/metrics`, optional `METRICS_TOKEN`), traces and OTLP metrics when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. `/readyz` checks database, migrations current, storage,
mail (slow probes cached 60 s), queue; 503 while draining.

## Tests

Unit: classification, logger redaction, error mapping, CORS, request id, readiness, ops routes,
index templating (`web.test.ts`: nonce, base-path rewriting, config meta escaping, `WebConfig`
derivations per mode/tree). Integration (Testcontainers Postgres): full boot in single and
multi mode, OTP login through HTTP, cookies, `/me`, CSRF, rate limits, module enablement,
audit sink fan-out, CSP nonce, the templated SPA (config meta, asset caching, 404s, header
profiles per tree, `/w/<slug>` and `/embed/<slug>` bases), a real listener with graceful stop.
