import { randomBytes, randomUUID } from "node:crypto";
import type { AuditRecorder } from "@fundroom/audit";
import {
  createDatabase,
  createWorkspace,
  type Database,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShareLinkRepo } from "../repos/share-link-repo.js";
import type { CodeKeyRing } from "../token.js";
import { createShareLinkService, type ShareLinkService } from "./links.js";
import { createMemoryViewSessionLedger, type ViewSessionLedger } from "./types.js";

/*
 * `max_views` against real Postgres, across a restart.
 *
 * `design/05` §4.4 defines a view limit as counting **unique sessions, not requests**. Work
 * package B could only dedup in process, because `core.share_link_visit` had nowhere to record
 * which sessions had been counted; `core.share_link_view` (migration 0008) is that record, and
 * `claimViewSession` — `INSERT … ON CONFLICT DO NOTHING RETURNING` — is what gates the
 * `share_link.views` increment on it.
 *
 * The bug this file exists to pin down is not a race and not a cap arithmetic slip: it is that a
 * *new process* used to have an empty set, so the session a dead process had already counted got
 * counted a second time and a view cap quietly shortened itself on every redeploy. So every
 * assertion here is made by a **second `ShareLinkService` instance**, built after the first one
 * has done its work and sharing nothing with it but the database — which is all a restarted node,
 * or the other node behind the load balancer, shares. The final case wires
 * `createMemoryViewSessionLedger` into those same instances and watches the cap break, so the
 * durable claim is demonstrably load-bearing rather than incidentally correct.
 *
 * It also pins two things only a database can answer: that the claim really is one statement with
 * no read-then-write window (ten concurrent requests of one session count one view), and that a
 * session id reaches the `uuid` column intact.
 */

let pg: TestPostgres;
let db: Database;
let ws: string;

const KEY = randomBytes(32);
const keyRing: CodeKeyRing = (() => {
  const entry = { id: "v1", key: KEY, fingerprint: "sha256:test" };
  return {
    current: entry,
    entries: [entry],
    get: (id: string) => (id === "v1" ? entry : undefined),
  };
})();

/** Audit rows are E2.3 WP D's business; this file is about the counter. */
const audit = {
  async record() {
    return undefined as never;
  },
} as unknown as Pick<AuditRecorder, "record">;

const STAFF = "01930000-0000-7000-8000-0000000000b1";

function staffCtx(): TenantContext {
  return { workspaceId: ws, actorKind: "staff", membershipId: STAFF };
}

/**
 * A brand-new service, as a freshly started process would build it. Nothing is memoised across
 * calls on purpose — that is the whole experiment.
 */
function service(viewSessions?: ViewSessionLedger): ShareLinkService {
  return createShareLinkService({
    audit,
    keyRing,
    ...(viewSessions === undefined ? {} : { viewSessions }),
  });
}

/** One transaction under the system context the public link routes run in (A4/A5). */
function asSystem<T>(fn: (tx: Tx, ctx: TenantContext) => Promise<T>): Promise<T> {
  const ctx = systemContext(ws);
  return db.withTenant(ctx, (tx) => fn(tx, ctx));
}

/** An external membership, the way redemption leaves one behind. */
async function makeVisitor(): Promise<string> {
  const id = randomUUID();
  await pg.pool.query(`INSERT INTO core."user" (id, display_name) VALUES ($1, 'Visitor')`, [id]);
  await pg.pool.query(
    `INSERT INTO core.membership (id, workspace_id, user_id, kind, role, status, source)
     VALUES ($1, $2, $1, 'external', 'investor', 'active', 'link')`,
    [id, ws],
  );
  return id;
}

/** Mints a link and admits `membershipId` through it; returns the link id. */
async function linkAdmitting(membershipId: string, maxViews: number | null): Promise<string> {
  const ctx = staffCtx();
  const minted = await db.withTenant(ctx, (tx) =>
    service().mint(ctx, tx, { label: "Series A room", maxViews }),
  );
  await asSystem((tx, c) => service().redeem(c, tx, { linkId: minted.link.id, membershipId }));
  return minted.link.id;
}

async function viewsOf(linkId: string): Promise<{ link: number; visit: number; rows: number }> {
  const ctx = staffCtx();
  return db.withTenant(ctx, async (tx) => {
    const repo = new ShareLinkRepo(ctx, tx);
    const record = await repo.byId(linkId);
    const visits = await repo.visits(linkId);
    const rows = await pg.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.share_link_view WHERE link_id = $1",
      [linkId],
    );
    return {
      link: record?.views ?? -1,
      visit: visits[0]?.views ?? -1,
      rows: rows.rows[0]?.n ?? -1,
    };
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 8 });
  ws = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  // D6: `none` (the column default) refuses to mint a link at all, and `506b` refuses an open
  // one. This file is about the counter, so the workspace is put in the mode where an open link
  // is permitted and the shape rule has nothing to say.
  await pg.pool.query("UPDATE core.workspace SET offering_status = '506c' WHERE id = $1", [ws]);
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("noteView across a restart", () => {
  it("does not re-count a session a dead process already counted", async () => {
    const visitor = await makeVisitor();
    const linkId = await linkAdmitting(visitor, 2);
    const session = randomUUID();

    // Instance 1 counts the session.
    await asSystem((tx, c) => service().noteView(c, tx, linkId, visitor, session));
    expect(await viewsOf(linkId)).toEqual({ link: 1, visit: 1, rows: 1 });

    // Restart: a new service, no shared state, same database. The same session comes back —
    // a reload after a deploy — and must cost nothing.
    for (let i = 0; i < 3; i++) {
      await asSystem((tx, c) => service().noteView(c, tx, linkId, visitor, session));
    }
    expect(await viewsOf(linkId)).toEqual({ link: 1, visit: 1, rows: 1 });

    // A genuinely new session still costs one, so the dedup is not simply "count nothing".
    await asSystem((tx, c) => service().noteView(c, tx, linkId, visitor, randomUUID()));
    expect(await viewsOf(linkId)).toEqual({ link: 2, visit: 2, rows: 2 });
  });

  it("does not let a restart burn a budget the next visitor still needs", async () => {
    // This is the harm, stated as a scenario rather than as a counter: a cap of two, two people
    // sent the same link, and a deploy in between. The redeploy must not cost the second person
    // their look.
    const first = await makeVisitor();
    const second = await makeVisitor();
    const ctx = staffCtx();
    const minted = await db.withTenant(ctx, (tx) =>
      service().mint(ctx, tx, { label: "Two looks", maxViews: 2 }),
    );
    const linkId = minted.link.id;
    for (const m of [first, second]) {
      await asSystem((tx, c) => service().redeem(c, tx, { linkId, membershipId: m }));
    }

    const session = randomUUID();
    await asSystem((tx, c) => service().noteView(c, tx, linkId, first, session));
    expect((await viewsOf(linkId)).link).toBe(1);

    // Deploy. The first visitor reloads in the same session they already had.
    await asSystem((tx, c) => service().noteView(c, tx, linkId, first, session));
    expect((await viewsOf(linkId)).link).toBe(1);

    // The link is therefore still live, and the second visitor's first look is still theirs.
    expect(await asSystem((tx, c) => service().resolve(c, tx, minted.token))).toBeDefined();
    await asSystem((tx, c) => service().noteView(c, tx, linkId, second, randomUUID()));
    expect((await viewsOf(linkId)).link).toBe(2);

    /*
     * The budget is now spent, and this is where work package H changed the answer (contract §10
     * H1–H3). This test used to assert that `resolve` stopped answering here. That was the bug,
     * not the contract: a spent link is still **open**, `PrincipalRepo` still emits its subject
     * for the two people it admitted (A6), and answering "no such link" to them locked out
     * exactly the visitors the cap was never about. `resolve` maps on `isOpen`; the caps are the
     * *admission* question and are asked one step later.
     *
     * So the property is stronger than the one it replaces — the cap did not disappear, it moved:
     */

    // 1. The link still resolves. Both visitors can come back on a new device.
    expect(await asSystem((tx, c) => service().resolve(c, tx, minted.token))).toBeDefined();

    // 2. But it admits nobody new. The policy is open (any address), so the only thing refusing
    //    this stranger is the spent view budget — `admitsEmail` still applies `isLive`.
    expect(
      await asSystem((tx, c) => service().admitsEmail(c, tx, linkId, "third@investor.test")),
    ).toBe(false);

    // 3. And the budget does not overrun: a third session counts nothing rather than taking the
    //    counter to 3. `max_views` is a tracking budget that stops counting, not a hard stop that
    //    stops viewing (H10) — which is this file's subject, so it is pinned here.
    await asSystem((tx, c) => service().noteView(c, tx, linkId, second, randomUUID()));
    expect((await viewsOf(linkId)).link).toBe(2);

    // 4. The negative half, kept so (1) is not merely "resolve always answers": on a state that
    //    really is dead, `resolve` really does stop. Pausing is a state `isOpen` and
    //    `PrincipalRepo.listActive()` agree on exactly — a link that stops resolving is a link
    //    that stops granting.
    const ctx2 = staffCtx();
    await db.withTenant(ctx2, (tx) => service().setPaused(ctx2, tx, linkId, true));
    expect(await asSystem((tx, c) => service().resolve(c, tx, minted.token))).toBeUndefined();
  });

  it("counts one view when ten concurrent requests of the same session arrive", async () => {
    const visitor = await makeVisitor();
    const linkId = await linkAdmitting(visitor, 10);
    const session = randomUUID();

    // Each gets its own transaction on its own connection, which is what two nodes look like.
    // A read-then-write dedup loses this; ON CONFLICT DO NOTHING does not.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        asSystem((tx, c) => service().noteView(c, tx, linkId, visitor, session)),
      ),
    );
    // Concurrent inserts of one key may deadlock-free-serialise or raise a serialisation error;
    // what must never happen is two of them counting.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await viewsOf(linkId)).link).toBe(1);
  });

  it("counts a distinct session per membership, not per link", async () => {
    const one = await makeVisitor();
    const two = await makeVisitor();
    const linkId = await linkAdmitting(one, null);
    await asSystem((tx, c) => service().redeem(c, tx, { linkId, membershipId: two }));

    // The same session id reaching two memberships is not a real flow, but the key must still be
    // the triple: a link shared with two people counts two views, one each.
    const session = randomUUID();
    await asSystem((tx, c) => service().noteView(c, tx, linkId, one, session));
    await asSystem((tx, c) => service().noteView(c, tx, linkId, two, session));
    expect((await viewsOf(linkId)).link).toBe(2);
    expect((await viewsOf(linkId)).rows).toBe(2);
  });

  /*
   * The negative control, and the reason `createMemoryViewSessionLedger` is still in the source.
   * Same database, same service, same session — but each instance carries the per-process ledger
   * B shipped, so each starts blind. If this ever stops over-counting, the durable claim has
   * stopped being what holds the cap and the test above has stopped meaning anything.
   */
  it("over-counts with the per-process ledger, which is the bug core.share_link_view closes", async () => {
    const visitor = await makeVisitor();
    const linkId = await linkAdmitting(visitor, 5);
    const session = randomUUID();

    for (let i = 0; i < 3; i++) {
      await asSystem((tx, c) =>
        service(createMemoryViewSessionLedger()).noteView(c, tx, linkId, visitor, session),
      );
    }
    expect((await viewsOf(linkId)).link).toBe(3);
    // And nothing was written to core.share_link_view, because that ledger never reaches it.
    expect((await viewsOf(linkId)).rows).toBe(0);
  });

  it("stores the session id as the uuid it is, and reads it back unchanged", async () => {
    const visitor = await makeVisitor();
    const linkId = await linkAdmitting(visitor, null);
    const session = randomUUID();
    await asSystem((tx, c) => service().noteView(c, tx, linkId, visitor, session));

    const r = await pg.pool.query<{ session_id: string; first_seen_at: Date }>(
      "SELECT session_id, first_seen_at FROM core.share_link_view WHERE link_id = $1",
      [linkId],
    );
    expect(r.rows[0]?.session_id).toBe(session);
    expect(r.rows[0]?.first_seen_at).toBeInstanceOf(Date);
  });
});
