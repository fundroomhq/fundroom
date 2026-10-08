import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The content page end to end (E1.2): the template home page seeded on first request, the
 * draft → publish → revision lifecycle, section visibility per audience (authenticated,
 * groups, staff-only, public with the workspace guard), preview-as, the hydration fallback
 * for reference blocks, revision immutability, RBAC per role and the cross-tenant replay.
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

interface Rendered {
  page: { id: string; slug: string; title: string };
  revision: { id: string; revisionNo: number };
  sections: {
    key: string;
    visibility: { mode: string };
    blocks: { id: string; type: string; data: Record<string, unknown>; unavailable?: string }[];
  }[];
  viewer: string;
  preview: boolean;
}
interface Detail {
  page: {
    id: string;
    slug: string;
    kind: string;
    publishedRevisionNo: number | null;
    draftDirty: boolean;
  };
  draft: {
    revisionId: string;
    doc: { sections: { key: string; title: string | null; blocks: unknown[] }[] };
    savedAt: string;
  };
  visibility: Record<string, { mode: string; groupIds?: string[] }>;
  groups: { id: string; name: string }[];
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let investor: Actor;
let boardInvestor: Actor;
let globexOwner: Actor;
let homeId: string;
let boardGroupId: string;

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
  const added = await request("acme", `/api/v1/access/groups/${boardGroupId}/members`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ membershipIds: [boardInvestor.membershipId] }),
  });
  expect(added.status).toBe(200);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema", () => {
  it("content.* tables pass the RLS catalog check (fence, force, schema_version siblings)", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });
});

describe("template and render", () => {
  it("seeds the home page from the template on the investor's first request", async () => {
    const res = await request("acme", "/api/v1/content/render/home", { cookie: investor.cookie });
    expect(res.status).toBe(200);
    const body = await json<Rendered>(res);
    expect(body.page.slug).toBe("home");
    expect(body.revision.revisionNo).toBe(1);
    expect(body.viewer).toBe("external");
    expect(body.preview).toBe(false);
    expect(body.sections.map((s) => s.key)).toEqual(["welcome", "about", "team", "faq"]);
    expect(body.sections[0]?.blocks[0]).toMatchObject({
      type: "hero",
      data: { heading: "Acme investor portal" },
    });
    homeId = body.page.id;
    // Idempotent: a second workspace gets its own template, ours is unchanged.
    const again = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: investor.cookie }),
    );
    expect(again.page.id).toBe(homeId);
    const globex = await json<Rendered>(
      await request("globex", "/api/v1/content/render/home", { cookie: globexOwner.cookie }),
    );
    expect(globex.page.id).not.toBe(homeId);
    expect(globex.sections[0]?.blocks[0]?.data["heading"]).toBe("Globex investor portal");
  });

  it("is signed-in only until public sections exist; a stranger to the workspace gets 404", async () => {
    expect((await request("acme", "/api/v1/content/render/home")).status).toBe(401);
    const stranger = await request("acme", "/api/v1/content/render/home", {
      cookie: globexOwner.cookie,
    });
    expect(stranger.status).toBe(404);
    expect(
      (await request("acme", "/api/v1/content/render/nope", { cookie: investor.cookie })).status,
    ).toBe(404);
  });

  it("lists pages with draft state for staff; RBAC per role", async () => {
    const list = await json<{ pages: Detail["page"][] }>(
      await request("acme", "/api/v1/content/pages", { cookie: viewer.cookie }),
    );
    expect(list.pages).toHaveLength(1);
    expect(list.pages[0]).toMatchObject({
      slug: "home",
      kind: "home",
      publishedRevisionNo: 1,
      draftDirty: false,
    });
    expect(
      (await request("acme", "/api/v1/content/pages", { cookie: investor.cookie })).status,
    ).toBe(404);
    const denied = await request("acme", `/api/v1/content/pages/${homeId}/publish`, {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    expect((await json(denied))["error"]).toMatchObject({
      code: "forbidden",
      permission: "content.publish",
    });
    const settings = await request("acme", "/api/v1/content/settings", {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ allowPublicSections: true }),
    });
    expect(settings.status).toBe(403);
  });
});

describe("draft, visibility, publish", () => {
  let detail: Detail;

  it("the editor saves a draft: validated, normalised, invisible to investors until published", async () => {
    detail = await json<Detail>(
      await request("acme", `/api/v1/content/pages/${homeId}`, { cookie: editor.cookie }),
    );
    expect(detail.groups.map((g) => g.name)).toEqual(["Board"]);
    const doc = detail.draft.doc;
    doc.sections.push({
      key: "board",
      title: "Board pack",
      blocks: [
        {
          id: "board-metrics",
          type: "metric_grid",
          schemaVersion: 1,
          data: { definitionIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c09"] },
        },
      ],
    });
    doc.sections.push({
      key: "internal",
      title: "Internal notes",
      blocks: [
        {
          id: "notes",
          type: "rich_text",
          schemaVersion: 1,
          data: { format: "markdown", text: "**staff only**" },
        },
      ],
    });
    const bad = await request("acme", `/api/v1/content/pages/${homeId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            ...doc.sections,
            {
              key: "x",
              title: null,
              blocks: [{ id: "w", type: "widget", schemaVersion: 1, data: {} }],
            },
          ],
        },
      }),
    });
    expect(bad.status).toBe(400);
    expect((await json(bad))["error"]).toMatchObject({
      code: "validation_failed",
      issues: [{ path: "doc.sections.6.blocks.0.type", code: "unknown_type" }],
    });

    const saved = await request("acme", `/api/v1/content/pages/${homeId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ doc, baseSavedAt: detail.draft.savedAt }),
    });
    expect(saved.status).toBe(200);
    detail = await json<Detail>(saved);
    expect(detail.page.draftDirty).toBe(true);
    expect(detail.visibility["board"]).toEqual({ mode: "authenticated" });
    const grid = detail.draft.doc.sections[4]?.blocks[0] as { data: Record<string, unknown> };
    expect(grid.data["columns"]).toBe(3);

    // Stale base → 409.
    const stale = await request("acme", `/api/v1/content/pages/${homeId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ doc, baseSavedAt: "2020-01-01T00:00:00.000Z" }),
    });
    expect(stale.status).toBe(409);

    const live = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: investor.cookie }),
    );
    expect(live.sections.map((s) => s.key)).toEqual(["welcome", "about", "team", "faq"]);
  });

  it("visibility: groups, staff_only, and the public guard", async () => {
    const rules = {
      welcome: { mode: "authenticated" },
      about: { mode: "authenticated" },
      team: { mode: "authenticated" },
      faq: { mode: "authenticated" },
      board: { mode: "groups", groupIds: [boardGroupId] },
      internal: { mode: "staff_only" },
    };
    const ok = await request("acme", `/api/v1/content/pages/${homeId}/visibility`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ rules }),
    });
    expect(ok.status).toBe(200);
    expect((await json<Detail>(ok)).visibility["board"]).toEqual(rules.board);

    const publicRefused = await request("acme", `/api/v1/content/pages/${homeId}/visibility`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ rules: { ...rules, welcome: { mode: "public" } } }),
    });
    expect(publicRefused.status).toBe(400);
    expect((await json(publicRefused))["error"]).toMatchObject({
      issues: [{ path: "rules.welcome.mode", code: "public_sections_disabled" }],
    });
    const unknownGroup = await request("acme", `/api/v1/content/pages/${homeId}/visibility`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        rules: { ...rules, board: { mode: "groups", groupIds: [globexId] } },
      }),
    });
    expect(unknownGroup.status).toBe(400);
  });

  it("preview-as renders the draft for an audience without publishing", async () => {
    const as = async (who: string) =>
      (
        await json<Rendered>(
          await request("acme", `/api/v1/content/pages/${homeId}/preview?as=${who}`, {
            cookie: viewer.cookie,
          }),
        )
      ).sections.map((s) => s.key);
    expect(await as("authenticated")).toEqual(["welcome", "about", "team", "faq"]);
    expect(await as(`group:${boardGroupId}`)).toEqual(["welcome", "about", "team", "faq", "board"]);
    expect(await as("staff")).toEqual(["welcome", "about", "team", "faq", "board", "internal"]);
    expect(await as("public")).toEqual([]);
    const preview = await json<Rendered>(
      await request("acme", `/api/v1/content/pages/${homeId}/preview?as=staff`, {
        cookie: viewer.cookie,
      }),
    );
    expect(preview.preview).toBe(true);
    expect(preview.sections[4]?.blocks[0]).toMatchObject({
      type: "metric_grid",
      unavailable: "module_unavailable",
    });
  });

  it("publish creates an immutable revision that investors see per their groups", async () => {
    const published = await request("acme", `/api/v1/content/pages/${homeId}/publish`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ note: "Board pack" }),
    });
    expect(published.status).toBe(200);
    const d = await json<Detail>(published);
    expect(d.page.publishedRevisionNo).toBe(2);
    expect(d.page.draftDirty).toBe(false);

    const plain = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: investor.cookie }),
    );
    expect(plain.sections.map((s) => s.key)).toEqual(["welcome", "about", "team", "faq"]);
    const board = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: boardInvestor.cookie }),
    );
    expect(board.sections.map((s) => s.key)).toEqual(["welcome", "about", "team", "faq", "board"]);
    expect(board.sections[4]?.blocks[0]?.unavailable).toBe("module_unavailable");
    const staffView = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: viewer.cookie }),
    );
    expect(staffView.viewer).toBe("staff");
    expect(staffView.sections.map((s) => s.visibility.mode)).toEqual([
      "authenticated",
      "authenticated",
      "authenticated",
      "authenticated",
      "groups",
      "staff_only",
    ]);

    // The published row is immutable at the database level.
    const { pgErrorCode, systemContext } = await import("@fundroom/db");
    const tamper = running.container.db
      .withTenant(systemContext(acmeId), (tx) =>
        tx.execute(
          `UPDATE content.page_revision SET note = 'tampered' WHERE published_at IS NOT NULL`,
        ),
      )
      .then(
        () => "committed",
        (error: unknown) => pgErrorCode(error),
      );
    await expect(tamper).resolves.toBe("23001"); // restrict_violation from the trigger
  });

  it("revisions list, restore, and rollback by publishing again", async () => {
    const list = await json<{
      revisions: { id: string; revisionNo: number; isCurrent: boolean; note: string | null }[];
    }>(
      await request("acme", `/api/v1/content/pages/${homeId}/revisions`, { cookie: viewer.cookie }),
    );
    expect(list.revisions.map((r) => [r.revisionNo, r.isCurrent, r.note])).toEqual([
      [2, true, "Board pack"],
      [1, false, "Initial page"],
    ]);
    const first = list.revisions[1];
    if (!first) throw new Error("no revision 1");
    const one = await json<{
      doc: { sections: { key: string }[] };
      visibility: Record<string, unknown>;
    }>(
      await request("acme", `/api/v1/content/pages/${homeId}/revisions/${first.id}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(one.doc.sections).toHaveLength(4);
    expect(Object.keys(one.visibility)).toHaveLength(4);

    const restored = await json<Detail>(
      await request("acme", `/api/v1/content/pages/${homeId}/revisions/${first.id}/restore`, {
        method: "POST",
        cookie: editor.cookie,
      }),
    );
    expect(restored.draft.doc.sections).toHaveLength(4);
    expect(restored.page.draftDirty).toBe(true);
    const back = await json<Detail>(
      await request("acme", `/api/v1/content/pages/${homeId}/publish`, {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({}),
      }),
    );
    expect(back.page.publishedRevisionNo).toBe(3);
    const board = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: boardInvestor.cookie }),
    );
    expect(board.sections.map((s) => s.key)).toEqual(["welcome", "about", "team", "faq"]);
  });

  it("public sections: refused while off, served to signed-out visitors once on", async () => {
    const on = await request("acme", "/api/v1/content/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowPublicSections: true }),
    });
    expect(on.status).toBe(200);
    expect(await json(on)).toEqual({ allowPublicSections: true });
    const rules = {
      welcome: { mode: "public" },
      about: { mode: "authenticated" },
      team: { mode: "authenticated" },
      faq: { mode: "authenticated" },
    };
    expect(
      (
        await request("acme", `/api/v1/content/pages/${homeId}/visibility`, {
          method: "PUT",
          cookie: editor.cookie,
          body: JSON.stringify({ rules }),
        })
      ).status,
    ).toBe(200);
    // Not yet published → still 401 for strangers.
    expect((await request("acme", "/api/v1/content/render/home")).status).toBe(401);
    await request("acme", `/api/v1/content/pages/${homeId}/publish`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    const anon = await request("acme", "/api/v1/content/render/home");
    expect(anon.status).toBe(200);
    const body = await json<Rendered>(anon);
    expect(body.viewer).toBe("anonymous");
    expect(body.sections.map((s) => s.key)).toEqual(["welcome"]);
    // Switching the setting off hides the public section again without touching rules.
    await request("acme", "/api/v1/content/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowPublicSections: false }),
    });
    expect((await request("acme", "/api/v1/content/render/home")).status).toBe(401);
    const signedIn = await json<Rendered>(
      await request("acme", "/api/v1/content/render/home", { cookie: investor.cookie }),
    );
    expect(signedIn.sections[0]?.key).toBe("welcome");
  });

  it("custom pages: create, render by slug, delete; the home page cannot be deleted", async () => {
    const created = await request("acme", "/api/v1/content/pages", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ slug: "round-2026", title: "Seed round" }),
    });
    expect(created.status).toBe(201);
    const page = (await json<Detail>(created)).page;
    expect(
      (await request("acme", "/api/v1/content/render/round-2026", { cookie: investor.cookie }))
        .status,
    ).toBe(404);
    await request("acme", `/api/v1/content/pages/${page.id}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            {
              key: "terms",
              title: "Terms",
              blocks: [
                {
                  id: "t",
                  type: "faq",
                  schemaVersion: 1,
                  data: { items: [{ question: "Cap?", answer: "Ask us." }] },
                },
              ],
            },
          ],
        },
      }),
    });
    await request("acme", `/api/v1/content/pages/${page.id}/publish`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    const r = await json<Rendered>(
      await request("acme", "/api/v1/content/render/round-2026", { cookie: investor.cookie }),
    );
    expect(r.page.title).toBe("Seed round");
    expect(r.sections[0]?.blocks[0]?.type).toBe("faq");
    const dup = await request("acme", "/api/v1/content/pages", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ slug: "round-2026", title: "Again" }),
    });
    expect(dup.status).toBe(409);
    const homeDelete = await request("acme", `/api/v1/content/pages/${homeId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(homeDelete.status).toBe(409);
    const del = await request("acme", `/api/v1/content/pages/${page.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    expect(
      (await request("acme", "/api/v1/content/render/round-2026", { cookie: investor.cookie }))
        .status,
    ).toBe(404);
  });

  it("cross-tenant replay: every id-bearing content route answers 404 for another tenant's ids", async () => {
    const globexHome = await json<Rendered>(
      await request("globex", "/api/v1/content/render/home", { cookie: globexOwner.cookie }),
    );
    const paths: [string, string, string | undefined][] = [
      ["GET", `/api/v1/content/pages/${globexHome.page.id}`, undefined],
      ["PATCH", `/api/v1/content/pages/${globexHome.page.id}`, JSON.stringify({ title: "x" })],
      [
        "PUT",
        `/api/v1/content/pages/${globexHome.page.id}/draft`,
        JSON.stringify({ doc: { sections: [] } }),
      ],
      [
        "PUT",
        `/api/v1/content/pages/${globexHome.page.id}/visibility`,
        JSON.stringify({ rules: {} }),
      ],
      ["POST", `/api/v1/content/pages/${globexHome.page.id}/publish`, JSON.stringify({})],
      ["GET", `/api/v1/content/pages/${globexHome.page.id}/preview`, undefined],
      ["GET", `/api/v1/content/pages/${globexHome.page.id}/revisions`, undefined],
      [
        "GET",
        `/api/v1/content/pages/${globexHome.page.id}/revisions/${globexHome.revision.id}`,
        undefined,
      ],
      [
        "POST",
        `/api/v1/content/pages/${globexHome.page.id}/revisions/${globexHome.revision.id}/restore`,
        undefined,
      ],
      ["DELETE", `/api/v1/content/pages/${globexHome.page.id}`, undefined],
    ];
    for (const [method, path, body] of paths) {
      const res = await request("acme", path, {
        method,
        cookie: owner.cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`);
    }
    // The globex page is untouched.
    const still = await json<Rendered>(
      await request("globex", "/api/v1/content/render/home", { cookie: globexOwner.cookie }),
    );
    expect(still.revision.id).toBe(globexHome.revision.id);
  });

  it("audit trail and outbox carry the publish", async () => {
    const { systemContext } = await import("@fundroom/db");
    const rows = await running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      const r = await tx.execute(
        `SELECT action, count(*)::int AS n FROM audit.event WHERE resource_kind = 'page' GROUP BY action ORDER BY action`,
      );
      return r.rows as { action: string; n: number }[];
    });
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toMatchObject({
      "page.created": 2,
      "page.published": 4,
      "page.visibility_changed": 2,
      "page.deleted": 1,
    });
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'page.published'`,
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(outbox).toBeGreaterThanOrEqual(4);
  });
});

describe("workspace search (E2.8)", () => {
  interface Hits {
    hits: { module: string; kind: string; refId: string; title: string; href: string }[];
  }
  const search = async (actor: Actor, q: string) => {
    const res = await request("acme", `/api/v1/search?q=${encodeURIComponent(q)}`, {
      cookie: actor.cookie,
    });
    expect(res.status).toBe(200);
    return (await json<Hits>(res)).hits.filter((h) => h.module === "content");
  };
  const faq = (id: string, question: string, answer: string) => ({
    id,
    type: "faq",
    schemaVersion: 1,
    data: { items: [{ question, answer }] },
  });
  let pageId: string;

  it("a published page is findable per section audience; staff_only never by investors", async () => {
    const created = await request("acme", "/api/v1/content/pages", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ slug: "search-probe", title: "Probe page" }),
    });
    expect(created.status).toBe(201);
    pageId = (await json<Detail>(created)).page.id;
    await request("acme", `/api/v1/content/pages/${pageId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            { key: "open", title: null, blocks: [faq("a", "Zanzibarquokka?", "Everyone.")] },
            { key: "board", title: "Board", blocks: [faq("b", "Xylophonegecko?", "Board.")] },
            { key: "ops", title: null, blocks: [faq("c", "Quetzalwombat?", "Staff.")] },
          ],
        },
      }),
    });
    const vis = await request("acme", `/api/v1/content/pages/${pageId}/visibility`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        rules: {
          open: { mode: "authenticated" },
          board: { mode: "groups", groupIds: [boardGroupId] },
          ops: { mode: "staff_only" },
        },
      }),
    });
    expect(vis.status).toBe(200);
    // A draft is not searchable, not even by staff.
    expect(await search(owner, "zanzibarquokka")).toEqual([]);
    const published = await request("acme", `/api/v1/content/pages/${pageId}/publish`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    expect(published.status).toBe(200);

    const open = await search(investor, "zanzibarquokka");
    expect(open.map((h) => [h.kind, h.refId, h.href, h.title])).toEqual([
      ["page", pageId, "/p/search-probe", "Probe page"],
    ]);
    expect(await search(investor, "xylophonegecko")).toEqual([]);
    expect((await search(boardInvestor, "xylophonegecko")).map((h) => h.refId)).toEqual([pageId]);
    expect(await search(investor, "quetzalwombat")).toEqual([]);
    expect(await search(boardInvestor, "quetzalwombat")).toEqual([]);
    expect((await search(owner, "quetzalwombat")).map((h) => h.refId)).toEqual([pageId]);
  });

  it("follows the published revision: a re-publish replaces the text, a delete removes the page", async () => {
    await request("acme", `/api/v1/content/pages/${pageId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [{ key: "open", title: null, blocks: [faq("a", "Okapiheron?", "Yes.")] }],
        },
      }),
    });
    // Saved but not published: the old words are still what investors can read.
    expect((await search(investor, "zanzibarquokka")).length).toBe(1);
    await request("acme", `/api/v1/content/pages/${pageId}/publish`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    expect(await search(investor, "zanzibarquokka")).toEqual([]);
    expect((await search(investor, "okapiheron")).map((h) => h.refId)).toEqual([pageId]);

    const del = await request("acme", `/api/v1/content/pages/${pageId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    expect(await search(investor, "okapiheron")).toEqual([]);
    expect(await search(owner, "okapiheron")).toEqual([]);
  });

  it("the home page (seeded and published at birth) opens at /", async () => {
    const hits = await search(owner, "Overview");
    expect(hits.some((h) => h.refId === homeId && h.href === "/")).toBe(true);
  });
});
