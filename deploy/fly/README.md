# FundRoom on Fly.io

`fly.toml` is generated from `deploy/platforms/source.mjs` (`pnpm gen:deploy`); do not edit it by
hand. One Fly app, two [process groups](https://fly.io/docs/launch/processes/) from the published
image:

- **`app`** — `serve --roles api,web`, behind `[http_service]` on port 3000 with a `/readyz` check.
- **`worker`** — `serve --roles worker`, no service, its own VM size.
- `[deploy] release_command = "migrate"` runs the migrations on a temporary Machine before each
  release; a failure stops the deploy.

`[processes]` and `release_command` replace the image's CMD and keep its ENTRYPOINT (the FundRoom
CLI), so they are plain CLI arguments. `[env]` is app-wide, which is why the roles are passed on
the command line rather than as `ROLES`.

No volumes: Fly volumes are per-Machine, and documents live in Tigris (Fly's S3-compatible object
storage, `STORAGE_DRIVER=s3`).

## Deploy

```sh
# 1. The app, from this config (do not deploy yet: secrets and the database come first).
fly launch --from https://github.com/fundroomhq/fundroom --copy-config --no-deploy
#    fly launch reads fly.toml from the repository root; with a fork, copy deploy/fly/fly.toml
#    there, or run `fly launch --config deploy/fly/fly.toml --no-deploy` from a checkout.

# 2. Postgres: Fly Managed Postgres, attached as DATABASE_URL.
fly mpg create --name fundroom-db --region <region>
fly mpg attach <cluster-id> -a <app>

# 3. Object storage: a Tigris bucket. Run it OUTSIDE the app directory (or without -a) so it
#    does not set AWS_* secrets on the app, then copy the printed keys into S3_* below.
fly storage create --name <bucket> --org <org>

# 4. Secrets (the generated list below), then deploy.
fly deploy
```

Then open `https://<app>.fly.dev`, and finish setup with the token you set as `SETUP_TOKEN`.
Keep a copy of `FUNDROOM_SECRET_KEY` outside Fly; a restored database is unreadable without it.

### Secrets

`--stage` stores them without restarting anything; the first `fly deploy` picks them up. Replace
the example values (bucket and keys from step 3, your SMTP account, your domain):

<!-- BEGIN GENERATED (pnpm gen:deploy; edit deploy/platforms/source.mjs) -->
```sh
fly secrets set --stage \
  BASE_URL="https://<app>.fly.dev" \
  FUNDROOM_SECRET_KEY="$(openssl rand -base64 32)" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  SETUP_TOKEN="$(openssl rand -hex 16)" \
  METRICS_TOKEN="$(openssl rand -hex 24)" \
  S3_BUCKET="fundroom-documents" \
  S3_ACCESS_KEY_ID="<s3_access_key_id>" \
  S3_SECRET_ACCESS_KEY="<s3_secret_access_key>" \
  SMTP_URL="smtps://user:pass@smtp.example.com:465" \
  MAIL_FROM="investors@example.com"
```

Set in `fly.toml` `[env]` (not secret): `APP_ENV=prod`, `MIGRATE_ON_START=false`, `TRUST_PROXY=true`, `CLIENT_IP_HEADER=Fly-Client-IP`, `TENANCY_MODE=single`, `CUSTOM_DOMAIN_DRIVER=manual`, `ROBOTS=noindex`, `LOG_LEVEL=info`, `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://fly.storage.tigris.dev`, `S3_REGION=auto`, `AV_ACCEPT_UNSCANNED=true`, `MAILER_DRIVER=smtp`.

`DATABASE_URL` comes from `fly mpg attach`.

**Upgrading from a pre-FundRoom template (renamed variables):**

- `FUNDROOM_SECRET_KEY` was `SEEDHOST_SECRET_KEY`. An existing app keeps working on `SEEDHOST_SECRET_KEY` (`fundroom doctor` warns). Upgrade the image first and rename after: an image from before the rename reads only `SEEDHOST_SECRET_KEY` and, without it, generates a new key (data written meanwhile is lost to the real key). Both names holding the same value are accepted (`fundroom doctor` warns); different values refuse to start, naming both by key fingerprint. Once the new image is deployed, set `FUNDROOM_SECRET_KEY` to the same value (from your backup, or `fly ssh console -C 'printenv SEEDHOST_SECRET_KEY'`: Fly cannot show a secret) with `fly secrets set`; `fly secrets unset SEEDHOST_SECRET_KEY` only when you will not roll back to an older image.
<!-- END GENERATED -->

## Things to know

- **The Tigris secrets.** `fly storage create` inside an app context sets `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` and `BUCKET_NAME` on the app. FundRoom reads
  `S3_*`; the `AWS_*` names belong to the SES mail driver. If they were set, remove them:
  `fly secrets unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 BUCKET_NAME`.
- **Managed Postgres pooling.** `fly mpg attach` hands out the PgBouncer URL. Keep the cluster's
  pool mode at *Session* (the default): the migration runner holds a session-level advisory lock,
  which transaction pooling would break. If you switch to *Transaction* mode, set the release
  command's database to the direct URL instead.
- **`--roles`.** `serve --roles <csv>` overrides `ROLES` for that process (the per-process
  environment Fly does not have). An image older than that flag ignores it and both groups run
  every role: still correct, only wasteful (two job consumers).
- **Scaling.** `fly scale count app=2 worker=1`. Both groups share the database and bucket, so the
  web group scales horizontally; `min_machines_running = 1` and `auto_stop_machines = "off"` keep
  the portal warm — set `auto_stop_machines = "stop"` in the generator for a cheaper, cold-starting
  install.
- **Custom domains.** `CUSTOM_DOMAIN_DRIVER=manual`: `fly certs add <domain>` for each verified
  customer domain; FundRoom verifies DNS.
- **Upgrades.** `[build] image` names `latest`; pin a version tag for production
  (`fly deploy --image ghcr.io/fundroomhq/fundroom:<version>`). The release command migrates
  first.
