import { randomBytes, randomUUID } from "node:crypto";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * E3.13 foundation: core migration 0026 (`0026_evidence_authz`).
 *
 *  - audit.anchor_batch / anchor_receipt are global, append-only evidence: system/host insert,
 *    staff/system/host read, externals see nothing; UPDATE/DELETE refused; one receipt per
 *    (batch, driver);
 *  - audit.anchor gains the Merkle placement (kind 'merkle' needs batch, leaf index, proof; one
 *    per checkpoint);
 *  - core.authz_engine_state is system-only;
 *  - core.share_link_forced_watermark answers for the CURRENT workspace from any actor kind
 *    (an external viewer cannot read core.share_link itself) and refuses any other workspace.
 */
let pg: TestPostgres;

interface Ctx {
  readonly actor: "staff" | "external" | "system" | "host";
  readonly ws?: string | undefined;
  readonly membership?: string | undefined;
}

/** One statement as seedhost_app under a transaction-local context. */
async function as<T extends Record<string, unknown>>(
  ctx: Ctx,
  q: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE seedhost_app");
    await client.query("SELECT set_config('app.actor_kind', $1, true)", [ctx.actor]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.ws ?? ""]);
    await client.query("SELECT set_config('app.membership_id', $1, true)", [ctx.membership ?? ""]);
    const r = await client.query<T>(q, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected a failure");
}

async function workspace(slug: string): Promise<string> {
  const r = await pg.pool.query<{ id: string }>(
    "INSERT INTO core.workspace (slug, name) VALUES ($1, $2) RETURNING id::text",
    [slug, slug],
  );
  return r.rows[0]?.id as string;
}

async function member(ws: string): Promise<string> {
  const u = await pg.pool.query<{ id: string }>(
    `INSERT INTO core."user" (display_name) VALUES ('x') RETURNING id::text`,
  );
  const m = await pg.pool.query<{ id: string }>(
    `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source)
     VALUES ($1, $2, 'external', 'investor', 'active', 'invite') RETURNING id::text`,
    [ws, u.rows[0]?.id],
  );
  return m.rows[0]?.id as string;
}

async function link(ws: string, policy: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await pg.pool.query(
    `INSERT INTO core.share_link (id, workspace_id, label, token_hash, policy)
     VALUES ($1, $2, 'l', sha256(convert_to($4, 'UTF8')), $3::jsonb)`,
    [id, ws, JSON.stringify(policy), id],
  );
  return id;
}

async function visit(ws: string, linkId: string, membershipId: string): Promise<void> {
  await pg.pool.query(
    "INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id) VALUES ($1, $2, $3)",
    [ws, linkId, membershipId],
  );
}

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

describe("0026 anchor batches and receipts", () => {
  it("system inserts, staff reads, externals see nothing, nothing changes afterwards", async () => {
    const ws = await workspace("anchor-a");
    const root = randomBytes(32);
    const [batch] = await as<{ id: string }>(
      { actor: "system", ws },
      "INSERT INTO audit.anchor_batch (merkle_root, leaf_count) VALUES ($1, 3) RETURNING id::text",
      [root],
    );
    const batchId = batch?.id as string;
    await as(
      { actor: "host" },
      `INSERT INTO audit.anchor_receipt (batch_id, kind, reference, anchored_at, receipt)
       VALUES ($1, 'rfc3161', 'https://tsa.example/ #1', now(), '{"token":"x"}')`,
      [batchId],
    );
    expect(
      await as({ actor: "staff", ws }, "SELECT id FROM audit.anchor_batch WHERE id = $1", [
        batchId,
      ]),
    ).toHaveLength(1);
    expect(
      await as(
        { actor: "external", ws },
        "SELECT id FROM audit.anchor_receipt WHERE batch_id = $1",
        [batchId],
      ),
    ).toHaveLength(0);
    // staff cannot insert evidence
    const staffInsert = await errorOf(
      as(
        { actor: "staff", ws },
        "INSERT INTO audit.anchor_batch (merkle_root, leaf_count) VALUES ($1, 1)",
        [root],
      ),
    );
    expect(staffInsert.code).toBe("42501");
    // append-only, even for the system context
    const upd = await errorOf(
      as({ actor: "system", ws }, "UPDATE audit.anchor_batch SET leaf_count = 9 WHERE id = $1", [
        batchId,
      ]),
    );
    expect(upd.code).toBe("42501");
    const del = await errorOf(
      as({ actor: "system", ws }, "DELETE FROM audit.anchor_receipt WHERE batch_id = $1", [
        batchId,
      ]),
    );
    expect(del.code).toBe("42501");
    // owner-level UPDATE is refused by the trigger as well
    const ownerUpd = await errorOf(
      pg.pool.query("UPDATE audit.anchor_batch SET leaf_count = 9 WHERE id = $1", [batchId]),
    );
    expect(ownerUpd.message).toMatch(/append-only/u);
    // one receipt per (batch, driver); a root is 32 bytes
    const dup = await errorOf(
      as(
        { actor: "system", ws },
        `INSERT INTO audit.anchor_receipt (batch_id, kind, reference, anchored_at, receipt)
         VALUES ($1, 'rfc3161', 'again', now(), '{}')`,
        [batchId],
      ),
    );
    expect(dup.code).toBe("23505");
    const short = await errorOf(
      as(
        { actor: "system", ws },
        "INSERT INTO audit.anchor_batch (merkle_root, leaf_count) VALUES ($1, 1)",
        [randomBytes(31)],
      ),
    );
    expect(short.code).toBe("23514");
  });

  it("a merkle anchor carries its placement, once per checkpoint", async () => {
    const ws = await workspace("anchor-b");
    const [batch] = await as<{ id: string }>(
      { actor: "system", ws },
      "INSERT INTO audit.anchor_batch (merkle_root, leaf_count) VALUES ($1, 1) RETURNING id::text",
      [randomBytes(32)],
    );
    const [cp] = await as<{ id: string }>(
      { actor: "system", ws },
      `INSERT INTO audit.checkpoint (workspace_id, seq, hash, event_id, head_occurred_at)
       VALUES ($1, 1, $2, $3, now()) RETURNING id::text`,
      [ws, randomBytes(32), randomUUID()],
    );
    const insert = (proof: string | null, leaf: number | null) =>
      as(
        { actor: "system", ws },
        `INSERT INTO audit.anchor (workspace_id, checkpoint_id, kind, reference, batch_id, leaf_index, proof)
         VALUES ($1, $2, 'merkle', $3, $6, $4, $5::jsonb)`,
        [ws, cp?.id, batch?.id, leaf, proof, batch?.id],
      );
    expect((await errorOf(insert(null, 0))).code).toBe("23514");
    expect((await errorOf(insert('{"path":[]}', null))).code).toBe("23514");
    await insert('{"leafHash":"00","path":[],"treeSize":1}', 0);
    expect((await errorOf(insert('{"leafHash":"00","path":[],"treeSize":1}', 0))).code).toBe(
      "23505",
    );
  });
});

describe("0026 authz engine state", () => {
  it("is system-only", async () => {
    const ws = await workspace("engine-a");
    await as(
      { actor: "system", ws },
      "INSERT INTO core.authz_engine_state (workspace_id, driver, synced_acl_version) VALUES ($1, 'openfga', 4)",
      [ws],
    );
    expect(await as({ actor: "system", ws }, "SELECT driver FROM core.authz_engine_state")).toEqual(
      [{ driver: "openfga" }],
    );
    expect(await as({ actor: "staff", ws }, "SELECT driver FROM core.authz_engine_state")).toEqual(
      [],
    );
    const other = await workspace("engine-b");
    expect(
      await as({ actor: "system", ws: other }, "SELECT driver FROM core.authz_engine_state"),
    ).toEqual([]);
  });
});

describe("0026 core.share_link_forced_watermark", () => {
  const forced = async (ctx: Ctx, ws: string, membershipId: string) =>
    (
      await as<{ f: boolean }>(ctx, "SELECT core.share_link_forced_watermark($1, $2) AS f", [
        ws,
        membershipId,
      ])
    )[0]?.f;

  it("answers for the viewer's own context, any actor kind", async () => {
    const ws = await workspace("links-a");
    const forcedMember = await member(ws);
    const plainMember = await member(ws);
    const strict = await link(ws, { domains: [], emails: [], forceWatermark: true });
    const open = await link(ws, { domains: [], emails: [], forceWatermark: false });
    await visit(ws, strict, forcedMember);
    await visit(ws, open, plainMember);
    // the external viewer cannot read the link itself …
    expect(
      await as(
        { actor: "external", ws, membership: forcedMember },
        "SELECT id FROM core.share_link",
      ),
    ).toEqual([]);
    // … but the function answers
    expect(
      await forced({ actor: "external", ws, membership: forcedMember }, ws, forcedMember),
    ).toBe(true);
    expect(await forced({ actor: "staff", ws }, ws, forcedMember)).toBe(true);
    expect(await forced({ actor: "system", ws }, ws, plainMember)).toBe(false);
    // a revoked visit or a revoked link no longer forces; a paused link still does
    await pg.pool.query("UPDATE core.share_link SET status = 'paused' WHERE id = $1", [strict]);
    expect(await forced({ actor: "system", ws }, ws, forcedMember)).toBe(true);
    await pg.pool.query("UPDATE core.share_link_visit SET revoked_at = now() WHERE link_id = $1", [
      strict,
    ]);
    expect(await forced({ actor: "system", ws }, ws, forcedMember)).toBe(false);
  });

  it("refuses any workspace but the current one", async () => {
    const a = await workspace("links-b");
    const b = await workspace("links-c");
    const m = await member(b);
    const strict = await link(b, { forceWatermark: true });
    await visit(b, strict, m);
    const e = await errorOf(forced({ actor: "system", ws: a }, b, m));
    expect(e.code).toBe("42501");
    const none = await errorOf(forced({ actor: "host" }, b, m));
    expect(none.code).toBe("42501");
  });
});
