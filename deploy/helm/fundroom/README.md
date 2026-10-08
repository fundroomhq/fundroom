# FundRoom Helm chart

Runs [FundRoom](https://github.com/fundroomhq/fundroom) on Kubernetes 1.27 or newer. Below,
`<fullname>` is `<release>-fundroom`, or just `<release>` when the release name already contains
`fundroom` (e.g. `helm install fundroom …` gives `fundroom-server`, `fundroom-env`).

| Resource | What it is |
|---|---|
| `Deployment <fullname>-server` | API and web app (`ROLES=api,web`). Runs the job worker itself (`WORKER_MODE=embedded`) when `worker.enabled=false`, otherwise `WORKER_MODE=external` |
| `Deployment <fullname>-worker` | The job worker (`ROLES=worker`), optional CPU `HorizontalPodAutoscaler` |
| `Job <fullname>-migrate` | `fundroom migrate`, a `pre-install,pre-upgrade` Helm hook. App pods run with `MIGRATE_ON_START=false` |
| `Service`, optional `Ingress` | Ingress for the primary host, with a cert-manager `cluster-issuer` annotation and TLS |
| `ConfigMap`, `Secret` (or your `existingSecret`) | The env the app reads (`packages/config/src/schema.ts`) |
| optional CloudNativePG `Cluster` | `postgresql.mode=cnpg`, with optional barman object-store backups and a `ScheduledBackup` |
| `PodDisruptionBudget`, `ServiceAccount`, optional `NetworkPolicy` | |

Every pod runs as the image's non-root user (65532) with a read-only root filesystem, an `emptyDir`
at `/tmp`, all capabilities dropped, no privilege escalation, the `RuntimeDefault` seccomp profile,
no service-account token and resource requests and limits. That passes the Kubernetes *restricted*
Pod Security Standard.

## Install

Prerequisites: Postgres 16 or newer (18 recommended), or the [CloudNativePG operator](https://cloudnative-pg.io/documentation/current/installation_upgrade/);
an S3-compatible bucket (AWS S3, Cloudflare R2, Garage, SeaweedFS, MinIO); SMTP or an email API provider.
For the Ingress you also need an ingress controller and, for automatic TLS, [cert-manager](https://cert-manager.io) with a `ClusterIssuer`.

```sh
cat > fundroom-values.yaml <<'EOF'
config:
  baseUrl: https://investors.example.com
  mail:
    from: investors@example.com
  av:
    # No virus scanner yet: uploads are stored `skipped`. Prefer driver: clamd + clamdHost.
    acceptUnscanned: true
secrets:
  secretKey: "<openssl rand -base64 32>"   # back this up outside the cluster
  # TLS that cannot be stripped: smtps://…:465, or smtp://…:587?requireTLS=true
  smtpUrl: smtps://user:pass@smtp.example.com:465
storage:
  s3:
    bucket: fundroom-documents
    region: eu-west-1
    accessKeyId: "<key id>"
    secretAccessKey: "<secret>"
postgresql:
  external:
    # A database outside the cluster is verified TLS in prod. For a managed database with its
    # own CA (RDS, Cloud SQL, Azure) see "External database with a private CA" below.
    url: postgres://seedhost:<password>@db.example.com:5432/seedhost?sslmode=verify-full
ingress:
  enabled: true
  className: nginx
  clusterIssuer: letsencrypt-prod
EOF

helm install fundroom oci://ghcr.io/fundroomhq/charts/fundroom --version 0.1.0 \
  --namespace fundroom --create-namespace -f fundroom-values.yaml
```

The notes printed after the install explain how to read the **first-run setup token**. In short,
every server replica uses the same token, stored in the chart's Secret as `SETUP_TOKEN`:

```sh
kubectl -n fundroom get secret fundroom-env -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d; echo
# or ask a running server; the image is distroless (no shell), so call node directly:
kubectl -n fundroom exec deploy/fundroom-server -- /nodejs/bin/node /app/dist/cli.js setup-token
```

If you do not set `secrets.setupToken`, the chart derives the token from the master key (SHA-256,
truncated), so it stays the same across upgrades and `helm template` runs without a `lookup`. It stops working once setup is complete.

### Secrets you manage yourself

With External Secrets, SOPS, Sealed Secrets or a similar tool, create the Secret **before**
`helm install` (the migrate hook reads it before any chart resource exists) and set
`secrets.existingSecret`. Every key in it becomes an env var, so name the keys after the env vars:

| Key | Required |
|---|---|
| `FUNDROOM_SECRET_KEY` or `SECRET_KEY_RING` | yes |
| `DATABASE_URL` | unless `postgresql.mode=cnpg` or `postgresql.external.existingSecret` |
| `SMTP_URL` | for `config.mail.driver=smtp` in prod/staging |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | with `storage.driver=s3` |
| `SETUP_TOKEN` | recommended with more than one server replica (otherwise each pod prints its own) |
| `METRICS_TOKEN`, `OIDC_CLIENT_SECRET`, `RESEND_API_KEY`, … | as needed |

A Secret made before the FundRoom rename holds the key as `SEEDHOST_SECRET_KEY`. That still works
(the app reads the old name and `doctor` warns). Upgrade the image first and rename after: add
`FUNDROOM_SECRET_KEY` with the **same value** and keep `SEEDHOST_SECRET_KEY` while any pod of an older
image may still run (an old ReplicaSet pod restarted mid-rollout, a rollback). An older image reads
only `SEEDHOST_SECRET_KEY` and, without it, generates a new key into `/data`. Both keys holding the
same value is accepted, with a warning. Different values are refused at boot. The chart's own
Secret (`secrets.secretKey`) carries both names for one minor release for the same reason.

```sh
kubectl -n fundroom create secret generic fundroom-env \
  --from-literal=FUNDROOM_SECRET_KEY="$(openssl rand -base64 32)" \
  --from-literal=SETUP_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=DATABASE_URL='postgres://…?sslmode=verify-full' --from-literal=SMTP_URL='smtps://…:465' \
  --from-literal=S3_ACCESS_KEY_ID='…' --from-literal=S3_SECRET_ACCESS_KEY='…'
```

`config.appEnv` defaults to `prod`, which refuses to start (the render or the migrate hook
fails) on anything that would run insecurely by accident: no virus scanner without
`config.av.acceptUnscanned=true`, plain `smtp://` to a public relay without `?requireTLS=true`,
and a public database host without `sslmode=verify-full` (or `verify-ca`).

### External database with a private CA

Managed Postgres services sign their server certificates with their own CA, which is not in
Node's bundled roots, so `sslmode=verify-full` alone fails the handshake. Put the CA bundle in a
Secret **before** `helm install` (the migrate hook mounts it) and point the chart at it:

```sh
curl -fsSLo global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
kubectl -n fundroom create secret generic rds-ca --from-file=ca.crt=global-bundle.pem
```

```yaml
postgresql:
  external:
    url: postgres://seedhost:<password>@<instance>.rds.amazonaws.com:5432/seedhost?sslmode=verify-full&sslrootcert=/etc/seed-host/db-ca/ca.crt
    caSecret: rds-ca        # mounted read-only at /etc/seed-host/db-ca/ca.crt in every pod
    caSecretKey: ca.crt     # the key in that Secret (default ca.crt)
```

The render fails if `caSecret` is set and `postgresql.external.url` lacks
`sslrootcert=/etc/seed-host/db-ca/ca.crt`. With `postgresql.external.existingSecret` or a
`DATABASE_URL` in `secrets.existingSecret`, put the same query string in that URL yourself.
`DATABASE_ACCEPT_UNVERIFIED_TLS=true` (via `config.extra`) is only for a host that really is on a
private network the loader does not recognise; it adds no TLS.

### CloudNativePG (`postgresql.mode=cnpg`)

The chart creates a `postgresql.cnpg.io/v1` `Cluster` named `<fullname>-pg`, and the app reads
`DATABASE_URL` from the operator-generated Secret `<fullname>-pg-app` (key `uri`), with
`sslmode=verify-full&sslrootcert=/etc/seed-host/db-ca/ca.crt` appended: the connection is TLS,
verified against the operator's CA (`<fullname>-pg-ca`, only `ca.crt` is mounted). With
`postgresql.mode=external`, put `?sslmode=verify-full` (and `sslrootcert` for a private CA) in the
URL yourself: in prod/staging the app refuses a database host outside the private network without
it (`DATABASE_ACCEPT_UNVERIFIED_TLS=true` via `config.extra` is the escape hatch). **The operator
must already be installed** (it provides the CRD). After initdb the chart runs
`ALTER ROLE seedhost CREATEROLE BYPASSRLS` (`postgresql.cnpg.grantMigratorPrivileges`), because the
migrator creates the NOLOGIN `seedhost_app` role and data migrations must see every tenant's rows.
Queries still run as `seedhost_app` under row-level security (see `packages/db/README.md`).

The database is created together with the release, so a pre-install hook would find no database.
`postgresql.cnpg.migrateOnStart` decides who migrates instead:

| Value | Behaviour |
|---|---|
| `auto` (default) | On the **first `helm install`** (`.Release.IsInstall`) the server pods migrate on start, serialised by the runner's advisory lock (`MIGRATE_ON_START=true`, with a five-minute wait for the database). Every later `helm upgrade` uses the pre-upgrade Job and sets `MIGRATE_ON_START=false`. That env change restarts the pods once, on the first upgrade |
| `true` | The pods always migrate on start and no migrate Job is rendered. Use this with tools that always render as an install (Argo CD, `helm template \| kubectl apply`), where `auto` would never switch off |
| `false` | Always the pre-upgrade Job. Only for a release whose database already exists |

The
`Cluster` has `helm.sh/resource-policy: keep`, so `helm uninstall` does not delete your data.

Backups: `postgresql.cnpg.backup.enabled=true` with `destinationPath` (e.g.
`s3://bucket/pg`) and `existingSecret` holding the object-store keys (`access-key-id` and
`secret-access-key` by default) turns on WAL archiving and base backups through the operator's
in-tree `barmanObjectStore`, plus a daily `ScheduledBackup`. For restore and PITR, see
[docs/runbooks/backup-and-restore.md](../../../docs/runbooks/backup-and-restore.md) and the
CloudNativePG recovery docs. Newer operator versions recommend the Barman Cloud *plugin*
instead; that migration is a `Cluster` edit you make when your operator version asks for it.

### Storage

`storage.driver=s3` is the default and is **required** with more than one FundRoom pod: two
server replicas, or any separate worker. `storage.driver=fs` stores documents on a
`PersistentVolumeClaim` at `/data`. The chart refuses to render fs unless `server.replicaCount=1`
and `worker.enabled=false`. It then switches the Deployment to the `Recreate` strategy, so a
ReadWriteOnce volume is never needed by two pods at once. The PVC is kept on `helm uninstall`.

## Upgrade

```sh
helm upgrade fundroom oci://ghcr.io/fundroomhq/charts/fundroom --version <new> \
  -n fundroom -f fundroom-values.yaml
```

Before upgrading, find out whether the new version changes the schema: run `migrate --dry-run`
with the **new** image, as described in
[docs/runbooks/install-and-upgrade.md](../../../docs/runbooks/install-and-upgrade.md). The result
decides what a rollback can mean (below).

The migrate Job runs before any pod is replaced. Migrations are expand/contract, so the old pods
keep working on the new schema while the rollout proceeds. The Job's own Secret carries only the
master key and `DATABASE_URL`. It runs with inert mail and storage drivers, because `migrate` sends
no mail and touches no files, so no SMTP, S3 or provider credentials are copied into it.

**If the Job fails**, the release stays on the old version. Hook resources are not removed by a
failed hook or by `helm uninstall`, so after reading the logs, delete them yourself; the next
attempt would otherwise replace them:

```sh
kubectl -n fundroom logs job/<fullname>-migrate
kubectl -n fundroom delete job,secret,configmap <fullname>-migrate
```

On success Helm deletes all three.

### Rollback

Migrations are forward-only. **The migration runner refuses a database that has migrations the
image does not carry** (`applied in the database but missing on disk`). So:

- If the upgrade applied **no** migrations (`pending: 0` in the dry run), `helm rollback` is a plain
  redeploy of the previous image.
- If it **did** apply migrations, `helm rollback` gives you pods that never become ready: they fail
  `/readyz` with `migrations: journal problems`, and `helm rollback` runs no migrate hook. A
  rollback across a schema change means restoring the database to the pre-upgrade backup and then
  deploying the previous version. The usual answer is to fix forward.

See [docs/runbooks/install-and-upgrade.md](../../../docs/runbooks/install-and-upgrade.md)
("Roll back") and [backup-and-restore.md](../../../docs/runbooks/backup-and-restore.md).

GitOps: nothing in the chart uses `lookup`, so `helm template`-based tools render it the same way
every time. Flux's helm-controller runs real installs and upgrades, so the hooks behave as
described above. Argo CD maps both hooks to `PreSync` and always renders as an install. With
`postgresql.mode=external` that is exactly right. With `postgresql.mode=cnpg`, set
`postgresql.cnpg.migrateOnStart=true`: `auto` relies on `.Release.IsInstall`, which is always
true there. With `true`, the pods migrate on start under the migration lock and no `PreSync` Job
waits for a database that does not exist yet. Alternatively, create the CloudNativePG `Cluster` as
its own application and use `postgresql.mode=external` with
`postgresql.external.existingSecret: <cluster>-app` and `existingSecretKey: uri`.

## Custom domains

The chart defaults to `CUSTOM_DOMAIN_DRIVER=manual`. FundRoom verifies that a workspace's custom
domain points at you (DNS, via DNS-over-HTTPS) and then leaves routing and certificates to you:
add the domain to `ingress.extraHosts`, and give it a certificate, for example a cert-manager
`Certificate` or a wildcard. The chart's Ingress configures TLS for the primary host only.

**Alternative: Caddy on-demand TLS.** If you want certificates issued automatically on the first
TLS handshake, as the Compose stack does, run Caddy in front of the Service instead of (or behind a
TCP load balancer next to) your ingress controller. Point it at `http://<fullname>:80`,
use the `ask` endpoint `http://<fullname>/internal/tls/ask`, and set `config.customDomains.driver=caddy-ask`. `deploy/caddy/Caddyfile` is the
reference configuration. Caddy needs persistent storage for its certificates (a PVC, or a
shared storage module when you run more than one Caddy replica).

**Alternative: Cloudflare for SaaS.** With the Service behind Cloudflare, set
`config.customDomains.driver=cloudflare-saas`, `config.customDomains.cnameTarget` to the proxied
hostname customers CNAME to, `CLOUDFLARE_ZONE_ID` in `config.extra` and `CLOUDFLARE_API_TOKEN` in
`secrets.extra`. Verified domains are registered with Cloudflare, which issues and serves their
certificates; nothing needs adding to `ingress.extraHosts` as long as Cloudflare's fallback origin
reaches the primary host's Service. Set `CLOUDFLARE_TRUSTED_PROXY: "on"` in `config.extra` so the
client address comes from `CF-Connecting-IP`, and only from Cloudflare's addresses
([`docs/runbooks/custom-domains.md`](../../../docs/runbooks/custom-domains.md#cloudflare-for-saas)).

**Edge forwarding.** Only for an edge (a Cloudflare Worker) in front of a platform that
routes by Host and overwrites `X-Forwarded-Host`; behind an ingress controller the real Host
already arrives, so a Helm install normally leaves these unset. The edge sends the customer hostname
and visitor IP in private headers, believed only when its `X-Fundroom-Edge` header carries the shared
secret: `FORWARDED_HOST_HEADER` (e.g. `X-Fundroom-Forwarded-Host`) and `FORWARDED_CLIENT_IP_HEADER`
(e.g. `X-Fundroom-Client-IP`) in `config.extra`, `EDGE_SHARED_SECRET` (32+ chars,
`openssl rand -hex 32`, same value at the edge) and, during a rotation only,
`EDGE_SHARED_SECRET_PREVIOUS` in `secrets.extra`. Both header names must start with `X-Fundroom-`
(the namespace the edge strips from inbound requests), and `config.clientIpHeader` may never be an
`X-Fundroom-*` header. Keep `config.trustProxy` on for direct traffic; not with `config.pathMounts`.

## Managed host (control plane)

The managed-host control plane has no dedicated values: it needs
`config.tenancyMode: multi`, and its keys go through `config.extra` / `secrets.extra`. Everything is
off by default.

```yaml
config:
  tenancyMode: multi
  extra:
    CONTROL_PLANE: "on"
    CELL_ID: "default"
    PLATFORM_OPERATOR_CIDRS: "203.0.113.0/24"
    BILLING_DRIVER: "stripe"          # none | manual | stripe
    SANCTIONS_DRIVER: "ofac"          # none | ofac | opensanctions
    CENTRAL_AUTH: "on"                # any tenancy mode; custom domains sign in via baseUrl
    SIGNUP_MODE: "open"               # self-service signup (needs SIGNUP_DEFAULT_PLAN)
    SIGNUP_DEFAULT_PLAN: "starter"
    SIGNUP_TERMS_VERSION: "1"         # raise when the terms at TERMS_URL change materially
    TERMS_URL: "https://www.example.com/terms"   # host footer links: any install, https only
    PRIVACY_URL: "https://www.example.com/privacy"
    SUPPORT_URL: "mailto:support@example.com"    # the only one that may be mailto:
    STATUS_URL: "https://status.example.com"
secrets:
  extra:
    STRIPE_SECRET_KEY: "rk_live_…"
    STRIPE_WEBHOOK_SECRET: "whsec_…"
```

`TERMS_URL`, `PRIVACY_URL`, `SUPPORT_URL` and `STATUS_URL` are not control-plane keys: any
install may set them in `config.extra`. Each one that is set is linked in the footer of the host's
own pages: the admin area, signup, setup, the operator console and sign-in on the canonical host. The
investor portal and a workspace host's sign-in pages show only Accessibility, because for investors
the tenant is the controller. Each must be an `https://` URL; only `SUPPORT_URL` may instead be a bare
`mailto:` address. With `SIGNUP_MODE: "open"`, set `TERMS_URL` (doctor warns otherwise): the signup
form links it next to the terms checkbox.

The migrate hook runs with `BILLING_DRIVER=none` and `CUSTOM_DOMAIN_DRIVER=manual`, because the
Stripe and Cloudflare credentials in `secrets.extra` never reach it. With `SANCTIONS_DRIVER=ofac` the
worker needs egress to `sanctionslistservice.ofac.treas.gov` and `*.amazonaws.com` (mind
`networkPolicy.egress`); the list is cached in each pod's `/data` scratch volume (an `emptyDir`
with S3 storage, so a replaced pod downloads it again; one snapshot is a few MiB). Grant
operators with `kubectl -n <ns> exec deploy/<fullname>-server -- /nodejs/bin/node /app/dist/cli.js
operator grant <email>` (after `operator enrol-link <email>` for someone with no passkey or TOTP yet).
`SANCTIONS_OPENSANCTIONS_API_KEY` goes in `secrets.extra`, and `SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS` in
`config.extra` if the key must reach a proxy rather than `api.opensanctions.org`. Runbooks: [control-plane](../../../docs/runbooks/control-plane.md),
[billing](../../../docs/runbooks/billing.md), [sanctions](../../../docs/runbooks/sanctions.md),
[central auth](../../../docs/runbooks/central-auth.md).

## AI assist

Off unless you configure a model (runbook [ai-assist](../../../docs/runbooks/ai-assist.md));
each workspace then opts in, and staff review every suggestion before it is saved. A model server
inside the cluster (Ollama, vLLM, llama.cpp) counts as self-hosted:

```yaml
config:
  extra:
    AI_PROVIDER: "openai-compatible"   # none | openai-compatible | anthropic
    AI_BASE_URL: "http://ollama.ai.svc.cluster.local:11434"
    AI_MODEL: "qwen3.5:9b"
secrets:
  extra:
    AI_API_KEY: ""                    # required with anthropic
```

A third-party OpenAI-compatible API also needs `AI_PROVIDER_LABEL` and `AI_PROVIDER_JURISDICTION`
(it is listed as a sub-processor). Allow the server and worker egress to the model host
(`networkPolicy.egress`).

## Evidence and authz depth

External audit anchoring (runbook [audit-anchoring](../../../docs/runbooks/audit-anchoring.md))
is off unless you list drivers; the pinned TSA certificates and the Rekor log key are public PEM
material and can go in `config.extra` as multi-line strings:

```yaml
config:
  extra:
    AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor"
    AUDIT_ANCHOR_TSA_URLS: "https://timestamp.sigstore.dev/api/v1/timestamp"
    AUDIT_ANCHOR_TSA_CERTS: |
      -----BEGIN CERTIFICATE-----
      …
    AUDIT_ANCHOR_REKOR_URL: "https://log2025-1.rekor.sigstore.dev"
    AUDIT_ANCHOR_REKOR_LOG_KEY: |
      -----BEGIN PUBLIC KEY-----
      …
```

An OpenFGA server you run can shadow (and later narrow) external access checks (runbook
[openfga](../../../docs/runbooks/openfga.md)); Postgres stays the source of truth:

```yaml
config:
  extra:
    AUTHZ_ENGINE: "openfga"
    AUTHZ_OPENFGA_URL: "http://openfga.authz.svc.cluster.local:8080"
    AUTHZ_OPENFGA_MODE: "shadow"         # shadow | enforce
secrets:
  extra:
    AUTHZ_OPENFGA_API_TOKEN: ""          # when the server requires a preshared key
```

Allow the server and worker egress to the TSA / Rekor / OpenFGA hosts (`networkPolicy.egress`).

## Data residency

One release is one cell, and one cell is one region: its database, its bucket, its backups and its
master key ring all have to live where you declare they do (the runbook is
[residency](../../../docs/runbooks/residency.md)). The product cannot check where they physically are,
so what tenants see is labelled as declared by the host.

```yaml
config:
  tenancyMode: multi
  extra:
    CONTROL_PLANE: "on"
    CELL_ID: "eu-1"
residency:
  region: eu
  regionLabel: "European Union (Frankfurt, Germany)"
  jurisdiction: eu
  backupLocation: "European Union (Frankfurt, Germany)"
  directory:                      # only for a host with cells in more than one region
    databaseUrl: "postgres://seedhost:…@directory.internal:5432/directory?sslmode=verify-full"
```

`residency.region` alone (no directory) is enough for a single-region install: tenants see the
region on **Settings → Data residency** and in the DPA template. A second region is a **second
release** (usually in another cluster) with its own `postgresql.*`, `storage.s3.*`, backups and
`secrets.secretKey`, its own `CELL_ID` and `config.baseUrl`, and the **same**
`residency.directory.databaseUrl`. The render refuses a directory without
`config.extra.CONTROL_PLANE: "on"`, `residency.region` and `residency.jurisdiction`, and (in
prod/staging) without `storage.driver: s3`. When `DIRECTORY_DATABASE_URL` lives in your own Secret,
set `residency.directory.existingSecret` to that Secret's name (even when it is
`secrets.existingSecret`): that is how the chart knows a directory is on. The migrate hook receives
the directory URL, because `fundroom migrate` also migrates the directory; with a directory it keeps
`STORAGE_DRIVER=s3` and gets placeholder S3 credentials (it never touches storage). An unreachable
directory does not fail the hook or the pods: its migrations are skipped (`migrate.directory.skipped`)
and retried by the worker. In prod/staging the directory URL must point at a private host or use
`sslmode=verify-full` (or `verify-ca`); `residency.directory.acceptUnverifiedTls` overrides that.
These keys are refused in `config.extra` / `secrets.extra`.

A workspace moving **into** this cell is downloaded by the worker to `<DATA_DIR>/moves/` before it is
imported (up to `residency.moves.maxBundleBytes`), and the source cell's worker writes the export
there first (ordinary workspace exports use `<DATA_DIR>/portability/`): size `dataScratchSizeLimit` (the `/data` emptyDir) above your
largest workspace export on both, or the worker is evicted mid-job. With
`networkPolicy.egress` set, allow the directory database and the other cells' object storage.

## Verifying the chart and image

Both are signed keylessly with cosign from GitHub Actions and carry SLSA build provenance.

```sh
# the chart (pushed by .github/workflows/chart-release.yml on tag chart-v<version>)
cosign verify ghcr.io/fundroomhq/charts/fundroom:0.1.0 \
  --certificate-identity-regexp '^https://github\.com/fundroomhq/fundroom/\.github/workflows/chart-release\.yml@refs/tags/chart-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/fundroomhq/charts/fundroom:0.1.0 --owner fundroomhq

# the image the chart deploys (appVersion; built by .github/workflows/image.yml)
cosign verify ghcr.io/fundroomhq/fundroom:<appVersion> \
  --certificate-identity-regexp '^https://github\.com/fundroomhq/fundroom/\.github/workflows/image\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/fundroomhq/fundroom:<appVersion> --owner fundroomhq
```

For production, pin the image by digest (`image.digest=sha256:…`) after verifying it.

## Values

`values.schema.json` rejects unknown keys, so a typo fails the install. The render also fails with
a message when a required combination is missing: no `config.baseUrl`; no master key; `fs`
storage with more than one pod; S3 without a bucket or credentials; no database; `MAIL_FROM` or
`SMTP_URL` missing in prod/staging; a cell directory without the control plane, a declared region and
jurisdiction, or S3 storage.

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/fundroomhq/fundroom` | The one image; server, worker and migrate differ only in args/env |
| `image.tag` | `""` (appVersion) | Image tag |
| `image.digest` | `""` | `sha256:…`; wins over the tag |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | |
| `config.baseUrl` | **required** | `BASE_URL`; https in prod/staging |
| `config.basePath` | `""` | `BASE_PATH` path mount; probes and the Ingress path follow it |
| `config.pathMounts` | `[]` | `PATH_MOUNTS`: public `origin + prefix` URLs a proxy on another site serves the portal under (`X-Forwarded-Prefix`), e.g. `[https://acme.com/investors]`; max 16, https in prod/staging, `tenancyMode: single` only |
| `config.appEnv` | `prod` | `APP_ENV` |
| `config.instanceName` | `FundRoom` | `INSTANCE_NAME` |
| `config.tenancyMode` | `single` | `TENANCY_MODE`: `single` or `multi` |
| `config.trustProxy` | `true` | `TRUST_PROXY` (as in the image) |
| `config.trustProxyHops` | `1` | `TRUST_PROXY_HOPS`: appending proxies in front of the pods; the client is that many `X-Forwarded-For` entries from the right. 1 fits ingress-nginx (default `use-forwarded-headers: false`) and Traefik; add one per appending CDN/LB in front |
| `config.clientIpHeader` | `""` | `CLIENT_IP_HEADER`: a single header your edge overwrites (`X-Real-IP` from ingress-nginx, `CF-Connecting-IP` behind Cloudflare); wins over hops |
| `config.logLevel` | `info` | `LOG_LEVEL` |
| `config.modules` | `""` (all) | `MODULES` |
| `config.mail.driver` | `smtp` | `MAILER_DRIVER`: smtp, resend, postmark, ses |
| `config.mail.from` / `fromName` | `""` | `MAIL_FROM` (required in prod/staging) / `MAIL_FROM_NAME` |
| `config.customDomains.driver` | `manual` | `CUSTOM_DOMAIN_DRIVER`: `manual`, `caddy-ask` or `cloudflare-saas` (see Custom domains) |
| `config.customDomains.cnameTarget` | `""` | `CUSTOM_DOMAIN_CNAME_TARGET` |
| `config.av.driver` / `clamdHost` | `noop` / `""` | `AV_DRIVER` / `CLAMD_HOST` (run ClamAV yourself) |
| `config.av.acceptUnscanned` | `false` | `AV_ACCEPT_UNSCANNED`; with `driver=noop` in prod/staging the render fails unless this is `true` |
| `config.metricsEnabled` | `auto` | `METRICS_ENABLED`: `auto` serves `/metrics` in prod/staging only with `secrets.metricsToken`; `true` there requires the token |
| `config.updateCheck` | `true` | `UPDATE_CHECK` |
| `config.otelExporterOtlpEndpoint` | `""` | `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `config.extra` | `{}` | Any other non-secret env key → value. Rendering fails for secret keys (`SECRET_KEYS` in `packages/config/src/schema.ts`, and any `*_FILE`); put those in `secrets.extra`. It also fails for keys the chart sets itself, such as `WORKER_CONCURRENCY`; use the dedicated value |
| `secrets.existingSecret` | `""` | Your Secret (see above); all other `secrets.*` must then be empty |
| `secrets.secretKey` | `""` | `FUNDROOM_SECRET_KEY` (this or `secretKeyRing` or `existingSecret` is required) |
| `secrets.secretKeyRing` | `""` | `SECRET_KEY_RING` |
| `secrets.setupToken` | `""` (derived) | `SETUP_TOKEN` |
| `secrets.smtpUrl` | `""` | `SMTP_URL` |
| `secrets.metricsToken` | `""` | `METRICS_TOKEN` (≥ 16 chars); scrape with `Authorization: Bearer <token>` |
| `secrets.extra` | `{}` | Any other secret env key → value; keys the chart sets itself are refused. Not given to the migrate Job |
| `storage.driver` | `s3` | `STORAGE_DRIVER`: `s3`, or `fs` for a single pod |
| `storage.s3.bucket` / `region` / `endpoint` | `""` | `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` (region or endpoint) |
| `storage.s3.forcePathStyle` | `false` | `S3_FORCE_PATH_STYLE` |
| `storage.s3.accessKeyId` / `secretAccessKey` | `""` | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (into the Secret) |
| `residency.region` / `regionLabel` / `jurisdiction` | `""` | `DATA_REGION` / `DATA_REGION_LABEL` / `DATA_REGION_JURISDICTION` (`eu`, `uk`, `ch`, `us`, `ca`, `au`, `other`): the region you declare this release's data lives in (see Data residency) |
| `residency.backupLocation` | `""` | `BACKUP_LOCATION`: where you declare this release's backups live |
| `residency.directory.databaseUrl` | `""` | `DIRECTORY_DATABASE_URL` (into the Secret and the migrate hook's Secret): the shared cell directory; empty = local mode |
| `residency.directory.existingSecret` / `existingSecretKey` | `""` / `DIRECTORY_DATABASE_URL` | Read `DIRECTORY_DATABASE_URL` from another Secret (may be `secrets.existingSecret`) |
| `residency.directory.poolMax` | `4` | `DIRECTORY_DATABASE_POOL_MAX` (rendered only with a directory) |
| `residency.directory.acceptUnverifiedTls` | `false` | `DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS`: in prod/staging the directory URL must be a private host or use `sslmode=verify-full`/`verify-ca`; `true` accepts it anyway |
| `residency.moves.sourceRetentionHours` / `maxBundleBytes` | `0` / `53687091200` | `MOVE_SOURCE_RETENTION_HOURS` / `MOVE_MAX_BUNDLE_BYTES` (rendered only with a directory) |
| `persistence.enabled` | `true` | fs only: PVC at `/data` (otherwise an emptyDir; trials only) |
| `persistence.existingClaim` / `storageClass` / `accessModes` / `size` / `annotations` | `""` / `""` / `[ReadWriteOnce]` / `20Gi` / `{}` | |
| `postgresql.mode` | `external` | `external` or `cnpg` |
| `postgresql.external.url` | `""` | `DATABASE_URL` |
| `postgresql.external.existingSecret` / `existingSecretKey` | `""` / `DATABASE_URL` | Read `DATABASE_URL` from another Secret |
| `postgresql.external.caSecret` / `caSecretKey` | `""` / `ca.crt` | Secret holding the database's CA, mounted at `/etc/seed-host/db-ca/ca.crt` in every pod (the migrate hook too); use it with `sslmode=verify-full&sslrootcert=/etc/seed-host/db-ca/ca.crt` |
| `postgresql.cnpg.instances` | `2` | |
| `postgresql.cnpg.imageName` | `""` (operator default) | e.g. `ghcr.io/cloudnative-pg/postgresql:18` |
| `postgresql.cnpg.migrateOnStart` | `auto` | `auto`, `true` or `false`; see CloudNativePG above |
| `postgresql.cnpg.database` / `owner` | `seedhost` / `seedhost` | |
| `postgresql.cnpg.grantMigratorPrivileges` | `true` | `ALTER ROLE <owner> CREATEROLE BYPASSRLS` after initdb |
| `postgresql.cnpg.postInitApplicationSQL` | `[]` | Extra SQL after initdb |
| `postgresql.cnpg.storage.size` / `storageClass` | `20Gi` / `""` | |
| `postgresql.cnpg.parameters` | `{}` | postgresql.conf parameters |
| `postgresql.cnpg.resources` | 250m/512Mi → 1/1Gi | |
| `postgresql.cnpg.backup.*` | disabled | `enabled`, `destinationPath`, `endpointURL`, `existingSecret`, `accessKeyIdKey`, `secretAccessKeyKey`, `retentionPolicy` (`30d`), `schedule` (`0 0 3 * * *`) |
| `server.replicaCount` | `2` | |
| `server.resources` | 250m/512Mi → 2/1536Mi | |
| `server.pdb.enabled` / `maxUnavailable` | `true` / `1` | |
| `server.terminationGracePeriodSeconds` | `30` | App drains for `SHUTDOWN_TIMEOUT_MS` (25 s) |
| `server.extraEnv` | `[]` | EnvVar objects |
| `server.podAnnotations` / `podLabels` / `nodeSelector` / `tolerations` / `affinity` / `topologySpreadConstraints` / `priorityClassName` | empty | Scheduling |
| `worker.enabled` | `true` | Separate worker Deployment |
| `worker.replicaCount` | `1` | |
| `worker.concurrency` | `5` | `WORKER_CONCURRENCY` |
| `worker.resources` | 250m/512Mi → 2/2Gi | |
| `worker.autoscaling.enabled` / `minReplicas` / `maxReplicas` / `targetCPUUtilizationPercentage` | `false` / `1` / `5` / `75` | CPU HPA |
| `worker.*` scheduling, `extraEnv`, `terminationGracePeriodSeconds` | as for server | |
| `migrate.backoffLimit` | `1` | |
| `migrate.activeDeadlineSeconds` | `900` | Includes waiting for the DB and the migration lock |
| `migrate.resources` | 100m/256Mi → 1/768Mi | |
| `migrate.extraEnv` / `podAnnotations` / `nodeSelector` / `tolerations` / `affinity` | empty | |
| `service.type` / `port` / `annotations` | `ClusterIP` / `80` / `{}` | |
| `ingress.enabled` | `false` | |
| `ingress.className` | `""` | `ingressClassName` |
| `ingress.clusterIssuer` | `""` | `cert-manager.io/cluster-issuer` |
| `ingress.host` | `""` (baseUrl host) | Primary host |
| `ingress.tls.enabled` / `secretName` | `true` / `<fullname>-tls` | TLS for the primary host only |
| `ingress.extraHosts` | `[]` | More hosts to the same Service, no TLS config here |
| `ingress.annotations` | `{}` | |
| `serviceAccount.create` / `name` / `annotations` | `true` / `""` / `{}` | Token never mounted |
| `networkPolicy.enabled` | `false` | Server: ingress only on its port; worker/migrate: no ingress |
| `networkPolicy.ingressFrom` / `metricsFrom` / `egress` | `[]` | Peers / peers / egress rules (empty egress = allow all) |
| `podSecurityContext` / `securityContext` | restricted, uid/gid 65532 | |
| `dataScratchSizeLimit` | `4Gi` | `/data` emptyDir size with S3 storage: workspace exports and inbound moves spool here, so keep it above your largest export |
| `tmpSizeLimit` | `1Gi` | `/tmp` emptyDir size |

## Troubleshooting

- **Server pods never become Ready.** `/readyz` checks the database, migrations, storage, mail,
  queue and renderer. Storage and mail must each pass once. Run
  `kubectl exec deploy/<fullname>-server -- /nodejs/bin/node /app/dist/cli.js doctor`, or
  port-forward and `curl localhost:8080/readyz` to see which check is failing. A mail relay the
  cluster cannot reach is the usual cause. Liveness uses `/healthz` only, so a dependency outage
  takes pods out of rotation instead of restarting them.
- **Install hangs on the migrate Job.** `kubectl logs job/<fullname>-migrate`. The usual
  causes are a wrong `DATABASE_URL`, a missing `existingSecret` (it must exist before the
  install), or a database user without `CREATE ROLE`.

## Development

`ci/*-values.yaml` are render fixtures, not examples. CI lints and renders each one, validates the
output with kubeconform (including the CloudNativePG CRDs) and scans it with Trivy.
