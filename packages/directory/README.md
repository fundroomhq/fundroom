# @fundroom/directory

The shared cell directory: the one thing the cells of a multi-region host share. It
keeps workspace slugs and verified custom hostnames unique across every cell, tells a cell which other
cell holds a workspace (so it can answer `421 wrong_cell` + `X-Fundroom-Cell`), publishes each cell's
region facts and export public key, and records moves between cells. It holds **no personal data**:
no names, email addresses or content. The operator runbook is
[`docs/runbooks/residency.md`](../../docs/runbooks/residency.md).

It implements `DirectoryPort` from `@fundroom/ports` in two modes:

| Mode | When | Behaviour |
|---|---|---|
| `local` (`createLocalDirectory({ db })`) | `DIRECTORY_DATABASE_URL` unset: every self-host and single-region host | a thin adapter over this database: claims always succeed (the local unique indexes stay the judge, as before E3.11), lookups of other cells' names return `null`, `listCells` is this database's `core.cell` rows, and `moves.*` throw `move_unavailable` (`reason: no_directory`) |
| `shared` (`createSharedDirectory({ url, poolMax, db, cellId, ownerKeys })`) | `DIRECTORY_DATABASE_URL` set | its own `pg` pool to the directory database; every method throws on a directory failure and the caller decides between failing (a slug claim: `503 directory_unavailable`) and best effort (post-commit activate / release, repaired by the sweep) |

| File | What |
|---|---|
| `migrations/0001_directory.sql` | the `directory` schema: `cell` (incl. `export_public_keys`: every public key of the cell's export key ring with its key id), `workspace` (entry per workspace: slug → cell, state `reserved` / `active` / `moving` / `dormant` (soft-deleted: holds its slug and hostnames, never routed) / `deleted`; one live entry per slug), `hostname` (verified hostnames only), `move` (one live move per entry). No RLS: every cell connects with the same role. Applied by `directoryMigrationSource` (module id `directory`, journaled in the directory database) from `migrate()` in `apps/server/src/server.ts` after the cell's own migrations — skipped with `migrate.directory.skipped` when the directory is unreachable; `directory.heartbeat` plans first (read-only journal check), applies only pending migrations, treats a newer directory schema or a failure as a rate-limited warning, and always publishes, in any worker; `fundroom directory migrate` is the strict form |
| `src/local.ts` | local mode |
| `src/shared.ts`, `src/repos/shared-repo.ts` | shared mode: claims, renames, releases, hostnames, cells, and the move rows (compare-and-set `transition`, leases with heartbeats on the directory's clock, the one-transaction `switchover` that rebinds the entry to the target) |
| `src/routing.ts` | `createDirectoryRouting`: the lookups tenant resolution makes on a local miss — a 30 s positive/negative cache, one per-process budget of 50 round trips per second for strangers' slugs and hosts and a separate one for the relocation check of this cell's own held workspaces (over budget = "no entry" = the caller's plain 404), a 1.5 s timeout and a 5 s "down" window after a failure. Nothing that failed is cached, and an outage is never a 503 (that would say which names exist elsewhere) |
| `src/reconcile.ts` | `publishLocalCells` (job `directory.heartbeat`, every 5 min: this database's cells with a declared region, their heartbeat and the instance export public key) and `reconcileDirectory` (job `directory.reconcile`, every 10 min: the repair path for the placement hooks — entries for local workspaces (live ones first; a live workspace may take its slug over from a local soft-deleted one; soft-deleted ones become `dormant`), releases for purged ones, directory hostnames no longer verified locally released (except the domain row a move re-added on the target, while it is pending and for at most 72 h after the switch — `move.switched_at` is the marker), stale `reserved` entries of this cell after 1 h, re-claimed verified hostnames; workspaces under a `relocation` hold are left to the move) |
| `src/hostname.ts` | `directoryHostname`: the one spelling the directory stores (the custom-domains normaliser, port stripped) |

The jobs, the boot-time publish and `fundroom directory status` live in `apps/server`
(`src/residency/directory-jobs.ts`, `src/cli-commands/directory.ts`); the tenant middleware
(`src/middleware/tenant.ts`) uses the routing. Placement hooks (provisioning, signup, setup, demo
seed, slug renames, purges, custom domains) are in `@fundroom/control-plane`, `@fundroom/db` and
`@fundroom/domains`; moves are in `@fundroom/control-plane` (`src/moves/`) and
`@fundroom/portability`.

Cell ownership: a `directory.cell` row belongs to the deployment whose export public key it carries
(`ownerKeys` = all of the deployment's export public keys, so a key rotation keeps ownership while the
old key stays in the ring). Another database publishing the same id never overwrites it or changes its
region; it logs `directory.cell_conflict`, sees the row as `local: false`, and cannot claim entries on
that cell (`directory_unavailable`, reason `cell_conflict`). Two deployments sharing one key ring are
therefore not told apart: every cell database has its own. Placeholder-region cells (the seeded
`default` row nobody uses) are never published (`directory.publish_skipped`). `fundroom directory
sync` exits 1 when its pass logged a conflict.

Trust: cells trust each other and the directory (same operator, same software). Anyone who can write
the directory database can misroute requests and interfere with moves, and anyone who can read it can
fetch a live move's bundle until the switch erases its link and key. In prod/staging the config
refuses a `DIRECTORY_DATABASE_URL` on a public host without `sslmode=verify-full`/`verify-ca`
(escape hatch `DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS`); protect its credentials like a cell
database's. A target cell verifies a
moved bundle against the **source cell's published** export key in `directory.cell`, never a key the
bundle carries, matched by the bundle's key id so a key rotation mid-move is safe.
