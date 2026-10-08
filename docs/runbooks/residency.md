# Runbook: data residency and cells in several regions

A managed host can keep each tenant's data in one region: an EU company's workspace, its members'
accounts, its documents and its backups stay in the EU, and a US company's stay in the US. This runbook
is for whoever runs the host. It covers declaring the region an install's data lives in, what is and is
not pinned to that region, standing up a cell in a second region, the shared directory database that
ties the cells together, moving a workspace from one region to another, and how to check each step.

Reference material: the control-plane
runbook's [Cells](control-plane.md#cells) section, `packages/directory` (the directory and
its migration), `packages/control-plane/src/moves/` (the move state machine),
`apps/server/src/residency/` (region boot check, directory and move jobs) and
`apps/server/src/middleware/tenant.ts` (cross-cell routing).

## The model

- **A cell is a complete, separate deployment.** It has its own Postgres database, its own object
  storage bucket, its own job queue and workers (the queue lives in that database), its own backups and
  its own master key ring. Everything a workspace owns lives in exactly one cell, **including the user
  accounts of its members**. An EU cell's processes never hold a US workspace's rows or file bytes,
  because they are never connected to where those live. Nothing in the code filters jobs by region;
  the separation comes from the deployment.
- **One database = one region.** Several cells may share one database (cells, for scaling the
  web tier), but then they are in the same region. The database refuses a second region (the
  `cell_single_region` trigger: "one database = one region"), and a declared region never changes.
- **A workspace's region is derived.** `core.workspace.data_region` is always the region of the
  workspace's cell, kept by a trigger. No code path, operator action or tenant writes it.
- **The region is declared by you.** `DATA_REGION`, `DATA_REGION_LABEL`, `DATA_REGION_JURISDICTION`
  and `BACKUP_LOCATION` are statements you make about where this install's database, bucket and backups
  are. The product cannot verify any of them, and everything a tenant sees says "declared by your host".
  Make them true before you set them.
- **The directory is the only thing cells share.** A small Postgres database at
  `DIRECTORY_DATABASE_URL` lists the cells (id, region, label, jurisdiction, public origin, status,
  heartbeat, export public key), one entry per workspace (slug → cell), verified custom hostnames
  (hostname → workspace entry) and moves in progress. It holds **no personal data**: no names, email
  addresses or content. It keeps slugs and custom hostnames unique across all cells, and lets a cell
  send a request for another cell's workspace to the right place.
- **Without `DIRECTORY_DATABASE_URL`** the directory is "local": this database alone decides, exactly
  as before residency support. Every self-hosted install and every single-region host runs this way. Declaring a
  region there only fills in the region (and the tenants' residency page and DPA); nothing else
  changes.

The cells trust each other and the directory: they are run by the same operator with the same
software. A compromised cell, or someone with write access to the directory database, can misroute
requests and interfere with moves; while a move's bundle is waiting to be imported (at most 24
hours), anyone who can read the directory can also fetch and decrypt it, because the link and its
per-move key are stored there until the switch (then both are erased; they are not wrapped to the
target cell). Protect the directory credentials like any database credential.

## What has to be true first

- **The CLI and Postgres**, as in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app
  <command>` (Helm: `kubectl exec deploy/<release>-server -- /nodejs/bin/node /app/dist/cli.js
  <command>`). Every command below runs **on the cell it is about**.
- **For more than one region: the managed-host control plane** (`CONTROL_PLANE=on`,
  `TENANCY_MODE=multi`, [control-plane.md](control-plane.md)) on every cell, and `STORAGE_DRIVER=s3`
  (prod and staging refuse a directory with any other driver: moves hand a bundle from one cell's
  bucket to the other over a presigned URL).

## Declare the region

On every install, including a single-region one:

```
DATA_REGION=eu                                         # ^[a-z][a-z0-9-]{0,31}$
DATA_REGION_LABEL=European Union (Frankfurt, Germany)  # what tenants read; 1-120 characters
DATA_REGION_JURISDICTION=eu                            # eu | uk | ch | us | ca | au | other
BACKUP_LOCATION=European Union (Frankfurt, Germany)    # where the backups are; 1-120 characters
```

Helm: `residency.region`, `residency.regionLabel`, `residency.jurisdiction`,
`residency.backupLocation` ([chart README](../../deploy/helm/fundroom/README.md#data-residency)).
`DATA_REGION_LABEL` and `DATA_REGION_JURISDICTION` need `DATA_REGION`.

Restart every process. At start, after the migrations, the server **adopts** the region: every cell
of this database that has not declared one yet (the placeholder region `default`) takes `DATA_REGION`,
the label and the jurisdiction, and every workspace on those cells gets the region in the same
transaction. The one exception is the `default` cell every database gets from its first migration,
when `CELL_ID` names another cell and no workspace was ever placed on `default`: it stays a
placeholder (see [the second cell](#stand-up-a-cell-in-a-second-region)). On every start, cells already
in `DATA_REGION` also take a changed `DATA_REGION_LABEL` or `DATA_REGION_JURISDICTION`, so **a typo in
the label is fixed by correcting the variable and restarting**. Each change is audited `cell.update`
on the platform chain; the log line is `residency.region_adopted`.

Check it:

```
fundroom doctor
```

The derived rows at the end say `dataResidency  region eu (European Union (Frankfurt, Germany)),
jurisdiction eu`, `backupLocation  …` and `directory  local` (or `shared`). With `CONTROL_PLANE=on`
and no `DATA_REGION`, doctor warns (`DATA_REGION`): tenants then see their data location as "not
declared", and the cell cannot join a directory. `fundroom cell list` shows each cell's region.

What tenants see: owners, admins and legal staff (`compliance.read`) get **Settings → Data residency**
(`GET /api/v1/residency`): the region and its label marked as declared by the host, where each part
of the service keeps their data (database, jobs, search and analytics — all in the database —,
object storage, backups, email, telemetry when configured, virus scanning with `AV_DRIVER=clamd`),
the sub-processors with a flag on the ones outside the region, and a banner while their workspace is
being moved (the page stays reachable for them during a move, when the rest of the admin answers
`423`). The DPA template in **Legal** fills its "Annex: Data location" from the same facts and lists
only the sub-processors you configure; a transfer safeguard the software cannot know reads "Not
stated", and US vendors seen from an EU, UK or Swiss region read "EU SCCs (or the EU-US Data Privacy
Framework — operator to confirm)". The investor **privacy notice** template lists both: your
sub-processors and, separately, the vendors the workspace connected itself
(`{{workspaceSubProcessors}}`). The workspace's privacy regime
(`legal.privacyRegion`, which notice and cookie rules apply) is a separate setting and does not
follow the region.

### A region is forever

The region of a database's cells never changes once declared, and a database never holds two
regions. So:

- **Never point `DATA_REGION` at a different value on an existing database.** In production
  (`APP_ENV=prod` or `staging`) the server refuses to start: `DATA_REGION=us, but cells of this
  database declare another region: default (eu). One database = one region, and a declared region
  never changes: …`. Elsewhere it logs `residency.region_mismatch` and starts. The fix is almost always
  that the process is pointed at the wrong database, or `DATA_REGION` was copied from another cell's
  configuration.
- **Unsetting `DATA_REGION`** on a database whose cells declared one logs
  `residency.region_undeclared`; the residency page says "not declared" until you set it again. The
  cells keep their region.
- **Data that really is in the wrong place** (you declared `eu` but the database is in Virginia) is
  fixed by moving: stand up a cell where the data should be and move the workspaces there. Do not
  restore a database into another region and keep its declaration.

## What is and is not pinned to the region

Pinning is only as good as the configuration of each cell. Go through this table for every cell.

| Part | Where it is | Pinned by |
|---|---|---|
| Database: every workspace row, member accounts, sessions, the audit log, search index, analytics, the mail log, the job queue | `DATABASE_URL` | you: a database in the region |
| Documents, renditions, exports, evidence | the bucket in `S3_*` | you: a bucket in the region (`S3_REGION`, or an `S3_ENDPOINT` there); no cross-region replication to another jurisdiction |
| Backups (database, bucket, key) | wherever your backups go | you: [backup-and-restore.md](backup-and-restore.md#backups-per-region); declared in `BACKUP_LOCATION` |
| Master key ring | `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING`, or `/data/secret.key` | you: each cell has its **own** key; keep its copy in the region's secret store |
| Worker scratch (exports, inbound moves) | `DATA_DIR` on the worker's host | the worker running in the region |
| Email | the mail provider (`MAILER_DRIVER`) | **not by default.** Postmark and Resend process mail in the United States; SES in `AWS_REGION` (choose one in the region per cell). The residency page lists them as sub-processors with their location. SMTP: a relay on a private or internal host counts as yours (in the cell); a public relay host is listed as "Email relay (SMTP, not identified)", location varies — the software does not know whose relay it is, so say so in your own sub-processor list |
| Virus scanning | `AV_DRIVER=clamd`, `CLAMD_HOST` (receives every uploaded file) | you: a clamd on a private or internal host counts as in the cell; any other host is shown as "not identified" and listed as a deployment sub-processor ("Virus scanning service (clamd, not identified)") |
| Traces | `OTEL_EXPORTER_OTLP_ENDPOINT` | you: a collector in the region, or none. A collector on a private or internal host counts as yours; any other is listed as a deployment sub-processor (Honeycomb by name, otherwise "Telemetry collector (OTLP, not identified)"). Spans carry route templates, timings, status codes and internal ids. Every span URL is reduced to its origin + `/[redacted]`: inbound (share-link and invite tokens, OAuth codes, query strings) and outbound (presigned links, webhook secrets). Database spans carry SQL text without bound values |
| AI assist | `AI_PROVIDER`, `AI_BASE_URL` (receives prompts built from workspace content: update text, KPI values, data-room passages, investor questions) | you, for a self-hosted model server: counts as in the cell. A third-party provider is **not pinned**: listed as a deployment sub-processor (Anthropic, United States; or `AI_PROVIDER_LABEL` with `AI_PROVIDER_LOCATION` / `AI_PROVIDER_JURISDICTION`), and as a workspace sub-processor only while that workspace has AI on. See [ai-assist.md](ai-assist.md) |
| Error reporting | `ERROR_REPORTING_DSN` | nothing sends to it yet, so it is not listed as a component |
| Vendors the operator configures | Stripe (billing), OpenSanctions (hosted sanctions screening), Cloudflare for SaaS (custom domains) | **not pinned**: each has its own locations, shown as deployment sub-processors. Cloudflare's edge terminates TLS for custom domains wherever the visitor is ("varies") |
| Vendors a workspace connects | e-sign, integrations, accreditation, Slack incoming webhooks (notification channels), the Google Sheets connector (metrics) | **not pinned**: the workspace's own choice, shown as workspace sub-processors with their locations |
| Custom-domain and sending-domain checks | DNS-over-HTTPS (`DOH_ENDPOINTS`, default Cloudflare and Google resolvers) | the domain names only |
| Update check | `UPDATE_CHECK_URL` | sends no identifiers |
| The edge in front of the cells | your load balancer / CDN | you: it sees every request. Route a region's traffic through infrastructure in that region if that matters to your tenants |

A cell whose jurisdiction is unknown (`other`) or a vendor whose location "varies" gets no in-region
or out-of-region flag: the page shows the location text and leaves the judgement to the reader.

## Stand up a cell in a second region

A second region is a second, complete install. Nothing is shared with the first cell except the
directory database. Take the example of an existing EU host adding a US cell.

1. **Every cell id must be unique across the directory.** A directory row for a cell belongs to the
   database that published it first (it is tied to that install's export key), and a second database
   publishing the same id is refused: it logs `directory.cell_conflict` at error level every
   heartbeat, the cell is shown as remote there, and no workspace can be placed on it (`503
   directory_unavailable`, reason `cell_conflict`). So the existing install may keep `default` (or
   whatever it has), and every new cell database gets its own `CELL_ID` (`us-1`, `eu-2`, …). A new
   database still has the `default` cell its first migration created; while `CELL_ID` names another
   cell and no workspace was ever placed on `default`, it keeps the placeholder region and is never
   published, which is expected. To give the existing install a clearer name, add a cell and move its
   workspaces there before you join the directory (in one database this is an instant label change):

   ```
   fundroom cell add eu-1 --region eu --origin https://eu.investors.example.com \
     --label "European Union (Frankfurt, Germany)" --jurisdiction eu
   ```

   then **Change cell** on each workspace's console page (or `PATCH /api/v1/platform/workspaces/{id}`
   `{ "cellId": "eu-1" }`), and set `CELL_ID=eu-1` on every process of that install. `--region`
   must equal `DATA_REGION` when it is set (the error says so), and a region other than the one the
   database already has fails with "one database = one region". Two cell databases must never share a
   master key ring: the directory tells databases apart by their export keys.
2. **Create the directory database** (below) if this is the first time, and set
   `DIRECTORY_DATABASE_URL` on every process of the **existing** cell. Restart it: its migrations
   create the `directory` schema, and at start (and every 5 minutes) it publishes its cells;
   `fundroom directory status` lists them. Its workspaces get their directory entries from the
   reconcile sweep (every 10 minutes), or at once with `fundroom directory sync`.
3. **Provision the new region's infrastructure**, all of it in the region:
   - a Postgres database of its own (not a second schema in the first cell's cluster);
   - an S3 bucket of its own, with its own credentials, versioning and lifecycle;
   - backups of both into the region ([backup-and-restore.md](backup-and-restore.md#backups-per-region));
   - a **new master key** (`openssl rand -base64 32`), stored in the region's secret store. Do not copy
     the first cell's key: each cell's key ring protects only its own tenants;
   - if you use a KMS or secret manager, a key ring / vault in the region;
   - a mail configuration for the region (SES in the region, or a relay there) if email should stay
     in the region too.
4. **Configure the new cell** as a normal install ([install-and-upgrade.md](install-and-upgrade.md)),
   plus:

   ```
   TENANCY_MODE=multi
   CONTROL_PLANE=on
   CELL_ID=us-1                                  # unique across the directory
   BASE_URL=https://us.investors.example.com     # this cell's own canonical origin
   DATA_REGION=us
   DATA_REGION_LABEL=United States (Virginia)
   DATA_REGION_JURISDICTION=us
   BACKUP_LOCATION=United States (Ohio)
   DIRECTORY_DATABASE_URL=postgres://…@directory.internal:5432/directory?sslmode=verify-full   # the SAME one
   STORAGE_DRIVER=s3
   S3_BUCKET=acme-fundroom-us …
   ```

   Run its migrations (`fundroom migrate`; the Helm hook does it). The first start creates the cell
   `CELL_ID` names from `DATA_REGION`, its label and jurisdiction and `BASE_URL`'s origin
   ([control-plane.md](control-plane.md) "Cells") and publishes it to the directory. For another
   origin, correct it afterwards with `fundroom cell set-origin us-1 https://us.investors.example.com`
   (on Helm, right after the install), or create the row yourself before the first start with
   `fundroom cell add us-1 --region us --origin https://us.investors.example.com --label "United
   States (Virginia)" --jurisdiction us`. A start never changes an existing row; a difference is
   logged as `cell.own_differs`. Until the row exists nothing can be created on this cell
   (`cell_unavailable`, or "has no row in core.cell" from the CLI). A row you added or changed
   yourself (`cell add`, `cell set-origin`) reaches the directory at the next heartbeat (5 minutes)
   or with `fundroom directory sync`; the row a start creates is published at once.
   The plans, operators and signup settings of each cell are its own (they live in its database):
   create the **same plan ids** on every cell (`fundroom plan upsert …`), because a moved workspace
   keeps its plan id and the move fails with `plan_unknown` when the target cell does not have it.
   Keep their limits identical too, `modules` and `features` included: a moved workspace gets what the
   target cell's copy of the plan allows.
   Grant operators on each cell (`fundroom operator enrol-link` / `grant`): an operator account is a
   user of one cell's database.
5. **Start it and check**: `fundroom doctor` (region, `directory shared`), then `fundroom directory
   status` on either cell lists both cells, each with its region and a heartbeat younger than
   15 minutes. The console's **Cells** page (`/platform/cells`) shows local cells with their workspace
   counts and remote cells from the directory (workspace count empty).
6. **Route traffic.** Each cell answers for its own workspaces and returns **`421 wrong_cell`** with
   `X-Fundroom-Cell: <cell id>` for a workspace the directory places in another cell (by slug or
   custom hostname). Your edge maps that header to the cell's origin and retries there; the product
   does not redirect. A `<slug>.` host or custom domain can be served by any cell's edge as long as it
   forwards 421s. People start on the cell's own canonical host (`BASE_URL`): **signup**
   (`/signup`, `GET /api/v1/signup/regions`) lists every active cell with a public origin and sends a
   visitor who picks another region to that cell's signup page (only cells with an `https` origin
   are offered; the list is cached for a minute). A slug or custom hostname taken in any cell is
   refused in every cell. A soft-deleted workspace's entry turns `dormant`: it keeps its slug and
   custom hostnames held everywhere for its 30-day restore window but is never routed (requests for
   it are a plain `404` in every cell); a restore makes it active again, and the purge releases it.

Each person's account lives in the cell of the workspace they belong to. Somebody who is a member of
an EU workspace and a US workspace has two accounts, one per cell, with separate passwords, passkeys
and sessions. The canonical host (sign-in, `/platform`, central auth) of each cell serves that cell's
accounts only.

## The directory database

**What it is.** One small Postgres database, reachable from every cell, with the schema `directory`
(tables `cell`, `workspace`, `hostname`, `move`). Every cell connects with the same role, and there is
no row-level security in it: it is infrastructure, not tenant data. It holds slugs, workspace ids,
verified hostnames, cell facts and move bookkeeping (states, bundle digests and a time-limited link to
the export bundle, error codes, an opaque operator reference) — never a name, email address or content.

**Where to put it.** Anywhere all cells can reach it with low latency to the cells' canonical hosts;
it holds no personal data, so its own location is not a residency question. Use TLS with
`sslmode=verify-full`: the directory carries each cell's export public keys (a target cell verifies a
moved bundle's signature against them) and each live move's bundle link, so an unverified connection
would let someone in the path substitute both. In production and staging this is enforced like
`DATABASE_URL`: the URL must point at a private host or carry `sslmode=verify-full` (or `verify-ca`),
or the config is refused (`DIRECTORY_DATABASE_URL`). `DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS=true`
accepts it anyway; `DATABASE_ACCEPT_UNVERIFIED_TLS` does not cover the directory. `fundroom doctor`
prints the transport in its `directory` row (`shared (tls verify-full)`, `shared (private host)`,
`shared (UNVERIFIED TLS accepted)`, …).

**Sizing.** Tiny: one row per cell, one per workspace ever created, one per verified custom hostname,
one per move. The smallest instance of your provider is enough; `DIRECTORY_DATABASE_POOL_MAX`
(default 4, 1–20) connections per process. Lookups are cached for 30 seconds in each process and
limited to a fixed budget per second, so traffic for unknown hosts cannot turn into directory load.

**Migrations.** Every cell applies the directory's migrations when it migrates (`fundroom migrate`,
server start, and the Helm migrate hook), after its own. They run under an advisory lock in the
directory database, so cells starting at the same time apply each file once. Upgrade every cell to the
same release. A directory that **cannot be reached** does not stop the cell: the migration is skipped
with an error-level `migrate.directory.skipped` (`fundroom migrate` still exits 0), the cell starts
and serves its own workspaces, and the next `directory.heartbeat` run on any worker applies them: the
heartbeat first checks the directory's migration journal (read only, so a directory role without
`CREATE` rights is fine when nothing is pending), applies only what is pending, and then always
publishes, whatever `MIGRATE_ON_START` says. A directory schema **newer** than this cell's code (a
cell not yet upgraded) or a failed migration is a rate-limited warning, never a stop: upgrade the
cell. To apply them by hand and see failures, run
`fundroom directory migrate` (exit code non-zero when the directory is unreachable). A failure after
connecting (a broken migration) still stops the start.

**Jobs.** At start, the server publishes this database's cells (waiting at most 5 seconds, logging
`directory.publish_slow` and finishing in the background if the directory is slow). On every cell's
worker: `directory.heartbeat` (every 5 minutes: publishes this database's cells — region, label,
jurisdiction, origin, status, and every public key of the export key ring with its key id — and their
heartbeat, after applying any pending directory migrations) and
`directory.reconcile` (every 10 minutes: repairs entries the placement hooks could not write, releases
reservations older than an hour that never became a workspace, re-claims verified hostnames and
releases hostnames that are no longer verified here — except a custom domain a move brought in, which
keeps its claim while that re-added domain waits for re-verification, for at most 72 hours after the
switch (a domain the tenant removes and re-adds, or re-verifies after a failure, is claimed normally
once it verifies) — marks soft-deleted workspaces `dormant`). A cell
whose heartbeat is older than 15 minutes is not offered as a move target.

**Backups.** Back it up like any database (daily at least, PITR if you can). Losing it loses no
tenant data, but until it is restored no cell can route to another, claim a new slug or hostname, or
move a workspace. A restore to an older point is repaired by the reconcile sweeps of every cell
(entries for workspaces that exist are recreated; hostnames re-claimed); moves that were in flight at
the restore point must be looked at by hand (`fundroom move list` on both cells).

### When the directory is down

| | What happens |
|---|---|
| Starting a cell | not blocked: the directory migration is skipped (`migrate.directory.skipped`) and retried by the heartbeat; the boot publish gives up waiting after 5 seconds |
| Local workspaces | unaffected: resolution tries this cell's database first and never needs the directory for its own workspaces |
| A slug or hostname this cell does not have | a plain `404`, as for a name that does not exist (not `503`: an outage must not reveal which names exist elsewhere). The failure is logged |
| New workspaces (operator provisioning, signup, the setup wizard, `workspace import`) | refused with `503 directory_unavailable` until it is back, and nothing is created: the directory is the only judge of a slug's uniqueness across cells. Signup's slug check answers "available" meanwhile; the final step is what refuses |
| Custom domains reaching verified | the hostname claim waits: the attempt is not counted against the domain's 72-hour deadline, and the next check retries. (A hostname another workspace holds is refused with the same sentence as a local conflict and does count.) |
| Soft delete and restore | done locally; the directory entry follows (`dormant` / `active`) on the next sweep. A restore whose directory entry was already released must claim the slug again first, and is refused until the directory is back |
| Moves | stall; they carry on from where they were when it is back (leases expire and are re-taken) |
| After it comes back | the reconcile sweep writes whatever the post-commit hooks could not |

## Move a workspace to another region

A move copies a workspace from its cell (the **source**) to a cell in another region (the **target**)
through a signed export, switches the directory entry, and deletes the source copy. It is heavy and
operator-initiated, with **downtime**: from the request until the switch, the workspace is
unavailable to everyone. Moving between cells of the same database (same region) is not a move: it
is the instant **Change cell** of [control-plane.md](control-plane.md#cells), and the console only
offers local cells there. `PATCH /api/v1/platform/workspaces/{id}` with a cell in another database
answers `409 move_unavailable` (`reason: use_move`).

### Before you start

- Both cells run the same release, share the directory, use `STORAGE_DRIVER=s3` (the bundle is
  handed over through a presigned link), and the target is `active` with a fresh heartbeat
  (`fundroom directory status`).
- The target cell has every plan the workspace references (step 4 above).
- The workspace is not deleted, is not under legal hold (a held source copy could never be purged),
  and has no open erasure request. Tell its owners about the downtime and **what they lose** (below).
- Scratch space on **both** workers under `DATA_DIR/moves/`: the source writes the export zip there,
  the target downloads the bundle there (Helm: `dataScratchSizeLimit`); `move.poll` removes files of
  moves that no longer need them. The target downloads at most
  `MOVE_MAX_BUNDLE_BYTES` (default 50 GiB); a larger bundle fails with `bundle_too_large`.
- The target's workers can reach the source's bucket over HTTPS. The download goes through the
  outbound-request guard: for a bucket on a private address (a MinIO inside your network) set
  `OUTBOUND_HTTP_ALLOW_PRIVATE=true` with the bucket's host in `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS` on
  the target. It follows no redirects. With `networkPolicy.egress` set in Helm, allow
  it there too.

### Start it

Any process of the database that serves the workspace's cell can request or cancel its move, and
any worker of that database drives the moves of all its cells (a database with several cells needs
no worker per cell). A workspace whose cell this database does not serve is refused with
`source_remote`. While it moves, its cell cannot be changed either (`409 conflict`, `reason:
relocating`).

In the console of the **source** cell: the workspace's page → **Move to another cell** → pick the
target (remote cells only), type the workspace's slug to confirm, and read the warning. Or by CLI on
the source cell (typing the slug is the confirmation):

```
fundroom workspace move <slug> --to us-1
fundroom move list [--state <state>] [--workspace <uuid>] [--json]   # moves where this cell is source or target
fundroom move cancel <move-id>
```

or `POST /api/v1/platform/workspaces/{id}/move` `{ "targetCellId": "us-1", "confirmSlug": "acme" }`
(202), `GET /api/v1/platform/moves?workspaceId=…&state=…`, `POST /api/v1/platform/moves/{id}/cancel`.

A request is refused with `409 move_unavailable` and a `reason`:

| Reason | Means |
|---|---|
| `no_directory` | this cell has no `DIRECTORY_DATABASE_URL` |
| `storage` | this cell's `STORAGE_DRIVER` is not `s3` |
| `target_unknown`, `target_local` | no such cell in the directory; or it is in this database (use **Change cell**) |
| `target_inactive`, `target_stale` | the target is draining or closed; or its heartbeat is older than 15 minutes |
| `source_remote`, `not_in_directory` | the workspace is not served by this database's cells; or it has no directory entry yet (`fundroom directory sync`) |
| `deleted`, `legal_hold`, `erasure_open` | as above |
| `sanctions_review` | the workspace's first sanctions screening is still pending; decide it first ([sanctions.md](sanctions.md)) |

`409 move_busy` means a move of this workspace is already live, a slug that does not match is `400
validation_failed` (`reason: confirmation_mismatch`), and `503 directory_unavailable` means the
directory could not be reached.

### What happens

| State | Where | What |
|---|---|---|
| `requested` | source | the workspace gets the `relocation` hold (it is now unavailable: staff see 423 everywhere except **Settings → Data residency**, everyone else 404; it cannot be deleted, `409 conflict` `reason: relocating`, and the hold cannot be lifted by an operator) and its directory entry is marked moving; audited `workspace.move_request` |
| `exporting` → `exported` | source worker (`move.export`) | a normal signed portability export, encrypted with a key of its own for this move and stored in the source bucket under a name of its own for each attempt; a presigned link valid for 24 hours, the sha256, size and signing key id go into the move; audited `workspace.move_export` |
| `importing` → `imported` | target worker (`move.poll` picks it up, `move.import`) | the target downloads the bundle (6-hour deadline), decrypts it, checks the sha256 and the signature **against the source cell's export key with that key id, as published in the directory** (never a key inside the bundle), that it is this workspace and that it was exported after the move was requested, and imports it under the same slug, held under `relocation`; audited `workspace.move_import` |
| `switched` | source, under the workspace's row lock | after re-checking that the source is still held for the move, not deleted, not under legal hold and has no new erasure request, the directory entry is pointed at the target, the source copy is soft-deleted and its subscription record removed (the target gets the subscription as it is at this moment, so only the target acts on billing webhooks), and the bundle, its link and its key are erased. The target then re-applies the holds and lifts `relocation`, and serves the workspace; the source answers `421` to the target for it (its other processes within 30 seconds, their lookup cache). Audited `workspace.move_switch` on both cells |
| `retired` | source worker (`move.retire`, hourly) | once `MOVE_SOURCE_RETENTION_HOURS` (default 0) have passed, the source copy is crypto-shredded by the normal purge; audited `workspace.move_retire` |

`move.poll` runs every minute on every cell and drives and repairs every step, so a crashed worker
resumes where it stopped. Progress is visible on the workspace's console page, in `fundroom move
list`, and to the workspace's staff as a banner on **Settings → Data residency**. The downtime is the
export, the transfer and the import, which scale with the workspace's documents.

### What is carried and what is lost

The target gets a new workspace (new internal ids, as in any import) with the same slug and:

- everything the portability export carries ([tenant-export-and-deletion.md](tenant-export-and-deletion.md)):
  content and documents (re-encrypted under the target's keys), members (matched or created by email
  address in the target cell), completed data-subject requests, and the audit trail, archived as
  evidence — a new chain starts with `workspace.imported`; search is re-indexed;
- its plan, legal name and country (as of the export);
- its billing binding: the subscription record (provider, customer and subscription ids, status,
  periods, grace) moves with it. Same operator, same billing account;
- every hold except `relocation`: **a workspace suspended for billing or sanctions arrives
  suspended**, holds gained on the source during the move are applied at the switch, and a hold lifted
  on the source during the move stays on the target (lift it there);
- its custom domains, re-added as **pending**: the owner must update the DNS TXT record (the challenge
  token changes) before they serve.

Not carried:

- sessions (everyone signs in again), passwords, passkeys and authenticator apps (members set them
  up again in the new cell), API keys, outbound webhooks and their secrets, and vendor connections
  (e-sign, integrations, accreditation, SSO and SCIM);
- share-link and invitation tokens (share links arrive revoked; pending invitations need resending),
  spreadsheet connections and chat webhooks (arrive disabled), the updates module's sending domain
  (verify again), the mail log, usage history and earlier exports;
- sanctions screening records: they are the operator's, so the target screens again, and a
  `sanctions` hold lifts only after a clear screening in the target;
- files keep the virus-scan verdict they had and are not rescanned.

The console states the identity losses before you confirm. Tell the owners before you start.

### Cancel, failure and rollback

**Cancel** is allowed while the move is `requested`, `exporting`, `exported` or `importing` (after
that `409 conflict`, `reason: not_cancellable`). The target discards any partial import, the bundle
is deleted, the source lifts the relocation hold and the entry is active in the source again; state
`cancelled`, audited `workspace.move_cancel`. On a cancel or failure the bundle, its link and its key
are erased too.

Rotating a cell's master key during a move is safe as long as the old key stays in the ring: the
directory publishes every public key of the ring, and the target matches the bundle's key id.

A **failure** before the switch ends in state `failed` with a stage (`request`, `export`,
`transfer`, `verify`, `import`, `switch`) and a code, with the same rollback (audited
`workspace.move_fail`): the workspace is back on the source, available, as it was. Codes and what to
do:

| Code | Meaning | Do |
|---|---|---|
| `export_failed` | the source's export job failed | the source worker's log (`move.export`); retry the move |
| `bundle_expired` | the 24-hour link ran out before the target downloaded it | check the target's worker is running, retry |
| `bundle_too_large` | bigger than the target's `MOVE_MAX_BUNDLE_BYTES` | raise it (and the target's scratch space), retry |
| `download_failed` | the target could not fetch the bundle | the target's egress to the source bucket (and the `OUTBOUND_HTTP_ALLOW_PRIVATE*` keys for a private one); retry |
| `sha256_mismatch`, `signature_invalid`, `unknown_signer`, `bundle_mismatch` | the bundle is not the one the source exported, is not signed by the source's published key, or is another workspace's | **treat as an incident**: compare the source's export key with its directory row; do not retry until explained |
| `incompatible` | the cells run different releases | upgrade both, retry |
| `import_failed` | the target's import failed (also: the directory was unreachable during it) | the target worker's log (`move.import`) |
| `slug_taken` | the slug is not free in the target | should not happen with a shared directory; `fundroom directory sync` on both cells |
| `plan_unknown` | the target has no plan the workspace references | create it on the target (`fundroom plan upsert`), retry |
| `erasure_during_move` | an erasure was requested while the workspace was moving | complete the erasure on the source first |
| `deleted`, `not_held`, `legal_hold` (stage `switch`) | at the switch the source was deleted, no longer held for the move, or under legal hold | resolve that on the source; the copy in the target was discarded. A deleted source's entry becomes `dormant` (its slug stays held for the restore window) |
| `internal` | anything else; at stage `request`, a request whose hold was never set (it is failed rather than exported) | both workers' logs, by move id (they carry error names and codes, not database messages) |

After `switched` there is no cancel: a move back is a new move in the other direction. The source's
soft-deleted copy cannot be restored during its retention (`fundroom workspace restore` refuses it:
the workspace moved to another cell).

## Verify

| Check | Where | Expect |
|---|---|---|
| `fundroom doctor` | every process | `dataResidency` with the region you mean, `backupLocation`, `directory shared (tls verify-full)` (or `private host`) on a multi-region host; no `DATA_REGION` warning |
| `fundroom directory migrate` | any cell, after an upgrade or a directory outage | applies pending directory migrations; exit 0 |
| `fundroom cell list` | each cell | this database's cells, all in one region |
| `fundroom directory status [--json]` | any cell | `mode: shared`, then one line per cell: id, status, region, `local` or `remote`, `heartbeat 2m ago` (under 15 minutes), origin. In local mode: `mode: local` and this database's cells |
| `fundroom directory sync` | any cell | one reconcile pass now: `published: …; entries created N, repaired N, conflicts N, …`. Exit 1 when there is any conflict (a slug or hostname another entry holds, logged with the workspace id) or in local mode |
| logs | every cell | no `directory.cell_conflict` (a cell id another database owns), `directory.publish_skipped` only for the unused `default` row |
| `/platform/cells` | console, each cell | the same, plus workspace counts for local cells |
| Settings → Data residency | a workspace in each cell | the region you declared, components and sub-processors as in the table above |
| A slug from the other cell, sent to a cell that does not hold it | `curl -si --connect-to <slug>.<domain>:443:<this cell's host>:443 https://<slug>.<domain>/api/v1/modules` | `421` with `X-Fundroom-Cell: <the other cell>` (a slug no cell holds: `404`) |

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `DATA_REGION` | unset | `^[a-z][a-z0-9-]{0,31}$`; adopted by this database's cells at start; never changes afterwards |
| `DATA_REGION_LABEL` | unset | 1–120 characters; needs `DATA_REGION` |
| `DATA_REGION_JURISDICTION` | unset | `eu`, `uk`, `ch`, `us`, `ca`, `au` or `other`; needs `DATA_REGION` |
| `BACKUP_LOCATION` | unset | 1–120 characters, shown to tenants |
| `DIRECTORY_DATABASE_URL` | unset (local mode) | secret (`_FILE` accepted); needs `CONTROL_PLANE=on`, `DATA_REGION`, `DATA_REGION_JURISDICTION`, and `STORAGE_DRIVER=s3` in prod/staging |
| `DIRECTORY_DATABASE_POOL_MAX` | `4` | 1–20 |
| `DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS` | `false` | prod/staging: accept a directory URL on a public host without `sslmode=verify-full`/`verify-ca` |
| `MOVE_SOURCE_RETENTION_HOURS` | `0` | 0–720: how long the source keeps a moved workspace after the switch |
| `MOVE_MAX_BUNDLE_BYTES` | `53687091200` (50 GiB) | at least 1 MiB; the largest bundle this cell downloads |
| `CELL_ID`, `CONTROL_PLANE` | `default`, `off` | [control-plane.md](control-plane.md) |
