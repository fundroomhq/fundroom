import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthzService } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, type Database, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { type RunningServer, startServer } from "../server.js";

/*
 * Review E2.10 R1-A6: a check() that finds an expired row rebuilds — but when a rebuild is
 * already in flight it *joins* it, and that rebuild computed its rows at its own, earlier `now`.
 * A grant that lapsed in between comes back as live, with an `expires_at` already in the past.
 * The service must never grant from such a row.
 *
 * The in-flight rebuild is held open by a wrapper around `Database.withTenant`, so the join is
 * deterministic; the service's clock is the test's, so the lapse happens exactly between the
 * rebuild's `now` and the check's.
 */
let pg: TestPostgres;
let running: RunningServer;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  running = await startServer({
    config: loadConfig({
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        BASE_URL: "https://portal.example.test",
        DATABASE_URL: pg.connectionString,
        FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
        STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
        TENANCY_MODE: "multi",
        ROLES: "api",
      },
    }),
    logger: createLogger({ level: "warn" }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: true,
  });
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("a check that joins an in-flight rebuild (R1-A6)", () => {
  it("does not grant from a row whose expiry passed after that rebuild started", async () => {
    const db = running.container.db;
    const ws = await createWorkspace(db, { slug: "acme", name: "Acme" });
    const user = await provisionUser(running.container.identityDeps, {
      email: "ada@example.com",
      displayName: "ada",
    });
    const m = await provisionMembership(running.container.identityDeps, {
      workspaceId: ws.id,
      userId: user.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    const until = new Date(Date.now() + 3_600_000);
    const resource = { kind: "post", id: randomUUID() };
    const ctx = systemContext(ws.id);
    await db.withTenant(ctx, (tx) =>
      tx.execute(
        `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id, capability, validity)
         VALUES ('${ws.id}', 'membership', '${m.id}', 'post', '${resource.id}', 'view',
                 tstzrange(now(), '${until.toISOString()}'))`,
      ),
    );

    let clock = until.getTime() - 60_000;
    let holdNext = false;
    let started: () => void = () => {};
    let release: () => void = () => {};
    const held: Database = {
      ...db,
      withTenant: ((c: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        if (!holdNext) return (db.withTenant as (c: unknown, f: unknown) => unknown)(c, fn);
        holdNext = false;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        return (db.withTenant as (c: unknown, f: unknown) => Promise<unknown>)(
          c,
          async (tx: unknown) => {
            const result = fn(tx); // the rebuild reads the clock here
            started();
            const out = await result;
            await gate;
            return out;
          },
        );
      }) as Database["withTenant"],
    } as Database;
    const authz = createAuthzService({
      db: held,
      permissionCatalogue: () => [],
      now: () => new Date(clock),
    });
    const principal = { workspaceId: ws.id, membershipId: m.id };

    await authz.rebuild(ws.id);
    expect((await authz.check(principal, resource, "view")).allowed).toBe(true);

    // A rebuild starts one second before the grant lapses and is held before it commits.
    clock = until.getTime() - 1_000;
    const hasStarted = new Promise<void>((r) => {
      started = r;
    });
    holdNext = true;
    const inflight = authz.rebuild(ws.id);
    await hasStarted;

    // The grant lapses; a check finds the lapsed row, joins the held rebuild, and reads its rows.
    clock = until.getTime() + 1_000;
    const decision = authz.check(principal, resource, "view");
    setTimeout(() => release(), 300);
    await inflight;
    expect(await decision).toMatchObject({ allowed: false });

    // The next check rebuilds at its own `now` and agrees.
    expect((await authz.check(principal, resource, "view")).allowed).toBe(false);
  });
});
