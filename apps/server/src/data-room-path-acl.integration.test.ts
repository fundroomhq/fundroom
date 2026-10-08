import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  waitFor,
} from "./test/esign-harness.js";

/*
 * Review R3A: a node's location feeds its effective-access row (review AZ gave a gated node its
 * own row, resolved from the grants of the folders ABOVE it at rebuild time), so moving the node
 * without moving `acl_version` leaves a row that keeps granting what the old ancestors allowed —
 * and the reconciler, which looks at versions and expiries only, never notices.
 *
 * The reviewer's reproduction: investor Ivy holds view + download on folder A; in A, document D
 * carries an NDA gate Ivy has accepted, document P none. A goes to the bin; D and P are restored
 * on their own and land under the root, where Ivy has nothing. P disappeared for her, D stayed
 * `granted` (check, detail, tree) — because `documents.restore` never bumped.
 *
 * Fix: every location change bumps in the same transaction — the services explicitly, and
 * data-room migration 0006's commit-time triggers as the backstop for every writer. The lock
 * order (E3.5 LX) is checked the way `lock-order.integration.test.ts` checks it.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql } = h;
const settle = () => new Promise((r) => setTimeout(r, 1_300));

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
  rootId: string;
  rootPath: string;
}
interface Folder {
  id: string;
  path: string;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  const tree = await request(slug, "/api/v1/data-room/tree", { cookie: owner.cookie });
  expect(tree.status, await tree.clone().text()).toBe(200);
  const rootId = (await json<{ rootId: string }>(tree)).rootId;
  const [root] = await sql<{ path: string }>(
    id,
    `SELECT path::text AS path FROM dataroom.folder WHERE id = '${rootId}'`,
  );
  return { id, slug, owner, rootId, rootPath: root?.path as string };
}

let people = 0;
async function investor(ws: Ws): Promise<Actor> {
  people += 1;
  return member(ws.slug, ws.id, `inv${people}@${ws.slug}.test`, "external", "investor");
}

async function createFolder(ws: Ws, parentId: string, name: string): Promise<Folder> {
  const res = await request(ws.slug, "/api/v1/data-room/folders", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ parentId, name }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const f = (
    await json<{ folders: { id: string; path: string; parentId: string | null; name: string }[] }>(
      res,
    )
  ).folders.find((x) => x.parentId === parentId && x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not created`);
  return { id: f.id, path: f.path };
}

/** A version-less document row (what the tree, detail and check need). */
async function createDoc(ws: Ws, folder: Folder, title: string): Promise<string> {
  const [d] = (
    await pg.pool.query<{ id: string }>(
      `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
       VALUES ($1, $2, $3::ltree, $4) RETURNING id`,
      [ws.id, folder.id, folder.path, title],
    )
  ).rows;
  return d?.id as string;
}

async function grant(ws: Ws, who: Actor, resource: Record<string, string>) {
  const res = await request(ws.slug, "/api/v1/access/grants", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({
      subject: { kind: "membership", id: who.membershipId },
      resource,
      capabilities: ["view", "download"],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function ndaGate(ws: Ws, resource: Record<string, string>, documentId: string) {
  const res = await request(ws.slug, "/api/v1/access/policies", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({
      kind: "nda",
      target: { kind: "resource", resource },
      config: { documentId },
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function clickwrapNda(ws: Ws): Promise<string> {
  const res = await request(ws.slug, "/api/v1/compliance/documents", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({
      slug: "room-nda",
      title: "Room NDA",
      kind: "nda",
      requiresAcceptance: false,
      ceremony: "clickwrap",
      body: "# Room NDA\n\nKeep it secret.",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ document: { id: string } }>(res)).document.id;
}

async function accept(ws: Ws, who: Actor, documentId: string) {
  const res = await request(ws.slug, "/api/v1/compliance/acceptances", {
    method: "POST",
    cookie: who.cookie,
    body: JSON.stringify({ documentId, versionNo: 1 }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const post = (ws: Ws, path: string, body: Record<string, unknown> = {}) =>
  request(ws.slug, `/api/v1/data-room${path}`, {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify(body),
  });
const del = (ws: Ws, path: string) =>
  request(ws.slug, `/api/v1/data-room${path}`, { method: "DELETE", cookie: ws.owner.cookie });
const patch = (ws: Ws, path: string, body: Record<string, unknown>) =>
  request(ws.slug, `/api/v1/data-room${path}`, {
    method: "PATCH",
    cookie: ws.owner.cookie,
    body: JSON.stringify(body),
  });

async function expectOk(res: Response | Promise<Response>) {
  const r = await res;
  expect(r.status, await r.clone().text()).toBeLessThan(300);
}

/** authz.check on the node as it stands in the database now. */
async function check(ws: Ws, who: Actor, kind: "document" | "folder", id: string) {
  const [row] = await sql<{ path: string }>(
    ws.id,
    kind === "document"
      ? `SELECT folder_path::text AS path FROM dataroom.document WHERE id = '${id}'`
      : `SELECT path::text AS path FROM dataroom.folder WHERE id = '${id}'`,
  );
  return running.container.authz.check(
    { workspaceId: ws.id, membershipId: who.membershipId },
    { kind, id, path: row?.path },
    "view",
  );
}

/** What Ivy sees of one document through every door the reviewer tried. */
async function seen(ws: Ws, who: Actor, id: string) {
  const decision = await check(ws, who, "document", id);
  const detail = await request(ws.slug, `/api/v1/data-room/documents/${id}`, {
    cookie: who.cookie,
  });
  const tree = await json<{ documents: { id: string }[] }>(
    await request(ws.slug, "/api/v1/data-room/tree", { cookie: who.cookie }),
  );
  return {
    reason: decision.reason,
    detail: detail.status,
    listed: tree.documents.some((d) => d.id === id),
  };
}
const HIDDEN = { reason: "no_grant", detail: 404, listed: false };
const OPEN = { reason: "granted", detail: 200, listed: true };

/**
 * Polls up to 8 s — beyond the 5 s `acl_version` cache — so a fixed build passes at once and a
 * broken one fails for good (the stale row never goes away on its own).
 */
async function eventually(ws: Ws, who: Actor, id: string, want: typeof HIDDEN) {
  let last: unknown;
  try {
    await waitFor(
      `document ${id} to read ${JSON.stringify(want)}`,
      async () => {
        last = await seen(ws, who, id);
        return JSON.stringify(last) === JSON.stringify(want) ? true : undefined;
      },
      8_000,
    );
  } catch {
    expect(last, `document ${id}`).toEqual(want);
  }
}

/** A room: folder A granted to Ivy, D (NDA-gated, accepted) and P inside, C ungranted. */
async function room(prefix: string) {
  const ws = await workspace(prefix);
  const ivy = await investor(ws);
  const nda = await clickwrapNda(ws);
  const a = await createFolder(ws, ws.rootId, "A");
  const c = await createFolder(ws, ws.rootId, "C");
  const d = await createDoc(ws, a, "Gated deck");
  const p = await createDoc(ws, a, "Plain deck");
  await grant(ws, ivy, { kind: "folder", id: a.id, path: a.path });
  await ndaGate(ws, { kind: "document", id: d }, nda);
  await accept(ws, ivy, nda);
  await eventually(ws, ivy, d, OPEN);
  await eventually(ws, ivy, p, OPEN);
  return { ws, ivy, nda, a, c, d, p };
}

async function aclVersion(ws: Ws): Promise<number> {
  const [r] = (
    await pg.pool.query<{ v: string }>(
      "SELECT acl_version::text AS v FROM core.workspace WHERE id = $1",
      [ws.id],
    )
  ).rows;
  return Number(r?.v);
}
async function pathEvents(ws: Ws): Promise<number> {
  const [r] = (
    await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.outbox
        WHERE workspace_id = $1 AND topic = 'acl.changed' AND payload->>'cause' = 'data-room.path'`,
      [ws.id],
    )
  ).rows;
  return r?.n ?? 0;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    // No worker: no outbox-driven rebuild runs behind the test's back, so a stale row stays
    // stale until something moves `acl_version` (what the reviewer saw once the queue was idle).
    config: esignTestConfig(freshSecrets(pg.connectionString), { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("a node's effective-access row follows it when it moves (review R3A)", () => {
  it("the reviewer's scenario: D and P restored to the root out of a binned granted folder", async () => {
    const { ws, ivy, a, d, p } = await room("rra");
    await expectOk(del(ws, `/folders/${a.id}`));
    await expectOk(post(ws, `/documents/${d}/restore`));
    await expectOk(post(ws, `/documents/${p}/restore`));
    const [landed] = await sql<{ path: string }>(
      ws.id,
      `SELECT folder_path::text AS path FROM dataroom.document WHERE id = '${d}'`,
    );
    expect(landed?.path).toBe(ws.rootPath);
    await eventually(ws, ivy, p, HIDDEN);
    await eventually(ws, ivy, d, HIDDEN);
    // And it stays that way through the reconciler.
    const reconcile = running.container.authz.jobs.find((j) => j.name === "authz.reconcile");
    await reconcile?.handler({ id: "r", name: "authz.reconcile", data: {} } as never);
    expect(await seen(ws, ivy, d)).toEqual(HIDDEN);
  }, 90_000);

  it("a gated document moved out of the granted folder", async () => {
    const { ws, ivy, c, d, p } = await room("rrb");
    await expectOk(patch(ws, `/documents/${d}`, { folderId: c.id }));
    await eventually(ws, ivy, d, HIDDEN);
    await eventually(ws, ivy, p, OPEN);
    // Moved back, it opens again: the row is rebuilt at the new place, not merely dropped.
    const [a] = await sql<{ folder_id: string }>(
      ws.id,
      `SELECT folder_id FROM dataroom.document WHERE id = '${p}'`,
    );
    await expectOk(patch(ws, `/documents/${d}`, { folderId: a?.folder_id as string }));
    await eventually(ws, ivy, d, OPEN);
  }, 90_000);

  it("a gated sub-folder restored to the root out of a binned granted folder", async () => {
    const { ws, ivy, nda, a } = await room("rrc");
    const b = await createFolder(ws, a.id, "B");
    const q = await createDoc(ws, b, "In B");
    await ndaGate(ws, { kind: "folder", id: b.id, path: b.path }, nda);
    await waitFor("B to open", async () =>
      (await check(ws, ivy, "folder", b.id)).reason === "granted" ? true : undefined,
    );
    await eventually(ws, ivy, q, OPEN);
    await expectOk(del(ws, `/folders/${a.id}`));
    await expectOk(post(ws, `/folders/${b.id}/restore`));
    await waitFor(
      "B to close",
      async () => ((await check(ws, ivy, "folder", b.id)).reason === "no_grant" ? true : undefined),
      8_000,
    );
    await eventually(ws, ivy, q, HIDDEN);
  }, 90_000);
});

describe("the database backstop (data-room migration 0006)", () => {
  it("a raw location change bumps acl_version once per transaction and files acl.changed", async () => {
    const { ws, ivy, c, d, p } = await room("rrd");
    const before = await aclVersion(ws);
    const events = await pathEvents(ws);
    // Two documents moved by hand, in one transaction, with nothing else: one bump, one event.
    await running.container.db.withTenant(systemContext(ws.id), async (tx) => {
      await tx.execute(
        `UPDATE dataroom.document SET folder_id = '${c.id}', folder_path = '${c.path}'::ltree
          WHERE id IN ('${d}', '${p}')`,
      );
    });
    expect(await aclVersion(ws)).toBe(before + 1);
    expect(await pathEvents(ws)).toBe(events + 1);
    await eventually(ws, ivy, d, HIDDEN);
    await eventually(ws, ivy, p, HIDDEN);
    // A title change is not a move; a transaction that already bumped (the services) adds none.
    await running.container.db.withTenant(systemContext(ws.id), async (tx) => {
      await tx.execute(`UPDATE dataroom.document SET title = 'Renamed' WHERE id = '${d}'`);
    });
    expect(await aclVersion(ws)).toBe(before + 1);
    const ctx = systemContext(ws.id);
    await running.container.db.withTenant(ctx, async (tx) => {
      await running.container.authz.bump(tx, ctx, "test");
      await tx.execute(
        `UPDATE dataroom.document SET folder_id = '${ws.rootId}', folder_path = '${ws.rootPath}'::ltree
          WHERE id = '${d}'`,
      );
    });
    expect(await aclVersion(ws)).toBe(before + 2);
    expect(await pathEvents(ws)).toBe(events + 1);
  }, 90_000);

  it("a rolled-back move bumps nothing", async () => {
    const { ws, c, d } = await room("rre");
    const before = await aclVersion(ws);
    await expect(
      running.container.db.withTenant(systemContext(ws.id), async (tx) => {
        await tx.execute(
          `UPDATE dataroom.document SET folder_id = '${c.id}', folder_path = '${c.path}'::ltree
            WHERE id = '${d}'`,
        );
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await aclVersion(ws)).toBe(before);
  }, 90_000);
});

/* ---- lock order (E3.5 LX): entity rows → workspace row → audit chain ---------------------- */

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
type Outcome = { ok: true; status: number; text: string } | { ok: false; error: string };
async function outcome(p: Promise<unknown>): Promise<Outcome> {
  try {
    const r = await p;
    if (!(r instanceof Response)) return { ok: true, status: 200, text: "" };
    return { ok: true, status: r.status, text: r.status >= 300 ? await r.text() : "" };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) };
  }
}

/** `lock-order.integration.test.ts`'s `lineUp`: holder row-locks the workspace, contenders queue. */
async function lineUp(ws: Ws, contenders: readonly (() => Promise<unknown>)[]): Promise<Outcome[]> {
  await settle();
  const before = await deadlocks(pg.pool);
  const holder = await pg.pool.connect();
  const pending: Promise<Outcome>[] = [];
  try {
    await holder.query("BEGIN");
    await holder.query("SET LOCAL lock_timeout = '30s'");
    const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows as [{ pid: number }];
    await holder.query("UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1", [
      ws.id,
    ]);
    for (const [i, start] of contenders.entries()) {
      pending.push(outcome(start()));
      await blockedAtLeast(pid, i + 1);
    }
    const { rows: chains } = await pg.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 24301 AND objsubid = 2 AND granted
          AND objid = (hashtext($1::uuid::text)::bigint & 4294967295)::oid AND pid <> $2`,
      [ws.id, pid],
    );
    expect(
      chains,
      "a contender holds the audit chain while it waits for the workspace row",
    ).toEqual([]);
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  const out = await Promise.all(pending);
  await settle();
  expect(await deadlocks(pg.pool)).toBe(before);
  return out;
}
function allOk(outcomes: readonly Outcome[]): void {
  for (const o of outcomes) {
    if (!o.ok) throw new Error(o.error);
    expect(o.status, o.text).toBeLessThan(300);
  }
}

let days = 0;
const patchSettings = (ws: Ws) => {
  days = (days + 1) % 300;
  return request(ws.slug, "/api/v1/compliance/settings", {
    method: "PATCH",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ relationshipWarningDays: days + 1 }),
  });
};

describe("lock order with the commit-time bump", () => {
  it("document restore, document move, folder move and a trigger-only move vs settings PATCH", async () => {
    const { ws, a, c, d } = await room("rrf");
    const e = await createDoc(ws, a, "Raw");
    const b = await createFolder(ws, a.id, "B");
    await expectOk(del(ws, `/documents/${d}`));
    await expectOk(del(ws, `/folders/${a.id}`)); // binned with D: D's restore goes to the root
    await expectOk(post(ws, `/folders/${b.id}/restore`)); // B back under the root
    await expectOk(post(ws, `/documents/${e}/restore`)); // E too
    const rawMove = () =>
      running.container.db.withTenant(systemContext(ws.id), async (tx) => {
        await tx.execute(
          `UPDATE dataroom.document SET folder_id = '${c.id}', folder_path = '${c.path}'::ltree
            WHERE id = '${e}'`,
        );
      });
    const [bNow] = await sql<{ path: string }>(
      ws.id,
      `SELECT path::text AS path FROM dataroom.folder WHERE id = '${b.id}'`,
    );
    expect(bNow?.path).toBe(`${ws.rootPath}.${b.id.replaceAll("-", "")}`);
    allOk(
      await lineUp(ws, [
        () => post(ws, `/documents/${d}/restore`),
        rawMove,
        () => patch(ws, `/folders/${b.id}`, { parentId: c.id }),
        () => patchSettings(ws),
      ]),
    );
  }, 120_000);

  it("a storm of moves and restores vs settings PATCHes and grants", async () => {
    const ws = await workspace("rrg");
    const x = await createFolder(ws, ws.rootId, "X");
    const y = await createFolder(ws, ws.rootId, "Y");
    const docs: string[] = [];
    for (let i = 0; i < 12; i++) docs.push(await createDoc(ws, x, `Doc ${i}`));
    const investors: Actor[] = [];
    for (let i = 0; i < 6; i++) investors.push(await investor(ws));
    await settle();
    const before = await deadlocks(pg.pool);
    const results = await Promise.all([
      ...docs.map((id, i) => patch(ws, `/documents/${id}`, { folderId: i % 2 ? y.id : ws.rootId })),
      ...docs.slice(0, 6).map(() => patchSettings(ws)),
      ...investors.map((inv) =>
        request(ws.slug, "/api/v1/access/grants", {
          method: "POST",
          cookie: ws.owner.cookie,
          body: JSON.stringify({
            subject: { kind: "membership", id: inv.membershipId },
            resource: { kind: "folder", id: x.id, path: x.path },
            capabilities: ["view"],
          }),
        }),
      ),
    ]);
    const bad = await Promise.all(
      results.filter((r) => r.status >= 300).map(async (r) => `${r.status} ${await r.text()}`),
    );
    await settle();
    expect({ bad, deadlocks: (await deadlocks(pg.pool)) - before }).toEqual({
      bad: [],
      deadlocks: 0,
    });
  }, 180_000);
});
