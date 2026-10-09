# @fundroom/identity

## 1.0.0-rc.0

### Minor Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Access management. New `@fundroom/authz`: the staff RBAC matrix as data (`matrix/authz-matrix.yaml`, rendered to `docs/authz-matrix.md`), the grants + policy-gates evaluator (nearest rule wins, then subject specificity, exclude wins ties), the `core.effective_access` rebuild (outbox subscriber, lazy on stale reads, hourly reconcile) and the `AuthzPort` implementation (`permissionsFor`, `check`, `listAccessible`, `whoHasAccess`, `explain`). `@fundroom/ports` gains `AuthzPort` and its types. `@fundroom/db` migration `0004_access`: `ltree`, `core.access_grant`, `core.access_policy`, `core.effective_access(+_state)`, `core.invite_import`, `core.has_access()` for module RLS, `invite.profile`; `bumpAclVersionInTx`, `readAclVersion`, `updateWorkspaceSettings`; `ResolvedWorkspace` carries `settings` and `aclVersion`. `@fundroom/domain`: `WorkspaceSettingsSchema` (`access.requireMfaForStaff/ForExternal/inviteExpiryDays/allowDelegates`), `InviteGrantSchema`, events `acl.changed` (now with `cause`), `membership.role_changed`, `invite_import.finished`. `@fundroom/identity`: `MembershipService` (people list/detail, role changes with owner rules, group sets, the full §13.2 revocation: delegates, group rows, grants, invites, sessions, audit, outbox, `acl_version`), `GroupService`, invitations with groups/grants/profile applied on acceptance, resend, CSV dry-run + `identity.invite_import` job; new audit actions. `@fundroom/contracts` `access.*` schemas; `@fundroom/module-kit` `required` modules, `resourceKinds`, `buildBootstrap` takes `permissions`. `@fundroom/server`: `/api/v1/access/*` (people, invites, CSV, groups, grants, policies, who/explain, settings, my), `requirePermission` / `requireMember` with the per-workspace MFA rule, `x-requires` on every operation and the generated matrix test, cross-tenant replay fuzz, the `access` manifest in `COMPILED_IN_MODULES`. `@fundroom/web`: People, person detail, Groups, group detail screens, invite and CSV import dialogs, the share sheet component.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add access requests and the approval queue. Workspaces can turn on a public "Request access" form (name, email, firm, reason) that verifies the address with an emailed code and answers every stranger identically: no membership oracle, budgets that look like success, a honeypot and a queue cap. Verified requests land in a new admin Requests screen. Approving creates an ordinary invite with groups, grants and expiry; a membership that comes from a request is recorded with `source=request`, and under Rule 506(b) approval requires an attested pre-existing relationship. Denying sends a neutral notice. Outside 506(b), requests can be auto-approved by email domain. Staff with `access.manage` are alerted through notify. Unverified challenges, expired requests and retired rows are swept on a schedule, and erasure, DSAR export and workspace portability cover the new data. Migrations: core `0016_access_requests`, notify `0006_access_request_event_types`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the admin surfaces.
  
  - **Audit log.** Filterable, paginated log with chain verification. The signed export is an Ed25519-signed zip holding JSONL, CSV and checkpoints, and `fundroom audit verify-export` checks it offline. That command exits 3 when the bundle's origin is not pinned to a trusted key.
  - **Access review.** A report covering activity, gates and accreditation-window divergence. The reviewer attests to the report they saw, and its canonical JSON is stored as evidence.
  - **Sessions admin.** Admins can list and revoke a member's sessions in this workspace.
  - **View as investor.** A read-only view of the portal with a banner, audited start and end, and read-only database transactions.
  - **Danger zones.** Transfer ownership, revoke all sessions and delete workspace, each needing typed confirmation and step-up. Delete is a soft delete with a 30-day restore window (`fundroom workspace restore`) and a nightly crypto-shred purge.
  - **Data subject requests.** Access and rectification requests alongside erasure. A subject export bundle collects data through a per-module `dsar.export` hook. Identity erasure runs as the last step.
  - **Settings and operations.** Module settings pages through a new `admin.settings` slot. A jobs/dead-letter page (`fundroom jobs dlq`) and `/api/v1/ops/health` with custom-domain certificate expiry.
  - **Pool-deadlock fixes.** Removed three pool deadlocks: `legal.isErased`/`allowsPurpose` from an investor context, and two in the updates module (replies and the archive read).

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the audit, events and jobs kernel. `@fundroom/db` gains migration `0002_audit_events`: the `audit` schema (`event` partitioned monthly with a per-workspace SHA-256 hash chain assigned by a `SECURITY DEFINER` trigger under an advisory lock, `chain_head`, `checkpoint`, `anchor`, all append-only), `core.idempotency_key`, `outbox.dispatched`, `audit.ensure_partitions()` / `expired_partitions()` / `drop_partition()` / `verify_chain()` / `export_rows()`, plus `PLATFORM_WORKSPACE_ID`, `platformContext()` and `listActiveWorkspaceIds()`. `@fundroom/ports` adds `JobQueuePort`, `JobDefinition`, `AuditSinkPort`. `@fundroom/domain` starts with the Zod-typed domain event catalogue. `@fundroom/events` implements the transactional outbox writer, the relay (one job per subscriber, transactional enqueue, poison-row isolation), the worker-side dispatcher, idempotency keys and job registration. `@fundroom/queue-pgboss` implements `JobQueuePort` over pg-boss 12 with a shared dead-letter queue. `@fundroom/audit` implements the recorder, diff redaction, IP truncation, HMAC-signed daily checkpoints, partition maintenance, in-database and offline chain verification and the `fundroom-audit verify` CLI. `@fundroom/identity` now records audit rows and publishes outbox events for logins, failed logins, revocations, credential changes, invites and memberships, and exports `createIdentityJobs`. `@fundroom/config` gains `AUDIT_RETENTION_MONTHS`, `AUDIT_IP_TRUNCATE`, `OUTBOX_POLL_INTERVAL_MS`, `JOBS_POLL_INTERVAL_MS`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Branding basics and onboarding.
  
  A workspace now has a brand, and it stores a deliberately small one: an accent colour, a font choice from bundled stacks, a corner radius, a logo, a display name, a tagline, a support address and an attribution flag, all in a new `branding` block of `core.workspace.settings` (no migration, exactly as E1.6's `legal` block). Everything the portal actually renders is **derived** from that by the new dependency-free `@fundroom/branding`, and the derived `--sh-*` tokens are returned read-only. The DTCG theme document is now an output (`GET /branding/theme`, the shape E2.2 will serve at `/embed/<ws>/theme.json`), not the thing a tenant edits. A stored token map would have been unmigratable the next time the design system gained a token, and the existing value allow-list on `applyThemeTokens` stops CSS injection but does nothing to stop a workspace setting its foreground to its background.
  
  Contrast is therefore a property of the derivation rather than advice in the form. Each palette is solved separately — a colour legible on white is too dark on the near-black dark ground — and the fill and its label are solved *together*, scored on the weaker of the two ratios, because pushing a fill just far enough to clear the page background strands mid-tone reds and violets exactly where neither white nor ink reads on top. A sweep of the hue circle plus black and white confirms every input reaches WCAG AA on both pairs in both palettes. OKLCH is the working space (scaling lightness in HSL swings blues towards purple), and colours that leave sRGB are gamut-mapped by reducing chroma rather than clipping channels. **Fonts are a choice from bundled system stacks, never an upload or a CDN link** — the app CSP allows no external font origin, and that limit is recorded rather than hidden.
  
  The logo is **hosted, never hot-linked**: bytes are uploaded or pulled from the company's website through the existing SSRF-guarded `OutboundHttpPort`, stored at `ws/<workspace>/branding/<sha256>`, and served by a public cacheable route, which is also what makes them usable as an `<img src>` in email. The content type is decided by the **bytes** — `checkLogo()` sniffs PNG, JPEG and WebP headers and reads the intrinsic size from them — because the request's `Content-Type` and any filename are attacker-controlled and the sniffed value is echoed as a response header on a public route. SVG is deliberately not on the allow-list: it is a script carrier, and serving one from our own origin would hand a workspace admin stored XSS on the portal. Nothing decodes or re-encodes the image, so no image library enters the dependency tree.
  
  Per-workspace email branding is now real rather than merely possible. `createTemplatedMailer`'s brand resolver accepts a **promise** — the synchronous-only version would have forced a per-workspace lookup to read a possibly-cold cache and send the first email after every restart unbranded, a bug appearing once per deploy and never reproducing locally — and a resolver that rejects falls back to the default brand and still sends, because a branding lookup must never block a sign-in code. The workspace travels explicitly on `OutboundEmail.workspaceId` rather than being parsed out of the free-form `tags` array, and every workspace-scoped send site now stamps it; the instance-level setup mail probe deliberately does not. `EmailBrand` gained `tagline` and `showPoweredBy`, the latter dropping only the attribution line and never the support or postal lines.
  
  Branding is kernel rather than a module — every fact it owns lives on `core.workspace`, the same argument that put `access` and `compliance` there — with permissions `branding.read` / `branding.manage`, an admin Branding screen with a live preview derived in the browser from unsaved form state, and an admin Modules screen over the new `GET /modules/enablement` and `PATCH /modules/{id}`. Module enablement is `owner-or-admin` rather than a new permission: turning the data room off is not a capability within a module but a decision about the shape of the whole workspace. Both palettes are injected into the page config from the already-resolved workspace row, so a branded portal has no flash of unbranded content on first paint; in the embed tree host-posted tokens keep winning over the workspace brand, which the bridge now enforces across theme flips rather than only on first message.
  
  The setup wizard gains its remaining steps — company basics with the logo pulled from the company website, offering mode, the modules checklist, a data-room folder template, investor invites and an optional first update draft — and `seedDefaults()` from E1.6, previously exported with no caller, is finally wired, so a new workspace starts with a privacy notice and a default disclaimer. The new steps drive the **real** admin endpoints rather than privileged `/setup/*` mirrors, because a second authorisation surface for the same operations is a second place for them to disagree; the honest consequence is that changing the offering mode still requires step-up, so a founder who skipped the security step is told to finish it. Wizard progress is computed from the facts that exist — an owner, a passed probe, a brand, an offering period — not stored in a wizard-state table, the same move E1.6 made with `core.offering_period`, and it deliberately covers kernel facts only so the setup route never reads a module's tables.
  
  Three defects were found and fixed on the way through. `POST /data-room/templates/{id}/apply` assumed a root folder, which the data room creates lazily on the first `tree()` read — so applying a folder template to a data room nobody had opened, which is exactly what the wizard does, failed. `progress.branding` counted only an accent colour or a logo while the company step saves a display name and a tagline on their own, so a founder who did that was resumed back at the company step on every cold load; it now counts every nullable brand field and deliberately not the three that have non-null defaults. And the public logo route framed its body with the length recorded in settings rather than the length of the object it had just read, which would have made a settings/bucket divergence malformed rather than merely stale.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - The vocabulary, the identity half and the in-frame runtime of the iframe embed.
  
  `@fundroom/domain` gains the `embed` block of `core.workspace.settings` — exact origins, the builder-preview toggle, `trustHostIdentity`, and the registered Ed25519 handoff keys — plus the pure rules over it: `normalizeEmbedOrigin` (an `https://` origin with no path, query, fragment or credentials; `http://` on loopback only, because a `Secure; Partitioned` cookie cannot be set from a plain-http page at all), `embedFrameAncestors`, `isAllowedEmbedOrigin` and `originMatchesPattern`. A customer-entered origin may not contain a wildcard. The only wildcards in the product are six curated builder-preview origins behind one boolean, because `https://*.acme.com` reads as a convenience and means "trust every host anyone ever puts in this zone", including the stale staging box and the subdomain-takeover target — and nobody reads an allow-list entry that way while writing it. There is no embed key: `/embed/<slug>` already names the workspace, the slug is already public through `<slug>.<canonical>` and `/w/<slug>`, and a public identifier that gates nothing is either theatre or a rotation lever that breaks snippets a customer pasted into pages they no longer remember. It lives in settings rather than a table because `frame-ancestors` is resolved before the handler on every embed request and `ResolvedWorkspace` already carries `settings`, so the list costs no query and has no cache to invalidate — which also means this epic adds no migration.
  
  `@fundroom/contracts` adds the embed operations and widens `ConsentPutBody.source` to include `host_cmp`. That value has been legal in the *stored* consent enum since E1.6 and was missing only from the request, so an embed could record a host CMP's answer only by claiming the member chose it in their own settings — a false statement in a register whose entire purpose is to record who consented to what, and where. `SlugSchema` now refuses version-shaped slugs, which the embed loader's URL space reserves.
  
  `@fundroom/identity` verifies host-signed handoff assertions: compact JWS, EdDSA only, the key selected by `kid` from the workspace's registered list and only then verified — the token's own `alg` is checked, never consulted, which is how JWT verifiers get broken. `aud` must equal the workspace slug, `exp - iat` at most 60 s, `iat` within a 5-second skew allowance, `sub` a valid email, `iss` a bare https origin, and `jti` inside the charset the caller's replay claim can carry. Every key registered under a `kid` is tried, because two rows sharing one is the *normal* rotation shape and stopping at the first match failed every login until an operator noticed. `handoffWireReason` collapses `unknown_key` and `bad_signature` for the response while the precise reason still reaches the audit log: telling them apart on a public endpoint lets a prober enumerate which key ids a workspace has registered. Only the public half of a key is ever stored, so there is no secret of ours at rest and a database compromise cannot mint an assertion.
  
  `@fundroom/web` completes the in-frame runtime: `consent`, `handoff`, `logout` and `viewport` inbound, `event`, `scroll-to` and the previously-typed-but-never-posted `open-external` outbound, all tolerating unknown message types so a snippet in someone else's CMS keeps working against a newer portal. Consent is `granted = analytics && !gpc` — a host CMP can never turn measurement on over a GPC signal, and the server independently enforces the same thing so the two cannot disagree. A reusable top-level-popup helper lands with step-up as its first caller; the flows that *complete* in a popup arrive with E2.3. Plus the admin Embed screen: origins with the same validation as the server, the preview toggle with a warning naming what it costs, the derived `frame-ancestors` shown read-only, the registered keys, and a snippet generator that emits exactly what `docs/embed/quickstart.md` documents.
  
  `@fundroomhq/ui` takes `DialogContent`'s vertical offset from a `--sh-dialog-top` custom property defaulting to today's `10vmin`. Inside an embed the loader sizes the frame to its content, so the frame never scrolls and the host page does: a dialog opened by a reader 2 500 px down landed 10vmin from the top of the *document*, overlay greying out the page and focus off-screen. The property is set from the `viewport` message the loader posts; with no loader — a hand-pasted `<iframe>` — nothing changes.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the identity and session kernel. `@fundroom/db` gains migration `0001_identity`: `core."user"`, `user_identity`, `credential`, `device`, `session`, `rate_limit`, `auth_challenge`, `membership`, `group`, `group_member`, `invite`, `attestation`, with `global_fence` policies on the global tables and `withHost(fn, { userId })`. `@fundroom/ports` starts with `AuthPort`, `MailerPort`, `RateLimiterPort` and `OutboundHttpPort`. `@fundroom/identity` implements server-side sessions with per-population lifetimes, devices and new-device alerts, email OTP, magic link (POST-to-confirm + browser binding), passkeys, TOTP with recovery codes, password with HIBP, generic OIDC (PKCE), invites and the §13.2 revocation core, a Postgres sliding-window rate limiter, cookie recipes per deployment mode, and Hono middleware for sessions, CSRF and step-up. `@fundroom/config` gains `AUTH_PASSWORD_ENABLED`, `AUTH_HIBP_CHECK`, `AUTH_MAGIC_LINK_ENABLED`, `PASSKEY_RP_ID`, `PASSKEY_RP_NAME` and `OIDC_*`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Path-mount mode: the portal can be served under a path of the customer's own site — `https://acme.com/investors` — through their reverse proxy, alongside its own address, in either the "preserve" shape (the path reaches the portal unchanged) or the "replace" shape (a public `/portal` in front of an internal `/investors`).
  
  `@fundroom/config` adds `PATH_MOUNTS`, the allow-list that gates it: comma-separated `origin + prefix` URLs, at most 16, https in staging and production, single-tenant installs only. `BASE_URL` may now be one of those URLs, and a mounted install refuses `HSTS_INCLUDE_SUBDOMAINS`/`HSTS_PRELOAD` and any mount origin in `CORS_ALLOWED_ORIGINS`. `doctor` prints the mounts and warns about prefixes it cannot tell apart. `@fundroom/http` adds `matchPathMount`: a request is mounted only when its single `X-Forwarded-Prefix` names a listed prefix byte for byte, and `X-Forwarded-Host` can only choose among mounts sharing a prefix (failing closed when it does not). `securityHeaders` gains per-request `cspReportUri` and `omitHsts`. `@fundroom/identity` adds the `partitioned_path_mount` cookie mode (an embed under a base path was sending `__Host-…; Path=/`) and `isPathScopedMode`. `@fundroom/sso` builds IdP-facing URLs from `BASE_URL` itself rather than its origin plus `BASE_PATH`.
  
  `@fundroom/server` resolves a per-request public base and origin that everything presentational reads: runtime config, `index.html` asset URLs, cookie name and `Path`, relative redirects, the CSP report endpoint, the CSRF origin, logo URLs. Everything canonical — email and magic links, OIDC and SAML callbacks (including the OIDC token request's `redirect_uri`), vendor webhooks, `security.txt`, the OpenAPI `servers` entry — comes from `BASE_URL`. Private responses carry `Vary: Cookie, X-Forwarded-Prefix`. Mounted responses carry no HSTS. Passkeys are offered only on the relying party's origin. Fixed along the way: double-prefixed URLs from (`workspaceUrl` callers) and the shipped Caddy edge's `ask`, `/internal/*`, `/metrics` and health-check paths under a base path (`FUNDROOM_BASE_PATH`). `@fundroom/web` loads lazy chunks relative to the entry script, so they resolve under any prefix without a rebuild, and reloads once when a stale tab asks for a chunk that a deploy removed.
  
  Recipes for nginx, Caddy, Cloudflare Workers, Next.js and WordPress are files under `e2e/pathmount/` that the new `50-path-mount` suite runs verbatim in real servers; Vercel and Netlify are documented as untested. The WordPress plugin (versioned separately, 0.2.0) gains an opt-in proxy mode that streams the portal through PHP under one path and forwards only the portal's own cookies. Docs: `docs/embed/path-mount.md`, the recipe pages, `docs/runbooks/path-mount.md`, threat-model entries T13–T17.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Plans can now say which optional modules and features a workspace may turn on. Nothing
  changes on an install with `CONTROL_PLANE=off` or for a workspace without a plan.
  
  - `PlanLimits` gains `modules` (optional module ids) and `features` (`qa`, `api_keys`, `webhooks`,
    `integrations`, `esign`, `accreditation`, `sso`, `scim`, `forensic`, `anchoring`, `ai`,
    `access_reviews`). Left out means all; `[]` means none. No migration: plans are written with
    `limits_schema_version` 2, and version 1 rows read as "all".
  - Turning on something the plan leaves out answers `402 plan_limit` with `limit: "module"` (and `module`)
    or `limit: "feature"` (and `feature`). The answer comes only after the route's own authentication and
    authorization, so it never reveals a plan to someone the route would not serve.
  - A downgrade freezes the configuration: what is on stays on, can be maintained (re-keying a connection,
    rotating secrets and tokens, removing webhook topics, re-verifying) and can be turned off, but nothing new
    can be added or turned on. A module that is on but outside the plan becomes read-only for staff: writes
    answer 402, DELETE and the withdraw routes keep working, restoring from the trash waits for an upgrade,
    investors are unaffected and jobs keep running. New AI requests and completing an access review stop.
  - Audit anchoring and verification are unchanged: every workspace is anchored and verified whatever its
    plan. On a plan without `anchoring`, downloading a proof (`GET /audit/anchors/{checkpointId}/proof`)
    answers 402, and `GET /audit/anchors` adds `planAllows`. After an upgrade every past proof is available.
  - Settings writers (branding, legal, access, embed, and the updates, content, metrics, round and analytics
    modules) now write only their own block of the workspace settings (`updateWorkspaceSettingsBlock` in
    `@fundroom/db`), so one can no longer put back a value another just changed.
  - Operators: `GET /platform/plans` returns `entitlementCatalog`. A module that is not an optional module
    of the build is `400 validation_failed` (`reason: "unknown_module"`). `fundroom plan upsert` takes
    `--modules` and `--features` (`ids`, `all` or `none`) and keeps any list a command does not mention,
    `--limits` included; `PATCH /platform/plans/{id}` still replaces the whole object. The plan editor in
    `/platform` has Modules and Features checklists.
  - Workspace UI: "Not on your plan" and "Read-only on your plan" on the modules page and in the setup wizard,
    a read-only banner on the module's admin pages, a notice on each feature's settings page, proof downloads
    disabled on the audit page, warnings on removals that can't be redone on the plan, and the plan's modules
    and features on the Billing page. `GET /modules/enablement` adds `planAllows` and `readOnly` (`lockedReason: "plan"`), the
    bootstrap adds `modules[].readOnly` and `entitlements` (staff only), and `GET /ai/status` adds
    `planAllows`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add search, workspace export and import, accessibility and i18n coverage.
  
  - **Search.** `GET /api/v1/search` and a search box in the portal and admin headers (`/` or Ctrl/Cmd+K).
    - The index covers data-room documents and folders (with extracted PDF text), published content-page sections and sent updates.
    - Access is filtered on every query by row security plus an authz check per document. A gated document is findable by its title only; nothing in the response depends on its body.
    - Queries are lexed by Postgres's own parser, so emails, file names, decimals and hyphenated dates are found as written.
    - `fundroom search reindex` rebuilds the index, and a 10-minute sweep rebuilds it by itself after deploys and imports.
  - **Workspace export.**
    - `/admin/settings/export` (owner, step-up) and `fundroom workspace export` produce a signed, streamed zip. It holds every table as JSONL, the audit chain, and every document in plaintext.
    - Exports are stored encrypted, expire after seven days, and can be checked offline with `fundroom workspace verify-export`.
  - **Workspace import.**
    - `fundroom workspace import <file> --slug <new>` recreates the workspace with fresh ids.
    - Members are matched to existing accounts by email, and blobs are re-encrypted under the new workspace's keys. Search and access are rebuilt afterwards.
    - It refuses unsigned files unless `--allow-unverified` is given, along with malformed archives and any file that names objects or rows of another workspace.
  - **Accessibility.**
    - The data-room viewer is keyboard-complete: zoom keys, go to page, a roving toolbar, a `?` shortcut sheet and thumbnails for every page. Each page has a screen-reader text layer (`GET /data-room/documents/{id}/pages/{n}/text`).
    - A public `/accessibility` statement is served per workspace.
    - A new `a11y` CI job runs real-browser axe (WCAG 2.2 AA including contrast) on 16 key pages for every pull request.
    - The muted text colour now meets 4.5:1 everywhere.
  - **i18n.**
    - An `en-XA` pseudo-locale proves the investor UI has no hard-coded English, and `pnpm lint:i18n` enforces that for every future change.
    - The UI package has no English defaults, messages use real plurals, and emails render in the recipient's language.
    - Users choose their language in settings (`PUT /me/locale`), and admins set a workspace default (`PUT /workspace/locale`).
  - **Fixes.**
    - Database pools now log idle-connection errors instead of crashing the process.
    - Three GitHub workflows used `hashFiles` in job-level conditions, which GitHub rejects, so they never started. They are fixed, and a new actionlint check keeps them that way.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Share links and the NDA click-wrap engine. A founder can send a tracked, policy-bound link to someone who is not in the directory yet, and that person can verify an email, accept an NDA and read exactly what the link opened — with a signed certificate of what they agreed to and when.
  
  New `@fundroom/share-links`: the link row and its token (256 bits, stored only as a digest, resolved without ever being consumed), and the **admission** rules — the domain allow-list and named contacts, the rate-limited passcode, expiry, the use cap and the view cap — all pure and all collapsing every refusal a stranger can provoke into one wire answer, because a caller who could tell "revoked" from "never existed" could enumerate live links and learn that a link they were refused exists. `linkPolicyPermitted` implements the offering-mode table as a function rather than a boolean: under `506b` a link must name an audience, and an "any verified email" link is refused. New `@fundroom/clickwrap`: the certificate as a **canonical JSON document** — a fixed key set with no optional properties, declaration key order, `audit.canonical()`'s timestamp rendering, the format version inside the preimage — plus its digest and a PDF rendering of it. The JSON cites the acceptance's audit `seq` and `hash`; a `legal.certificate_issued` event then carries the JSON's sha256; the PDF prints both anchors and says it is a rendering. pdf-lib stamps dates from the wall clock and orders objects by insertion, so hashing a PDF would be hashing a clock.
  
  `@fundroom/db` migrations `core/0008_share_links` and `core/0009_link_policy_target`: `core.share_link` and `core.share_link_visit`, with **no permissive RLS policy for `external`** on the link itself — row security is row-level, so no policy could return the row while withholding `token_hash` and `passcode_hash`, and a link visitor is an external member the moment they are admitted — and own-row reads but **no external writes** on the visit, which is an authorization edge a visitor who could insert one would use to grant themselves everything the link carries. The two files are split because Postgres permits `ALTER TYPE … ADD VALUE` inside a transaction but not the use of the value it just added, and recreating the `access_policy_target_shape` CHECK with a `link` arm counts as using it. That one enum value is the epic's entire schema-vocabulary change: `policy_kind` is untouched, because four of the seven link policies turned out to be admission controls rather than gates.
  
  `@fundroom/authz`: `link` subjects are real — `Principal` carries the links a membership was admitted through, `subjectsOf` emits them, and `PrincipalRepo` walks `core.share_link_visit` so link grants materialise into `core.effective_access` with **no change to `AuthzPort`**. The `nda` gate now stores `{documentId}` and the policy repository resolves the current `<slug>:v<n>` stamp when it loads the gate, which fixes a latent bug — the gate matched `nda:<version>` while acceptances wrote `<slug>:v<n>`, so an accepted NDA settled its gate only if the document's slug was literally `nda`, and the pinned version went stale on publish — and makes re-acceptance on version change a property of the model: publishing already bumps `acl_version`, the stamp moves, and prior acceptors go pending with nothing rewritten.
  
  `@fundroom/identity`: eligibility gains a third source so a link visitor can receive an OTP at all, reachable only from the token-scoped `/links/{token}` routes and never from the generic OTP start — otherwise possession of a link **id**, which is not a secret, would buy eligibility and bypass the passcode. The OTP challenge is bound to its link through `auth_challenge.binding_hash`, because passcode transitivity holds per link and a code minted by a passcode-free link could otherwise be spent at a protected one. `@fundroom/compliance`: the certificate seam, acceptance evidence gaining an optional typed name, accreditation self-certification writing **two** attestation rows (agreement to a text, which never expires, and accreditation as of a date, which expires in twelve months and carries its categories as data), and the acceptance register's keyset pagination pushed into the repository with CSV and JSON export — the CSV quoted per RFC 4180 *and* guarded against a leading `=` so a tenant-controlled slug cannot execute in a spreadsheet.
  
  Also: the data room's weekly storage reconciler no longer deletes other epics' objects. It swept the whole `ws/<workspace>/` prefix and removed anything the key parser merely *recognised* and its own tables did not know — so every workspace logo has been deleted on the first weekly run more than a day after upload since E1.7 shipped, and click-wrap certificates would have followed. Recognising a key is not owning it, so the test is now an ownership allow-list and an unknown key area is left alone. `pendingFor` no longer makes one query per gating document on the bootstrap's hot path.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add staff single sign-on and SCIM provisioning: one OIDC or SAML connection per workspace with verified domains, just-in-time staff accounts, workspace-bound SSO sessions and optional enforcement with owner break-glass, plus a SCIM 2.0 endpoint that provisions staff memberships and maps IdP groups to roles.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the storage, email, KMS and HTTP kernel adapters. `@fundroom/ports` gains `ObjectStoragePort` (with `assertObjectKey`, `StorageError`), `KmsPort` (`KmsError`), `MailDeliveryEvent` and a richer `MailerPort` (`driver`, `send → SentEmail`, optional `parseWebhook`, `healthCheck`), and `OutboundHttpError`. `@fundroom/storage` holds the object key layout (`ws/<id>/blobs/<sha256>`, quarantine and rendition prefixes), upload policy constants and the port contract test suite; `@fundroom/storage-s3` (AWS SDK v3, presigned multipart, S3-compatible checksum settings) and `@fundroom/storage-fs` (atomic local files plus a tus resumable-upload server) implement it. `@fundroom/kms-local` wraps per-workspace data keys under the config key ring; `@fundroom/crypto` adds the chunked AES-256-GCM object format, the `core.workspace_key` envelope service (migration `0003_workspace_key` in `@fundroom/db`) and the `crypto.rewrap` job. `@fundroom/email-smtp` implements `MailerPort` over nodemailer; `@fundroom/mail` renders React Email templates for the identity emails and ships memory/log mailers; `@fundroom/identity` emails now name their template. `@fundroom/outbound-http` is the SSRF-guarded fetch (DNS pre-resolution, private-range deny, pinned address, redirect re-checks, timeout and size caps). `@fundroom/http` adds the security-headers middleware (per-request CSP nonce, `frame-ancestors` per profile, HSTS, COOP/CORP, Referrer-Policy, `X-Robots-Tag`). `@fundroom/config` gains `KMS_DRIVER`, `UPLOAD_MAX_BYTES`, `MAIL_FROM_NAME`, `OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]`, `HSTS`, `HSTS_PRELOAD`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Close the v1.0 carry-overs. Investors can add delegates (scope: everything, data room only, or updates only) from portal settings, and admins can add or remove them from a person's page. A delegate borrows a scoped subset of its investor's access, is bound by both its investor's exclusions and its own, signs its own gates, and loses everything as soon as its investor's access ends. Sign-in now refuses a person whose every membership has expired (`membership_expired`, after the credential is proven). The last-owner floor counts only active, unexpired owners and every owner-removing path locks first. Invite grants and imported rule paths are re-derived from the resource, so a folder move or an old over-broad path can no longer widen access. A daily job reminds `access.manage` holders about overdue access reviews. Trusted Types is enforced by default (`CSP_TRUSTED_TYPES`), the HIBP check's failure mode is configurable and audited (`AUTH_HIBP_FAIL_MODE`), web source maps are no longer served, module raw routes run the kernel guards, and a behavioural authz sweep checks every route against the matrix. Fixes the post-sign-in "no access" screen caused by a stale bootstrap cache. Migrations: core `0017_delegates`; notify `0007`, `0008`; round `0003`; metrics `0004`; content `0003`; updates `0003`.

### Patch Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add accreditation vendor adapters: per-workspace VerifyInvestor.com and Parallel Markets connections, vendor-decided 506(c) verifications with stored certificates, and a verification lifecycle (polling, expiry, reminders, renewal).

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add API keys and outbound webhooks.
  
  **API keys.** Owners and admins mint scoped `frk_` keys under `/admin/api-keys`. Each key acts as its creator, capped by its scopes, and only on routes whose matrix row is `apiKey: true`; 27 routes accept keys so far. Every other route answers 401 `api_key_not_allowed`. Tokens are stored as sha256 hashes. Rotation has a 0–168 h grace window. Each key is limited to 600 requests a minute, and a workspace can hold at most 50 live keys. Keys record when they were last used, and their creator's departure or erasure revokes them. Audit rows written with a key carry `meta.apiKeyId`. The SDK takes an `apiKey` option.
  
  **Outbound webhooks.** Webhooks are managed under `/admin/webhooks` and cover 17 manifest-declared topics. Deliveries follow the Standard Webhooks format: bodies carry ids only, and session and user ids are stripped. Each delivery is fanned out from the outbox and retried ten times over about 47 h. Failed deliveries can be redelivered from a delivery log. An endpoint is disabled after a 410 or 20 exhausted deliveries.
  
  **Webhook privacy and verification.** Person-level topics are gated by analytics consent, and consent, erasure and subscription are re-checked at every attempt. Signing secrets can be rotated with an overlap window. The SDK exports `verifyWebhook`.
  
  **Configuration and supporting changes.**
  - New config: `WEBHOOK_ALLOW_PRIVATE_HOSTS`.
  - `@fundroom/outbound-http` gains `oversizeResponse: "truncate"`.
  - Erasure now locks the member's key rows before the audit chain.
  - Migration: core `0018_api_keys_webhooks`.
  - Developer docs are in `docs/api/`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Deploy & first run: distroless multi-arch image (`deploy/docker/Dockerfile`) with `serve`/`migrate` entrypoints, generated master key and setup token in `DATA_DIR`, database wait, pg/undici OTel preload and a Node `HEALTHCHECK`; Compose reference stack with profiles, S3 override, dev stack (Mailpit, local-CA Caddy for `*.fundroom.localhost`) and CI stack; Caddyfile with on-demand TLS `ask` (`/internal/tls/ask`); `/api/v1/setup/*` (status, token verify, owner bootstrap, mail + storage probes) and the `/setup` wizard in the SPA; `fundroom setup-token` and `fundroom seed-demo` with deterministic synthetic factories; `@fundroom/e2e` Playwright + axe suite against the CI stack; new config keys `DATA_DIR`, `SETUP_TOKEN`, `DATABASE_WAIT_TIMEOUT_MS`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add e-signature, the round closing workflow and signed-document vaulting.
  
  **E-signature.** A workspace connects one vendor under `/admin/esign`: Documenso or DocuSeal (cloud or self-hosted), DocuSign or Dropbox Sign, reached over their APIs only. Credentials are sealed per workspace, verified with the vendor before they are stored, and never shown again. Vendor callbacks arrive at `/webhooks/esign/{connectionId}`. They are authenticated per vendor and treated only as a wake-up: the server then asks the vendor for the envelope's status. A five-minute sweep backs them up. Signed PDFs (and the vendor's certificate where separate) are size-capped, scanned and stored encrypted.
  
  **E-sign NDA.** A legal document's ceremony can be click-wrap (default) or e-signature (NDA documents only). Investors record ESIGN consent to electronic records, sign in the vendor's UI (opened top-level, never inside an embed frame), and the completed envelope writes the same acceptance a click-wrap does, so the portal gate and NDA gates on folders and documents open as before.
  
  **Closing workflow.** A round's Closing tab sends subscription documents from a vendor template, prefilled from the round's terms, and tracks each commitment through documents sent, signed, wired and confirmed, with a summary of counts and amounts. Investors see their own checklist and download their signed copy.
  
  **Vaulting.** Completed envelopes are filed into the data room under legal hold, in staff-only folders that no investor, delegate or share-link grant can open.
  
  **Fixes found along the way.**
  - An NDA or accreditation gate on a sub-folder or document now applies to members granted an ancestor folder (it previously did not).
  - The workspace row is now always locked before the audit chain, removing a class of deadlocks between settings, acceptance, group and document writers.
  - The first concurrent use of a new encryption-key purpose no longer fails with an aborted transaction.
  
  **Configuration.** New: `ESIGN_DRIVERS`, `ESIGN_ALLOW_PRIVATE_HOSTS`, `ESIGN_MAX_ARTIFACT_BYTES`. Migrations: core `0019_esign`, round `0004_closing`, data-room `0004_vault` and `0005_staff_only`, notify `0010_esign_event_types`. Operator guide in `docs/esign/`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Central authentication carries a minimum level. `GET /auth/central/start` accepts `level=2`, and a re-authentication keeps the workspace session's current level as the minimum. `authorize` answers a step-up with `reason=level` when the canonical session is below the minimum, after the membership and SSO decisions and before the freshness check. `finish` still never raises a level. Passkey registration that the authenticator reports as user-verified raises the session to level 2, as TOTP enrolment does: the cookie is reissued and `auth.step_up` is audited with method `passkey_registration`. The response adds `authLevel` (`PasskeyRegistered`), and the SPA skips its second passkey ceremony when it is 2. The canonical step-up screen enrols a first factor in place instead of dead-ending, and tells the user when a key cannot confirm them. The investor KPIs page moves from `/metrics` to `/kpis`, so a reload or bookmark on a workspace host no longer reaches the ops Prometheus endpoint, which keeps `/metrics` on every host. In-app `/metrics` links redirect to `/kpis`. A guard test keeps module nav targets out of the ops tree.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - The product is now called **FundRoom**, step 1 of the rename: what people
  see. `INSTANCE_NAME` and `PASSKEY_RP_NAME` default to `FundRoom`; emails, the setup banner, the
  "Powered by" line, SDK and embed error messages, export and audit-bundle READMEs and docs say
  FundRoom; the mail default accent is the app primary `#1d4ed8` (was `#1f4b99`); a new interim mark
  ships as `favicon.svg`, PNG icons and `site.webmanifest`; outbound `User-Agent` is
  `FundRoom/<version>`. The image is `ghcr.io/fundroomhq/fundroom` and the Helm chart is
  `deploy/helm/fundroom` (`oci://ghcr.io/fundroomhq/charts/fundroom`; its selector labels change, so
  reinstall a release made from a local checkout of the old chart). PaaS templates name their
  services `fundroom*`, dev hosts are `*.fundroom.localhost`, the security contact is
  `security@fundroom.com` and the update index defaults to `https://releases.fundroom.com/index.json`.
  The WordPress plugin is displayed as FundRoom; its slug and text domain stay `seed-host`.
  Identifiers (`@seed-host/*`, the `seedhost` CLI, `SEEDHOST_*`, `_seedhost-challenge`, headers,
  meters, metrics) are renamed with aliases in the next step. Cryptographic labels and export format
  ids never change.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - KPIs. New module package `@fundroom/module-metrics` (`metrics` schema: definitions with unit, aggregation, direction, period granularity, decimals, an optional formula and a per-metric audience; append-only `point` rows where a correction supersedes rather than edits, with a deferred GiST exclusion keeping one live value per period and a trigger refusing every other kind of update; `source` recording provenance; CSV imports and one Google Sheets connection per workspace). `/api/v1/metrics/*`: the definition catalogue, the period grid with its no-op rule, per-cell revision history, the investor series read, a two-step CSV import with an admin-chosen column mapping, the Sheets connection and an on-demand sync, module settings, and a public chart image addressed by a capability token. Jobs `metrics.import` and the nightly `metrics.sheets_sync`; derived metrics recomputed through the outbox on `metric.points_changed`, where a division by zero or a missing input produces no point rather than a zero. Metrics is the first module in the product that is **off by default**, so its routes answer 404 where it has not been enabled.
  
  New `@fundroom/charts` — chart geometry as a list of drawing operations with no DOM, no palette and no renderer, replayed as React SVG in the browser and through pdf-lib into PDFium on the server, so the chart in an investor's inbox and the chart on the page cannot disagree. New `DocumentRenderPort.renderVector` and its `VectorOp` vocabulary implement the second half in `@fundroom/render-pdfium`. New `@fundroom/csv`, the RFC-4180-ish parser extracted from the invite importer now that a second surface needs it, with its first real test suite. New `@fundroom/sheets-google` behind a `SpreadsheetPort`, service-account only, reached through a new narrowly-scoped `ModuleServices.spreadsheets` rather than a general outbound fetch; `SPREADSHEET_DRIVER` selects it or a `noop`.
  
  Investor updates now carry their KPIs: `metric_grid` blocks are hydrated per audience in the send path through the block-hydrator registry, rendered as a chart image plus the same figures in text in both parts of the mail, and the image URL names an audience rather than a person, so it cannot become the tracking pixel this product does not ship. `BlockHydrationContext` gains an optional `medium` so a capability URL is minted for mail and never for a page a session already protects. Web: `/admin/metrics` (period grid, catalogue, revision history, CSV import with column mapping, Sheets connection and KPI settings), `/metrics` for investors, a real `metric_grid` block renderer replacing the placeholder, and a metric picker in the overview-page editor. Matrix permissions `metrics.read|manage|settings`; `WorkspaceSettings.metrics`; events `metric.points_changed` and `metric.restated`. Requires the `btree_gist` extension.
  
  Also fixes three defects that predate this epic and were found while building it. The in-viewer data-room watermark rendered as a grid of empty boxes in the shipped image — the runtime is distroless and has no fonts, so the SVG text path drew `.notdef` glyphs silently while development on macOS looked perfect; the image now bundles a font and a fontconfig file, and the renderer gained a probe that compares each glyph against a code point no font can have — because under a missing font every glyph is the same rectangle, so a "did anything draw?" check passes — asserted once at boot, so a fontless image refuses to start rather than quietly serving blank watermarks. `GET /api/v1/openapi.json` rebuilds the API against a throwing stub, so `modules/content` and `modules/data-room`, which captured their services unconditionally, had disclaimer and document-list hydration permanently broken by any single fetch of the contract document; `isLiveModuleServices` in `@fundroom/module-kit` guards both. And `@fundroom/identity` ignored its injected clock when reading a pending invitation, which production never saw because its clock is real.
- Updated dependencies [[`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b)]:
  - @fundroom/authz@1.0.0-rc.0
  - @fundroom/ports@1.0.0-rc.0
  - @fundroom/db@1.0.0-rc.0
  - @fundroom/domain@1.0.0-rc.0
  - @fundroom/audit@1.0.0-rc.0
  - @fundroom/events@1.0.0-rc.0
  - @fundroom/config@1.0.0-rc.0
  - @fundroom/csv@0.1.0-rc.0
  - @fundroom/i18n@0.1.0-rc.0
