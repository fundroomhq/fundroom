# @fundroom/custom-domains

## 0.1.0-rc.0

### Minor Changes

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Custom domains. A workspace can serve its portal from the customer's own hostname, with a certificate obtained on the first request and no configuration reload anywhere.
  
  New `@fundroom/custom-domains`: hostname normalisation and refusal (IDNA to punycode, every IPv4 spelling, wildcards, reserved zones, bare public suffixes, and the install's own canonical host and its subdomains — a hostname that normalised differently on write than on lookup would be a tenant-resolution bypass), the reproducible challenge token (`base32(HMAC-SHA256(HKDF subkey, "<workspaceId>:<hostname>"))`, compared in constant time), the derived DNS instructions, the `pending → dns_ok → active` state machine with `failed`, the verdict function, the `CustomDomainRepo`, the admin service, the host-context lookup cache and the two jobs. `@fundroom/ports` gains `DnsResolverPort` and `CustomDomainProviderPort`; new adapters `@fundroom/dns-doh` (DoH JSON over the SSRF-guarded fetch to two resolvers addressed by IP, deduped by host, a positive verdict requiring two distinct resolvers to agree, answer records dropped outside the query's bailiwick), `@fundroom/domain-caddy-ask` (the default; `activate` is a no-op because the `ask` endpoint *is* the mechanism) and `@fundroom/domain-manual` (verify only — the operator terminates TLS, so control is proven by the TXT record alone).
  
  `@fundroom/db` migration `core/0007_custom_domains`: `core.custom_domain` with a host-admitting tenant fence (the `ask` endpoint and the classifier read it before any tenant context exists), a partial unique claim index so verification is exclusive per hostname while `pending` rows are not — a global unique index would let a squatter block a rival with one form submission — a third index holding one verified hostname per workspace, and `ResolvedWorkspace.primaryHost`. `@fundroom/server`: `/api/v1/domains/*` behind a `required` `domains` manifest (`domains.read`/`domains.manage`, mutations step-up), the `ask` endpoint answering from an indexed lookup with its ceiling on cache misses rather than on requests, the custom-host branch in tenant resolution (`classifyRequest` stays synchronous and pure; the lookup lives in the middleware that was already async), `apiCors`'s workspace-origins hook, a passkey ceremony that refuses cleanly on a custom domain, and the two jobs. `@fundroom/web`: the `/admin/domains` screen and the wizard's domain step. `@fundroom/module-updates` now verifies its DKIM sending domain through the injected DoH resolver instead of `node:dns` and a module-global test seam, and a transport failure no longer unverifies an already-verified domain (which silently stopped outgoing mail being signed). `workspaceUrl` takes the workspace rather than its slug, so a verified hostname becomes the origin in email links and `canonicalOrigin`.
  
  Also: the Compose edge refuses `/internal/*` publicly, gains an `ACME_CA` knob for a local Pebble CA without collapsing the ZeroSSL fallback, and no longer fails to start when `ACME_EMAIL` is unset — an unquoted empty placeholder was a Caddyfile parse error, now pinned by a `caddy validate` step in CI. `doctor` gained a warning channel and warns that a non-empty `BASE_PATH` moves the `ask` route out from under the proxy's hard-coded URL. First entry in `docs/runbooks/`.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Per-tenant data residency. A cell is now a complete deployment in one region, with its own database, bucket, job queue, backups and key ring, and a workspace's region is the region of its cell. Without `DIRECTORY_DATABASE_URL` nothing changes for an existing install, except that `data_region` is filled in, the residency page exists and the DPA's data-location annex fills in.
  
  - **Declared region.** `DATA_REGION`, `DATA_REGION_LABEL`, `DATA_REGION_JURISDICTION` and `BACKUP_LOCATION` say where the cell is. Boot adopts them into the cell rows and refuses (prod and staging) a local cell in another region. Core migration `0024_data_residency` enforces one database = one region, derives `workspace.data_region` from the cell, and adds the `relocation` hold. `fundroom cell add` takes `--label` and `--jurisdiction`.
  - **Directory.** `@fundroom/directory` at `DIRECTORY_DATABASE_URL` (needs `CONTROL_PLANE=on`, a declared region, S3 storage and a verified TLS connection in production, or `DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS`) holds cells, slugs, verified hostnames and moves, and no personal data. Slugs and custom hostnames are unique across every cell. A request for a workspace on another cell answers `421 wrong_cell` with `X-Fundroom-Cell`, and a soft-deleted workspace is held but never routed. `fundroom directory status|sync|migrate`. A directory outage never stops a cell from booting or serving its own tenants; only new slug claims answer 503 `directory_unavailable`.
  - **Moves between regions.** `fundroom workspace move <slug> --to <cell-id>`, or the operator console's "Move to another cell", holds the workspace under `relocation`, exports it signed and encrypted, has the target pull and verify it against the source cell's published key, imports it with its holds, plan and subscription, switches the directory from the source under its row lock, and crypto-shreds the source after `MOVE_SOURCE_RETENTION_HOURS`. The workspace is unavailable during the move, and members sign in again afterwards: sessions, factors, API keys, webhooks and vendor connections are not carried. `fundroom move list|cancel`; audit actions `workspace.move_*`.
  - **Residency page.** `GET /api/v1/residency` and Settings → Data residency show the declared region, where each component is (database, jobs, search, analytics, files, backups, email, virus scanning, telemetry), and every sub-processor of the deployment and of the workspace, flagged when outside the region. Staff can read it during a move.
  - **Generated sub-processor list.** Mail, storage and Cloudflare for SaaS adapters declare sub-processor metadata, and every vendor adapter declares a jurisdiction. The `dpa`, `sub-processors` and `privacy-notice` templates (version 2) are filled from them, with a new `{{dataLocation}}` annex and `{{workspaceSubProcessors}}` in the privacy notice. Transfer mechanisms are stated only where the software knows them.
  - **Signup.** `GET /api/v1/signup/regions` feeds a region picker that links to another region's signup page.
  
  Also fixed: the setup wizard, demo seed and workspace import placed new workspaces on the `default` cell whatever `CELL_ID` said. Inbound and outbound trace spans no longer export full URLs: share-link and invite tokens, OAuth codes, presigned links and webhook paths are reduced to the origin. The Helm chart's worker scratch volume was a fixed 64 MiB, which evicted the worker on any larger export; it is now `dataScratchSizeLimit` (default 4 GiB).
  
  Compose and Helm (`residency.*` values) pass every new key through with empty defaults. Docs: runbook `residency.md`; the Cells section of `control-plane.md`; backups per region in `backup-and-restore.md`.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - The identifiers now carry the FundRoom name too, step 2 of the rename. An
  existing install upgrades without changes and keeps working; `docs/runbooks/install-and-upgrade.md`
  ("Renamed identifiers") lists what to rename and when.
  
  Renamed, with the old name still read:
  
  - `SEEDHOST_SECRET_KEY` (+ `_FILE`) is `FUNDROOM_SECRET_KEY` (+ `_FILE`). The old name is read when
    the new one is unset, and `doctor` and boot warn; it will be removed in a later release. **Upgrade
    the image first, rename after:** an older image reads only the old name and, finding only
    `FUNDROOM_SECRET_KEY`, generates a new key. So both names set to the **same** value (file contents
    for `_FILE`, trailing newlines stripped) are accepted, with a warning that the old name can go once
    no older image runs. Different values are a configuration error. It names every variable set with
    the key fingerprint `doctor` prints (`sha256:<12 hex>` of the key bytes), says that on an upgraded
    install the OLD name normally holds the data's key, and asks you to match the fingerprints before
    deleting anything. For one minor release the Helm chart's Secrets and the Coolify stacks set both
    names from one value. The Render Blueprint keeps generating `SEEDHOST_SECRET_KEY`, because Render
    generates one random value per name. Helm accepts an `existingSecret` that still holds the old key.
  - Compose also reads `SEEDHOST_DOMAIN` / `SEEDHOST_IMAGE` when `FUNDROOM_DOMAIN` / `FUNDROOM_IMAGE`
    are unset. The shipped Caddyfile honours `SEEDHOST_DOMAIN` / `SEEDHOST_BASE_PATH` as well (its
    `/internal/*` and `/metrics` refusals cover both prefixes) and refuses to start with both base-path
    names set.
  - The CLI is `fundroom` (package CLIs `fundroom-audit`, `fundroom-db`). `seedhost`, `seedhost-audit`
    and `seedhost-db` still work for one more minor release and print a note on stderr.
  
  Accepted indefinitely (values other systems hold):
  
  - Custom-domain TXT `_seedhost-challenge` beside the new `_fundroom-challenge`, and SSO TXT
    `_seedhost-sso` / `seedhost-sso=` beside `_fundroom-sso` / `fundroom-sso=`. The new label is looked
    up first; the verdict names the label that matched; instructions show only the new one.
  - API keys `shk_…` and SCIM tokens `shs_…`. New ones are minted as `frk_…` / `frs_…`; migration
    `0027_fundroom_identifiers` widens the API-key prefix check, and the `.gitleaks.toml` rules
    (`fundroom-api-key`, new `fundroom-scim-token`) match both.
  - DocuSeal's `X-Seedhost-Signature` beside `X-Fundroom-Signature`. Every one of the two that is
    present must match the secret.
  
  Sent under both names until the next minor release, then the old one is removed:
  `X-Seedhost-Cell` (with `X-Fundroom-Cell` on `421 wrong_cell`), `X-Seedhost-Export-Truncated` (with
  `X-Fundroom-Export-Truncated` on the Q&A CSV export; deprecated in OpenAPI), and
  `/.well-known/seed-host.json` (with `/.well-known/fundroom.json`).
  
  Changed with no alias:
  
  - Prometheus/OTel metrics `seed_host_*` / `seedhost_*` are `fundroom_*`
    (`fundroom_security_events_total`, `fundroom_csp_violations_total`, `fundroom_authz_*`), and the
    meter scopes `seed-host.{http,authz,security,csp}` are `fundroom.{http,authz,security,csp}`.
  - The `OTEL_SERVICE_NAME` default, the log `service` fallback and pg-boss's `application_name` are
    `fundroom`.
  - User-Agents `FundRoom-Webhooks/1` (was `SeedHost-Webhooks/1`) and `fundroom-authz-engine/1` (was
    `seed-host-authz-engine/1`).
  - Stripe meter event names are settings, `BILLING_METER_SEATS_EVENT` and
    `BILLING_METER_STORAGE_EVENT`, defaulting to `fundroom_staff_seats` / `fundroom_storage_gb` (were
    the fixed `seedhost_*` names).
    The usage report logs `billing.usage_meter_unknown` (warn) when a subscription bills on a meter
    whose event name is neither setting.
  - The npm scope is `@fundroom/*`, and the SDK exports `FundRoomClient`, `createFundRoomClient`,
    `FundRoomApiError`, `FundRoomSchemas` and the other former `SeedHost*` names.
  - The PDF `Producer` of generated clickwrap and e-sign documents is `FundRoom clickwrap` /
    `FundRoom esign`. Not evidence: the PDF digest is not what the audit trail relies on.
  - The Stripe Checkout idempotency-key prefix is `fundroom:checkout:` (was `seedhost:checkout:`).
    The keys are per-attempt random UUIDs, so at most a Checkout retried across the upgrade gets a
    fresh key.
  - The design-token source file is `packages/ui/tokens/fundroom.tokens.json` (was
    `seed-host.tokens.json`). The package export `@fundroomhq/ui/tokens.json` is unchanged.
  
  Operator actions: after the new image runs everywhere, set `FUNDROOM_SECRET_KEY` to the same value
  as `SEEDHOST_SECRET_KEY`, and remove the old name only when no older image can run again (on
  Render, leave the Blueprint's `SEEDHOST_SECRET_KEY` alone); rename `SEEDHOST_DOMAIN` / `SEEDHOST_IMAGE` in a Compose `.env`;
  switch scripts to the `fundroom` CLI; move edge routing to `X-Fundroom-Cell` and probes to
  `/.well-known/fundroom.json` before the next minor release; update dashboards and alerts for the
  metric and scope names, and filters on the old User-Agents; on a managed host billing by meter, set
  `BILLING_METER_*_EVENT` to your existing Stripe meter names or create meters with the new ones.
  Nothing to do for TXT records, API keys, SCIM tokens or the DocuSeal header; rename those when
  convenient.
  
  Rolling back: an older image rejects `frk_` / `frs_` tokens minted after the upgrade (re-mint them),
  has only the `seedhost*` bins, and sends only the old headers and metric names.
  
  Never renamed: cryptographic labels, export format ids, database names and roles, Compose project
  names, the pgBackRest stanza, the WordPress plugin's slug, and the embed API (`SeedHost.init`).

### Patch Changes

- Updated dependencies [[`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b)]:
  - @fundroom/ports@1.0.0-rc.0
  - @fundroom/db@1.0.0-rc.0
  - @fundroom/audit@1.0.0-rc.0
