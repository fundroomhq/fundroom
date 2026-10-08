import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * `GET /api/v1/ops/update` (E2.9) end to end, against a local HTTP server serving index.json.
 *
 * Every unreleased build reports 0.0.0 (always `unknown`), so this file pins the running version
 * to 1.4.0. The checker caches a success for 12 hours, so each status gets its own server: four
 * single-tenant servers share one database (a multi-replica install — sessions are rows, so one
 * sign-in works on all of them), each pointed at its own index path, plus a multi-tenant server
 * on a second database. The index server counts requests per path, which is how "cached" and
 * "never fetched" are proven.
 */
vi.mock("./version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version.js")>()),
  SERVER_VERSION: "1.4.0",
}));

const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const SECRET = randomBytes(32).toString("base64");

const release = (version: string, security = false) => ({
  version,
  date: "2026-10-01",
  url: `https://github.com/fundroomhq/fundroom/releases/tag/v${version}`,
  security,
  summary: `Release ${version}`,
});

const INDEXES: Record<string, unknown> = {
  "/current/index.json": { schemaVersion: 1, latest: "1.4.0", releases: [release("1.4.0")] },
  "/update/index.json": {
    schemaVersion: 1,
    latest: "1.4.2",
    releases: [release("1.4.2"), release("1.4.1"), release("1.4.0")],
  },
  "/security/index.json": {
    schemaVersion: 1,
    latest: "1.4.2",
    releases: [release("1.4.2"), release("1.4.1", true), release("1.4.0")],
  },
};

interface Seen {
  path: string;
  url: string;
  headers: IncomingMessage["headers"];
}

let index: HttpServer;
let indexOrigin: string;
const seen: Seen[] = [];
const hits = (path: string) => seen.filter((s) => s.path === path).length;

let pg: TestPostgres;
const servers: RunningServer[] = [];
let current: RunningServer;
let update: RunningServer;
let security: RunningServer;
let off: RunningServer;
let multi: RunningServer;
let owner: string;
let editor: string;
let investor: string;
let multiOwner: string;

function envFor(url: string, tenancy: "single" | "multi", extra: Record<string, string> = {}) {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    BASE_URL: BASE,
    DATABASE_URL: url,
    FUNDROOM_SECRET_KEY: SECRET,
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    TENANCY_MODE: tenancy,
    ROLES: "api,web",
    OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
    ...extra,
  };
}

async function boot(
  url: string,
  tenancy: "single" | "multi",
  mailer: MemoryMailer,
  migrate: boolean,
  extra: Record<string, string>,
): Promise<RunningServer> {
  const running = await startServer({
    config: loadConfig({ env: envFor(url, tenancy, extra) }),
    logger: createLogger({ level: "warn" }),
    mailer,
    modules: COMPILED_IN_MODULES,
    listenEnabled: false,
    migrate,
    announceSetup: false,
  });
  servers.push(running);
  return running;
}

async function req(s: RunningServer, host: string, path: string, cookie?: string) {
  const headers = new Headers({ host });
  if (cookie) headers.set("cookie", cookie);
  return s.app.request(`https://${host}${path}`, { headers });
}

async function member(
  s: RunningServer,
  mailer: MemoryMailer,
  host: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "editor" | "investor",
): Promise<string> {
  const deps = s.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const post = (path: string, body: unknown, cookie?: string) =>
    s.app.request(`https://${host}${path}`, {
      method: "POST",
      headers: {
        host,
        "content-type": "application/json",
        ...(cookie ? { cookie, origin: `https://${host}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const since = mailer.sent.length;
  expect((await post("/api/v1/auth/otp/start", { email })).status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await post("/api/v1/auth/otp/verify", { email, code });
  expect(verify.status).toBe(200);
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  if (kind === "staff") {
    const enrol = await post("/api/v1/auth/totp/enrol", {}, cookie);
    const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await post(
      "/api/v1/auth/totp/enrol/confirm",
      { code: totp.generate() },
      cookie,
    );
    expect(confirm.status).toBe(200);
    // Step-up rotates the session token (F-12): carry the new cookie on.
    return withSetCookies(cookie, confirm);
  }
  return cookie;
}

beforeAll(async () => {
  index = createServer((request, response) => {
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? url;
    seen.push({ path, url, headers: request.headers });
    const body = INDEXES[path];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => index.listen(0, "127.0.0.1", resolve));
  indexOrigin = `http://127.0.0.1:${(index.address() as AddressInfo).port}`;

  pg = await startPostgres({ sources: [] });
  await pg.pool.query("CREATE DATABASE seedhost_single");
  const singleUrl = pg.connectionString.replace(/\/seedhost_test(?=$|\?)/u, "/seedhost_single");

  const mailer = createMemoryMailer();
  const at = (path: string) => ({ UPDATE_CHECK_URL: `${indexOrigin}${path}` });
  current = await boot(singleUrl, "single", mailer, true, at("/current/index.json"));
  update = await boot(singleUrl, "single", mailer, false, at("/update/index.json"));
  security = await boot(singleUrl, "single", mailer, false, at("/security/index.json"));
  off = await boot(singleUrl, "single", mailer, false, {
    ...at("/off/index.json"),
    UPDATE_CHECK: "false",
  });
  const solo = await createWorkspace(current.container.db, { slug: "solo", name: "Solo" });
  owner = await member(current, mailer, CANON, solo.id, "owner@solo.test", "staff", "owner");
  editor = await member(current, mailer, CANON, solo.id, "editor@solo.test", "staff", "editor");
  investor = await member(current, mailer, CANON, solo.id, "ada@solo.test", "external", "investor");

  const multiMailer = createMemoryMailer();
  multi = await boot(pg.connectionString, "multi", multiMailer, true, at("/multi/index.json"));
  const acme = await createWorkspace(multi.container.db, { slug: "acme", name: "Acme" });
  multiOwner = await member(
    multi,
    multiMailer,
    `acme.${CANON}`,
    acme.id,
    "owner@acme.test",
    "staff",
    "owner",
  );
}, 240_000);

afterAll(async () => {
  for (const s of servers.reverse()) await s.stop();
  await pg?.stop();
  await new Promise<void>((resolve) => (index ? index.close(() => resolve()) : resolve()));
});

type Body = Record<string, unknown>;

async function status(s: RunningServer, cookie = owner, host = CANON) {
  const res = await req(s, host, "/api/v1/ops/update", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

describe("GET /ops/update (single-tenant)", () => {
  it("current: the running version is the latest release", async () => {
    expect(await status(current)).toMatchObject({
      status: "current",
      currentVersion: "1.4.0",
      latestVersion: "1.4.0",
      releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.0",
    });
  });

  it("update_available: a newer release without a security fix", async () => {
    const body = await status(update);
    expect(body).toMatchObject({
      status: "update_available",
      currentVersion: "1.4.0",
      latestVersion: "1.4.2",
    });
    expect(body).not.toHaveProperty("securityReleases");
  });

  it("security_update: a security release newer than this build, and the answer is cached", async () => {
    const before = hits("/security/index.json");
    const body = await status(security);
    expect(body).toMatchObject({
      status: "security_update",
      currentVersion: "1.4.0",
      latestVersion: "1.4.2",
      securityReleases: ["1.4.1"],
    });
    expect(typeof body["checkedAt"]).toBe("string");
    expect(hits("/security/index.json")).toBe(before + 1);
    // Second (and concurrent) calls are answered from the cache: no refetch.
    await Promise.all([status(security), status(security), status(security)]);
    expect(hits("/security/index.json")).toBe(before + 1);
  });

  it("sends no identifiers: a bare GET with only the version in the user agent", () => {
    const requests = seen.filter((s) => s.path !== "/off/index.json");
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.url).not.toContain("?");
      expect(r.headers["cookie"]).toBeUndefined();
      expect(r.headers["authorization"]).toBeUndefined();
      expect(r.headers["referer"]).toBeUndefined();
      expect(r.headers["user-agent"]).toBe("FundRoom/1.4.0");
      expect(JSON.stringify(r.headers)).not.toMatch(/solo|acme|portal\.example/u);
    }
  });

  it("UPDATE_CHECK=false: disabled, and nothing is ever fetched", async () => {
    expect(await status(off)).toEqual({
      status: "disabled",
      reason: "opted_out",
      currentVersion: "1.4.0",
    });
    expect(hits("/off/index.json")).toBe(0);
  });

  it("editor is forbidden; an investor gets the unknown-route 404; anonymous is 401", async () => {
    const asEditor = await req(current, CANON, "/api/v1/ops/update", editor);
    expect(asEditor.status).toBe(403);
    expect(((await asEditor.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await req(current, CANON, "/api/v1/ops/update", investor)).status).toBe(404);
    expect((await req(current, CANON, "/api/v1/ops/update")).status).toBe(401);
  });
});

describe("GET /ops/update (multi-tenant)", () => {
  it("answers disabled / multi_tenant without fetching the index", async () => {
    expect(await status(multi, multiOwner, `acme.${CANON}`)).toEqual({
      status: "disabled",
      reason: "multi_tenant",
      currentVersion: "1.4.0",
    });
    expect(hits("/multi/index.json")).toBe(0);
  });
});
