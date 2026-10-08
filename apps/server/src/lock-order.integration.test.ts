import { createWorkspace, platformContext, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  deadlocks,
  type EnvelopeBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * E3.5 LX: ONE global lock order for the workspace row and the audit chain —
 *
 *     [entity rows / per-feature advisory locks] → workspace row (FOR NO KEY UPDATE)
 *       → search entries → audit chain (advisory 24301) → outbox
 *
 * enforced structurally: `lockAuditChain` (which `audit.record` calls before every insert) takes
 * the workspace row before the chain, and every search write takes the row first too. Before,
 * settings writers and the click-wrap/e-sign acceptance took row → chain while group/membership/
 * document/grant writers audited first and bumped `acl_version` afterwards (chain → row).
 *
 * Deterministic interleaves: a holder transaction row-locks the workspace (what a settings writer
 * does first) and keeps it while the real contenders are started one at a time — each is waited
 * for until it blocks — so the contenders line up at their first workspace-row lock in a known
 * order. With the old order the second contender had already taken the audit chain before it
 * blocked on the row, so once the holder commits the first contender gets the row, waits for the
 * chain, and Postgres breaks the cycle (40P01 → a 500). With the new order nobody holds the chain
 * without the row. Then real-code storms, as the reviewer ran them.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, runJob } = h;

// pg_stat counters reach the view at most once a second
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
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  return { id, slug, owner };
}

let people = 0;
async function investor(ws: Ws): Promise<Actor> {
  people += 1;
  return member(ws.slug, ws.id, `inv${people}@${ws.slug}.test`, "external", "investor");
}

/** A membership without a session (a group-add target). */
async function bareMember(ws: Ws): Promise<string> {
  people += 1;
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email: `m${people}@${ws.slug}.test` });
  const m = await provisionMembership(deps, {
    workspaceId: ws.id,
    userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
  return m.id;
}

async function createDoc(
  ws: Ws,
  opts: { slug: string; ceremony?: "clickwrap" | "esign"; requiresAcceptance?: boolean },
): Promise<string> {
  const res = await request(ws.slug, "/api/v1/compliance/documents", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({
      slug: opts.slug,
      title: "Mutual NDA",
      kind: "nda",
      requiresAcceptance: opts.requiresAcceptance ?? true,
      ceremony: opts.ceremony ?? "clickwrap",
      body: "# NDA\n\nKeep it secret.",
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ document: { id: string } }>(res)).document.id;
}

async function createGroup(ws: Ws, name: string): Promise<string> {
  const res = await request(ws.slug, "/api/v1/access/groups", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ name, kind: "custom" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ id: string }>(res)).id;
}

const accept = (ws: Ws, inv: Actor, documentId: string) =>
  request(ws.slug, "/api/v1/compliance/acceptances", {
    method: "POST",
    cookie: inv.cookie,
    body: JSON.stringify({ documentId, versionNo: 1 }),
  });
const addToGroup = (ws: Ws, groupId: string, membershipId: string) =>
  request(ws.slug, `/api/v1/access/groups/${groupId}/members`, {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ membershipIds: [membershipId] }),
  });
const patchDoc = (ws: Ws, documentId: string, body: Record<string, unknown>) =>
  request(ws.slug, `/api/v1/compliance/documents/${documentId}`, {
    method: "PATCH",
    cookie: ws.owner.cookie,
    body: JSON.stringify(body),
  });
const publishDoc = (ws: Ws, documentId: string, body: string) =>
  request(ws.slug, `/api/v1/compliance/documents/${documentId}/versions`, {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ body }),
  });
let days = 0;
const patchSettings = (ws: Ws) => {
  days = (days + 1) % 300;
  return request(ws.slug, "/api/v1/compliance/settings", {
    method: "PATCH",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ relationshipWarningDays: days + 1 }),
  });
};
const revoke = (ws: Ws, membershipId: string) =>
  request(ws.slug, `/api/v1/access/people/${membershipId}/revoke`, {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({}),
  });

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

/**
 * Row-locks the workspace in a holder transaction (a settings writer's first step), starts each
 * contender in turn and waits until it blocks, asserts none of them holds the audit chain while
 * it waits, then commits. Returns every contender's outcome
 * and asserts no deadlock was detected meanwhile.
 */
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
    // Every contender now waits for the workspace row. The invariant: none of them holds the
    // audit chain while it waits (with the old order an audit-then-bump contender did — and
    // then whichever contender got the row first after the commit closed a cycle with it).
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

function expectOk(outcomes: readonly Outcome[]): void {
  for (const o of outcomes) {
    if (!o.ok) throw new Error(o.error);
    expect(o.status, o.text).toBeLessThan(300);
  }
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    // No worker: jobs run only when a test runs them.
    // CONTROL_PLANE=on: the upload-start interleave needs a storage quota (a plan); workspaces
    // without a plan — every other test here — are limited nowhere.
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      ROLES: "api",
      CONTROL_PLANE: "on",
    }),
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

describe("the structure: every audit takes the workspace row before the audit chain", () => {
  it("an audit blocked on the workspace row holds no audit-chain lock", async () => {
    const ws = await workspace("lxs");
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      await holder.query("SELECT 1 FROM core.workspace WHERE id = $1 FOR NO KEY UPDATE", [ws.id]);
      const audit = running.container.audit.recordDetached(systemContext(ws.id), {
        action: "workspace.lock_probe",
        resourceKind: "workspace",
        resourceId: ws.id,
      });
      audit.catch(() => undefined);
      await blockedAtLeast(pid, 1);
      const { rows } = await pg.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 24301 AND granted AND pid <> $1`,
        [pid],
      );
      expect(rows[0]?.n).toBe(0);
      await holder.query("COMMIT");
      await audit;
    } finally {
      holder.release();
    }
  });

  it("platform (host/system) audits have no workspace row and still record", async () => {
    const rec = await running.container.audit.recordDetached(platformContext(), {
      action: "workspace.lock_probe",
      resourceKind: "workspace",
      actorKind: "system",
    });
    expect(rec.seq).toBeGreaterThan(0);
  });
});

describe("deterministic interleaves (holder row-locks the workspace, contenders line up)", () => {
  it("click-wrap acceptance vs group-member add", async () => {
    const ws = await workspace("lxa");
    const doc = await createDoc(ws, { slug: "terms" });
    const group = await createGroup(ws, "Board");
    const inv = await investor(ws);
    const target = await bareMember(ws);
    expectOk(await lineUp(ws, [() => accept(ws, inv, doc), () => addToGroup(ws, group, target)]));
  }, 90_000);

  it("click-wrap acceptance vs legal document PATCH (requiresAcceptance) and publish", async () => {
    const ws = await workspace("lxb");
    const doc = await createDoc(ws, { slug: "terms" });
    const other = await createDoc(ws, { slug: "privacy", requiresAcceptance: false });
    const inv = await investor(ws);
    const inv2 = await investor(ws);
    expectOk(
      await lineUp(ws, [
        () => accept(ws, inv, doc),
        () => patchDoc(ws, other, { requiresAcceptance: true }),
      ]),
    );
    expectOk(
      await lineUp(ws, [
        () => accept(ws, inv2, doc),
        () => publishDoc(ws, other, "# Privacy\n\nVersion two."),
      ]),
    );
  }, 90_000);

  it("membership revoke vs settings PATCH", async () => {
    const ws = await workspace("lxc");
    const inv = await investor(ws);
    expectOk(await lineUp(ws, [() => patchSettings(ws), () => revoke(ws, inv.membershipId)]));
  }, 90_000);

  it("membership suspend / unsuspend (SCIM, E3.8) vs settings PATCH", async () => {
    const ws = await workspace("lxh");
    const inv = await investor(ws);
    const other = await bareMember(ws);
    const scim = { kind: "system", label: "scim:lock-order" } as const;
    const memberships = running.container.auth.memberships;
    const sys = systemContext(ws.id);
    await memberships.suspend(sys, { membershipId: other, reason: "test" }, scim);
    expectOk(
      await lineUp(ws, [
        () => patchSettings(ws),
        () => memberships.suspend(sys, { membershipId: inv.membershipId, reason: "test" }, scim),
        () => memberships.unsuspend(sys, { membershipId: other }, scim),
      ]),
    );
    const rows = await sql<{ id: string; status: string }>(
      ws.id,
      `SELECT id, status::text FROM core.membership WHERE id IN ('${inv.membershipId}', '${other}')`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [inv.membershipId]: "suspended",
      [other]: "active",
    });
  }, 90_000);

  describe("e-sign collect settling an NDA", () => {
    async function ndaReady(prefix: string) {
      const ws = await workspace(prefix);
      const put = await request(ws.slug, "/api/v1/esign/connection", {
        method: "PUT",
        cookie: ws.owner.cookie,
        body: JSON.stringify({
          driver: "docuseal",
          credentials: { apiToken: `tok-${ws.slug}-01` },
        }),
      });
      expect(put.status, await put.clone().text()).toBe(200);
      const nda = await createDoc(ws, { slug: "nda", ceremony: "esign" });
      const inv = await investor(ws);
      const res = await request(ws.slug, "/api/v1/esign/nda/start", {
        method: "POST",
        cookie: inv.cookie,
        body: JSON.stringify({
          documentId: nda,
          consentToElectronicRecords: true,
          disclosureVersion: 1,
        }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const envelope = (await json<{ envelope: EnvelopeBody }>(res)).envelope;
      const [r] = await sql<{ provider_ref: string }>(
        ws.id,
        `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelope.id}'`,
      );
      mem.vendor.complete(r?.provider_ref as string);
      await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
      const collect = () =>
        runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
      return { ws, nda, inv, collect };
    }

    async function settled(ws: Ws, nda: string, inv: Actor) {
      const status = await running.container.esign.ndaStatus(
        systemContext(ws.id),
        inv.membershipId,
        nda,
      );
      expect(status.status).toBe("completed");
    }

    it("vs settings PATCH", async () => {
      const { ws, nda, inv, collect } = await ndaReady("lxd");
      expectOk(await lineUp(ws, [collect, () => patchSettings(ws)]));
      await settled(ws, nda, inv);
    }, 90_000);

    it("vs group-member add", async () => {
      const { ws, nda, inv, collect } = await ndaReady("lxe");
      const group = await createGroup(ws, "Board");
      const target = await bareMember(ws);
      expectOk(await lineUp(ws, [collect, () => addToGroup(ws, group, target)]));
      await settled(ws, nda, inv);
    }, 90_000);
  });

  describe("data-room Q&A", () => {
    async function qaReady(prefix: string) {
      const ws = await workspace(prefix);
      await pg.pool.query(
        `UPDATE core.workspace SET settings = jsonb_set(settings, '{dataRoom}',
           COALESCE(settings->'dataRoom', '{}'::jsonb) || '{"qa": {"enabled": true}}'::jsonb)
         WHERE id = $1`,
        [ws.id],
      );
      running.container.moduleServices.workspaces.invalidate(ws.id);
      const tree = await request(ws.slug, "/api/v1/data-room/tree", { cookie: ws.owner.cookie });
      expect(tree.status, await tree.clone().text()).toBe(200);
      const [root] = (
        await pg.pool.query<{ id: string; path: string }>(
          "SELECT id, path::text FROM dataroom.folder WHERE workspace_id = $1 AND parent_id IS NULL",
          [ws.id],
        )
      ).rows;
      const [d] = (
        await pg.pool.query<{ id: string }>(
          `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
           VALUES ($1, $2, $3::ltree, 'Board deck') RETURNING id`,
          [ws.id, root?.id, root?.path],
        )
      ).rows;
      const question = async (subject: string): Promise<string> => {
        const [q] = (
          await pg.pool.query<{ id: string }>(
            `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id, source,
                status, subject, body)
             VALUES ($1, 'document', $2, 'staff', 'assigned', $3, 'Why?') RETURNING id`,
            [ws.id, d?.id, subject],
          )
        ).rows;
        await pg.pool.query(
          `INSERT INTO dataroom.qa_answer (workspace_id, question_id, body, author_membership_id)
           VALUES ($1, $2, 'Because.', $3)`,
          [ws.id, q?.id, ws.owner.membershipId],
        );
        return q?.id as string;
      };
      const release = (id: string) =>
        request(ws.slug, `/api/v1/data-room/qa/inbox/${id}/release`, {
          method: "POST",
          cookie: ws.owner.cookie,
          body: JSON.stringify({ visibility: "target" }),
        });
      return { ws, question, release };
    }

    it("answer release vs settings PATCH", async () => {
      const { ws, question, release } = await qaReady("lxf");
      const q = await question("Runway");
      expectOk(await lineUp(ws, [() => release(q), () => patchSettings(ws)]));
      const [row] = (
        await pg.pool.query<{ status: string }>(
          "SELECT status FROM dataroom.qa_question WHERE id = $1",
          [q],
        )
      ).rows;
      expect(row?.status).toBe("published");
    }, 90_000);

    it("two answer releases (no share-lock upgrade) vs settings PATCH", async () => {
      const { ws, question, release } = await qaReady("lxg");
      const a = await question("Burn");
      const b = await question("Hiring");
      // Both releases wait for the holder at their workspace-row lock. With FOR SHARE they would
      // both be granted it on commit and then both need FOR NO KEY UPDATE for the audit: a
      // deadlock between the two upgrades.
      expectOk(await lineUp(ws, [() => release(a), () => release(b), () => patchSettings(ws)]));
    }, 90_000);
  });
});

describe("data-room document PATCH vs inserts that reference the document (A-3 RR2 H1)", () => {
  /*
   * A document PATCH locks the document row (`DocumentRepo.lockLive`) and takes the workspace row
   * later, for its audit. Q&A import and a quota-checked upload start take the workspace row first
   * and then insert a row referencing the document, whose foreign-key check takes FOR KEY SHARE on
   * it. `lockLive` must be FOR NO KEY UPDATE (which KEY SHARE does not wait for); FOR UPDATE closes a
   * cycle (40P01 → a 500). Deterministic: a holder locks the document, the PATCH lines up on it,
   * the contender takes the workspace row and lines up on its FK check, the holder commits; the
   * PATCH is granted the document first, and with FOR UPDATE the contender then waits for it while
   * it waits for the contender's workspace row.
   */
  interface DocWs extends Ws {
    root: { id: string; path: string };
  }

  async function docWorkspace(prefix: string, planId: string | null): Promise<DocWs> {
    const ws = await workspace(prefix);
    if (planId !== null) {
      // The control-plane columns are written by the host actor only (trigger).
      await running.container.db.withHost((tx) =>
        tx.execute(`UPDATE core.workspace SET plan_id = '${planId}' WHERE id = '${ws.id}'`),
      );
      running.container.resolver.invalidate();
    }
    const tree = await request(ws.slug, "/api/v1/data-room/tree", { cookie: ws.owner.cookie });
    expect(tree.status, await tree.clone().text()).toBe(200);
    const [root] = (
      await pg.pool.query<{ id: string; path: string }>(
        "SELECT id, path::text FROM dataroom.folder WHERE workspace_id = $1 AND parent_id IS NULL",
        [ws.id],
      )
    ).rows;
    return { ...ws, root: root as { id: string; path: string } };
  }

  async function document(ws: DocWs, title: string): Promise<string> {
    const [d] = (
      await pg.pool.query<{ id: string }>(
        `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
         VALUES ($1, $2, $3::ltree, $4) RETURNING id`,
        [ws.id, ws.root.id, ws.root.path, title],
      )
    ).rows;
    return d?.id as string;
  }

  const patchDocument = (ws: Ws, id: string, body: unknown) =>
    request(ws.slug, `/api/v1/data-room/documents/${id}`, {
      method: "PATCH",
      cookie: ws.owner.cookie,
      body: JSON.stringify(body),
    });

  /** Holder locks the document; the PATCH lines up first, the contender second; commit. */
  async function documentLineUp(
    documentId: string,
    patch: () => Promise<Response>,
    contender: () => Promise<Response>,
  ): Promise<Outcome[]> {
    await settle();
    const before = await deadlocks(pg.pool);
    const holder = await pg.pool.connect();
    const pending: Promise<Outcome>[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '30s'");
      const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      // FOR UPDATE here (unlike the PATCH) so the contender's FK check waits too, holding the
      // workspace row: both are lined up on the document when it commits.
      await holder.query("SELECT 1 FROM dataroom.document WHERE id = $1 FOR UPDATE", [documentId]);
      pending.push(outcome(patch()));
      await blockedAtLeast(pid, 1);
      pending.push(outcome(contender()));
      await blockedAtLeast(pid, 2);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    const out = await Promise.all(pending);
    await settle();
    expect(await deadlocks(pg.pool), "deadlocks during the interleave").toBe(before);
    return out;
  }

  beforeAll(async () => {
    await pg.pool.query(
      `INSERT INTO core.plan (id, name, limits, limits_schema_version)
       VALUES ('lx-quota', 'Quota', '{"storageBytes": 1000000000000}'::jsonb, 2)`,
    );
  });

  it("Q&A import (workspace row → question insert) vs document PATCH, 10 times", async () => {
    const ws = await docWorkspace("lxh", null);
    for (let i = 0; i < 10; i++) {
      const d = await document(ws, `Deck ${i}`);
      expectOk(
        await documentLineUp(
          d,
          () => patchDocument(ws, d, { protection: { download: i % 2 === 0 } }),
          () =>
            request(ws.slug, "/api/v1/data-room/qa/import", {
              method: "POST",
              cookie: ws.owner.cookie,
              body: JSON.stringify({
                csv: `target_kind,target_id,subject,question\ndocument,${d},Q${i},Why?\n`,
                dryRun: false,
              }),
            }),
        ),
      );
    }
  }, 300_000);

  it("new-version upload start under a storage quota (workspace row → upload insert) vs document PATCH, 10 times", async () => {
    const ws = await docWorkspace("lxi", "lx-quota");
    for (let i = 0; i < 10; i++) {
      const d = await document(ws, `Model ${i}`);
      expectOk(
        await documentLineUp(
          d,
          () => patchDocument(ws, d, { title: `Model ${i} renamed` }),
          () =>
            request(ws.slug, "/api/v1/data-room/uploads", {
              method: "POST",
              cookie: ws.owner.cookie,
              body: JSON.stringify({
                fileName: "v2.pdf",
                size: 1000,
                contentType: "application/pdf",
                documentId: d,
              }),
            }),
        ),
      );
      // One open upload per document is fine; keep the member's open-upload count low.
      await pg.pool.query("UPDATE dataroom.upload SET status = 'failed' WHERE workspace_id = $1", [
        ws.id,
      ]);
    }
  }, 300_000);
});

describe("real-code storms (the reviewer's reproduction)", () => {
  async function storm(
    prefix: string,
    other: (
      ws: Ws,
      i: number,
      ctx: { group: string; members: string[]; doc2: string },
    ) => Promise<Response>,
  ) {
    const ws = await workspace(prefix);
    const doc = await createDoc(ws, { slug: "terms" });
    const doc2 = await createDoc(ws, { slug: "privacy", requiresAcceptance: false });
    const group = await createGroup(ws, "Board");
    const investors: Actor[] = [];
    for (let i = 0; i < 12; i++) investors.push(await investor(ws));
    const members: string[] = [];
    for (let i = 0; i < 24; i++) members.push(await bareMember(ws));
    await settle();
    const before = await deadlocks(pg.pool);
    const results = await Promise.all([
      ...investors.map((inv) => accept(ws, inv, doc)),
      ...members.map((_, i) => other(ws, i, { group, members, doc2 })),
    ]);
    const bad = await Promise.all(
      results.filter((r) => r.status >= 300).map(async (r) => `${r.status} ${await r.text()}`),
    );
    await settle();
    const after = await deadlocks(pg.pool);
    expect({ bad, deadlocks: after - before }).toEqual({ bad: [], deadlocks: 0 });
    const [acc] = await sql<{ n: number }>(
      ws.id,
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'legal.document_accepted'`,
    );
    expect(acc?.n).toBe(12);
  }

  it("12 click-wrap acceptances vs 24 group-member adds", async () => {
    await storm("lxt", (ws, i, c) => addToGroup(ws, c.group, c.members[i] as string));
  }, 180_000);

  it("12 click-wrap acceptances vs 24 legal document PATCHes", async () => {
    await storm("lxu", (ws, i, c) => patchDoc(ws, c.doc2, { requiresAcceptance: i % 2 === 0 }));
  }, 180_000);
});
