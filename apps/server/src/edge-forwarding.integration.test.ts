import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/*
 * Edge forwarding (E-UP-7, ADR-0064) end to end. The hosted topology: Cloudflare for SaaS → an
 * edge Worker → Railway, which routes by Host (so every customer request arrives with the
 * PLATFORM host) and overwrites X-Forwarded-Host. The Worker carries the customer host and the
 * visitor IP in private headers and proves itself with `X-Fundroom-Edge`. Everything below is
 * observed through the full app: tenant resolution, the page config, CSRF, the security headers,
 * the recorded client IP, and the log stream (which must never carry the secret).
 */
const BASE = "https://portal.fundroom-test.com";
const CANON = "portal.fundroom-test.com";
/** The host Railway routes on: the same for every tenant. */
const PLATFORM = "fundroom-app-production.up.railway.app";
const CUSTOM = "investors.acme-ir.com";
const SECRET = `current-${randomBytes(24).toString("hex")}`;
const PREVIOUS = `previous-${randomBytes(24).toString("hex")}`;
const HOST_HEADER = "X-Fundroom-Forwarded-Host";
const IP_HEADER = "X-Fundroom-Client-IP";
const VISITOR_IP = "203.0.113.77";
/** What Railway's own proxy appends: the Worker's egress address, never the visitor's. */
const WORKER_EGRESS = "104.28.1.9";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
const logLines: string[] = [];

/** A request as the Worker sends it: platform Host, Railway's forwarding headers, then ours. */
async function viaEdge(
  path: string,
  init: RequestInit & {
    secret?: string | null;
    forwardedHost?: string | null;
    /** Railway's `X-Forwarded-Proto`; null omits it. */
    proto?: string | null;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", PLATFORM);
  headers.set("x-forwarded-host", PLATFORM);
  if (init.proto !== null) headers.set("x-forwarded-proto", init.proto ?? "https");
  headers.set("x-forwarded-for", WORKER_EGRESS);
  if (init.forwardedHost !== null) headers.set(HOST_HEADER, init.forwardedHost ?? CUSTOM);
  if (!headers.has(IP_HEADER)) headers.set(IP_HEADER, VISITOR_IP);
  const secret = init.secret === undefined ? SECRET : init.secret;
  if (secret !== null) headers.set("x-fundroom-edge", secret);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return running.app.request(`http://${PLATFORM}${path}`, { ...init, headers });
}

function configOf(html: string): WebConfig {
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error(`no config meta: ${html.slice(0, 200)}`);
  return JSON.parse(
    m[1]
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&"),
  ) as WebConfig;
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

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function rows<T>(query: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(acmeId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "debug",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web",
      WEB_DIST_PATH: fakeWebDist(),
      TRUST_PROXY: "true",
      HSTS: "true",
      FORWARDED_HOST_HEADER: HOST_HEADER,
      FORWARDED_CLIENT_IP_HEADER: IP_HEADER,
      EDGE_SHARED_SECRET: SECRET,
      EDGE_SHARED_SECRET_PREVIOUS: PREVIOUS,
    },
  });
  running = await startServer({
    config,
    // Every line at every level, so the "never logged" assertion covers debug lines too.
    logger: createLogger({
      level: "debug",
      destination: new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString("utf8"));
          done();
        },
      }),
    }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  await createWorkspace(running.container.db, { slug: "globex", name: "Globex" });
  // Acme's verified custom domain, as the cloudflare-saas driver leaves it once active.
  await rows(
    `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
       VALUES ('${acmeId}'::uuid, '${CUSTOM}', 'active', 'edgeforwardingtesttoken0', now(), now())`,
  );
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email: "ada@investor.test", displayName: "Ada" });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("tenant resolution through the edge", () => {
  it("a verified custom domain reached via the platform host resolves and serves the workspace", async () => {
    const res = await viaEdge("/updates");
    expect(res.status).toBe(200);
    const config = configOf(await res.text());
    expect(config).toMatchObject({
      tree: "app",
      workspace: { slug: "acme", name: "Acme" },
      canonicalOrigin: `https://${CUSTOM}`,
    });
    // Railway sees one Host for every tenant: a shared cache must key on the forwarded host.
    expect(res.headers.get("vary")?.split(/,\s*/u)).toContain(HOST_HEADER);

    const api = await viaEdge("/api/v1/modules", { headers: { accept: "application/json" } });
    expect(api.status).toBe(200);
    expect(((await api.json()) as { workspace: { slug: string } | null }).workspace?.slug).toBe(
      "acme",
    );
  });

  it("the same request without the secret is the platform host: 404 unknown host", async () => {
    const res = await viaEdge("/api/v1/modules", {
      secret: null,
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(res.headers.get("vary") ?? "").not.toContain(HOST_HEADER);
    // And the ordinary paths are untouched: a tenant subdomain without the edge still works.
    const direct = await running.app.request(`${BASE}/api/v1/modules`, {
      headers: { host: `globex.${CANON}`, accept: "application/json" },
    });
    expect(((await direct.json()) as { workspace: { slug: string } | null }).workspace?.slug).toBe(
      "globex",
    );
  });

  it("a wrong secret is 403 edge_unauthorized, before any tenant work", async () => {
    const wrong = `wrong-${randomBytes(24).toString("hex")}`;
    for (const path of ["/updates", "/api/v1/modules", "/healthz"]) {
      const res = await viaEdge(path, { secret: wrong });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: "edge_unauthorized" } });
      expect(body).not.toContain(wrong);
    }
    const mismatch = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["event"] === "http.edge_secret_mismatch");
    expect(mismatch).toHaveLength(3);
    // Attributable without any header value: method, redacted path, the ordinary derivation's
    // address (Railway's XFF entry — on a refused request nothing is edge-forwarded), truncated.
    expect(mismatch[0]).toMatchObject({
      level: "warn",
      method: "GET",
      path: "/updates",
      clientNetwork: "104.28.1.0/24",
      reason: "mismatch",
    });
    expect(logLines.join("\n")).not.toContain(wrong);
  });

  it("the previous secret is still accepted during a rotation", async () => {
    const res = await viaEdge("/api/v1/modules", {
      secret: PREVIOUS,
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspace: { slug: string } | null }).workspace?.slug).toBe(
      "acme",
    );
  });

  it("a valid secret with a missing or malformed forwarded host is 400", async () => {
    for (const forwardedHost of [null, `${CUSTOM}:443`, `${CUSTOM}, evil.test`, `${CUSTOM}.`]) {
      const res = await viaEdge("/api/v1/modules", { forwardedHost });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "invalid_request",
      );
    }
  });

  it("an edge-forwarded host nobody claimed is the ordinary 404", async () => {
    const res = await viaEdge("/api/v1/modules", {
      forwardedHost: "someone-else.acme-ir.com",
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
  });
});

describe("security headers through the edge", () => {
  it("the customer origin is https from the edge alone, with no or a contrary X-Forwarded-Proto", async () => {
    // TRUST_PROXY=true as FundRoom runs, but the scheme comes from the edge secret, not from a
    // proxy header Railway may or may not send.
    for (const proto of [null, "http"]) {
      const res = await viaEdge("/updates", { proto });
      expect(res.status).toBe(200);
      expect(res.headers.get("reporting-endpoints")).toBe(`csp="https://${CUSTOM}/csp-report"`);
      expect(res.headers.get("strict-transport-security")).toMatch(/^max-age=\d+$/u);
      expect(configOf(await res.text()).canonicalOrigin).toBe(`https://${CUSTOM}`);
    }
  });

  it("HSTS and Reporting-Endpoints name the customer host over https", async () => {
    const res = await viaEdge("/updates");
    expect(res.status).toBe(200);
    // A customer's domain: max-age without includeSubDomains (never pin a zone we do not own).
    expect(res.headers.get("strict-transport-security")).toMatch(/^max-age=\d+$/u);
    expect(res.headers.get("reporting-endpoints")).toBe(`csp="https://${CUSTOM}/csp-report"`);
  });
});

describe("sign-in, client IP and CSRF through the edge", () => {
  let cookie = "";

  it("records the visitor IP the edge forwarded, not the Worker's egress address", async () => {
    const since = mailer.sent.length;
    const start = await viaEdge("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test" }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, "ada@investor.test", since);
    const challenge = await rows<{ ip: string | null }>(
      `SELECT host(ip) AS ip FROM core.auth_challenge
         WHERE workspace_id = '${acmeId}'::uuid AND email = 'ada@investor.test'
         ORDER BY created_at DESC LIMIT 1`,
    );
    expect(challenge[0]?.ip).toBe(VISITOR_IP);

    const verify = await viaEdge("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test", code }),
    });
    expect(verify.status).toBe(200);
    cookie = cookiesOf(verify);
    expect(cookie).not.toBe("");
    // The session was issued for an https origin: its cookie is Secure.
    expect(verify.headers.getSetCookie().some((c) => /;\s*secure/iu.test(c))).toBe(true);
  });

  it("an invalid forwarded client IP falls back to the ordinary derivation", async () => {
    const since = mailer.sent.length;
    const start = await viaEdge("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test" }),
      headers: { [IP_HEADER]: "not-an-ip" },
    });
    expect(start.status).toBe(200);
    await awaitSignInCode(mailer, "ada@investor.test", since);
    const challenge = await rows<{ ip: string | null }>(
      `SELECT host(ip) AS ip FROM core.auth_challenge
         WHERE workspace_id = '${acmeId}'::uuid AND email = 'ada@investor.test'
         ORDER BY created_at DESC LIMIT 1`,
    );
    // TRUST_PROXY with one hop: the X-Forwarded-For entry Railway appended.
    expect(challenge[0]?.ip).toBe(WORKER_EGRESS);
  });

  it("an Origin-only state-changing request from the customer origin passes CSRF", async () => {
    // No Sec-Fetch-Site (an older browser): the Origin must be the request's own origin, which
    // through the edge is https://<customer host>, not the platform host Railway routed on.
    const foreign = await viaEdge("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie, origin: `https://${PLATFORM}` },
    });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      "csrf_rejected",
    );
    // The CSRF self-origin is https://<customer> even with no X-Forwarded-Proto at all.
    const own = await viaEdge("/api/v1/auth/logout", {
      method: "POST",
      proto: null,
      headers: { cookie, origin: `https://${CUSTOM}` },
    });
    expect(own.status).toBeLessThan(300);
  });
});

describe("the secret never reaches the logs", () => {
  it("no captured log line, at any level, carries either secret", () => {
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(PREVIOUS);
  });
});
