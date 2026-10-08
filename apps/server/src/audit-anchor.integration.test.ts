import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorVerifier,
  anchorPending,
  exportPublicKeys,
  listAnchorPage,
  readAnchorProof,
  verifyExportBundle,
  verifyWorkspace,
  writeAllCheckpoints,
  writeCheckpoint,
} from "@fundroom/audit";
import { createFakeAnchor, type FakeAnchor } from "@fundroom/audit/testing";
import { loadConfig } from "@fundroom/config";
import {
  createDatabase,
  createWorkspace,
  PLATFORM_WORKSPACE_ID,
  platformContext,
  systemContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAuditAnchor, runAuditVerifyAnchor } from "./cli-commands/audit-anchor.js";
import { runAuditVerifyExport } from "./cli-commands/audit-verify-export.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E3.13 external audit anchoring, end to end against a real server and Postgres, with two
 * in-memory anchor drivers (`@fundroom/audit/testing` `createFakeAnchor`): batching across
 * workspaces and the platform chain, per-workspace proofs, tamper detection, export bundle v2
 * through the CLI function, route permissions, driver retries, concurrent runs and a
 * one-connection pool. The off state lives in audit-anchor-off.integration.test.ts.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let tsa: FakeAnchor;
let log: FakeAnchor;
let verifiers: Record<string, AnchorVerifier>;

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  return { cookie, membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "legal" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function recordEvents(workspaceId: string, n: number): Promise<void> {
  const ctx = systemContext(workspaceId);
  for (let i = 0; i < n; i++) {
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.audit.record(tx, ctx, {
        action: "grant.changed",
        resourceKind: "grant",
        meta: { i },
      }),
    );
  }
}

/** Superuser SQL (bypasses RLS and the app role), for counting and tampering. */
async function su<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

/** Superuser: move a batch's created_at back (its immutable trigger disabled for the UPDATE). */
async function backdateBatch(batchId: string, days: number): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit.anchor_batch DISABLE TRIGGER anchor_batch_immutable");
    await client.query(
      "UPDATE audit.anchor_batch SET created_at = created_at - make_interval(days => $2::int) WHERE id = $1",
      [batchId, days],
    );
    await client.query("ALTER TABLE audit.anchor_batch ENABLE TRIGGER anchor_batch_immutable");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

const opts = () => ({
  db: running.container.db,
  drivers: [tsa, log],
  keyRing: running.container.config.keyRing,
  audit: running.container.audit,
});

let acmeId: string;
let globexId: string;
let owner: Actor;
let admin: Actor;
let counsel: Actor;
let editor: Actor;
let ada: Actor;
let globexOwner: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  tsa = createFakeAnchor({ kind: "faketsa" });
  log = createFakeAnchor({ kind: "fakelog" });
  verifiers = { faketsa: tsa.verify, fakelog: log.verify };
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
    auditAnchorDrivers: [tsa, log],
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  admin = await member("acme", acmeId, "admin@example.com", "staff", "admin");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  await recordEvents(acmeId, 3);
  await recordEvents(globexId, 2);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

afterEach(() => {
  tsa.setFailing(null);
  log.setFailing(null);
  vi.restoreAllMocks();
});

let firstBatch: string;

describe("an anchoring run", () => {
  it("registers the audit.anchor job when drivers are configured", () => {
    const job = running.container.jobs.find((j) => j.name === "audit.anchor");
    expect(job?.cron).toBe("40 2 * * *");
  });

  it("batches every workspace's and the platform's checkpoints into one tree and anchors the root", async () => {
    await writeAllCheckpoints({
      db: running.container.db,
      keyRing: running.container.config.keyRing,
    });
    const pending = await su<{ workspace_id: string; id: string }>(
      "SELECT workspace_id, id FROM audit.checkpoint ORDER BY created_at, id",
    );
    const owners = new Set(pending.map((p) => p.workspace_id));
    expect(owners).toEqual(new Set([PLATFORM_WORKSPACE_ID, acmeId, globexId]));

    const r = await anchorPending(opts());
    expect(r.batchId).not.toBeNull();
    firstBatch = r.batchId as string;
    expect(r.leaves).toBe(pending.length);
    expect(r.receipts).toEqual([
      { batchId: firstBatch, kind: "faketsa", ok: true },
      { batchId: firstBatch, kind: "fakelog", ok: true },
    ]);
    const anchors = await su<{ checkpoint_id: string; leaf_index: number; reference: string }>(
      "SELECT checkpoint_id, leaf_index, reference FROM audit.anchor WHERE kind = 'merkle' ORDER BY leaf_index",
    );
    expect(anchors.map((a) => a.checkpoint_id)).toEqual(pending.map((p) => p.id));
    expect(new Set(anchors.map((a) => a.reference))).toEqual(new Set([firstBatch]));
    const [batch] = await su<{ root: string; leaf_count: number }>(
      "SELECT encode(merkle_root, 'hex') AS root, leaf_count FROM audit.anchor_batch WHERE id = $1",
      [firstBatch],
    );
    expect(batch?.leaf_count).toBe(pending.length);
    expect(tsa.anchored).toEqual([batch?.root]);
    expect(log.anchored).toEqual([batch?.root]);
    expect(
      await su("SELECT kind FROM audit.anchor_receipt WHERE batch_id = $1 ORDER BY kind", [
        firstBatch,
      ]),
    ).toEqual([{ kind: "fakelog" }, { kind: "faketsa" }]);
  });

  it("records audit.anchored on the platform chain only", async () => {
    const platform = await su<{ meta: Record<string, unknown>; resource_id: string }>(
      "SELECT meta, resource_id FROM audit.event WHERE action = 'audit.anchored' AND workspace_id = $1",
      [PLATFORM_WORKSPACE_ID],
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]?.resource_id).toBe(firstBatch);
    expect(platform[0]?.meta).toMatchObject({
      batchId: firstBatch,
      kinds: ["faketsa", "fakelog"],
      failures: [],
    });
    expect(
      await su("SELECT 1 FROM audit.event WHERE action = 'audit.anchored' AND workspace_id <> $1", [
        PLATFORM_WORKSPACE_ID,
      ]),
    ).toHaveLength(0);
  });

  it("a second run with nothing new builds no batch and calls no driver", async () => {
    const before = tsa.calls();
    const r = await anchorPending(opts());
    expect(r).toEqual({
      batchId: null,
      batchIds: [],
      leaves: 0,
      skipped: 0,
      skippedCheckpointIds: [],
      receipts: [],
    });
    expect(tsa.calls()).toBe(before);
  });

  it("verify checks every anchored checkpoint (path + receipts) and reports a summary", async () => {
    const v = await verifyWorkspace(
      {
        db: running.container.db,
        keyRing: running.container.config.keyRing,
        anchorDrivers: [tsa, log],
      },
      acmeId,
    );
    expect(v.problems).toEqual([]);
    expect(v.anchors).toEqual({
      checked: v.checkpoints,
      verified: v.checkpoints,
      unverifiedOrigin: 0,
      failed: 0,
      missing: 0,
      late: 0,
      presenceOnly: 0,
    });
    const platform = await verifyWorkspace(
      { db: running.container.db, anchorDrivers: [tsa, log] },
      PLATFORM_WORKSPACE_ID,
    );
    expect(platform.ok).toBe(true);
    expect(platform.anchors.verified).toBeGreaterThan(0);
  });
});

describe("routes", () => {
  it("GET /audit/anchors: owner, admin and legal read; editor 403; investor 404", async () => {
    for (const a of [owner, admin, counsel]) {
      const res = await request("acme", "/api/v1/audit/anchors", { cookie: a.cookie });
      expect(res.status).toBe(200);
    }
    expect((await request("acme", "/api/v1/audit/anchors", { cookie: editor.cookie })).status).toBe(
      403,
    );
    expect((await request("acme", "/api/v1/audit/anchors", { cookie: ada.cookie })).status).toBe(
      404,
    );
    expect((await request("acme", "/api/v1/audit/anchors")).status).toBe(401);
  });

  it("lists this workspace's checkpoints, newest first, with receipts, and pages", async () => {
    await recordEvents(acmeId, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      acmeId,
    );
    const res = await request("acme", "/api/v1/audit/anchors?limit=1", { cookie: owner.cookie });
    const page = await json<{
      configured: string[];
      items: {
        checkpointId: string;
        seq: number;
        anchored: boolean;
        batchId: string | null;
        receipts: { kind: string }[];
      }[];
      nextCursor: string | null;
    }>(res);
    expect(page.configured).toEqual(["faketsa", "fakelog"]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      anchored: false,
      state: "pending",
      batchId: null,
      receipts: [],
    });
    expect(page.nextCursor).not.toBeNull();
    const next = await json<typeof page>(
      await request("acme", `/api/v1/audit/anchors?limit=10&cursor=${page.nextCursor}`, {
        cookie: owner.cookie,
      }),
    );
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items[0]?.seq).toBeLessThan(page.items[0]?.seq ?? 0);
    expect(next.items[0]).toMatchObject({ anchored: true, state: "anchored", batchId: firstBatch });
    expect(next.items[0]?.receipts.map((r) => r.kind).sort()).toEqual(["fakelog", "faketsa"]);
    const all = await su<{ workspace_id: string; id: string }>(
      "SELECT workspace_id, id FROM audit.checkpoint",
    );
    const listed = new Set([...page.items, ...next.items].map((i) => i.checkpointId));
    for (const cp of all) expect(listed.has(cp.id)).toBe(cp.workspace_id === acmeId);
    expect(
      (await request("acme", "/api/v1/audit/anchors?cursor=bm9wZQ", { cookie: owner.cookie }))
        .status,
    ).toBe(400);
    // Anchor the new checkpoint for the rest of the file.
    await anchorPending(opts());
  });

  it("GET /audit/verify carries the anchors summary", async () => {
    const res = await request("acme", "/api/v1/audit/verify", { cookie: owner.cookie });
    const body = await json<{ ok: boolean; anchors: Record<string, number>; checkpoints: number }>(
      res,
    );
    expect(body.ok).toBe(true);
    expect(body.anchors).toEqual({
      checked: body.checkpoints,
      verified: body.checkpoints,
      unverifiedOrigin: 0,
      failed: 0,
      missing: 0,
      late: 0,
      presenceOnly: 0,
    });
  });

  it("the proof: owner and legal download it, admin 403, investor 404, another workspace's 404", async () => {
    const [cp] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 ORDER BY seq LIMIT 1",
      [acmeId],
    );
    const [foreign] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 LIMIT 1",
      [globexId],
    );
    const path = (id: string) => `/api/v1/audit/anchors/${id}/proof`;
    const ok = await request("acme", path(cp!.id), { cookie: owner.cookie });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(
      /attachment; filename="anchor-proof-acme-/u,
    );
    expect((await request("acme", path(cp!.id), { cookie: counsel.cookie })).status).toBe(200);
    expect((await request("acme", path(cp!.id), { cookie: admin.cookie })).status).toBe(403);
    expect((await request("acme", path(cp!.id), { cookie: ada.cookie })).status).toBe(404);
    expect((await request("acme", path(foreign!.id), { cookie: owner.cookie })).status).toBe(404);
    expect(
      (await request("globex", path(foreign!.id), { cookie: globexOwner.cookie })).status,
    ).toBe(200);
  });
});

describe("a per-workspace proof", () => {
  let proofFile: string;
  let proofText: string;

  beforeAll(async () => {
    const [cp] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 ORDER BY seq LIMIT 1",
      [acmeId],
    );
    const res = await request("acme", `/api/v1/audit/anchors/${cp!.id}/proof`, {
      cookie: owner.cookie,
    });
    proofText = await res.text();
    proofFile = join(mkdtempSync(join(tmpdir(), "fundroom-proof-")), "proof.json");
    writeFileSync(proofFile, proofText);
  });

  it("verifies offline with the CLI function", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runAuditVerifyAnchor([proofFile], verifiers)).toBe(0);
  });

  it("contains no other workspace's ids and no other checkpoint's facts", async () => {
    const others = await su<{ id: string; workspace_id: string; event_id: string; hash: string }>(
      "SELECT id, workspace_id, event_id, encode(hash, 'hex') AS hash FROM audit.checkpoint WHERE workspace_id <> $1",
      [acmeId],
    );
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      for (const secret of [o.id, o.workspace_id, o.event_id, o.hash]) {
        expect(proofText).not.toContain(secret);
      }
    }
    const doc = JSON.parse(proofText) as { checkpoint: { workspace_id: string } };
    expect(doc.checkpoint.workspace_id).toBe(acmeId);
  });

  it("a doctored proof fails (exit 1); an unpinned signer is UNVERIFIED ORIGIN (exit 3)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const doc = JSON.parse(proofText) as { checkpoint: { seq: number } };
    doc.checkpoint.seq += 1;
    const bad = join(mkdtempSync(join(tmpdir(), "fundroom-proof-")), "bad.json");
    writeFileSync(bad, JSON.stringify(doc));
    expect(await runAuditVerifyAnchor([bad], verifiers)).toBe(1);
    expect(lines.join("\n")).toContain("anchor_path_invalid");
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(await runAuditVerifyAnchor([proofFile, "--anchor-cert", pem], verifiers)).toBe(3);
    expect(lines.join("\n")).toContain("UNVERIFIED ORIGIN");
    expect(await runAuditVerifyAnchor([], verifiers)).toBe(2);
  });
});

describe("tampering", () => {
  it("a checkpoint row rewritten by a superuser is detected by the anchor even without the key ring", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "tamper", name: "Tamper" })).id;
    await recordEvents(ws, 2);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    await anchorPending(opts());
    const clean = await verifyWorkspace(
      { db: running.container.db, anchorDrivers: [tsa, log] },
      ws,
    );
    expect(clean.ok).toBe(true);
    expect(clean.anchors.verified).toBe(1);

    // The superuser moves the head time: hash and seq still match the event row, so without the
    // key ring only the anchor (leaf recomputed from the row) can notice.
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit.checkpoint DISABLE TRIGGER checkpoint_immutable");
      await client.query(
        "UPDATE audit.checkpoint SET head_occurred_at = head_occurred_at + interval '1 second' WHERE workspace_id = $1",
        [ws],
      );
      await client.query("ALTER TABLE audit.checkpoint ENABLE TRIGGER checkpoint_immutable");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const v = await verifyWorkspace({ db: running.container.db, anchorDrivers: [tsa, log] }, ws);
    expect(v.ok).toBe(false);
    expect(v.anchors).toMatchObject({ checked: 1, failed: 1, verified: 0 });
    expect(v.anchorProblems.map((p) => p.code)).toEqual(["anchor_path_invalid"]);
    // FIX2 A12: the head time is bound to the head row as well.
    expect(v.problems.some((p) => p.includes("head time differs from the row"))).toBe(true);
    expect(v.problems.some((p) => p.startsWith("anchor_path_invalid: checkpoint "))).toBe(true);
  });

  it("a doctored stored path or a forged receipt fails too", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "tamper2", name: "Tamper 2" }))
      .id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    const r = await anchorPending(opts());
    // Verified (and cached in-process) before the forgery: the cache must not hide it.
    const before = await verifyWorkspace(
      { db: running.container.db, anchorDrivers: [tsa, log] },
      ws,
    );
    expect(before.anchors.verified).toBe(1);
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE audit.anchor_receipt DISABLE TRIGGER anchor_receipt_immutable",
      );
      await client.query(
        `UPDATE audit.anchor_receipt SET receipt = jsonb_set(receipt, '{proof,mac}', to_jsonb(repeat('0', 64)))
          WHERE batch_id = $1 AND kind = 'faketsa'`,
        [r.batchId],
      );
      await client.query(
        "ALTER TABLE audit.anchor_receipt ENABLE TRIGGER anchor_receipt_immutable",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const v = await verifyWorkspace({ db: running.container.db, anchorDrivers: [tsa, log] }, ws);
    expect(v.ok).toBe(false);
    expect(v.anchorProblems.map((p) => p.code)).toEqual(["anchor_receipt_failed"]);
  });
});

describe("export bundle v2", () => {
  it("round-trips through the CLI function, with and without --require-anchors", async () => {
    const res = await request("acme", "/api/v1/audit/exports", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sync = verifyExportBundle(bytes);
    expect(sync.manifest?.version).toBe(2);
    expect(sync.anchors?.checkpoints).toBeGreaterThan(0);
    expect(sync.anchors?.anchored).toBe(sync.anchors?.checkpoints);
    const file = join(mkdtempSync(join(tmpdir(), "fundroom-export-")), "bundle.zip");
    writeFileSync(file, bytes);
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey as string;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    expect(
      await runAuditVerifyExport(
        [file, "--public-key", key, "--require-anchors"],
        undefined,
        verifiers,
      ),
    ).toBe(0);
    expect(lines.join("\n")).toMatch(
      /anchors: (\d+) of \1 checkpoint\(s\) anchored — \1 verified/u,
    );
    // Pinned to a signer the receipts do not carry: chain verified, anchors unverified origin.
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(
      await runAuditVerifyExport(
        [file, "--public-key", key, "--anchor-cert", pem],
        undefined,
        verifiers,
      ),
    ).toBe(0);
    expect(lines.join("\n")).toContain("no time-verified anchor covers these rows");
    expect(
      await runAuditVerifyExport(
        [file, "--public-key", key, "--anchor-cert", pem, "--require-anchors"],
        undefined,
        verifiers,
      ),
    ).toBe(3);
    // No verifier for the kinds (e.g. a stock CLI on a fake-driver bundle): unchecked → exit 3.
    expect(
      await runAuditVerifyExport([file, "--public-key", key, "--require-anchors"], undefined, {}),
    ).toBe(3);
  });

  it("a checkpoint not anchored yet: coverage stops at the last anchored one, the tail is reported", async () => {
    await recordEvents(acmeId, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      acmeId,
    );
    await recordEvents(acmeId, 1);
    const res = await request("acme", "/api/v1/audit/exports", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    const file = join(mkdtempSync(join(tmpdir(), "fundroom-export-")), "bundle.zip");
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey as string;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    expect(await runAuditVerifyExport([file, "--public-key", key], undefined, verifiers)).toBe(0);
    expect(
      await runAuditVerifyExport(
        [file, "--public-key", key, "--require-anchors"],
        undefined,
        verifiers,
      ),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/anchored through seq \d+ at /u);
    expect(text).toMatch(/seq \d+\.\.\d+: not yet anchored/u);
    await anchorPending(opts());
  });
});

describe("retries", () => {
  it("a failing driver is retried by later runs for the same batch; the healthy one is not re-called", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "retry", name: "Retry" })).id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    log.setFailing("timeout");
    const first = await anchorPending(opts());
    expect(first.batchId).not.toBeNull();
    expect(first.receipts).toEqual([
      { batchId: first.batchId, kind: "faketsa", ok: true },
      { batchId: first.batchId, kind: "fakelog", ok: false, code: "timeout" },
    ]);
    const [event] = await su<{ meta: Record<string, unknown> }>(
      "SELECT meta FROM audit.event WHERE action = 'audit.anchored' AND resource_id = $1",
      [first.batchId],
    );
    expect(event?.meta).toMatchObject({
      kinds: ["faketsa"],
      failures: [{ kind: "fakelog", code: "timeout" }],
    });
    // Between runs the checkpoint is anchored by one receipt: verified, not missing.
    const mid = await verifyWorkspace({ db: running.container.db, anchorDrivers: [tsa, log] }, ws);
    expect(mid.anchors).toMatchObject({ verified: 1, missing: 0 });

    log.setFailing(null);
    const tsaCalls = tsa.calls();
    const second = await anchorPending(opts());
    expect(second).toEqual({
      batchId: null,
      batchIds: [],
      leaves: 0,
      skipped: 0,
      skippedCheckpointIds: [],
      receipts: [{ batchId: first.batchId, kind: "fakelog", ok: true }],
    });
    expect(tsa.calls()).toBe(tsaCalls);
    expect(
      await su("SELECT kind FROM audit.anchor_receipt WHERE batch_id = $1 ORDER BY kind", [
        first.batchId,
      ]),
    ).toEqual([{ kind: "fakelog" }, { kind: "faketsa" }]);
  });

  it("stops retrying after 7 days, and verify then reports the checkpoint as anchor_missing", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "lost", name: "Lost" })).id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    tsa.setFailing("unreachable");
    log.setFailing("rejected");
    const first = await anchorPending(opts());
    expect(first.receipts.every((r) => !r.ok)).toBe(true);
    tsa.setFailing(null);
    log.setFailing(null);
    // Still pending (inside the retry window) in the list.
    const [cp] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1",
      [ws],
    );
    const listed = await running.container.db.withTenant(systemContext(ws), (tx) =>
      listAnchorPage(tx, ws, { limit: 10 }),
    );
    expect(listed.find((i) => i.checkpointId === cp?.id)?.state).toBe("pending");
    // The window is measured on the DATABASE clock: age the batch there, not in the app.
    await backdateBatch(first.batchId as string, 8);
    const calls = tsa.calls();
    const r = await anchorPending(opts());
    expect(r.receipts.filter((x) => x.batchId === first.batchId)).toEqual([]);
    expect(tsa.calls()).toBe(calls);
    // A3: the list now says failed (batched, no receipt, no more retries) — never "anchored".
    const after = await running.container.db.withTenant(systemContext(ws), (tx) =>
      listAnchorPage(tx, ws, { limit: 10 }),
    );
    expect(after.find((i) => i.checkpointId === cp?.id)).toMatchObject({
      anchored: false,
      state: "failed",
    });
    // The batch is kept (anchored path, zero receipts); 9 days on it is reported missing.
    const v = await verifyWorkspace(
      {
        db: running.container.db,
        anchorDrivers: [tsa, log],
        now: new Date(Date.now() + 9 * 86_400_000),
      },
      ws,
    );
    expect(v.anchors).toMatchObject({ checked: 1, missing: 1 });
    expect(v.anchorProblems.map((p) => p.code)).toEqual(["anchor_missing"]);
    // Without anchoring configured nothing is "missing".
    const off = await verifyWorkspace(
      { db: running.container.db, now: new Date(Date.now() + 9 * 86_400_000) },
      ws,
    );
    expect(off.anchors.missing).toBe(0);
  });
});

describe("concurrency", () => {
  it("three simultaneous runs batch every checkpoint exactly once", async () => {
    for (const slug of ["c1", "c2", "c3", "c4"]) {
      const ws = (await createWorkspace(running.container.db, { slug, name: slug })).id;
      await recordEvents(ws, 1);
      await writeCheckpoint(
        { db: running.container.db, keyRing: running.container.config.keyRing },
        ws,
      );
    }
    const pendingBefore = await su<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.checkpoint c
        WHERE NOT EXISTS (SELECT 1 FROM audit.anchor a WHERE a.checkpoint_id = c.id AND a.kind = 'merkle')`,
    );
    expect(pendingBefore[0]?.n).toBeGreaterThanOrEqual(4);
    tsa.setDelay(50);
    try {
      const runs = await Promise.all([
        anchorPending(opts()),
        anchorPending(opts()),
        anchorPending(opts()),
      ]);
      const built = runs.filter((r) => r.batchId !== null);
      expect(runs.reduce((n, r) => n + r.leaves, 0)).toBe(pendingBefore[0]?.n);
      expect(built.length).toBeGreaterThanOrEqual(1);
    } finally {
      tsa.setDelay(0);
    }
    const dup = await su<{ n: number }>(
      "SELECT count(*)::int AS n FROM (SELECT checkpoint_id FROM audit.anchor WHERE kind = 'merkle' GROUP BY checkpoint_id HAVING count(*) > 1) d",
    );
    expect(dup[0]?.n).toBe(0);
    const left = await su<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.checkpoint c
        WHERE NOT EXISTS (SELECT 1 FROM audit.anchor a WHERE a.checkpoint_id = c.id AND a.kind = 'merkle')`,
    );
    expect(left[0]?.n).toBe(0);
    // Each batch still has one receipt per driver (UNIQUE (batch_id, kind)).
    const receipts = await su<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.anchor_receipt GROUP BY batch_id, kind HAVING count(*) > 1",
    );
    expect(receipts).toEqual([]);
  });

  it("works on a one-connection pool (no second connection under a held transaction)", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "solo", name: "Solo" })).id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    const single = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
    try {
      const r = await Promise.race([
        anchorPending({
          db: single,
          drivers: [tsa, log],
          keyRing: running.container.config.keyRing,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("pool deadlock")), 20_000),
        ),
      ]);
      expect(r.leaves).toBeGreaterThanOrEqual(1);
      const v = await verifyWorkspace({ db: single, anchorDrivers: [tsa, log] }, ws);
      expect(v.anchors.verified).toBe(1);
      const [cp] = await su<{ id: string }>(
        "SELECT id FROM audit.checkpoint WHERE workspace_id = $1",
        [ws],
      );
      const proof = await single.withTenant(systemContext(ws), (tx) =>
        readAnchorProof(tx, ws, cp!.id),
      );
      expect(proof?.receipts).toHaveLength(2);
      expect(
        await single.withTenant(platformContext(), (tx) =>
          readAnchorProof(tx, PLATFORM_WORKSPACE_ID, cp!.id),
        ),
      ).toBeUndefined();
    } finally {
      await single.close();
    }
  });
});

describe("FIX1 hardening", () => {
  async function pendingCheckpoint(slug: string): Promise<{ ws: string; cp: string }> {
    const ws = (await createWorkspace(running.container.db, { slug, name: slug })).id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    const [row] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1",
      [ws],
    );
    return { ws, cp: row?.id as string };
  }

  it("A4: only system/host may insert anchor rows, and only for their own workspace's checkpoint", async () => {
    await pendingCheckpoint("fx-seed");
    await anchorPending(opts());
    const a = await pendingCheckpoint("fx-a");
    const b = await pendingCheckpoint("fx-b");
    const [batch] = await su<{ id: string }>("SELECT id FROM audit.anchor_batch LIMIT 1");
    const insert = (cp: string) => `
      INSERT INTO audit.anchor (workspace_id, checkpoint_id, kind, reference, batch_id, leaf_index, proof)
      VALUES ('${a.ws}', '${cp}', 'merkle', '${batch?.id}', '${batch?.id}', 0, '{"leafHash":"00","path":[],"treeSize":1}')`;
    const member = "01920000-0000-7000-8000-0000000000aa";
    // An external (or staff) context in workspace A: refused by the insert policy.
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => "inserted",
        (e: unknown) => {
          const err = e as { message?: string; cause?: { message?: string } };
          return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
        },
      );
    for (const actorKind of ["external", "staff"] as const) {
      expect(
        await failure(
          running.container.db.withTenant(
            { workspaceId: a.ws, actorKind, membershipId: member },
            (tx) => tx.execute(insert(a.cp)),
          ),
        ),
      ).toMatch(/row-level security/u);
    }
    // Even the system context of A cannot point a row at B's checkpoint (same-workspace FK).
    expect(
      await failure(
        running.container.db.withTenant(systemContext(a.ws), (tx) => tx.execute(insert(b.cp))),
      ),
    ).toMatch(/anchor_checkpoint_same_workspace/u);
    await anchorPending(opts());
  });

  it("A4: a conflicting anchor row skips that leaf only; the batch and the rest still anchor", async () => {
    await pendingCheckpoint("race-seed");
    await anchorPending(opts()); // a batch row to point the squatting row at
    const a = await pendingCheckpoint("race-a");
    const b = await pendingCheckpoint("race-b");
    const [batch] = await su<{ id: string }>("SELECT id FROM audit.anchor_batch LIMIT 1");
    // A row for A's checkpoint that the run cannot see when it selects (uncommitted), then commits
    // while the run waits on the unique index.
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO audit.anchor (workspace_id, checkpoint_id, kind, reference, batch_id, leaf_index, proof)
         VALUES ($1, $2, 'merkle', $3::text, $3::text::uuid, 0, '{"leafHash":"00","path":[],"treeSize":1}')`,
        [a.ws, a.cp, batch?.id],
      );
      const run = anchorPending(opts());
      for (let i = 0; i < 100; i++) {
        const waiting = await pg.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO audit.anchor (%' AND pid <> pg_backend_pid()",
        );
        if (waiting.rowCount) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await client.query("COMMIT");
      const r = await run;
      expect(r.skipped).toBe(1);
      expect(r.batchId).not.toBeNull();
      const anchored = await su<{ batch_id: string }>(
        "SELECT batch_id FROM audit.anchor WHERE checkpoint_id = $1 AND kind = 'merkle'",
        [b.cp],
      );
      expect(anchored[0]?.batch_id).toBe(r.batchId);
      // FIX2 A13: the committed tree was rebuilt without A's leaf.
      const [count] = await su<{ leaf_count: number; rows: number }>(
        `SELECT b.leaf_count, (SELECT count(*)::int FROM audit.anchor a WHERE a.batch_id = b.id) AS rows
           FROM audit.anchor_batch b WHERE b.id = $1`,
        [r.batchId],
      );
      expect(count?.leaf_count).toBe(count?.rows);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  it("A7: a large backlog is paged into several batches in one run", async () => {
    for (const slug of ["pg1", "pg2", "pg3", "pg4", "pg5"]) await pendingCheckpoint(slug);
    const r = await anchorPending({ ...opts(), maxBatchLeaves: 2 });
    expect(r.batchIds).toHaveLength(3);
    expect(r.leaves).toBe(5);
    const sizes = await su<{ leaf_count: number }>(
      "SELECT leaf_count FROM audit.anchor_batch WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
      [r.batchIds],
    );
    expect(sizes.map((x) => x.leaf_count)).toEqual([2, 2, 1]);
  });

  it("A8: a receipt that is not `verified` against the driver's pins is never stored", async () => {
    await pendingCheckpoint("unpinned");
    const unpinned = {
      ...tsa,
      kind: "faketsa",
      anchor: (d: Uint8Array) => tsa.anchor(d),
      verify: async () => ({ status: "unverified_origin" as const, detail: "signer not pinned" }),
    };
    const r = await anchorPending({ ...opts(), drivers: [unpinned] });
    expect(r.receipts).toEqual([
      { batchId: r.batchId, kind: "faketsa", ok: false, code: "verification_failed" },
    ]);
    expect(await su("SELECT 1 FROM audit.anchor_receipt WHERE batch_id = $1", [r.batchId])).toEqual(
      [],
    );
    await anchorPending(opts());
  });

  it("H1/H2 on the server: presence-only and late anchors are not `verified`", async () => {
    const p = await pendingCheckpoint("presence");
    const rekorish = createFakeAnchor({ kind: "fakelog", timeTrusted: false });
    await anchorPending({ ...opts(), drivers: [rekorish] });
    const v = await verifyWorkspace({ db: running.container.db, anchorDrivers: [rekorish] }, p.ws);
    expect(v.anchors).toMatchObject({ checked: 1, verified: 0, presenceOnly: 1 });

    const l = await pendingCheckpoint("late");
    const lateTsa = createFakeAnchor({
      kind: "faketsa",
      now: () => new Date(Date.now() + 10 * 86_400_000),
    });
    await anchorPending({ ...opts(), drivers: [lateTsa] });
    const lv = await verifyWorkspace({ db: running.container.db, anchorDrivers: [lateTsa] }, l.ws);
    expect(lv.anchors).toMatchObject({ checked: 1, verified: 0, late: 1 });
    expect(lv.anchorProblems.map((x) => x.code)).toEqual(["anchor_late"]);
    expect(lv.problems.some((x) => x.startsWith("anchor_late: "))).toBe(true);
    // A warning: history anchored when anchoring was first enabled is late by construction.
    expect(lv.ok).toBe(true);
  });

  it("A6: GET /audit/verify is rate-limited per member", async () => {
    let last = 200;
    for (let i = 0; i < 8 && last === 200; i++) {
      last = (await request("acme", "/api/v1/audit/verify", { cookie: counsel.cookie })).status;
    }
    expect(last).toBe(429);
    // Another member is unaffected.
    expect((await request("acme", "/api/v1/audit/verify", { cookie: admin.cookie })).status).toBe(
      200,
    );
  });
});

describe("FIX2", () => {
  async function pending(slug: string): Promise<{ ws: string; cp: string }> {
    const ws = (await createWorkspace(running.container.db, { slug, name: slug })).id;
    await recordEvents(ws, 1);
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      ws,
    );
    const [row] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
      [ws],
    );
    return { ws, cp: row?.id as string };
  }

  it("A13: leaves that cannot be written are left out of every tree; healthy ones are not starved", async () => {
    await anchorPending(opts()); // nothing else pending
    const stuck = await pending("stuck");
    for (let i = 0; i < 2; i++) {
      await recordEvents(stuck.ws, 1);
      await writeCheckpoint(
        { db: running.container.db, keyRing: running.container.config.keyRing },
        stuck.ws,
      );
    }
    const healthy: string[] = [];
    for (const slug of ["ok1", "ok2", "ok3", "ok4"]) healthy.push((await pending(slug)).cp);
    await pg.pool.query(`
      CREATE FUNCTION audit.test_refuse_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.workspace_id = '${stuck.ws}'::uuid THEN RAISE EXCEPTION 'refused'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER test_refuse_anchor BEFORE INSERT ON audit.anchor
        FOR EACH ROW EXECUTE FUNCTION audit.test_refuse_anchor();`);
    try {
      const calls = tsa.calls();
      const r = await anchorPending({ ...opts(), maxBatchLeaves: 3 });
      expect(r.skipped).toBe(3);
      expect(r.leaves).toBe(4);
      const anchored = await su<{ checkpoint_id: string }>(
        "SELECT checkpoint_id FROM audit.anchor WHERE checkpoint_id = ANY($1::uuid[]) AND kind = 'merkle'",
        [healthy],
      );
      expect(anchored).toHaveLength(4);
      // Every committed batch's tree holds exactly its recorded leaves (no root for unrecorded ones).
      const sizes = await su<{ leaf_count: number; rows: number }>(
        `SELECT b.leaf_count, (SELECT count(*)::int FROM audit.anchor a WHERE a.batch_id = b.id) AS rows
           FROM audit.anchor_batch b WHERE b.id = ANY($1::uuid[])`,
        [r.batchIds],
      );
      for (const x of sizes) expect(x.leaf_count).toBe(x.rows);
      expect(tsa.calls() - calls).toBe(r.batchIds.length);
      // The CLI reports it and exits 1.
      const lines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
      expect(
        await runAuditAnchor(running.container.config, running.container.db, {
          drivers: [tsa, log],
        }),
      ).toBe(1);
      expect(lines.join("\n")).toMatch(/SKIPPED 3 checkpoint\(s\)/u);
    } finally {
      await pg.pool.query(
        "DROP TRIGGER test_refuse_anchor ON audit.anchor; DROP FUNCTION audit.test_refuse_anchor();",
      );
    }
    await anchorPending(opts());
  });

  it("A14: an unanchored checkpoint whose signature fails is listed as failed, not pending", async () => {
    const p = await pending("badsig");
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit.checkpoint DISABLE TRIGGER checkpoint_immutable");
      await client.query("UPDATE audit.checkpoint SET signature = '\\x00' WHERE id = $1", [p.cp]);
      await client.query("ALTER TABLE audit.checkpoint ENABLE TRIGGER checkpoint_immutable");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await anchorPending(opts()); // skips it (bad HMAC)
    const ring = running.container.config.keyRing;
    const items = await running.container.db.withTenant(systemContext(p.ws), (tx) =>
      listAnchorPage(tx, p.ws, { limit: 10 }, new Date(), ring),
    );
    expect(items.find((i) => i.checkpointId === p.cp)?.state).toBe("failed");
    const noRing = await running.container.db.withTenant(systemContext(p.ws), (tx) =>
      listAnchorPage(tx, p.ws, { limit: 10 }),
    );
    expect(noRing.find((i) => i.checkpointId === p.cp)?.state).toBe("pending");
  });

  it("A12/N5 on the server: a trusted time before the head event is anchor_inconsistent", async () => {
    const p = await pending("early");
    const early = createFakeAnchor({
      kind: "faketsa",
      now: () => new Date(Date.now() - 3_600_000),
    });
    await anchorPending({ ...opts(), drivers: [early] });
    const v = await verifyWorkspace({ db: running.container.db, anchorDrivers: [early] }, p.ws);
    expect(v.ok).toBe(false);
    expect(v.anchorProblems.map((x) => x.code)).toEqual(["anchor_inconsistent"]);
    expect(v.anchors.failed).toBe(1);
  });
});
