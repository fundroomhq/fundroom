import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
} from "./test/esign-harness.js";

/*
 * A-3 R2 M1: `core.workspace.settings` is one jsonb shared by a dozen writers. They used to
 * rebuild the WHOLE document from the request's cached copy (read without a lock when the
 * request started) and write it back, so a writer racing another writer restored stale values
 * of every other block. With plan entitlements that lost update became a bypass: a branding
 * save racing "turn Q&A off" left `dataRoom.qa.enabled = true` on a plan without `qa`, and no
 * gate saw it.
 *
 * Now each writer reads its block on the row-locked copy (`lockWorkspaceFacts`) and writes that
 * block alone (`updateWorkspaceSettingsBlock`). The interleave is R2's, made deterministic: a
 * holder transaction row-locks the workspace; the Q&A switch-off is started and waited for until
 * it blocks; then the other writer is started and waited for until it blocks; the holder
 * commits. Q&A goes off first, then the other writer applies — and Q&A must still be off.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const h = harness(
  () => running,
  () => mailer,
);
const { request, member } = h;

const settle = () => new Promise((r) => setTimeout(r, 1_300));

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  // Default-off modules whose settings writers are under test (round also needs an offering).
  const ctx = systemContext(id);
  await running.container.db.withTenant(ctx, async (tx) => {
    const repo = new ModuleEnablementRepo(ctx, tx);
    await repo.set("metrics", true);
    await repo.set("round", true);
    await updateOfferingStatus(tx, id, "506b");
  });
  running.container.enablement.invalidate(id);
  running.container.resolver.invalidate();
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  return { id, slug, owner };
}

type Block = Record<string, unknown>;
type Settings = Record<string, Block | undefined> & {
  dataRoom?: { qa?: { enabled?: boolean } };
  branding?: { tagline?: unknown; displayName?: unknown };
};

async function storedSettings(ws: Ws): Promise<Settings> {
  const { rows } = await pg.pool.query<{ settings: Settings }>(
    "SELECT settings FROM core.workspace WHERE id = $1",
    [ws.id],
  );
  return rows[0]?.settings ?? {};
}

const send = (
  ws: Ws,
  method: string,
  path: string,
  body: unknown,
  server?: RunningServer,
): Promise<Response> =>
  request(ws.slug, path, {
    method,
    cookie: ws.owner.cookie,
    body: JSON.stringify(body),
    ...(server === undefined ? {} : { server }),
  });

const qa = (ws: Ws, enabled: boolean, server?: RunningServer) =>
  send(ws, "PATCH", "/api/v1/data-room/settings", { qa: { enabled } }, server);

/** Every settings writer that changes one block, with a change and how to see it stored. */
interface Writer {
  readonly name: string;
  readonly method: "PATCH" | "PUT";
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly block: string;
  readonly field: string;
  readonly value: unknown;
}
const WRITERS: readonly Writer[] = [
  w("branding", "PATCH", "/api/v1/branding", "branding", "tagline", "racing"),
  w("compliance", "PATCH", "/api/v1/compliance/settings", "legal", "relationshipWarningDays", 123),
  w("access", "PATCH", "/api/v1/access/settings", "access", "inviteExpiryDays", 21),
  w("embed", "PUT", "/api/v1/embed/settings", "embed", "allowPreviewOrigins", true),
  w("metrics", "PATCH", "/api/v1/metrics/settings", "metrics", "defaultCurrency", "EUR"),
  w("content", "PATCH", "/api/v1/content/settings", "content", "allowPublicSections", true),
  w("updates", "PATCH", "/api/v1/updates/settings", "updates", "fromName", "Racing Fund"),
  w("round", "PATCH", "/api/v1/round/settings", "round", "evidenceRetentionDays", 400),
  w("analytics", "PATCH", "/api/v1/analytics/settings", "analytics", "retentionMonths", 7),
];
function w(
  name: string,
  method: "PATCH" | "PUT",
  path: string,
  block: string,
  field: string,
  value: unknown,
): Writer {
  return { name, method, path, body: { [field]: value }, block, field, value };
}

/** Distinct backends (other than `holder`) waiting on an ungranted lock. */
async function blocked(holder: number): Promise<number> {
  const { rows } = await pg.pool.query<{ n: number }>(
    "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND pid <> $1",
    [holder],
  );
  return rows[0]?.n ?? 0;
}

async function blockedAtLeast(holder: number, n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await blocked(holder)) < n) {
    if (Date.now() > deadline) throw new Error(`fewer than ${n} blocked backends`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Row-locks the workspace in a holder transaction, starts each contender in turn and waits until
 * it blocks (so they reach the row in this order), then commits. Returns every response, and
 * asserts no deadlock was detected meanwhile.
 */
async function lineUp(ws: Ws, contenders: readonly (() => Promise<Response>)[]) {
  await settle();
  const before = await deadlocks(pg.pool);
  const holder = await pg.pool.connect();
  const pending: Promise<Response>[] = [];
  try {
    await holder.query("BEGIN");
    await holder.query("SET LOCAL lock_timeout = '30s'");
    const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows as [{ pid: number }];
    await holder.query("UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1", [
      ws.id,
    ]);
    for (const [i, start] of contenders.entries()) {
      pending.push(start());
      await blockedAtLeast(pid, i + 1);
    }
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  const out = await Promise.all(pending);
  for (const res of out) expect(res.status, await res.clone().text()).toBe(200);
  await settle();
  expect(await deadlocks(pg.pool)).toBe(before);
  return out;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    // No worker: nothing but the requests under test touches the rows.
    config: esignTestConfig(env, { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("a settings writer racing a Q&A switch-off (R2 M1)", () => {
  it.each(WRITERS.map((x) => [x.name, x] as const))(
    "%s writes its own block only: Q&A stays off, and the change lands",
    async (_name, writer) => {
      const ws = await workspace(writer.name);
      expect((await qa(ws, true)).status).toBe(200);
      expect((await storedSettings(ws)).dataRoom?.qa?.enabled).toBe(true);

      // The writer's request resolves the workspace (Q&A on) before it reaches the row.
      await lineUp(ws, [
        () => qa(ws, false),
        () => send(ws, writer.method, writer.path, writer.body),
      ]);

      const after = await storedSettings(ws);
      expect(after.dataRoom?.qa?.enabled, "Q&A turned back on by a stale copy").toBe(false);
      expect(after[writer.block]?.[writer.field]).toEqual(writer.value);
    },
    60_000,
  );

  it("two saves of the same block merge on the locked row: neither undoes the other's field", async () => {
    const ws = await workspace("same");
    await lineUp(ws, [
      () => send(ws, "PATCH", "/api/v1/branding", { tagline: "first" }),
      () => send(ws, "PATCH", "/api/v1/branding", { displayName: "Second Fund" }),
    ]);
    const after = await storedSettings(ws);
    expect(after.branding?.tagline).toBe("first");
    expect(after.branding?.displayName).toBe("Second Fund");
  }, 60_000);

  it("every writer keeps a top-level key it does not know", async () => {
    const ws = await workspace("keep");
    await pg.pool.query(
      `UPDATE core.workspace SET settings = settings || '{"zzFuture": {"x": 1}}'::jsonb WHERE id = $1`,
      [ws.id],
    );
    for (const writer of WRITERS) {
      const res = await send(ws, writer.method, writer.path, writer.body);
      expect(res.status, `${writer.name}: ${await res.clone().text()}`).toBe(200);
    }
    const after = await storedSettings(ws);
    expect(after["zzFuture"]).toEqual({ x: 1 });
    for (const writer of WRITERS) expect(after[writer.block]?.[writer.field]).toEqual(writer.value);
  }, 60_000);
});

describe("pool", () => {
  it("a one-connection pool: every settings writer completes (no second connection in a held transaction)", async () => {
    const ws = await workspace("pool");
    const single = await startServer({
      config: esignTestConfig(env, { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      // The relay legitimately serialises the only connection; stop it (E3.4 lesson).
      await single.container.relay.stop();
      const within = <T>(label: string, p: Promise<T>) =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label}: timed out (pool held?)`)), 20_000),
          ),
        ]);
      expect((await within("qa on", qa(ws, true, single))).status).toBe(200);
      for (const writer of WRITERS) {
        const res = await within(
          writer.name,
          send(ws, writer.method, writer.path, writer.body, single),
        );
        expect(res.status, `${writer.name}: ${await res.clone().text()}`).toBe(200);
      }
      expect((await within("qa off", qa(ws, false, single))).status).toBe(200);
      const after = await storedSettings(ws);
      expect(after.dataRoom?.qa?.enabled).toBe(false);
      for (const writer of WRITERS)
        expect(after[writer.block]?.[writer.field]).toEqual(writer.value);
    } finally {
      await single.stop();
    }
  }, 120_000);
});
