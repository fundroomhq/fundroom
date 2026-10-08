# Runbook: OpenFGA authorization engine

FundRoom decides who may see what in Postgres: grants and policies in `core.access_grant` and
`core.access_policy`, resolved by the nearest-rule algorithm and materialised into
`core.effective_access`, which row-level security reads. An install can additionally run
[OpenFGA](https://openfga.dev), a Zanzibar-style relationship engine, behind the same authorization port. In
**shadow** mode it is asked the same questions and disagreements are counted; in **enforce** mode it gets a
veto over external principals' access. It never grants anything Postgres would not.

This runbook is for whoever runs the install: what the engine sees and what stays in Postgres, running it,
the shadow-to-enforce rollout, reading the metrics, sync, fail-closed behaviour, limits and sizing.

Reference material: `packages/authz` (`engine.ts`, `repos/snapshot.ts`) and `packages/adapters/authz-openfga` (the generated model,
its README and the differential test against the Postgres resolver).

## Why you might, and might not, want it

- **What it gives.** A second, independent evaluator of the access rules, with its own model and its own
  code. In enforce mode a bug that made Postgres too generous for an external viewer has to be repeated by the
  engine to leak anything. It is also a step for hosts that already operate OpenFGA.
- **What it does not give.** It does not make access checks faster (Postgres still decides first, and enforce
  mode adds a round trip), it does not replace row-level security, and in shadow mode it changes no decision.
- **What it costs.** Another service to run, patch and keep available. In enforce mode **an engine outage
  denies every external viewer** (fail closed, below). Most installs should not run it; the default
  `AUTHZ_ENGINE=postgres` is complete on its own.

## What the engine sees, and what stays in Postgres

The engine receives a **projection of the raw rules**, per workspace, in its own store (`seedhost-<workspace
id>`), synced after every access change:

- every resource node with a path (folders, documents; trashed ones included) and its parent;
- every live grant whose validity window can still open: subject (membership, group, role or share link),
  resource, capability (view, download, comment, edit), effect (allow or exclude), and the window as a
  condition evaluated with the request time;
- for every **active, external, non-delegate** membership: its role, groups and bound share links;
- the install's resource kinds, so a workspace synced before its first document already knows `document`.

Only ids (UUIDs), kinds and timestamps: no names, emails, titles or file names. The generated model encodes the
the Postgres resolver's ordering exactly (nearest node first, then membership > link > group > role, exclude wins a full
tie); a differential test compares it with the Postgres resolver on thousands of random trees, rules, members
and times on every CI run.

What **stays in Postgres**, and why:

| Stays | Why |
|---|---|
| `core.effective_access` and row-level security | RLS reads it through `core.has_access()` inside every query; a remote engine cannot sit inside a Postgres policy |
| Gates: NDA, accreditation, minimum sign-in level, IP allow-list | They depend on facts of the request and the person, and report *pending* gates the UI acts on |
| The staff-only veil | A workspace-level overlay, not a relationship |
| Staff roles and every staff decision | Staff permissions come from the RBAC matrix; staff principals are answered by Postgres alone |
| Delegates | A delegate's access resolves through the principal's; delegated memberships are answered by Postgres alone |
| `permissionsFor`, `hasPermission`, `explain`, `whoHasAccess` | They need the decisive grant, its id and the ACL version |
| Share-link view budgets (`max_views`), passcodes | Counters and secrets, checked where they are stored |

## Run OpenFGA

**Compose (evaluation):** the reference file has an `openfga` service on the `openfga` profile
(`openfga/openfga:v1.21.0`, in-memory datastore, Compose network only).

```
# .env
COMPOSE_PROFILES=worker,openfga        # add to what is there
AUTHZ_ENGINE=openfga
AUTHZ_OPENFGA_URL=http://openfga:8080
#AUTHZ_OPENFGA_MODE=shadow             # the default
```

```
docker compose up -d openfga
docker compose up -d app worker
fundroom doctor 2>&1 | grep authzEngine
#   authzEngine  openfga shadow, sample 1 (openfga:8080, timeout 1500 ms)
```

The in-memory datastore loses everything when the container restarts. The next failed check or the hourly
reconcile re-creates the store and re-syncs; until then shadow mode counts errors and enforce mode fails
closed. **Use it for evaluation only.**

**Production:** OpenFGA on its own Postgres database (not FundRoom's), migrated once, then `run`:

```
docker run --rm openfga/openfga:v1.21.0 migrate \
  --datastore-engine postgres --datastore-uri 'postgres://openfga:<pw>@<db>:5432/openfga?sslmode=require'
# then the service, with the same datastore flags and:
OPENFGA_AUTHN_METHOD=preshared
OPENFGA_AUTHN_PRESHARED_KEYS=<key>[,<next key>]
OPENFGA_PLAYGROUND_ENABLED=false
```

- **Token.** In `prod` and `staging`, `AUTHZ_OPENFGA_API_TOKEN` (or `_FILE`) is required with
  `AUTHZ_ENGINE=openfga`. The preshared-keys list takes several values, so the token rotates without downtime
  ([rotate-keys.md](rotate-keys.md)).
- **Network.** Keep the engine private. In `prod`/`staging` `AUTHZ_OPENFGA_URL` must be `https:` unless its
  host is operator-run (a private address or a service name); a URL with a user name or password is refused
  everywhere. Redirects are never followed.
- **Image.** Pin `openfga/openfga:v1.21.0` by digest. Leave OpenFGA's check caches off (its default), so a
  revocation is seen at once.
- **Availability.** Run at least two replicas behind a load balancer before you enforce.

## Shadow → enforce rollout

1. **Shadow, full sample.** `AUTHZ_ENGINE=openfga`, `AUTHZ_OPENFGA_MODE=shadow`,
   `AUTHZ_OPENFGA_SHADOW_SAMPLE=1`. Postgres decides everything. For a sample of external, non-delegate
   principals' `check`s (decisions about non-members are skipped), the engine is asked the same question off
   the request path, at most 8 in flight per process; extra comparisons are dropped, never queued
   (`fundroom_authz_shadow_dropped_total`). Lists are not replayed in shadow mode.
2. **Wait for the first sync.** Every workspace syncs after its next access change, and the hourly
   `authz.engine_reconcile` job (at :35) enqueues a sync for every workspace that lags or failed. Shadow
   comparisons also kick a sync when they find a workspace never synced or behind. Check the state table
   (below): every workspace should have a `synced_acl_version` equal to its `acl_version` and no
   `last_error_code`.
3. **Watch for at least two weeks** of normal use, including grant changes, expiring grants, new folders and
   documents, and share links. The target is **zero `pg_only` mismatches** that are not explained by sync lag
   (next section). Lower the sample (`0.1`) only if the comparison load matters on a large install.
4. **Investigate every unexplained `pg_only` mismatch** before going further: report it with the ids from the
   log line.
5. **Enforce.** `AUTHZ_OPENFGA_MODE=enforce`, restart. From now on an external non-delegate principal's
   `check` capabilities are those both Postgres and the engine allow, and a list (`listAccessible`) is
   Postgres's list filtered by the engine's `view` answer (batch checks of 50, at most 4 batches in flight;
   per-capability narrowing happens on each `check`). The `/readyz` check `authzEngine` (`authz_engine` on
   the admin health page) becomes gating.
6. **Roll back** at any time with `AUTHZ_OPENFGA_MODE=shadow` (or `AUTHZ_ENGINE=postgres`) and a restart.
   Nothing in Postgres depends on the engine.

## Reading the metrics

| Metric | Labels | Means |
|---|---|---|
| `fundroom_authz_shadow_mismatch_total` | `capability`; `direction` = `pg_only` or `engine_only`; `stale` = `true`/`false` | shadow comparisons where the two disagreed |
| `fundroom_authz_engine_errors_total` | `operation` = `check`, `batch_check`, `sync`, `drop`; `code` (below) | engine calls that failed, in either mode |
| `fundroom_authz_shadow_dropped_total` | — | comparisons not made because 8 were already in flight |
| `fundroom_authz_shadow_skipped_total` | `reason` (`too_deep`) | comparisons not attempted (see [Limits](#limits)) |

Each mismatch is logged once at `warn` as `authz.shadow_mismatch`, with ids only: workspace, membership,
resource kind and id, capability, what Postgres and the engine said, the workspace's `aclVersion`, the engine's
`syncedAclVersion`, and `stale`. (Error codes in these logs are under `errorCode`.)

| Mismatch | Usually means | Action |
|---|---|---|
| `stale="true"` (either direction) | **sync lag**: the rules changed and the engine had not caught up yet; a sync was kicked | none, if it stops within a minute or two of the change; if not, look at `last_error_code` and the `authz.engine_sync` jobs |
| `direction="engine_only"` | Postgres refused something the engine allows: a gate (NDA, MFA level, IP), the staff-only veil, or a pending gate. Expected: the engine is never asked to model those, and in enforce mode the intersection keeps Postgres's answer | none; harmless under intersection |
| `direction="pg_only"`, around a grant's start or end time | a validity boundary crossed between the two evaluations (they run moments apart) | none, if rare |
| `direction="pg_only"`, `stale="false"`, otherwise | **a real divergence**: in enforce mode this viewer would be denied what Postgres allows | report it with the log line; do not enforce until it is explained |

Also watch request latency: in enforce mode every external document or folder check waits for the engine, up to
`AUTHZ_OPENFGA_TIMEOUT_MS` (default 1.5 s; the kernel adds a 500 ms backstop).

## Sync and its state

- **After every access change** (`acl.changed`, which share-link pause, resume and revoke now also publish),
  the `authz.engine_sync` job loads the workspace's snapshot in a short read transaction and then, outside any
  transaction, makes the engine's tuples equal to it: a full diff (read the engine's tuples page by page, write
  and delete in chunks of 100), idempotent. One sync per workspace runs at a time, held by a **lease** on the
  workspace's state row (`lease_owner`, `lease_until`, 20 minutes), which works behind a transaction-pooling
  PgBouncer; an expired lease is taken over; a sync that lost its lease records nothing and re-enqueues;
  `synced_acl_version` never goes backwards.
- **Hourly** (`authz.engine_reconcile`, `35 * * * *`), a sync is enqueued for every workspace whose synced
  version lags, whose last sync failed, or whose state is missing or names another driver; workspaces
  soft-deleted within the last 90 days have their store dropped.
- **New documents and folders need no sync.** A check sends the node's unsynced ancestor chain (nodes created
  since the last sync, read from Postgres) along with the question, so an upload or a new folder is decided at
  once. More than 8 new nested levels at once are cut and denied in enforce mode until a sync, which the cut
  itself kicks (debounced, at most once a minute per workspace); so does any check the engine refuses.
- **The model** is written per store and re-written only when the install's set of resource kinds changes
  (a FundRoom upgrade that adds a module, for example).
- **Dropping a store** deletes its tuples first, because OpenFGA's store deletion is soft (checks would keep
  answering from them). OpenFGA's change log keeps the history of tuple writes; purging it is a datastore
  operation on OpenFGA's own database.

The state, per workspace (as the database owner):

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT s.workspace_id, w.acl_version, s.synced_acl_version, s.synced_at, s.last_error_code,
         s.lease_until
    FROM core.authz_engine_state s JOIN core.workspace w ON w.id = s.workspace_id
   ORDER BY s.synced_at NULLS FIRST LIMIT 50;"
```

## Fail closed

In enforce mode, when the engine errors or does not answer in time:

- a `check` for an external non-delegate principal answers **denied** (reason `no_grant`): the viewer sees "no
  access";
- a list answers **without** the items the engine could not decide (an error for the whole request: empty);
- staff and delegates are unaffected (Postgres only);
- the error is counted (`fundroom_authz_engine_errors_total`) and logged (`authz.engine_error`,
  `authz.engine_item_failed`); `/readyz` reports `authzEngine` failing (probed on every readiness run in
  enforce mode; in shadow mode it is reported from a cached probe and never gates), so an orchestrator can
  alert. Taking replicas out of rotation does not help: they all share the engine.

A **stale** engine is still consulted, and a sync is kicked. The engine can only narrow, so a stale engine can
deny something just granted (until the sync lands) but never allow something just revoked.

This is a deliberate availability trade: **an engine outage is an outage of the investor data room.** Before
enforcing, decide who is paged for it, run the engine highly available, and keep the rollback (`shadow`) one
config change away.

| Engine error `code` | Means |
|---|---|
| `unreachable` | no connection, DNS or TLS failure, an HTTP 5xx or 429, or a redirect |
| `timeout` | no answer within `AUTHZ_OPENFGA_TIMEOUT_MS` (or the server's own deadline) |
| `unauthorized` | the preshared key was refused (401/403): check `AUTHZ_OPENFGA_API_TOKEN` against `OPENFGA_AUTHN_PRESHARED_KEYS` |
| `rejected` | the engine refused the request: a chain too deep, a store that disappeared, an unknown type, another 4xx |
| `invalid_response` | an answer that does not parse or is over the size cap |
| `not_synced` | the workspace has no store yet (a sync is kicked) |
| `internal` | anything else (see the log) |

## Limits

- **Folder depth 20.** With the engine, an external principal's access to a node more than 20 folder levels
  deep is **denied in enforce mode** and not compared in shadow mode (`fundroom_authz_shadow_skipped_total{reason
  ="too_deep"}`); sync writes no parent edge past that depth. OpenFGA's resolution cost grows steeply with
  depth, and the product has no depth limit of its own, so keep data-room trees shallower than that if you
  enforce. Measured on v1.21.0: checks at depth 4–20 take 9–20 ms.
- **More than 20 000 folders in one workspace** (or 200 000 across the process): the kernel stops tracking
  which folders are already synced and sends whole chains (capped at 8 levels), trimmed by the adapter against
  the store. In such a workspace a chain of more than 8 *new* nested folders is denied until the next sync
  (any access change or the hourly reconcile; the reconcile does not detect this case by itself).
- **Per-node checks.** The data-room tree, search and Q&A make one `check` per node, so in enforce mode each
  node costs an engine round trip (about 3 ms locally): 300 checks took 281 ms with Postgres alone and 1.27 s
  in enforce mode. A batched path is deferred.

## Upgrade note: a Postgres inheritance fix comes with the OpenFGA release

Building the differential test exposed a pre-existing Postgres bug: a document with a rule of its own (say,
`download` for one investor) hid the capabilities that investor inherited from its folders (`view`), so
`check` refused what `explain` showed as granted. The rebuild now resolves every rule-named document at its
folder location, and `check`, `explain` and row-level security agree. This applies with or without the engine,
and only **widens** access where Postgres was wrongly refusing it. Expect some investors to see documents they
were already shown as having access to.

## Sizing

- **Tuples per workspace** ≈ resource nodes (one parent tuple each) + 2 per live grant (each rule is its own
  object, so two rules that differ only in their window never collide) + external memberships × (1 role +
  groups + bound links). A data room with 2 000 documents, 300 folders, 500 grants and 400 investors in
  3 groups each is about 5 000 tuples. Tested to 7 000 tuples per workspace: first sync about 0.5 s, a no-op
  sync 0.12 s (memory datastore). Sync memory is bounded by paging.
- **Sync cost** is proportional to the workspace's tuples, once per access change (changes in quick succession
  are coalesced by the per-workspace job), plus the hourly reconcile for lagging workspaces.
- **Check load in enforce mode** equals external document and folder checks (one batch item per capability)
  plus one batch item per listed item. Measured: a check of 4 capabilities about 10 ms, batch checks about
  1.2 ms per item. OpenFGA's defaults (`OPENFGA_MAX_CHECKS_PER_BATCH_CHECK=50`, request timeout 3 s) fit.
- **Datastore:** OpenFGA's Postgres needs little: a few hundred bytes per tuple plus the change log.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `AUTHZ_ENGINE` | `postgres` | `openfga` to add the engine |
| `AUTHZ_OPENFGA_URL` | unset | required with `openfga`; `https:` in `prod`/`staging` unless operator-run; no user info |
| `AUTHZ_OPENFGA_API_TOKEN` (`_FILE`) | unset | secret; the engine's preshared key; required in `prod`/`staging` |
| `AUTHZ_OPENFGA_MODE` | `shadow` | `enforce` narrows external principals' access; refused with `AUTHZ_ENGINE=postgres` |
| `AUTHZ_OPENFGA_SHADOW_SAMPLE` | `1` | 0–1, the fraction of external checks compared in shadow mode |
| `AUTHZ_OPENFGA_TIMEOUT_MS` | `1500` | 100–30 000, per engine call |
