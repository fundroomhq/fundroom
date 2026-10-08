# @fundroom/authz-openfga

`RelationshipEnginePort` over [OpenFGA](https://openfga.dev): a second, narrowing
authorization engine behind `packages/authz` (`AUTHZ_ENGINE=openfga`). Plain `fetch` through the injected,
SSRF-guarded client (no `@openfga/sdk`: its retries and transport would bypass the guard). Runtime dependency
`@fundroom/ports` only. Built and tested against `openfga/openfga:v1.21.0`. Operations:
[`docs/runbooks/openfga.md`](../../../docs/runbooks/openfga.md).

Exports `createOpenFgaEngine({ url, apiToken?, http, timeoutMs, log?, depthLimit?, batchConcurrency?, now?
})`, `OPENFGA_ENGINE_DRIVER` (`"openfga"`), `openFgaStoreName(workspaceId)` (`seedhost-<workspaceId>`), the
model builder (`buildOpenFgaModel`, `modelHash`, `formatModelRef`/`parseModelRef`, `openFgaTypeName`,
`openFgaTypeTable`, `ruleRelation`, `TIERS`, `RESERVED_TYPE_NAMES`, `VALID_WINDOW_CONDITION`), the
projection (`projectSnapshot`, `kindsOf`, `objectOf`, `userOf`, `subjectUserOf`, `encodeId`,
`tupleIdentity`), the HTTP client (`createOpenFgaHttp`, `apiErrorOf`) and the limits
(`OPENFGA_WRITE_CHUNK` 100, `OPENFGA_READ_PAGE` 100, `OPENFGA_BATCH_CHECK_CHUNK` 50,
`OPENFGA_MAX_CONTEXTUAL_TUPLES` 100, `OPENFGA_DEFAULT_DEPTH_LIMIT` 20).

## The model (`src/model.ts`)

- **Types.** Subjects `user`, `group#member`, `link#member`, `role#member`; one type per resource kind,
  `openFgaTypeName(kind)` (lower-cased, anything outside `[a-z0-9_]` → `_`: `data-room.document` →
  `data_room_document`). A kind that maps to a reserved name (`user`, `group`, `link`, `role`, `grant`) or two
  kinds that collide make sync throw rather than merge. The model declares the snapshot's `kinds` (the
  install's resource kinds) plus every kind seen in nodes and rules, so a workspace synced before its first
  document already knows `document`, and the model hash changes only when the set of kinds does.
- **Rules are objects.** Every rule is its own `grant:<ruleId>.<hash12>` object. `grant#subject` holds the
  rule's subject, conditioned with `valid_window(current_time, not_before, not_after)` **only** when the rule
  is time-bounded (condition evaluation roughly triples check cost on v1.21). The resource holds
  `grant:…#subject` in one of eight direct relations per capability, `<cap>_<membership|link|group|role>_
  <allow|exclude>`. The indirection is needed because OpenFGA keys tuples by (user, relation, object) without
  the condition, so two rules that differ only in their window would collide; the hash makes an edited rule a
  new key (written, then the old one deleted, never rewritten in place). Bounds are normalised to
  millisecond ISO; open bounds are `0001-01-01T00:00:00.000Z` / `9999-12-31T23:59:59.999Z`.
- **The access-rule ordering in one relation per capability.** Below each tier r: `(r_allow − r_exclude) ∪ (parent.cap −
  (r_allow ∪ r_exclude))`, nested role → group → link → membership: nearest node first, then subject
  specificity, exclude wins a full tie, liveness filtered before ranking. There is no capability implication
  in `packages/authz` `evaluate.ts`, so none here.

## Sync, checks, stores

- **Store resolution.** The stored `storeRef` (its name verified; another workspace's store → `rejected`),
  else adopt the oldest store named `seedhost-<ws>`, else create one; a store that answers 404 is re-created.
  `modelRef` is `<authorization_model_id>:<sha256-16 of the model JSON>`; a model is written only when the
  kinds change or the store is new or adopted.
- **Sync** = paged Read (100) of every tuple, a full diff against the projected snapshot, deletes of keys
  whose condition changed, writes (≤ 100 operations per request, `on_duplicate: "ignore"`), stale deletes
  (`on_missing: "ignore"`). Idempotent; memory O(snapshot + diff). Nodes deeper than the depth limit (or on a
  cycle) get no parent edge, and a warning is logged with the count.
- **Checks** always send `context.current_time`, `HIGHER_CONSISTENCY` and the pinned model id. `check` is one
  BatchCheck with one item per capability (any item error throws); `batchCheck` sends chunks of 50, at most
  `batchConcurrency` (4) in flight, and returns `{ allowed, failed }`: per-item server errors (too deep →
  `rejected`, deadline → `timeout`) go to `failed`, only transport or whole-request errors throw. A resource
  kind absent from the synced model answers false without a call; a state without a store or model throws
  `rejected` ("not synced").
- **Unsynced ancestors.** A resource may carry `ancestors` (nearest first), sent as contextual `parent`
  tuples so nodes created since the last sync are decided at once. The adapter stops at the first edge the
  store already holds, learned by an exact-tuple Read (user = parent, relation `parent`, object = child,
  page size 1) cached 15 s per (store, parent, child) with in-flight de-duplication and an LRU of 200 000
  entries (`OPENFGA_EDGE_CACHE_TTL_MS`, `OPENFGA_EDGE_CACHE_BUDGET`), invalidated by this process's syncs and
  drops. Staleness costs at most a duplicated hop or a brief narrow deny, never a widening. More than
  `depthLimit` ancestors (or more than 100 contextual tuples, or an ancestor kind the model lacks) → that
  item fails `rejected` before any call.
- **Dropping a workspace.** OpenFGA's `DeleteStore` is a soft delete: Check keeps answering from the tuples
  afterwards (verified). `dropWorkspace` therefore deletes every tuple first, then the store; 404 counts as
  done. OpenFGA's change log (ReadChanges) keeps the history; purging it is a datastore operation.
- **Errors** (`RelationshipEngineError`): 401/403 `unauthorized`; 408/504 `timeout`; 429 and 5xx
  `unreachable`; other 4xx `rejected`; non-JSON or oversize `invalid_response`; transport timeouts `timeout`,
  other network and guard errors `unreachable`. `healthCheck()` is an authenticated `GET /stores?page_size=1`
  (it catches a wrong key).
- **ListObjects is not used**: with exclusions and conditions it is bounded by
  `OPENFGA_LIST_OBJECTS_MAX_RESULTS` / `_DEADLINE` (silent truncation), so it is not provably equivalent.

## Tests and numbers

`src/openfga-engine.integration.test.ts` runs against a real `openfga/openfga:v1.21.0` container (override
`FUNDROOM_TEST_OPENFGA_IMAGE`) with preshared-key auth. The **differential test** generates random trees
(depth ≤ 5, some documents without a folder, flat resources), 3–6 members with groups, links and roles,
allow and exclude rules including same-key twins and full ties, open, half-open and closed windows, and
times at the boundaries ± 1 ms: more than 5 000 (member, resource, capability, time) cases per seed, 12 fixed
seeds (plus `FUNDROOM_FGA_SEED`), all equal to `resolveNode` from `packages/authz`. Dropping the same-tier
exclude, the "no rule here" subtraction, the `<` on `not_after`, `not_after` itself, or the conditions each
make seeds fail. Also covered: idempotency, incremental changes, moves, store adoption and re-creation,
unsynced nodes, depth limits, folders-only workspaces.

Measured on the memory datastore: a workspace of 6 984 tuples syncs in about 0.5 s (a no-op sync 0.12 s); a
check of 4 capabilities about 10 ms; batch checks about 1.2 ms per item (1 902 resources in 2.3 s); checks at
depth 4–20 with full ancestors 9–20 ms; a cold check in a folder of 12 000 synced documents 4–12 ms.
