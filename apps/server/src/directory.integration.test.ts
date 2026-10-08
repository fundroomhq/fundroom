import { randomBytes, randomUUID } from "node:crypto";
import { isApiError } from "@fundroom/contracts";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import {
  createDirectoryRouting,
  createSharedDirectory,
  type SharedDirectory,
} from "@fundroom/directory";
import type { DirectoryMove, MoveCarried } from "@fundroom/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCellDatabase,
  createDirectoryDatabase,
  type TestDatabase,
} from "./test/directory-db.js";

/*
 * E3.11 agent A: the shared cell directory's port semantics against a real directory database
 * (claims, renames, releases, hostname uniqueness, CAS transitions, leases, switchover, "busy",
 * cell ownership), the concurrency rule (N claims racing on one slug → exactly one wins), and the
 * routing cache the tenant middleware uses (positive/negative cache, own-write invalidation,
 * the global budget, directory-down → miss). Tenant middleware 421s between two app instances and
 * the reconcile sweep are in `directory-routing.integration.test.ts`.
 */

let pg: TestPostgres;
let dirDb: TestDatabase;
let cellDb: TestDatabase;
let dir: SharedDirectory;
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const CARRIED: MoveCarried = { planId: null, legalName: null, country: null, holds: [] };

async function dq<T extends Record<string, unknown>>(q: string, params: unknown[] = []) {
  return (await dirDb.db.pool.query<T>(q, params)).rows;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
}

function publish(d: SharedDirectory, id: string, region: string, key: string | null) {
  return d.publishCell({
    id,
    region,
    regionLabel: `${region} label`,
    jurisdiction: region === "us" ? "us" : "eu",
    publicOrigin: `https://${id}.example.com`,
    status: "active",
    exportPublicKey: key,
  });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  dirDb = await createDirectoryDatabase(pg);
  cellDb = await createCellDatabase(pg);
  // This cell database serves eu-1 and eu-2 (E3.10 label cells share a database and a region).
  await cellDb.db.pool.query(
    `INSERT INTO core.cell (id, region, region_label, jurisdiction) VALUES
       ('eu-1', 'eu', 'Frankfurt', 'eu'), ('eu-2', 'eu', 'Frankfurt', 'eu')`,
  );
  dir = createSharedDirectory({
    url: dirDb.url,
    poolMax: 8,
    db: cellDb.db,
    cellId: "eu-1",
    ownerKeys: [KEY_A],
  });
  await publish(dir, "eu-1", "eu", KEY_A);
  // A remote cell (another database, another key ring).
  const remote = createSharedDirectory({
    url: dirDb.url,
    poolMax: 1,
    db: cellDb.db,
    cellId: "us-1",
    ownerKeys: [KEY_B],
  });
  await publish(remote, "us-1", "us", KEY_B);
  await remote.close();
}, 180_000);

afterAll(async () => {
  await dir?.close();
  await cellDb?.close();
  await dirDb?.close();
  await pg?.stop();
});

describe("cells", () => {
  it("lists cells with local marked by this database's core.cell AND ownership", async () => {
    const cells = await dir.listCells();
    const eu1 = cells.find((c) => c.id === "eu-1");
    expect(eu1).toMatchObject({
      region: "eu",
      regionLabel: "eu label",
      jurisdiction: "eu",
      status: "active",
      exportPublicKey: KEY_A,
      local: true,
    });
    expect(eu1?.heartbeatAt).toBeInstanceOf(Date);
    expect(cells.find((c) => c.id === "us-1")?.local).toBe(false);
  });

  it("refuses to overwrite a cell another cell database owns, or to change a region", async () => {
    // Another database publishing `eu-1` (both seed the same id): refused, facts unchanged.
    const other = createSharedDirectory({
      url: dirDb.url,
      poolMax: 1,
      db: cellDb.db,
      cellId: "eu-1",
      ownerKeys: [KEY_B],
    });
    try {
      const e = await errorOf(publish(other, "eu-1", "eu", KEY_B));
      expect(isApiError(e, "directory_unavailable")).toBe(true);
      expect((e as { details: Record<string, unknown> }).details["reason"]).toBe("cell_conflict");
      // …and it never claims entries on it.
      const c = await errorOf(
        other.claimSlug({ workspaceId: randomUUID(), slug: "squat", cellId: "eu-1" }),
      );
      expect((c as { details: Record<string, unknown> }).details["reason"]).toBe("cell_conflict");
      // It sees eu-1 as NOT local although its core.cell has the row.
      expect((await other.listCells()).find((x) => x.id === "eu-1")?.local).toBe(false);
    } finally {
      await other.close();
    }
    // The owner cannot move its cell to another region either.
    expect(
      isApiError(await errorOf(publish(dir, "eu-1", "us", KEY_A)), "directory_unavailable"),
    ).toBe(true);
    const rows = await dq<{ region: string; export_public_key: string }>(
      "SELECT region, export_public_key FROM directory.cell WHERE id = 'eu-1'",
    );
    expect(rows[0]).toEqual({ region: "eu", export_public_key: KEY_A });
    // A rotated ring still holds the old key: the owner keeps its row.
    const rotated = createSharedDirectory({
      url: dirDb.url,
      poolMax: 1,
      db: cellDb.db,
      cellId: "eu-1",
      ownerKeys: [randomBytes(32).toString("base64"), KEY_A],
    });
    try {
      await publish(rotated, "eu-1", "eu", KEY_A);
    } finally {
      await rotated.close();
    }
  });

  it("publishes a local cell on its first claim; an unknown cell is directory_unavailable", async () => {
    const ws = randomUUID();
    expect(await dir.claimSlug({ workspaceId: ws, slug: "on-eu2", cellId: "eu-2" })).toBe(
      "claimed",
    );
    expect((await dq("SELECT id FROM directory.cell WHERE id = 'eu-2'")).length).toBe(1);
    const e = await errorOf(
      dir.claimSlug({ workspaceId: randomUUID(), slug: "nowhere", cellId: "zz-9" }),
    );
    expect(isApiError(e, "directory_unavailable")).toBe(true);
    await dir.release(ws);
  });
});

describe("slugs", () => {
  it("claims reserved, is idempotent, activates, and refuses a live slug to anyone else", async () => {
    const a = randomUUID();
    expect(await dir.claimSlug({ workspaceId: a, slug: "acme", cellId: "eu-1" })).toBe("claimed");
    expect(await dir.lookupSlug("acme")).toEqual({ cellId: "eu-1", state: "reserved" });
    expect(await dir.claimSlug({ workspaceId: a, slug: "acme", cellId: "eu-1" })).toBe("claimed");
    expect(await dir.claimSlug({ workspaceId: randomUUID(), slug: "acme", cellId: "eu-1" })).toBe(
      "taken",
    );
    // A reserved slug of another cell is taken too (claims never reclaim a reservation).
    await dq(
      "UPDATE directory.workspace SET created_at = now() - interval '2 hours' WHERE workspace_id = $1",
      [a],
    );
    expect(await dir.claimSlug({ workspaceId: randomUUID(), slug: "acme", cellId: "eu-1" })).toBe(
      "taken",
    );
    // The same workspace claiming a second slug is not a rename.
    expect(await dir.claimSlug({ workspaceId: a, slug: "acme-2", cellId: "eu-1" })).toBe("taken");
    await dir.activate(a);
    await dir.activate(a);
    expect(await dir.lookupSlug("acme")).toEqual({ cellId: "eu-1", state: "active" });
    expect(await dir.lookupWorkspace(a)).toMatchObject({ cellId: "eu-1", state: "active" });
    expect(await dir.lookupSlug("nope")).toBeNull();
    expect(await dir.lookupWorkspace(randomUUID())).toBeNull();
    expect(await dir.lookupWorkspace("not-a-uuid")).toBeNull();
  });

  it("renames (taken on a clash), releases (frees slug + hostnames), revives a released id", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await dir.claimSlug({ workspaceId: a, slug: "ren-a", cellId: "eu-1" });
    await dir.claimSlug({ workspaceId: b, slug: "ren-b", cellId: "eu-1" });
    await dir.activate(a);
    await dir.activate(b);
    expect(await dir.renameSlug({ workspaceId: a, to: "ren-b" })).toBe("taken");
    expect(await dir.renameSlug({ workspaceId: a, to: "ren-c" })).toBe("renamed");
    expect(await dir.lookupSlug("ren-a")).toBeNull();
    // A workspace with no entry yet: renamed unless the slug is live elsewhere.
    expect(await dir.renameSlug({ workspaceId: randomUUID(), to: "ren-c" })).toBe("taken");
    expect(await dir.renameSlug({ workspaceId: randomUUID(), to: "ren-free" })).toBe("renamed");

    expect(await dir.claimHost({ hostname: "ir.ren-c.com", workspaceId: a })).toBe("claimed");
    await dir.release(a);
    expect(await dir.lookupSlug("ren-c")).toBeNull();
    expect(await dir.lookupHost("ir.ren-c.com")).toBeNull();
    expect(await dir.lookupWorkspace(a)).toMatchObject({ state: "deleted" });
    // Released: the slug is free for someone else …
    const c = randomUUID();
    expect(await dir.claimSlug({ workspaceId: c, slug: "ren-c", cellId: "eu-1" })).toBe("claimed");
    // … and a claim for the released id revives its entry.
    expect(await dir.claimSlug({ workspaceId: a, slug: "ren-a2", cellId: "eu-1" })).toBe("claimed");
    expect(await dir.lookupWorkspace(a)).toMatchObject({ state: "reserved" });
    await dir.setState(b, "moving");
    expect(await dir.lookupSlug("ren-b")).toEqual({ cellId: "eu-1", state: "moving" });
    await dir.setState(b, "active");
  });

  it("two claims racing on one slug: exactly one wins", async () => {
    const racers = Array.from({ length: 12 }, () => randomUUID());
    const results = await Promise.all(
      racers.map((workspaceId) => dir.claimSlug({ workspaceId, slug: "race", cellId: "eu-1" })),
    );
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "taken")).toHaveLength(11);
    const rows = await dq(
      "SELECT 1 FROM directory.workspace WHERE slug = 'race' AND state <> 'deleted'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("hostnames", () => {
  it("claims verified hostnames uniquely, normalised like the domains package", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await dir.claimSlug({ workspaceId: a, slug: "host-a", cellId: "eu-1" });
    await dir.claimSlug({ workspaceId: b, slug: "host-b", cellId: "eu-1" });
    // Only live (active/moving) entries route by hostname.
    await dir.activate(a);
    expect(await dir.claimHost({ hostname: "IR.Host-A.com.", workspaceId: a })).toBe("claimed");
    expect(await dir.claimHost({ hostname: "ir.host-a.com", workspaceId: a })).toBe("claimed");
    expect(await dir.claimHost({ hostname: "ir.host-a.com", workspaceId: b })).toBe("taken");
    expect(
      await dq("SELECT hostname FROM directory.hostname WHERE hostname LIKE '%host-a%'"),
    ).toEqual([{ hostname: "ir.host-a.com" }]);
    // A Host header spelling (port, case) finds it; garbage never reaches the database.
    expect(await dir.lookupHost("IR.HOST-A.COM:443")).toEqual({ cellId: "eu-1" });
    expect(await dir.lookupHost("127.0.0.1")).toBeNull();
    // Only the holder releases it.
    await dir.releaseHost({ hostname: "ir.host-a.com", workspaceId: b });
    expect(await dir.lookupHost("ir.host-a.com")).toEqual({ cellId: "eu-1" });
    await dir.releaseHost({ hostname: "ir.host-a.com", workspaceId: a });
    expect(await dir.lookupHost("ir.host-a.com")).toBeNull();
    expect(await dir.claimHost({ hostname: "ir.host-a.com", workspaceId: b })).toBe("claimed");
    // No entry → directory_unavailable (the sweep repairs), never a silent claim.
    const e = await errorOf(dir.claimHost({ hostname: "x.host-z.com", workspaceId: randomUUID() }));
    expect(isApiError(e, "directory_unavailable")).toBe(true);
  });
});

describe("moves", () => {
  let ws: string;
  let move: DirectoryMove;

  beforeEach(async () => {
    ws = randomUUID();
    const slug = `mv-${ws.slice(0, 8)}`;
    await dir.claimSlug({ workspaceId: ws, slug, cellId: "eu-1" });
    await dir.activate(ws);
    const m = await dir.moves.request({
      workspaceId: ws,
      slug,
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      requestedBy: "op:tester",
      carried: { ...CARRIED, holds: ["billing"], extra: { subscription: "sub_1" } },
    });
    if (typeof m === "string") throw new Error(m);
    move = m;
  });

  it("requests one live move per entry (busy), unknown workspaces are refused", async () => {
    expect(move).toMatchObject({
      state: "requested",
      sourceWorkspaceId: ws,
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      carried: { holds: ["billing"], extra: { subscription: "sub_1" } },
      bundle: null,
      leaseOwner: null,
    });
    expect(
      await dir.moves.request({
        workspaceId: ws,
        slug: "x",
        sourceCellId: "eu-1",
        targetCellId: "us-1",
        requestedBy: "op",
        carried: CARRIED,
      }),
    ).toBe("busy");
    expect(
      await dir.moves.request({
        workspaceId: randomUUID(),
        slug: "x",
        sourceCellId: "eu-1",
        targetCellId: "us-1",
        requestedBy: "op",
        carried: CARRIED,
      }),
    ).toBe("unknown_workspace");
    // Terminal → a new move is allowed.
    expect(
      await dir.moves.transition(move.id, { from: ["requested"], to: "cancelled" }),
    ).toMatchObject({
      state: "cancelled",
    });
    const again = await dir.moves.request({
      workspaceId: ws,
      slug: "x",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      requestedBy: "op",
      carried: CARRIED,
    });
    expect(typeof again).toBe("object");
    expect(await dir.moves.get(move.id)).toMatchObject({ state: "cancelled" });
    expect(await dir.moves.get("nope")).toBeNull();
    const listed = await dir.moves.list({ workspaceId: ws });
    expect(listed.map((m) => m.state).sort()).toEqual(["cancelled", "requested"]);
    expect(
      (await dir.moves.list({ cellId: "us-1", role: "target", states: ["requested"] })).some(
        (m) => m.sourceWorkspaceId === ws,
      ),
    ).toBe(true);
    expect(
      (await dir.moves.list({ cellId: "us-1", role: "source" })).some(
        (m) => m.sourceWorkspaceId === ws,
      ),
    ).toBe(false);
  });

  it("transitions are compare-and-set; patches write only the keys given", async () => {
    expect(await dir.moves.transition(move.id, { from: ["exported"], to: "importing" })).toBeNull();
    const bundle = {
      url: "https://s3.example.com/x",
      sha256: "a".repeat(64),
      bytes: 10,
      expiresAt: new Date().toISOString(),
      signerKeyFingerprint: "fp",
    };
    const exporting = await dir.moves.transition(move.id, { from: ["requested"], to: "exporting" });
    expect(exporting?.state).toBe("exporting");
    const exported = await dir.moves.transition(move.id, {
      from: ["exporting"],
      to: "exported",
      patch: { bundle },
    });
    expect(exported).toMatchObject({ state: "exported", bundle, carried: move.carried });
    // Two racing CAS from the same state: one wins.
    const [x, y] = await Promise.all([
      dir.moves.transition(move.id, { from: ["exported"], to: "importing" }),
      dir.moves.transition(move.id, { from: ["exported"], to: "failed" }),
    ]);
    expect([x, y].filter((r) => r !== null)).toHaveLength(1);
  });

  it("leases have owner tokens and expiry; heartbeat extends only a held lease", async () => {
    await dir.moves.transition(move.id, { from: ["requested"], to: "exporting" });
    await dir.moves.transition(move.id, { from: ["exporting"], to: "exported" });
    const held = await dir.moves.acquireLease(move.id, "worker-a", 60_000, ["exported"]);
    expect(held).toMatchObject({ leaseOwner: "worker-a" });
    expect(await dir.moves.acquireLease(move.id, "worker-b", 60_000, ["exported"])).toBeNull();
    // Re-entrant for the same owner; wrong `from` refuses.
    expect(await dir.moves.acquireLease(move.id, "worker-a", 60_000, ["exported"])).not.toBeNull();
    expect(await dir.moves.acquireLease(move.id, "worker-a", 60_000, ["imported"])).toBeNull();
    expect(await dir.moves.heartbeat(move.id, "worker-b", 60_000)).toBe(false);
    expect(await dir.moves.heartbeat(move.id, "worker-a", 60_000)).toBe(true);
    // A leased transition requires the lease.
    expect(
      await dir.moves.transition(move.id, {
        from: ["exported"],
        to: "importing",
        leaseOwner: "worker-b",
      }),
    ).toBeNull();
    expect(
      await dir.moves.transition(move.id, {
        from: ["exported"],
        to: "importing",
        leaseOwner: "worker-a",
      }),
    ).toMatchObject({ state: "importing" });
    // Expired: another owner takes it; the old owner's heartbeat and CAS fail.
    await dq(
      "UPDATE directory.move SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [move.id],
    );
    expect(await dir.moves.heartbeat(move.id, "worker-a", 60_000)).toBe(false);
    expect(await dir.moves.acquireLease(move.id, "worker-b", 60_000, ["importing"])).toMatchObject({
      leaseOwner: "worker-b",
    });
    expect(
      await dir.moves.transition(move.id, {
        from: ["importing"],
        to: "imported",
        leaseOwner: "worker-a",
      }),
    ).toBeNull();
    // A terminal state clears the lease.
    const failed = await dir.moves.transition(move.id, {
      from: ["importing"],
      to: "failed",
      patch: { error: { stage: "import", code: "import_failed" } },
    });
    expect(failed).toMatchObject({
      state: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      error: { stage: "import", code: "import_failed" },
    });
  });

  it("switchover rebinds the entry (slug + hostnames follow) in one transaction, with the lease", async () => {
    await dir.claimHost({ hostname: `ir.${move.slug}.com`, workspaceId: ws });
    const target = randomUUID();
    await dir.moves.transition(move.id, { from: ["requested"], to: "exporting" });
    await dir.moves.transition(move.id, { from: ["exporting"], to: "exported" });
    await dir.moves.transition(move.id, {
      from: ["exported"],
      to: "imported",
      patch: { targetWorkspaceId: target },
    });
    // No lease → refused; another owner's lease → refused.
    expect(await dir.moves.switchover(move.id, "src")).toBeNull();
    await dir.moves.acquireLease(move.id, "other", 60_000, ["imported"]);
    expect(await dir.moves.switchover(move.id, "src")).toBeNull();
    await dq(
      "UPDATE directory.move SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [move.id],
    );
    await dir.moves.acquireLease(move.id, "src", 60_000, ["imported"]);
    const switched = await dir.moves.switchover(move.id, "src");
    expect(switched).toMatchObject({ state: "switched", targetWorkspaceId: target });
    expect(await dir.lookupSlug(move.slug)).toEqual({ cellId: "us-1", state: "active" });
    expect(await dir.lookupHost(`ir.${move.slug}.com`)).toEqual({ cellId: "us-1" });
    expect(await dir.lookupWorkspace(target)).toMatchObject({ cellId: "us-1", state: "active" });
    // The source id now resolves (through the switched move) to the target cell …
    expect(await dir.lookupWorkspace(ws)).toMatchObject({ cellId: "us-1" });
    // … and the source's purge releasing its id cannot free the moved entry.
    await dir.release(ws);
    expect(await dir.lookupSlug(move.slug)).toEqual({ cellId: "us-1", state: "active" });
    // Not twice.
    expect(await dir.moves.switchover(move.id, "src")).toBeNull();
  });
});

describe("routing cache (tenant resolution)", () => {
  it("caches positive and negative answers, and this process's own writes clear it", async () => {
    let calls = 0;
    const counting = new Proxy(dir, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "lookupSlug") {
          return (s: string) => {
            calls += 1;
            return target.lookupSlug(s);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as SharedDirectory;
    const routing = createDirectoryRouting({ directory: counting });
    const w = randomUUID();
    expect(await routing.slug("cached")).toBeNull();
    expect(await routing.slug("cached")).toBeNull();
    expect(calls).toBe(1);
    // Our own claim clears the cache: the next read asks again.
    await dir.claimSlug({ workspaceId: w, slug: "cached", cellId: "eu-1" });
    await dir.activate(w);
    expect(await routing.slug("cached")).toEqual({ cellId: "eu-1", state: "active" });
    expect(calls).toBe(2);
    // Another cell's write (straight SQL here) is not seen within the TTL.
    await dq("UPDATE directory.workspace SET cell_id = 'us-1' WHERE workspace_id = $1", [w]);
    expect(await routing.slug("cached")).toEqual({ cellId: "eu-1", state: "active" });
    expect(calls).toBe(2);
    routing.close();
  });

  it("over the global budget answers a miss without asking", async () => {
    let calls = 0;
    const t = 1_000_000;
    const routing = createDirectoryRouting({
      directory: {
        ...dir,
        mode: "shared",
        lookupSlug: async () => {
          calls += 1;
          return { cellId: "us-1", state: "active" };
        },
      },
      budget: 3,
      now: () => t,
    });
    const answers = [];
    for (const s of ["b1", "b2", "b3", "b4", "b5"]) answers.push(await routing.slug(s));
    expect(calls).toBe(3);
    expect(answers.slice(3)).toEqual([null, null]);
    // Cached answers cost no budget.
    expect(await routing.slug("b1")).toEqual({ cellId: "us-1", state: "active" });
  });

  it("a directory that is down answers misses (never throws), quickly, and backs off", async () => {
    const down = createSharedDirectory({
      // Nothing listens on port 1.
      url: "postgres://u:p@127.0.0.1:1/none",
      poolMax: 1,
      db: cellDb.db,
      cellId: "eu-1",
    });
    const events: string[] = [];
    const routing = createDirectoryRouting({ directory: down, log: (e) => events.push(e) });
    const started = Date.now();
    expect(await routing.slug("anything")).toBeNull();
    expect(await routing.host("ir.anything.com")).toBeNull();
    expect(await routing.workspace(randomUUID())).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toEqual(["directory.lookup_failed"]);
    // The port itself throws: callers of the port decide.
    await expect(down.lookupSlug("anything")).rejects.toBeDefined();
    await down.close();
  });
});

describe("fix round 1", () => {
  it("R1-6: a cell publishes every key of its ring with its key id", async () => {
    const keys = [
      { keyId: "k2", publicKey: KEY_A },
      { keyId: "k1", publicKey: randomBytes(32).toString("base64") },
    ];
    await dir.publishCell({
      id: "eu-1",
      region: "eu",
      regionLabel: "eu label",
      jurisdiction: "eu",
      publicOrigin: "https://eu-1.example.com",
      status: "active",
      exportPublicKey: KEY_A,
      exportPublicKeys: keys,
    });
    expect((await dir.listCells()).find((c) => c.id === "eu-1")?.exportPublicKeys).toEqual(keys);
  });

  it("R2-3: dormant holds the slug and hostnames but every lookup answers like no entry", async () => {
    const w = randomUUID();
    await dir.claimSlug({ workspaceId: w, slug: "dorm", cellId: "eu-1" });
    await dir.activate(w);
    await dir.claimHost({ hostname: "ir.dorm.com", workspaceId: w });
    await dir.setState(w, "dormant");
    expect(await dir.lookupSlug("dorm")).toBeNull();
    expect(await dir.lookupHost("ir.dorm.com")).toBeNull();
    expect(await dir.claimSlug({ workspaceId: randomUUID(), slug: "dorm", cellId: "eu-1" })).toBe(
      "taken",
    );
    const other = randomUUID();
    await dir.claimSlug({ workspaceId: other, slug: "dorm-2", cellId: "eu-1" });
    expect(await dir.claimHost({ hostname: "ir.dorm.com", workspaceId: other })).toBe("taken");
    await dir.setState(w, "active");
    expect(await dir.lookupSlug("dorm")).toEqual({ cellId: "eu-1", state: "active" });
    expect(await dir.lookupHost("ir.dorm.com")).toEqual({ cellId: "eu-1" });
  });
});
