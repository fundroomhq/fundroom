# @fundroom/module-updates

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Analytics and notifications, full.
  
  **Email delivery feedback.** Three ESP adapters — `@fundroom/email-resend`, `@fundroom/email-postmark` and `@fundroom/email-ses` (`MAILER_DRIVER=resend|postmark|ses`) — send over dedicated guarded HTTP clients and verify their webhooks: Svix signatures for Resend, Basic auth for Postmark, SNS message signatures for SES with the certificate URL, topic ARN and subscription URL pinned. `MailerPort` gains `stream`, `tracking`, `ref`, `capabilities`, `open`/`click` event kinds and `MailSuppressedError`. The kernel records every workspace message it sends in `core.mail_message`, accepts provider webhooks at `/webhooks/email/<driver>`, and publishes `mail.delivery_recorded` into the right workspace. Opens and clicks are published only in `engagement` mode for members whose `email_tracking` consent allows it, checked again when the webhook arrives. `classifyEngagement` flags Apple Mail Privacy Protection, link scanners and opens with no user agent as automated. A hard bounce, complaint or provider-side suppression suppresses the address for that workspace's broadcast and notification mail, never for sign-in mail. The list is stored as a keyed hash that survives key rotation and is managed at `/admin/mail`. Update sends report delivered, bounced and complained.
  
  **Engagement analytics.** Per-document page heatmaps, per-update opens and clicks (human and automated reported separately), a consented, engagement-mode hot list with a CSV export and `analytics.hot_lead` alerts, per-workspace retention including per-member rollups, and a transparency notice that names email opens, clicks and engagement scoring.
  
  **Consent and erasure.** `legal.privacyRegion` suggests a consent mode (EU opt-in, UK opt-out, US notice-only) when it is set, and never rewrites a mode an admin chose. Global Privacy Control is now stored as a refusal, so it also covers facts that arrive without a browser. `legal.legalHold` blocks erasure and retention. DSAR erasure requests (`/compliance/erasure-requests`) carry a statutory due date and complete once every module that holds personal data has erased its own rows. That includes modules that are currently disabled.
  
  **Notifications.** Daily and weekly digests in each member's own time zone, catch-up after a missed run, quiet hours that hold emails but never the in-app inbox, an inbox with paging, archiving and mark-all-read, and Slack channels through the new `@fundroom/chat-slack` adapter and `ModuleServices.chat` (`notify.manage`). Instant mail is sent by a job outside the transaction that created it, with deterministic idempotency keys, retry backoff and a terminal failed state.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Branding basics and onboarding.
  
  A workspace now has a brand, and it stores a deliberately small one: an accent colour, a font choice from bundled stacks, a corner radius, a logo, a display name, a tagline, a support address and an attribution flag, all in a new `branding` block of `core.workspace.settings` (no migration, exactly as E1.6's `legal` block). Everything the portal actually renders is **derived** from that by the new dependency-free `@fundroom/branding`, and the derived `--sh-*` tokens are returned read-only. The DTCG theme document is now an output (`GET /branding/theme`, the shape E2.2 will serve at `/embed/<ws>/theme.json`), not the thing a tenant edits. A stored token map would have been unmigratable the next time the design system gained a token, and the existing value allow-list on `applyThemeTokens` stops CSS injection but does nothing to stop a workspace setting its foreground to its background.
  
  Contrast is therefore a property of the derivation rather than advice in the form. Each palette is solved separately — a colour legible on white is too dark on the near-black dark ground — and the fill and its label are solved *together*, scored on the weaker of the two ratios, because pushing a fill just far enough to clear the page background strands mid-tone reds and violets exactly where neither white nor ink reads on top. A sweep of the hue circle plus black and white confirms every input reaches WCAG AA on both pairs in both palettes. OKLCH is the working space (scaling lightness in HSL swings blues towards purple), and colours that leave sRGB are gamut-mapped by reducing chroma rather than clipping channels. **Fonts are a choice from bundled system stacks, never an upload or a CDN link** — the app CSP allows no external font origin, and that limit is recorded rather than hidden.
  
  The logo is **hosted, never hot-linked**: bytes are uploaded or pulled from the company's website through the existing SSRF-guarded `OutboundHttpPort`, stored at `ws/<workspace>/branding/<sha256>`, and served by a public cacheable route, which is also what makes them usable as an `<img src>` in email. The content type is decided by the **bytes** — `checkLogo()` sniffs PNG, JPEG and WebP headers and reads the intrinsic size from them — because the request's `Content-Type` and any filename are attacker-controlled and the sniffed value is echoed as a response header on a public route. SVG is deliberately not on the allow-list: it is a script carrier, and serving one from our own origin would hand a workspace admin stored XSS on the portal. Nothing decodes or re-encodes the image, so no image library enters the dependency tree.
  
  Per-workspace email branding is now real rather than merely possible. `createTemplatedMailer`'s brand resolver accepts a **promise** — the synchronous-only version would have forced a per-workspace lookup to read a possibly-cold cache and send the first email after every restart unbranded, a bug appearing once per deploy and never reproducing locally — and a resolver that rejects falls back to the default brand and still sends, because a branding lookup must never block a sign-in code. The workspace travels explicitly on `OutboundEmail.workspaceId` rather than being parsed out of the free-form `tags` array, and every workspace-scoped send site now stamps it; the instance-level setup mail probe deliberately does not. `EmailBrand` gained `tagline` and `showPoweredBy`, the latter dropping only the attribution line and never the support or postal lines.
  
  Branding is kernel rather than a module — every fact it owns lives on `core.workspace`, the same argument that put `access` and `compliance` there — with permissions `branding.read` / `branding.manage`, an admin Branding screen with a live preview derived in the browser from unsaved form state, and an admin Modules screen over the new `GET /modules/enablement` and `PATCH /modules/{id}`. Module enablement is `owner-or-admin` rather than a new permission: turning the data room off is not a capability within a module but a decision about the shape of the whole workspace. Both palettes are injected into the page config from the already-resolved workspace row, so a branded portal has no flash of unbranded content on first paint; in the embed tree host-posted tokens keep winning over the workspace brand, which the bridge now enforces across theme flips rather than only on first message.
  
  The setup wizard gains its remaining steps — company basics with the logo pulled from the company website, offering mode, the modules checklist, a data-room folder template, investor invites and an optional first update draft — and `seedDefaults()` from E1.6, previously exported with no caller, is finally wired, so a new workspace starts with a privacy notice and a default disclaimer. The new steps drive the **real** admin endpoints rather than privileged `/setup/*` mirrors, because a second authorisation surface for the same operations is a second place for them to disagree; the honest consequence is that changing the offering mode still requires step-up, so a founder who skipped the security step is told to finish it. Wizard progress is computed from the facts that exist — an owner, a passed probe, a brand, an offering period — not stored in a wizard-state table, the same move E1.6 made with `core.offering_period`, and it deliberately covers kernel facts only so the setup route never reads a module's tables.
  
  Three defects were found and fixed on the way through. `POST /data-room/templates/{id}/apply` assumed a root folder, which the data room creates lazily on the first `tree()` read — so applying a folder template to a data room nobody had opened, which is exactly what the wizard does, failed. `progress.branding` counted only an accent colour or a logo while the company step saves a display name and a tagline on their own, so a founder who did that was resumed back at the company step on every cold load; it now counts every nullable brand field and deliberately not the three that have non-null defaults. And the public logo route framed its body with the length recorded in settings rather than the length of the object it had just read, which would have made a settings/bucket divergence malformed rather than merely stale.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Custom domains. A workspace can serve its portal from the customer's own hostname, with a certificate obtained on the first request and no configuration reload anywhere.
  
  New `@fundroom/custom-domains`: hostname normalisation and refusal (IDNA to punycode, every IPv4 spelling, wildcards, reserved zones, bare public suffixes, and the install's own canonical host and its subdomains — a hostname that normalised differently on write than on lookup would be a tenant-resolution bypass), the reproducible challenge token (`base32(HMAC-SHA256(HKDF subkey, "<workspaceId>:<hostname>"))`, compared in constant time), the derived DNS instructions, the `pending → dns_ok → active` state machine with `failed`, the verdict function, the `CustomDomainRepo`, the admin service, the host-context lookup cache and the two jobs. `@fundroom/ports` gains `DnsResolverPort` and `CustomDomainProviderPort`; new adapters `@fundroom/dns-doh` (DoH JSON over the SSRF-guarded fetch to two resolvers addressed by IP, deduped by host, a positive verdict requiring two distinct resolvers to agree, answer records dropped outside the query's bailiwick), `@fundroom/domain-caddy-ask` (the default; `activate` is a no-op because the `ask` endpoint *is* the mechanism) and `@fundroom/domain-manual` (verify only — the operator terminates TLS, so control is proven by the TXT record alone).
  
  `@fundroom/db` migration `core/0007_custom_domains`: `core.custom_domain` with a host-admitting tenant fence (the `ask` endpoint and the classifier read it before any tenant context exists), a partial unique claim index so verification is exclusive per hostname while `pending` rows are not — a global unique index would let a squatter block a rival with one form submission — a third index holding one verified hostname per workspace, and `ResolvedWorkspace.primaryHost`. `@fundroom/server`: `/api/v1/domains/*` behind a `required` `domains` manifest (`domains.read`/`domains.manage`, mutations step-up), the `ask` endpoint answering from an indexed lookup with its ceiling on cache misses rather than on requests, the custom-host branch in tenant resolution (`classifyRequest` stays synchronous and pure; the lookup lives in the middleware that was already async), `apiCors`'s workspace-origins hook, a passkey ceremony that refuses cleanly on a custom domain, and the two jobs. `@fundroom/web`: the `/admin/domains` screen and the wizard's domain step. `@fundroom/module-updates` now verifies its DKIM sending domain through the injected DoH resolver instead of `node:dns` and a module-global test seam, and a transport failure no longer unverifies an already-verified domain (which silently stopped outgoing mail being signed). `workspaceUrl` takes the workspace rather than its slug, so a verified hostname becomes the origin in email links and `canonicalOrigin`.
  
  Also: the Compose edge refuses `/internal/*` publicly, gains an `ACME_CA` knob for a local Pebble CA without collapsing the ZeroSSL fallback, and no longer fails to start when `ACME_EMAIL` is unset — an unquoted empty placeholder was a Caddyfile parse error, now pinned by a `caddy validate` step in CI. `doctor` gained a warning channel and warns that a non-empty `BASE_PATH` moves the `ask` route out from under the proxy's hard-coded URL. First entry in `docs/runbooks/`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Engagement analytics and staff notifications. Two new module packages. `@fundroom/module-analytics` (`analytics` schema: `view_session`, `event` RANGE-partitioned by month, the `page_open` dwell accumulator, per-viewer and per-day rollups behind a keyset cursor; `/api/v1/analytics/*`: the page-dwell heartbeat and close beacon, the investor transparency notice, the staff overview, per-document "who viewed", per-viewer page dwell, the keyset-paged per-contact timeline, mode/retention settings and DSAR erasure; jobs `analytics.flush`, `analytics.rollup` and `analytics.maintain` for partition creation and retention drops). `@fundroom/module-notify` (`notify` schema: per-member cadence preferences, member settings, the inbox and digests; `/api/v1/notify/*`; fan-out from `document.viewed`, `document.downloaded` and `update.replied` deduped on a UNIQUE hour-bucket key, instant email marked sent by compare-and-set, one daily digest per member; jobs `notify.deliver` and `notify.digest`). `modules/updates` now publishes `update.viewed` from the archive read for external readers — the topic was catalogued and consumed but never emitted. Matrix permissions `analytics.read` / `analytics.settings` (`notify.read` was already present) and ten new analytics routes. Web: `/admin/analytics` (overview, who-viewed, per-page dwell, contact timeline, settings with the `fresh` step-up, DSAR erase), `/admin/notify` (inbox and preferences), the dwell heartbeat wired into the data-room viewer, and the investor "what this workspace records" notice on the portal settings page.
  
  Privacy is in the schema rather than in a setting: no email address, IP address or User-Agent string is stored — a hashed session id, a browser family and an IP HMAC under the workspace's `analytics-ip` data key — and `analytics.mode` (`off | essential | engagement`) silences the writers. A heartbeat is accepted only when the caller's session already carries a server-recorded view of that resource, so a member cannot record dwell against — or appear in the "who viewed" list of — a document they never opened.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Investor updates. New module package `@fundroom/module-updates` (`updates` schema: posts with immutable versions, sends and per-recipient status, private reply threads, unsubscribes, per-workspace sending domain with an envelope-encrypted DKIM key; `/api/v1/updates/*`: templates (YC, minimal, board, blank), drafts with autosave and conflicts, audience + per-section rules, test send, schedule/unschedule, send now, archive-only publish, archive/restore, sends and recipients, the member archive, reply threads, the subscription switch, public one-click unsubscribe, settings, sending-domain records + DNS verification; jobs `updates.send` and `updates.dispatch`). New `@fundroom/markdown` (the shared Markdown-subset parser with HTML, text and ProseMirror round trips) used by the web renderer, the email renderer and the new TipTap editor. `OutboundEmail.from` / `dkim` on the mailer port (SMTP adapter signs), `ModuleServices.tenancy` + `workspaceUrl`, `findWorkspaceById`, `WorkspaceSettings.updates`, events `update.sent` / `update.replied`, audit actions for updates and sending domains, matrix permissions `updates.read|manage|send|settings`. Web: `/updates` archive + email preference, `/updates/<slug>` with replies, `/admin/updates` list/editor/deliveries/threads, `/admin/updates/settings`, `/unsubscribe`; the module page cache is now keyed by surface.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - KPIs. New module package `@fundroom/module-metrics` (`metrics` schema: definitions with unit, aggregation, direction, period granularity, decimals, an optional formula and a per-metric audience; append-only `point` rows where a correction supersedes rather than edits, with a deferred GiST exclusion keeping one live value per period and a trigger refusing every other kind of update; `source` recording provenance; CSV imports and one Google Sheets connection per workspace). `/api/v1/metrics/*`: the definition catalogue, the period grid with its no-op rule, per-cell revision history, the investor series read, a two-step CSV import with an admin-chosen column mapping, the Sheets connection and an on-demand sync, module settings, and a public chart image addressed by a capability token. Jobs `metrics.import` and the nightly `metrics.sheets_sync`; derived metrics recomputed through the outbox on `metric.points_changed`, where a division by zero or a missing input produces no point rather than a zero. Metrics is the first module in the product that is **off by default**, so its routes answer 404 where it has not been enabled.
  
  New `@fundroom/charts` — chart geometry as a list of drawing operations with no DOM, no palette and no renderer, replayed as React SVG in the browser and through pdf-lib into PDFium on the server, so the chart in an investor's inbox and the chart on the page cannot disagree. New `DocumentRenderPort.renderVector` and its `VectorOp` vocabulary implement the second half in `@fundroom/render-pdfium`. New `@fundroom/csv`, the RFC-4180-ish parser extracted from the invite importer now that a second surface needs it, with its first real test suite. New `@fundroom/sheets-google` behind a `SpreadsheetPort`, service-account only, reached through a new narrowly-scoped `ModuleServices.spreadsheets` rather than a general outbound fetch; `SPREADSHEET_DRIVER` selects it or a `noop`.
  
  Investor updates now carry their KPIs: `metric_grid` blocks are hydrated per audience in the send path through the block-hydrator registry, rendered as a chart image plus the same figures in text in both parts of the mail, and the image URL names an audience rather than a person, so it cannot become the tracking pixel this product does not ship. `BlockHydrationContext` gains an optional `medium` so a capability URL is minted for mail and never for a page a session already protects. Web: `/admin/metrics` (period grid, catalogue, revision history, CSV import with column mapping, Sheets connection and KPI settings), `/metrics` for investors, a real `metric_grid` block renderer replacing the placeholder, and a metric picker in the overview-page editor. Matrix permissions `metrics.read|manage|settings`; `WorkspaceSettings.metrics`; events `metric.points_changed` and `metric.restated`. Requires the `btree_gist` extension.
  
  Also fixes three defects that predate this epic and were found while building it. The in-viewer data-room watermark rendered as a grid of empty boxes in the shipped image — the runtime is distroless and has no fonts, so the SVG text path drew `.notdef` glyphs silently while development on macOS looked perfect; the image now bundles a font and a fontconfig file, and the renderer gained a probe that compares each glyph against a code point no font can have — because under a missing font every glyph is the same rectangle, so a "did anything draw?" check passes — asserted once at boot, so a fontless image refuses to start rather than quietly serving blank watermarks. `GET /api/v1/openapi.json` rebuilds the API against a throwing stub, so `modules/content` and `modules/data-room`, which captured their services unconditionally, had disclaimer and document-list hydration permanently broken by any single fetch of the contract document; `isLiveModuleServices` in `@fundroom/module-kit` guards both. And `@fundroom/identity` ignored its injected clock when reading a pending invitation, which production never saw because its clock is real.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Offering mode and legal templates.
  
  New `@fundroom/compliance`: the shipped legal-template library (12 counsel-review-headed Markdown templates compiled into the package by a committed codegen step), the offering/document/acceptance/consent/relationship services, and the `LegalServices` implementation. `@fundroom/db` migration `0006_compliance`: `core.offering_period` (append-only status history, one open row per workspace, closable but never rewritable), `core.legal_document` + `core.legal_document_version` (immutable, sha256-stamped published versions), `core.consent_event` (append-only, unbundled from notice acceptance), `core.membership.relationship_note` + `first_exposure_at`, and a **tightening of `core.attestation`'s RLS**, which shipped in E0.3 with a permissive policy that let any member of a workspace read another member's legal facts. `updateOfferingStatus` on the workspace accessors.
  
  Acceptance of a legal document is a `core.attestation` row of kind `<slug>:v<n>`, which is the shape the NDA gate already matches, so an accepted NDA settles its own gate. The gate itself is enforced in `requireMember`, not in the SPA: an external member owing a required acceptance is refused everything but the routes that let them read and accept it.
  
  `@fundroom/domain` gains the `legal` settings block (`consentMode`, `enforceAcceptance`, `relationshipWarningDays`, `defaultDisclaimerSlug`). **`analytics.mode` now defaults to `essential` rather than `engagement`** — a behaviour change for any workspace that never wrote the key, and the point of it: a tenant who has not thought about consent no longer measures page dwell by default. Together with the new consent capture this closes R13 and the risk E1.5 booked.
  
  `@fundroom/module-kit`: `LegalServices` on `ModuleServices` (resolve a disclaimer, get a snapshot stamp, read consent, ask whether a purpose is permitted) and `offeringStatusRules.disabledWhen`, which switches a module off for staff too where `hiddenWhen` only hides it from investors. `modules/content` gains a `disclaimer` block hydrated through that port and stamps `page_revision.disclaimer_version` at publish (migration `0002`); `modules/updates` fills the `post_version.disclaimer_version` column reserved for this epic, and now hydrates reference blocks for emailed updates — previously an emailed disclaimer would have carried its slug and no text. `modules/analytics` asks the kernel whether it may record dwell: `GET /analytics/notice` returns one `dwell` boolean folding the workspace mode, the consent mode, the member's stored answer and their Global Privacy Control header, and the browser obeys only that.

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
  - @fundroom/module-content@0.1.0-rc.0
  - @fundroom/crypto@1.0.0-rc.0
  - @fundroom/i18n@0.1.0-rc.0
  - @fundroom/markdown@0.1.0-rc.0
