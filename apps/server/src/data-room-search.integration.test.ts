import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { dataRoomPortability } from "@fundroom/module-data-room";
import * as OTPAuth from "otpauth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The data room in workspace search (E2.8): after upload + ingest a document is findable by a
 * word of its PDF text for an investor holding a (folder) grant and for staff, by nobody else;
 * a gated (NDA pending) investor finds the title only, never a body match; rename, move, folder
 * move, delete and restore keep the index in step on the write's own transaction. The page
 * text route answers with the page's `page_text` under exactly the page image's checks. The
 * import hook re-derives renditions and text through the ingest job without rescanning.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
}
interface Hit {
  module: string;
  kind: string;
  refId: string;
  title: string;
  snippet: { text: string; highlight: boolean }[];
  href: string;
  gated: boolean;
}

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out");
}

async function signIn(email: string): Promise<Actor> {
  const since = mailer.sent.length;
  await request("/api/v1/auth/otp/start", { method: "POST", body: JSON.stringify({ email }) });
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  return { cookie, membershipId: body.membership?.id ?? "" };
}

async function member(
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(email);
  if (role === "owner") {
    const enrol = await request("/api/v1/auth/totp/enrol", {
      method: "POST",
      cookie: actor.cookie,
    });
    const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({ code: totp.generate() }),
    });
    expect(confirm.status).toBe(200);
    // Step-up rotates the session token (F-12): carry the new cookie on.
    actor.cookie = withSetCookies(actor.cookie, confirm);
  }
  return actor;
}

async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of pages) {
    doc.addPage([612, 792]).drawText(line, { x: 50, y: 700, size: 20, font });
  }
  return doc.save();
}

/** tus upload + complete, as the browser does; waits for ingest. */
async function upload(actor: Actor, folderId: string, fileName: string, bytes: Uint8Array) {
  const start = await request("/api/v1/data-room/uploads", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({
      fileName,
      size: bytes.byteLength,
      contentType: "application/pdf",
      folderId,
    }),
  });
  expect(start.status).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const create = await request(endpoint, {
    method: "POST",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": `upload ${Buffer.from(started.upload.id).toString("base64")}`,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request(`${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: bytes,
  });
  expect(patch.status).toBe(204);
  const complete = await request(`/api/v1/data-room/uploads/${started.upload.id}/complete`, {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({}),
  });
  expect(complete.status).toBe(200);
  const body = await json<{ document: { id: string }; version: { id: string } }>(complete);
  await ready(actor, body.document.id);
  return { documentId: body.document.id, versionId: body.version.id };
}

async function ready(actor: Actor, id: string) {
  return waitFor(async () => {
    const res = await request(`/api/v1/data-room/documents/${id}`, { cookie: actor.cookie });
    if (res.status !== 200) return undefined;
    const d = await json<{ currentVersion: { renderStatus: string; pageCount: number } | null }>(
      res,
    );
    return d.currentVersion?.renderStatus === "ready" ? d : undefined;
  });
}

async function search(actor: Actor, q: string): Promise<Hit[]> {
  const res = await request(`/api/v1/search?q=${encodeURIComponent(q)}`, {
    cookie: actor.cookie,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ hits: Hit[] }>(res)).hits.filter((h) => h.module === "data-room");
}

/** Polls until the data-room hits for `q` satisfy `ok` (grants reach effective access async). */
async function eventually(actor: Actor, q: string, ok: (hits: Hit[]) => boolean) {
  let last: Hit[] = [];
  try {
    return await waitFor(async () => {
      last = await search(actor, q);
      return ok(last) ? last : undefined;
    }, 15_000);
  } catch {
    throw new Error(`search ${JSON.stringify(q)}: ${JSON.stringify(last)}`);
  }
}

interface TreeBody {
  rootId: string;
  folders: { id: string; name: string; path: string }[];
}
function folderIn(tree: TreeBody, name: string): { id: string; path: string } {
  const f = tree.folders.find((x) => x.name === name);
  if (f === undefined) throw new Error(`no folder ${name}`);
  return { id: f.id, path: f.path };
}

const ids = (hits: Hit[]) => hits.map((h) => `${h.kind}:${h.refId}`).sort();

let acmeId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor; // folder grant on Financials
let bob: Actor; // no grant
let carol: Actor; // grant through a group that has an NDA pending
let rootId: string;
let financials: { id: string; path: string };
let legal: { id: string; path: string };
let deckId: string;
let deckVersionId: string;
let memoId: string;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member(acmeId, "owner@example.com", "staff", "owner");
  editor = await member(acmeId, "editor@example.com", "staff", "editor");
  ada = await member(acmeId, "ada@investor.test", "external", "investor");
  bob = await member(acmeId, "bob@investor.test", "external", "investor");
  carol = await member(acmeId, "carol@investor.test", "external", "investor");

  // The noop scanner marks blobs `skipped`; this workspace accepts unscanned files.
  const settings = await request("/api/v1/data-room/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ allowUnscanned: true }),
  });
  expect(settings.status).toBe(200);

  rootId = (
    await json<{ rootId: string }>(
      await request("/api/v1/data-room/tree", { cookie: owner.cookie }),
    )
  ).rootId;
  const folder = async (name: string) => {
    const res = await request("/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId, name }),
    });
    expect(res.status).toBe(201);
    return folderIn(await json<TreeBody>(res), name);
  };
  financials = await folder("Financials");
  legal = await folder("Legal");

  const deck = await upload(
    editor,
    financials.id,
    "alphadeck.pdf",
    await makePdf(["zebracorn traction slide", "second page runway eighteen months"]),
  );
  deckId = deck.documentId;
  deckVersionId = deck.versionId;
  memoId = (
    await upload(editor, legal.id, "counselmemo.pdf", await makePdf(["quokkaclause indemnity"]))
  ).documentId;

  const grant = async (subject: { kind: string; id: string }) => {
    const res = await request("/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject,
        resource: { kind: "folder", id: financials.id, path: financials.path },
        capabilities: ["view"],
      }),
    });
    expect(res.status).toBe(200);
  };
  await grant({ kind: "membership", id: ada.membershipId });
  const group = await json<{ id: string }>(
    await request("/api/v1/access/groups", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Prospects", kind: "custom" }),
    }),
  );
  await request(`/api/v1/access/groups/${group.id}/members`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ membershipIds: [carol.membershipId] }),
  });
  await grant({ kind: "group", id: group.id });
  const nda = await request("/api/v1/access/policies", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      kind: "nda",
      target: { kind: "group", id: group.id },
      config: { version: "v1" },
    }),
  });
  expect(nda.status).toBe(200);
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("data room entries in workspace search", () => {
  it("indexes the document (title + page text) and the folders, with the ACL path authz checks", async () => {
    const rows = await sql<{
      kind: string;
      ref_id: string;
      title: string;
      body: string;
      href: string;
      acl_kind: string;
      acl_resource_kind: string;
      acl_path: string;
    }>(
      `SELECT kind, ref_id::text, title, body, href, acl_kind, acl_resource_kind, acl_path::text
         FROM core.search_entry WHERE workspace_id = $1 AND module = 'data-room' ORDER BY kind, title`,
      [acmeId],
    );
    const deck = rows.find((r) => r.ref_id === deckId);
    const pages = await sql<{ text: string }>(
      "SELECT text FROM dataroom.page_text WHERE version_id = $1 ORDER BY page_no",
      [deckVersionId],
    );
    expect(deck).toMatchObject({
      kind: "document",
      title: "alphadeck",
      body: pages.map((p) => p.text).join("\n"),
      href: `/data-room/documents/${deckId}`,
      acl_kind: "resource",
      acl_resource_kind: "document",
      acl_path: financials.path,
    });
    expect(deck?.body).toContain("zebracorn");
    expect(rows.find((r) => r.ref_id === financials.id)).toMatchObject({
      kind: "folder",
      title: "Financials",
      body: "",
      href: `/data-room/folders/${financials.id}`,
      acl_resource_kind: "folder",
      acl_path: financials.path,
    });
    expect(rows.some((r) => r.ref_id === rootId)).toBe(false);
  });

  it("finds a document by a word of its PDF text for an investor with a folder grant", async () => {
    const hits = await eventually(ada, "zebracorn", (h) => h.length > 0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "document",
      refId: deckId,
      title: "alphadeck",
      href: `/data-room/documents/${deckId}`,
      gated: false,
    });
    expect(hits[0]?.snippet.some((s) => s.highlight && /zebracorn/iu.test(s.text))).toBe(true);
    expect(ids(await search(ada, "Financials"))).toEqual([`folder:${financials.id}`]);
    // a document outside the grant is not found
    expect(await search(ada, "quokkaclause")).toEqual([]);
  });

  it("finds nothing for an investor without a grant; staff find everything", async () => {
    expect(await search(bob, "zebracorn")).toEqual([]);
    expect(await search(bob, "alphadeck")).toEqual([]);
    expect(await search(bob, "Financials")).toEqual([]);
    expect(ids(await search(owner, "zebracorn"))).toEqual([`document:${deckId}`]);
    expect(ids(await search(owner, "quokkaclause"))).toEqual([`document:${memoId}`]);
  });

  it("a gated (NDA pending) investor finds the title only — never a body match or a snippet", async () => {
    const titled = await eventually(carol, "alphadeck", (h) => h.length > 0);
    expect(titled).toEqual([expect.objectContaining({ refId: deckId, gated: true, snippet: [] })]);
    expect(await search(carol, "zebracorn")).toEqual([]);
    expect(await search(carol, "runway")).toEqual([]);
  });

  it("a rename updates the title in the same transaction", async () => {
    const res = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "Series seed board pack" }),
    });
    expect(res.status).toBe(200);
    expect(await search(ada, "alphadeck")).toEqual([]);
    expect(ids(await search(ada, "board pack"))).toEqual([`document:${deckId}`]);
  });

  it("moving a document out of the granted folder hides it; moving it back shows it", async () => {
    const out = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ folderId: legal.id }),
    });
    expect(out.status).toBe(200);
    const [row] = await sql<{ acl_path: string }>(
      "SELECT acl_path::text FROM core.search_entry WHERE ref_id = $1",
      [deckId],
    );
    expect(row?.acl_path).toBe(legal.path);
    expect(await search(ada, "zebracorn")).toEqual([]);
    const back = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ folderId: financials.id }),
    });
    expect(back.status).toBe(200);
    expect(ids(await search(ada, "zebracorn"))).toEqual([`document:${deckId}`]);
  });

  it("moving a folder under a granted one re-paths its subtree (grant inheritance follows)", async () => {
    const moved = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: financials.id }),
    });
    expect(moved.status).toBe(200);
    const newPath = folderIn(await json<TreeBody>(moved), "Legal").path;
    const rows = await sql<{ ref_id: string; acl_path: string }>(
      "SELECT ref_id::text, acl_path::text FROM core.search_entry WHERE ref_id = ANY($1::uuid[])",
      [[legal.id, memoId]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.ref_id, r.acl_path]))).toEqual({
      [legal.id]: newPath,
      [memoId]: newPath,
    });
    const found = await eventually(ada, "quokkaclause", (h) => h.length > 0);
    expect(ids(found)).toEqual([`document:${memoId}`]);
    const back = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId }),
    });
    expect(back.status).toBe(200);
    legal = folderIn(await json<TreeBody>(back), "Legal");
    await eventually(ada, "quokkaclause", (h) => h.length === 0);
  });

  it("delete and restore (document, then a folder subtree) remove and bring back the entries", async () => {
    const del = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(200);
    expect(await search(owner, "zebracorn")).toEqual([]);
    const restore = await request(`/api/v1/data-room/documents/${deckId}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restore.status).toBe(200);
    expect(ids(await search(owner, "zebracorn"))).toEqual([`document:${deckId}`]);

    const delFolder = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(delFolder.status).toBe(200);
    expect(await search(owner, "quokkaclause")).toEqual([]);
    expect(await search(owner, "Legal")).toEqual([]);
    const restoreFolder = await request(`/api/v1/data-room/folders/${legal.id}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restoreFolder.status).toBe(200);
    expect(ids(await search(owner, "quokkaclause"))).toEqual([`document:${memoId}`]);
    expect(ids(await search(owner, "Legal"))).toEqual([`folder:${legal.id}`]);
  });
});

describe("data room index maintenance (fix A)", () => {
  const folderUnder = async (parentId: string, name: string) => {
    const res = await request("/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId, name }),
    });
    expect(res.status).toBe(201);
    return folderIn(await json<TreeBody>(res), name);
  };
  const entryRows = (refs: string[]) =>
    sql<{ ref_id: string; acl_path: string; indexed_at: string; body_len: number }>(
      `SELECT ref_id::text, acl_path::text, indexed_at::text, char_length(body)::int AS body_len
         FROM core.search_entry WHERE ref_id = ANY($1::uuid[]) ORDER BY ref_id`,
      [refs],
    );

  it("moving a folder into a restricted one hides its hits at once, re-pathing without re-reading bodies", async () => {
    // Fix A #5: the move rewrites acl_path in SQL; the document entries are not re-written.
    const vault = await folderUnder(rootId, "Vault");
    const boardroom = await folderUnder(financials.id, "Boardroom");
    const doc = await upload(
      editor,
      boardroom.id,
      "wombatplan.pdf",
      await makePdf(["wombatstrategy numbers"]),
    );
    await eventually(ada, "wombatstrategy", (h) => h.length === 1);
    const before = await entryRows([boardroom.id, doc.documentId]);
    expect(before.find((r) => r.ref_id === doc.documentId)?.body_len).toBeGreaterThan(0);

    const moved = await request(`/api/v1/data-room/folders/${boardroom.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: vault.id }),
    });
    expect(moved.status).toBe(200);
    const newPath = folderIn(await json<TreeBody>(moved), "Boardroom").path;
    // Hidden immediately (no job in between): the ACL path moved in the same transaction.
    expect(await search(ada, "wombatstrategy")).toEqual([]);
    expect((await search(ada, "Boardroom")).map((h) => h.refId)).not.toContain(boardroom.id);
    expect(ids(await search(owner, "wombatstrategy"))).toEqual([`document:${doc.documentId}`]);
    const after = await entryRows([boardroom.id, doc.documentId]);
    expect(after.map((r) => r.acl_path)).toEqual([newPath, newPath]);
    // Same indexed_at and body: the entries were re-pathed, not re-read and re-written.
    expect(after.map((r) => [r.ref_id, r.indexed_at, r.body_len])).toEqual(
      before.map((r) => [r.ref_id, r.indexed_at, r.body_len]),
    );
  });

  it("a title of only control characters does not fail the rename (the entry gets a neutral marker)", async () => {
    // Fix A #7: the route admits it; the index used to throw inside the rename's transaction.
    const res = await request(`/api/v1/data-room/documents/${memoId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "\u0007\u0001" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await sql<{ title: string }>(
      "SELECT title FROM core.search_entry WHERE ref_id = $1",
      [memoId],
    );
    expect(row?.title).toBe("\u2014");
    const back = await request(`/api/v1/data-room/documents/${memoId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "counselmemo" }),
    });
    expect(back.status).toBe(200);
  });

  it("turning allowUnscanned off drops unscanned files' text from search at once", async () => {
    // Fix A #6: the noop scanner leaves every blob here `skipped` (unscanned).
    expect(ids(await search(owner, "zebracorn"))).toEqual([`document:${deckId}`]);
    const off = await request("/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowUnscanned: false }),
    });
    try {
      expect(off.status).toBe(200);
      // Immediately — not when the reindex job gets to it.
      expect(await search(owner, "zebracorn")).toEqual([]);
      const [row] = await entryRows([deckId]);
      expect(row?.body_len).toBe(0);
      // The title stays findable.
      expect(ids(await search(owner, "board pack"))).toContain(`document:${deckId}`);
    } finally {
      const on = await request("/api/v1/data-room/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ allowUnscanned: true }),
      });
      expect(on.status).toBe(200);
    }
    // Back on: the reindex brings the text back.
    await eventually(owner, "zebracorn", (h) => h.length === 1);
  });
});

describe("GET /data-room/documents/{id}/pages/{n}/text", () => {
  const text = (actor: Actor, id: string, n: number | string) =>
    request(`/api/v1/data-room/documents/${id}/pages/${n}/text`, { cookie: actor.cookie });

  it("answers with the page's extracted text under the page image's checks", async () => {
    const pages = await sql<{ page_no: number; text: string }>(
      "SELECT page_no, text FROM dataroom.page_text WHERE version_id = $1 ORDER BY page_no",
      [deckVersionId],
    );
    for (const actor of [ada, owner]) {
      const res = await text(actor, deckId, 2);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await json(res)).toEqual({ pageNo: 2, pageCount: 2, text: pages[1]?.text });
    }
    expect(pages[1]?.text).toContain("runway");
  });

  it("refuses like the page image: no grant 404, gated 403 with the gate, past the end 404, bad n 400", async () => {
    expect((await text(bob, deckId, 1)).status).toBe(404);
    const gated = await text(carol, deckId, 1);
    expect(gated.status).toBe(403);
    expect(JSON.stringify(await json(gated))).toContain("nda");
    expect((await text(ada, deckId, 3)).status).toBe(404);
    expect((await text(ada, deckId, 0)).status).toBe(400);
    expect((await text(ada, memoId, 1)).status).toBe(404);
  });

  it("writes nothing: no audit event, no outbox row", async () => {
    const count = async () =>
      (
        await sql<{ n: string }>(
          `SELECT (SELECT count(*) FROM audit.event WHERE workspace_id = $1)
                + (SELECT count(*) FROM core.outbox WHERE workspace_id = $1) AS n`,
          [acmeId],
        )
      )[0]?.n;
    const before = await count();
    for (let i = 0; i < 3; i++) expect((await text(ada, deckId, 1)).status).toBe(200);
    expect(await count()).toBe(before);
  });
});

describe("after a workspace import (portability afterImport)", () => {
  it("re-derives renditions and page text through the ingest job without rescanning or new versions", async () => {
    const before = await sql<{ scanned_at: string; versions: string; blobs: string }>(
      `SELECT b.scanned_at::text,
              (SELECT count(*) FROM dataroom.document_version WHERE workspace_id = $1) AS versions,
              (SELECT count(*) FROM dataroom.blob WHERE workspace_id = $1) AS blobs
         FROM dataroom.document_version v JOIN dataroom.blob b ON b.id = v.blob_id WHERE v.id = $2`,
      [acmeId, deckVersionId],
    );
    // What the import leaves behind: carried versions, no derived rows.
    await sql("DELETE FROM dataroom.page_text WHERE workspace_id = $1", [acmeId]);
    await sql("DELETE FROM dataroom.rendition WHERE workspace_id = $1", [acmeId]);
    const sys = systemContext(acmeId);
    await running.container.db.withTenant(
      sys,
      (tx) =>
        dataRoomPortability.afterImport?.({
          tx,
          ctx: sys,
          services: running.container.moduleServices,
        }) ?? Promise.resolve(),
    );
    await ready(owner, deckId);
    const pages = await waitFor(async () => {
      const rows = await sql<{ text: string }>(
        "SELECT text FROM dataroom.page_text WHERE version_id = $1 ORDER BY page_no",
        [deckVersionId],
      );
      return rows.length === 2 ? rows : undefined;
    });
    expect(pages[0]?.text).toContain("zebracorn");
    const thumbs = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM dataroom.rendition WHERE version_id = $1 AND kind = 'thumbnail'",
      [deckVersionId],
    );
    expect(thumbs[0]?.n).toBe("1");
    const after = await sql<{ scanned_at: string; versions: string; blobs: string }>(
      `SELECT b.scanned_at::text,
              (SELECT count(*) FROM dataroom.document_version WHERE workspace_id = $1) AS versions,
              (SELECT count(*) FROM dataroom.blob WHERE workspace_id = $1) AS blobs
         FROM dataroom.document_version v JOIN dataroom.blob b ON b.id = v.blob_id WHERE v.id = $2`,
      [acmeId, deckVersionId],
    );
    expect(after).toEqual(before);
    expect(ids(await eventually(owner, "zebracorn", (h) => h.length > 0))).toEqual([
      `document:${deckId}`,
    ]);
  });
});
