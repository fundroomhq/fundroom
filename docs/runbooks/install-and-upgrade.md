# Runbook: install, upgrade and roll back

FundRoom ships as one signed container image, `ghcr.io/fundroomhq/fundroom`, whose entrypoint is the `fundroom` CLI. The same image runs everywhere: a reference Docker Compose stack for one server, Coolify, a Helm chart for Kubernetes, and generated templates for Render, Railway and Fly.io. This runbook is for whoever operates the install. It covers choosing where to run it, where each platform's install instructions live, how to get the first-run setup token on each, verifying what you are about to run, upgrading safely, what "rolling back" can and cannot mean, and the update notice.

The per-platform READMEs linked below are the install instructions; this runbook does not repeat them.

## What has to be true first

- **A domain you control**, with DNS you can edit, for `BASE_URL`. Production (`APP_ENV=prod`, the default in every template) refuses a non-https `BASE_URL`.
- **Outbound mail**: an SMTP account, or an API key for Resend, Postmark or SES. `MAIL_FROM` and (for SMTP) `SMTP_URL` are required in production; people sign in with emailed codes, so an install without mail cannot be used.
- **A plan for the master key.** Every template either generates `FUNDROOM_SECRET_KEY` for you or asks you to. Copy it out of the platform on day one and store it with your backups: a database restored without it cannot open a single document ([backup-and-restore.md](backup-and-restore.md)). If you keep your production environment in Git, encrypt it with SOPS: [`deploy/sops/README.md`](../../deploy/sops/README.md).
- **An S3-compatible bucket** everywhere except a single-server Compose or Coolify install. As soon as there are two processes — a separate worker, a second replica, any PaaS template — documents must be in a bucket (`STORAGE_DRIVER=s3`), because the processes do not share a disk.

## Choose a mode

| You have | Use | TLS and customer domains | Notes |
|---|---|---|---|
| One VPS, Docker | **Compose** — [`deploy/compose/`](../../deploy/compose/compose.yaml) | Caddy, automatic, including on-demand certificates for customer domains | The reference stack. `/data` volume for documents; optional profiles for a separate worker, ClamAV, backups. |
| One server managed by Coolify | **Coolify** — [`deploy/coolify/README.md`](../../deploy/coolify/README.md) | Coolify's Traefik (customer domains added by hand), or the Caddy variant (automatic) | The Compose stack reduced to Postgres, `migrate` and one all-in-one `app`. |
| Kubernetes 1.27+ | **Helm** — [`deploy/helm/fundroom/README.md`](../../deploy/helm/fundroom/README.md) | Your ingress + cert-manager for the primary host; customer domains by hand (`CUSTOM_DOMAIN_DRIVER=manual`) unless you put Caddy in front | Separate server and worker Deployments, a migrate Job, optional CloudNativePG. |
| No servers at all | **Render** — [`deploy/render/README.md`](../../deploy/render/README.md), **Railway** — [`deploy/railway/README.md`](../../deploy/railway/README.md), **Fly.io** — [`deploy/fly/README.md`](../../deploy/fly/README.md) | The platform's certificates; customer domains added in the platform by hand | Web + worker + managed Postgres + your bucket. Paid plans (Render runs pre-deploy commands only on paid services). |

Two decisions cut across all of them:

- **`TENANCY_MODE`**: `single` (the default) serves one workspace; `multi` serves many, by slug or custom domain. Decide before setup. A single-tenant install refuses to serve at all once it holds two live workspaces.
- **Custom domains**: on-demand certificates for customers' hostnames only work where Caddy fronts the app (Compose, Coolify's Caddy variant). Everywhere else a domain is verified by the app and added to the platform by you — see [custom-domains.md](custom-domains.md).

The PaaS templates and the Coolify stacks are generated from one source, `deploy/platforms/source.mjs` (`pnpm gen:deploy`); change that file, not the outputs, if you fork them.

## Install

Follow the linked README for your platform. What every install has in common:

1. **Pin a version.** Images are tagged `X.Y.Z`, `X.Y`, `X` and `latest` on a stable release (`latest` only for the newest one), only `X.Y.Z-rc.N` for a release candidate, which never moves `latest`, `X.Y` or `X`, and `edge` from `main`. The image's `org.opencontainers.image.version` label is the version it was released as. Every template names `latest`; replace it with an exact `X.Y.Z` (or a digest, below) before you rely on the install, so that an upgrade is something you do rather than something that happens on the next restart.
2. **Migrations run before the app starts.** Every platform has a step for it (next table); you do not run them by hand.
3. **Finish setup in the browser** with the first-run setup token, at `<BASE_URL>/setup`.
4. **Check the configuration** from inside a running container: `fundroom doctor` prints the resolved configuration with secrets redacted, the key ring's fingerprints, and an "Update check" line. Compose: `docker compose run --rm app doctor`. Kubernetes: `kubectl -n <ns> exec deploy/<fullname>-server -- /nodejs/bin/node /app/dist/cli.js doctor` (the image has no shell, so call Node directly).

### Where migrations run

| Platform | Migration step | App's `MIGRATE_ON_START` |
|---|---|---|
| Compose | the one-shot `migrate` service runs `migrate` and must exit 0 before `app` starts | `true` as well — a second, no-op pass guarded by an advisory lock |
| Coolify | the one-shot `migrate` service | `false` |
| Helm, external database | the `<fullname>-migrate` Job, a `pre-install,pre-upgrade` hook | `false` |
| Helm, `postgresql.mode=cnpg` | **first install:** the server pods migrate on start (the database is created with the release, so a pre-install Job would find none); **every later upgrade:** the pre-upgrade Job | `true` on the first install, `false` from the first upgrade (which restarts the pods once) |
| Render | the web service's pre-deploy command (`… cli.js migrate`) | `false` |
| Railway | the `web` service's pre-deploy command | `false` |
| Fly.io | `[deploy] release_command = "migrate"`, on a temporary Machine | `false` |

Concurrent runners are safe everywhere: the migration runner takes a Postgres advisory lock and waits up to ten minutes for another holder. On Fly, keep Managed Postgres pooling in *Session* mode — transaction pooling breaks that lock.

With Argo CD and CloudNativePG together, the first sync fails (Argo renders every sync as an install, so the migrate Job waits for a database that does not exist yet). Create the `Cluster` as its own application and install the chart in external mode against it — the Helm README has the values.

### The first-run setup token

The token authorises creating the first workspace and its owner. It stops working the moment setup is complete. Where to find it:

| Platform | Where |
|---|---|
| Compose | `docker compose logs app \| grep -A4 "first-run setup"`, or `docker compose run --rm app setup-token`. Fix it in advance with `SETUP_TOKEN` in `.env`. |
| Coolify | `SETUP_TOKEN` in the stack's Environment Variables (Coolify generated it). |
| Helm | `kubectl -n <ns> get secret <fullname>-env -o jsonpath='{.data.SETUP_TOKEN}' \| base64 -d; echo` — the chart derives one token from the master key, so every replica agrees. With `secrets.existingSecret`, put `SETUP_TOKEN` in your Secret (otherwise each pod prints its own). `helm install` prints the exact commands. |
| Render | the web service's `SETUP_TOKEN` (Environment tab; Render generated it). |
| Railway | the `web` service's `SETUP_TOKEN` (Variables tab; the template generated it). |
| Fly.io | the `SETUP_TOKEN` you set with `fly secrets set`. Fly will not show a secret back; if you lost it, set a new one (`fly secrets set SETUP_TOKEN="$(openssl rand -hex 16)"`, which restarts the Machines). |

`fundroom setup-token` answers `setup is complete` and exits 1 once a workspace exists — including a deleted one still inside its 30-day restore window.

A managed host (`CONTROL_PLANE=on`, [control-plane.md](control-plane.md)) has no first run and no token: workspaces come from signup and the operator API, `/api/v1/setup/status` says `"required": false` from the first boot, no token is generated, written to `DATA_DIR` or logged, a `SETUP_TOKEN` is ignored (`doctor` warns), and `fundroom setup-token` says so and exits 1.

## Verify what you run

Images and charts are signed keylessly with cosign from GitHub Actions, and carry an SBOM attestation and SLSA build provenance. Verify the exact version before you deploy it:

```sh
# the image (built and signed by .github/workflows/image.yml)
cosign verify ghcr.io/fundroomhq/fundroom:<version> \
  --certificate-identity-regexp '^https://github\.com/fundroomhq/fundroom/\.github/workflows/image\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/fundroomhq/fundroom:<version> --owner fundroomhq

# the Helm chart (pushed by .github/workflows/chart-release.yml on tag chart-v<version>)
cosign verify ghcr.io/fundroomhq/charts/fundroom:<chart version> \
  --certificate-identity-regexp '^https://github\.com/fundroomhq/fundroom/\.github/workflows/chart-release\.yml@refs/tags/chart-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/fundroomhq/charts/fundroom:<chart version> --owner fundroomhq
```

Then pin the digest you verified, so the name cannot move under you:

```sh
docker buildx imagetools inspect ghcr.io/fundroomhq/fundroom:<version> | grep '^Digest'
```

Compose: `FUNDROOM_IMAGE=ghcr.io/fundroomhq/fundroom@sha256:…` in `.env`. Helm: `image.digest=sha256:…`. The PaaS templates take the same reference wherever they name the image.

The chart has its own version, independent of the app's; its `appVersion` is the image it deploys by default.

## Upgrade

Read the release notes first — for a security release, the advisory. Then, on every platform:

1. **Back up, and note the time.** The time is your point-in-time target if the upgrade has to be undone.
   - Compose with pgBackRest: `docker compose -f compose.yaml -f compose.backup.yaml exec pgbackrest pgbackrest --stanza=seedhost backup --type=full`.
   - Compose without it: `docker compose exec -T db pg_dump -U seedhost -Fc seedhost > pre-upgrade-$(date -u +%Y%m%dT%H%MZ).dump`.
   - CloudNativePG: an on-demand `Backup` (`kubectl cnpg backup <fullname>-pg`). Managed Postgres: the provider's snapshot.

   `BACKUP_BEFORE_MIGRATE` is accepted by the configuration and **does nothing yet**; this step is yours. Details and restores: [backup-and-restore.md](backup-and-restore.md).
2. **Find out whether the new version changes the schema** — it decides what a rollback can mean (next section). From anywhere that can reach the database, with the **new** image:

   ```sh
   # Compose (from deploy/compose; --no-deps stops Compose from running the new image's migrate service first)
   FUNDROOM_IMAGE=ghcr.io/fundroomhq/fundroom:<new version> docker compose run --rm --no-deps app migrate --dry-run
   ```

   Elsewhere, `docker run --rm -e BASE_URL=https://<your host> -e DATABASE_URL=<url> -e FUNDROOM_SECRET_KEY="$(openssl rand -base64 32)" ghcr.io/fundroomhq/fundroom:<new version> migrate --dry-run` — a dry run reads the migration journal only, so any valid key will do. It prints `applied: <n>, pending: <m>` and one line per pending migration; exit 1 means the journal has a problem, and the upgrade would fail at the migrate step.
3. **Upgrade**, the platform's way:

| Platform | Upgrade |
|---|---|
| Compose | Set `FUNDROOM_IMAGE` to the new version (or digest) in `.env`, then `docker compose pull` and `docker compose up -d` (with the backup overlay, both `-f` files). `migrate` runs, then `app` and `worker` are recreated; Caddy retries for up to 30 s while `app` restarts, so the gap is a slow request rather than an error page. |
| Coolify | Change the image tag on **both** the `migrate` and `app` services to the same version, then redeploy. |
| Helm | `helm upgrade <release> oci://ghcr.io/fundroomhq/charts/fundroom --version <chart version> -n <ns> -f values.yaml` (set `image.tag` or `image.digest` if you pin the app separately from the chart). The migrate Job runs before any pod is replaced; if it fails, the release stays on the old version and `kubectl -n <ns> logs job/<fullname>-migrate` says why. |
| Render | Pin the version in `deploy/platforms/source.mjs` (`IMAGE`) and regenerate, or change the image URL on both services, then trigger a manual deploy. Image services do not redeploy when a tag moves. The pre-deploy command migrates first. |
| Railway | Change the source image of `web` and deploy it first — its pre-deploy command migrates — then change and deploy `worker`. |
| Fly.io | `fly deploy --image ghcr.io/fundroomhq/fundroom:<version>`. The release command migrates first; a failure stops the deploy. |

4. **Check it.** `/readyz` on the new version answers `ready` (it fails with `pending migration(s)` if the migration step was skipped), `doctor`'s first line names the new version, and the admin **Health** page shows it. Sign in and open a document.

Migrations are written expand/contract, so the **old** version keeps working on the new schema while a rolling deploy replaces it; that is what makes step 3 zero-downtime on Helm and the PaaS platforms.

## Upgrading to the security-hardening release

The security-hardening release makes `APP_ENV=prod` (and `staging`) refuse settings that used to run
insecurely by default. A stack that booted before can stop at the **migrate** step after the
upgrade: on Compose `migrate` exits with code 2 and `app` never starts, on Helm the pre-upgrade Job fails and
the release stays on the old version, on the PaaS platforms the pre-deploy/release command fails.
The error names the key. Check your configuration against this list **before** step 3 of the
upgrade. On Compose the dry run in step 2 loads your whole configuration and fails with exit
code 2 and the same list (the `docker run -e …` form passes only three variables, so it checks
nothing else). Anywhere, `doctor` with the new image and the real environment prints the same
list without touching the database:

```sh
FUNDROOM_IMAGE=ghcr.io/fundroomhq/fundroom:<new version> docker compose run --rm --no-deps app doctor
```

On Helm, the migrate Job runs with inert mail drivers, so an `SMTP_URL` problem passes the hook
and then crash-loops the new server and worker pods (the old ReplicaSet keeps serving): render
with `helm template` and fix the values first.

| Refused now (prod/staging) | Error names | Line to add or change |
|---|---|---|
| No virus scanner (`AV_DRIVER=noop`, the default) without saying so | `AV_DRIVER` | Compose `.env`: `AV_ACCEPT_UNSCANNED=true` (or `AV_DRIVER=clamd` with `--profile av`). Helm: `config.av.acceptUnscanned: true` (or `config.av.driver: clamd` + `clamdHost`). Render/Railway/Fly/Coolify services created from an older template: add `AV_ACCEPT_UNSCANNED=true` to the web and worker env. |
| `SMTP_URL` to a relay outside the private network over plain `smtp://` (STARTTLS only if offered) | `SMTP_URL` | `SMTP_URL=smtps://user:pass@smtp.example.com:465`, or keep port 587 and append `?requireTLS=true`: `SMTP_URL=smtp://user:pass@smtp.example.com:587?requireTLS=true` |
| `SMTP_URL` that switches certificate checks off (`tls.rejectUnauthorized=false`/`0`/empty), sets `ignoreTLS`, repeats an option, or contains a backslash or space | `SMTP_URL` | Remove the option (install the relay's CA with `NODE_EXTRA_CA_CERTS` instead); give each option once; percent-encode the user name and password |
| `DATABASE_URL` to a host outside the private network without verified TLS | `DATABASE_URL` | Append `?sslmode=verify-full` (`&sslmode=…` if the URL already has a query; the **last** `sslmode` counts, as in pg). Managed database with its own CA: also `&sslrootcert=/path/ca.pem` — on Helm set `postgresql.external.caSecret` and use `sslrootcert=/etc/seed-host/db-ca/ca.crt` (chart README, "External database with a private CA"). Only if the host is private after all: `DATABASE_ACCEPT_UNVERIFIED_TLS=true` |
| `METRICS_ENABLED=true` without a token | `METRICS_TOKEN` | `METRICS_TOKEN=<openssl rand -hex 24>` (scrapers send `Authorization: Bearer <token>`), or drop `METRICS_ENABLED`. Without either, `/metrics` is now **off** in prod (not an error) |
| `CLIENT_IP_HEADER` without `TRUST_PROXY=true`, set to `X-Forwarded-For`, or `TRUST_PROXY_HOPS=0` | that key | Remove it, or set `TRUST_PROXY=true`; `TRUST_PROXY_HOPS` is 1 or more |
| `RATE_LIMIT_MULTIPLIER` other than 1 in prod, or anywhere `APP_ENV` is not set explicitly | `RATE_LIMIT_MULTIPLIER` | Remove it; it is for load and DAST stacks, which set `APP_ENV=test` |

Compose only:

| Refused now | Message | Line to add |
|---|---|---|
| `.env` without `POSTGRES_PASSWORD` (Compose used to fall back to `seedhost`) | `required variable POSTGRES_PASSWORD is missing a value` | `POSTGRES_PASSWORD=seedhost` — the password your existing `pgdata` volume was created with. Postgres reads `POSTGRES_PASSWORD` only when it initialises an empty volume, so a **new** random value here would lock the app out of the database. Afterwards rotate it the safe way ([rotate-keys.md](rotate-keys.md), "The database password"). A new install sets a fresh one: `openssl rand -hex 24` |

Behaviour that changes without an error:

- **Client addresses** behind a proxy are the `X-Forwarded-For` entry `TRUST_PROXY_HOPS` (default 1) places from the right, or the platform header in `CLIENT_IP_HEADER` — never the client-written first entry. Raise `TRUST_PROXY_HOPS` by one per appending CDN/load balancer in front of your proxy.
- **Caddy (Compose)** no longer keeps `X-Forwarded-*` from private-range peers. With a CDN or load balancer in front of Caddy, list it: `EDGE_TRUSTED_PROXIES=<its CIDRs>` (or `private_ranges`) and `TRUST_PROXY_HOPS=2`. Without that, the app sees the load balancer's address for every visitor.
- **HSTS** carries `includeSubDomains` by default on a host-mounted install (`HSTS_INCLUDE_SUBDOMAINS=false` turns it off), and only on `BASE_URL`'s host and its subdomains; custom domains get plain `max-age`. Before enabling HSTS on a domain whose sibling subdomains still serve plain http, set `HSTS_INCLUDE_SUBDOMAINS=false`.
- **`/readyz`** shows only the verdicts to anonymous callers; the details need `Authorization: Bearer <METRICS_TOKEN>` or a loopback call without `TRUST_PROXY`.

## Renamed identifiers (FundRoom)

The release that finishes the rename to FundRoom changes identifiers, not behaviour. An existing install upgrades without any change and keeps working; this section says what to rename, by when, and what you must update yourself because it has no alias.

**The master key variable.** `SEEDHOST_SECRET_KEY` (and `SEEDHOST_SECRET_KEY_FILE`) is now `FUNDROOM_SECRET_KEY` (`FUNDROOM_SECRET_KEY_FILE`).

**Upgrade the image first, rename the variable after.** An image from before this release reads only `SEEDHOST_SECRET_KEY`. If it starts and finds only `FUNDROOM_SECRET_KEY`, it treats the install as having no key. Wherever `/data` is writable it then generates a **new** master key and runs on it: a restarted old pod during a rolling upgrade, a rollback, an image cached or pinned on one host. Anything it encrypts in that window can never be read with your real key. So, while any older image may still run against this data, set **both names to the same value**:

- The old name is still read when no spelling of the new one is set. `doctor` and the boot log then warn `SEEDHOST_SECRET_KEY: deprecated name: it has been renamed FUNDROOM_SECRET_KEY …`. The old name will be removed in a later release.
- Both names set to the **same** value (each side resolved as usual: a `_FILE` variable's contents with trailing newlines stripped) are accepted. `FUNDROOM_SECRET_KEY` is used, and `doctor` and the boot log warn `SEEDHOST_SECRET_KEY: deprecated name, set to the same value as FUNDROOM_SECRET_KEY …`. Remove `SEEDHOST_SECRET_KEY` once no older image can run: after the upgrade has settled and you no longer plan a rollback.
- Both names set to **different** values (or one side ambiguous, such as `NAME` and `NAME_FILE` both set) are a configuration error. The process refuses to start, and `doctor` and the migrate step fail the same way. The message names every variable that is set, with a fingerprint of each value, never the value itself. For a `_FILE` variable it shows the path and the fingerprint of the file's contents. A usable key is shown as `key sha256:<12 hex>`: the same fingerprint `fundroom doctor` prints for the key ring (`FUNDROOM_SECRET_KEY  v1 (sha256:<12 hex>)`) and the boot log's resolved configuration shows. Compare it with what `doctor` printed on the deployment before the upgrade. **On an upgraded install the old name normally holds the key your data was encrypted with.** A platform that generates secrets per variable name can put a brand-new random value under the new name; a Render Blueprint sync does exactly that. Set `FUNDROOM_SECRET_KEY` to the matching value, or set both to it, and only then remove the other. Never delete a value you have not matched: data encrypted with it cannot be read without it.
- **Compose:** Compose passes both names from `.env` to the app. Upgrade `FUNDROOM_IMAGE` first. Then add `FUNDROOM_SECRET_KEY=` with the same value as `SEEDHOST_SECRET_KEY`, and delete the old line once you will not roll back. `SEEDHOST_DOMAIN` and `SEEDHOST_IMAGE` are now `FUNDROOM_DOMAIN` and `FUNDROOM_IMAGE`; Compose still falls back to the old names when the new ones are unset, but rename them too.
- **Caddy edge:** the shipped `deploy/caddy/Caddyfile` reads `FUNDROOM_DOMAIN` and `FUNDROOM_BASE_PATH`, which Compose sets for it. A Caddy you run yourself with that file and only the old `SEEDHOST_DOMAIN` / `SEEDHOST_BASE_PATH` keeps working: the `/internal/*` and `/metrics` refusals cover both prefixes. Rename them in one change. With both `FUNDROOM_BASE_PATH` and `SEEDHOST_BASE_PATH` set, Caddy refuses to start (`wrong argument count … @base_path_set_twice`), because the ask URL and health check would carry the prefix twice.
- **Helm:** for one minor release the chart-managed Secret, and the migrate hook's Secret, carry the key under both `FUNDROOM_SECRET_KEY` and `SEEDHOST_SECRET_KEY`, with the same value from `secrets.secretKey`. Old-ReplicaSet pods restarted mid-rollout and `helm rollback` therefore keep finding it. A `secrets.existingSecret` that holds `SEEDHOST_SECRET_KEY` keeps working. Add `FUNDROOM_SECRET_KEY` with the same value after the upgrade, and drop the old key only when you will not roll back.
- **Coolify:** for one minor release the stacks pass the one generated `SERVICE_REALBASE64_SEEDHOSTKEY` as both `FUNDROOM_SECRET_KEY` and `SEEDHOST_SECRET_KEY`. Nothing to do.
- **Render:** Render's `generateValue` makes one random value per variable name, and an env group cannot reference another variable. Two names would therefore be two different keys, so for this minor release the Blueprint keeps generating the key under `SEEDHOST_SECRET_KEY`. Syncing it into an existing install keeps your key, because an existing variable is not regenerated. Do not add `FUNDROOM_SECRET_KEY` with any other value. Before you sync a later Blueprint that uses the new name, add `FUNDROOM_SECRET_KEY` to the env group with `SEEDHOST_SECRET_KEY`'s value ([deploy/render/README.md](../../deploy/render/README.md)).
- **Railway, Fly.io:** you set secrets by hand, so follow the order above. See the upgrade notes at the end of [deploy/railway/README.md](../../deploy/railway/README.md) and [deploy/fly/README.md](../../deploy/fly/README.md).
- **`docker run`:** keep your existing volume name (the Dockerfile example still says `-v seedhost-data:/data`). The volume holds `/data/secret.key`, so a new name means an empty `/data` and a newly generated key.

**The CLI** is `fundroom` (and `fundroom-audit`, `fundroom-db` for the package CLIs). The old `seedhost`, `seedhost-audit` and `seedhost-db` bins still work for one more minor release and print a one-line note on stderr. The image's entrypoint is unchanged, so `docker compose run --rm app doctor` and the Helm and PaaS commands need nothing; only scripts that call the bin by name do.

**Stripe meters** (managed hosts with metered prices only). The meter event names are now settings, `BILLING_METER_SEATS_EVENT` and `BILLING_METER_STORAGE_EVENT`, and their defaults changed from `seedhost_staff_seats` / `seedhost_storage_gb` to `fundroom_staff_seats` / `fundroom_storage_gb`. If your Stripe meters use the old names, set `BILLING_METER_SEATS_EVENT=seedhost_staff_seats` and `BILLING_METER_STORAGE_EVENT=seedhost_storage_gb` before the upgrade. Otherwise the nightly usage report sends nothing for those meters. It logs `billing.usage_meter_unknown` (warn) for each subscription that bills on a meter it does not recognise ([billing.md](billing.md)).

**Accepted indefinitely** — things other systems hold, which you do not have to change:

| Old | New | |
|---|---|---|
| TXT `_seedhost-challenge.<hostname>` (custom domains) | `_fundroom-challenge.<hostname>` | Verified domains keep verifying on the weekly re-check. The new label is looked up first and the old one only when the new one does not carry the token, so a domain still on the old record costs one more DNS lookup per check (a domain with neither record too) ([custom-domains.md](custom-domains.md)). |
| TXT `_seedhost-sso.<domain>` = `seedhost-sso=<token>` (SSO domains) | `_fundroom-sso.<domain>` = `fundroom-sso=<token>` | Any mix of the two names and prefixes passes with the right token. |
| API keys `shk_…`, SCIM tokens `shs_…` | `frk_…`, `frs_…` | Old keys and tokens authenticate unchanged until revoked or expired; rotating one returns the new prefix. Secret-scanning rules in `.gitleaks.toml` match both. |
| DocuSeal webhook header `X-Seedhost-Signature` | `X-Fundroom-Signature` | Rename it in DocuSeal the next time you rotate the callback secret ([esign/docuseal.md](../esign/docuseal.md)). |

**Served under both names for one more minor release**, then the old name goes:

| Old | New | Who reads it |
|---|---|---|
| `X-Seedhost-Cell` on `421 wrong_cell` | `X-Fundroom-Cell` | an edge that routes requests between cells ([control-plane.md](control-plane.md)) |
| `X-Seedhost-Export-Truncated` on the Q&A CSV export | `X-Fundroom-Export-Truncated` | scripts calling the export API |
| `/.well-known/seed-host.json` | `/.well-known/fundroom.json` | version probes, uptime checks, monitoring |

**Changed with no alias** — update what you built on them:

- **Metrics:** `seed_host_*` / `seedhost_*` series are now `fundroom_*`, for example `fundroom_security_events_total`, `fundroom_csp_violations_total` and `fundroom_authz_engine_errors_total`. The OpenTelemetry meter scopes `seed-host.http`, `seed-host.authz`, `seed-host.security` and `seed-host.csp` are now `fundroom.http`, `fundroom.authz`, `fundroom.security` and `fundroom.csp` (the `otel_scope_name` label in Prometheus). Update dashboards and alert rules.
- **Service names:** the `OTEL_SERVICE_NAME` default, the `service` field of log lines and pg-boss's Postgres `application_name` are `fundroom` (were `seed-host`). Set `OTEL_SERVICE_NAME` explicitly if your traces are filtered on the old value.
- **User-Agents:** outbound webhooks send `FundRoom-Webhooks/1` (was `SeedHost-Webhooks/1`) and the OpenFGA client sends `fundroom-authz-engine/1` (was `seed-host-authz-engine/1`). Update any receiver or proxy rule that filters on them.
- **Code built against the packages:** the npm scope is `@fundroom/*` and the SDK exports are `FundRoomClient`, `createFundRoomClient`, `FundRoomApiError`, `FundRoomSchemas` and so on. The embed API (`SeedHost.init`, `window.SeedHost`) does not change.

**Rolling back, or old and new images side by side.** Plan for these before you upgrade:

- **Tokens minted after the upgrade.** API keys are `frk_…` and SCIM tokens `frs_…`. An older image accepts only `shk_` / `shs_`, so after a rollback, and on old pods during a rolling deploy, the new ones answer 401. Re-mint those keys and tokens after a rollback, or roll forward. Keys and tokens from before the upgrade work on both.
- **The master key.** Keep `SEEDHOST_SECRET_KEY` set (same value) until you will not roll back (above).
- **The CLI.** An older image has only the `seedhost` bins. Scripts that already call `fundroom …` fail against it.
- **Headers and paths.** An older image sends only `X-Seedhost-Cell` / `X-Seedhost-Export-Truncated` and serves only `/.well-known/seed-host.json`. Readers you switched to the new names see nothing from it.
- **Metrics.** Series and scopes go back to `seedhost_*` / `seed-host.*` on an older image, so dashboards switched to `fundroom_*` go blank.
- **Restoring with Compose's backup profile.** The local pgBackRest image is now tagged `fundroom-local/postgres-pgbackrest`. The restore services reuse the locally built image and never pull or build it (`pull_policy: never`). On a host that has not run `docker compose build db` (or `up`) since upgrading, `--profile restore run --rm pgbackrest-restore …` therefore fails with "image not found". Run `docker compose build db` first ([backup-and-restore.md](backup-and-restore.md)).

Not renamed, ever: database names and roles (`seedhost`, `seedhost_app`, `seedhost_host`), the pgBackRest stanza `seedhost`, Compose project names, cryptographic labels and export format ids, the WordPress plugin's slug, and the embed API.

## Roll back

Migrations are **forward-only**: there are no down migrations, and nothing ever runs one. What a rollback means therefore depends on step 2 of the upgrade.

- **The new version applied no migrations** (`pending: 0`): a rollback is redeploying the previous image — `FUNDROOM_IMAGE` back and `docker compose up -d`, `helm rollback`, the previous image on the PaaS. Nothing else changes.
- **The new version applied migrations**: **the previous image will not start against that database.** The runner compares the journal (`core.schema_migration`) with the migration files the image carries, and a migration that is applied in the database but absent from the image is a hard error: `applied in the database but missing on disk (migrations are forward-only; restore the file)`. Concretely, the old image's `migrate` step fails — on Compose the `migrate` service exits 1 and `app` never starts; `serve` with `MIGRATE_ON_START=true` refuses to boot; and where the migrate step is skipped (`helm rollback` runs no pre-upgrade hook), `/readyz` reports `migrations: journal problems` and the old pods never become ready. The schema itself would have been compatible; the journal check is what stops it.

  So a rollback across a schema change is a **restore**: stop the app, restore the database to the time you noted before the upgrade ([backup-and-restore.md](backup-and-restore.md) — in-place PITR, or the pre-upgrade dump), and deploy the previous image. Everything written after that time is lost, which is why the usual answer is to fix forward: stay on the new version and take the fix in the next patch release.

Do not edit `core.schema_migration` by hand to make an old image start. The journal is what keeps the next upgrade from re-running or skipping a migration.

## The update notice

The install checks, by itself, whether a newer release exists. It never installs anything.

- **What it sends:** one `GET` of `UPDATE_CHECK_URL` (default `https://releases.fundroom.com/index.json`, a static file) with no query string, no cookies and nothing about the install except its version, in the User-Agent (`FundRoom/<version>`). The answer is cached for 12 hours, or 1 hour after a failure. The request has a 5-second timeout and follows no redirects (a moved index is a config change: set `UPDATE_CHECK_URL`).
- **When it runs:** only when asked — by `fundroom doctor`, and by the admin **Health** page (`GET /api/v1/ops/update`, owner and admin). The Health page shows it on single-tenant installs only; on a multi-tenant host the running version is the operator's business rather than a workspace admin's, so the page says nothing and makes no request. `doctor` checks in both modes.

What it says (the `doctor` line, and the card):

| Status | `doctor` says | Means |
|---|---|---|
| `current` | `Update check: up to date (…)` | Nothing newer is listed (a hotfix build ahead of the index counts as current). |
| `update_available` | `Update check: <version> is available (running …) — <release notes URL>` | A newer release exists; none of the newer ones is a security release. Plan the upgrade. |
| `security_update` | `Update check: SECURITY UPDATE — <versions> fixes security issues …` | At least one release newer than yours fixes a security issue — checked against every newer release, not just the latest. Read the advisory and upgrade promptly. |
| `unknown` | `… is a development or prerelease build …` | You run `edge`, a prerelease or a local build; there is nothing to compare. |
| `error` | `Update check: could not read the release index …` | The index could not be fetched or did not validate. Harmless — it never fails `doctor` or the page — and expected on a host with no outbound internet. |
| `disabled` | `Update check: off (UPDATE_CHECK=false)` / `not reported on a multi-tenant host` | Opted out, or the Health page on a multi-tenant host. |

**Opting out:** `UPDATE_CHECK=false`. With it off, the install builds no outbound client for the check and never fetches. Helm: `config.updateCheck=false`. PaaS: add the variable to both services. Compose: the reference `compose.yaml` passes only a listed set of variables to the app, and `UPDATE_CHECK` is not one of them — add it in a `compose.override.yaml` next to `compose.yaml`:

```yaml
services:
  app:
    environment:
      UPDATE_CHECK: "false"
```

An air-gapped install that still wants the notice can mirror the index and point `UPDATE_CHECK_URL` at the copy (https is required in production). Security advisories are also published as GitHub Security Advisories and on the `security-advisories` list (`SECURITY.md`); subscribe to one of them either way.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `FUNDROOM_IMAGE` | Compose `.env` | `ghcr.io/fundroomhq/fundroom:latest` |
| `BASE_URL` | app | required |
| `APP_ENV` | app | `dev` in the schema; `prod` in every template |
| `TENANCY_MODE` | app | `single` |
| `ROLES` / `WORKER_MODE` | app | `api,web,worker` / unset; the templates split web and worker |
| `MIGRATE_ON_START` | app | `true`; `false` wherever a separate migrate step runs |
| `BACKUP_BEFORE_MIGRATE` | app | `false`; not implemented |
| `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING` | app | generated into `/data/secret.key` on Compose if unset; generated by the platform elsewhere |
| `SETUP_TOKEN` | app | generated; fixed by the templates |
| `STORAGE_DRIVER` | app | `fs`; `s3` in every multi-process template |
| `CUSTOM_DOMAIN_DRIVER` | app | `caddy-ask`; `manual` in Helm and the PaaS templates |
| `UPDATE_CHECK` / `UPDATE_CHECK_URL` | app | `true` / `https://releases.fundroom.com/index.json` |
| `AV_ACCEPT_UNSCANNED` | app | `false`; prod/staging refuse `AV_DRIVER=noop` without it |
| `POSTGRES_PASSWORD` | Compose `.env` | required; `seedhost` on stacks created before |
| `EDGE_TRUSTED_PROXIES` | Compose `.env` (caddy) | empty: Caddy trusts no forwarded headers |
| `image.tag`, `image.digest`, `config.updateCheck`, `postgresql.mode` | Helm values | see the chart README |
