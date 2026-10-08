import { createErasureService } from "@fundroom/compliance";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  type ConnectionBody,
  deadlocks,
  type EnvelopeBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
} from "./test/esign-harness.js";

/*
 * E-sign races (E3.5): the lock order every e-sign write path follows — envelope row (FOR UPDATE)
 * → audit chain → outbox — against identity erasure, which runs its identity step under the chain
 * and therefore must PRE-lock the member's envelope rows before it (the E3.4 lesson). Each round
 * is a deterministic interleave: an erasure's final step is paused with a raw connection holding
 * the DSAR row it is about to lock; the contender (a real `esign.sync` / `esign.collect` handler,
 * or the void route) is started and waited on until it blocks too; then the erasure is released.
 * Both must finish and `pg_stat_database.deadlocks` must not move.
 *
 * Then a one-connection pool pass over request → callback → sync → collect → reads, with the
 * server's own outbox relay stopped (it legitimately serialises the only connection).
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
const { request, member, sql, callback, runJob } = h;

let acmeId: string;
let owner: Actor;
let conn: ConnectionBody;
let secret: string;
let ndaId: string;
/** A second e-sign document, so a member with an NDA envelope can start another one. */
let nda2Id: string;

async function startNda(actor: Actor, via?: RunningServer): Promise<EnvelopeBody> {
  const res = await request("acme", "/api/v1/esign/nda/start", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({
      documentId: ndaId,
      consentToElectronicRecords: true,
      disclosureVersion: 1,
    }),
    ...(via === undefined ? {} : { server: via }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ envelope: EnvelopeBody }>(res)).envelope;
}

async function providerRefOf(envelopeId: string): Promise<string> {
  const [row] = await sql<{ provider_ref: string }>(
    acmeId,
    `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  return row?.provider_ref as string;
}

async function statusOf(envelopeId: string) {
  const [row] = await sql<{ status: string; has: boolean; pseudo: boolean }>(
    acmeId,
    `SELECT status, artifacts IS NOT NULL AS has, signer_pseudonymised_at IS NOT NULL AS pseudo
       FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  return row;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(
    await request("acme", "/api/v1/esign/connection", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: "race-token-0001" } }),
    }),
  );
  conn = saved.connection;
  secret = saved.callbackSecret;
  const created = await request("acme", "/api/v1/compliance/documents", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      slug: "nda",
      kind: "nda",
      requiresAcceptance: true,
      ceremony: "esign",
      body: "# NDA\n\nRaces.",
    }),
  });
  expect(created.status).toBe(200);
  ndaId = (await json<{ document: { id: string } }>(created)).document.id;
  const second = await request("acme", "/api/v1/compliance/documents", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ slug: "nda-two", kind: "nda", ceremony: "esign", body: "# Two" }),
  });
  nda2Id = (await json<{ document: { id: string } }>(second)).document.id;
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("erasure vs the e-sign write paths never deadlock", () => {
  const settle = () => new Promise((r) => setTimeout(r, 1_500));
  /** Waits until at least `atLeast` backends other than `holder` wait on a lock. */
  const blockedBehind = async (holder: number, atLeast: number) => {
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
  };

  /**
   * One round: a fresh investor with an envelope prepared by `prepare`, their erasure's final step
   * paused under the DSAR row, `contend` started and blocked, then released.
   */
  async function round(
    label: string,
    prepare: (envelopeId: string) => Promise<void>,
    contend: (envelopeId: string, signer: Actor) => Promise<unknown>,
    options: { contenderBlocks?: boolean } = {},
  ): Promise<string> {
    const n = Math.random().toString(36).slice(2, 8);
    const inv = await member("acme", acmeId, `race-${n}@investor.test`, "external", "investor");
    const envelope = await startNda(inv);
    await prepare(envelope.id);
    const sys = systemContext(acmeId);
    const erasure = createErasureService({
      db: running.container.db,
      audit: running.container.audit,
      bookingSuppressionKeys: running.container.envelope,
    });
    const detail = await running.container.db.withTenant(sys, (tx) =>
      erasure.request(sys, tx, {
        membershipId: inv.membershipId,
        expectedModules: ["probe"],
        actor: { membershipId: owner.membershipId },
      }),
    );
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '15s'");
      const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      await holder.query("SELECT id FROM core.dsar_request WHERE id = $1 FOR UPDATE", [
        detail.request.id,
      ]);
      const step = running.container.db.withTenant(sys, (tx) =>
        erasure.completeStep(sys, tx, detail.request.id, "probe", {}),
      );
      await blockedBehind(pid, 1);
      const contender = contend(envelope.id, inv).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      if (options.contenderBlocks !== false) {
        // The interleave is only real if the contender is actually waiting on what erasure holds.
        const first = await Promise.race([
          blockedBehind(pid, 2).then(() => "blocked" as const),
          contender.then(() => "finished" as const),
        ]);
        expect(first, `${label}: the contender must be waiting on the erasure`).toBe("blocked");
      }
      await holder.query("COMMIT");
      await step;
      const outcome = await contender;
      if (!outcome.ok) {
        const e = outcome.e as { code?: string; message?: string };
        // A refusal is fine (the signer is gone / the envelope is terminal); a deadlock is not.
        expect(String(e.code ?? e.message), label).not.toMatch(/40P01|deadlock/iu);
      }
      expect((await statusOf(envelope.id))?.pseudo, label).toBe(true);
      // Nothing the contender created for the member survives un-pseudonymised.
      const [left] = await sql<{ n: number }>(
        acmeId,
        `SELECT count(*)::int AS n FROM core.esign_envelope
          WHERE membership_id = '${inv.membershipId}' AND signer_pseudonymised_at IS NULL`,
      );
      expect(left?.n, label).toBe(0);
      return envelope.id;
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  }

  it("sync, collect, void and a callback against the identity step", async () => {
    // The relay would run every module's erasure handler concurrently: stopped, so the only
    // transactions in play are the ones each round starts.
    await running.container.relay.stop();
    try {
      await settle();
      const before = await deadlocks(pg.pool);
      for (let i = 0; i < 2; i++) {
        // A sync that applies a status change (row → audit → outbox).
        await round(
          "sync",
          async (id) => mem.vendor.complete(await providerRefOf(id)),
          (id) => runJob("esign.sync", { workspaceId: acmeId, envelopeId: id }),
        );
        // A collect: artifacts in, audit, outbox, and the NDA acceptance (+ isErased check).
        const collected = await round(
          "collect",
          async (id) => {
            mem.vendor.complete(await providerRefOf(id));
            await runJob("esign.sync", { workspaceId: acmeId, envelopeId: id });
          },
          (id) => runJob("esign.collect", { workspaceId: acmeId, envelopeId: id }),
        );
        // A late writer must not recreate what erasure removed: no acceptance for an erased
        // signer, whichever side won.
        const [att] = await sql<{ n: number }>(
          acmeId,
          `SELECT count(*)::int AS n FROM core.attestation a
             JOIN core.esign_envelope e ON e.membership_id = a.membership_id
            WHERE e.id = '${collected}' AND a.kind LIKE 'nda:%'
              AND a.signed_at > e.signer_pseudonymised_at`,
        );
        expect(att?.n).toBe(0);
        // The admin void route (row → vendor outside tx → row → audit).
        await round(
          "void",
          async () => undefined,
          (id) =>
            request("acme", `/api/v1/esign/envelopes/${id}/void`, {
              method: "POST",
              cookie: owner.cookie,
              body: JSON.stringify({ reason: "race" }),
            }).then((r) => {
              expect(r.status).toBeLessThan(500);
            }),
        );
        // A new NDA for the member being erased, racing the identity step: never a deadlock and
        // never an envelope left naming an erased signer.
        await round(
          "start",
          async () => undefined,
          async (_id, signer) => {
            const res = await request("acme", "/api/v1/esign/nda/start", {
              method: "POST",
              cookie: signer.cookie,
              body: JSON.stringify({
                documentId: nda2Id,
                consentToElectronicRecords: true,
                disclosureVersion: 1,
              }),
            });
            // Before the erasure's step takes its locks the start may simply win (and its
            // envelope is then pseudonymised with the rest); after, it is refused.
            expect(res.status).toBeLessThan(500);
          },
          { contenderBlocks: false },
        );
        // A genuine callback (ingest enqueues a sync; no envelope lock of its own).
        await round(
          "callback",
          async () => undefined,
          async (id) => {
            const res = await callback(
              conn.id,
              memoryCallback(secret, { providerRef: await providerRefOf(id), event: "viewed" }),
            );
            expect(res.status).toBe(200);
          },
          { contenderBlocks: false },
        );
      }
      await settle();
      expect(await deadlocks(pg.pool)).toBe(before);
    } finally {
      running.container.relay.start();
    }
  }, 180_000);
});

describe("setting the e-sign ceremony races disconnecting", () => {
  it("never leaves an e-sign document without a connection", async () => {
    const wsId = (await createWorkspace(running.container.db, { slug: "cer", name: "Cer" })).id;
    const o = await member("cer", wsId, "owner@cer.test", "staff", "owner");
    const doc = await json<{ document: { id: string } }>(
      await request("cer", "/api/v1/compliance/documents", {
        method: "POST",
        cookie: o.cookie,
        body: JSON.stringify({ slug: "nda", kind: "nda", body: "# NDA" }),
      }),
    );
    const before = await deadlocks(pg.pool);
    for (let i = 0; i < 3; i++) {
      // Reset: connected, document on click-wrap.
      await request("cer", `/api/v1/compliance/documents/${doc.document.id}`, {
        method: "PATCH",
        cookie: o.cookie,
        body: JSON.stringify({ ceremony: "clickwrap" }),
      });
      const put = await request("cer", "/api/v1/esign/connection", {
        method: "PUT",
        cookie: o.cookie,
        body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: "cer-token-0001" } }),
      });
      expect(put.status).toBe(200);
      // Hold the connection's advisory lock so both requests queue behind it, then let go.
      const holder = await pg.pool.connect();
      try {
        await holder.query("BEGIN");
        const [{ pid }] = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows as [{ pid: number }];
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `esign.connection:${wsId}`,
        ]);
        const patch = request("cer", `/api/v1/compliance/documents/${doc.document.id}`, {
          method: "PATCH",
          cookie: o.cookie,
          body: JSON.stringify({ ceremony: "esign" }),
        });
        const del = request("cer", "/api/v1/esign/connection", {
          method: "DELETE",
          cookie: o.cookie,
        });
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows } = await pg.pool.query<{ n: number }>(
            "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND pid <> $1",
            [pid],
          );
          if ((rows[0]?.n ?? 0) >= 2) break;
          if (Date.now() > deadline) throw new Error("the two requests did not queue");
          await new Promise((r) => setTimeout(r, 25));
        }
        await holder.query("COMMIT");
        const [p, d] = await Promise.all([patch, del]);
        // Exactly one wins: the document went e-sign (delete refused) or the connection went
        // (the ceremony refused).
        expect([p.status, d.status].sort()).toEqual([200, 409]);
      } finally {
        holder.release();
      }
      const [state] = await sql<{ ceremony: string; live: number }>(
        wsId,
        `SELECT d.ceremony,
                (SELECT count(*)::int FROM core.esign_connection WHERE deleted_at IS NULL) AS live
           FROM core.legal_document d WHERE d.id = '${doc.document.id}'`,
      );
      expect(state?.ceremony === "esign" && state.live === 0).toBe(false);
    }
    expect(await deadlocks(pg.pool)).toBe(before);
  }, 90_000);
});

describe("a one-connection pool", () => {
  it("request → callback → sync → collect → reads complete without a nested acquire", async () => {
    const single = await startServer({
      config: esignTestConfig(env, { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      esignAdapters: { docuseal: mem.definition },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    await single.container.relay.stop();
    try {
      const inv = await member(
        "acme",
        acmeId,
        `single-${Date.now()}@investor.test`,
        "external",
        "investor",
      );
      const run = async () => {
        const opts = { server: single };
        for (const path of [
          "/api/v1/esign/connection",
          "/api/v1/esign/drivers",
          "/api/v1/esign/envelopes",
        ]) {
          const r = await request("acme", path, { cookie: owner.cookie, ...opts });
          expect(r.status, path).toBe(200);
        }
        const envelope = await startNda(inv, single);
        const ref = await providerRefOf(envelope.id);
        mem.vendor.complete(ref);
        const cb = await callback(
          conn.id,
          memoryCallback(secret, { providerRef: ref, event: "completed" }),
          single,
        );
        expect(cb.status).toBe(200);
        await runJob("esign.sync", { workspaceId: acmeId, envelopeId: envelope.id }, single);
        await runJob("esign.collect", { workspaceId: acmeId, envelopeId: envelope.id }, single);
        await runJob("esign.sync-due", {}, single);
        const status = await json<{ status: string }>(
          await request("acme", `/api/v1/esign/nda/status?documentId=${ndaId}`, {
            cookie: inv.cookie,
            ...opts,
          }),
        );
        expect(status.status).toBe("completed");
        const pdf = await request("acme", `/api/v1/esign/envelopes/${envelope.id}/signed.pdf`, {
          cookie: owner.cookie,
          ...opts,
        });
        expect(pdf.status).toBe(200);
        const mine = await request("acme", `/api/v1/esign/me/envelopes/${envelope.id}/signed.pdf`, {
          cookie: inv.cookie,
          ...opts,
        });
        expect(mine.status).toBe(200);
        const gates = await request("acme", "/api/v1/compliance/gates", {
          cookie: inv.cookie,
          ...opts,
        });
        expect(gates.status).toBe(200);
        // Save with live verify (vendor call outside the tx; blank secret keeps the stored one).
        const saved = await request("acme", "/api/v1/esign/connection", {
          method: "PUT",
          cookie: owner.cookie,
          body: JSON.stringify({ driver: "docuseal", credentials: {} }),
          ...opts,
        });
        expect(saved.status, await saved.clone().text()).toBe(200);
        const newSecret = (await json<{ callbackSecret?: string }>(saved)).callbackSecret;
        if (newSecret !== undefined) secret = newSecret;
        const other = await startNda(
          await member(
            "acme",
            acmeId,
            `single2-${Date.now()}@investor.test`,
            "external",
            "investor",
          ),
          single,
        );
        const voided = await request("acme", `/api/v1/esign/envelopes/${other.id}/void`, {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({ reason: "one connection" }),
          ...opts,
        });
        expect(voided.status).toBe(200);
        await runJob(
          "esign.void",
          { workspaceId: acmeId, envelopeId: other.id, reason: "x" },
          single,
        );
        const dsar = await request(
          "acme",
          `/api/v1/compliance/subjects/${inv.membershipId}/export`,
          {
            cookie: owner.cookie,
            ...opts,
          },
        );
        expect(dsar.status).toBe(200);
        const sync = await request("acme", `/api/v1/esign/envelopes/${envelope.id}/sync`, {
          method: "POST",
          cookie: owner.cookie,
          ...opts,
        });
        expect(sync.status).toBe(202);
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 45_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 90_000);
});
