import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { ForensicTimeoutError } from "@fundroom/forensic";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { dataRoomDsar } from "@fundroom/module-data-room";
import { replaceProcessDetector } from "@fundroom/module-data-room/testing";
import * as OTPAuth from "otpauth";
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Forensic (invisible) watermarking end to end (E3.13, ADR-0061 §1): two investors are served
 * the same forensic page, investor A's served bytes are re-encoded as JPEG and traced back to A
 * (B: no match); view-as carries the acting staff member's own mark; the share-link `forceWatermark` fix; downloads carry a
 * trace; the detect/recipients permission walk, rate limit and errors; marks survive the
 * member's erasure and go with a purge; and the delivery path on a one-connection pool.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: Record<string, string>;

// sharp lives with the renderer adapter; borrow it to re-encode a served page like a leaker would.
interface SharpChain {
  jpeg(o: { quality: number }): SharpChain;
  png(): SharpChain;
  greyscale(): SharpChain;
  raw(): SharpChain;
  extract(o: { left: number; top: number; width: number; height: number }): SharpChain;
  resize(o: { width: number; height?: number; fit?: "fill" }): SharpChain;
  metadata(): Promise<{ width?: number }>;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(import.meta.resolve("@fundroom/render-pdfium"))("sharp") as (
  input: Uint8Array,
  options?: { raw: { width: number; height: number; channels: 1 } },
) => SharpChain;

interface Actor {
  cookie: string;
  membershipId: string;
  email: string;
}

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string; server?: RunningServer } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return (init.server ?? running).app.request(`http://${slug}.${CANON}${path}`, {
    ...init,
    headers,
  });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(text, params);
  return r.rows as T[];
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
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "", email };
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
  return withSetCookies(cookie, confirm);
}

type Role = "owner" | "admin" | "legal" | "editor" | "viewer" | "finance" | "investor";

async function member(
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: Role,
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn("acme", email);
  if (kind === "staff") actor.cookie = await stepUpToMfa("acme", actor.cookie);
  return actor;
}

/** Marks every live session of `actor` as freshly authenticated (the 10-minute `fresh` check). */
async function markFresh(actor: Actor): Promise<void> {
  await sql(
    `UPDATE core.session SET auth_time = now()
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid)
        AND revoked_at IS NULL`,
    [actor.membershipId],
  );
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: timed out (pool deadlock?)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A text-and-table page with enough structure to register a photo or screenshot onto. */
async function makePdf(pages: number, marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${marker} — confidential page ${p}`, { x: 50, y: 730, size: 22, font: bold });
    for (let i = 0; i < 26; i++) {
      page.drawText(
        `${i + 1}. Revenue grew ${(i * 7) % 31}% in Q${(i % 4) + 1}; burn ${(i * 13) % 97}k; runway ${12 + (i % 9)} months.`,
        { x: 50, y: 690 - i * 18, size: 11, font },
      );
    }
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 4; c++) {
        page.drawRectangle({
          x: 50 + c * 125,
          y: 140 - r * 18,
          width: 125,
          height: 18,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 0.8,
          color: (r + c) % 2 === 0 ? rgb(0.92, 0.94, 0.98) : rgb(1, 1, 1),
        });
        page.drawText(`${r * 4 + c}`, { x: 56 + c * 125, y: 145 - r * 18, size: 9, font });
      }
    }
  }
  return doc.save();
}

async function upload(
  actor: Actor,
  folderId: string,
  fileName: string,
  bytes: Uint8Array,
  contentType = "application/pdf",
): Promise<{ documentId: string; versionId: string }> {
  const start = await request("acme", "/api/v1/data-room/uploads", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({
      fileName,
      size: bytes.byteLength,
      contentType,
      folderId,
    }),
  });
  expect(start.status, await start.clone().text()).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
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
  const patch = await request("acme", `${endpoint}/${started.upload.id}`, {
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
  const complete = await request(
    "acme",
    `/api/v1/data-room/uploads/${started.upload.id}/complete`,
    { method: "POST", cookie: actor.cookie, body: JSON.stringify({}) },
  );
  expect(complete.status, await complete.clone().text()).toBe(200);
  const body = await json<{ document: { id: string }; version: { id: string } }>(complete);
  await waitFor(async () => {
    const res = await request("acme", `/api/v1/data-room/documents/${body.document.id}`, {
      cookie: actor.cookie,
    });
    if (res.status !== 200) return undefined;
    const d = await json<{ currentVersion: { renderStatus: string } | null }>(res);
    return d.currentVersion?.renderStatus === "ready" ? true : undefined;
  });
  return { documentId: body.document.id, versionId: body.version.id };
}

async function protect(id: string, protection: Record<string, boolean>): Promise<void> {
  const res = await request("acme", `/api/v1/data-room/documents/${id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ protection }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function page(actor: Actor, id: string, n = 1, server?: RunningServer) {
  const res = await request("acme", `/api/v1/data-room/documents/${id}/pages/${n}`, {
    cookie: actor.cookie,
    ...(server ? { server } : {}),
  });
  expect(res.status, `page as ${actor.email}: ${res.status}`).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function detect(
  actor: Actor,
  id: string,
  image: Uint8Array,
  fields: { page?: string; versionId?: string; type?: string } = {},
  server?: RunningServer,
) {
  const form = new FormData();
  form.set(
    "image",
    new Blob([image as unknown as ArrayBuffer], { type: fields.type ?? "image/jpeg" }),
    "leak.jpg",
  );
  form.set("page", fields.page ?? "1");
  if (fields.versionId !== undefined) form.set("versionId", fields.versionId);
  return request("acme", `/api/v1/data-room/documents/${id}/forensic/detect`, {
    method: "POST",
    cookie: actor.cookie,
    body: form,
    ...(server ? { server } : {}),
  });
}

interface Detection {
  documentId: string;
  versionId: string;
  page: number;
  alignment: { scale: number; dx: number; dy: number; quality: number };
  candidatesTested: number;
  keysMissing: number;
  results: { membershipId: string; email: string | null; z: number; verdict: string }[];
  noMatchCount: number;
}

interface Recipients {
  items: {
    membershipId: string;
    displayName: string;
    email: string | null;
    versionId: string;
    versionNo: number;
    trace: string;
    firstServedAt: string;
    lastServedAt: string;
  }[];
  nextCursor: string | null;
}

async function marksOf(membershipId: string, versionId?: string) {
  return sql<{ id: string; token: string; key_id: string; version_id: string }>(
    `SELECT id, encode(token, 'hex') AS token, key_id, version_id::text
       FROM dataroom.forensic_mark WHERE membership_id = $1::uuid
        AND ($2::uuid IS NULL OR version_id = $2::uuid)`,
    [membershipId, versionId ?? null],
  );
}

/** JPEG re-encode at `quality` (what a leaker's screenshot tool or chat app does). */
async function asJpeg(bytes: Uint8Array, quality = 80): Promise<Uint8Array> {
  return new Uint8Array(await sharp(bytes).jpeg({ quality }).toBuffer());
}

let acmeId: string;
let owner: Actor;
let admin: Actor;
let legal: Actor;
let editor: Actor;
let viewer: Actor;
let finance: Actor;
let ada: Actor;
let bob: Actor;
let carol: Actor;
let rootId: string;
let folderId: string;
let folderPath: string;
let linkFolderId: string;
let linkFolderPath: string;
let docId: string;
let versionId: string;
let adaPage: Uint8Array;
let bobPage: Uint8Array;
let viewAsPage: Uint8Array;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = {
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
  };
  running = await startServer({
    config: loadConfig({ env }),
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member(acmeId, "owner@example.com", "staff", "owner");
  admin = await member(acmeId, "admin@example.com", "staff", "admin");
  legal = await member(acmeId, "legal@example.com", "staff", "legal");
  editor = await member(acmeId, "editor@example.com", "staff", "editor");
  viewer = await member(acmeId, "viewer@example.com", "staff", "viewer");
  finance = await member(acmeId, "finance@example.com", "staff", "finance");
  ada = await member(acmeId, "ada@investor.test", "external", "investor");
  bob = await member(acmeId, "bob@investor.test", "external", "investor");
  carol = await member(acmeId, "carol@investor.test", "external", "investor");

  // The test install scans with the noop driver: serve `skipped` files.
  const unscanned = await request("acme", "/api/v1/data-room/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ allowUnscanned: true }),
  });
  expect(unscanned.status, await unscanned.clone().text()).toBe(200);
  const tree = await json<{ rootId: string }>(
    await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
  );
  rootId = tree.rootId;
  const mkFolder = async (name: string) => {
    const res = await request("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ parentId: rootId, name }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const t = await json<{ folders: { id: string; name: string; path: string }[] }>(res);
    const f = t.folders.find((x) => x.name === name);
    if (f === undefined) throw new Error("no folder");
    return f;
  };
  const f = await mkFolder("Forensic");
  folderId = f.id;
  folderPath = f.path;
  const lf = await mkFolder("Linked");
  linkFolderId = lf.id;
  linkFolderPath = lf.path;
  for (const who of [ada, bob, carol]) {
    for (const [id, path] of [
      [folderId, folderPath],
      [linkFolderId, linkFolderPath],
    ] as const) {
      const grant = await request("acme", "/api/v1/access/grants", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({
          subject: { kind: "membership", id: who.membershipId },
          resource: { kind: "folder", id, path },
          capabilities: ["view", "download"],
        }),
      });
      expect(grant.status, await grant.clone().text()).toBe(200);
    }
  }
  const up = await upload(owner, folderId, "board-deck.pdf", await makePdf(2, "Acme board"));
  docId = up.documentId;
  versionId = up.versionId;
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("protection and settings accept the forensic fields", () => {
  it("PATCH /documents/{id} sets protection.forensic (audited as a protection change)", async () => {
    await protect(docId, { forensic: true, watermark: true, download: true });
    const d = await json<{ document: { protection: Record<string, boolean> } }>(
      await request("acme", `/api/v1/data-room/documents/${docId}`, { cookie: owner.cookie }),
    );
    expect(d.document.protection).toEqual({
      download: true,
      watermark: true,
      print: false,
      forensic: true,
    });
    const [ev] = await sql<{ meta: { protection: string[] } }>(
      `SELECT meta FROM audit.event WHERE action = 'document.updated' AND resource_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [docId],
    );
    expect(ev?.meta.protection).toContain("forensic");
  });

  it("forensicByDefault applies to new uploads", async () => {
    await markFresh(owner);
    const on = await request("acme", "/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ forensicByDefault: true }),
    });
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await json<{ forensicByDefault: boolean }>(on)).forensicByDefault).toBe(true);
    const up = await upload(owner, folderId, "default-on.pdf", await makePdf(1, "Default on"));
    const [row] = await sql<{ protection: Record<string, boolean> }>(
      "SELECT protection FROM dataroom.document WHERE id = $1",
      [up.documentId],
    );
    expect(row?.protection["forensic"]).toBe(true);
    const off = await request("acme", "/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ forensicByDefault: false }),
    });
    expect(off.status).toBe(200);
    const up2 = await upload(owner, folderId, "default-off.pdf", await makePdf(1, "Default off"));
    const [row2] = await sql<{ protection: Record<string, boolean> }>(
      "SELECT protection FROM dataroom.document WHERE id = $1",
      [up2.documentId],
    );
    expect(row2?.protection["forensic"]).toBe(false);
  });
});

describe("serving forensic pages", () => {
  it("two investors get different page bytes; each gets one mark row per version", async () => {
    adaPage = await page(ada, docId);
    bobPage = await page(bob, docId);
    expect(Buffer.from(adaPage).equals(Buffer.from(bobPage))).toBe(false);
    // Re-reads are stable (cache) and do not mint a second mark.
    expect(Buffer.from(await page(ada, docId)).equals(Buffer.from(adaPage))).toBe(true);
    await page(ada, docId, 2);
    const a = await marksOf(ada.membershipId, versionId);
    const b = await marksOf(bob.membershipId, versionId);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.token).not.toBe(b[0]?.token);
    expect(a[0]?.key_id).toBeTruthy();
  });

  it("traces investor A's served page, re-encoded as JPEG, to A — and not to B", async () => {
    const leak = await asJpeg(adaPage, 80);
    await markFresh(owner);
    const res = await detect(owner, docId, leak);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<Detection>(res);
    expect(body).toMatchObject({ documentId: docId, versionId, page: 1, keysMissing: 0 });
    expect(body.candidatesTested).toBe(2);
    const adaHit = body.results.find((r) => r.membershipId === ada.membershipId);
    expect(adaHit?.verdict).toBe("match");
    expect(adaHit?.email).toBe("ada@investor.test");
    expect(body.results.find((r) => r.membershipId === bob.membershipId)).toBeUndefined();
    expect(body.noMatchCount).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/token|seed/u);
    const [ev] = await sql<{ actor_membership_id: string; meta: Record<string, unknown> }>(
      `SELECT actor_membership_id, meta FROM audit.event
        WHERE action = 'data_room.forensic_detection' AND resource_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [docId],
    );
    expect(ev?.actor_membership_id).toBe(owner.membershipId);
    expect(ev?.meta).toEqual({
      versionId,
      page: 1,
      candidatesTested: 2,
      matches: [ada.membershipId],
      inconclusive: 0,
    });
  });

  it("traces B's page to B (screenshot-like rescale, explicit versionId)", async () => {
    const meta = await sharp(bobPage).metadata();
    const shot = new Uint8Array(
      await sharp(bobPage)
        .resize({ width: Math.round((meta.width ?? 1600) * 0.73) })
        .png()
        .toBuffer(),
    );
    const res = await detect(owner, docId, shot, { versionId, type: "image/png" });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<Detection>(res);
    expect(body.results.map((r) => [r.membershipId, r.verdict])).toEqual([
      [bob.membershipId, "match"],
    ]);
  });

  it("view-as marks with the acting staff member's own mark — never the investor's, never none", async () => {
    expect(await marksOf(carol.membershipId)).toHaveLength(0);
    expect(await marksOf(owner.membershipId)).toHaveLength(0);
    await markFresh(owner);
    const start = await request("acme", `/api/v1/access/people/${carol.membershipId}/view-as`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "support ticket 7" }),
    });
    expect(start.status, await start.clone().text()).toBe(200);
    try {
      const seen = await page(owner, docId);
      expect(seen.byteLength).toBeGreaterThan(0);
      expect(await marksOf(carol.membershipId)).toHaveLength(0);
      expect(await marksOf(owner.membershipId, versionId)).toHaveLength(1);
      viewAsPage = seen;
    } finally {
      const end = await request("acme", "/api/v1/me/view-as", {
        method: "DELETE",
        cookie: owner.cookie,
      });
      expect(end.status).toBeLessThan(300);
    }
    // The impersonated page traces to the staff member, not to Carol.
    await markFresh(owner);
    const traced = await detect(owner, docId, await asJpeg(viewAsPage, 80));
    expect(traced.status, await traced.clone().text()).toBe(200);
    const hits = (await json<Detection>(traced)).results as (Detection["results"][number] & {
      servedUnderViewAs: boolean;
      viewAsMembershipId: string | null;
    })[];
    expect(hits.map((r) => [r.membershipId, r.verdict])).toEqual([[owner.membershipId, "match"]]);
    // FIX2 D10: the result says this copy was served while the owner viewed as Carol.
    expect(hits[0]).toMatchObject({
      servedUnderViewAs: true,
      viewAsMembershipId: carol.membershipId,
    });
    const rec = await json<{
      items: {
        membershipId: string;
        servedUnderViewAs: boolean;
        viewAsMembershipId: string | null;
      }[];
    }>(
      await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
        cookie: owner.cookie,
      }),
    );
    expect(rec.items.find((i) => i.membershipId === owner.membershipId)).toMatchObject({
      servedUnderViewAs: true,
      viewAsMembershipId: carol.membershipId,
    });
    expect(rec.items.find((i) => i.membershipId === ada.membershipId)).toMatchObject({
      servedUnderViewAs: false,
      viewAsMembershipId: null,
    });
    // Control: Carol herself is marked on first sight.
    await page(carol, docId);
    expect(await marksOf(carol.membershipId, versionId)).toHaveLength(1);
  });

  it("a watermarked download carries a visible trace line and /SeedHostTrace; audited forensic", async () => {
    const res = await request("acme", `/api/v1/data-room/documents/${docId}/download`, {
      cookie: ada.cookie,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
    const trace = (info as { get(n: PDFName): unknown } | undefined)?.get(
      PDFName.of("SeedHostTrace"),
    );
    const traceText =
      trace instanceof PDFString
        ? trace.decodeText()
        : String((trace as { decodeText?: () => string })?.decodeText?.() ?? trace);
    const [mark] = await marksOf(ada.membershipId, versionId);
    expect(traceText).toBe(mark?.token);
    const [ev] = await sql<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE action = 'document.downloaded' AND resource_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [docId],
    );
    expect(ev?.meta).toMatchObject({ versionId, variant: "watermarked", forensic: true });
  });

  it("lists recipients (paged) with the trace code printed on their downloads", async () => {
    const all = await json<Recipients>(
      await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
        cookie: legal.cookie,
      }),
    );
    expect(all.items.map((i) => i.membershipId).sort()).toEqual(
      [ada.membershipId, bob.membershipId, carol.membershipId, owner.membershipId].sort(),
    );
    expect(all.nextCursor).toBeNull();
    const a = all.items.find((i) => i.membershipId === ada.membershipId);
    expect(a).toMatchObject({ email: "ada@investor.test", versionId, versionNo: 1 });
    const [mark] = await marksOf(ada.membershipId, versionId);
    const tokenB32 = base32(Buffer.from(mark?.token ?? "", "hex")).slice(0, 8);
    expect(a?.trace).toBe(tokenB32);
    const p1 = await json<Recipients>(
      await request(
        "acme",
        `/api/v1/data-room/documents/${docId}/forensic/recipients?limit=2&versionId=${versionId}`,
        { cookie: legal.cookie },
      ),
    );
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await json<Recipients>(
      await request(
        "acme",
        `/api/v1/data-room/documents/${docId}/forensic/recipients?limit=2&cursor=${p1.nextCursor}`,
        { cookie: legal.cookie },
      ),
    );
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((i) => i.membershipId).sort()).toEqual(
      all.items.map((i) => i.membershipId).sort(),
    );
  });
});

function base32(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[Number.parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

describe("share-link forceWatermark (pre-existing gap, fixed)", () => {
  let plainId: string;
  let visitor: Actor;
  let openVisitor: Actor;

  async function visit(token: string, email: string): Promise<Actor> {
    const since = mailer.sent.length;
    const start = await request("acme", `/api/v1/links/${token}/start`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(start.status, await start.clone().text()).toBe(200);
    const code = await awaitSignInCode(mailer, email, since);
    const verified = await request("acme", `/api/v1/links/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const body = await json<{ membership: { id: string } | null }>(verified);
    return { membershipId: body.membership?.id ?? "", cookie: cookiesOf(verified), email };
  }

  async function mint(forceWatermark: boolean, domain: string): Promise<string> {
    const res = await request("acme", "/api/v1/links", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        label: `linked ${domain}`,
        policy: { domains: [domain], emails: [], forceWatermark },
        grants: [
          {
            resource: { kind: "folder", id: linkFolderId, path: linkFolderPath },
            capabilities: ["view", "download"],
          },
        ],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await json<{ token: string }>(res)).token;
  }

  it("forces the visible watermark onto a forcing link's visitor whose document has it off", async () => {
    await markFresh(owner);
    const offering = await request("acme", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "506c", confirm: "506c", reason: "raising" }),
    });
    expect(offering.status, await offering.clone().text()).toBe(200);
    const up = await upload(owner, linkFolderId, "plain.pdf", await makePdf(1, "Plain"));
    plainId = up.documentId;
    await protect(plainId, { watermark: false, download: true, forensic: false });
    visitor = await visit(await mint(true, "forced.test"), "vic@forced.test");
    openVisitor = await visit(await mint(false, "open.test"), "olga@open.test");
    const seeIt = (who: Actor) =>
      waitFor(async () =>
        (
          await request("acme", `/api/v1/data-room/documents/${plainId}`, {
            cookie: who.cookie,
          })
        ).status === 200
          ? true
          : undefined,
      );
    await seeIt(visitor);
    await seeIt(openVisitor);

    const raw = await page(owner, plainId);
    // Controls: an investor with a plain grant, and a non-forcing link's visitor, see it clean.
    expect(Buffer.from(await page(ada, plainId)).equals(Buffer.from(raw))).toBe(true);
    expect(Buffer.from(await page(openVisitor, plainId)).equals(Buffer.from(raw))).toBe(true);
    // The forcing link's visitor gets a watermarked page...
    expect(Buffer.from(await page(visitor, plainId)).equals(Buffer.from(raw))).toBe(false);
    // ...and a watermarked download, where the document alone would hand out the original.
    const detail = await json<{ availability: { download: string | null } }>(
      await request("acme", `/api/v1/data-room/documents/${plainId}`, { cookie: visitor.cookie }),
    );
    expect(detail.availability.download).toBe("watermarked");
    const openDetail = await json<{ availability: { download: string | null } }>(
      await request("acme", `/api/v1/data-room/documents/${plainId}`, {
        cookie: openVisitor.cookie,
      }),
    );
    expect(openDetail.availability.download).toBe("original");
    const dl = await request(
      "acme",
      `/api/v1/data-room/documents/${plainId}/download?variant=original`,
      { cookie: visitor.cookie },
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("-watermarked.pdf");
    // Never forensic: a link cannot switch the invisible mark on.
    expect(await marksOf(visitor.membershipId)).toHaveLength(0);
  });
});

describe("detect: permission, freshness, rate limit, errors", () => {
  it("owner, admin and legal may; other staff roles are refused; externals get 404", async () => {
    const leak = await asJpeg(adaPage, 70);
    for (const who of [admin, legal]) {
      await markFresh(who);
      const res = await detect(who, docId, leak);
      expect(res.status, `${who.email}: ${await res.clone().text()}`).toBe(200);
      const r = await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
        cookie: who.cookie,
      });
      expect(r.status).toBe(200);
    }
    for (const who of [editor, viewer, finance]) {
      await markFresh(who);
      const res = await detect(who, docId, leak);
      expect([403, 404], `${who.email}`).toContain(res.status);
      const r = await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
        cookie: who.cookie,
      });
      expect([403, 404]).toContain(r.status);
    }
    for (const who of [ada, bob]) {
      expect((await detect(who, docId, leak)).status).toBe(404);
      expect(
        (
          await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
            cookie: who.cookie,
          })
        ).status,
      ).toBe(404);
    }
  });

  it("needs a fresh session", async () => {
    await sql(
      `UPDATE core.session SET auth_time = now() - interval '1 hour'
        WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid)`,
      [admin.membershipId],
    );
    const res = await detect(admin, docId, await asJpeg(adaPage, 70));
    expect(res.status).toBe(403);
    await markFresh(admin);
  });

  it("409 forensic_no_marks for a version nobody was served marked; 404s; 422 invalid image", async () => {
    await markFresh(legal);
    const up = await upload(owner, folderId, "never-served.pdf", await makePdf(1, "Never"));
    const none = await detect(legal, up.documentId, await asJpeg(adaPage, 70));
    expect(none.status).toBe(409);
    expect((await json<{ error: { code: string } }>(none)).error.code).toBe("forensic_no_marks");
    expect((await detect(legal, "00000000-0000-4000-8000-000000000000", adaPage)).status).toBe(404);
    expect((await detect(legal, docId, adaPage, { page: "9" })).status).toBe(404);
    expect((await detect(legal, docId, adaPage, { versionId: up.versionId })).status).toBe(404);
    const junk = await detect(legal, docId, new Uint8Array([1, 2, 3, 4, 5]), {
      type: "image/png",
    });
    expect(junk.status).toBe(422);
    expect((await json<{ error: { code: string } }>(junk)).error.code).toBe(
      "forensic_image_invalid",
    );
    const tiny = new Uint8Array(await sharp(adaPage).resize({ width: 120 }).png().toBuffer());
    const small = await detect(legal, docId, tiny, { type: "image/png" });
    expect(small.status).toBe(422);
    expect((await detect(legal, docId, adaPage, { type: "image/gif" })).status).toBe(415);
  });

  it("allows 10 detections per USER per hour across workspaces, then 429 forensic_rate_limited", async () => {
    const limited = await member(acmeId, "legal2@example.com", "staff", "legal");
    // The same person staffs a second workspace: its detections share the budget (FIX1 D8).
    const betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
    const deps = running.container.identityDeps;
    const user = await provisionUser(deps, { email: limited.email, displayName: "legal2" });
    await provisionMembership(deps, {
      workspaceId: betaId,
      userId: user.userId,
      kind: "staff",
      role: "legal",
      source: "test",
    });
    const inBeta = await signIn("beta", limited.email);
    for (let i = 0; i < 5; i++) {
      const res = await detect(limited, docId, adaPage, { page: "9" }); // cheap: 404
      expect(res.status).toBe(404);
      const form = new FormData();
      form.set("image", new Blob([adaPage as unknown as ArrayBuffer], { type: "image/webp" }));
      form.set("page", "1");
      const b = await request(
        "beta",
        "/api/v1/data-room/documents/00000000-0000-4000-8000-000000000000/forensic/detect",
        { method: "POST", cookie: inBeta.cookie, body: form },
      );
      expect(b.status, await b.clone().text()).toBe(404);
    }
    const over = await detect(limited, docId, adaPage, { page: "9" });
    expect(over.status).toBe(429);
    expect((await json<{ error: { code: string } }>(over)).error.code).toBe(
      "forensic_rate_limited",
    );
    // Per user: another person is unaffected.
    expect((await detect(legal, docId, adaPage, { page: "9" })).status).toBe(404);
  });
});

describe("fix round 1", () => {
  it("D2: forensic on + visible off → investors get a traced PDF, never the original", async () => {
    const up = await upload(owner, folderId, "traced-only.pdf", await makePdf(1, "Traced"));
    await protect(up.documentId, { forensic: true, watermark: false, download: true });
    const detail = await json<{ availability: { download: string | null } }>(
      await request("acme", `/api/v1/data-room/documents/${up.documentId}`, {
        cookie: ada.cookie,
      }),
    );
    expect(detail.availability.download).toBe("watermarked");
    const res = await request(
      "acme",
      `/api/v1/data-room/documents/${up.documentId}/download?variant=original`,
      { cookie: ada.cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("-watermarked.pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    const info = pdf.context.lookup(pdf.context.trailerInfo.Info) as
      | { get(n: PDFName): unknown }
      | undefined;
    const trace = info?.get(PDFName.of("SeedHostTrace"));
    const [mark] = await marksOf(ada.membershipId, up.versionId);
    expect(trace instanceof PDFString ? trace.decodeText() : String(trace)).toBe(mark?.token);
  });

  it("D1: refuses an image that does not have the page's shape, before detecting", async () => {
    await markFresh(admin);
    const meta = await sharp(adaPage).metadata();
    const w = meta.width ?? 1600;
    const strip = new Uint8Array(
      await sharp(adaPage).resize({ width: w, height: 300, fit: "fill" }).png().toBuffer(),
    );
    const res = await detect(admin, docId, strip, { type: "image/png" });
    expect(res.status, await res.clone().text()).toBe(422);
    expect(await json(res)).toMatchObject({
      error: { code: "forensic_image_invalid", reason: "aspect_ratio" },
    });
    const huge = new Uint8Array(
      await sharp(adaPage)
        .resize({ width: w * 3 })
        .jpeg({ quality: 30 })
        .toBuffer(),
    );
    const big = await detect(admin, docId, huge);
    expect(big.status, await big.clone().text()).toBe(422);
    expect(await json(big)).toMatchObject({
      error: { code: "forensic_image_invalid", reason: "too_large" },
    });
  });

  it("D9: one detection in flight per workspace — a second user's concurrent one gets 503", async () => {
    const [p1, p2] = [
      await member(acmeId, "pair1@example.com", "staff", "legal"),
      await member(acmeId, "pair2@example.com", "staff", "legal"),
    ];
    const leak = await asJpeg(adaPage, 75);
    const statuses = (
      await Promise.all(
        [detect(p1, docId, leak), detect(p2, docId, leak)].map((p) => p.then((r) => r.status)),
      )
    ).sort();
    expect(statuses).toEqual([200, 503]);
    // The slot is released afterwards (success or refusal).
    expect((await detect(p2, docId, leak)).status).toBe(200);
  }, 120_000);

  it("a detector deadline (ForensicTimeoutError) answers 503 forensic_busy, quietly", async () => {
    const tester = await member(acmeId, "timeout@example.com", "staff", "legal");
    const restore = replaceProcessDetector({
      detect: () => Promise.reject(new ForensicTimeoutError(30_000)),
      close: async () => {},
    });
    try {
      // FIX3 RR2-1: a shed (503) attempt never spends the hourly allowance of 10.
      const leak = await asJpeg(adaPage, 80);
      for (let i = 0; i < 11; i++) {
        const shed = await detect(tester, docId, leak);
        expect(shed.status, `attempt ${i + 1}`).toBe(503);
      }
      const res = await detect(tester, docId, leak);
      expect(res.status, await res.clone().text()).toBe(503);
      expect(res.headers.get("retry-after")).toBe("10");
      expect(await json(res)).toMatchObject({
        error: { code: "forensic_busy", reason: "timeout" },
      });
    } finally {
      restore();
    }
    // The workspace slot was released: the real detector answers again.
    expect((await detect(tester, docId, await asJpeg(adaPage, 80))).status).toBe(200);
  }, 120_000);

  it("D11: a page taller than 4× its width is tested, not a 500", async () => {
    const tall = new Uint8Array(
      await sharp(await asJpeg(adaPage, 90))
        .resize({ width: 400, height: 2400, fit: "fill" })
        .png()
        .toBuffer(),
    );
    const up = await upload(owner, folderId, "receipt.png", tall, "image/png");
    await protect(up.documentId, { forensic: true, watermark: false });
    const shown = await page(ada, up.documentId);
    const tester = await member(acmeId, "tall@example.com", "staff", "legal");
    const res = await detect(tester, up.documentId, await asJpeg(shown, 90));
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<Detection>(res)).results.map((r) => r.membershipId)).toEqual([
      ada.membershipId,
    ]);
  }, 120_000);

  it("D1: detection runs on a bounded worker queue — a flood gets 503 forensic_busy", async () => {
    const flooder = await member(acmeId, "flood@example.com", "staff", "admin");
    const leak = await asJpeg(adaPage, 75);
    const statuses = await Promise.all(
      Array.from({ length: 9 }, () => detect(flooder, docId, leak).then((r) => r.status)),
    );
    expect(statuses.filter((x) => x === 200).length).toBeGreaterThan(0);
    expect(statuses).toContain(503);
    expect(statuses.every((x) => x === 200 || x === 503)).toBe(true);
  }, 120_000);

  it("D5: returns the thresholds used and flags a tampered (collusion) image", async () => {
    await markFresh(admin);
    const clean = await json<
      Detection & { thresholds: { match: number; inconclusive: number }; tamperSuspected: boolean }
    >(await detect(admin, docId, await asJpeg(adaPage, 85)));
    expect(clean.tamperSuspected).toBe(false);
    expect(clean.thresholds.match).toBeGreaterThanOrEqual(6);
    expect(clean.thresholds.inconclusive).toBeGreaterThanOrEqual(4);
    // Collusion: 2A − B (A's and B's copies averaged against each other) inverts B's mark.
    const gray = async (b: Uint8Array) => sharp(b).greyscale().raw().toBuffer();
    const meta = await sharp(adaPage).metadata();
    const [a, b] = [await gray(adaPage), await gray(bobPage)];
    const mix = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++)
      mix[i] = Math.max(0, Math.min(255, 2 * (a[i] ?? 0) - (b[i] ?? 0)));
    const width = meta.width ?? 0;
    const png = new Uint8Array(
      await sharp(mix, { raw: { width, height: a.length / width, channels: 1 } })
        .png()
        .toBuffer(),
    );
    const res = await detect(admin, docId, png, { type: "image/png" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<{ tamperSuspected: boolean }>(res)).tamperSuspected).toBe(true);
  });

  it("D4: investors are not told which documents carry the invisible mark; staff are", async () => {
    const staffView = await json<{ document: { protection: Record<string, unknown> } }>(
      await request("acme", `/api/v1/data-room/documents/${docId}`, { cookie: owner.cookie }),
    );
    expect(staffView.document.protection["forensic"]).toBe(true);
    const mine = await json<{ document: { protection: Record<string, unknown> } }>(
      await request("acme", `/api/v1/data-room/documents/${docId}`, { cookie: ada.cookie }),
    );
    expect(mine.document.protection).not.toHaveProperty("forensic");
    const tree = await request("acme", "/api/v1/data-room/tree", { cookie: ada.cookie });
    const text = await tree.text();
    expect(text).toContain(docId);
    expect(text).not.toContain("forensic");
  });

  it("D6: the member's forensic marks are in their subject-access export (no token)", async () => {
    const ctx = systemContext(acmeId);
    const out = (await running.container.db.withTenant(ctx, (tx) =>
      dataRoomDsar.export({ tx, ctx, membershipId: ada.membershipId } as never),
    )) as { forensicMarks: Record<string, unknown>[] };
    const [mark] = await marksOf(ada.membershipId, versionId);
    const row = out.forensicMarks.find((m) => m["versionId"] === versionId);
    expect(row).toMatchObject({ documentId: docId, documentTitle: "board-deck", versionNo: 1 });
    expect(row?.["trace"]).toBe(base32(Buffer.from(mark?.token ?? "", "hex")).slice(0, 8));
    expect(JSON.stringify(out)).not.toContain(mark?.token ?? "-");
  });
});

describe("a one-connection pool", () => {
  it("serves marked pages, downloads, detection and recipients without a nested acquire", async () => {
    const dave = await member(acmeId, "dave@investor.test", "external", "investor");
    const grant = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "membership", id: dave.membershipId },
        resource: { kind: "folder", id: folderId, path: folderPath },
        capabilities: ["view", "download"],
      }),
    });
    expect(grant.status).toBe(200);
    const single = await startServer({
      config: loadConfig({ env: { ...env, DATABASE_POOL_MAX: "1", ROLES: "api,web" } }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    await single.container.relay.stop();
    try {
      await withTimeout(
        (async () => {
          const shown = await page(dave, docId, 1, single);
          expect(await marksOf(dave.membershipId, versionId)).toHaveLength(1);
          const dl = await request("acme", `/api/v1/data-room/documents/${docId}/download`, {
            cookie: dave.cookie,
            server: single,
          });
          expect(dl.status).toBe(200);
          await dl.arrayBuffer();
          await markFresh(owner);
          const res = await detect(owner, docId, await asJpeg(shown, 85), {}, single);
          expect(res.status, await res.clone().text()).toBe(200);
          const body = await json<Detection>(res);
          expect(body.results.find((r) => r.verdict === "match")?.membershipId).toBe(
            dave.membershipId,
          );
          const rec = await request(
            "acme",
            `/api/v1/data-room/documents/${docId}/forensic/recipients`,
            { cookie: owner.cookie, server: single },
          );
          expect(rec.status).toBe(200);
        })(),
        60_000,
        "one-connection forensic path",
      );
    } finally {
      await single.stop();
    }
  }, 120_000);
});

describe("evidence lifecycle", () => {
  it("mark rows survive the member's erasure (email then null)", async () => {
    const before = await marksOf(bob.membershipId);
    expect(before.length).toBeGreaterThan(0);
    await markFresh(owner);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: bob.membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(res);
    await waitFor(async () => {
      const [r] = await sql<{ status: string }>(
        "SELECT status::text FROM core.dsar_request WHERE id = $1",
        [id],
      );
      return r?.status === "completed" ? true : undefined;
    }, 90_000);
    expect(await marksOf(bob.membershipId)).toEqual(before);
    const list = await json<Recipients>(
      await request("acme", `/api/v1/data-room/documents/${docId}/forensic/recipients`, {
        cookie: owner.cookie,
      }),
    );
    const erased = list.items.find((i) => i.membershipId === bob.membershipId);
    expect(erased).toBeDefined();
    expect(erased?.email).toBeNull();
    expect(JSON.stringify(list)).not.toContain("bob@investor.test");
  }, 120_000);

  it("purging the document removes its marks", async () => {
    const [{ n } = { n: 0 }] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM dataroom.forensic_mark WHERE document_id = $1",
      [docId],
    );
    expect(n).toBeGreaterThan(0);
    const del = await request("acme", `/api/v1/data-room/documents/${docId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status, await del.clone().text()).toBe(200);
    await markFresh(owner);
    const purge = await request("acme", `/api/v1/data-room/documents/${docId}/purge`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(purge.status, await purge.clone().text()).toBe(200);
    const [{ m } = { m: -1 }] = await sql<{ m: number }>(
      "SELECT count(*)::int AS m FROM dataroom.forensic_mark WHERE document_id = $1",
      [docId],
    );
    expect(m).toBe(0);
  });
});
