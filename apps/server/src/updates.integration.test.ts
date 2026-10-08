import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventTopic } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import { JOB_DISPATCH, JOB_SEND, recordsFor } from "@fundroom/module-updates";
import {
  type DnsAnswer,
  type DnsRecordType,
  type DnsResolverPort,
  type MailerPort,
  MailSuppressedError,
} from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Investor updates end to end (E1.4): templates → draft autosave (conflicts, validation,
 * audience + section rules) → test send → live send through `updates.send` with
 * per-recipient status and per-reader section filtering → the gated web archive → private
 * reply threads → unsubscribe (portal switch, signed footer token, one-click POST) → the
 * sending domain (DKIM keys, DNS verification through a fake resolver, signed mail) →
 * scheduling through the dispatcher → RLS catalog, cross-tenant replay, audit + outbox.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

/*
 * E2.6: addresses the kernel's suppression wrapper would refuse. The wrapper itself is the
 * kernel's (and has its own suite); what this file proves is what the updates module does when
 * the mailer it was handed says no — so the refusal is injected one layer down, at the port.
 */
const suppressedAddresses = new Set<string>();
/*
 * E2.10: delivery failures, shaped like the SMTP adapter's. `transientFailures` counts down the
 * connection refusals an address still has coming (an outage that ends); `permanentFailures`
 * answer 550 every time. `attempts` is every hand-over to the port, per address and subject.
 */
const transientFailures = new Map<string, number>();
const permanentFailures = new Set<string>();
const attempts: { to: string; subject: string }[] = [];
function gatedMailer(inner: MemoryMailer): MailerPort {
  return {
    driver: inner.driver,
    send: (message) => {
      attempts.push({ to: message.to, subject: message.subject });
      if (suppressedAddresses.has(message.to))
        return Promise.reject(new MailSuppressedError("bounce"));
      const left = transientFailures.get(message.to) ?? 0;
      if (left > 0) {
        transientFailures.set(message.to, left - 1);
        return Promise.reject(
          Object.assign(new Error("could not send the message"), {
            code: "connection_failed",
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:25"), {
              code: "ECONNREFUSED",
            }),
          }),
        );
      }
      if (permanentFailures.has(message.to))
        return Promise.reject(
          Object.assign(new Error("could not send the message"), {
            code: "send_failed",
            cause: Object.assign(new Error("550 5.1.1 no such user"), {
              code: "EENVELOPE",
              responseCode: 550,
            }),
          }),
        );
      return inner.send(message);
    },
    healthCheck: () => inner.healthCheck(),
  };
}

/*
 * A fake `DnsResolverPort` in place of the DoH adapter (E2.1 decision 2 replaced E1.4's
 * `setDnsResolver` module global with `ModuleServices.dns`). Injected through the container's
 * test seam rather than mutated, so the zone is per-test state that cannot leak between files:
 * `zone` holds the TXT strings a name publishes, and a name that is absent answers `nxdomain`
 * the way a real resolver does for a domain with nothing in it.
 */
const zone = new Map<string, readonly string[]>();
/** When set, every lookup answers this rcode instead — "we could not look", not "not there". */
let dnsFailure: DnsAnswer["rcode"] | undefined;

const fakeDns: DnsResolverPort = {
  driver: "fake",
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
    const values = zone.get(name) ?? [];
    return Promise.resolve({
      name,
      type,
      values: [...values],
      rcode: dnsFailure ?? (zone.has(name) ? "ok" : "nxdomain"),
      resolver: "fake",
      chain: undefined,
    });
  },
  healthCheck: () => Promise.resolve(),
};

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
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${slug}.${CANON}`);
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

interface Detail {
  post: {
    id: string;
    slug: string;
    title: string;
    state: string;
    audience: { kind: string; groupIds?: string[] };
    savedAt: string;
    scheduledFor: string | null;
    sentAt: string | null;
    publishedVersionNo: number | null;
    lastSend: {
      id: string;
      kind: string;
      status: string;
      sent: number;
      failed: number;
      skipped: number;
      total: number;
    } | null;
  };
  doc: {
    sections: {
      key: string;
      title: string | null;
      blocks: { id: string; type: string; schemaVersion: number; data: Record<string, unknown> }[];
    }[];
  };
  visibility: Record<string, { mode: string; groupIds?: string[] }>;
  groups: { id: string; name: string }[];
  versions: { id: string; versionNo: number; isPublished: boolean }[];
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let investor: Actor;
let boardInvestor: Actor;
let quiet: Actor;
let globexOwner: Actor;
let boardGroupId: string;
let postId: string;
let postSlug: string;
let liveSendId: string;

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
    mailer: gatedMailer(mailer),
    dns: fakeDns,
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
  quiet = await member("acme", acmeId, "quiet@investor.test", "external", "investor");
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
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema + registry", () => {
  it("updates.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers permissions, jobs and nav slots", async () => {
    const registry = running.container.registry;
    for (const p of ["updates.read", "updates.manage", "updates.send", "updates.settings"]) {
      expect(registry.permissions.has(p)).toBe(true);
    }
    const jobs = registry.resolveJobs(running.container.moduleServices).map((j) => j.name);
    expect(jobs).toEqual(expect.arrayContaining(["updates.send", "updates.dispatch"]));
    const boot = await json<{
      modules: { id: string; slots: Record<string, unknown[]> }[];
      permissions: string[];
    }>(await request("acme", "/api/v1/modules", { cookie: investor.cookie }));
    const mod = boot.modules.find((m) => m.id === "updates");
    expect(mod?.slots["investor.nav"]).toHaveLength(1);
  });
});

describe("drafts", () => {
  it("lists templates and creates a YC draft (editor), viewer cannot", async () => {
    const templates = await json<{ templates: { key: string }[] }>(
      await request("acme", "/api/v1/updates/templates", { cookie: viewer.cookie }),
    );
    expect(templates.templates.map((t) => t.key)).toEqual(["yc", "minimal", "board", "blank"]);
    const forbidden = await request("acme", "/api/v1/updates/posts", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(forbidden.status).toBe(403);
    const created = await request("acme", "/api/v1/updates/posts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "September 2026 update", template: "yc" }),
    });
    expect(created.status).toBe(201);
    const d = await json<Detail>(created);
    postId = d.post.id;
    postSlug = d.post.slug;
    expect(d.post.slug).toBe("september-2026-update");
    expect(d.post.state).toBe("draft");
    expect(d.doc.sections.map((s) => s.key)).toEqual([
      "recap",
      "highlights",
      "lowlights",
      "kpis",
      "asks",
      "thanks",
    ]);
    expect(Object.keys(d.visibility)).toHaveLength(6);
    expect(d.groups.map((g) => g.name)).toEqual(["Board"]);
  });

  it("autosaves the draft, rejects hero blocks, unknown sections and stale saves", async () => {
    const before = await json<Detail>(
      await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: editor.cookie }),
    );
    const doc = {
      sections: [
        {
          key: "recap",
          title: "TL;DR",
          blocks: [
            {
              id: "recap-text",
              type: "rich_text",
              schemaVersion: 1,
              data: {
                format: "markdown",
                text: "We closed **three** customers. See [the deck](https://acme.test/deck).\n\n- ARR 120k\n- Burn 40k",
              },
            },
          ],
        },
        {
          key: "board-only",
          title: "Board only",
          blocks: [
            {
              id: "board-text",
              type: "rich_text",
              schemaVersion: 1,
              data: {
                format: "markdown",
                text: "Confidential: term sheet from <script>Fund</script>.",
              },
            },
          ],
        },
        {
          key: "docs",
          title: "Documents",
          blocks: [
            {
              id: "docs-list",
              type: "document_list",
              schemaVersion: 1,
              data: { folderId: null, documentIds: [] },
            },
          ],
        },
      ],
    };
    const saved = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc,
        visibility: { "board-only": { mode: "groups", groupIds: [boardGroupId] } },
        baseSavedAt: before.post.savedAt,
      }),
    });
    expect(saved.status).toBe(200);
    const d = await json<Detail>(saved);
    expect(d.visibility).toEqual({
      recap: { mode: "authenticated" },
      "board-only": { mode: "groups", groupIds: [boardGroupId] },
      docs: { mode: "authenticated" },
    });
    expect(d.post.savedAt).not.toBe(before.post.savedAt);

    const stale = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "Stale", baseSavedAt: before.post.savedAt }),
    });
    expect(stale.status).toBe(409);

    const hero = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            {
              key: "a",
              title: null,
              blocks: [
                {
                  id: "h",
                  type: "hero",
                  schemaVersion: 1,
                  data: { heading: "x", subheading: null, imageUrl: null, cta: null },
                },
              ],
            },
          ],
        },
      }),
    });
    expect(hero.status).toBe(400);

    const unknownSection = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ visibility: { nope: { mode: "staff_only" } } }),
    });
    expect(unknownSection.status).toBe(400);

    const unknownGroup = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        audience: { kind: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e99"] },
      }),
    });
    expect(unknownGroup.status).toBe(400);
  });

  it("investors cannot read drafts or the admin list (404, no oracle); nothing is in the archive yet", async () => {
    expect(
      (await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: investor.cookie }))
        .status,
    ).toBe(404);
    expect(
      (await request("acme", "/api/v1/updates/posts", { cookie: investor.cookie })).status,
    ).toBe(404);
    const archive = await json<{ posts: unknown[]; subscribed: boolean }>(
      await request("acme", "/api/v1/updates/archive", { cookie: investor.cookie }),
    );
    expect(archive).toEqual({ posts: [], subscribed: true });
    expect(
      (await request("acme", `/api/v1/updates/archive/${postSlug}`, { cookie: investor.cookie }))
        .status,
    ).toBe(404);
  });
});

describe("sending", () => {
  it("test send goes to the editor only, shows every section and changes no state", async () => {
    mailer.clear();
    const res = await request("acme", `/api/v1/updates/posts/${postId}/test-send`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const send = await json<{ id: string; kind: string }>(res);
    expect(send.kind).toBe("test");
    const done = await waitFor(async () => {
      const list = await json<{ sends: { id: string; status: string; sent: number }[] }>(
        await request("acme", `/api/v1/updates/posts/${postId}/sends`, { cookie: editor.cookie }),
      );
      const s = list.sends.find((x) => x.id === send.id);
      return s?.status === "finished" ? s : undefined;
    });
    expect(done.sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail?.to).toBe("editor@example.com");
    expect(mail?.subject).toBe("[Test] Acme: September 2026 update");
    expect(mail?.text).toContain("TEST SEND");
    expect(mail?.text).toContain("Confidential: term sheet");
    expect(mail?.html).toContain("&lt;script&gt;Fund&lt;/script&gt;");
    expect(mail?.html).not.toContain("<script>");
    expect(mail?.headers?.["List-Unsubscribe"]).toBeUndefined();
    // E1.7: an update is sent on behalf of its workspace, named for the brand resolver.
    expect(mail?.workspaceId).toBe(acmeId);
    const d = await json<Detail>(
      await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: editor.cookie }),
    );
    expect(d.post.state).toBe("draft");
    expect(d.post.publishedVersionNo).toBeNull();
  });

  it("send now needs updates.send and a fresh session; fans out per reader with section filtering", async () => {
    // A viewer holds no updates.send at all.
    const viewerSend = await request("acme", `/api/v1/updates/posts/${postId}/send`, {
      method: "POST",
      cookie: viewer.cookie,
    });
    expect(viewerSend.status).toBe(403);

    // Quiet investor opts out through the portal first.
    const off = await request("acme", "/api/v1/updates/subscription", {
      method: "PUT",
      cookie: quiet.cookie,
      body: JSON.stringify({ subscribed: false }),
    });
    expect(await json(off)).toEqual({ subscribed: false });

    mailer.clear();
    const res = await request("acme", `/api/v1/updates/posts/${postId}/send`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(202);
    const queued = await json<Detail>(res);
    expect(queued.post.state).toBe("sending");
    expect(queued.post.publishedVersionNo).toBe(2);
    expect(queued.post.lastSend?.kind).toBe("live");
    liveSendId = queued.post.lastSend?.id ?? "";

    const sent = await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: editor.cookie }),
      );
      return d.post.state === "sent" && d.post.lastSend?.status === "finished" ? d : undefined;
    });
    expect(sent.post.sentAt).not.toBeNull();
    expect(sent.post.lastSend).toMatchObject({ total: 3, sent: 2, failed: 0, skipped: 1 });

    const recipients = await json<{
      recipients: { email: string; status: string; error: string | null }[];
    }>(
      await request("acme", `/api/v1/updates/sends/${liveSendId}/recipients`, {
        cookie: viewer.cookie,
      }),
    );
    expect(recipients.recipients.map((r) => [r.email, r.status, r.error])).toEqual([
      ["ada@investor.test", "sent", null],
      ["board@investor.test", "sent", null],
      ["quiet@investor.test", "skipped", "unsubscribed"],
    ]);

    expect(mailer.sent).toHaveLength(2);
    const ada = mailer.sent.find((m) => m.to === "ada@investor.test");
    const board = mailer.sent.find((m) => m.to === "board@investor.test");
    expect(ada?.subject).toBe("Acme: September 2026 update");
    expect(ada?.text).toContain("We closed three customers");
    expect(ada?.text).not.toContain("Confidential: term sheet");
    expect(board?.text).toContain("Confidential: term sheet");
    expect(ada?.html).toContain("<strong>three</strong>");
    expect(ada?.text).toContain(`http://acme.${CANON}/updates/${postSlug}`);
    expect(ada?.text).toContain("View the documents on the web");
    expect(ada?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(ada?.headers?.["List-Unsubscribe"]).toMatch(
      /^<http:\/\/acme\.portal\.example\.test\/api\/v1\/updates\/unsubscribe\?token=/u,
    );
    expect(ada?.replyTo).toBe("editor@example.com");
    expect(ada?.from).toBeUndefined();
    expect(ada?.dkim).toBeUndefined();
    expect(ada?.tags).toEqual(["updates", "live"]);
  });

  it("the archive shows the sent version per reader; staff see every section, non-audience sees nothing", async () => {
    const list = await json<{ posts: { slug: string; title: string; versionNo: number }[] }>(
      await request("acme", "/api/v1/updates/archive", { cookie: investor.cookie }),
    );
    expect(list.posts).toEqual([
      expect.objectContaining({ slug: postSlug, title: "September 2026 update", versionNo: 2 }),
    ]);

    const adaPage = await json<{
      sections: { key: string; blocks: { type: string; data: Record<string, unknown> }[] }[];
      viewer: string;
    }>(await request("acme", `/api/v1/updates/archive/${postSlug}`, { cookie: investor.cookie }));
    expect(adaPage.viewer).toBe("external");
    expect(adaPage.sections.map((s) => s.key)).toEqual(["recap", "docs"]);
    // The document_list reference is hydrated by the data room (enabled by default; empty for Ada).
    expect(adaPage.sections[1]?.blocks[0]?.data["hydrated"]).toBeDefined();

    const boardPage = await json<{ sections: { key: string }[] }>(
      await request("acme", `/api/v1/updates/archive/${postSlug}`, {
        cookie: boardInvestor.cookie,
      }),
    );
    expect(boardPage.sections.map((s) => s.key)).toEqual(["recap", "board-only", "docs"]);

    const staffPage = await json<{ sections: { key: string }[]; viewer: string }>(
      await request("acme", `/api/v1/updates/archive/${postSlug}`, { cookie: viewer.cookie }),
    );
    expect(staffPage.viewer).toBe("staff");
    expect(staffPage.sections).toHaveLength(3);

    // Narrow the audience to the board and re-publish to the archive: Ada loses it.
    const narrowed = await request("acme", `/api/v1/updates/posts/${postId}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ audience: { kind: "groups", groupIds: [boardGroupId] } }),
    });
    expect(narrowed.status).toBe(200);
    const republished = await request("acme", `/api/v1/updates/posts/${postId}/publish`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(republished.status).toBe(200);
    expect((await json<Detail>(republished)).post.publishedVersionNo).toBe(3);
    expect(
      (await request("acme", `/api/v1/updates/archive/${postSlug}`, { cookie: investor.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await request("acme", `/api/v1/updates/archive/${postSlug}`, {
          cookie: boardInvestor.cookie,
        })
      ).status,
    ).toBe(200);
    const adaList = await json<{ posts: unknown[] }>(
      await request("acme", "/api/v1/updates/archive", { cookie: investor.cookie }),
    );
    expect(adaList.posts).toEqual([]);
  });

  it("archiving hides the update from investors; restoring brings it back", async () => {
    const hide = await request("acme", `/api/v1/updates/posts/${postId}/archived`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ archived: true }),
    });
    expect((await json<Detail>(hide)).post.state).toBe("archived");
    expect(
      (
        await request("acme", `/api/v1/updates/archive/${postSlug}`, {
          cookie: boardInvestor.cookie,
        })
      ).status,
    ).toBe(404);
    const show = await request("acme", `/api/v1/updates/posts/${postId}/archived`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ archived: false }),
    });
    expect((await json<Detail>(show)).post.state).toBe("sent");
    expect(
      (
        await request("acme", `/api/v1/updates/archive/${postSlug}`, {
          cookie: boardInvestor.cookie,
        })
      ).status,
    ).toBe(200);
  });
});

describe("replies", () => {
  it("an investor in the audience replies in their own thread; staff answer; others see nothing", async () => {
    const outside = await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
      method: "POST",
      cookie: investor.cookie,
      body: JSON.stringify({ body: "Can I see the term sheet?" }),
    });
    expect(outside.status).toBe(404);

    const ask = await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
      method: "POST",
      cookie: boardInvestor.cookie,
      body: JSON.stringify({ body: "Great progress. Happy to intro Fund X." }),
    });
    expect(ask.status).toBe(201);
    const reply = await json<{ authorKind: string; authorName: string }>(ask);
    expect(reply).toMatchObject({ authorKind: "external", authorName: "board" });

    const staffThreads = await json<{
      threads: { membershipId: string; replies: { body: string }[] }[];
    }>(await request("acme", `/api/v1/updates/posts/${postId}/replies`, { cookie: viewer.cookie }));
    expect(staffThreads.threads).toHaveLength(1);
    expect(staffThreads.threads[0]?.membershipId).toBe(boardInvestor.membershipId);

    const answer = await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ body: "Yes please!", threadMembershipId: boardInvestor.membershipId }),
    });
    expect(answer.status).toBe(201);
    const noThread = await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ body: "Where does this go?" }),
    });
    expect(noThread.status).toBe(400);

    const mine = await json<{ threads: { replies: { body: string; authorKind: string }[] }[] }>(
      await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
        cookie: boardInvestor.cookie,
      }),
    );
    expect(mine.threads[0]?.replies.map((r) => [r.body, r.authorKind])).toEqual([
      ["Great progress. Happy to intro Fund X.", "external"],
      ["Yes please!", "staff"],
    ]);
    // Ada is outside the narrowed audience: the post (and its threads) do not exist for her.
    expect(
      (
        await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
          cookie: investor.cookie,
        })
      ).status,
    ).toBe(404);
  });
});

describe("unsubscribe", () => {
  it("the signed link and the one-click POST work without a session; tampering and other tenants fail", async () => {
    const ada = mailer.sent.find((m) => m.to === "ada@investor.test");
    const header = ada?.headers?.["List-Unsubscribe"] ?? "";
    const url = new URL(header.slice(1, -1));
    const token = url.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(40);

    const wrongTenant = await request(
      "globex",
      `/api/v1/updates/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(wrongTenant.status).toBe(403);
    const tampered = await request(
      "acme",
      `/api/v1/updates/unsubscribe?token=${encodeURIComponent(`${token.slice(0, -2)}xx`)}`,
      { method: "POST" },
    );
    expect(tampered.status).toBe(403);

    // RFC 8058: form-encoded body, no cookie, no Origin.
    const oneClick = await request(
      "acme",
      `/api/v1/updates/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    expect(oneClick.status).toBe(200);
    expect(await json(oneClick)).toEqual({
      ok: true,
      email: "a***@investor.test",
      alreadyUnsubscribed: false,
    });
    const again = await json<{ alreadyUnsubscribed: boolean }>(
      await request("acme", `/api/v1/updates/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
      }),
    );
    expect(again.alreadyUnsubscribed).toBe(true);

    const state = await json(
      await request("acme", "/api/v1/updates/subscription", { cookie: investor.cookie }),
    );
    expect(state).toEqual({ subscribed: false });
    const back = await request("acme", "/api/v1/updates/subscription", {
      method: "PUT",
      cookie: investor.cookie,
      body: JSON.stringify({ subscribed: true }),
    });
    expect(await json(back)).toEqual({ subscribed: true });
  });
});

describe("sending domain + settings", () => {
  it("owner sets a domain, records are shown, verification follows DNS, mail is then DKIM-signed", async () => {
    const editorPut = await request("acme", "/api/v1/updates/sending-domain", {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ domain: "mail.acme.test" }),
    });
    expect(editorPut.status).toBe(403);
    const bad = await request("acme", "/api/v1/updates/sending-domain", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ domain: "not a domain" }),
    });
    expect(bad.status).toBe(400);

    const set = await request("acme", "/api/v1/updates/sending-domain", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ domain: "Mail.Acme.test" }),
    });
    expect(set.status).toBe(200);
    const d = await json<{
      domain: string;
      selector: string;
      status: string;
      records: { kind: string; name: string; value: string; required: boolean }[];
    }>(set);
    expect(d.domain).toBe("mail.acme.test");
    expect(d.status).toBe("pending");
    const dkim = d.records.find((r) => r.kind === "dkim");
    expect(dkim?.name).toBe(`${d.selector}._domainkey.mail.acme.test`);
    expect(dkim?.value).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/u);
    expect(d.records.map((r) => [r.kind, r.required])).toEqual([
      ["dkim", true],
      ["spf", false],
      ["dmarc", false],
    ]);

    // Nothing published yet → still pending. (An empty zone answers `nxdomain`, which the
    // service maps to "no records", not to an error.)
    zone.clear();
    const notYet = await json<{ status: string; checks: Record<string, { ok: boolean }> }>(
      await request("acme", "/api/v1/updates/sending-domain/verify", {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(notYet.status).toBe("pending");
    expect(notYet.checks["dkim"]?.ok).toBe(false);

    // A resolver that cannot answer must not read as "your records are missing": it fails the
    // verification and records the reason, which is what `servfail` means.
    dnsFailure = "servfail";
    const unreachable = await json<{ status: string; lastError: string | null }>(
      await request("acme", "/api/v1/updates/sending-domain/verify", {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(unreachable.status).toBe("failed");
    expect(unreachable.lastError).toContain("servfail");
    dnsFailure = undefined;

    // Publish DKIM + DMARC, no SPF. The port hands back the 255-octet chunks of a TXT record
    // already rejoined, so the fake publishes one string per record like the adapter does.
    zone.set(dkim?.name ?? "", [dkim?.value ?? ""]);
    zone.set("_dmarc.mail.acme.test", ["v=DMARC1; p=none"]);
    const verified = await json<{
      status: string;
      verifiedAt: string | null;
      checks: Record<string, { ok: boolean }>;
    }>(
      await request("acme", "/api/v1/updates/sending-domain/verify", {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(verified.status).toBe("verified");
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.checks).toMatchObject({
      dkim: { ok: true },
      spf: { ok: false },
      dmarc: { ok: true },
    });

    /*
     * A transport failure must NOT unverify an already-verified sending domain (E2.1 S5).
     *
     * `lookupTxt` throws for anything that is not `ok`/`nxdomain`, and the DoH adapter reports
     * `other` whenever only one of the two endpoints answers — so a routine single-provider blip
     * used to set `status: "failed"` **and `verifiedAt: null`**, and `signer()` gates on
     * `status === "verified"`: outgoing updates silently stopped being DKIM-signed until an admin
     * happened to click verify again. Under E1.4's `node:dns` a single good answer sufficed, so
     * this was a *new* failure mode introduced into a shipped feature by the resolver swap.
     *
     * "We could not look" is not evidence the records are gone. The status, `verifiedAt` and the
     * `checks` all survive (a red DKIM row beside a green status would be its own lie), and the
     * reason lands in `lastError` — and the signed mail asserted further down is what proves
     * signing is still on.
     */
    dnsFailure = "other";
    const blip = await json<{
      status: string;
      verifiedAt: string | null;
      lastError: string | null;
      lastCheckedAt: string | null;
      checks: Record<string, { ok: boolean }>;
    }>(
      await request("acme", "/api/v1/updates/sending-domain/verify", {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(blip.status).toBe("verified");
    expect(blip.verifiedAt).toBe(verified.verifiedAt);
    expect(blip.lastError).toContain("other");
    expect(blip.lastCheckedAt).not.toBeNull();
    expect(blip.checks).toMatchObject({ dkim: { ok: true }, dmarc: { ok: true } });
    dnsFailure = undefined;

    // Settings: sender name, reply-to, postal address, footer.
    const patched = await request("acme", "/api/v1/updates/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({
        fromName: "Acme IR",
        replyTo: "ir@acme.test",
        postalAddress: "1 Main St, Springfield",
        footerNote: "Confidential. Do not forward.",
      }),
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({
      fromName: "Acme IR",
      fromLocalPart: "updates",
      replyTo: "ir@acme.test",
    });

    // A new update to everyone: signed with the domain key, from the workspace sender.
    mailer.clear();
    const created = await json<Detail>(
      await request("acme", "/api/v1/updates/posts", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ title: "Quick note", template: "minimal" }),
      }),
    );
    const res = await request("acme", `/api/v1/updates/posts/${created.post.id}/send`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(202);
    await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${created.post.id}`, { cookie: owner.cookie }),
      );
      return d.post.state === "sent" ? d : undefined;
    });
    /*
     * Scope the assertion to *this* post's mail. `mailer.clear()` above empties what has already
     * been delivered, but an earlier test's send job is a background worker: it can finish after
     * the clear and drop its recipients into the same array, which made this assertion flake
     * roughly one run in three. The subject is per post, so filtering on it is deterministic
     * regardless of what else is still in flight.
     */
    const mine = mailer.sent.filter((m) => m.subject?.includes("Quick note"));
    expect(mine.map((m) => m.to).sort()).toEqual(["ada@investor.test", "board@investor.test"]);
    const m0 = mine[0];
    expect(m0?.from).toEqual({ address: "updates@mail.acme.test", name: "Acme IR" });
    expect(m0?.dkim).toMatchObject({ domainName: "mail.acme.test", keySelector: d.selector });
    expect(m0?.dkim?.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(m0?.replyTo).toBe("ir@acme.test");
    expect(m0?.text).toContain("1 Main St, Springfield");
    expect(m0?.text).toContain("Confidential. Do not forward.");
    expect(
      recordsFor({
        domain: "x.test",
        selector: "s1",
        publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
      })[0]?.value,
    ).toBe("v=DKIM1; k=rsa; p=AAAA");

    // Removing the domain returns to the operator default sender.
    const removed = await request("acme", "/api/v1/updates/sending-domain", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(removed.status).toBe(200);
    expect(
      await json(await request("acme", "/api/v1/updates/sending-domain", { cookie: owner.cookie })),
    ).toEqual({ domain: null });
  });
});

describe("scheduling", () => {
  it("a scheduled update is sent by the dispatcher once due; unschedule returns it to draft", async () => {
    const created = await json<Detail>(
      await request("acme", "/api/v1/updates/posts", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ title: "Scheduled note", template: "blank" }),
      }),
    );
    const past = await request("acme", `/api/v1/updates/posts/${created.post.id}/schedule`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ scheduledFor: new Date(Date.now() - 60_000).toISOString() }),
    });
    expect(past.status).toBe(400);
    const when = new Date(Date.now() + 2_000).toISOString();
    const scheduled = await json<Detail>(
      await request("acme", `/api/v1/updates/posts/${created.post.id}/schedule`, {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ scheduledFor: when }),
      }),
    );
    expect(scheduled.post.state).toBe("scheduled");
    expect(scheduled.post.scheduledFor).toBe(when);
    const back = await json<Detail>(
      await request("acme", `/api/v1/updates/posts/${created.post.id}/unschedule`, {
        method: "POST",
        cookie: editor.cookie,
      }),
    );
    expect(back.post.state).toBe("draft");
    expect(back.post.scheduledFor).toBeNull();

    await request("acme", `/api/v1/updates/posts/${created.post.id}/schedule`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ scheduledFor: when }),
    });
    await new Promise((r) => setTimeout(r, 2_200));
    mailer.clear();
    // Run the dispatcher directly rather than waiting a minute for the cron tick.
    const jobs = running.container.registry.resolveJobs(running.container.moduleServices);
    const dispatch = jobs.find((j) => j.name === JOB_DISPATCH);
    if (!dispatch) throw new Error("no dispatcher");
    await dispatch.handler({
      id: "test",
      name: JOB_DISPATCH,
      data: { workspaceId: acmeId },
      signal: new AbortController().signal,
    });
    const sent = await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${created.post.id}`, {
          cookie: editor.cookie,
        }),
      );
      return d.post.state === "sent" ? d : undefined;
    });
    expect(sent.post.lastSend).toMatchObject({ kind: "live", status: "finished", sent: 2 });
    expect(mailer.sent).toHaveLength(2);
  });
});

describe("tenancy + records", () => {
  it("every id-bearing route answers 404 for another tenant's ids; delete needs updates.manage", async () => {
    for (const path of [
      `/api/v1/updates/posts/${postId}`,
      `/api/v1/updates/posts/${postId}/sends`,
      `/api/v1/updates/posts/${postId}/replies`,
      `/api/v1/updates/sends/${liveSendId}/recipients`,
      `/api/v1/updates/archive/${postSlug}`,
    ]) {
      const res = await request("globex", path, { cookie: globexOwner.cookie });
      expect(res.status, path).toBe(404);
    }
    const viewerDelete = await request("acme", `/api/v1/updates/posts/${postId}`, {
      method: "DELETE",
      cookie: viewer.cookie,
    });
    expect(viewerDelete.status).toBe(403);
    const deleted = await request("acme", `/api/v1/updates/posts/${postId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(deleted.status).toBe(200);
    expect(
      (await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: editor.cookie })).status,
    ).toBe(404);
  });

  it("audit trail and outbox carry the lifecycle", async () => {
    const rows = await running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      const r = await tx.execute(
        `SELECT action, count(*)::int AS n FROM audit.event WHERE action LIKE 'update.%' OR action LIKE 'sending_domain.%' OR action = 'updates.settings_changed' GROUP BY action ORDER BY action`,
      );
      return r.rows as { action: string; n: number }[];
    });
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toMatchObject({
      "update.created": 3,
      "update.published": 4,
      "update.sent": 3,
      "update.test_sent": 1,
      "update.scheduled": 2,
      "update.unscheduled": 1,
      "update.replied": 2,
      "update.unsubscribed": 2,
      "update.resubscribed": 1,
      "update.deleted": 1,
      "sending_domain.created": 1,
      "sending_domain.verified": 1,
      "sending_domain.deleted": 1,
      "updates.settings_changed": 1,
    });
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT topic, count(*)::int AS n FROM core.outbox WHERE topic LIKE 'update.%' GROUP BY topic ORDER BY topic`,
      );
      return Object.fromEntries(
        (r.rows as { topic: string; n: number }[]).map((x) => [x.topic, x.n]),
      );
    });
    expect(outbox).toMatchObject({ "update.published": 4, "update.sent": 4, "update.replied": 2 });
    /*
     * `update.viewed` is the engagement signal analytics ingests (E1.5). It is emitted from the
     * archive read, and only for external readers — the staff reads in this file must not have
     * produced any, or every founder previewing their own update would show up as a reader.
     */
    expect(outbox["update.viewed"]).toBeGreaterThan(0);
    const viewers = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT DISTINCT payload->>'membershipId' AS m FROM core.outbox WHERE topic = 'update.viewed'`,
      );
      return (r.rows as { m: string }[]).map((x) => x.m);
    });
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers).not.toContain(owner.membershipId);
  });
});

/*
 * E2.6: what the updates module does with the kernel's delivery feedback. Every event here goes
 * through the real outbox — published into `core.outbox` the way the webhook ingress publishes
 * it, fanned out by the relay, handled by the module's subscriber in a system transaction.
 */
describe("delivery feedback, suppression, tracking and erasure (E2.6)", () => {
  let eve: Actor;
  let feedbackPostId: string;
  let feedbackSendId: string;

  const announce = async (topic: EventTopic, payload: Record<string, unknown>) => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload as never));
  };

  const recipientRows = async (sendId: string) =>
    running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      const r = await tx.execute(
        `SELECT membership_id::text AS "membershipId", email::text AS email, status::text AS status,
                error, message_id AS "messageId"
           FROM updates.recipient WHERE send_id = '${sendId}'::uuid ORDER BY email`,
      );
      return r.rows as {
        membershipId: string | null;
        email: string;
        status: string;
        error: string | null;
        messageId: string | null;
      }[];
    });

  const recipientOf = async (sendId: string, membershipId: string) =>
    (await recipientRows(sendId)).find((r) => r.membershipId === membershipId);

  const drained = async (topic: EventTopic) => {
    await waitFor(async () => {
      const pending = await running.container.db.withHost(async (tx) => {
        const r = await tx.execute(
          `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}' AND processed_at IS NULL`,
        );
        return (r.rows as { n: number }[])[0]?.n ?? 0;
      });
      return pending === 0 ? true : undefined;
    });
    // Relayed is not yet handled: give the subscriber job its poll interval.
    await new Promise((r) => setTimeout(r, 1_500));
  };

  const setAnalyticsMode = async (mode: "essential" | "engagement") => {
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.workspace SET settings = jsonb_set(settings, '{analytics}',
            COALESCE(settings->'analytics', '{}'::jsonb) || '{"mode":"${mode}"}'::jsonb)
          WHERE id = '${acmeId}'::uuid`,
      ),
    );
    running.container.resolver.invalidate();
  };

  /** Creates a blank update and sends it live through the dispatcher (no step-up clock needed). */
  const sendLive = async (title: string): Promise<{ postId: string; sendId: string }> => {
    const created = await json<Detail>(
      await request("acme", "/api/v1/updates/posts", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ title, template: "blank" }),
      }),
    );
    const scheduled = await request("acme", `/api/v1/updates/posts/${created.post.id}/schedule`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 1_000).toISOString() }),
    });
    expect(scheduled.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_200));
    const jobs = running.container.registry.resolveJobs(running.container.moduleServices);
    const dispatch = jobs.find((j) => j.name === JOB_DISPATCH);
    if (!dispatch) throw new Error("no dispatcher");
    await dispatch.handler({
      id: "test",
      name: JOB_DISPATCH,
      data: { workspaceId: acmeId },
      signal: new AbortController().signal,
    });
    const sent = await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${created.post.id}`, {
          cookie: editor.cookie,
        }),
      );
      return d.post.state === "sent" && d.post.lastSend?.status === "finished" ? d : undefined;
    });
    return { postId: created.post.id, sendId: sent.post.lastSend?.id ?? "" };
  };

  interface SendStats {
    id: string;
    sent: number;
    skipped: number;
    delivered: number;
    bounced: number;
    complained: number;
  }
  const statsOf = async (postId: string, sendId: string) => {
    const list = await json<{ sends: SendStats[] }>(
      await request("acme", `/api/v1/updates/posts/${postId}/sends`, { cookie: viewer.cookie }),
    );
    return list.sends.find((x) => x.id === sendId);
  };

  it("sets up: a new investor, Ada's tracking consent and a suppressed address", async () => {
    eve = await member("acme", acmeId, "eve@investor.test", "external", "investor");
    const consent = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: investor.cookie,
      body: JSON.stringify({ purpose: "email_tracking", granted: true, source: "settings" }),
    });
    expect(consent.status).toBe(200);
    suppressedAddresses.add("board@investor.test");
  });

  it("asks for no tracking outside `engagement`, even for a member who consented", async () => {
    mailer.clear();
    await sendLive("Essential-mode note");
    const ada = mailer.sent.find((m) => m.to === "ada@investor.test");
    expect(ada).toBeDefined();
    expect(ada?.tracking).toBeUndefined();
    expect(ada?.stream).toBe("broadcast");
  });

  it("in `engagement`, tracks only the consenting member and skips the suppressed address", async () => {
    await setAnalyticsMode("engagement");
    try {
      mailer.clear();
      const out = await sendLive("Engagement-mode note");
      feedbackPostId = out.postId;
      feedbackSendId = out.sendId;
    } finally {
      await setAnalyticsMode("essential");
    }
    const ada = mailer.sent.find((m) => m.to === "ada@investor.test");
    const eveMail = mailer.sent.find((m) => m.to === "eve@investor.test");
    expect(ada?.tracking).toEqual({ opens: true, clicks: true });
    expect(ada?.ref).toEqual({
      kind: "post",
      id: feedbackPostId,
      membershipId: investor.membershipId,
    });
    // Eve never answered; under the default `opt_in` consent mode that is a no.
    expect(eveMail).toBeDefined();
    expect(eveMail?.tracking).toBeUndefined();
    // The suppressed address was never handed over, and its row says why.
    expect(mailer.sent.some((m) => m.to === "board@investor.test")).toBe(false);
    const board = await recipientOf(feedbackSendId, boardInvestor.membershipId);
    expect(board).toMatchObject({ status: "skipped", error: "suppressed" });
    const stats = await statsOf(feedbackPostId, feedbackSendId);
    expect(stats?.skipped).toBeGreaterThanOrEqual(1);
    expect(stats).toMatchObject({ delivered: 0, bounced: 0, complained: 0 });
    suppressedAddresses.clear();
  });

  const feedback = async (
    membershipId: string,
    kind: "delivered" | "bounce" | "complaint" | "open",
    extra: Record<string, unknown> = {},
  ) => {
    const row = await recipientOf(feedbackSendId, membershipId);
    if (!row?.messageId) throw new Error("no message id");
    await announce("mail.delivery_recorded", {
      messageRef: randomUUID(),
      providerMessageId: row.messageId,
      kind,
      bounceType: kind === "bounce" ? "hard" : null,
      automated: false,
      refKind: "post",
      refId: feedbackPostId,
      membershipId,
      link: null,
      occurredAt: new Date().toISOString(),
      ...extra,
    });
  };

  it("a soft bounce is noted on the row but neither bounces it nor moves the stats", async () => {
    await feedback(investor.membershipId, "bounce", { bounceType: "soft" });
    const noted = await waitFor(async () => {
      const r = await recipientOf(feedbackSendId, investor.membershipId);
      return r?.error === "bounce:soft" ? r : undefined;
    });
    expect(noted.status).toBe("sent");
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({
      delivered: 0,
      bounced: 0,
    });
  });

  it("moves a recipient to delivered, then bounced, and the send's stats follow", async () => {
    await feedback(investor.membershipId, "delivered");
    await waitFor(async () =>
      (await recipientOf(feedbackSendId, investor.membershipId))?.status === "delivered"
        ? true
        : undefined,
    );
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({
      delivered: 1,
      bounced: 0,
    });

    await feedback(investor.membershipId, "bounce");
    const bounced = await waitFor(async () => {
      const r = await recipientOf(feedbackSendId, investor.membershipId);
      return r?.status === "bounced" ? r : undefined;
    });
    expect(bounced.error).toBe("bounce:hard");
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({
      delivered: 0,
      bounced: 1,
    });
  });

  it("never downgrades a bounce, and ignores opens and mail that is not an update", async () => {
    await feedback(investor.membershipId, "delivered");
    await feedback(investor.membershipId, "open");
    await feedback(eve.membershipId, "delivered", { refKind: "notification" });
    await drained("mail.delivery_recorded");
    expect((await recipientOf(feedbackSendId, investor.membershipId))?.status).toBe("bounced");
    expect((await recipientOf(feedbackSendId, eve.membershipId))?.status).toBe("sent");
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({
      delivered: 0,
      bounced: 1,
      complained: 0,
    });
  });

  it("records a complaint", async () => {
    await feedback(eve.membershipId, "complaint");
    await waitFor(async () =>
      (await recipientOf(feedbackSendId, eve.membershipId))?.status === "complained"
        ? true
        : undefined,
    );
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({
      bounced: 1,
      complained: 1,
    });
  });

  it("erasure pseudonymises the member's recipient rows and replies but keeps the opt-out", async () => {
    const replied = await request("acme", `/api/v1/updates/posts/${feedbackPostId}/replies`, {
      method: "POST",
      cookie: eve.cookie,
      body: JSON.stringify({ body: "Eve here, call me on 555-0100." }),
    });
    expect(replied.status).toBe(201);
    const off = await request("acme", "/api/v1/updates/subscription", {
      method: "PUT",
      cookie: eve.cookie,
      body: JSON.stringify({ subscribed: false }),
    });
    expect(await json(off)).toEqual({ subscribed: false });

    const before = (await recipientRows(feedbackSendId)).length;
    const requestId = randomUUID();
    await announce("member.erasure_requested", { requestId, membershipId: eve.membershipId });
    const erased = await waitFor(async () => {
      const r = await recipientOf(feedbackSendId, eve.membershipId);
      return r?.email.endsWith("@erased.invalid") ? r : undefined;
    });
    // The row, its status and therefore the send's counts survive; the address does not.
    expect(erased.status).toBe("complained");
    expect(erased.email).not.toContain("eve");
    expect(await recipientRows(feedbackSendId)).toHaveLength(before);
    expect(await statsOf(feedbackPostId, feedbackSendId)).toMatchObject({ complained: 1 });

    const store = await running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      const everywhere = await tx.execute(
        `SELECT count(*)::int AS n FROM updates.recipient
          WHERE membership_id = '${eve.membershipId}'::uuid AND email::text LIKE '%eve%'`,
      );
      const replies = await tx.execute(
        `SELECT body, deleted_at IS NOT NULL AS deleted FROM updates.reply
          WHERE thread_membership_id = '${eve.membershipId}'::uuid`,
      );
      const unsub = await tx.execute(
        `SELECT email::text AS email FROM updates.unsubscribe
          WHERE membership_id = '${eve.membershipId}'::uuid`,
      );
      return {
        leaked: (everywhere.rows as { n: number }[])[0]?.n,
        replies: replies.rows as { body: string; deleted: boolean }[],
        optOuts: unsub.rows as { email: string }[],
      };
    });
    expect(store.leaked).toBe(0);
    expect(store.replies).toEqual([{ body: "[erased]", deleted: true }]);
    // An opt-out must survive the erasure of the person who gave it — without their address.
    expect(store.optOuts).toEqual([{ email: "erased@erased.invalid" }]);

    // Redelivery changes nothing: already-erased rows are not rewritten.
    const snapshot = await recipientRows(feedbackSendId);
    await announce("member.erasure_requested", { requestId, membershipId: eve.membershipId });
    await drained("member.erasure_requested");
    expect(await recipientRows(feedbackSendId)).toEqual(snapshot);

    // The pseudonymised opt-out still works: the send path looks it up by membership id.
    mailer.clear();
    const next = await sendLive("After Eve's erasure");
    expect(mailer.sent.some((m) => m.to === "eve@investor.test")).toBe(false);
    expect(await recipientOf(next.sendId, eve.membershipId)).toMatchObject({
      status: "skipped",
      error: "unsubscribed",
    });
  });
  /*
   * Contract decision 5 (amended): a DSAR must reach rows written while the module was on, and
   * the kernel waits for an `updates` step from every workspace. So with the module switched
   * off, a real erasure request (created through the compliance route, published by the
   * kernel) still pseudonymises the member's rows and records the step.
   */
  it("erases and records its DSAR step even while the module is switched off", async () => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("updates", false),
    );
    running.container.enablement.invalidate(acmeId);
    try {
      const created = await request("acme", "/api/v1/compliance/erasure-requests", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ membershipId: boardInvestor.membershipId }),
      });
      expect(created.status).toBe(201);
      const { id } = await json<{ id: string }>(created);
      const step = await waitFor(async () => {
        const r = await running.container.db.withTenant(ctx, (tx) =>
          tx.execute(
            `SELECT counts FROM core.dsar_step
              WHERE request_id = '${id}'::uuid AND module = 'updates'`,
          ),
        );
        return (r.rows as { counts: Record<string, number> }[])[0];
      });
      expect(step.counts["recipients"]).toBeGreaterThan(0);
      const leaked = await running.container.db.withTenant(ctx, async (tx) => {
        const r = await tx.execute(
          `SELECT count(*)::int AS n FROM updates.recipient
            WHERE membership_id = '${boardInvestor.membershipId}'::uuid
              AND email::text NOT LIKE '%@erased.invalid'`,
        );
        return (r.rows as { n: number }[])[0]?.n;
      });
      expect(leaked).toBe(0);
    } finally {
      await running.container.db.withTenant(ctx, (tx) =>
        new ModuleEnablementRepo(ctx, tx).set("updates", true),
      );
      running.container.enablement.invalidate(acmeId);
    }
  });

  it("drops delivery feedback about a member whose erasure was requested", async () => {
    const zed = await member("acme", acmeId, "zed@investor.test", "external", "investor");
    mailer.clear();
    const { postId, sendId } = await sendLive("Zed's first update");
    const row = await waitFor(async () => {
      const r = await recipientOf(sendId, zed.membershipId);
      return r?.status === "sent" && r.messageId ? r : undefined;
    });
    const created = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: zed.membershipId }),
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    await waitFor(async () => {
      const r = await running.container.db.withTenant(systemContext(acmeId), (tx) =>
        tx.execute(
          `SELECT 1 FROM core.dsar_step WHERE request_id = '${id}'::uuid AND module = 'updates'`,
        ),
      );
      return r.rows[0];
    });
    // A hard bounce that arrives after the request (the ESP took its time) changes nothing.
    await announce("mail.delivery_recorded", {
      messageRef: randomUUID(),
      providerMessageId: row.messageId,
      kind: "bounce",
      bounceType: "hard",
      automated: false,
      refKind: "post",
      refId: postId,
      membershipId: zed.membershipId,
      link: null,
      occurredAt: new Date().toISOString(),
    });
    await drained("mail.delivery_recorded");
    const after = await recipientOf(sendId, zed.membershipId);
    expect(after?.status).toBe("sent");
    expect(after?.email.endsWith("@erased.invalid")).toBe(true);
    expect(await statsOf(postId, sendId)).toMatchObject({ bounced: 0 });
  });
});

describe("workspace search (E2.8)", () => {
  // Its own board member: the E2.6 erasure test above erases `boardInvestor`, whose session is
  // then gone, so reusing it here made these tests depend on running before that one.
  let boardInvestor: Actor;
  beforeAll(async () => {
    boardInvestor = await member(
      "acme",
      acmeId,
      "board-search@investor.test",
      "external",
      "investor",
    );
    const added = await request("acme", `/api/v1/access/groups/${boardGroupId}/members`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipIds: [boardInvestor.membershipId] }),
    });
    expect(added.status).toBe(200);
  });
  interface Hits {
    hits: { module: string; kind: string; refId: string; title: string; href: string }[];
  }
  const search = async (actor: Actor, q: string) => {
    const res = await request("acme", `/api/v1/search?q=${encodeURIComponent(q)}`, {
      cookie: actor.cookie,
    });
    expect(res.status).toBe(200);
    return (await json<Hits>(res)).hits.filter((h) => h.module === "updates");
  };
  const text = (id: string, words: string) => ({
    id,
    type: "rich_text",
    schemaVersion: 1,
    data: { format: "markdown", text: words },
  });
  const create = async (title: string) => {
    const created = await request("acme", "/api/v1/updates/posts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ title, template: "blank" }),
    });
    expect(created.status).toBe(201);
    return (await json<Detail>(created)).post;
  };
  let probe: { id: string; slug: string };

  it("a draft is never findable; once sent, each section is findable per audience × visibility", async () => {
    probe = await create("Search probe update");
    const saved = await request("acme", `/api/v1/updates/posts/${probe.id}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            { key: "recap", title: null, blocks: [text("a", "Pangolinmarimba for everyone")] },
            { key: "board", title: "Board", blocks: [text("b", "Narwhalocarina for the board")] },
            { key: "internal", title: null, blocks: [text("c", "Axolotlbassoon for staff")] },
          ],
        },
        visibility: {
          recap: { mode: "authenticated" },
          board: { mode: "groups", groupIds: [boardGroupId] },
          internal: { mode: "staff_only" },
        },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await search(owner, "pangolinmarimba")).toEqual([]);
    expect(await search(investor, "pangolinmarimba")).toEqual([]);

    const published = await request("acme", `/api/v1/updates/posts/${probe.id}/publish`, {
      method: "POST",
      cookie: editor.cookie,
    });
    expect(published.status).toBe(200);
    expect((await json<Detail>(published)).post.state).toBe("sent");

    const hits = await search(investor, "pangolinmarimba");
    expect(hits.map((h) => [h.kind, h.refId, h.href, h.title])).toEqual([
      ["post", probe.id, `/updates/${probe.slug}`, "Search probe update"],
    ]);
    expect(await search(investor, "narwhalocarina")).toEqual([]);
    expect((await search(boardInvestor, "narwhalocarina")).map((h) => h.refId)).toEqual([probe.id]);
    expect(await search(investor, "axolotlbassoon")).toEqual([]);
    expect(await search(boardInvestor, "axolotlbassoon")).toEqual([]);
    expect((await search(owner, "axolotlbassoon")).map((h) => h.refId)).toEqual([probe.id]);
  });

  it("narrowing a sent post's audience narrows its hits at once", async () => {
    const narrowed = await request("acme", `/api/v1/updates/posts/${probe.id}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ audience: { kind: "groups", groupIds: [boardGroupId] } }),
    });
    expect(narrowed.status).toBe(200);
    expect(await search(investor, "pangolinmarimba")).toEqual([]);
    expect((await search(boardInvestor, "pangolinmarimba")).map((h) => h.refId)).toEqual([
      probe.id,
    ]);
  });

  it("archiving removes the post from search, restoring brings it back, deleting removes it", async () => {
    const hide = await request("acme", `/api/v1/updates/posts/${probe.id}/archived`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ archived: true }),
    });
    expect(hide.status).toBe(200);
    expect(await search(boardInvestor, "pangolinmarimba")).toEqual([]);
    expect(await search(owner, "pangolinmarimba")).toEqual([]);
    await request("acme", `/api/v1/updates/posts/${probe.id}/archived`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({ archived: false }),
    });
    expect((await search(boardInvestor, "pangolinmarimba")).map((h) => h.refId)).toEqual([
      probe.id,
    ]);
    const del = await request("acme", `/api/v1/updates/posts/${probe.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    expect(await search(boardInvestor, "pangolinmarimba")).toEqual([]);
    expect(await search(owner, "pangolinmarimba")).toEqual([]);
  });

  it("a live send is indexed by the delivery job when the post becomes sent", async () => {
    const post = await create("Search send probe");
    await request("acme", `/api/v1/updates/posts/${post.id}/draft`, {
      method: "PUT",
      cookie: editor.cookie,
      body: JSON.stringify({
        doc: { sections: [{ key: "recap", title: null, blocks: [text("a", "Wombatzither")] }] },
      }),
    });
    const res = await request("acme", `/api/v1/updates/posts/${post.id}/send`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(202);
    await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${post.id}`, { cookie: editor.cookie }),
      );
      return d.post.state === "sent" ? d : undefined;
    });
    expect((await search(investor, "wombatzither")).map((h) => h.refId)).toEqual([post.id]);
  });
});

describe("an SMTP outage during a send (E2.10)", () => {
  let tina: Actor;
  let perm: Actor;

  const rowsOf = async (sendId: string) =>
    running.container.db.withTenant(systemContext(acmeId), async (tx) => {
      const r = await tx.execute(
        `SELECT email::text AS email, status::text AS status, error
           FROM updates.recipient WHERE send_id = '${sendId}'::uuid ORDER BY email`,
      );
      return new Map(
        (r.rows as { email: string; status: string; error: string | null }[]).map((x) => [
          x.email,
          x,
        ]),
      );
    });

  const jobs = () => running.container.registry.resolveJobs(running.container.moduleServices);
  const runJob = async (name: string, data: Record<string, unknown>) => {
    const job = jobs().find((j) => j.name === name);
    if (!job) throw new Error(`no job ${name}`);
    await job.handler({
      id: randomUUID(),
      name,
      data: data as never,
      signal: new AbortController().signal,
    });
  };

  /** Creates an update and hands it to the dispatcher; the worker picks the send job up. */
  const dispatch = async (title: string): Promise<{ postId: string; sendId: string }> => {
    const created = await json<Detail>(
      await request("acme", "/api/v1/updates/posts", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ title, template: "blank" }),
      }),
    );
    const scheduled = await request("acme", `/api/v1/updates/posts/${created.post.id}/schedule`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ scheduledFor: new Date(Date.now() + 1_000).toISOString() }),
    });
    expect(scheduled.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_200));
    await runJob(JOB_DISPATCH, { workspaceId: acmeId });
    const detail = await waitFor(async () => {
      const d = await json<Detail>(
        await request("acme", `/api/v1/updates/posts/${created.post.id}`, {
          cookie: editor.cookie,
        }),
      );
      return d.post.lastSend ? d : undefined;
    });
    return { postId: created.post.id, sendId: detail.post.lastSend?.id ?? "" };
  };

  const detailOf = async (postId: string) =>
    json<Detail>(
      await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: editor.cookie }),
    );

  it("keeps a transiently failed recipient queued, retries it once the relay is back, and fails a 5xx for good", async () => {
    tina = await member("acme", acmeId, "tina@investor.test", "external", "investor");
    perm = await member("acme", acmeId, "perm@investor.test", "external", "investor");
    suppressedAddresses.clear();
    transientFailures.set("tina@investor.test", 2);
    permanentFailures.add("perm@investor.test");
    mailer.clear();
    const title = "Outage note";

    const { postId: outagePost, sendId } = await dispatch(title);

    // Attempt 1 (the worker): Tina's relay refuses, Perm's server says 550, Ada gets hers.
    const first = await waitFor(async () => {
      const rows = await rowsOf(sendId);
      return rows.get("tina@investor.test")?.error?.startsWith("retrying:") &&
        rows.get("perm@investor.test")?.status === "failed"
        ? rows
        : undefined;
    });
    expect(first.get("tina@investor.test")).toMatchObject({
      status: "queued",
      error: "retrying: could not send the message",
    });
    expect(first.get("perm@investor.test")?.error).toBe("could not send the message");
    expect(first.get("ada@investor.test")?.status).toBe("sent");
    // Not finished: the send is still running — but everyone was tried and Ada's mail went out,
    // so the post is already in the archive her "view on the web" link points at (R1-A4).
    const midway = await detailOf(outagePost);
    expect(midway.post.state).toBe("sent");
    expect(midway.post.lastSend?.status).toBe("running");

    // Attempt 2 (a retry of the job): still down — the job fails again, so pg-boss retries it.
    await expect(runJob(JOB_SEND, { workspaceId: acmeId, sendId, testTo: [] })).rejects.toThrow(
      /deferred/u,
    );
    // Attempt 3: the relay is back. Tina's mail goes; nobody else is sent anything again.
    await runJob(JOB_SEND, { workspaceId: acmeId, sendId, testTo: [] });

    const done = await rowsOf(sendId);
    expect(done.get("tina@investor.test")).toMatchObject({ status: "sent", error: null });
    expect(done.get("perm@investor.test")?.status).toBe("failed");
    const finished = await detailOf(outagePost);
    expect(finished.post.state).toBe("sent");
    expect(finished.post.lastSend).toMatchObject({ status: "finished", failed: 1 });

    const mine = (to: string) => attempts.filter((a) => a.to === to && a.subject.includes(title));
    expect(mine("tina@investor.test")).toHaveLength(3);
    // A 5xx is final: tried once, never retried.
    expect(mine("perm@investor.test")).toHaveLength(1);
    expect(mine("ada@investor.test")).toHaveLength(1);
    // Exactly one copy reached each address that got one.
    const delivered = (to: string) =>
      mailer.sent.filter((m) => m.to === to && m.subject?.includes(title));
    expect(delivered("tina@investor.test")).toHaveLength(1);
    expect(delivered("ada@investor.test")).toHaveLength(1);
    expect(delivered("perm@investor.test")).toHaveLength(0);
    expect(tina.membershipId).not.toBe(perm.membershipId);
  });

  it("hands each recipient to the mailer once even when three runs of one send race", async () => {
    permanentFailures.clear();
    mailer.clear();
    const title = "Racing note";
    const { postId: racingPost, sendId } = await dispatch(title);
    // The worker's run is already going; two more (a pg-boss retry and the dispatcher's stale
    // re-enqueue, say) start on top of it. Any of them may lose rows to the others and defer.
    await Promise.allSettled([
      runJob(JOB_SEND, { workspaceId: acmeId, sendId, testTo: [] }),
      runJob(JOB_SEND, { workspaceId: acmeId, sendId, testTo: [] }),
    ]);
    await waitFor(async () => {
      const d = await detailOf(racingPost);
      if (d.post.lastSend?.status === "finished") return d;
      // A run that lost a row to another defers; the retry is what closes the send.
      await runJob(JOB_SEND, { workspaceId: acmeId, sendId, testTo: [] }).catch(() => undefined);
      return undefined;
    });
    const rows = await rowsOf(sendId);
    const sentTo = [...rows.values()].filter((r) => r.status === "sent").map((r) => r.email);
    expect(sentTo.length).toBeGreaterThanOrEqual(3);
    for (const to of sentTo) {
      expect(
        attempts.filter((a) => a.to === to && a.subject.includes(title)),
        to,
      ).toHaveLength(1);
    }
  });
});
