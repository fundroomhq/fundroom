# @fundroom/queue-pgboss

## 1.0.0-rc.0

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the audit, events and jobs kernel. `@fundroom/db` gains migration `0002_audit_events`: the `audit` schema (`event` partitioned monthly with a per-workspace SHA-256 hash chain assigned by a `SECURITY DEFINER` trigger under an advisory lock, `chain_head`, `checkpoint`, `anchor`, all append-only), `core.idempotency_key`, `outbox.dispatched`, `audit.ensure_partitions()` / `expired_partitions()` / `drop_partition()` / `verify_chain()` / `export_rows()`, plus `PLATFORM_WORKSPACE_ID`, `platformContext()` and `listActiveWorkspaceIds()`. `@fundroom/ports` adds `JobQueuePort`, `JobDefinition`, `AuditSinkPort`. `@fundroom/domain` starts with the Zod-typed domain event catalogue. `@fundroom/events` implements the transactional outbox writer, the relay (one job per subscriber, transactional enqueue, poison-row isolation), the worker-side dispatcher, idempotency keys and job registration. `@fundroom/queue-pgboss` implements `JobQueuePort` over pg-boss 12 with a shared dead-letter queue. `@fundroom/audit` implements the recorder, diff redaction, IP truncation, HMAC-signed daily checkpoints, partition maintenance, in-database and offline chain verification and the `fundroom-audit verify` CLI. `@fundroom/identity` now records audit rows and publishes outbox events for logins, failed logins, revocations, credential changes, invites and memberships, and exports `createIdentityJobs`. `@fundroom/config` gains `AUDIT_RETENTION_MONTHS`, `AUDIT_IP_TRUNCATE`, `OUTBOX_POLL_INTERVAL_MS`, `JOBS_POLL_INTERVAL_MS`.

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

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - The pg-boss app-role grants no longer race at start-up, and a failed start exits instead of hanging. `@fundroom/queue-pgboss` runs its GRANT / ALTER DEFAULT PRIVILEGES batch as one transaction behind pg-boss's install and `create-queue` advisory locks with a 30 s `lock_timeout` (new `grantLockTimeoutMs` option, per lock; `grantLockTimeoutWithin` fits both waits inside a pool's client-side bound, which the server wires from `DATABASE_STATEMENT_TIMEOUT_MS`; a timeout fails the start naming the lock), plus a bounded retry of "tuple concurrently updated" and the `pg_default_acl` unique violation for replicas without the lock; `start()` stops pg-boss again (bounded to 5 s) if its own start or anything after it fails. `@fundroom/server`'s `startServer` releases whatever it had started when any start step throws (the listener, the queue, the container's pools, the OTel SDK; within one overall `SHUTDOWN_TIMEOUT_MS` budget; with a slice kept for the OTel SDK), and the container's `stop()` is now safe and complete after a partial start (relay, queue, every outbound agent, kernel and wiring, the pools; once, one failing step does not skip the rest), and a listener bind error (EADDRINUSE) now rejects the start instead of escaping as an uncaught exception, so `fundroom serve` exits 1 and the platform restarts it.

- [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b) Thanks [@fundroomio](https://github.com/fundroomio)! - Add the integrations hub.
  
  **Connections.** `/admin/integrations` lists every integration a workspace can use. A workspace holds at most one live connection per provider. Credentials are sealed per workspace and never shown again. Each connection reports its health (active, degraded, reconnect needed) with the last success and the last problem. QuickBooks Online, Xero and Slack connect over OAuth 2.0, using client credentials the operator registers once per deployment. The member who started a connection must confirm it from their own session before it is saved. Stripe connects with a restricted key (`rk_…`); secret keys are refused.
  
  **KPI sources.** Monthly revenue, expenses, net income and cash come from QuickBooks or Xero. Gross volume, net volume, new customers, MRR and active subscriptions come from Stripe. A monthly metric is bound to one source series under **KPI sources**. A nightly sync backfills 24 months and then keeps the last 3 current. A synced value never silently replaces one typed by hand: it is flagged for review.
  
  **Slack app.** Notification channels can post through the connected Slack app to a channel picked from a list, alongside the existing incoming-webhook channels. Staff are alerted when a connection stops working.
  
  **Booking.** The investor portal shows "Book time" links (Calendly or Cal.com) to the audiences you choose. Bookings made through a connected account are recorded and logged as meetings on the CRM contact.
  
  **Cap table.** New optional module `captable`. It imports read-only snapshots from our CSV template or from a Carta or Pulley export, and shows a fully diluted summary by class, the option pool and SAFEs/notes outstanding. Investors see a "Your holdings" card with their own lines under a disclaimer; published snapshots are immutable.
  
  **Configuration.** New: `INTEGRATIONS_QUICKBOOKS_CLIENT_ID`/`_SECRET`/`_ENVIRONMENT`, `INTEGRATIONS_XERO_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_SLACK_CLIENT_ID`/`_SECRET`, `INTEGRATIONS_ALLOW_PRIVATE_HOSTS`. Migrations: core `0020_integrations`, metrics `0005_kpi_source_kinds` and `0006_kpi_bindings`, notify `0011_slack_app_channels`, crm `0002_activity`, captable `0001_captable`. Operator guide in `docs/integrations/`.
  
  **Fix.** Job workers no longer run more concurrent slots per queue than the database pool has connections (`DATABASE_POOL_MAX`), so a small pool is no longer starved by pollers ahead of requests.
- Updated dependencies [[`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b), [`538f8b3`](https://github.com/fundroomhq/fundroom/commit/538f8b3b40aafd77196e2c0d6ba66bb8ebe3ad5b)]:
  - @fundroom/ports@1.0.0-rc.0
