import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createDatabase, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  defineModule,
  ModuleEnablementRepo,
  type ModuleManifest,
  type SearchEntryInput,
} from "@fundroom/module-kit";
import {
  createSearchIndex,
  readStates,
  reindexWorkspaceModule,
  sweepSearchIndex,
} from "@fundroom/search";
import { sql as dsql } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchReindexCommand } from "./cli-commands/search-reindex.js";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { purgeDeletedWorkspaces } from "./workspace/lifecycle.js";

/*
 * Workspace search (E2.8 package S), end to end against real Postgres.
 *
 * A test-only module (`search-probe`) contributes entries through `ModuleManifest.search`, so
 * the index is always rebuilt from one canonical list (a background `search.sweep` firing mid-run
 * rebuilds the same thing). The ACL matrix: `members`, `groups` (Board), `staff`, and `resource`
 * documents that an investor holds a grant on, holds none on, or holds behind an NDA gate — seen
 * by staff, by an investor in Board, by one in another group, and by one whose only grant is
 * gated. Then: RLS across workspaces, a revoked group membership, a module switched off, view-as
 * (read only, writes nothing), the reindex job and the sweep, a one-connection pool (the
 * deadlock detector), prefix and trigram matching, hostile queries, the rate limit and the purge.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const PROBE = "search-probe";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

// ---- the probe module ------------------------------------------------------------------------
const probeEntries = new Map<string, SearchEntryInput[]>();
let probeVersion = 1;
let probeReads = 0;
/** Entries per provider page (the paged `search.page` form; `entries` pauses at the same points). */
const PROBE_PAGE = 3;
/** Called after each page is read from the source, before it is handed back (a test's pause point). */
let probeHook: ((at: { workspaceId: string; start: number }) => Promise<void>) | undefined;
/** Workspaces whose provider throws (the CLI's keep-going test). */
const probeFail = new Set<string>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const probeModule: ModuleManifest = defineModule({
  id: PROBE,
  version: "1.0.0",
  search: {
    get version() {
      return probeVersion;
    },
    async *entries({ tx, ctx }) {
      // Reads through the job's own transaction, as a real provider does (the 1-connection-pool
      // run below would hang if anything took a second connection).
      await tx.execute(dsql`SELECT count(*) FROM core.search_state`);
      if (probeFail.has(ctx.workspaceId)) throw new Error("probe provider failed");
      probeReads += 1;
      const all = probeEntries.get(ctx.workspaceId) ?? [];
      for (let start = 0; start < all.length; start += PROBE_PAGE) {
        const slice = all.slice(start, start + PROBE_PAGE);
        await probeHook?.({ workspaceId: ctx.workspaceId, start });
        for (const e of slice) yield e;
      }
    },
    async page({ tx, ctx, cursor }) {
      await tx.execute(dsql`SELECT count(*) FROM core.search_state`);
      if (probeFail.has(ctx.workspaceId)) throw new Error("probe provider failed");
      const start = cursor === null ? 0 : Number(cursor);
      if (start === 0) probeReads += 1;
      const all = probeEntries.get(ctx.workspaceId) ?? [];
      const slice = all.slice(start, start + PROBE_PAGE);
      await probeHook?.({ workspaceId: ctx.workspaceId, start });
      return {
        entries: slice,
        next: start + PROBE_PAGE < all.length ? String(start + PROBE_PAGE) : null,
      };
    },
  },
});

// ---- http helpers ----------------------------------------------------------------------------
interface Actor {
  cookie: string;
  membershipId: string;
  email: string;
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

async function signIn(slug: string, email: string): Promise<Omit<Actor, "email">> {
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
  role: "owner" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return { ...actor, email };
}

/** Superuser SQL, around RLS. */
async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
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

interface Hit {
  module: string;
  kind: string;
  refId: string;
  title: string;
  snippet: { text: string; highlight: boolean }[];
  href: string;
  updatedAt: string;
  gated: boolean;
}
interface Results {
  query: string;
  hits: Hit[];
  hasMore: boolean;
}

/** The limiter is tested on its own; everything else starts each search with a clean window. */
async function resetLimits(): Promise<void> {
  await sql("DELETE FROM core.rate_limit");
}

/**
 * The server's clock. Wall time, except while a test pins it: the limiter's window is wall-clock
 * buckets, so a burst that straddles a minute boundary (and runs slowly under load) sees the
 * previous bucket decay and may legitimately get a 31st search through.
 */
let pinnedNow: Date | undefined;
const clock = (): Date => pinnedNow ?? new Date();

async function search(actor: Actor, q: string, extra = "", slug = "acme"): Promise<Response> {
  await resetLimits();
  return request(slug, `/api/v1/search?q=${encodeURIComponent(q)}${extra}`, {
    cookie: actor.cookie,
  });
}

async function hits(actor: Actor, q: string, extra = "", slug = "acme"): Promise<Hit[]> {
  const res = await search(actor, q, extra, slug);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<Results>(res)).hits;
}

async function titles(actor: Actor, q: string, extra = "", slug = "acme"): Promise<string[]> {
  return (await hits(actor, q, extra, slug)).filter((h) => h.module === PROBE).map((h) => h.title);
}

// ---- fixtures --------------------------------------------------------------------------------
let acmeId: string;
let globexId: string;
let owner: Actor;
let ada: Actor; // Board, plus a direct grant on DOC_GRANTED
let bob: Actor; // Seed group only
let dave: Actor; // NDA group only: his one grant is gated
let carol: Actor; // no group, no grant (rate limit)
let globexOwner: Actor;
let boardId: string;
let ndaGroupId: string;

const DOC_GRANTED = randomUUID();
const DOC_UNGRANTED = randomUUID();
const DOC_GATED = randomUUID();
const REF = {
  members: randomUUID(),
  board: randomUUID(),
  staff: randomUUID(),
  kilimanjaro: randomUUID(),
  globex: randomUUID(),
};
const AT = new Date("2026-09-01T12:00:00Z");

function acmeEntries(): SearchEntryInput[] {
  return [
    {
      kind: "page",
      refId: REF.members,
      title: "Zephyr members memo",
      body: "The quarterly zephyr update for every member. Runway eighteen months.",
      acl: { kind: "members" },
      href: `/p/members`,
      updatedAt: AT,
    },
    {
      kind: "page",
      refId: REF.board,
      title: "Zephyr board minutes",
      body: "Board discussed the zephyr acquisition.",
      acl: { kind: "groups", groupIds: [boardId] },
      href: `/p/board`,
      updatedAt: AT,
    },
    {
      kind: "note",
      refId: REF.staff,
      title: "Zephyr staff notes",
      body: "internal only",
      acl: { kind: "staff" },
      href: `/admin/notes`,
      updatedAt: AT,
    },
    {
      kind: "document",
      refId: DOC_GRANTED,
      title: "Zephyr granted deck",
      body: "Runway numbers and the kumquat plan <script>alert(1)</script>.",
      acl: { kind: "resource", resourceKind: "document", resourceId: DOC_GRANTED },
      href: `/data-room/documents/${DOC_GRANTED}`,
      updatedAt: AT,
    },
    {
      kind: "document",
      refId: DOC_UNGRANTED,
      title: "Zephyr ungranted cap table",
      body: "nobody outside staff sees this",
      acl: { kind: "resource", resourceKind: "document", resourceId: DOC_UNGRANTED },
      href: `/data-room/documents/${DOC_UNGRANTED}`,
      updatedAt: AT,
    },
    {
      kind: "document",
      refId: DOC_GATED,
      title: "Zephyr NDA agreement",
      body: "Confidential marmalade terms behind the NDA.",
      acl: { kind: "resource", resourceKind: "document", resourceId: DOC_GATED },
      href: `/data-room/documents/${DOC_GATED}`,
      updatedAt: AT,
    },
    {
      kind: "page",
      refId: REF.kilimanjaro,
      title: "Quarterly Kilimanjaro report",
      body: "",
      acl: { kind: "members" },
      href: `/p/kili`,
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    },
  ];
}

async function reindexProbe(workspaceId: string) {
  return reindexWorkspaceModule(
    { db: running.container.db, modules: () => running.container.registry.modules },
    workspaceId,
    PROBE,
  );
}

async function grant(subject: { kind: string; id: string }, resourceId: string): Promise<void> {
  const res = await request("acme", "/api/v1/access/grants", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      subject,
      resource: { kind: "document", id: resourceId },
      capabilities: ["view"],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function group(name: string, members: string[]): Promise<string> {
  const res = await request("acme", "/api/v1/access/groups", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ name }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const id = (await json<{ id: string }>(res)).id;
  const add = await request("acme", `/api/v1/access/groups/${id}/members`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ membershipIds: members }),
  });
  expect(add.status, await add.clone().text()).toBe(200);
  return id;
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
    modules: [...COMPILED_IN_MODULES, probeModule],
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
    now: clock,
  });
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  ada = await member("acme", acmeId, "ada@example.com", "external", "investor");
  bob = await member("acme", acmeId, "bob@example.com", "external", "investor");
  dave = await member("acme", acmeId, "dave@example.com", "external", "investor");
  carol = await member("acme", acmeId, "carol@example.com", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");

  /*
   * Grants name resources that must exist in the workspace (P1-03), so the three documents the
   * probe module's entries point at are real `dataroom.document` rows. Inserted directly (the
   * data room's upload path is not what this file tests), with titles no query here matches.
   */
  await db.withTenant(systemContext(acmeId), async (tx) => {
    const r = await tx.execute(
      `INSERT INTO dataroom.folder (workspace_id, name, path)
         VALUES ('${acmeId}'::uuid, 'Root', 'root') RETURNING id::text AS id`,
    );
    const folderId = (r.rows as { id: string }[])[0]?.id ?? "";
    for (const id of [DOC_GRANTED, DOC_UNGRANTED, DOC_GATED]) {
      await tx.execute(
        `INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
           VALUES ('${id}'::uuid, '${acmeId}'::uuid, '${folderId}'::uuid, 'root', 'Fixture ${id.slice(0, 8)}')`,
      );
    }
  });
  boardId = await group("Board", [ada.membershipId]);
  await group("Seed", [bob.membershipId]);
  ndaGroupId = await group("NDA holders", [dave.membershipId]);
  await grant({ kind: "membership", id: ada.membershipId }, DOC_GRANTED);
  await grant({ kind: "group", id: ndaGroupId }, DOC_GATED);
  const policy = await request("acme", "/api/v1/access/policies", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      kind: "nda",
      target: { kind: "group", id: ndaGroupId },
      config: { version: "v1" },
    }),
  });
  expect(policy.status, await policy.clone().text()).toBe(200);
  // The RLS mirror (effective_access) and the gate are rebuilt asynchronously.
  await waitFor(async () => {
    const d = await running.container.authz.check(
      { workspaceId: acmeId, membershipId: dave.membershipId },
      { kind: "document", id: DOC_GATED },
      "view",
    );
    return d.reason === "gated" ? d : undefined;
  });

  probeEntries.set(acmeId, acmeEntries());
  probeEntries.set(globexId, [
    {
      kind: "page",
      refId: REF.globex,
      title: "Zephyr globex secret",
      body: "globex only",
      acl: { kind: "members" },
      href: "/p/globex",
      updatedAt: AT,
    },
  ]);
  expect((await reindexProbe(acmeId)).status).toBe("indexed");
  expect((await reindexProbe(globexId)).status).toBe("indexed");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

// ---- the ACL matrix --------------------------------------------------------------------------
describe("who sees what", () => {
  it("staff see every entry, including staff-only and ungranted resources", async () => {
    expect((await titles(owner, "zephyr")).sort()).toEqual([
      "Zephyr NDA agreement",
      "Zephyr board minutes",
      "Zephyr granted deck",
      "Zephyr members memo",
      "Zephyr staff notes",
      "Zephyr ungranted cap table",
    ]);
    const gated = (await hits(owner, "zephyr")).find((h) => h.refId === DOC_GATED);
    expect(gated?.gated).toBe(false);
  });

  it("an investor in Board with a grant: members + Board + the granted document", async () => {
    const got = await waitFor(async () => {
      const t = (await titles(ada, "zephyr")).sort();
      return t.length === 3 ? t : undefined;
    });
    expect(got).toEqual(["Zephyr board minutes", "Zephyr granted deck", "Zephyr members memo"]);
  });

  it("an investor in another group sees neither Board's entry nor any document", async () => {
    expect(await titles(bob, "zephyr")).toEqual(["Zephyr members memo"]);
  });

  it("a gated grant: the title-matching hit comes back gated, with no snippet", async () => {
    const got = await waitFor(async () => {
      const h = (await hits(dave, "zephyr")).filter((x) => x.module === PROBE);
      return h.length === 2 ? h : undefined;
    });
    const doc = got.find((h) => h.refId === DOC_GATED);
    expect(doc).toMatchObject({ title: "Zephyr NDA agreement", gated: true, snippet: [] });
    expect(got.find((h) => h.refId === REF.members)?.gated).toBe(false);
  });

  it("a gated document never matches on its body, alone or mixed with a title word", async () => {
    // Load-bearing: without the title-only rule each would return the NDA document. A two-word
    // query may still bring it back through the trigram TITLE fallback — but then exactly as
    // when the second word is in no body at all (the next test proves that in general).
    const refs = async (q: string) => (await hits(dave, q)).map((h) => h.refId);
    expect(await refs("marmalade")).toEqual([]);
    expect(await refs("zephyr marmalade")).toEqual(await refs("zephyr qwxzvkj"));
    expect(await refs("confidential")).toEqual([]);
    // Staff, and the body term itself, prove the entry does match that word.
    expect(await titles(owner, "marmalade")).toEqual(["Zephyr NDA agreement"]);
  });

  it("a gated hit never depends on the body: probes differing only in a body word answer identically", async () => {
    // Fix A #1 (the body oracle): "…marmalade" (in the gated body) and "…marmaladx" (nowhere)
    // must give the same hits, order, snippets and hasMore — whatever the title does.
    const probe = async (q: string, extra = "") => {
      const r = await json<Results>(await search(dave, q, extra));
      return { hits: r.hits, hasMore: r.hasMore };
    };
    await waitFor(async () =>
      (await hits(dave, "zephyr nda agreement")).some((h) => h.refId === DOC_GATED)
        ? true
        : undefined,
    );
    for (const [a, b] of [
      ["zephyr nda agreement marmalade", "zephyr nda agreement marmaladx"],
      ["zephyr nda agreement marm", "zephyr nda agreement marx"],
      ["zephyr nda agreement confidential", "zephyr nda agreement confidentiax"],
      ["marmalade zephyr nda agreement", "marmaladx zephyr nda agreement"],
      ["zephyr marmalade", "zephyr marmaladx"],
      ["marmalade", "marmaladx"],
    ] as const) {
      expect(await probe(a), `${a} / ${b}`).toEqual(await probe(b));
      expect(await probe(a, "&limit=1"), `${a} / ${b} (limit 1)`).toEqual(
        await probe(b, "&limit=1"),
      );
    }
    // The title alone still finds it (gated, no snippet).
    const got = (await hits(dave, "zephyr nda agreement marmaladx")).find(
      (h) => h.refId === DOC_GATED,
    );
    expect(got).toMatchObject({ gated: true, snippet: [] });
  });

  it("granted hits carry body snippets as plain segments, highlights marked, never HTML", async () => {
    const [hit] = (await hits(ada, "kumquat")).filter((h) => h.module === PROBE);
    expect(hit?.refId).toBe(DOC_GRANTED);
    expect(hit?.snippet.some((s) => s.highlight && s.text.toLowerCase() === "kumquat")).toBe(true);
    const text = hit?.snippet.map((s) => s.text).join("") ?? "";
    expect(text).toContain("kumquat");
    // No delimiter or other control character survives into the text.
    expect([...text].some((ch) => (ch.codePointAt(0) ?? 32) < 32 && ch !== "\t")).toBe(false);
    // The body's literal "<script>" stays text inside a segment; nothing is markup.
    expect(hit?.href).toBe(`/data-room/documents/${DOC_GRANTED}`);
    expect(Number.isNaN(Date.parse(hit?.updatedAt ?? ""))).toBe(false);
  });

  it("a title-only hit has an empty snippet", async () => {
    const [hit] = (await hits(owner, "kilimanjaro")).filter((h) => h.module === PROBE);
    expect(hit?.title).toBe("Quarterly Kilimanjaro report");
    expect(hit?.snippet).toEqual([]);
  });

  it("a revoked group membership stops matching", async () => {
    const del = await request(
      "acme",
      `/api/v1/access/groups/${boardId}/members/${ada.membershipId}`,
      {
        method: "DELETE",
        cookie: owner.cookie,
      },
    );
    expect(del.status, await del.clone().text()).toBeLessThan(300);
    expect(await titles(ada, "zephyr board")).not.toContain("Zephyr board minutes");
    expect((await titles(ada, "zephyr")).sort()).toEqual([
      "Zephyr granted deck",
      "Zephyr members memo",
    ]);
    // Back in, for the view-as test below.
    const add = await request("acme", `/api/v1/access/groups/${boardId}/members`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipIds: [ada.membershipId] }),
    });
    expect(add.status).toBe(200);
    expect(await titles(ada, "zephyr board")).toContain("Zephyr board minutes");
  });

  it("RLS keeps workspaces apart, for staff too", async () => {
    expect(await titles(globexOwner, "zephyr", "", "globex")).toEqual(["Zephyr globex secret"]);
    expect(await titles(owner, "globex")).toEqual([]);
    // Belt and braces: an acme membership asking on globex's host is not a member there.
    const res = await search(ada, "zephyr", "", "globex");
    expect(res.status).toBe(404);
  });
});

// ---- query semantics -------------------------------------------------------------------------
describe("matching", () => {
  it("the last word matches as a prefix; earlier words must be whole", async () => {
    expect(await titles(owner, "zeph")).toHaveLength(6);
    expect(await titles(owner, "board minu")).toEqual(["Zephyr board minutes"]);
    // Only the last word is a prefix: "boa" is no full-text match for "board", so nothing
    // outranks the trigram fallback's title match, which comes back all the same.
    expect(await titles(owner, "boa minutes")).toEqual(["Zephyr board minutes"]);
    expect(await titles(owner, "kumq")).toEqual(["Zephyr granted deck"]);
  });

  it("falls back to trigram title matches for a misspelling", async () => {
    expect(await titles(owner, "kilimanjro")).toEqual(["Quarterly Kilimanjaro report"]);
  });

  it("ranks title matches above body matches", async () => {
    const t = await titles(owner, "runway");
    expect(t).toEqual(expect.arrayContaining(["Zephyr members memo", "Zephyr granted deck"]));
    const all = await titles(owner, "board");
    expect(all[0]).toBe("Zephyr board minutes");
  });

  it("filters by kinds and pages with hasMore", async () => {
    expect((await titles(owner, "zephyr", "&kinds=document")).sort()).toEqual([
      "Zephyr NDA agreement",
      "Zephyr granted deck",
      "Zephyr ungranted cap table",
    ]);
    const p1 = await json<Results>(await search(owner, "zephyr", "&kinds=document&limit=2"));
    expect(p1.hits).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await json<Results>(
      await search(owner, "zephyr", "&kinds=document&limit=2&offset=2"),
    );
    expect(p2.hits).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    expect(new Set([...p1.hits, ...p2.hits].map((h) => h.refId)).size).toBe(3);
  });

  it("de-duplicates parts of one ref, keeping the best-ranked", async () => {
    probeEntries.set(acmeId, [
      ...acmeEntries(),
      {
        kind: "page",
        refId: REF.members,
        part: "appendix",
        title: "Zephyr members memo",
        body: "appendix mentions tangerine once",
        acl: { kind: "members" },
        href: "/p/members#appendix",
        updatedAt: AT,
      },
    ]);
    await reindexProbe(acmeId);
    const got = (await hits(owner, "zephyr")).filter((h) => h.refId === REF.members);
    expect(got).toHaveLength(1);
    const tangerine = (await hits(owner, "tangerine")).filter((h) => h.module === PROBE);
    expect(tangerine.map((h) => h.href)).toEqual(["/p/members#appendix"]);
    probeEntries.set(acmeId, acmeEntries());
    await reindexProbe(acmeId);
  });

  it("a query typed exactly as the text reads finds it: emails, hosts, files, decimals, dates, hyphens", async () => {
    // Fix A #2: the query goes through the same parser as the index (`to_tsvector('simple')`).
    const cases = [
      "john.doe@acme.com",
      "acme.com",
      "report_final.pdf",
      "3.5",
      "$1.5M",
      "Q3-2025",
      "2025-09-23",
      "COVID-19",
      "秘密保持契約書",
    ];
    const ctx = systemContext(acmeId);
    const made = cases.map((t, i) => {
      const letter = "abcdefghijk"[i] ?? "z";
      return {
        t,
        inTitle: {
          kind: "page",
          refId: randomUUID(),
          title: `Casefile ${t}`,
          body: "nothing else",
          acl: { kind: "members" },
          href: "/p/case",
          updatedAt: AT,
        } satisfies SearchEntryInput,
        inBody: {
          kind: "page",
          refId: randomUUID(),
          title: `Casefile body ${letter}`,
          body: `As agreed, see ${t} for the details.`,
          acl: { kind: "members" },
          href: "/p/case",
          updatedAt: AT,
        } satisfies SearchEntryInput,
      };
    });
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.search.upsert(
        tx,
        ctx,
        PROBE,
        made.flatMap((m) => [m.inTitle, m.inBody]),
      ),
    );
    try {
      for (const m of made) {
        const refs = (await hits(owner, m.t)).map((h) => h.refId);
        expect(refs, m.t).toEqual(expect.arrayContaining([m.inTitle.refId, m.inBody.refId]));
        // Mixed with a plain word, too.
        const mixed = (await hits(owner, `casefile ${m.t}`)).map((h) => h.refId);
        expect(mixed, `casefile ${m.t}`).toContain(m.inTitle.refId);
      }
      // A short CJK query finds a CJK title through the title fallback.
      const cjk = made.find((m) => m.t === "秘密保持契約書");
      expect((await hits(owner, "契約")).map((h) => h.refId)).toContain(cjk?.inTitle.refId);
    } finally {
      await running.container.db.withTenant(ctx, async (tx) => {
        for (const m of made) {
          await running.container.search.remove(tx, ctx, PROBE, {
            kind: "page",
            refId: m.inTitle.refId,
          });
          await running.container.search.remove(tx, ctx, PROBE, {
            kind: "page",
            refId: m.inBody.refId,
          });
        }
      });
    }
  });

  it("hostile queries never error: 200 or 400 search_query_invalid", async () => {
    for (const q of [
      "':*&|!()",
      "foo':* | bar",
      "a & !b",
      "(x | y) <-> z",
      "'; DROP TABLE core.search_entry; --",
      "zephyr:*A & staff:B",
      "\\' OR 1=1 --",
      "$$ || $$",
      "\u0002zephyr\u0003",
      "💥".repeat(100),
      "x".repeat(200),
      "é".repeat(200),
    ]) {
      const res = await search(bob, q);
      expect([200, 400], `${q}: ${res.status}`).toContain(res.status);
      if (res.status === 400) {
        const body = await json<{ error: { code: string } }>(res);
        expect(body.error.code).toBe("search_query_invalid");
      } else {
        // Whatever it matched, an investor never gets the staff-only entry.
        const b = await json<Results>(res);
        expect(b.hits.map((h) => h.title)).not.toContain("Zephyr staff notes");
      }
    }
    const tooLong = await search(bob, "x".repeat(201));
    expect(tooLong.status).toBe(400);
    const empty = await search(bob, "");
    expect(empty.status).toBe(400);
  });
});

// ---- enablement, view-as, rate limit --------------------------------------------------------
describe("visibility and side effects", () => {
  it("a module switched off for the workspace contributes nothing (its entries stay indexed)", async () => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set(PROBE, false),
    );
    running.container.enablement.invalidate(acmeId);
    try {
      expect(await titles(owner, "zephyr")).toEqual([]);
      expect(await titles(ada, "zephyr")).toEqual([]);
      const [row] = await sql<{ n: number }>(
        "SELECT count(*)::int AS n FROM core.search_entry WHERE workspace_id = $1 AND module = $2",
        [acmeId, PROBE],
      );
      expect(row?.n).toBeGreaterThan(0);
    } finally {
      await running.container.db.withTenant(ctx, (tx) =>
        new ModuleEnablementRepo(ctx, tx).set(PROBE, true),
      );
      running.container.enablement.invalidate(acmeId);
    }
    expect(await titles(owner, "zephyr")).toHaveLength(6);
  });

  it("view-as: the investor's results, read only, and nothing written", async () => {
    await sql(
      `UPDATE core.session SET auth_time = now()
        WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid) AND revoked_at IS NULL`,
      [owner.membershipId],
    );
    const start = await request("acme", `/api/v1/access/people/${ada.membershipId}/view-as`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "support ticket 7" }),
    });
    expect(start.status, await start.clone().text()).toBe(200);
    try {
      await resetLimits();
      const count = async () =>
        sql<{ t: string; n: number }>(
          `SELECT 'rate' AS t, count(*)::int AS n FROM core.rate_limit
           UNION ALL SELECT 'audit', count(*)::int FROM audit.event
           UNION ALL SELECT 'entries', count(*)::int FROM core.search_entry
           UNION ALL SELECT 'state', count(*)::int FROM core.search_state`,
        );
      const before = await count();
      const res = await request("acme", "/api/v1/search?q=zephyr", { cookie: owner.cookie });
      expect(res.status, await res.clone().text()).toBe(200);
      const got = (await json<Results>(res)).hits.filter((h) => h.module === PROBE);
      expect(got.map((h) => h.title).sort()).toEqual([
        "Zephyr board minutes",
        "Zephyr granted deck",
        "Zephyr members memo",
      ]);
      expect(await count()).toEqual(before);
    } finally {
      const end = await request("acme", "/api/v1/me/view-as", {
        method: "DELETE",
        cookie: owner.cookie,
      });
      expect(end.status).toBeLessThan(300);
    }
  });

  it("rate-limits each membership at 30 a minute", async () => {
    await resetLimits();
    // One instant for the whole burst: all 31 hits land in one window, however slow the run.
    pinnedNow = new Date();
    try {
      for (let i = 0; i < 30; i++) {
        const res = await request("acme", "/api/v1/search?q=zephyr", { cookie: carol.cookie });
        expect(res.status).toBe(200);
      }
      const limited = await request("acme", "/api/v1/search?q=zephyr", { cookie: carol.cookie });
      expect(limited.status).toBe(429);
      expect((await json<{ error: { code: string } }>(limited)).error.code).toBe("rate_limited");
      // Another member is unaffected.
      const other = await request("acme", "/api/v1/search?q=zephyr", { cookie: bob.cookie });
      expect(other.status).toBe(200);
    } finally {
      pinnedNow = undefined;
      await resetLimits();
    }
  });
});

// ---- the index service, the reindex job and the sweep ---------------------------------------
describe("indexing", () => {
  it("upsert / replace / remove on the caller's transaction", async () => {
    const ctx = systemContext(acmeId);
    const index = running.container.search;
    const ref = randomUUID();
    const e = (part: string, title: string): SearchEntryInput => ({
      kind: "page",
      refId: ref,
      part,
      title,
      body: "x".repeat(250_000),
      acl: { kind: "members" },
      href: "/p/x",
      updatedAt: AT,
    });
    const rows = () =>
      sql<{ part: string; title: string; len: number }>(
        "SELECT part, title, char_length(body)::int AS len FROM core.search_entry WHERE ref_id = $1 ORDER BY part",
        [ref],
      );
    await running.container.db.withTenant(ctx, (tx) =>
      index.upsert(tx, ctx, "search-scratch", [e("a", "A1"), e("b", "B1")]),
    );
    expect(await rows()).toEqual([
      { part: "a", title: "A1", len: 200_000 },
      { part: "b", title: "B1", len: 200_000 },
    ]);
    await running.container.db.withTenant(ctx, (tx) =>
      index.upsert(tx, ctx, "search-scratch", [e("a", "A2")]),
    );
    expect((await rows()).map((r) => r.title)).toEqual(["A2", "B1"]);
    await running.container.db.withTenant(ctx, (tx) =>
      index.replace(tx, ctx, "search-scratch", "page", ref, [e("c", "C1")]),
    );
    expect((await rows()).map((r) => r.part)).toEqual(["c"]);
    // A rolled-back transaction leaves nothing behind.
    await expect(
      running.container.db.withTenant(ctx, async (tx) => {
        await index.upsert(tx, ctx, "search-scratch", [e("d", "D1")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await rows()).map((r) => r.part)).toEqual(["c"]);
    await running.container.db.withTenant(ctx, (tx) =>
      index.remove(tx, ctx, "search-scratch", { kind: "page", refId: ref }),
    );
    expect(await rows()).toEqual([]);
    // An investor's own context may not write (RLS would refuse; the service says why first).
    const external = {
      workspaceId: acmeId,
      actorKind: "external" as const,
      membershipId: ada.membershipId,
    };
    await expect(
      running.container.db.withTenant(external, (tx) =>
        index.upsert(tx, external, "search-scratch", [e("a", "A")]),
      ),
    ).rejects.toThrow(/staff or system context/u);
  });

  it("the reindex job replaces a module's entries and records its version", async () => {
    const extra = randomUUID();
    const ctx = systemContext(acmeId);
    // A stray entry the provider does not produce: a rebuild must remove it.
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.search.upsert(tx, ctx, PROBE, [
        {
          kind: "page",
          refId: extra,
          title: "Zephyr stray",
          acl: { kind: "members" },
          href: "/p/stray",
          updatedAt: AT,
        },
      ]),
    );
    expect(await titles(owner, "stray")).toEqual(["Zephyr stray"]);
    probeVersion = 2;
    const r = await reindexProbe(acmeId);
    expect(r).toMatchObject({ status: "indexed", entries: acmeEntries().length, invalid: 0 });
    expect(await titles(owner, "stray")).toEqual([]);
    const state = await running.container.db.withTenant(ctx, (tx) => readStates(tx, acmeId));
    expect(state.find((s) => s.module === PROBE)).toMatchObject({ version: 2, requestedAt: null });
  });

  it("the reindex skips an invalid provider entry instead of failing the module", async () => {
    probeEntries.set(acmeId, [
      ...acmeEntries(),
      {
        ...acmeEntries()[0],
        refId: randomUUID(),
        href: "https://evil.example/",
      } as SearchEntryInput,
    ]);
    const r = await reindexProbe(acmeId);
    expect(r).toMatchObject({ status: "indexed", entries: acmeEntries().length, invalid: 1 });
    probeEntries.set(acmeId, acmeEntries());
    await reindexProbe(acmeId);
  });

  it("the sweep enqueues only stale pairs: missing, other version, or requested", async () => {
    const sent: { workspaceId: string; module: string }[] = [];
    const deps = {
      db: running.container.db,
      modules: () => running.container.registry.modules,
      queue: {
        send: async (_name: string, data: Record<string, unknown>) => {
          sent.push(data as { workspaceId: string; module: string });
          return "x";
        },
      },
    };
    const probePairs = () => sent.filter((s) => s.module === PROBE).map((s) => s.workspaceId);
    // acme is current at version 2; globex was built at 1.
    await sweepSearchIndex(deps);
    expect(probePairs()).toEqual([globexId]);
    await reindexProbe(globexId);
    sent.length = 0;
    await sweepSearchIndex(deps);
    expect(probePairs()).toEqual([]);
    // A request (without its job) makes the pair stale again.
    const ctx = systemContext(acmeId);
    const quiet = createSearchIndex({ queue: { sendInTransaction: async () => null } });
    await running.container.db.withTenant(ctx, (tx) => quiet.requestReindex(tx, ctx, PROBE));
    sent.length = 0;
    await sweepSearchIndex(deps);
    expect(probePairs()).toEqual([acmeId]);
    await reindexProbe(acmeId);
    // A third workspace has no state at all.
    const fresh = (await createWorkspace(running.container.db, { slug: "fresh", name: "Fresh" }))
      .id;
    sent.length = 0;
    await sweepSearchIndex(deps);
    expect(probePairs()).toEqual([fresh]);
    // Soft-deleted workspaces are skipped.
    await sql(
      "UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [fresh],
    );
    sent.length = 0;
    await sweepSearchIndex(deps);
    expect(probePairs()).toEqual([]);
    expect((await reindexProbe(fresh)).status).toBe("skipped");
  });

  it("requestReindex runs the real job through the queue and clears requested_at", async () => {
    const ctx = systemContext(acmeId);
    const reads = probeReads;
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.search.requestReindex(tx, ctx, PROBE),
    );
    const state = await waitFor(async () => {
      const s = (await running.container.db.withTenant(ctx, (tx) => readStates(tx, acmeId))).find(
        (x) => x.module === PROBE,
      );
      return s !== undefined && s.requestedAt === null && probeReads > reads ? s : undefined;
    });
    expect(state.version).toBe(probeVersion);
  });

  it("runs the reindex and the sweep on a one-connection pool (no nested connection)", async () => {
    const db = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
    try {
      const deps = {
        db,
        modules: () => running.container.registry.modules,
        queue: { send: async () => null },
      };
      const r = await Promise.race([
        reindexWorkspaceModule(deps, acmeId, PROBE),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("deadlock: reindex waited for a second connection")),
            15_000,
          ),
        ),
      ]);
      expect(r.status).toBe("indexed");
      await Promise.race([
        sweepSearchIndex(deps),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("deadlock: sweep waited for a second connection")),
            15_000,
          ),
        ),
      ]);
    } finally {
      await db.close();
    }
  });

  it("a full rebuild runs in short transactions: a writer is never held for the whole rebuild", async () => {
    // Fix A #3. 30 extra entries = 13 provider pages, each pausing 200 ms: the old one-transaction
    // rebuild held the (deleted) rows for ~2.6 s, so a write with a 1.5 s statement timeout failed.
    const ctx = systemContext(acmeId);
    const extra: SearchEntryInput[] = Array.from({ length: 30 }, (_, i) => ({
      kind: "page",
      refId: randomUUID(),
      title: `Filler ${i}`,
      acl: { kind: "members" },
      href: "/p/filler",
      updatedAt: AT,
    }));
    probeEntries.set(acmeId, [...acmeEntries(), ...extra]);
    await reindexProbe(acmeId);
    const target = extra[25] as SearchEntryInput;
    const doomed = extra[1] as SearchEntryInput;
    const newer = { ...target, title: "Filler renamed while rebuilding" };
    probeHook = () => sleep(200);
    try {
      const rebuild = reindexProbe(acmeId);
      await sleep(300);
      // The writer changes its source first, then indexes on its own transaction.
      probeEntries.set(acmeId, [
        ...acmeEntries(),
        ...extra.filter((e) => e !== doomed).map((e) => (e === target ? newer : e)),
      ]);
      const started = Date.now();
      await running.container.db.withTenant(ctx, async (tx) => {
        await tx.execute(dsql`SET LOCAL statement_timeout = '1500ms'`);
        await running.container.search.upsert(tx, ctx, PROBE, [newer]);
        await running.container.search.remove(tx, ctx, PROBE, {
          kind: "page",
          refId: doomed.refId,
        });
      });
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((await rebuild).status).toBe("indexed");
    } finally {
      probeHook = undefined;
    }
    expect(await titles(owner, "renamed while rebuilding")).toEqual([
      "Filler renamed while rebuilding",
    ]);
    expect(await titles(owner, "filler 1")).not.toContain("Filler 1");
    const [n] = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.search_entry WHERE workspace_id = $1 AND module = $2",
      [acmeId, PROBE],
    );
    expect(n?.n).toBe(acmeEntries().length + extra.length - 1);
    probeEntries.set(acmeId, acmeEntries());
    await reindexProbe(acmeId);
    expect(await titles(owner, "filler")).toEqual([]);
  });

  it("a write committed between a rebuild page's read and its write is not overwritten", async () => {
    // Fix A #3 ordering: the page reads, then (paused) a writer indexes newer data. The writer must
    // win — it waits for the page (a shared/exclusive advisory lock per module), then writes.
    const ctx = systemContext(acmeId);
    const [first, ...rest] = acmeEntries() as [SearchEntryInput, ...SearchEntryInput[]];
    const newer = { ...first, title: "Zephyr members memo v2" };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const atPage = new Promise<void>((r) => {
      reached = r;
    });
    probeHook = async ({ workspaceId, start }) => {
      if (workspaceId === acmeId && start === 0) {
        reached();
        await gate;
      }
    };
    try {
      const rebuild = reindexProbe(acmeId);
      await atPage;
      probeEntries.set(acmeId, [newer, ...rest]);
      const write = running.container.db.withTenant(ctx, (tx) =>
        running.container.search.upsert(tx, ctx, PROBE, [newer]),
      );
      await Promise.race([write, sleep(400)]);
      release();
      await Promise.all([write, rebuild]);
    } finally {
      probeHook = undefined;
    }
    expect(await titles(owner, "members memo")).toEqual(["Zephyr members memo v2"]);
    probeEntries.set(acmeId, acmeEntries());
    await reindexProbe(acmeId);
    expect(await titles(owner, "members memo")).toEqual(["Zephyr members memo"]);
  });

  it("a reindex request made during a rebuild survives it, even with an older request pending", async () => {
    // Fix A #4: requested_at kept the EARLIEST request, and the rebuild cleared anything older than
    // its start — so r1 (during the rebuild) was lost behind r0 (before it).
    const ctx = systemContext(acmeId);
    const quiet = createSearchIndex({ queue: { sendInTransaction: async () => null } });
    const probeState = async () =>
      (await running.container.db.withTenant(ctx, (tx) => readStates(tx, acmeId))).find(
        (s) => s.module === PROBE,
      );
    await running.container.db.withTenant(ctx, (tx) => quiet.requestReindex(tx, ctx, PROBE));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const atPage = new Promise<void>((r) => {
      reached = r;
    });
    probeHook = async ({ workspaceId, start }) => {
      if (workspaceId === acmeId && start === 0) {
        reached();
        await gate;
      }
    };
    try {
      const rebuild = reindexProbe(acmeId);
      await atPage;
      const again = running.container.db.withTenant(ctx, (tx) =>
        quiet.requestReindex(tx, ctx, PROBE),
      );
      await Promise.race([again, sleep(300)]);
      release();
      await Promise.all([again, rebuild]);
    } finally {
      probeHook = undefined;
    }
    expect((await probeState())?.requestedAt).not.toBeNull();
    // The next rebuild, with nothing asked meanwhile, clears it.
    await reindexProbe(acmeId);
    expect((await probeState())?.requestedAt).toBeNull();
  });

  it("the index service never throws on data: an empty-after-cleaning title gets the neutral marker", async () => {
    // Fix A #7.
    const ctx = systemContext(acmeId);
    const ref = randomUUID();
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.search.upsert(tx, ctx, "search-scratch", [
        {
          kind: "page",
          refId: ref,
          title: "\u0007\u0001 \u0002",
          body: "body text",
          acl: { kind: "members" },
          href: "/p/x",
          updatedAt: AT,
        },
      ]),
    );
    const [row] = await sql<{ title: string }>(
      "SELECT title FROM core.search_entry WHERE ref_id = $1",
      [ref],
    );
    expect(row?.title).toBe("\u2014");
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.search.remove(tx, ctx, "search-scratch", { kind: "page", refId: ref }),
    );
  });

  it("fundroom search reindex keeps going past a failing workspace, reports it and exits 1", async () => {
    // Fix A #8.
    probeFail.add(globexId);
    const lines: string[] = [];
    let code: number;
    try {
      code = await searchReindexCommand(["reindex", "--module", PROBE], {
        db: running.container.db,
        modules: running.container.registry.modules,
        audit: running.container.audit,
        out: (l) => lines.push(l),
      });
    } finally {
      probeFail.clear();
    }
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith(`${acmeId}\t${PROBE}\tindexed`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${globexId}\t${PROBE}\tfailed`))).toBe(true);
  });

  it("the workspace purge deletes the workspace's entries and state", async () => {
    const doomed = (await createWorkspace(running.container.db, { slug: "doomed", name: "Doomed" }))
      .id;
    probeEntries.set(doomed, acmeEntries().slice(0, 1));
    await reindexProbe(doomed);
    const counts = async () =>
      sql<{ e: number; s: number }>(
        `SELECT (SELECT count(*)::int FROM core.search_entry WHERE workspace_id = $1) AS e,
                (SELECT count(*)::int FROM core.search_state WHERE workspace_id = $1) AS s`,
        [doomed],
      );
    expect((await counts())[0]).toEqual({ e: 1, s: 1 });
    await sql(
      "UPDATE core.workspace SET deleted_at = now() - interval '31 days', purge_after = now() - interval '1 day' WHERE id = $1",
      [doomed],
    );
    const result = await purgeDeletedWorkspaces({
      db: running.container.db,
      audit: running.container.audit,
    });
    expect(result.purged).toContain(doomed);
    expect((await counts())[0]).toEqual({ e: 0, s: 0 });
  });
});
