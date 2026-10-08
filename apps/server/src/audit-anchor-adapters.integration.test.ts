import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StubRekor, startStubRekor } from "@fundroom/anchor-rekor/testing";
import { type StubTsa, startStubTsa } from "@fundroom/anchor-rfc3161/testing";
import {
  buildExportBundle,
  exportPublicKeys,
  readAnchorProof,
  readWorkspaceExport,
  verifyWorkspace,
  writeAllCheckpoints,
} from "@fundroom/audit";
import { type AppConfig, loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditAnchoring } from "./audit-anchoring.js";
import { runAuditAnchor, runAuditVerifyAnchor } from "./cli-commands/audit-anchor.js";
import { runAuditVerifyExport } from "./cli-commands/audit-verify-export.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";

/*
 * E3.13 anchoring with the REAL adapters, built by the container from config exactly as in
 * production (AUDIT_ANCHOR_DRIVERS=rfc3161,rekor), against B's local stubs: a pkijs TSA and a
 * Rekor v2 log with a real tree and signed note. Covers the wiring (guarded client, pinned certs,
 * the key-ring-derived Rekor key), the CLI `fundroom audit anchor`, offline `verify-anchor` and
 * `verify-export --require-anchors` with the stock verifiers, and a retry after a TSA outage.
 */
let pg: TestPostgres;
let running: RunningServer;
let config: AppConfig;
let tsa: StubTsa;
let rekor: StubRekor;
let acmeId: string;
let dir: string;
let tsaPemFile: string;
let rekorPemFile: string;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  tsa = await startStubTsa();
  rekor = await startStubRekor();
  dir = mkdtempSync(join(tmpdir(), "fundroom-anchor-"));
  tsaPemFile = join(dir, "tsa.pem");
  rekorPemFile = join(dir, "rekor.pub");
  writeFileSync(tsaPemFile, tsa.trustedPem);
  writeFileSync(rekorPemFile, rekor.logPublicKeyPem);
  config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: "http://portal.example.test",
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor",
      AUDIT_ANCHOR_TSA_URLS: tsa.url,
      AUDIT_ANCHOR_TSA_CERTS: tsa.trustedPem,
      AUDIT_ANCHOR_REKOR_URL: rekor.url,
      AUDIT_ANCHOR_REKOR_LOG_KEY: rekor.logPublicKeyPem,
      AUDIT_ANCHOR_TIMEOUT_MS: "5000",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  const ctx = systemContext(acmeId);
  for (let i = 0; i < 3; i++) {
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.audit.record(tx, ctx, { action: "grant.changed", resourceKind: "grant" }),
    );
  }
  await writeAllCheckpoints({ db: running.container.db, keyRing: config.keyRing });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await tsa?.close();
  await rekor?.close();
  await pg?.stop();
});

afterEach(() => {
  tsa.control.mode = "ok";
  rekor.control.mode = "ok";
  vi.restoreAllMocks();
});

function quiet(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  return lines;
}

describe("real adapters from config", () => {
  it("builds both drivers and registers the job", () => {
    expect(running.container.auditAnchoring.drivers.map((d) => d.kind)).toEqual([
      "rfc3161",
      "rekor",
    ]);
    expect(running.container.jobs.map((j) => j.name)).toContain("audit.anchor");
  });

  it("`fundroom audit anchor` anchors with the TSA and Rekor, and verify checks both receipts", async () => {
    const lines = quiet();
    expect(await runAuditAnchor(config, running.container.db)).toBe(0);
    expect(lines.join("\n")).toMatch(/rfc3161\s+ok/u);
    expect(lines.join("\n")).toMatch(/rekor\s+ok/u);
    expect(tsa.requests()).toBeGreaterThan(0);
    expect(rekor.entries()).toBe(1);
    const v = await verifyWorkspace(
      {
        db: running.container.db,
        keyRing: config.keyRing,
        anchorDrivers: running.container.auditAnchoring.drivers,
      },
      acmeId,
    );
    expect(v.problems).toEqual([]);
    expect(v.anchors).toMatchObject({ checked: 1, verified: 1, failed: 0 });
  });

  it("verification-only pins (drivers off) still verify stored receipts (FIX1 A9)", async () => {
    const pinsOnly = loadConfig({
      env: {
        APP_ENV: "test",
        BASE_URL: "http://portal.example.test",
        DATABASE_URL: pg.connectionString,
        FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
        AUDIT_ANCHOR_TSA_CERTS: tsa.trustedPem,
        AUDIT_ANCHOR_REKOR_LOG_KEY: `${rekor.otherLogPublicKeyPem}\n${rekor.logPublicKeyPem}`,
        AUDIT_ANCHOR_REKOR_ORIGIN: "old.shard.example,new.shard.example",
      },
    });
    const anchoring = createAuditAnchoring({ config: pinsOnly });
    expect(anchoring.drivers).toEqual([]);
    const v = await verifyWorkspace(
      { db: running.container.db, anchorVerifiers: anchoring.verifiers },
      acmeId,
    );
    expect(v.anchors).toMatchObject({ checked: 1, verified: 1, unverifiedOrigin: 0, missing: 0 });
    // Without the pins the same receipts are only "unverified origin".
    const bare = await verifyWorkspace({ db: running.container.db }, acmeId);
    expect(bare.anchors).toMatchObject({ verified: 0, unverifiedOrigin: 1 });
  });

  it("a proof verifies offline with the stock verifiers only when the signers are pinned", async () => {
    const [cp] = (
      await pg.pool.query<{ id: string }>(
        "SELECT id FROM audit.checkpoint WHERE workspace_id = $1",
        [acmeId],
      )
    ).rows;
    const proof = await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      readAnchorProof(tx, acmeId, cp!.id),
    );
    expect(proof?.receipts.map((r) => r.kind).sort()).toEqual(["rekor", "rfc3161"]);
    const file = join(dir, "proof.json");
    writeFileSync(file, JSON.stringify(proof));
    const lines = quiet();
    expect(await runAuditVerifyAnchor([file])).toBe(3);
    expect(lines.join("\n")).toContain("UNVERIFIED ORIGIN");
    expect(
      await runAuditVerifyAnchor([
        file,
        "--anchor-cert",
        tsaPemFile,
        "--anchor-cert",
        rekorPemFile,
      ]),
    ).toBe(0);
    // Only the TSA pinned: the Rekor receipt is unpinned, the TSA one carries the time → verified.
    expect(await runAuditVerifyAnchor([file, "--anchor-cert", tsaPemFile])).toBe(0);
    // Only the Rekor log key pinned, no origin: the log is not pinned → unverified origin (FIX2
    // A15: the receipt's own origin claim never counts).
    lines.length = 0;
    expect(await runAuditVerifyAnchor([file, "--anchor-cert", rekorPemFile])).toBe(3);
    expect(lines.join("\n")).toContain("UNVERIFIED ORIGIN");
    // Key + origin pinned: present in a public log, but no trusted time → still exit 3 (H1).
    const origin = String(proof?.receipts.find((r) => r.kind === "rekor")?.proof["origin"]);
    lines.length = 0;
    expect(
      await runAuditVerifyAnchor([file, "--anchor-cert", rekorPemFile, "--rekor-origin", origin]),
    ).toBe(3);
    expect(lines.join("\n")).toContain("PRESENT IN LOG, NO TRUSTED TIME");
    expect(lines.join("\n")).not.toContain("existed by");
    // A wrong origin pinned: unverified origin again.
    lines.length = 0;
    await runAuditVerifyAnchor([
      file,
      "--anchor-cert",
      rekorPemFile,
      "--rekor-origin",
      "other.log",
    ]);
    expect(lines.join("\n")).toContain("UNVERIFIED ORIGIN");
    expect(await runAuditVerifyAnchor([file, "--anchor-cert", join(dir, "missing.pem")])).toBe(2);
  });

  it("an export bundle v2 passes verify-export --require-anchors with the pins, exit 3 without", async () => {
    const input = await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      readWorkspaceExport(tx, {
        workspace: { id: acmeId, slug: "acme", name: "Acme" },
        generatedBy: { membershipId: null },
        keyRing: config.keyRing,
      }),
    );
    const file = join(dir, "bundle.zip");
    writeFileSync(file, buildExportBundle(input).bytes);
    const key = exportPublicKeys(config.keyRing)[0]?.publicKey as string;
    quiet();
    const base = [file, "--public-key", key, "--require-anchors"];
    expect(
      await runAuditVerifyExport([
        ...base,
        "--anchor-cert",
        tsaPemFile,
        "--anchor-cert",
        rekorPemFile,
      ]),
    ).toBe(0);
    expect(await runAuditVerifyExport(base)).toBe(3);
    expect(await runAuditVerifyExport([file, "--public-key", key])).toBe(0);
  });

  it("a TSA outage fails only that driver (exit 1); the next run adds the missing receipt", async () => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.audit.record(tx, ctx, { action: "grant.changed", resourceKind: "grant" }),
    );
    await writeAllCheckpoints({ db: running.container.db, keyRing: config.keyRing });
    tsa.control.mode = "error";
    const lines = quiet();
    expect(await runAuditAnchor(config, running.container.db)).toBe(1);
    expect(lines.join("\n")).toMatch(/rfc3161\s+FAILED \(/u);
    tsa.control.mode = "ok";
    expect(await runAuditAnchor(config, running.container.db)).toBe(0);
    const kinds = await pg.pool.query<{ kind: string; n: number }>(
      "SELECT kind, count(*)::int AS n FROM audit.anchor_receipt GROUP BY kind ORDER BY kind",
    );
    expect(kinds.rows).toEqual([
      { kind: "rekor", n: 2 },
      { kind: "rfc3161", n: 2 },
    ]);
  });
});
