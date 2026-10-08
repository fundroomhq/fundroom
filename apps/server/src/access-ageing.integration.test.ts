import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";

/*
 * Time alone ends access (E2.10, WP-D follow-up + P1-01's authz half). The `accredited` gate is
 * settled when `effective_access` is rebuilt, and nothing *writes* when an accreditation passes
 * `maxAgeDays` or a membership reaches `expires_at` — so without an expiry on the materialised
 * row neither the hourly reconciler nor a read ever rebuilt, and the gate stayed open until some
 * unrelated change bumped `acl_version`.
 *
 * Every timestamp here comes from the test's clock (not Postgres `now()`), because the service
 * compares with the process clock and Docker's VM clock may drift from it.
 */
const BASE = "https://portal.example.test";
const DAY_MS = 24 * 3600_000;
/** How far in the future each lapse is placed; the test sleeps past it once. */
const LAPSE_MS = 4_000;

let pg: TestPostgres;
let running: RunningServer;
let t0: number;

interface Seeded {
  workspaceId: string;
  membershipId: string;
  resource: { kind: string; id: string };
}

async function sql(workspaceId: string, query: string): Promise<Record<string, unknown>[]> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(
    ctx,
    async (tx) => (await tx.execute(query)).rows as Record<string, unknown>[],
  );
}

async function investor(
  workspaceId: string,
  email: string,
  expiresAt?: Date,
): Promise<{ membershipId: string }> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
  if (expiresAt !== undefined) {
    await sql(
      workspaceId,
      `UPDATE core.membership SET expires_at = '${expiresAt.toISOString()}' WHERE id = '${m.id}'`,
    );
  }
  return { membershipId: m.id };
}

/** A view grant on a fresh resource; `accreditedAt` also puts a 1-day accredited gate on the workspace. */
async function granted(
  workspaceId: string,
  membershipId: string,
  accreditedAt?: Date,
): Promise<Seeded> {
  const resource = { kind: "post", id: randomUUID() };
  await sql(
    workspaceId,
    `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id, capability)
     VALUES ('${workspaceId}', 'membership', '${membershipId}', '${resource.kind}', '${resource.id}', 'view')`,
  );
  if (accreditedAt !== undefined) {
    await sql(
      workspaceId,
      `INSERT INTO core.attestation (workspace_id, membership_id, kind, signed_at)
       VALUES ('${workspaceId}', '${membershipId}', 'accredited', '${accreditedAt.toISOString()}')`,
    );
  }
  return { workspaceId, membershipId, resource };
}

async function ensureAccreditedGate(workspaceId: string): Promise<void> {
  await sql(
    workspaceId,
    `INSERT INTO core.access_policy (workspace_id, target_kind, kind, config)
     VALUES ('${workspaceId}', 'workspace', 'accredited', '{"maxAgeDays": 1}')`,
  );
}

/** The setup write: raw SQL does not bump the ACL version, so bump it once, as a service would. */
async function bump(workspaceId: string): Promise<void> {
  await sql(
    workspaceId,
    `UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = '${workspaceId}'`,
  );
}

const check = (s: Seeded) =>
  running.container.authz.check(
    { workspaceId: s.workspaceId, membershipId: s.membershipId },
    s.resource,
    "view",
  );

async function row(s: Seeded): Promise<{ pending: string[]; expiresAt: Date | null } | undefined> {
  const r = (
    await sql(
      s.workspaceId,
      `SELECT pending_gates, expires_at FROM core.effective_access
       WHERE membership_id = '${s.membershipId}' AND resource_id = '${s.resource.id}'`,
    )
  )[0];
  if (r === undefined) return undefined;
  const gates = (r["pending_gates"] as { kind: string }[]) ?? [];
  const exp = r["expires_at"];
  return {
    pending: gates.map((g) => g.kind),
    expiresAt: exp === null ? null : new Date(exp as string),
  };
}

// acme: the reconciler must pick the ageing row up. beta: a read must, with no reconciler run.
let acmeAged: Seeded;
let betaAged: Seeded;
let betaLeaving: Seeded;
let betaStaying: Seeded;
let accreditedAt: Date;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: true,
  });
  const acme = await createWorkspace(running.container.db, { slug: "acme", name: "Acme" });
  const beta = await createWorkspace(running.container.db, { slug: "beta", name: "Beta" });
  t0 = Date.now();
  // Signed one day minus LAPSE_MS ago under a 1-day gate: it ages out LAPSE_MS from now.
  accreditedAt = new Date(t0 - DAY_MS + LAPSE_MS);

  const ada = await investor(acme.id, "ada@example.com");
  await ensureAccreditedGate(acme.id);
  acmeAged = await granted(acme.id, ada.membershipId, accreditedAt);
  await bump(acme.id);

  const bob = await investor(beta.id, "bob@example.com");
  const cy = await investor(beta.id, "cy@example.com", new Date(t0 + LAPSE_MS));
  const di = await investor(beta.id, "di@example.com");
  await ensureAccreditedGate(beta.id);
  betaAged = await granted(beta.id, bob.membershipId, accreditedAt);
  betaLeaving = await granted(beta.id, cy.membershipId, new Date(t0));
  betaStaying = await granted(beta.id, di.membershipId, new Date(t0));
  await bump(beta.id);
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("access that runs out with no write anywhere", () => {
  it("is granted while the accreditation is fresh and the membership live, with the lapse on the row", async () => {
    for (const s of [acmeAged, betaAged, betaLeaving, betaStaying]) {
      expect((await check(s)).reason, s.membershipId).toBe("granted");
    }
    const lapse = new Date(accreditedAt.getTime() + DAY_MS + 1);
    expect(await row(acmeAged)).toEqual({ pending: [], expiresAt: lapse });
    expect((await row(betaLeaving))?.expiresAt).toEqual(new Date(t0 + LAPSE_MS));
    // Fresh accreditation: the row lapses a day from now, not never.
    expect((await row(betaStaying))?.expiresAt).toEqual(new Date(t0 + DAY_MS + 1));
  });

  it("gates a read as soon as the accreditation ages out, and drops an expired member", async () => {
    const wait = t0 + LAPSE_MS + 500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const aged = await check(betaAged);
    expect(aged.allowed).toBe(false);
    expect(aged.reason).toBe("gated");
    expect(aged.pendingGates.map((g) => g.kind)).toEqual(["accredited"]);
    expect((await row(betaAged))?.pending).toEqual(["accredited"]);

    const left = await check(betaLeaving);
    expect(left.allowed).toBe(false);
    expect(await row(betaLeaving)).toBeUndefined();

    // Nobody else in the workspace lost anything.
    expect((await check(betaStaying)).reason).toBe("granted");
  });

  it("is marked stale for the hourly reconciler, which rebuilds it without any read", async () => {
    // acme has not been read since the lapse: its row still says "no pending gates".
    expect((await row(acmeAged))?.pending).toEqual([]);
    const reconcile = running.container.authz.jobs.find((j) => j.name === "authz.reconcile");
    expect(reconcile).toBeDefined();
    await reconcile?.handler({} as never);
    expect((await row(acmeAged))?.pending).toEqual(["accredited"]);
    expect((await check(acmeAged)).reason).toBe("gated");
  });
});
