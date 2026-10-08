import { createWorkspace, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { dataRoomModule } from "@fundroom/module-data-room";
import type { JsonObject } from "@fundroom/ports";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  type ConnectionBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
  waitFor,
} from "./test/esign-harness.js";

/*
 * A gate on a node BELOW the node a member was granted (review AZ): an investor holding `view` +
 * `download` on data-room folder R, with an access-policy gate attached to a sub-folder R/Secret, to
 * a single document in a granted folder, or to a sub-folder whose document the investor was granted
 * directly. The kernel used to materialise effective-access rows only for the nodes a member's
 * RULES name, and `check()` answers from the nearest row — so the granted ancestor's row (with no
 * pending gate) decided the gated sub-folder and everything in it: the NDA / accreditation was never
 * asked for. Every door is checked: the folder tree, document detail, page image, page text,
 * download, workspace search, `document_list` hydration, `GET /access/my`; and the E3.5 NDA flow
 * (`GET /compliance/gates` lists the sub-folder's NDA as `scope:"resource"`, `POST /esign/nda/start`
 * starts it, signing it opens the sub-folder). A gate on the granted folder itself is the control
 * that always worked, and the ungated sibling documents must stay open.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, callback } = h;
const SLUG = "gateco";

interface TreeBody {
  rootId: string;
  folders: { id: string; name: string; path: string; parentId: string | null }[];
  documents: { id: string; folderId: string; access: { allowed: boolean; reason: string } }[];
}
interface Folder {
  id: string;
  path: string;
}
interface Access {
  allowed: boolean;
  reason: string;
  pendingGates: { kind: string; detail: Record<string, unknown>; source: string }[];
}

let wsId: string;
let owner: Actor;
let ivy: Actor; // allow on R, R2, R3, R4; a direct grant on doc5 only
let bob: Actor; // no grant anywhere
let conn: ConnectionBody;
let secret: string;
let ndaId: string;

let r: Folder;
let rSecret: Folder;
let r2: Folder;
let r3: Folder;
let r4: Folder;
let r4Acc: Folder;
let s5: Folder;
const doc: Record<string, string> = {};

async function makePdf(line: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText(line, { x: 50, y: 700, size: 20, font });
  return d.save();
}

async function createFolder(parentId: string, name: string): Promise<Folder> {
  const res = await request(SLUG, "/api/v1/data-room/folders", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ parentId, name }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const f = (await json<TreeBody>(res)).folders.find(
    (x) => x.parentId === parentId && x.name === name,
  );
  if (f === undefined) throw new Error(`folder ${name} not created`);
  return { id: f.id, path: f.path };
}

/** tus upload + complete, as the browser does; waits for ingest. */
async function upload(folderId: string, fileName: string, line: string): Promise<string> {
  const bytes = await makePdf(line);
  const start = await request(SLUG, "/api/v1/data-room/uploads", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      fileName,
      size: bytes.byteLength,
      contentType: "application/pdf",
      folderId,
    }),
  });
  expect(start.status, await start.clone().text()).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const create = await request(SLUG, endpoint, {
    method: "POST",
    cookie: owner.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": `upload ${Buffer.from(started.upload.id).toString("base64")}`,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request(SLUG, `${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  expect(patch.status).toBe(204);
  const complete = await request(SLUG, `/api/v1/data-room/uploads/${started.upload.id}/complete`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({}),
  });
  expect(complete.status, await complete.clone().text()).toBe(200);
  const id = (await json<{ document: { id: string } }>(complete)).document.id;
  await waitFor(`${fileName} ingested`, async () => {
    const res = await request(SLUG, `/api/v1/data-room/documents/${id}`, { cookie: owner.cookie });
    if (res.status !== 200) return undefined;
    const d = await json<{ currentVersion: { renderStatus: string } | null }>(res);
    return d.currentVersion?.renderStatus === "ready" ? true : undefined;
  });
  return id;
}

async function grant(resource: Record<string, string>, subject = ivy.membershipId) {
  const res = await request(SLUG, "/api/v1/access/grants", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      subject: { kind: "membership", id: subject },
      resource,
      capabilities: ["view", "download"],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function gate(kind: string, resource: Record<string, string>, config: JsonObject) {
  const res = await request(SLUG, "/api/v1/access/policies", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ kind, target: { kind: "resource", resource }, config }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function tree(actor: Actor): Promise<TreeBody> {
  const res = await request(SLUG, "/api/v1/data-room/tree", { cookie: actor.cookie });
  expect(res.status).toBe(200);
  return json<TreeBody>(res);
}

async function detail(actor: Actor, id: string): Promise<{ status: number; access?: Access }> {
  const res = await request(SLUG, `/api/v1/data-room/documents/${id}`, { cookie: actor.cookie });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, access: (await json<{ access: Access }>(res)).access };
}

/**
 * Every content-serving route of one document: its status, and `gated` when the refusal is the
 * pending-gate one (403 carrying `pendingGates`) rather than, say, a download the document's
 * protection does not offer.
 */
async function served(actor: Actor, id: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of ["pages/1", "pages/1/text", "download", "thumbnail"]) {
    const res = await request(SLUG, `/api/v1/data-room/documents/${id}/${p}`, {
      cookie: actor.cookie,
    });
    const gated =
      res.status === 403 &&
      Array.isArray(
        ((await res.json()) as { error?: { pendingGates?: unknown } }).error?.pendingGates,
      );
    out[p] = gated ? "403 gated" : String(res.status);
  }
  return out;
}

async function search(actor: Actor, q: string) {
  const res = await request(SLUG, `/api/v1/search?q=${encodeURIComponent(q)}`, {
    cookie: actor.cookie,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (
    await json<{ hits: { refId: string; gated: boolean; snippet: unknown[] }[] }>(res)
  ).hits.filter((x) => Object.values(doc).includes(x.refId));
}

async function hydrate(actor: Actor, data: JsonObject) {
  const hydrator = dataRoomModule.blockHydrators?.find((b) => b.type === "document_list");
  if (hydrator === undefined) throw new Error("no document_list hydrator");
  const tenant: TenantContext = {
    workspaceId: wsId,
    actorKind: "external",
    membershipId: actor.membershipId,
  };
  const out = await hydrator.hydrate(data, {
    tenant,
    viewer: { kind: "external", membershipId: actor.membershipId, groupIds: [] },
    facts: {},
  } as never);
  return out["documents"] as { id: string; gated: boolean }[];
}

/** Every door answers "gated": listed, never served. */
async function assertGated(id: string, gateKind: string, bodyWord: string) {
  const d = await detail(ivy, id);
  expect(d.status, `detail ${id}`).toBe(200);
  expect(d.access).toMatchObject({ allowed: false, reason: "gated" });
  expect(d.access?.pendingGates.map((g) => g.kind)).toContain(gateKind);
  const s = await served(ivy, id);
  expect(s, `content routes of ${id}`).toEqual({
    "pages/1": "403 gated",
    "pages/1/text": "403 gated",
    download: "403 gated",
    thumbnail: "403 gated",
  });
  const t = await tree(ivy);
  expect(t.documents.find((x) => x.id === id)?.access).toMatchObject({
    allowed: false,
    reason: "gated",
  });
  // A gated document is findable by its title at most — never served a snippet of its body.
  for (const hit of await search(ivy, bodyWord))
    expect(hit).toMatchObject({ refId: id, gated: true, snippet: [] });
  const hydrated = await hydrate(ivy, { documentIds: [id] });
  expect(hydrated).toEqual([expect.objectContaining({ id, gated: true })]);
}

async function assertOpen(id: string, bodyWord: string) {
  const d = await detail(ivy, id);
  expect(d.access).toMatchObject({ allowed: true, reason: "granted" });
  const s = await served(ivy, id);
  expect(s["pages/1"]).toBe("200");
  expect(s["pages/1/text"]).toBe("200");
  expect(s["thumbnail"]).toBe("200");
  expect((await search(ivy, bodyWord)).map((x) => x.refId)).toEqual([id]);
  expect(await hydrate(ivy, { documentIds: [id] })).toEqual([
    expect.objectContaining({ id, gated: false }),
  ]);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString)),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  wsId = (await createWorkspace(running.container.db, { slug: SLUG, name: "Gate Co" })).id;
  owner = await member(SLUG, wsId, "owner@gateco.test", "staff", "owner");
  ivy = await member(SLUG, wsId, "ivy@investor.test", "external", "investor");
  bob = await member(SLUG, wsId, "bob@investor.test", "external", "investor");

  const settings = await request(SLUG, "/api/v1/data-room/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ allowUnscanned: true }),
  });
  expect(settings.status).toBe(200);
  const put = await request(SLUG, "/api/v1/esign/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: "tok-gateco-1234" } }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
  const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(put);
  conn = saved.connection;
  secret = saved.callbackSecret;
  const nda = await request(SLUG, "/api/v1/compliance/documents", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      slug: "secret-nda",
      title: "Secret folder NDA",
      kind: "nda",
      requiresAcceptance: false,
      ceremony: "esign",
      body: "# Secret folder NDA\n\nThe secret folder is confidential.",
    }),
  });
  expect(nda.status, await nda.clone().text()).toBe(200);
  ndaId = (await json<{ document: { id: string } }>(nda)).document.id;

  const rootId = (await tree(owner)).rootId;
  r = await createFolder(rootId, "Room");
  rSecret = await createFolder(r.id, "Secret");
  r2 = await createFolder(rootId, "Room two");
  r3 = await createFolder(rootId, "Room three");
  r4 = await createFolder(rootId, "Room four");
  r4Acc = await createFolder(r4.id, "Accredited only");
  s5 = await createFolder(rootId, "Room five");

  doc["open"] = await upload(r.id, "open.pdf", "aardvarkopen");
  doc["secret"] = await upload(rSecret.id, "secret.pdf", "bananasecret");
  doc["self"] = await upload(r2.id, "self.pdf", "cherryself");
  doc["gatedDoc"] = await upload(r3.id, "gateddoc.pdf", "damsongated");
  doc["sibling"] = await upload(r3.id, "sibling.pdf", "elderberrysibling");
  doc["acc"] = await upload(r4Acc.id, "acc.pdf", "figaccredited");
  doc["direct"] = await upload(s5.id, "direct.pdf", "grapedirect");

  const folderRef = (f: Folder) => ({ kind: "folder", id: f.id, path: f.path });
  for (const f of [r, r2, r3, r4]) await grant(folderRef(f));
  await grant({ kind: "document", id: doc["direct"] as string });

  await gate("nda", folderRef(rSecret), { documentId: ndaId });
  await gate("nda", folderRef(r2), { version: "v7" });
  await gate("nda", { kind: "document", id: doc["gatedDoc"] as string }, { version: "v8" });
  await gate("accredited", folderRef(r4Acc), { maxAgeDays: 365 });
  await gate("nda", folderRef(s5), { version: "v9" });
  // Wait until the last gate has materialised (the rebuild runs off the outbox).
  await waitFor("gates to materialise", async () => {
    const d = await detail(ivy, doc["self"] as string);
    return d.access?.reason === "gated" ? true : undefined;
  });
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("a gate on a node below the granted one binds (review AZ)", () => {
  it("control: a gate on the granted folder itself gates the documents inside", async () => {
    await assertGated(doc["self"] as string, "nda", "cherryself");
  });

  it("an NDA on a sub-folder of the granted folder gates the sub-folder and its documents", async () => {
    await assertGated(doc["secret"] as string, "nda", "bananasecret");
    const t = await tree(ivy);
    const folder = t.folders.find((f) => f.id === rSecret.id) as unknown as
      | { access: Access }
      | undefined;
    expect(folder?.access).toMatchObject({ allowed: false, reason: "gated" });
    // The ungated rest of the granted folder stays open.
    await assertOpen(doc["open"] as string, "aardvarkopen");
  });

  it("an NDA on one document of a granted folder gates that document, not its sibling", async () => {
    await assertGated(doc["gatedDoc"] as string, "nda", "damsongated");
    await assertOpen(doc["sibling"] as string, "elderberrysibling");
  });

  it("an accreditation gate on a sub-folder binds as well", async () => {
    await assertGated(doc["acc"] as string, "accredited", "figaccredited");
  });

  it("a gate on the folder binds a document inside it granted directly", async () => {
    await assertGated(doc["direct"] as string, "nda", "grapedirect");
  });

  it("GET /access/my reports the sub-folder with its pending gate", async () => {
    const res = await request(SLUG, "/api/v1/access/my?kind=folder", { cookie: ivy.cookie });
    expect(res.status).toBe(200);
    const mine = await json<{ resources: { id: string; pendingGates: { kind: string }[] }[] }>(res);
    expect(mine.resources.find((x) => x.id === rSecret.id)?.pendingGates).toEqual([
      expect.objectContaining({ kind: "nda" }),
    ]);
    expect(mine.resources.find((x) => x.id === r.id)?.pendingGates).toEqual([]);
  });

  it("the sub-folder's e-sign NDA is offered (scope resource), startable, and signing it opens the sub-folder", async () => {
    const offered = await json<{ pending: { documentId: string; scope: string }[] }>(
      await request(SLUG, "/api/v1/compliance/gates", { cookie: ivy.cookie }),
    );
    expect(offered.pending.find((p) => p.documentId === ndaId)).toMatchObject({
      scope: "resource",
    });
    // A member no grant reaches is not offered it.
    const theirs = await json<{ pending: { documentId: string }[] }>(
      await request(SLUG, "/api/v1/compliance/gates", { cookie: bob.cookie }),
    );
    expect(theirs.pending.map((p) => p.documentId)).not.toContain(ndaId);

    const started = await request(SLUG, "/api/v1/esign/nda/start", {
      method: "POST",
      cookie: ivy.cookie,
      body: JSON.stringify({
        documentId: ndaId,
        consentToElectronicRecords: true,
        disclosureVersion: 1,
      }),
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const envelopeId = (await json<{ envelope: { id: string } }>(started)).envelope.id;
    const [row] = await sql<{ provider_ref: string | null }>(
      wsId,
      `SELECT provider_ref FROM core.esign_envelope WHERE id = '${envelopeId}'`,
    );
    const ref = row?.provider_ref;
    if (!ref) throw new Error("envelope has no provider ref");
    mem.vendor.complete(ref);
    const cb = await callback(
      conn.id,
      memoryCallback(secret, { providerRef: ref, event: "completed" }),
    );
    expect(cb.status).toBe(200);
    await waitFor(
      "the secret folder to open",
      async () =>
        (await detail(ivy, doc["secret"] as string)).access?.allowed === true ? true : undefined,
      30_000,
    );
    await assertOpen(doc["secret"] as string, "bananasecret");
    const after = await json<{ pending: { documentId: string }[] }>(
      await request(SLUG, "/api/v1/compliance/gates", { cookie: ivy.cookie }),
    );
    expect(after.pending.map((p) => p.documentId)).not.toContain(ndaId);
    // The other gates still bind.
    await assertGated(doc["gatedDoc"] as string, "nda", "damsongated");
  }, 60_000);
});
