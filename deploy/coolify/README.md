# FundRoom on Coolify

Two generated Docker Compose stacks for [Coolify](https://coolify.io) 4.x (from
`deploy/platforms/source.mjs`, `pnpm gen:deploy`; do not edit them by hand). Both are the
reference Compose stack reduced to what a single Coolify server needs: Postgres, a one-shot
`migrate` service, and one all-in-one `app` (API, web and the embedded worker) with a `/data`
volume (`STORAGE_DRIVER=fs`, fine on one server). They differ only in who terminates TLS.

| | `compose.coolify.yaml` | `compose.coolify-caddy.yaml` |
|---|---|---|
| Edge | Coolify's proxy (Traefik) | Caddy from this repository |
| Primary domain | your https domain on the `app` service, repeated as `BASE_URL` | `FUNDROOM_DOMAIN` you enter |
| Customer custom domains | `CUSTOM_DOMAIN_DRIVER=manual`: add each verified domain to the app in Coolify | automatic: Caddy on-demand TLS asks the app (`caddy-ask`) |
| Coolify proxy on the server | running | **stopped** (Caddy binds 80/443) |
| Source | paste the file, or Git | **Git repository** (it mounts `deploy/caddy/Caddyfile`) |

Pick Traefik unless workspaces bring their own domains in volume; the Caddy mode exists because
Traefik cannot issue certificates on demand for hostnames it has never been told about.

## Coolify's generated values

Coolify fills `SERVICE_*` variables once per stack and shares them across its services
([magic environment variables](https://coolify.io/docs/knowledge-base/docker/compose)):
`SERVICE_URL_APP_3000` makes Coolify route a domain to the app's port 3000;
`SERVICE_PASSWORD_POSTGRES` is the database password; `SERVICE_REALBASE64_SEEDHOSTKEY` is 32 random
bytes, base64-encoded — the master key; `SERVICE_HEX_32_SETUP` the first-run token. `${VAR:?}`
marks a value Coolify will not deploy without (`BASE_URL`, `MAIL_FROM` and `SMTP_URL`; in the
Caddy mode `FUNDROOM_DOMAIN` instead of `BASE_URL`).

> **The domain must be https before the first deploy.** The stack runs with `APP_ENV=prod`, which
> refuses an `http://` `BASE_URL`: `migrate` exits with status 2 and `app` never starts. Coolify's
> default for a server without an https wildcard domain is an `http://…sslip.io` URL, so the stack
> does not use Coolify's generated URL for `BASE_URL`; you enter it, and it must match the
> `https://` domain you give the `app` service.

Copy `FUNDROOM_SECRET_KEY` out of Coolify after the first deploy and store it with your backups:
the database is unreadable without it.

## Traefik mode (`compose.coolify.yaml`)

1. Project → New Resource → **Docker Compose Empty**, paste `compose.coolify.yaml` (or choose
   the Git repository with compose location `/deploy/coolify/compose.coolify.yaml`).
2. On the `app` service set the domain to your `https://` name with the container port
   (`https://portal.example.com:3000` routes to port 3000; DNS must point at the server). Under
   Environment Variables set `BASE_URL=https://portal.example.com` (same host, no port),
   `MAIL_FROM` and `SMTP_URL`.
3. Deploy. `migrate` runs and exits (`exclude_from_hc` keeps that from marking the stack
   unhealthy), then `app` starts. The setup token is `SETUP_TOKEN` in the Environment Variables.

## Caddy mode (`compose.coolify-caddy.yaml`)

1. On the server: **Servers → Proxy → Stop Proxy** (Caddy needs ports 80 and 443). Other
   resources on this server then need Caddy routes of their own — give FundRoom its own server.
2. Project → New Resource → **Public/Private Repository**, build pack **Docker Compose**, base
   directory `/`, compose location `/deploy/coolify/compose.coolify-caddy.yaml`. The `caddy`
   service bind-mounts `../caddy/Caddyfile` from the checkout, the same Caddyfile the Compose
   stack uses, so the on-demand TLS `ask` endpoint and the `/internal/*` refusal come with it.
3. Set `FUNDROOM_DOMAIN` (DNS A/AAAA to this server), `ACME_EMAIL`, `MAIL_FROM` and `SMTP_URL`;
   do not assign a Coolify domain to any service. Deploy.
4. For customer domains set `TENANCY_MODE=multi` (see `docs/runbooks/custom-domains.md`).

## Variables

<!-- BEGIN GENERATED (pnpm gen:deploy; edit deploy/platforms/source.mjs) -->
| Variable | `compose.coolify.yaml` (Traefik) | `compose.coolify-caddy.yaml` (Caddy) |
|---|---|---|
| `APP_ENV` | `prod` | `prod` |
| `BASE_URL` | `${BASE_URL:?}` | `https://${FUNDROOM_DOMAIN:?}` |
| `DATABASE_URL` | `postgres://seedhost:${SERVICE_PASSWORD_POSTGRES}@db:5432/seedhost` | `postgres://seedhost:${SERVICE_PASSWORD_POSTGRES}@db:5432/seedhost` |
| `ROLES` | `api,web,worker` | `api,web,worker` |
| `WORKER_MODE` | `embedded` | `embedded` |
| `MIGRATE_ON_START` | `false` | `false` |
| `TRUST_PROXY` | `true` | `true` |
| `TENANCY_MODE` | `single` | `single` |
| `CUSTOM_DOMAIN_DRIVER` | `manual` | `caddy-ask` |
| `ROBOTS` | `noindex` | `noindex` |
| `LOG_LEVEL` | `info` | `info` |
| `FUNDROOM_SECRET_KEY`, `SEEDHOST_SECRET_KEY` | `${SERVICE_REALBASE64_SEEDHOSTKEY}` | `${SERVICE_REALBASE64_SEEDHOSTKEY}` |
| `SESSION_SECRET` | `${SERVICE_PASSWORD_64_SESSION}` | `${SERVICE_PASSWORD_64_SESSION}` |
| `SETUP_TOKEN` | `${SERVICE_HEX_32_SETUP}` | `${SERVICE_HEX_32_SETUP}` |
| `METRICS_TOKEN` | `${SERVICE_PASSWORD_METRICS}` | `${SERVICE_PASSWORD_METRICS}` |
| `STORAGE_DRIVER` | `fs` | `fs` |
| `AV_ACCEPT_UNSCANNED` | `true` | `true` |
| `MAILER_DRIVER` | `smtp` | `smtp` |
| `SMTP_URL` | `${SMTP_URL:?}` | `${SMTP_URL:?}` |
| `MAIL_FROM` | `${MAIL_FROM:?}` | `${MAIL_FROM:?}` |

A `:?` value is one Coolify refuses to deploy without; the `SERVICE_…` values are generated by Coolify once per stack.

**Upgrading from a pre-FundRoom template (renamed variables):**

- `FUNDROOM_SECRET_KEY` was `SEEDHOST_SECRET_KEY`. For one minor release the stack sets both `FUNDROOM_SECRET_KEY` and `SEEDHOST_SECRET_KEY`, both fed by `SERVICE_REALBASE64_SEEDHOSTKEY` (one value), so an older image still finds its key. The magic name is kept on purpose: Coolify stores one generated value per name, so a new name would mint a new master key. Caddy mode: the domain variable is now `FUNDROOM_DOMAIN`; set it in Coolify before redeploying.
<!-- END GENERATED -->

A separate worker process, S3 storage, ClamAV and the other optional services are in the
reference Compose stack (`deploy/compose/`); on Coolify add them to a copy of the stack.
