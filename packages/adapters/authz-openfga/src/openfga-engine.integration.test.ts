import { type Principal, type Rule, resolveNode, rulesFor } from "@fundroom/authz";
import {
  CAPABILITIES,
  type Capability,
  type EngineState,
  type RelationshipEngineError,
  type RelationshipEnginePort,
  type RelationshipMember,
  type RelationshipNode,
  type RelationshipNodeRef,
  type RelationshipResource,
  type RelationshipRule,
  type RelationshipSnapshot,
  type ResourceRef,
  type SubjectRef,
} from "@fundroom/ports";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenFgaEngine, OPENFGA_DEFAULT_DEPTH_LIMIT, openFgaStoreName } from "./engine.js";

/*
 * The key acceptance test of the OpenFGA adapter (E3.13): a DIFFERENTIAL property test against a
 * real OpenFGA server. Random worlds — folder trees up to depth 5, documents, flat posts, members
 * with groups/links/roles, allow/exclude rules at random nodes with random validity windows — are
 * synced, then the engine's answer for every (member, resource, capability, at) is compared with
 * `packages/authz`'s pure ADR-0032 resolver (`resolveNode(rulesFor(rules, principal), …)`), the
 * same function the Postgres engine materialises. `@fundroom/authz` is a TEST-ONLY import here.
 *
 * Seeds are fixed so a failure reproduces; FUNDROOM_FGA_SEED=<n> runs one extra seed.
 */
const IMAGE = process.env["FUNDROOM_TEST_OPENFGA_IMAGE"] ?? "openfga/openfga:v1.21.0";
const PORT = 8080;
const TOKEN = "fundroom-test-preshared-key";

let container: StartedTestContainer;
let url: string;
let engine: RelationshipEnginePort;

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withCommand(["run"])
    .withEnvironment({
      OPENFGA_AUTHN_METHOD: "preshared",
      OPENFGA_AUTHN_PRESHARED_KEYS: TOKEN,
      OPENFGA_PLAYGROUND_ENABLED: "false",
      OPENFGA_LOG_LEVEL: "warn",
    })
    .withExposedPorts(PORT)
    .withWaitStrategy(Wait.forHttp("/healthz", PORT))
    .withStartupTimeout(120_000)
    .start();
  url = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
  engine = createOpenFgaEngine({ url, apiToken: TOKEN, http: fetch, timeoutMs: 10_000 });
});

afterAll(async () => {
  await container?.stop();
});

// --- seeded random worlds ----------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  subset<T>(items: readonly T[], p: number): T[];
}

function rngOf(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    chance: (p) => next() < p,
    subset: (items, p) => items.filter(() => next() < p),
  };
}

interface Folder {
  readonly id: string;
  readonly parent: string | null;
  readonly path: string;
}
interface Doc {
  readonly id: string;
  readonly folder: string | null;
}
interface World {
  readonly workspaceId: string;
  folders: Folder[];
  docs: Doc[];
  posts: string[];
  members: RelationshipMember[];
  groups: string[];
  links: string[];
  roles: string[];
  rules: RelationshipRule[];
  /** Interesting instants: rule boundaries ± 1 ms and random ones. */
  times: Date[];
}

const BASE = Date.parse("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
let ruleSeq = 0;

function randomWindow(rng: Rng): { validFrom: string | null; validUntil: string | null } {
  const roll = rng.next();
  if (roll < 0.45) return { validFrom: null, validUntil: null };
  const a = BASE + rng.int(-20, 20) * DAY + rng.int(0, DAY - 1);
  const b = a + rng.int(1, 15) * DAY + rng.int(0, 999);
  if (roll < 0.6) return { validFrom: new Date(a).toISOString(), validUntil: null };
  if (roll < 0.75) return { validFrom: null, validUntil: new Date(b).toISOString() };
  return { validFrom: new Date(a).toISOString(), validUntil: new Date(b).toISOString() };
}

function randomRule(rng: Rng, w: World): RelationshipRule {
  const memberIds = w.members.map((m) => m.membershipId);
  const kindRoll = rng.next();
  const subject: SubjectRef =
    kindRoll < 0.3
      ? { kind: "membership", id: rng.chance(0.9) ? rng.pick(memberIds) : "m-outsider" }
      : kindRoll < 0.5
        ? { kind: "link", id: rng.pick(w.links) }
        : kindRoll < 0.8
          ? { kind: "group", id: rng.pick(w.groups) }
          : { kind: "role", role: rng.pick(w.roles) };
  const resRoll = rng.next();
  const resource =
    resRoll < 0.55 || w.docs.length === 0
      ? { kind: "folder", id: rng.pick(w.folders).id }
      : resRoll < 0.9
        ? { kind: "document", id: rng.pick(w.docs).id }
        : { kind: "post", id: rng.pick(w.posts) };
  ruleSeq++;
  return {
    id: `0190a0b0-0000-7000-8000-${String(ruleSeq).padStart(12, "0")}`,
    subject,
    resource,
    capability: rng.chance(0.5) ? "view" : rng.pick(CAPABILITIES),
    effect: rng.chance(0.35) ? "exclude" : "allow",
    ...randomWindow(rng),
  };
}

function randomWorld(seed: number, size: { folders: number; docs: number; rules: number }): World {
  const rng = rngOf(seed);
  const w: World = {
    workspaceId: crypto.randomUUID(),
    folders: [],
    docs: [],
    posts: ["p1", "p2"],
    members: [],
    groups: ["g1", "g2", "g3"],
    links: ["l1", "l2"],
    roles: ["investor", "advisor"],
    rules: [],
    times: [],
  };
  for (let i = 0; i < size.folders; i++) {
    const candidates = w.folders.filter((f) => f.path.split(".").length < 5);
    const parent = i === 0 || rng.chance(0.08) ? null : rng.pick(candidates);
    const id = `f${seed}x${i}`;
    w.folders.push({ id, parent: parent?.id ?? null, path: parent ? `${parent.path}.${id}` : id });
  }
  for (let i = 0; i < size.docs; i++) {
    w.docs.push({ id: `d${seed}x${i}`, folder: rng.chance(0.95) ? rng.pick(w.folders).id : null });
  }
  for (let i = 0; i < rng.int(3, 6); i++) {
    w.members.push({
      membershipId: `m${i}`,
      role: rng.pick(w.roles),
      groupIds: rng.subset(w.groups, 0.4),
      linkIds: rng.subset(w.links, 0.3),
    });
  }
  for (let i = 0; i < size.rules; i++) w.rules.push(randomRule(rng, w));
  // Same subject/resource/capability/effect, different window: OpenFGA keys tuples without the
  // condition, so this is the case the grant indirection exists for.
  if (w.rules.length > 0) {
    const twin = rng.pick(w.rules);
    w.rules.push({ ...twin, id: `${twin.id.slice(0, -4)}ffff`, ...randomWindow(rng) });
    // Full ties (same node, same tier, both effects): exclude must win. Two of them, on rules of
    // different subjects of one tier where possible.
    for (let i = 0; i < 2; i++) {
      const base = rng.pick(w.rules);
      const sameTier = w.rules.filter((r) => r.subject.kind === base.subject.kind);
      const other = rng.pick(sameTier);
      w.rules.push({
        ...base,
        subject: other.subject,
        id: `${base.id.slice(0, -4)}eee${i}`,
        effect: base.effect === "allow" ? "exclude" : "allow",
        validFrom: null,
        validUntil: null,
      });
    }
  }
  refreshTimes(rng, w);
  return w;
}

function refreshTimes(rng: Rng, w: World): void {
  const times = new Set<number>([BASE]);
  for (const r of w.rules) {
    for (const b of [r.validFrom, r.validUntil]) {
      if (b === null) continue;
      const t = Date.parse(b);
      times
        .add(t - 1)
        .add(t)
        .add(t + 1);
    }
  }
  const all = [...times];
  const picked = rng.subset(all, Math.min(1, 6 / Math.max(1, all.length))).slice(0, 5);
  for (let i = 0; i < 3; i++) picked.push(BASE + rng.int(-25, 40) * DAY + rng.int(0, DAY - 1));
  w.times = [...new Set(picked)].map((t) => new Date(t));
}

function snapshotOf(w: World, aclVersion = 1): RelationshipSnapshot {
  const nodes: RelationshipNode[] = [
    ...w.folders.map((f) => ({
      kind: "folder",
      id: f.id,
      parent: f.parent === null ? null : { kind: "folder", id: f.parent },
    })),
    ...w.docs.map((d) => ({
      kind: "document",
      id: d.id,
      parent: d.folder === null ? null : { kind: "folder", id: d.folder },
    })),
    ...w.posts.map((id) => ({ kind: "post", id, parent: null })),
  ];
  return { workspaceId: w.workspaceId, aclVersion, nodes, members: w.members, rules: w.rules };
}

// --- the reference: packages/authz's resolver over the same world -----------------------------

function folderPath(w: World, id: string): string {
  const f = w.folders.find((x) => x.id === id);
  if (f === undefined) throw new Error(`no folder ${id}`);
  return f.path;
}

/** The ResourceRef the Postgres engine resolves: a folder at its own path, a document at its folder's. */
function resourceRefOf(w: World, kind: string, id: string): ResourceRef {
  if (kind === "folder") return { kind, id, path: folderPath(w, id) };
  if (kind === "document") {
    const d = w.docs.find((x) => x.id === id);
    return d?.folder ? { kind, id, path: folderPath(w, d.folder) } : { kind, id };
  }
  return { kind, id };
}

function authzRulesOf(w: World): Rule[] {
  return w.rules.map((r) => ({
    grantId: r.id,
    subject: r.subject,
    // A rule on a folder carries the folder's own path (derivedRulePath); documents and flat
    // kinds carry none.
    resource:
      r.resource.kind === "folder"
        ? { ...r.resource, path: folderPath(w, r.resource.id) }
        : { ...r.resource },
    capability: r.capability,
    effect: r.effect,
    validFrom: r.validFrom === null ? undefined : new Date(r.validFrom),
    validUntil: r.validUntil === null ? undefined : new Date(r.validUntil),
  }));
}

function principalOf(m: RelationshipMember): Principal {
  return {
    membershipId: m.membershipId,
    kind: "external",
    role: m.role,
    groupIds: m.groupIds,
    linkIds: m.linkIds,
    attestations: [],
  };
}

function expected(rules: Rule[], m: RelationshipMember, res: ResourceRef, at: Date) {
  const caps = resolveNode(rulesFor(rules, principalOf(m)), res, at).capabilities;
  return Object.fromEntries(CAPABILITIES.map((c) => [c, caps.includes(c)])) as Record<
    Capability,
    boolean
  >;
}

/** The folder chain above a folder id, nearest first (the folder itself first). */
function folderChain(w: World, id: string | null): RelationshipNodeRef[] {
  const out: RelationshipNodeRef[] = [];
  let cur = id;
  while (cur !== null) {
    out.push({ kind: "folder", id: cur });
    cur = w.folders.find((f) => f.id === cur)?.parent ?? null;
  }
  return out;
}

/**
 * Every resource of the world; with `ancestors`, each carries its chain as the kernel derives it
 * from Postgres (nearest first, the node itself excluded).
 */
function resourcesOf(w: World, ancestors = false): RelationshipResource[] {
  const withChain = (r: RelationshipResource, chain: RelationshipNodeRef[]) =>
    ancestors ? { ...r, ancestors: chain } : r;
  return [
    ...w.folders.map((f) => withChain({ kind: "folder", id: f.id }, folderChain(w, f.parent))),
    ...w.docs.map((d) => withChain({ kind: "document", id: d.id }, folderChain(w, d.folder))),
    ...w.posts.map((id) => withChain({ kind: "post", id }, [])),
  ];
}

interface Mismatch {
  member: string;
  resource: string;
  at: string;
  capability: string;
  engine: boolean | "failed";
  reference: boolean;
}

/** Compares every (member, resource, capability, at) by batchCheck, plus a sample by check. */
async function differential(
  w: World,
  state: EngineState,
  rng: Rng,
  ancestors = false,
): Promise<{ cases: number; mismatches: Mismatch[] }> {
  const rules = authzRulesOf(w);
  const resources = resourcesOf(w, ancestors);
  const mismatches: Mismatch[] = [];
  let cases = 0;
  for (const m of w.members) {
    for (const at of w.times) {
      const want = new Map(
        resources.map((r) => [
          `${r.kind}:${r.id}`,
          expected(rules, m, resourceRefOf(w, r.kind, r.id), at),
        ]),
      );
      for (const capability of CAPABILITIES) {
        const { allowed, failed } = await engine.batchCheck(state, {
          membershipId: m.membershipId,
          resources,
          capability,
          at,
        });
        for (const r of resources) {
          cases++;
          const reference = want.get(`${r.kind}:${r.id}`)?.[capability] === true;
          const got = failed.has(r.id) ? "failed" : allowed.has(r.id);
          if (got !== reference) {
            mismatches.push({
              member: m.membershipId,
              resource: `${r.kind}:${r.id}`,
              at: at.toISOString(),
              capability,
              engine: got,
              reference,
            });
          }
        }
      }
      // `check` (all four capabilities in one call) on a sample of resources.
      for (const r of rng.subset(resources, 0.25)) {
        const got = await engine.check(state, {
          membershipId: m.membershipId,
          resource: r,
          capabilities: CAPABILITIES,
          at,
        });
        for (const capability of CAPABILITIES) {
          cases++;
          const reference = want.get(`${r.kind}:${r.id}`)?.[capability] === true;
          if (got[capability] !== reference) {
            mismatches.push({
              member: m.membershipId,
              resource: `${r.kind}:${r.id} (check)`,
              at: at.toISOString(),
              capability,
              engine: got[capability],
              reference,
            });
          }
        }
      }
    }
  }
  return { cases, mismatches };
}

function explainMismatch(w: World, mm: Mismatch[]): string {
  if (mm.length === 0) return "";
  const first = mm[0] as Mismatch;
  return JSON.stringify(
    {
      count: mm.length,
      first,
      folders: w.folders,
      docs: w.docs,
      members: w.members,
      rules: w.rules,
    },
    null,
    1,
  ).slice(0, 20_000);
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const extraSeed = Number(process.env["FUNDROOM_FGA_SEED"]);
if (Number.isInteger(extraSeed)) SEEDS.push(extraSeed);

describe("openfga engine vs packages/authz resolveNode (differential)", () => {
  let total = 0;

  for (const seed of SEEDS) {
    it(`seed ${seed}: every (member, resource, capability, at) agrees`, async () => {
      const rng = rngOf(seed * 7919);
      const w = randomWorld(seed, {
        folders: rng.int(4, 12),
        docs: rng.int(3, 10),
        rules: rng.int(8, 40),
      });
      const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
      // Even seeds also send each resource's ancestors as contextual tuples (what the kernel
      // does): duplicates of the synced parents must not change any answer.
      const { cases, mismatches } = await differential(w, state, rng, seed % 2 === 0);
      total += cases;
      expect(mismatches, explainMismatch(w, mismatches)).toEqual([]);
      expect(cases).toBeGreaterThan(100);
      await engine.dropWorkspace(state);
    });
  }

  it("ran thousands of cases in total", () => {
    expect(total).toBeGreaterThan(5_000);
  });
});

describe("openfga engine sync", () => {
  it("is idempotent, applies incremental changes and deletions, and still agrees", async () => {
    const rng = rngOf(424242);
    const w = randomWorld(77, { folders: 10, docs: 8, rules: 30 });
    const first = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    expect(first.writes).toBeGreaterThan(0);
    expect(first.deletes).toBe(0);

    // A second sync of the same snapshot writes nothing and keeps the model.
    const second = await engine.sync(snapshotOf(w), first);
    expect(second).toEqual({ ...first, writes: 0, deletes: 0 });

    // Incremental: drop some rules, edit a window in place (same rule id), add rules, move a
    // document, change a member's groups and links.
    const removed = w.rules.splice(0, 5);
    expect(removed).toHaveLength(5);
    const edited = w.rules[0] as RelationshipRule;
    w.rules[0] = {
      ...edited,
      validFrom: new Date(BASE - 3 * DAY).toISOString(),
      validUntil: new Date(BASE + 3 * DAY).toISOString(),
    };
    for (let i = 0; i < 6; i++) w.rules.push(randomRule(rng, w));
    const moved = w.docs[0] as Doc;
    w.docs[0] = { ...moved, folder: (w.folders.at(-1) as Folder).id };
    const m0 = w.members[0] as RelationshipMember;
    w.members[0] = { ...m0, groupIds: m0.groupIds.length ? [] : ["g1", "g2"], linkIds: ["l2"] };
    refreshTimes(rng, w);
    const third = await engine.sync(snapshotOf(w, 2), second);
    expect(third.storeRef).toBe(first.storeRef);
    expect(third.modelRef).toBe(first.modelRef);
    expect(third.writes).toBeGreaterThan(0);
    expect(third.deletes).toBeGreaterThanOrEqual(2 * 5);
    const after = await differential(w, third, rng);
    expect(after.mismatches, explainMismatch(w, after.mismatches)).toEqual([]);
    expect((await engine.sync(snapshotOf(w, 2), third)).writes).toBe(0);

    // Deletion: no rules left → nothing is allowed anywhere, and only rule tuples were deleted.
    const ruleTuples = 2 * w.rules.length;
    w.rules = [];
    const fourth = await engine.sync(snapshotOf(w, 3), third);
    expect(fourth.writes).toBe(0);
    expect(fourth.deletes).toBe(ruleTuples);
    for (const m of w.members) {
      for (const capability of CAPABILITIES) {
        const { allowed } = await engine.batchCheck(fourth, {
          membershipId: m.membershipId,
          resources: resourcesOf(w),
          capability,
          at: new Date(BASE),
        });
        expect(allowed.size).toBe(0);
      }
    }
    await engine.dropWorkspace(fourth);
  });

  it("writes a new model only when the resource kinds change", async () => {
    const w = randomWorld(91, { folders: 3, docs: 2, rules: 6 });
    w.posts = [];
    w.rules = w.rules.filter((r) => r.resource.kind !== "post");
    const a = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    const b = await engine.sync(snapshotOf(w), a);
    expect(b.modelRef).toBe(a.modelRef);
    w.posts = ["p9"];
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000a0009",
      subject: { kind: "role", role: "investor" },
      resource: { kind: "post", id: "p9" },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    const c = await engine.sync(snapshotOf(w), b);
    expect(c.storeRef).toBe(a.storeRef);
    expect(c.modelRef).not.toBe(a.modelRef);
    const investor = w.members.find((m) => m.role === "investor");
    if (investor !== undefined) {
      const got = await engine.check(c, {
        membershipId: investor.membershipId,
        resource: { kind: "post", id: "p9" },
        capabilities: ["view"],
        at: new Date(BASE),
      });
      expect(got.view).toBe(true);
    }
    // A kind the model does not know answers false without asking.
    const none = await engine.check(c, {
      membershipId: "m0",
      resource: { kind: "data-room.unknown", id: "x" },
      capabilities: ["view", "edit"],
      at: new Date(BASE),
    });
    expect(none).toEqual({ view: false, download: false, comment: false, edit: false });
    await engine.dropWorkspace(c);
  });

  it("adopts its store after lost state, recreates a vanished one, refuses another workspace's", async () => {
    const w = randomWorld(55, { folders: 4, docs: 3, rules: 10 });
    const a = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    // Lost state: the same store is found by name, nothing to write.
    const adopted = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    expect(adopted.storeRef).toBe(a.storeRef);
    expect(adopted.writes).toBe(0);
    // Another workspace's store id is refused.
    const other = randomWorld(56, { folders: 2, docs: 1, rules: 2 });
    await expect(engine.sync(snapshotOf(other), a)).rejects.toMatchObject({ code: "rejected" });
    // Vanished store: recreated and fully written.
    await engine.dropWorkspace(a);
    await engine.dropWorkspace(a); // idempotent
    const again = await engine.sync(snapshotOf(w), adopted);
    expect(again.storeRef).not.toBe(a.storeRef);
    expect(again.writes).toBe(a.writes);
    const listed = await fetch(`${url}/stores?name=${openFgaStoreName(w.workspaceId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json() as Promise<{ stores: { id: string }[] }>);
    expect(listed.stores.map((s) => s.id)).toEqual([again.storeRef]);
    await engine.dropWorkspace(again);
  });

  it("holds a 5k+ tuple workspace (paged read, 100-op writes) within budget", async () => {
    const rng = rngOf(5000);
    const w = randomWorld(5000, { folders: 400, docs: 1500, rules: 0 });
    for (let i = 0; i < 2_600; i++) w.rules.push(randomRule(rng, w));
    const snapshot = snapshotOf(w);
    let t = performance.now();
    const first = await engine.sync(snapshot, { storeRef: null, modelRef: null });
    const firstMs = performance.now() - t;
    expect(first.writes).toBeGreaterThan(5_000);
    t = performance.now();
    const second = await engine.sync(snapshot, first);
    const secondMs = performance.now() - t;
    expect(second.writes).toBe(0);
    expect(second.deletes).toBe(0);
    // Spot-check the big world against the reference on one member and capability.
    const rules = authzRulesOf(w);
    const m = w.members[0] as RelationshipMember;
    const resources = resourcesOf(w);
    t = performance.now();
    const { allowed, failed } = await engine.batchCheck(second, {
      membershipId: m.membershipId,
      resources,
      capability: "view",
      at: new Date(BASE),
    });
    const listMs = performance.now() - t;
    const want = resources
      .filter((r) => expected(rules, m, resourceRefOf(w, r.kind, r.id), new Date(BASE)).view)
      .map((r) => r.id);
    expect(failed.size).toBe(0);
    expect([...allowed].sort()).toEqual(want.sort());
    console.info(
      `[openfga 5k] tuples=${first.writes} firstSync=${firstMs.toFixed(0)}ms noopSync=${secondMs.toFixed(0)}ms batchCheck(${resources.length})=${listMs.toFixed(0)}ms`,
    );
    expect(firstMs).toBeLessThan(60_000);
    expect(secondMs).toBeLessThan(20_000);
    await engine.dropWorkspace(second);
  });
});

describe("openfga engine errors", () => {
  it("maps a wrong preshared key to unauthorized", async () => {
    const bad = createOpenFgaEngine({ url, apiToken: "wrong", http: fetch, timeoutMs: 5_000 });
    await expect(bad.healthCheck()).rejects.toMatchObject({ code: "unauthorized" });
    await engine.healthCheck();
  });

  it("refuses to check an unsynced workspace", async () => {
    await expect(
      engine.check(
        { storeRef: null, modelRef: null },
        {
          membershipId: "m",
          resource: { kind: "folder", id: "f" },
          capabilities: ["view"],
          at: new Date(),
        },
      ),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("dropWorkspace erases the tuples, not just the store (DeleteStore is soft)", async () => {
    const w = randomWorld(66, { folders: 2, docs: 1, rules: 0 });
    const root = (w.folders[0] as Folder).id;
    const m0 = (w.members[0] as RelationshipMember).membershipId;
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000d0066",
      subject: { kind: "membership", id: m0 },
      resource: { kind: "folder", id: root },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    const s = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    const q = {
      membershipId: m0,
      resources: [{ kind: "folder", id: root }],
      capability: "view" as const,
      at: new Date(BASE),
    };
    expect([...(await engine.batchCheck(s, q)).allowed]).toEqual([root]);
    await engine.dropWorkspace(s);
    await engine.dropWorkspace(s); // idempotent
    const after = await engine.batchCheck(s, q).catch((e: unknown) => e);
    if (!(after instanceof Error)) expect((after as { allowed: Set<string> }).allowed.size).toBe(0);
    else expect((after as RelationshipEngineError).code).toBe("rejected");
    const read = await fetch(`${url}/stores/${s.storeRef}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ page_size: 100 }),
    });
    if (read.ok) expect(((await read.json()) as { tuples: unknown[] }).tuples).toEqual([]);
    else expect(read.status).toBe(404);
  });

  it("refuses nodes deeper than the depth limit (an error, not false) and decides the rest", async () => {
    const w: World = {
      workspaceId: crypto.randomUUID(),
      folders: [],
      docs: [],
      posts: [],
      members: [{ membershipId: "m0", role: "investor", groupIds: [], linkIds: [] }],
      groups: [],
      links: [],
      roles: ["investor"],
      rules: [],
      times: [],
    };
    for (let i = 0; i < 30; i++) {
      const parent = w.folders[i - 1];
      w.folders.push({
        id: `deep${i}`,
        parent: parent?.id ?? null,
        path: parent ? `${parent.path}.deep${i}` : `deep${i}`,
      });
    }
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-00000000dee0",
      subject: { kind: "membership", id: "m0" },
      resource: { kind: "folder", id: "deep0" },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    const s = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    const withChain = new Map(resourcesOf(w, true).map((r) => [r.id, r]));
    const q = (id: string, ancestors = true) => ({
      membershipId: "m0",
      resource: ancestors ? (withChain.get(id) as RelationshipResource) : { kind: "folder", id },
      capabilities: ["view"] as const,
      at: new Date(BASE),
    });
    expect((await engine.check(s, q("deep20"))).view).toBe(true);
    // Deeper than the limit: refused with its chain; without one, sync wrote no parent edge that
    // deep, so the engine answers from the node alone (narrower, never a long walk).
    await expect(engine.check(s, q("deep21"))).rejects.toMatchObject({ code: "rejected" });
    await expect(engine.check(s, q("deep29"))).rejects.toMatchObject({ code: "rejected" });
    expect((await engine.check(s, q("deep29", false))).view).toBe(false);
    // batchCheck (R3-3): the too-deep items fail one by one; the shallow ones are still decided.
    const all = [...withChain.values()];
    const { allowed, failed } = await engine.batchCheck(s, {
      membershipId: "m0",
      resources: all,
      capability: "view",
      at: new Date(BASE),
    });
    expect(allowed.has("deep0")).toBe(true);
    expect(allowed.has("deep20")).toBe(true);
    expect(failed.get("deep29")).toBe("rejected");
    expect(allowed.size + failed.size).toBe(30);
    expect(failed.size).toBeGreaterThan(0);
    await engine.dropWorkspace(s);
  });
});

describe("openfga engine: nodes created after the last sync (ancestors as contextual tuples)", () => {
  it("decides new folders and documents through the ancestors the caller sends", async () => {
    const rng = rngOf(31337);
    const w = randomWorld(31, { folders: 6, docs: 4, rules: 25 });
    const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    // Grow the tree WITHOUT syncing: a new subtree under random folders, documents in it and in
    // old folders — exactly what an upload after the last sync looks like.
    for (let i = 0; i < 6; i++) {
      const parent = rng.pick(w.folders.filter((f) => f.path.split(".").length < 5));
      const id = `new${i}`;
      w.folders.push({ id, parent: parent.id, path: `${parent.path}.${id}` });
    }
    for (let i = 0; i < 10; i++) w.docs.push({ id: `nd${i}`, folder: rng.pick(w.folders).id });
    const fresh = (r: { id: string }) => r.id.startsWith("new") || r.id.startsWith("nd");
    const resources = resourcesOf(w, true);
    const rules = authzRulesOf(w);
    let inherited = 0;
    for (const m of w.members) {
      for (const at of w.times) {
        for (const capability of CAPABILITIES) {
          const { allowed, failed } = await engine.batchCheck(state, {
            membershipId: m.membershipId,
            resources,
            capability,
            at,
          });
          const without = await engine.batchCheck(state, {
            membershipId: m.membershipId,
            resources: resources.filter(fresh).map((r) => ({ kind: r.kind, id: r.id })),
            capability,
            at,
          });
          expect(failed.size).toBe(0);
          expect(without.allowed.size).toBe(0); // unsynced and untreed: the engine knows nothing
          for (const r of resources) {
            const want = expected(rules, m, resourceRefOf(w, r.kind, r.id), at)[capability];
            expect({ r: r.id, m: m.membershipId, at, capability, got: allowed.has(r.id) }).toEqual({
              r: r.id,
              m: m.membershipId,
              at,
              capability,
              got: want,
            });
            if (want && fresh(r)) inherited++;
          }
        }
      }
    }
    expect(inherited).toBeGreaterThan(0);
    // check() takes the same path.
    const doc = resources.find((r) => r.id === "nd0") as RelationshipResource;
    const m = w.members[0] as RelationshipMember;
    const at = new Date(BASE);
    const got = await engine.check(state, {
      membershipId: m.membershipId,
      resource: doc,
      capabilities: CAPABILITIES,
      at,
    });
    expect(got).toEqual(expected(rules, m, resourceRefOf(w, doc.kind, doc.id), at));
    await engine.dropWorkspace(state);
  });

  it("fails an item whose ancestors cannot be sent, instead of denying it silently", async () => {
    const w = randomWorld(32, { folders: 3, docs: 2, rules: 5 });
    const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    const root = (w.folders[0] as Folder).id;
    const long = Array.from({ length: 101 }, (_, i) => ({ kind: "folder", id: `x${i}` }));
    const at = new Date(BASE);
    const { allowed, failed } = await engine.batchCheck(state, {
      membershipId: "m0",
      resources: [
        { kind: "document", id: "toolong", ancestors: long },
        { kind: "document", id: "alien", ancestors: [{ kind: "vault", id: "v1" }] },
        { kind: "nosuchkind", id: "n1", ancestors: [{ kind: "folder", id: root }] },
        { kind: "nosuchkind", id: "n2" },
        { kind: "folder", id: root },
      ],
      capability: "view",
      at,
    });
    expect(Object.fromEntries(failed)).toEqual({
      toolong: "rejected",
      alien: "rejected",
      n1: "rejected",
    });
    expect(allowed.has("n2")).toBe(false);
    await expect(
      engine.check(state, {
        membershipId: "m0",
        resource: { kind: "document", id: "toolong", ancestors: long },
        capabilities: ["view"],
        at,
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    // 100 contextual tuples are accepted by the server.
    const hundred = long.slice(0, 99).concat([{ kind: "folder", id: root }]);
    await engine
      .check(state, {
        membershipId: "m0",
        resource: { kind: "document", id: "deepnew", ancestors: hundred },
        capabilities: ["view"],
        at,
      })
      .catch((e: unknown) => {
        // Resolving 100 hops exceeds the resolve limit: an error, never a silent false.
        expect(e).toMatchObject({ code: "rejected" });
      });
    await engine.dropWorkspace(state);
  });
});

describe("openfga engine: deep trees stay cheap (RR1 NEW-1: no duplicated synced edges)", () => {
  function chainWorld(depth: number): World {
    const w: World = {
      workspaceId: crypto.randomUUID(),
      folders: [],
      docs: [],
      posts: [],
      members: [{ membershipId: "m0", role: "investor", groupIds: ["g1"], linkIds: [] }],
      groups: ["g1"],
      links: [],
      roles: ["investor"],
      rules: [],
      times: [],
    };
    for (let i = 0; i < depth; i++) {
      const parent = w.folders[i - 1];
      const id = `c${i}`;
      w.folders.push({
        id,
        parent: parent?.id ?? null,
        path: parent ? `${parent.path}.${id}` : id,
      });
    }
    w.docs.push({ id: "bottom", folder: (w.folders.at(-1) as Folder).id });
    // view for the group on the second folder, download for the member on the deepest folder
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000c0001",
      subject: { kind: "group", id: "g1" },
      resource: { kind: "folder", id: "c1" },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000c0002",
      subject: { kind: "membership", id: "m0" },
      resource: { kind: "folder", id: (w.folders.at(-1) as Folder).id },
      capability: "download",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    return w;
  }

  async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
    const t = performance.now();
    const r = await f();
    return [r, performance.now() - t];
  }

  function p99(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] as number;
  }

  it("a 26-level tree: every node within the limit decided correctly and fast, deeper ones refused without a call, server healthy", async () => {
    const w = chainWorld(25); // root c0 … c24, document at 26 levels
    const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    const other = await engine.sync(
      snapshotOf(randomWorld(26, { folders: 3, docs: 2, rules: 4 })),
      {
        storeRef: null,
        modelRef: null,
      },
    );
    const rules = authzRulesOf(w);
    const m = w.members[0] as RelationshipMember;
    const at = new Date(BASE);
    const times: number[] = [];
    for (const r of resourcesOf(w, true)) {
      const depth = r.ancestors?.length ?? 0;
      const [got, ms] = await timed(() =>
        engine
          .check(state, {
            membershipId: m.membershipId,
            resource: r,
            capabilities: CAPABILITIES,
            at,
          })
          .catch((e: unknown) => e as RelationshipEngineError),
      );
      if (depth > OPENFGA_DEFAULT_DEPTH_LIMIT) {
        expect(got).toMatchObject({ code: "rejected" });
        expect(ms).toBeLessThan(20); // refused before any engine call
      } else {
        expect(got).toEqual(expected(rules, m, resourceRefOf(w, r.kind, r.id), at));
        times.push(ms);
      }
    }
    const [list, listMs] = await timed(() =>
      engine.batchCheck(state, {
        membershipId: m.membershipId,
        resources: resourcesOf(w, true),
        capability: "view",
        at,
      }),
    );
    expect(list.allowed.has("c1")).toBe(true);
    expect(list.allowed.has("c20")).toBe(true);
    expect(list.failed.get("c24")).toBe("rejected");
    expect(list.failed.get("bottom")).toBe("rejected");
    console.info(
      `[openfga deep] p99 check=${p99(times).toFixed(0)}ms list(${resourcesOf(w).length})=${listMs.toFixed(0)}ms`,
    );
    expect(p99(times)).toBeLessThan(1_000); // ~20 ms alone; the duplicated-edge regression was 1.8 s at depth 14 and killed the server at 16
    expect(listMs).toBeLessThan(2_000);
    await engine.healthCheck();
    const [, otherMs] = await timed(() =>
      engine.check(other, {
        membershipId: "m0",
        resource: { kind: "folder", id: "f26x0" },
        capabilities: ["view"],
        at,
      }),
    );
    expect(otherMs).toBeLessThan(1_000);
    await engine.dropWorkspace(state);
    await engine.dropWorkspace(other);
  });

  it("a 16-level chain with new unsynced nodes below: inherits through the new edges only, fast", async () => {
    const w = chainWorld(16);
    const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    // New (unsynced) folders n0 ← n1 ← n2 under c15, and documents in them and in c15.
    for (let i = 0; i < 3; i++) {
      const parent = (i === 0 ? w.folders[15] : w.folders.at(-1)) as Folder;
      const id = `n${i}`;
      w.folders.push({ id, parent: parent.id, path: `${parent.path}.${id}` });
      w.docs.push({ id: `nd${i}`, folder: id });
    }
    w.docs.push({ id: "nd-top", folder: "c15" });
    const rules = authzRulesOf(w);
    const m = w.members[0] as RelationshipMember;
    const at = new Date(BASE);
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const r of resourcesOf(w, true)) {
        const [got, ms] = await timed(() =>
          engine.check(state, {
            membershipId: m.membershipId,
            resource: r,
            capabilities: CAPABILITIES,
            at,
          }),
        );
        expect({ id: r.id, got }).toEqual({
          id: r.id,
          got: expected(rules, m, resourceRefOf(w, r.kind, r.id), at),
        });
        times.push(ms);
      }
    }
    const nd2 = resourcesOf(w, true).find((r) => r.id === "nd2") as RelationshipResource;
    expect(nd2.ancestors).toHaveLength(19);
    expect(
      (
        await engine.check(state, {
          membershipId: "m0",
          resource: nd2,
          capabilities: ["view", "download"],
          at,
        })
      ).view,
    ).toBe(true);
    console.info(`[openfga 16+new] p99 check=${p99(times).toFixed(0)}ms over ${times.length}`);
    expect(p99(times)).toBeLessThan(1_000); // ~20 ms alone; the duplicated-edge regression was 1.8 s at depth 14 and killed the server at 16
    await engine.healthCheck();
    await engine.dropWorkspace(state);
  });
});

describe("openfga engine: edge lookups do not scale with folder size (RR2-3)", () => {
  it("a cold check in a folder with 12k synced documents stays fast", async () => {
    const w = randomWorld(12_000, { folders: 2, docs: 0, rules: 0 });
    const big = (w.folders[1] ?? w.folders[0]) as Folder;
    for (let i = 0; i < 12_000; i++) w.docs.push({ id: `bd${i}`, folder: big.id });
    const m = w.members[0] as RelationshipMember;
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000b1600",
      subject: { kind: "membership", id: m.membershipId },
      resource: { kind: "folder", id: big.id },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    const state = await engine.sync(snapshotOf(w), { storeRef: null, modelRef: null });
    // A fresh engine instance = a cold edge cache (another process).
    const cold = createOpenFgaEngine({ url, apiToken: TOKEN, http: fetch, timeoutMs: 10_000 });
    const chain = folderChain(w, big.id);
    const at = new Date(BASE);
    for (const id of ["bd11999", "brand-new-doc"]) {
      const t = performance.now();
      const got = await cold.check(state, {
        membershipId: m.membershipId,
        resource: { kind: "document", id, ancestors: chain },
        capabilities: ["view"],
        at,
      });
      const ms = performance.now() - t;
      console.info(`[openfga 12k] cold check ${id}=${ms.toFixed(0)}ms`);
      expect(got.view).toBe(true);
      expect(ms).toBeLessThan(1_000);
    }
    await engine.dropWorkspace(state);
  }, 180_000);
});

describe("openfga engine: declared kinds (RR2-1)", () => {
  it("decides the first document of a room synced with folders only, and keeps the model stable", async () => {
    const w = randomWorld(2101, { folders: 3, docs: 0, rules: 0 });
    w.posts = [];
    const m = w.members[0] as RelationshipMember;
    const top = w.folders[0] as Folder;
    w.rules.push({
      id: "0190a0b0-0000-7000-8000-0000000b2101",
      subject: { kind: "membership", id: m.membershipId },
      resource: { kind: "folder", id: top.id },
      capability: "view",
      effect: "allow",
      validFrom: null,
      validUntil: null,
    });
    const kinds = ["document", "folder", "post"];
    const first = await engine.sync(
      { ...snapshotOf(w), kinds },
      { storeRef: null, modelRef: null },
    );
    const leaf = w.folders.at(-1) as Folder;
    const doc = { kind: "document", id: "first-doc", ancestors: folderChain(w, leaf.id) };
    const at = new Date(BASE);
    expect(
      (
        await engine.check(first, {
          membershipId: m.membershipId,
          resource: doc,
          capabilities: ["view"],
          at,
        })
      ).view,
    ).toBe(true);
    // Without declared kinds the same room has no document type: the item is refused.
    const bare = await engine.sync(snapshotOf({ ...w, workspaceId: crypto.randomUUID() }), {
      storeRef: null,
      modelRef: null,
    });
    await expect(
      engine.check(bare, {
        membershipId: m.membershipId,
        resource: doc,
        capabilities: ["view"],
        at,
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    // The document is uploaded and synced: same model, no rewrite.
    w.docs.push({ id: "first-doc", folder: leaf.id });
    const second = await engine.sync({ ...snapshotOf(w, 2), kinds }, first);
    expect(second.modelRef).toBe(first.modelRef);
    await engine.dropWorkspace(second);
    await engine.dropWorkspace(bare);
  });
});
