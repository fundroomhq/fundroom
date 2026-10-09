# @fundroom/http

## 1.0.0-rc.0

### Minor Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Managed-host control plane. Everything here is inert unless `CONTROL_PLANE=on`, which requires `TENANCY_MODE=multi`. A default self-hosted install sees no change: no quotas, no suspension, and 404 from the new routes.
  
  - **Operators.** Platform operators are granted only by the CLI (`fundroom operator enrol-link|grant|revoke|list`), and only to accounts that already have a passkey or TOTP (`enrol-link` prints a one-time link that, together with the mailbox, lets a new operator enrol one). They sign in to the `/platform` console with a separate `__Host-op_sid` session, minted from a fresh passkey or authenticator proof (with a factor older than the grant) on the canonical host and optionally fenced by `PLATFORM_OPERATOR_CIDRS`. Everyone else gets a plain 404. Operators can create, suspend, unsuspend and move workspaces, manage plans, work the sanctions queue, and read the platform audit chain and queue health. They never see tenant content, and every write is audited on the tenant's chain and the platform's.
  - **Workspace status.** A workspace carries independent holds (sanctions review, operator, billing, sanctions), each lifted only by its owner, and its status is derived from them. A suspended or held workspace answers 423 to its staff and 404 to everyone else, except the owner's billing page. Its outgoing mail, updates and webhooks are deferred.
  - **Cells.** Workspaces are placed on cells (`CELL_ID`, `fundroom cell list|add|drain`); a request that reaches the wrong cell gets `421 wrong_cell` with `X-Fundroom-Cell`.
  - **Plans and usage.** Plans (`fundroom plan list|upsert`, or the console) limit staff and investor seats, storage and custom domains with `402 plan_limit`, and apply only to workspaces that have a plan. A daily `core.tenant_usage_daily` rollup gets storage and documents viewed from a new optional module `usage` hook (data room, analytics).
  - **Billing** (`BILLING_DRIVER=manual|stripe`). Stripe Checkout and the Customer Portal pin API version `2026-08-26.dahlia`, with optional metered prices per plan (`plan upsert --metered-price`) billed from daily seat and storage meter events. Signed webhooks are treated as wake-ups that re-read the subscription. Owners get a grace period (`BILLING_GRACE_DAYS`) and emails before a billing suspension. Deleted and sanctioned workspaces have their subscriptions cancelled.
  - **Sanctions screening** (`SANCTIONS_DRIVER=ofac|opensanctions`). New tenant companies are screened against the OFAC SDN and consolidated lists, matched locally with Cyrillic/Greek transliteration, or through OpenSanctions/yente (commercial data licence required; the key goes only over https to `api.opensanctions.org` or `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS`). Operators can correct a company's legal name and country, which re-screens it. Lifting a confirmed sanctions suspension needs a newer clean screening and a second operator. A new workspace is held until it clears, list changes trigger a re-screen, and potential matches wait for an operator decision. A re-screen never takes a live portal down by itself.
  - **Signup.** Optional self-service signup (`SIGNUP_MODE=open`) on the canonical host, with explicit terms acceptance (`signupTerms` in the page config) and per-IP and per-network budgets.
  
  Two parts work on any multi-tenant install, with or without the control plane:
  
  - **Central auth origin** (`CENTRAL_AUTH=on`). Custom domains and slug hosts sign in through `BASE_URL` and receive a session bound to that workspace by a one-time, verifier-bound code. Passkeys therefore work on custom domains. Account settings from such a session answer `bound_session_restricted`.
  - **Cloudflare for SaaS custom-domain driver** (`CUSTOM_DOMAIN_DRIVER=cloudflare-saas`). The domain is registered with Cloudflare only after our own DNS verification, and becomes active only when Cloudflare says so. `CLOUDFLARE_TRUSTED_PROXY=on` reads `CF-Connecting-IP` from Cloudflare's published ranges only.
  
  Also fixed: on a `<slug>.<canonical>` host, a `/w/<other>` or `/embed/<other>` path could resolve another workspace; the host's slug now wins and a different path slug is a 404. With the control plane on, `/w/<slug>` on the canonical host redirects to the slug host. `@fundroom/identity` caps concurrent sessions per population, so an operator or bound session never evicts an ordinary one.
  
  Compose passes every new key through with empty defaults (everything off). Docs: runbooks `control-plane.md`, `billing.md`, `sanctions.md`, `central-auth.md` and a Cloudflare for SaaS section in `custom-domains.md`; threat-model entries T18–T22.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Edge forwarding: an edge Worker in front of a platform that routes by `Host` and overwrites `X-Forwarded-Host` (Railway) can name the customer's hostname and the visitor's address in private headers, which the app believes only when the Worker's shared secret matches. New optional keys `FORWARDED_HOST_HEADER`, `FORWARDED_CLIENT_IP_HEADER`, `EDGE_SHARED_SECRET` and `EDGE_SHARED_SECRET_PREVIOUS` (both secrets 32–256 printable characters, redacted, `_FILE` capable); the secret travels in the fixed header `X-Fundroom-Edge`. With the keys unset nothing changes and no new header is read. When configured, a request without `X-Fundroom-Edge` is ordinary and its forwarded headers are ignored; a wrong secret answers `403 edge_unauthorized`; a matching secret without a valid forwarded host answers `400 invalid_request`; otherwise the request is served as `https://<forwarded host>` with the forwarded client IP (when it is an IP literal) and `Vary: <FORWARDED_HOST_HEADER>`. The two header names must start with `X-Fundroom-` (and may not be `X-Fundroom-Edge` or a proxy-written name); `CLIENT_IP_HEADER` may no longer start with `X-Fundroom-`; edge forwarding is refused with `PATH_MOUNTS`. Refusals are logged with the method, redacted path, a truncated client network and the reason (never a header value) and counted in `fundroom.security.events{event="edge_refused"}`. `fundroom doctor` warns when `TRUST_PROXY` is off, when `FORWARDED_CLIENT_IP_HEADER` is unset, and while a rotation (`EDGE_SHARED_SECRET_PREVIOUS`) is unfinished. After a match the secret header is removed from the request, so no handler sees it. `fundroom doctor` also warns when the two header names look swapped. `@fundroom/http` exports `edgeForwarding`, `edgeForwardedOf`, `stripEdgeSecret`, `EDGE_SECRET_HEADER` and the parsers.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - The server side of the iframe embed. A workspace decides which sites may frame its portal, the header and the document agree about that list on every request, and the loader is served by the app itself because this product self-hosts and ships no CDN.
  
  `apps/server`: a `required` `embed` manifest (`embed.read` / `embed.manage`, admin nav 25) with `GET`/`PUT /api/v1/embed/settings` — the stored block plus `frameAncestors`, `previewOriginPatterns` and the snippet URLs derived on every read, never stored, so the screen and the header cannot disagree. Mutations need step-up (as E2.1 did for custom domains: a stolen session that could add an origin would be a clickjacking primitive) and `handoffKeys` is a whole-list replace whose `addedAt` the server stamps and preserves for an unchanged (id, public key) pair. `frame-ancestors` is derived in the security-headers hook straight from the already-resolved workspace's `settings`, so the allow-list costs no query and has no cache to invalidate, and an unconfigured workspace resolves to `frame-ancestors 'self'` rather than `'none'` — the honest answer is "only we may frame it", and `'none'` also broke the admin screen's own preview.
  
  The embed document independently refuses a framing it can see is disallowed, and **only** that: a cross-site `Sec-Fetch-Site` naming an `Origin`/`Referer` that is not on the list. Absence of evidence is never a refusal — a host page with `Referrer-Policy: no-referrer` sends nothing, an older browser sends no `Sec-Fetch-*`, and a direct visit to `/embed/<slug>` is a person opening the fallback URL. A refusal serves a minimal unbranded page linking the portal's own origin and writes `embed.origin_rejected` **throttled per (workspace, origin)** through a bounded, clear-on-full cache: the audit log is hash-chained per workspace, so an unthrottled write from an anonymous request is a remote way to grow and serialise it.
  
  `POST /api/v1/embed/handoff` (public, rate-limited) exchanges a host-signed assertion for a partitioned `auth_level` 0 session: EdDSA only, the key chosen by `kid` from the registered list and never by the token's `alg`, single-use through `core.idempotency_key` rather than a fifth single-use table, and only for an email that already holds a membership. Off per workspace by default.
  
  The framed SPA now calls the API under its own prefix — `${basePath}/embed/<slug>/api/v1` — in every tenancy mode, and the classifier keeps that request in the embed context (`tree: "api"`, `embed: true`, prefix stripped from the path so the routes mount unchanged). This is what makes an embed session work at all: the cookie recipe is chosen from the classification, and a call to `/w/<slug>/api/v1` was indistinguishable from a first-party one, so every login made inside the iframe was issued a `SameSite=Lax` cookie the browser then refused to send back from a third-party frame — minted and immediately unusable. The context is derived from a URL the server mints into the page config rather than asserted by an `X-Fundroom-Embed` header, because a derived input beats a trusted one whenever both are available.
  
  Routing gains an `asset` tree for `^/embed/(v\d+|\d+\.\d+\.\d+)/<file>$`, ahead of `/embed/<slug>` and refusing version-shaped slugs so the namespace is not decided by whoever claims `v1` first. That tree selects the `asset` header profile, which `packages/http` had implemented and nothing had ever used (`CORP: cross-origin`, no CSP, handler-owned `Cache-Control`). The loader is served from `@fundroom/embed/artifacts` in memory on two channels — rolling `v1` (`max-age=3600, stale-while-revalidate=86400`) and pinned, immutable `<version>` with the SRI digest — plus the public, CORS-open `${basePath}/embed/<slug>/theme.json`, all registered ahead of the SPA catch-all, which would otherwise answer an HTML document to a `<script src>`.
  
  `packages/http` adds `publickey-credentials-get=(self)` to `Permissions-Policy` so a host that delegates the feature on the frame can offer passkeys inside it; the top-level popup stays the guaranteed path. `packages/audit` adds `embed.settings_changed`, `embed.origin_rejected`, `embed.handoff_accepted` and `embed.handoff_rejected`. The misleading note in `middleware/cors.ts` promising to add embed origins to the CORS allow-list is corrected rather than implemented: the iframe is same-origin with the API, and allow-listing the host page would hand every script on it credentialed, state-changing access — the exact threat the iframe boundary exists to prevent.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Path-mount mode: the portal can be served under a path of the customer's own site — `https://acme.com/investors` — through their reverse proxy, alongside its own address, in either the "preserve" shape (the path reaches the portal unchanged) or the "replace" shape (a public `/portal` in front of an internal `/investors`).
  
  `@fundroom/config` adds `PATH_MOUNTS`, the allow-list that gates it: comma-separated `origin + prefix` URLs, at most 16, https in staging and production, single-tenant installs only. `BASE_URL` may now be one of those URLs, and a mounted install refuses `HSTS_INCLUDE_SUBDOMAINS`/`HSTS_PRELOAD` and any mount origin in `CORS_ALLOWED_ORIGINS`. `doctor` prints the mounts and warns about prefixes it cannot tell apart. `@fundroom/http` adds `matchPathMount`: a request is mounted only when its single `X-Forwarded-Prefix` names a listed prefix byte for byte, and `X-Forwarded-Host` can only choose among mounts sharing a prefix (failing closed when it does not). `securityHeaders` gains per-request `cspReportUri` and `omitHsts`. `@fundroom/identity` adds the `partitioned_path_mount` cookie mode (an embed under a base path was sending `__Host-…; Path=/`) and `isPathScopedMode`. `@fundroom/sso` builds IdP-facing URLs from `BASE_URL` itself rather than its origin plus `BASE_PATH`.
  
  `@fundroom/server` resolves a per-request public base and origin that everything presentational reads: runtime config, `index.html` asset URLs, cookie name and `Path`, relative redirects, the CSP report endpoint, the CSRF origin, logo URLs. Everything canonical — email and magic links, OIDC and SAML callbacks (including the OIDC token request's `redirect_uri`), vendor webhooks, `security.txt`, the OpenAPI `servers` entry — comes from `BASE_URL`. Private responses carry `Vary: Cookie, X-Forwarded-Prefix`. Mounted responses carry no HSTS. Passkeys are offered only on the relying party's origin. Fixed along the way: double-prefixed URLs from (`workspaceUrl` callers) and the shipped Caddy edge's `ask`, `/internal/*`, `/metrics` and health-check paths under a base path (`FUNDROOM_BASE_PATH`). `@fundroom/web` loads lazy chunks relative to the entry script, so they resolve under any prefix without a rebuild, and reloads once when a stale tab asks for a chunk that a deploy removed.
  
  Recipes for nginx, Caddy, Cloudflare Workers, Next.js and WordPress are files under `e2e/pathmount/` that the new `50-path-mount` suite runs verbatim in real servers; Vercel and Netlify are documented as untested. The WordPress plugin (versioned separately, 0.2.0) gains an opt-in proxy mode that streams the portal through PHP under one path and forwards only the portal's own cookies. Docs: `docs/embed/path-mount.md`, the recipe pages, `docs/runbooks/path-mount.md`, threat-model entries T13–T17.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Security hardening, following an ASVS 5.0 Level 2 review and an internal penetration test.
  
  **Upgrading: production and staging now refuse to boot on settings they used to accept.** Each error names its fix, and `docs/runbooks/install-and-upgrade.md` has an "Upgrading to the security-hardening release" section.
  1. `AV_DRIVER=noop` needs `AV_ACCEPT_UNSCANNED=true`, or run ClamAV (`AV_DRIVER=clamd`).
     - Helm: set `config.av.acceptUnscanned`.
     - PaaS services created from an older template: add the variable to web and worker.
  2. SMTP to a public relay needs `smtps://…:465` or `?requireTLS=true`.
     - Refused: `tls.rejectUnauthorized` set to anything but `true`, a truthy `ignoreTLS`, a repeated option, and backslashes or spaces in the URL.
  3. A public database host needs `sslmode=verify-full` or `verify-ca`.
     - The last `sslmode` in the URL wins, and a `host=` parameter counts as the host.
     - For a private CA, add `sslrootcert=`. Helm: `postgresql.external.caSecret`.
     - `DATABASE_ACCEPT_UNVERIFIED_TLS=true` is only for a host that really is private.
  4. `METRICS_ENABLED=true` needs `METRICS_TOKEN`. Without either, `/metrics` is off in prod. Caddy now refuses `/metrics` unless `EDGE_EXPOSE_METRICS=true`.
  5. Compose requires `POSTGRES_PASSWORD`. An existing stack whose `.env` never set it was created with `seedhost`: set that, then rotate the password.
  6. `RATE_LIMIT_MULTIPLIER` (new, for k6 and ZAP runs) other than 1 is refused in prod, and whenever `APP_ENV` is not set explicitly.
  7. Client IP:
     - `TRUST_PROXY=true` now means one trusted hop counted from the right of `X-Forwarded-For`. `TRUST_PROXY_HOPS` sets more hops, and `CLIENT_IP_HEADER` names a platform header. The Fly, Render and Railway templates set one.
     - `X-Forwarded-Host` and `-Proto` take their rightmost entry.
     - Caddy trusts forwarded headers only from `EDGE_TRUSTED_PROXIES`, default loopback. Behind a CDN or load balancer, set it and `TRUST_PROXY_HOPS=2`.
  8. HSTS:
     - `includeSubDomains` can be sent without `preload` (`HSTS_INCLUDE_SUBDOMAINS`).
     - `includeSubDomains` and `preload` go only to the `BASE_URL` host and its subdomains, so customers' custom domains get plain `max-age`.
  
  **Authentication and sessions**
  - Managing a second factor needs the second factor.
    - Once a user has a TOTP or a passkey, disabling or enrolling TOTP, adding or removing a passkey, regenerating recovery codes, and setting or removing a password all need auth level 2 plus a recent sign-in.
    - A PIN-less passkey step-up in the same session also counts.
    - Every factor change signs out the user's other sessions and emails a security notice. Previously, someone holding a mailbox could replace an owner's second factor.
  - Session tokens:
    - The session token rotates on step-up and on login (the previous session is revoked, including share-link and embed logins).
    - Concurrent step-ups keep the winner's token.
  - Passwords:
    - Changing or removing an existing password needs `currentPassword`.
    - Signing out other sessions needs a recent sign-in.
  - OIDC:
    - Logins are level 1 unless the ID token's `amr`/`acr` shows MFA (`OIDC_MFA_ACR`) or `OIDC_TRUST_MFA=true`.
    - The flow is bound to the starting browser (`__Host-oidc_req`).
    - The ID-token signature is verified.
    - `returnTo` must be same-origin, inside `BASE_PATH`.
  - Sign-in answers the same for known and unknown addresses, including while mail is failing.
    - `/auth/otp/start` and `/auth/magic-link/start` no longer answer 503. Failures are logged as `auth.sign_in_mail_failed`.
    - Unknown addresses get a decoy challenge. Challenges are deleted 6 h after expiry.
  - TOTP and recovery codes:
    - The rate-limit slot is consumed before the code is checked.
    - A code cannot be used twice concurrently.
    - Recovery codes are stored as salted scrypt hashes; old codes still verify.
  - Other:
    - Magic links last 10 minutes.
    - scrypt is `N=2^16, r=8, p=2`, and old hashes are rehashed at login.
    - Logout sends `Clear-Site-Data: "cache", "storage"`.
    - Step-up, recovery-code use and regeneration, and password removal are audited.
  
  **Authorization**
  - Grant validity was never enforced: `validity` was mis-parsed, so grants with an end date never expired. They now do, fail-closed.
  - Membership `expires_at` is enforced everywhere: request middleware, permissions, `/me`, and the last-owner count. An owner membership cannot carry an expiry. Only an owner can edit another owner.
  - Access rows expire at the earliest of these dates:
    - grant end;
    - accreditation age-out;
    - attestation expiry;
    - membership expiry.
  - Sharing one data-room document no longer grants its folder. The server derives every rule's path from the resource: grants, policies, invites and share links.
    - A client path that doesn't match gets 400 `resource_path_mismatch`.
    - An unknown or foreign id gets 404 `unknown_resource`.
    - A data-room trigger and one-off repair clear over-broad document rule paths already stored.
  - `ip_allowlist`:
    - Malformed entries (`10.0.0.0/`) are ignored fail-closed and rejected by the API.
    - Entries match per address family, so `::/0` no longer admits IPv4.
  - Two owners demoting each other concurrently can no longer leave a workspace without an owner.
  
  **Browser**
  - Zero CSP violations on the key screens (sonner, input-otp, Radix Select and Dialog, TipTap and Zod no longer inject un-nonced styles or `new Function`).
  - Headers:
    - `worker-src 'none'`.
    - CORP is `same-origin` on app, admin and api, `cross-origin` on the embed loader and email chart images, and `same-site` on framed `/embed/*`.
    - Every tenant 404 now carries security headers.
  - Trusted Types stays report-only: `trusted-types default ProseMirrorClipboard`.
  - `Reporting-Endpoints` is an absolute URL.
  - `/csp-report` streams under a 16 KiB limit and accepts `application/reports+json`. Reports are normalised without queries or ids and counted in `fundroom_csp_violations_total`.
  - `/.well-known/security.txt` (`SECURITY_TXT`, `SECURITY_TXT_CONTACT`, `SECURITY_TXT_POLICY`) is served, and `/security.txt` redirects to it.
  - The SPA works on plain-http origins, where `crypto.randomUUID` is unavailable. Sign-out clears the query cache, and passkey autofill is aborted before an email-code request.
  
  **Operations**
  - `fundroom break-glass open|sql|close|list` is host-operator access past RLS (migration 0015, `seedhost_host` role).
    - It needs a ticket, lasts at most 60 minutes and stays pending until owners are mailed.
    - Statements are vetted by Postgres `PREPARE` and run in a security-definer function that cannot switch roles. They are read-only unless `--write`.
    - Each statement is audited in the tenant chain (hash) and the platform chain (text).
    - Owners are mailed on open and after every write.
    - `sql` output is `row_to_json`, and EXPLAIN and SHOW are not accepted.
  - `fundroom evidence access-reviews|operators|break-glass`, plus a monthly change-management bundle (`evidence.yml`).
  - Faults:
    - A connection reset no longer crashes the process.
    - A black-holed database no longer hangs requests. A client-side query bound follows `statement_timeout`; a timed-out COMMIT raises `ClientTimeoutError` 08007.
    - A failed `begin` no longer leaks a pool slot.
    - S3 has connect and socket timeouts.
  - Update sends retry transient mail failures for 24 h without double-sending. Recipients whose membership lapsed are skipped, and one failing mailbox no longer holds the post out of the archive.
  - `/metrics` and the access log label by route template, so token-bearing paths never appear. `/readyz` shows details only to loopback callers without `TRUST_PROXY`, or with the metrics token.
  - Anonymous `/setup/status` after setup answers only `{ required: false }`. The setup mail probe is limited to the caller's own or staff addresses, needs level 2, and allows 5 per hour.
  - Authorization denials and CSRF rejections are logged as `security.*` events and counted in `fundroom_security_events_total`.
  - Hardening:
    - AES-GCM tag length is pinned.
    - Download filenames are sanitised (RFC 6266/8187).
    - The outbound guard refuses userinfo URLs and IPv6 forms that embed IPv4 or special ranges.
  - OpenAPI `pattern`s no longer carry a leaked `/u` flag.
  
  **Tooling**
  - Toxiproxy fault tests run in the integration suite.
  - `40-csp` real-browser checks run in the a11y job.
  - Stryker on `@fundroom/authz` runs weekly (`break: 95`).
  - A ZAP baseline, passive API scans and a weekly active scan run in `zap.yml`, gated by `.zap/rules.tsv`.
  - k6 profiles live in `load/` (`load.yml`, on demand).
  - `minimumReleaseAge` is 7 days.
  - CODEOWNERS paths are corrected.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the storage, email, KMS and HTTP kernel adapters. `@fundroom/ports` gains `ObjectStoragePort` (with `assertObjectKey`, `StorageError`), `KmsPort` (`KmsError`), `MailDeliveryEvent` and a richer `MailerPort` (`driver`, `send → SentEmail`, optional `parseWebhook`, `healthCheck`), and `OutboundHttpError`. `@fundroom/storage` holds the object key layout (`ws/<id>/blobs/<sha256>`, quarantine and rendition prefixes), upload policy constants and the port contract test suite; `@fundroom/storage-s3` (AWS SDK v3, presigned multipart, S3-compatible checksum settings) and `@fundroom/storage-fs` (atomic local files plus a tus resumable-upload server) implement it. `@fundroom/kms-local` wraps per-workspace data keys under the config key ring; `@fundroom/crypto` adds the chunked AES-256-GCM object format, the `core.workspace_key` envelope service (migration `0003_workspace_key` in `@fundroom/db`) and the `crypto.rewrap` job. `@fundroom/email-smtp` implements `MailerPort` over nodemailer; `@fundroom/mail` renders React Email templates for the identity emails and ships memory/log mailers; `@fundroom/identity` emails now name their template. `@fundroom/outbound-http` is the SSRF-guarded fetch (DNS pre-resolution, private-range deny, pinned address, redirect re-checks, timeout and size caps). `@fundroom/http` adds the security-headers middleware (per-request CSP nonce, `frame-ancestors` per profile, HSTS, COOP/CORP, Referrer-Policy, `X-Robots-Tag`). `@fundroom/config` gains `KMS_DRIVER`, `UPLOAD_MAX_BYTES`, `MAIL_FROM_NAME`, `OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]`, `HSTS`, `HSTS_PRELOAD`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Close the v1.0 carry-overs. Investors can add delegates (scope: everything, data room only, or updates only) from portal settings, and admins can add or remove them from a person's page. A delegate borrows a scoped subset of its investor's access, is bound by both its investor's exclusions and its own, signs its own gates, and loses everything as soon as its investor's access ends. Sign-in now refuses a person whose every membership has expired (`membership_expired`, after the credential is proven). The last-owner floor counts only active, unexpired owners and every owner-removing path locks first. Invite grants and imported rule paths are re-derived from the resource, so a folder move or an old over-broad path can no longer widen access. A daily job reminds `access.manage` holders about overdue access reviews. Trusted Types is enforced by default (`CSP_TRUSTED_TYPES`), the HIBP check's failure mode is configurable and audited (`AUTH_HIBP_FAIL_MODE`), web source maps are no longer served, module raw routes run the kernel guards, and a behavioural authz sweep checks every route against the matrix. Fixes the post-sign-in "no access" screen caused by a stale bootstrap cache. Migrations: core `0017_delegates`; notify `0007`, `0008`; round `0003`; metrics `0004`; content `0003`; updates `0003`.

### Patch Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add accreditation vendor adapters: per-workspace VerifyInvestor.com and Parallel Markets connections, vendor-decided 506(c) verifications with stored certificates, and a verification lifecycle (polling, expiry, reminders, renewal).
