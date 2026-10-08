# FundRoom

[![CI](https://github.com/fundroomhq/fundroom/actions/workflows/ci.yml/badge.svg)](https://github.com/fundroomhq/fundroom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

FundRoom is a self-hostable investor portal for early-stage companies raising private rounds. It
gives a company one gated place for its data room, investor updates, KPIs and round, with access
control down to the folder and document, an audit trail for every decision, and compliance
defaults for private offerings. It runs as a standalone site, on a subdomain or custom domain,
embedded in an existing website (WordPress, Webflow, Framer, Squarespace, Next.js and others), or
under a path of the company's own site through its reverse proxy.

## Features

- **Data room**: folder tree with index numbering, virus-scanned uploads, a secure in-browser
  viewer with per-viewer watermarks, watermarked downloads, Q&A on documents and folders.
- **Investor updates**: block editor, templates, per-audience sends with delivery tracking,
  private reply threads.
- **KPIs**: metric definitions with restatements, charts in the portal and in updates, optional
  sources from QuickBooks, Xero and Stripe.
- **Round**: terms as append-only revisions, an interest form, commitments, accreditation for
  Rule 506(c), e-signature and a closing workflow, plus a lightweight CRM.
- **Access control**: groups, grants and gates (NDA click-wrap, accreditation), share links with
  policies, delegates, access requests with an approval queue, periodic access review.
- **Identity**: email codes, passkeys, TOTP, optional passwords, generic OIDC, and per-workspace
  staff SSO (OIDC or SAML) with SCIM provisioning.
- **Evidence**: per-workspace hash-chained audit log, signed exports, optional external anchoring
  (RFC 3161, Sigstore Rekor), DSAR export and erasure, data residency per deployment.
- **Embeddable**: a small loader for an iframe embed, a WordPress plugin and recipes for common
  site builders and proxies.
- **Integrations**: REST API with API keys and an OpenAPI 3.1 contract, a typed SDK, signed
  outbound webhooks, and opt-in AI assist on a model you choose.

## Quick start (Docker Compose)

Requirements: Docker with Compose v2, a domain name pointing at the host, and an SMTP relay.

```sh
cd deploy/compose
cp .env.example .env          # set FUNDROOM_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, SMTP_URL, MAIL_FROM
docker compose up -d          # db -> migrate -> app -> caddy (automatic TLS)
docker compose logs app | grep -A5 "first-run setup"   # the one-time setup token
```

Open `https://<your domain>/setup`, enter the token, create the owner account and follow the
wizard. If `FUNDROOM_SECRET_KEY` is unset, the first start generates one into the `/data` volume
and says so in the logs: back it up. `docker compose run --rm app setup-token` prints the token
again.

The image's entrypoint is the `fundroom` CLI (`serve`, `migrate`, `doctor`, `setup-token`, and
operator commands; `help` lists them). Optional Compose profiles add a separate `worker`, object
storage (`objstore`), virus scanning (`av`), document conversion (`convert`), search, nightly
backups (`backup`), OpenFGA (`openfga`) and a local model for AI assist (`ai`).
`compose.s3.yaml` switches storage to an external bucket and `compose.backup.yaml` adds
pgBackRest point-in-time recovery.

The full install, upgrade and rollback procedure, including verifying image signatures, is in
[docs/runbooks/install-and-upgrade.md](docs/runbooks/install-and-upgrade.md).

## Other deployment targets

- **Kubernetes**: Helm chart in [deploy/helm/fundroom](deploy/helm/fundroom/README.md), published
  as a signed OCI chart.
- **Fly.io**: [deploy/fly](deploy/fly/README.md)
- **Render**: [deploy/render](deploy/render/README.md)
- **Railway**: [deploy/railway](deploy/railway/README.md)
- **Coolify**: [deploy/coolify](deploy/coolify/README.md)

The PaaS templates are generated from one environment catalogue (`pnpm gen:deploy`).

## Configuration

Every setting is an environment variable. [.env.example](.env.example) is the complete reference,
with defaults and comments; [deploy/compose/.env.example](deploy/compose/.env.example) is the
short list a Compose install needs. `fundroom doctor` validates the environment and prints the
resolved configuration with secrets redacted. Secrets can be supplied as files (`*_FILE`) or
encrypted with SOPS ([deploy/sops](deploy/sops/README.md)).

## Documentation

- [Operator runbooks](docs/runbooks/README.md): install and upgrade, backup and restore, key
  rotation, custom domains and certificates, queues, virus scanning, SSO, incidents, and more.
- [Embedding](docs/embed/README.md): the loader, theming, CSP, and recipes per site builder and
  reverse proxy, including [path mounts](docs/embed/path-mount.md).
- [REST API](docs/api/README.md), [webhooks](docs/api/webhooks.md) and
  [Zapier / Make](docs/api/zapier-make.md).
- [Staff SSO and SCIM](docs/sso/README.md), [e-signature](docs/esign/README.md),
  [accreditation vendors](docs/accreditation/README.md), [integrations](docs/integrations/README.md).
- [Authorization matrix](docs/authz-matrix.md), [accessibility](docs/accessibility.md),
  [SOC 2 evidence map](docs/compliance/soc2-evidence.md).
- [WordPress plugin](plugins/wordpress/README.md).

## Development

Requirements: Node 24 (`.nvmrc`; `mise install` sets up Node and pnpm), pnpm 10 (via Corepack
from `package.json`), and Docker for integration tests and the local stack.

```sh
pnpm install                       # also installs the git hooks
pnpm lint                          # Biome, dependency rules, SQL hygiene, i18n checks
pnpm typecheck                     # codegen + tsc across project references
pnpm test                          # unit and jsdom test projects
pnpm test:integration              # integration tests (needs Docker)
pnpm build                         # Turborepo build
pnpm storybook                     # design system (packages/ui)
pnpm --filter @fundroom/web dev    # SPA on :5173, proxying /api to a server on :3000
```

`deploy/compose/compose.dev.yaml` runs Postgres, Mailpit and a local-CA Caddy for
`https://*.fundroom.localhost` next to `pnpm dev`. The repository is a pnpm workspace: `apps/`
(server and web app), `packages/` (kernel libraries and adapters), `modules/` (feature modules),
`plugins/wordpress/`, `deploy/`, `e2e/` (Playwright) and `load/` (k6).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Every commit must be
signed off under the [Developer Certificate of Origin](DCO) (`git commit -s`).

## License

[MIT](LICENSE). The WordPress plugin in `plugins/wordpress/` is licensed GPLv2 or later.
