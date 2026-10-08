import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/* Multi-tenant resolution by host label and path prefix (§3.3 step 1, §9.2). */
const BASE = "https://portal.example.test";
let pg: TestPostgres;
let running: RunningServer;

async function get(path: string, host: string) {
  return running.app.request(`${BASE}${path}`, { headers: { host, accept: "application/json" } });
}

async function page(path: string, host: string): Promise<{ res: Response; config: WebConfig }> {
  const res = await running.app.request(`${BASE}${path}`, { headers: { host } });
  const html = await res.text();
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error(`no config meta in ${path}: ${html.slice(0, 200)}`);
  const config = JSON.parse(
    m[1]
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&"),
  ) as WebConfig;
  return { res, config };
}

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta property="csp-nonce" nonce="__CSP_NONCE__"><script type="module" src="/assets/app.js" nonce="__CSP_NONCE__"></script></head><body></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "");
  return dir;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web",
      WEB_DIST_PATH: fakeWebDist(),
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: true,
  });
  await createWorkspace(running.container.db, { slug: "acme", name: "Acme" });
  await createWorkspace(running.container.db, { slug: "globex", name: "Globex" });
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("multi-tenant resolution", () => {
  it("resolves by subdomain and by /w/<slug>, and keeps the canonical host workspace-less", async () => {
    const acme = (await (await get("/api/v1/modules", "acme.portal.example.test")).json()) as {
      workspace: { slug: string } | null;
    };
    expect(acme.workspace?.slug).toBe("acme");
    const globex = (await (
      await get("/w/globex/api/v1/modules", "portal.example.test")
    ).json()) as { workspace: { slug: string } | null };
    expect(globex.workspace?.slug).toBe("globex");
    const host = (await (await get("/api/v1/modules", "portal.example.test")).json()) as {
      workspace: unknown;
    };
    expect(host.workspace).toBeNull();
  });

  it("rejects unknown hosts and unknown slugs with 404 before any session work", async () => {
    const evil = await get("/api/v1/modules", "evil.example");
    expect(evil.status).toBe(404);
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe("not_found");
    const missing = await get("/api/v1/modules", "nobody.portal.example.test");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_found",
    );
    const ops = await get("/healthz", "evil.example");
    expect(ops.status).toBe(200);
  });

  it("reports multi tenancy in the capability doc", async () => {
    const doc = (await (await get("/.well-known/fundroom.json", "portal.example.test")).json()) as {
      tenancy: string;
    };
    expect(doc.tenancy).toBe("multi");
  });
});

describe("multi-tenant web pages", () => {
  it("derives router and API bases from the host label, /w/<slug> and /embed/<slug>", async () => {
    const sub = await page("/updates", "acme.portal.example.test");
    expect(sub.res.status).toBe(200);
    expect(sub.config).toMatchObject({
      tree: "app",
      tenancy: "multi",
      routerBase: "",
      apiBase: "",
      workspace: { slug: "acme", name: "Acme" },
      canonicalOrigin: "https://acme.portal.example.test",
      setupRequired: false,
    });

    const w = await page("/w/globex/admin", "portal.example.test");
    expect(w.config).toMatchObject({
      tree: "admin",
      routerBase: "/w/globex",
      apiBase: "/w/globex",
      workspace: { slug: "globex", name: "Globex" },
      canonicalOrigin: "https://globex.portal.example.test",
    });
    expect(w.res.headers.get("x-frame-options")).toBe("DENY");

    const embed = await page("/embed/acme/data-room", "portal.example.test");
    expect(embed.config).toMatchObject({
      tree: "embed",
      routerBase: "/embed/acme",
      // The API lives under the embed prefix (E2.2), which is what lets the classifier mark the
      // request as embed context and issue a partitioned session cookie for a login in the frame.
      apiBase: "/embed/acme",
      workspace: { slug: "acme", name: "Acme" },
      embedOrigins: [],
    });
    expect(embed.res.headers.get("x-frame-options")).toBeNull();
    /*
     * `'self'`, not `'none'` (E2.2 decision 3): `frame-ancestors` always includes our own origin,
     * so an unconfigured workspace resolves to `frame-ancestors 'self'` and the admin screen can
     * preview its own embed in an iframe. A same-origin frame reaches nothing that same-origin
     * script could not already, and "only we may frame it" is the honest answer for a workspace
     * nobody has configured yet — `'none'` said "nobody may", which also broke the preview.
     */
    expect(embed.res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const nonce = /nonce="([^"]+)"/u.exec(
      await (
        await running.app.request(`${BASE}/embed/acme`, {
          headers: { host: "portal.example.test" },
        })
      ).text(),
    )?.[1];
    expect(nonce).toBeTruthy();

    const host = await page("/", "portal.example.test");
    expect(host.config.workspace).toBeNull();
    expect(host.config.routerBase).toBe("");
    expect(host.config.setupRequired).toBe(false);
  });

  it("keeps 404s for unknown hosts and slugs on page routes", async () => {
    const evil = await running.app.request(`${BASE}/`, { headers: { host: "evil.example" } });
    expect(evil.status).toBe(404);
    expect(evil.headers.get("content-type")).not.toMatch(/html/u);
    const missing = await running.app.request(`${BASE}/w/nobody/`, {
      headers: { host: "portal.example.test" },
    });
    expect(missing.status).toBe(404);
  });

  // E2.10 P2-04: tenant resolution answers these before the routes, and used to answer them
  // before the security headers too.
  it.each([
    ["/embed/nobody", "portal.example.test", "embed"],
    ["/w/nobody/", "portal.example.test", "app"],
    ["/w/nobody/api/v1/modules", "portal.example.test", "api"],
    ["/", "evil.example", "app"],
  ])(
    "serves the tenant 404 for %s on %s with the %s header profile",
    async (path, host, profile) => {
      const res = await running.app.request(`${BASE}${path}`, { headers: { host } });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-resource-policy")).not.toBeNull();
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const csp = res.headers.get("content-security-policy") ?? "";
      if (profile === "embed") {
        // No workspace, so nobody may frame the refusal.
        expect(res.headers.get("x-frame-options")).toBeNull();
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        expect(csp).toMatch(/frame-ancestors 'none'/u);
      } else {
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(csp).toMatch(/frame-ancestors 'none'/u);
      }
      if (profile === "api") expect(csp).toMatch(/default-src 'none'/u);
    },
  );
});

describe("seed-demo (multi mode)", () => {
  it("creates a synthetic workspace next to real ones, and replaces it only with --reset", async () => {
    const first = await seedDemo(running.container, { investors: 8 });
    expect(first).toMatchObject({
      slug: "acme-demo",
      owner: "founder@example.com",
      staff: 3,
      investorsActive: 6,
      investorsInvited: 2,
    });
    const page = await running.app.request(`${BASE}/`, {
      headers: { host: "acme-demo.portal.example.test" },
    });
    expect(page.status).toBe(200);
    await expect(seedDemo(running.container)).rejects.toThrow(/--reset/u);
    const second = await seedDemo(running.container, { reset: true, investors: 4 });
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(second.investorsActive + second.investorsInvited).toBe(4);
    const gone = await running.app.request(`${BASE}/w/acme-demo/api/v1/modules`, {
      headers: { host: "portal.example.test" },
    });
    expect(gone.status).toBe(200); // the reseeded slug resolves again
  });
});
