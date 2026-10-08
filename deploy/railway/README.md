# FundRoom on Railway

Railway one-click deploys are **templates**, and a template is composed in the Railway dashboard
(Workspace → Templates → New Template), not committed as a file. This README is the template's
recipe: the three services, their settings, and every variable with the exact value to paste.
The variable tables are generated from `deploy/platforms/source.mjs` (`pnpm gen:deploy`), so
the template and the other platforms cannot drift apart on names.

## Why there is no `railway.json`

Railway's file-based Config as Code (`railway.json` / `railway.toml`) is deprecated: new services
cannot opt into it, and existing ones stop reading it on 2026-12-01. Its replacement,
Infrastructure as Code (`.railway/railway.ts`, `railway config apply`), configures one linked
project rather than a template, and is not used here yet. Everything the old file would have held
(pre-deploy command, health check, restart policy) is a service setting in the template below.

## The template

Three services. Web and worker are **Docker image** services from
`ghcr.io/fundroomhq/fundroom:<version>` — the published, signed image; Railway does not build this
repository (its Dockerfile's BuildKit cache mounts do not follow Railway's cache-id convention).
Pin a version tag rather than `latest` when you publish the template.

- **`Postgres`** — Railway's PostgreSQL database.
- **`web`** — `ROLES=api,web`. Public domain on port 3000, healthcheck path `/readyz`, pre-deploy
  command running the migrations, restart policy *On failure*.
- **`worker`** — `ROLES=worker`. No domain, no healthcheck, no pre-deploy command.

Variable references (`${{Postgres.DATABASE_URL}}`, `${{web.FUNDROOM_SECRET_KEY}}`) resolve when a
deploy starts, so the worker always sees the web service's values; each secret is generated once,
on `web`, by the template function `${{secret(length, alphabet)}}` when someone deploys the
template. The hex alphabet keeps the master key inside what the key ring accepts (64 hex digits =
32 bytes).

Commands: Railway's start and pre-deploy commands **replace** the image's ENTRYPOINT (exec form,
no shell — the image is distroless). Leave the start command empty (the image runs `serve`); the
pre-deploy command is the full `node … cli.js migrate` invocation shown below.

Object storage: web and worker are separate containers and a Railway volume attaches to one
service, so documents go to an S3-compatible bucket (`STORAGE_DRIVER=s3`) — a Railway Bucket,
Cloudflare R2, AWS S3, … — whose endpoint and keys the template user enters.

After deploying: the first-run setup token is `web`'s `SETUP_TOKEN` (Variables tab). Copy
`FUNDROOM_SECRET_KEY` somewhere outside Railway; a restored database is unreadable without it.

Custom domains: `CUSTOM_DOMAIN_DRIVER=manual`. Add each verified customer domain to `web` under
Settings → Networking (Railway issues the certificate) and change `BASE_URL` if the primary
domain moves off `*.up.railway.app`. That is the simple path for a single tenant. Railway asks
for its own TXT record per domain and caps custom domains per service (20 on Pro), so a
multi-tenant install serves customer domains through Cloudflare for SaaS and a Worker instead
(`cloudflare-saas` with edge forwarding; `docs/runbooks/custom-domains.md` "An origin
that routes by `Host`").

<!-- BEGIN GENERATED (pnpm gen:deploy; edit deploy/platforms/source.mjs) -->
**Service `web`** — source image `ghcr.io/fundroomhq/fundroom:latest`; Settings → Deploy → Pre-deploy command `/nodejs/bin/node --import /app/dist/instrumentation.js /app/dist/cli.js migrate`; healthcheck path `/readyz`; Networking → generate a domain on port 3000; no start command (the image's ENTRYPOINT + CMD run `serve`).

| Variable | Value in the template | Notes |
|---|---|---|
| `APP_ENV` | `prod` | prod: https BASE_URL, MAIL_FROM and SMTP_URL become mandatory; SMTP over TLS, a METRICS_TOKEN for /metrics, and a virus scanner or AV_ACCEPT_UNSCANNED. |
| `BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Public https URL of the portal (the platform hostname or your own domain). |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Postgres connection string (the platform's managed Postgres). |
| `ROLES` | `api,web` | api,web on the web process, worker on the worker process. |
| `WORKER_MODE` | `external` | external on the web process: a separate worker process runs the jobs. |
| `MIGRATE_ON_START` | `false` | Off: the platform's migrate step runs migrations once per deploy. |
| `TRUST_PROXY` | `true` | The platform's router terminates TLS and sets X-Forwarded-*. |
| `CLIENT_IP_HEADER` | `X-Real-IP` | Header the platform's edge sets to the client address (overwritten per request). |
| `TENANCY_MODE` | `single` | single: one workspace. multi routes workspaces by host (custom domains). |
| `CUSTOM_DOMAIN_DRIVER` | `manual` | manual: the platform issues certificates for domains you add there; the app only verifies DNS. |
| `ROBOTS` | `noindex` | noindex keeps the investor portal out of search engines. |
| `LOG_LEVEL` | `info` | trace\|debug\|info\|warn\|error. |
| `FUNDROOM_SECRET_KEY` | `${{secret(64, "abcdef0123456789")}}` | Master key (256-bit). Generated once; back it up — losing it loses every encrypted field. |
| `SESSION_SECRET` | `${{secret(64, "abcdef0123456789")}}` | Session signing secret (otherwise derived from the master key). |
| `SETUP_TOKEN` | `${{secret(32, "abcdef0123456789")}}` | First-run setup token, readable in the platform's variables screen instead of the logs. |
| `METRICS_TOKEN` | `${{secret(48, "abcdef0123456789")}}` | Bearer token for /metrics; in prod /metrics is served only when one is set. |
| `STORAGE_DRIVER` | `s3` | s3: web and worker run on separate machines and cannot share a volume. |
| `S3_BUCKET` | *(template user enters it)* e.g. `fundroom-documents` | Bucket for documents. |
| `S3_ENDPOINT` | *(template user enters it)* e.g. `https://<account>.r2.cloudflarestorage.com` | S3 API endpoint (R2, Tigris, B2, AWS: https://s3.<region>.amazonaws.com). |
| `S3_REGION` | `auto` | auto for R2/Tigris; the bucket's region on AWS. |
| `S3_ACCESS_KEY_ID` | *(template user enters it)* | Bucket access key. |
| `S3_SECRET_ACCESS_KEY` | *(template user enters it)* | Bucket secret key. |
| `AV_ACCEPT_UNSCANNED` | `true` | No virus scanner on this platform: uploads stay unservable unless a workspace allows unscanned files. Run clamd and set AV_DRIVER=clamd + CLAMD_HOST to scan. |
| `MAILER_DRIVER` | `smtp` | smtp here; resend\|postmark\|ses need their own keys (see .env.example). |
| `SMTP_URL` | *(template user enters it)* e.g. `smtps://user:pass@smtp.example.com:465` | smtps://user:pass@host:465, or smtp://…:587?requireTLS=true (required in prod; plain STARTTLS is refused). |
| `MAIL_FROM` | *(template user enters it)* e.g. `investors@example.com` | Sender address (required in prod). |

**Service `worker`** — same image; no pre-deploy command, no healthcheck, no public domain.

| Variable | Value in the template | Notes |
|---|---|---|
| `APP_ENV` | `prod` | prod: https BASE_URL, MAIL_FROM and SMTP_URL become mandatory; SMTP over TLS, a METRICS_TOKEN for /metrics, and a virus scanner or AV_ACCEPT_UNSCANNED. |
| `BASE_URL` | `${{web.BASE_URL}}` | Public https URL of the portal (the platform hostname or your own domain). |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Postgres connection string (the platform's managed Postgres). |
| `ROLES` | `worker` | api,web on the web process, worker on the worker process. |
| `MIGRATE_ON_START` | `false` | Off: the platform's migrate step runs migrations once per deploy. |
| `TRUST_PROXY` | `true` | The platform's router terminates TLS and sets X-Forwarded-*. |
| `CLIENT_IP_HEADER` | `X-Real-IP` | Header the platform's edge sets to the client address (overwritten per request). |
| `TENANCY_MODE` | `single` | single: one workspace. multi routes workspaces by host (custom domains). |
| `CUSTOM_DOMAIN_DRIVER` | `manual` | manual: the platform issues certificates for domains you add there; the app only verifies DNS. |
| `ROBOTS` | `noindex` | noindex keeps the investor portal out of search engines. |
| `LOG_LEVEL` | `info` | trace\|debug\|info\|warn\|error. |
| `FUNDROOM_SECRET_KEY` | `${{web.FUNDROOM_SECRET_KEY}}` | Master key (256-bit). Generated once; back it up — losing it loses every encrypted field. |
| `SESSION_SECRET` | `${{web.SESSION_SECRET}}` | Session signing secret (otherwise derived from the master key). |
| `METRICS_TOKEN` | `${{web.METRICS_TOKEN}}` | Bearer token for /metrics; in prod /metrics is served only when one is set. |
| `STORAGE_DRIVER` | `s3` | s3: web and worker run on separate machines and cannot share a volume. |
| `S3_BUCKET` | `${{web.S3_BUCKET}}` | Bucket for documents. |
| `S3_ENDPOINT` | `${{web.S3_ENDPOINT}}` | S3 API endpoint (R2, Tigris, B2, AWS: https://s3.<region>.amazonaws.com). |
| `S3_REGION` | `auto` | auto for R2/Tigris; the bucket's region on AWS. |
| `S3_ACCESS_KEY_ID` | `${{web.S3_ACCESS_KEY_ID}}` | Bucket access key. |
| `S3_SECRET_ACCESS_KEY` | `${{web.S3_SECRET_ACCESS_KEY}}` | Bucket secret key. |
| `AV_ACCEPT_UNSCANNED` | `true` | No virus scanner on this platform: uploads stay unservable unless a workspace allows unscanned files. Run clamd and set AV_DRIVER=clamd + CLAMD_HOST to scan. |
| `MAILER_DRIVER` | `smtp` | smtp here; resend\|postmark\|ses need their own keys (see .env.example). |
| `SMTP_URL` | `${{web.SMTP_URL}}` | smtps://user:pass@host:465, or smtp://…:587?requireTLS=true (required in prod; plain STARTTLS is refused). |
| `MAIL_FROM` | `${{web.MAIL_FROM}}` | Sender address (required in prod). |

**Service `Postgres`** — Railway's PostgreSQL template (provides `DATABASE_URL` on the private network).

**Upgrading from a pre-FundRoom template (renamed variables):**

- `FUNDROOM_SECRET_KEY` was `SEEDHOST_SECRET_KEY`. An existing project keeps working on `SEEDHOST_SECRET_KEY` (`fundroom doctor` warns). Upgrade the image first and rename after: an image from before the rename reads only `SEEDHOST_SECRET_KEY` and, without it, generates a new key (data written meanwhile is lost to the real key). Both names holding the same value are accepted (`fundroom doctor` warns); different values refuse to start, naming both by key fingerprint. Once every service runs the new image, create `FUNDROOM_SECRET_KEY` on the web service with the same value and point the worker's reference at it; delete `SEEDHOST_SECRET_KEY` only when you will not roll back to an older image.
<!-- END GENERATED -->

## Client address (verify after the first deploy)

`CLIENT_IP_HEADER=X-Real-IP` makes the app take the visitor's address from that one header; it
feeds rate limits, audit IPs and the `ip_allowlist` access policy. Railway staff state on Railway
Central Station that the edge sets `X-Real-IP` and that clients can no longer set it (fixed August
2024), with one known bug: through Railway's CDN path it carries the CDN edge's address instead of
the client's. That is a shared address, not a spoofable one, but it is not a documented guarantee.
Check it once, after deploy, by signing in with a forged value (you@example.com is an account on
the portal):

```sh
H='X-Real-IP: 203.0.113.9'; U=https://<your-service>.up.railway.app
curl -s -H "$H" -H "Origin: $U" -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}' "$U/api/v1/auth/otp/start"
# enter the code from your inbox:
curl -s -c jar -H "$H" -H "Origin: $U" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"<code>"}' "$U/api/v1/auth/otp/verify"
curl -s -b jar -H "$H" "$U/api/v1/me/sessions"
```

The new session's `ip` must be your own address, never `203.0.113.9`. If it is `203.0.113.9`, unset
`CLIENT_IP_HEADER` so the app falls back to `TRUST_PROXY_HOPS` (the `X-Forwarded-For` entry the
edge appended) and repeat the check.
