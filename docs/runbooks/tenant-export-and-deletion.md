# Runbook: export, delete and restore a workspace; data-subject requests

A workspace can leave an install in two ways — as a signed export file that another install can import, or by being deleted — and a person can ask for their own data to be exported, corrected or erased. This runbook is for whoever operates the install. It covers what the workspace owner does in the product, what only the operator can do from the CLI, the 30-day window between "deleted" and "gone", what "gone" actually means on disk, and where the operator fits into a data-subject request.

Reference material: the file format is documented in `packages/portability/README.md`.

## What has to be true first

- **You can run the CLI:** `docker compose run --rm app <command>` — the image's entrypoint is the CLI, and it has no shell.
- **Files move in and out of the container through the data volume.** The CLI runs inside a container, so `--out` and import paths are paths *in the container*. Write under `/data/…` and copy with `docker compose cp` against the running `app` container, which mounts the same volume.
- **The queue is healthy.** Web exports, the purge and every erasure step run as jobs. If jobs are backing up, fix that first: [queue-backlog.md](queue-backlog.md).
- **You know who the controller is.** For the people in a workspace, the company that owns the workspace decides what to export, delete or erase; on a multi-tenant install you are running it on their behalf. Do not delete or erase on an investor's request sent to you — pass it to the workspace owner.

## Export a workspace

**The owner does it in the product:** **Settings → Export workspace** (`POST /api/v1/portability/exports`, then `GET …/exports/{id}/download`). Owner only, with a fresh sign-in for both starting and downloading. The `portability.export` job builds it in the background; the file is kept encrypted on the install for **7 days**, then deleted. An export that fails is marked failed on the same screen and is not retried — start another.

**The operator does it from the CLI** when the owner cannot (the portal is down, the owner has left, the workspace is being moved by you):

```
docker compose run --rm app workspace export acme --out /data/exports/acme.zip
docker compose cp app:/data/exports/acme.zip ./acme.zip
```

`acme` is the slug or the workspace id. `--include-raw-analytics` adds the raw engagement event stream, which is large and is personal data about every investor; leave it off unless the destination needs it. The command runs synchronously (no worker needed), writes the plaintext zip to `--out`, keeps the same encrypted copy in storage that a portal export would (expiring after 7 days), and prints:

```
exported acme (<workspace id>) to /data/exports/acme.zip: <bytes> bytes, sha256 <hex>
signed with key v2: <base64 public key>
```

**Record that public key with the file.** It is what proves the file came from this install, and after a key rotation it is the only way to verify it (the install's current ring may no longer contain it). Then remove the plaintext from the volume — the image has no shell, so:

```
docker compose exec app /nodejs/bin/node -e "require('fs').rmSync('/data/exports/acme.zip')"
```

Only live workspaces export: a deleted one answers `no live workspace acme`. Restore it first (below), export, and delete it again.

**What is in the file, and what that means.** Every table the workspace owns, the audit chain with its checkpoints, and **every document in plaintext** — workspace keys never leave an install, so the only portable form of a document is the decrypted one. Treat the zip as the whole company's investor data room: store it encrypted, move it over an encrypted channel, delete copies you do not need.

## Verify and import on another install

**Verify** anywhere — it needs no database and no configuration, only the file and the public key you recorded:

```
docker run --rm -v "$PWD:/in:ro" ghcr.io/fundroomhq/fundroom:<version> workspace verify-export /in/acme.zip --public-key <base64 public key>
```

The container runs as uid 65532, so the file must be readable by it (`chmod a+r acme.zip` on the host, or copy it somewhere that is). Exit status and the last line:

| Exit | Means |
|---|---|
| 0 | Intact, and signed by a key you pinned |
| 1 | Failed: altered, truncated, malformed, or signed by a key you pinned that does not match |
| 2 | Usage |
| 3 | Intact, but **UNVERIFIED ORIGIN**: no `--public-key` (and no loadable key ring), so only the file's own embedded key was checked — which an attacker who rebuilt the file would also have supplied |

**Import** on the destination creates a **new** workspace with fresh ids from the file; it never touches an existing one.

```
docker compose cp ./acme.zip app:/data/acme-import.zip
docker compose run --rm app workspace import /data/acme-import.zip --slug acme --public-key <base64 public key> --owner-email founder@acme.example
```

- `docker compose cp` keeps the host file's mode and makes it root-owned, and the app runs as uid 65532: `chmod a+r acme.zip` before copying it in, or the import cannot open it.
- `--slug` is required and must be free on the destination; `--name` overrides the name.
- `--public-key` pins the source install's key (repeatable). Without it the destination trusts only its **own** export keys — right for re-importing on the same install, wrong for a move — and an unpinned file is refused with exit 3. `--allow-unverified` imports it anyway; use it only for a file whose origin you have established some other way, and say so in your records.
- `--owner-email` guarantees one live staff owner with that address, promoted or created. Use it whenever you are not sure an owner in the file can still sign in.
- The import runs in one transaction: exit 1 means **nothing** was written. It prints a table and row count, the signature status, any warnings, and the list of what is *not* carried.

**A single-tenant destination must have no workspace yet.** `TENANCY_MODE=single` routes every request to the one live workspace and refuses to serve at all (`TENANCY_MODE=single but more than one workspace exists`) once there are two. For a single-tenant move, bring up the new install, **do not** run the setup wizard, import, then sign in. To add a workspace next to an existing one, the destination must run `TENANCY_MODE=multi`.

After an import, tell the owner what has to be redone by hand — the import prints it, and `packages/portability/README.md` has the detail:

- custom domains (add and verify again — see [custom-domains.md](custom-domains.md)) and the updates module's sending domain;
- integration secrets: spreadsheet connections and chat webhooks arrive disabled and must be reconnected;
- share links arrive revoked; pending invitations need resending;
- everyone signs in again; passkeys and TOTP must be enrolled again on the new install;
- files keep the scan verdict they had at the source and are not rescanned ([av-failure.md](av-failure.md)).

Delete `/data/acme-import.zip` from the volume afterwards the same way as above.

## Delete a workspace

Only the owner deletes, in the product: **Settings → Danger zone → Delete this workspace** (`DELETE /api/v1/workspace`), with a fresh sign-in and the slug typed back. It is refused while the workspace is under **legal hold** (Legal & offering → Settings), and on a single-tenant install it is refused for the only live workspace — there, decommissioning means the operator stops the install and removes its database and volumes.

What happens, and when:

| When | What |
|---|---|
| Immediately | `deleted_at` set, `purge_after` = now + 30 days, `workspace.deleted` on the workspace's audit chain. Every session whose last workspace was this one is revoked — sessions are global sign-ins, so those people are signed out of their other workspaces too. The portal and its custom domain stop resolving within a minute (cache TTL). |
| Days 0–30 | The operator can restore it. Nothing is purged. First-run setup stays closed while a deleted workspace is inside its window. |
| The first 04:20 UTC run after `purge_after` | The `workspace.purge` job, unless the workspace is under legal hold: stamps `purged_at` and **crypto-shreds** every workspace data key (the wrapped key is overwritten; the row stays as a tombstone), deletes its search entries and its export rows and files. `workspace.purged` on the platform audit trail. At most 50 workspaces per run; the rest go the next day. |

**What the purge does not remove**, which you should know before telling anyone their data is "deleted":

- **Rows.** Memberships, the audit chain, analytics, legal acceptances and the other metadata stay in Postgres. The purge removes the ability to decrypt *content*; it does not delete the workspace row, whose `ON DELETE CASCADE` is what would remove the rest. Deleting that row is a manual operator action with no command behind it.
- **Encrypted objects.** Documents, renditions and other blobs stay in object storage (the `fs` volume or the bucket) under `ws/<workspace id>/`, as ciphertext nobody can decrypt any more. Remove that prefix yourself if you want the space back.
- **Backups, WAL and old snapshots.** They hold the pre-shred wrapped keys until they expire. Those copies are only useful together with the master key they were wrapped under, which is why rotating the master key ring is the remaining lever for a workspace that must be unrecoverable before your backup retention runs out ([rotate-keys.md](rotate-keys.md)).
- **Other nodes' caches** hold an unwrapped key for up to 10 minutes after the purge.

### Restore a deleted workspace

The owner asks you; there is no self-service undo.

```
docker compose run --rm app workspace restore acme
```

Slug or id. Exit 0 prints `restored workspace acme (<id>)` and records `workspace.restored` on the platform trail; the portal resolves again within a minute. Exit 1 with a reason:

| Reason | Means | Do |
|---|---|---|
| `no deleted workspace matches …` | Wrong slug, or it was never deleted | Check the slug; restore by id |
| `the restore window of … has closed` | `purge_after` has passed. Whether or not the purge job has run yet, restore refuses | Nothing to restore; the data is (or is about to be) unreadable |
| `… deleted workspaces use the slug …` | Several deleted workspaces share the slug | Restore by the id the message lists |
| `another live workspace now uses the slug …` | The slug was reused since | Rename the live one first |
| `… was moved to another cell; this is the old copy …` | This is the source copy of a workspace moved to another region's cell; the live workspace is there | Nothing to restore here ([residency.md](residency.md)) |

Sessions revoked by the deletion stay revoked; people sign in again. If you rotated the master key ring while the workspace was deleted, keep the old key in the ring: a deleted workspace's keys are not rewrapped until it is live again, and the first nightly `crypto.rewrap` after the restore moves them.

To see what is deleted and when it will be purged:

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT id, slug, deleted_at, purge_after, purged_at FROM core.workspace
   WHERE deleted_at IS NOT NULL ORDER BY purge_after;"
```

## Data-subject requests

Requests are recorded and worked by the workspace's own staff — owner, admin or legal — under **Legal & offering → Data requests**. Recording one starts the statutory clock: **30 days, or 45 for a US workspace**, shown on the request. The operator's part is to keep the machinery running and to answer for the layers the product does not reach.

| Kind | What the product does | Where the operator comes in |
|---|---|---|
| **Access** | The request's export action on the **Data requests** screen (`GET /api/v1/compliance/subjects/{membershipId}/export`, fresh sign-in) builds a zip of everything the workspace holds about them from every module, with other staff members' identities redacted from the audit lines. Completing the request cites that zip's hash. | Nothing, unless the export fails — then it is usually a module's hook; the error is in the logs. |
| **Rectification** | Recorded; the correction is made on the person's page by hand. | Nothing. |
| **Erasure** | `member.erasure_requested` goes to every compiled-in module that handles it — enabled or not, because a disabled module's old rows are personal data too. Each module erases or pseudonymises its own rows and reports back; the request shows each module's progress. When the last one reports, the kernel scrubs the profile and invites, revokes the membership and this workspace's sessions, and — only if this was the person's last live membership on the install — pseudonymises the global identity. | Keep the queue flowing, and handle backups (below). |

Things that stop an erasure, deliberately:

- **Legal hold** on the workspace refuses new erasure requests (access and rectification are still allowed).
- **The last owner** cannot be erased: the request waits ("Waiting: this person is the last owner") until ownership is transferred.
- **An open request of the same kind** for the same person.

Consent history, click-wrap acceptances and attestations, audit rows and round commitments are **retained** on purpose — they are evidence or a legal obligation — and the request says so. Hash-chained audit rows are never rewritten; erasure pseudonymises the identity they point at instead.

**An erasure that stays "in progress"** is almost always a job problem. Each module's step is an `event.member.erasure_requested` job; look for them in the queue and in the dead letters:

```
docker compose run --rm app jobs dlq list --workspace <workspace uuid>
```

and retry once the cause is fixed ([queue-backlog.md](queue-backlog.md)). The step is idempotent.

**Backups.** Erasure, like the purge, acts on the live database. Backups taken before it still contain the person until they expire. State your backup retention in your privacy documentation as the period within which an erasure propagates, and if you ever restore a backup, re-run the erasures completed since it was taken — the audit trail (`compliance.identity_erased`, and the erasure request rows) is the list.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `TENANCY_MODE` | app | `single` (one live workspace; imports need an empty install) |
| `DATA_DIR` | app | `/data` (also the import's temp directory) |
| `STORAGE_DRIVER` / `STORAGE_FS_PATH` / `S3_BUCKET` | app | `fs` / `/data/storage` — where the ciphertext left behind by a purge lives |
| `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING` | app | the ring whose export keys sign and pin export files |
| `AUDIT_RETENTION_MONTHS` | app | `84` — audit partitions older than this are dropped by maintenance; legal hold does not veto the drop yet |
