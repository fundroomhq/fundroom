import type { Database, Tx } from "@fundroom/db";
import type {
  AccessDecision,
  AccessibleResource,
  Capability,
  RelationshipSnapshot,
} from "@fundroom/ports";
import { RelationshipEngineError } from "@fundroom/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ancestorsOf,
  ENGINE_MAX_TREE_DEPTH,
  ENGINE_RECONCILE_JOB,
  ENGINE_SYNC_JOB,
  type RelationshipEngineMetrics,
  unsyncedPrefix,
  withRelationshipEngine,
} from "./engine.js";
import type { EngineStore, EngineView } from "./repos/engine-state-repo.js";
import type { AuthzService } from "./service.js";
import {
  createFakeRelationshipEngine,
  type FakeRelationshipEngine,
} from "./testing/fake-engine.js";

const WS = "0190d000-0000-7000-8000-000000000001";
const INVESTOR = "0190d000-0000-7000-8000-0000000000a1";
const STAFF = "0190d000-0000-7000-8000-0000000000a2";
const DELEGATE = "0190d000-0000-7000-8000-0000000000a3";
const FOLDER = "0190d000-0000-7000-8000-0000000000f1";
const DOC = "0190d000-0000-7000-8000-0000000000d1";

const snapshot = (aclVersion: number): RelationshipSnapshot => ({
  workspaceId: WS,
  aclVersion,
  nodes: [
    { kind: "folder", id: FOLDER, parent: null },
    { kind: "document", id: DOC, parent: { kind: "folder", id: FOLDER } },
  ],
  members: [{ membershipId: INVESTOR, role: "investor", groupIds: [], linkIds: [] }],
  rules: [rule("r-view", "view"), rule("r-download", "download")],
});

function rule(id: string, capability: Capability) {
  return {
    id,
    subject: { kind: "membership" as const, id: INVESTOR },
    resource: { kind: "folder", id: FOLDER },
    capability,
    effect: "allow" as const,
    validFrom: null,
    validUntil: null,
  };
}

const allow = (caps: Capability[]): AccessDecision => ({
  allowed: true,
  capabilities: caps,
  pendingGates: [],
  reason: "granted",
});
const DENY: AccessDecision = {
  allowed: false,
  capabilities: [],
  pendingGates: [],
  reason: "no_grant",
};

interface Harness {
  engine: FakeRelationshipEngine;
  store: EngineStore & {
    views: Map<string, EngineView>;
    synced: unknown[];
    errors: string[];
    deleted: string[];
  };
  pgDecision: { value: AccessDecision };
  pgList: { value: AccessibleResource[] };
  sent: { name: string; data: unknown; key: string | undefined }[];
  sentInTx: { name: string; data: unknown; key: string | undefined }[];
  metrics: { mismatch: unknown[]; errors: unknown[]; dropped: number } & RelationshipEngineMetrics;
  pg: AuthzService;
}

function harness(): Harness {
  const engine = createFakeRelationshipEngine({ driver: "fake" });
  const views = new Map<string, EngineView>();
  const synced: unknown[] = [];
  const errors: string[] = [];
  const deleted: string[] = [];
  let version = 1;
  const store = {
    views,
    synced,
    errors,
    deleted,
    async view(ws: string) {
      return views.get(ws) ?? { state: undefined, aclVersion: version, deleted: false };
    },
    async snapshot(ws: string) {
      const view = await store.view(ws);
      if (view.deleted) return undefined;
      return { view, snapshot: snapshot(view.aclVersion), at: new Date() };
    },
    async shape(_ws: string, m: string) {
      if (m === INVESTOR) return { kind: "external" as const, role: "investor" };
      if (m === DELEGATE) return { kind: "external" as const, role: "delegate" };
      if (m === STAFF) return { kind: "staff" as const, role: "admin" };
      return undefined;
    },
    async recordSynced(
      ws: string,
      input: {
        storeRef: string | null;
        modelRef: string | null;
        syncedAclVersion: number;
        driver: string;
        leaseOwner?: string | null;
      },
    ) {
      // Fenced like the real one: a sync that no longer owns the lease records nothing.
      if (input.leaseOwner != null && store.lease !== input.leaseOwner) return false;
      synced.push(input);
      const v = await store.view(ws);
      views.set(ws, {
        ...v,
        state: {
          driver: input.driver,
          storeRef: input.storeRef,
          modelRef: input.modelRef,
          syncedAclVersion: input.syncedAclVersion,
          syncedAt: new Date(),
          lastErrorCode: null,
        },
      });
      return true;
    },
    async recordError(_ws: string, _driver: string, code: string) {
      errors.push(code);
    },
    async deleteState(ws: string) {
      deleted.push(ws);
      views.delete(ws);
    },
    async liveWorkspaceIds() {
      return [WS];
    },
    async recentlyDeletedWorkspaceIds() {
      return [];
    },
    async rootFolderId() {
      return FOLDER;
    },
    lease: undefined as string | undefined,
    async claimLease(_ws: string, _driver: string, owner: string) {
      if (store.lease !== undefined && store.lease !== owner) return false;
      store.lease = owner;
      return true;
    },
    async releaseLease(_ws: string, owner: string) {
      if (store.lease === owner) store.lease = undefined;
    },
    foldersBefore: async (): Promise<string[] | undefined> => [FOLDER],
    setVersion(v: number) {
      version = v;
    },
  };
  const pgDecision = { value: allow(["view", "download"]) };
  const pgList = { value: [] as AccessibleResource[] };
  const pg = {
    subscriptions: [],
    jobs: [],
    invalidate: vi.fn(),
    bump: vi.fn(async () => 2),
    check: vi.fn(async () => pgDecision.value),
    listAccessible: vi.fn(async () => pgList.value),
  } as unknown as AuthzService;
  const sent: Harness["sent"] = [];
  const sentInTx: Harness["sentInTx"] = [];
  const m = {
    mismatch: [] as unknown[],
    errors: [] as unknown[],
    dropped: 0,
    shadowMismatch(l: unknown) {
      m.mismatch.push(l);
    },
    engineError(l: unknown) {
      m.errors.push(l);
    },
    shadowDropped() {
      m.dropped += 1;
    },
  };
  return {
    engine,
    store: store as unknown as Harness["store"],
    pgDecision,
    pgList,
    sent,
    sentInTx,
    metrics: m as unknown as Harness["metrics"],
    pg,
  };
}

function compose(h: Harness, mode: "shadow" | "enforce", extra: Record<string, unknown> = {}) {
  return withRelationshipEngine(h.pg, h.engine, {
    mode,
    sample: 1,
    db: {} as Database,
    store: h.store,
    metrics: h.metrics,
    stateTtlMs: 0,
    memberTtlMs: 0,
    queue: {
      send: async (name, data, o) => {
        h.sent.push({ name, data, key: o?.idempotencyKey });
        return "job";
      },
      sendInTransaction: async (_tx, name, data, o) => {
        h.sentInTx.push({ name, data, key: o?.idempotencyKey });
        return "job";
      },
    },
    ...extra,
  });
}

const principal = (membershipId: string) => ({ workspaceId: WS, membershipId });
const doc = { kind: "document", id: DOC };

async function synced(h: Harness, mode: "shadow" | "enforce", extra?: Record<string, unknown>) {
  const authz = compose(h, mode, extra);
  expect((await authz.engine.syncWorkspace(WS)).status).toBe("synced");
  return authz;
}

describe("withRelationshipEngine — enforce", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("in sync, the engine agrees and the decision is Postgres's", async () => {
    const authz = await synced(h, "enforce");
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(
      allow(["view", "download"]),
    );
  });

  it("the engine can narrow: a tuple gone behind our back denies", async () => {
    const authz = await synced(h, "enforce");
    expect(h.engine.dropRule(`fake-${WS}`, "r-download")).toBe(true);
    expect(await authz.check(principal(INVESTOR), doc, "download")).toEqual({
      allowed: false,
      capabilities: ["view"],
      pendingGates: [],
      reason: "no_grant",
    });
    // The asked capability survives: allowed, with the narrowed list.
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(allow(["view"]));
  });

  it("the engine can never widen: Postgres's deny stands (and the engine is not asked)", async () => {
    const authz = await synced(h, "enforce");
    h.pgDecision.value = DENY;
    const calls = h.engine.calls.check;
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
    expect(h.engine.calls.check).toBe(calls);
    // PG grants view only; the engine would also grant download — still view only.
    h.pgDecision.value = allow(["view"]);
    expect(await authz.check(principal(INVESTOR), doc, "download")).toEqual(allow(["view"]));
  });

  it("a gated Postgres answer stays gated when the engine agrees", async () => {
    const authz = await synced(h, "enforce");
    const gated: AccessDecision = {
      allowed: false,
      capabilities: ["view"],
      pendingGates: [{ kind: "nda", detail: {}, source: "workspace" }],
      reason: "gated",
    };
    h.pgDecision.value = gated;
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(gated);
  });

  it("an engine error fails closed (check denies, list is empty) and is counted", async () => {
    const authz = await synced(h, "enforce");
    h.pgList.value = [
      {
        kind: "document",
        id: DOC,
        capabilities: ["view"],
        pendingGates: [],
        path: undefined,
        expiresAt: undefined,
      },
    ];
    h.engine.failWith(new RelationshipEngineError("unreachable", "down"));
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
    expect(await authz.listAccessible(principal(INVESTOR), "document")).toEqual([]);
    expect(h.metrics.errors).toEqual([
      { operation: "check", code: "unreachable" },
      { operation: "batch_check", code: "unreachable" },
    ]);
  });

  it("a non-engine error fails closed too (code internal)", async () => {
    const authz = await synced(h, "enforce");
    h.engine.failWith(new TypeError("boom"));
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
    expect(h.metrics.errors).toEqual([{ operation: "check", code: "internal" }]);
  });

  it("the call backstop times out a hung engine and fails closed", async () => {
    h.engine = createFakeRelationshipEngine({ driver: "fake", delayMs: 200 });
    const authz = await synced(h, "enforce", { callTimeoutMs: 20 });
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
    expect(h.metrics.errors).toEqual([{ operation: "check", code: "timeout" }]);
  });

  it("never synced: fails closed and kicks a sync", async () => {
    const authz = compose(h, "enforce");
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
    expect(h.metrics.errors).toEqual([{ operation: "check", code: "not_synced" }]);
    await vi.waitFor(() =>
      expect(h.sent).toEqual([
        { name: ENGINE_SYNC_JOB, data: { workspaceId: WS }, key: `${ENGINE_SYNC_JOB}:${WS}` },
      ]),
    );
  });

  it("a state written by another driver counts as never synced", async () => {
    const authz = await synced(h, "enforce");
    const v = await h.store.view(WS);
    h.store.views.set(WS, {
      ...v,
      state: { ...(v.state as NonNullable<EngineView["state"]>), driver: "other" },
    });
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(DENY);
  });

  it("stale (synced version behind): still intersects, and kicks a sync", async () => {
    const authz = await synced(h, "enforce");
    const v = await h.store.view(WS);
    h.store.views.set(WS, { ...v, aclVersion: v.aclVersion + 3 });
    h.engine.dropRule(`fake-${WS}`, "r-view");
    expect((await authz.check(principal(INVESTOR), doc, "view")).allowed).toBe(false);
    await vi.waitFor(() => expect(h.sent.map((s) => s.name)).toEqual([ENGINE_SYNC_JOB]));
  });

  it("staff and delegates are Postgres-only: the engine is never asked", async () => {
    const authz = await synced(h, "enforce");
    h.engine.failWith(new RelationshipEngineError("unreachable", "down"));
    for (const m of [STAFF, DELEGATE]) {
      expect(await authz.check(principal(m), doc, "view")).toEqual(allow(["view", "download"]));
      h.pgList.value = [
        {
          kind: "document",
          id: DOC,
          capabilities: ["view"],
          pendingGates: [],
          path: undefined,
          expiresAt: undefined,
        },
      ];
      expect(await authz.listAccessible(principal(m), "document")).toHaveLength(1);
    }
    expect(h.metrics.errors).toEqual([]);
  });

  it("listAccessible keeps only what the engine allows, BatchCheck in chunks of 50", async () => {
    const authz = await synced(h, "enforce");
    const items: AccessibleResource[] = Array.from({ length: 120 }, (_, i) => ({
      kind: "document",
      id: i === 7 ? DOC : `0190d000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      capabilities: ["view"],
      pendingGates: [],
      path: undefined,
      expiresAt: undefined,
    }));
    h.pgList.value = items;
    const before = h.engine.calls.batchCheck;
    const got = await authz.listAccessible(principal(INVESTOR), "document");
    expect(got.map((r) => r.id)).toEqual([DOC]);
    expect(h.engine.calls.batchCheck - before).toBe(3);
  });
});

describe("withRelationshipEngine — shadow", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("never changes a decision; mismatches are counted per capability and direction", async () => {
    const authz = await synced(h, "shadow");
    h.engine.dropRule(`fake-${WS}`, "r-download");
    h.pgDecision.value = allow(["view", "download"]);
    expect(await authz.check(principal(INVESTOR), doc, "download")).toEqual(
      allow(["view", "download"]),
    );
    await authz.engine.shadowIdle();
    expect(h.metrics.mismatch).toEqual([
      { capability: "download", direction: "pg_only", stale: false },
    ]);
    h.pgDecision.value = allow(["view"]);
    h.engine.dropRule(`fake-${WS}`, "nothing");
    await authz.check(principal(INVESTOR), doc, "view");
    await authz.engine.shadowIdle();
    expect(h.metrics.mismatch).toHaveLength(1);
  });

  it("engine-only grants are counted as such", async () => {
    const authz = await synced(h, "shadow");
    h.pgDecision.value = allow(["view"]);
    await authz.check(principal(INVESTOR), doc, "view");
    await authz.engine.shadowIdle();
    expect(h.metrics.mismatch).toEqual([
      { capability: "download", direction: "engine_only", stale: false },
    ]);
  });

  it("an engine error never reaches the caller", async () => {
    const authz = await synced(h, "shadow");
    h.engine.failWith(new RelationshipEngineError("timeout", "slow"));
    expect(await authz.check(principal(INVESTOR), doc, "view")).toEqual(
      allow(["view", "download"]),
    );
    await authz.engine.shadowIdle();
    expect(h.metrics.errors).toEqual([{ operation: "check", code: "timeout" }]);
  });

  it("sample 0 never asks the engine; staff are never compared", async () => {
    const off = await synced(h, "shadow", { sample: 0 });
    const calls = h.engine.calls.check;
    await off.check(principal(INVESTOR), doc, "view");
    await off.engine.shadowIdle();
    const on = compose(h, "shadow");
    await on.check(principal(STAFF), doc, "view");
    await on.engine.shadowIdle();
    expect(h.engine.calls.check).toBe(calls);
  });

  it("bounded: comparisons beyond the concurrency limit are dropped and counted", async () => {
    h.engine = createFakeRelationshipEngine({ driver: "fake", delayMs: 50 });
    const authz = await synced(h, "shadow", {
      shadowConcurrency: 2,
      memberTtlMs: 60_000,
      stateTtlMs: 60_000,
    });
    await Promise.all(
      Array.from({ length: 6 }, () => authz.check(principal(INVESTOR), doc, "view")),
    );
    await authz.engine.shadowIdle();
    expect(h.metrics.dropped).toBe(4);
    expect(h.engine.calls.check).toBe(2);
  });

  it("listAccessible is Postgres's untouched", async () => {
    const authz = await synced(h, "shadow");
    h.engine.failWith(new RelationshipEngineError("unreachable", "down"));
    h.pgList.value = [
      {
        kind: "document",
        id: DOC,
        capabilities: ["view"],
        pendingGates: [],
        path: undefined,
        expiresAt: undefined,
      },
    ];
    expect(await authz.listAccessible(principal(INVESTOR), "document")).toHaveLength(1);
  });
});

describe("withRelationshipEngine — sync, subscription, reconcile", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("sync records refs and the snapshot's acl_version; a failure records its code and throws from the job", async () => {
    const authz = compose(h, "shadow");
    const ok = await authz.engine.syncWorkspace(WS);
    expect(ok).toMatchObject({ status: "synced", aclVersion: 1, writes: 2, deletes: 0 });
    expect(h.store.synced).toEqual([
      expect.objectContaining({ driver: "fake", storeRef: `fake-${WS}`, syncedAclVersion: 1 }),
    ]);
    h.engine.failWith(new RelationshipEngineError("rejected", "nope"));
    const job = authz.jobs.find((j) => j.name === ENGINE_SYNC_JOB);
    await expect(
      job?.handler({
        id: "1",
        name: ENGINE_SYNC_JOB,
        data: { workspaceId: WS },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/rejected/u);
    expect(h.store.errors).toEqual(["rejected"]);
    expect(h.metrics.errors).toEqual([{ operation: "sync", code: "rejected" }]);
  });

  it("the sync job is stately per workspace and ignores a malformed payload", async () => {
    const authz = compose(h, "shadow");
    const job = authz.jobs.find((j) => j.name === ENGINE_SYNC_JOB);
    expect(job?.queue?.policy).toBe("stately");
    await job?.handler({
      id: "1",
      name: ENGINE_SYNC_JOB,
      data: { workspaceId: "x" },
      signal: new AbortController().signal,
    });
    expect(h.engine.calls.sync).toBe(0);
  });

  it("a deleted workspace is skipped", async () => {
    h.store.views.set(WS, { state: undefined, aclVersion: 4, deleted: true });
    const authz = compose(h, "shadow");
    expect(await authz.engine.syncWorkspace(WS)).toEqual({ status: "skipped" });
    expect(h.engine.calls.sync).toBe(0);
  });

  it("acl.changed enqueues the sync in the event's transaction; host events are ignored", async () => {
    const authz = compose(h, "shadow");
    const sub = authz.subscriptions.find((s) => s.id === "authz.engine_sync");
    expect(sub?.topic).toBe("acl.changed");
    const tx = {} as Tx;
    await sub?.handler({} as never, {
      tx,
      ctx: { workspaceId: WS, actorKind: "system" },
      job: {} as never,
    });
    await sub?.handler({} as never, { tx, ctx: { actorKind: "host" } as never, job: {} as never });
    expect(h.sentInTx).toEqual([
      { name: ENGINE_SYNC_JOB, data: { workspaceId: WS }, key: `${ENGINE_SYNC_JOB}:${WS}` },
    ]);
  });

  it("reconcile enqueues lagging or failed workspaces only, and drops deleted ones", async () => {
    const authz = compose(h, "shadow");
    const reconcile = authz.jobs.find((j) => j.name === ENGINE_RECONCILE_JOB);
    expect(reconcile?.cron).toBe("35 * * * *");
    const run = () =>
      reconcile?.handler({
        id: "r",
        name: ENGINE_RECONCILE_JOB,
        data: {},
        signal: new AbortController().signal,
      });
    await run(); // never synced → enqueued
    expect(h.sent).toHaveLength(1);
    await authz.engine.syncWorkspace(WS);
    await run(); // current → nothing
    expect(h.sent).toHaveLength(1);
    const v = await h.store.view(WS);
    h.store.views.set(WS, { ...v, aclVersion: v.aclVersion + 1 });
    await run(); // lagging → enqueued
    expect(h.sent).toHaveLength(2);
    // Deleted: the store is dropped and the state row removed.
    h.store.liveWorkspaceIds = async () => [];
    h.store.recentlyDeletedWorkspaceIds = async () => [WS];
    await run();
    expect(h.engine.calls.drop).toBe(1);
    expect(h.store.deleted).toEqual([WS]);
    expect(h.engine.stores.size).toBe(0);
  });

  it("bump and invalidate drop the cached engine view", async () => {
    const authz = await synced(h, "enforce", { stateTtlMs: 60_000 });
    await authz.check(principal(INVESTOR), doc, "view");
    const v = await h.store.view(WS);
    h.store.views.set(WS, { ...v, state: undefined });
    // Cached: still answers from the old view.
    expect((await authz.check(principal(INVESTOR), doc, "view")).allowed).toBe(true);
    authz.invalidate(WS);
    expect((await authz.check(principal(INVESTOR), doc, "view")).allowed).toBe(false);
  });
});

const hex = (id: string) => id.replace(/-/gu, "");

describe("FIX1: ancestors, per-item failures, locks, shadow", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("ancestorsOf reads the chain from the path, nearest first, root resolved", () => {
    const sub = "0190d000-0000-7000-8000-0000000000f2";
    expect(ancestorsOf({ kind: "document", id: DOC, path: `r.${hex(sub)}` }, FOLDER)).toEqual([
      { kind: "folder", id: sub },
      { kind: "folder", id: FOLDER },
    ]);
    // A folder's own label is not its ancestor.
    expect(ancestorsOf({ kind: "folder", id: sub, path: `r.${hex(sub)}` }, FOLDER)).toEqual([
      { kind: "folder", id: FOLDER },
    ]);
    expect(ancestorsOf({ kind: "folder", id: FOLDER, path: "r" }, FOLDER)).toEqual([]);
    expect(ancestorsOf({ kind: "document", id: DOC, path: "r" }, FOLDER)).toEqual([
      { kind: "folder", id: FOLDER },
    ]);
    // Unknown root, odd labels, flat kinds: the chain stops (the synced tree answers above).
    expect(ancestorsOf({ kind: "document", id: DOC, path: "r" }, undefined)).toEqual([]);
    expect(ancestorsOf({ kind: "document", id: DOC, path: `x.${hex(sub)}` }, FOLDER)).toEqual([
      { kind: "folder", id: sub },
    ]);
    expect(ancestorsOf({ kind: "post", id: DOC, path: "r" }, FOLDER)).toEqual([]);
  });

  it("R3-1: a document created after the sync is decided through its current ancestors", async () => {
    const authz = await synced(h, "enforce");
    const fresh = "0190d000-0000-7000-8000-0000000000d9";
    // Not in the snapshot; it sits in the root folder (path `r`), which the rule covers.
    expect(
      await authz.check(principal(INVESTOR), { kind: "document", id: fresh, path: "r" }, "view"),
    ).toEqual(allow(["view", "download"]));
    // Without a path the engine has nothing to go on: narrowed to a deny.
    expect(
      (await authz.check(principal(INVESTOR), { kind: "document", id: fresh }, "view")).allowed,
    ).toBe(false);
  });

  it("R3-3: one undecidable item is denied alone; the rest of the list stands", async () => {
    const authz = await synced(h, "enforce");
    const other = "0190d000-0000-7000-8000-0000000000d2";
    h.pgList.value = [
      {
        kind: "folder",
        id: FOLDER,
        path: "r",
        capabilities: ["view"],
        pendingGates: [],
        expiresAt: undefined,
      },
      {
        kind: "document",
        id: other,
        path: undefined,
        capabilities: ["view"],
        pendingGates: [],
        expiresAt: undefined,
      },
    ];
    h.engine.failIds.add(other);
    const got = await authz.listAccessible(principal(INVESTOR), "folder");
    expect(got.map((r) => r.id)).toEqual([FOLDER]);
    expect(h.metrics.errors).toEqual([{ operation: "batch_check", code: "rejected" }]);
  });

  it("R3-4: a second sync of the same workspace while one runs is busy, and the job retries", async () => {
    h.engine = createFakeRelationshipEngine({ driver: "fake", delayMs: 50 });
    const authz = compose(h, "enforce");
    const [a, b] = await Promise.all([
      authz.engine.syncWorkspace(WS),
      authz.engine.syncWorkspace(WS),
    ]);
    expect([a.status, b.status].sort()).toEqual(["busy", "synced"]);
    expect(h.engine.calls.sync).toBe(1);
  });

  it("R3-4: the workspace moved on during the push → another sync is enqueued", async () => {
    let calls = 0;
    const view = h.store.view.bind(h.store);
    h.store.view = async (ws: string) => {
      calls += 1;
      const v = await view(ws);
      // The re-read after the push sees a newer acl_version.
      return calls >= 2 ? { ...v, aclVersion: v.aclVersion + 1 } : v;
    };
    const authz = compose(h, "enforce");
    expect((await authz.engine.syncWorkspace(WS)).status).toBe("synced");
    expect(h.sent.map((x) => x.name)).toEqual([ENGINE_SYNC_JOB]);
  });

  it("R3-6: shadow kicks a sync when stale and labels the mismatch stale", async () => {
    const authz = await synced(h, "shadow");
    const v = await h.store.view(WS);
    h.store.views.set(WS, { ...v, aclVersion: v.aclVersion + 1 });
    h.pgDecision.value = allow(["view"]);
    await authz.check(principal(INVESTOR), doc, "view");
    await authz.engine.shadowIdle();
    expect(h.metrics.mismatch).toEqual([
      { capability: "download", direction: "engine_only", stale: true },
    ]);
    await vi.waitFor(() => expect(h.sent.map((x) => x.name)).toEqual([ENGINE_SYNC_JOB]));
  });

  it("R3-8: staff and delegates never take a shadow slot", async () => {
    h.engine = createFakeRelationshipEngine({ driver: "fake", delayMs: 50 });
    const authz = await synced(h, "shadow", { shadowConcurrency: 1, memberTtlMs: 60_000 });
    // Warm the shape cache, then hold the only slot with an investor comparison.
    await authz.check(principal(STAFF), doc, "view");
    await authz.check(principal(DELEGATE), doc, "view");
    await authz.engine.shadowIdle();
    await authz.check(principal(INVESTOR), doc, "view");
    await authz.engine.shadowIdle();
    const p = authz.check(principal(INVESTOR), doc, "view");
    for (let i = 0; i < 5; i++) await authz.check(principal(STAFF), doc, "view");
    await p;
    await authz.engine.shadowIdle();
    expect(h.metrics.dropped).toBe(0);
  });
});

describe("FIX2: only unsynced ancestors, depth caps, lease fencing", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  const F2 = "0190d000-0000-7000-8000-0000000000f2";
  const F3 = "0190d000-0000-7000-8000-0000000000f3";
  const f = (id: string) => ({ kind: "folder", id });

  it("unsyncedPrefix: own parent edge always, then only while unsynced", () => {
    expect(unsyncedPrefix([f(F3), f(F2), f(FOLDER)], new Set([F3]))).toEqual([f(F3)]);
    expect(unsyncedPrefix([f(F3), f(F2), f(FOLDER)], new Set([F2]))).toEqual([f(F3), f(F2)]);
    expect(unsyncedPrefix([f(F3), f(F2), f(FOLDER)], new Set())).toEqual([f(F3), f(F2), f(FOLDER)]);
    // Unknown / over budget: the whole chain (capped by the caller; the adapter trims stored edges).
    expect(unsyncedPrefix([f(F3), f(F2), f(FOLDER)], undefined)).toEqual([f(F3), f(F2), f(FOLDER)]);
  });

  it("the engine never receives synced edges (no duplicated chain)", async () => {
    const seen: unknown[] = [];
    const check = h.engine.check.bind(h.engine);
    h.engine = Object.assign(h.engine, {
      check: async (st: Parameters<typeof check>[0], q: Parameters<typeof check>[1]) => {
        seen.push(q.resource.ancestors);
        return check(st, q);
      },
    });
    const authz = await synced(h, "enforce");
    const deep = { kind: "document", id: DOC, path: `r.${hex(F2)}.${hex(F3)}` };
    // Only the root is synced: F3 and F2 are new → both sent, plus the root edge.
    await authz.check(principal(INVESTOR), deep, "view");
    // F2 synced too → the chain stops at F2.
    h.store.foldersBefore = async () => [FOLDER, F2];
    authz.invalidate(WS);
    const v = await h.store.view(WS);
    h.store.views.set(WS, {
      ...v,
      state: {
        ...(v.state as NonNullable<EngineView["state"]>),
        syncedAt: new Date(Date.now() + 1),
      },
    });
    await authz.check(principal(INVESTOR), deep, "view");
    expect(seen).toEqual([
      [f(F3), f(F2), f(FOLDER)],
      [f(F3), f(F2)],
    ]);
  });

  it("a chain deeper than the cap is refused before the engine (enforce deny, shadow skipped)", async () => {
    const path = [
      "r",
      ...Array.from({ length: ENGINE_MAX_TREE_DEPTH }, (_, i) => `${String(i).padStart(32, "a")}`),
    ].join(".");
    const deep = { kind: "document", id: DOC, path };
    const enforced = await synced(h, "enforce");
    const calls = h.engine.calls.check;
    expect((await enforced.check(principal(INVESTOR), deep, "view")).allowed).toBe(false);
    expect(h.engine.calls.check).toBe(calls);
    expect(h.metrics.errors).toEqual([{ operation: "check", code: "rejected" }]);
    const skipped: string[] = [];
    const shadowed = compose(h, "shadow", {
      metrics: { ...h.metrics, shadowSkipped: (r: string) => skipped.push(r) },
    });
    expect((await shadowed.check(principal(INVESTOR), deep, "view")).allowed).toBe(true);
    await shadowed.engine.shadowIdle();
    expect(skipped).toEqual(["too_deep"]);
    expect(h.engine.calls.check).toBe(calls);
  });

  it("a sync whose lease was taken over records nothing and re-enqueues", async () => {
    h.engine = createFakeRelationshipEngine({ driver: "fake", delayMs: 30 });
    const authz = compose(h, "enforce");
    const p = authz.engine.syncWorkspace(WS);
    await new Promise((r) => setTimeout(r, 10));
    (h.store as unknown as { lease: string }).lease = "someone-else";
    expect((await p).status).toBe("skipped");
    expect(h.store.synced).toEqual([]);
    expect(h.sent.map((x) => x.name)).toEqual([ENGINE_SYNC_JOB]);
  });
});

describe("FIX2 C10: error codes are logged as errorCode (the server logger redacts `code`)", () => {
  it("engine_error and engine_sync_failed carry errorCode, never code", async () => {
    const h = harness();
    const lines: Record<string, unknown>[] = [];
    const authz = compose(h, "enforce", {
      log: (_e: string, f?: Record<string, unknown>) => lines.push(f ?? {}),
    });
    await authz.engine.syncWorkspace(WS);
    h.engine.failWith(new RelationshipEngineError("unreachable", "down"));
    await authz.check(principal(INVESTOR), doc, "view");
    await authz.engine.syncWorkspace(WS);
    const failures = lines.filter((l) => "errorCode" in l);
    expect(failures.map((l) => l["errorCode"])).toEqual(["unreachable", "unreachable"]);
    expect(lines.some((l) => "code" in l)).toBe(false);
  });
});

describe("FIX3 RR2-1: a deny the engine cannot cure without a sync kicks one", () => {
  it("a cut unsynced chain (> 8 new folders) kicks one sync per synced generation", async () => {
    const h = harness();
    h.store.foldersBefore = async () => []; // nothing known-synced: every folder is new
    const authz = await synced(h, "enforce");
    const labels = Array.from({ length: 10 }, (_, i) => String(i).padStart(32, "b"));
    const deep = { kind: "document", id: DOC, path: ["r", ...labels].join(".") };
    await authz.check(principal(INVESTOR), deep, "view");
    await authz.check(principal(INVESTOR), deep, "view");
    await vi.waitFor(() => expect(h.sent.map((x) => x.name)).toEqual([ENGINE_SYNC_JOB]));
    // A chain within the cap kicks nothing.
    const h2 = harness();
    h2.store.foldersBefore = async () => [];
    const ok = await synced(h2, "enforce");
    await ok.check(
      principal(INVESTOR),
      { kind: "document", id: DOC, path: `r.${labels[0]}` },
      "view",
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(h2.sent).toEqual([]);
  });

  it("an item the engine refuses (unknown kind) kicks a sync; transport errors do not", async () => {
    const h = harness();
    const authz = await synced(h, "enforce");
    h.engine.failWith(new RelationshipEngineError("unreachable", "down"));
    await authz.check(principal(INVESTOR), doc, "view");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent).toEqual([]);
    h.engine.failWith(new RelationshipEngineError("rejected", "unknown type document"));
    await authz.check(principal(INVESTOR), doc, "view");
    await vi.waitFor(() => expect(h.sent.map((x) => x.name)).toEqual([ENGINE_SYNC_JOB]));
  });
});
