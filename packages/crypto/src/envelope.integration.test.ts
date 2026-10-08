import { randomBytes } from "node:crypto";
import { parseKeyRing } from "@fundroom/config";
import {
  createDatabase,
  createWorkspace,
  type Database,
  pgErrorCode,
  systemContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createLocalKms } from "@fundroom/kms-local";
import { KmsError, type KmsPort } from "@fundroom/ports";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCryptoJobs, createEnvelopeService } from "./envelope.js";
import { WorkspaceKeyRepo } from "./repos/workspace-key-repo.js";
import { bytesToStream, decryptStream, encryptStream, streamToBytes } from "./stream-aead.js";

/*
 * Per-workspace DEKs on Postgres 18 with RLS and the role switch on: get-or-create, tenant
 * isolation of core.workspace_key, rotation, KEK rewrap after a ring rotation, the
 * no-DELETE grant, and an encrypt → store → decrypt round trip through the service.
 */
let pg: TestPostgres;
let db: Database;
let wsA: string;
let wsB: string;

const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");

function ring(spec: string) {
  const r = parseKeyRing(spec);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
}

const kmsV1 = createLocalKms({ keyRing: ring(`v1:${K1}`) });
const kmsV2 = createLocalKms({ keyRing: ring(`v2:${K2},v1:${K1}`) });
const kmsV2Only = createLocalKms({ keyRing: ring(`v2:${K2}`) });

function service(kms: KmsPort, cacheTtlMs?: number) {
  return createEnvelopeService({
    db,
    kms,
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 6 });
  wsA = (await createWorkspace(db, { slug: "alpha", name: "Alpha" })).id;
  wsB = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("migration", () => {
  /*
   * This is the SECOND hand-maintained copy of the kernel migration list; the first is the
   * `KERNEL` array in `packages/db/src/migrate/migrate.integration.test.ts`. Two copies of one
   * list means every kernel migration costs two edits in two packages, and E2.3 paid that tax:
   * `0008_share_links` / `0009_link_policy_target` were appended there and missed here, so this
   * file went red for a change it has no opinion about. The list belongs in one place, derived
   * from the shipped `coreMigrationSource` rather than typed twice — see the E2.3 contract §10,
   * work package J. Until then: **append here too.**
   *
   * What this test is actually for is the name in its title — `packages/crypto` cannot store an
   * envelope without `core.workspace_key`, so it pins that the kernel this package's fixture
   * migrates really does bring that table with it.
   */
  it("lists every kernel file including workspace_key", async () => {
    const journal = await pg.pool.query<{ name: string }>(
      "SELECT name FROM core.schema_migration WHERE module = 'core' ORDER BY name",
    );
    expect(journal.rows.map((r) => r.name)).toEqual([
      "0000_core_kernel",
      "0001_identity",
      "0002_audit_events",
      "0003_workspace_key",
      "0004_access",
      "0005_access_path_inheritance",
      "0006_compliance",
      "0007_custom_domains",
      "0008_share_links",
      "0009_link_policy_target",
      "0010_mail_feedback",
      "0011_dsar",
      "0012_admin_surfaces",
      "0013_search_portability_i18n",
      "0014_import_reference_guard",
      "0015_break_glass",
      "0016_access_requests",
      "0017_delegates",
      "0018_api_keys_webhooks",
      "0019_esign",
      "0020_integrations",
      "0021_accreditation",
      "0022_sso_scim",
      "0023_control_plane",
      "0024_data_residency",
      "0025_ai_assist",
      "0026_evidence_authz",
      "0027_fundroom_identifiers",
    ]);
  });
});

describe("envelope service", () => {
  it("creates one active key per workspace and returns it stably", async () => {
    const env = service(kmsV1);
    const ctx = systemContext(wsA);
    const first = await db.withTenant(ctx, (tx) => env.currentKey(tx, ctx));
    const second = await db.withTenant(ctx, (tx) => env.currentKey(tx, ctx));
    expect(second.keyId).toBe(first.keyId);
    expect(Buffer.from(second.key).equals(Buffer.from(first.key))).toBe(true);
    expect(first.keyRef).toBe("local:v1");
    expect(first.key).toHaveLength(32);

    // A fresh service (empty cache) unwraps the stored row to the same key.
    const again = await db.withTenant(ctx, (tx) => service(kmsV1).currentKey(tx, ctx));
    expect(Buffer.from(again.key).equals(Buffer.from(first.key))).toBe(true);
    expect(env.stats().hits).toBeGreaterThan(0);
  });

  it("isolates workspaces: B gets its own key and cannot see A's row", async () => {
    const env = service(kmsV1);
    const ctxA = systemContext(wsA);
    const ctxB = systemContext(wsB);
    const a = await db.withTenant(ctxA, (tx) => env.currentKey(tx, ctxA));
    const b = await db.withTenant(ctxB, (tx) => env.currentKey(tx, ctxB));
    expect(b.keyId).not.toBe(a.keyId);
    expect(Buffer.from(b.key).equals(Buffer.from(a.key))).toBe(false);

    const rowsSeenByB = await db.withTenant(ctxB, (tx) => new WorkspaceKeyRepo(ctxB, tx).listAll());
    expect(rowsSeenByB.map((r) => r.id)).toEqual([b.keyId]);
    const aFromB = await db.withTenant(ctxB, (tx) => env.keyById(tx, ctxB, a.keyId));
    expect(aFromB).toBeUndefined();
    // Even a raw select in B's context returns nothing for A's key.
    const raw = await db.withTenant(ctxB, (tx) =>
      tx.execute(sql`SELECT id FROM core.workspace_key WHERE id = ${a.keyId}::uuid`),
    );
    expect(raw.rows).toHaveLength(0);
  });

  it("rotates: the old key still decrypts by id, the new one is active", async () => {
    const env = service(kmsV1);
    const ctx = systemContext(wsA);
    const before = await db.withTenant(ctx, (tx) => env.currentKey(tx, ctx));
    const rotated = await db.withTenant(ctx, (tx) => env.rotate(tx, ctx));
    expect(rotated.keyId).not.toBe(before.keyId);
    const now = await db.withTenant(ctx, (tx) => env.currentKey(tx, ctx));
    expect(now.keyId).toBe(rotated.keyId);
    const old = await db.withTenant(ctx, (tx) => env.keyById(tx, ctx, before.keyId));
    expect(old && Buffer.from(old.key).equals(Buffer.from(before.key))).toBe(true);
    const rows = await db.withTenant(ctx, (tx) => new WorkspaceKeyRepo(ctx, tx).listAll());
    const oldRow = rows.find((r) => r.id === before.keyId);
    const newRow = rows.find((r) => r.id === rotated.keyId);
    expect(oldRow?.retiredAt).toBeInstanceOf(Date);
    expect(newRow?.rotatedFromId).toBe(before.keyId);
    expect(newRow?.retiredAt).toBeNull();

    // keysFor lists retired keys too (oldest first), so a derivation made under the old key can
    // still be matched after the rotation; it never creates a key for an unused purpose.
    const all = await db.withTenant(ctx, (tx) => env.keysFor(tx, ctx, "workspace-dek"));
    const ids = all.map((k) => k.keyId);
    expect(ids.indexOf(before.keyId)).toBeGreaterThanOrEqual(0);
    expect(ids.at(-1)).toBe(rotated.keyId);
    expect(await db.withTenant(ctx, (tx) => env.keysFor(tx, ctx, "never-used"))).toEqual([]);
  });

  it("rewraps every key after a KEK rotation", async () => {
    const ctxA = systemContext(wsA);
    const ctxB = systemContext(wsB);
    const v1 = service(kmsV1);
    const aKeys = await db.withTenant(ctxA, (tx) => new WorkspaceKeyRepo(ctxA, tx).listAll());
    const keyIds = aKeys.map((r) => r.id);
    const plain = new Map<string, Uint8Array>();
    for (const id of keyIds) {
      const k = await db.withTenant(ctxA, (tx) => v1.keyById(tx, ctxA, id));
      if (!k) throw new Error("missing key");
      plain.set(id, k.key);
    }
    expect(aKeys.every((r) => r.kmsKeyRef === "local:v1")).toBe(true);

    // Operator rotated the ring: the daily job moves every workspace to v2.
    const v2 = service(kmsV2);
    let ran: Record<string, unknown> | undefined;
    const [job] = createCryptoJobs({ db, envelope: v2, log: (_e, f) => (ran = { ...f }) });
    if (!job) throw new Error("no job");
    await job.handler({ id: "1", name: job.name, data: {}, signal: AbortSignal.timeout(30_000) });
    expect(ran).toEqual({ workspaces: 2, keys: keyIds.length + 1 });

    const after = await db.withTenant(ctxA, (tx) => new WorkspaceKeyRepo(ctxA, tx).listAll());
    expect(after.every((r) => r.kmsKeyRef === "local:v2")).toBe(true);
    const bAfter = await db.withTenant(ctxB, (tx) => new WorkspaceKeyRepo(ctxB, tx).listAll());
    expect(bAfter.every((r) => r.kmsKeyRef === "local:v2")).toBe(true);
    // Same plaintext keys, new wrap; a second run is a no-op.
    for (const id of keyIds) {
      const k = await db.withTenant(ctxA, (tx) => v2.keyById(tx, ctxA, id));
      expect(k && Buffer.from(k.key).equals(Buffer.from(plain.get(id) ?? new Uint8Array()))).toBe(
        true,
      );
    }
    expect(await db.withTenant(ctxA, (tx) => v2.rewrap(tx, ctxA))).toBe(0);

    // A ring that only has v2 now works; the pre-rotation ring no longer does.
    const only = service(kmsV2Only);
    const k = await db.withTenant(ctxA, (tx) => only.currentKey(tx, ctxA));
    expect(k.keyRef).toBe("local:v2");
    const stale = service(kmsV1);
    await expect(db.withTenant(ctxA, (tx) => stale.currentKey(tx, ctxA))).rejects.toSatisfy(
      (e) => e instanceof KmsError && e.code === "unknown_key",
    );
  });

  it("refuses DELETE for the application role", async () => {
    const ctx = systemContext(wsA);
    let code: string | undefined;
    try {
      await db.withTenant(ctx, (tx) => tx.execute(sql`DELETE FROM core.workspace_key`));
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe("42501");
    const rows = await db.withTenant(ctx, (tx) => new WorkspaceKeyRepo(ctx, tx).listAll());
    expect(rows.length).toBeGreaterThan(0);
  });

  it("encrypts with the current key and decrypts by id from a cold cache", async () => {
    const env = service(kmsV2, 50);
    const ctx = systemContext(wsA);
    const plaintext = new Uint8Array(randomBytes(200_000));
    const { keyId, key } = await db.withTenant(ctx, (tx) => env.currentKey(tx, ctx));
    const stored = await streamToBytes(encryptStream(key, bytesToStream(plaintext)));
    expect(stored.byteLength).toBeGreaterThan(plaintext.byteLength);

    env.invalidate();
    expect(env.stats().cached).toBe(0);
    const reader = await db.withTenant(ctx, (tx) => env.keyById(tx, ctx, keyId));
    if (!reader) throw new Error("key vanished");
    const back = await streamToBytes(decryptStream(reader.key, bytesToStream(stored, 4096)));
    expect(Buffer.from(back).equals(Buffer.from(plaintext))).toBe(true);

    // TTL expiry drops the cached plaintext.
    await new Promise((r) => setTimeout(r, 80));
    const missesBefore = env.stats().misses;
    await db.withTenant(ctx, (tx) => env.keyById(tx, ctx, keyId));
    expect(env.stats().misses).toBe(missesBefore + 1);
    // Another workspace never hits A's cache entries.
    env.invalidate(wsB);
    expect(env.stats().cached).toBeGreaterThan(0);
    env.invalidate(wsA);
    expect(env.stats().cached).toBe(0);
  });
  it("two concurrent first uses of a purpose both get the one key (no aborted transaction)", async () => {
    // E3.5 fix A3: the loser of the first-use race used to re-read in its aborted transaction
    // (25P02). Deterministic: the winner inserts and holds its transaction open; the loser's
    // INSERT then waits on the unique index, fails with 23505 when the winner commits, and must
    // recover inside a savepoint — and its transaction must still be usable afterwards.
    const env = service(kmsV1);
    const ctx = systemContext(wsA);
    const purpose = `race-${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const winnerInserted = new Promise<void>((r) => {
      inserted = r;
    });
    const winner = db.withTenant(ctx, async (tx) => {
      const k = await env.currentKey(tx, ctx, purpose);
      inserted();
      await gate;
      return k;
    });
    await winnerInserted;
    const loser = db.withTenant(ctx, async (tx) => {
      const k = await env.currentKey(tx, ctx, purpose);
      // The transaction is still alive: a further statement succeeds.
      const again = await new WorkspaceKeyRepo(ctx, tx).findActive(purpose);
      return { k, again };
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pg.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted",
      );
      if ((rows[0]?.n ?? 0) >= 1) break;
      if (Date.now() > deadline) throw new Error("the loser never waited on the winner");
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    const [w, l] = await Promise.all([winner, loser]);
    expect(l.k.keyId).toBe(w.keyId);
    expect(l.again?.id).toBe(w.keyId);
    expect(Buffer.from(l.k.key).equals(Buffer.from(w.key))).toBe(true);
  });
});
