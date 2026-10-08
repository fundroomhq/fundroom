import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moduleEnablement, outbox, workspace } from "../schema/core.js";
import { customDomain } from "../schema/custom-domains.js";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";
import { systemContext, type TenantContext } from "./context.js";
import { createDatabase, type Database, pgErrorCode, pgErrorMessage } from "./database.js";
import { TenantRepo } from "./repo.js";
import {
  bumpAclVersion,
  createWorkspace,
  createWorkspaceResolver,
  findSoleWorkspace,
  findWorkspaceById,
  findWorkspaceBySlug,
} from "./workspace.js";

/** Unwraps Drizzle's query error so assertions see the Postgres message and SQLSTATE. */
async function pgFailure(
  p: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: pgErrorCode(e), message: pgErrorMessage(e) };
  }
  throw new Error("expected the query to fail");
}

/*
 * withTenant()/withHost() against a real Postgres through Drizzle: context is transaction-
 * local, the role switch makes RLS bite on a superuser URL, TenantRepo scopes and forces
 * workspace_id, and the workspace helpers behave for both tenancy modes.
 */
let pg: TestPostgres;
let db: Database;

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 4 });
});
afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

class EnablementRepo extends TenantRepo<typeof moduleEnablement> {
  enable(module: string) {
    return this.insertOne({ module, enabled: true });
  }
  list() {
    return this.findMany();
  }
  only(module: string) {
    return this.findMany(eq(moduleEnablement.module, module));
  }
}

describe("withHost / workspace helpers", () => {
  it("creates workspaces in host context and resolves them by slug (case-insensitive)", async () => {
    const acme = await createWorkspace(db, { slug: "Acme", name: " Acme Inc " });
    expect(acme.slug).toBe("acme");
    expect(acme.name).toBe("Acme Inc");
    expect(acme.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(acme.aclVersion).toBe(0);
    expect((await findWorkspaceBySlug(db, "ACME"))?.id).toBe(acme.id);
    expect(await findWorkspaceBySlug(db, "nope")).toBeUndefined();
    const dup = await pgFailure(createWorkspace(db, { slug: "acme", name: "dup" }));
    expect(dup.code).toBe("23505");
    expect(dup.message).toMatch(/workspace_slug_active_idx/u);
    const bad = await pgFailure(createWorkspace(db, { slug: "Bad Slug!", name: "x" }));
    expect(bad.code).toBe("23514");
    expect(bad.message).toMatch(/workspace_slug_format/u);
  });

  it("single-tenant resolution returns the sole workspace, then fails once a second one exists", async () => {
    const sole = await findSoleWorkspace(db);
    expect(sole?.slug).toBe("acme");
    const resolver = createWorkspaceResolver(db, "single");
    expect((await resolver.resolve("ignored"))?.slug).toBe("acme");
    await createWorkspace(db, { slug: "beta", name: "Beta" });
    await expect(findSoleWorkspace(db)).rejects.toThrow(/TENANCY_MODE=multi/u);
    expect((await createWorkspaceResolver(db, "multi").resolve("beta"))?.slug).toBe("beta");
  });

  it("bumps acl_version and the updated_at trigger fires", async () => {
    const acme = await findWorkspaceBySlug(db, "acme");
    if (!acme) throw new Error("missing");
    await bumpAclVersion(db, acme.id);
    await bumpAclVersion(db, acme.id);
    const row = await db.withHost(async (tx) => {
      const rows = await tx.select().from(workspace).where(eq(workspace.id, acme.id));
      return rows[0];
    });
    expect(row?.aclVersion).toBe(2);
    expect(row && row.updatedAt.getTime() > row.createdAt.getTime()).toBe(true);
  });

  it("resolves primaryHost from the active custom domain, and the claim is global once verified", async () => {
    const acme = await findWorkspaceBySlug(db, "acme");
    const beta = await findWorkspaceBySlug(db, "beta");
    if (!acme || !beta) throw new Error("missing");
    expect(acme.primaryHost).toBeNull();

    await db.withHost((tx) =>
      tx.insert(customDomain).values({
        workspaceId: acme.id,
        hostname: "investors.acme.test",
        token: "A".repeat(20),
        status: "active",
        activatedAt: new Date(),
      }),
    );
    expect((await findWorkspaceBySlug(db, "acme"))?.primaryHost).toBe("investors.acme.test");
    // Only the owning workspace gets it, and only an *active* row counts.
    expect((await findWorkspaceById(db, beta.id))?.primaryHost).toBeNull();

    // Two workspaces may both hold a `pending` row on the same hostname — one of them is a typo,
    // and a global claim over pending rows would let a squatter block a rival forever. Promoting
    // the second one to a verified state is what the claim index refuses: first verified wins.
    await db.withHost((tx) =>
      tx.insert(customDomain).values({
        workspaceId: beta.id,
        hostname: "investors.acme.test",
        token: "B".repeat(20),
      }),
    );
    const clash = await pgFailure(
      db.withHost((tx) =>
        tx
          .update(customDomain)
          .set({ status: "dns_ok" })
          .where(eq(customDomain.workspaceId, beta.id)),
      ),
    );
    expect(clash.code).toBe("23505");
    expect(clash.message).toMatch(/custom_domain_claim_idx/u);

    // The sibling rule: one verified hostname per *workspace*. A second verified hostname is a
    // second `__Host-` cookie jar, not an alias — an investor who bookmarked it would get a
    // different session. Multiple pending rows stay legal (a founder fixing a typo needs that).
    await db.withHost((tx) =>
      tx.insert(customDomain).values({
        workspaceId: acme.id,
        hostname: "portal.acme.test",
        token: "D".repeat(20),
      }),
    );
    const second = await pgFailure(
      db.withHost((tx) =>
        tx
          .update(customDomain)
          .set({ status: "dns_ok" })
          .where(eq(customDomain.hostname, "portal.acme.test")),
      ),
    );
    expect(second.code).toBe("23505");
    expect(second.message).toMatch(/custom_domain_one_per_workspace_idx/u);

    // A hostname the application layer would never accept is still refused by the backstop.
    const bad = await pgFailure(
      db.withHost((tx) =>
        tx
          .insert(customDomain)
          .values({ workspaceId: beta.id, hostname: "not a host", token: "C".repeat(20) }),
      ),
    );
    expect(bad.code).toBe("23514");
    expect(bad.message).toMatch(/custom_domain_hostname_format/u);
  });
});

describe("withTenant", () => {
  let acme: string;
  let beta: string;
  beforeAll(async () => {
    acme = (await findWorkspaceBySlug(db, "acme"))?.id ?? "";
    beta = (await findWorkspaceBySlug(db, "beta"))?.id ?? "";
  });

  it("runs as seedhost_app with the context set, and the pooled connection is clean afterwards", async () => {
    const inside = await db.withTenant(systemContext(acme), async (tx) => {
      const r = await tx.execute<{ role: string; ws: string | null; kind: string | null }>(
        "SELECT current_user AS role, core.current_workspace()::text AS ws, core.current_actor_kind() AS kind",
      );
      return r.rows[0];
    });
    expect(inside).toEqual({ role: "seedhost_app", ws: acme, kind: "system" });
    const after = await pg.pool.query(
      "SELECT current_user AS role, core.current_workspace()::text AS ws, current_setting('app.actor_kind', true) AS kind",
    );
    expect(after.rows[0]).toEqual({
      role: "seedhost",
      ws: null,
      kind: expect.toSatisfy((v: unknown) => v === null || v === ""),
    });
  });

  it("TenantRepo scopes reads and forces workspace_id on insert", async () => {
    const staffAcme: TenantContext = {
      workspaceId: acme,
      actorKind: "staff",
      membershipId: "01920000-0000-7000-8000-000000000123",
      userId: "01920000-0000-7000-8000-000000000456",
    };
    await db.withTenant(staffAcme, async (tx) => {
      const repo = new EnablementRepo(moduleEnablement, staffAcme, tx);
      await repo.enable("updates");
      await repo.enable("metrics");
    });
    await db.withTenant(systemContext(beta), async (tx) => {
      await new EnablementRepo(moduleEnablement, systemContext(beta), tx).enable("updates");
    });

    const acmeRows = await db.withTenant(staffAcme, (tx) =>
      new EnablementRepo(moduleEnablement, staffAcme, tx).list(),
    );
    expect(acmeRows.map((r) => r.module).sort()).toEqual(["metrics", "updates"]);
    expect(acmeRows.every((r) => r.workspaceId === acme)).toBe(true);
    const betaRows = await db.withTenant(systemContext(beta), (tx) =>
      new EnablementRepo(moduleEnablement, systemContext(beta), tx).only("updates"),
    );
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]?.workspaceId).toBe(beta);
  });

  it("RLS blocks an insert that names another workspace even when the repo is bypassed", async () => {
    const a = await pgFailure(
      db.withTenant(systemContext(acme), async (tx) => {
        await tx.insert(moduleEnablement).values({ workspaceId: beta, module: "crm" });
      }),
    );
    expect(a.code).toBe("42501");
    expect(a.message).toMatch(/row-level security/u);
    const b = await pgFailure(
      db.withTenant(systemContext(acme), async (tx) => {
        await tx.insert(outbox).values({ workspaceId: beta, topic: "t", payload: {} });
      }),
    );
    expect(b.code).toBe("42501");
    expect(b.message).toMatch(/row-level security/u);
  });

  it("a tenant cannot see other workspaces or their outbox; host can", async () => {
    await db.withTenant(systemContext(acme), async (tx) => {
      await tx.insert(outbox).values({ workspaceId: acme, topic: "acme.t", payload: { a: 1 } });
    });
    await db.withTenant(systemContext(beta), async (tx) => {
      await tx.insert(outbox).values({ workspaceId: beta, topic: "beta.t", payload: { b: 1 } });
    });
    const seenByAcme = await db.withTenant(systemContext(acme), async (tx) => ({
      ws: (await tx.select({ slug: workspace.slug }).from(workspace)).map((r) => r.slug),
      ob: (await tx.select({ topic: outbox.topic }).from(outbox)).map((r) => r.topic),
    }));
    expect(seenByAcme).toEqual({ ws: ["acme"], ob: ["acme.t"] });
    const seenByHost = await db.withHost(async (tx) => ({
      ws: (await tx.select({ slug: workspace.slug }).from(workspace)).map((r) => r.slug).sort(),
      ob: (await tx.select({ topic: outbox.topic }).from(outbox)).map((r) => r.topic).sort(),
      me: (await tx.select().from(moduleEnablement)).length,
    }));
    expect(seenByHost).toEqual({ ws: ["acme", "beta"], ob: ["acme.t", "beta.t"], me: 0 });
  });

  it("rejects malformed contexts before touching the database", async () => {
    await expect(
      db.withTenant({ workspaceId: "x", actorKind: "system" }, async () => 1),
    ).rejects.toThrow(/workspaceId/u);
  });

  it("rolls back on error", async () => {
    await expect(
      db.withTenant(systemContext(acme), async (tx) => {
        await tx.insert(moduleEnablement).values({ workspaceId: acme, module: "rollback-me" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db.withTenant(systemContext(acme), (tx) =>
      tx.select().from(moduleEnablement).where(eq(moduleEnablement.module, "rollback-me")),
    );
    expect(rows).toEqual([]);
  });

  it("ping works and statement_timeout is applied inside transactions", async () => {
    expect(await db.ping()).toBe(true);
    const t = await db.withTenant(systemContext(acme), async (tx) => {
      const r = await tx.execute<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
      return r.rows[0]?.t;
    });
    expect(t).toBe("30s");
  });
});

describe("pool lifecycle", () => {
  it("an idle connection the server kills is reported, not an uncaught exception", async () => {
    const seen: string[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    const own = createDatabase({
      connectionString: pg.connectionString,
      poolMax: 3,
      onIdleError: (e) => seen.push((e as { code?: string }).code ?? e.message),
    });
    try {
      // Three concurrent statements leave three idle connections behind.
      await Promise.all([1, 2, 3].map(() => own.pool.query("SELECT pg_sleep(0.05)")));
      expect(own.pool.idleCount).toBe(3);
      await pg.pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query = 'SELECT pg_sleep(0.05)'",
      );
      const deadline = Date.now() + 5_000;
      while (seen.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(["57P01", "57P01", "57P01"]);
      expect(uncaught).toEqual([]);
      // The pool recovers: the next statement opens a fresh connection.
      expect(await own.ping()).toBe(true);
    } finally {
      process.off("uncaughtException", onUncaught);
      await own.close();
    }
  });

  it("close() resolves only once every connection has actually closed", async () => {
    const own = createDatabase({ connectionString: pg.connectionString, poolMax: 3 });
    await Promise.all([1, 2, 3].map(() => own.pool.query("SELECT pg_sleep(0.05)")));
    const closed: unknown[] = [];
    own.pool.on("remove", (client) => closed.push(client));
    await own.close();
    expect(closed).toHaveLength(3);
  });
});
