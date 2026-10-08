import { randomUUID } from "node:crypto";
import { createErasureService, verifySubjectExport } from "@fundroom/compliance";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { startFakeDocumenso } from "@fundroom/esign-documenso/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import {
  type Actor,
  CANON,
  type ConnectionBody,
  type EnvelopeBody,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
  waitFor,
} from "./test/esign-harness.js";

/*
 * E-signature, end to end (E3.5, ADR-0053) against a real server on a real database, with the
 * in-memory vendor standing in for DocuSeal and Dropbox Sign and the real Documenso adapter
 * talking real HTTP to a fake Documenso through the SSRF-guarded client:
 *
 *  - the connection lifecycle (live verify, credentials rejected, hints never leak, the callback
 *    secret shown once + rotation, delete refusals);
 *  - the compliance side of the ceremony (`ceremony` on documents, 409 `esign_not_configured`,
 *    click-wrap refused with 409 `esign_required`, `ceremony` + vendor on the gate);
 *  - the NDA ceremony (consent, idempotent start, callback → sync → collect → attestation → gate
 *    open; a version superseded mid-flight leaves the gate closed);
 *  - the envelope register (list/detail/artifacts/void/sync, API keys on the key-callable reads),
 *    the member's own routes (another member's id is 404);
 *  - the callback route (forged 401, unknown connection indistinguishable, genuine → sync,
 *    replay harmless, Dropbox Sign's ack);
 *  - erasure (pseudonymised, open envelopes voided, artifacts kept).
 *
 * The races (erasure interleaved with sync/collect/void) and the one-connection pool pass live in
 * `esign-races.integration.test.ts`.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const dbx = createMemoryESignAdapter("dropbox-sign");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, callback, runJob } = h;

let acmeId: string;
let owner: Actor;
let counsel: Actor;
let ada: Actor;
let bob: Actor;
/** The acme connection and its (current) callback secret. */
let conn: ConnectionBody;
let secret: string;
/** acme's e-sign NDA. */
let ndaId: string;

const TOKEN = "docuseal-token-abcd1234";

async function put(slug: string, cookie: string, body: Record<string, unknown>) {
  return request(slug, "/api/v1/esign/connection", {
    method: "PUT",
    cookie,
    body: JSON.stringify(body),
  });
}

async function startNda(actor: Actor, documentId: string, slug = "acme") {
  return request(slug, "/api/v1/esign/nda/start", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({ documentId, consentToElectronicRecords: true, disclosureVersion: 1 }),
  });
}

async function ndaStatus(actor: Actor, documentId: string, slug = "acme") {
  return json<{ status: string; envelopeId: string | null }>(
    await request(slug, `/api/v1/esign/nda/status?documentId=${documentId}`, {
      cookie: actor.cookie,
    }),
  );
}

async function providerRefOf(workspaceId: string, envelopeId: string): Promise<string> {
  const [row] = await sql<{ provider_ref: string | null }>(
    workspaceId,
    `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  if (!row?.provider_ref) throw new Error("envelope has no provider ref");
  return row.provider_ref;
}

async function envelopeRow(workspaceId: string, envelopeId: string) {
  const [row] = await sql<{
    status: string;
    signer_name: string;
    signer_email: string;
    signer_pseudonymised_at: string | null;
    artifacts: Record<string, unknown> | null;
  }>(
    workspaceId,
    `SELECT status, signer_name, signer_email::text AS signer_email,
            signer_pseudonymised_at::text AS signer_pseudonymised_at, artifacts
       FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  return row;
}

async function auditActions(workspaceId: string, resourceId: string): Promise<string[]> {
  return (
    await sql<{ action: string }>(
      workspaceId,
      `SELECT action FROM audit.event WHERE resource_id = '${resourceId}' ORDER BY seq`,
    )
  ).map((r) => r.action);
}

async function createEsignNda(slug: string, cookie: string, docSlug: string, body: string) {
  return request(slug, "/api/v1/compliance/documents", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      slug: docSlug,
      title: "Mutual NDA",
      kind: "nda",
      requiresAcceptance: true,
      ceremony: "esign",
      body,
    }),
  });
}

/** Completes `envelopeId` at the vendor and delivers a genuine callback; waits for the gate. */
async function signAtVendor(workspaceId: string, envelopeId: string): Promise<void> {
  const ref = await providerRefOf(workspaceId, envelopeId);
  mem.vendor.complete(ref);
  const res = await callback(
    conn.id,
    memoryCallback(secret, { providerRef: ref, event: "completed" }),
  );
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString)),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition, "dropbox-sign": dbx.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@acme.test", "staff", "legal");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("the vendor connection", () => {
  it("lists the drivers (with credential fields) to esign.read holders only", async () => {
    const res = await request("acme", "/api/v1/esign/drivers", { cookie: counsel.cookie });
    expect(res.status).toBe(200);
    const { drivers } = await json<{
      drivers: { meta: { driver: string }; credentialFields: { key: string }[] }[];
    }>(res);
    expect(drivers.map((d) => d.meta.driver).sort()).toEqual([
      "documenso",
      "docuseal",
      "docusign",
      "dropbox-sign",
    ]);
    expect(drivers.find((d) => d.meta.driver === "docuseal")?.credentialFields[0]?.key).toBe(
      "apiToken",
    );
    expect((await request("acme", "/api/v1/esign/drivers", { cookie: ada.cookie })).status).toBe(
      404,
    );
  });

  it("starts unconfigured; only esign.manage (fresh) may connect", async () => {
    const none = await request("acme", "/api/v1/esign/connection", { cookie: counsel.cookie });
    expect(await json(none)).toEqual({ connection: null });
    const refused = await put("acme", counsel.cookie, {
      driver: "docuseal",
      credentials: { apiToken: TOKEN },
    });
    expect(refused.status).toBe(403);
  });

  it("verifies credentials live before storing anything (422 esign_credentials_rejected)", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "docuseal",
      credentials: { apiToken: "invalid" },
    });
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error.code).toBe("esign_credentials_rejected");
    const [n] = await sql<{ n: number }>(
      acmeId,
      "SELECT count(*)::int AS n FROM core.esign_connection",
    );
    expect(n?.n).toBe(0);
  });

  it("connects: the callback secret once, hints only, nothing secret in rows, audit or reads", async () => {
    const res = await put("acme", owner.cookie, {
      driver: "docuseal",
      credentials: { apiToken: TOKEN },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const saved = JSON.parse(text) as { connection: ConnectionBody; callbackSecret: string };
    conn = saved.connection;
    secret = saved.callbackSecret;
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(conn).toMatchObject({
      driver: "docuseal",
      displayName: "DocuSeal",
      status: "active",
      callbackSecretKind: "ours",
    });
    expect(conn.callbackUrl).toBe(`http://${CANON}/webhooks/esign/${conn.id}`);
    expect(conn.credentialHints["apiToken"]).toMatch(/1234$/u);
    expect(conn.credentialHints["apiToken"]).not.toContain("abcd");

    const read = await (
      await request("acme", "/api/v1/esign/connection", { cookie: counsel.cookie })
    ).text();
    expect(read).not.toContain(TOKEN);
    expect(read).not.toContain(secret);
    expect(JSON.parse(read)).toMatchObject({ connection: { id: conn.id, status: "active" } });

    const [row] = await sql<{ blob: string }>(
      acmeId,
      `SELECT encode(credentials_enc, 'escape') || coalesce(encode(callback_secret_enc, 'escape'), '')
              || credential_hints::text AS blob FROM core.esign_connection WHERE id = '${conn.id}'`,
    );
    expect(row?.blob).not.toContain(TOKEN);
    expect(row?.blob).not.toContain(secret);
    const audit = await sql<{ action: string; meta: unknown }>(
      acmeId,
      `SELECT action, meta FROM audit.event WHERE resource_id = '${conn.id}' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action)).toContain("esign.connection_saved");
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("re-verifies on demand", async () => {
    const res = await request("acme", "/api/v1/esign/connection/verify", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const { connection } = await json<{ connection: ConnectionBody }>(res);
    expect(connection.status).toBe("active");
    expect(connection.lastVerifiedAt).not.toBeNull();
  });
});

describe("the vendor callback route", () => {
  it("answers a forged callback and an unknown connection with the same 401", async () => {
    const forged = await callback(
      conn.id,
      memoryCallback("not-the-secret-at-all", { event: "completed" }),
    );
    const unknown = await callback(randomUUID(), memoryCallback(secret, { event: "completed" }));
    expect(forged.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await forged.text()).toBe(await unknown.text());
  });

  it("answers 200 to a genuine callback naming an envelope we do not know (no oracle)", async () => {
    const res = await callback(
      conn.id,
      memoryCallback(secret, { providerRef: "mem_docuseal_999", event: "completed" }),
    );
    expect(res.status).toBe(200);
  });

  it("rotates the callback secret: the new one works at once, the old one never again", async () => {
    const res = await request("acme", "/api/v1/esign/connection/rotate-callback-secret", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const rotated = await json<{ callbackSecret: string }>(res);
    expect(rotated.callbackSecret).not.toBe(secret);
    const old = secret;
    secret = rotated.callbackSecret;
    expect((await callback(conn.id, memoryCallback(old, { event: "viewed" }))).status).toBe(401);
    expect((await callback(conn.id, memoryCallback(secret, { event: "viewed" }))).status).toBe(200);
    expect(await auditActions(acmeId, conn.id)).toContain("esign.callback_secret_rotated");
  });

  it("acknowledges Dropbox Sign with its ack text", async () => {
    const dbxId = (await createWorkspace(running.container.db, { slug: "dbx", name: "Dbx" })).id;
    const dbxOwner = await member("dbx", dbxId, "owner@dbx.test", "staff", "owner");
    const res = await put("dbx", dbxOwner.cookie, {
      driver: "dropbox-sign",
      credentials: { apiToken: "dbx-token-5678" },
    });
    expect(res.status).toBe(200);
    const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(res);
    const ack = await callback(
      saved.connection.id,
      memoryCallback(saved.callbackSecret, { event: "signature_request_viewed" }),
    );
    expect(ack.status).toBe(200);
    expect(await ack.text()).toContain("Hello API Event Received");
  });
});

describe("the ceremony on legal documents", () => {
  it("refuses `esign` without an active connection (409 esign_not_configured)", async () => {
    const wsId = (await createWorkspace(running.container.db, { slug: "noconn", name: "No" })).id;
    const o = await member("noconn", wsId, "owner@noconn.test", "staff", "owner");
    const created = await createEsignNda("noconn", o.cookie, "nda", "# NDA");
    expect(created.status).toBe(409);
    expect((await json<ErrorBody>(created)).error.code).toBe("esign_not_configured");
    const plain = await request("noconn", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: o.cookie,
      body: JSON.stringify({ slug: "nda", kind: "nda", body: "# NDA" }),
    });
    expect(plain.status).toBe(200);
    const { document } = await json<{ document: { id: string; ceremony: string } }>(plain);
    expect(document.ceremony).toBe("clickwrap");
    const patched = await request("noconn", `/api/v1/compliance/documents/${document.id}`, {
      method: "PATCH",
      cookie: o.cookie,
      body: JSON.stringify({ ceremony: "esign" }),
    });
    expect(patched.status).toBe(409);
    expect((await json<ErrorBody>(patched)).error.code).toBe("esign_not_configured");
  });

  it("creates an e-sign NDA once connected; the gate names the ceremony and the vendor", async () => {
    const created = await createEsignNda(
      "acme",
      owner.cookie,
      "mutual-nda",
      "# Mutual NDA\n\nThe parties agree to keep each other's secrets. Version one.",
    );
    expect(created.status).toBe(200);
    const detail = await json<{ document: { id: string; ceremony: string } }>(created);
    expect(detail.document.ceremony).toBe("esign");
    ndaId = detail.document.id;

    const gates = await json<{
      pending: { documentId: string; ceremony: string; esign: unknown }[];
    }>(await request("acme", "/api/v1/compliance/gates", { cookie: ada.cookie }));
    expect(gates.pending.find((p) => p.documentId === ndaId)).toMatchObject({
      ceremony: "esign",
      esign: { driver: "docuseal", displayName: "DocuSeal" },
    });
    const boot = await json<{ pendingAcceptances: { documentId: string; ceremony: string }[] }>(
      await request("acme", "/api/v1/modules", { cookie: ada.cookie }),
    );
    expect(boot.pendingAcceptances.find((p) => p.documentId === ndaId)?.ceremony).toBe("esign");
    // The gate holds: the portal refuses everything else.
    const blocked = await request("acme", "/api/v1/access/my", { cookie: ada.cookie });
    expect(blocked.status).toBe(403);
    expect((await json<ErrorBody>(blocked)).error.code).toBe("legal_acceptance_required");
  });

  it("refuses click-wrap for an e-sign document (409 esign_required)", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ documentId: ndaId, versionNo: 1 }),
    });
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.code).toBe("esign_required");
  });
});

describe("the e-sign NDA ceremony", () => {
  let adaEnvelope: EnvelopeBody;

  it("needs the ESIGN consent (422 esign_consent_required)", async () => {
    for (const body of [
      { documentId: ndaId, consentToElectronicRecords: false, disclosureVersion: 1 },
      { documentId: ndaId, consentToElectronicRecords: true, disclosureVersion: 99 },
    ]) {
      const res = await request("acme", "/api/v1/esign/nda/start", {
        method: "POST",
        cookie: ada.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).error.code).toBe("esign_consent_required");
    }
    expect(await ndaStatus(ada, ndaId)).toEqual({ status: "none", envelopeId: null });
  });

  it("starts (consent recorded, envelope at the vendor) and is idempotent", async () => {
    const before = mem.vendor.created().length;
    const res = await startNda(ada, ndaId);
    expect(res.status).toBe(200);
    const started = await json<{ envelope: EnvelopeBody; signingUrl: string | null }>(res);
    adaEnvelope = started.envelope;
    expect(adaEnvelope).toMatchObject({
      purpose: "nda",
      status: "sent",
      membershipId: ada.membershipId,
      signerEmail: "ada@investor.test",
      subject: { id: ndaId },
    });
    expect(started.signingUrl).toMatch(/^https:\/\/memory\.esign\.test\/sign\//u);
    expect(mem.vendor.created().length).toBe(before + 1);
    const again = await json<{ envelope: EnvelopeBody }>(await startNda(ada, ndaId));
    expect(again.envelope.id).toBe(adaEnvelope.id);
    expect(mem.vendor.created().length).toBe(before + 1);

    const consent = await sql<{ kind: string }>(
      acmeId,
      `SELECT kind FROM core.attestation WHERE membership_id = '${ada.membershipId}'
          AND kind LIKE 'esign-consent:%'`,
    );
    expect(consent.map((c) => c.kind)).toEqual(["esign-consent:v1"]);
    expect(await ndaStatus(ada, ndaId)).toEqual({ status: "open", envelopeId: adaEnvelope.id });
  });

  it("completion: callback → sync → collect → attestation → the gate opens", async () => {
    await signAtVendor(acmeId, adaEnvelope.id);
    await waitFor("ada's NDA to complete", async () => {
      const s = await ndaStatus(ada, ndaId);
      return s.status === "completed" ? s : undefined;
    });
    const att = await sql<{ kind: string; evidence_ref: string | null }>(
      acmeId,
      `SELECT kind, evidence_ref FROM core.attestation
         WHERE membership_id = '${ada.membershipId}' AND kind = 'mutual-nda:v1'`,
    );
    expect(att).toEqual([{ kind: "mutual-nda:v1", evidence_ref: `esign:v1:${adaEnvelope.id}` }]);
    const [data] = await sql<{ method: string | null }>(
      acmeId,
      `SELECT data->>'method' AS method FROM core.attestation
         WHERE membership_id = '${ada.membershipId}' AND kind = 'mutual-nda:v1'`,
    );
    expect(data?.method).toBe("esign");
    // An e-signed acceptance is evidenced by the vendor's record, not a click-wrap certificate.
    const certs = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'legal.certificate_issued'
          AND subject_membership_id = '${ada.membershipId}'`,
    );
    expect(certs[0]?.n).toBe(0);
    await waitFor("the gate to open", async () => {
      const r = await request("acme", "/api/v1/access/my", { cookie: ada.cookie });
      return r.status === 200 ? true : undefined;
    });
    const view = await json<EnvelopeBody>(
      await request("acme", `/api/v1/esign/envelopes/${adaEnvelope.id}`, {
        cookie: owner.cookie,
      }),
    );
    expect(view).toMatchObject({ status: "completed", hasSigned: true, hasCertificate: true });
    expect(await auditActions(acmeId, adaEnvelope.id)).toEqual(
      expect.arrayContaining([
        "esign.envelope_requested",
        "esign.envelope_status_changed",
        "esign.envelope_completed",
      ]),
    );
  });

  it("a terminal envelope stays terminal: a later vendor-side void does not move it", async () => {
    const ref = await providerRefOf(acmeId, adaEnvelope.id);
    mem.vendor.voidFromVendor(ref);
    await runJob("esign.sync", { workspaceId: acmeId, envelopeId: adaEnvelope.id });
    expect((await envelopeRow(acmeId, adaEnvelope.id))?.status).toBe("completed");
    const res = await request("acme", `/api/v1/esign/envelopes/${adaEnvelope.id}/void`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "too late" }),
    });
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.code).toBe("envelope_not_open");
  });

  it("a replayed callback is a harmless extra pull", async () => {
    const actions = await auditActions(acmeId, adaEnvelope.id);
    const ref = await providerRefOf(acmeId, adaEnvelope.id);
    for (let i = 0; i < 3; i++) {
      const res = await callback(
        conn.id,
        memoryCallback(secret, { providerRef: ref, event: "completed" }),
      );
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await auditActions(acmeId, adaEnvelope.id)).toEqual(actions);
    expect((await envelopeRow(acmeId, adaEnvelope.id))?.status).toBe("completed");
  });

  it("serves the signed copy to its signer only; another member's id is 404", async () => {
    const mine = await json<{ items: EnvelopeBody[] }>(
      await request("acme", "/api/v1/esign/me/envelopes", { cookie: ada.cookie }),
    );
    expect(mine.items.map((e) => e.id)).toEqual([adaEnvelope.id]);
    const theirs = await json<{ items: EnvelopeBody[] }>(
      await request("acme", "/api/v1/esign/me/envelopes", { cookie: bob.cookie }),
    );
    expect(theirs.items).toEqual([]);

    const own = await request("acme", `/api/v1/esign/me/envelopes/${adaEnvelope.id}/signed.pdf`, {
      cookie: ada.cookie,
    });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("application/pdf");
    expect(own.headers.get("content-disposition")).toMatch(/^attachment; filename="/u);
    expect(new TextDecoder().decode((await own.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const other = await request("acme", `/api/v1/esign/me/envelopes/${adaEnvelope.id}/signed.pdf`, {
      cookie: bob.cookie,
    });
    expect(other.status).toBe(404);
    const unknown = await request("acme", `/api/v1/esign/me/envelopes/${randomUUID()}/signed.pdf`, {
      cookie: bob.cookie,
    });
    expect(unknown.status).toBe(404);
    const a = (await json<ErrorBody>(other)).error;
    const b = (await json<ErrorBody>(unknown)).error;
    expect([a.code, a.message]).toEqual([b.code, b.message]);
  });

  it("a version superseded mid-flight leaves the gate closed", async () => {
    const started = await json<{ envelope: EnvelopeBody }>(await startNda(bob, ndaId));
    const envelopeId = started.envelope.id;
    const published = await request("acme", `/api/v1/compliance/documents/${ndaId}/versions`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ body: "# Mutual NDA\n\nVersion two: stricter." }),
    });
    expect(published.status).toBe(200);
    await signAtVendor(acmeId, envelopeId);
    await waitFor("bob's envelope to be collected", async () => {
      const row = await envelopeRow(acmeId, envelopeId);
      return row?.artifacts ? row : undefined;
    });
    await waitFor("the supersede audit", async () =>
      (await auditActions(acmeId, envelopeId)).includes("esign.nda_version_superseded")
        ? true
        : undefined,
    );
    const att = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM core.attestation
         WHERE membership_id = '${bob.membershipId}' AND kind LIKE 'mutual-nda:%'`,
    );
    expect(att[0]?.n).toBe(0);
    expect((await ndaStatus(bob, ndaId)).status).toBe("superseded");
    const blocked = await request("acme", "/api/v1/access/my", { cookie: bob.cookie });
    expect(blocked.status).toBe(403);
  });

  it("refuses to start from the embed tree (the signing page must be top-level)", async () => {
    const res = await running.app.request(`http://${CANON}/embed/acme/api/v1/esign/nda/start`, {
      method: "POST",
      headers: {
        host: CANON,
        cookie: bob.cookie,
        origin: `http://${CANON}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        documentId: ndaId,
        consentToElectronicRecords: true,
        disclosureVersion: 1,
      }),
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.reason).toBe("embed_frame");
  });
});

describe("the envelope register", () => {
  let openId: string;

  it("lists with filters and a keyset cursor, to esign.read holders", async () => {
    const carl = await member("acme", acmeId, "carl@investor.test", "external", "investor");
    openId = (await json<{ envelope: EnvelopeBody }>(await startNda(carl, ndaId))).envelope.id;
    const all = await json<{ items: EnvelopeBody[]; nextCursor: string | null }>(
      await request("acme", "/api/v1/esign/envelopes?purpose=nda", { cookie: counsel.cookie }),
    );
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(all.items[0]?.id).toBe(openId); // newest first
    const sent = await json<{ items: EnvelopeBody[] }>(
      await request("acme", "/api/v1/esign/envelopes?status=sent", { cookie: counsel.cookie }),
    );
    expect(sent.items.every((e) => e.status === "sent")).toBe(true);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: EnvelopeBody[]; nextCursor: string | null } = await json(
        await request(
          "acme",
          `/api/v1/esign/envelopes?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { cookie: owner.cookie },
        ),
      );
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== null && seen.length < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(
      (
        await json<{ items: unknown[] }>(
          await request("acme", "/api/v1/esign/envelopes?limit=100", { cookie: owner.cookie }),
        )
      ).items.length,
    );
    expect((await request("acme", "/api/v1/esign/envelopes", { cookie: ada.cookie })).status).toBe(
      404,
    );
  });

  it("downloads artifacts (audited); 404 until collected", async () => {
    const [done] = await sql<{ id: string }>(
      acmeId,
      "SELECT id FROM core.esign_envelope WHERE artifacts IS NOT NULL ORDER BY created_at LIMIT 1",
    );
    const id = done?.id as string;
    for (const which of ["signed", "certificate"]) {
      const res = await request("acme", `/api/v1/esign/envelopes/${id}/${which}.pdf`, {
        cookie: counsel.cookie,
      });
      expect(res.status, which).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }
    expect(await auditActions(acmeId, id)).toContain("esign.artifact_downloaded");
    const pending = await request("acme", `/api/v1/esign/envelopes/${openId}/signed.pdf`, {
      cookie: owner.cookie,
    });
    expect(pending.status).toBe(404);
  });

  it("key-callable reads work with an API key; artifact downloads do not", async () => {
    const { token } = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: owner.membershipId,
      scopes: ["esign.read"],
    });
    expect(
      (await request("acme", "/api/v1/esign/envelopes", { headers: bearer(token) })).status,
    ).toBe(200);
    expect(
      (await request("acme", `/api/v1/esign/envelopes/${openId}`, { headers: bearer(token) }))
        .status,
    ).toBe(200);
    const pdf = await request("acme", `/api/v1/esign/envelopes/${openId}/signed.pdf`, {
      headers: bearer(token),
    });
    expect(pdf.status).toBe(401);
    expect((await json<ErrorBody>(pdf)).error.reason).toBe("api_key_not_allowed");
  });

  it("another workspace's envelope id is a 404", async () => {
    const other = (await createWorkspace(running.container.db, { slug: "other", name: "O" })).id;
    const o = await member("other", other, "owner@other.test", "staff", "owner");
    expect(
      (await request("other", `/api/v1/esign/envelopes/${openId}`, { cookie: o.cookie })).status,
    ).toBe(404);
    expect(
      (
        await request("other", `/api/v1/esign/envelopes/${openId}/void`, {
          method: "POST",
          cookie: o.cookie,
          body: JSON.stringify({ reason: "nope" }),
        })
      ).status,
    ).toBe(404);
  });

  it("syncs on demand (202), 10 a minute per workspace; unknown ids spend nothing", async () => {
    expect(
      (
        await request("acme", `/api/v1/esign/envelopes/${randomUUID()}/sync`, {
          method: "POST",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await request("acme", `/api/v1/esign/envelopes/${openId}/sync`, {
            method: "POST",
            cookie: owner.cookie,
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("voids an open envelope (esign.manage, fresh); a terminal one is 409 envelope_not_open", async () => {
    const byLegal = await request("acme", `/api/v1/esign/envelopes/${openId}/void`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ reason: "wrong address" }),
    });
    expect(byLegal.status).toBe(403);
    const res = await request("acme", `/api/v1/esign/envelopes/${openId}/void`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "wrong address" }),
    });
    expect(res.status).toBe(200);
    expect((await json<EnvelopeBody>(res)).status).toBe("voided");
    expect(await auditActions(acmeId, openId)).toContain("esign.envelope_voided");
    const again = await request("acme", `/api/v1/esign/envelopes/${openId}/void`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "twice" }),
    });
    expect(again.status).toBe(409);
    expect((await json<ErrorBody>(again)).error.code).toBe("envelope_not_open");
  });
});

describe("disconnecting", () => {
  it("refuses while an e-sign document or an open envelope depends on it; a changed driver too", async () => {
    const wsId = (await createWorkspace(running.container.db, { slug: "gamma", name: "G" })).id;
    const o = await member("gamma", wsId, "owner@gamma.test", "staff", "owner");
    const inv = await member("gamma", wsId, "inv@gamma.test", "external", "investor");
    const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(
      await put("gamma", o.cookie, { driver: "docuseal", credentials: { apiToken: TOKEN } }),
    );
    const doc = await json<{ document: { id: string } }>(
      await createEsignNda("gamma", o.cookie, "nda", "# NDA\n\nGamma."),
    );
    const del = () =>
      request("gamma", "/api/v1/esign/connection", { method: "DELETE", cookie: o.cookie });
    const inUse = await del();
    expect(inUse.status).toBe(409);
    expect((await json<ErrorBody>(inUse)).error.code).toBe("esign_ceremony_in_use");

    const env = (
      await json<{ envelope: EnvelopeBody }>(await startNda(inv, doc.document.id, "gamma"))
    ).envelope;
    const back = await request("gamma", `/api/v1/compliance/documents/${doc.document.id}`, {
      method: "PATCH",
      cookie: o.cookie,
      body: JSON.stringify({ ceremony: "clickwrap" }),
    });
    expect(back.status).toBe(200);
    const open = await del();
    expect(open.status).toBe(409);
    expect((await json<ErrorBody>(open)).error.code).toBe("envelopes_open");
    const switched = await put("gamma", o.cookie, {
      driver: "dropbox-sign",
      credentials: { apiToken: "dbx-token-5678" },
    });
    expect(switched.status).toBe(409);
    expect((await json<ErrorBody>(switched)).error.code).toBe("envelopes_open");

    expect(
      (
        await request("gamma", `/api/v1/esign/envelopes/${env.id}/void`, {
          method: "POST",
          cookie: o.cookie,
          body: JSON.stringify({ reason: "closing down" }),
        })
      ).status,
    ).toBe(200);
    expect((await del()).status).toBe(200);
    expect(
      await json(await request("gamma", "/api/v1/esign/connection", { cookie: o.cookie })),
    ).toEqual({ connection: null });
    // The deleted connection's callback URL is now the same 401 as a stranger's.
    expect(
      (
        await callback(
          saved.connection.id,
          memoryCallback(saved.callbackSecret, { event: "completed" }),
        )
      ).status,
    ).toBe(401);
    // Signed records are kept: the voided envelope is still in the register.
    expect((await envelopeRow(wsId, env.id))?.status).toBe("voided");
  });
});

describe("the service beyond the routes", () => {
  it("a module's round envelope: artifacts encrypted at rest, completed published exactly once", async () => {
    const carol = await member("acme", acmeId, "carol@investor.test", "external", "investor");
    const ctx = systemContext(acmeId);
    const view = await running.container.esign.request(ctx, {
      purpose: "round_closing",
      subject: { module: "round", kind: "commitment", id: randomUUID() },
      signer: { name: "Carol", email: "carol@investor.test", membershipId: carol.membershipId },
      title: "Subscription agreement",
      document: { kind: "template", templateRef: "tpl-1", prefill: { amount: "25,000" } },
      vaultFolder: "Signed documents/Seed",
      embedded: false,
      requestedByMembershipId: owner.membershipId,
    });
    expect(view).toMatchObject({ status: "sent", purpose: "round_closing" });
    await signAtVendor(acmeId, view.id);
    const row = await waitFor("the round envelope's artifacts", async () => {
      const [r] = await sql<{ artifacts: { signed: { key: string } } | null }>(
        acmeId,
        `SELECT artifacts FROM core.esign_envelope WHERE id = '${view.id}'`,
      );
      return r?.artifacts ?? undefined;
    });
    const stored = await running.container.storage.get(row.signed.key);
    const raw = new Uint8Array(await new Response(stored?.body).arrayBuffer());
    expect(raw.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(raw.slice(0, 5))).not.toBe("%PDF-");
    const pdf = await request("acme", `/api/v1/esign/envelopes/${view.id}/signed.pdf`, {
      cookie: owner.cookie,
    });
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    await new Promise((r) => setTimeout(r, 1_000));
    const events = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'esign.envelope_completed'
          AND payload->>'envelopeId' = '${view.id}'`,
    );
    expect(events[0]?.n).toBe(1);
  });

  it("the member's DSAR export carries esign.json and their signed copy", async () => {
    const res = await request("acme", `/api/v1/compliance/subjects/${ada.membershipId}/export`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const check = verifySubjectExport(new Uint8Array(await res.arrayBuffer()));
    expect(check.problems).toEqual([]);
    const names = Object.keys(check.files);
    expect(names).toContain("esign.json");
    const signed = names.filter((n) => /^esign\/[0-9a-f-]{36}-signed\.pdf$/u.test(n));
    expect(signed.length).toBeGreaterThanOrEqual(1);
    // `files` is text; the manifest's sha256 over the bytes was already checked above.
    expect(check.files[signed[0] as string]?.startsWith("%PDF-")).toBe(true);
  });

  it("switching driver with nothing open replaces the connection (old one soft-deleted)", async () => {
    const wsId = (await createWorkspace(running.container.db, { slug: "swap", name: "S" })).id;
    const o = await member("swap", wsId, "owner@swap.test", "staff", "owner");
    const first = await json<{ connection: ConnectionBody }>(
      await put("swap", o.cookie, { driver: "docuseal", credentials: { apiToken: TOKEN } }),
    );
    const second = await put("swap", o.cookie, {
      driver: "dropbox-sign",
      credentials: { apiToken: "dbx-token-5678" },
    });
    expect(second.status).toBe(200);
    const now = (await json<{ connection: ConnectionBody }>(second)).connection;
    expect(now.id).not.toBe(first.connection.id);
    expect(now.driver).toBe("dropbox-sign");
    const rows = await sql<{ id: string; deleted: boolean }>(
      wsId,
      "SELECT id, deleted_at IS NOT NULL AS deleted FROM core.esign_connection ORDER BY created_at",
    );
    expect(rows).toEqual([
      { id: first.connection.id, deleted: true },
      { id: now.id, deleted: false },
    ]);
  });
});

describe("erasure", () => {
  it("pseudonymises the signer, voids open envelopes at the vendor and keeps signed artifacts", async () => {
    const dora = await member("acme", acmeId, "dora@investor.test", "external", "investor");
    const doc = await json<{ document: { id: string } }>(
      await createEsignNda("acme", owner.cookie, "side-letter-nda", "# Side letter\n\nOne."),
    );
    // One completed (artifacts collected), one open.
    const done = (await json<{ envelope: EnvelopeBody }>(await startNda(dora, ndaId))).envelope;
    await signAtVendor(acmeId, done.id);
    await waitFor("dora's signed copy", async () =>
      (await envelopeRow(acmeId, done.id))?.artifacts ? true : undefined,
    );
    const open = (await json<{ envelope: EnvelopeBody }>(await startNda(dora, doc.document.id)))
      .envelope;
    const openRef = await providerRefOf(acmeId, open.id);

    const ctx = systemContext(acmeId);
    const detail = await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: dora.membershipId,
        expectedModules: [],
        actor: { membershipId: owner.membershipId },
      }),
    );
    expect(detail.request.status).toBe("completed");
    const [step] = await sql<{ counts: Record<string, number> }>(
      acmeId,
      `SELECT counts FROM core.dsar_step WHERE request_id = '${detail.request.id}'
          AND module = 'core.identity'`,
    );
    expect(step?.counts["esignEnvelopesPseudonymised"]).toBe(2);
    for (const id of [done.id, open.id]) {
      const row = await envelopeRow(acmeId, id);
      expect(row?.signer_pseudonymised_at, id).not.toBeNull();
      expect(row?.signer_email).not.toContain("dora");
      expect(row?.signer_name).not.toContain("dora");
    }
    // Signed records stay (legal hold): the artifacts and the download.
    expect((await envelopeRow(acmeId, done.id))?.artifacts).not.toBeNull();
    expect(
      (
        await request("acme", `/api/v1/esign/envelopes/${done.id}/signed.pdf`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
    // The open one is voided at the vendor by the sweep → `esign.void`.
    await runJob("esign.sync-due", {});
    await waitFor("the erased signer's open envelope to be voided", async () =>
      (await envelopeRow(acmeId, open.id))?.status === "voided" ? true : undefined,
    );
    expect(mem.vendor.created().find((c) => c.providerRef === openRef)).toBeDefined();
  });
});

describe("one real HTTP round trip through the SSRF guard (fake Documenso)", () => {
  it("connect → start → vendor completes → callback → sync → collect → signed PDF", async () => {
    const fake = await startFakeDocumenso();
    try {
      const wsId = (await createWorkspace(running.container.db, { slug: "docu", name: "Docu" })).id;
      const o = await member("docu", wsId, "owner@docu.test", "staff", "owner");
      const inv = await member("docu", wsId, "inv@docu.test", "external", "investor");
      const res = await put("docu", o.cookie, {
        driver: "documenso",
        baseUrl: fake.url,
        credentials: { apiToken: fake.vendor.apiToken },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(res);
      expect(saved.connection.baseUrlHost).toBe(new URL(fake.url).host);
      fake.vendor.setCallbackSecret(saved.callbackSecret);
      const doc = await json<{ document: { id: string } }>(
        await createEsignNda("docu", o.cookie, "nda", "# NDA\n\nThe fake vendor signs this."),
      );
      const started = await startNda(inv, doc.document.id, "docu");
      expect(started.status, await started.clone().text()).toBe(200);
      const env = (await json<{ envelope: EnvelopeBody }>(started)).envelope;
      const ref = await providerRefOf(wsId, env.id);
      expect(fake.vendor.created().map((c) => c.providerRef)).toContain(ref);
      fake.vendor.complete(ref);
      const cb = await callback(saved.connection.id, fake.vendor.callback(ref, "completed"));
      expect(cb.status).toBe(200);
      const forged = await callback(saved.connection.id, fake.vendor.forgedCallback(ref));
      expect(forged.status).toBe(401);
      await waitFor(
        "the documenso NDA to complete",
        async () =>
          (await ndaStatus(inv, doc.document.id, "docu")).status === "completed" ? true : undefined,
        30_000,
      );
      const pdf = await request("docu", `/api/v1/esign/envelopes/${env.id}/signed.pdf`, {
        cookie: o.cookie,
      });
      expect(pdf.status).toBe(200);
      expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

      // A vendor-side cancel hard-deletes a Documenso document: status() then says not_found,
      // which a sync (after a confirming retry) records as voided.
      const inv2 = await member("docu", wsId, "inv2@docu.test", "external", "investor");
      const second = (
        await json<{ envelope: EnvelopeBody }>(await startNda(inv2, doc.document.id, "docu"))
      ).envelope;
      fake.vendor.voidFromVendor(await providerRefOf(wsId, second.id));
      for (let i = 0; i < 3 && (await envelopeRow(wsId, second.id))?.status !== "voided"; i++)
        await runJob("esign.sync", { workspaceId: wsId, envelopeId: second.id });
      expect((await envelopeRow(wsId, second.id))?.status).toBe("voided");
    } finally {
      await fake.close();
    }
  }, 60_000);
});

describe("a resource-scoped e-sign NDA (a folder's gate, E3.5 fix B3)", () => {
  interface GateDoc {
    documentId: string;
    ceremony: string;
    scope: string;
    esign: unknown;
  }
  interface MyAccess {
    resources: { id: string; pendingGates: { kind: string; detail: Record<string, unknown> }[] }[];
  }
  let wsId: string;
  let staff: Actor;
  let rita: Actor;
  let folderId: string;
  let docId: string;
  let conn2: ConnectionBody;
  let secret2: string;

  const gates = async () =>
    (
      await json<{ pending: GateDoc[] }>(
        await request("roomco", "/api/v1/compliance/gates", { cookie: rita.cookie }),
      )
    ).pending;
  const folderGates = async () => {
    const res = await request("roomco", "/api/v1/access/my", { cookie: rita.cookie });
    // The folder's NDA never blocks the rest of the portal.
    expect(res.status).toBe(200);
    return (await json<MyAccess>(res)).resources.find((r) => r.id === folderId)?.pendingGates;
  };

  beforeAll(async () => {
    wsId = (await createWorkspace(running.container.db, { slug: "roomco", name: "Room" })).id;
    staff = await member("roomco", wsId, "owner@roomco.test", "staff", "owner");
    rita = await member("roomco", wsId, "rita@investor.test", "external", "investor");
    const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(
      await put("roomco", staff.cookie, {
        driver: "docuseal",
        credentials: { apiToken: "docuseal-token-room" },
      }),
    );
    conn2 = saved.connection;
    secret2 = saved.callbackSecret;
    // A folder NDA: `nda` + `esign`, but NOT `requiresAcceptance` — it gates one folder only.
    const created = await request("roomco", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: staff.cookie,
      body: JSON.stringify({
        slug: "room-nda",
        title: "Diligence NDA",
        kind: "nda",
        requiresAcceptance: false,
        ceremony: "esign",
        body: "# Diligence NDA\n\nThe diligence folder is confidential.",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    docId = (await json<{ document: { id: string } }>(created)).document.id;
    const tree = await json<{ rootId: string }>(
      await request("roomco", "/api/v1/data-room/tree", { cookie: staff.cookie }),
    );
    const made = await request("roomco", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: staff.cookie,
      body: JSON.stringify({ parentId: tree.rootId, name: "Diligence" }),
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const folder = (
      await json<{ folders: { id: string; name: string; path: string }[] }>(made)
    ).folders.find((f) => f.name === "Diligence");
    if (folder === undefined) throw new Error("no folder");
    folderId = folder.id;
    const granted = await request("roomco", "/api/v1/access/grants", {
      method: "POST",
      cookie: staff.cookie,
      body: JSON.stringify({
        subject: { kind: "membership", id: rita.membershipId },
        resource: { kind: "folder", id: folder.id, path: folder.path },
        capabilities: ["view"],
      }),
    });
    expect(granted.status, await granted.clone().text()).toBe(200);
    const policy = await request("roomco", "/api/v1/access/policies", {
      method: "POST",
      cookie: staff.cookie,
      body: JSON.stringify({
        kind: "nda",
        target: {
          kind: "resource",
          resource: { kind: "folder", id: folder.id, path: folder.path },
        },
        config: { documentId: docId },
      }),
    });
    expect(policy.status, await policy.clone().text()).toBe(200);
    await waitFor("the folder gate to materialise", async () =>
      ((await folderGates()) ?? []).length > 0 ? true : undefined,
    );
  }, 120_000);

  it("is listed by GET /compliance/gates marked scope resource — and nowhere the portal gate reads", async () => {
    const listed = (await gates()).find((p) => p.documentId === docId);
    expect(listed).toMatchObject({
      scope: "resource",
      ceremony: "esign",
      esign: { driver: "docuseal", displayName: "DocuSeal" },
    });
    const boot = await json<{ pendingAcceptances: { documentId: string }[] }>(
      await request("roomco", "/api/v1/modules", { cookie: rita.cookie }),
    );
    expect(boot.pendingAcceptances.map((p) => p.documentId)).not.toContain(docId);
    expect(await folderGates()).toEqual([
      expect.objectContaining({
        kind: "nda",
        detail: expect.objectContaining({ documentId: docId }),
      }),
    ]);
    // A member no gate names is not offered it.
    const other = await member("roomco", wsId, "otto@investor.test", "external", "investor");
    const theirs = await json<{ pending: GateDoc[] }>(
      await request("roomco", "/api/v1/compliance/gates", { cookie: other.cookie }),
    );
    expect(theirs.pending.map((p) => p.documentId)).not.toContain(docId);
  });

  it("signing it at the vendor opens the folder and drops it from the list", async () => {
    const started = await startNda(rita, docId, "roomco");
    expect(started.status, await started.clone().text()).toBe(200);
    const env = (await json<{ envelope: EnvelopeBody }>(started)).envelope;
    const ref = await providerRefOf(wsId, env.id);
    mem.vendor.complete(ref);
    const cb = await callback(
      conn2.id,
      memoryCallback(secret2, { providerRef: ref, event: "completed" }),
    );
    expect(cb.status).toBe(200);
    await waitFor("rita's folder NDA to complete", async () =>
      (await ndaStatus(rita, docId, "roomco")).status === "completed" ? true : undefined,
    );
    await waitFor("the folder to open", async () =>
      (await folderGates())?.length === 0 ? true : undefined,
    );
    expect((await gates()).map((p) => p.documentId)).not.toContain(docId);
  });
});

describe("only a signable NDA takes the e-sign ceremony (E3.5 fix B4)", () => {
  it("refuses esign on a non-nda kind, on create and on patch (422 esign_ceremony_unsupported)", async () => {
    const created = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        slug: "terms-esign",
        title: "Terms",
        kind: "terms",
        ceremony: "esign",
        body: "# Terms",
      }),
    });
    expect(created.status).toBe(422);
    expect((await json<ErrorBody>(created)).error).toMatchObject({
      code: "esign_ceremony_unsupported",
      reason: "not_nda_document",
      kind: "terms",
    });
    // Nothing was written.
    const [n] = await sql<{ n: number }>(
      acmeId,
      "SELECT count(*)::int AS n FROM core.legal_document WHERE slug = 'terms-esign'",
    );
    expect(n?.n).toBe(0);

    const plain = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ slug: "terms-plain", title: "Terms", kind: "terms", body: "# T" }),
    });
    expect(plain.status).toBe(200);
    const id = (await json<{ document: { id: string } }>(plain)).document.id;
    const patched = await request("acme", `/api/v1/compliance/documents/${id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ ceremony: "esign" }),
    });
    expect(patched.status).toBe(422);
    expect((await json<ErrorBody>(patched)).error.code).toBe("esign_ceremony_unsupported");
    // An e-sign NDA cannot be turned into another kind while it keeps the ceremony.
    const nda = await request("acme", `/api/v1/compliance/documents/${ndaId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ kind: "terms" }),
    });
    expect(nda.status).toBe(422);
    const kinds = await sql<{ id: string; kind: string; ceremony: string }>(
      acmeId,
      `SELECT id, kind, ceremony FROM core.legal_document WHERE id IN ('${id}', '${ndaId}')`,
    );
    expect(kinds.find((k) => k.id === id)).toMatchObject({ kind: "terms", ceremony: "clickwrap" });
    expect(kinds.find((k) => k.id === ndaId)).toMatchObject({ kind: "nda", ceremony: "esign" });
  });

  it("refuses text the signing PDF would alter (422 esign_nda_text_unsupported), on every write", async () => {
    const greek = "# NDA\n\nΤα μέρη συμφωνούν.";
    const created = await createEsignNda("acme", owner.cookie, "greek-nda", greek);
    expect(created.status).toBe(422);
    // The error body carries the details flattened beside the code.
    expect((await json<ErrorBody>(created)).error).toMatchObject({
      code: "esign_nda_text_unsupported",
      reason: "unsupported_characters",
      field: "body",
    });

    // A click-wrap NDA with that text may not switch to e-sign…
    const plain = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ slug: "greek-plain", title: "NDA", kind: "nda", body: greek }),
    });
    expect(plain.status).toBe(200);
    const plainId = (await json<{ document: { id: string } }>(plain)).document.id;
    const patched = await request("acme", `/api/v1/compliance/documents/${plainId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ ceremony: "esign" }),
    });
    expect(patched.status).toBe(422);
    expect((await json<ErrorBody>(patched)).error.code).toBe("esign_nda_text_unsupported");

    // …and an e-sign NDA may not publish such a version (nothing is published).
    const esignDoc = await createEsignNda("acme", owner.cookie, "latin-nda", "# NDA\n\nPlain.");
    expect(esignDoc.status).toBe(200);
    const esignId = (await json<{ document: { id: string } }>(esignDoc)).document.id;
    const v2 = await request("acme", `/api/v1/compliance/documents/${esignId}/versions`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ body: greek }),
    });
    expect(v2.status).toBe(422);
    expect((await json<ErrorBody>(v2)).error.code).toBe("esign_nda_text_unsupported");
    const [versions] = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM core.legal_document_version WHERE document_id = '${esignId}'`,
    );
    expect(versions?.n).toBe(1);
  });
});

describe("the NDA start budget answers with Retry-After (E3.5 fix B5)", () => {
  it("the sixth new envelope in a day is 429 rate_limited with Retry-After; resuming is free", async () => {
    const wsId = (await createWorkspace(running.container.db, { slug: "budget", name: "B" })).id;
    const o = await member("budget", wsId, "owner@budget.test", "staff", "owner");
    const inv = await member("budget", wsId, "ivy@investor.test", "external", "investor");
    expect(
      (await put("budget", o.cookie, { driver: "docuseal", credentials: { apiToken: "tok-bud" } }))
        .status,
    ).toBe(200);
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await createEsignNda("budget", o.cookie, `nda-${i}`, `# NDA ${i}\n\nText ${i}.`);
      expect(res.status).toBe(200);
      ids.push((await json<{ document: { id: string } }>(res)).document.id);
    }
    for (const id of ids.slice(0, 5)) expect((await startNda(inv, id, "budget")).status).toBe(200);
    // Resuming an open one does not spend the budget.
    expect((await startNda(inv, ids[0] as string, "budget")).status).toBe(200);
    const over = await startNda(inv, ids[5] as string, "budget");
    expect(over.status).toBe(429);
    expect((await json<ErrorBody>(over)).error).toMatchObject({
      code: "rate_limited",
      reason: "nda_start_budget",
    });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("clearing an optional connection secret reaches the service (E3.5 fix B5)", () => {
  it("passes clearCredentials through: clearing a required field is refused, nothing changes", async () => {
    const before = await sql<{ updated_at: string }>(
      acmeId,
      "SELECT updated_at::text FROM core.esign_connection WHERE deleted_at IS NULL",
    );
    const res = await put("acme", owner.cookie, {
      driver: "docuseal",
      credentials: {},
      clearCredentials: ["apiToken"],
    });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "validation_failed",
      reason: "cannot_clear_required",
    });
    expect(
      await sql<{ updated_at: string }>(
        acmeId,
        "SELECT updated_at::text FROM core.esign_connection WHERE deleted_at IS NULL",
      ),
    ).toEqual(before);
  });
});
