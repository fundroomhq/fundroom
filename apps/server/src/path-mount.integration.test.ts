import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { awaitMail, awaitSignInCode } from "./test/sign-in-mail.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/*
 * Path-mount mode (E3.9, ADR-0057) through the whole server: a host site's proxy serves the portal
 * under one of its own paths and says so with `X-Forwarded-Prefix`, which counts only when it names
 * a `PATH_MOUNTS` entry. Two installs:
 *
 *  - PRESERVE / REPLACE: `BASE_PATH=/investors`, `BASE_URL=https://portal.test/investors`, mounts
 *    `https://acme.com/investors` (the proxy preserves the path) and `https://caddy.test/portal`
 *    (the proxy replaces `/portal` with `/investors`). TRUST_PROXY off: the allow-list alone gates.
 *  - STRIP: the app at the root (`BASE_PATH` unset), `BASE_URL=https://acme.com/investors` = the one
 *    mount, TRUST_PROXY on (a believed forwarded host only selects among mounts), on a ONE-CONNECTION pool.
 *
 * What a mount changes is the presentation of that one response (router/API base, asset URLs,
 * cookie name + Path, relative redirects, CSP report URL) and the CSRF origin. What it never
 * changes: emails, magic links, OIDC / SAML callbacks, security.txt `Canonical`, OpenAPI `servers`.
 */
const PORTAL = "https://portal.test";
const HOST = "portal.test";
const ACME = "https://acme.com";
const CADDY = "https://caddy.test";

let pg: TestPostgres;
let mailer: MemoryMailer;
let preserve: RunningServer;
let strip: RunningServer;
let idp: {
  issuer: string;
  nonce: string;
  email: string;
  redirectUris: string[];
  close(): Promise<void>;
};

interface Req extends RequestInit {
  /** `X-Forwarded-Prefix`. */
  readonly prefix?: string | undefined;
  /** `X-Forwarded-Host` (only believed with TRUST_PROXY). */
  readonly fwdHost?: string | undefined;
  readonly cookie?: string | undefined;
  /** `Origin` on a non-GET; default the portal's own. `false` sends none. */
  readonly origin?: string | false | undefined;
}

/** Requests as the proxy delivers them: `Host: portal.test`, the INTERNAL path. */
async function call(server: RunningServer, path: string, init: Req = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", HOST);
  if (init.prefix !== undefined) headers.set("x-forwarded-prefix", init.prefix);
  if (init.fwdHost !== undefined) {
    headers.set("x-forwarded-host", init.fwdHost);
    headers.set("x-forwarded-proto", "https");
  }
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.origin !== false)
    headers.set("origin", init.origin ?? PORTAL);
  return server.app.request(`${PORTAL}${path}`, { ...init, headers });
}

function setCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((c) => !/Max-Age=0/iu.test(c))
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
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

/** A fake Vite build: root-relative entry script, stylesheet and icon, as `apps/web` emits. */
function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<script type="module" crossorigin src="/assets/app-abc.js" nonce="__CSP_NONCE__"></script>
<link rel="modulepreload" crossorigin href="/assets/lazy-def.js" nonce="__CSP_NONCE__">
<link rel="stylesheet" crossorigin href="/assets/app-abc.css" nonce="__CSP_NONCE__">
</head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "lazy-def.js"), "export {}");
  writeFileSync(join(dir, "assets", "app-abc.css"), "body{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

/** A minimal OpenID provider (as in auth-hardening): discovery, JWKS, a token endpoint. */
async function startIdp(): Promise<typeof idp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const state = {
    issuer: "",
    nonce: "",
    email: "sso@acme.test",
    redirectUris: [] as string[],
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
      let form = "";
      for await (const chunk of req) form += String(chunk);
      // What a real IdP compares with the registered redirect URI.
      state.redirectUris.push(new URLSearchParams(form).get("redirect_uri") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
      const body = b64({
        iss: state.issuer,
        aud: "fundroom",
        sub: "sso|1",
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

async function boot(
  databaseUrl: string,
  env: Record<string, string>,
  roles = "api,web,worker",
): Promise<RunningServer> {
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: databaseUrl,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "single",
      ROLES: roles,
      WEB_DIST_PATH: fakeWebDist(),
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      ...env,
    },
  });
  const running = await startServer({
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
  const ws = await createWorkspace(c.db, { slug: "acme", name: "Acme" });
  for (const [email, kind, role] of [
    ["lp@investor.test", "external", "investor"],
    ["ml@investor.test", "external", "investor"],
    [idp.email, "staff", "editor"],
  ] as const) {
    await c.auth.invites.create({ workspaceId: ws.id, email, kind, role, send: false });
  }
  return running;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  idp = await startIdp();
  await pg.pool.query("CREATE DATABASE seedhost_strip");
  const stripUrl = pg.connectionString.replace(/\/seedhost_test(?=$|\?)/u, "/seedhost_strip");
  preserve = await boot(pg.connectionString, {
    BASE_URL: `${PORTAL}/investors`,
    BASE_PATH: "/investors",
    PATH_MOUNTS: `${ACME}/investors,${CADDY}/portal`,
  });
  strip = await boot(
    stripUrl,
    {
      BASE_URL: `${ACME}/investors`,
      PATH_MOUNTS: `${ACME}/investors`,
      TRUST_PROXY: "true",
      DATABASE_POOL_MAX: "1",
    },
    // An api+web node, as in the other one-connection suites: a worker's pollers would starve it.
    "api,web",
  );
  // As in access-requests' one-connection suite: the relay would hold the only connection.
  await strip.container.relay.stop();
}, 240_000);

afterAll(async () => {
  await strip?.stop();
  await preserve?.stop();
  await idp?.close();
  await pg?.stop();
});

async function signIn(server: RunningServer, email: string, init: Req = {}) {
  const since = mailer.sent.length;
  const start = await call(server, pathOf(server, "/api/v1/auth/otp/start"), {
    ...init,
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await call(server, pathOf(server, "/api/v1/auth/otp/verify"), {
    ...init,
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  return verify;
}

/** The internal path for `rest` on `server` (its BASE_PATH). */
function pathOf(server: RunningServer, rest: string): string {
  return `${server.container.config.basePath}${rest}`;
}

describe("preserve / replace shapes (BASE_PATH=/investors)", () => {
  const viaAcme = { prefix: "/investors" } as const;
  const viaCaddy = { prefix: "/portal" } as const;

  it("both root forms serve the SPA, direct and mounted", async () => {
    for (const path of ["/investors", "/investors/"]) {
      for (const init of [{}, viaAcme, viaCaddy]) {
        const res = await call(preserve, path, init);
        expect(res.status, `${path} ${JSON.stringify(init)}`).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/html/u);
      }
    }
  });

  it("the page config and asset URLs present the request's public base", async () => {
    const direct = await (await call(preserve, "/investors/updates")).text();
    expect(webConfigOf(direct)).toMatchObject({
      basePath: "/investors",
      routerBase: "/investors",
      apiBase: "/investors",
      canonicalOrigin: `${PORTAL}/investors`,
    });
    expect(direct).toContain('src="/investors/assets/app-abc.js"');

    const replaced = await (await call(preserve, "/investors/updates", viaCaddy)).text();
    expect(webConfigOf(replaced)).toMatchObject({
      basePath: "/portal",
      routerBase: "/portal",
      apiBase: "/portal",
      canonicalOrigin: `${CADDY}/portal`,
      workspace: { slug: "acme" },
    });
    expect(replaced).toContain('src="/portal/assets/app-abc.js"');
    expect(replaced).toContain('href="/portal/assets/lazy-def.js"');
    expect(replaced).toContain('href="/portal/favicon.svg"');
    expect(replaced).not.toContain('"/investors/assets/');

    const embed = webConfigOf(
      await (await call(preserve, "/investors/embed/acme", viaCaddy)).text(),
    );
    expect(embed.routerBase).toBe("/portal/embed/acme");
    expect(embed.apiBase).toBe("/portal/embed/acme");

    const preserved = webConfigOf(await (await call(preserve, "/investors/", viaAcme)).text());
    expect(preserved).toMatchObject({
      basePath: "/investors",
      canonicalOrigin: `${ACME}/investors`,
    });
  });

  it("a forged X-Forwarded-Prefix that names no mount is ignored", async () => {
    for (const prefix of ["/evil", "/portal,/investors", "/portal/x", ""]) {
      const res = await call(preserve, "/investors/updates", { prefix });
      const cfg = webConfigOf(await res.text());
      expect(cfg.basePath, prefix).toBe("/investors");
      expect(cfg.canonicalOrigin, prefix).toBe(`${PORTAL}/investors`);
    }
  });

  it("the CSP report URL is the mount's", async () => {
    const res = await call(preserve, "/investors/", viaCaddy);
    expect(res.headers.get("content-security-policy")).toContain(
      `report-uri ${CADDY}/portal/csp-report`,
    );
    expect(res.headers.get("reporting-endpoints")).toBe(`csp="${CADDY}/portal/csp-report"`);
    const direct = await call(preserve, "/investors/");
    expect(direct.headers.get("content-security-policy")).toContain(
      "report-uri /investors/csp-report",
    );
  });

  it("cookies: __Secure- with Path=<public base>, direct and mounted", async () => {
    const direct = await signIn(preserve, "lp@investor.test");
    const sid = setCookie(direct, "__Secure-sid") ?? "";
    expect(sid).toContain("Path=/investors;");
    expect(sid).toMatch(/Secure; HttpOnly; SameSite=Lax/u);
    expect(setCookie(direct, "__Secure-did")).toContain("Path=/investors;");

    const mounted = await signIn(preserve, "lp@investor.test", { ...viaCaddy, origin: CADDY });
    expect(setCookie(mounted, "__Secure-sid")).toContain("Path=/portal;");
    expect(setCookie(mounted, "__Host-sid")).toBeUndefined();
    const cookie = cookiesOf(mounted);
    const me = await call(preserve, "/investors/api/v1/me", { ...viaCaddy, cookie });
    expect(me.status).toBe(200);

    // Sign-out through the mount clears the mount's cookie and sends no origin-wide
    // Clear-Site-Data (the origin is the host site's).
    const out = await call(preserve, "/investors/api/v1/auth/logout", {
      ...viaCaddy,
      method: "POST",
      origin: CADDY,
      cookie,
    });
    expect(out.status).toBe(200);
    expect(setCookie(out, "__Secure-sid")).toMatch(/Path=\/portal;.*Max-Age=0/u);
    expect(out.headers.get("clear-site-data")).toBeNull();
  });

  it("CSRF: the mount's origin is accepted only with the header, a forged one never", async () => {
    // The check guards requests that carry cookies (a cookie-less one has no session to ride).
    const cookie = cookiesOf(
      await signIn(preserve, "lp@investor.test", { ...viaCaddy, origin: CADDY }),
    );
    const start = (init: Req) =>
      call(preserve, "/investors/api/v1/auth/otp/start", {
        cookie,
        ...init,
        method: "POST",
        body: JSON.stringify({ email: "nobody@investor.test" }),
      });
    expect((await start({ ...viaCaddy, origin: CADDY })).status).toBe(200);
    expect((await start({ ...viaAcme, origin: ACME })).status).toBe(200);
    // Without the header the request is the portal's own: a host-site page posting to it (same
    // site, Lax cookies ride) is refused.
    const bare = await start({ origin: CADDY });
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({ error: { code: "csrf_rejected" } });
    // With a mount's header, only that mount's origin.
    expect((await start({ ...viaCaddy, origin: ACME })).status).toBe(403);
    expect((await start({ ...viaCaddy, origin: "https://evil.test" })).status).toBe(403);
    // A prefix that names no mount changes nothing.
    expect((await start({ prefix: "/evil", origin: "https://evil.test" })).status).toBe(403);
    // Fetch Metadata says cross-site from the host: refused without the mount.
    expect(
      (await start({ origin: CADDY, headers: { "sec-fetch-site": "same-site" } })).status,
    ).toBe(403);
  });

  it("magic links and email links use BASE_URL, not the mount", async () => {
    const since = mailer.sent.length;
    const res = await call(preserve, "/investors/api/v1/auth/magic-link/start", {
      ...viaCaddy,
      origin: CADDY,
      method: "POST",
      body: JSON.stringify({ email: "ml@investor.test" }),
    });
    expect(res.status).toBe(200);
    // Its binding cookie lives where the browser is: the mount.
    expect(setCookie(res, "__Secure-auth_req")).toContain("Path=/portal;");
    const mail = await awaitMail(mailer, {
      to: "ml@investor.test",
      since,
      match: (m) => m.text.includes("http"),
    });
    expect(mail.text).toContain(`${PORTAL}/investors/`);
    expect(mail.text).not.toContain("caddy.test");
    expect(mail.html ?? "").not.toContain("caddy.test");
  });

  it("OIDC redirect URI and SAML ACS are BASE_URL-based even when begun through a mount", async () => {
    const res = await call(preserve, "/investors/api/v1/auth/oidc/begin", {
      ...viaCaddy,
      origin: CADDY,
      method: "POST",
      body: JSON.stringify({ provider: "sso", returnTo: "/admin" }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      `${PORTAL}/investors/api/v1/auth/oidc/callback`,
    );
    expect(setCookie(res, "__Secure-oidc_req")).toContain("Path=/portal;");
    const sp = preserve.container.sso.spInfo("01920000-0000-7000-8000-000000000001");
    expect(sp.samlAcsUrl).toBe(
      `${PORTAL}/investors/sso/saml/01920000-0000-7000-8000-000000000001/acs`,
    );
    expect(sp.oidcRedirectUri.startsWith(`${PORTAL}/investors/sso/`)).toBe(true);
  });

  it("Vary: private responses key on Cookie + the mount; base-dependent public ones on the mount", async () => {
    const page = await call(preserve, "/investors/", viaCaddy);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("vary")).toContain("Cookie");
    expect(page.headers.get("vary")).toContain("X-Forwarded-Prefix");
    const api = await call(preserve, "/investors/api/v1/modules");
    expect(api.headers.get("vary")).toContain("Cookie");
    expect(api.headers.get("vary")).toContain("X-Forwarded-Prefix");

    const asset = await call(preserve, "/investors/assets/app-abc.js", viaCaddy);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("vary") ?? "").not.toContain("Cookie");
    // FR2 B11: PATH_MOUNTS is set, so even a base-independent public response keys on the mount
    // (its HSTS differs by it).
    expect(asset.headers.get("vary")).toBe("X-Forwarded-Prefix");
    const icon = await call(preserve, "/investors/favicon.svg");
    expect(icon.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(icon.headers.get("vary")).toBe("X-Forwarded-Prefix");

    const capDirect = await call(preserve, "/investors/.well-known/fundroom.json");
    expect(capDirect.headers.get("cache-control")).toBe("public, max-age=300");
    expect(capDirect.headers.get("vary")).toBe("X-Forwarded-Prefix");
    // FR1 B3: base-dependent public documents are private through a mount (a host CDN may
    // ignore Vary).
    const cap = await call(preserve, "/investors/.well-known/fundroom.json", viaCaddy);
    expect(cap.headers.get("cache-control")).toBe("private, no-store");
    expect(cap.headers.get("vary")).toContain("X-Forwarded-Prefix");
    expect(await cap.json()).toMatchObject({ apiBase: "/portal/api/v1" });
    const txt = await call(preserve, "/investors/.well-known/security.txt", viaCaddy);
    expect(txt.headers.get("cache-control")).toBe("private, no-store");
    const legacy = await call(preserve, "/investors/security.txt", viaCaddy);
    expect(legacy.headers.get("cache-control")).toBe("private, no-store");
    expect((await call(preserve, "/investors/security.txt")).headers.get("cache-control")).toBe(
      "public, max-age=86400",
    );

    // FR1 B6: the served document names the absolute canonical API base, the same body for every
    // face — so it stays public (it varies by mount only for HSTS, FR2 B11).
    const doc = await call(preserve, "/investors/api/v1/openapi.json", viaCaddy);
    expect(doc.headers.get("cache-control")).toBe("public, max-age=300");
    expect(doc.headers.get("vary")).toContain("X-Forwarded-Prefix");
    expect(((await doc.json()) as { servers: unknown }).servers).toEqual([
      { url: `${PORTAL}/investors/api/v1` },
    ]);
  });

  it("security.txt's legacy redirect lands under the mount; Canonical stays BASE_URL's", async () => {
    const legacy = await call(preserve, "/investors/security.txt", viaCaddy);
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe("/portal/.well-known/security.txt");
    expect(legacy.headers.get("vary")).toContain("X-Forwarded-Prefix");
    const direct = await call(preserve, "/investors/security.txt");
    expect(direct.headers.get("location")).toBe("/investors/.well-known/security.txt");
    const txt = await (await call(preserve, "/investors/.well-known/security.txt")).text();
    expect(txt).toContain(`Canonical: ${PORTAL}/investors/.well-known/security.txt\n`);
    const viaMount = await (
      await call(preserve, "/investors/.well-known/security.txt", viaCaddy)
    ).text();
    expect(viaMount).not.toContain("Canonical:");
  });

  it("canonical URLs built from BASE_URL are not double-prefixed", async () => {
    const err = preserve.container.integrations.oauthErrorUrl("expired");
    expect(err.startsWith(`${PORTAL}/investors/admin/`)).toBe(true);
    expect(err).not.toContain("/investors/investors");
  });
});

describe("strip shape on a one-connection pool (BASE_PATH unset, BASE_URL = the mount)", () => {
  const viaMount = { prefix: "/investors", fwdHost: "acme.com" } as const;

  it("both root forms and a deep link serve the SPA under the mount's base", async () => {
    for (const path of ["/", "/updates/1"]) {
      const res = await call(strip, path, viaMount);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(webConfigOf(html)).toMatchObject({
        basePath: "/investors",
        routerBase: "/investors",
        apiBase: "/investors",
        canonicalOrigin: `${ACME}/investors`,
      });
      expect(html).toContain('src="/investors/assets/app-abc.js"');
    }
    // Direct, the portal runs at its root.
    const direct = webConfigOf(await (await call(strip, "/")).text());
    expect(direct.basePath).toBe("");
    // TRUST_PROXY on: a forwarded host other than the mount's (an edge that overwrote it) only
    // fails to select — the first listed mount with the prefix still applies (E3.9 correction).
    const other = await call(strip, "/", { prefix: "/investors", fwdHost: "evil.test" });
    expect(webConfigOf(await other.text())).toMatchObject({
      basePath: "/investors",
      canonicalOrigin: `${ACME}/investors`,
    });
  });

  it("a session minted on one face is never read on the other", async () => {
    const mounted = await signIn(strip, "lp@investor.test", { ...viaMount, origin: ACME });
    expect(setCookie(mounted, "__Secure-sid")).toMatch(/Path=\/investors; Secure; HttpOnly/u);
    const onMount = cookiesOf(mounted);
    expect((await call(strip, "/api/v1/me", { ...viaMount, cookie: onMount })).status).toBe(200);
    expect((await call(strip, "/api/v1/me", { cookie: onMount })).status).toBe(401);

    const direct = await signIn(strip, "lp@investor.test");
    expect(setCookie(direct, "__Host-sid")).toContain("Path=/;");
    const onPortal = cookiesOf(direct);
    expect((await call(strip, "/api/v1/me", { cookie: onPortal })).status).toBe(200);
    expect((await call(strip, "/api/v1/me", { ...viaMount, cookie: onPortal })).status).toBe(401);
  });

  it("an OIDC round trip through the mount: BASE_URL redirect URI, mounted cookies, relative return", async () => {
    const begin = await call(strip, "/api/v1/auth/oidc/begin", {
      ...viaMount,
      origin: ACME,
      method: "POST",
      body: JSON.stringify({ provider: "sso", returnTo: "/admin?tab=people" }),
    });
    expect(begin.status).toBe(200);
    const authorize = new URL(((await begin.json()) as { url: string }).url);
    const redirectUri = `${ACME}/investors/api/v1/auth/oidc/callback`;
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
    idp.nonce = authorize.searchParams.get("nonce") ?? "";
    const binding = setCookie(begin, "__Secure-oidc_req") ?? "";
    expect(binding).toContain("Path=/investors;");

    // The IdP sends the browser to BASE_URL = the mount; the proxy strips `/investors`.
    const state = encodeURIComponent(authorize.searchParams.get("state") ?? "");
    const done = await call(strip, `/api/v1/auth/oidc/callback?code=the-code&state=${state}`, {
      ...viaMount,
      cookie: binding.split(";")[0],
    });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/investors/admin?tab=people");
    expect(setCookie(done, "__Secure-sid")).toContain("Path=/investors;");
    // The token request named the registered redirect URI, not the internal URL.
    expect(idp.redirectUris.at(-1)).toBe(redirectUri);
  });

  it("canonical URLs come from BASE_URL (path included) and are not double-prefixed", async () => {
    expect(
      strip.container.integrations.oauthErrorUrl("expired").startsWith(`${ACME}/investors/admin/`),
    ).toBe(true);
    expect(strip.container.sso.spInfo("01920000-0000-7000-8000-000000000001").samlAcsUrl).toBe(
      `${ACME}/investors/sso/saml/01920000-0000-7000-8000-000000000001/acs`,
    );
    const txt = await (await call(strip, "/.well-known/security.txt", viaMount)).text();
    expect(txt).toContain(`Canonical: ${ACME}/investors/.well-known/security.txt\n`);
    // The capability doc and the security.txt redirect follow the request's face.
    const cap = await call(strip, "/.well-known/fundroom.json", viaMount);
    expect(await cap.json()).toMatchObject({ apiBase: "/investors/api/v1" });
    const legacy = await call(strip, "/security.txt", viaMount);
    expect(legacy.headers.get("location")).toBe("/investors/.well-known/security.txt");
  });
});

describe("FR1: host-site origins, HSTS, passkeys", () => {
  const viaCaddy = { prefix: "/portal" } as const;
  const viaMount = { prefix: "/investors", fwdHost: "acme.com" } as const;

  it("B1: BASE_URL's origin is not CORS/CSRF-trusted when BASE_URL is a mount (strip)", async () => {
    // A direct request (no mount header) from the host site's origin.
    for (const path of ["/api/v1/me", "/embed/acme/api/v1/me"]) {
      const pre = await call(strip, path, {
        method: "OPTIONS",
        origin: false,
        headers: { origin: ACME, "access-control-request-method": "POST" },
      });
      expect(pre.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    const cookie = cookiesOf(await signIn(strip, "lp@investor.test"));
    for (const path of ["/api/v1/auth/otp/start", "/embed/acme/api/v1/auth/otp/start"]) {
      const res = await call(strip, path, {
        method: "POST",
        origin: ACME,
        cookie,
        body: JSON.stringify({ email: "nobody@investor.test" }),
      });
      expect(res.status, path).toBe(403);
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    // Through the mount, the mount's origin is the page's own and is accepted.
    const mounted = cookiesOf(
      await signIn(strip, "lp@investor.test", { ...viaMount, origin: ACME }),
    );
    const ok = await call(strip, "/api/v1/auth/otp/start", {
      ...viaMount,
      method: "POST",
      origin: ACME,
      cookie: mounted,
      body: JSON.stringify({ email: "nobody@investor.test" }),
    });
    expect(ok.status).toBe(200);
  });

  it("B2: a mounted response carries no HSTS; a direct one does", async () => {
    const direct = await call(preserve, "/investors/");
    expect(direct.headers.get("strict-transport-security")).toMatch(/^max-age=/u);
    const mounted = await call(preserve, "/investors/", viaCaddy);
    expect(mounted.headers.get("strict-transport-security")).toBeNull();
    const api = await call(strip, "/api/v1/modules", viaMount);
    expect(api.headers.get("strict-transport-security")).toBeNull();
  });

  it("B4: an unmounted page never names a mount origin as its portal root", async () => {
    // Strip: BASE_URL is the mount (acme.com), but this page is on the portal's own origin.
    const direct = webConfigOf(await (await call(strip, "/")).text());
    expect(direct.canonicalOrigin).toBe(PORTAL);
    // Preserve: today's shape is unchanged.
    const own = webConfigOf(await (await call(preserve, "/investors/")).text());
    expect(own.canonicalOrigin).toBe(`${PORTAL}/investors`);
  });

  it("B5: passkeys only where the page is on the passkey RP origin (BASE_URL's)", async () => {
    const methods = async (server: RunningServer, path: string, init: Req = {}) =>
      webConfigOf(await (await call(server, path, init)).text()).auth.methods;
    expect(await methods(preserve, "/investors/")).toContain("passkey");
    expect(await methods(preserve, "/investors/", viaCaddy)).not.toContain("passkey");
    expect(await methods(strip, "/", viaMount)).toContain("passkey");
    expect(await methods(strip, "/")).not.toContain("passkey");
    // FR2 B9: an unmounted request on another host than BASE_URL's is off the RP origin too.
    expect(
      await methods(preserve, "/investors/", { headers: { host: "other.test" } }),
    ).not.toContain("passkey");

    const begin = (server: RunningServer, path: string, init: Req) =>
      call(server, path, { ...init, method: "POST", body: JSON.stringify({}) });
    for (const [server, path, init] of [
      [preserve, "/investors/api/v1/auth/passkeys/login/begin", { ...viaCaddy, origin: CADDY }],
      [strip, "/api/v1/auth/passkeys/login/begin", {}],
    ] as const) {
      const res = await begin(server, path, init);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "unsupported", reason: "path_mount" },
      });
    }
    const allowed = await begin(strip, "/api/v1/auth/passkeys/login/begin", {
      ...viaMount,
      origin: ACME,
    });
    expect(allowed.status).toBe(200);
  });
});
