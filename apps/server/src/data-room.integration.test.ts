import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rederiveRulePaths } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { createMaintenanceService } from "@fundroom/module-data-room";
import { brandingLogoKey } from "@fundroom/storage";
import * as OTPAuth from "otpauth";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The data room end to end (E1.3): folder templates with index numbers, the tus upload
 * path through the app (filesystem driver), the ingest job (noop scan → sanitise → encrypt
 * → text + thumbnail), the unscanned policy, page images with per-viewer watermarks,
 * in-document search, watermarked vs original downloads, folder grants inherited by the
 * documents inside (ADR-0034) incl. exclusion and a folder move, upload hygiene refusals,
 * legal hold, recycle bin → restore → purge, RLS catalog, cross-tenant replay, audit + outbox.
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

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "viewer" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

interface TreeFolder {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  index: string | null;
  passthrough: boolean;
  access: { allowed: boolean; reason: string };
}
interface TreeDoc {
  id: string;
  folderId: string;
  title: string;
  index: string;
  scanStatus: string | null;
  renderStatus: string | null;
  access: { allowed: boolean; capabilities: string[]; reason: string };
}
interface Tree {
  rootId: string;
  folders: TreeFolder[];
  documents: TreeDoc[];
}
interface Detail {
  document: {
    id: string;
    title: string;
    legalHold: boolean;
    protection: Record<string, boolean>;
    pageCount: number | null;
  };
  folder: { id: string; path: string };
  currentVersion: {
    id: string;
    renderStatus: string;
    pageCount: number | null;
    fileName: string;
  } | null;
  scan: { status: string; engine: string | null } | null;
  versions: unknown[];
  access: { allowed: boolean; capabilities: string[]; reason: string };
  availability: { viewable: boolean; download: string | null; reason: string };
}

async function makePdf(pages: number, marker: string, hostile = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${marker} page ${i} ${i === 2 ? "runway eighteen months" : ""}`, {
      x: 50,
      y: 700,
      size: 20,
      font,
    });
  }
  if (hostile) {
    doc.catalog.set(
      PDFName.of("OpenAction"),
      doc.context.obj({ S: "JavaScript", JS: "app.alert(1)" }),
    );
  }
  return doc.save();
}

/** Uploads through the tus endpoint the way the browser does; returns the completed document id. */
async function uploadViaTus(
  actor: Actor,
  target: { folderId?: string; documentId?: string },
  fileName: string,
  contentType: string,
  bytes: Uint8Array,
  opts: { expectStart?: number; expectComplete?: number } = {},
): Promise<{
  documentId: string;
  versionId: string;
  uploadId: string;
  complete: Response;
  deduplicated: boolean;
}> {
  const start = await request("acme", "/api/v1/data-room/uploads", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({ fileName, size: bytes.byteLength, contentType, ...target }),
  });
  expect(start.status).toBe(opts.expectStart ?? 201);
  if (start.status !== 201)
    return { documentId: "", versionId: "", uploadId: "", complete: start, deduplicated: false };
  const started = await json<{
    upload: { id: string };
    method: string;
    tus: { path: string } | null;
  }>(start);
  expect(started.method).toBe("tus");
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from(fileName).toString("base64")}`;
  const create = await request("acme", endpoint, {
    method: "POST",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": meta,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const half = Math.ceil(bytes.byteLength / 2);
  for (const [offset, chunk] of [
    [0, bytes.subarray(0, half)],
    [half, bytes.subarray(half)],
  ] as const) {
    const patch = await request("acme", `${endpoint}/${started.upload.id}`, {
      method: "PATCH",
      cookie: actor.cookie,
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "content-type": "application/offset+octet-stream",
      },
      body: chunk,
    });
    expect(patch.status).toBe(204);
  }
  const complete = await request(
    "acme",
    `/api/v1/data-room/uploads/${started.upload.id}/complete`,
    {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({}),
    },
  );
  expect(complete.status).toBe(opts.expectComplete ?? 200);
  if (complete.status !== 200) {
    return {
      documentId: "",
      versionId: "",
      uploadId: started.upload.id,
      complete,
      deduplicated: false,
    };
  }
  const body = await json<{
    document: { id: string };
    version: { id: string };
    deduplicated: boolean;
  }>(complete);
  return {
    documentId: body.document.id,
    versionId: body.version.id,
    uploadId: started.upload.id,
    complete,
    deduplicated: body.deduplicated,
  };
}

async function detail(actor: Actor, id: string): Promise<Response> {
  return request("acme", `/api/v1/data-room/documents/${id}`, { cookie: actor.cookie });
}

async function ingested(actor: Actor, id: string): Promise<Detail> {
  return waitFor(async () => {
    const res = await detail(actor, id);
    if (res.status !== 200) return undefined;
    const d = await json<Detail>(res);
    return d.currentVersion && d.currentVersion.renderStatus !== "pending" ? d : undefined;
  });
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let investor: Actor;
let boardInvestor: Actor;
let globexOwner: Actor;
let boardGroupId: string;
let rootId: string;
let financialsId: string;
let forecastId: string;
let deckId: string;
let deckPdf: Uint8Array;

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
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  viewer = await member("acme", acmeId, "viewer@example.com", "staff", "viewer");
  investor = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  boardInvestor = await member("acme", acmeId, "board@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  const group = await json<{ id: string }>(
    await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Board", kind: "board" }),
    }),
  );
  boardGroupId = group.id;
  await request("acme", `/api/v1/access/groups/${boardGroupId}/members`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ membershipIds: [boardInvestor.membershipId] }),
  });
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema", () => {
  it("dataroom.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers the module with its permissions, jobs and the document_list hydrator", () => {
    const r = running.container.registry;
    expect(r.ids).toContain("data-room");
    expect(r.permissions.get("data-room.manage")).toBe("data-room");
    expect(running.container.jobs.map((j) => j.name)).toEqual(
      expect.arrayContaining(["data-room.ingest", "data-room.purge", "data-room.reconcile"]),
    );
    expect(r.blockHydrators.get("document_list")?.module).toBe("data-room");
  });
});

describe("folders and templates", () => {
  it("creates the root on first sight and applies the Seed template with index numbers", async () => {
    const empty = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    expect(empty.folders).toEqual([]);
    rootId = empty.rootId;
    const templates = await request("acme", "/api/v1/data-room/templates", {
      cookie: viewer.cookie,
    });
    expect(templates.status).toBe(200);
    const applied = await request("acme", "/api/v1/data-room/templates/seed/apply", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    expect(applied.status).toBe(200);
    const { created, tree } = await json<{ created: number; tree: Tree }>(applied);
    expect(created).toBe(12);
    const byName = new Map(tree.folders.map((f) => [f.name, f]));
    expect(byName.get("Overview")?.index).toBe("1");
    expect(byName.get("Financials")?.index).toBe("2");
    expect(byName.get("Forecast")?.index).toBe("2.2");
    financialsId = byName.get("Financials")?.id ?? "";
    forecastId = byName.get("Forecast")?.id ?? "";
    // idempotent: existing names are kept
    const again = await json<{ created: number }>(
      await request("acme", "/api/v1/data-room/templates/seed/apply", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({}),
      }),
    );
    expect(again.created).toBe(0);
  });

  it("refuses duplicates, moving into itself, and renames within the parent", async () => {
    const dup = await request("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId, name: "financials" }),
    });
    expect(dup.status).toBe(409);
    const self = await request("acme", `/api/v1/data-room/folders/${financialsId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: forecastId }),
    });
    expect(self.status).toBe(409);
    const viewerTry = await request("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({ parentId: rootId, name: "Nope" }),
    });
    expect(viewerTry.status).toBe(403);
  });
});

describe("upload → ingest → view", () => {
  it("refuses types outside the allow-list up front and content that does not match its type", async () => {
    const html = await request("acme", "/api/v1/data-room/uploads", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        fileName: "x.html",
        size: 10,
        contentType: "text/html",
        folderId: financialsId,
      }),
    });
    expect(html.status).toBe(415);
    const fake = await uploadViaTus(
      editor,
      { folderId: financialsId },
      "fake.pdf",
      "application/pdf",
      Buffer.from("<html><script>alert(1)</script></html>"),
      { expectComplete: 415 },
    );
    expect((await json<{ error: { code: string } }>(fake.complete)).error.code).toBe(
      "unsupported_media_type",
    );
    const status = await json<{ status: string; error: string | null }>(
      await request("acme", `/api/v1/data-room/uploads/${fake.uploadId}`, {
        cookie: editor.cookie,
      }),
    );
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/type mismatch/u);
  });

  it("uploads a hostile PDF through tus, scans (noop → skipped), sanitises, renders and extracts text", async () => {
    deckPdf = await makePdf(3, "Acme deck", true);
    const pdf = deckPdf;
    const up = await uploadViaTus(
      editor,
      { folderId: financialsId },
      "Acme Deck.pdf",
      "application/pdf",
      pdf,
    );
    deckId = up.documentId;
    const d = await ingested(owner, deckId);
    expect(d.document.title).toBe("Acme Deck");
    expect(d.scan).toMatchObject({ status: "skipped", engine: "noop" });
    expect(d.currentVersion).toMatchObject({
      renderStatus: "ready",
      pageCount: 3,
      fileName: "Acme Deck.pdf",
    });
    expect(d.versions).toHaveLength(1);
    // The noop scanner leaves it unscanned; unscanned is not servable until the workspace opts in.
    expect(d.availability).toEqual({ viewable: false, download: null, reason: "unscanned" });
    const page = await request("acme", `/api/v1/data-room/documents/${deckId}/pages/1`, {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(409);
    const tree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const doc = tree.documents.find((x) => x.id === deckId);
    expect(doc?.index).toBe("2.3");
    expect(doc?.scanStatus).toBe("skipped");
    const audit = await running.container.db.pool.query(
      `SELECT action FROM audit.event WHERE workspace_id = $1 AND action IN ('document.sanitized','document.ingested') ORDER BY action`,
      [acmeId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["document.ingested", "document.sanitized"]);
  });

  it("serves watermarked pages, thumbnail and search once unscanned blobs are allowed", async () => {
    const settings = await request("acme", "/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowUnscanned: true }),
    });
    expect(settings.status).toBe(200);
    const d = await json<Detail>(await detail(owner, deckId));
    expect(d.availability).toEqual({ viewable: true, download: "original", reason: "ready" });
    const page = await request("acme", `/api/v1/data-room/documents/${deckId}/pages/1`, {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("image/webp");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const ownerBytes = new Uint8Array(await page.arrayBuffer());
    expect(ownerBytes.byteLength).toBeGreaterThan(1000);
    const again = await request("acme", `/api/v1/data-room/documents/${deckId}/pages/1`, {
      cookie: editor.cookie,
    });
    const editorBytes = new Uint8Array(await again.arrayBuffer());
    // Same rendition, different watermark identity → different bytes.
    expect(Buffer.compare(Buffer.from(ownerBytes), Buffer.from(editorBytes))).not.toBe(0);
    const thumb = await request("acme", `/api/v1/data-room/documents/${deckId}/thumbnail`, {
      cookie: viewer.cookie,
    });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    const missing = await request("acme", `/api/v1/data-room/documents/${deckId}/pages/9`, {
      cookie: owner.cookie,
    });
    expect(missing.status).toBe(404);
    const search = await json<{ hits: { pageNo: number; snippet: string }[] }>(
      await request("acme", `/api/v1/data-room/documents/${deckId}/search?q=runway`, {
        cookie: owner.cookie,
      }),
    );
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]).toMatchObject({ pageNo: 2 });
    expect(search.hits[0]?.snippet).toContain("«runway»");
    const viewed = await request("acme", `/api/v1/data-room/documents/${deckId}/viewed`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(await json(viewed)).toEqual({ recorded: true });
    expect(
      await json(
        await request("acme", `/api/v1/data-room/documents/${deckId}/viewed`, {
          method: "POST",
          cookie: owner.cookie,
        }),
      ),
    ).toEqual({ recorded: false });
  });

  it("downloads: staff get the original, the watermarked variant is a PDF with the viewer burned in", async () => {
    const original = await request("acme", `/api/v1/data-room/documents/${deckId}/download`, {
      cookie: owner.cookie,
    });
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("application/pdf");
    expect(original.headers.get("content-disposition")).toContain('filename="Acme Deck.pdf"');
    const bytes = new Uint8Array(await original.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const marked = await request(
      "acme",
      `/api/v1/data-room/documents/${deckId}/download?variant=watermarked`,
      { cookie: owner.cookie },
    );
    expect(marked.status).toBe(200);
    expect(marked.headers.get("content-disposition")).toContain("Acme Deck-watermarked.pdf");
    const markedBytes = new Uint8Array(await marked.arrayBuffer());
    const text = await running.container.renderer.extractText(markedBytes, "pdf");
    expect(text[0]).toContain("owner@example.com");
    // viewer role: read but no download permission
    const denied = await request("acme", `/api/v1/data-room/documents/${deckId}/download`, {
      cookie: viewer.cookie,
    });
    expect(denied.status).toBe(403);
  });

  it("dedupes an identical file within the workspace and versions a document", async () => {
    const again = await uploadViaTus(
      editor,
      { folderId: forecastId },
      "copy.pdf",
      "application/pdf",
      deckPdf,
    );
    expect(again.deduplicated).toBe(true);
    const d = await ingested(owner, again.documentId);
    expect(d.currentVersion?.renderStatus).toBe("ready");
    const v2 = await makePdf(2, "Acme deck v2");
    const versioned = await uploadViaTus(
      editor,
      { documentId: deckId },
      "deck-v2.pdf",
      "application/pdf",
      v2,
    );
    const dd = await waitFor(async () => {
      const x = await json<Detail>(await detail(owner, deckId));
      return x.currentVersion?.id === versioned.versionId &&
        x.currentVersion.renderStatus === "ready"
        ? x
        : undefined;
    });
    expect(dd.versions).toHaveLength(2);
    expect(dd.currentVersion?.pageCount).toBe(2);
    await request("acme", `/api/v1/data-room/documents/${again.documentId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
  });
});

describe("investor access through grants (folder → documents, ADR-0034)", () => {
  it("shows nothing before a grant, then the folder chain and the document after a group grant", async () => {
    const none = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: boardInvestor.cookie }),
    );
    expect(none.folders).toEqual([]);
    expect(none.documents).toEqual([]);
    expect((await detail(boardInvestor, deckId)).status).toBe(404);
    const tree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const financials = tree.folders.find((f) => f.id === financialsId);
    const grant = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "group", id: boardGroupId },
        resource: { kind: "folder", id: financialsId, path: financials?.path },
        capabilities: ["view", "download"],
      }),
    });
    expect(grant.status).toBe(200);
    const mine = await waitFor(async () => {
      const t = await json<Tree>(
        await request("acme", "/api/v1/data-room/tree", { cookie: boardInvestor.cookie }),
      );
      return t.documents.some((d) => d.id === deckId) ? t : undefined;
    });
    expect(mine.folders.map((f) => f.name).sort()).toEqual([
      "Financials",
      "Forecast",
      "Historicals",
    ]);
    expect(mine.documents.find((d) => d.id === deckId)?.access).toMatchObject({
      allowed: true,
      capabilities: ["view", "download"],
    });
    const d = await json<Detail>(await detail(boardInvestor, deckId));
    expect(d.versions).toHaveLength(1); // investors see the current version only
    // protection.download is off by default → viewable but no download
    expect(d.availability).toEqual({ viewable: true, download: null, reason: "ready" });
    const page = await request("acme", `/api/v1/data-room/documents/${deckId}/pages/1`, {
      cookie: boardInvestor.cookie,
    });
    expect(page.status).toBe(200);
    const dl = await request("acme", `/api/v1/data-room/documents/${deckId}/download`, {
      cookie: boardInvestor.cookie,
    });
    expect(dl.status).toBe(403);
    // the other investor still sees nothing
    expect((await detail(investor, deckId)).status).toBe(404);
    expect(
      (
        await request("acme", `/api/v1/data-room/documents/${deckId}/pages/1`, {
          cookie: investor.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("protection.download turns the investor's download into a watermarked PDF, never the original", async () => {
    const patched = await request("acme", `/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ protection: { download: true } }),
    });
    expect(patched.status).toBe(200);
    const d = await json<Detail>(await detail(boardInvestor, deckId));
    expect(d.availability.download).toBe("watermarked");
    const dl = await request(
      "acme",
      `/api/v1/data-room/documents/${deckId}/download?variant=original`,
      { cookie: boardInvestor.cookie },
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("watermarked.pdf");
    const text = await running.container.renderer.extractText(
      new Uint8Array(await dl.arrayBuffer()),
      "pdf",
    );
    expect(text[0]).toContain("board@investor.test");
  });

  it("an exclude on the document shadows the folder grant; a folder move keeps the grant working", async () => {
    const exclude = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "membership", id: boardInvestor.membershipId },
        resource: { kind: "document", id: deckId },
        capabilities: ["view"],
        effect: "exclude",
      }),
    });
    expect(exclude.status).toBe(200);
    await waitFor(async () =>
      (await detail(boardInvestor, deckId)).status === 404 ? true : undefined,
    );
    const t = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: boardInvestor.cookie }),
    );
    expect(t.documents.some((d) => d.id === deckId)).toBe(false);
    expect(t.folders.some((f) => f.id === financialsId)).toBe(true);
    const { grants } = await json<{ grants: { id: string; effect: string }[] }>(
      await request("acme", `/api/v1/access/grants?resourceKind=document&resourceId=${deckId}`, {
        cookie: owner.cookie,
      }),
    );
    const ex = grants.find((g) => g.effect === "exclude");
    expect(ex).toBeDefined();
    await request("acme", `/api/v1/access/grants/${ex?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    await waitFor(async () =>
      (await detail(boardInvestor, deckId)).status === 200 ? true : undefined,
    );

    // Move Financials under Overview: paths rewritten for the subtree, documents and the grant.
    const tree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const overview = tree.folders.find((f) => f.name === "Overview");
    const moved = await request("acme", `/api/v1/data-room/folders/${financialsId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: overview?.id }),
    });
    expect(moved.status).toBe(200);
    const after = await json<Tree>(moved);
    const fin = after.folders.find((f) => f.id === financialsId);
    expect(fin?.path.startsWith(`${overview?.path}.`)).toBe(true);
    expect(fin?.index).toBe("1.3");
    const rows = await running.container.db.pool.query<{ resource_path: string }>(
      `SELECT resource_path::text FROM core.access_grant WHERE workspace_id = $1 AND resource_id = $2`,
      [acmeId, financialsId],
    );
    expect(rows.rows[0]?.resource_path).toBe(fin?.path);
    const still = await waitFor(async () => {
      const x = await json<Tree>(
        await request("acme", "/api/v1/data-room/tree", { cookie: boardInvestor.cookie }),
      );
      return x.documents.some((d) => d.id === deckId) &&
        x.folders.some((f) => f.id === overview?.id)
        ? x
        : undefined;
    });
    expect(still.folders.find((f) => f.id === overview?.id)?.passthrough).toBe(true);
    // document_list hydration on the content page runs as the viewer
    const hydrated = await running.container.registry.blockHydrators
      .get("document_list")
      ?.hydrator.hydrate(
        { folderId: financialsId, documentIds: [] },
        {
          tenant: {
            workspaceId: acmeId,
            actorKind: "external",
            membershipId: boardInvestor.membershipId,
          },
          viewer: {
            kind: "external",
            membershipId: boardInvestor.membershipId,
            groupIds: [boardGroupId],
          },
          facts: {},
        },
      );
    expect((hydrated as { documents: { id: string }[] }).documents.map((d) => d.id)).toEqual([
      deckId,
    ]);
  });
});

describe("legal hold, recycle bin, purge", () => {
  it("a held document cannot be binned, cleared it can; restore and purge follow", async () => {
    const hold = await request("acme", `/api/v1/data-room/documents/${deckId}/legal-hold`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ hold: true, reason: "Litigation hold 2026-09" }),
    });
    expect(hold.status).toBe(200);
    expect((await json<Detail>(hold)).document.legalHold).toBe(true);
    const noReason = await request("acme", `/api/v1/data-room/documents/${deckId}/legal-hold`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ hold: true }),
    });
    expect(noReason.status).toBe(400);
    const editorHold = await request("acme", `/api/v1/data-room/documents/${deckId}/legal-hold`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ hold: false }),
    });
    expect(editorHold.status).toBe(403);
    const del = await request("acme", `/api/v1/data-room/documents/${deckId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(409);
    const folderDel = await request("acme", `/api/v1/data-room/folders/${financialsId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(folderDel.status).toBe(409);
    // the trigger refuses even a raw delete
    await expect(
      running.container.db.pool.query("DELETE FROM dataroom.document WHERE id = $1", [deckId]),
    ).rejects.toThrow(/legal hold/u);
    const clear = await request("acme", `/api/v1/data-room/documents/${deckId}/legal-hold`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ hold: false }),
    });
    expect(clear.status).toBe(200);
    const del2 = await request("acme", `/api/v1/data-room/documents/${deckId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del2.status).toBe(200);
    expect((await detail(owner, deckId)).status).toBe(404);
    const trash = await json<{ documents: { id: string; purgeAfter: string }[] }>(
      await request("acme", "/api/v1/data-room/trash", { cookie: editor.cookie }),
    );
    expect(trash.documents.map((d) => d.id)).toContain(deckId);
    const restored = await request("acme", `/api/v1/data-room/documents/${deckId}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restored.status).toBe(200);
    expect((await detail(owner, deckId)).status).toBe(200);
  });

  it("deleting a folder bins its subtree; the purge job removes what is past purge_after and orphaned blobs two-phase", async () => {
    const tree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const overview = tree.folders.find((f) => f.name === "Overview");
    const del = await request("acme", `/api/v1/data-room/folders/${overview?.id}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(200);
    expect((await json<{ deleted: number }>(del)).deleted).toBeGreaterThanOrEqual(7);
    const after = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    expect(after.folders.some((f) => f.id === financialsId)).toBe(false);
    expect(after.documents.some((d) => d.id === deckId)).toBe(false);
    await running.container.db.pool.query(
      `UPDATE dataroom.document SET purge_after = now() - interval '1 minute' WHERE workspace_id = $1 AND deleted_at IS NOT NULL`,
      [acmeId],
    );
    await running.container.db.pool.query(
      `UPDATE dataroom.folder SET purge_after = now() - interval '1 minute' WHERE workspace_id = $1 AND deleted_at IS NOT NULL`,
      [acmeId],
    );
    const maintenance = createMaintenanceService(running.container.moduleServices);
    const first = await maintenance.purge(acmeId);
    expect(first.documents).toBe(2);
    expect(first.folders).toBeGreaterThanOrEqual(5);
    expect(first.blobs).toBe(0); // marked only
    const second = await maintenance.purge(acmeId);
    expect(second.blobs).toBe(2);
    const blobs = await running.container.db.pool.query(
      `SELECT count(*)::int AS n FROM dataroom.blob WHERE workspace_id = $1`,
      [acmeId],
    );
    expect(blobs.rows[0]?.n).toBe(0);
    const remaining = await running.container.storage.list({ prefix: `ws/${acmeId}/` });
    expect(remaining.objects).toEqual([]);
    const reconciled = await maintenance.reconcile(acmeId);
    expect(reconciled).toMatchObject({ orphanObjects: 0, missingObjects: 0 });
  });

  /*
   * Regression (found while adding the E2.3 certificate key area). `ws/<workspace>/` is the whole
   * tenant's storage prefix, not the data room's, and the sweep used to delete every key
   * `parseObjectKey` merely *recognised*. E1.7's logos live under `branding/` and are in none of
   * this module's tables, so each one was deleted on the first weekly run more than a day after it
   * was uploaded — silently, a week later, with nothing in the data room to point at. Recognising
   * a key is not owning it.
   */
  it("leaves another epic's objects alone, however old and however well it knows the key shape", async () => {
    const logo = brandingLogoKey(acmeId, createHash("sha256").update("logo").digest("hex"));
    const certificate = `ws/${acmeId}/certificates/${randomUUID()}/certificate.json`;
    const foreign = `ws/${acmeId}/something-a-later-epic-invents/x`;
    const day = 48 * 3600_000;
    for (const key of [logo, certificate, foreign]) {
      await running.container.storage.put(key, Buffer.from("owned by someone else"), {
        contentType: "application/octet-stream",
      });
    }
    // `moduleServices` is a lazy Proxy (`moduleServicesOf`), so spreading it yields nothing —
    // every property has to be read through its `get` trap. Wrap it instead of copying it.
    const later = new Date(Date.now() + day);
    const maintenance = createMaintenanceService(
      new Proxy(running.container.moduleServices, {
        // Far enough past the 24 h grace that an unowned key would certainly be swept.
        get: (target, prop, receiver) =>
          prop === "now" ? () => later : Reflect.get(target, prop, receiver),
      }),
    );
    const summary = await maintenance.reconcile(acmeId);
    expect(summary.orphanObjects).toBe(0);
    for (const key of [logo, certificate, foreign]) {
      expect(await running.container.storage.head(key)).toBeDefined();
    }
  });
});

describe("tenancy and audit", () => {
  it("answers 404 for another tenant's ids on every id-bearing route", async () => {
    const pdf = await makePdf(1, "Globex");
    // seed a globex document to have a real id
    const start = await request("globex", "/api/v1/data-room/tree", { cookie: globexOwner.cookie });
    const gtree = await json<Tree>(start);
    const up = await request("globex", "/api/v1/data-room/uploads", {
      method: "POST",
      cookie: globexOwner.cookie,
      body: JSON.stringify({
        fileName: "g.pdf",
        size: pdf.byteLength,
        contentType: "application/pdf",
        folderId: gtree.rootId,
      }),
    });
    expect(up.status).toBe(201);
    const upId = (await json<{ upload: { id: string } }>(up)).upload.id;
    const acmeTree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const someFolder = acmeTree.folders[0]?.id ?? acmeTree.rootId;
    for (const [method, path] of [
      ["GET", `/api/v1/data-room/documents/${deckId}`],
      ["PATCH", `/api/v1/data-room/folders/${someFolder}`],
      ["DELETE", `/api/v1/data-room/folders/${someFolder}`],
      ["GET", `/api/v1/data-room/documents/${deckId}/pages/1`],
      ["GET", `/api/v1/data-room/documents/${deckId}/download`],
    ] as const) {
      const res = await request(
        "globex",
        path,
        method === "GET"
          ? { cookie: globexOwner.cookie }
          : { method, cookie: globexOwner.cookie, body: JSON.stringify({ name: "x" }) },
      );
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const foreign = await request("acme", `/api/v1/data-room/uploads/${upId}`, {
      cookie: owner.cookie,
    });
    expect(foreign.status).toBe(404);
  });

  it("wrote the audit trail and outbox events", async () => {
    const audit = await running.container.db.pool.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit.event WHERE workspace_id = $1 AND (resource_kind IN ('document','folder','upload') OR action LIKE 'data_room.%') GROUP BY action ORDER BY action`,
      [acmeId],
    );
    const actions = Object.fromEntries(audit.rows.map((r) => [r.action, r.n]));
    for (const a of [
      "folder.template_applied",
      "folder.updated",
      "folder.deleted",
      "document.created",
      "document.version_uploaded",
      "document.ingested",
      "document.sanitized",
      "document.viewed",
      "document.downloaded",
      "document.updated",
      "document.legal_hold_set",
      "document.legal_hold_cleared",
      "document.deleted",
      "document.restored",
      "document.purged",
      "data_room.settings_changed",
    ]) {
      expect(actions[a] ?? 0, a).toBeGreaterThanOrEqual(1);
    }
    const outbox = await running.container.db.pool.query<{ topic: string; n: number }>(
      `SELECT topic, count(*)::int AS n FROM core.outbox WHERE workspace_id = $1 AND topic LIKE 'document.%' GROUP BY topic`,
      [acmeId],
    );
    const topics = Object.fromEntries(outbox.rows.map((r) => [r.topic, r.n]));
    expect(topics["document.ingested"]).toBeGreaterThanOrEqual(3);
    expect(topics["document.viewed"]).toBe(1);
    expect(topics["document.downloaded"]).toBeGreaterThanOrEqual(3);
  });
});

describe("sharing one document never shares its folder (review E2.10 R1-A1)", () => {
  it("refuses the folder path on a document rule, scopes the grant to the document, and heals old rows", async () => {
    // A folder of its own, so nothing else in this file can open it for the investor.
    const created = await request("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId, name: "Side letters" }),
    });
    expect(created.status).toBe(201);
    const folder = (await json<Tree>(created)).folders.find((f) => f.name === "Side letters");
    if (folder === undefined) throw new Error("folder not created");
    const a = await uploadViaTus(
      editor,
      { folderId: folder.id },
      "Letter A.pdf",
      "application/pdf",
      await makePdf(1, "Side letter A"),
    );
    const b = await uploadViaTus(
      editor,
      { folderId: folder.id },
      "Letter B.pdf",
      "application/pdf",
      await makePdf(1, "Side letter B"),
    );
    await ingested(owner, a.documentId);
    await ingested(owner, b.documentId);
    const grantA = (resource: Record<string, unknown>) =>
      request("acme", "/api/v1/access/grants", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({
          subject: { kind: "membership", id: investor.membershipId },
          resource,
          capabilities: ["view"],
        }),
      });

    // Exactly what the Share sheet used to post for a document: its folder's path as the scope.
    const legacy = await grantA({ kind: "document", id: a.documentId, path: folder.path });
    expect(legacy.status).toBe(400);
    const refusal = await json<{ error: { code: string; details?: { reason?: string } } }>(legacy);
    expect(JSON.stringify(refusal)).toContain("resource_path_mismatch");

    const ok = await grantA({ kind: "document", id: a.documentId });
    expect(ok.status).toBe(200);
    const stored = async () =>
      (
        await running.container.db.pool.query<{ path: string | null }>(
          `SELECT resource_path::text AS path FROM core.access_grant
           WHERE workspace_id = $1 AND resource_id = $2 AND revoked_at IS NULL`,
          [acmeId, a.documentId],
        )
      ).rows.map((r) => r.path);
    expect(await stored()).toEqual([null]);
    await waitFor(async () =>
      (await detail(investor, a.documentId)).status === 200 ? true : undefined,
    );
    // The sibling is not shared, and neither is the folder.
    expect((await detail(investor, b.documentId)).status).toBe(404);
    const tree = await json<Tree>(
      await request("acme", "/api/v1/data-room/tree", { cookie: investor.cookie }),
    );
    expect(tree.documents.map((d) => d.id)).toEqual([a.documentId]);
    expect(tree.folders.find((f) => f.id === folder.id)?.access.allowed ?? false).toBe(false);

    // A row written before the fix (the trigger is what stops one being written now): switch the
    // backstop off, file the grant under the folder path, rebuild — the sibling opens, which is
    // the over-grant the review found.
    const pool = running.container.db.pool;
    await pool.query("ALTER TABLE core.access_grant DISABLE TRIGGER dataroom_canonical_rule_path");
    try {
      await pool.query(
        `UPDATE core.access_grant SET resource_path = $3::ltree
         WHERE workspace_id = $1 AND resource_id = $2 AND revoked_at IS NULL`,
        [acmeId, a.documentId, folder.path],
      );
    } finally {
      await pool.query("ALTER TABLE core.access_grant ENABLE TRIGGER dataroom_canonical_rule_path");
    }
    await running.container.authz.rebuild(acmeId);
    expect((await detail(investor, b.documentId)).status).toBe(200);

    // The migration's remediation clears it and drops the materialised rows at once: the sibling
    // is shut on the very next request, without waiting for a rebuild.
    const healed = await pool.query<{ n: number }>(
      "SELECT dataroom.clear_overbroad_rule_paths() AS n",
    );
    expect(healed.rows[0]?.n).toBe(1);
    expect(await stored()).toEqual([null]);
    expect((await detail(investor, b.documentId)).status).toBe(404);
    expect((await detail(investor, a.documentId)).status).toBe(200);

    // And with the trigger on, no writer can put a path back on a document rule, nor file a
    // non-folder rule inside the data room's namespace.
    await pool.query(
      `UPDATE core.access_grant SET resource_path = $3::ltree
       WHERE workspace_id = $1 AND resource_id = $2 AND revoked_at IS NULL`,
      [acmeId, a.documentId, folder.path],
    );
    expect(await stored()).toEqual([null]);
    const post = await pool.query<{ path: string | null }>(
      `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind,
         resource_id, resource_path, capability)
       VALUES ($1, 'membership', $2, 'post', $3, 'r', 'view') RETURNING resource_path::text AS path`,
      [acmeId, investor.membershipId, randomUUID()],
    );
    expect(post.rows[0]?.path).toBeNull();
    await pool.query(
      "DELETE FROM core.access_grant WHERE workspace_id = $1 AND resource_kind = 'post'",
      [acmeId],
    );
  });
});

describe("an invitation's folder grant follows a folder moved before acceptance (E3.2)", () => {
  it("grants the folder at the path it has when the invitation is accepted", async () => {
    const folderNamed = async (name: string) => {
      const res = await request("acme", "/api/v1/data-room/folders", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ parentId: rootId, name }),
      });
      expect(res.status).toBe(201);
      const f = (await json<Tree>(res)).folders.find((x) => x.name === name);
      if (f === undefined) throw new Error(`folder ${name} not created`);
      return f;
    };
    const pledges = await folderNamed("E32 Pledges");
    const archive = await folderNamed("E32 Archive");
    const invited = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        invites: [{ email: "e32-late@investor.test" }],
        grants: [{ resource: { kind: "folder", id: pledges.id }, capabilities: ["view"] }],
      }),
    });
    expect(invited.status, await invited.clone().text()).toBe(200);
    // The stored promise carries the path the folder had when the invitation was written …
    const promised = await running.container.db.pool.query<{ path: string }>(
      `SELECT grants->0->'resource'->>'path' AS path FROM core.invite
        WHERE workspace_id = $1 AND email = 'e32-late@investor.test'`,
      [acmeId],
    );
    expect(promised.rows[0]?.path).toBe(pledges.path);
    // … and the folder moves before the invitation is accepted.
    const moved = await request("acme", `/api/v1/data-room/folders/${pledges.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: archive.id }),
    });
    expect(moved.status).toBe(200);
    const now = (await json<Tree>(moved)).folders.find((f) => f.id === pledges.id);
    expect(now?.path.startsWith(`${archive.path}.`)).toBe(true);

    const late = await signIn("acme", "e32-late@investor.test");
    const rows = await running.container.db.pool.query<{ resource_path: string }>(
      `SELECT resource_path::text FROM core.access_grant
        WHERE workspace_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
      [acmeId, late.membershipId],
    );
    expect(rows.rows.map((r) => r.resource_path)).toEqual([now?.path]);
    const tree = await waitFor(async () => {
      const t = await json<Tree>(
        await request("acme", "/api/v1/data-room/tree", { cookie: late.cookie }),
      );
      return t.folders.some((f) => f.id === pledges.id) ? t : undefined;
    });
    expect(tree.folders.find((f) => f.id === pledges.id)?.access.allowed).toBe(true);
  });
});

describe("a folder's rules keep covering its subtree through the trash (E3.2 L-2)", () => {
  it("an import-time re-derive keeps a binned folder's rule path, and a restore repairs a lost one", async () => {
    const folderNamed = async (parentId: string, name: string) => {
      const res = await request("acme", "/api/v1/data-room/folders", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ parentId, name }),
      });
      expect(res.status).toBe(201);
      const f = (await json<Tree>(res)).folders.find((x) => x.name === name);
      if (f === undefined) throw new Error(`folder ${name} not created`);
      return f;
    };
    const parent = await folderNamed(rootId, "L2 Parent");
    const child = await folderNamed(parent.id, "L2 Child");
    const grant = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "membership", id: investor.membershipId },
        resource: { kind: "folder", id: child.id },
        capabilities: ["view"],
      }),
    });
    expect(grant.status, await grant.clone().text()).toBe(200);
    const grantPath = async () =>
      (
        await running.container.db.pool.query<{ path: string | null }>(
          `SELECT resource_path::text AS path FROM core.access_grant
            WHERE workspace_id = $1 AND resource_id = $2 AND revoked_at IS NULL`,
          [acmeId, child.id],
        )
      ).rows.map((r) => r.path);
    expect(await grantPath()).toEqual([child.path]);

    const binned = await request("acme", `/api/v1/data-room/folders/${parent.id}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(binned.status).toBe(200);
    // What a workspace import runs: a folder in the trash still exists, so its rule keeps the
    // path (it used to be nulled like a folder that is gone, i.e. a rule on the node alone).
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) => rederiveRulePaths(tx, ctx));
    expect(await grantPath()).toEqual([child.path]);

    // A rule that lost its path anyway (an import by an older build) is repaired by the restore.
    await running.container.db.pool.query(
      `UPDATE core.access_grant SET resource_path = NULL WHERE workspace_id = $1 AND resource_id = $2`,
      [acmeId, child.id],
    );
    const restored = await request("acme", `/api/v1/data-room/folders/${parent.id}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restored.status).toBe(200);
    const after = (await json<Tree>(restored)).folders.find((f) => f.id === child.id);
    expect(after?.path).toBe(child.path);
    expect(await grantPath()).toEqual([child.path]);
  });
});
