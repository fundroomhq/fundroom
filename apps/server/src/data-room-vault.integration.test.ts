import { randomUUID } from "node:crypto";
import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { publish } from "@fundroom/events";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { dataRoomModule } from "@fundroom/module-data-room";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import {
  type Actor,
  type ConnectionBody,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
  waitFor,
} from "./test/esign-harness.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Vaulting signed e-signature documents into the data room (E3.5, ADR-0053, modules/data-room
 * README "Vaulting"), end to end on a real server and database with the in-memory vendor:
 *
 *  - the happy path for a round-closing envelope (folder path created with the first new folder
 *    staff-only, signed copy + certificate as two legal-hold documents, ingest pipeline reused,
 *    staff-only search ACL, `document.vaulted` audited ×2 and published once, the kernel records
 *    `vaultedDocumentId`), delete / purge / flag-clearing refused;
 *  - THE invariant: nothing vaulted is visible to an external member through any grant — an
 *    investor holding the data-room root, a grant written afterwards on the staff-only folder and
 *    on the document itself, a share-link visitor admitted to the root — across the tree, the
 *    document routes (detail, thumbnail, pages, text, in-document search, download, viewed),
 *    workspace search, `document_list` hydration, the Q&A ask route, RLS and `core.has_access`;
 *    a staff API key reads it; staff moving it out exposes it (audited), moving it back hides it;
 *  - an NDA envelope (`Signed documents/NDAs`, reusing the staff-only folder) and a path that
 *    already exists unveiled (the leaf is flagged staff-only, fail closed);
 *  - the module disabled at run time → skipped, not failed; outbox redelivery and job retry are
 *    idempotent; envelopes completing concurrently into one new path share one folder (no 409,
 *    no duplicate, no deadlock); a one-connection pool vaults without a nested acquire.
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

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
  conn: ConnectionBody;
  secret: string;
  rootId: string;
}

interface TreeBody {
  rootId: string;
  folders: { id: string; name: string; parentId: string | null }[];
  documents: { id: string; title: string; folderId: string }[];
}

interface DocRow {
  id: string;
  title: string;
  folder_id: string;
  folder_path: string;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  esign_envelope_id: string | null;
  deleted_at: string | null;
}

let seq = 0;

async function workspace(slug: string): Promise<Ws> {
  const id = (await createWorkspace(running.container.db, { slug, name: slug })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  const put = await request(slug, "/api/v1/esign/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: `tok-${slug}-1234` } }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(put);
  const tree = await json<TreeBody>(
    await request(slug, "/api/v1/data-room/tree", { cookie: owner.cookie }),
  );
  return {
    id,
    slug,
    owner,
    conn: saved.connection,
    secret: saved.callbackSecret,
    rootId: tree.rootId,
  };
}

function staffCtx(ws: Ws): TenantContext {
  return { workspaceId: ws.id, actorKind: "staff", membershipId: ws.owner.membershipId };
}

async function providerRefOf(ws: Ws, envelopeId: string): Promise<string> {
  const [row] = await sql<{ provider_ref: string | null }>(
    ws.id,
    `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelopeId}'`,
  );
  if (!row?.provider_ref) throw new Error("envelope has no provider ref");
  return row.provider_ref;
}

/** Completes an envelope at the vendor, delivers the genuine callback, waits for collect. */
async function completeAtVendor(ws: Ws, envelopeId: string): Promise<void> {
  const ref = await providerRefOf(ws, envelopeId);
  mem.vendor.complete(ref);
  const res = await callback(
    ws.conn.id,
    memoryCallback(ws.secret, { providerRef: ref, event: "completed" }),
  );
  expect(res.status).toBe(200);
  await waitFor(`envelope ${envelopeId} collected`, async () => {
    const [row] = await sql<{ status: string; collected: boolean }>(
      ws.id,
      `SELECT status, artifacts IS NOT NULL AS collected FROM core.esign_envelope WHERE id = '${envelopeId}'`,
    );
    return row?.status === "completed" && row.collected ? true : undefined;
  });
}

/** A round-closing envelope requested through the kernel service, then completed. */
async function roundEnvelope(ws: Ws, title: string, vaultFolder?: string): Promise<string> {
  seq += 1;
  const view = await running.container.esign.request(staffCtx(ws), {
    purpose: "round_closing",
    subject: { module: "fixture", kind: "commitment", id: randomUUID() },
    signer: { name: `Ivy Investor ${seq}`, email: `ivy+${seq}@investor.test` },
    title,
    document: { kind: "template", templateRef: "tpl-subscription", prefill: {} },
    ...(vaultFolder === undefined ? {} : { vaultFolder }),
    embedded: false,
    requestedByMembershipId: ws.owner.membershipId,
  });
  await completeAtVendor(ws, view.id);
  return view.id;
}

async function vaultedDocs(ws: Ws, envelopeId: string): Promise<DocRow[]> {
  return sql<DocRow>(
    ws.id,
    `SELECT id, title, folder_id, folder_path::text AS folder_path, legal_hold, legal_hold_reason,
            esign_envelope_id, deleted_at::text AS deleted_at
       FROM dataroom.document WHERE legal_hold_reason = 'esign:${envelopeId}' ORDER BY created_at, id`,
  );
}

async function waitVaulted(ws: Ws, envelopeId: string, count = 2): Promise<DocRow[]> {
  return waitFor(
    `envelope ${envelopeId} vaulted`,
    async () => {
      const docs = await vaultedDocs(ws, envelopeId);
      return docs.length >= count ? docs : undefined;
    },
    30_000,
  );
}

/** The vault jobs the queue ran for an envelope have all finished (none pending or failed). */
async function vaultJobsSettled(ws: Ws, envelopeId: string): Promise<string[]> {
  return waitFor(`vault job for ${envelopeId} to finish`, async () => {
    const rows = await sql<{ state: string }>(
      ws.id,
      `SELECT state::text AS state FROM pgboss.job
        WHERE name = 'data-room.vault' AND data->>'envelopeId' = '${envelopeId}'`,
    ).catch(() => [] as { state: string }[]);
    if (rows.length === 0) return undefined;
    return rows.every((r) => r.state === "completed" || r.state === "failed")
      ? rows.map((r) => r.state)
      : undefined;
  });
}

async function setDataRoom(ws: Ws, enabled: boolean, servers: RunningServer[] = [running]) {
  const ctx = systemContext(ws.id);
  await running.container.db.withTenant(ctx, (tx) =>
    new ModuleEnablementRepo(ctx, tx).set("data-room", enabled),
  );
  for (const s of servers) s.container.enablement.invalidate(ws.id);
}

async function folderByName(ws: Ws, name: string) {
  return sql<{ id: string; path: string; staff_only: boolean; parent_id: string | null }>(
    ws.id,
    `SELECT id, path::text AS path, staff_only, parent_id FROM dataroom.folder
      WHERE lower(name) = lower('${name.replaceAll("'", "''")}') AND deleted_at IS NULL ORDER BY created_at`,
  );
}

/** `POST /data-room/folders` answers the tree; the new folder is the one under `parentId`. */
async function createFolder(ws: Ws, parentId: string, name: string): Promise<string> {
  const res = await request(ws.slug, "/api/v1/data-room/folders", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ parentId, name }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const t = await json<TreeBody>(res);
  const f = t.folders.find((x) => x.parentId === parentId && x.name === name);
  if (f === undefined) throw new Error(`folder ${name} not created`);
  return f.id;
}

async function grant(ws: Ws, subject: Record<string, string>, resource: Record<string, string>) {
  const res = await request(ws.slug, "/api/v1/access/grants", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ subject, resource, capabilities: ["view", "download"] }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function rowsAsExternal<T>(ws: Ws, membershipId: string, query: string): Promise<T[]> {
  const ctx: TenantContext = { workspaceId: ws.id, actorKind: "external", membershipId };
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

async function tree(ws: Ws, actor: Actor): Promise<TreeBody> {
  const res = await request(ws.slug, "/api/v1/data-room/tree", { cookie: actor.cookie });
  expect(res.status).toBe(200);
  return json<TreeBody>(res);
}

async function searchIds(ws: Ws, actor: Actor, q: string): Promise<string[]> {
  const res = await request(ws.slug, `/api/v1/search?q=${encodeURIComponent(q)}`, {
    cookie: actor.cookie,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ hits: { refId: string }[] }>(res)).hits.map((h) => h.refId);
}

async function hydrate(
  ws: Ws,
  viewer: { kind: "staff" | "external"; membershipId: string },
  data: JsonObject,
) {
  const hydrator = dataRoomModule.blockHydrators?.find((b) => b.type === "document_list");
  if (hydrator === undefined) throw new Error("no document_list hydrator");
  const tenant: TenantContext = {
    workspaceId: ws.id,
    actorKind: viewer.kind,
    membershipId: viewer.membershipId,
  };
  const out = await hydrator.hydrate(data, {
    tenant,
    viewer: { ...viewer, groupIds: [] },
    facts: {},
  } as never);
  return (out["documents"] as { id: string }[]).map((d) => d.id);
}

/**
 * Everything an external actor could use to reach a vaulted document or its folder: each must
 * answer as if it did not exist.
 */
async function assertInvisible(
  ws: Ws,
  actor: Actor,
  docIds: readonly string[],
  folderIds: readonly string[],
  words: string,
) {
  for (const id of docIds) {
    for (const path of [
      `/documents/${id}`,
      `/documents/${id}/thumbnail`,
      `/documents/${id}/pages/1`,
      `/documents/${id}/pages/1/text`,
      `/documents/${id}/search?q=signed`,
      `/documents/${id}/download`,
      `/documents/${id}/versions`,
    ]) {
      const res = await request(ws.slug, `/api/v1/data-room${path}`, { cookie: actor.cookie });
      expect(res.status, `${path} as external`).toBe(404);
    }
    const viewed = await request(ws.slug, `/api/v1/data-room/documents/${id}/viewed`, {
      method: "POST",
      cookie: actor.cookie,
    });
    expect(viewed.status).toBe(404);
  }
  const t = await tree(ws, actor);
  expect(t.documents.map((d) => d.id).filter((id) => docIds.includes(id))).toEqual([]);
  expect(t.folders.map((f) => f.id).filter((id) => folderIds.includes(id))).toEqual([]);
  const hits = await searchIds(ws, actor, words);
  expect(hits.filter((id) => docIds.includes(id) || folderIds.includes(id))).toEqual([]);
  // Storage layer: RLS never returns the rows, whatever effective_access says.
  const idList = [...docIds].map((i) => `'${i}'`).join(",");
  expect(
    await rowsAsExternal(
      ws,
      actor.membershipId,
      `SELECT id FROM dataroom.document WHERE id IN (${idList})`,
    ),
  ).toEqual([]);
  const fList = [...folderIds].map((i) => `'${i}'`).join(",");
  expect(
    await rowsAsExternal(
      ws,
      actor.membershipId,
      `SELECT id FROM dataroom.folder WHERE id IN (${fList})`,
    ),
  ).toEqual([]);
  expect(
    await rowsAsExternal(
      ws,
      actor.membershipId,
      `SELECT id FROM dataroom.document_version WHERE document_id IN (${idList})`,
    ),
  ).toEqual([]);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env, { JOBS_POLL_INTERVAL_MS: "500" }),
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

describe("vaulting a round-closing envelope", () => {
  let acme: Ws;
  let envelopeId: string;
  let signed: DocRow;
  let certificate: DocRow;
  let signedFolderId: string;
  let roundFolderId: string;
  let ada: Actor;
  let visitor: Actor;
  let pitchId: string;

  beforeAll(async () => {
    acme = await workspace("acme");
    ada = await member("acme", acme.id, "ada@investor.test", "external", "investor");
    // Ada holds the WHOLE data room (a grant on the root), before anything is vaulted.
    await grant(
      acme,
      { kind: "membership", id: ada.membershipId },
      { kind: "folder", id: acme.rootId, path: "r" },
    );
    pitchId = await createFolder(acme, acme.rootId, "Pitch");
  }, 120_000);

  it("files the signed copy and the certificate as legal-hold documents under a new staff-only path", async () => {
    envelopeId = await roundEnvelope(
      acme,
      "Subscription agreement — Quartz Capital",
      "Signed documents/Seed round",
    );
    const docs = await waitVaulted(acme, envelopeId);
    expect(docs).toHaveLength(2);
    [signed, certificate] = docs as [DocRow, DocRow];
    expect(signed).toMatchObject({
      title: "Subscription agreement — Quartz Capital — signed",
      legal_hold: true,
      legal_hold_reason: `esign:${envelopeId}`,
      esign_envelope_id: envelopeId,
    });
    expect(certificate).toMatchObject({
      title: "Subscription agreement — Quartz Capital — certificate",
      legal_hold: true,
      esign_envelope_id: null,
    });
    const [top] = await folderByName(acme, "Signed documents");
    const [leaf] = await folderByName(acme, "Seed round");
    if (!top || !leaf) throw new Error("vault folders missing");
    expect(top).toMatchObject({ staff_only: true, parent_id: acme.rootId });
    // Covered by its staff-only parent: no flag of its own.
    expect(leaf).toMatchObject({ staff_only: false, parent_id: top.id });
    expect(signed.folder_id).toBe(leaf.id);
    signedFolderId = top.id;
    roundFolderId = leaf.id;

    // The ingest pipeline ran on both (scan → encrypt → render), no upload row involved.
    let last: unknown;
    await waitFor(
      "ingest of both vaulted versions",
      async () => {
        const rows = await sql<{ render_status: string; scan_status: string; key: string }>(
          acme.id,
          `SELECT v.render_status::text AS render_status, b.scan_status::text AS scan_status,
                b.storage_key AS key
           FROM dataroom.document d JOIN dataroom.document_version v ON v.id = d.current_version_id
           JOIN dataroom.blob b ON b.id = v.blob_id
          WHERE d.id IN ('${signed.id}', '${certificate.id}')`,
        );
        last = rows;
        return rows.length === 2 &&
          rows.every((r) => r.render_status !== "pending" && r.key.includes("/blobs/"))
          ? rows
          : undefined;
      },
      60_000,
    ).catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(last)}`);
    });
    const [uploads] = await sql<{ n: number }>(
      acme.id,
      "SELECT count(*)::int AS n FROM dataroom.upload",
    );
    expect(uploads?.n).toBe(0);
  }, 120_000);

  it("audits document.vaulted twice, publishes it once, and the kernel records the vaulted document", async () => {
    const audits = await sql<{ resource_id: string; meta: Record<string, unknown> }>(
      acme.id,
      `SELECT resource_id::text AS resource_id, meta FROM audit.event
        WHERE action = 'document.vaulted' ORDER BY seq`,
    );
    expect(audits.map((a) => [a.resource_id, a.meta["artifact"]])).toEqual([
      [signed.id, "signed"],
      [certificate.id, "certificate"],
    ]);
    const folderAudits = await sql<{ resource_id: string }>(
      acme.id,
      `SELECT resource_id::text AS resource_id FROM audit.event
        WHERE action = 'folder.created' AND meta->>'cause' = 'esign.vault' ORDER BY seq`,
    );
    expect(folderAudits.map((a) => a.resource_id)).toEqual([signedFolderId, roundFolderId]);
    const outbox = await sql<{ payload: Record<string, unknown> }>(
      acme.id,
      `SELECT payload FROM core.outbox WHERE topic = 'document.vaulted'`,
    );
    expect(outbox.map((o) => o.payload["documentId"])).toEqual([signed.id]);
    await waitFor("vaultedDocumentId on the envelope", async () => {
      const [row] = await sql<{ vaulted: string | null }>(
        acme.id,
        `SELECT vaulted_document_id::text AS vaulted FROM core.esign_envelope WHERE id = '${envelopeId}'`,
      );
      return row?.vaulted === signed.id ? true : undefined;
    });
    // Search: every vaulted entry is staff-only, whatever the grants say.
    const entries = await sql<{ ref_id: string; acl_kind: string }>(
      acme.id,
      `SELECT ref_id::text AS ref_id, acl_kind FROM core.search_entry
        WHERE ref_id IN ('${signed.id}', '${certificate.id}', '${signedFolderId}', '${roundFolderId}')`,
    );
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((e) => e.acl_kind))).toEqual(new Set(["staff"]));
  });

  it("shows staff everything: tree, detail, search, hydration, and a staff API key", async () => {
    const t = await tree(acme, acme.owner);
    expect(t.documents.map((d) => d.id)).toEqual(
      expect.arrayContaining([signed.id, certificate.id]),
    );
    expect(t.folders.map((f) => f.id)).toEqual(
      expect.arrayContaining([signedFolderId, roundFolderId]),
    );
    const d = await request("acme", `/api/v1/data-room/documents/${signed.id}`, {
      cookie: acme.owner.cookie,
    });
    expect(d.status).toBe(200);
    expect(await searchIds(acme, acme.owner, "Quartz")).toEqual(
      expect.arrayContaining([signed.id]),
    );
    expect(
      await hydrate(
        acme,
        { kind: "staff", membershipId: acme.owner.membershipId },
        {
          folderId: roundFolderId,
          documentIds: [],
        },
      ),
    ).toEqual(expect.arrayContaining([signed.id, certificate.id]));
    const key = await mintTestApiKey(running.container.db, {
      workspaceId: acme.id,
      creatorMembershipId: acme.owner.membershipId,
      scopes: ["data-room.read"],
    });
    const versions = await request("acme", `/api/v1/data-room/documents/${signed.id}/versions`, {
      headers: bearer(key.token),
    });
    expect(versions.status).toBe(200);
  });

  it("refuses to delete, purge or unveil: legal hold and the sticky staff-only flag", async () => {
    const del = await request("acme", `/api/v1/data-room/documents/${certificate.id}`, {
      method: "DELETE",
      cookie: acme.owner.cookie,
    });
    expect(del.status).toBe(409);
    const folderDel = await request("acme", `/api/v1/data-room/folders/${signedFolderId}`, {
      method: "DELETE",
      cookie: acme.owner.cookie,
    });
    expect(folderDel.status).toBe(409);
    const purge = await request("acme", `/api/v1/data-room/documents/${signed.id}/purge`, {
      method: "DELETE",
      cookie: acme.owner.cookie,
    });
    expect(purge.status).toBe(404); // only a binned document can be purged, and this one never is
    await expect(
      sql(acme.id, `DELETE FROM dataroom.document WHERE id = '${signed.id}'`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/legal hold/u) } });
    await expect(
      sql(acme.id, `UPDATE dataroom.folder SET staff_only = false WHERE id = '${signedFolderId}'`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/staff-only/u) } });
    expect((await vaultedDocs(acme, envelopeId)).every((d) => d.deleted_at === null)).toBe(true);
  });

  describe("the invariant: no external member sees a vaulted document through any grant", () => {
    const docIds = () => [signed.id, certificate.id];
    const folderIds = () => [signedFolderId, roundFolderId];

    it("an investor with a grant on the data-room root", async () => {
      // The root grant works (control): Ada sees the ordinary folder.
      expect((await tree(acme, ada)).folders.map((f) => f.id)).toContain(pitchId);
      await assertInvisible(acme, ada, docIds(), folderIds(), "Quartz");
    });

    it("…still, after staff grant her the staff-only folder and the document itself", async () => {
      await grant(
        acme,
        { kind: "membership", id: ada.membershipId },
        { kind: "folder", id: signedFolderId },
      );
      await grant(
        acme,
        { kind: "membership", id: ada.membershipId },
        { kind: "folder", id: roundFolderId },
      );
      await grant(
        acme,
        { kind: "membership", id: ada.membershipId },
        { kind: "document", id: signed.id },
      );
      await running.container.authz.rebuild(acme.id);
      await assertInvisible(acme, ada, docIds(), folderIds(), "Quartz");
      // The kernel's own answers agree: the materialised rows, has_access, who-has-access, explain.
      const rows = await sql<{ resource_id: string; capabilities: string[] }>(
        acme.id,
        `SELECT resource_id::text AS resource_id, capabilities::text[] AS capabilities
           FROM core.effective_access WHERE membership_id = '${ada.membershipId}'`,
      );
      const caps = new Map(rows.map((r) => [r.resource_id, r.capabilities]));
      expect(caps.get(acme.rootId)).toEqual(expect.arrayContaining(["view"]));
      for (const id of [signedFolderId, roundFolderId, signed.id]) expect(caps.get(id)).toEqual([]);
      const [ha] = await rowsAsExternal<{ ok: boolean }>(
        acme,
        ada.membershipId,
        `SELECT core.has_access('document', '${signed.id}'::uuid, '${signed.folder_path}'::ltree, 'view') AS ok`,
      );
      expect(ha?.ok).toBe(false);
      const who = await json<{ holders: { membershipId: string; capabilities: string[] }[] }>(
        await request("acme", `/api/v1/access/resources/document/${signed.id}/who`, {
          cookie: acme.owner.cookie,
        }),
      );
      expect(who.holders.find((x) => x.membershipId === ada.membershipId)?.capabilities).toEqual(
        [],
      );
      const ex = await json<{ decision: { allowed: boolean; reason: string } }>(
        await request(
          "acme",
          `/api/v1/access/resources/folder/${roundFolderId}/explain?membershipId=${ada.membershipId}`,
          { cookie: acme.owner.cookie },
        ),
      );
      expect(ex.decision).toMatchObject({ allowed: false, reason: "no_grant" });
    });

    it("holds from the commit, before any effective-access rebuild (the module's own veil)", async () => {
      // A staff-only flag written with NO acl bump: the materialised rows still say Ada's root
      // grant reaches the folder, so only the module's path check and RLS stand in the way.
      const lateId = await createFolder(acme, acme.rootId, "Late closing");
      await waitFor("ada to see the new folder", async () =>
        (await tree(acme, ada)).folders.some((f) => f.id === lateId) ? true : undefined,
      );
      await sql(acme.id, `UPDATE dataroom.folder SET staff_only = true WHERE id = '${lateId}'`);
      expect((await tree(acme, ada)).folders.map((f) => f.id)).not.toContain(lateId);
      expect(
        await rowsAsExternal(
          acme,
          ada.membershipId,
          `SELECT id FROM dataroom.folder WHERE id = '${lateId}'`,
        ),
      ).toEqual([]);
    });

    it("document_list hydration (content-page embeds) returns nothing vaulted", async () => {
      expect(
        await hydrate(
          acme,
          { kind: "external", membershipId: ada.membershipId },
          {
            folderId: roundFolderId,
            documentIds: docIds(),
          },
        ),
      ).toEqual([]);
    });

    it("the Q&A target picker / ask route refuses a vaulted target as unknown", async () => {
      const on = await request("acme", "/api/v1/data-room/settings", {
        method: "PATCH",
        cookie: acme.owner.cookie,
        body: JSON.stringify({ qa: { enabled: true } }),
      });
      expect(on.status, await on.clone().text()).toBe(200);
      const ask = (targetKind: string, targetId: string) =>
        request("acme", "/api/v1/data-room/qa/questions", {
          method: "POST",
          cookie: ada.cookie,
          body: JSON.stringify({
            targetKind,
            targetId,
            subject: "Terms?",
            body: "What are the terms?",
          }),
        });
      expect((await ask("folder", pitchId)).status).toBe(201); // control
      expect((await ask("document", signed.id)).status).toBe(404);
      expect((await ask("folder", roundFolderId)).status).toBe(404);
      const listed = await request(
        "acme",
        `/api/v1/data-room/qa/questions?scope=target&targetKind=document&targetId=${signed.id}`,
        { cookie: ada.cookie },
      );
      expect(listed.status).toBe(200);
      expect((await json<{ items: unknown[] }>(listed)).items).toEqual([]);
    });

    it("a share-link visitor admitted to the whole data room", async () => {
      const offering = await request("acme", "/api/v1/compliance/offering", {
        method: "PATCH",
        cookie: acme.owner.cookie,
        body: JSON.stringify({ status: "506c", confirm: "506c", reason: "raising" }),
      });
      expect(offering.status, await offering.clone().text()).toBe(200);
      const minted = await request("acme", "/api/v1/links", {
        method: "POST",
        cookie: acme.owner.cookie,
        body: JSON.stringify({
          label: "Everything",
          policy: { domains: ["visitor.test"], emails: [], forceWatermark: false },
          grants: [
            {
              resource: { kind: "folder", id: acme.rootId, path: "r" },
              capabilities: ["view", "download"],
            },
          ],
        }),
      });
      expect(minted.status, await minted.clone().text()).toBe(200);
      const { token } = await json<{ token: string }>(minted);
      const email = "vic@visitor.test";
      const since = mailer.sent.length;
      const start = await request("acme", `/api/v1/links/${token}/start`, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      expect(start.status).toBe(200);
      const code = await awaitSignInCode(mailer, email, since);
      const verified = await request("acme", `/api/v1/links/${token}/verify`, {
        method: "POST",
        body: JSON.stringify({ email, code }),
      });
      expect(verified.status, await verified.clone().text()).toBe(200);
      const body = await json<{ membership: { id: string } | null }>(verified);
      visitor = {
        membershipId: body.membership?.id ?? "",
        cookie: verified.headers
          .getSetCookie()
          .map((c) => c.split(";")[0] ?? "")
          .join("; "),
      };
      await waitFor("the visitor to see the root", async () =>
        (await tree(acme, visitor)).folders.some((f) => f.id === pitchId) ? true : undefined,
      );
      await assertInvisible(acme, visitor, docIds(), folderIds(), "Quartz");
    });

    it("staff may move a signed document out on purpose (audited) — and back in, hidden again at once", async () => {
      const out = await request("acme", `/api/v1/data-room/documents/${signed.id}`, {
        method: "PATCH",
        cookie: acme.owner.cookie,
        body: JSON.stringify({ folderId: pitchId }),
      });
      expect(out.status, await out.clone().text()).toBe(200);
      const [moved] = await sql<{ meta: Record<string, unknown> }>(
        acme.id,
        `SELECT meta FROM audit.event WHERE action = 'document.updated'
          AND resource_id = '${signed.id}' ORDER BY seq DESC LIMIT 1`,
      );
      expect(moved?.meta).toMatchObject({ movedTo: pitchId, leftStaffOnly: true, legalHold: true });
      // Still held, and now an ordinary document Ada's root grant reaches.
      await waitFor("ada to see the moved document", async () =>
        (await request("acme", `/api/v1/data-room/documents/${signed.id}`, { cookie: ada.cookie }))
          .status === 200
          ? true
          : undefined,
      );
      const [entry] = await sql<{ acl_kind: string }>(
        acme.id,
        `SELECT acl_kind FROM core.search_entry WHERE ref_id = '${signed.id}'`,
      );
      expect(entry?.acl_kind).toBe("resource");
      const back = await request("acme", `/api/v1/data-room/documents/${signed.id}`, {
        method: "PATCH",
        cookie: acme.owner.cookie,
        body: JSON.stringify({ folderId: roundFolderId }),
      });
      expect(back.status).toBe(200);
      // No rebuild awaited: the module's veil and the search ACL hold from the commit.
      expect(
        (await request("acme", `/api/v1/data-room/documents/${signed.id}`, { cookie: ada.cookie }))
          .status,
      ).toBe(404);
      const [again] = await sql<{ acl_kind: string }>(
        acme.id,
        `SELECT acl_kind FROM core.search_entry WHERE ref_id = '${signed.id}'`,
      );
      expect(again?.acl_kind).toBe("staff");
      await assertInvisible(acme, ada, docIds(), folderIds(), "Quartz");
    });
  });

  it("is idempotent under outbox redelivery and job retry", async () => {
    const before = await vaultedDocs(acme, envelopeId);
    const auditsBefore = await sql<{ n: number }>(
      acme.id,
      "SELECT count(*)::int AS n FROM audit.event WHERE action = 'document.vaulted'",
    );
    // Redelivery: the same event again through the outbox (the relay runs every handler).
    const ctx = systemContext(acme.id);
    await running.container.db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "esign.envelope_completed", {
        envelopeId,
        purpose: "round_closing",
        subjectModule: "fixture",
        subjectKind: "commitment",
        subjectId: randomUUID(),
        membershipId: null,
      }),
    );
    // Retries: sequential and concurrent.
    await runJob("data-room.vault", { workspaceId: acme.id, envelopeId });
    await Promise.all([
      runJob("data-room.vault", { workspaceId: acme.id, envelopeId }),
      runJob("data-room.vault", { workspaceId: acme.id, envelopeId }),
    ]);
    await vaultJobsSettled(acme, envelopeId);
    await waitFor("the redelivered event to be dispatched", async () => {
      const [pending] = await sql<{ n: number }>(
        acme.id,
        `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'esign.envelope_completed'
          AND processed_at IS NULL`,
      ).catch(() => [{ n: 0 }]);
      return pending?.n === 0 ? true : undefined;
    });
    await vaultJobsSettled(acme, envelopeId);
    expect((await vaultedDocs(acme, envelopeId)).map((d) => d.id)).toEqual(before.map((d) => d.id));
    const auditsAfter = await sql<{ n: number }>(
      acme.id,
      "SELECT count(*)::int AS n FROM audit.event WHERE action = 'document.vaulted'",
    );
    expect(auditsAfter[0]?.n).toBe(auditsBefore[0]?.n);
    expect(await folderByName(acme, "Signed documents")).toHaveLength(1);
  }, 60_000);

  it("skips an envelope with no vault folder (nothing filed, the job does not fail)", async () => {
    const id = await roundEnvelope(acme, "Side letter — no vault");
    const states = await vaultJobsSettled(acme, id);
    expect(states.every((s) => s === "completed")).toBe(true);
    expect(await vaultedDocs(acme, id)).toEqual([]);
  }, 60_000);
});

describe("vaulting an NDA envelope, and a path that already exists unveiled", () => {
  let gamma: Ws;
  let nina: Actor;

  beforeAll(async () => {
    gamma = await workspace("gamma");
    nina = await member("gamma", gamma.id, "nina@investor.test", "external", "investor");
    await grant(
      gamma,
      { kind: "membership", id: nina.membershipId },
      { kind: "folder", id: gamma.rootId, path: "r" },
    );
  }, 120_000);

  it("files a signed NDA under Signed documents/NDAs, staff-only", async () => {
    const created = await request("gamma", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: gamma.owner.cookie,
      body: JSON.stringify({
        slug: "mutual-nda",
        title: "Mutual NDA",
        kind: "nda",
        requiresAcceptance: true,
        ceremony: "esign",
        body: "The parties agree to keep each other's information confidential.",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const ndaId = (await json<{ document: { id: string } }>(created)).document.id;
    const start = await request("gamma", "/api/v1/esign/nda/start", {
      method: "POST",
      cookie: nina.cookie,
      body: JSON.stringify({
        documentId: ndaId,
        consentToElectronicRecords: true,
        disclosureVersion: 1,
      }),
    });
    expect(start.status, await start.clone().text()).toBe(200);
    const envelopeId = (await json<{ envelope: { id: string } }>(start)).envelope.id;
    await completeAtVendor(gamma, envelopeId);
    const docs = await waitVaulted(gamma, envelopeId);
    expect(
      docs.map((d) => d.title.endsWith(" — signed") || d.title.endsWith(" — certificate")),
    ).toEqual([true, true]);
    const [top] = await folderByName(gamma, "Signed documents");
    const [ndas] = await folderByName(gamma, "NDAs");
    expect(top?.staff_only).toBe(true);
    expect(ndas?.parent_id).toBe(top?.id);
    expect(docs[0]?.folder_id).toBe(ndas?.id);
    // The signer herself — past the gate now, holding the root — does not see it in the room
    // (her copy is the kernel's /esign/me/envelopes/{id}/signed.pdf).
    await waitFor("nina past the NDA gate", async () =>
      (await request("gamma", "/api/v1/data-room/tree", { cookie: nina.cookie })).status === 200
        ? true
        : undefined,
    );
    await assertInvisible(
      gamma,
      nina,
      docs.map((d) => d.id),
      [top?.id ?? "", ndas?.id ?? ""],
      "NDA",
    );

    // A round envelope later reuses the staff-only parent: one "Signed documents".
    const round = await roundEnvelope(
      gamma,
      "SAFE — Birch Ventures",
      "signed documents/Seed round",
    );
    await waitVaulted(gamma, round);
    expect(await folderByName(gamma, "Signed documents")).toHaveLength(1);
    const [seed] = await folderByName(gamma, "Seed round");
    expect(seed).toMatchObject({ parent_id: top?.id, staff_only: false });
  }, 120_000);

  it("fails closed on an existing unveiled path: the leaf is flagged staff-only (audited), its parent stays shared", async () => {
    const boardId = await createFolder(gamma, gamma.rootId, "Board");
    const minutesId = await createFolder(gamma, boardId, "Minutes");
    await waitFor("nina to see Minutes", async () =>
      (await tree(gamma, nina)).folders.some((f) => f.id === minutesId) ? true : undefined,
    );
    const id = await roundEnvelope(gamma, "Board consent — signed resolution", "Board/Minutes");
    const docs = await waitVaulted(gamma, id);
    expect(docs[0]?.folder_id).toBe(minutesId);
    const [flag] = await sql<{ diff: Record<string, unknown> }>(
      gamma.id,
      `SELECT diff FROM audit.event WHERE action = 'folder.updated' AND resource_id = '${minutesId}'`,
    );
    expect(flag?.diff).toMatchObject({ after: { staffOnly: true } });
    const t = await tree(gamma, nina);
    expect(t.folders.map((f) => f.id)).toContain(boardId);
    expect(t.folders.map((f) => f.id)).not.toContain(minutesId);
    await assertInvisible(
      gamma,
      nina,
      docs.map((d) => d.id),
      [minutesId],
      "resolution",
    );
  }, 90_000);
});

describe("module disabled, concurrency, and a one-connection pool", () => {
  let beta: Ws;

  beforeAll(async () => {
    beta = await workspace("beta");
  }, 120_000);

  it("skips (not fails) while the data room is disabled; a retry after enabling vaults it", async () => {
    await setDataRoom(beta, false);
    const id = await roundEnvelope(beta, "SAFE — Cedar Partners", "Signed documents/Series A");
    const states = await vaultJobsSettled(beta, id);
    expect(states.every((s) => s === "completed")).toBe(true);
    await runJob("data-room.vault", { workspaceId: beta.id, envelopeId: id });
    expect(await vaultedDocs(beta, id)).toEqual([]);
    expect(await folderByName(beta, "Series A")).toEqual([]);
    await setDataRoom(beta, true);
    await runJob("data-room.vault", { workspaceId: beta.id, envelopeId: id });
    expect(await vaultedDocs(beta, id)).toHaveLength(2);
  }, 90_000);

  it("envelopes completing at once into the same NEW path share one folder, no 409, no deadlock", async () => {
    await setDataRoom(beta, false);
    const ids: string[] = [];
    for (const who of ["Dune", "Elm", "Fir", "Gale"]) {
      ids.push(await roundEnvelope(beta, `SAFE — ${who} Capital`, "Closing binders/Series B"));
    }
    for (const id of ids) await vaultJobsSettled(beta, id);
    await setDataRoom(beta, true);
    const before = await deadlocks(pg.pool);
    // Every envelope at once, the first one twice (a retry racing the original).
    await Promise.all([
      ...ids.map((id) => runJob("data-room.vault", { workspaceId: beta.id, envelopeId: id })),
      runJob("data-room.vault", { workspaceId: beta.id, envelopeId: ids[0] ?? "" }),
    ]);
    expect(await folderByName(beta, "Closing binders")).toHaveLength(1);
    const series = await folderByName(beta, "Series B");
    expect(series).toHaveLength(1);
    for (const id of ids) {
      const docs = await vaultedDocs(beta, id);
      expect(docs).toHaveLength(2);
      expect(docs.every((d) => d.folder_id === series[0]?.id)).toBe(true);
    }
    expect(await deadlocks(pg.pool)).toBe(before);
  }, 120_000);

  it("a one-connection pool vaults, and serves the vaulted document, without a nested acquire", async () => {
    await setDataRoom(beta, false);
    const id = await roundEnvelope(beta, "SAFE — Hazel Fund", "Signed documents/Series A");
    await vaultJobsSettled(beta, id);
    const single = await startServer({
      config: esignTestConfig(env, {
        DATABASE_POOL_MAX: "1",
        ROLES: "api",
        JOBS_POLL_INTERVAL_MS: "500",
      }),
      logger: createLogger({ level: "error" }),
      mailer,
      esignAdapters: { docuseal: mem.definition },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    // Its own relay would legitimately serialise the only connection (E3.4 lesson).
    await single.container.relay.stop();
    try {
      await setDataRoom(beta, true, [running, single]);
      const run = async () => {
        const handler = dataRoomModule.events?.handles?.["esign.envelope_completed"];
        if (handler === undefined) throw new Error("no handler");
        const ctx = systemContext(beta.id);
        // The outbox handler on the dispatcher's transaction: enqueue, no second connection.
        await single.container.db.withTenant(ctx, (tx) =>
          handler(
            {
              id: randomUUID(),
              topic: "esign.envelope_completed",
              payload: {
                envelopeId: id,
                purpose: "round_closing",
                subjectModule: "fixture",
                subjectKind: "commitment",
                subjectId: randomUUID(),
                membershipId: null,
              },
            } as never,
            { tx, ctx } as never,
          ),
        );
        await runJob("data-room.vault", { workspaceId: beta.id, envelopeId: id }, single);
        const docs = await vaultedDocs(beta, id);
        expect(docs).toHaveLength(2);
        const opts = { server: single };
        const t = await request("beta", "/api/v1/data-room/tree", {
          cookie: beta.owner.cookie,
          ...opts,
        });
        expect(t.status).toBe(200);
        const d = await request("beta", `/api/v1/data-room/documents/${docs[0]?.id}`, {
          cookie: beta.owner.cookie,
          ...opts,
        });
        expect(d.status).toBe(200);
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 45_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 120_000);
});
