import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createOidcFlow } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E2.10 auth hardening through the real HTTP surface (fix package G): the OIDC browser-binding
 * cookie (F-03), the post-login open redirect (F-02), ending the session a browser already held
 * when it signs in again (F-12), and `Clear-Site-Data` on sign-out (F-25). The OIDC provider is a
 * small in-process IdP; the install's flow is swapped for one pointed at it, because config
 * refuses a non-https issuer.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let idp: { issuer: string; nonce: string; sub: string; email: string; close(): Promise<void> };
let acmeId: string;

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((c) => !/Max-Age=0/iu.test(c))
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function signIn(email: string, cookie?: string): Promise<string> {
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
    ...(cookie === undefined ? {} : { cookie }),
  });
  expect(verify.status).toBe(200);
  return cookiesOf(verify);
}

/** A minimal OpenID provider: discovery, JWKS and a token endpoint minting RS256 ID tokens. */
async function startIdp(): Promise<typeof idp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const state = {
    issuer: "",
    nonce: "",
    sub: "sso|1",
    email: "sso@acme.test",
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.issuer);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      for await (const _ of req) {
        // drain the form body
      }
      const now = Math.floor(Date.now() / 1000);
      const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
      const body = b64({
        iss: state.issuer,
        aud: "fundroom",
        sub: state.sub,
        email: state.email,
        email_verified: true,
        name: "SSO Person",
        nonce: state.nonce,
        iat: now,
        exp: now + 300,
      });
      const sig = sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
      res.end(
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          id_token: `${head}.${body}.${sig}`,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  state.issuer = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  idp = await startIdp();
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
  const c = running.container;
  Object.assign(c.auth, {
    oidc: createOidcFlow(c.identityDeps, c.auth.sessions, {
      providers: { sso: { issuer: idp.issuer, clientId: "fundroom", clientSecret: "s3cret" } },
      allowInsecureHttp: true,
    }),
  });
  acmeId = (await createWorkspace(c.db, { slug: "acme", name: "Acme" })).id;
  await c.auth.invites.create({
    workspaceId: acmeId,
    email: idp.email,
    kind: "staff",
    role: "editor",
    send: false,
  });
  await c.auth.invites.create({
    workspaceId: acmeId,
    email: "otp@acme.test",
    kind: "external",
    role: "investor",
    send: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await idp?.close();
  await pg?.stop();
});

/** POST /auth/oidc/begin; returns the binding cookie and the callback path the IdP would hit. */
async function beginOidc(returnTo?: string) {
  const res = await request("/api/v1/auth/oidc/begin", {
    method: "POST",
    body: JSON.stringify({ provider: "sso", ...(returnTo === undefined ? {} : { returnTo }) }),
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const authorize = new URL(url);
  idp.nonce = authorize.searchParams.get("nonce") ?? "";
  const binding = setCookie(res, "__Host-oidc_req");
  const state = authorize.searchParams.get("state") ?? "";
  return {
    binding,
    cookie: binding?.split(";")[0] ?? "",
    callback: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(state)}`,
  };
}

describe("OIDC browser binding and return path (F-02, F-03)", () => {
  it("issues a __Host- binding cookie at begin and requires it at the callback", async () => {
    const b = await beginOidc("/admin");
    expect(b.binding).toMatch(/^__Host-oidc_req=[A-Za-z0-9_-]{20,};/u);
    expect(b.binding).toContain("HttpOnly");
    expect(b.binding).toContain("Secure");
    expect(b.binding).toContain("SameSite=Lax");
    expect(b.binding).toContain("Max-Age=600");

    // A browser that did not begin this login (no cookie / someone else's) is refused.
    const foreign = await request(b.callback);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await foreign.json()).toMatchObject({
      error: { code: "oidc_failed", reason: "binding_mismatch" },
    });
    const other = await beginOidc();
    const swapped = await request(b.callback, { cookie: other.cookie });
    expect(await swapped.json()).toMatchObject({ error: { reason: "binding_mismatch" } });

    // The browser that began it completes, lands on its return path and loses the binding.
    const again = await beginOidc("/admin?tab=people");
    const done = await request(again.callback, { cookie: again.cookie });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/admin?tab=people");
    expect(setCookie(done, "__Host-sid")).toBeDefined();
    expect(setCookie(done, "__Host-oidc_req")).toContain("Max-Age=0");
    const me = await request("/api/v1/me", { cookie: cookiesOf(done) });
    expect(me.status).toBe(200);
  });

  it.each(["/\\evil.com", "/\t/evil.com", "//evil.com", "/%5Cevil.com", "https://evil.com"])(
    "drops a returnTo that would leave the origin: %j",
    async (hostile) => {
      const b = await beginOidc(hostile);
      const done = await request(b.callback, { cookie: b.cookie });
      expect(done.status).toBe(302);
      expect(done.headers.get("location")).toBe("/");
    },
  );
});

describe("sessions (F-12, F-25)", () => {
  it("signing in again ends the session the browser already held", async () => {
    const first = await signIn("otp@acme.test");
    expect((await request("/api/v1/me", { cookie: first })).status).toBe(200);
    const second = await signIn("otp@acme.test", first);
    expect(second).not.toBe(first);
    expect((await request("/api/v1/me", { cookie: first })).status).toBe(401);
    expect((await request("/api/v1/me", { cookie: second })).status).toBe(200);
  });

  it("sign-out clears cached responses and web storage, but not the device cookie", async () => {
    const cookie = await signIn("otp@acme.test");
    const out = await request("/api/v1/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get("clear-site-data")).toBe('"cache", "storage"');
    expect(setCookie(out, "__Host-sid")).toContain("Max-Age=0");
    expect(setCookie(out, "__Host-did")).toBeUndefined();
  });
});
