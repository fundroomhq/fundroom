import type {
  Capability,
  EngineState,
  RelationshipEnginePort,
  RelationshipResource,
  RelationshipSnapshot,
  ResourceRef,
  SubjectRef,
} from "@fundroom/ports";
import { CAPABILITIES, RelationshipEngineError } from "@fundroom/ports";
import { resolveNode } from "../evaluate.js";
import { type Rule, subjectKey } from "../model.js";

/*
 * An in-memory `RelationshipEnginePort` that answers with the pure ADR-0032 resolver
 * (`resolveNode`) over the last snapshot it was given — the reference the OpenFGA adapter is
 * proven against. The tree is turned into synthetic ltree paths (ancestor ids joined by `.`), so
 * "nearest node first" is exactly the resolver's path depth. Test seams: `failWith` (every call
 * throws, as an unreachable engine), `dropRule` (a tuple deleted behind the kernel's back).
 */
export interface FakeRelationshipEngine extends RelationshipEnginePort {
  /** Snapshots by store ref, as last synced (rules mutable through `dropRule`). */
  readonly stores: ReadonlyMap<string, RelationshipSnapshot>;
  failWith(error: Error | null): void;
  dropRule(storeRef: string, ruleId: string): boolean;
  /** batchCheck reports these ids as per-item failures (`rejected`). */
  readonly failIds: Set<string>;
  readonly calls: { sync: number; check: number; batchCheck: number; drop: number; health: number };
}

export interface FakeRelationshipEngineOptions {
  readonly driver?: string | undefined;
  /** Artificial latency per call. */
  readonly delayMs?: number | undefined;
}

interface Store {
  snapshot: RelationshipSnapshot;
  paths: Map<string, string | undefined>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFakeRelationshipEngine(
  options: FakeRelationshipEngineOptions = {},
): FakeRelationshipEngine {
  const stores = new Map<string, Store>();
  const snapshots = new Map<string, RelationshipSnapshot>();
  const calls = { sync: 0, check: 0, batchCheck: 0, drop: 0, health: 0 };
  const failIds = new Set<string>();
  let failure: Error | null = null;
  let model = 0;

  async function enter(): Promise<void> {
    if (options.delayMs !== undefined) await sleep(options.delayMs);
    if (failure !== null) throw failure;
  }

  function storeOf(state: EngineState): Store {
    const s = state.storeRef === null ? undefined : stores.get(state.storeRef);
    if (s === undefined) throw new RelationshipEngineError("rejected", "unknown store");
    return s;
  }

  function pathsOf(snapshot: RelationshipSnapshot): Map<string, string | undefined> {
    const byKey = new Map(snapshot.nodes.map((n) => [`${n.kind}:${n.id}`, n]));
    const out = new Map<string, string | undefined>();
    const resolve = (key: string, seen: Set<string>): string | undefined => {
      if (out.has(key)) return out.get(key);
      const node = byKey.get(key);
      if (node === undefined || seen.has(key)) return undefined;
      seen.add(key);
      const parent =
        node.parent === null ? undefined : resolve(`${node.parent.kind}:${node.parent.id}`, seen);
      const path = parent === undefined ? node.id : `${parent}.${node.id}`;
      out.set(key, path);
      return path;
    };
    for (const key of byKey.keys()) resolve(key, new Set());
    return out;
  }

  function decide(
    store: Store,
    membershipId: string,
    resource: RelationshipResource,
    at: Date,
  ): readonly Capability[] {
    const member = store.snapshot.members.find((m) => m.membershipId === membershipId);
    if (member === undefined) return [];
    const subjects: SubjectRef[] = [
      { kind: "membership", id: member.membershipId },
      ...member.linkIds.map((id): SubjectRef => ({ kind: "link", id })),
      ...member.groupIds.map((id): SubjectRef => ({ kind: "group", id })),
      { kind: "role", role: member.role },
    ];
    const keys = new Set(subjects.map(subjectKey));
    const rules: Rule[] = store.snapshot.rules
      .filter((r) => keys.has(subjectKey(r.subject)))
      .map((r) => ({
        grantId: r.id,
        subject: r.subject,
        resource: {
          kind: r.resource.kind,
          id: r.resource.id,
          path: store.paths.get(`${r.resource.kind}:${r.resource.id}`),
        },
        capability: r.capability,
        effect: r.effect,
        validFrom: r.validFrom === null ? undefined : new Date(r.validFrom),
        validUntil: r.validUntil === null ? undefined : new Date(r.validUntil),
      }));
    // Contextual ancestors (nearest first) decide where the node sits now; above the farthest
    // one the synced tree continues.
    const chain = resource.ancestors ?? [];
    let path = store.paths.get(`${resource.kind}:${resource.id}`);
    if (chain.length > 0) {
      const top = chain[chain.length - 1] as { kind: string; id: string };
      const prefix = store.paths.get(`${top.kind}:${top.id}`) ?? top.id;
      path = [
        prefix,
        ...chain
          .slice(0, -1)
          .map((a) => a.id)
          .reverse(),
        resource.id,
      ].join(".");
    }
    const target: ResourceRef = { kind: resource.kind, id: resource.id, path };
    return resolveNode(rules, target, at).capabilities;
  }

  return {
    driver: options.driver ?? "fake",
    stores: snapshots,
    calls,
    failIds,
    failWith(error) {
      failure = error;
    },
    dropRule(storeRef, ruleId) {
      const s = stores.get(storeRef);
      if (s === undefined) return false;
      const rules = s.snapshot.rules.filter((r) => r.id !== ruleId);
      if (rules.length === s.snapshot.rules.length) return false;
      s.snapshot = { ...s.snapshot, rules };
      snapshots.set(storeRef, s.snapshot);
      return true;
    },
    async sync(snapshot, state) {
      calls.sync += 1;
      await enter();
      const storeRef = state.storeRef ?? `fake-${snapshot.workspaceId}`;
      const before = stores.get(storeRef)?.snapshot.rules ?? [];
      const was = new Set(before.map((r) => JSON.stringify(r)));
      const now = new Set(snapshot.rules.map((r) => JSON.stringify(r)));
      const writes = [...now].filter((k) => !was.has(k)).length;
      const deletes = [...was].filter((k) => !now.has(k)).length;
      const copy: RelationshipSnapshot = structuredClone(snapshot);
      stores.set(storeRef, { snapshot: copy, paths: pathsOf(copy) });
      snapshots.set(storeRef, copy);
      model += state.modelRef === null ? 1 : 0;
      return { storeRef, modelRef: state.modelRef ?? `fake-model-${model}`, writes, deletes };
    },
    async check(state, q) {
      calls.check += 1;
      await enter();
      const caps = decide(storeOf(state), q.membershipId, q.resource, q.at);
      const out = {} as Record<Capability, boolean>;
      for (const c of CAPABILITIES) if (q.capabilities.includes(c)) out[c] = caps.includes(c);
      return out;
    },
    async batchCheck(state, q) {
      calls.batchCheck += 1;
      await enter();
      const store = storeOf(state);
      const allowed = new Set<string>();
      const failed = new Map<string, "rejected">();
      for (const r of q.resources) {
        if (failIds.has(r.id)) failed.set(r.id, "rejected");
        else if (decide(store, q.membershipId, r, q.at).includes(q.capability)) allowed.add(r.id);
      }
      return { allowed, failed };
    },
    async dropWorkspace(state) {
      calls.drop += 1;
      await enter();
      if (state.storeRef !== null) {
        stores.delete(state.storeRef);
        snapshots.delete(state.storeRef);
      }
    },
    async healthCheck() {
      calls.health += 1;
      await enter();
    },
  };
}
