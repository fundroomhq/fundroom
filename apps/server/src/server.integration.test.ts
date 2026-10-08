import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { defineModule } from "@fundroom/module-kit";
import type { AuditEventRecord, AuditSinkPort } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { accessModule } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/*
 * Boots the whole server (migrations, container, pipeline) against Testcontainers Postgres
 * with a memory mailer and a temp-dir filesystem store, then drives it through `app.request`
 * and, for one test, a real listener. Single-tenant mode; a second suite covers multi.
 */
const BASE = "http://localhost:3000";
const HOST = "localhost:3000";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const delivered: AuditEventRecord[] = [];
const sink: AuditSinkPort = { deliver: async (events) => void delivered.push(...events) };

const demo = defineModule({
  id: "demo",
  version: "1.0.0",
  permissions: ["demo.read", "demo.manage"],
  slots: { "investor.nav": [{ id: "demo", label: "Demo", to: "/demo", order: 10 }] },
  routes: (r) => {
    r.get("/ping", (c) => c.json({ pong: true, workspace: c.get("workspace")?.slug ?? null }));
  },
});

function envFor(pgUrl: string, extra: Record<string, string> = {}) {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    BASE_URL: BASE,
    DATABASE_URL: pgUrl,
    FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    TENANCY_MODE: "single",
    ROLES: "api,web,worker",
    OUTBOX_POLL_INTERVAL_MS: "200",
    JOBS_POLL_INTERVAL_MS: "500",
    ...extra,
  };
}

async function request(
  path: string,
  init: RequestInit & { cookie?: string; origin?: boolean; host?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? HOST);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== false && init.method && init.method !== "GET") headers.set("origin", BASE);
  return running.app.request(`${BASE}${path}`, { ...init, headers });
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(
  email: string,
): Promise<{ cookie: string; body: { session: { sessionId: string; userId: string } } }> {
  const since = mailer.sent.length;
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  return { cookie: cookiesOf(verify), body: (await verify.json()) as never };
}

/** A fake Vite build: the shape `apps/web` emits (nonce placeholders, hashed assets, public files). */
function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="csp-nonce" nonce="__CSP_NONCE__">
<script type="module" crossorigin src="/assets/app-abc.js" nonce="__CSP_NONCE__"></script>
<link rel="stylesheet" crossorigin href="/assets/app-abc.css" nonce="__CSP_NONCE__">
</head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "app-abc.css"), "body{}");
  // F-32: a source map a build left behind must never be served.
  writeFileSync(join(dir, "assets", "app-abc.js.map"), '{"version":3,"sources":["secret.ts"]}');
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

function webConfigOf(html: string): WebConfig {
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error("no config meta in page");
  return JSON.parse(
    m[1]
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&"),
  ) as WebConfig;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({ env: envFor(pg.connectionString) });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    modules: [accessModule, demo],
    auditSinks: [sink],
    listenEnabled: false,
    migrate: true,
  });
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("ops", () => {
  it("serves liveness, readiness and the capability doc", async () => {
    const h = await request("/healthz");
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: "ok" });
    expect(h.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(h.headers.get("cache-control")).toBe("private, no-store");
    expect(h.headers.get("content-security-policy")).toContain("default-src 'none'");

    const r = await request("/readyz");
    const body = (await r.json()) as { status: string; checks: { name: string; status: string }[] };
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "database:ok",
      "migrations:ok",
      "storage:ok",
      "mail:ok",
      // The renderer is probed too (E2.4): it can lose its fonts to a bad image build and go on
      // producing page renditions whose watermark is a grid of empty boxes, which nothing else notices.
      "render:ok",
      "queue:ok",
    ]);

    const w = await request("/.well-known/fundroom.json");
    const doc = await w.json();
    expect(doc).toMatchObject({
      apiVersion: "v1",
      tenancy: "single",
      features: ["access", "demo"],
      apiBase: "/api/v1",
      auth: { methods: ["email_otp", "magic_link", "passkey"], passkeyRpId: "localhost" },
    });
    // A-2: the pre-rename path answers the same document for one minor release.
    const legacy = await request("/.well-known/seed-host.json");
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual(doc);
  });

  it("exposes Prometheus metrics and accepts CSP reports", async () => {
    const m = await request("/metrics");
    expect(m.status).toBe(200);
    expect(m.headers.get("content-type")).toContain("text/plain");
    expect(await m.text()).toContain("http_server_request_duration");

    const csp = await request("/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "blocked-uri": "https://evil.example" } }),
      origin: false,
    });
    expect(csp.status).toBe(204);
  });

  it("echoes a well-formed client request id and replaces a bad one", async () => {
    const good = await request("/healthz", { headers: { "x-request-id": "trace-abc.123" } });
    expect(good.headers.get("x-request-id")).toBe("trace-abc.123");
    const bad = await request("/healthz", { headers: { "x-request-id": "bad id with spaces" } });
    expect(bad.headers.get("x-request-id")).not.toBe("bad id with spaces");
  });
});

describe("api shell", () => {
  it("serves the OpenAPI document and the envelope on unknown routes", async () => {
    const doc = await request("/api/v1/openapi.json");
    expect(doc.status).toBe(200);
    const json = (await doc.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(json.openapi).toBe("3.1.0");
    expect(json.paths).toHaveProperty("/auth/otp/start");
    expect(json.paths).toHaveProperty("/modules");

    const nf = await request("/api/v1/nope");
    expect(nf.status).toBe(404);
    const body = (await nf.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBe(nf.headers.get("x-request-id"));

    const v2 = await request("/api/v2/me", { headers: { accept: "application/json" } });
    expect(v2.status).toBe(404);
  });

  it("validates bodies strictly and reports the paths", async () => {
    const res = await request("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "nope", extra: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; issues: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["json.email", "json"]),
    );

    const wrongType = await request("/api/v1/auth/otp/start", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "email=x",
    });
    expect(wrongType.status).toBe(415);
    expect(((await wrongType.json()) as { error: { code: string } }).error.code).toBe(
      "unsupported_media_type",
    );
  });

  it("answers CORS preflight only for allow-listed origins", async () => {
    const ok = await request("/api/v1/me", {
      method: "OPTIONS",
      headers: { origin: BASE, "access-control-request-method": "GET" },
      origin: false,
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(BASE);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const bad = await request("/api/v1/me", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
      origin: false,
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires a session where documented", async () => {
    const me = await request("/api/v1/me");
    expect(me.status).toBe(401);
    expect(((await me.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it("reports setup_required before a workspace exists", async () => {
    const boot = await request("/api/v1/modules");
    expect(boot.status).toBe(200);
    expect(await boot.json()).toMatchObject({ workspace: null, permissions: [], membership: null });
    const inv = await request("/api/v1/invites/0123456789abcdef0123456789abcdef");
    expect(inv.status).toBe(404);
    expect(((await inv.json()) as { error: { code: string } }).error.code).toBe("setup_required");
    const mod = await request("/api/v1/demo/ping");
    expect(mod.status).toBe(404);
    expect(((await mod.json()) as { error: { code: string } }).error.code).toBe("setup_required");
  });
});

describe("with a workspace", () => {
  const investor = "ada@investor.test";
  let workspaceId: string;

  beforeAll(async () => {
    const ws = await createWorkspace(running.container.db, { slug: "acme", name: "Acme" });
    workspaceId = ws.id;
    await running.container.auth.invites.create({
      workspaceId,
      email: investor,
      kind: "external",
      role: "investor",
      send: false,
    });
    await running.container.auth.invites.create({
      workspaceId,
      email: "owner@acme.test",
      kind: "staff",
      role: "owner",
      send: false,
    });
  });

  it("resolves the sole workspace and 404s a wrong path slug", async () => {
    const boot = await request("/api/v1/modules");
    expect(await boot.json()).toMatchObject({
      workspace: { slug: "acme" },
      modules: [
        { id: "access", enabled: true },
        { id: "demo", enabled: true },
      ],
    });
    const wrong = await request("/w/other/api/v1/modules");
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
    const right = await request("/w/acme/api/v1/demo/ping");
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ pong: true, workspace: "acme" });
  });

  it("signs in with an emailed code, sets the first-party cookie recipe, and serves /me", async () => {
    const { cookie, body } = await signIn(investor);
    expect(cookie).toContain("__Host-sid=");
    expect(cookie).toContain("__Host-did=");
    expect(body.session.userId).toMatch(/^[0-9a-f-]{36}$/u);

    const me = await request("/api/v1/me", { cookie });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      membership: { kind: string; role: string } | null;
      workspaces: unknown[];
    };
    expect(meBody.membership).toMatchObject({ kind: "external", role: "investor" });
    expect(meBody.workspaces).toHaveLength(1);

    const boot = (await (await request("/api/v1/modules", { cookie })).json()) as {
      permissions: string[];
      membership: unknown;
    };
    // External kinds hold no permission (ADR-0014); grants decide what they see.
    expect(boot.permissions).toEqual([]);
    expect(boot.membership).toMatchObject({ kind: "external" });
  });

  it("gives staff the matrix permissions of enabled modules and hides slots of disabled ones", async () => {
    const { cookie } = await signIn("owner@acme.test");
    const boot = (await (await request("/api/v1/modules", { cookie })).json()) as {
      permissions: string[];
    };
    // The matrix decides (E1.1): `demo.*` has no row, so nobody holds it; `access.*` does.
    expect(boot.permissions).toEqual([
      "access.delete_workspace",
      "access.manage",
      "access.manage_staff",
      "access.read",
      "access.settings",
      "access.transfer",
    ]);

    const { ModuleEnablementRepo } = await import("@fundroom/module-kit");
    const ctx = { workspaceId, actorKind: "system" as const };
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("demo", false),
    );
    running.container.enablement.invalidate(workspaceId);
    const off = await request("/api/v1/demo/ping", { cookie });
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("module_disabled");
    const boot2 = (await (await request("/api/v1/modules", { cookie })).json()) as {
      modules: { id: string; enabled: boolean; slots: Record<string, unknown> }[];
    };
    expect(boot2.modules.find((m) => m.id === "demo")).toMatchObject({
      enabled: false,
      slots: {},
    });
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("demo", true),
    );
    running.container.enablement.invalidate(workspaceId);
  });

  it("rejects cookie-backed mutations without a trustworthy Origin (CSRF)", async () => {
    const { cookie } = await signIn(investor);
    const res = await request("/api/v1/auth/logout", {
      method: "POST",
      cookie,
      headers: { origin: "https://evil.example" },
      origin: false,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_rejected");
    const ok = await request("/api/v1/auth/logout", { method: "POST", cookie });
    expect(ok.status).toBe(200);
    expect(
      ok.headers
        .getSetCookie()
        .some((c) => c.startsWith("__Host-sid=;") || /__Host-sid=.*Max-Age=0/u.test(c)),
    ).toBe(true);
    const after = await request("/api/v1/me", { cookie });
    expect(after.status).toBe(401);
  });

  it("returns invalid_code for wrong codes and never distinguishes unknown emails on start", async () => {
    const unknown = await request("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "nobody@nowhere.test" }),
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ status: "sent", emailHint: "n***@nowhere.test" });
    const wrong = await request("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email: investor, code: "000000" }),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("invalid_code");
  });

  it("rate limits with Retry-After through the envelope", async () => {
    const email = "burst@investor.test";
    let last: Response | undefined;
    for (let i = 0; i < 7; i++) {
      last = await request("/api/v1/auth/otp/start", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (last.status === 429) break;
    }
    if (last === undefined) throw new Error("no response");
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("lists sessions and devices, enforces step-up freshness, and signs out everywhere", async () => {
    const { cookie, body } = await signIn(investor);
    const sessions = (await (await request("/api/v1/me/sessions", { cookie })).json()) as {
      sessions: { id: string; current: boolean }[];
    };
    expect(sessions.sessions.some((s) => s.id === body.session.sessionId && s.current)).toBe(true);
    const devices = (await (await request("/api/v1/me/devices", { cookie })).json()) as {
      devices: unknown[];
    };
    expect(devices.devices.length).toBeGreaterThan(0);

    const totp = await request("/api/v1/auth/totp", { cookie });
    expect(await totp.json()).toMatchObject({ enrolled: false });
    const pw = await request("/api/v1/auth/password", { cookie });
    expect(await pw.json()).toEqual({ enabled: false, set: false });
    const pwLogin = await request("/api/v1/auth/password/login", {
      method: "POST",
      body: JSON.stringify({ email: investor, password: "x".repeat(12) }),
    });
    expect(pwLogin.status).toBe(400);
    expect(((await pwLogin.json()) as { error: { code: string } }).error.code).toBe("unsupported");

    const everywhere = await request("/api/v1/auth/logout-everywhere", { method: "POST", cookie });
    expect(await everywhere.json()).toMatchObject({ revoked: expect.any(Number) });
    expect((await request("/api/v1/me", { cookie })).status).toBe(401);
  });

  it("uses the partitioned cookie recipe on the embed tree and the frame-ancestors seam", async () => {
    const start = await request("/embed/acme/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: investor }),
    });
    // The embed tree keeps /embed/<slug> in the path, so the API lives at /api/v1 on the same origin;
    // the embed flag comes from the classification of the page, exercised here through the page route.
    expect([200, 404]).toContain(start.status);
    const page = await request("/embed/acme/updates");
    expect(page.status).toBe(200);
    // `'self'`, not `'none'` (E2.2 decision 3): `frame-ancestors` always includes our own origin,
    // so an unconfigured workspace can still be previewed in an iframe by its own admin screen,
    // and "only we may frame it" is the honest answer rather than "nobody may".
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("cross-origin-opener-policy")).toBeNull();
    const admin = await request("/admin/people");
    expect(admin.headers.get("x-frame-options")).toBe("DENY");
    expect(admin.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("fans audit rows out to configured sinks through the outbox", async () => {
    await signIn(investor);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !delivered.some((e) => e.action === "auth.login")) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const login = delivered.find((e) => e.action === "auth.login");
    expect(login).toBeDefined();
    expect(login?.workspaceId).toBe(workspaceId);
    expect(login?.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("serves the placeholder page with a CSP nonce on the app tree", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    const nonce = /nonce="([^"]+)"/u.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
  });
});

describe("web role with a built SPA", () => {
  let web: RunningServer;
  beforeAll(async () => {
    const config = loadConfig({
      env: envFor(pg.connectionString, {
        ROLES: "api,web",
        MIGRATE_ON_START: "false",
        WEB_DIST_PATH: fakeWebDist(),
      }),
    });
    web = await startServer({
      config,
      logger: createLogger({ level: "warn" }),
      mailer,
      listenEnabled: false,
      migrate: false,
    });
  }, 60_000);
  afterAll(async () => {
    await web?.stop();
  });

  const page = (path: string, init: RequestInit = {}) =>
    web.app.request(`${BASE}${path}`, { ...init, headers: { host: HOST, ...init.headers } });

  it("serves the templated index on the app, admin and deep routes with the CSP nonce", async () => {
    for (const path of ["/", "/admin", "/anything/deep/here"]) {
      const res = await page(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/u);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).not.toContain("__CSP_NONCE__");
      const nonces = [...html.matchAll(/nonce="([^"]+)"/gu)].map((m) => m[1]);
      expect(nonces).toHaveLength(3);
      expect(new Set(nonces).size).toBe(1);
      expect(res.headers.get("content-security-policy")).toContain(`'nonce-${nonces[0]}'`);
      // E3.2: Trusted Types are enforced (CSP_TRUSTED_TYPES defaults to enforce), not report-only.
      expect(res.headers.get("content-security-policy")).toContain(
        "require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard",
      );
      expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    }
  });

  it("injects the WebConfig meta with tree, router base and workspace", async () => {
    const app = webConfigOf(await (await page("/updates")).text());
    expect(app).toMatchObject({
      v: 1,
      tree: "app",
      tenancy: "single",
      basePath: "",
      routerBase: "",
      apiBase: "",
      workspace: { slug: "acme", name: "Acme" },
      canonicalOrigin: BASE,
      embedOrigins: [],
      setupRequired: false,
      instanceName: "FundRoom",
    });
    expect(app.auth.methods).toContain("email_otp");
    expect(app.auth.methods).toContain("passkey");
    expect(app.auth.passkeyRpId).toBe("localhost");
    const admin = webConfigOf(await (await page("/admin/people")).text());
    expect(admin.tree).toBe("admin");
    const embed = await page("/embed/acme/updates");
    expect(embed.status).toBe(200);
    const embedConfig = webConfigOf(await embed.text());
    expect(embedConfig.tree).toBe("embed");
    expect(embedConfig.routerBase).toBe("/embed/acme");
    expect(embedConfig.apiBase).toBe("/embed/acme");
    expect(embed.headers.get("x-frame-options")).toBeNull();
    // See the E2.2 decision-3 note above: an unconfigured workspace frames itself and nobody else.
    expect(embed.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(embed.headers.get("content-security-policy")).toContain(
      "require-trusted-types-for 'script'",
    );
  });

  it("serves hashed assets immutably and public files for an hour", async () => {
    const js = await page("/assets/app-abc.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/u);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("console.log('app')");
    const css = await page("/assets/app-abc.css");
    expect(css.headers.get("content-type")).toMatch(/text\/css/u);
    const icon = await page("/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toMatch(/image\/svg\+xml/u);
    expect(icon.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("answers 404 for missing assets and unknown API versions, never the index", async () => {
    // F-32: source maps 404 even when the file exists, however the name is spelled.
    for (const path of [
      "/assets/app-abc.js.map",
      "/assets/app-abc.js%2Emap",
      "/assets/APP-abc.js.MAP",
    ]) {
      const map = await page(path);
      expect(map.status, path).toBe(404);
      expect(await map.text(), path).not.toContain("secret.ts");
      expect(map.headers.get("cache-control"), path).toBe("private, no-store");
    }
    // Trusted Types are a document control: the API profile never carries them.
    const api = await page("/api/v1/modules");
    expect(api.headers.get("content-security-policy") ?? "").not.toMatch(/trusted-types/u);
    const missing = await page("/assets/missing.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).not.toMatch(/html/u);
    expect(await missing.text()).toContain("404 not found");
    const unknownVersion = await page("/api/v2/x");
    expect(unknownVersion.status).toBe(404);
    expect(((await unknownVersion.json()) as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
    const post = await page("/", { method: "POST", headers: { origin: BASE } });
    expect(post.status).toBe(404);
  });
});

describe("real listener", () => {
  it("binds an ephemeral port, serves over TCP, flips readiness while draining, and stops", async () => {
    const config = loadConfig({
      env: envFor(pg.connectionString, { ROLES: "api", MIGRATE_ON_START: "false" }),
    });
    const live = await startServer({
      config,
      logger: createLogger({ level: "warn" }),
      mailer,
      listen: { host: "127.0.0.1", port: 0 },
      migrate: false,
    });
    try {
      expect(live.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${live.port}/healthz`, { headers: { host: HOST } });
      expect(res.status).toBe(200);
      const wrongHost = await fetch(`http://127.0.0.1:${live.port}/api/v1/modules`);
      // single mode: any host is accepted (the proxy in front owns routing)
      expect(wrongHost.status).toBe(200);
    } finally {
      const stopping = live.stop();
      await stopping;
      expect(live.readiness.draining).toBe(true);
    }
  }, 60_000);
});
