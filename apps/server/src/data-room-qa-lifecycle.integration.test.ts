import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  dataRoomDsar,
  dataRoomSearch,
  indexQuestion,
  JOB_QA_SLA,
  QA_EXPORT_COLUMNS,
  runQaSla,
  SEARCH_VERSION,
} from "@fundroom/module-data-room";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Data-room Q&A lifecycle (E3.3 D7 + the D6 CSV routes): published answers in workspace search
 * under the target's ACL (and nowhere else), following the target through trash, restore,
 * purge, document and folder moves and a full rebuild; the SLA sweep's reminders (once per
 * phase, only while Q&A and the data room are on); DSAR erasure and export; the CSV export
 * (formula-guarded, fresh session) and the all-or-nothing import.
 *
 * Questions are written with SQL here — the ask/answer/release flows are covered by
 * data-room-qa.integration.test.ts — and re-indexed through the module's own `indexQuestion`,
 * the call every release/unpublish/edit makes on its write transaction.
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

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
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
  // the code mail to this address: Q&A notifications from earlier tests may land in between
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
    actor.cookie = withSetCookies(actor.cookie, confirm);
  }
  return actor;
}

/** Sets the actor's sessions' auth time `ageMs` into the past (0 = fresh). */
async function authAge(actor: Actor, ageMs: number): Promise<void> {
  await sql(
    `UPDATE core.session SET auth_time = now() - ($2::bigint * interval '1 millisecond')
      WHERE revoked_at IS NULL
        AND user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid)`,
    [actor.membershipId, ageMs],
  );
}

async function search(actor: Actor, q: string): Promise<Hit[]> {
  const res = await request(`/api/v1/search?q=${encodeURIComponent(q)}`, {
    cookie: actor.cookie,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ hits: Hit[] }>(res)).hits.filter((h) => h.module === "data-room");
}

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

/** RFC 4180 (quoted fields, doubled quotes, CRLF), enough to read the export back. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/u, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && src[i + 1] === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) out.push([...row, cell]);
  return out;
}

const refs = (hits: Hit[]) => hits.map((h) => `${h.kind}:${h.refId}`).sort();

interface TreeBody {
  rootId: string;
  folders: { id: string; name: string; path: string }[];
}
function folderIn(tree: TreeBody, name: string): { id: string; path: string } {
  const f = tree.folders.find((x) => x.name === name);
  if (f === undefined) throw new Error(`no folder ${name}`);
  return { id: f.id, path: f.path };
}

let acmeId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor; // folder grant on Financials
let bob: Actor; // no grant
let carol: Actor; // grant through a group with an NDA pending
let erin: Actor; // grant on Financials; erased below
let rootId: string;
let financials: { id: string; path: string };
let legal: { id: string; path: string };
let deckId: string; // in Financials
let memoId: string; // in Legal

const services = () => running.container.moduleServices;
const tenant = () => systemContext(acmeId);

/** A document row (no version: Q&A needs a live target, not a file). */
async function doc(folder: { id: string; path: string }, title: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
     VALUES ($1, $2, $3::ltree, $4) RETURNING id`,
    [acmeId, folder.id, folder.path, title],
  );
  return row?.id ?? "";
}

interface QuestionInput {
  target: { kind: "document" | "folder"; id: string };
  status?: "open" | "assigned" | "awaiting_approval" | "answered" | "published" | "closed";
  asker?: Actor | null;
  subject?: string;
  body?: string;
  publicText?: string | null;
  answer?: string | null;
  dueAt?: Date | null;
  internalNote?: string | null;
}

async function question(q: QuestionInput): Promise<string> {
  const status = q.status ?? "open";
  const visibility = status === "published" ? "target" : status === "answered" ? "asker" : null;
  const released = status === "published" || status === "answered";
  const asker = q.asker === undefined ? ada : q.asker;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id, folder_id,
        asker_membership_id, source, status, subject, body, public_text, visibility, due_at,
        internal_note, closed_reason, closed_at, released_at, published_at, first_released_at)
     VALUES ($1, $2::dataroom.qa_target_kind, $3, $4, $5, $6, $7::dataroom.qa_status, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $16)
     RETURNING id`,
    [
      acmeId,
      q.target.kind,
      q.target.kind === "document" ? q.target.id : null,
      q.target.kind === "folder" ? q.target.id : null,
      asker?.membershipId ?? null,
      asker === null ? "staff" : "portal",
      status,
      q.subject ?? "A question",
      q.body ?? "The asker's own words",
      status === "published" ? (q.publicText ?? "A question") : (q.publicText ?? null),
      visibility,
      q.dueAt ?? null,
      q.internalNote ?? null,
      status === "closed" ? "declined" : null,
      status === "closed" ? new Date() : null,
      released ? new Date() : null,
      status === "published" ? new Date() : null,
    ],
  );
  const id = row?.id ?? "";
  if (q.answer != null)
    await sql(
      `INSERT INTO dataroom.qa_answer (workspace_id, question_id, body, author_membership_id)
       VALUES ($1, $2, $3, $4)`,
      [acmeId, id, q.answer, owner.membershipId],
    );
  return id;
}

async function index(id: string): Promise<void> {
  await running.container.db.withTenant(tenant(), (tx) =>
    indexQuestion(services(), tx, tenant(), id),
  );
}

async function qaEntries(ids?: string[]) {
  return sql<{
    ref_id: string;
    title: string;
    body: string;
    href: string;
    acl_resource_kind: string;
    acl_resource_id: string;
    acl_path: string;
  }>(
    `SELECT ref_id::text, title, body, href, acl_resource_kind, acl_resource_id::text,
            acl_path::text
       FROM core.search_entry
      WHERE workspace_id = $1 AND module = 'data-room' AND kind = 'qa'
        AND ($2::uuid[] IS NULL OR ref_id = ANY($2::uuid[]))
      ORDER BY ref_id`,
    [acmeId, ids ?? null],
  );
}

async function setQa(patch: Record<string, unknown>): Promise<void> {
  await sql(
    `UPDATE core.workspace SET settings = jsonb_set(settings, '{dataRoom}',
       COALESCE(settings->'dataRoom', '{}'::jsonb) || jsonb_build_object('qa',
         COALESCE(settings->'dataRoom'->'qa', '{}'::jsonb) || $2::jsonb))
     WHERE id = $1`,
    [acmeId, JSON.stringify(patch)],
  );
  services().workspaces.invalidate(acmeId);
}

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
  erin = await member(acmeId, "erin@investor.test", "external", "investor");
  await setQa({ enabled: true, reminderLeadHours: 24, slaHours: 72 });

  rootId = (
    await json<{ rootId: string }>(
      await request("/api/v1/data-room/tree", { cookie: owner.cookie }),
    )
  ).rootId;
  const folder = async (name: string, parentId = rootId) => {
    const res = await request("/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId, name }),
    });
    expect(res.status).toBe(201);
    return folderIn(await json<TreeBody>(res), name);
  };
  financials = await folder("Financials");
  legal = await folder("Legal");
  deckId = await doc(financials, "Board deck");
  memoId = await doc(legal, "Counsel memo");

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
  await grant({ kind: "membership", id: erin.membershipId });
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

describe("published Q&A in workspace search", () => {
  let burnId: string; // published, on the deck (Financials)
  let legalFaqId: string; // published, on the Legal folder
  let memoQId: string; // published, on the memo (in Legal)

  beforeAll(async () => {
    burnId = await question({
      target: { kind: "document", id: deckId },
      status: "published",
      subject: "Burn?",
      body: "koalaprivate words only the asker may see",
      publicText: "Burn multiple question\n\nWhat is the monthly burn?",
      answer: "Our burn is aardwolfnumber per month",
    });
    legalFaqId = await question({
      target: { kind: "folder", id: legal.id },
      status: "published",
      asker: null,
      publicText: "Indemnity caps\n\nHow are indemnities capped?",
      answer: "Capped at pangolincap of the purchase price",
    });
    memoQId = await question({
      target: { kind: "document", id: memoId },
      status: "published",
      publicText: "Memo question",
      answer: "The memo covers quollclause",
    });
    for (const id of [burnId, legalFaqId, memoQId]) await index(id);
  });

  it("indexes a published question as kind `qa` with the target's ACL and title, public text + answer only", async () => {
    const [entry] = await qaEntries([burnId]);
    expect(entry).toMatchObject({
      ref_id: burnId,
      // The target's title, never Q&A text: gated callers match on titles alone (S1).
      title: "Board deck",
      href: `/data-room/questions/${burnId}`,
      acl_resource_kind: "document",
      acl_resource_id: deckId,
      acl_path: financials.path,
    });
    expect(entry?.body).toBe(
      "Burn multiple question\n\nWhat is the monthly burn?\n\nOur burn is aardwolfnumber per month",
    );
    expect(entry?.body).not.toContain("koalaprivate");
    expect(entry?.title).not.toContain("Burn?");
    const [folderEntry] = await qaEntries([legalFaqId]);
    expect(folderEntry).toMatchObject({
      title: "Legal",
      acl_resource_kind: "folder",
      acl_resource_id: legal.id,
      acl_path: legal.path,
    });
  });

  it("is found by an investor who can view the target and by staff; by nobody else", async () => {
    expect(refs(await eventually(ada, "aardwolfnumber", (h) => h.length > 0))).toEqual([
      `qa:${burnId}`,
    ]);
    expect(await search(ada, "pangolincap")).toEqual([]); // Legal: no grant
    expect(await search(ada, "koalaprivate")).toEqual([]); // the asker's words are not indexed
    expect(await search(bob, "aardwolfnumber")).toEqual([]);
    expect(await search(bob, "Burn multiple")).toEqual([]);
    expect(refs(await search(owner, "pangolincap"))).toEqual([`qa:${legalFaqId}`]);
    expect(refs(await search(editor, "aardwolfnumber"))).toEqual([`qa:${burnId}`]);
  });

  it("a gated (NDA pending) investor learns nothing about Q&A text: no match on question or answer words", async () => {
    // Only the target's own title matches for them — what the gated document hit says anyway.
    const titled = await eventually(carol, "Board deck", (h) => h.length > 0);
    expect(titled).toEqual([
      expect.objectContaining({ refId: burnId, title: "Board deck", gated: true, snippet: [] }),
    ]);
    // Words that appear only in the public wording's first line, the rest of it, or the answer.
    for (const q of ["Burn multiple", "Burn", "monthly", "aardwolfnumber"])
      expect(await search(carol, q), q).toEqual([]);
    // The same words do find it for an investor who can open the target.
    expect(refs(await search(ada, "monthly"))).toEqual([`qa:${burnId}`]);
  });

  it("renaming the target re-titles its Q&A entries (document and folder)", async () => {
    const rename = async (path: string, body: Record<string, string>) => {
      const res = await request(path, {
        method: "PATCH",
        cookie: editor.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };
    await rename(`/api/v1/data-room/documents/${deckId}`, { title: "Renamed deck" });
    await rename(`/api/v1/data-room/folders/${legal.id}`, { name: "Legal renamed" });
    try {
      expect((await qaEntries([burnId]))[0]?.title).toBe("Renamed deck");
      expect((await qaEntries([legalFaqId]))[0]?.title).toBe("Legal renamed");
    } finally {
      await rename(`/api/v1/data-room/documents/${deckId}`, { title: "Board deck" });
      await rename(`/api/v1/data-room/folders/${legal.id}`, { name: "Legal" });
    }
    expect((await qaEntries([burnId]))[0]?.title).toBe("Board deck");
    expect((await qaEntries([legalFaqId]))[0]?.title).toBe("Legal");
  });

  it("unpublished, answered-to-asker, open and closed questions are not indexed", async () => {
    const ids = [
      await question({ target: { kind: "document", id: deckId }, status: "answered", answer: "x" }),
      await question({ target: { kind: "document", id: deckId }, status: "open" }),
      await question({ target: { kind: "document", id: deckId }, status: "closed" }),
    ];
    for (const id of ids) await index(id);
    expect(await qaEntries(ids)).toEqual([]);
    // unpublish: the entry goes on the next indexQuestion
    await sql(
      `UPDATE dataroom.qa_question SET status = 'answered', visibility = 'asker' WHERE id = $1`,
      [burnId],
    );
    await index(burnId);
    expect(await qaEntries([burnId])).toEqual([]);
    await sql(
      `UPDATE dataroom.qa_question SET status = 'published', visibility = 'target' WHERE id = $1`,
      [burnId],
    );
    await index(burnId);
    expect(await qaEntries([burnId])).toHaveLength(1);
  });

  it("trashing and restoring the target document removes and restores its entries", async () => {
    const del = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(200);
    expect(await qaEntries([burnId])).toEqual([]);
    expect(await search(owner, "aardwolfnumber")).toEqual([]);
    // re-indexing while the target is in the bin does not bring it back
    await index(burnId);
    expect(await qaEntries([burnId])).toEqual([]);
    const restore = await request(`/api/v1/data-room/documents/${deckId}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restore.status).toBe(200);
    expect(refs(await search(ada, "aardwolfnumber"))).toEqual([`qa:${burnId}`]);
  });

  it("trashing a folder removes entries for questions anywhere in its subtree; restore brings them back", async () => {
    const del = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(200);
    expect(await qaEntries([legalFaqId, memoQId])).toEqual([]);
    expect(await search(owner, "quollclause")).toEqual([]);
    const restore = await request(`/api/v1/data-room/folders/${legal.id}/restore`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(restore.status).toBe(200);
    expect((await qaEntries([legalFaqId, memoQId])).map((e) => e.acl_path)).toEqual([
      legal.path,
      legal.path,
    ]);
    expect(refs(await search(owner, "quollclause"))).toEqual([`qa:${memoQId}`]);
  });

  it("a folder move re-paths the Q&A entries under it (grant inheritance follows)", async () => {
    const moved = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: financials.id }),
    });
    expect(moved.status).toBe(200);
    const newPath = folderIn(await json<TreeBody>(moved), "Legal").path;
    expect(newPath).not.toBe(legal.path);
    expect((await qaEntries([legalFaqId, memoQId])).map((e) => e.acl_path)).toEqual([
      newPath,
      newPath,
    ]);
    expect(refs(await eventually(ada, "quollclause", (h) => h.length > 0))).toEqual([
      `qa:${memoQId}`,
    ]);
    const back = await request(`/api/v1/data-room/folders/${legal.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId }),
    });
    expect(back.status).toBe(200);
    legal = folderIn(await json<TreeBody>(back), "Legal");
    await eventually(ada, "quollclause", (h) => h.length === 0);
  });

  it("moving the target document to another folder re-paths its entries", async () => {
    const out = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ folderId: legal.id }),
    });
    expect(out.status).toBe(200);
    expect((await qaEntries([burnId]))[0]?.acl_path).toBe(legal.path);
    expect(await search(ada, "aardwolfnumber")).toEqual([]);
    const back = await request(`/api/v1/data-room/documents/${deckId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ folderId: financials.id }),
    });
    expect(back.status).toBe(200);
    expect((await qaEntries([burnId]))[0]?.acl_path).toBe(financials.path);
    expect(refs(await search(ada, "aardwolfnumber"))).toEqual([`qa:${burnId}`]);
  });

  it("purging the target deletes its Q&A rows and their entries", async () => {
    const tmpDoc = await doc(financials, "Temporary");
    const q = await question({
      target: { kind: "document", id: tmpDoc },
      status: "published",
      publicText: "Temp question",
      answer: "ephemeral numbatword",
    });
    await index(q);
    expect(await qaEntries([q])).toHaveLength(1);
    expect(
      (
        await request(`/api/v1/data-room/documents/${tmpDoc}`, {
          method: "DELETE",
          cookie: editor.cookie,
        })
      ).status,
    ).toBe(200);
    // the entry was already gone with the trash; put it back to prove purge removes it itself
    await sql("UPDATE dataroom.document SET deleted_at = NULL WHERE id = $1", [tmpDoc]);
    await index(q);
    await sql("UPDATE dataroom.document SET deleted_at = now() WHERE id = $1", [tmpDoc]);
    expect(await qaEntries([q])).toHaveLength(1);
    await authAge(owner, 0);
    const purge = await request(`/api/v1/data-room/documents/${tmpDoc}/purge`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(purge.status, await purge.clone().text()).toBe(200);
    expect(await sql("SELECT 1 FROM dataroom.qa_question WHERE id = $1", [q])).toEqual([]);
    expect(await sql("SELECT 1 FROM dataroom.qa_answer WHERE question_id = $1", [q])).toEqual([]);
    expect(await qaEntries([q])).toEqual([]);
  });

  it("the full rebuild (search version 2) includes published Q&A on live targets", async () => {
    expect(SEARCH_VERSION).toBe(2);
    expect(dataRoomSearch.version).toBe(2);
    const pages = await running.container.db.withTenant(tenant(), async (tx) => {
      const kinds: string[] = [];
      const source = dataRoomSearch.entries({ tx, ctx: tenant() } as never);
      const entries = Symbol.asyncIterator in source ? source : await source;
      for await (const e of entries) kinds.push(`${e.kind}:${e.refId}`);
      return kinds;
    });
    expect(pages.filter((k) => k.startsWith("qa:")).sort()).toEqual(
      [`qa:${burnId}`, `qa:${legalFaqId}`, `qa:${memoQId}`].sort(),
    );
    // Through the real job: drop the entries, ask for a rebuild, they come back.
    await sql("DELETE FROM core.search_entry WHERE workspace_id = $1 AND kind = 'qa'", [acmeId]);
    await running.container.db.withTenant(tenant(), (tx) =>
      services().search.requestReindex(tx, tenant(), "data-room"),
    );
    const back = await waitFor(async () => {
      const rows = await qaEntries();
      return rows.length === 3 ? rows : undefined;
    });
    expect(back.map((r) => r.ref_id).sort()).toEqual([burnId, legalFaqId, memoQId].sort());
    expect(refs(await search(ada, "aardwolfnumber"))).toEqual([`qa:${burnId}`]);
  });
});

describe("Q&A switched off (settings.dataRoom.qa.enabled = false)", () => {
  const reindex = () =>
    running.container.db.withTenant(tenant(), (tx) =>
      services().search.requestReindex(tx, tenant(), "data-room"),
    );

  it("Q&A entries exist only while Q&A is on: writes remove, the rebuild drops and restores", async () => {
    const before = (await qaEntries()).map((e) => e.ref_id).sort();
    expect(before.length).toBeGreaterThan(0);
    const [one] = before;
    await setQa({ enabled: false });
    try {
      // A write path (release, edit…) while off removes instead of upserting.
      await index(one ?? "");
      expect(await qaEntries([one ?? ""])).toEqual([]);
      // The rebuild the settings PATCH requests drops the rest.
      await reindex();
      await waitFor(async () => ((await qaEntries()).length === 0 ? true : undefined));
      expect(await search(ada, "aardwolfnumber")).toEqual([]);
      expect(await search(owner, "pangolincap")).toEqual([]);
      // Target hooks (restore) do not bring them back either.
      await request(`/api/v1/data-room/documents/${deckId}`, {
        method: "DELETE",
        cookie: editor.cookie,
      });
      await request(`/api/v1/data-room/documents/${deckId}/restore`, {
        method: "POST",
        cookie: editor.cookie,
      });
      expect(await qaEntries()).toEqual([]);
    } finally {
      await setQa({ enabled: true });
    }
    await reindex();
    const back = await waitFor(async () => {
      const rows = await qaEntries();
      return rows.length === before.length ? rows : undefined;
    });
    expect(back.map((e) => e.ref_id).sort()).toEqual(before);
    expect(refs(await search(ada, "aardwolfnumber")).length).toBeGreaterThan(0);
  });
});

describe("the SLA job (data-room.qa-sla)", () => {
  const HOUR = 3_600_000;
  const stamps = async (id: string) =>
    (
      await sql<{ soon: Date | null; over: Date | null }>(
        `SELECT due_soon_notified_at AS soon, overdue_notified_at AS over
           FROM dataroom.qa_question WHERE id = $1`,
        [id],
      )
    )[0];
  const audits = async (id: string) =>
    sql<{ meta: { phase: string; dueAt: string } }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'qa.question_due'
         AND resource_id = $2 ORDER BY occurred_at`,
      [acmeId, id],
    );
  const events = async (id: string) =>
    sql<{ payload: { phase: string; questionId: string; assigneeMembershipId: string | null } }>(
      `SELECT payload FROM core.outbox WHERE workspace_id = $1 AND topic = 'qa.question_due'
         AND payload->>'questionId' = $2 ORDER BY id`,
      [acmeId, id],
    );

  it("sends due_soon once, then overdue once, per question", async () => {
    const t = new Date();
    const due = new Date(t.getTime() + 10 * HOUR);
    const q = await question({ target: { kind: "document", id: deckId }, dueAt: due });
    await sql(
      "UPDATE dataroom.qa_question SET status = 'assigned', assignee_membership_id = $2 WHERE id = $1",
      [q, editor.membershipId],
    );
    await runQaSla(services(), { workspaceId: acmeId, at: t });
    await runQaSla(services(), { workspaceId: acmeId, at: new Date(t.getTime() + HOUR) });
    expect((await stamps(q))?.soon).not.toBeNull();
    expect((await stamps(q))?.over).toBeNull();
    expect((await audits(q)).map((a) => a.meta.phase)).toEqual(["due_soon"]);
    await runQaSla(services(), { workspaceId: acmeId, at: new Date(due.getTime() + HOUR) });
    await runQaSla(services(), { workspaceId: acmeId, at: new Date(due.getTime() + 2 * HOUR) });
    expect((await stamps(q))?.over).not.toBeNull();
    expect((await audits(q)).map((a) => a.meta)).toEqual([
      { phase: "due_soon", dueAt: due.toISOString() },
      { phase: "overdue", dueAt: due.toISOString() },
    ]);
    expect((await events(q)).map((e) => e.payload)).toEqual([
      expect.objectContaining({ phase: "due_soon", assigneeMembershipId: editor.membershipId }),
      expect.objectContaining({ phase: "overdue", assigneeMembershipId: editor.membershipId }),
    ]);
  });

  it("a question first seen past its due time gets the overdue reminder only; far-off ones none", async () => {
    const t = new Date();
    const late = await question({
      target: { kind: "document", id: deckId },
      dueAt: new Date(t.getTime() - HOUR),
    });
    const far = await question({
      target: { kind: "document", id: deckId },
      dueAt: new Date(t.getTime() + 48 * HOUR),
    });
    await runQaSla(services(), { workspaceId: acmeId, at: t });
    expect((await audits(late)).map((a) => a.meta.phase)).toEqual(["overdue"]);
    expect(await stamps(late)).toMatchObject({ soon: null });
    expect(await audits(far)).toEqual([]);
  });

  it("ignores answered, published and closed questions", async () => {
    const past = new Date(Date.now() - 5 * HOUR);
    const ids = [
      await question({ target: { kind: "document", id: deckId }, status: "answered", dueAt: past }),
      await question({
        target: { kind: "document", id: deckId },
        status: "published",
        dueAt: past,
      }),
      await question({ target: { kind: "document", id: deckId }, status: "closed", dueAt: past }),
    ];
    await runQaSla(services(), { workspaceId: acmeId, at: new Date() });
    for (const id of ids) {
      expect(await audits(id)).toEqual([]);
      expect(await stamps(id)).toEqual({ soon: null, over: null });
    }
  });

  it("skips the workspace while Q&A is off, and while the data room is disabled", async () => {
    const q = await question({
      target: { kind: "document", id: deckId },
      dueAt: new Date(Date.now() - HOUR),
    });
    await setQa({ enabled: false });
    try {
      const s = await runQaSla(services(), { workspaceId: acmeId, at: new Date() });
      expect(s).toMatchObject({ workspaces: 0, overdue: 0, failed: 0 });
      expect(await audits(q)).toEqual([]);
    } finally {
      await setQa({ enabled: true });
    }
    await sql(
      `INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'data-room', false)`,
      [acmeId],
    );
    services().enablement.invalidate(acmeId);
    try {
      const s = await runQaSla(services(), { workspaceId: acmeId, at: new Date() });
      expect(s).toMatchObject({ workspaces: 0, overdue: 0, failed: 0 });
      expect(await audits(q)).toEqual([]);
    } finally {
      await sql(
        "DELETE FROM core.module_enablement WHERE workspace_id = $1 AND module = 'data-room'",
        [acmeId],
      );
      services().enablement.invalidate(acmeId);
    }
    await runQaSla(services(), { workspaceId: acmeId, at: new Date() });
    expect((await audits(q)).map((a) => a.meta.phase)).toEqual(["overdue"]);
  });

  it("one failing workspace is logged and skipped, not thrown", async () => {
    const s = await runQaSla(services(), { workspaceId: "not-a-uuid" });
    expect(s).toMatchObject({ failed: 1, workspaces: 0 });
  });

  it("runs as the registered job with `{ workspaceId, at }` data", async () => {
    const t = new Date();
    const q = await question({
      target: { kind: "document", id: deckId },
      dueAt: new Date(t.getTime() + 2 * HOUR),
    });
    await services().queue.send(JOB_QA_SLA, { workspaceId: acmeId, at: t.toISOString() });
    await waitFor(async () => ((await stamps(q))?.soon ? true : undefined));
    expect((await audits(q)).map((a) => a.meta.phase)).toEqual(["due_soon"]);
  });

  it("1000 overdue-and-reminded questions do not starve a due-soon one out of the page", async () => {
    const t = new Date();
    // Oldest due first: these would fill the 1000-row page if they still matched the due-soon
    // branch (first seen overdue, so never stamped due-soon).
    await sql(
      `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id,
          asker_membership_id, source, status, subject, body, due_at, overdue_notified_at)
       SELECT $1, 'document', $2, $3, 'portal', 'open', 'Starver', 'b',
              $4::timestamptz - (g * interval '1 minute'), $4::timestamptz
         FROM generate_series(1, 1000) g`,
      [acmeId, deckId, ada.membershipId, new Date(t.getTime() - HOUR)],
    );
    try {
      const soon = await question({
        target: { kind: "document", id: deckId },
        dueAt: new Date(t.getTime() + 2 * HOUR),
      });
      const s = await runQaSla(services(), { workspaceId: acmeId, at: t });
      expect(s.failed).toBe(0);
      expect((await stamps(soon))?.soon).not.toBeNull();
      expect((await audits(soon)).map((a) => a.meta.phase)).toEqual(["due_soon"]);
    } finally {
      await sql(
        "DELETE FROM dataroom.qa_question WHERE workspace_id = $1 AND subject = 'Starver'",
        [acmeId],
      );
    }
  });

  it("lock order: the sweep row-locks the workspace before auditing — no deadlock with a settings writer", async () => {
    // A settings writer holds the workspace row FOR UPDATE, then audits (audit-chain advisory
    // lock). The sweep audits and then publishes (outbox FK: FOR KEY SHARE on the same row). If
    // the sweep took the chain lock first, the two would deadlock; it must wait on the row first.
    const deadlocks = async () => {
      await pg.pool.query("SELECT pg_stat_clear_snapshot()");
      const [r] = (
        await pg.pool.query<{ n: string }>(
          "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
        )
      ).rows;
      return Number(r?.n ?? 0);
    };
    const settle = () => new Promise((r) => setTimeout(r, 1_500));
    await settle();
    const before = await deadlocks();
    for (let round = 0; round < 3; round++) {
      const q = await question({
        target: { kind: "document", id: deckId },
        dueAt: new Date(Date.now() - HOUR),
      });
      const writer = await pg.pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout = '10s'");
        const [{ pid }] = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows as [{ pid: number }];
        await writer.query("SELECT id FROM core.workspace WHERE id = $1 FOR UPDATE", [acmeId]);
        const sweep = runQaSla(services(), { workspaceId: acmeId, at: new Date() });
        // Wait until the sweep blocks on something the writer holds.
        await waitFor(async () => {
          const { rows } = await pg.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks l
               WHERE NOT l.granted AND l.pid <> $1 AND $1 = ANY(pg_blocking_pids(l.pid))`,
            [pid],
          );
          return (rows[0]?.n ?? 0) > 0 ? true : undefined;
        }, 10_000);
        // The writer now audits: it takes the audit-chain lock.
        await writer.query("SELECT pg_advisory_xact_lock(24301, hashtext($1::uuid::text))", [
          acmeId,
        ]);
        await writer.query("COMMIT");
        const summary = await sweep;
        expect(summary).toMatchObject({ failed: 0 });
        expect((await audits(q)).map((a) => a.meta.phase)).toEqual(["overdue"]);
      } catch (error) {
        await writer.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        writer.release();
      }
    }
    await settle();
    expect(await deadlocks()).toBe(before);
  }, 60_000);
});

describe("DSAR", () => {
  it("exports the member's questions and the answers released to them — not drafts or staff notes", async () => {
    const released = await question({
      target: { kind: "document", id: deckId },
      status: "answered",
      asker: bob,
      subject: "Bob asks",
      body: "Bob's words",
      answer: "Released to bob",
    });
    const pending = await question({
      target: { kind: "folder", id: financials.id },
      status: "open",
      asker: bob,
      subject: "Bob again",
      body: "Still waiting",
      answer: "draft not yet released",
      internalNote: "staff-only note",
    });
    const out = await running.container.db.withTenant(tenant(), (tx) =>
      dataRoomDsar.export({ tx, ctx: tenant(), membershipId: bob.membershipId } as never),
    );
    const qs = (out as { questions: Record<string, unknown>[] }).questions;
    expect(qs.map((q) => q["id"])).toEqual([released, pending]);
    expect(qs[0]).toMatchObject({
      subject: "Bob asks",
      body: "Bob's words",
      status: "answered",
      targetKind: "document",
      targetId: deckId,
      releasedAnswer: "Released to bob",
    });
    expect(qs[1]).toMatchObject({
      status: "open",
      targetKind: "folder",
      targetId: financials.id,
      releasedAnswer: null,
    });
    expect(JSON.stringify(out)).not.toContain("draft not yet released");
    expect(JSON.stringify(out)).not.toContain("staff-only note");
  });
});

describe("erasure (member.erasure_requested)", () => {
  it("erases the member's words, withdraws published questions from search and reports counts", async () => {
    const pub = await question({
      target: { kind: "document", id: deckId },
      status: "published",
      asker: erin,
      subject: "Erin's subject",
      body: "Erin's body",
      publicText: "Erin public dugongword",
      answer: "Answer to erin dugongword",
    });
    const open = await question({
      target: { kind: "document", id: deckId },
      asker: erin,
      subject: "Erin open",
      body: "Erin open body",
    });
    // Already closed (declined): erasure still marks it `erased`, which bars any reopen.
    const declined = await question({
      target: { kind: "document", id: deckId },
      status: "closed",
      asker: erin,
      subject: "Erin declined",
      body: "Erin declined body",
    });
    await index(pub);
    expect(refs(await search(ada, "dugongword"))).toEqual([`qa:${pub}`]);

    await authAge(owner, 0);
    const res = await request("/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: erin.membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id, expectedModules } = await json<{ id: string; expectedModules: string[] }>(res);
    expect(expectedModules).toContain("data-room");
    const step = await waitFor(async () => {
      const [r] = await sql<{ counts: Record<string, number> }>(
        `SELECT counts FROM core.dsar_step WHERE request_id = $1 AND module = 'data-room'`,
        [id],
      );
      return r;
    });
    expect(step.counts).toEqual({ questions: 3, unpublished: 1 });
    const rows = await sql<{
      id: string;
      subject: string;
      body: string;
      public_text: string | null;
      status: string;
      closed_reason: string;
    }>(
      `SELECT id, subject, body, public_text, status::text, closed_reason
         FROM dataroom.qa_question WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[pub, open, declined].sort()],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        subject: "[erased]",
        body: "[erased]",
        status: "closed",
        closed_reason: "erased",
      });
    }
    expect(rows.find((r) => r.id === pub)?.public_text).toBe("[erased]");
    expect(rows.find((r) => r.id === open)?.public_text).toBeNull();
    expect(await qaEntries([pub])).toEqual([]);
    expect(await search(ada, "dugongword")).toEqual([]);
    // the staff answer stays (the firm's text), readable by nobody
    expect(
      await sql("SELECT 1 FROM dataroom.qa_answer WHERE question_id = $1", [pub]),
    ).toHaveLength(1);
  });
});

describe("CSV export (GET /data-room/qa/export)", () => {
  it("writes every question with the frozen columns, formula-guarded, and audits it", async () => {
    const evil = await question({
      target: { kind: "document", id: deckId },
      asker: ada,
      subject: '=HYPERLINK("http://evil.test","x")',
      body: "+cmd|' /C calc'!A0",
      internalNote: "not exported",
    });
    await authAge(owner, 0);
    const res = await request("/api/v1/data-room/qa/export?format=csv", { cookie: owner.cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-fundroom-export-truncated")).toBeNull();
    expect(res.headers.get("x-seedhost-export-truncated")).toBeNull();
    const text = await res.text();
    const table = parseCsv(text);
    expect(table[0]).toEqual([...QA_EXPORT_COLUMNS]);
    const col = (name: string) => QA_EXPORT_COLUMNS.indexOf(name as never);
    const row = table.find((r) => r[col("id")] === evil);
    expect(row?.[col("subject")]).toBe('\'=HYPERLINK("http://evil.test","x")');
    expect(row?.[col("question")]).toBe("'+cmd|' /C calc'!A0");
    expect(row?.[col("asker_email")]).toBe("ada@investor.test");
    expect(row?.[col("asker_name")]).toBe("ada");
    expect(row?.[col("target_title")]).toBe("Board deck");
    expect(row?.[col("status")]).toBe("open");
    expect(text).not.toContain("not exported");
    const [count] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM dataroom.qa_question WHERE workspace_id = $1",
      [acmeId],
    );
    expect(table.length - 1).toBe(count?.n);
    const [audit] = await sql<{ meta: { rows: number } }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'qa.exported'
        ORDER BY occurred_at DESC LIMIT 1`,
      [acmeId],
    );
    expect(audit?.meta.rows).toBe(count?.n);
  });

  it("over the row cap: still 200, the first 50 000 rows, and X-Fundroom-Export-Truncated: true", async () => {
    await sql(
      `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id, source, status,
          subject, body)
       SELECT $1, 'document', $2, 'staff', 'open', 'bulk-trunc', 'bulk ' || g
         FROM generate_series(1, 50001) g`,
      [acmeId, deckId],
    );
    try {
      await authAge(owner, 0);
      const res = await request("/api/v1/data-room/qa/export", { cookie: owner.cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-fundroom-export-truncated")).toBe("true");
      // A-2: the pre-rename spelling rides along for one minor release.
      expect(res.headers.get("x-seedhost-export-truncated")).toBe("true");
      const lines = (await res.text()).split("\r\n").filter((l) => l.length > 0);
      expect(lines.length - 1).toBe(50_000);
      const [audit] = await sql<{ meta: { rows: number; truncated: boolean } }>(
        `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'qa.exported'
          ORDER BY occurred_at DESC LIMIT 1`,
        [acmeId],
      );
      expect(audit?.meta).toEqual({ rows: 50_000, truncated: true });
    } finally {
      await sql(
        "DELETE FROM dataroom.qa_question WHERE workspace_id = $1 AND subject = 'bulk-trunc'",
        [acmeId],
      );
    }
  }, 120_000);

  it("needs data-room.qa_manage and a fresh session", async () => {
    expect((await request("/api/v1/data-room/qa/export", { cookie: editor.cookie })).status).toBe(
      403,
    );
    expect((await request("/api/v1/data-room/qa/export", { cookie: ada.cookie })).status).toBe(404);
    await authAge(owner, 11 * 60_000);
    try {
      const stale = await request("/api/v1/data-room/qa/export", { cookie: owner.cookie });
      expect(stale.status).toBe(403);
      expect(await json(stale)).toMatchObject({ error: { code: "step_up_required" } });
    } finally {
      await authAge(owner, 0);
    }
  });
});

describe("CSV import (POST /data-room/qa/import)", () => {
  const post = (csv: string, dryRun: boolean, actor = owner) =>
    request("/api/v1/data-room/qa/import", {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({ csv, dryRun }),
    });
  const header = "target_kind,target_id,subject,question,answer,category,publish\n";
  const count = async () =>
    (
      await sql<{ n: number }>(
        "SELECT count(*)::int AS n FROM dataroom.qa_question WHERE workspace_id = $1 AND source = 'import'",
        [acmeId],
      )
    )[0]?.n;

  it("reports per-line errors and writes nothing (dry run or not)", async () => {
    await authAge(owner, 0);
    const trashed = await doc(financials, "Binned");
    await sql("UPDATE dataroom.document SET deleted_at = now() WHERE id = $1", [trashed]);
    const csv =
      header +
      `page,${deckId},S,Q,,,\n` + // 2: bad kind
      `document,${randomUUID()},S,Q,,,\n` + // 3: no such document
      `document,${trashed},S,Q,,,\n` + // 4: in the trash
      `document,${deckId},S,Q,,,true\n` + // 5: publish without an answer
      `document,${deckId},Fine,Fine question,,,\n`; // 6: fine
    for (const dryRun of [true, false]) {
      const res = await post(csv, dryRun);
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await json<{ rows: number; created: number; errors: { line: number }[] }>(res);
      expect(body.rows).toBe(5);
      expect(body.created).toBe(0);
      expect(body.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    }
    expect(await count()).toBe(0);
  });

  it("refuses a bad header and too many rows as a whole", async () => {
    const bad = await json<{ errors: { line: number; message: string }[] }>(
      await post("target_kind,subject,question,surprise\nfolder,S,Q,x\n", true),
    );
    expect(bad.errors).toEqual([{ line: 1, message: expect.stringContaining("surprise") }]);
    const many = header + `folder,,S,Q,,,\n`.repeat(501);
    const tooMany = await json<{ rows: number; errors: { line: number }[] }>(
      await post(many, true),
    );
    expect(tooMany).toMatchObject({ rows: 501, errors: [{ line: 1 }] });
  });

  it("imports all rows; published ones are live in search, the rest wait in the inbox", async () => {
    const csv =
      header +
      `document,${deckId},Cap table,Who holds the options?,The pool holds platypusoptions,Legal,true\n` +
      `folder,,General,Anything else?,,,\n` +
      `folder,${financials.id},Forecast,Is there a forecast?,Draft forecast answer,,false\n`;
    const dry = await json<{ created: number; errors: unknown[] }>(await post(csv, true));
    expect(dry).toMatchObject({ created: 0, errors: [] });
    expect(await count()).toBe(0);
    const outboxBefore = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.outbox WHERE workspace_id = $1 AND topic LIKE 'qa.%'",
      [acmeId],
    );
    const res = await post(csv, false);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ rows: 3, created: 3, errors: [] });
    const rows = await sql<{
      id: string;
      subject: string;
      status: string;
      source: string;
      folder_id: string | null;
      public_text: string | null;
      visibility: string | null;
      due_at: Date | null;
      category: string | null;
    }>(
      `SELECT id, subject, status::text, source, folder_id, public_text, visibility, due_at, category
         FROM dataroom.qa_question WHERE workspace_id = $1 AND source = 'import'`,
      [acmeId],
    );
    const by = (s: string) => rows.find((r) => r.subject === s);
    expect(by("Cap table")).toMatchObject({
      status: "published",
      visibility: "target",
      public_text: "Cap table\n\nWho holds the options?",
      category: "Legal",
      due_at: null,
    });
    expect(by("General")).toMatchObject({ status: "open", folder_id: rootId });
    // No asker, no SLA clock.
    expect(by("General")?.due_at).toBeNull();
    expect(by("Forecast")?.due_at).toBeNull();
    expect(by("Forecast")).toMatchObject({ status: "open", folder_id: financials.id });
    expect(refs(await eventually(ada, "platypusoptions", (h) => h.length > 0))).toEqual([
      `qa:${by("Cap table")?.id}`,
    ]);
    // imports notify nobody
    const outboxAfter = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.outbox WHERE workspace_id = $1 AND topic LIKE 'qa.%'",
      [acmeId],
    );
    expect(outboxAfter[0]?.n).toBe(outboxBefore[0]?.n);
    const [audit] = await sql<{ meta: Record<string, number> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'qa.imported'`,
      [acmeId],
    );
    expect(audit?.meta).toMatchObject({ created: 3, published: 1 });
  });

  it("holds publish=true rows for approval while the workspace requires it", async () => {
    await setQa({ requireApproval: true });
    try {
      const res = await post(
        `${header}document,${deckId},Approval needed,Q?,Answer echidnaword,,true\n`,
        false,
      );
      expect(await json(res)).toMatchObject({ created: 1, errors: [] });
      const [row] = await sql<{ id: string; status: string; submitted: Date | null }>(
        `SELECT q.id, q.status::text, a.submitted_at AS submitted
           FROM dataroom.qa_question q JOIN dataroom.qa_answer a ON a.question_id = q.id
          WHERE q.subject = 'Approval needed'`,
      );
      expect(row?.status).toBe("awaiting_approval");
      expect(row?.submitted).not.toBeNull();
      expect(await qaEntries([row?.id ?? ""])).toEqual([]);
      expect(await search(owner, "echidnaword")).toEqual([]);
    } finally {
      await setQa({ requireApproval: false });
    }
  });

  it("reports the physical line a record starts on (blank lines and quoted line breaks count)", async () => {
    await authAge(owner, 0);
    const csv =
      header + // line 1
      "\n" + // 2: blank
      'folder,,Multi,"a question\nover\r\nthree lines",,,\n' + // 3-5
      "page,,S,Q,,,\r\n" + // 6: bad kind
      '"folder",,,Q,,,\n'; // 7: no subject
    const body = await json<{ errors: { line: number }[] }>(await post(csv, true));
    expect(body.errors.map((e) => e.line)).toEqual([6, 7]);
  });

  it("refuses a NUL character in any cell as an error on its line", async () => {
    const csv =
      header +
      "folder,,Fine,Fine question,,,\n" +
      "folder,,S\u0000x,Q,,,\n" +
      "folder,,S,Q,,cat\u0000,\n";
    for (const dryRun of [true, false]) {
      const res = await post(csv, dryRun);
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await json<{ created: number; errors: { line: number; message: string }[] }>(
        res,
      );
      expect(body.created).toBe(0);
      expect(body.errors).toEqual([
        { line: 3, message: expect.stringContaining("NUL") },
        { line: 4, message: expect.stringContaining("NUL") },
      ]);
    }
  });

  it("accepts a 1 MiB CSV whatever JSON escaping does to it (route body limit)", async () => {
    // ~0.95 MiB of CSV that JSON-encodes to ~5.7 MiB (every \u0001 becomes 6 bytes): far over
    // the API's default 1 MiB body limit.
    const row = `folder,,S,${"\u0001".repeat(2_300)},,,\n`;
    const csv = header + row.repeat(430);
    expect(Buffer.byteLength(csv)).toBeLessThanOrEqual(1_048_576);
    expect(JSON.stringify({ csv, dryRun: true }).length).toBeGreaterThan(5 * 1_048_576);
    const res = await post(csv, true);
    expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
    expect(await json(res)).toMatchObject({ rows: 430, errors: [] });
    // Other routes keep the default limit.
    const other = await request("/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: rootId, name: "x".repeat(2 * 1_048_576) }),
    });
    expect(other.status).toBe(413);
  });

  it("re-imports its own export: export-only columns ignored, formula guard removed", async () => {
    await authAge(owner, 0);
    const exported = await (
      await request("/api/v1/data-room/qa/export", { cookie: owner.cookie })
    ).text();
    const rowsOut = parseCsv(exported).length - 1;
    const before = await count();
    const res = await post(exported, false);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json(res)).toEqual({ rows: rowsOut, created: rowsOut, errors: [] });
    expect(((await count()) ?? 0) - (before ?? 0)).toBe(rowsOut);
    const [evil] = await sql<{ subject: string; body: string }>(
      `SELECT subject, body FROM dataroom.qa_question
        WHERE workspace_id = $1 AND source = 'import' AND subject LIKE '%HYPERLINK%'`,
      [acmeId],
    );
    expect(evil).toEqual({
      subject: '=HYPERLINK("http://evil.test","x")',
      body: "+cmd|' /C calc'!A0",
    });
  });

  it("keeps a leading apostrophe verbatim in a file that is not our export", async () => {
    await authAge(owner, 0);
    // Import columns only (not the export's header): the apostrophe is the author's text.
    const res = await post(`${header}folder,,'=Verbatim subject,'+verbatim question,,,\n`, false);
    expect(await json(res)).toMatchObject({ created: 1, errors: [] });
    const [row] = await sql<{ subject: string; body: string }>(
      `SELECT subject, body FROM dataroom.qa_question
        WHERE workspace_id = $1 AND source = 'import' AND subject LIKE '%Verbatim subject'`,
      [acmeId],
    );
    expect(row).toEqual({ subject: "'=Verbatim subject", body: "'+verbatim question" });
  });

  it("strips the formula guard when the header is exactly the export's columns (any order)", async () => {
    await authAge(owner, 0);
    const cols = [...QA_EXPORT_COLUMNS].reverse();
    const cell: Record<string, string> = {
      target_kind: "folder",
      subject: "'=Guarded subject",
      question: "'@guarded question",
    };
    const csv = `${cols.join(",")}\n${cols.map((c) => cell[c] ?? "").join(",")}\n`;
    const res = await post(csv, false);
    expect(await json(res)).toMatchObject({ created: 1, errors: [] });
    const [row] = await sql<{ subject: string; body: string }>(
      `SELECT subject, body FROM dataroom.qa_question
        WHERE workspace_id = $1 AND source = 'import' AND subject LIKE '%Guarded subject'`,
      [acmeId],
    );
    expect(row).toEqual({ subject: "=Guarded subject", body: "@guarded question" });
  });

  it("needs data-room.qa_manage and a fresh session", async () => {
    const csv = `${header}folder,,S,Q,,,\n`;
    expect((await post(csv, true, editor)).status).toBe(403);
    expect((await post(csv, true, ada)).status).toBe(404);
    await authAge(owner, 11 * 60_000);
    try {
      expect((await post(csv, true)).status).toBe(403);
    } finally {
      await authAge(owner, 0);
    }
  });
});

/*
 * Fix round 3: ONE lock order for every Q&A write path —
 *   question row(s) FOR UPDATE (by id) → workspace row FOR SHARE → search entries →
 *   audit chain (pg_advisory_xact_lock(24301, …), every audit insert) → outbox insert.
 * Each test below deadlocked before its fix (see the E3.3 fix-round-3 report).
 */
describe("lock order (fix round 3)", () => {
  const HOUR = 3_600_000;
  const deadlocks = async () => {
    await pg.pool.query("SELECT pg_stat_clear_snapshot()");
    const [r] = (
      await pg.pool.query<{ n: string }>(
        "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
      )
    ).rows;
    return Number(r?.n ?? 0);
  };
  // pg_stat counters reach the view at most once a second
  const settle = () => new Promise((r) => setTimeout(r, 1_500));
  const staffPatch = (id: string, body: Record<string, unknown>) =>
    request(`/api/v1/data-room/qa/inbox/${id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify(body),
    });
  const qaEntryDelete =
    "DELETE FROM core.search_entry WHERE workspace_id = $1 AND module = 'data-room' AND kind = 'qa' AND ref_id = $2";

  /**
   * Plays a staff action by hand, pausing it between its steps: row-locks the question (as
   * `staffTx` does), runs `other`, waits until `other` blocks on that row lock, then does what
   * the staff action does next — write the question's search entry, then audit — and commits.
   */
  async function staffActionAround<T>(questionId: string, other: () => Promise<T>): Promise<T> {
    const staffTx = await pg.pool.connect();
    try {
      await staffTx.query("BEGIN");
      await staffTx.query("SET LOCAL lock_timeout = '20s'");
      const [{ pid }] = (await staffTx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      await staffTx.query("SELECT id FROM dataroom.qa_question WHERE id = $1 FOR UPDATE", [
        questionId,
      ]);
      const pending = other();
      pending.catch(() => undefined); // awaited below
      await waitFor(async () => {
        const { rows } = await pg.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l
             WHERE NOT l.granted AND l.pid <> $1 AND $1 = ANY(pg_blocking_pids(l.pid))`,
          [pid],
        );
        return (rows[0]?.n ?? 0) > 0 ? true : undefined;
      }, 20_000);
      await staffTx.query(qaEntryDelete, [acmeId, questionId]);
      await staffTx.query("SELECT pg_advisory_xact_lock(24301, hashtext($1::uuid::text))", [
        acmeId,
      ]);
      await staffTx.query("COMMIT");
      return await pending;
    } catch (error) {
      await staffTx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      staffTx.release();
    }
  }

  it("D1: the SLA sweep and concurrent staff edits never deadlock (candidates locked first, SKIP LOCKED)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(
        await question({
          target: { kind: "document", id: deckId },
          subject: `Sweep race ${i}`,
          dueAt: new Date(Date.now() - HOUR),
        }),
      );
    await settle();
    const before = await deadlocks();
    const statuses: number[] = [];
    let failed = 0;
    let reminded = 0;
    try {
      for (let round = 0; round < 20; round++) {
        await sql(
          `UPDATE dataroom.qa_question SET overdue_notified_at = NULL, due_soon_notified_at = NULL
            WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        const [summary, ...rs] = await Promise.all([
          runQaSla(services(), { workspaceId: acmeId, at: new Date() }),
          ...ids.map((id, i) => staffPatch(id, { internalNote: `round ${round} #${i}` })),
        ]);
        failed += summary.failed;
        reminded += summary.overdue;
        statuses.push(...rs.map((r) => r.status));
      }
    } finally {
      await sql(
        `UPDATE dataroom.qa_question SET status = 'closed', closed_reason = 'declined', closed_at = now()
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    expect(failed).toBe(0);
    // rows a staff edit held were skipped for the next run, the rest were reminded
    expect(reminded).toBeGreaterThan(0);
    await settle();
    expect(await deadlocks()).toBe(before);
  }, 180_000);

  it("D2: renaming the target while staff edit its published question's wording never deadlocks", async () => {
    const q = await question({
      target: { kind: "document", id: deckId },
      status: "published",
      publicText: "Rename race",
      answer: "rename race answer",
    });
    await index(q);
    await settle();
    const before = await deadlocks();
    const statuses: number[] = [];
    let stale = 0;
    try {
      for (let round = 0; round < 20; round++) {
        const rs = await Promise.all([
          request(`/api/v1/data-room/documents/${deckId}`, {
            method: "PATCH",
            cookie: owner.cookie,
            body: JSON.stringify({ title: round % 2 === 0 ? "Board deck v2" : "Board deck" }),
          }),
          staffPatch(q, { publicText: `Rename race ${round}` }),
        ]);
        statuses.push(...rs.map((r) => r.status));
        // whichever committed last re-read what the other committed: never a stale entry
        stale += (await qaEntries([q]))[0]?.body.startsWith(`Rename race ${round}\n`) ? 0 : 1;
      }
    } finally {
      await sql("UPDATE dataroom.document SET title = 'Board deck' WHERE id = $1", [deckId]);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    await settle();
    expect(await deadlocks()).toBe(before);
    expect(stale).toBe(0);
  }, 120_000);

  it("D2: purging a document row-locks its questions before touching their entries", async () => {
    const tmpDoc = await doc(financials, "Purge race");
    const q = await question({
      target: { kind: "document", id: tmpDoc },
      status: "published",
      publicText: "Purge race",
      answer: "purge race answer",
    });
    await index(q);
    // binned with its entry still there (the purge must remove it itself)
    await sql("UPDATE dataroom.document SET deleted_at = now() WHERE id = $1", [tmpDoc]);
    expect(await qaEntries([q])).toHaveLength(1);
    await authAge(owner, 0);
    await settle();
    const before = await deadlocks();
    const purge = await staffActionAround(q, () =>
      request(`/api/v1/data-room/documents/${tmpDoc}/purge`, {
        method: "DELETE",
        cookie: owner.cookie,
      }),
    );
    expect(purge.status, await purge.clone().text()).toBe(200);
    expect(await sql("SELECT 1 FROM dataroom.qa_question WHERE id = $1", [q])).toEqual([]);
    expect(await qaEntries([q])).toEqual([]);
    await settle();
    expect(await deadlocks()).toBe(before);
  }, 60_000);

  it("D2: purge and a real staff edit on the doomed question race without a deadlock", async () => {
    await settle();
    const before = await deadlocks();
    const statuses: number[] = [];
    for (let round = 0; round < 10; round++) {
      const tmpDoc = await doc(financials, `Purge race ${round}`);
      const q = await question({
        target: { kind: "document", id: tmpDoc },
        status: "published",
        publicText: "Purge race",
        answer: "purge race answer",
      });
      await index(q);
      await sql("UPDATE dataroom.document SET deleted_at = now() WHERE id = $1", [tmpDoc]);
      await authAge(owner, 0);
      const [purge, edit] = await Promise.all([
        request(`/api/v1/data-room/documents/${tmpDoc}/purge`, {
          method: "DELETE",
          cookie: owner.cookie,
        }),
        staffPatch(q, { publicText: `Purge race ${round}` }),
      ]);
      statuses.push(purge.status);
      // the edit either lands first or finds the question gone with its document
      expect([200, 404]).toContain(edit.status);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    await settle();
    expect(await deadlocks()).toBe(before);
  }, 120_000);

  it("D3: erasure row-locks the subject's questions before unindexing them", async () => {
    const fay = await member(acmeId, "fay@investor.test", "external", "investor");
    const q = await question({
      target: { kind: "document", id: deckId },
      status: "published",
      asker: fay,
      publicText: "Fay public",
      answer: "fay answer",
    });
    await index(q);
    expect(await qaEntries([q])).toHaveLength(1);
    await authAge(owner, 0);
    await settle();
    const before = await deadlocks();
    const requestId = await staffActionAround(q, async () => {
      const res = await request("/api/v1/compliance/erasure-requests", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ membershipId: fay.membershipId }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const { id } = await json<{ id: string }>(res);
      // the dispatcher's transaction runs the erasure step: wait on it, not on the request
      await waitFor(async () => {
        const [r] = await sql<{ counts: Record<string, number> }>(
          `SELECT counts FROM core.dsar_step WHERE request_id = $1 AND module = 'data-room'`,
          [id],
        );
        return r;
      }, 40_000);
      return id;
    });
    const [step] = await sql<{ counts: Record<string, number> }>(
      `SELECT counts FROM core.dsar_step WHERE request_id = $1 AND module = 'data-room'`,
      [requestId],
    );
    expect(step?.counts).toEqual({ questions: 1, unpublished: 1 });
    expect(await qaEntries([q])).toEqual([]);
    await settle();
    expect(await deadlocks()).toBe(before);
  }, 90_000);

  it("settings PATCH turning Q&A off writes its entry removals before it audits", async () => {
    // A document trash (or rename) writes search entries and then audits. The PATCH holds the
    // workspace row, then must write entries before the audit chain — not the other way round.
    const q = await question({
      target: { kind: "document", id: deckId },
      status: "published",
      publicText: "Flip race",
      answer: "flip race answer",
    });
    await index(q);
    await authAge(owner, 0);
    await settle();
    const before = await deadlocks();
    const trashTx = await pg.pool.connect();
    let patch: Response;
    try {
      await trashTx.query("BEGIN");
      await trashTx.query("SET LOCAL lock_timeout = '20s'");
      const [{ pid }] = (await trashTx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows as [{ pid: number }];
      await trashTx.query(qaEntryDelete, [acmeId, q]); // the trash's entry write
      const pending = request("/api/v1/data-room/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ qa: { enabled: false } }),
      });
      await waitFor(async () => {
        const { rows } = await pg.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l
             WHERE NOT l.granted AND l.pid <> $1 AND $1 = ANY(pg_blocking_pids(l.pid))`,
          [pid],
        );
        return (rows[0]?.n ?? 0) > 0 ? true : undefined;
      }, 20_000);
      // the trash now audits
      await trashTx.query("SELECT pg_advisory_xact_lock(24301, hashtext($1::uuid::text))", [
        acmeId,
      ]);
      await trashTx.query("COMMIT");
      patch = await pending;
    } catch (error) {
      await trashTx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      trashTx.release();
    }
    try {
      expect(patch.status, await patch.clone().text()).toBe(200);
      await settle();
      expect(await deadlocks()).toBe(before);
    } finally {
      const back = await request("/api/v1/data-room/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ qa: { enabled: true } }),
      });
      expect(back.status).toBe(200);
    }
  }, 60_000);
});
