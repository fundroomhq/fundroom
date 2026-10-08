import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildEffectiveAccess, rederiveRulePaths } from "@fundroom/authz";
import { createAcceptanceService, createErasureService } from "@fundroom/compliance";
import { decryptBytes } from "@fundroom/crypto";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { esignSubjectEnvelopes } from "@fundroom/esign";
import { createMemoryESignAdapter, tinyPdf } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { exportPublicKeys, importWorkspace, requestExport, runExport } from "@fundroom/portability";
import type { ESignAdapterDefinition, ESignArtifacts } from "@fundroom/ports";
import { esignArtifactKey } from "@fundroom/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  type ConnectionBody,
  deadlocks,
  type EnvelopeBody,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * E3.5 fix round 1, package FXA: the kernel e-sign / compliance / crypto / portability fixes
 * (A1–A16), each against a real server and database. The server runs WITHOUT the worker role, so
 * no job runs unless a test runs it (`runJob`) — every interleave below is deterministic. The
 * memory vendor is wrapped so a test can hold its `createEnvelope` / `downloadSigned` calls, vary
 * the bytes it returns, and see every config a port was bound to.
 *
 * Each fix's test was run with the fix reverted and failed (see the FXA report).
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, runJob } = h;

/** Test controls over the wrapped memory vendor. */
const ctl = {
  /** Every config a port was bound to (what the vendor would receive). */
  configs: [] as { credentials: Record<string, string>; baseUrl?: string | undefined }[],
  /** When set, `createEnvelope` calls `onCreate` and waits for this before creating. */
  holdCreate: undefined as Promise<void> | undefined,
  onCreate: undefined as (() => void) | undefined,
  /** When set, replaces what `downloadSigned` returns (after the real call succeeded). */
  onDownload: undefined as ((arts: ESignArtifacts) => Promise<ESignArtifacts>) | undefined,
  /** Every provider ref a port was asked to void (FX2A). */
  voided: [] as string[],
};

const definition: ESignAdapterDefinition = {
  ...mem.definition,
  credentialFields: [
    ...mem.definition.credentialFields,
    { key: "signingKey", label: "Signing key", kind: "secret", required: false },
  ],
  create(config, deps) {
    ctl.configs.push({ credentials: { ...config.credentials }, baseUrl: config.baseUrl });
    const port = mem.definition.create(config, deps);
    return {
      ...port,
      async createEnvelope(input) {
        if (ctl.holdCreate !== undefined) {
          ctl.onCreate?.();
          await ctl.holdCreate;
        }
        return port.createEnvelope(input);
      },
      async void(ref, reason) {
        ctl.voided.push(ref);
        return port.void(ref, reason);
      },
      async downloadSigned(ref, limits) {
        const arts = await port.downloadSigned(ref, limits);
        return ctl.onDownload === undefined ? arts : ctl.onDownload(arts);
      },
    };
  },
};

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
  conn: ConnectionBody;
  ndaId: string;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  const put = await request(slug, "/api/v1/esign/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: `tok-${slug}-0001` } }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  const conn = (await json<{ connection: ConnectionBody }>(put)).connection;
  const doc = await createDoc(slug, owner, { slug: "nda", body: "# NDA\n\nKeep it secret." });
  return { id, slug, owner, conn, ndaId: doc };
}

async function createDoc(
  slug: string,
  owner: Actor,
  opts: { slug: string; body: string; requiresAcceptance?: boolean; ceremony?: string },
): Promise<string> {
  const res = await request(slug, "/api/v1/compliance/documents", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      slug: opts.slug,
      title: "Mutual NDA",
      kind: "nda",
      requiresAcceptance: opts.requiresAcceptance ?? true,
      ceremony: opts.ceremony ?? "esign",
      body: opts.body,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ document: { id: string } }>(res)).document.id;
}

let investors = 0;
async function investor(ws: Ws): Promise<Actor> {
  investors += 1;
  return member(ws.slug, ws.id, `inv${investors}@${ws.slug}.test`, "external", "investor");
}

function startNda(ws: Ws, actor: Actor, documentId = ws.ndaId) {
  return request(ws.slug, "/api/v1/esign/nda/start", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({ documentId, consentToElectronicRecords: true, disclosureVersion: 1 }),
  });
}

async function started(ws: Ws, actor: Actor, documentId = ws.ndaId): Promise<EnvelopeBody> {
  const res = await startNda(ws, actor, documentId);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ envelope: EnvelopeBody }>(res)).envelope;
}

async function row(ws: Ws, envelopeId: string) {
  const [r] = await sql<{
    status: string;
    provider_ref: string | null;
    artifacts: { signed: { sha256: string; keyRef: string } } | null;
    error_code: string | null;
    signer_pseudonymised_at: string | null;
  }>(
    ws.id,
    `SELECT status, provider_ref, artifacts, error_code, signer_pseudonymised_at::text
       FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  if (r === undefined) throw new Error("no envelope row");
  return r;
}

async function completeAtVendor(ws: Ws, envelopeId: string): Promise<void> {
  const ref = (await row(ws, envelopeId)).provider_ref;
  if (ref === null) throw new Error("no provider ref");
  mem.vendor.complete(ref);
  await runJob("esign.sync", { workspaceId: ws.id, envelopeId });
  expect((await row(ws, envelopeId)).status).toBe("completed");
}

async function erase(ws: Ws, membershipId: string): Promise<void> {
  const ctx = systemContext(ws.id);
  const detail = await running.container.db.withTenant(ctx, (tx) =>
    createErasureService({
      db: running.container.db,
      audit: running.container.audit,
      bookingSuppressionKeys: running.container.envelope,
    }).request(ctx, tx, {
      membershipId,
      expectedModules: [],
      actor: { membershipId: ws.owner.membershipId },
    }),
  );
  expect(detail.request.status).toBe("completed");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until at least `atLeast` backends other than `holder` wait on a lock. */
async function blockedBehind(holder: number, atLeast: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await pg.pool.query<{ n: number }>(
      "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND pid <> $1",
      [holder],
    );
    if ((rows[0]?.n ?? 0) >= atLeast) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${atLeast} blocked backends`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    // No worker: jobs run only when a test runs them.
    config: esignTestConfig(env, { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("A1: an erased signer who had already signed", () => {
  it("is pulled first: the envelope completes and the signed copy is collected, nothing loops", async () => {
    const ws = await workspace("aone");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    const ref = (await row(ws, envelope.id)).provider_ref as string;
    // The signer signs at the vendor; before any callback lands, their data is erased.
    mem.vendor.complete(ref);
    await erase(ws, inv.membershipId);
    expect((await row(ws, envelope.id)).signer_pseudonymised_at).not.toBeNull();
    await runJob("esign.sync-due", {});
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    // Not voided (the vendor refuses: it is signed) and not left open with a re-queued sync.
    expect((await row(ws, envelope.id)).status).toBe("completed");
    await runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).artifacts).not.toBeNull();
    // A legacy `esign.void` still queued for it changes nothing.
    await runJob("esign.void", { workspaceId: ws.id, envelopeId: envelope.id, reason: "erasure" });
    expect((await row(ws, envelope.id)).status).toBe("completed");
    // The erased member's acceptance is NOT recorded (late writer), the record is kept.
    const [att] = await sql<{ n: number }>(
      ws.id,
      `SELECT count(*)::int AS n FROM core.attestation
        WHERE membership_id = '${inv.membershipId}' AND kind LIKE 'nda:%'`,
    );
    expect(att?.n).toBe(0);
  });

  it("A13: an `error` envelope that has a vendor ref is voided at the vendor after erasure", async () => {
    const ws = await workspace("athirteen");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await sql(
      ws.id,
      `UPDATE core.esign_envelope SET status = 'error', error_code = 'unavailable',
                        next_sync_at = now() + interval '1 day' WHERE id = '${envelope.id}' RETURNING id`,
    );
    await erase(ws, inv.membershipId);
    await runJob("esign.sync-due", {});
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("voided");
  });
});

describe("A2: the NDA acceptance never inverts workspace row → audit chain", () => {
  /**
   * An ACL/settings writer's lock order, held open: the workspace row, then (after the contender
   * is blocked) the audit chain. With the old order the contender held the chain while it waited
   * for the workspace row, and Postgres broke the cycle by killing one of them (40P01).
   */
  async function againstSettingsWriter(ws: Ws, contend: () => Promise<unknown>): Promise<void> {
    const before = await deadlocks(pg.pool);
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '15s'");
      const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      // What an ACL/settings writer does first: an UPDATE of the workspace row (a FOR NO KEY
      // UPDATE lock — compatible with the FK checks every insert makes, so the contender runs up
      // to its own workspace-row UPDATE, the ACL bump).
      await holder.query("UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1", [
        ws.id,
      ]);
      const contender = contend().then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await blockedBehind(pid, 1);
      await holder.query("SELECT pg_advisory_xact_lock(24301, hashtext($1::uuid::text))", [ws.id]);
      await holder.query("COMMIT");
      const outcome = await contender;
      expect(outcome.ok, outcome.ok ? "" : String((outcome.e as Error).message)).toBe(true);
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await deadlocks(pg.pool)).toBe(before);
  }

  it("esign.collect settling an NDA", async () => {
    const ws = await workspace("atwo");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await completeAtVendor(ws, envelope.id);
    await againstSettingsWriter(ws, () =>
      runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id }),
    );
    const status = await running.container.esign.ndaStatus(
      systemContext(ws.id),
      inv.membershipId,
      ws.ndaId,
    );
    expect(status.status).toBe("completed");
  }, 60_000);

  it("a click-wrap acceptance", async () => {
    const ws = await workspace("atwob");
    const doc = await createDoc(ws.slug, ws.owner, {
      slug: "terms-cw",
      body: "# Terms",
      ceremony: "clickwrap",
    });
    const inv = await investor(ws);
    await againstSettingsWriter(ws, async () => {
      const res = await request(ws.slug, "/api/v1/compliance/acceptances", {
        method: "POST",
        cookie: inv.cookie,
        body: JSON.stringify({ documentId: doc, versionNo: 1 }),
      });
      if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
    });
  }, 60_000);
});

describe("A4/A5/A10/A14: the connection's secrets and address", () => {
  it("A4: a changed base URL needs every stored secret re-typed; nothing is sent to the new host first", async () => {
    const ws = await workspace("afour");
    const put = (body: Record<string, unknown>) =>
      request(ws.slug, "/api/v1/esign/connection", {
        method: "PUT",
        cookie: ws.owner.cookie,
        body: JSON.stringify({ driver: "docuseal", ...body }),
      });
    ctl.configs = [];
    const refused = await put({ baseUrl: "https://sign.attacker.example", credentials: {} });
    expect(refused.status).toBe(422);
    expect(await json<ErrorBody & { error: { fields?: string[] } }>(refused)).toMatchObject({
      error: {
        code: "esign_credentials_required",
        reason: "base_url_changed",
        fields: ["apiToken"],
      },
    });
    expect(ctl.configs).toEqual([]);
    const ok = await put({
      baseUrl: "https://sign.example.com",
      credentials: { apiToken: "tok-new-host-0001" },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(ctl.configs).toEqual([
      { credentials: { apiToken: "tok-new-host-0001" }, baseUrl: "https://sign.example.com" },
    ]);
    // Same address again with blank secrets: kept, as before.
    const kept = await put({ baseUrl: "https://sign.example.com/", credentials: {} });
    expect(kept.status).toBe(200);
    expect(ctl.configs.at(-1)?.credentials["apiToken"]).toBe("tok-new-host-0001");
  });

  it("A5: an optional secret can be cleared (sealed row really loses it); a required one cannot", async () => {
    const ws = await workspace("afive");
    const ctx = systemContext(ws.id);
    const actor = { membershipId: ws.owner.membershipId };
    await running.container.esign.saveConnection(
      ctx,
      { driver: "docuseal", credentials: { signingKey: "sk-0000000000000001" } },
      actor,
    );
    const cleared = await running.container.esign.saveConnection(
      ctx,
      { driver: "docuseal", credentials: {}, clearCredentials: ["signingKey"] },
      actor,
    );
    expect(Object.keys(cleared.connection.credentialHints)).toEqual(["apiToken"]);
    ctl.configs = [];
    await running.container.esign.verifyConnection(ctx, actor);
    expect(ctl.configs.at(-1)?.credentials).toEqual({ apiToken: `tok-${ws.slug}-0001` });
    await expect(
      running.container.esign.saveConnection(
        ctx,
        { driver: "docuseal", credentials: {}, clearCredentials: ["apiToken"] },
        actor,
      ),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { reason: "cannot_clear_required" },
    });
  });

  it("A10: no address change under open envelopes; an `error` envelope with a vendor ref is open", async () => {
    const ws = await workspace("aten");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    const moved = await request(ws.slug, "/api/v1/esign/connection", {
      method: "PUT",
      cookie: ws.owner.cookie,
      body: JSON.stringify({
        driver: "docuseal",
        baseUrl: "https://sign.example.com",
        credentials: { apiToken: "tok-moved-00000001" },
      }),
    });
    expect(moved.status).toBe(409);
    expect((await json<ErrorBody>(moved)).error.code).toBe("envelopes_open");
    await sql(
      ws.id,
      `UPDATE core.esign_envelope SET status = 'error', error_code = 'unavailable'
                       WHERE id = '${envelope.id}' RETURNING id`,
    );
    // Still open at the vendor as far as we know: the connection cannot go.
    await sql(ws.id, `UPDATE core.legal_document SET ceremony = 'clickwrap' RETURNING id`);
    const del = await request(ws.slug, "/api/v1/esign/connection", {
      method: "DELETE",
      cookie: ws.owner.cookie,
    });
    expect(del.status).toBe(409);
    expect((await json<ErrorBody>(del)).error.code).toBe("envelopes_open");
  });

  it("A14: a driver the operator stopped offering can still be re-keyed", async () => {
    const ws = await workspace("afourteen");
    const narrowed = await startServer({
      config: esignTestConfig(env, { ROLES: "api", ESIGN_DRIVERS: "documenso" }),
      logger: createLogger({ level: "error" }),
      mailer,
      esignAdapters: { docuseal: definition },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const res = await request(ws.slug, "/api/v1/esign/connection", {
        method: "PUT",
        cookie: ws.owner.cookie,
        body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: "tok-rotated-0001" } }),
        server: narrowed,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    } finally {
      await narrowed.stop();
    }
  });
});

describe("A6/A7/A15: what may be started", () => {
  it("A7: only a document pending for the member — by requires_acceptance or a live nda gate", async () => {
    const ws = await workspace("aseven");
    const inv = await investor(ws);
    const side = await createDoc(ws.slug, ws.owner, {
      slug: "side-nda",
      body: "# Side",
      requiresAcceptance: false,
    });
    const refused = await startNda(ws, inv, side);
    expect(refused.status).toBe(409);
    expect((await json<ErrorBody>(refused)).error).toMatchObject({
      code: "conflict",
      reason: "not_pending",
    });
    // A group gate for a group the member is not in does not make it pending...
    const [g] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core."group" (workspace_id, name) VALUES ('${ws.id}', 'Board') RETURNING id`,
    );
    await sql(
      ws.id,
      `INSERT INTO core.access_policy (workspace_id, target_kind, target_id, kind, config)
       VALUES ('${ws.id}', 'group', '${g?.id}', 'nda', '{"documentId":"${side}"}') RETURNING id`,
    );
    expect((await startNda(ws, inv, side)).status).toBe(409);
    // ...nor does a resource-scoped gate on a node the member cannot reach...
    const node = randomUUID();
    await sql(
      ws.id,
      `INSERT INTO core.access_policy
         (workspace_id, target_kind, target_id, resource_kind, resource_path, kind, config)
       VALUES ('${ws.id}', 'resource', '${node}', 'folder', 'r.gated', 'nda',
               '{"documentId":"${side}"}') RETURNING id`,
    );
    expect((await startNda(ws, inv, side)).status).toBe(409);
    // ...until they hold a live grant reaching it (here: on the gated folder itself; FX2A).
    await sql(
      ws.id,
      `INSERT INTO core.access_grant
         (workspace_id, subject_kind, subject_id, resource_kind, resource_id, resource_path, capability)
       VALUES ('${ws.id}', 'membership', '${inv.membershipId}', 'folder', '${node}', 'r.gated',
               'view') RETURNING id`,
    );
    const ctx = systemContext(ws.id);
    const acceptances = createAcceptanceService({
      db: running.container.db,
      audit: running.container.audit,
    } as never);
    const resource = await running.container.db.withTenant(ctx, (tx) =>
      acceptances.resourcePendingFor(ctx, tx, { id: inv.membershipId, kind: "external" }),
    );
    expect(resource.map((p) => p.documentId)).toEqual([side]);
    expect((await started(ws, inv, side)).status).toBe("sent");
  });

  it("A7: five new NDA envelopes per member per day, then 429", async () => {
    const ws = await workspace("asevenb");
    const inv = await investor(ws);
    const ctx = systemContext(ws.id);
    for (let i = 0; i < 5; i++) {
      const e = await started(ws, inv);
      await running.container.esign.void(ctx, e.id, "again", ws.owner.membershipId);
    }
    const res = await startNda(ws, inv);
    expect(res.status).toBe(429);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "rate_limited",
      reason: "nda_start_budget",
    });
  });

  it("A6: an e-sign document whose kind is not `nda` is refused", async () => {
    const ws = await workspace("asix");
    const inv = await investor(ws);
    await sql(
      ws.id,
      `UPDATE core.legal_document SET kind = 'terms' WHERE id = '${ws.ndaId}' RETURNING id`,
    );
    const res = await startNda(ws, inv);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.reason).toBe("not_nda_document");
  });

  it("A15: a text the base-14 PDF cannot draw is refused, never signed altered", async () => {
    const ws = await workspace("afifteen");
    // The compliance routes refuse such a text under the e-sign ceremony (FXB, B4): write it as
    // click-wrap, then switch the ceremony underneath — the kernel must still refuse it.
    const greek = await createDoc(ws.slug, ws.owner, {
      slug: "nda-el",
      body: "# NDA\n\nΤα μέρη συμφωνούν. 中文.",
      ceremony: "clickwrap",
    });
    await sql(
      ws.id,
      `UPDATE core.legal_document SET ceremony = 'esign' WHERE id = '${greek}' RETURNING id`,
    );
    const inv = await investor(ws);
    const before = mem.vendor.created().length;
    const res = await startNda(ws, inv, greek);
    expect(res.status).toBe(422);
    expect((await json<ErrorBody & { error: { field?: string } }>(res)).error).toMatchObject({
      code: "esign_nda_text_unsupported",
      reason: "unsupported_characters",
      field: "body",
    });
    expect(mem.vendor.created().length).toBe(before);
  });
});

describe("A8: two concurrent starts of the same NDA", () => {
  it("the second waits for the first's vendor call and returns the sent envelope with its URL", async () => {
    const ws = await workspace("aeight");
    const inv = await investor(ws);
    let release!: () => void;
    let entered!: () => void;
    const creating = new Promise<void>((r) => {
      entered = r;
    });
    ctl.holdCreate = new Promise<void>((r) => {
      release = r;
    });
    ctl.onCreate = entered;
    try {
      const first = startNda(ws, inv);
      await creating;
      ctl.holdCreate = undefined;
      const second = startNda(ws, inv);
      setTimeout(release, 600);
      const [a, b] = await Promise.all([first, second]);
      const [ja, jb] = [
        await json<{ envelope: EnvelopeBody; signingUrl: string | null }>(a),
        await json<{ envelope: EnvelopeBody; signingUrl: string | null }>(b),
      ];
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(jb.envelope.id).toBe(ja.envelope.id);
      expect(jb.envelope.status).toBe("sent");
      expect(jb.signingUrl).not.toBeNull();
    } finally {
      ctl.holdCreate = undefined;
      ctl.onCreate = undefined;
      release();
    }
  });
});

describe("A9/A11: collecting the signed copy", () => {
  it("A9: overlapping collects — the stored bytes always match the recorded sha256", async () => {
    const ws = await workspace("anine");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await completeAtVendor(ws, envelope.id);
    // Each download returns different bytes (a vendor re-rendering its PDF) and waits for us.
    const entered = [deferred(), deferred()];
    const holds = [deferred(), deferred()];
    let n = 0;
    ctl.onDownload = async (arts) => {
      const i = n++;
      entered[i]?.resolve();
      await holds[i]?.promise;
      return { ...arts, document: tinyPdf(`Signed copy, rendering ${i}`) };
    };
    try {
      // Both collects download; the first finishes completely, then the second.
      const first = runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
      await entered[0]?.promise;
      const second = runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
      await entered[1]?.promise;
      holds[0]?.resolve();
      await first;
      holds[1]?.resolve();
      await second;
    } finally {
      ctl.onDownload = undefined;
    }
    const recorded = (await row(ws, envelope.id)).artifacts?.signed;
    expect(recorded).toBeDefined();
    const obj = await running.container.storage.get(esignArtifactKey(ws.id, envelope.id, "signed"));
    if (obj === undefined) throw new Error("no stored object");
    const cipher = new Uint8Array(await new Response(obj.body).arrayBuffer());
    const keyId = (recorded?.keyRef ?? "").replace(/^she1:/u, "");
    const ctx = systemContext(ws.id);
    const dek = await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.keyById(tx, ctx, keyId),
    );
    if (dek === undefined) throw new Error("no key");
    const plain = await decryptBytes(dek.key, cipher);
    expect(createHash("sha256").update(plain).digest("hex")).toBe(recorded?.sha256);
  });

  it("A11: a permanent collection failure reads `failed` and a fresh start supersedes it", async () => {
    const ws = await workspace("aeleven");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await completeAtVendor(ws, envelope.id);
    ctl.onDownload = async (arts) => ({ ...arts, document: new TextEncoder().encode("not a pdf") });
    try {
      await runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
    } finally {
      ctl.onDownload = undefined;
    }
    expect((await row(ws, envelope.id)).error_code).toBe("artifact_not_pdf");
    const ctx = systemContext(ws.id);
    expect(await running.container.esign.ndaStatus(ctx, inv.membershipId, ws.ndaId)).toEqual({
      status: "failed",
      envelopeId: envelope.id,
    });
    const again = await started(ws, inv);
    expect(again.id).not.toBe(envelope.id);
    expect((await running.container.esign.ndaStatus(ctx, inv.membershipId, ws.ndaId)).status).toBe(
      "open",
    );
  });
});

describe("A12: the DSAR export selects what erasure selects", () => {
  it("includes an envelope addressed to the member's email with no membership link", async () => {
    const ws = await workspace("atwelve");
    const inv = await investor(ws);
    const email = `inv${investors}@${ws.slug}.test`;
    const ctx = systemContext(ws.id);
    const view = await running.container.esign.request(ctx, {
      purpose: "round_closing",
      subject: { module: "round", kind: "commitment", id: randomUUID() },
      signer: { name: "Unlinked Investor", email },
      title: "Subscription agreement",
      document: { kind: "template", templateRef: "101", prefill: {} },
      embedded: false,
      requestedByMembershipId: ws.owner.membershipId,
    });
    expect(view.membershipId).toBeNull();
    await completeAtVendor(ws, view.id);
    await runJob("esign.collect", { workspaceId: ws.id, envelopeId: view.id });
    const listed = await running.container.db.withTenant(ctx, (tx) =>
      esignSubjectEnvelopes(tx, ctx, inv.membershipId),
    );
    expect(listed.map((e) => e["id"])).toContain(view.id);
    const files = await running.container.esign.subjectArtifacts(ws.id, inv.membershipId);
    expect(Object.keys(files)).toContain(`esign/${view.id}-signed.pdf`);
  });
});

describe("A16: importing a workspace", () => {
  it("resets an e-sign ceremony to click-wrap (no connection travels) and reports it", async () => {
    const ws = await workspace("asixteen");
    const c = running.container;
    const ctx = systemContext(ws.id);
    const tmp = mkdtempSync(join(tmpdir(), "fundroom-fxa-"));
    const zipPath = join(tmp, "export.zip");
    const exp = await c.db.withTenant(ctx, (tx) =>
      requestExport({ audit: c.audit }, tx, ctx, { requestedBy: null, includeRawAnalytics: false }),
    );
    const done = await runExport(
      {
        db: c.db,
        storage: c.storage,
        envelope: c.envelope,
        keyRing: c.config.keyRing,
        modules: c.registry.modules,
        instanceVersion: "test",
        audit: c.audit,
        dataDir: tmp,
      },
      { exportId: exp.id, workspaceId: ws.id, copyTo: zipPath },
    );
    expect(done.status).toBe("ready");
    const result = await importWorkspace(
      {
        db: c.db,
        storage: c.storage,
        envelope: c.envelope,
        keyRing: c.config.keyRing,
        modules: c.registry.modules,
        instanceVersion: "test",
        audit: c.audit,
        moduleServices: c.moduleServices,
        rederiveRulePaths,
        rebuildAccess: async (tx, tctx) => {
          await rebuildEffectiveAccess(tx, tctx);
        },
        tmpDir: tmp,
      },
      {
        file: zipPath,
        slug: `${ws.slug}-copy`,
        trustedPublicKeys: [exportPublicKeys(c.config.keyRing)[0]?.publicKey ?? ""],
        importedBy: "test",
      },
    );
    expect(result.warnings.join("\n")).toMatch(/e-signature ceremony \(nda\).*click-wrap/u);
    const [doc] = await sql<{ ceremony: string }>(
      result.workspaceId,
      "SELECT ceremony FROM core.legal_document WHERE slug = 'nda'",
    );
    expect(doc?.ceremony).toBe("clickwrap");
  }, 120_000);
});

/*
 * FX2A (fix round 2). The "pending for this member" predicate is the authz kernel's evaluation;
 * the sync window never expires a signature the vendor already holds; a blank base URL keeps.
 */
describe("FX2A-1: a resource NDA is offered only where the kernel lets the member in but for it", () => {
  async function gateDocs(ws: Ws, actor: Actor): Promise<string[]> {
    const res = await request(ws.slug, "/api/v1/compliance/gates", { cookie: actor.cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await json<{ pending: { documentId: string }[] }>(res)).pending.map(
      (p) => p.documentId,
    );
  }
  async function refused(ws: Ws, actor: Actor, documentId: string): Promise<void> {
    const res = await startNda(ws, actor, documentId);
    expect(res.status, await res.clone().text()).toBe(409);
    expect((await json<ErrorBody>(res)).error.reason).toBe("not_pending");
  }
  async function grant(
    ws: Ws,
    subject: { kind: "membership" | "link"; id: string },
    node: { id: string; path: string },
    effect: "allow" | "exclude" = "allow",
  ): Promise<void> {
    await sql(
      ws.id,
      `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind,
                                      resource_id, resource_path, capability, effect)
       VALUES ('${ws.id}', '${subject.kind}', '${subject.id}', 'folder', '${node.id}',
               '${node.path}', 'view', '${effect}') RETURNING id`,
    );
  }
  async function gate(ws: Ws, target: string, documentId: string): Promise<void> {
    await sql(
      ws.id,
      `INSERT INTO core.access_policy
         (workspace_id, target_kind, target_id, resource_kind, resource_path, kind, config)
       VALUES ('${ws.id}', ${target}, 'nda', '{"documentId":"${documentId}"}') RETURNING id`,
    );
  }

  it("an exclude on the gated node hides its NDA; a live grant on it offers it", async () => {
    const ws = await workspace("fxexcl");
    const blocked = await investor(ws);
    const reaches = await investor(ws);
    const doc = await createDoc(ws.slug, ws.owner, {
      slug: "secret-nda",
      body: "# Secret",
      requiresAcceptance: false,
    });
    const r = { id: randomUUID(), path: "r" };
    const secret = { id: randomUUID(), path: "r.secret" };
    // `blocked`: allow on r, exclude on r.secret — the kernel shuts r.secret whatever the NDA.
    await grant(ws, { kind: "membership", id: blocked.membershipId }, r);
    await grant(ws, { kind: "membership", id: blocked.membershipId }, secret, "exclude");
    // `reaches`: allow on r.secret itself — only the NDA stands in the way.
    await grant(ws, { kind: "membership", id: reaches.membershipId }, secret);
    await gate(ws, `'resource', '${secret.id}', 'folder', 'r.secret'`, doc);

    expect(await gateDocs(ws, blocked)).not.toContain(doc);
    await refused(ws, blocked, doc);
    expect(await gateDocs(ws, reaches)).toContain(doc);
    expect((await started(ws, reaches, doc)).status).toBe("sent");
  });

  it("a paused, revoked or expired share link offers nothing, even with a live visit", async () => {
    const ws = await workspace("fxlink");
    const inv = await investor(ws);
    const onNode = await createDoc(ws.slug, ws.owner, {
      slug: "link-node-nda",
      body: "# Node",
      requiresAcceptance: false,
    });
    const onLink = await createDoc(ws.slug, ws.owner, {
      slug: "link-door-nda",
      body: "# Door",
      requiresAcceptance: false,
    });
    const [link] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.share_link (workspace_id, label, token_hash)
       VALUES ('${ws.id}', 'Door', '\\x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}')
       RETURNING id`,
    );
    const linkId = link?.id as string;
    await sql(
      ws.id,
      `INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id)
       VALUES ('${ws.id}', '${linkId}', '${inv.membershipId}') RETURNING id`,
    );
    const node = { id: randomUUID(), path: "d" };
    await grant(ws, { kind: "link", id: linkId }, node);
    await gate(ws, `'resource', '${node.id}', 'folder', 'd'`, onNode);
    await sql(
      ws.id,
      `INSERT INTO core.access_policy (workspace_id, target_kind, target_id, kind, config)
       VALUES ('${ws.id}', 'link', '${linkId}', 'nda', '{"documentId":"${onLink}"}') RETURNING id`,
    );
    // Live link: both are the member's to sign.
    expect(await gateDocs(ws, inv)).toEqual(expect.arrayContaining([onNode, onLink]));

    const dead = [
      `status = 'paused'`,
      `status = 'revoked', revoked_at = now()`,
      `expires_at = now() - interval '1 minute'`,
    ];
    for (const state of dead) {
      await sql(ws.id, `UPDATE core.share_link SET ${state} WHERE id = '${linkId}' RETURNING id`);
      const listed = await gateDocs(ws, inv);
      expect(listed, state).not.toContain(onNode);
      expect(listed, state).not.toContain(onLink);
      await refused(ws, inv, onNode);
      await refused(ws, inv, onLink);
      await sql(
        ws.id,
        `UPDATE core.share_link SET status = 'active', revoked_at = NULL, expires_at = NULL
          WHERE id = '${linkId}' RETURNING id`,
      );
    }
    // Live again: startable.
    expect((await started(ws, inv, onNode)).status).toBe("sent");
  });
});

describe("FX2A-2: the sync window closing pulls first", () => {
  async function pastWindow(ws: Ws, envelopeId: string): Promise<void> {
    await sql(
      ws.id,
      `UPDATE core.esign_envelope SET sent_at = now() - interval '61 days'
        WHERE id = '${envelopeId}' RETURNING id`,
    );
  }

  it("a signature made at the vendor is applied and collected, not expired", async () => {
    const ws = await workspace("fxwin");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await pastWindow(ws, envelope.id);
    mem.vendor.complete((await row(ws, envelope.id)).provider_ref as string);
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("completed");
    await runJob("esign.collect", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).artifacts).not.toBeNull();
  });

  it("one the vendor still reports open is withdrawn there and expired", async () => {
    const ws = await workspace("fxwinopen");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    const ref = (await row(ws, envelope.id)).provider_ref as string;
    await pastWindow(ws, envelope.id);
    ctl.voided = [];
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("expired");
    expect(ctl.voided).toEqual([ref]);
  });
});

describe("FX2A-3: a blank base URL on a same-driver save keeps the stored one", () => {
  it("re-keys without retyping the address; a typed different address is still a change", async () => {
    const ws = await workspace("fxbase");
    const put = (body: Record<string, unknown>) =>
      request(ws.slug, "/api/v1/esign/connection", {
        method: "PUT",
        cookie: ws.owner.cookie,
        body: JSON.stringify({ driver: "docuseal", ...body }),
      });
    const moved = await put({
      baseUrl: "https://sign.example.com",
      credentials: { apiToken: "tok-self-hosted-01" },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const inv = await investor(ws);
    await started(ws, inv); // an open envelope: the address must not move under it
    ctl.configs = [];
    // Omitted: re-key only.
    const rekey = await put({ credentials: { apiToken: "tok-self-hosted-02" } });
    expect(rekey.status, await rekey.clone().text()).toBe(200);
    expect((await json<{ connection: ConnectionBody }>(rekey)).connection.baseUrlHost).toBe(
      "sign.example.com",
    );
    // Blank (the service; the route omits it), secrets blank: nothing to re-enter, nothing moves.
    const blank = await running.container.esign.saveConnection(
      systemContext(ws.id),
      { driver: "docuseal", baseUrl: "  ", credentials: {} },
      { membershipId: ws.owner.membershipId },
    );
    expect(blank.connection.baseUrlHost).toBe("sign.example.com");
    expect(ctl.configs).toEqual([
      { credentials: { apiToken: "tok-self-hosted-02" }, baseUrl: "https://sign.example.com" },
      { credentials: { apiToken: "tok-self-hosted-02" }, baseUrl: "https://sign.example.com" },
    ]);
    // Typing the vendor's cloud address is a change: secrets again (A4)...
    const cloud = await put({ baseUrl: "https://api.docuseal.com", credentials: {} });
    expect(cloud.status).toBe(422);
    expect((await json<ErrorBody>(cloud)).error).toMatchObject({
      code: "esign_credentials_required",
      reason: "base_url_changed",
    });
    // ...and not while envelopes are open (A10).
    const withSecrets = await put({
      baseUrl: "https://api.docuseal.com",
      credentials: { apiToken: "tok-cloud-000001" },
    });
    expect(withSecrets.status).toBe(409);
    expect((await json<ErrorBody>(withSecrets)).error.code).toBe("envelopes_open");
  });
});

/*
 * R3C (fix round 3). A failed pull at window close is retried through a grace before the envelope
 * is given up on (and then withdrawn at the vendor, best effort); new connection ids are budgeted.
 */
describe("R3C-4: a failed pull at window close does not leave the envelope signable", () => {
  async function sentDaysAgo(ws: Ws, envelopeId: string, days: number): Promise<void> {
    await sql(
      ws.id,
      `UPDATE core.esign_envelope SET sent_at = now() - interval '${days} days'
        WHERE id = '${envelopeId}' RETURNING id`,
    );
  }
  async function expiredAudit(ws: Ws, envelopeId: string) {
    return sql<{ meta: Record<string, unknown> }>(
      ws.id,
      `SELECT meta FROM audit.event
        WHERE action = 'esign.envelope_status_changed' AND resource_id = '${envelopeId}'
          AND meta->>'to' = 'expired'`,
    );
  }

  it("inside the grace the envelope stays open and is pulled again within hours", async () => {
    const ws = await workspace("fxgrace");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    await sentDaysAgo(ws, envelope.id, 61);
    ctl.voided = [];
    mem.vendor.failNext(1, "unavailable");
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("sent");
    expect(ctl.voided).toEqual([]);
    const [next] = await sql<{ soon: boolean }>(
      ws.id,
      `SELECT next_sync_at <= now() + interval '6 hours 1 minute' AS soon
         FROM core.esign_envelope WHERE id = '${envelope.id}'`,
    );
    expect(next?.soon).toBe(true);
    expect(await expiredAudit(ws, envelope.id)).toEqual([]);
    // The vendor is back: the next pull within the grace sees it open and withdraws it as usual.
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("expired");
    expect(ctl.voided).toEqual([(await row(ws, envelope.id)).provider_ref]);
  });

  it("past the grace it is voided at the vendor (best effort) and expired, the outcome audited", async () => {
    const ws = await workspace("fxgraceover");
    const inv = await investor(ws);
    const envelope = await started(ws, inv);
    const ref = (await row(ws, envelope.id)).provider_ref as string;
    await sentDaysAgo(ws, envelope.id, 64);
    ctl.voided = [];
    mem.vendor.failNext(1, "unavailable");
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: envelope.id });
    expect((await row(ws, envelope.id)).status).toBe("expired");
    expect(ctl.voided).toEqual([ref]);
    const audits = await expiredAudit(ws, envelope.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.meta).toMatchObject({
      reason: "sync_window_over_unreachable",
      void: "voided",
    });

    // A void that fails too is still recorded (staff can see what may be open at the vendor).
    const other = await started(ws, await investor(ws));
    await sentDaysAgo(ws, other.id, 64);
    mem.vendor.failNext(2, "unavailable");
    await runJob("esign.sync", { workspaceId: ws.id, envelopeId: other.id });
    expect((await row(ws, other.id)).status).toBe("expired");
    expect((await expiredAudit(ws, other.id))[0]?.meta).toMatchObject({
      reason: "sync_window_over_unreachable",
      void: "failed",
      providerCode: "unavailable",
    });
  });
});

describe("R3C-3: connection saves that mint a new connection id are budgeted per workspace", () => {
  it("the 11th new connection in an hour is 429 rate_limited with Retry-After; re-keys are free", async () => {
    const ws = await workspace("fxmint"); // its first connect was mint 1
    const put = (driver: string, token: string) =>
      request(ws.slug, "/api/v1/esign/connection", {
        method: "PUT",
        cookie: ws.owner.cookie,
        body: JSON.stringify({ driver, credentials: { apiToken: token } }),
      });
    const del = () =>
      request(ws.slug, "/api/v1/esign/connection", { method: "DELETE", cookie: ws.owner.cookie });
    // Re-keying the same connection mints nothing, however often.
    for (let i = 0; i < 12; i++) {
      const res = await put("docuseal", `tok-rekey-${String(i).padStart(6, "0")}`);
      expect(res.status, await res.clone().text()).toBe(200);
    }
    // Disconnect / reconnect mints a new id each time (the NDA leaves the e-sign ceremony first).
    await sql(ws.id, "UPDATE core.legal_document SET ceremony = 'clickwrap' RETURNING id");
    const ids = new Set<string>([ws.conn.id]);
    for (let i = 0; i < 9; i++) {
      const d = await del();
      expect(d.status, await d.clone().text()).toBe(200);
      const res = await put("docuseal", `tok-mint-${String(i).padStart(6, "0")}`);
      expect(res.status, await res.clone().text()).toBe(200);
      ids.add((await json<{ connection: ConnectionBody }>(res)).connection.id);
    }
    expect(ids.size).toBe(10);
    expect((await del()).status).toBe(200);
    const refused = await put("docuseal", "tok-mint-000011");
    expect(refused.status).toBe(429);
    expect((await json<ErrorBody>(refused)).error.code).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Nothing was written: still disconnected.
    const [live] = await sql<{ n: number }>(
      ws.id,
      "SELECT count(*)::int AS n FROM core.esign_connection WHERE deleted_at IS NULL",
    );
    expect(live?.n).toBe(0);
  });
});
