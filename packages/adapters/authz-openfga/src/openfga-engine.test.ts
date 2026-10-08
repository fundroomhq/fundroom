import {
  OutboundHttpError,
  RelationshipEngineError,
  type RelationshipRule,
  type RelationshipSnapshot,
} from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createOpenFgaEngine, OPENFGA_ENGINE_DRIVER } from "./engine.js";
import {
  buildOpenFgaModel,
  formatModelRef,
  modelHash,
  openFgaTypeName,
  openFgaTypeTable,
  parseModelRef,
} from "./model.js";
import {
  encodeId,
  OPEN_NOT_AFTER,
  OPEN_NOT_BEFORE,
  projectSnapshot,
  tupleIdentity,
} from "./tuples.js";

// --- a tiny fake OpenFGA ---------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Handler = (call: Call) => { status: number; body?: unknown } | undefined;

function fakeServer(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const http = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input));
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${u.pathname}${u.search}`,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const custom = handler(call);
    const reply = custom ?? defaultReply(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  };
  function defaultReply(call: Call): { status: number; body?: unknown } {
    const p = call.path;
    if (call.method === "GET" && p.startsWith("/stores?"))
      return { status: 200, body: { stores: [], continuation_token: "" } };
    if (call.method === "POST" && p === "/stores")
      return { status: 201, body: { id: "STORE1", name: call.body["name"] } };
    if (call.method === "GET" && p === "/stores/STORE1")
      return { status: 200, body: { id: "STORE1", name: "seedhost-ws1" } };
    if (p.endsWith("/authorization-models") && call.method === "POST")
      return { status: 201, body: { authorization_model_id: "MODEL1" } };
    if (p.includes("/authorization-models/")) {
      return {
        status: 200,
        body: { authorization_model: buildOpenFgaModel(["folder", "document"]) },
      };
    }
    if (p.endsWith("/read")) {
      const f = (call.body["tuple_key"] ?? {}) as {
        user?: string;
        relation?: string;
        object?: string;
      };
      const tuples = [...stored.values()].filter(
        (t) =>
          (f.user === undefined || t["user"] === f.user) &&
          (f.relation === undefined || t["relation"] === f.relation) &&
          (f.object === undefined ||
            (f.object.endsWith(":")
              ? String(t["object"]).startsWith(f.object)
              : t["object"] === f.object)),
      );
      return {
        status: 200,
        body: { tuples: tuples.map((key) => ({ key })), continuation_token: "" },
      };
    }
    if (p.endsWith("/write")) {
      const writes =
        (call.body["writes"] as { tuple_keys: Record<string, unknown>[] } | undefined)
          ?.tuple_keys ?? [];
      const deletes =
        (call.body["deletes"] as { tuple_keys: Record<string, unknown>[] } | undefined)
          ?.tuple_keys ?? [];
      if (writes.length + deletes.length > 100)
        return { status: 400, body: { code: "exceeded_entity_limit" } };
      for (const t of writes) stored.set(tupleIdentity(t as never), t);
      for (const t of deletes) stored.delete(tupleIdentity(t as never));
      return { status: 200, body: {} };
    }
    if (p.endsWith("/batch-check")) {
      const checks = call.body["checks"] as { correlation_id: string }[];
      if (checks.length > 50) return { status: 400, body: { code: "validation_error" } };
      return {
        status: 200,
        body: {
          result: Object.fromEntries(checks.map((c) => [c.correlation_id, { allowed: true }])),
        },
      };
    }
    if (call.method === "DELETE") return { status: 204 };
    return { status: 404, body: { code: "not_found" } };
  }
  return { http, calls, stored };
}

const SYNCED = { storeRef: "STORE1", modelRef: formatModelRef("MODEL1", "h") };

function rule(i: number, over: Partial<RelationshipRule> = {}): RelationshipRule {
  return {
    id: `r${i}`,
    subject: { kind: "group", id: "g1" },
    resource: { kind: "folder", id: "root" },
    capability: "view",
    effect: "allow",
    validFrom: null,
    validUntil: null,
    ...over,
  };
}

function snapshot(rules: RelationshipRule[] = [rule(1)]): RelationshipSnapshot {
  return {
    workspaceId: "ws1",
    aclVersion: 1,
    nodes: [
      { kind: "folder", id: "root", parent: null },
      { kind: "document", id: "d1", parent: { kind: "folder", id: "root" } },
    ],
    members: [{ membershipId: "m1", role: "investor", groupIds: ["g1"], linkIds: ["l1"] }],
    rules,
  };
}

// --- model ----------------------------------------------------------------------------------

describe("buildOpenFgaModel", () => {
  it("is deterministic in the kinds and changes its hash only with them", () => {
    const a = buildOpenFgaModel(["folder", "document", "folder"]);
    const b = buildOpenFgaModel(["document", "folder"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(modelHash(a)).toBe(modelHash(b));
    expect(modelHash(buildOpenFgaModel(["document", "folder", "post"]))).not.toBe(modelHash(a));
  });

  it("encodes nearest-first, specificity and exclude-on-tie for each capability", () => {
    const model = buildOpenFgaModel(["folder"]);
    const folder = model.type_definitions.find((t) => t["type"] === "folder") as {
      relations: Record<string, unknown>;
    };
    const cu = (relation: string) => ({ computedUserset: { relation } });
    // Innermost: the parent's answer where no role rule sits here; then each tier, from role up
    // to membership: (allow − exclude) ∪ (below − (allow ∪ exclude)).
    let expected: unknown = {
      tupleToUserset: { tupleset: { relation: "parent" }, computedUserset: { relation: "view" } },
    };
    for (const tier of ["role", "group", "link", "membership"]) {
      const a = cu(`view_${tier}_allow`);
      const x = cu(`view_${tier}_exclude`);
      expected = {
        union: {
          child: [
            { difference: { base: a, subtract: x } },
            { difference: { base: expected, subtract: { union: { child: [a, x] } } } },
          ],
        },
      };
    }
    expect(folder.relations["view"]).toEqual(expected);
    for (const cap of ["view", "download", "comment", "edit"])
      expect(folder.relations[cap]).toBeDefined();
  });

  it("maps kinds to type names and refuses reserved names and collisions", () => {
    expect(openFgaTypeName("data-room.document")).toBe("data_room_document");
    expect([...openFgaTypeTable(["document", "data-room.document"])]).toEqual([
      ["data-room.document", "data_room_document"],
      ["document", "document"],
    ]);
    expect(() => buildOpenFgaModel(["group"])).toThrow(/reserved/u);
    expect(() => buildOpenFgaModel(["user"])).toThrow(/reserved/u);
    expect(() => buildOpenFgaModel(["a-b", "a.b"])).toThrow(/both map/u);
  });

  it("round-trips modelRef", () => {
    expect(parseModelRef(formatModelRef("01ABC", "deadbeef"))).toEqual({
      modelId: "01ABC",
      hash: "deadbeef",
    });
    expect(parseModelRef(null)).toBeNull();
  });
});

// --- projection -----------------------------------------------------------------------------

describe("projectSnapshot", () => {
  it("projects parents, memberships and one grant object per rule with its window", () => {
    const p = projectSnapshot(
      snapshot([
        rule(1, { validFrom: "2026-01-01T00:00:00Z" }),
        rule(2, {
          subject: { kind: "role", role: "investor" },
          effect: "exclude",
          resource: { kind: "document", id: "d1" },
        }),
      ]),
      23,
    );
    const tuples = [...p.tuples.values()];
    expect(tuples).toContainEqual({
      user: "folder:root",
      relation: "parent",
      object: "document:d1",
    });
    expect(tuples).toContainEqual({ user: "user:m1", relation: "member", object: "group:g1" });
    expect(tuples).toContainEqual({ user: "user:m1", relation: "member", object: "link:l1" });
    expect(tuples).toContainEqual({ user: "user:m1", relation: "member", object: "role:investor" });
    const subj = tuples.filter((t) => t.relation === "subject");
    expect(subj).toHaveLength(2);
    expect(subj[0]?.condition).toEqual({
      name: "valid_window",
      context: { not_before: "2026-01-01T00:00:00.000Z", not_after: OPEN_NOT_AFTER },
    });
    expect(subj[1]?.user).toBe("role:investor#member");
    // An open-ended rule carries no condition (cheaper to evaluate); a half-open one is closed
    // with the far bound.
    expect(subj[1]?.condition).toBeUndefined();
    const onDoc = tuples.find((t) => t.object === "document:d1" && t.relation !== "parent");
    expect(onDoc?.relation).toBe("view_role_exclude");
    expect(onDoc?.user).toBe(`${subj[1]?.object}#subject`);
  });

  it("gives two rules with the same subject/resource/capability/effect distinct grants", () => {
    const p = projectSnapshot(
      snapshot([
        rule(1, { validUntil: "2026-02-01T00:00:00Z" }),
        rule(2, { validFrom: "2026-03-01T00:00:00Z" }),
      ]),
      23,
    );
    expect([...p.tuples.values()].filter((t) => t.relation === "view_group_allow")).toHaveLength(2);
  });

  it("changes a rule's grant key when its window changes", () => {
    const key = (r: RelationshipRule) =>
      [...projectSnapshot(snapshot([r]), 23).tuples.values()].find((t) => t.relation === "subject")
        ?.object;
    expect(key(rule(1))).not.toBe(key(rule(1, { validUntil: "2027-01-01T00:00:00Z" })));
    expect(key(rule(1))).toBe(key(rule(1)));
  });

  it("encodes unsafe ids without collisions and refuses invalid instants", () => {
    expect(encodeId("0190a0b0-aaaa")).toBe("0190a0b0-aaaa");
    expect(encodeId("a:b#c")).toMatch(/^~[A-Za-z0-9_-]{43}$/u);
    expect(encodeId("a:b#c")).not.toBe(encodeId("a:b#d"));
    expect(() => projectSnapshot(snapshot([rule(1, { validFrom: "yesterday" })]), 23)).toThrow(
      TypeError,
    );
  });

  it("reports parent chains deeper than the limit, and cycles", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      kind: "folder",
      id: `f${i}`,
      parent: i === 0 ? null : { kind: "folder", id: `f${i - 1}` },
    }));
    const p = projectSnapshot({ ...snapshot([]), nodes }, 3);
    expect(p.tooDeep).toBe(2); // f4 (4 hops), f5 (5 hops)
    expect(p.maxDepth).toBe(3);
    const cyc = projectSnapshot(
      {
        ...snapshot([]),
        nodes: [
          { kind: "folder", id: "a", parent: { kind: "folder", id: "b" } },
          { kind: "folder", id: "b", parent: { kind: "folder", id: "a" } },
        ],
      },
      23,
    );
    expect(cyc.tooDeep).toBe(2);
  });
});

// --- engine over a fake server --------------------------------------------------------------

describe("createOpenFgaEngine (fake server)", () => {
  it("syncs in writes of at most 100 operations and is idempotent", async () => {
    const fake = fakeServer();
    const engine = createOpenFgaEngine({
      url: "http://fga.test/",
      apiToken: "k",
      http: fake.http,
      timeoutMs: 1000,
    });
    expect(engine.driver).toBe(OPENFGA_ENGINE_DRIVER);
    const rules = Array.from({ length: 120 }, (_, i) => rule(i));
    const first = await engine.sync(snapshot(rules), { storeRef: null, modelRef: null });
    expect(first.storeRef).toBe("STORE1");
    expect(first.modelRef).toMatch(/^MODEL1:[0-9a-f]{16}$/u);
    // 1 parent + 3 member + 240 rule tuples
    expect(first.writes).toBe(244);
    const writes = fake.calls.filter((c) => c.path.endsWith("/write"));
    expect(
      writes.map((c) => (c.body["writes"] as { tuple_keys: unknown[] }).tuple_keys.length),
    ).toEqual([100, 100, 44]);
    for (const w of writes) {
      expect(w.body["writes"]).toMatchObject({ on_duplicate: "ignore" });
      expect(w.body["authorization_model_id"]).toBe("MODEL1");
      expect(w.headers["authorization"]).toBe("Bearer k");
    }
    expect(fake.calls.find((c) => c.path === "/stores")?.body).toEqual({ name: "seedhost-ws1" });

    fake.calls.length = 0;
    const second = await engine.sync(snapshot(rules), first);
    expect(second).toEqual({ ...first, writes: 0, deletes: 0 });
    expect(fake.calls.some((c) => c.path.endsWith("/authorization-models"))).toBe(false);

    const third = await engine.sync(snapshot(rules.slice(0, 10)), second);
    expect(third.deletes).toBe(220);
    const deletes = fake.calls.filter((c) => c.body["deletes"] !== undefined);
    for (const d of deletes) {
      expect(d.body["deletes"]).toMatchObject({ on_missing: "ignore" });
      expect(
        (d.body["deletes"] as { tuple_keys: unknown[] }).tuple_keys.length,
      ).toBeLessThanOrEqual(100);
    }
  });

  it("rewrites a tuple whose condition differs: delete first, then write", async () => {
    const fake = fakeServer();
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    const s = await engine.sync(snapshot(), { storeRef: null, modelRef: null });
    const subject = [...fake.stored.values()].find((t) => t["relation"] === "subject") as Record<
      string,
      unknown
    >;
    subject["condition"] = {
      name: "valid_window",
      context: { not_before: OPEN_NOT_BEFORE, not_after: "2000-01-01T00:00:00Z" },
    };
    fake.calls.length = 0;
    const again = await engine.sync(snapshot(), s);
    expect(again).toMatchObject({ writes: 1, deletes: 1 });
    const ops = fake.calls.filter((c) => c.path.endsWith("/write"));
    expect(ops[0]?.body["deletes"]).toBeDefined();
    expect(ops[1]?.body["writes"]).toBeDefined();
  });

  it("always sends context.current_time and chunks batch checks by 50", async () => {
    const fake = fakeServer();
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    const at = new Date("2026-10-01T10:00:00.123Z");
    const resources = Array.from({ length: 120 }, (_, i) => ({ kind: "document", id: `d${i}` }));
    const ids = await engine.batchCheck(SYNCED, {
      membershipId: "m1",
      resources,
      capability: "download",
      at,
    });
    expect(ids.allowed.size).toBe(120);
    expect(ids.failed.size).toBe(0);
    const checks = fake.calls.filter((c) => c.path.endsWith("/batch-check"));
    expect(checks.map((c) => (c.body["checks"] as unknown[]).length)).toEqual([50, 50, 20]);
    for (const c of checks) {
      expect(c.body["authorization_model_id"]).toBe("MODEL1");
      for (const item of c.body["checks"] as {
        context: unknown;
        tuple_key: { relation: string; user: string };
      }[]) {
        expect(item.context).toEqual({ current_time: "2026-10-01T10:00:00.123Z" });
        expect(item.tuple_key).toMatchObject({ relation: "download", user: "user:m1" });
      }
    }
    const got = await engine.check(SYNCED, {
      membershipId: "m1",
      resource: { kind: "folder", id: "root" },
      capabilities: ["view", "edit", "view"],
      at,
    });
    expect(got).toEqual({ view: true, download: false, comment: false, edit: true });
    const last = fake.calls.at(-1);
    expect(
      ((last as Call).body["checks"] as { context: unknown }[]).every(
        (i) => (i.context as { current_time: string }).current_time === at.toISOString(),
      ),
    ).toBe(true);
  });

  it("sends ancestors as contextual parent links, nearest first, and fails items it cannot send", async () => {
    const fake = fakeServer((c) =>
      c.path.endsWith("/batch-check")
        ? {
            status: 200,
            body: {
              result: {
                c0: { allowed: true },
                c1: { error: { message: "authorization_model_resolution_too_complex" } },
                c2: { error: { message: "context deadline exceeded" } },
              },
            },
          }
        : undefined,
    );
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    const res = await engine.batchCheck(SYNCED, {
      membershipId: "m1",
      resources: [
        {
          kind: "document",
          id: "d9",
          ancestors: [
            { kind: "folder", id: "f2" },
            { kind: "folder", id: "f1" },
          ],
        },
        { kind: "folder", id: "deep" },
        { kind: "folder", id: "slow" },
        {
          kind: "document",
          id: "big",
          ancestors: Array.from({ length: 101 }, (_, i) => ({ kind: "folder", id: `x${i}` })),
        },
        { kind: "document", id: "alien", ancestors: [{ kind: "vault", id: "v" }] },
      ],
      capability: "view",
      at: new Date(),
    });
    expect([...res.allowed]).toEqual(["d9"]);
    expect(Object.fromEntries(res.failed)).toEqual({
      deep: "rejected",
      slow: "timeout",
      big: "rejected",
      alien: "rejected",
    });
    const sent = fake.calls.find((c) => c.path.endsWith("/batch-check"))?.body["checks"] as {
      contextual_tuples?: { tuple_keys: unknown[] };
    }[];
    expect(sent).toHaveLength(3);
    expect(sent[0]?.contextual_tuples?.tuple_keys).toEqual([
      { user: "folder:f2", relation: "parent", object: "document:d9" },
      { user: "folder:f1", relation: "parent", object: "folder:f2" },
    ]);
    expect(sent[1]?.contextual_tuples).toBeUndefined();
    // check(): one resource, so a failing item throws.
    await expect(
      engine.check(SYNCED, {
        membershipId: "m1",
        resource: { kind: "folder", id: "x" },
        capabilities: ["view", "edit"],
        at: new Date(),
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("sends only the unsynced leading part of the chain, caches edge reads, and caps depth", async () => {
    const fake = fakeServer();
    let clock = 0;
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
      now: () => clock,
    });
    // Synced: root ← f1 ← f2 (folders), d1 in f2.
    fake.stored.set("a", { user: "folder:root", relation: "parent", object: "folder:f1" });
    fake.stored.set("b", { user: "folder:f1", relation: "parent", object: "folder:f2" });
    fake.stored.set("c", { user: "folder:f2", relation: "parent", object: "document:d1" });
    const chain = [
      { kind: "folder", id: "f2" },
      { kind: "folder", id: "f1" },
      { kind: "folder", id: "root" },
    ];
    const sentFor = async (resource: { kind: string; id: string; ancestors?: typeof chain }) => {
      fake.calls.length = 0;
      await engine.batchCheck(SYNCED, {
        membershipId: "m1",
        resources: [resource],
        capability: "view",
        at: new Date(),
      });
      const bc = fake.calls.find((c) => c.path.endsWith("/batch-check"));
      const reads = fake.calls.filter((c) => c.path.endsWith("/read")).length;
      const item = (
        bc?.body["checks"] as { contextual_tuples?: { tuple_keys: unknown[] } }[] | undefined
      )?.[0];
      return {
        contextual: item?.contextual_tuples?.tuple_keys ?? [],
        reads,
        called: bc !== undefined,
      };
    };
    // A synced document: nothing contextual (no duplicated edge).
    expect((await sentFor({ kind: "document", id: "d1", ancestors: chain })).contextual).toEqual(
      [],
    );
    // A new document in a synced folder: exactly its own edge; f2's children read is cached now.
    const fresh = await sentFor({ kind: "document", id: "d2", ancestors: chain });
    expect(fresh.contextual).toEqual([
      { user: "folder:f2", relation: "parent", object: "document:d2" },
    ]);
    expect(fresh.reads).toBe(2); // exact edges: f2→d2 (absent), f1→f2 (stored, stop)
    // A new folder chain under f2: new3 ← new2 ← f2: two contextual edges, stop at f2 ← f1.
    const deep = await sentFor({
      kind: "document",
      id: "d3",
      ancestors: [{ kind: "folder", id: "new3" }, { kind: "folder", id: "new2" }, ...chain],
    });
    expect(deep.contextual).toEqual([
      { user: "folder:new3", relation: "parent", object: "document:d3" },
      { user: "folder:new2", relation: "parent", object: "folder:new3" },
      { user: "folder:f2", relation: "parent", object: "folder:new2" },
    ]);
    // Cached within the TTL: no read for d1 again; after the TTL a fresh read.
    expect((await sentFor({ kind: "document", id: "d1", ancestors: chain })).reads).toBe(0);
    clock += 16_000;
    expect((await sentFor({ kind: "document", id: "d1", ancestors: chain })).reads).toBe(1);
    // Over the depth limit: refused before any engine call.
    const tooDeep = Array.from({ length: 21 }, (_, i) => ({ kind: "folder", id: `z${i}` }));
    fake.calls.length = 0;
    const res = await engine.batchCheck(SYNCED, {
      membershipId: "m1",
      resources: [{ kind: "document", id: "dz", ancestors: tooDeep }],
      capability: "view",
      at: new Date(),
    });
    expect(res.failed.get("dz")).toBe("rejected");
    expect(
      fake.calls.filter((c) => c.path.endsWith("/batch-check") || c.path.endsWith("/read")),
    ).toEqual([]);
  });

  it("answers false for a kind the model lacks, without asking", async () => {
    const fake = fakeServer();
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    const got = await engine.check(SYNCED, {
      membershipId: "m1",
      resource: { kind: "post", id: "p1" },
      capabilities: ["view"],
      at: new Date(),
    });
    expect(got.view).toBe(false);
    expect(fake.calls.some((c) => c.path.endsWith("/batch-check"))).toBe(false);
  });

  it("turns a per-item batch-check error into rejected and a missing item into invalid_response", async () => {
    const perItem = fakeServer((c) =>
      c.path.endsWith("/batch-check")
        ? {
            status: 200,
            body: {
              result: {
                c0: {
                  error: { input_error: "validation_error", message: "missing context parameters" },
                },
              },
            },
          }
        : undefined,
    );
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: perItem.http,
      timeoutMs: 1000,
    });
    const q = {
      membershipId: "m1",
      resource: { kind: "folder", id: "root" },
      capabilities: ["view"] as const,
      at: new Date(),
    };
    await expect(engine.check(SYNCED, q)).rejects.toMatchObject({ code: "rejected" });
    const missing = fakeServer((c) =>
      c.path.endsWith("/batch-check") ? { status: 200, body: { result: {} } } : undefined,
    );
    const e2 = createOpenFgaEngine({ url: "http://fga.test", http: missing.http, timeoutMs: 1000 });
    await expect(e2.check(SYNCED, q)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses to check before the first sync", async () => {
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fakeServer().http,
      timeoutMs: 1000,
    });
    await expect(
      engine.batchCheck(
        { storeRef: "S", modelRef: null },
        {
          membershipId: "m",
          resources: [{ kind: "folder", id: "f" }],
          capability: "view",
          at: new Date(),
        },
      ),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses to sync into a store that belongs to another workspace", async () => {
    const fake = fakeServer((c) =>
      c.path === "/stores/OTHER"
        ? { status: 200, body: { id: "OTHER", name: "seedhost-ws2" } }
        : undefined,
    );
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    await expect(
      engine.sync(snapshot(), { storeRef: "OTHER", modelRef: null }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(fake.calls.some((c) => c.path.endsWith("/write"))).toBe(false);
  });

  it("deletes every tuple before deleting the store, and treats 404 as done", async () => {
    const fake = fakeServer();
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: fake.http,
      timeoutMs: 1000,
    });
    const s = await engine.sync(snapshot(), { storeRef: null, modelRef: null });
    expect(fake.stored.size).toBeGreaterThan(0);
    fake.calls.length = 0;
    await engine.dropWorkspace(s);
    expect(fake.stored.size).toBe(0);
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/stores/STORE1" });
    const gone = fakeServer(() => ({ status: 404, body: { code: "store_id_not_found" } }));
    await createOpenFgaEngine({
      url: "http://fga.test",
      http: gone.http,
      timeoutMs: 1000,
    }).dropWorkspace(s);
    await createOpenFgaEngine({
      url: "http://fga.test",
      http: gone.http,
      timeoutMs: 1000,
    }).dropWorkspace({ storeRef: null, modelRef: null });
  });
});

describe("error mapping", () => {
  const cases: [
    string,
    Parameters<typeof fakeServer>[0] | "throw-timeout" | "throw-net" | "throw-guard" | "throw-big",
    string,
  ][] = [
    ["401", () => ({ status: 401, body: { code: "bearer_token_missing" } }), "unauthorized"],
    ["403", () => ({ status: 403, body: {} }), "unauthorized"],
    ["400", () => ({ status: 400, body: { code: "validation_error" } }), "rejected"],
    ["404", () => ({ status: 404, body: { code: "store_id_not_found" } }), "rejected"],
    ["429", () => ({ status: 429, body: {} }), "unreachable"],
    ["500", () => ({ status: 500, body: {} }), "unreachable"],
    ["504", () => ({ status: 504, body: {} }), "timeout"],
    ["non-JSON 200", () => ({ status: 200, body: undefined }), "invalid_response"],
    ["timeout", "throw-timeout", "timeout"],
    ["network", "throw-net", "unreachable"],
    ["guard blocked", "throw-guard", "unreachable"],
    ["guard too large", "throw-big", "invalid_response"],
  ];
  for (const [name, behaviour, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const http =
        typeof behaviour === "function"
          ? fakeServer(behaviour).http
          : async (): Promise<Response> => {
              if (behaviour === "throw-timeout") throw new DOMException("t", "TimeoutError");
              if (behaviour === "throw-guard") throw new OutboundHttpError("blocked_address", "no");
              if (behaviour === "throw-big")
                throw new OutboundHttpError("response_too_large", "big");
              throw new TypeError("fetch failed");
            };
      const engine = createOpenFgaEngine({ url: "http://fga.test", http, timeoutMs: 1000 });
      const error = await engine.healthCheck().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RelationshipEngineError);
      expect((error as RelationshipEngineError).code).toBe(code);
    });
  }

  it("passes a timeout signal and never follows redirects", async () => {
    let init: RequestInit | undefined;
    const engine = createOpenFgaEngine({
      url: "http://fga.test",
      http: async (_u, i) => {
        init = i;
        return new Response(JSON.stringify({ stores: [] }), { status: 200 });
      },
      timeoutMs: 1234,
    });
    await engine.healthCheck();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("manual");
    expect(((init?.headers ?? {}) as Record<string, string>)["authorization"]).toBeUndefined();
  });
});
