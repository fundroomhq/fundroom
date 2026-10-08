# @fundroom/authz

Authorization kernel: the staff RBAC matrix,
the grants + policy-gates evaluator, the `core.effective_access` rebuild and the `AuthzPort`
implementation the server and modules call.

## Wiring

```ts
import { createAuthzService } from "@fundroom/authz";

const authz = createAuthzService({
  db,
  permissionCatalogue: () => registry.permissions.keys(),
  resourceKinds: registry.resourceKinds, // { folder: { staff: { view: "data-room.read" } } }
  log,
});
for (const sub of authz.subscriptions) subscriptions.subscribe(sub.topic, sub.id, sub.handler);
jobs.push(...authz.jobs); // authz.reconcile, hourly
```

`authz` implements `AuthzPort`:

| Call | Answers |
|---|---|
| `permissionsFor(membership, catalogue)` | Staff RBAC from `matrix/authz-matrix.yaml`; external kinds get `[]` |
| `check(principal, resource, capability, facts?)` | `{ allowed, capabilities, pendingGates, reason }` from the nearest materialised node; staff also via `resourceKinds` |
| `listAccessible(principal, kind, facts?)` | Every node of `kind` the membership can at least view |
| `whoHasAccess(workspaceId, resource)` | Holders with capabilities, pending gates and every rule (`via`) that applied |
| `explain(principal, resource, facts?)` | The decision for one membership with the rules ranked, decisive ones flagged |

Plus `bump(tx, ctx, cause)` (call inside the transaction that changed grants / groups /
policies / memberships / attestations: `acl_version++` + `acl.changed`), `ensureFresh`,
`rebuild`, `invalidate`. Kernel services that cannot hold the service instance call the
standalone `bumpAcl(tx, ctx, cause)`.

## Resolution rule

For a principal (membership, its groups, the share links it was admitted through, its role)
and a resource, only rules on the node itself or on an ancestor `ltree` path count. Per
capability the winner is chosen by depth (node itself > deeper ancestor > shallower), then
subject specificity (membership > link > group > role), then effect (exclude wins a full tie).
`resolveNode()` is pure and covered by `evaluate.test.ts`.

## The `link` subject

A share-link visitor becomes a real `core.membership` (`kind='external'`,
`source='link:<id>'`), but the **link stays the grant subject**: grants are written once against
`subject_kind='link', subject_id=<link id>` and never copied per visitor. What turns that into
access for a person is `core.share_link_visit`, the membership ↔ link binding that
`PrincipalRepo.listActive()` walks to fill `Principal.linkIds`. `AuthzPort` never learns about
links at all — no new field on `AuthzPrincipal`, nothing new in `RequestFacts` — because the
binding is a row, not a request fact.

That shape is what makes revocation one write. Revoking, pausing or expiring the link stops
`listActive()` emitting the subject, so **every** membership it admitted loses the access on the
next rebuild; there is no per-visitor grant to hunt down. `uses` / `max_uses` are deliberately
*not* consulted — an exhausted link admits nobody new (admission) but must
keep working for the people already inside.

`SUBJECT_SPECIFICITY` has ranked `link: 2` since E1.1, between `membership` and `group`, and the
ordering is the point: a link is narrower than a group (it names one door, not a cohort) and
broader than a person, so an exclude written for one visitor overrides what their link allowed,
and the link overrides what their group allowed. Before E2.3 `subjectsOf()` never emitted a link
subject, so no link grant could resolve for anybody.

A gate may target a link too (`access_policy.target_kind = 'link'`, added in
`0009_link_policy_target.sql`). It binds only the principals currently bound to that link and
reports `source: "link:<id>"`.

## The `nda` gate names a document, not a version

The stored config is `{ documentId }`. **`PolicyRepo.listLiveGates()` resolves the stamp** —
joining `core.legal_document → current_version_id → legal_document_version.version_no` and
filling `config.stamp = "<slug>:v<n>"` — and only then hands the `Gate` to the evaluator, which
compares `principal.attestations.some(a => a.kind === config.stamp)` and stays pure.

This is the whole of "re-acceptance on version change", and it costs no code at publish time:
publishing a version already bumps `acl_version`, the rebuild re-reads the gate, the stamp moves
to `:v<n+1>`, and every holder of the old stamp is pending again. No policy row is rewritten and
no old acceptance is lost.

Two deliberate edges:

- A legacy config carrying `{ version: "v3" }` and no `documentId` still resolves to `nda:v3`,
  exactly as before. `withResolvedStamps()` leaves it alone.
- A `documentId` that resolves to nothing — deleted document, no published version — gets no
  stamp and `ndaStamp()` falls back to `nda:v1`, a stamp nobody holds, so the gate stays shut.
  An NDA gate that *opened* because its document went missing would be the worse failure.

## Materialisation

`rebuildEffectiveAccess(tx, ctx)` stores one row per (active membership, node named by a rule
that applies to it), including nodes with no capability left (so `core.has_access()` stops
there instead of falling back to a parent's allow). Attestation gates (`nda`, `accredited`) are
settled at build time, which is why an attestation change and an NDA publish both have to bump
`acl_version`; `min_auth_level` / `ip_allowlist` stay pending and `settleGates()` decides per
request.
Gated nodes get rows too (review AZ, 2026-09-26): `check()` answers from the nearest row, so a
gate on a node *below* the one a rule names — an NDA on a sub-folder of a granted folder, or on
one document in it — needs a row of its own, or the granted ancestor's row (which knows nothing
of the gate) decides the gated subtree and the gate is never asked for. Every resource-targeted
gate's node that one of a member's rules reaches therefore gets a row resolved exactly as that
node (same rules, same staff-only veil; a document's row stays path-less so it never covers a
sibling), bounded by the number of gated nodes. A document's gates are evaluated at the folder
path it sits at (`locatedDocumentIds()` says which documents need that lookup), so a gate on a
folder also binds a document inside it that was granted directly.
Time changes a verdict with no write at all: a grant's `validUntil`, an `accredited`
attestation ageing past `maxAgeDays`, an attestation's or the membership's own `expires_at`.
Each row's `expires_at` is the earliest of those (`gateVerdictExpiry()` ∧ the decisive grants),
so it is not only a grant's end any more: it is when the stored verdict stops being true.
Reads call `ensureFresh()`: a table behind `workspace.acl_version` is rebuilt inline
(deduplicated per process), and so is one whose rows for the caller have passed `expires_at`. `authz.reconcile` (hourly) rebuilds workspaces with an expired row or a validity window
that opened since the last build.

**Folder-location fix.** The rebuild loads the folder location of *every* document a rule names and
resolves non-delegates at that location, so a document's own rule (say `download`) no longer hides the
capabilities inherited from its folders (`view`): before, `check` answered `no_grant` where `explain` showed the
grant. `check`, `explain` and `core.has_access()` now agree; the change only widens where Postgres was wrongly
refusing.

## Optional relationship engine

With `AUTHZ_ENGINE=openfga` the server wraps the service with `withRelationshipEngine(pg, engine, { mode,
sample, db, queue, log?, metrics?, resourceKinds?, callTimeoutMs?, … })` (`src/engine.ts`;
`apps/server/src/authz-engine-wiring.ts`) around a `RelationshipEnginePort` (`@fundroom/authz-openfga`). With
the default `postgres` the service is untouched. Operations:
[`docs/runbooks/openfga.md`](../../docs/runbooks/openfga.md).

- **What is projected.** `buildRelationshipSnapshot(tx, ctx)` (`src/repos/snapshot.ts`, one short read
  transaction): every folder and document with its parent (derived from the ltree paths; trashed ones
  included), every live grant whose window can still open, every active external non-delegate membership
  with its role, groups and bound links, the `aclVersion`, and `kinds` (the registry's resource kinds, plus
  `folder`/`document` when the data room exists).
- **Modes.** `shadow` (default): Postgres answers; a sampled share (`AUTHZ_OPENFGA_SHADOW_SAMPLE`) of external
  non-delegate `check`s (not `not_member` decisions) is replayed against the engine off the request path, at
  most 8 at a time (more are dropped); staff and delegates never take a slot. `enforce`: for external
  non-delegates, `check` = Postgres ∩ engine per capability, `listAccessible` = Postgres's list filtered by
  the engine's `view` in batches of `ENGINE_BATCH_CHUNK` (50); per-item failures deny that item; any engine
  error or timeout (adapter deadline + a `callTimeoutMs` backstop) fails closed. Staff, delegates,
  `permissionsFor`, `hasPermission`, `whoHasAccess` and `explain` are always Postgres.
- **Unsynced nodes.** Each check carries `ancestors` derived from the resource's path (labels are folder ids
  without dashes; the root label is looked up once per 10 minutes): only the leading unsynced part (the
  node's own parent edge, then ancestors whose folder was created after the last snapshot − 60 s, by the
  database clock), at most `ENGINE_MAX_CONTEXT_EDGES` (8). A longer chain is cut (deny direction) and kicks a
  sync; chains deeper than `ENGINE_MAX_TREE_DEPTH` (20 path labels) are refused before any call (enforce
  deny, shadow `skipped{reason="too_deep"}`). Synced-folder ids are cached per process
  (`SYNCED_FOLDERS_PER_WORKSPACE` 20 000, `SYNCED_FOLDERS_TOTAL` 200 000); over budget the whole chain (capped
  at 8) is sent and the adapter trims it against the store, so a chain of more than 8 new nested folders in
  such a workspace is denied until the next sync. A sync is also kicked (debounced, ≥ 60 s per workspace)
  when the engine refuses an item.
- **Sync.** `acl.changed` → job `authz.engine_sync` (stately per workspace): claim the lease on
  `core.authz_engine_state` (`lease_owner`, `lease_until`, 20 minutes; free, expired or ours; pooler-safe),
  load the snapshot in a short transaction (`synced_at` = that transaction's `now()`), call `engine.sync`
  outside any transaction, record `synced_acl_version` fenced on the lease and monotonic, release; if the
  workspace's `acl_version` moved meanwhile, re-enqueue. Cron `authz.engine_reconcile` (`35 * * * *`)
  enqueues syncs for lagging, failed, missing or other-driver states, and drops the stores of workspaces
  soft-deleted within `DROP_WINDOW_DAYS` (90). Shadow and enforce reads also kick a sync when the engine is
  stale or never synced. Share-link pause, resume and revoke now publish `acl.changed` too.
- **Metrics** (`RelationshipEngineMetrics`): `fundroom_authz_shadow_mismatch_total{capability,direction,
  stale}` (`pg_only`: the engine would deny what Postgres allows; `engine_only`: harmless under intersection),
  `fundroom_authz_engine_errors_total{operation,code}` (`check`, `batch_check`, `sync`, `drop`; the engine
  code, `not_synced` or `internal`), `fundroom_authz_shadow_dropped_total`,
  `fundroom_authz_shadow_skipped_total{reason}`. Logs carry `errorCode` (the server logger redacts `code`).
- **Readiness.** The handle's `healthCheck` is the `/readyz` check `authzEngine` (`authz_engine` on the admin
  health page): probed on every run and gating in enforce mode; cached and informational in shadow mode.
- **Deviation (C8).** The data-room tree, search and Q&A call `check` once per node, so enforce mode costs one
  engine round trip per node (300 checks: 281 ms Postgres-only, 1.27 s enforce). A batched `checkMany` on the
  port is deferred.
- **`./testing`**: `describeAuthzPortContract(name, factory)` with `AUTHZ_CONTRACT_FIXTURE` (folders,
  documents, groups, links, roles, excludes, validity), run against Postgres, enforce mode with a real
  OpenFGA container and shadow mode; and `createFakeRelationshipEngine`.

## Module RLS

```sql
CREATE POLICY document_read ON dataroom.document FOR SELECT USING (
  core.current_actor_kind() = 'staff'
  OR core.has_access('folder', folder_id, folder_path, 'view')
);
```

`has_access()` ignores gates on purpose; the serving path calls `check()` with the request
facts.

## Matrix

`matrix/authz-matrix.yaml` is the source for permissions → roles and route requirements.
`pnpm --filter @fundroom/authz matrix:docs` renders `docs/authz-matrix.md`; the unit test
fails when it is stale, and `apps/server`'s `authz-matrix.test.ts` fails when an OpenAPI
operation lacks a row, its `x-requires` disagrees, or a compiled-in permission is missing.

## Mutation testing

`pnpm --filter @fundroom/authz mutation` runs Stryker over the pure resolver (`evaluate.ts`,
`model.ts`, `matrix.ts` parse/RBAC, `computeEffectiveRows`) with the package's unit tests
(`vitest.config.ts` here exists only for Stryker; `pnpm test` keeps running them once under the
root `unit` project). Reports and the incremental file go to `reports/mutation/` (gitignored);
`-- --force` ignores the incremental file. CI runs it weekly and fails under `thresholds.break`.

Score: 67.06% before E2.10, 98.31% after, 97.90% with the verdict-expiry code (668 mutants).
The surviving mutants are equivalent:

- `resolveNode`: `best !== undefined` → `true` (a `Map` entry holding `undefined` is never read
  as a rule); `until !== undefined` → `true` and `until < expiresAt` → `<=` (same result).
- `withResolvedStamps`: dropping the `typeof documentId` guard (a non-string key misses the map).
- `num`: dropping `typeof v === "number"` (`Number.isFinite` already rejects non-numbers).
- `settleGates`: the `?? ""` fallback and `.filter(Boolean)` (an empty or junk entry is skipped
  by `isIP`).
- `ipAllowed`: `family === 0` and `f === 0` guards (`BlockList` rejects or throws, and the throw
  is caught).
- `computeEffectiveRows`: the `mine.length === 0` fast path.
- `satisfiedUntil` / `gateVerdictExpiry`: `until > best` → `>=` and `until < earliest` → `<=`
  (equal instants); `until !== undefined` → `true` (`undefined < n` is already false).
- `earliestOf`: `a === undefined` → `false` (the next branches return `b` all the same).

A test must fail on a load error rather than at collection: Stryker's vitest runner does not count
a collection error as a kill, which is why `matrix.test.ts` loads the matrix in `beforeEach`.
