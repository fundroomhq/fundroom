import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  type MoveEngineDeps,
  MoveError,
  pollMoves,
  requestMove,
  runMoveExport,
  runMoveImport,
  setWorkspaceHold,
} from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID, type Tx } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createLocalDirectory } from "@fundroom/directory";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer } from "@fundroom/mail";
import { exportWorkspace, importWorkspace, PortabilityError } from "@fundroom/portability";
import type { DirectoryMove, DirectoryPort } from "@fundroom/ports";
import { brandingLogoKey } from "@fundroom/storage";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operatorCommand } from "./cli-commands/operator.js";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { runDirectoryReconcile } from "./residency/directory-jobs.js";
import { moveEngineDeps } from "./residency/move-jobs.js";
import { type RunningServer, startServer } from "./server.js";
import {
  createCellDatabase,
  createDirectoryDatabase,
  type TestDatabase,
} from "./test/directory-db.js";

/*
 * Moves between cells end to end (E3.11 §9, agent C) with TWO real cells: two cell databases
 * (eu-1 in region eu, us-1 in region us) and one directory database in the testcontainer
 * Postgres, two S3 buckets on one SeaweedFS, and two in-process servers (CONTROL_PLANE=on,
 * TENANCY_MODE=multi, their own CELL_ID, DATA_REGION, key ring and bucket). The engine's steps
 * are driven by calling `pollMoves` on each cell (the minute job's body, inline), so every
 * transition is deterministic.
 *
 * Proves: the happy path (content, members, legal documents, the logo object, plan, legal name,
 * country, the subscription binding and a custom domain arrive; region/data_region of the target;
 * the directory flipped; the source 421s to the target and is purged; audit rows on both chains
 * of both cells; the bundle URL and key in no response, log or audit row; the bundle object
 * deleted), a sha256 mismatch, a signature by a key other than the source cell's published one,
 * cancel before import, a failed import rolling the source back, a held workspace arriving held
 * (including a hold gained after the export), an erasure recorded during the move refusing the
 * switch, a workspace in deletion refused, move_busy, move_unavailable in local mode, and the
 * plain portability import landing in CELL_ID with its slug claimed in the directory.
 */

const S3_IMAGE = process.env["FUNDROOM_TEST_S3_IMAGE"] ?? "chrislusf/seaweedfs:3.97";
const EU = "eu.example.test";
const US = "us.example.test";
const IN_NET = "10.20.30.40";

let pg: TestPostgres;
let dir: TestDatabase;
let euDb: TestDatabase;
let usDb: TestDatabase;
let seaweed: StartedTestContainer;
let s3Endpoint: string;
let eu: RunningServer;
let us: RunningServer;
let engEu: MoveEngineDeps;
let engUs: MoveEngineDeps;
let operatorUserId: string;
let opCookie: string;
/** Every log line the engines wrote (the bundle URL must never be among them). */
const logged: string[] = [];

function collect(event: string, fields?: Readonly<Record<string, unknown>>): void {
  logged.push(JSON.stringify({ event, ...fields }));
}

function envFor(db: TestDatabase, cell: string, region: "eu" | "us", bucket: string) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: `https://${region === "eu" ? EU : US}`,
      DATABASE_URL: db.url,
      DATABASE_POOL_MAX: process.env["FUNDROOM_TEST_POOL_MAX"] ?? "6",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_DRIVER: "s3",
      S3_BUCKET: bucket,
      S3_ENDPOINT: s3Endpoint,
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "fundroom",
      S3_SECRET_ACCESS_KEY: "fundroom",
      S3_FORCE_PATH_STYLE: "true",
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      CELL_ID: cell,
      DATA_REGION: region,
      DATA_REGION_LABEL:
        region === "eu" ? "European Union (Frankfurt)" : "United States (Virginia)",
      DATA_REGION_JURISDICTION: region,
      DIRECTORY_DATABASE_URL: dir.url,
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "localhost,127.0.0.1",
      MOVE_SOURCE_RETENTION_HOURS: "0",
      PLATFORM_OPERATOR_CIDRS: "10.0.0.0/8",
      TRUST_PROXY: "true",
      ROLES: "api,web",
      UPDATE_CHECK: "false",
    },
  });
}

async function hostQuery<T = Record<string, unknown>>(
  db: TestDatabase,
  q: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await db.db.pool.query(q, params)).rows as T[];
}

/** A statement as the host actor (the control-plane guard admits only host/system writers). */
async function asHost<T = Record<string, unknown>>(
  db: TestDatabase,
  q: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await db.db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    const r = await client.query(q, params);
    await client.query("COMMIT");
    return r.rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function dq<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
  return (await dir.db.pool.query(q, params)).rows as T[];
}

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
  app: RunningServer = eu,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  headers.set("x-forwarded-for", IN_NET);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return app.app.request(`https://${host}${path}`, { ...init, headers });
}

const op = (path: string, init: Parameters<typeof request>[2] = {}) =>
  request(EU, `/api/v1/platform${path}`, { cookie: opCookie, ...init });

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.clone().json()) as { error: Record<string, unknown> }).error;
}

async function s3Keys(bucket: string, prefix: string): Promise<string[]> {
  const res = await fetch(
    `${s3Endpoint}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`,
  );
  const text = await res.text();
  return [...text.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((m) => m[1] as string);
}

/** A workspace on the EU cell with an owner and an investor, registered in the directory. */
async function euWorkspace(slug: string): Promise<string> {
  const ws = await createWorkspace(eu.container.db, { slug, name: `${slug} Inc`, cellId: "eu-1" });
  const deps = eu.container.identityDeps;
  for (const [email, kind, role] of [
    [`owner@${slug}.test`, "staff", "owner"],
    [`investor@${slug}.test`, "external", "investor"],
  ] as const) {
    const u = await provisionUser(deps, { email, displayName: email.split("@")[0] });
    await provisionMembership(deps, {
      workspaceId: ws.id,
      userId: u.userId,
      kind,
      role,
      source: "test",
    });
  }
  await reconcile();
  return ws.id;
}

async function reconcile(): Promise<void> {
  for (const r of [eu, us]) {
    await runDirectoryReconcile({
      db: r.container.db,
      directory: r.container.directory,
      keyRing: r.container.config.keyRing,
    });
  }
}

const operator = () => ({ kind: "operator", userId: operatorUserId }) as const;

async function move(id: string): Promise<DirectoryMove> {
  const m = await eu.container.directory.moves.get(id);
  if (m === null) throw new Error(`no move ${id}`);
  return m;
}

/** Polls both cells until the move reaches one of `states` (or gives up). */
async function drive(id: string, states: DirectoryMove["state"][], rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    const m = await move(id);
    if (states.includes(m.state)) return m;
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
  }
  return move(id);
}

async function wsRow(db: TestDatabase, slugOrId: string) {
  const [row] = await hostQuery<{
    id: string;
    slug: string;
    cell_id: string;
    data_region: string | null;
    holds: string[];
    status: string;
    suspended_reason: string | null;
    plan_id: string | null;
    legal_name: string | null;
    country: string | null;
    deleted_at: Date | null;
    purged_at: Date | null;
  }>(
    db,
    `SELECT id::text, slug, cell_id, data_region, holds, status, suspended_reason, plan_id,
            legal_name, country, deleted_at, purged_at
       FROM core.workspace WHERE ${slugOrId.includes("-") && slugOrId.length === 36 ? "id = $1::uuid" : "slug = $1"}
      ORDER BY created_at DESC LIMIT 1`,
    [slugOrId],
  );
  return row;
}

async function liveCopies(slug: string) {
  return hostQuery<{ id: string }>(
    usDb,
    `SELECT id::text FROM core.workspace WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
}

async function actions(db: TestDatabase, workspaceId: string, like = "workspace.move_%") {
  return (
    await hostQuery<{ action: string; meta: Record<string, unknown> }>(
      db,
      `SELECT action, meta FROM audit.event WHERE workspace_id = $1 AND action LIKE $2 ORDER BY seq`,
      [workspaceId, like],
    )
  ).map((r) => r.action);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  seaweed = await new GenericContainer(S3_IMAGE)
    .withExposedPorts(8333)
    .withCommand([
      "server",
      "-s3",
      "-dir=/data",
      "-ip.bind=0.0.0.0",
      "-master.volumeSizeLimitMB=64",
      "-volume.max=8",
    ])
    .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/u))
    .withStartupTimeout(120_000)
    .start();
  s3Endpoint = `http://${seaweed.getHost()}:${seaweed.getMappedPort(8333)}`;
  for (const bucket of ["cell-eu", "cell-us"]) {
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${s3Endpoint}/${bucket}`, { method: "PUT" }).catch(() => undefined);
      if (res !== undefined && (res.ok || res.status === 409)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  dir = await createDirectoryDatabase(pg);
  euDb = await createCellDatabase(pg);
  usDb = await createCellDatabase(pg);
  await euDb.db.pool.query(
    `INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-1', 'eu', 'https://${EU}');
     INSERT INTO core.plan (id, name, limits) VALUES ('starter', 'Starter', '{}'), ('pro', 'Pro', '{}');`,
  );
  // The US cell knows `starter` but not `pro` (plans are per database).
  await usDb.db.pool.query(
    `INSERT INTO core.cell (id, region, public_origin) VALUES ('us-1', 'us', 'https://${US}');
     INSERT INTO core.plan (id, name, limits) VALUES ('starter', 'Starter', '{}');`,
  );
  const mailer = createMemoryMailer();
  eu = await startServer({
    config: envFor(euDb, "eu-1", "eu", "cell-eu"),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  us = await startServer({
    config: envFor(usDb, "us-1", "us", "cell-us"),
    logger: createLogger({ level: "error" }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  for (const r of [eu, us]) {
    Object.assign(r.container.sanctions, { hooks: {} });
    Object.assign(r.container.billing, { hooks: {} });
  }
  await reconcile();
  engEu = { ...moveEngineDeps({ ...eu.container, log: collect }), heartbeatMs: 200 };
  engUs = { ...moveEngineDeps({ ...us.container, log: collect }), heartbeatMs: 200 };

  // An operator on the EU cell.
  const opUser = await provisionUser(eu.container.identityDeps, { email: "ops@platform.test" });
  operatorUserId = opUser.userId;
  await hostQuery(
    euDb,
    `INSERT INTO core.credential (user_id, kind, secret, confirmed_at, created_at)
       VALUES ($1, 'totp', 'sealed', now() - interval '1 day', now() - interval '1 day')`,
    [opUser.userId],
  );
  const granted = await operatorCommand(["grant", "ops@platform.test"], {
    db: eu.container.db,
    audit: eu.container.audit,
    osUser: "tester",
    out: () => {},
    err: () => {},
  });
  expect(granted).toBe(0);
}, 300_000);

beforeEach(async () => {
  const s = await eu.container.auth.sessions.startSession({
    userId: operatorUserId,
    population: "staff",
    context: "first_party",
    authLevel: 2,
  });
  await hostQuery(
    euDb,
    `UPDATE core.credential SET last_used_at = now() WHERE user_id = $1 AND kind = 'totp'`,
    [operatorUserId],
  );
  const minted = await request(EU, "/api/v1/platform/session", {
    method: "POST",
    cookie: `__Host-sid=${s.token}`,
  });
  expect(minted.status).toBe(200);
  const line = minted.headers.getSetCookie().find((c) => c.startsWith("__Host-op_sid="));
  opCookie = (line as string).split(";")[0] as string;
});

afterAll(async () => {
  await us?.stop();
  await eu?.stop();
  await usDb?.close();
  await euDb?.close();
  await dir?.close();
  await seaweed?.stop();
  await pg?.stop();
});

describe("the cells", () => {
  it("both published their region and export key; each sees the other as remote", async () => {
    const cells = await eu.container.directory.listCells();
    expect(cells.find((c) => c.id === "eu-1")).toMatchObject({ region: "eu", local: true });
    const usCell = cells.find((c) => c.id === "us-1");
    expect(usCell).toMatchObject({ region: "us", local: false, status: "active" });
    expect(usCell?.exportPublicKey).toBeTruthy();
    expect(usCell?.heartbeatAt).toBeInstanceOf(Date);
  });
});

describe("the happy path", () => {
  let sourceId: string;
  let moveId: string;
  let before: { members: number; legal: number };
  let logoSha: string;
  /** Captured while the move is live: the switch retires both from the directory row (R1-7). */
  let bundleUrl: string;
  let transferKey: string;

  it("requests the move: 202 without the URL, the source held and the entry moving", async () => {
    const seeded = await seedDemo(eu.container, { slug: "acme", investors: 3 });
    sourceId = seeded.workspaceId;
    // A logo object (a blob the move must carry), the control-plane facts and a billing binding.
    const logo = randomBytes(64);
    logoSha = createHash("sha256").update(logo).digest("hex");
    await eu.container.storage.put(brandingLogoKey(sourceId, logoSha), logo, {
      contentType: "image/png",
    });
    await asHost(
      euDb,
      `UPDATE core.workspace SET plan_id = 'starter', legal_name = 'Acme Holdings GmbH', country = 'DE',
              settings = jsonb_set(settings, '{branding}', coalesce(settings -> 'branding', '{}'::jsonb)
                || jsonb_build_object('logo', jsonb_build_object('key', $2::text, 'contentType', 'image/png',
                   'width', 1, 'height', 1, 'bytes', 64, 'sha256', $3::text, 'source', 'upload')))
        WHERE id = $1`,
      [sourceId, brandingLogoKey(sourceId, logoSha), logoSha],
    );
    await asHost(
      euDb,
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id, provider_subscription_id)
         VALUES ($1, 'starter', 'stripe', 'active', 'cus_acme', 'sub_acme')`,
      [sourceId],
    );
    await asHost(
      euDb,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token)
         VALUES ($1, 'ir.acme-corp.com', 'active', 'tok-0123456789abcdef')`,
      [sourceId],
    );
    before = {
      members: Number(
        (
          await hostQuery<{ n: number }>(
            euDb,
            `SELECT count(*)::int AS n FROM core.membership WHERE workspace_id = $1`,
            [sourceId],
          )
        )[0]?.n,
      ),
      legal: Number(
        (
          await hostQuery<{ n: number }>(
            euDb,
            `SELECT count(*)::int AS n FROM core.legal_document WHERE workspace_id = $1`,
            [sourceId],
          )
        )[0]?.n,
      ),
    };
    expect(before.members).toBeGreaterThanOrEqual(4);

    const mismatch = await op(`/workspaces/${sourceId}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "acme-typo" }),
    });
    expect(mismatch.status).toBe(400);
    expect(await errorOf(mismatch)).toMatchObject({
      code: "validation_failed",
      reason: "confirmation_mismatch",
    });

    const res = await op(`/workspaces/${sourceId}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "acme" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspaceId: sourceId,
      slug: "acme",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      sourceRegion: "eu",
      targetRegion: "us",
      state: "requested",
      error: null,
    });
    moveId = body["id"] as string;
    expect(Object.keys(body).sort()).toEqual(
      [
        "createdAt",
        "error",
        "id",
        "slug",
        "sourceCellId",
        "sourceRegion",
        "state",
        "targetCellId",
        "targetRegion",
        "updatedAt",
        "workspaceId",
      ].sort(),
    );
    expect((await wsRow(euDb, sourceId))?.holds).toEqual(["relocation"]);
    expect(await eu.container.directory.lookupWorkspace(sourceId)).toMatchObject({
      cellId: "eu-1",
      state: "moving",
    });

    const again = await op(`/workspaces/${sourceId}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "acme" }),
    });
    expect(again.status).toBe(409);
    expect((await errorOf(again))["code"]).toBe("move_busy");

    const listed = await op(`/moves?workspaceId=${sourceId}`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((m) => m.id)).toEqual([
      moveId,
    ]);
  });

  it("exports (a presigned, encrypted bundle), imports under relocation, switches and goes live", async () => {
    await pollMoves(engEu, { inline: true });
    const exported = await move(moveId);
    expect(exported.state).toBe("exported");
    expect(exported.bundle?.url).toContain("X-Amz-");
    bundleUrl = exported.bundle?.url as string;
    transferKey = (exported.carried as { transferKey?: string }).transferKey as string;
    expect(transferKey.length).toBeGreaterThan(20);
    const objects = await s3Keys("cell-eu", `ws/${sourceId}/moves/`);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatch(
      new RegExp(`^ws/${sourceId}/moves/${moveId}/[0-9a-f-]{36}\\.bin$`, "u"),
    );
    // Not yet public anywhere: the GET view has no bundle.
    const view = await op(`/moves?workspaceId=${sourceId}`);
    expect(await view.text()).not.toContain("X-Amz-");

    await pollMoves(engUs, { inline: true });
    const imported = await move(moveId);
    expect(imported.state).toBe("imported");
    const copyId = imported.targetWorkspaceId as string;
    const copy = await wsRow(usDb, copyId);
    expect(copy).toMatchObject({
      slug: "acme",
      cell_id: "us-1",
      data_region: "us",
      holds: ["relocation"],
    });

    await pollMoves(engEu, { inline: true });
    const switched = await move(moveId);
    expect(["switched", "retired"]).toContain(switched.state);
    expect(
      await dq(
        `SELECT cell_id, state, workspace_id::text FROM directory.workspace WHERE slug = 'acme' AND state <> 'deleted'`,
      ),
    ).toEqual([{ cell_id: "us-1", state: "active", workspace_id: copyId }]);
    const src = await wsRow(euDb, sourceId);
    expect(src?.deleted_at).not.toBeNull();
    expect(
      await hostQuery(euDb, `SELECT 1 FROM core.subscription WHERE workspace_id = $1`, [sourceId]),
    ).toEqual([]);
    expect(await s3Keys("cell-eu", `ws/${sourceId}/moves/`)).toEqual([]);

    await pollMoves(engUs, { inline: true });
    const live = await wsRow(usDb, copyId);
    expect(live).toMatchObject({
      holds: [],
      status: "active",
      cell_id: "us-1",
      data_region: "us",
      plan_id: "starter",
      legal_name: "Acme Holdings GmbH",
      country: "DE",
    });
    // Content and people arrived.
    const [members] = await hostQuery<{ n: number }>(
      usDb,
      `SELECT count(*)::int AS n FROM core.membership WHERE workspace_id = $1`,
      [copyId],
    );
    expect(members?.n).toBe(before.members);
    const [legal] = await hostQuery<{ n: number }>(
      usDb,
      `SELECT count(*)::int AS n FROM core.legal_document WHERE workspace_id = $1`,
      [copyId],
    );
    expect(legal?.n).toBe(before.legal);
    expect(await s3Keys("cell-us", `ws/${copyId}/branding/`)).toEqual([
      brandingLogoKey(copyId, logoSha),
    ]);
    // The billing binding moved with it; the custom domain came back pending re-verification.
    expect(
      await hostQuery(
        usDb,
        `SELECT plan_id, provider, status, provider_customer_id, provider_subscription_id FROM core.subscription WHERE workspace_id = $1`,
        [copyId],
      ),
    ).toEqual([
      {
        plan_id: "starter",
        provider: "stripe",
        status: "active",
        provider_customer_id: "cus_acme",
        provider_subscription_id: "sub_acme",
      },
    ]);
    expect(
      await hostQuery(
        usDb,
        `SELECT hostname::text, status::text FROM core.custom_domain WHERE workspace_id = $1 AND deleted_at IS NULL`,
        [copyId],
      ),
    ).toEqual([{ hostname: "ir.acme-corp.com", status: "pending" }]);
    // No credential travelled: the members' accounts on the US cell have no sessions.
    const [sessions] = await hostQuery<{ n: number }>(
      usDb,
      `SELECT count(*)::int AS n FROM core.session s JOIN core.membership m ON m.user_id = s.user_id WHERE m.workspace_id = $1`,
      [copyId],
    );
    expect(sessions?.n).toBe(0);

    // The source cell sends the slug to the target; the target serves it.
    const fromEu = await request(`acme.${EU}`, "/api/v1/modules");
    expect(fromEu.status).toBe(421);
    expect(fromEu.headers.get("x-fundroom-cell")).toBe("us-1");
    const fromUs = await request(`acme.${US}`, "/api/v1/modules", {}, us);
    expect(fromUs.status).not.toBe(421);
    expect(fromUs.status).not.toBe(404);
  });

  it("retires once the source copy is purged, and audits every step on both chains of both cells", async () => {
    const done = await drive(moveId, ["retired"]);
    expect(done.state).toBe("retired");
    expect((await wsRow(euDb, sourceId))?.purged_at).not.toBeNull();
    const copyId = done.targetWorkspaceId as string;

    expect(await actions(euDb, sourceId)).toEqual([
      "workspace.move_request",
      "workspace.move_export",
      "workspace.move_switch",
    ]);
    const euPlatform = await hostQuery<{ action: string; meta: Record<string, unknown> }>(
      euDb,
      `SELECT action, meta FROM audit.event WHERE workspace_id = $1 AND action LIKE 'workspace.move_%'
        AND meta ->> 'moveId' = $2 ORDER BY seq`,
      [PLATFORM_WORKSPACE_ID, moveId],
    );
    expect(euPlatform.map((r) => r.action)).toEqual([
      "workspace.move_request",
      "workspace.move_export",
      "workspace.move_switch",
      "workspace.move_retire",
    ]);
    expect(await actions(usDb, copyId)).toEqual(["workspace.move_import", "workspace.move_switch"]);
    const usPlatform = await hostQuery<{ action: string }>(
      usDb,
      `SELECT action FROM audit.event WHERE workspace_id = $1 AND meta ->> 'moveId' = $2 AND action LIKE 'workspace.move_%' ORDER BY seq`,
      [PLATFORM_WORKSPACE_ID, moveId],
    );
    expect(usPlatform.map((r) => r.action)).toEqual([
      "workspace.move_import",
      "workspace.move_switch",
    ]);
    // The tenant sees the hold go and come on its own chain (relocation on / off).
    expect(await actions(usDb, copyId, "workspace.%suspend")).toEqual(["workspace.unsuspend"]);

    // The switch retired the secrets from the directory row (R1-7).
    expect(
      await dq(
        `SELECT bundle, carried ? 'transferKey' AS has_key FROM directory.move WHERE id = $1`,
        [moveId],
      ),
    ).toEqual([{ bundle: null, has_key: false }]);
    // The bundle URL and the transfer key: in no audit row, log line or response.
    const url = bundleUrl;
    const key = transferKey;
    const signature = new URL(url).searchParams.get("X-Amz-Signature") as string;
    expect(signature.length).toBeGreaterThan(10);
    for (const db of [euDb, usDb]) {
      const [hits] = await hostQuery<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM audit.event WHERE meta::text LIKE $1 OR meta::text LIKE $2`,
        [`%${signature}%`, `%${key}%`],
      );
      expect(hits?.n).toBe(0);
    }
    expect(logged.join("\n")).not.toContain(signature);
    expect(logged.join("\n")).not.toContain(key);
    const list = await op("/moves");
    const text = await list.text();
    expect(text).not.toContain(signature);
    expect(text).not.toContain(key);
  });
});

describe("a held workspace", () => {
  it("arrives held, including a hold the source gained after the export", async () => {
    const id = await euWorkspace("held");
    await eu.container.db.withHost(async (tx) => {
      for (const hold of ["billing", "sanctions"] as const) {
        await setWorkspaceHold(
          tx as Tx,
          { workspaceId: id, hold, on: true, actor: { kind: "system", source: "billing" } },
          { audit: eu.container.audit, invalidate: () => {} },
        );
      }
    });
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: "held",
      actor: operator(),
      requestedBy: "op:test",
    });
    await pollMoves(engEu, { inline: true });
    expect((await move(m.id)).state).toBe("exported");
    // An operator suspends the source after the export: the switch carries it too.
    await eu.container.db.withHost((tx) =>
      setWorkspaceHold(
        tx as Tx,
        { workspaceId: id, hold: "operator", on: true, actor: operator() },
        { audit: eu.container.audit, invalidate: () => {} },
      ),
    );
    await pollMoves(engUs, { inline: true });
    const imported = await move(m.id);
    expect((await wsRow(usDb, imported.targetWorkspaceId as string))?.holds).toEqual([
      "billing",
      "relocation",
      "sanctions",
    ]);
    const done = await drive(m.id, ["retired"]);
    const copy = await wsRow(usDb, done.targetWorkspaceId as string);
    expect(copy).toMatchObject({
      holds: ["billing", "operator", "sanctions"],
      status: "suspended",
      suspended_reason: "sanctions",
    });
  });
});

describe("failures", () => {
  async function started(slug: string): Promise<{ id: string; moveId: string }> {
    const id = await euWorkspace(slug);
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: slug,
      actor: operator(),
      requestedBy: "op:test",
    });
    await pollMoves(engEu, { inline: true });
    expect((await move(m.id)).state).toBe("exported");
    return { id, moveId: m.id };
  }

  async function rolledBack(id: string, moveId: string, slug: string) {
    await pollMoves(engEu, { inline: true });
    expect((await wsRow(euDb, id))?.holds).toEqual([]);
    expect(await eu.container.directory.lookupWorkspace(id)).toMatchObject({
      cellId: "eu-1",
      state: "active",
    });
    expect(await s3Keys("cell-eu", `ws/${id}/moves/`)).toEqual([]);
    expect(await liveCopies(slug)).toEqual([]);
    expect(await actions(euDb, id)).toContain(
      (await move(moveId)).state === "cancelled" ? "workspace.move_cancel" : "workspace.move_fail",
    );
  }

  it("a sha256 that does not match the bundle fails the move at verify and rolls the source back", async () => {
    const { id, moveId } = await started("shabad");
    await dq(
      `UPDATE directory.move SET bundle = jsonb_set(bundle, '{sha256}', to_jsonb(repeat('0', 64))) WHERE id = $1`,
      [moveId],
    );
    await pollMoves(engUs, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "verify", code: "sha256_mismatch" },
    });
    await rolledBack(id, moveId, "shabad");
  });

  it("a bundle signed by a key other than the source cell's published one is refused", async () => {
    const { id, moveId } = await started("wrongkey");
    const [row] = await dq<{ k: string; ks: unknown }>(
      `SELECT export_public_key AS k, export_public_keys AS ks FROM directory.cell WHERE id = 'eu-1'`,
    );
    try {
      // The directory is the trust root: other published keys (same key ids) make the (valid)
      // signature untrusted — the key embedded in the bundle is never consulted.
      await dq(
        `UPDATE directory.cell SET export_public_key = $1,
                export_public_keys = (SELECT coalesce(jsonb_agg(jsonb_build_object('keyId', e ->> 'keyId', 'publicKey', $1::text)), '[]'::jsonb)
                                        FROM jsonb_array_elements(export_public_keys) e)
          WHERE id = 'eu-1'`,
        [randomBytes(32).toString("base64")],
      );
      await pollMoves(engUs, { inline: true });
    } finally {
      await dq(
        `UPDATE directory.cell SET export_public_key = $1, export_public_keys = $2::jsonb WHERE id = 'eu-1'`,
        [row?.k, JSON.stringify(row?.ks)],
      );
    }
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "verify", code: "signature_invalid" },
    });
    await rolledBack(id, moveId, "wrongkey");
  });

  it("cancel before the import: the source is released at once and the target imports nothing", async () => {
    const { id, moveId } = await started("cancelme");
    const res = await op(`/moves/${moveId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("cancelled");
    expect((await wsRow(euDb, id))?.holds).toEqual([]);
    await pollMoves(engUs, { inline: true });
    expect((await move(moveId)).state).toBe("cancelled");
    await rolledBack(id, moveId, "cancelme");
    const late = await op(`/moves/${moveId}/cancel`, { method: "POST" });
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ code: "conflict", reason: "not_cancellable" });
  });

  it("a failed import (a plan the target does not have) rolls the source back", async () => {
    const id = await euWorkspace("proplan");
    await asHost(euDb, `UPDATE core.workspace SET plan_id = 'pro' WHERE id = $1`, [id]);
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: "proplan",
      actor: operator(),
      requestedBy: "op:test",
    });
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    expect(await move(m.id)).toMatchObject({
      state: "failed",
      error: { stage: "import", code: "plan_unknown" },
    });
    await rolledBack(id, m.id, "proplan");
    expect((await wsRow(euDb, id))?.plan_id).toBe("pro");
  });

  it("an erasure recorded during the move refuses the switch; the target discards its copy", async () => {
    const id = await euWorkspace("erased");
    const [member] = await hostQuery<{ id: string }>(
      euDb,
      `SELECT id::text FROM core.membership WHERE workspace_id = $1 AND kind = 'external'`,
      [id],
    );
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: "erased",
      actor: operator(),
      requestedBy: "op:test",
    });
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    const imported = await move(m.id);
    expect(imported.state).toBe("imported");
    // An erasure lands on the source after the export (as an in-flight request would).
    await asHost(
      euDb,
      `INSERT INTO core.dsar_request (workspace_id, membership_id, due_at, kind)
         VALUES ($1, $2, now() + interval '30 days', 'erasure')`,
      [id, member?.id],
    );
    await pollMoves(engEu, { inline: true });
    expect(await move(m.id)).toMatchObject({
      state: "failed",
      error: { stage: "switch", code: "erasure_during_move" },
    });
    // The directory never pointed at the copy; the target throws it away.
    expect(await eu.container.directory.lookupWorkspace(id)).toMatchObject({ cellId: "eu-1" });
    await pollMoves(engUs, { inline: true });
    expect((await wsRow(usDb, imported.targetWorkspaceId as string))?.deleted_at).not.toBeNull();
    expect(await liveCopies("erased")).toEqual([]);
    expect((await wsRow(euDb, id))?.holds).toEqual([]);

    // And while the erasure is open, a new move is refused outright.
    const again = await op(`/workspaces/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "erased" }),
    });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({
      code: "move_unavailable",
      reason: "erasure_open",
    });
  });
});

describe("crash repair (the poll finishes what a dead worker started)", () => {
  async function requested(slug: string) {
    const id = await euWorkspace(slug);
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: slug,
      actor: operator(),
      requestedBy: "op:test",
    });
    return { id, moveId: m.id };
  }
  const expireLease = (moveId: string) =>
    dq(`UPDATE directory.move SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
      moveId,
    ]);

  it("an export whose worker died mid-way is run again once its lease expires", async () => {
    const { moveId } = await requested("deadexport");
    const moves = eu.container.directory.moves;
    expect(await moves.acquireLease(moveId, "eu-1:dead", 60_000, ["requested"])).not.toBeNull();
    expect(
      await moves.transition(moveId, {
        from: ["requested"],
        to: "exporting",
        leaseOwner: "eu-1:dead",
      }),
    ).not.toBeNull();
    // Leased: nobody else touches it.
    await pollMoves(engEu, { inline: true });
    expect((await move(moveId)).state).toBe("exporting");
    await expireLease(moveId);
    await pollMoves(engEu, { inline: true });
    expect((await move(moveId)).state).toBe("exported");
    expect((await drive(moveId, ["retired"])).state).toBe("retired");
  });

  it("an import that committed its copy before its worker died is adopted, not repeated", async () => {
    const { id, moveId } = await requested("deadimport");
    await pollMoves(engEu, { inline: true });
    const moves = us.container.directory.moves;
    expect(await moves.acquireLease(moveId, "us-1:dead", 60_000, ["exported"])).not.toBeNull();
    expect(
      await moves.transition(moveId, {
        from: ["exported"],
        to: "importing",
        leaseOwner: "us-1:dead",
      }),
    ).not.toBeNull();
    // What the dead worker had committed: the copy, recorded with the move id.
    const file = join(mkdtempSync(join(tmpdir(), "fundroom-move-crash-")), "b.zip");
    await exportWorkspace(engEu.portability, {
      workspaceId: id,
      includeRawAnalytics: false,
      outPath: file,
    });
    const euKey = (await us.container.directory.listCells()).find((c) => c.id === "eu-1")
      ?.exportPublicKey as string;
    const copy = await importWorkspace(
      { ...engUs.portability, cellId: "us-1" },
      {
        file,
        slug: "deadimport",
        trustedPublicKeys: [euKey],
        importedBy: `move:${moveId}`,
        relocation: { moveId, holds: ["relocation"], planId: null, legalName: null, country: null },
      },
    );
    await expireLease(moveId);
    await pollMoves(engUs, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "imported",
      targetWorkspaceId: copy.workspaceId,
    });
    expect(await liveCopies("deadimport")).toEqual([{ id: copy.workspaceId }]);
    const done = await drive(moveId, ["retired"]);
    expect(done.targetWorkspaceId).toBe(copy.workspaceId);
    expect((await wsRow(usDb, copy.workspaceId))?.holds).toEqual([]);
  });

  it("a switch the directory recorded but the source never committed is settled by the poll", async () => {
    const { id, moveId } = await requested("deadswitch");
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    expect((await move(moveId)).state).toBe("imported");
    // The source's worker flipped the directory, then died before its local commit.
    const moves = eu.container.directory.moves;
    expect(await moves.acquireLease(moveId, "eu-1:dead", 60_000, ["imported"])).not.toBeNull();
    expect(await moves.switchover(moveId, "eu-1:dead")).not.toBeNull();
    expect((await wsRow(euDb, id))?.deleted_at).toBeNull();
    await pollMoves(engEu, { inline: true });
    expect((await wsRow(euDb, id))?.deleted_at).not.toBeNull();
    const [repaired] = await hostQuery<{ meta: Record<string, unknown> }>(
      euDb,
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'workspace.move_switch'`,
      [id],
    );
    expect(repaired?.meta).toMatchObject({ moveId, repaired: true });
    const done = await drive(moveId, ["retired"]);
    await pollMoves(engUs, { inline: true });
    expect((await wsRow(usDb, done.targetWorkspaceId as string))?.holds).toEqual([]);
  });
});

describe("fix round 1 (review R1)", () => {
  async function requested(slug: string) {
    const id = await euWorkspace(slug);
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: slug,
      actor: operator(),
      requestedBy: "op:test",
    });
    return { id, moveId: m.id };
  }
  const expireLease = (moveId: string) =>
    dq(`UPDATE directory.move SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
      moveId,
    ]);
  /** A directory whose `moves.transition` runs `before` ahead of the first call matching `when`. */
  function interceptTransition(
    base: DirectoryPort,
    when: (t: { to: string }) => boolean,
    before: () => Promise<void>,
  ): DirectoryPort {
    let fired = false;
    const moves = new Proxy(base.moves, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "transition") return typeof v === "function" ? v.bind(target) : v;
        return async (id: string, t: { to: string }) => {
          if (!fired && when(t)) {
            fired = true;
            await before();
          }
          return (v as (...a: unknown[]) => unknown).call(target, id, t);
        };
      },
    });
    return new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "moves") return moves;
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it("R1-1: an importer whose lease was taken never discards the copy the new holder adopted", async () => {
    const { moveId } = await requested("staleimport");
    await pollMoves(engEu, { inline: true });
    let w2: string | undefined;
    const directory = interceptTransition(
      us.container.directory,
      (t) => t.to === "imported",
      async () => {
        // W1 committed its copy; before it can say so its lease expires and W2 adopts the copy.
        await expireLease(moveId);
        w2 = await runMoveImport(engUs, moveId);
      },
    );
    const w1 = await runMoveImport({ ...engUs, directory }, moveId);
    expect(w2).toBe("done");
    expect(w1).toBe("skipped");
    const adopted = await move(moveId);
    expect(adopted.state).toBe("imported");
    const copy = await wsRow(usDb, adopted.targetWorkspaceId as string);
    expect(copy?.deleted_at).toBeNull();
    const done = await drive(moveId, ["retired"]);
    await pollMoves(engUs, { inline: true });
    const live = await wsRow(usDb, done.targetWorkspaceId as string);
    expect(live).toMatchObject({ holds: [], deleted_at: null, purged_at: null });
  });

  it("R1-2: a source deleted mid-move fails the switch; nothing comes back to life on the target", async () => {
    const { id, moveId } = await requested("deletedmid");
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    const imported = await move(moveId);
    expect(imported.state).toBe("imported");
    await asHost(
      euDb,
      `UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`,
      [id],
    );
    await pollMoves(engEu, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "switch", code: "deleted" },
    });
    await pollMoves(engUs, { inline: true });
    expect((await wsRow(usDb, imported.targetWorkspaceId as string))?.deleted_at).not.toBeNull();
    expect(await liveCopies("deletedmid")).toEqual([]);
    // RR1-6: the deleted source is released and its entry dormant (never routed), not active.
    expect(await eu.container.directory.lookupWorkspace(id)).toMatchObject({
      cellId: "eu-1",
      state: "dormant",
    });
    expect((await wsRow(euDb, id))?.holds).toEqual([]);
  });

  it("R1-4: a legal hold set mid-move fails the switch and releases the source", async () => {
    const { id, moveId } = await requested("legalmid");
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    await asHost(
      euDb,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{legal}', coalesce(settings -> 'legal', '{}'::jsonb) || '{"legalHold": true}'::jsonb) WHERE id = $1`,
      [id],
    );
    await pollMoves(engEu, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "switch", code: "legal_hold" },
    });
    expect((await wsRow(euDb, id))?.holds).toEqual([]);
    await pollMoves(engUs, { inline: true });
    expect(await liveCopies("legalmid")).toEqual([]);
  });

  it("R1-3: a discarded copy takes its subscription with it; the binding is re-read at the switch", async () => {
    // A move that fails after the import (erasure at the switch): the copy's billing row goes.
    const failing = await requested("subgone");
    await asHost(
      euDb,
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id, provider_subscription_id)
         VALUES ($1, 'starter', 'stripe', 'active', 'cus_gone', 'sub_gone')`,
      [failing.id],
    );
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    const [member] = await hostQuery<{ id: string }>(
      euDb,
      `SELECT id::text FROM core.membership WHERE workspace_id = $1 AND kind = 'external'`,
      [failing.id],
    );
    await asHost(
      euDb,
      `INSERT INTO core.dsar_request (workspace_id, membership_id, due_at, kind)
         VALUES ($1, $2, now() + interval '30 days', 'erasure')`,
      [failing.id, member?.id],
    );
    await pollMoves(engEu, { inline: true });
    expect((await move(failing.moveId)).state).toBe("failed");
    await pollMoves(engUs, { inline: true });
    expect(
      await hostQuery(
        usDb,
        `SELECT 1 FROM core.subscription WHERE provider_subscription_id = 'sub_gone'`,
      ),
    ).toEqual([]);

    // A billing webhook between the export and the switch: the target gets the switch-time row.
    const moving = await requested("subnow");
    await asHost(
      euDb,
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id, provider_subscription_id)
         VALUES ($1, 'starter', 'stripe', 'active', 'cus_now', 'sub_now')`,
      [moving.id],
    );
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    await asHost(
      euDb,
      `UPDATE core.subscription SET status = 'past_due', grace_until = now() + interval '7 days' WHERE workspace_id = $1`,
      [moving.id],
    );
    const done = await drive(moving.moveId, ["retired"]);
    await pollMoves(engUs, { inline: true });
    expect(
      await hostQuery(usDb, `SELECT status FROM core.subscription WHERE workspace_id = $1`, [
        done.targetWorkspaceId,
      ]),
    ).toEqual([{ status: "past_due" }]);
  });

  it("R1-5: an exporter that lost its lease never deletes the bundle the lease holder published", async () => {
    const { moveId } = await requested("staleexport");
    let w2: string | undefined;
    const storage = new Proxy(engEu.storage, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "put") return typeof v === "function" ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          if (w2 === undefined) {
            await expireLease(moveId);
            w2 = await runMoveExport(engEu, moveId);
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const w1 = await runMoveExport({ ...engEu, storage }, moveId);
    expect(w2).toBe("done");
    expect(w1).toBe("skipped");
    await pollMoves(engUs, { inline: true });
    expect((await move(moveId)).state).toBe("imported");
    expect((await drive(moveId, ["retired"])).state).toBe("retired");
  });

  it("R1-6: a key rotation between export and import still verifies against the published ring", async () => {
    const { moveId } = await requested("rotated");
    await pollMoves(engEu, { inline: true });
    const [row] = await dq<{ k: string; ks: unknown }>(
      `SELECT export_public_key AS k, export_public_keys AS ks FROM directory.cell WHERE id = 'eu-1'`,
    );
    const signer = (await move(moveId)).bundle?.signerKeyFingerprint as string;
    try {
      // The source rotated: a new current key, the signing key still in its published ring.
      const newKey = randomBytes(32).toString("base64");
      await dq(
        `UPDATE directory.cell SET export_public_key = $1,
                export_public_keys = jsonb_build_array(jsonb_build_object('keyId', 'k-new', 'publicKey', $1::text)) || export_public_keys
          WHERE id = 'eu-1'`,
        [newKey],
      );
      await pollMoves(engUs, { inline: true });
    } finally {
      await dq(
        `UPDATE directory.cell SET export_public_key = $1, export_public_keys = $2::jsonb WHERE id = 'eu-1'`,
        [row?.k, JSON.stringify(row?.ks)],
      );
    }
    expect(signer.length).toBeGreaterThan(0);
    expect((await move(moveId)).state).toBe("imported");
    expect((await drive(moveId, ["retired"])).state).toBe("retired");
  });

  it("R1-9: a request whose local step never committed is failed, never exported", async () => {
    const id = await euWorkspace("orphanreq");
    const orphan = await eu.container.directory.moves.request({
      workspaceId: id,
      slug: "orphanreq",
      sourceCellId: "eu-1",
      targetCellId: "us-1",
      requestedBy: "op:test",
      carried: { planId: null, legalName: null, country: null, holds: [], transferKey: "x" },
    });
    expect(typeof orphan).toBe("object");
    const moveId = (orphan as DirectoryMove).id;
    // RR1-5: inside the grace window it may be a request whose local commit is in flight.
    await pollMoves(engEu, { inline: true });
    expect((await move(moveId)).state).not.toBe("failed");
    await dq(`UPDATE directory.move SET created_at = now() - interval '3 minutes' WHERE id = $1`, [
      moveId,
    ]);
    await expireLease(moveId);
    await pollMoves(engEu, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "request", code: "internal" },
    });
    expect((await wsRow(euDb, id))?.holds).toEqual([]);
  });

  it("RR1-1: lifting a copy takes the billing row before the workspace row (no deadlock with billing)", async () => {
    const { id, moveId } = await requested("liftlock");
    await asHost(
      euDb,
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id, provider_subscription_id)
         VALUES ($1, 'starter', 'stripe', 'active', 'cus_lock', 'sub_lock')`,
      [id],
    );
    await pollMoves(engEu, { inline: true });
    await pollMoves(engUs, { inline: true });
    await pollMoves(engEu, { inline: true });
    const switched = await move(moveId);
    expect(switched.state).toMatch(/switched|retired/u);
    const copyId = switched.targetWorkspaceId as string;
    // A billing webhook on the target: subscription row first, then (later) the workspace row.
    const client = await usDb.db.pool.connect();
    let webhook: unknown;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT 1 FROM core.subscription WHERE provider_subscription_id = 'sub_lock' FOR UPDATE",
      );
      const lift = pollMoves(engUs, { inline: true }).then(
        () => "ok",
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 700));
      webhook = await client
        .query("SELECT 1 FROM core.workspace WHERE id = $1 FOR NO KEY UPDATE", [copyId])
        .then(
          () => "ok",
          (e: unknown) => e,
        );
      await client.query(webhook === "ok" ? "COMMIT" : "ROLLBACK");
      expect(await lift).toBe("ok");
    } finally {
      client.release();
    }
    expect(webhook).toBe("ok");
    expect((await wsRow(usDb, copyId))?.holds).toEqual([]);
  });

  it("RR3-3: a sibling label cell's move is driven, listed and cancelled by any process of the database", async () => {
    await asHost(
      euDb,
      `INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-2', 'eu', '')`,
    );
    await reconcile();
    const sib = async (slug: string) => {
      const ws = await createWorkspace(eu.container.db, { slug, name: slug, cellId: "eu-2" });
      await reconcile();
      return ws.id;
    };
    // The only worker is eu-1's (engEu): it requests, exports, switches and retires eu-2's move.
    const id = await sib("siblingcell");
    const m = await requestMove(engEu, {
      workspaceId: id,
      targetCellId: "us-1",
      confirmSlug: "siblingcell",
      actor: operator(),
      requestedBy: "op:test",
    });
    expect(m.sourceCellId).toBe("eu-2");
    await pollMoves(engEu, { inline: true });
    expect((await move(m.id)).state).toBe("exported");
    await pollMoves(engUs, { inline: true });
    const done = await drive(m.id, ["retired"]);
    expect(done.state).toBe("retired");
    await pollMoves(engUs, { inline: true });
    expect((await wsRow(usDb, done.targetWorkspaceId as string))?.holds).toEqual([]);
    const listed = await op(`/moves?workspaceId=${id}`);
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((x) => x.id)).toEqual([
      m.id,
    ]);
    // Cancel from an eu-1 process releases an eu-2 workspace at once.
    const id2 = await sib("siblingcancel");
    const m2 = await requestMove(engEu, {
      workspaceId: id2,
      targetCellId: "us-1",
      confirmSlug: "siblingcancel",
      actor: operator(),
      requestedBy: "op:test",
    });
    const res = await op(`/moves/${m2.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await wsRow(euDb, id2))?.holds).toEqual([]);
    // A held eu-2 workspace whose move is live is never lifted as "unexplained" by eu-1's poll.
    const id3 = await sib("siblinglive");
    const m3 = await requestMove(engEu, {
      workspaceId: id3,
      targetCellId: "us-1",
      confirmSlug: "siblinglive",
      actor: operator(),
      requestedBy: "op:test",
    });
    await eu.container.directory.moves.acquireLease(m3.id, "eu-2:busy", 60_000, ["requested"]);
    await pollMoves(engEu, { inline: true });
    expect((await wsRow(euDb, id3))?.holds).toEqual(["relocation"]);
    expect((await op(`/moves/${m3.id}/cancel`, { method: "POST" })).status).toBe(200);
  });

  it("RR2-2: a workspace awaiting its first sanctions screen is not moved", async () => {
    const id = await euWorkspace("unscreened");
    await eu.container.db.withHost((tx) =>
      setWorkspaceHold(
        tx as Tx,
        {
          workspaceId: id,
          hold: "sanctions_review",
          on: true,
          actor: { kind: "system", source: "sanctions" },
        },
        { audit: eu.container.audit, invalidate: () => {} },
      ),
    );
    const res = await op(`/workspaces/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "unscreened" }),
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "move_unavailable",
      reason: "sanctions_review",
    });
  });

  it("R1-11: a validly signed export older than the move is refused", async () => {
    const { moveId } = await requested("oldbundle");
    await pollMoves(engEu, { inline: true });
    await dq(`UPDATE directory.move SET created_at = now() + interval '1 hour' WHERE id = $1`, [
      moveId,
    ]);
    await pollMoves(engUs, { inline: true });
    expect(await move(moveId)).toMatchObject({
      state: "failed",
      error: { stage: "verify", code: "bundle_mismatch" },
    });
    // R1-7: a failed move keeps neither the URL nor the key.
    expect(
      await dq(
        `SELECT bundle, carried ? 'transferKey' AS has_key FROM directory.move WHERE id = $1`,
        [moveId],
      ),
    ).toEqual([{ bundle: null, has_key: false }]);
  });

  it("R1-10: plaintext spool files of moves that are no longer live are swept", async () => {
    const { moveId } = await requested("spool");
    const dirPath = join(engEu.dataDir, "moves");
    mkdirSync(dirPath, { recursive: true });
    const stale = join(dirPath, `import-${moveId}.zip`);
    writeFileSync(stale, "plaintext tenant export");
    const done = await drive(moveId, ["retired"]);
    expect(done.state).toBe("retired");
    await pollMoves(engEu, { inline: true });
    expect(existsSync(stale)).toBe(false);
  });

  it("R1-8: import failures are logged by name and code only", async () => {
    const lines = logged.filter((l) => l.includes("moves.import_error"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toMatch(/Failed query|params|INSERT|SELECT/u);
    }
  });
});

describe("refusals", () => {
  it("a workspace in deletion, an unknown or local target, concurrent requests, local mode", async () => {
    const gone = await euWorkspace("goner");
    await asHost(
      euDb,
      `UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`,
      [gone],
    );
    const deleted = await op(`/workspaces/${gone}/move`, {
      method: "POST",
      body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "goner" }),
    });
    expect(deleted.status).toBe(409);
    expect(await errorOf(deleted)).toMatchObject({ code: "move_unavailable", reason: "deleted" });

    const id = await euWorkspace("racer");
    for (const [target, reason] of [
      ["ap-9", "target_unknown"],
      ["eu-1", "target_local"],
    ] as const) {
      const res = await op(`/workspaces/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ targetCellId: target, confirmSlug: "racer" }),
      });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({ code: "move_unavailable", reason });
    }

    const both = await Promise.all(
      [0, 1].map(() =>
        op(`/workspaces/${id}/move`, {
          method: "POST",
          body: JSON.stringify({ targetCellId: "us-1", confirmSlug: "racer" }),
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    const loser = both.find((r) => r.status === 409) as Response;
    expect((await errorOf(loser))["code"]).toBe("move_busy");
    const winner = (await (both.find((r) => r.status === 202) as Response).json()) as {
      id: string;
    };
    expect((await op(`/moves/${winner.id}/cancel`, { method: "POST" })).status).toBe(200);

    const local = await requestMove(
      { ...engEu, directory: createLocalDirectory({ db: eu.container.db }) },
      {
        workspaceId: id,
        targetCellId: "us-1",
        confirmSlug: "racer",
        actor: operator(),
        requestedBy: "op:test",
      },
    ).catch((e: unknown) => e);
    expect(local).toBeInstanceOf(MoveError);
    expect(local).toMatchObject({ code: "move_unavailable", reason: "no_directory" });
  });
});

describe("the plain portability import (E3.11 fixes)", () => {
  it("lands in this process's cell and claims its slug in the directory; a slug another cell holds is slug_taken", async () => {
    const id = await euWorkspace("exported-one");
    const file = join(mkdtempSync(join(tmpdir(), "fundroom-move-export-")), "x.zip");
    await exportWorkspace(engEu.portability, {
      workspaceId: id,
      includeRawAnalytics: false,
      outPath: file,
    });
    const euKey = (await eu.container.directory.listCells()).find((c) => c.id === "eu-1")
      ?.exportPublicKey as string;
    const deps = { ...engUs.portability, cellId: "us-1", directory: us.container.directory };
    const result = await importWorkspace(deps, {
      file,
      slug: "imported-one",
      trustedPublicKeys: [euKey],
      importedBy: "test",
    });
    expect(await wsRow(usDb, result.workspaceId)).toMatchObject({
      cell_id: "us-1",
      data_region: "us",
    });
    expect(await us.container.directory.lookupSlug("imported-one")).toEqual({
      cellId: "us-1",
      state: "active",
    });
    // `exported-one` is live in the EU cell: the directory refuses it before any local row.
    const taken = await importWorkspace(deps, {
      file,
      slug: "exported-one",
      trustedPublicKeys: [euKey],
      importedBy: "test",
    }).catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(PortabilityError);
    expect((taken as PortabilityError).code).toBe("slug_taken");
    expect(await liveCopies("exported-one")).toEqual([]);
  });
});
