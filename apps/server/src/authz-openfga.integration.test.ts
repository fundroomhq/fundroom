import { buildRelationshipSnapshot, createAuthzService, createEngineStore } from "@fundroom/authz";
import {
  AUTHZ_CONTRACT_FIXTURE,
  type AuthzContractWorld,
  type ContractMember,
  type ContractNode,
  contractSubject,
  contractWindow,
  describeAuthzPortContract,
} from "@fundroom/authz/testing";
import { createOpenFgaEngine, projectSnapshot, tupleIdentity } from "@fundroom/authz-openfga";
import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { EngineState, RelationshipEnginePort, RelationshipSnapshot } from "@fundroom/ports";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { esignTestConfig, freshSecrets, harness, json, waitFor } from "./test/esign-harness.js";

/*
 * E3.13 (ADR-0061 §3): the OpenFGA engine behind the authz port, against a real OpenFGA
 * (`openfga/openfga:v1.21.0`, override FUNDROOM_TEST_OPENFGA_IMAGE) and a real Postgres.
 *
 *  - the AuthzPort contract suite: Postgres alone, the composed service in enforce mode, in shadow
 *    mode — the same answers while the engine is in sync;
 *  - enforce narrows when the engine diverges (a tuple deleted behind our back) and never widens;
 *  - shadow counts the mismatch and changes nothing;
 *  - acl.changed → authz.engine_sync keeps the engine current after a grant, a revoke, a group
 *    change and a link revoke; a deleted workspace's store is dropped by the reconciler;
 *  - the engine down: enforce fails closed and /readyz goes red, shadow keeps serving and ready;
 *  - RLS (effective_access) is untouched by the engine;
 *  - a one-connection pool completes sync, check, list and the jobs (no nested pool use).
 */
const IMAGE = process.env["FUNDROOM_TEST_OPENFGA_IMAGE"] ?? "openfga/openfga:v1.21.0";

let pg: TestPostgres;
let fga: StartedTestContainer;
let fgaUrl: string;
let env: ReturnType<typeof freshSecrets>;
let mailer: MemoryMailer;
let enforce: RunningServer;
let shadow: RunningServer;
let direct: RelationshipEnginePort;

function startFga(): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE)
    .withCommand(["run"])
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp("/healthz", 8080))
    .start();
}
const urlOf = (c: StartedTestContainer) => `http://${c.getHost()}:${c.getMappedPort(8080)}`;

function engineEnv(url: string, mode: "shadow" | "enforce", extra: Record<string, string> = {}) {
  return esignTestConfig(env, {
    AUTHZ_ENGINE: "openfga",
    AUTHZ_OPENFGA_URL: url,
    AUTHZ_OPENFGA_MODE: mode,
    AUTHZ_OPENFGA_TIMEOUT_MS: "2000",
    ...extra,
  });
}

beforeAll(async () => {
  [pg, fga] = await Promise.all([startPostgres({ sources: [] }), startFga()]);
  fgaUrl = urlOf(fga);
  env = freshSecrets(pg.connectionString);
  mailer = createMemoryMailer();
  // First server: its telemetry is the process's meter provider (the counters below read it).
  enforce = await startServer({
    config: engineEnv(fgaUrl, "enforce"),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  shadow = await startServer({
    config: engineEnv(fgaUrl, "shadow", { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  direct = createOpenFgaEngine({ url: fgaUrl, http: fetch, timeoutMs: 5_000 });
}, 240_000);

afterAll(async () => {
  await shadow?.stop();
  await enforce?.stop();
  await fga?.stop();
  await pg?.stop();
});

const h = harness(
  () => enforce,
  () => mailer,
);

// --- the fixture world in Postgres ----------------------------------------------------------------

interface Built {
  readonly world: AuthzContractWorld;
  readonly slug: string;
  readonly emails: Readonly<Record<ContractMember, string>>;
  readonly rules: Readonly<Record<string, string>>;
}

let seq = 0;
async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

async function buildWorld(prefix: string): Promise<Built> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const workspaceId = (await createWorkspace(enforce.container.db, { slug, name: `Ws ${slug}` }))
    .id;
  const deps = enforce.container.identityDeps;
  const members = {} as Record<ContractMember, string>;
  const emails = {} as Record<ContractMember, string>;
  for (const m of AUTHZ_CONTRACT_FIXTURE.members) {
    emails[m] = `${m}@${slug}.test`;
    const { userId } = await provisionUser(deps, { email: emails[m], displayName: m });
    members[m] = (
      await provisionMembership(deps, {
        workspaceId,
        userId,
        kind: "external",
        role: "investor",
        source: "test",
      })
    ).id;
  }
  const nodes = {} as Record<ContractNode, { kind: string; id: string; path: string }>;
  for (const f of AUTHZ_CONTRACT_FIXTURE.folders) {
    const id = crypto.randomUUID();
    const parent = f.parent === null ? null : nodes[f.parent];
    const path = parent === null ? "r" : `${parent.path}.${id.replace(/-/gu, "")}`;
    await q(
      `INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
       VALUES ($1, $2, $3, $4, $5::ltree)`,
      [id, workspaceId, parent?.id ?? null, f.name, path],
    );
    nodes[f.name] = { kind: "folder", id, path };
  }
  for (const d of AUTHZ_CONTRACT_FIXTURE.documents) {
    const folder = nodes[d.folder];
    const [row] = await q<{ id: string }>(
      `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
       VALUES ($1, $2, $3::ltree, $4) RETURNING id`,
      [workspaceId, folder.id, folder.path, d.name],
    );
    nodes[d.name] = { kind: "document", id: row?.id as string, path: folder.path };
  }
  const groups = {} as Record<string, string>;
  for (const g of AUTHZ_CONTRACT_FIXTURE.groups) {
    const [row] = await q<{ id: string }>(
      `INSERT INTO core."group" (workspace_id, name) VALUES ($1, $2) RETURNING id`,
      [workspaceId, g.name],
    );
    groups[g.name] = row?.id as string;
    for (const m of g.members)
      await q(
        "INSERT INTO core.group_member (workspace_id, group_id, membership_id) VALUES ($1, $2, $3)",
        [workspaceId, groups[g.name], members[m]],
      );
  }
  const links = {} as Record<string, string>;
  for (const l of AUTHZ_CONTRACT_FIXTURE.links) {
    const [row] = await q<{ id: string }>(
      `INSERT INTO core.share_link (workspace_id, label, token_hash)
       VALUES ($1, $2, sha256(gen_random_uuid()::text::bytea)) RETURNING id`,
      [workspaceId, l.name],
    );
    links[l.name] = row?.id as string;
    for (const m of l.visitors)
      await q(
        "INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id) VALUES ($1, $2, $3)",
        [workspaceId, links[l.name], members[m]],
      );
  }
  const world: AuthzContractWorld = {
    workspaceId,
    members,
    groups: groups as AuthzContractWorld["groups"],
    links: links as AuthzContractWorld["links"],
    nodes,
  };
  const rules: Record<string, string> = {};
  const now = new Date();
  for (const r of AUTHZ_CONTRACT_FIXTURE.rules) {
    const s = contractSubject(r.subject, world);
    const node = nodes[r.node];
    const w = contractWindow(r.window, now);
    const [row] = await q<{ id: string }>(
      `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, subject_role,
         resource_kind, resource_id, resource_path, capability, effect, validity, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::ltree, $8, $9, tstzrange($10::timestamptz, $11::timestamptz, '[)'),
               CASE WHEN $12 THEN now() END)
       RETURNING id`,
      [
        workspaceId,
        s.kind,
        s.kind === "role" ? null : s.id,
        s.kind === "role" ? s.role : null,
        node.kind,
        node.id,
        node.kind === "folder" ? node.path : null,
        r.capability,
        r.effect,
        w.validFrom?.toISOString() ?? null,
        w.validUntil?.toISOString() ?? null,
        r.revoked === true,
      ],
    );
    rules[r.name] = row?.id as string;
  }
  const built: Built = { world, slug, emails, rules };
  await settle(workspaceId);
  return built;
}

/** Raw writes moved the graph: bump, rebuild effective_access, sync the engine, drop caches. */
async function settle(workspaceId: string): Promise<void> {
  await q("UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1", [workspaceId]);
  await enforce.container.authz.rebuild(workspaceId);
  const outcome = await enforce.container.authzEngine?.syncWorkspace(workspaceId);
  expect(outcome?.status).toBe("synced");
  enforce.container.authz.invalidate(workspaceId);
  shadow.container.authz.invalidate(workspaceId);
}

async function engineState(workspaceId: string) {
  const [row] = await q<{
    store_ref: string | null;
    model_ref: string | null;
    synced: string;
    last_error_code: string | null;
  }>(
    `SELECT store_ref, model_ref, synced_acl_version::text AS synced, last_error_code
       FROM core.authz_engine_state WHERE workspace_id = $1`,
    [workspaceId],
  );
  return row;
}

async function aclVersion(workspaceId: string): Promise<number> {
  const [r] = await q<{ v: string }>(
    "SELECT acl_version::text AS v FROM core.workspace WHERE id = $1",
    [workspaceId],
  );
  return Number(r?.v);
}

async function snapshotOf(workspaceId: string): Promise<RelationshipSnapshot> {
  const ctx = systemContext(workspaceId);
  return enforce.container.db.withTenant(ctx, (tx) => buildRelationshipSnapshot(tx, ctx));
}

/**
 * Divergence: delete, straight in OpenFGA, the tuples only `ruleName` contributes — as if someone
 * edited the store behind the kernel's back. The kernel's state still says "in sync".
 */
async function deleteRuleTuples(b: Built, ruleName: string): Promise<number> {
  const snap = await snapshotOf(b.world.workspaceId);
  const ruleId = b.rules[ruleName];
  const all = projectSnapshot(snap, 23).tuples;
  const without = projectSnapshot(
    { ...snap, rules: snap.rules.filter((r) => r.id !== ruleId) },
    23,
  ).tuples;
  const gone = [...all.entries()].filter(([k]) => !without.has(k)).map(([, t]) => t);
  expect(gone.length).toBeGreaterThan(0);
  const state = await engineState(b.world.workspaceId);
  const res = await fetch(`${fgaUrl}/stores/${state?.store_ref}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deletes: {
        tuple_keys: gone.map((t) => ({ user: t.user, relation: t.relation, object: t.object })),
        on_missing: "ignore",
      },
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(new Set(gone.map(tupleIdentity)).size).toBe(gone.length);
  return gone.length;
}

const principal = (b: Built, m: ContractMember) => ({
  workspaceId: b.world.workspaceId,
  membershipId: b.world.members[m],
});

async function directCheck(b: Built, m: ContractMember, node: ContractNode): Promise<boolean> {
  const state = await engineState(b.world.workspaceId);
  const refs: EngineState = {
    storeRef: state?.store_ref ?? null,
    modelRef: state?.model_ref ?? null,
  };
  const n = b.world.nodes[node];
  const r = await direct.check(refs, {
    membershipId: b.world.members[m],
    resource: { kind: n.kind, id: n.id },
    capabilities: ["view"],
    at: new Date(),
  });
  return r.view;
}

async function metricsText(): Promise<string> {
  return enforce.telemetry.metricsText();
}

function counter(text: string, name: string, labels: Record<string, string>): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    total += Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return total;
}

// --- the contract, three ways --------------------------------------------------------------------

let contractWorld: Promise<Built> | undefined;
const sharedWorld = () => {
  contractWorld ??= buildWorld("ctr");
  return contractWorld;
};

describeAuthzPortContract("postgres", async () => ({
  port: createAuthzService({ db: enforce.container.db, permissionCatalogue: () => [] }),
  world: (await sharedWorld()).world,
}));
describeAuthzPortContract("openfga enforce", async () => ({
  port: enforce.container.authz,
  world: (await sharedWorld()).world,
}));
describeAuthzPortContract("openfga shadow", async () => ({
  port: shadow.container.authz,
  world: (await sharedWorld()).world,
}));

describe("the snapshot", () => {
  it("projects the external non-delegate members, live rules and the folder/document tree", async () => {
    const b = await sharedWorld();
    const snap = await snapshotOf(b.world.workspaceId);
    expect(snap.aclVersion).toBe(await aclVersion(b.world.workspaceId));
    expect(snap.members.map((m) => m.membershipId).sort()).toEqual(
      Object.values(b.world.members).sort(),
    );
    const erin = snap.members.find((m) => m.membershipId === b.world.members.erin);
    expect(erin?.linkIds).toEqual([b.world.links.l]);
    const bob = snap.members.find((m) => m.membershipId === b.world.members.bob);
    expect(bob?.groupIds).toEqual([b.world.groups.g]);
    // The revoked rule is not shipped; the others are.
    expect(snap.rules.map((r) => r.id).sort()).toEqual(
      Object.entries(b.rules)
        .filter(([n]) => n !== "alice-view-a-revoked")
        .map(([, id]) => id)
        .sort(),
    );
    const nodeOf = (n: ContractNode) => snap.nodes.find((x) => x.id === b.world.nodes[n].id);
    expect(nodeOf("root")?.parent).toBeNull();
    expect(nodeOf("a1")?.parent).toEqual({ kind: "folder", id: b.world.nodes.a.id });
    expect(nodeOf("dA1")?.parent).toEqual({ kind: "folder", id: b.world.nodes.a1.id });
    expect(nodeOf("dB")?.parent).toEqual({ kind: "folder", id: b.world.nodes.b.id });
    // Engine state recorded the sync.
    const state = await engineState(b.world.workspaceId);
    expect(Number(state?.synced)).toBe(snap.aclVersion);
    expect(state?.last_error_code).toBeNull();
  });
});

// --- divergence --------------------------------------------------------------------------------

describe("divergence", () => {
  it("enforce narrows when the engine denies, never widens; shadow counts it and changes nothing", async () => {
    const b = await buildWorld("div");
    const frank = principal(b, "frank");
    const dave = principal(b, "dave");
    const a = b.world.nodes.a;
    const bNode = b.world.nodes.b;
    expect((await enforce.container.authz.check(frank, a, "view")).allowed).toBe(true);
    const mismatchBefore = counter(await metricsText(), "fundroom_authz_shadow_mismatch_total", {
      capability: "view",
      direction: "pg_only",
    });

    // The group's allow on `a` vanishes from the engine only.
    await deleteRuleTuples(b, "g-view-a");
    expect(await directCheck(b, "frank", "a")).toBe(false);
    // Enforce: Postgres still allows, the composed answer is narrowed.
    expect(await enforce.container.authz.check(frank, a, "view")).toEqual({
      allowed: false,
      capabilities: [],
      pendingGates: [],
      reason: "no_grant",
    });
    const listed = await enforce.container.authz.listAccessible(frank, "folder");
    expect(listed.map((r) => r.id)).toEqual([bNode.id]);
    // Shadow: the decision is Postgres's, the mismatch is counted.
    expect((await shadow.container.authz.check(frank, a, "view")).allowed).toBe(true);
    await shadow.container.authzEngine?.shadowIdle();
    const mismatchAfter = counter(await metricsText(), "fundroom_authz_shadow_mismatch_total", {
      capability: "view",
      direction: "pg_only",
    });
    expect(mismatchAfter).toBeGreaterThan(mismatchBefore);

    // Dave's exclude vanishes from the engine: it now allows him on b — the composed answer does not.
    await deleteRuleTuples(b, "dave-exclude-b");
    expect(await directCheck(b, "dave", "b")).toBe(true);
    expect((await enforce.container.authz.check(dave, bNode, "view")).allowed).toBe(false);
    expect(await enforce.container.authz.listAccessible(dave, "folder")).toEqual([]);

    // RLS is effective_access's, untouched by the engine: frank still reads `a` through RLS.
    const ctx: TenantContext = {
      workspaceId: b.world.workspaceId,
      actorKind: "external",
      membershipId: b.world.members.frank,
    };
    const rls = await enforce.container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute("SELECT id::text AS id FROM dataroom.folder ORDER BY id");
      return (r.rows as { id: string }[]).map((x) => x.id);
    });
    expect(rls).toContain(a.id);
    expect(rls).not.toContain(b.world.nodes.root.id);

    // A full sync repairs the drift.
    expect((await enforce.container.authzEngine?.syncWorkspace(b.world.workspaceId))?.status).toBe(
      "synced",
    );
    expect(await directCheck(b, "frank", "a")).toBe(true);
    expect((await enforce.container.authz.check(frank, a, "view")).allowed).toBe(true);
  }, 120_000);
});

// --- the sync pipeline -------------------------------------------------------------------------

describe("acl.changed → authz.engine_sync", () => {
  /** A write in a system transaction that bumps like the services do (outbox `acl.changed`). */
  async function change(workspaceId: string, statements: string[]): Promise<number> {
    const ctx = systemContext(workspaceId);
    return enforce.container.db.withTenant(ctx, async (tx) => {
      for (const s of statements) await tx.execute(s);
      return enforce.container.authz.bump(tx, ctx, "test.engine_sync");
    });
  }

  async function syncedTo(workspaceId: string, version: number): Promise<void> {
    await waitFor(
      `engine synced to v${version}`,
      async () => {
        const s = await engineState(workspaceId);
        return s !== undefined && Number(s.synced) >= version ? true : undefined;
      },
      30_000,
    );
  }

  it("a grant, its revoke, a group change and a link revoke all reach the engine", async () => {
    const b = await buildWorld("sync");
    const ws = b.world.workspaceId;
    const dave = b.world.members.dave;
    const a1 = b.world.nodes.a1;

    // Grant: dave view on a1.
    const grantId = crypto.randomUUID();
    let v = await change(ws, [
      `INSERT INTO core.access_grant (id, workspace_id, subject_kind, subject_id, resource_kind,
         resource_id, resource_path, capability, validity)
       VALUES ('${grantId}', '${ws}', 'membership', '${dave}', 'folder', '${a1.id}',
               '${a1.path}'::ltree, 'view', tstzrange(NULL, NULL))`,
    ]);
    await syncedTo(ws, v);
    expect(await directCheck(b, "dave", "a1")).toBe(true);
    await waitFor("dave sees a1 (enforce)", async () =>
      (await enforce.container.authz.check(principal(b, "dave"), a1, "view")).allowed
        ? true
        : undefined,
    );

    // Revoke it.
    v = await change(ws, [
      `UPDATE core.access_grant SET revoked_at = now() WHERE id = '${grantId}'`,
    ]);
    await syncedTo(ws, v);
    expect(await directCheck(b, "dave", "a1")).toBe(false);

    // Group change: frank leaves g.
    expect(await directCheck(b, "frank", "a")).toBe(true);
    v = await change(ws, [
      `UPDATE core.group_member SET revoked_at = now()
        WHERE group_id = '${b.world.groups.g}' AND membership_id = '${b.world.members.frank}'`,
    ]);
    await syncedTo(ws, v);
    expect(await directCheck(b, "frank", "a")).toBe(false);

    // Link revoke: erin's only door to a1.
    expect(await directCheck(b, "erin", "a1")).toBe(true);
    v = await change(ws, [
      `UPDATE core.share_link SET status = 'revoked', revoked_at = now()
        WHERE id = '${b.world.links.l}'`,
    ]);
    await syncedTo(ws, v);
    expect(await directCheck(b, "erin", "a1")).toBe(false);
    expect((await engineState(ws))?.last_error_code).toBeNull();
  }, 120_000);

  it("the reconciler re-syncs a lagging workspace and drops a deleted workspace's store", async () => {
    const b = await buildWorld("rec");
    const ws = b.world.workspaceId;
    // Lagging without an event (a raw bump): the reconciler enqueues the sync.
    await q("UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1", [ws]);
    const v = await aclVersion(ws);
    await h.runJob("authz.engine_reconcile", {});
    await waitFor(
      "reconciled sync",
      async () => (Number((await engineState(ws))?.synced) >= v ? true : undefined),
      30_000,
    );
    // Deleted: the store goes, then the state row.
    const store = (await engineState(ws))?.store_ref as string;
    expect((await fetch(`${fgaUrl}/stores/${store}`)).status).toBe(200);
    await q("UPDATE core.workspace SET deleted_at = now() WHERE id = $1", [ws]);
    await h.runJob("authz.engine_reconcile", {});
    expect(await engineState(ws)).toBeUndefined();
    expect((await fetch(`${fgaUrl}/stores/${store}`)).status).not.toBe(200);
  }, 120_000);
});

// --- the engine down ------------------------------------------------------------------------------

describe("the engine down", () => {
  let other: StartedTestContainer;
  let failEnforce: RunningServer;
  let failShadow: RunningServer;
  let b: Built;

  beforeAll(async () => {
    other = await startFga();
    const url = urlOf(other);
    failEnforce = await startServer({
      config: engineEnv(url, "enforce", { ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    failShadow = await startServer({
      config: engineEnv(url, "shadow", { ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    b = await buildWorld("down");
    expect(
      (await failEnforce.container.authzEngine?.syncWorkspace(b.world.workspaceId))?.status,
    ).toBe("synced");
  }, 180_000);

  afterAll(async () => {
    await failShadow?.stop();
    await failEnforce?.stop();
    await other?.stop().catch(() => undefined);
  });

  it("enforce fails closed and /readyz goes red; shadow keeps serving and stays ready", async () => {
    const bob = principal(b, "bob");
    const a = b.world.nodes.a;
    expect((await failEnforce.container.authz.check(bob, a, "view")).allowed).toBe(true);
    let ready = await failEnforce.readiness.run();
    expect(ready.checks.find((c) => c.name === "authzEngine")?.status).toBe("ok");
    expect(ready.ready).toBe(true);

    const errorsBefore = counter(await metricsText(), "fundroom_authz_engine_errors_total", {
      operation: "check",
    });
    await other.stop();

    expect(await failEnforce.container.authz.check(bob, a, "view")).toEqual({
      allowed: false,
      capabilities: [],
      pendingGates: [],
      reason: "no_grant",
    });
    expect(await failEnforce.container.authz.listAccessible(bob, "folder")).toEqual([]);
    ready = await failEnforce.readiness.run();
    expect(ready.checks.find((c) => c.name === "authzEngine")?.status).toBe("fail");
    expect(ready.ready).toBe(false);
    expect(
      counter(await metricsText(), "fundroom_authz_engine_errors_total", { operation: "check" }),
    ).toBeGreaterThan(errorsBefore);
    // Postgres-only questions are unaffected.
    const holders = await failEnforce.container.authz.whoHasAccess(b.world.workspaceId, a);
    expect(holders.map((x) => x.membershipId)).toContain(b.world.members.bob);

    // Shadow: Postgres decides; the engine is reported, never gating.
    expect((await failShadow.container.authz.check(bob, a, "view")).allowed).toBe(true);
    await failShadow.container.authzEngine?.shadowIdle();
    const s = await failShadow.readiness.run();
    expect(s.checks.find((c) => c.name === "authzEngine")?.status).toBe("fail");
    expect(s.ready).toBe(
      s.checks.filter((c) => c.name !== "authzEngine").every((c) => c.status === "ok"),
    );
  }, 120_000);

  it("a sync against the dead engine records the error for the reconciler", async () => {
    const outcome = await failEnforce.container.authzEngine?.syncWorkspace(b.world.workspaceId);
    expect(outcome?.status).toBe("failed");
    expect((await engineState(b.world.workspaceId))?.last_error_code).toMatch(/^[a-z_]+$/u);
    // Restore the shared state row for the rest of the file (the live engine re-syncs it).
    expect((await enforce.container.authzEngine?.syncWorkspace(b.world.workspaceId))?.status).toBe(
      "synced",
    );
  }, 60_000);
});

// --- RLS-backed list endpoints -------------------------------------------------------------------

describe("RLS-backed list endpoints", () => {
  it("the data-room tree an investor gets is the one Postgres decides, in sync", async () => {
    const b = await sharedWorld();
    const cookie = await h.signIn(b.slug, b.emails.frank);
    const res = await h.request(b.slug, "/api/v1/data-room/tree", { cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    const tree = await json<{ folders: { id: string }[]; documents: { id: string }[] }>(res);
    const docs = tree.documents.map((d) => d.id);
    // frank: dA through his group's folder, dB through the investors' role rule; dA1 is excluded
    // for his group, dRoot was never granted.
    expect(docs).toEqual(expect.arrayContaining([b.world.nodes.dA.id, b.world.nodes.dB.id]));
    expect(docs).not.toContain(b.world.nodes.dA1.id);
    expect(docs).not.toContain(b.world.nodes.dRoot.id);
    const folders = tree.folders.map((f) => f.id);
    expect(folders).toEqual(expect.arrayContaining([b.world.nodes.a.id, b.world.nodes.b.id]));
  }, 60_000);
});

// --- one connection ------------------------------------------------------------------------------

describe("a one-connection pool", () => {
  it("sync, check, list, the sync job and the reconciler complete (no nested pool use)", async () => {
    const b = await sharedWorld();
    const single = await startServer({
      config: engineEnv(fgaUrl, "enforce", { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      await single.container.relay.stop();
      const within = <T>(p: Promise<T> | undefined) =>
        Promise.race([
          p as Promise<T>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out (pool held?)")), 15_000),
          ),
        ]);
      const ws = b.world.workspaceId;
      expect((await within(single.container.authzEngine?.syncWorkspace(ws)))?.status).toBe(
        "synced",
      );
      const bob = principal(b, "bob");
      expect(
        (await within(single.container.authz.check(bob, b.world.nodes.dA1, "view"))).allowed,
      ).toBe(true);
      expect(
        (await within(single.container.authz.listAccessible(bob, "document")))
          .map((r) => r.id)
          .sort(),
      ).toEqual([b.world.nodes.dA.id, b.world.nodes.dA1.id].sort());
      await within(h.runJob("authz.engine_sync", { workspaceId: ws }, single));
      await within(h.runJob("authz.engine_reconcile", {}, single));
    } finally {
      await single.stop();
    }
  }, 120_000);
});

// --- FIX1 ----------------------------------------------------------------------------------------

describe("FIX1 (review R3)", () => {
  it("R3-1: a folder and document created after the sync are allowed in enforce without a sync", async () => {
    const b = await buildWorld("new");
    const ws = b.world.workspaceId;
    const owner = await h.member(b.slug, ws, `owner@${b.slug}.test`, "staff", "owner");
    const res = await h.request(b.slug, "/api/v1/data-room/folders", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ parentId: b.world.nodes.a.id, name: "Fresh" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const folder = (
      await json<{ folders: { id: string; path: string; name: string }[] }>(res)
    ).folders.find((f) => f.name === "Fresh") as { id: string; path: string };
    const [doc] = await q<{ id: string }>(
      `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
       VALUES ($1, $2, $3::ltree, 'fresh deck') RETURNING id`,
      [ws, folder.id, folder.path],
    );
    // Nothing re-synced: the engine has never heard of either node.
    const state = await engineState(ws);
    expect(Number(state?.synced)).toBe(await aclVersion(ws));
    const frank = principal(b, "frank");
    const freshDoc = { kind: "document", id: doc?.id as string, path: folder.path };
    const freshFolder = { kind: "folder", id: folder.id, path: folder.path };
    expect((await enforce.container.authz.check(frank, freshDoc, "view")).allowed).toBe(true);
    expect((await enforce.container.authz.check(frank, freshFolder, "view")).allowed).toBe(true);
    // Still ∩ PG: dave (no grant on a) stays out.
    expect(
      (await enforce.container.authz.check(principal(b, "dave"), freshDoc, "view")).allowed,
    ).toBe(false);
    // And the investor's tree shows it.
    const cookie = await h.signIn(b.slug, b.emails.frank);
    const tree = await json<{ documents: { id: string }[] }>(
      await h.request(b.slug, "/api/v1/data-room/tree", { cookie }),
    );
    expect(tree.documents.map((d) => d.id)).toContain(doc?.id);
  }, 120_000);

  it("R3-2: a document's own rule keeps the folder's view — check, explain and has_access agree", async () => {
    const b = await buildWorld("own");
    const ws = b.world.workspaceId;
    const dA = b.world.nodes.dA;
    await q(
      `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id,
         capability, validity)
       VALUES ($1, 'membership', $2, 'document', $3, 'download', tstzrange(NULL, NULL))`,
      [ws, b.world.members.frank, dA.id],
    );
    await settle(ws);
    const pgOnly = createAuthzService({ db: enforce.container.db, permissionCatalogue: () => [] });
    const frank = principal(b, "frank");
    for (const port of [pgOnly, enforce.container.authz]) {
      const view = await port.check(frank, dA, "view");
      expect(view.allowed).toBe(true);
      expect(view.capabilities).toEqual(["view", "download"]);
      expect((await port.check(frank, dA, "download")).allowed).toBe(true);
    }
    expect((await pgOnly.explain(frank, dA)).decision.allowed).toBe(true);
    const ctx: TenantContext = {
      workspaceId: ws,
      actorKind: "external",
      membershipId: frank.membershipId,
    };
    const rls = await enforce.container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute(
        `SELECT core.has_access('document', '${dA.id}'::uuid, '${dA.path}'::ltree, 'view') AS v,
                core.has_access('document', '${dA.id}'::uuid, '${dA.path}'::ltree, 'download') AS d`,
      );
      return r.rows[0] as { v: boolean; d: boolean };
    });
    expect(rls).toEqual({ v: true, d: true });
  }, 120_000);

  it("R3-4/C9: a live lease makes a sync busy, an expired one is taken over; the synced version never goes back", async () => {
    const b = await sharedWorld();
    const ws = b.world.workspaceId;
    // FIX2 C9: a live lease held by someone else → busy, on every process.
    await q(
      `UPDATE core.authz_engine_state SET lease_owner = 'other', lease_until = now() + interval '5 minutes'
        WHERE workspace_id = $1`,
      [ws],
    );
    expect((await enforce.container.authzEngine?.syncWorkspace(ws))?.status).toBe("busy");
    expect((await shadow.container.authzEngine?.syncWorkspace(ws))?.status).toBe("busy");
    // An expired lease (a crashed holder) is taken over; the sync releases it afterwards.
    await q(
      `UPDATE core.authz_engine_state SET lease_until = now() - interval '1 second' WHERE workspace_id = $1`,
      [ws],
    );
    expect((await enforce.container.authzEngine?.syncWorkspace(ws))?.status).toBe("synced");
    const [lease] = await q<{ lease_owner: string | null }>(
      "SELECT lease_owner FROM core.authz_engine_state WHERE workspace_id = $1",
      [ws],
    );
    expect(lease?.lease_owner).toBeNull();
    const before = Number((await engineState(ws))?.synced);
    const state = await engineState(ws);
    await createEngineStore(enforce.container.db).recordSynced(ws, {
      driver: "openfga",
      storeRef: state?.store_ref ?? null,
      modelRef: state?.model_ref ?? null,
      syncedAclVersion: before - 1,
      at: new Date(),
    });
    expect(Number((await engineState(ws))?.synced)).toBe(before);
  }, 60_000);

  it("R3-6: pausing and resuming a share link through the route publishes acl.changed and reaches the engine", async () => {
    const b = await buildWorld("lnk");
    const ws = b.world.workspaceId;
    // Share links need an offering mode that allows them (506(b) here).
    await q("UPDATE core.workspace SET offering_status = '506b' WHERE id = $1", [ws]);
    const owner = await h.member(b.slug, ws, `owner@${b.slug}.test`, "staff", "owner");
    expect(await directCheck(b, "erin", "a1")).toBe(true);
    const pause = await h.request(b.slug, `/api/v1/links/${b.world.links.l}/pause`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(pause.status, await pause.clone().text()).toBe(200);
    const [ev] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.outbox
        WHERE workspace_id = $1 AND topic = 'acl.changed' AND payload->>'cause' = 'share_link.paused'`,
      [ws],
    );
    expect(ev?.n).toBe(1);
    const v = await aclVersion(ws);
    await waitFor(
      "engine synced after pause",
      async () => (Number((await engineState(ws))?.synced) >= v ? true : undefined),
      30_000,
    );
    expect(await directCheck(b, "erin", "a1")).toBe(false);
    const resume = await h.request(b.slug, `/api/v1/links/${b.world.links.l}/resume`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(resume.status, await resume.clone().text()).toBe(200);
    const v2 = await aclVersion(ws);
    await waitFor(
      "engine synced after resume",
      async () => (Number((await engineState(ws))?.synced) >= v2 ? true : undefined),
      30_000,
    );
    expect(await directCheck(b, "erin", "a1")).toBe(true);
  }, 120_000);
});

// --- FIX2: deep trees ------------------------------------------------------------------------------

describe("FIX2 (RR1 #1): deep folder chains stay cheap and never hurt the engine", () => {
  /** A chain of `depth` folders under `a` (raw rows, like the folder service writes them). */
  async function chain(b: Built, depth: number, from: { id: string; path: string }) {
    let parent = from;
    const out: { id: string; path: string }[] = [];
    for (let i = 0; i < depth; i++) {
      const id = crypto.randomUUID();
      const path = `${parent.path}.${id.replace(/-/gu, "")}`;
      await q(
        `INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
         VALUES ($1, $2, $3, $4, $5::ltree)`,
        [id, b.world.workspaceId, parent.id, `L${i}-${id.slice(0, 8)}`, path],
      );
      parent = { id, path };
      out.push(parent);
    }
    return out;
  }
  async function doc(b: Built, folder: { id: string; path: string }): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
       VALUES ($1, $2, $3::ltree, 'deep') RETURNING id`,
      [b.world.workspaceId, folder.id, folder.path],
    );
    return row?.id as string;
  }
  const timed = async <T>(p: Promise<T>) => {
    const t = performance.now();
    const v = await p;
    return { v, ms: performance.now() - t };
  };

  it("16 levels (synced, then with new nodes below) answer within bounds; 26 levels are refused fast; health stays green", async () => {
    const b = await buildWorld("deep");
    const ws = b.world.workspaceId;
    const a = b.world.nodes.a as { id: string; path: string };
    // root → a → 14 more = 16 levels for a document at the bottom.
    const levels = await chain(b, 14, a);
    const bottom = levels.at(-1) as { id: string; path: string };
    const synced = await doc(b, bottom);
    // 26 levels: a further 10 below.
    const deeper = await chain(b, 10, bottom);
    const deepDoc = await doc(b, deeper.at(-1) as { id: string; path: string });
    await settle(ws);
    const frank = principal(b, "frank");
    const at = (id: string, path: string) => ({ kind: "document", id, path });

    // Synced 16-level document: nothing contextual beyond its own parent edge.
    const s1 = await timed(enforce.container.authz.check(frank, at(synced, bottom.path), "view"));
    expect(s1.v.allowed).toBe(true);
    expect(s1.ms).toBeLessThan(1_000);

    // New nodes after the sync: 3 new folders + a document at depth 19, no sync.
    const fresh = await chain(b, 3, bottom);
    const freshFolder = fresh.at(-1) as { id: string; path: string };
    const freshDoc = await doc(b, freshFolder);
    const s2 = await timed(
      enforce.container.authz.check(frank, at(freshDoc, freshFolder.path), "view"),
    );
    expect(s2.v.allowed).toBe(true);
    expect(s2.ms).toBeLessThan(1_000);
    // Shadow too (the rollout mode): decision unchanged, comparison completes quickly.
    expect(
      (await shadow.container.authz.check(frank, at(freshDoc, freshFolder.path), "view")).allowed,
    ).toBe(true);
    const idle = await timed(shadow.container.authzEngine?.shadowIdle() ?? Promise.resolve());
    expect(idle.ms).toBeLessThan(2_000);

    // 26 levels: refused before the engine (deny in enforce), fast.
    const deep = await timed(
      enforce.container.authz.check(
        frank,
        at(deepDoc, (deeper.at(-1) as { path: string }).path),
        "view",
      ),
    );
    expect(deep.v.allowed).toBe(false);
    expect(deep.ms).toBeLessThan(500);

    // The engine is healthy and other workspaces are unaffected.
    await direct.healthCheck();
    const other = await sharedWorld();
    expect(
      (await enforce.container.authz.check(principal(other, "bob"), other.world.nodes.a, "view"))
        .allowed,
    ).toBe(true);
    // A list across shallow and deep folders keeps the shallow ones.
    const folders = await enforce.container.authz.listAccessible(frank, "folder");
    expect(folders.map((r) => r.id)).toContain(b.world.nodes.a.id);
  }, 180_000);
});

// --- FIX3: onboarding order ----------------------------------------------------------------------

describe("FIX3 (RR2-1): a room synced before its first document", () => {
  it("first upload is allowed at once; 9 new nested folders are allowed after the kicked sync", async () => {
    seq += 1;
    const slug = `onb${seq}`;
    const ws = (await createWorkspace(enforce.container.db, { slug, name: `Ws ${slug}` })).id;
    const deps = enforce.container.identityDeps;
    const { userId } = await provisionUser(deps, { email: `ivy@${slug}.test`, displayName: "ivy" });
    const ivy = (
      await provisionMembership(deps, {
        workspaceId: ws,
        userId,
        kind: "external",
        role: "investor",
        source: "test",
      })
    ).id;
    const folder = async (parent: { id: string; path: string } | null, name: string) => {
      const id = crypto.randomUUID();
      const path = parent === null ? "r" : `${parent.path}.${id.replace(/-/gu, "")}`;
      await q(
        `INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
         VALUES ($1, $2, $3, $4, $5::ltree)`,
        [id, ws, parent?.id ?? null, name, path],
      );
      return { id, path };
    };
    const document = async (f: { id: string; path: string }) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
         VALUES ($1, $2, $3::ltree, 'deck') RETURNING id`,
        [ws, f.id, f.path],
      );
      return row?.id as string;
    };
    const root = await folder(null, "root");
    const f = await folder(root, "F");
    await q(
      `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind,
         resource_id, resource_path, capability, validity)
       VALUES ($1, 'membership', $2, 'folder', $3, $4::ltree, 'view', tstzrange(NULL, NULL))`,
      [ws, ivy, f.id, f.path],
    );
    await settle(ws); // synced: folders only, no document anywhere in the workspace
    const who = { workspaceId: ws, membershipId: ivy };

    // The room's first document: the model already declares `document`.
    const first = await document(f);
    expect(
      (
        await enforce.container.authz.check(
          who,
          { kind: "document", id: first, path: f.path },
          "view",
        )
      ).allowed,
    ).toBe(true);

    // 9 new nested folders under F and a document at the bottom: the unsynced chain is cut at 8
    // edges, so the first answer may be a deny — but it kicks a sync, after which it is allowed.
    let parent = f;
    for (let i = 0; i < 9; i++) parent = await folder(parent, `N${i}`);
    const deep = await document(parent);
    const syncedAt = async () =>
      (
        await q<{ t: string }>(
          "SELECT synced_at::text AS t FROM core.authz_engine_state WHERE workspace_id = $1",
          [ws],
        )
      )[0]?.t;
    const t0 = await syncedAt();
    const v0 = await aclVersion(ws);
    const ref = { kind: "document", id: deep, path: parent.path };
    await enforce.container.authz.check(who, ref, "view");
    // Nothing bumped acl_version: only the kick can produce a new sync.
    await waitFor(
      "the kicked sync",
      async () => ((await syncedAt()) !== t0 ? true : undefined),
      30_000,
    );
    expect(await aclVersion(ws)).toBe(v0);
    await waitFor(
      "deep document allowed in enforce",
      async () => {
        enforce.container.authz.invalidate(ws);
        return (await enforce.container.authz.check(who, ref, "view")).allowed ? true : undefined;
      },
      30_000,
    );
    expect(Number((await engineState(ws))?.synced)).toBe(await aclVersion(ws));
  }, 120_000);
});
