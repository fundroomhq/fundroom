import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGO_MAX_BYTES } from "@fundroom/branding";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
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
 * Branding end to end (E1.7, EXECUTION_PLAN §12 "branding basics").
 *
 * The shape of the epic, in order: the brand as a small set of settings with everything else
 * derived → a colour change moving the derived tokens and reporting its own contrast → the
 * logo pipeline deciding the content type from the BYTES and refusing a script carrier → the
 * same pipeline fed by the founder's website, with every candidate in someone else's markup
 * re-validated through the SSRF guard → the logo served unauthenticated from our own origin,
 * because that is what an email's `<img src>` fetches → the theme document a signed-out
 * sign-in page themes itself from → the two kernel permissions actually gating the staff
 * surfaces, with an investor getting the 404 an unknown URL gives → module enablement and the
 * refusals that keep the workspace consistent → the setup wizard's progress, which reads
 * kernel facts only.
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
  // The code mail is sent detached: under load it can trail the response, and another mail
  // (a security notice, a notification) can land last. Wait for this address's code mail.
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
  role: "owner" | "admin" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

// --- image fixtures ----------------------------------------------------------------------------
// Real headers, not mocks: the whole point of the pipeline is that the bytes decide.
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// --- the founder's marketing site --------------------------------------------------------------
/*
 * A local HTTP server standing in for the company's website, reached through the REAL guard:
 * the composition root builds `OutboundHttpPort` from config and takes no injected port, so the
 * seam is the documented one — `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS` naming 127.0.0.1, the
 * operator's way to let the guard reach exactly one private host. `OUTBOUND_HTTP_ALLOW_PRIVATE`
 * stays false, so every other private address is refused here exactly as it is in production,
 * which is what the refusal cases below rely on.
 */
interface Hit {
  path: string;
  accept: string;
  userAgent: string;
}
const hits: Hit[] = [];
let site: Server | undefined;
let sitePort = 0;
const siteUrl = (path: string) => `http://127.0.0.1:${sitePort}${path}`;

/** What the website's marketing page offers; the favicon fallback is always tried after it. */
const pageWith = (href: string) =>
  `<!doctype html><html><head><meta property="og:image" content="${href}"></head><body>Acme</body></html>`;

/** The bytes the happy path imports: a real PNG header, 320×200, nothing decodes it. */
const WEBSITE_LOGO = png(320, 200);
const REAL_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512"/></svg>',
  "utf8",
);

/** The address every SSRF write-up names, and the one an attacker puts in their own markup. */
const METADATA_LOGO = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";

function handleSite(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  hits.push({
    path,
    accept: req.headers.accept ?? "",
    userAgent: req.headers["user-agent"] ?? "",
  });
  const html = (body: string): void => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
  /** Bytes with a content type of the site's choosing — truthful or not. */
  const served = (bytes: Uint8Array, contentType: string): void => {
    res.writeHead(200, { "content-type": contentType, "content-length": String(bytes.byteLength) });
    res.end(Buffer.from(bytes));
  };
  switch (path) {
    case "/":
      // A relative href, so the resolution against the page's own URL is exercised too.
      html(pageWith("/logo.png"));
      return;
    case "/logo.png":
      served(WEBSITE_LOGO, "image/png");
      return;
    case "/lies-svg":
      html(pageWith("/logo-as-svg"));
      return;
    case "/logo-as-svg":
      served(WEBSITE_LOGO, "image/svg+xml");
      return;
    case "/lies-html":
      html(pageWith("/logo-as-html"));
      return;
    case "/logo-as-html":
      served(WEBSITE_LOGO, "text/html; charset=utf-8");
      return;
    case "/really-svg":
      html(pageWith("/real.svg"));
      return;
    case "/real.svg":
      served(REAL_SVG, "image/svg+xml");
      return;
    case "/garbage":
      html(pageWith("/not-an-image"));
      return;
    case "/not-an-image":
      // Lying the other way: an `image/png` header over bytes no sniffer recognises.
      served(Buffer.from("<!doctype html><p>our brand deck is a PDF", "utf8"), "image/png");
      return;
    case "/bare":
      html("<!doctype html><html><head><title>Acme</title></head><body>no images</body></html>");
      return;
    case "/too-big-declared":
      html(pageWith("/big.png"));
      return;
    case "/big.png":
      served(Buffer.alloc(LOGO_MAX_BYTES * 2, 0x61), "image/png");
      return;
    case "/too-big-chunked":
      html(pageWith("/big-chunked.png"));
      return;
    case "/big-chunked.png":
      // No `Content-Length`: the size is only knowable by counting the bytes as they arrive.
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(LOGO_MAX_BYTES * 2, 0x62));
      return;
    case "/points-at-metadata":
      html(pageWith(METADATA_LOGO));
      return;
    case "/down":
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("maintenance");
      return;
    default:
      // Including `/favicon.ico`, which `logoCandidates` appends to every page.
      res.writeHead(404);
      res.end();
  }
}

interface Branding {
  displayName: string | null;
  tagline: string | null;
  accentColor: string | null;
  fontFamily: string;
  radius: string;
  logo: {
    url: string;
    contentType: string;
    width: number;
    height: number;
    bytes: number;
    source: string;
  } | null;
  supportEmail: string | null;
  showPoweredBy: boolean;
  tokens: { light: Record<string, string>; dark: Record<string, string> };
  contrast: { pair: string; mode: string; ratio: number; passes: boolean }[];
  effectiveName: string;
}

interface Enablement {
  modules: {
    id: string;
    enabled: boolean;
    locked: boolean;
    lockedReason: string | null;
    dependsOn: string[];
  }[];
}

interface SetupStatus {
  required: boolean;
  progress: {
    owner: boolean;
    mail: boolean;
    storage: boolean;
    branding: boolean;
    offering: boolean;
  };
}

let acmeId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  site = createServer(handleSite);
  await new Promise<void>((resolve) => {
    site?.listen(0, "127.0.0.1", resolve);
  });
  sitePort = (site.address() as AddressInfo).port;
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
      // One private host, named: the website-import cases below reach the local site server
      // through the real guard, and every other private address stays refused.
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
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
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  // The container's stop closes the outbound agent, so the site server has no live sockets left.
  await running?.stop();
  if (site) {
    const closing = site;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => {
      closing.close(() => resolve());
    });
  }
  await pg?.stop();
});

describe("registry", () => {
  it("registers the two permissions and the admin nav slot", async () => {
    const registry = running.container.registry;
    for (const p of ["branding.read", "branding.manage"]) {
      expect(registry.permissions.get(p)).toBe("branding");
    }
    const boot = await json<{
      modules: { id: string; enabled: boolean; slots: Record<string, unknown[]> }[];
    }>(await request("acme", "/api/v1/modules", { cookie: owner.cookie }));
    const mod = boot.modules.find((m) => m.id === "branding");
    expect(mod?.enabled).toBe(true);
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
  });
});

describe("the brand", () => {
  it("starts at the shipped defaults, with the workspace name as the effective name", async () => {
    const res = await request("acme", "/api/v1/branding", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const brand = await json<Branding>(res);
    expect(brand).toMatchObject({
      displayName: null,
      tagline: null,
      accentColor: null,
      fontFamily: "system",
      radius: "soft",
      logo: null,
      showPoweredBy: true,
      effectiveName: "Acme",
    });
    // No accent chosen means no colour tokens at all: the stylesheet default shows through,
    // so "no brand" and "a brand that happens to match the default" stay distinguishable.
    expect(brand.tokens.light).toEqual({});
    expect(brand.contrast).toEqual([]);
  });

  it("derives new tokens and a contrast report when the accent changes", async () => {
    const res = await request("acme", "/api/v1/branding", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ accentColor: "#B91C1C", displayName: "Acme Investors" }),
    });
    expect(res.status).toBe(200);
    const brand = await json<Branding>(res);
    expect(brand.accentColor).toBe("#B91C1C");
    expect(brand.effectiveName).toBe("Acme Investors");
    expect(brand.tokens.light["--sh-color-primary"]).toMatch(/^#[0-9a-f]{6}$/u);
    // Each palette moves the hue its own way; reusing one value in both is the bug.
    expect(brand.tokens.dark["--sh-color-primary"]).not.toBe(
      brand.tokens.light["--sh-color-primary"],
    );
    expect(brand.contrast).toHaveLength(4);
    expect(brand.contrast.every((f) => f.passes)).toBe(true);
  });

  it("keeps the rest of the settings jsonb intact and audits the change", async () => {
    // The branding save writes the `branding` block alone (A-3 R2 M1,
    // `updateWorkspaceSettingsBlock`): every other key stays exactly as stored.
    const read = async () =>
      (
        await rows<{ settings: Record<string, unknown> }>(
          `SELECT settings FROM core.workspace WHERE id = '${acmeId}'::uuid`,
        )
      )[0]?.settings ?? {};
    await rows(
      `UPDATE core.workspace SET settings = settings || '{"zzOther": {"x": 1}}'::jsonb
        WHERE id = '${acmeId}'::uuid RETURNING id`,
    );
    const before = await read();
    const res = await request("acme", "/api/v1/branding", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ displayName: "Acme Investors" }),
    });
    expect(res.status).toBe(200);
    const { branding, ...rest } = await read();
    const { branding: _old, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(rest["zzOther"]).toEqual({ x: 1 });
    expect(branding).toMatchObject({ displayName: "Acme Investors", accentColor: "#B91C1C" });
    await rows(
      `UPDATE core.workspace SET settings = settings - 'zzOther' WHERE id = '${acmeId}'::uuid RETURNING id`,
    );
    const audit = await rows<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'branding.settings_changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("branding.settings_changed");
  });

  it("refuses a colour that is not a colour, and a token map", async () => {
    for (const body of [
      { accentColor: "rebeccapurple" },
      { accentColor: "#ff00" },
      { tokens: { light: { "--sh-color-primary": "#000000" } } },
    ]) {
      const res = await request("acme", "/api/v1/branding", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // …and the brand is unchanged by the attempt.
    const brand = await json<Branding>(
      await request("acme", "/api/v1/branding", { cookie: owner.cookie }),
    );
    expect(brand.accentColor).toBe("#B91C1C");
  });
});

describe("the logo", () => {
  it("accepts a PNG, decides the type from the bytes and stores it content-addressed", async () => {
    const res = await request("acme", "/api/v1/branding/logo", {
      method: "POST",
      cookie: owner.cookie,
      // The advisory `contentType` deliberately lies: the bytes must win.
      body: JSON.stringify({ data: base64(png(256, 128)), contentType: "image/jpeg" }),
    });
    expect(res.status).toBe(200);
    const brand = await json<Branding>(res);
    expect(brand.logo).toMatchObject({
      contentType: "image/png",
      width: 256,
      height: 128,
      source: "upload",
    });
    // Served from our own origin, on this workspace's host, never a third party's.
    expect(brand.logo?.url).toMatch(
      /^http:\/\/acme\.portal\.example\.test\/api\/v1\/branding\/logo\?v=[0-9a-f]{16}$/u,
    );
    const stored = await rows<{ settings: { branding: { logo: { key: string } } } }>(
      `SELECT settings FROM core.workspace WHERE id = '${acmeId}'::uuid`,
    );
    expect(stored[0]?.settings.branding.logo.key).toMatch(
      new RegExp(`^ws/${acmeId}/branding/[0-9a-f]{64}$`, "u"),
    );
  });

  it("refuses a text file and an SVG: neither is an image format we serve", async () => {
    for (const payload of [
      "hello, I am definitely a logo",
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>',
    ]) {
      const res = await request("acme", "/api/v1/branding/logo", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ data: Buffer.from(payload, "utf8").toString("base64") }),
      });
      expect(res.status).toBe(415);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
        "unsupported_media_type",
      );
    }
  });

  it("refuses an image too small to be a logo", async () => {
    const res = await request("acme", "/api/v1/branding/logo", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ data: base64(png(16, 16)) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: { reason: string } }>(res)).error.reason).toBe("too_small");
  });

  it("refuses an oversized body before it ever reaches the handler", async () => {
    // Base64 expands by a third, so anything over the 1 MiB logo cap is also over the API's
    // own body limit — the cap is enforced twice, and the outer one answers first.
    const huge = png(256, 256);
    const padded = new Uint8Array(LOGO_MAX_BYTES + 1024);
    padded.set(huge, 0);
    const res = await request("acme", "/api/v1/branding/logo", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ data: base64(padded) }),
    });
    expect(res.status).toBe(413);
  });

  it("serves the bytes to a caller with NO session at all", async () => {
    const res = await request("acme", "/api/v1/branding/logo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("answers 304 when the caller already has these bytes", async () => {
    const first = await request("acme", "/api/v1/branding/logo");
    const etag = first.headers.get("etag") as string;
    for (const value of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
      const res = await request("acme", "/api/v1/branding/logo", {
        headers: { "if-none-match": value },
      });
      expect(res.status).toBe(304);
    }
    const stale = await request("acme", "/api/v1/branding/logo", {
      headers: { "if-none-match": `"${"0".repeat(64)}"` },
    });
    expect(stale.status).toBe(200);
  });

  it("removes the logo and forgets the object", async () => {
    const before = await json<Branding>(
      await request("acme", "/api/v1/branding", { cookie: owner.cookie }),
    );
    const key = `ws/${acmeId}/branding/${(before.logo?.url ?? "").split("v=")[1]}`;
    expect(key).toBeTruthy();
    const res = await request("acme", "/api/v1/branding/logo", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect((await json<Branding>(res)).logo).toBeNull();
    // The public route now tells the truth rather than serving a stale object.
    expect((await request("acme", "/api/v1/branding/logo")).status).toBe(404);
    expect(
      (await request("acme", "/api/v1/branding/logo", { method: "DELETE", cookie: owner.cookie }))
        .status,
    ).toBe(404);
  });
});

describe("the logo, imported from the company website", () => {
  /** Every case that must not store anything checks the brand against this afterwards. */
  async function brand(): Promise<Branding> {
    return json<Branding>(await request("acme", "/api/v1/branding", { cookie: owner.cookie }));
  }

  async function importFrom(url: string, cookie = owner.cookie) {
    return request("acme", "/api/v1/branding/logo/fetch", {
      method: "POST",
      cookie,
      body: JSON.stringify({ url }),
    });
  }

  it("reads the Open Graph image, stores it content-addressed and serves it back", async () => {
    const from = hits.length;
    const res = await importFrom(siteUrl("/"));
    expect(res.status).toBe(200);
    const sha256 = sha256Of(WEBSITE_LOGO);
    expect((await json<Branding>(res)).logo).toMatchObject({
      contentType: "image/png",
      width: 320,
      height: 200,
      bytes: WEBSITE_LOGO.byteLength,
      source: "website",
    });

    // Both hops went through the guarded client, which announces itself and asks for what it
    // wants: the page as HTML, the candidate as an image.
    const [page, candidate] = hits.slice(from);
    expect(page).toMatchObject({ path: "/", accept: "text/html,*/*" });
    expect(candidate).toMatchObject({ path: "/logo.png", accept: "image/*" });
    expect(candidate?.userAgent).toMatch(/^FundRoom\//u);

    // The object is ours, at a key derived from the bytes, with the sniffed type recorded.
    const stored = await rows<{
      settings: { branding: { logo: { key: string; sha256: string; contentType: string } } };
    }>(`SELECT settings FROM core.workspace WHERE id = '${acmeId}'::uuid`);
    expect(stored[0]?.settings.branding.logo).toMatchObject({
      key: `ws/${acmeId}/branding/${sha256}`,
      sha256,
      contentType: "image/png",
    });
    const audit = await rows<{ meta: { source: string; sha256: string; bytes: number } }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'branding.logo_changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.meta).toMatchObject({
      source: "website",
      sha256,
      bytes: WEBSITE_LOGO.byteLength,
    });

    // …and the public route serves those exact bytes, with the type the bytes decided — the
    // header a mail client and a browser will both act on.
    const served = await request("acme", "/api/v1/branding/logo");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("etag")).toBe(`"${sha256}"`);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...WEBSITE_LOGO]);
  });

  it("stores what the bytes are, never what the site's Content-Type claimed", async () => {
    // `image/svg+xml` would be stored XSS on our own origin and `text/html` worse; the site
    // gets no say, because the value is echoed as a response header on a public route.
    for (const path of ["/lies-svg", "/lies-html"]) {
      const res = await importFrom(siteUrl(path));
      expect(res.status, path).toBe(200);
      expect((await json<Branding>(res)).logo).toMatchObject({
        contentType: "image/png",
        width: 320,
        source: "website",
      });
    }
  });

  it("refuses bytes that really are an SVG, or parse as nothing, and stores neither", async () => {
    for (const [page, candidate] of [
      ["/really-svg", "/real.svg"],
      ["/garbage", "/not-an-image"],
    ] as const) {
      const res = await importFrom(siteUrl(page));
      expect(res.status, page).toBe(400);
      const body = await json<{
        error: { code: string; tried: { url: string; reason: string }[] };
      }>(res);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.tried).toEqual(
        expect.arrayContaining([{ url: siteUrl(candidate), reason: "unsupported_type" }]),
      );
    }
    // The brand still carries the PNG the happy path imported: a refusal changes nothing.
    expect((await brand()).logo).toMatchObject({
      contentType: "image/png",
      bytes: WEBSITE_LOGO.byteLength,
      source: "website",
    });
  });

  it("says what it tried when the page names nothing usable", async () => {
    const res = await importFrom(siteUrl("/bare"));
    expect(res.status).toBe(400);
    const body = await json<{
      error: { message: string; tried: { url: string; reason: string }[] };
    }>(res);
    // `logoCandidates` appends `/favicon.ico` to every page, so a page that names nothing
    // still has exactly one candidate — which is why the message names the images it tried.
    expect(body.error.tried).toEqual([{ url: siteUrl("/favicon.ico"), reason: "http_404" }]);
    expect(body.error.message).toMatch(/none of the images/u);
  });

  it("refuses a candidate past the logo cap, by its declared length and by its bytes", async () => {
    /*
     * Two ways to be too big, and both are caught before the bytes are buffered: the declared
     * `Content-Length` up front, and the count of what actually arrives on a chunked response.
     * The guard's own response cap is `LOGO_MAX_BYTES` to the byte, so it answers first and the
     * route's `boundedBytes` is the second line of defence rather than the one that fires.
     */
    for (const [page, candidate] of [
      ["/too-big-declared", "/big.png"],
      ["/too-big-chunked", "/big-chunked.png"],
    ] as const) {
      const res = await importFrom(siteUrl(page));
      expect(res.status, page).toBe(400);
      const body = await json<{ error: { tried: { url: string; reason: string }[] } }>(res);
      expect(body.error.tried[0]).toEqual({
        url: siteUrl(candidate),
        reason: "response_too_large",
      });
    }
    expect((await brand()).logo?.bytes).toBe(WEBSITE_LOGO.byteLength);
  });

  it("turns an address the guard refuses into a 4xx naming the URL, never a 500", async () => {
    // A founder who types one of these has a typo to fix; a 500 would send them to support.
    for (const [url, reason] of [
      [METADATA_LOGO, "blocked_address"],
      ["http://10.1.2.3/logo.png", "blocked_address"],
      ["http://acme.internal/", "blocked_host"],
      ["http://93.184.216.34:8080/", "blocked_port"],
    ] as const) {
      const res = await importFrom(url);
      expect(res.status, url).toBe(400);
      expect(await json<{ error: unknown }>(res)).toMatchObject({
        error: { code: "invalid_request", reason, url },
      });
    }
    const metadata = await importFrom(METADATA_LOGO);
    expect((await json<{ error: { message: string } }>(metadata)).error.message).toBe(
      "that address cannot be fetched from here",
    );
  });

  it("refuses a URL carrying credentials, and a site that is down, with a 4xx (P2b-01)", async () => {
    // `new Request()` refuses userinfo with a bare TypeError; the guard now answers first.
    for (const url of [
      "http://spoofed.example.com@127.0.0.1/",
      `http://user:secret@127.0.0.1:${sitePort}/`,
    ]) {
      const res = await importFrom(url);
      expect(res.status, url).toBe(400);
      const body = await json<{ error: { code: string; reason: string; url?: string } }>(res);
      expect(body.error).toMatchObject({ code: "invalid_request", reason: "blocked_host" });
      expect(JSON.stringify(body)).not.toMatch(/secret|spoofed/u);
    }
    // Connection refused is the network, not this server: 4xx, not 500.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const down = await importFrom(`http://127.0.0.1:${closedPort}/`);
    expect(down.status).toBe(400);
    expect(await json<{ error: unknown }>(down)).toMatchObject({
      error: { code: "invalid_request", reason: "unreachable" },
    });
    expect((await brand()).logo?.source).toBe("website");
  });

  it("re-validates every candidate the page names through the same guard", async () => {
    // The one that matters: the candidate is a string out of a third party's markup, and this
    // page aims it at the cloud metadata service. The guard refuses it like any other address.
    const res = await importFrom(siteUrl("/points-at-metadata"));
    expect(res.status).toBe(400);
    const body = await json<{ error: { tried: { url: string; reason: string }[] } }>(res);
    expect(body.error.tried[0]).toEqual({ url: METADATA_LOGO, reason: "blocked_address" });
    expect((await brand()).logo?.source).toBe("website");
  });

  it("reports the status a page answered rather than hunting for images in it", async () => {
    const res = await importFrom(siteUrl("/down"));
    expect(res.status).toBe(400);
    expect(await json<{ error: unknown }>(res)).toMatchObject({
      error: { code: "invalid_request", status: 503, message: "that page answered 503" },
    });
  });

  it("is branding.manage: an editor is refused before anything leaves the process", async () => {
    const from = hits.length;
    const res = await importFrom(siteUrl("/"), editor.cookie);
    expect(res.status).toBe(403);
    expect(hits.length).toBe(from);
  });
});

describe("the theme document", () => {
  it("is public, cacheable, and carries only this workspace's overrides", async () => {
    const res = await request("acme", "/api/v1/branding/theme");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    const doc = await json<Record<string, Record<string, Record<string, { $value: string }>>>>(res);
    expect(doc["$schema"]).toBe("https://tr.designtokens.org/format/");
    expect(doc["color"]?.["light"]?.["primary"]?.$value).toMatch(/^#[0-9a-f]{6}$/u);
    // The font and radius are still the defaults, so nothing is claimed about them.
    expect(doc["font"]).toBeUndefined();
  });
});

describe("who may do this", () => {
  it("a staff editor may not read or change the brand (403: the role is the answer)", async () => {
    const read = await request("acme", "/api/v1/branding", { cookie: editor.cookie });
    expect(read.status).toBe(403);
    const write = await request("acme", "/api/v1/branding", {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ tagline: "mine now" }),
    });
    expect(write.status).toBe(403);
  });

  it("an investor gets the 404 an unknown URL gives, never a 403 that confirms the route", async () => {
    for (const path of ["/api/v1/branding", "/api/v1/modules/enablement"]) {
      expect((await request("acme", path, { cookie: ada.cookie })).status).toBe(404);
    }
    const write = await request("acme", "/api/v1/branding/logo", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ data: base64(png(64, 64)) }),
    });
    expect(write.status).toBe(404);
  });

  it("the public routes need no session but the staff ones still do", async () => {
    expect((await request("acme", "/api/v1/branding/theme")).status).toBe(200);
    expect((await request("acme", "/api/v1/branding")).status).toBe(401);
  });
});

describe("module enablement", () => {
  it("lists every compiled-in module with its lock", async () => {
    const res = await request("acme", "/api/v1/modules/enablement", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const list = await json<Enablement>(res);
    const byId = new Map(list.modules.map((m) => [m.id, m]));
    expect(byId.get("branding")).toMatchObject({
      enabled: true,
      locked: true,
      lockedReason: "required",
    });
    expect(byId.get("data-room")).toMatchObject({
      enabled: true,
      locked: false,
      lockedReason: null,
      dependsOn: ["access", "content"],
    });
  });

  it("turns an optional module off, and its routes go with it", async () => {
    const res = await request("acme", "/api/v1/modules/data-room", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(await json<{ enabled: boolean }>(res)).toMatchObject({
      id: "data-room",
      enabled: false,
    });
    const tree = await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie });
    expect(tree.status).toBe(404);
    expect((await json<{ error: { code: string } }>(tree)).error.code).toBe("module_disabled");

    const audit = await rows<{ resource_kind: string; meta: { module: string } }>(
      `SELECT resource_kind, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'module.enablement_changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]).toMatchObject({ resource_kind: "module", meta: { module: "data-room" } });
  });

  it("turns it back on and the routes return", async () => {
    const res = await request("acme", "/api/v1/modules/data-room", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect((await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie })).status).toBe(
      200,
    );
  });

  it("refuses to switch off a required module — a kernel surface has no off switch", async () => {
    for (const id of ["access", "compliance", "branding", "content"]) {
      const res = await request("acme", `/api/v1/modules/${id}`, {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(409);
      const body = await json<{ error: { code: string; reason: string } }>(res);
      expect(body.error.code).toBe("conflict");
      expect(body.error.reason).toBe("required");
    }
  });

  it("refuses a module nobody compiled in", async () => {
    // `crm` was the example until E2.5 compiled it in; the id must be one no epic will claim.
    const res = await request("acme", "/api/v1/modules/nobody-shipped-this", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });

  it("is owner-or-admin, not a permission: an editor is refused", async () => {
    expect(
      (await request("acme", "/api/v1/modules/enablement", { cookie: editor.cookie })).status,
    ).toBe(403);
    expect(
      (
        await request("acme", "/api/v1/modules/data-room", {
          method: "PATCH",
          cookie: editor.cookie,
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(403);
  });
});

describe("setup wizard progress", () => {
  it("reports kernel-owned facts only, and flips as they are settled", async () => {
    const before = await json<SetupStatus>(
      // `progress` is for a signed-in staff owner/admin only (E2.10 ZAP-04).
      await request("acme", "/api/v1/setup/status", { cookie: owner.cookie }),
    );
    expect(before.required).toBe(false);
    expect(before.progress.owner).toBe(true);
    expect(before.progress.branding).toBe(true); // the accent was set above
    expect(before.progress.offering).toBe(false);
    // No data-room / invites / updates keys: those are module facts, and the kernel must not
    // read a module's tables to answer them (ADR-0033, the E1.6 lesson).
    expect(Object.keys(before.progress).sort()).toEqual([
      "branding",
      "mail",
      "offering",
      "owner",
      "storage",
    ]);

    // Opening the offering screen opens the first period, which is the fact the step asks for.
    expect(
      (await request("acme", "/api/v1/compliance/offering", { cookie: owner.cookie })).status,
    ).toBe(200);
    const after = await json<SetupStatus>(
      // `progress` is for a signed-in staff owner/admin only (E2.10 ZAP-04).
      await request("acme", "/api/v1/setup/status", { cookie: owner.cookie }),
    );
    expect(after.progress.offering).toBe(true);
  });

  it("degrades to all-false where no workspace has resolved", async () => {
    const res = await running.app.request(`${BASE}/api/v1/setup/status`, {
      headers: { host: CANON, cookie: owner.cookie },
    });
    const status = await json<SetupStatus>(res);
    expect(status.progress).toEqual({
      owner: true,
      mail: false,
      storage: false,
      branding: false,
      offering: false,
    });
  });
});

describe("the brand in outgoing mail", () => {
  /*
   * The point of the whole epic, end to end: a workspace-scoped message carries its workspace
   * id, the composition root's resolver turns that into the workspace's brand, and the rendered
   * HTML is the workspace's, not the instance's.
   *
   * It runs against a workspace of its own because the container caches a resolved brand for a
   * minute per workspace id: a workspace that has never sent mail has nothing cached, so the
   * brand set here is provably the one that rendered. The owner is the same user as Acme's — a
   * session is a user's, not a workspace's — so no sign-in mail goes out first and warms it.
   */
  it("renders a workspace-scoped email with the workspace's own brand", async () => {
    const vega = await createWorkspace(running.container.db, { slug: "vega", name: "Vega" });
    const deps = running.container.identityDeps;
    const user = await provisionUser(deps, { email: "owner@example.com" });
    await provisionMembership(deps, {
      workspaceId: vega.id,
      userId: user.userId,
      kind: "staff",
      role: "owner",
      source: "test",
    });
    const patch = await request("vega", "/api/v1/branding", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ accentColor: "#7C3AED", displayName: "Vega Capital" }),
    });
    expect(patch.status).toBe(200);

    const to = "brandcheck@investor.test";
    const invited = await request("vega", "/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ invites: [{ email: to }] }),
    });
    expect(invited.status).toBe(200);

    // Scoped to this recipient, never to a position in the shared mailer array.
    const mail = mailer.sent.find((m) => m.to === to);
    expect(mail?.workspaceId).toBe(vega.id);
    const html = (mail?.html ?? "").toLowerCase();
    expect(html).toContain("vega capital");
    expect(html).toContain("#7c3aed");
    // The instance default would have shown neither the workspace name nor its accent.
    expect(html).not.toContain("#1d4ed8");
  });
});
