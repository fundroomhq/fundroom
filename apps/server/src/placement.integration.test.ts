import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createAuditService } from "@fundroom/audit";
import { isCellOrigin, loadConfig } from "@fundroom/config";
import {
  cellOriginOf,
  ensureOwnCell,
  localPlacementCell,
  OwnCellUnavailableError,
  ProvisioningError,
  provisionWorkspace,
} from "@fundroom/control-plane";
import { CHALLENGE_LABEL } from "@fundroom/custom-domains";
import { PLATFORM_WORKSPACE_ID, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createSharedDirectory } from "@fundroom/directory";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type {
  DirectoryPort,
  DnsAnswer,
  DnsRecordType,
  DnsResolverPort,
  ProvisionedWorkspace,
} from "@fundroom/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cellsCommand } from "./cli-commands/cells.js";
import { operatorCommand } from "./cli-commands/operator.js";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { checkDataRegion, RegionBootError } from "./residency/boot.js";
import { type RunningServer, startServer } from "./server.js";
import {
  createCellDatabase,
  createDirectoryDatabase,
  type TestDatabase,
} from "./test/directory-db.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import {
  purgeDeletedWorkspaces,
  restoreWorkspace,
  softDeleteWorkspace,
} from "./workspace/lifecycle.js";

/*
 * E3.11 placement hooks (agent B) against a REAL shared cell directory: one directory database,
 * this cell's database (`eu-1`, region eu, served by `running`) and a second cell database
 * (`us-1`, region us) whose only presence here is a second directory client (`remote`) — what
 * another cell's processes would write. Proves that every place a slug or hostname is born, dies
 * or is refused asks the directory, and never names the other cell's tenant:
 *
 *  - the region boot check (adoption, label refresh, the seeded `default` row left alone,
 *    refusal in prod-like, warning elsewhere) and publishing the cell;
 *  - the setup wizard, operator provisioning, signup and the demo seed refusing a slug held in
 *    another cell with the same answer the local unique index gives;
 *  - a failure after the claim releasing it; the purge releasing the entry;
 *  - a hostname verified by another cell failing to verify here, silently;
 *  - `GET /platform/cells` (remote cells, heartbeats), `PATCH` to a remote cell (409 use_move),
 *    `GET /signup/regions`, `fundroom cell add` with label / jurisdiction / DATA_REGION.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const IN_NET = "10.20.30.40";
const TOKEN = "placement-setup-token-0123456789";
const LABEL = "European Union (Frankfurt, Germany)";

let pg: TestPostgres;
let dir: TestDatabase;
let cellA: TestDatabase;
let cellB: TestDatabase;
let running: RunningServer;
let mailer: MemoryMailer;
/** Another cell's view of the directory (us-1, a different cell database). */
let remote: DirectoryPort;
let operatorUserId: string;
let opCookie: string;
let ipCounter = 0;
let dataDir: string;
const hookMode: { fail: boolean } = { fail: false };

// --- DNS ----------------------------------------------------------------------------------------

const zone = new Map<string, Map<DnsRecordType, readonly string[]>>();
function publishRecord(name: string, type: DnsRecordType, values: readonly string[]): void {
  const byType = zone.get(name.toLowerCase()) ?? new Map<DnsRecordType, readonly string[]>();
  byType.set(type, values);
  zone.set(name.toLowerCase(), byType);
}
const fakeDns: DnsResolverPort = {
  driver: "fake",
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
    const byType = zone.get(name.toLowerCase());
    return Promise.resolve({
      name,
      type,
      values: [...(byType?.get(type) ?? [])],
      rcode: byType === undefined ? "nxdomain" : "ok",
      resolver: "fake",
      chain: undefined,
    });
  },
  healthCheck: () => Promise.resolve(),
};

// --- helpers ------------------------------------------------------------------------------------

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; ip?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  const n = ipCounter++;
  headers.set("x-forwarded-for", init.ip ?? `10.${Math.floor(n / 250) % 250}.${n % 250}.7`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const op = (path: string, init: Parameters<typeof request>[2] = {}) =>
  request(CANON, `/api/v1/platform${path}`, { cookie: opCookie, ip: IN_NET, ...init });

async function errorBody(res: Response): Promise<Record<string, unknown>> {
  return ((await res.clone().json()) as { error: Record<string, unknown> }).error;
}

async function cellQuery<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  return (await cellA.db.pool.query(sql, args)).rows as T[];
}
async function dirQuery<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  return (await dir.db.pool.query(sql, args)).rows as T[];
}

/** The directory entry of a slug (any state), newest first. */
async function entriesOf(slug: string) {
  return dirQuery<{ workspace_id: string; cell_id: string; state: string }>(
    `SELECT workspace_id::text AS workspace_id, cell_id, state FROM directory.workspace
      WHERE slug = $1 ORDER BY created_at DESC`,
    [slug],
  );
}

/** The body of the workspace's seeded privacy notice (template `privacy-notice`). */
async function seededPrivacyNotice(workspaceId: string): Promise<string> {
  const rows = await cellQuery<{ body: string }>(
    `SELECT body FROM core.legal_document_version
      WHERE workspace_id = $1 AND template_id = 'privacy-notice' ORDER BY version_no DESC LIMIT 1`,
    [workspaceId],
  );
  return rows[0]?.body ?? "";
}

/** Another cell's workspace takes `slug` (reserved → active), as that cell's provisioning would. */
async function remoteWorkspace(slug: string): Promise<string> {
  const id = randomUUID();
  expect(await remote.claimSlug({ workspaceId: id, slug, cellId: "us-1" })).toBe("claimed");
  await remote.activate(id);
  return id;
}

async function userSession(userId: string): Promise<string> {
  const s = await running.container.auth.sessions.startSession({
    userId,
    population: "staff",
    context: "first_party",
    authLevel: 2,
  });
  await cellQuery(
    `UPDATE core.credential SET last_used_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND kind IN ('totp', 'passkey')`,
    [userId],
  );
  return `__Host-sid=${s.token}`;
}

const signupApplication = (email: string, slug: string) => ({
  email,
  companyName: `${slug} Inc`,
  legalName: `${slug} Holdings GmbH`,
  country: "DE",
  slug,
  acceptTerms: true,
  termsVersion: 1,
});

async function signup(email: string, slug: string): Promise<Response> {
  const since = mailer.sent.length;
  const start = await request(CANON, "/api/v1/signup/start", {
    method: "POST",
    body: JSON.stringify(signupApplication(email, slug)),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  return request(CANON, "/api/v1/signup/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

function provisioningInput(slug: string) {
  return {
    slug,
    name: `${slug} Inc`,
    legalName: `${slug} GmbH`,
    country: "DE",
    ownerEmail: `owner@${slug}.test`,
    planId: null,
    actor: { kind: "system", source: "provisioning" } as const,
  };
}

// --- the cells ----------------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  dir = await createDirectoryDatabase(pg);
  cellA = await createCellDatabase(pg);
  cellB = await createCellDatabase(pg);
  // This cell's database: its own cell `eu-1` (no label yet: the boot check fills it in).
  await cellA.db.pool.query(
    `INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-1', 'eu', '');
     INSERT INTO core.plan (id, name, limits, public) VALUES ('starter', 'Starter', '{}', true);`,
  );
  // The other cell's database, and that cell's directory client.
  await cellB.db.pool.query(
    `INSERT INTO core.cell (id, region, public_origin) VALUES ('us-1', 'us', 'https://us.example.test')`,
  );
  remote = createSharedDirectory({ url: dir.url, poolMax: 2, db: cellB.db, cellId: "us-1" });
  await remote.publishCell({
    id: "us-1",
    region: "us",
    regionLabel: "United States (Virginia)",
    jurisdiction: "us",
    publicOrigin: "https://us.example.test",
    status: "active",
    exportPublicKey: null,
  });
  // Two more remote cells the signup picker must NOT offer: one draining, one with no origin.
  for (const cell of [
    {
      id: "ap-1",
      region: "ap",
      status: "draining" as const,
      publicOrigin: "https://ap.example.test",
    },
    { id: "ca-1", region: "ca", status: "active" as const, publicOrigin: "" },
  ]) {
    await remote.publishCell({
      ...cell,
      regionLabel: cell.region,
      jurisdiction: null,
      exportPublicKey: null,
    });
  }

  mailer = createMemoryMailer();
  dataDir = mkdtempSync(join(tmpdir(), "fundroom-data-"));
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: cellA.url,
      DATABASE_POOL_MAX: process.env["FUNDROOM_TEST_POOL_MAX"] ?? "6",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: dataDir,
      SETUP_TOKEN: TOKEN,
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      CELL_ID: "eu-1",
      DATA_REGION: "eu",
      DATA_REGION_LABEL: LABEL,
      DATA_REGION_JURISDICTION: "eu",
      DIRECTORY_DATABASE_URL: dir.url,
      SIGNUP_MODE: "open",
      SIGNUP_DEFAULT_PLAN: "starter",
      PLATFORM_OPERATOR_CIDRS: "10.0.0.0/8",
      TRUST_PROXY: "true",
      ROLES: "api,web",
      UPDATE_CHECK: "false",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    dns: fakeDns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  // The provisioning hooks (sanctions, billing) replaced by one that can fail after the insert.
  Object.assign(running.container.sanctions, {
    hooks: {
      async onWorkspaceCreated(_tx: unknown, _ws: ProvisionedWorkspace) {
        if (hookMode.fail) throw new Error("hook refused");
      },
    },
  });
  Object.assign(running.container.billing, { hooks: {} });

  // An operator: an account with a confirmed second factor from yesterday, granted by the CLI.
  const { identityDeps } = running.container;
  const { provisionUser } = await import("@fundroom/identity");
  const opUser = await provisionUser(identityDeps, { email: "ops@platform.test" });
  operatorUserId = opUser.userId;
  await cellQuery(
    `INSERT INTO core.credential (user_id, kind, secret, confirmed_at, created_at)
       VALUES ($1, 'totp', 'sealed', now() - interval '1 day', now() - interval '1 day')`,
    [opUser.userId],
  );
  const granted = await operatorCommand(["grant", "ops@platform.test"], {
    db: running.container.db,
    audit: running.container.audit,
    osUser: "tester",
    out: () => {},
    err: () => {},
  });
  expect(granted).toBe(0);
}, 240_000);

beforeEach(async () => {
  const minted = await request(CANON, "/api/v1/platform/session", {
    method: "POST",
    cookie: await userSession(operatorUserId),
    ip: IN_NET,
  });
  expect(minted.status).toBe(200);
  const line = minted.headers.getSetCookie().find((c) => c.startsWith("__Host-op_sid="));
  opCookie = (line as string).split(";")[0] as string;
});

afterAll(async () => {
  await running?.stop();
  await remote?.close();
  await cellB?.close();
  await cellA?.close();
  await dir?.close();
  await pg?.stop();
});

// --- the region boot check ----------------------------------------------------------------------

describe("the region boot check", () => {
  it("gave this cell the declared label and jurisdiction, left the unused seeded row alone, and published", async () => {
    const cells = await cellQuery<{
      id: string;
      region: string;
      region_label: string;
      jurisdiction: string | null;
    }>(`SELECT id, region, region_label, jurisdiction FROM core.cell ORDER BY id`);
    expect(cells).toEqual([
      // CELL_ID is eu-1 and nothing was ever placed on `default`: every cell database seeds one,
      // so adopting (and publishing) it everywhere would collide in the directory.
      { id: "default", region: "default", region_label: "", jurisdiction: null },
      { id: "eu-1", region: "eu", region_label: LABEL, jurisdiction: "eu" },
    ]);
    const audits = await cellQuery<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'cell.update' ORDER BY seq`,
      [PLATFORM_WORKSPACE_ID],
    );
    expect(audits.map((a) => a.meta)).toEqual([
      expect.objectContaining({
        cellId: "eu-1",
        from: { regionLabel: "", jurisdiction: null },
        to: { regionLabel: LABEL, jurisdiction: "eu" },
      }),
    ]);
    const published = await dirQuery<{ region: string; region_label: string }>(
      `SELECT region, region_label FROM directory.cell WHERE id = 'eu-1'`,
    );
    expect(published).toEqual([{ region: "eu", region_label: LABEL }]);
  });

  it("adopts placeholder cells, and refuses a database of another region in prod-like only", async () => {
    // A fresh database whose `default` row holds a workspace (an E3.10 install): adopted.
    const fresh = await createCellDatabase(pg);
    try {
      await fresh.db.pool.query(
        `BEGIN;
         SELECT set_config('app.actor_kind', 'host', true);
         INSERT INTO core.workspace (slug, name) VALUES ('legacy', 'Legacy');
         COMMIT;`,
      );
      const audit = createAuditService({ db: fresh.db });
      const logged: string[] = [];
      const raw = {
        APP_ENV: "prod",
        CELL_ID: "eu-9",
        DATA_REGION: "eu",
        DATA_REGION_LABEL: LABEL,
        DATA_REGION_JURISDICTION: "eu",
      } as const;
      const adoption = await checkDataRegion({
        db: fresh.db,
        audit,
        raw,
        log: (event) => logged.push(event),
      });
      expect(adoption.adopted).toEqual(["default"]);
      const [ws] = (
        await fresh.db.pool.query(`SELECT data_region FROM core.workspace WHERE slug = 'legacy'`)
      ).rows as { data_region: string }[];
      expect(ws?.data_region).toBe("eu");
      expect(logged).toContain("residency.region_adopted");
      // Idempotent: a second boot adopts nothing.
      expect((await checkDataRegion({ db: fresh.db, audit, raw, log: () => {} })).adopted).toEqual(
        [],
      );

      // The same database under a deployment declaring another region.
      const us = { ...raw, DATA_REGION: "us", DATA_REGION_JURISDICTION: "us" } as const;
      await expect(
        checkDataRegion({ db: fresh.db, audit, raw: us, log: () => {} }),
      ).rejects.toThrow(RegionBootError);
      await expect(
        checkDataRegion({ db: fresh.db, audit, raw: us, log: () => {} }),
      ).rejects.toThrow(/DATA_REGION=us.*default \(eu\).*one region/su);
      const warned: string[] = [];
      await checkDataRegion({
        db: fresh.db,
        audit,
        raw: { ...us, APP_ENV: "test" },
        log: (event) => warned.push(event),
      });
      expect(warned).toContain("residency.region_mismatch");
      // Nothing changed region.
      const regions = (await fresh.db.pool.query(`SELECT region FROM core.cell`)).rows;
      expect(regions).toEqual([{ region: "eu" }]);
      // No declaration at all while a cell declares one: a warning, never a refusal.
      const undeclared: string[] = [];
      await checkDataRegion({
        db: fresh.db,
        audit,
        raw: { APP_ENV: "prod", CELL_ID: "default" } as never,
        log: (event) => undeclared.push(event),
      });
      expect(undeclared).toEqual(["residency.region_undeclared"]);
    } finally {
      await fresh.close();
    }
  });
});

// --- the own cell row (E-UP-13) ------------------------------------------------------------------

/** A started server on its own fresh database, its log lines captured. */
async function bootCell(
  database: TestDatabase,
  env: Record<string, string>,
): Promise<{ server: RunningServer; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split("\n"))
        if (line.trim() !== "") logs.push(JSON.parse(line));
      done();
    },
  });
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: database.url,
      DATABASE_POOL_MAX: "4",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      ROLES: "api",
      UPDATE_CHECK: "false",
      ...env,
    },
  });
  const server = await startServer({
    config,
    logger: createLogger({ level: "info", destination: sink }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: true,
    modules: [],
  });
  return { server, logs };
}

describe("the own cell row (E-UP-13)", () => {
  const own = {
    id: "us-7",
    region: "us",
    regionLabel: "United States (Virginia)",
    jurisdiction: "us",
    publicOrigin: "https://app.us7.example.test",
  };

  it("placement refuses a CELL_ID without its row, or not active, instead of picking `default`", async () => {
    const fresh = await createCellDatabase(pg);
    try {
      await expect(localPlacementCell(fresh.db, "us-7")).rejects.toThrow(OwnCellUnavailableError);
      await expect(localPlacementCell(fresh.db, "us-7")).rejects.toThrow(
        /CELL_ID=us-7 has no row in core\.cell.*fundroom cell add us-7/su,
      );
      expect(await localPlacementCell(fresh.db, "default")).toBe("default");
      // L2: a draining own cell takes no new workspace either (as provisioning refuses it).
      await fresh.db.pool.query(
        `INSERT INTO core.cell (id, region, public_origin, status) VALUES ('us-7', 'us', '', 'draining')`,
      );
      await expect(localPlacementCell(fresh.db, "us-7")).rejects.toMatchObject({
        name: "OwnCellUnavailableError",
        state: "draining",
      });
    } finally {
      await fresh.close();
    }
  });

  it("is created once from the configuration, audited, never rewritten, and set-origin corrects it", async () => {
    const fresh = await createCellDatabase(pg);
    try {
      const audit = createAuditService({ db: fresh.db });
      const q = async <T>(sql: string) => (await fresh.db.pool.query(sql)).rows as T[];
      expect(await ensureOwnCell({ db: fresh.db, audit }, { ...own, id: "default" })).toEqual({
        outcome: "placeholder",
      });
      // app and worker start together: one insert, everyone else finds it.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ensureOwnCell({ db: fresh.db, audit }, own)),
      );
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "present")).toHaveLength(5);
      expect(
        await q(
          `SELECT id, region, public_origin, status, region_label, jurisdiction FROM core.cell WHERE id = 'us-7'`,
        ),
      ).toEqual([
        {
          id: "us-7",
          region: "us",
          public_origin: own.publicOrigin,
          status: "active",
          region_label: own.regionLabel,
          jurisdiction: "us",
        },
      ]);
      const audits = await q<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM audit.event WHERE action = 'cell.add' ORDER BY seq`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.meta).toMatchObject({ cellId: "us-7", region: "us" });
      expect(await localPlacementCell(fresh.db, "us-7")).toBe("us-7");

      // An operator moved the origin and drained it: the origin is a difference, reported and
      // left as it is; draining is deliberate, not a difference (the server logs it at info).
      await fresh.db.pool.query(
        `BEGIN;
         SELECT set_config('app.actor_kind', 'host', true);
         UPDATE core.cell SET public_origin = 'https://edited.example.test', status = 'draining'
          WHERE id = 'us-7';
         COMMIT;`,
      );
      const differs = await ensureOwnCell({ db: fresh.db, audit }, own);
      expect(differs.outcome).toBe("differs");
      expect(differs.outcome === "differs" ? differs.differences : []).toEqual([
        `public origin is https://edited.example.test, BASE_URL gives ${own.publicOrigin}`,
      ]);
      expect(await q(`SELECT public_origin, status FROM core.cell WHERE id = 'us-7'`)).toEqual([
        { public_origin: "https://edited.example.test", status: "draining" },
      ]);
      expect(await q(`SELECT 1 FROM audit.event WHERE action LIKE 'cell.%'`)).toHaveLength(1);

      // M1: `fundroom cell set-origin` is how the row is corrected (audited cell.update).
      const out: string[] = [];
      const err: string[] = [];
      const cli = (argv: string[]) =>
        cellsCommand(argv, {
          db: fresh.db,
          audit,
          out: (l) => out.push(l),
          err: (l) => err.push(l),
        });
      expect(await cli(["set-origin", "us-7", "https://App.US7.example.test/"])).toBe(0);
      expect(out.at(-1)).toMatch(/^origin: us-7 https:\/\/app\.us7\.example\.test /u);
      expect(await ensureOwnCell({ db: fresh.db, audit }, own)).toMatchObject({
        outcome: "present",
      });
      const updates = await q<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM audit.event WHERE action = 'cell.update' ORDER BY seq`,
      );
      expect(updates.map((u) => u.meta)).toEqual([
        expect.objectContaining({
          cellId: "us-7",
          from: { publicOrigin: "https://edited.example.test" },
          to: { publicOrigin: own.publicOrigin },
        }),
      ]);
      // The same again is a no-op (no second audit row); bad input and unknown cells refused.
      expect(await cli(["set-origin", "us-7", own.publicOrigin])).toBe(0);
      expect(await q(`SELECT 1 FROM audit.event WHERE action = 'cell.update'`)).toHaveLength(1);
      expect(await cli(["set-origin", "us-7", "http://plain.example.test"])).toBe(2);
      expect(err.at(-1)).toMatch(/^publicOrigin: an origin is https:\/\/host/u);
      expect(await cli(["set-origin", "nope-1", own.publicOrigin])).toBe(1);
      expect(await cli(["set-origin", "us-7"])).toBe(2);
      // "" is this install.
      expect(await cli(["set-origin", "us-7", ""])).toBe(0);
      expect(await q(`SELECT public_origin FROM core.cell WHERE id = 'us-7'`)).toEqual([
        { public_origin: "" },
      ]);

      // Another region declared in this database already: refused with the reason, not thrown.
      const refused = await ensureOwnCell(
        { db: fresh.db, audit },
        { ...own, id: "eu-7", region: "eu", jurisdiction: "eu" },
      );
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: expect.stringMatching(/one region/u),
      });
      // No DATA_REGION: the placeholder region, adopted later by the region boot check.
      const bare = await ensureOwnCell({ db: fresh.db, audit }, { id: "zz-1", publicOrigin: "" });
      expect(bare).toMatchObject({
        outcome: "created",
        row: { region: "default", publicOrigin: "" },
      });
    } finally {
      await fresh.close();
    }
  });

  it("the config's cell-origin shape is the control plane's (doctor and start-up agree)", () => {
    for (const origin of [
      "https://app.example.com",
      "https://app.example.com:8443",
      "https://10.0.0.1",
      "https://[2001:db8::1]",
      "https://[2001:db8::1]:8443",
      "http://app.example.com",
      "https://app.example.com/x",
      "https://user@app.example.com",
    ]) {
      expect(isCellOrigin(origin), origin).toBe(cellOriginOf(origin) !== "");
    }
  });

  it("a server start creates it, warns about workspaces left on `default`, and keeps no setup token", async () => {
    const fresh = await createCellDatabase(pg);
    const freshData = mkdtempSync(join(tmpdir(), "fundroom-data-"));
    // A workspace from before E-UP-13, stranded on `default`; and a token from a self-hosted past.
    await fresh.db.pool.query(
      `BEGIN;
       SELECT set_config('app.actor_kind', 'host', true);
       INSERT INTO core.workspace (slug, name) VALUES ('stranded', 'Stranded');
       COMMIT;`,
    );
    writeFileSync(join(freshData, "setup-token"), "an-old-token-0123456789\n");
    let booted: Awaited<ReturnType<typeof bootCell>> | undefined;
    try {
      booted = await bootCell(fresh, {
        BASE_URL: "https://app.us7.example.test",
        DATA_DIR: freshData,
        CELL_ID: "us-7",
        DATA_REGION: "us",
        DATA_REGION_JURISDICTION: "us",
      });
      const rows = (
        await fresh.db.pool.query(
          `SELECT id, region, public_origin, jurisdiction FROM core.cell ORDER BY id`,
        )
      ).rows;
      expect(rows).toEqual([
        // Holds a workspace, so the region boot check adopted it.
        { id: "default", region: "us", public_origin: "", jurisdiction: "us" },
        {
          id: "us-7",
          region: "us",
          public_origin: "https://app.us7.example.test",
          jurisdiction: "us",
        },
      ]);
      const events = booted.logs.map((l) => l["event"] ?? l["msg"]);
      expect(events).toContain("cell.own_created");
      // L1: the stranded workspace answers 421 wrong_cell; said once, with the remedy.
      const stranded = booted.logs.find((l) => l["msg"] === "cell.default_has_workspaces");
      expect(stranded).toMatchObject({ level: "warn", workspaces: 1 });
      expect(String(stranded?.["message"])).toMatch(/PATCH \/api\/v1\/platform\/workspaces/u);
      // E-UP-11 at boot: setup is not required and no token exists (`announceSetup` is on: the
      // banner would have generated one); L7: the leftover file is gone.
      expect(await booted.server.container.setupGate.required()).toBe(false);
      expect(existsSync(join(freshData, "setup-token"))).toBe(false);
      expect(booted.logs.map((l) => l["msg"])).toContain("setup.token_removed");
    } finally {
      await booted?.server.stop();
      await fresh.close();
    }
  }, 120_000);

  it("L8: without a control plane the wizard places on the named CELL_ID with the declared region", async () => {
    const fresh = await createCellDatabase(pg);
    let booted: Awaited<ReturnType<typeof bootCell>> | undefined;
    try {
      booted = await bootCell(fresh, {
        BASE_URL: "https://portal.eu9.example.test",
        DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
        TENANCY_MODE: "single",
        CONTROL_PLANE: "off",
        SETUP_TOKEN: TOKEN,
        CELL_ID: "eu-9",
        DATA_REGION: "eu",
        DATA_REGION_LABEL: LABEL,
        DATA_REGION_JURISDICTION: "eu",
      });
      const res = await booted.server.app.request(
        "https://portal.eu9.example.test/api/v1/setup/owner",
        {
          method: "POST",
          headers: {
            host: "portal.eu9.example.test",
            origin: "https://portal.eu9.example.test",
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            token: TOKEN,
            email: "sam@acme.test",
            displayName: "Sam",
            workspaceName: "Acme",
            workspaceSlug: "acme",
          }),
        },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const { workspace } = (await res.json()) as { workspace: { id: string } };
      const q = async <T>(sql: string, args: unknown[]) =>
        (await fresh.db.pool.query(sql, args)).rows as T[];
      expect(
        await q(`SELECT cell_id, data_region FROM core.workspace WHERE id = $1`, [workspace.id]),
      ).toEqual([{ cell_id: "eu-9", data_region: "eu" }]);
      // The seeded privacy notice states the declared region (E3.11's assertion, kept).
      const [notice] = await q<{ body: string }>(
        `SELECT body FROM core.legal_document_version
          WHERE workspace_id = $1 AND template_id = 'privacy-notice' ORDER BY version_no DESC LIMIT 1`,
        [workspace.id],
      );
      expect(notice?.body).toContain(`Data is stored in ${LABEL}`);
    } finally {
      await booted?.server.stop();
      await fresh.close();
    }
  }, 120_000);

  it("M2: with a shared directory, a cell's first start publishes its new row at once", async () => {
    const fresh = await createCellDatabase(pg);
    const freshDir = await createDirectoryDatabase(pg);
    let booted: Awaited<ReturnType<typeof bootCell>> | undefined;
    try {
      booted = await bootCell(fresh, {
        BASE_URL: "https://app.eu8.example.test",
        DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
        CELL_ID: "eu-8",
        DATA_REGION: "eu",
        DATA_REGION_JURISDICTION: "eu",
        DIRECTORY_DATABASE_URL: freshDir.url,
      });
      const published = (
        await freshDir.db.pool.query(`SELECT id, public_origin FROM directory.cell ORDER BY id`)
      ).rows;
      expect(published).toEqual([{ id: "eu-8", public_origin: "https://app.eu8.example.test" }]);
      // The first slug claim works straight away, not after the 5-minute heartbeat.
      const workspaceId = randomUUID();
      expect(
        await booted.server.container.directory.claimSlug({
          workspaceId,
          slug: "first-tenant",
          cellId: "eu-8",
        }),
      ).toBe("claimed");
    } finally {
      await booted?.server.stop();
      await freshDir.close();
      await fresh.close();
    }
  }, 120_000);
});

// --- slugs --------------------------------------------------------------------------------------

describe("no first-run wizard under the control plane (E-UP-11)", () => {
  /*
   * Was "the setup wizard" (E3.11): under the control plane the wizard claimed slugs like every
   * other path. Since E-UP-11 there is no wizard there at all — not even before the first
   * workspace exists — and SETUP_TOKEN (set above on purpose) is ignored: no token verifies,
   * none is written to DATA_DIR. Placement through the remaining local paths (demo seed, import)
   * is covered below; signup and the operator API have their own describes.
   */
  const owner = (slug: string, token = TOKEN) =>
    request(CANON, "/api/v1/setup/owner", {
      method: "POST",
      body: JSON.stringify({
        token,
        email: "sam@acme.test",
        displayName: "Sam",
        workspaceName: "Acme",
        workspaceSlug: slug,
      }),
    });

  it("is never required, even with no workspace yet, and has no token", async () => {
    expect(
      await cellQuery(`SELECT id FROM core.workspace WHERE id <> $1`, [PLATFORM_WORKSPACE_ID]),
    ).toEqual([]);
    running.container.setupGate.invalidate();
    expect(await running.container.setupGate.required()).toBe(false);
    const status = await request(CANON, "/api/v1/setup/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ required: false });
    // The configured SETUP_TOKEN is not a token here, and nothing was generated or written.
    expect(running.container.setupToken.verify(TOKEN)).toBe(false);
    expect(existsSync(join(dataDir, "setup-token"))).toBe(false);
  });

  it("refuses the token routes with the right token, creating and claiming nothing", async () => {
    const verify = await request(CANON, "/api/v1/setup/token/verify", {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(verify.status).toBe(409);
    expect(await errorBody(verify)).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/first-run setup is off on this host/u),
    });
    const res = await owner("acme");
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toMatchObject({ code: "conflict" });
    expect(await cellQuery(`SELECT id FROM core.workspace WHERE slug = 'acme'`)).toEqual([]);
    expect(await entriesOf("acme")).toEqual([]);
  });
});

describe("operator provisioning", () => {
  it("answers slug_taken for a slug another cell holds, never naming it", async () => {
    await remoteWorkspace("globex");
    const res = await op("/workspaces", {
      method: "POST",
      body: JSON.stringify({
        slug: "globex",
        name: "Globex",
        legalName: "Globex GmbH",
        country: "DE",
        ownerEmail: "hank@globex.test",
        planId: null,
      }),
    });
    expect(res.status).toBe(409);
    const error = await errorBody(res);
    expect(error["code"]).toBe("slug_taken");
    expect(JSON.stringify(error)).not.toMatch(/us-1|united states/iu);
    expect(await cellQuery(`SELECT id FROM core.workspace WHERE slug = 'globex'`)).toEqual([]);
    // Only the other cell's entry.
    expect((await entriesOf("globex")).map((e) => e.cell_id)).toEqual(["us-1"]);
  });

  it("claims under the new workspace's own id and activates after the commit", async () => {
    const res = await op("/workspaces", {
      method: "POST",
      body: JSON.stringify({
        slug: "initech",
        name: "Initech",
        legalName: "Initech GmbH",
        country: "DE",
        ownerEmail: "bill@initech.test",
        planId: null,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await entriesOf("initech")).toEqual([
      { workspace_id: id, cell_id: "eu-1", state: "active" },
    ]);
    expect(await seededPrivacyNotice(id)).toContain(`Data is stored in ${LABEL}`);
    // The other cell cannot take it now.
    expect(
      await remote.claimSlug({ workspaceId: randomUUID(), slug: "initech", cellId: "us-1" }),
    ).toBe("taken");
  });

  it("releases the claim when the provisioning transaction fails after it", async () => {
    hookMode.fail = true;
    try {
      await expect(
        provisionWorkspace(
          running.container.controlPlane.operators.provisioning,
          provisioningInput("umbrella"),
        ),
      ).rejects.toThrow("hook refused");
    } finally {
      hookMode.fail = false;
    }
    expect(await cellQuery(`SELECT id FROM core.workspace WHERE slug = 'umbrella'`)).toEqual([]);
    const entries = await entriesOf("umbrella");
    expect(entries.map((e) => e.state)).toEqual(["deleted"]);
    // Free for everybody again.
    await remoteWorkspace("umbrella");
  });

  it("maps an unreachable directory to directory_unavailable, creating nothing", async () => {
    const deps = running.container.controlPlane.operators.provisioning;
    const down = {
      ...deps,
      directory: {
        ...running.container.directory,
        claimSlug: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    };
    const error = await provisionWorkspace(down, provisioningInput("offline")).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).reason).toBe("directory_unavailable");
    expect(await cellQuery(`SELECT id FROM core.workspace WHERE slug = 'offline'`)).toEqual([]);
  });
});

describe("signup", () => {
  it("says a slug another cell holds is unavailable, and verify refuses it with slug_taken", async () => {
    await remoteWorkspace("hooli");
    const slug = await request(CANON, "/api/v1/signup/slug?slug=hooli");
    expect(((await slug.json()) as { available: boolean }).available).toBe(false);
    const free = await request(CANON, "/api/v1/signup/slug?slug=pied-piper");
    expect(((await free.json()) as { available: boolean }).available).toBe(true);

    const res = await signup("gavin@hooli.test", "hooli");
    expect(res.status).toBe(409);
    expect((await errorBody(res))["code"]).toBe("slug_taken");
    expect(JSON.stringify(await res.clone().json())).not.toContain("us-1");
    expect(await cellQuery(`SELECT id FROM core.workspace WHERE slug = 'hooli'`)).toEqual([]);
  });

  it("claims and activates a free slug", async () => {
    const res = await signup("richard@piedpiper.test", "pied-piper");
    expect(res.status).toBe(201);
    const [ws] = await cellQuery<{ id: string }>(
      `SELECT id::text FROM core.workspace WHERE slug = 'pied-piper'`,
    );
    expect(await entriesOf("pied-piper")).toEqual([
      { workspace_id: (ws as { id: string }).id, cell_id: "eu-1", state: "active" },
    ]);
  });
});

describe("the demo seed", () => {
  it("refuses a slug another cell holds, and claims its own", async () => {
    await remoteWorkspace("demo-held");
    await expect(seedDemo(running.container, { slug: "demo-held" })).rejects.toThrow(
      /taken by a workspace of another cell/u,
    );
    const seeded = await seedDemo(running.container, { slug: "demo-here" });
    expect(await entriesOf("demo-here")).toEqual([
      { workspace_id: seeded.workspaceId, cell_id: "eu-1", state: "active" },
    ]);
    // --reset replaces it: the old entry is released and the new workspace claims the slug.
    const again = await seedDemo(running.container, { slug: "demo-here", reset: true });
    const entries = await entriesOf("demo-here");
    expect(entries.find((e) => e.state === "active")?.workspace_id).toBe(again.workspaceId);
    expect(entries.find((e) => e.workspace_id === seeded.workspaceId)?.state).toBe("deleted");
  });

  // E-UP-13 fix round 2: the own cell is asked before `--reset` deletes anything.
  it("--reset on a draining own cell refuses and leaves the old demo intact", async () => {
    const seeded = await seedDemo(running.container, { slug: "demo-keep" });
    const before = { id: seeded.workspaceId };
    await cellQuery(
      `BEGIN; SELECT set_config('app.actor_kind', 'host', true);
       UPDATE core.cell SET status = 'draining' WHERE id = 'eu-1'; COMMIT;`,
    );
    try {
      await expect(seedDemo(running.container, { slug: "demo-keep", reset: true })).rejects.toThrow(
        OwnCellUnavailableError,
      );
      expect(
        await cellQuery(
          `SELECT id::text AS id FROM core.workspace WHERE slug = 'demo-keep' AND deleted_at IS NULL`,
        ),
      ).toEqual([before]);
      expect((await entriesOf("demo-keep")).find((e) => e.workspace_id === before?.id)?.state).toBe(
        "active",
      );
    } finally {
      await cellQuery(
        `BEGIN; SELECT set_config('app.actor_kind', 'host', true);
         UPDATE core.cell SET status = 'active' WHERE id = 'eu-1'; COMMIT;`,
      );
    }
  });
});

describe("the purge", () => {
  it("keeps the slug through the restore window and releases it when the workspace is purged", async () => {
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("soylent"),
    );
    const lifecycle = {
      db: running.container.db,
      audit: running.container.audit,
      directory: running.container.directory,
    };
    await softDeleteWorkspace(lifecycle, systemContext(ws.id));
    // R2-3: soft-deleted = `dormant`: still held for the 30-day restore window (nobody can take
    // it), but no longer routed — another cell sees it exactly like a slug that never existed.
    expect((await entriesOf("soylent"))[0]?.state).toBe("dormant");
    expect(await remote.lookupSlug("soylent")).toBeNull();
    expect(await remote.lookupSlug("never-was-here")).toBeNull();
    expect(
      await remote.claimSlug({ workspaceId: randomUUID(), slug: "soylent", cellId: "us-1" }),
    ).toBe("taken");
    // Restored: routed again; deleted again for the purge below.
    await restoreWorkspace(lifecycle, ws.id);
    expect((await entriesOf("soylent"))[0]?.state).toBe("active");
    expect((await remote.lookupSlug("soylent"))?.cellId).toBe("eu-1");
    await softDeleteWorkspace(lifecycle, systemContext(ws.id));
    expect((await entriesOf("soylent"))[0]?.state).toBe("dormant");
    const result = await purgeDeletedWorkspaces({
      db: running.container.db,
      audit: running.container.audit,
      directory: running.container.directory,
      now: () => new Date(Date.now() + 31 * 24 * 3600_000),
    });
    expect(result.purged).toContain(ws.id);
    expect((await entriesOf("soylent"))[0]?.state).toBe("deleted");
    await remoteWorkspace("soylent");
  });
});

// --- hostnames ----------------------------------------------------------------------------------

describe("custom domains", () => {
  it("a hostname verified in another cell does not verify here, and the answer names nobody", async () => {
    const remoteId = await remoteWorkspace("vandelay");
    expect(
      await remote.claimHost({ hostname: "ir.kramerica-group.com", workspaceId: remoteId }),
    ).toBe("claimed");
    const local = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("kramerica"),
    );
    const ctx = systemContext(local.id);
    const { customDomains } = running.container;
    const added = await customDomains.add(ctx, { hostname: "ir.kramerica-group.com" });
    const [row] = await cellQuery<{ token: string }>(
      `SELECT token FROM core.custom_domain WHERE id = $1`,
      [added.id],
    );
    publishRecord("ir.kramerica-group.com", "CNAME", [CANON]);
    publishRecord(`${CHALLENGE_LABEL}.ir.kramerica-group.com`, "TXT", [
      (row as { token: string }).token,
    ]);

    const refused = await customDomains.check(ctx, added.id);
    expect(refused?.status).toBe("pending");
    expect(refused?.detail).toContain("already verified for another workspace");
    expect(refused?.detail).not.toMatch(/vandelay|us-1/u);
    expect(refused?.consecutiveFailures).toBe(1);
    expect((await remote.lookupHost("ir.kramerica-group.com"))?.cellId).toBe("us-1");

    // Released there: verifies here, and the directory routes it to this cell.
    await remote.releaseHost({ hostname: "ir.kramerica-group.com", workspaceId: remoteId });
    const verified = await customDomains.check(ctx, added.id);
    expect(verified?.status).toBe("dns_ok");
    expect((await remote.lookupHost("ir.kramerica-group.com"))?.cellId).toBe("eu-1");
    expect(
      await remote.claimHost({ hostname: "ir.kramerica-group.com", workspaceId: remoteId }),
    ).toBe("taken");

    // Removed: released for everybody.
    expect(await customDomains.remove(ctx, added.id)).toBe(true);
    expect(await remote.lookupHost("ir.kramerica-group.com")).toBeNull();
  });
});

// --- operator surfaces --------------------------------------------------------------------------

describe("GET /platform/cells", () => {
  it("lists this database's cells with counts and heartbeats, then remote cells without counts", async () => {
    const res = await op("/cells");
    expect(res.status).toBe(200);
    const { cells } = (await res.json()) as {
      cells: {
        id: string;
        local: boolean;
        workspaces: number | null;
        heartbeatAt: string | null;
        createdAt: string | null;
        region: string;
        regionLabel: string;
      }[];
    };
    const byId = new Map(cells.map((c) => [c.id, c]));
    expect(byId.get("eu-1")).toMatchObject({ local: true, region: "eu", regionLabel: LABEL });
    expect(byId.get("eu-1")?.workspaces).toBeGreaterThan(0);
    expect(byId.get("eu-1")?.heartbeatAt).not.toBeNull();
    expect(byId.get("us-1")).toMatchObject({
      local: false,
      region: "us",
      regionLabel: "United States (Virginia)",
      workspaces: null,
      createdAt: null,
    });
    expect(byId.get("us-1")?.heartbeatAt).not.toBeNull();
    // Local first.
    expect(cells.findIndex((c) => !c.local)).toBeGreaterThan(cells.findIndex((c) => c.local));
  });
});

describe("PATCH /platform/workspaces/{id} with a cell of another database", () => {
  it("is 409 move_unavailable (use_move); a local or unknown cell behaves as before", async () => {
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("wonka"),
    );
    const patch = (cellId: string) =>
      op(`/workspaces/${ws.id}`, { method: "PATCH", body: JSON.stringify({ cellId }) });
    const remoteCell = await patch("us-1");
    expect(remoteCell.status).toBe(409);
    expect(await errorBody(remoteCell)).toMatchObject({
      code: "move_unavailable",
      reason: "use_move",
    });
    const unknown = await patch("nowhere-1");
    expect(unknown.status).toBe(400);
    expect(await errorBody(unknown)).toMatchObject({ code: "invalid_request", field: "cellId" });
    expect((await patch("eu-1")).status).toBe(200);
    const [row] = await cellQuery<{ cell_id: string }>(
      `SELECT cell_id FROM core.workspace WHERE id = $1`,
      [ws.id],
    );
    expect(row?.cell_id).toBe("eu-1");
  });
});

describe("fix round 1", () => {
  it("R2-8: a label-cell change re-points the directory entry at once", async () => {
    await cellQuery(`INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-4', 'eu', '')`);
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("oceanic"),
    );
    expect((await entriesOf("oceanic"))[0]?.cell_id).toBe("eu-1");
    const res = await op(`/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cellId: "eu-4" }),
    });
    expect(res.status).toBe(200);
    expect(await entriesOf("oceanic")).toEqual([
      { workspace_id: ws.id, cell_id: "eu-4", state: "active" },
    ]);
    expect((await remote.lookupSlug("oceanic"))?.cellId).toBe("eu-4");
  });

  it("RR3-2: a workspace under a relocation hold keeps its cell (PATCH is 409 relocating)", async () => {
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("mid-move"),
    );
    await cellQuery(`INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-5', 'eu', '')`);
    await cellQuery(
      `BEGIN;
       SELECT set_config('app.actor_kind', 'host', true);
       UPDATE core.workspace SET holds = ARRAY['relocation'] WHERE id = '${ws.id}';
       COMMIT;`,
    );
    const res = await op(`/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cellId: "eu-5" }),
    });
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toMatchObject({ code: "conflict", reason: "relocating" });
    const [row] = await cellQuery<{ cell_id: string; holds: string[] }>(
      `SELECT cell_id, holds FROM core.workspace WHERE id = $1`,
      [ws.id],
    );
    expect(row).toEqual({ cell_id: "eu-1", holds: ["relocation"] });
    expect((await entriesOf("mid-move"))[0]?.cell_id).toBe("eu-1");
  });

  it("R1-2: a workspace under a relocation hold cannot be soft-deleted", async () => {
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("dharma"),
    );
    await cellQuery(
      `BEGIN;
       SELECT set_config('app.actor_kind', 'host', true);
       UPDATE core.workspace SET holds = ARRAY['relocation'] WHERE id = '${ws.id}';
       COMMIT;`,
    );
    const error = await softDeleteWorkspace(
      { db: running.container.db, audit: running.container.audit },
      systemContext(ws.id),
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("relocating");
    const [row] = await cellQuery<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM core.workspace WHERE id = $1`,
      [ws.id],
    );
    expect(row?.deleted_at).toBeNull();
  });

  it("R2-3: a restore after the entry was released claims the slug again (or is refused)", async () => {
    const lifecycle = {
      db: running.container.db,
      audit: running.container.audit,
      directory: running.container.directory,
    };
    const a = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("hudsucker"),
    );
    await softDeleteWorkspace(lifecycle, systemContext(a.id));
    await running.container.directory.release(a.id);
    expect((await entriesOf("hudsucker"))[0]?.state).toBe("deleted");
    await restoreWorkspace(lifecycle, a.id);
    expect((await entriesOf("hudsucker"))[0]).toEqual({
      workspace_id: a.id,
      cell_id: "eu-1",
      state: "active",
    });

    const b = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("tyrell"),
    );
    await softDeleteWorkspace(lifecycle, systemContext(b.id));
    await running.container.directory.release(b.id);
    await remoteWorkspace("tyrell");
    const refused = await restoreWorkspace(lifecycle, b.id).catch((e: unknown) => e);
    expect((refused as { code?: string }).code).toBe("slug_taken");
    expect(String((refused as Error).message)).not.toContain("us-1");
    const [row] = await cellQuery<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM core.workspace WHERE id = $1`,
      [b.id],
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it("RR1-7: the soft-deleted source of a finished move cannot be restored", async () => {
    const lifecycle = {
      db: running.container.db,
      audit: running.container.audit,
      directory: running.container.directory,
    };
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("moved-away"),
    );
    await softDeleteWorkspace(lifecycle, systemContext(ws.id));
    // What the moves engine leaves on a switched source: soft-deleted, still held `relocation`.
    await cellQuery(
      `BEGIN;
       SELECT set_config('app.actor_kind', 'host', true);
       UPDATE core.workspace SET holds = ARRAY['relocation'] WHERE id = '${ws.id}';
       COMMIT;`,
    );
    const refused = await restoreWorkspace(lifecycle, ws.id).catch((e: unknown) => e);
    expect((refused as { code?: string }).code).toBe("moved");
    const [row] = await cellQuery<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM core.workspace WHERE id = $1`,
      [ws.id],
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it("RR1-8: a hostname claim refused for want of an entry repairs the entry and verifies", async () => {
    const ws = await provisionWorkspace(
      running.container.controlPlane.operators.provisioning,
      provisioningInput("entryless"),
    );
    // The entry never made it (a pre-E3.11 workspace before the first sweep).
    await dirQuery(`DELETE FROM directory.workspace WHERE workspace_id = $1`, [ws.id]);
    const ctx = systemContext(ws.id);
    const { customDomains } = running.container;
    const added = await customDomains.add(ctx, { hostname: "ir.entryless-corp.com" });
    const [row] = await cellQuery<{ token: string }>(
      `SELECT token FROM core.custom_domain WHERE id = $1`,
      [added.id],
    );
    publishRecord("ir.entryless-corp.com", "CNAME", [CANON]);
    publishRecord(`${CHALLENGE_LABEL}.ir.entryless-corp.com`, "TXT", [
      (row as { token: string }).token,
    ]);
    expect((await customDomains.check(ctx, added.id))?.status).toBe("dns_ok");
    expect(await entriesOf("entryless")).toEqual([
      { workspace_id: ws.id, cell_id: "eu-1", state: "active" },
    ]);
    expect((await remote.lookupHost("ir.entryless-corp.com"))?.cellId).toBe("eu-1");
  });

  it("R2-7: the public slug hint is cached and budgeted — it cannot drain the directory", async () => {
    // Thirty slugs held by the other cell, asked for at once: the per-process directory budget
    // (10/s) answers the rest from "did not look" (available — verify is the authority).
    const slugs = Array.from({ length: 30 }, (_, i) => `busy-${i}`);
    for (const slug of slugs) await remoteWorkspace(slug);
    const answers = await Promise.all(
      slugs.map(async (slug) => {
        const res = await request(CANON, `/api/v1/signup/slug?slug=${slug}`);
        expect(res.status).toBe(200);
        return ((await res.json()) as { available: boolean }).available;
      }),
    );
    const looked = answers.filter((a) => !a).length;
    expect(looked).toBeGreaterThan(0);
    expect(looked).toBeLessThanOrEqual(20);
    // Cached: a slug the other cell released a moment ago still reads as taken.
    const cachedSlug = "cached-hint";
    const id = await remoteWorkspace(cachedSlug);
    await new Promise((r) => setTimeout(r, 1_100));
    const first = await request(CANON, `/api/v1/signup/slug?slug=${cachedSlug}`);
    expect(((await first.json()) as { available: boolean }).available).toBe(false);
    await remote.release(id);
    const second = await request(CANON, `/api/v1/signup/slug?slug=${cachedSlug}`);
    expect(((await second.json()) as { available: boolean }).available).toBe(false);
  });
});

describe("GET /signup/regions", () => {
  it("offers this region here and each other active, reachable region at its own origin", async () => {
    const res = await request(CANON, "/api/v1/signup/regions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { region: "eu", label: LABEL, jurisdiction: "eu", signupUrl: null },
        {
          region: "us",
          label: "United States (Virginia)",
          jurisdiction: "us",
          signupUrl: "https://us.example.test/signup",
        },
      ],
    });
  });

  it("is a plain 404 on a tenant host", async () => {
    const res = await request(`demo-here.${CANON}`, "/api/v1/signup/regions");
    expect(res.status).toBe(404);
  });
});

describe("fundroom cell add", () => {
  async function cell(argv: string[], dataRegion?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cellsCommand(argv, {
      db: running.container.db,
      audit: running.container.audit,
      dataRegion,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("takes a label and a jurisdiction, and refuses another region with a clear message", async () => {
    const added = await cell(
      [
        "add",
        "eu-2",
        "--region",
        "eu",
        "--origin",
        "https://eu-2.example.test",
        "--label",
        "EU (Paris)",
        "--jurisdiction",
        "eu",
      ],
      "eu",
    );
    expect(added.code).toBe(0);
    const [row] = await cellQuery(
      `SELECT region_label, jurisdiction FROM core.cell WHERE id = 'eu-2'`,
    );
    expect(row).toEqual({ region_label: "EU (Paris)", jurisdiction: "eu" });

    const declared = await cell(
      ["add", "us-9", "--region", "us", "--origin", "https://us-9.example.test"],
      "eu",
    );
    expect(declared.code).toBe(2);
    expect(declared.err).toContain("DATA_REGION=eu");
    // Without DATA_REGION the database trigger decides; its words, not a constraint dump.
    const trigger = await cell([
      "add",
      "us-9",
      "--region",
      "us",
      "--origin",
      "https://us-9.example.test",
    ]);
    expect(trigger.code).toBe(2);
    expect(trigger.err).toContain("one database = one region");
    expect(trigger.err).not.toContain("23514");
    const bad = await cell(
      [
        "add",
        "eu-3",
        "--region",
        "eu",
        "--origin",
        "https://eu-3.example.test",
        "--jurisdiction",
        "mars",
      ],
      "eu",
    );
    expect(bad.code).toBe(2);
    expect(await cellQuery(`SELECT id FROM core.cell WHERE id IN ('us-9', 'eu-3')`)).toEqual([]);
  });
});
