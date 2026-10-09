# @fundroom/module-metrics

## 0.1.0-rc.0

### Minor Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the admin surfaces.
  
  - **Audit log.** Filterable, paginated log with chain verification. The signed export is an Ed25519-signed zip holding JSONL, CSV and checkpoints, and `fundroom audit verify-export` checks it offline. That command exits 3 when the bundle's origin is not pinned to a trusted key.
  - **Access review.** A report covering activity, gates and accreditation-window divergence. The reviewer attests to the report they saw, and its canonical JSON is stored as evidence.
  - **Sessions admin.** Admins can list and revoke a member's sessions in this workspace.
  - **View as investor.** A read-only view of the portal with a banner, audited start and end, and read-only database transactions.
  - **Danger zones.** Transfer ownership, revoke all sessions and delete workspace, each needing typed confirmation and step-up. Delete is a soft delete with a 30-day restore window (`fundroom workspace restore`) and a nightly crypto-shred purge.
  - **Data subject requests.** Access and rectification requests alongside erasure. A subject export bundle collects data through a per-module `dsar.export` hook. Identity erasure runs as the last step.
  - **Settings and operations.** Module settings pages through a new `admin.settings` slot. A jobs/dead-letter page (`fundroom jobs dlq`) and `/api/v1/ops/health` with custom-domain certificate expiry.
  - **Pool-deadlock fixes.** Removed three pool deadlocks: `legal.isErased`/`allowsPurpose` from an investor context, and two in the updates module (replies and the archive read).

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - AI assist, opt-in. The operator configures one model provider (`AI_PROVIDER`:
  `openai-compatible` for a self-hosted Ollama, vLLM or llama.cpp server or a hosted API, or
  `anthropic`; default `none`), and each workspace turns on "Draft with AI" for investor updates and
  "Suggest an answer" for data-room Q&A after acknowledging that provider. AI only produces
  suggestions that staff apply through the normal editors; Q&A suggestions cite only pages the asker
  (and the whole folder audience) can see, with server-verified quotes. New kernel package
  `@fundroom/ai`, two adapters, core migration `0025_ai_assist`, routes under `/api/v1/ai`, per-user,
  in-flight and monthly token budgets, and `/admin/settings/ai`.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the integrations hub.
  
  **Connections.** `/admin/integrations` lists every integration a workspace can use. A workspace holds at most one live connection per provider. Credentials are sealed per workspace and never shown again. Each connection reports its health (active, degraded, reconnect needed) with the last success and the last problem. QuickBooks Online, Xero and Slack connect over OAuth 2.0, using client credentials the operator registers once per deployment. The member who started a connection must confirm it from their own session before it is saved. Stripe connects with a restricted key (`rk_…`); secret keys are refused.
  
  **KPI sources.** Monthly revenue, expenses, net income and cash come from QuickBooks or Xero. Gross volume, net volume, new customers, MRR and active subscriptions come from Stripe. A monthly metric is bound to one source series under **KPI sources**. A nightly sync backfills 24 months and then keeps the last 3 current. A synced value never silently replaces one typed by hand: it is flagged for review.
  
  **Slack app.** Notification channels can post through the connected Slack app to a channel picked from a list, alongside the existing incoming-webhook channels. Staff are alerted when a connection stops working.
  
  **Booking.** The investor portal shows "Book time" links (Calendly or Cal.com) to the audiences you choose. Bookings made through a connected account are recorded and logged as meetings on the CRM contact.
  
  **Cap table.** New optional module `captable`. It imports read-only snapshots from our CSV template or from a Carta or Pulley export, and shows a fully diluted summary by class, the option pool and SAFEs/notes outstanding. Investors see a "Your holdings" card with their own lines under a disclaimer; published snapshots are immutable.
  
  **Configuration.** New: `INTEGRATIONS_QUICKBOOKS_CLIENT_ID`/`_SECRET`/`_ENVIRONMENT`, `INTEGRATIONS_XERO_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_SLACK_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_ALLOW_PRIVATE_HOSTS`. Migrations: core `0020_integrations`, metrics `0005_kpi_source_kinds` and `0006_kpi_bindings`, notify `0011_slack_app_channels`, crm `0002_activity`, captable `0001_captable`. Operator guide in `docs/integrations/`.
  
  **Fix.** Job workers no longer run more concurrent slots per queue than the database pool has connections (`DATABASE_POOL_MAX`), so a small pool is no longer starved by pollers ahead of requests.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - KPIs. New module package `@fundroom/module-metrics` (`metrics` schema: definitions with unit, aggregation, direction, period granularity, decimals, an optional formula and a per-metric audience; append-only `point` rows where a correction supersedes rather than edits, with a deferred GiST exclusion keeping one live value per period and a trigger refusing every other kind of update; `source` recording provenance; CSV imports and one Google Sheets connection per workspace). `/api/v1/metrics/*`: the definition catalogue, the period grid with its no-op rule, per-cell revision history, the investor series read, a two-step CSV import with an admin-chosen column mapping, the Sheets connection and an on-demand sync, module settings, and a public chart image addressed by a capability token. Jobs `metrics.import` and the nightly `metrics.sheets_sync`; derived metrics recomputed through the outbox on `metric.points_changed`, where a division by zero or a missing input produces no point rather than a zero. Metrics is the first module in the product that is **off by default**, so its routes answer 404 where it has not been enabled.
  
  New `@fundroom/charts` — chart geometry as a list of drawing operations with no DOM, no palette and no renderer, replayed as React SVG in the browser and through pdf-lib into PDFium on the server, so the chart in an investor's inbox and the chart on the page cannot disagree. New `DocumentRenderPort.renderVector` and its `VectorOp` vocabulary implement the second half in `@fundroom/render-pdfium`. New `@fundroom/csv`, the RFC-4180-ish parser extracted from the invite importer now that a second surface needs it, with its first real test suite. New `@fundroom/sheets-google` behind a `SpreadsheetPort`, service-account only, reached through a new narrowly-scoped `ModuleServices.spreadsheets` rather than a general outbound fetch; `SPREADSHEET_DRIVER` selects it or a `noop`.
  
  Investor updates now carry their KPIs: `metric_grid` blocks are hydrated per audience in the send path through the block-hydrator registry, rendered as a chart image plus the same figures in text in both parts of the mail, and the image URL names an audience rather than a person, so it cannot become the tracking pixel this product does not ship. `BlockHydrationContext` gains an optional `medium` so a capability URL is minted for mail and never for a page a session already protects. Web: `/admin/metrics` (period grid, catalogue, revision history, CSV import with column mapping, Sheets connection and KPI settings), `/metrics` for investors, a real `metric_grid` block renderer replacing the placeholder, and a metric picker in the overview-page editor. Matrix permissions `metrics.read|manage|settings`; `WorkspaceSettings.metrics`; events `metric.points_changed` and `metric.restated`. Requires the `btree_gist` extension.
  
  Also fixes three defects that predate this epic and were found while building it. The in-viewer data-room watermark rendered as a grid of empty boxes in the shipped image — the runtime is distroless and has no fonts, so the SVG text path drew `.notdef` glyphs silently while development on macOS looked perfect; the image now bundles a font and a fontconfig file, and the renderer gained a probe that compares each glyph against a code point no font can have — because under a missing font every glyph is the same rectangle, so a "did anything draw?" check passes — asserted once at boot, so a fontless image refuses to start rather than quietly serving blank watermarks. `GET /api/v1/openapi.json` rebuilds the API against a throwing stub, so `modules/content` and `modules/data-room`, which captured their services unconditionally, had disclaimer and document-list hydration permanently broken by any single fetch of the contract document; `isLiveModuleServices` in `@fundroom/module-kit` guards both. And `@fundroom/identity` ignored its injected clock when reading a pending invitation, which production never saw because its clock is real.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Close the v1.0 carry-overs. Investors can add delegates (scope: everything, data room only, or updates only) from portal settings, and admins can add or remove them from a person's page. A delegate borrows a scoped subset of its investor's access, is bound by both its investor's exclusions and its own, signs its own gates, and loses everything as soon as its investor's access ends. Sign-in now refuses a person whose every membership has expired (`membership_expired`, after the credential is proven). The last-owner floor counts only active, unexpired owners and every owner-removing path locks first. Invite grants and imported rule paths are re-derived from the resource, so a folder move or an old over-broad path can no longer widen access. A daily job reminds `access.manage` holders about overdue access reviews. Trusted Types is enforced by default (`CSP_TRUSTED_TYPES`), the HIBP check's failure mode is configurable and audited (`AUTH_HIBP_FAIL_MODE`), web source maps are no longer served, module raw routes run the kernel guards, and a behavioural authz sweep checks every route against the matrix. Fixes the post-sign-in "no access" screen caused by a stale bootstrap cache. Migrations: core `0017_delegates`; notify `0007`, `0008`; round `0003`; metrics `0004`; content `0003`; updates `0003`.

### Patch Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Central authentication carries a minimum level. `GET /auth/central/start` accepts `level=2`, and a re-authentication keeps the workspace session's current level as the minimum. `authorize` answers a step-up with `reason=level` when the canonical session is below the minimum, after the membership and SSO decisions and before the freshness check. `finish` still never raises a level. Passkey registration that the authenticator reports as user-verified raises the session to level 2, as TOTP enrolment does: the cookie is reissued and `auth.step_up` is audited with method `passkey_registration`. The response adds `authLevel` (`PasskeyRegistered`), and the SPA skips its second passkey ceremony when it is 2. The canonical step-up screen enrols a first factor in place instead of dead-ending, and tells the user when a key cannot confirm them. The investor KPIs page moves from `/metrics` to `/kpis`, so a reload or bookmark on a workspace host no longer reaches the ops Prometheus endpoint, which keeps `/metrics` on every host. In-app `/metrics` links redirect to `/kpis`. A guard test keeps module nav targets out of the ops tree.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Round, interest form and CRM-lite. A workspace can describe the round it is raising — stage, instrument, target, minimum and the terms themselves as an append-only series of revisions — and an investor can read those terms, see what an amount would buy them and indicate interest, with the accreditation path decided on the server from the offering status, the subject and the amount rather than re-derived in the browser. Two new shared packages carry the parts both sides need: `@fundroom/decimal`, the fixed-point arithmetic promoted out of `modules/metrics` now that money is added in a second place, and `@fundroom/round-terms`, holding the SAFE, convertible-note and priced-round zod schemas, the ownership calculator with its plain-English explanations and assumptions, the US accreditation-path rule with the minimum-investment safe harbour, and the allocation roll-up that every progress figure in the product reads. Metrics keeps its public surface unchanged and re-exports the decimal module from the package, so there is still exactly one implementation.
  
  Accreditation stops being something a module can write for itself. `LegalServices` (`@fundroom/module-kit`) gains `accreditation`, `certifyAccreditation`, `recordVerifiedAccreditation` and `noteExposure`; `@fundroom/compliance` implements them over the existing acceptance service, so a self-certification still produces exactly the two attestation rows E2.3 froze — the click-wrap record of agreeing to a text, and the dated `accredited` fact the policy gate reads — while a staff decision records one row whose `data.method` is prefixed `verified:`, with the evidence named by reference and never copied. A verification with no evidence behind it is refused, and a workspace that has published no accreditation questionnaire gets the new `accreditation_unavailable` (409) rather than a 500 or a misleading `not_found`. `@fundroom/ports` gains `AccreditationVerificationPort` and the new `@fundroom/accred-manual` adapter answers it for `ACCREDITATION_DRIVER=manual`: every attempt stays pending until a person reads the evidence, because claiming otherwise would assert on the issuer's behalf that it took the reasonable steps Rule 506(c) requires. `ModuleServices` carries the port, with `ContainerOptions`/`StartOptions` overrides for tests. `@fundroom/domain` adds the nine `round.*` outbox topics (ids only — the amount an investor named stays on the fenced, audited row) and the `round` workspace-settings block (evidence retention, default currency). `@fundroom/module-notify` learns two instant event types, `round.interest_submitted` and `round.verification_requested`, addressed to staff holding `round.manage` rather than `notify.read` so a viewer who cannot open the round does not learn by email who wants into it; migration `0002_round_event_types` widens both CHECK constraints. `@fundroom/authz` carries the full `round.*` and `crm.*` permission and route matrix.
  
  CRM-lite ships as its own module rather than as part of `round`, and the cut is the offering rules': `round` is disabled outright in `none` and `informational`, while a CRM is exactly what a founder uses before there is anything to offer, so `@fundroom/module-crm` declares no offering rules at all and a workspace tracking relationships keeps its board with the round module switched off underneath it. It owns seven tables in a `crm` schema whose every row-security policy admits staff and system and nobody else: organisations, contacts that are not logins (an optional `membership_id` link, a generated `search_tsv`, at most one live contact per member), a tenant-editable stage ladder with stable keys seeded lazily on the first read, per-round pipeline cards whose `amount` is a forecast and whose `commitment_id` is a soft reference to the round module's system of record, polymorphic notes and tasks, and a `stage_transition` history that records every move with its cause and both stage keys. The only coupling to `round` is four outbox subscribers — interest submitted, interest decided, commitment created, commitment changed — each idempotent under redelivery, silent for a workspace that has the module switched off, and tolerant of a stage a tenant has renamed away; nothing is emitted back. Every mutation is audited with ids, keys and counts only: no email, no name, no note body.
  
  The round itself ships as `@fundroom/module-round`, off by default and **disabled outright** while the workspace's offering status is `none` or `informational` — the two states where `permits(status).roundAndTerms` is false. That gate applies to staff as well, so an `informational` workspace's owner gets the same 404 an investor does; a compliance control an admin can walk around is no control. Six tables in a `round` schema: the round, its terms as an append-only series of revisions (a trigger refuses every update but the one that supersedes, and a deferrable exclusion constraint keeps exactly one live revision per round), interest submissions carrying the offering status and accreditation path of the moment they were made, verifications, the commitments that are the system of record for the money, and a closing checklist. Row security lets an investor read an open or closed round and its terms, read and write their own submissions, read their own verifications — and reach `commitment` and `closing_task` not at all, because what another investor put in is not their business.
  
  An investor's page arrives in one read: the round, the live terms, the disclaimer that was in force when they were written, the progress bar when the workspace has chosen to show one, the member's own submissions and a preview of which accreditation path their amount would take. Viewing it stamps `first_exposure_at` the first time — under Rule 506(b) what matters is whether the relationship pre-dated the offer, so the column is written once and never overwritten — and records a `round.terms_viewed` audit row naming the revision, the disclaimer stamp and the offering status, throttled to once per session per revision so a refresh is not an audit row. Indicating interest is rate-limited to five an hour, records the questionnaire through the kernel's acceptance service rather than by touching `core.attestation`, and under Rule 506(c) below the minimum-investment safe harbour opens a verification the company has to settle before it can accept: a self-certification does not open that door, however recent, which is the difference between 506(b) and 506(c) made enforceable rather than documented. Evidence is uploaded on a raw route in front of the JSON body limit, virus-scanned, envelope-encrypted under the workspace key before a byte reaches storage, readable only by staff holding `round.manage`, and deleted by a nightly job once the decision is older than the workspace's retention window — while the decision, its method and the digest of what was read survive, which is what keeps a verification provable after somebody's tax return is gone. Opening, closing and the commitments CSV need step-up. The `round_summary` content block renders for members and staff and gives an anonymous reader an empty payload even in a public section: no offering content is reachable anonymously, and on a 506(b) page that is not a UI mistake.

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
- Updated dependencies [[`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b)]:
  - @fundroom/ports@1.0.0-rc.0
  - @fundroom/db@1.0.0-rc.0
  - @fundroom/domain@1.0.0-rc.0
  - @fundroom/identity@1.0.0-rc.0
  - @fundroom/contracts@1.0.0-rc.0
  - @fundroom/module-kit@1.0.0-rc.0
  - @fundroom/events@1.0.0-rc.0
  - @fundroom/csv@0.1.0-rc.0
  - @fundroom/crypto@1.0.0-rc.0
  - @fundroom/charts@0.1.0-rc.0
  - @fundroom/sheets-google@0.1.0-rc.0
  - @fundroom/decimal@0.1.0-rc.0
