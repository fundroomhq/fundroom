import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import {
  createDirectoryRouting,
  createSharedDirectory,
  isSharedDirectory,
} from "@fundroom/directory";
import type { DirectoryPort } from "@fundroom/ports";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryCommand } from "./cli-commands/directory.js";
import type { AppEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { CELL_HEADER, LEGACY_CELL_HEADER, tenantResolution } from "./middleware/tenant.js";
import {
  createDirectoryJobs,
  directoryMigrationPending,
  directoryOwnerKeys,
  JOB_DIRECTORY_HEARTBEAT,
  JOB_DIRECTORY_RECONCILE,
  publishDirectoryCells,
  runDirectoryReconcile,
} from "./residency/directory-jobs.js";
import { type RunningServer, startServer } from "./server.js";
import {
  createCellDatabase,
  createDirectoryDatabase,
  createTestDatabase,
  type TestDatabase,
} from "./test/directory-db.js";

/*
 * E3.11 agent A, end to end with TWO app instances (an EU cell and a US cell, each with its own
 * database and key ring) sharing one directory database:
 *
 *  - tenant resolution (§7): a slug or verified hostname another cell serves is 421 `wrong_cell`
 *    + `X-Fundroom-Cell`; a move's source copy under a `relocation` hold whose entry was switched
 *    is 421 to the target; unknown slugs/hosts stay a plain 404; a directory outage or an
 *    exhausted budget never turns a local tenant or a stranger's 404 into anything else;
 *  - the reconcile sweep (`directory.reconcile`): publishing, entries for local workspaces,
 *    relocation-held workspaces skipped, slug conflicts logged not stolen, stale reservations and
 *    purged workspaces released, verified hostnames re-claimed; the jobs exist in shared mode;
 *  - `fundroom directory status|sync`.
 */

const CANON = "portal.example.com";
const BASE = `https://${CANON}`;

let pg: TestPostgres;
let dirDb: TestDatabase;
let euDb: TestDatabase;
let usDb: TestDatabase;
let eu: RunningServer;
let us: RunningServer;
const ids: Record<string, string> = {};

function envFor(
  db: TestDatabase,
  cell: string,
  region: string,
  jurisdiction: string,
  directoryUrl: string = dirDb.url,
) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: db.url,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      CELL_ID: cell,
      DATA_REGION: region,
      DATA_REGION_JURISDICTION: jurisdiction,
      DIRECTORY_DATABASE_URL: directoryUrl,
      ROLES: "api",
      UPDATE_CHECK: "false",
    },
  });
}

async function request(app: RunningServer, host: string, path = "/api/v1/modules") {
  return app.app.request(`https://${host}${path}`, {
    headers: { host, accept: "application/json" },
  });
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
}

async function host(db: TestDatabase, q: string, params: unknown[] = []) {
  const client = await db.db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    const r = await client.query(q, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function dq(q: string, params: unknown[] = []) {
  return (await dirDb.db.pool.query(q, params)).rows;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  dirDb = await createDirectoryDatabase(pg);
  euDb = await createCellDatabase(pg);
  usDb = await createCellDatabase(pg);
  await euDb.db.pool.query(
    "INSERT INTO core.cell (id, region, jurisdiction, public_origin) VALUES ('eu-1', 'eu', 'eu', 'https://eu.example.com')",
  );
  await usDb.db.pool.query(
    "INSERT INTO core.cell (id, region, jurisdiction, public_origin) VALUES ('us-1', 'us', 'us', 'https://us.example.com')",
  );
  eu = await startServer({
    config: envFor(euDb, "eu-1", "eu", "eu"),
    logger: createLogger({ level: "error" }),
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  us = await startServer({
    config: envFor(usDb, "us-1", "us", "us"),
    logger: createLogger({ level: "error" }),
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  for (const r of [eu, us]) {
    await publishDirectoryCells({
      db: r.container.db,
      directory: r.container.directory,
      keyRing: r.container.config.keyRing,
    });
  }
  // The US cell serves `alpha`, with a verified custom domain.
  ids["alpha"] = (
    await createWorkspace(us.container.db, { slug: "alpha", name: "Alpha", cellId: "us-1" })
  ).id;
  await host(
    usDb,
    `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
     VALUES ($1, 'ir.alpha.com', 'active', 'tok-0123456789abcdef')`,
    [ids["alpha"]],
  );
  // The EU cell serves `local`, and `beta` (a move's source, switched below) and `gamma` (held,
  // no move) under a relocation hold.
  for (const slug of ["local", "beta", "gamma"]) {
    ids[slug] = (await createWorkspace(eu.container.db, { slug, name: slug, cellId: "eu-1" })).id;
  }
  await host(
    euDb,
    "UPDATE core.workspace SET holds = '{relocation}' WHERE slug IN ('beta', 'gamma')",
  );
}, 240_000);

afterAll(async () => {
  await us?.stop();
  await eu?.stop();
  await usDb?.close();
  await euDb?.close();
  await dirDb?.close();
  await pg?.stop();
});

describe("publishing and the reconcile sweep", () => {
  it("publishes both cells with their export keys; each sees the other as remote", async () => {
    const cells = await eu.container.directory.listCells();
    expect(cells.find((c) => c.id === "eu-1")).toMatchObject({ region: "eu", local: true });
    expect(cells.find((c) => c.id === "us-1")).toMatchObject({ region: "us", local: false });
    const keys = cells.map((c) => c.exportPublicKey);
    expect(new Set(keys.filter((k) => k !== null)).size).toBeGreaterThanOrEqual(2);
    expect(eu.container.jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining([JOB_DIRECTORY_HEARTBEAT, JOB_DIRECTORY_RECONCILE]),
    );
  });

  it("creates entries for local workspaces and re-claims verified hostnames", async () => {
    const report = await runDirectoryReconcile({
      db: us.container.db,
      directory: us.container.directory,
      keyRing: us.container.config.keyRing,
    });
    expect(report).toMatchObject({ created: 1, conflicts: 0, hostnamesClaimed: 1 });
    expect(await us.container.directory.lookupSlug("alpha")).toEqual({
      cellId: "us-1",
      state: "active",
    });
    expect(await us.container.directory.lookupHost("ir.alpha.com")).toEqual({ cellId: "us-1" });
    // Idempotent: nothing to repair the second time.
    expect(
      await runDirectoryReconcile({
        db: us.container.db,
        directory: us.container.directory,
        keyRing: us.container.config.keyRing,
      }),
    ).toMatchObject({ created: 0, repaired: 0, hostnamesClaimed: 1 });
  });

  it("skips relocating workspaces, logs slug conflicts, releases stale reservations and purged entries", async () => {
    const d = eu.container.directory;
    // A slug the US cell holds, and a workspace here that uses it (pre-directory duplicate).
    const remote = randomUUID();
    await dq(
      "INSERT INTO directory.workspace (entry_id, workspace_id, slug, cell_id, state) VALUES ($1, $2, 'clash', 'us-1', 'active')",
      [randomUUID(), remote],
    );
    ids["clash"] = (
      await createWorkspace(eu.container.db, { slug: "clash", name: "c", cellId: "eu-1" })
    ).id;
    // A provisioning that died between claim and insert (old), and one in flight (fresh).
    const ghost = randomUUID();
    const fresh = randomUUID();
    await d.claimSlug({ workspaceId: ghost, slug: "ghost", cellId: "eu-1" });
    await d.claimSlug({ workspaceId: fresh, slug: "fresh", cellId: "eu-1" });
    await dq(
      "UPDATE directory.workspace SET created_at = now() - interval '2 hours' WHERE workspace_id = $1",
      [ghost],
    );
    // A workspace that exists, then gets purged without its release hook running.
    ids["gone"] = (
      await createWorkspace(eu.container.db, { slug: "gone", name: "g", cellId: "eu-1" })
    ).id;
    const events: { event: string; fields: Record<string, unknown> | undefined }[] = [];
    const run = () =>
      runDirectoryReconcile({
        db: eu.container.db,
        directory: d,
        keyRing: eu.container.config.keyRing,
        log: (event, fields) => events.push({ event, fields: fields as Record<string, unknown> }),
      });
    const first = await run();
    expect(first).toMatchObject({ conflicts: 1, skippedRelocating: 2, staleReservations: 1 });
    // `local` and `gone` got entries; `clash` did not steal the US slug; beta/gamma untouched.
    expect(await d.lookupSlug("local")).toEqual({ cellId: "eu-1", state: "active" });
    expect(await d.lookupSlug("clash")).toEqual({ cellId: "us-1", state: "active" });
    expect(await d.lookupWorkspace(ids["clash"] ?? "")).toBeNull();
    expect(await d.lookupWorkspace(ids["beta"] ?? "")).toBeNull();
    expect(await d.lookupSlug("ghost")).toBeNull();
    expect(await d.lookupSlug("fresh")).toEqual({ cellId: "eu-1", state: "reserved" });
    const conflict = events.find((e) => e.event === "directory.reconcile_conflict");
    expect(conflict?.fields).toEqual({
      level: "warn",
      workspaceId: ids["clash"],
      reason: "slug_taken",
    });
    // The holder is never named in the log.
    expect(JSON.stringify(events)).not.toContain(remote);

    await host(
      euDb,
      "UPDATE core.workspace SET deleted_at = now(), purge_after = now(), purged_at = now() WHERE id = $1",
      [ids["gone"]],
    );
    const second = await run();
    expect(second).toMatchObject({ released: 1 });
    expect(await d.lookupSlug("gone")).toBeNull();
  });

  it("fundroom directory status|sync", async () => {
    const out: string[] = [];
    const deps = {
      db: eu.container.db,
      directory: eu.container.directory,
      keyRing: eu.container.config.keyRing,
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    expect(await directoryCommand(["status"], deps)).toBe(0);
    expect(out[0]).toBe("mode: shared");
    expect(out.find((l) => l.startsWith("eu-1"))).toMatch(
      /active\s+eu\s+local\s+heartbeat \d+s ago/u,
    );
    expect(out.find((l) => l.startsWith("us-1"))).toMatch(/remote/u);
    out.length = 0;
    // The `clash` conflict is still there: sync reports it and exits 1.
    expect(await directoryCommand(["sync"], deps)).toBe(1);
    expect(out[0]).toMatch(/^published: .*eu-1.*; .*conflicts 1/u);
    expect(await directoryCommand(["nope"], deps)).toBe(2);
  });
});

describe("tenant resolution across cells (421 wrong_cell)", () => {
  it("routes another cell's slug and verified hostname; the owning cell serves them", async () => {
    const bySlug = await request(eu, `alpha.${CANON}`);
    expect(bySlug.status).toBe(421);
    expect(bySlug.headers.get(CELL_HEADER)).toBe("us-1");
    // A-2: the pre-rename spelling rides along for one minor release.
    expect(bySlug.headers.get(LEGACY_CELL_HEADER)).toBe("us-1");
    expect(await errorCode(bySlug)).toBe("wrong_cell");
    const byHost = await request(eu, "ir.alpha.com");
    expect(byHost.status).toBe(421);
    expect(byHost.headers.get(CELL_HEADER)).toBe("us-1");
    expect(byHost.headers.get(LEGACY_CELL_HEADER)).toBe("us-1");
    // Case and port in the Host header do not matter.
    expect((await request(eu, "IR.Alpha.com:443")).status).toBe(421);
    expect((await request(us, `alpha.${CANON}`)).status).toBe(200);
    expect((await request(us, "ir.alpha.com")).status).toBe(200);
    // This cell's own workspaces are served here and 421 from the other cell.
    expect((await request(eu, `local.${CANON}`)).status).toBe(200);
    const fromUs = await request(us, `local.${CANON}`);
    expect(fromUs.status).toBe(421);
    expect(fromUs.headers.get(CELL_HEADER)).toBe("eu-1");
  });

  it("unknown slugs and hosts stay a plain 404, with no cell header", async () => {
    for (const [app, h] of [
      [eu, `nobody.${CANON}`],
      [us, `nobody.${CANON}`],
      [eu, "ir.nobody.com"],
    ] as const) {
      const res = await request(app, h);
      expect(res.status).toBe(404);
      expect(res.headers.get(CELL_HEADER)).toBeNull();
    }
    // A reservation (not yet live) is not routed either.
    expect((await request(eu, `fresh.${CANON}`)).status).toBe(404);
  });

  it("a switched move's source copy (relocation hold) is 421 to the target; a held one without a move is not", async () => {
    const d = eu.container.directory;
    const beta = ids["beta"] ?? "";
    await d.claimSlug({ workspaceId: beta, slug: "beta", cellId: "eu-1" });
    await d.activate(beta);
    const move = await d.moves.request({
      workspaceId: beta,
      slug: "beta",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      requestedBy: "op:test",
      carried: { planId: null, legalName: null, country: null, holds: [] },
    });
    if (typeof move === "string") throw new Error(move);
    await d.moves.transition(move.id, { from: ["requested"], to: "exporting" });
    await d.moves.transition(move.id, { from: ["exporting"], to: "exported" });
    // The target imported it under a new id (done by the US cell's own directory instance).
    const target = randomUUID();
    await us.container.directory.moves.transition(move.id, {
      from: ["exported"],
      to: "imported",
      patch: { targetWorkspaceId: target },
    });
    await d.moves.acquireLease(move.id, "eu-src", 60_000, ["imported"]);
    expect(await d.moves.switchover(move.id, "eu-src")).toMatchObject({ state: "switched" });

    const res = await request(eu, `beta.${CANON}`);
    expect(res.status).toBe(421);
    expect(res.headers.get(CELL_HEADER)).toBe("us-1");
    // gamma is held with no move: the hold's own answers (the bootstrap still serves), not a 421.
    const gamma = await request(eu, `gamma.${CANON}`);
    expect(gamma.status).toBe(200);
    expect(gamma.headers.get(CELL_HEADER)).toBeNull();
  });
});

describe("the directory never breaks local tenants", () => {
  function appWith(directory: DirectoryPort) {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      tenantResolution({
        resolver: eu.container.resolver,
        classify: { mode: "multi", canonicalHost: CANON, basePath: "" },
        trustProxy: false,
        cell: { enabled: true, cellId: "eu-1" },
        directory,
      }),
    );
    app.get("*", (c) => c.json({ slug: c.get("workspace")?.slug ?? null }));
    return app;
  }
  const get = (app: Hono<AppEnv>, h: string) =>
    app.request(`https://${h}/api/v1/x`, { headers: { host: h, accept: "application/json" } });

  it("a directory outage: local tenants are served without asking, misses are 404 (never 503)", async () => {
    let calls = 0;
    const broken: DirectoryPort = {
      ...eu.container.directory,
      mode: "shared",
      lookupSlug: async () => {
        calls += 1;
        throw new Error("directory down");
      },
      lookupHost: async () => {
        calls += 1;
        throw new Error("directory down");
      },
      lookupWorkspace: async () => {
        calls += 1;
        throw new Error("directory down");
      },
    };
    const app = appWith(broken);
    const local = await get(app, `local.${CANON}`);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ slug: "local" });
    expect(calls).toBe(0);
    expect((await get(app, `alpha.${CANON}`)).status).toBe(404);
    expect((await get(app, "ir.alpha.com")).status).toBe(404);
    expect(calls).toBe(1); // then backed off
  });

  it("over the lookup budget a remote slug is a plain 404 (no 429, no oracle)", async () => {
    let calls = 0;
    const d = eu.container.directory;
    const counting: DirectoryPort = {
      ...d,
      lookupSlug: (slug) => {
        calls += 1;
        return d.lookupSlug(slug);
      },
    };
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      tenantResolution({
        resolver: eu.container.resolver,
        classify: { mode: "multi", canonicalHost: CANON, basePath: "" },
        trustProxy: false,
        cell: { enabled: true, cellId: "eu-1" },
        directory: counting,
        directoryRouting: createDirectoryRouting({ directory: counting, budget: 1, now: () => 0 }),
      }),
    );
    app.get("*", (c) => c.json({ slug: c.get("workspace")?.slug ?? null }));
    expect((await get(app, `alpha.${CANON}`)).status).toBe(421);
    const over = await get(app, `beta-nope.${CANON}`);
    expect(over.status).toBe(404);
    expect(await errorCode(over)).toBe("workspace_not_found");
    expect(calls).toBe(1);
    // `alpha` is cached: still routed without spending budget.
    expect((await get(app, `alpha.${CANON}`)).status).toBe(421);
    expect(calls).toBe(1);
  });

  it("local mode (no directory database) never consults anything", async () => {
    const app = appWith({ ...eu.container.directory, mode: "local" });
    expect((await get(app, `alpha.${CANON}`)).status).toBe(404);
  });
});

describe("fix round 1 (R2-3/4/5/10): the sweep's evidence rules", () => {
  const sweep = (r: RunningServer) =>
    runDirectoryReconcile({
      db: r.container.db,
      directory: r.container.directory,
      keyRing: r.container.config.keyRing,
    });

  it("R2-3: a soft-deleted workspace holds its slug and hostname but is not routed (same 404 as never-existed)", async () => {
    const id = (
      await createWorkspace(eu.container.db, { slug: "sleepy", name: "s", cellId: "eu-1" })
    ).id;
    await host(
      euDb,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
       VALUES ($1, 'ir.sleepy.com', 'active', 'tok-sleepy-0123456789')`,
      [id],
    );
    await sweep(eu);
    expect(await us.container.directory.lookupSlug("sleepy")).toEqual({
      cellId: "eu-1",
      state: "active",
    });
    // Soft delete (B's hook would call setState(ws, "dormant"); the sweep repairs it too).
    await host(
      euDb,
      "UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [id],
    );
    await sweep(eu);
    const d = us.container.directory;
    expect(await d.lookupSlug("sleepy")).toBeNull();
    expect(await d.lookupHost("ir.sleepy.com")).toBeNull();
    expect(await eu.container.directory.lookupWorkspace(id)).toMatchObject({ state: "dormant" });
    // Not routable from another cell: indistinguishable from a slug that never existed …
    for (const h of [`sleepy.${CANON}`, "ir.sleepy.com"]) {
      const res = await request(us, h);
      expect(res.status).toBe(404);
      expect(res.headers.get(CELL_HEADER)).toBeNull();
    }
    const fresh = createDirectoryRouting({ directory: us.container.directory });
    expect(await fresh.slug("sleepy")).toBeNull();
    expect(await fresh.host("ir.sleepy.com")).toBeNull();
    // … but still held: nobody else can claim the slug or the hostname.
    expect(await d.claimSlug({ workspaceId: randomUUID(), slug: "sleepy", cellId: "us-1" })).toBe(
      "taken",
    );
    // Restore: routed again.
    await eu.container.directory.setState(id, "active");
    expect(await d.lookupSlug("sleepy")).toEqual({ cellId: "eu-1", state: "active" });
    expect(await d.lookupHost("ir.sleepy.com")).toEqual({ cellId: "eu-1" });
  });

  it("R2-4: directory hostnames of local workspaces that are no longer verified here are released", async () => {
    const id = (
      await createWorkspace(eu.container.db, { slug: "stale-host", name: "s", cellId: "eu-1" })
    ).id;
    await sweep(eu);
    await host(
      euDb,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
       VALUES ($1, 'ir.stale-host.com', 'active', 'tok-stale-0123456789')`,
      [id],
    );
    await sweep(eu);
    expect(await us.container.directory.lookupHost("ir.stale-host.com")).toEqual({
      cellId: "eu-1",
    });
    // Demoted locally; the best-effort release hook missed it.
    await host(
      euDb,
      "UPDATE core.custom_domain SET status = 'pending' WHERE hostname = 'ir.stale-host.com'",
    );
    const report = await sweep(eu);
    expect(report?.hostnamesReleased).toBe(1);
    expect(await us.container.directory.lookupHost("ir.stale-host.com")).toBeNull();
    expect(await us.container.directory.lookupHost("ir.alpha.com")).toEqual({ cellId: "us-1" });
  });

  it("R2-5: a live workspace takes its slug over from a local soft-deleted one", async () => {
    const d = eu.container.directory;
    // A pre-directory install: a soft-deleted `dupe` holds the entry, a live `dupe` has none.
    const dead = randomUUID();
    const live = randomUUID();
    await host(
      euDb,
      `INSERT INTO core.workspace (id, slug, name, cell_id, deleted_at, purge_after)
       VALUES ($1, 'dupe', 'old', 'eu-1', now(), now() + interval '30 days')`,
      [dead],
    );
    await d.claimSlug({ workspaceId: dead, slug: "dupe", cellId: "eu-1" });
    await d.activate(dead);
    await createWorkspace(eu.container.db, { id: live, slug: "dupe", name: "new", cellId: "eu-1" });
    await sweep(eu);
    expect(await d.lookupWorkspace(live)).toMatchObject({ cellId: "eu-1", state: "active" });
    expect(await d.lookupSlug("dupe")).toEqual({ cellId: "eu-1", state: "active" });
    expect(await d.lookupWorkspace(dead)).toMatchObject({ state: "deleted" });
    // A remote holder is never displaced (the `clash` case above still conflicts).
    expect(await d.lookupSlug("clash")).toEqual({ cellId: "us-1", state: "active" });
  });

  it("R2-10: the sweep re-checks the local row inside its write and never revives a released entry", async () => {
    const d = eu.container.directory;
    if (!isSharedDirectory(d)) throw new Error("shared expected");
    const id = (
      await createWorkspace(eu.container.db, { slug: "racer", name: "r", cellId: "eu-1" })
    ).id;
    // The local facts changed after the sweep read them: nothing is written.
    expect(
      await d.ensureEntry({
        workspaceId: id,
        slug: "racer",
        cellId: "eu-1",
        localCellIds: ["eu-1"],
        confirm: async () => false,
      }),
    ).toBe("stale");
    expect(await d.lookupWorkspace(id)).toBeNull();
    // Released by the purge hook between the sweep's read and its write: stays released.
    await d.claimSlug({ workspaceId: id, slug: "racer", cellId: "eu-1" });
    await d.release(id);
    expect(
      await d.ensureEntry({
        workspaceId: id,
        slug: "racer",
        cellId: "eu-1",
        localCellIds: ["eu-1"],
      }),
    ).toBe("released");
    expect(await d.lookupSlug("racer")).toBeNull();
  });
});

describe("fix round 1 (R2-2): a directory outage never stops a cell from booting", () => {
  it("boots with an unreachable directory, serves its own tenants, and leaves the migration pending", async () => {
    const lone = await createCellDatabase(pg);
    await lone.db.pool.query(
      "INSERT INTO core.cell (id, region, jurisdiction) VALUES ('eu-9', 'eu', 'eu')",
    );
    // Nothing listens on port 1.
    const cfg = envFor(lone, "eu-9", "eu", "eu", "postgres://u:p@127.0.0.1:1/directory");
    const started = Date.now();
    const r = await startServer({
      config: cfg,
      logger: createLogger({ level: "error" }),
      listenEnabled: false,
      migrate: true,
      announceSetup: false,
    });
    try {
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(directoryMigrationPending()).toBe(true);
      await createWorkspace(r.container.db, { slug: "island", name: "i", cellId: "eu-9" });
      expect((await request(r, `island.${CANON}`)).status).toBe(200);
      expect((await request(r, `nowhere.${CANON}`)).status).toBe(404);
    } finally {
      await r.stop();
      await lone.close();
    }
  }, 120_000);
});

describe("fix round 2", () => {
  it("RR1-3: every heartbeat applies the directory migrations, in any process (no boot state needed)", async () => {
    const empty = await createTestDatabase(pg, { prefix: "seedhost_dir_late" });
    const late = createSharedDirectory({
      url: empty.url,
      poolMax: 2,
      db: eu.container.db,
      cellId: "eu-1",
      ownerKeys: directoryOwnerKeys(eu.container.config.keyRing),
    });
    try {
      const heartbeat = createDirectoryJobs({
        db: eu.container.db,
        directory: late,
        keyRing: eu.container.config.keyRing,
        directoryUrl: empty.url,
      }).find((j) => j.name === JOB_DIRECTORY_HEARTBEAT);
      await heartbeat?.handler({
        id: "j1",
        name: JOB_DIRECTORY_HEARTBEAT,
        data: {},
        signal: new AbortController().signal,
      });
      expect((await late.listCells()).map((c) => c.id)).toContain("eu-1");
      // Idempotent on the next tick.
      await heartbeat?.handler({
        id: "j2",
        name: JOB_DIRECTORY_HEARTBEAT,
        data: {},
        signal: new AbortController().signal,
      });
    } finally {
      await late.close();
      await empty.close();
    }
  });

  it("RR1-4: a hostname a move carried stays claimed while the copy re-verifies, and is pruned once it fails", async () => {
    const src = randomUUID();
    const d = eu.container.directory;
    await d.claimSlug({ workspaceId: src, slug: "carried", cellId: "eu-1" });
    await d.activate(src);
    await d.claimHost({ hostname: "ir.carried.com", workspaceId: src });
    const copy = (
      await createWorkspace(us.container.db, { slug: "carried", name: "c", cellId: "us-1" })
    ).id;
    const move = await d.moves.request({
      workspaceId: src,
      slug: "carried",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      requestedBy: "op:test",
      carried: { planId: null, legalName: null, country: null, holds: [] },
    });
    if (typeof move === "string") throw new Error(move);
    await d.moves.transition(move.id, { from: ["requested"], to: "exporting" });
    await d.moves.transition(move.id, { from: ["exporting"], to: "exported" });
    await d.moves.transition(move.id, {
      from: ["exported"],
      to: "imported",
      patch: { targetWorkspaceId: copy },
    });
    await d.moves.acquireLease(move.id, "src", 60_000, ["imported"]);
    await d.moves.switchover(move.id, "src");
    // The copy carries the domain as pending re-verification.
    await host(
      usDb,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
       VALUES ($1, 'ir.carried.com', 'pending', 'tok-carried-0123456789')`,
      [copy],
    );
    const sweep = () =>
      runDirectoryReconcile({
        db: us.container.db,
        directory: us.container.directory,
        keyRing: us.container.config.keyRing,
      });
    await sweep();
    expect(await eu.container.directory.lookupHost("ir.carried.com")).toEqual({ cellId: "us-1" });
    // Re-verification failed: the claim goes.
    await host(
      usDb,
      "UPDATE core.custom_domain SET status = 'failed' WHERE hostname = 'ir.carried.com'",
    );
    expect((await sweep())?.hostnamesReleased).toBe(1);
    expect(await eu.container.directory.lookupHost("ir.carried.com")).toBeNull();

    // RR3-4: only the row the move re-added, and only until switch + the verification deadline.
    const lookup = () => eu.container.directory.lookupHost("ir.carried.com");
    const reclaim = async () => {
      expect(
        await us.container.directory.claimHost({ hostname: "ir.carried.com", workspaceId: copy }),
      ).toBe("claimed");
    };
    const age = (hours: number) =>
      host(
        usDb,
        `UPDATE core.custom_domain SET created_at = now() - make_interval(hours => $1),
           first_attempt_at = now() - make_interval(hours => $1)
         WHERE hostname = 'ir.carried.com' AND deleted_at IS NULL`,
        [hours],
      );
    // The genuine carried row, two hours after a switch: kept.
    await dq("UPDATE directory.move SET switched_at = now() - interval '2 hours' WHERE id = $1", [
      move.id,
    ]);
    await host(
      usDb,
      "UPDATE core.custom_domain SET status = 'pending' WHERE hostname = 'ir.carried.com'",
    );
    await age(2);
    await reclaim();
    await sweep();
    expect(await lookup()).toEqual({ cellId: "us-1" });
    // (a) the tenant reopens the row ("verify now" on a failed row): a fresh first attempt → pruned.
    await host(
      usDb,
      "UPDATE core.custom_domain SET first_attempt_at = now() WHERE hostname = 'ir.carried.com'",
    );
    await sweep();
    expect(await lookup()).toBeNull();
    // (b) remove + re-add: a new row → pruned.
    await age(2);
    await reclaim();
    await sweep();
    expect(await lookup()).toEqual({ cellId: "us-1" });
    await host(
      usDb,
      "UPDATE core.custom_domain SET deleted_at = now() WHERE hostname = 'ir.carried.com'",
    );
    await host(
      usDb,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
       VALUES ($1, 'ir.carried.com', 'pending', 'tok-carried-readd-012345')`,
      [copy],
    );
    await sweep();
    expect(await lookup()).toBeNull();
    // (c) the genuine row past switch + 72 h → pruned.
    await host(
      usDb,
      "DELETE FROM core.custom_domain WHERE hostname = 'ir.carried.com' AND deleted_at IS NULL",
    );
    await host(
      usDb,
      "UPDATE core.custom_domain SET deleted_at = NULL WHERE hostname = 'ir.carried.com'",
    );
    await dq("UPDATE directory.move SET switched_at = now() - interval '73 hours' WHERE id = $1", [
      move.id,
    ]);
    await age(73);
    await reclaim();
    await sweep();
    expect(await lookup()).toBeNull();
  });

  it("RR3-1: a directory schema from a newer release never stops the heartbeat from publishing", async () => {
    await dq(
      `INSERT INTO core.schema_migration (module, name, checksum, duration_ms)
       VALUES ('directory', '9999_from_newer_release', 'x', 1)`,
    );
    const events: string[] = [];
    try {
      await dq(
        "UPDATE directory.cell SET heartbeat_at = now() - interval '1 hour' WHERE id = 'eu-1'",
      );
      const heartbeat = createDirectoryJobs({
        db: eu.container.db,
        directory: eu.container.directory,
        keyRing: eu.container.config.keyRing,
        directoryUrl: dirDb.url,
        log: (e) => events.push(e),
      }).find((j) => j.name === JOB_DIRECTORY_HEARTBEAT);
      await heartbeat?.handler({
        id: "j3",
        name: JOB_DIRECTORY_HEARTBEAT,
        data: {},
        signal: new AbortController().signal,
      });
      const [row] = await dq(
        "SELECT heartbeat_at > now() - interval '1 minute' AS fresh FROM directory.cell WHERE id = 'eu-1'",
      );
      expect(row).toEqual({ fresh: true });
      expect(events).toContain("migrate.directory.schema_newer");
      expect(events).not.toContain("migrate.directory.heartbeat_failed");
    } finally {
      await dq("DELETE FROM core.schema_migration WHERE name = '9999_from_newer_release'");
    }
  });
});
