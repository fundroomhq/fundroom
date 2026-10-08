# Runbook: back up and restore

An install is three things, and a backup is only complete when it has all three: the **Postgres database**, the **file storage** (the `/data` volume or the S3 bucket that holds every document), and the **master key** that the documents' encryption keys are wrapped under. This runbook is for whoever operates the install. It covers the backup tiers the project ships, turning on point-in-time recovery for the Compose stack, checking that backups are actually happening, the monthly restore drill, restoring in place to a point in time, restoring onto a new host, and what no database backup can give you back.

Reference material: the overlay itself is `deploy/compose/compose.backup.yaml`, with `deploy/pgbackrest/` and `deploy/docker/postgres-pgbackrest.Dockerfile`, and its comments are part of this runbook.

## What has to be true first

- **You have a copy of the master key that does not live on this install.** That is `FUNDROOM_SECRET_KEY` or `SECRET_KEY_RING` from your environment or secret store, or, on a default Compose install, the file `/data/secret.key` that the first start generated. Without it every restore below produces a database whose documents cannot be opened — see "What a database backup does not cover". Print a generated key once and store it with your other secrets:

  ```
  docker compose exec app /nodejs/bin/node -e "process.stdout.write(require('fs').readFileSync('/data/secret.key','utf8'))"
  ```

- **You run the Compose commands from `deploy/compose/`**, where `.env` lives. Every command in the Tier 1 sections uses both files; set this once in your shell:

  ```
  C="docker compose -f compose.yaml -f compose.backup.yaml"
  ```

  Add `-p <project>` to it if you run the stack under a project name.
- **Backups go somewhere other than this host.** A backup on the same disk as the database survives a bad migration and nothing else.

## The tiers

| Tier | What | RPO / RTO target | Where |
|---|---|---|---|
| **0** | Nightly logical dump (`pg_dump`, gzip) of the database into the `backups` volume | 24 h / 1 h | `compose.yaml`, profile `backup` |
| **1** | pgBackRest: continuous WAL archiving plus weekly full and daily differential backups, **point-in-time recovery** to any second in the retention window | about a minute / 1 h | `compose.backup.yaml` overlay (this runbook) |
| **2** | Managed PITR: CloudNativePG on Kubernetes, or your provider's (RDS, Cloud SQL, Neon, …) | provider's | [`deploy/helm/fundroom/README.md`](../../deploy/helm/fundroom/README.md) (`postgresql.cnpg.backup.*`); "Tier 2" below |

Use Tier 1 for any Compose install that holds real investor data. Tier 0 still works alongside it and is a convenient second, independent copy in a format any Postgres can read.

`BACKUP_BEFORE_MIGRATE` exists in the configuration schema and **does nothing yet**: no backup is taken before migrations. Take one by hand before an upgrade (see "Take a backup now").

## Tier 1: turn on pgBackRest

**Decide the repository and encryption before the first start.** The cipher settings are fixed when pgBackRest creates its *stanza* on first start; they cannot be changed afterwards without starting a new repository, and losing the passphrase loses every backup in it.

1. **Choose where backups go** in `deploy/compose/.env`:
   - **Default: the `pgbackrest` named volume** on this host (`PGBACKREST_REPO1_TYPE` unset = `posix`). Only acceptable if you ship that volume off the host yourself.
   - **Recommended: S3 or anything S3-compatible**:

     ```
     PGBACKREST_REPO1_TYPE=s3
     PGBACKREST_REPO1_S3_BUCKET=acme-fundroom-pg
     PGBACKREST_REPO1_S3_ENDPOINT=s3.eu-west-1.amazonaws.com
     PGBACKREST_REPO1_S3_REGION=eu-west-1
     PGBACKREST_REPO1_S3_KEY=…
     PGBACKREST_REPO1_S3_KEY_SECRET=…
     ```

     For MinIO, SeaweedFS, Garage or R2 add `PGBACKREST_REPO1_S3_URI_STYLE=path`. `PGBACKREST_REPO1_PATH` is the key prefix inside the bucket. Use a bucket of its own, with credentials that can write only there. The S3 settings are not checked until the sidecar's first `stanza-create`, so read its log (step 4).
2. **Encrypt the repository**:

   ```
   PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc
   PGBACKREST_REPO1_CIPHER_PASS=<openssl rand -base64 48>
   ```

   (or `PGBACKREST_REPO1_CIPHER_PASS_FILE` pointing at a mounted secret; `PGBACKREST_REPO1_S3_KEY_FILE` and `…_S3_KEY_SECRET_FILE` work the same way). Store the passphrase with the master key: a restore needs both.
3. **Retention**: `PGBACKREST_REPO1_RETENTION_FULL` full backups are kept (default `4`, one a week, so four weeks), plus all WAL needed to reach any point since the oldest. **Schedule**: `BACKUP_TIME` (UTC, default `02:30`) daily; a full backup on `BACKUP_FULL_WEEKDAY` (1 = Monday … 7 = Sunday, default `7`), a differential on the other days. `PG_ARCHIVE_TIMEOUT` (default `60` seconds) forces a WAL segment out at least that often, which is what bounds how much a restore can lose on a quiet database.
4. **Start it:**

   ```
   $C up -d
   ```

   This builds the Postgres-plus-pgBackRest image locally the first time (`fundroom-local/postgres-pgbackrest:18-2.59.1`; it is never pulled or pushed), restarts `db` with WAL archiving on, and starts the `pgbackrest` sidecar. The sidecar creates the stanza, runs `check` (which forces a WAL switch and waits for it to reach the repository — a broken `archive_command` fails here, loudly), and takes a first full backup when the repository is empty, so point-in-time recovery works from today rather than from next Sunday. Watch it:

   ```
   $C logs -f pgbackrest
   ```

   `ready: full on weekday 7, differential on other days, at 02:30 UTC` is the line you want. From now on, always start the stack with both files; a plain `docker compose up -d` puts `db` back on the stock image with archiving off.

## Is it working?

**1. Is the sidecar healthy?**

```
$C ps pgbackrest
```

`healthy` means the stanza checked out at start, the most recent scheduled backup did not fail, and WAL archiving is working. `unhealthy` means one of the three: read `$C logs pgbackrest` for `ERROR: scheduled … backup failed`, a failed `stanza-create` / `check`, or `ERROR: WAL archiving is failing` — the last one has its own section below. A failed scheduled backup is not retried until the next day's `BACKUP_TIME`; take one by hand once the cause is fixed.

**2. What is in the repository?**

```
$C exec pgbackrest pgbackrest info
```

Lists each backup (full, diff, incr) with its timestamp and size, and the WAL range archived. The newest backup should be no older than a day, and the WAL range should end within a minute or two of now. A WAL range that stopped hours ago while backups continue means archiving is broken: the database's own log says why (`$C logs db | grep -i archive`).

**3. Does the whole path work end to end?**

```
$C exec pgbackrest pgbackrest check
```

Forces a WAL switch and confirms it lands in the repository. Exit 0 and no `ERROR` is the answer.

Put questions 1 and 2 into your monitoring: the container's health status, and the age of the newest backup in `pgbackrest --output=json info`. **Nothing alerts on container health by default** — Docker records it and does nothing else — so have your monitoring read it:

```
docker inspect --format '{{.State.Health.Status}}' "$($C ps -q pgbackrest)"
```

### Take a backup now

Before an upgrade, before a risky manual change, or after fixing a failed night:

```
$C exec pgbackrest pgbackrest --stanza=seedhost backup --type=full
```

(`--type=diff` or `--type=incr` for a faster one on top of the last full.) Expiry of old backups runs after every backup according to the retention setting.

## The pgbackrest sidecar is unhealthy / WAL archiving failed

Backups are only half of point-in-time recovery; the other half is the continuous stream of WAL that Postgres pushes to the repository (`archive_command`). If that stream stops, you can still restore last night's backup, but not "a minute ago". The sidecar watches it:

- Every `BACKUP_ARCHIVE_CHECK_INTERVAL` seconds (default 60) it reads `pg_stat_archiver` — archiving is failing when the last failure is newer than the last success — and runs a read-only probe of the repository (`pgbackrest repo-ls archive/seedhost`). Two checks, because with `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX` set, pgBackRest reports segments it *dropped* as archived and `pg_stat_archiver` stays green; the repository probe still fails.
- While a failure is younger than `BACKUP_ARCHIVE_GRACE` seconds (default 300 — the RPO) it logs `WARN`. Past the grace it writes `/tmp/pgbackrest-archive-failed`, the container turns **unhealthy**, and it logs `ERROR: WAL archiving is failing` on every check. When archiving works again it logs `WAL archiving recovered` and the container turns healthy on its own.
- Worst case from the first failure to `unhealthy` is about grace + interval + 60 s — roughly seven minutes at the defaults. The checks pause while a scheduled backup runs.

What an outage does to the database depends on `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX`:

| `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX` | While the repository is unreachable | Afterwards |
|---|---|---|
| unset (the default) | Postgres keeps every WAL segment it could not archive in `pg_wal` on the `pgdata` volume. **Nothing is lost**, but the volume fills; when it is full, Postgres stops. | Archiving catches up by itself once the cause is fixed. |
| set, e.g. `4GiB` | Past the limit, pgBackRest **drops** WAL instead of queueing it (`WARN: dropped WAL file '…' because archive queue exceeded …` in the db log). The database stays up. | Point-in-time recovery has a **gap** across the dropped WAL until the next full backup. Take one at once. |

Choose deliberately: unset protects the recovery history at the cost of availability; set protects availability at the cost of a gap. Either way, the alert is what gives you time to act.

**1. Is it archiving, or the sidecar itself, that is failing?**

```
$C ps pgbackrest
$C logs pgbackrest | grep -E "ERROR|WARN|recovered"
```

`ERROR: WAL archiving is failing` (with the reason from the check that tripped: `pg_stat_archiver` or the repository probe) is this section. `ERROR: scheduled … backup failed` or a failed `stanza-create` / `check` at start is "Is it working?" above.

**2. What does Postgres say about the push?**

```
$C logs db | grep -E "archive command failed|P00 +ERROR|dropped WAL file"
$C exec db psql -U seedhost -d seedhost -c "SELECT * FROM pg_stat_archiver;"
```

The `P00 ERROR` lines carry pgBackRest's own error — an S3 `403` (credentials, bucket policy), a DNS or connection failure (endpoint, network), a permissions error on a `posix` repository, a full repository disk. `pg_stat_archiver` shows the last segment archived, the last one that failed, and when.

**3. How much WAL is waiting?**

```
$C exec db sh -c 'ls /var/lib/postgresql/18/docker/pg_wal/archive_status | grep -c ready'
```

Each `ready` file is one 16 MB segment not yet archived. Compare the total with the free space on the volume behind `pgdata` (`df -h` on the host); with the queue limit unset, that free space is how long you have before Postgres stops.

**4. Was anything dropped?** Only possible with `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX` set: the `dropped WAL file` lines from question 2. If there are any, the recovery window has a hole from the first dropped segment until the next full backup.

**Fix and confirm.** Fix the cause — the S3 credentials, the bucket permissions, the repository disk. Archiving resumes on its own; nothing needs restarting. Then:

```
$C exec pgbackrest pgbackrest check
```

must exit 0, the sidecar logs `WAL archiving recovered`, and `$C ps pgbackrest` returns to `healthy` within a check interval. **If question 4 found any dropped WAL**, take a full backup immediately — it is the new start of an unbroken recovery window:

```
$C exec pgbackrest pgbackrest --type=full backup
```

## The monthly restore drill

A backup you have never restored is a hope. Once a month, restore into a scratch Postgres next to production — production stays up — and look at the data.

The restore services reuse the locally built `fundroom-local/postgres-pgbackrest` image and never pull or build it (`pull_policy: never`). Since the FundRoom rename that tag is new, so on a host upgraded from an older release run `$C build db` (or `$C up -d`) once before the first restore, or `run` fails with "image not found".

1. **Pick a target time** a few minutes in the past, with its zone, e.g. `2026-09-23 18:17:41+00`. (Leave out `--type` and `--target` to restore the latest state instead.)
2. **Restore into the scratch volume:**

   ```
   $C --profile restore run --rm pgbackrest-restore restore --pg1-path=/var/lib/pgrestore/18/docker --type=time "--target=2026-09-23 18:17:41+00" --target-action=promote --archive-mode=off
   ```

   `--pg1-path` must be exactly that path: it is where the `pg-drill` container's `PGDATA` points. `--archive-mode=off` — together with `pg-drill` running with `archive_mode=off` — is what stops the drill from pushing a second timeline into the production repository. Leave both in.
3. **Start the scratch Postgres** and let it replay WAL to the target:

   ```
   $C --profile restore up -d --wait pg-drill
   $C logs pg-drill | grep -E "recovery stopping|archive recovery complete"
   ```

4. **Look at the data.** Something you can compare with production and with what you know happened around the target time:

   ```
   $C exec pg-drill psql -U seedhost -d seedhost -c "SELECT slug, created_at FROM core.workspace ORDER BY created_at;"
   $C exec pg-drill psql -U seedhost -d seedhost -c "SELECT count(*), max(created_at) FROM core.outbox;"
   ```

   A `max(created_at)` just before your target is the proof that point-in-time recovery, not just the last base backup, worked.
5. **Throw it away:**

   ```
   $C --profile restore rm -fsv pg-drill
   docker volume rm <project>_pgrestore
   ```

   (`<project>` is `seed-host` unless you set another with `-p`; `docker volume ls | grep pgrestore` shows the name.)

Write down the date, the target, how long steps 2–3 took (that is your real restore time for this database size) and what you checked. Once a quarter, extend the drill to the files and the key: open one restored document through a scratch app, which is the only test that proves all three parts of the backup fit together.

## Restore in place to a point in time

For "the data went wrong at 14:05 and we want it back as it was at 14:04" — a bad bulk import, a destructive mistake, a compromised account that deleted things. Everything after the target is lost from the database, so be sure of the target: read the audit log (`/admin/audit`) for the exact time of the event first.

1. **Stop everything that talks to the database**, and the database itself — pgBackRest refuses to restore into a data directory whose Postgres is running:

   ```
   $C stop caddy app worker pgbackrest db
   ```

2. **Restore**, reusing the files that did not change (`--delta`):

   ```
   $C --profile restore run --rm pgbackrest-restore restore --delta --type=time "--target=2026-09-23 14:04:00+00" --target-action=promote
   ```

3. **Start the database and the sidecar** and confirm Postgres finished recovery on a new timeline:

   ```
   $C up -d --wait db pgbackrest
   $C exec db psql -U seedhost -d seedhost -c "SELECT pg_is_in_recovery(), timeline_id FROM pg_control_checkpoint();"
   ```

   `f` and a timeline one higher than before.
4. **Take a full backup at once** — the old backups belong to the old timeline, and this one is the base every later restore will want:

   ```
   $C exec pgbackrest pgbackrest --type=full backup
   ```

5. **Before starting the app, decide about the job queue.** The job queue is in the database, so it went back in time too. Work that ran after the target — an investor update's sends, notifications, erasure steps — is queued again as it was at the target, and **will run again**, sending those emails a second time. If that matters, start the app with the worker off (`WORKER_MODE=off` in `.env`), look at what is queued:

   ```
   docker compose exec db psql -U seedhost -d seedhost -c "
     SELECT name, count(*), min(created_on) FROM pgboss.job
      WHERE state IN ('created','retry') GROUP BY 1 ORDER BY 2 DESC;"
   ```

   and decide with the workspace owner before turning the worker back on ([queue-backlog.md](queue-backlog.md)).
6. **Start the rest:**

   ```
   $C up -d
   ```

   `migrate` runs first and is a no-op unless the target predates an upgrade.

Then, because the database now says things that are no longer true:

- **Sessions revoked after the target are live again**, and so are memberships revoked after it. If the restore follows an incident, revoke again ([incident-response.md](incident-response.md)).
- **Erasures completed after the target are undone.** Re-run them; the list is in the erasure requests you have outside the database (emails, tickets) — the database's own record of them went back in time too.
- **Files uploaded after the target** are still in storage but no longer referenced. The data room's weekly reconcile (Sundays 03:50 UTC) deletes unreferenced objects older than 24 hours, so they disappear on their own; copy them out first if anyone needs them.

## Restore onto a new host

The same restore, into an empty data directory, on a machine that has never run this install.

1. **Bring the three parts together** on the new host: the repository (the `pgbackrest` volume copied across, or the same S3 settings), the cipher passphrase, and the master key.
2. **Configure before starting anything**: copy `deploy/compose/.env` with the same `PGBACKREST_*` settings and the same `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING`. If the old install used a generated key, put the saved value in `FUNDROOM_SECRET_KEY` — otherwise the new install's first start generates a **different** key into its fresh `/data` volume.
3. **Restore files first** — the `data` volume contents (`/data/storage` for `STORAGE_DRIVER=fs`), or point `S3_*` at the existing bucket.
4. **Restore the database** into the new, empty `pgdata` volume. Build the image and create the volumes without starting Postgres, then restore (no `--delta`: there is nothing to reuse):

   ```
   $C build db
   $C --profile restore run --rm pgbackrest-restore restore
   ```

   Add `--type=time "--target=…" --target-action=promote` for a point in time; leave them out for the latest state.
5. **Start** in the order of the in-place restore, steps 3–6: `db` and `pgbackrest`, a full backup, a look at the queue, then everything.
6. **Point DNS at the new host** last, and let Caddy obtain certificates ([acme-failures.md](acme-failures.md)).

## What a database backup does not cover

**File storage.** pgBackRest and `pg_dump` copy the database only. Every document, rendition, export and piece of evidence lives in object storage:

- `STORAGE_DRIVER=fs` (the Compose default): the `data` volume, under `/data/storage`. Back up the volume — a nightly snapshot or `restic`/`borg` of the Docker volume's directory. It also holds `/data/secret.key` on a default install, which is exactly why that copy must be protected like the key it is.
- `STORAGE_DRIVER=s3`: turn on **bucket versioning** and a lifecycle rule for old versions, and replicate to a second bucket or region — inside the region you declared, when you declare one (next section).

Take the file backup **no earlier** than the database target you are likely to restore to. Files newer than the database are harmless (unreferenced, and reconciled away); a database newer than its files points at documents that do not exist, which the reconcile marks as `error` ("object missing from storage").

**The master key.** Documents are encrypted with per-workspace data keys, and those keys are stored in the database *wrapped* under the master key ring. A restored database with a different or missing key boots — config only needs *a* key — and then fails every operation that touches a workspace's keys with `no key "v1" in the ring` or `wrapped data key could not be unwrapped`. The workspace's existing key rows block new ones from being created, so this does not heal. Specifically, without the original key:

| Unrecoverable | Because |
|---|---|
| Every data-room document, rendition and thumbnail; click-wrap certificates; accreditation evidence; workspace exports stored on the install | Encrypted under workspace data keys the new key cannot unwrap |
| Sending-domain DKIM private keys, spreadsheet service-account credentials, chat webhook URLs | Encrypted under the same data keys; the integrations must be set up again |
| The mail suppression list — and with it, sending | Stored as hashes keyed by the data keys. Every lookup needs to unwrap a key it cannot, so sends that check the list **fail** rather than go out; the list itself cannot be read back |
| Unsubscribe links and chart images in emails already sent | Their tokens are keyed by the data keys; they stop working |
| TOTP for everyone; recovery codes; share-link passcodes | Sealed or hashed under the ring itself; people must re-enrol and passcodes must be reset |
| Verifying audit checkpoints | Their signatures are keyed by the ring; `audit verify` reports every checkpoint as failing. The hash chain itself still verifies. |

What survives without the key: every row that is not encrypted — workspaces, people and their email addresses, grants, groups, the audit log's contents, analytics, legal acceptances — plus sessions, passkeys and passwords (none depend on the key), and custom domains. Export bundles already handed out still verify with the public key recorded when they were made.

There is no recovery path for the rows in the first table. Keep the key, and every retired key still in the ring, wherever you keep the backups' own credentials — and not only there.

## Backups per region

When an install declares where its data lives (`DATA_REGION`, [residency.md](residency.md)), its backups
are part of that statement: a database kept in Frankfurt whose backups are replicated to Virginia is not
kept in the EU. Tenants are shown the backup location you declare in `BACKUP_LOCATION` (for example
`European Union (Frankfurt, Germany)`) next to the region, on **Settings → Data residency** and in the DPA
template's data-location annex. The product cannot check it, so keep it true:

- **Each cell backs up to its own region.** The pgBackRest repository (`PGBACKREST_REPO1_S3_REGION` /
  `…_S3_ENDPOINT`), the CloudNativePG `destinationPath`, or your provider's backup region, the bucket's
  versioning and replication target, and the copy of the master key all stay in the cell's region (or in
  a second region inside the same jurisdiction, and say so in `BACKUP_LOCATION`). A provider's
  "cross-region replica" or "cross-region backup copy" default is the usual way this breaks.
- **Each cell has its own repository, passphrase and master key.** Never point two cells at one
  pgBackRest repository or bucket prefix: a restore of one would bring back the other's tenants.
- **Restore a cell's backup only into its own region.** A restored database keeps its cells' region
  (a declared region never changes); a server whose `DATA_REGION` differs refuses to start in production.
  Moving data to another region is a workspace move, not a restore.
- **Restoring one cell is independent of the others**, with one exception: the shared directory database
  (it holds no personal data and is backed up on its own, see [residency.md](residency.md#the-directory-database)).
  After restoring a cell to an earlier point, its reconcile sweep re-publishes its workspaces within
  10 minutes; check moves that were in flight at the restore point with `fundroom move list` on both cells.

## Tier 0: the nightly `pg_dump`

The `backup` profile runs `prodrigestivill/postgres-backup-local`, which dumps the `seedhost` database daily with `pg_dump` (plain SQL, gzip) into the `backups` volume and keeps 14 daily, 8 weekly and 6 monthly dumps.

```
docker compose --profile backup up -d
```

**1. Is it producing dumps?**

```
docker compose --profile backup logs backup | tail -n 20
docker compose --profile backup exec backup ls -l /backups/last /backups/daily
```

Per the image's documentation, `last/` holds every run as `seedhost-YYYYMMDD-HHmmss.sql.gz`, `daily/`, `weekly/` and `monthly/` hold one per period, and each directory has a `seedhost-latest.sql.gz` link. The reference stack runs `prodrigestivill/postgres-backup-local:18` against Postgres 18, and that pairing has been checked to write a dump. Keep the two in step when you change either: `pg_dump` refuses to dump a server of a newer major version, and the log then says `server version mismatch` while no file appears.

**2. Restore a dump.** A plain dump restores into an **empty** database, so this replaces the database wholesale — there is no point in time other than the dump's own.

```
docker compose stop caddy app worker
docker compose exec db psql -U seedhost -d postgres -c "DROP DATABASE seedhost WITH (FORCE);" -c "CREATE DATABASE seedhost OWNER seedhost;"
docker compose --profile backup exec backup sh -c 'zcat /backups/last/seedhost-latest.sql.gz | PGPASSWORD="$POSTGRES_PASSWORD" psql -h db -U seedhost -d seedhost -v ON_ERROR_STOP=1 -q'
docker compose up -d
```

Use a specific file from `daily/` or `weekly/` instead of `-latest` for an older state. On a **new** Postgres cluster (a new host, a managed database), create the app role before loading, because `pg_dump` dumps one database and not the cluster's roles:

```
CREATE ROLE seedhost_app NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT seedhost_app TO seedhost;
```

**A dump taken before data-room migration 0008** (`0008_dump_safe_location_triggers`) stops with `operator does not exist: public.ltree = public.ltree` at `CREATE CONSTRAINT TRIGGER document_location_acl`. Those older databases still had data-room 0006's triggers, whose condition `pg_dump` cannot write in a form that restores under the empty `search_path` every dump sets. Restore such a dump with that one line changed to `public`. The app then applies 0008 on its next start as usual:

```
docker compose --profile backup exec -T backup zcat /backups/daily/<file>.sql.gz \
  | sed "s/set_config('search_path', '', false)/set_config('search_path', 'public', false)/" \
  | docker compose exec -T db psql -U seedhost -d seedhost -v ON_ERROR_STOP=1 -q
```

For a custom-format dump (`pg_dump -Fc`), turn it into a script first (`pg_restore -f - <file>`), then pipe it through the same `sed`. Dumps taken after 0008 restore unchanged.

If you already restored such a dump **without** `ON_ERROR_STOP` (or `pg_restore` without `--exit-on-error`), the restore carried on past that error. The database then lacks the two data-room triggers that bump access versions when a folder or document moves. Check with:

```
docker compose exec db psql -U seedhost -d seedhost -c "SELECT tgname FROM pg_trigger WHERE tgname IN ('document_location_acl', 'folder_location_acl');"
```

Both names should be listed. If they are missing, run `fundroom migrate`, or start the app, with a release that includes 0008. The restored database's migration journal comes from the old dump, so 0008 is still pending there, and applying it recreates both triggers. Check the restore's output for any other error as well, because nothing else is expected to fail. `apps/server/src/dump-restore.integration.test.ts` checks that on every module's migrations.

Everything in "What a database backup does not cover" and the queue warning in step 5 of the in-place restore apply to a dump restore too. The dumps are **not encrypted** by the image; the volume they sit in, and wherever you copy it, must be.

## Tier 2: CloudNativePG

With the Helm chart's `postgresql.mode=cnpg` and `postgresql.cnpg.backup.enabled=true`, the operator archives WAL and takes a daily base backup to the object store in `destinationPath` (configuration: [`deploy/helm/fundroom/README.md`](../../deploy/helm/fundroom/README.md)). Check it with `kubectl get backups.postgresql.cnpg.io` and the `Cluster`'s status (`kubectl describe cluster <release>-pg`), or `kubectl cnpg status <release>-pg` with the operator's plugin. An on-demand backup is a `Backup` resource naming the cluster, or `kubectl cnpg backup <release>-pg`.

The chart has no restore switch: CloudNativePG restores by bootstrapping a **new** `Cluster` from the object store, and you point the release at it. In outline — the CloudNativePG recovery documentation is authoritative for your operator version:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: fundroom-restored
spec:
  instances: 2
  storage:
    size: 20Gi
  bootstrap:
    recovery:
      source: origin
      database: seedhost
      owner: seedhost
      recoveryTarget:
        targetTime: "2026-09-23 14:04:00+00"   # omit recoveryTarget for the latest state
  externalClusters:
    - name: origin
      barmanObjectStore:
        destinationPath: s3://acme-fundroom-pg/pg   # the release's postgresql.cnpg.backup.destinationPath
        serverName: <release>-pg                    # the original cluster's name
        s3Credentials:
          accessKeyId: { name: <backup secret>, key: access-key-id }
          secretAccessKey: { name: <backup secret>, key: secret-access-key }
        wal:
          compression: gzip
```

When it is ready, upgrade the release with `postgresql.mode=external` and `postgresql.external.existingSecret=fundroom-restored-app`, `postgresql.external.existingSecretKey=uri`. The role attributes the chart granted (`CREATEROLE BYPASSRLS`) are part of the restored data. Give the new cluster its own `backup` section before relying on it, and remember the job-queue and session warnings from the in-place restore apply here too. A managed database (RDS, Cloud SQL, …) restores the same way: the provider creates a new instance at a point in time, and you change `DATABASE_URL`.

This section is written from the chart and the operator's API; it has not been exercised against a live cluster.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `PGBACKREST_REPO1_TYPE` | `db`, `pgbackrest` | `posix` (the `pgbackrest` volume) |
| `PGBACKREST_REPO1_PATH` | same | `/var/lib/pgbackrest` (the key prefix, for S3) |
| `PGBACKREST_REPO1_S3_BUCKET`, `…_S3_ENDPOINT`, `…_S3_REGION`, `…_S3_KEY`, `…_S3_KEY_SECRET`, `…_S3_URI_STYLE` | same | unset; `_KEY` and `_KEY_SECRET` also accept `_FILE` |
| `PGBACKREST_REPO1_CIPHER_TYPE` / `…_CIPHER_PASS` | same | `none` / unset (`_FILE` accepted); **fixed at stanza creation** |
| `PGBACKREST_REPO1_RETENTION_FULL` | same | `4` |
| `PGBACKREST_COMPRESS_TYPE` / `PGBACKREST_PROCESS_MAX` | same | `zst` / `2` |
| `BACKUP_TIME` / `BACKUP_FULL_WEEKDAY` / `BACKUP_INITIAL_FULL` | `pgbackrest` | `02:30` UTC / `7` (Sunday) / `true` |
| `PG_ARCHIVE_TIMEOUT` | `db` | `60` seconds |
| `BACKUP_ARCHIVE_CHECK_INTERVAL` | `pgbackrest` | `60` seconds between WAL-archiving checks |
| `BACKUP_ARCHIVE_GRACE` | `pgbackrest` | `300` seconds of failed archiving before the sidecar turns unhealthy |
| `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX` | `db` | unset — WAL is never dropped, and a dead repository eventually fills the `pgdata` volume; set it (e.g. `4GiB`) to drop WAL past that size instead |
| `BACKUP_BEFORE_MIGRATE` | app | `false`; not implemented |
| `BACKUP_LOCATION` | app | unset; where you declare this install's backups live, shown to tenants ([residency.md](residency.md)) |
| `STORAGE_DRIVER` / `STORAGE_FS_PATH` | app | `fs` / `/data/storage` — not in any database backup |
| `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING` | app | generated into `/data/secret.key` when unset — not in any database backup |
| `WORKER_MODE` | app | `embedded` in the reference Compose `app`; `off` to hold jobs after a restore |
| `postgresql.cnpg.backup.*` | Helm values | disabled |
