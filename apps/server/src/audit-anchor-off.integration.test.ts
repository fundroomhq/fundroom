import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkspace, writeCheckpoint } from "@fundroom/audit";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAuditAnchor } from "./cli-commands/audit-anchor.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E3.13 anchoring OFF (the default: AUDIT_ANCHOR_DRIVERS empty): no `audit.anchor` job, the
 * anchors list says `configured: []` with nothing anchored, verify reports an all-zero summary
 * (never `anchor_missing`), and `fundroom audit anchor` refuses (exit 2) without touching the DB.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
let cookie: string;

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
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
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email: "owner@example.com", displayName: "Owner" });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  const since = mailer.sent.length;
  await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com" }),
  });
  const code = await awaitSignInCode(mailer, "owner@example.com", since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email: "owner@example.com", code }),
  });
  cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  cookie = withSetCookies(cookie, confirm);
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, (tx) =>
    running.container.audit.record(tx, ctx, { action: "grant.changed", resourceKind: "grant" }),
  );
  await writeCheckpoint(
    { db: running.container.db, keyRing: running.container.config.keyRing },
    acmeId,
  );
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("anchoring off", () => {
  it("registers no audit.anchor job and builds no driver", () => {
    expect(running.container.jobs.map((j) => j.name)).not.toContain("audit.anchor");
    expect(running.container.jobs.map((j) => j.name)).toContain("audit.checkpoint");
    expect(running.container.auditAnchoring.drivers).toEqual([]);
  });

  it("GET /audit/anchors reports configured: [] and nothing anchored", async () => {
    const res = await request("/api/v1/audit/anchors", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: string[];
      items: { anchored: boolean; receipts: unknown[] }[];
    };
    expect(body.configured).toEqual([]);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => !i.anchored && i.receipts.length === 0)).toBe(true);
  });

  it("verify reports an all-zero summary, never anchor_missing, even for old checkpoints", async () => {
    const res = await request("/api/v1/audit/verify", { cookie });
    const body = (await res.json()) as { ok: boolean; anchors: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.anchors).toEqual({
      checked: 0,
      verified: 0,
      unverifiedOrigin: 0,
      failed: 0,
      missing: 0,
      late: 0,
      presenceOnly: 0,
    });
    const later = await verifyWorkspace(
      { db: running.container.db, now: new Date(Date.now() + 30 * 86_400_000) },
      acmeId,
    );
    expect(later.anchors.missing).toBe(0);
    expect(later.ok).toBe(true);
  });

  it("the proof route is a 404 for an unanchored checkpoint", async () => {
    const r = await pg.pool.query<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 LIMIT 1",
      [acmeId],
    );
    const res = await request(`/api/v1/audit/anchors/${r.rows[0]?.id}/proof`, { cookie });
    expect(res.status).toBe(404);
  });

  it("`fundroom audit anchor` refuses with exit 2", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    expect(await runAuditAnchor(running.container.config, running.container.db)).toBe(2);
    expect(lines.join("\n")).toContain("AUDIT_ANCHOR_DRIVERS is empty");
    vi.restoreAllMocks();
    const batches = await pg.pool.query("SELECT 1 FROM audit.anchor_batch");
    expect(batches.rowCount).toBe(0);
  });
});
