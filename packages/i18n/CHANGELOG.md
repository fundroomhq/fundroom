# @fundroom/i18n

## 0.1.0-rc.0

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

### Patch Changes

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
