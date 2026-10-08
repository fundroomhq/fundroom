import {
  CAPABILITIES,
  type Capability,
  type EngineState,
  type OutboundFetch,
  RelationshipEngineError,
  type RelationshipEngineErrorCode,
  type RelationshipEnginePort,
  type RelationshipResource,
  type RelationshipSnapshot,
} from "@fundroom/ports";
import { apiErrorOf, createOpenFgaHttp, type OpenFgaRequest } from "./client.js";
import {
  buildOpenFgaModel,
  formatModelRef,
  modelHash,
  openFgaTypeName,
  PARENT_RELATION,
  parseModelRef,
} from "./model.js";
import {
  conditionSignature,
  kindsOf,
  objectOf,
  projectSnapshot,
  type TupleCondition,
  type TupleKey,
  tupleIdentity,
  userOf,
} from "./tuples.js";

export const OPENFGA_ENGINE_DRIVER = "openfga";

/** OpenFGA's limit on writes + deletes in one Write call. */
export const OPENFGA_WRITE_CHUNK = 100;
/** OpenFGA's Read page size ceiling. */
export const OPENFGA_READ_PAGE = 100;
/** OpenFGA's default `OPENFGA_MAX_CHECKS_PER_BATCH_CHECK`. */
export const OPENFGA_BATCH_CHECK_CHUNK = 50;
/** OpenFGA's limit on contextual tuples per check (one per ancestor link). */
export const OPENFGA_MAX_CONTEXTUAL_TUPLES = 100;

interface CheckItem {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly contextual: readonly TupleKey[];
}

type ItemVerdict =
  | { readonly allowed: boolean }
  | { readonly error: RelationshipEngineErrorCode; readonly message: string };
/**
 * The deepest node (ancestor hops below its root) the engine decides. OpenFGA itself refuses
 * beyond its resolve-node limit (25 by default: 23 hops for a membership rule, 22 for a
 * group/link/role rule on v1.21.0), and check cost grows with every hop, so the adapter stops
 * earlier: a node with more ancestors than this is refused ("rejected") BEFORE any call, and sync
 * writes no parent edge for it (so no check ever walks further).
 */
export const OPENFGA_DEFAULT_DEPTH_LIMIT = 20;
/** How long an edge lookup stays trusted (see `edgeStored`). */
export const OPENFGA_EDGE_CACHE_TTL_MS = 15_000;
/** Edge lookups kept (bounded memory, LRU). */
export const OPENFGA_EDGE_CACHE_BUDGET = 200_000;

export interface OpenFgaEngineLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenFgaEngineOptions {
  /** The OpenFGA HTTP API base URL (AUTHZ_OPENFGA_URL). */
  readonly url: string;
  /** Preshared key sent as a bearer token (AUTHZ_OPENFGA_API_TOKEN). */
  readonly apiToken?: string | undefined;
  /** The guarded outbound client's fetch (no redirects, size cap). */
  readonly http: OutboundFetch;
  /** Per-call timeout (AUTHZ_OPENFGA_TIMEOUT_MS). Sync calls get the same budget per request. */
  readonly timeoutMs: number;
  readonly log?: OpenFgaEngineLog | undefined;
  /** Deepest node decided (see OPENFGA_DEFAULT_DEPTH_LIMIT); ≤ the server's resolve limit. */
  readonly depthLimit?: number | undefined;
  /** Clock for the edge cache (tests). */
  readonly now?: (() => number) | undefined;
  /** BatchCheck requests in flight for one `batchCheck` call (default 4). */
  readonly batchConcurrency?: number | undefined;
}

export function openFgaStoreName(workspaceId: string): string {
  return `seedhost-${workspaceId}`;
}

const CONSISTENCY = "HIGHER_CONSISTENCY";

function invalid(message: string): RelationshipEngineError {
  return new RelationshipEngineError("invalid_response", `openfga: ${message}`);
}

function stringField(obj: Record<string, unknown>, key: string, what: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw invalid(`${what} has no ${key}`);
  return v;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function wireTuple(t: TupleKey): Record<string, unknown> {
  return t.condition === undefined
    ? { user: t.user, relation: t.relation, object: t.object }
    : { user: t.user, relation: t.relation, object: t.object, condition: t.condition };
}

function parseReadTuple(raw: unknown): TupleKey {
  const key = (raw as { key?: unknown } | null)?.key;
  if (typeof key !== "object" || key === null) throw invalid("read tuple without key");
  const k = key as Record<string, unknown>;
  const user = stringField(k, "user", "read tuple");
  const relation = stringField(k, "relation", "read tuple");
  const object = stringField(k, "object", "read tuple");
  const c = k["condition"];
  let condition: TupleCondition | undefined;
  if (typeof c === "object" && c !== null) {
    const name = (c as { name?: unknown }).name;
    const context = (c as { context?: unknown }).context;
    if (typeof name === "string" && name !== "") {
      condition = {
        name,
        context:
          typeof context === "object" && context !== null
            ? (context as Record<string, unknown>)
            : {},
      };
    }
  }
  return { user, relation, object, condition };
}

function currentTime(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new TypeError("authz-openfga: invalid `at`");
  return at.toISOString();
}

export function createOpenFgaEngine(options: OpenFgaEngineOptions): RelationshipEnginePort {
  const request: OpenFgaRequest = createOpenFgaHttp(options);
  const depthLimit = Math.min(
    options.depthLimit ?? OPENFGA_DEFAULT_DEPTH_LIMIT,
    OPENFGA_MAX_CONTEXTUAL_TUPLES,
  );
  const now = options.now ?? Date.now;
  /** `${store}|${parent}|${child}` → whether the store holds that edge. Insertion-ordered (LRU). */
  const edgeCache = new Map<string, { readonly stored: boolean; readonly until: number }>();
  const edgeInFlight = new Map<string, Promise<boolean>>();
  const batchConcurrency = Math.max(1, Math.floor(options.batchConcurrency ?? 4));
  const log = options.log;
  /** `${store}/${model}` → OpenFGA type names in that model (models are immutable). */
  const modelTypes = new Map<string, ReadonlySet<string>>();

  async function storeOf(
    workspaceId: string,
    storeRef: string | null,
  ): Promise<{ readonly id: string; readonly fresh: boolean }> {
    const name = openFgaStoreName(workspaceId);
    if (storeRef !== null) {
      try {
        const store = await request("GET", `/stores/${encodeURIComponent(storeRef)}`);
        if (store["name"] !== name) {
          throw new RelationshipEngineError(
            "rejected",
            `openfga: store ${storeRef} is not ${name}; refusing to sync into it`,
          );
        }
        return { id: storeRef, fresh: false };
      } catch (error) {
        if (apiErrorOf(error)?.status !== 404) throw error;
        log?.warn({ workspaceId, store: storeRef }, "openfga store vanished; recreating");
      }
    }
    // Adopt a store a previous sync created but could not record, else create one.
    let token = "";
    let found: { id: string; created: string } | undefined;
    do {
      const page = await request(
        "GET",
        `/stores?name=${encodeURIComponent(name)}&page_size=100${token ? `&continuation_token=${encodeURIComponent(token)}` : ""}`,
      );
      const stores = page["stores"];
      if (!Array.isArray(stores)) throw invalid("list stores without stores");
      for (const s of stores as Record<string, unknown>[]) {
        if (s["name"] !== name || typeof s["id"] !== "string") continue;
        const created = typeof s["created_at"] === "string" ? s["created_at"] : "";
        if (found === undefined || created < found.created) found = { id: s["id"], created };
      }
      token = typeof page["continuation_token"] === "string" ? page["continuation_token"] : "";
    } while (token !== "");
    if (found !== undefined) return { id: found.id, fresh: true };
    const created = await request("POST", "/stores", { name });
    return { id: stringField(created, "id", "create store"), fresh: true };
  }

  async function typesOf(storeId: string, modelId: string): Promise<ReadonlySet<string>> {
    const key = `${storeId}/${modelId}`;
    const cached = modelTypes.get(key);
    if (cached !== undefined) return cached;
    const body = await request(
      "GET",
      `/stores/${encodeURIComponent(storeId)}/authorization-models/${encodeURIComponent(modelId)}`,
    );
    const model = body["authorization_model"] as { type_definitions?: unknown } | undefined;
    if (!Array.isArray(model?.type_definitions)) throw invalid("model without type_definitions");
    const types = new Set<string>();
    for (const t of model.type_definitions as { type?: unknown }[]) {
      if (typeof t.type === "string") types.add(t.type);
    }
    if (modelTypes.size >= 1024) {
      const oldest = modelTypes.keys().next().value;
      if (oldest !== undefined) modelTypes.delete(oldest);
    }
    modelTypes.set(key, types);
    return types;
  }

  function synced(state: EngineState): { readonly storeId: string; readonly modelId: string } {
    const model = parseModelRef(state.modelRef);
    if (state.storeRef === null || model === null) {
      throw new RelationshipEngineError("rejected", "openfga: workspace not synced yet");
    }
    return { storeId: state.storeRef, modelId: model.modelId };
  }

  /**
   * One verdict per check item, in order. Every item carries `context.current_time`; an item
   * may carry contextual tuples (its ancestors as `parent` links). A per-item error from the
   * server (too deep, deadline, validation) is that item's failure — the rest still count;
   * transport and whole-request errors throw.
   */
  async function runChecks(
    storeId: string,
    modelId: string,
    items: readonly CheckItem[],
    at: Date,
  ): Promise<ItemVerdict[]> {
    const context = { current_time: currentTime(at) };
    const out = new Array<ItemVerdict>(items.length).fill({ allowed: false });
    const batches = chunks(
      items.map((item, index) => ({ item, index })),
      OPENFGA_BATCH_CHECK_CHUNK,
    );
    const run = async (batch: { item: CheckItem; index: number }[]) => {
      const body = await request("POST", `/stores/${encodeURIComponent(storeId)}/batch-check`, {
        authorization_model_id: modelId,
        consistency: CONSISTENCY,
        checks: batch.map(({ item, index }) => ({
          tuple_key: { user: item.user, relation: item.relation, object: item.object },
          ...(item.contextual.length === 0
            ? {}
            : { contextual_tuples: { tuple_keys: item.contextual.map(wireTuple) } }),
          context,
          correlation_id: `c${index}`,
        })),
      });
      const result = body["result"];
      if (typeof result !== "object" || result === null)
        throw invalid("batch-check without result");
      for (const { index } of batch) {
        const r = (result as Record<string, unknown>)[`c${index}`] as
          | { allowed?: unknown; error?: { message?: unknown } }
          | undefined;
        if (r === undefined || r === null) throw invalid(`batch-check missing c${index}`);
        if (r.error !== undefined && r.error !== null) {
          const message = typeof r.error.message === "string" ? r.error.message : "error";
          // A per-item deadline (`context deadline exceeded`, the server's request timeout) is
          // a timeout; anything else (validation, resolution too complex) is a refusal.
          out[index] = {
            error: /deadline exceeded|timeout/iu.test(message) ? "timeout" : "rejected",
            message: `openfga batch-check: ${message.slice(0, 300)}`,
          };
          continue;
        }
        out[index] = { allowed: r.allowed === true };
      }
    };
    // Bounded fan-out: at most `batchConcurrency` batch requests in flight.
    for (let i = 0; i < batches.length; i += batchConcurrency) {
      await Promise.all(batches.slice(i, i + batchConcurrency).map(run));
    }
    return out;
  }

  /**
   * Whether the store holds the edge `parent parent child`: one exact-tuple Read (independent of
   * how many children `parent` has), cached for OPENFGA_EDGE_CACHE_TTL_MS. Concurrent asks share
   * one read.
   */
  async function edgeStored(storeId: string, parent: string, child: string): Promise<boolean> {
    const key = `${storeId}|${parent}|${child}`;
    const hit = edgeCache.get(key);
    if (hit !== undefined && hit.until > now()) {
      edgeCache.delete(key); // refresh LRU position
      edgeCache.set(key, hit);
      return hit.stored;
    }
    const pending = edgeInFlight.get(key);
    if (pending !== undefined) return pending;
    const load = (async () => {
      const page = await request("POST", `/stores/${encodeURIComponent(storeId)}/read`, {
        tuple_key: { user: parent, relation: PARENT_RELATION, object: child },
        page_size: 1,
        consistency: CONSISTENCY,
      });
      const tuples = page["tuples"];
      if (!Array.isArray(tuples)) throw invalid("read without tuples");
      const stored = tuples.length > 0;
      edgeCache.delete(key);
      edgeCache.set(key, { stored, until: now() + OPENFGA_EDGE_CACHE_TTL_MS });
      for (const k of edgeCache.keys()) {
        if (edgeCache.size <= OPENFGA_EDGE_CACHE_BUDGET) break;
        edgeCache.delete(k);
      }
      return stored;
    })();
    edgeInFlight.set(key, load);
    try {
      return await load;
    } finally {
      edgeInFlight.delete(key);
    }
  }

  /**
   * Where one resource sits for a check: its object plus contextual `parent` tuples for the
   * LEADING part of its `ancestors` chain (nearest first) that the store does not hold yet — a
   * node created or moved after the last sync. The walk stops at the first edge the store
   * already has: sending synced edges again would duplicate every hop, and OpenFGA explores
   * both copies, so cost doubles per level (RR1 NEW-1). A stale cache can only cost one
   * duplicate edge or a brief deny (narrower), never a widening.
   *
   * `undefined`: the kind is unknown to the model and nothing places it in a tree (no rule can
   * name it). An error: the chain is deeper than `depthLimit`, or names a kind the model lacks.
   */
  async function placementOf(
    storeId: string,
    types: ReadonlySet<string>,
    resource: RelationshipResource,
  ): Promise<
    | { readonly object: string; readonly contextual: readonly TupleKey[] }
    | { readonly error: RelationshipEngineErrorCode; readonly message: string }
    | undefined
  > {
    const type = openFgaTypeName(resource.kind);
    const ancestors = resource.ancestors ?? [];
    if (!types.has(type)) {
      return ancestors.length === 0
        ? undefined
        : {
            error: "rejected",
            message: `openfga: kind '${resource.kind}' is not in the synced model`,
          };
    }
    if (ancestors.length > depthLimit) {
      return {
        error: "rejected",
        message: `openfga: ${ancestors.length} ancestors exceed the depth limit ${depthLimit}`,
      };
    }
    const object = objectOf(type, resource.id);
    const contextual: TupleKey[] = [];
    let child = object;
    for (const a of ancestors) {
      const aType = openFgaTypeName(a.kind);
      if (!types.has(aType)) {
        return {
          error: "rejected",
          message: `openfga: ancestor kind '${a.kind}' is not in the synced model`,
        };
      }
      const parent = objectOf(aType, a.id);
      if (await edgeStored(storeId, parent, child)) break;
      contextual.push({ user: parent, relation: PARENT_RELATION, object: child });
      child = parent;
    }
    return { object, contextual };
  }

  async function write(
    storeId: string,
    modelId: string,
    kind: "writes" | "deletes",
    tuples: readonly TupleKey[],
  ): Promise<void> {
    for (const chunk of chunks(tuples, OPENFGA_WRITE_CHUNK)) {
      const body =
        kind === "writes"
          ? { writes: { tuple_keys: chunk.map(wireTuple), on_duplicate: "ignore" } }
          : {
              deletes: {
                tuple_keys: chunk.map((t) => ({
                  user: t.user,
                  relation: t.relation,
                  object: t.object,
                })),
                on_missing: "ignore",
              },
            };
      await request("POST", `/stores/${encodeURIComponent(storeId)}/write`, {
        ...body,
        authorization_model_id: modelId,
      });
    }
  }

  return {
    driver: OPENFGA_ENGINE_DRIVER,

    async sync(snapshot: RelationshipSnapshot, state: EngineState) {
      const started = Date.now();
      const projection = projectSnapshot(snapshot, depthLimit);
      const model = buildOpenFgaModel(kindsOf(snapshot));
      const hash = modelHash(model);
      const store = await storeOf(snapshot.workspaceId, state.storeRef);

      const previous = parseModelRef(state.modelRef);
      let modelId: string;
      let modelWritten = false;
      if (!store.fresh && previous !== null && previous.hash === hash) {
        modelId = previous.modelId;
      } else {
        const written = await request(
          "POST",
          `/stores/${encodeURIComponent(store.id)}/authorization-models`,
          model,
        );
        modelId = stringField(written, "authorization_model_id", "write model");
        modelWritten = true;
      }

      // Full diff: page through what the store holds, keep what matches, collect the rest.
      const pending = new Map(projection.tuples);
      const stale: TupleKey[] = [];
      const replaced: TupleKey[] = [];
      let token = "";
      do {
        const page = await request("POST", `/stores/${encodeURIComponent(store.id)}/read`, {
          page_size: OPENFGA_READ_PAGE,
          consistency: CONSISTENCY,
          ...(token === "" ? {} : { continuation_token: token }),
        });
        const tuples = page["tuples"];
        if (!Array.isArray(tuples)) throw invalid("read without tuples");
        for (const raw of tuples) {
          const existing = parseReadTuple(raw);
          const id = tupleIdentity(existing);
          const wanted = pending.get(id);
          if (wanted === undefined) {
            if (!projection.tuples.has(id)) stale.push(existing);
            continue;
          }
          if (conditionSignature(wanted.condition) === conditionSignature(existing.condition)) {
            pending.delete(id);
          } else {
            replaced.push(existing); // same key, other condition: delete, then write anew
          }
        }
        const next = page["continuation_token"];
        token = typeof next === "string" ? next : "";
      } while (token !== "");

      // Keys whose condition changed must go first (a Write cannot carry a key twice); then the
      // new tuples; then the stale ones.
      await write(store.id, modelId, "deletes", replaced);
      const writes = [...pending.values()];
      await write(store.id, modelId, "writes", writes);
      await write(store.id, modelId, "deletes", stale);
      // This process's edge cache for the store describes the old tree.
      for (const key of edgeCache.keys()) {
        if (key.startsWith(`${store.id}|`)) edgeCache.delete(key);
      }

      const deletes = replaced.length + stale.length;
      if (projection.tooDeep > 0) {
        log?.warn(
          {
            workspaceId: snapshot.workspaceId,
            store: store.id,
            nodes: projection.tooDeep,
            depthLimit,
          },
          "openfga: nodes deeper than the engine resolves; checks on them fail closed",
        );
      }
      log?.info(
        {
          workspaceId: snapshot.workspaceId,
          store: store.id,
          aclVersion: snapshot.aclVersion,
          tuples: projection.tuples.size,
          writes: writes.length,
          deletes,
          modelWritten,
          ms: Date.now() - started,
        },
        "openfga sync",
      );
      return {
        storeRef: store.id,
        modelRef: formatModelRef(modelId, hash),
        writes: writes.length,
        deletes,
      };
    },

    async check(state, q) {
      const { storeId, modelId } = synced(state);
      currentTime(q.at);
      const caps = [...new Set(q.capabilities)];
      const result = Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as Record<
        Capability,
        boolean
      >;
      if (caps.length === 0) return result;
      const types = await typesOf(storeId, modelId);
      const user = userOf(q.membershipId);
      const place = await placementOf(storeId, types, q.resource);
      if (place === undefined) return result; // unknown, untreed kind: nothing grants
      if ("error" in place) throw new RelationshipEngineError(place.error, place.message);
      const items: CheckItem[] = caps.map((relation) => ({ user, relation, ...place }));
      const verdicts = await runChecks(storeId, modelId, items, q.at);
      caps.forEach((cap, i) => {
        const v = verdicts[i] as ItemVerdict;
        // One resource: any failing capability fails the call (the caller fails closed).
        if ("error" in v) throw new RelationshipEngineError(v.error, v.message);
        result[cap] = v.allowed;
      });
      return result;
    },

    async batchCheck(state, q) {
      const { storeId, modelId } = synced(state);
      currentTime(q.at);
      const allowed = new Set<string>();
      const failed = new Map<string, RelationshipEngineErrorCode>();
      if (q.resources.length === 0) return { allowed, failed };
      const types = await typesOf(storeId, modelId);
      const user = userOf(q.membershipId);
      const asked: { readonly id: string; readonly item: CheckItem }[] = [];
      const places = await Promise.all(q.resources.map((r) => placementOf(storeId, types, r)));
      q.resources.forEach((r, i) => {
        const place = places[i];
        if (place === undefined) return;
        if ("error" in place) failed.set(r.id, place.error);
        else asked.push({ id: r.id, item: { user, relation: q.capability, ...place } });
      });
      const verdicts = await runChecks(
        storeId,
        modelId,
        asked.map((a) => a.item),
        q.at,
      );
      asked.forEach((a, i) => {
        const v = verdicts[i] as ItemVerdict;
        if ("error" in v) failed.set(a.id, v.error);
        else if (v.allowed) allowed.add(a.id);
      });
      if (failed.size > 0) {
        log?.warn(
          { store: storeId, failed: failed.size, of: q.resources.length },
          "openfga batch-check: items failed (denied by the caller)",
        );
      }
      return { allowed, failed };
    },

    async dropWorkspace(state) {
      if (state.storeRef === null) return;
      const store = encodeURIComponent(state.storeRef);
      // OpenFGA's DeleteStore is a soft delete: Check keeps answering from the tuples. Delete
      // every tuple first so the workspace's relationships are really gone, then the store.
      try {
        for (;;) {
          const page = await request("POST", `/stores/${store}/read`, {
            page_size: OPENFGA_READ_PAGE,
            consistency: CONSISTENCY,
          });
          const tuples = page["tuples"];
          if (!Array.isArray(tuples)) throw invalid("read without tuples");
          if (tuples.length === 0) break;
          await request("POST", `/stores/${store}/write`, {
            deletes: {
              tuple_keys: tuples.map((raw) => {
                const t = parseReadTuple(raw);
                return { user: t.user, relation: t.relation, object: t.object };
              }),
              on_missing: "ignore",
            },
          });
        }
        await request("DELETE", `/stores/${store}`);
      } catch (error) {
        if (apiErrorOf(error)?.status !== 404) throw error;
      }
      for (const key of modelTypes.keys()) {
        if (key.startsWith(`${state.storeRef}/`)) modelTypes.delete(key);
      }
      for (const key of edgeCache.keys()) {
        if (key.startsWith(`${state.storeRef}|`)) edgeCache.delete(key);
      }
    },

    async healthCheck() {
      // Authenticated, so a wrong preshared key fails here rather than at the first check.
      const body = await request("GET", "/stores?page_size=1");
      if (!Array.isArray(body["stores"])) throw invalid("list stores without stores");
    },
  };
}
