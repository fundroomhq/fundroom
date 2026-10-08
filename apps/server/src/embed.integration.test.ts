import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { EMBED_ARTIFACTS, EMBED_VERSION } from "@fundroom/embed/artifacts";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Embed end to end (E2.2, EXECUTION_PLAN §9.3, design/08 §1c/§6, ADR-0008/0009/0040).
 *
 * The shape of the epic, in order: an unconfigured workspace already frames itself and nobody
 * else (`frame-ancestors 'self'`, not `'none'`) → the settings screen reads the allow-list and
 * everything derived from it, and refuses a customer wildcard before it is stored → an added
 * origin becomes the header on the very next embed request → the document independently refuses
 * a request whose *observed* initiator is disallowed, while absence of evidence is never a
 * refusal → that refusal is audited once per (workspace, origin) and not once per visitor,
 * because the audit log is hash-chained → the loader is served from memory on two channels, one
 * rolling and one immutable, and `/embed/v1` is the loader's namespace rather than a workspace's
 * → `theme.json` is public, cacheable and CORS-open → a host-signed assertion becomes a session
 * only when the workspace opted in, the key is registered, the membership exists and the `jti`
 * has not been spent → and the permissions, where an investor gets the 404 an unknown URL gives
 * rather than the 403 that would confirm the route exists.
 *
 * Two harness notes:
 *
 *  - `WEB_DIST_PATH` points at a stub `index.html`, because the origin check and the rejection
 *    page live on the document route and the placeholder branch is not the thing being tested.
 *  - The handoff assertions are signed with `node:crypto`'s Ed25519 rather than through `jose`.
 *    The verifier is `jose`'s, and a test that minted its tokens with the same library could
 *    agree with itself about a malformed one; `crypto.sign(null, …)` is the raw primitive a
 *    PHP host with `sodium` will use, which is the interoperability this protocol promises.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const HOST_SITE = "https://acme.com";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
let betaId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor;

interface Actor {
  cookie: string;
  membershipId: string;
}

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><script type="module" src="/assets/app.js" nonce="__CSP_NONCE__"></script></head><body></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "");
  return dir;
}

async function req(host: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie && !headers.has("origin"))
    headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const request = (slug: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  req(`${slug}.${CANON}`, path, init);

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

/** `PUT /embed/settings` is a step-up route, so every staff actor enrols TOTP on sign-in. */
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

async function auditCount(action: string, workspaceId = acmeId): Promise<number> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${workspaceId}'::uuid
       AND action = '${action}'`,
    workspaceId,
  );
  return r[0]?.n ?? 0;
}

// --- the settings body, as the admin screen reads it ------------------------------------------
interface EmbedSettingsBody {
  origins: string[];
  allowPreviewOrigins: boolean;
  trustHostIdentity: boolean;
  handoffKeys: { id: string; publicKey: string; label: string; addedAt: string }[];
  frameAncestors: string[];
  previewOriginPatterns: string[];
  embedUrl: string;
  loaderUrl: string;
  loaderIntegrity: string;
  loaderPinnedUrl: string;
}

interface ErrorBody {
  error: { code: string; message: string; reason?: string };
}

const settings = async (cookie: string) =>
  json<EmbedSettingsBody>(await request("acme", "/api/v1/embed/settings", { cookie }));

const put = (cookie: string, body: unknown) =>
  request("acme", "/api/v1/embed/settings", {
    method: "PUT",
    cookie,
    body: JSON.stringify(body),
  });

/** The embed document, as a host page's iframe navigation looks to us. */
const embedDoc = (init: { referer?: string; origin?: string; site?: string } = {}) => {
  const headers = new Headers();
  if (init.site !== undefined) headers.set("sec-fetch-site", init.site);
  if (init.referer !== undefined) headers.set("referer", init.referer);
  if (init.origin !== undefined) headers.set("origin", init.origin);
  return req(CANON, "/embed/acme/updates", { headers });
};

// --- Ed25519, the way a PHP host with `sodium` will do it --------------------------------------
function b64u(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function keypair(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x?: string };
  if (jwk.x === undefined) throw new Error("no x in the exported Ed25519 JWK");
  return { privateKey: pair.privateKey, publicKey: jwk.x };
}

function assertion(
  key: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid, ...header }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(sign(null, Buffer.from(`${h}.${p}`), key))}`;
}

function claimsFor(email: string, jti: string, over: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: HOST_SITE, aud: "acme", sub: email, iat, exp: iat + 30, jti, ...over };
}

const HOST_KEY = keypair();
const OTHER_KEY = keypair();

const handoff = (body: unknown, slug = "acme") =>
  req(CANON, `/w/${slug}/api/v1/embed/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${CANON}` },
    body: JSON.stringify(body),
  });

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
      ROLES: "api,web",
      WEB_DIST_PATH: fakeWebDist(),
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
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  await member("beta", betaId, "owner@beta.example.com", "staff", "owner");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("registry", () => {
  it("registers the two permissions and the admin nav slot, and cannot be switched off", async () => {
    for (const p of ["embed.read", "embed.manage"]) {
      expect(running.container.registry.permissions.get(p)).toBe("embed");
    }
    const boot = await json<{
      modules: { id: string; enabled: boolean; slots: Record<string, { order: number }[]> }[];
    }>(await request("acme", "/api/v1/modules", { cookie: owner.cookie }));
    const mod = boot.modules.find((m) => m.id === "embed");
    expect(mod?.enabled).toBe(true);
    expect(mod?.slots["admin.nav"]?.[0]?.order).toBe(25);
    /*
     * `required`, and here that is not a convenience: `frame-ancestors` is computed by the
     * security-headers middleware before enablement is consulted, so a workspace that switched
     * `embed` off would keep serving framed pages with the screen that governs them gone — a
     * framing control with an off switch, which fails open.
     */
    const enablement = await json<{ modules: { id: string; locked: boolean }[] }>(
      await request("acme", "/api/v1/modules/enablement", { cookie: owner.cookie }),
    );
    expect(enablement.modules.find((m) => m.id === "embed")?.locked).toBe(true);
  });
});

describe("an unconfigured workspace", () => {
  it("frames itself and nobody else, and says so in both the header and the settings", async () => {
    // E2.2 decision 3: `'self'` is always present, so the admin screen can preview its own embed
    // and the honest answer for an unconfigured workspace is "only we may frame it" rather than
    // "nobody may" — which is what `'none'` said, and which also broke that preview.
    const doc = await embedDoc();
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(doc.headers.get("x-frame-options")).toBeNull();
    expect(doc.headers.get("permissions-policy")).toContain("publickey-credentials-get=(self)");

    const body = await settings(owner.cookie);
    expect(body).toMatchObject({
      origins: [],
      allowPreviewOrigins: false,
      trustHostIdentity: false,
      handoffKeys: [],
      frameAncestors: ["'self'"],
    });
    // The curated preview patterns are returned even while the toggle is off, so the screen can
    // name what turning it on would trust.
    expect(body.previewOriginPatterns).toContain("https://*.webflow.io");
    expect(body.embedUrl).toBe(`https://acme.${CANON}/embed/acme`);
    expect(body.loaderUrl).toBe(`https://acme.${CANON}/embed/v1/embed.js`);
    expect(body.loaderPinnedUrl).toBe(`https://acme.${CANON}/embed/${EMBED_VERSION}/embed.js`);
    // The SRI value belongs to the pinned URL: it describes bytes that cannot change.
    expect(body.loaderIntegrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/u);
    expect(body.loaderIntegrity).toBe(
      EMBED_ARTIFACTS.find((a) => a.path === "embed.js")?.sha384 ?? "",
    );
  });
});

describe("changing the allow-list", () => {
  it("refuses a customer wildcard, a path and a plain-http origin before storing anything", async () => {
    for (const origin of [
      "https://*.acme.com",
      "https://acme.com/investors",
      "http://acme.com",
      "javascript:alert(1)",
    ]) {
      const res = await put(owner.cookie, { origins: [origin] });
      expect(res.status).toBe(400);
      // `invalid_request` with the offending origin named, not a bare schema failure: the
      // contract bounds the length and the domain rule decides the meaning.
      const body = await json<ErrorBody>(res);
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.reason).toBe("invalid_origin");
    }
    expect((await settings(owner.cookie)).origins).toEqual([]);
  });

  it("normalises what it does accept, and the header changes on the very next request", async () => {
    const res = await put(owner.cookie, {
      origins: ["HTTPS://ACME.COM/", "https://www.acme.com:443", "http://localhost:5173"],
    });
    expect(res.status).toBe(200);
    const body = await json<EmbedSettingsBody>(res);
    // Upper case, a trailing slash and an explicit default port are spellings of one origin.
    expect(body.origins).toEqual([
      "https://acme.com",
      "https://www.acme.com",
      "http://localhost:5173",
    ]);
    expect(body.frameAncestors).toEqual([
      "'self'",
      "https://acme.com",
      "https://www.acme.com",
      "http://localhost:5173",
    ]);
    const doc = await embedDoc();
    expect(doc.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://acme.com https://www.acme.com http://localhost:5173",
    );
  });

  it("adds the curated builder patterns only while the toggle is on", async () => {
    const on = await json<EmbedSettingsBody>(
      await put(owner.cookie, { allowPreviewOrigins: true }),
    );
    expect(on.frameAncestors).toContain("https://*.webflow.io");
    expect((await embedDoc()).headers.get("content-security-policy")).toContain(
      "https://*.webflow.io",
    );
    const off = await json<EmbedSettingsBody>(
      await put(owner.cookie, { allowPreviewOrigins: false }),
    );
    expect(off.frameAncestors).not.toContain("https://*.webflow.io");
  });

  it("audits the change with the whole block before and after, and leaves other settings alone", async () => {
    const before = await auditCount("embed.settings_changed");
    await put(owner.cookie, { origins: ["https://acme.com", "https://www.acme.com"] });
    expect(await auditCount("embed.settings_changed")).toBe(before + 1);
    const audit = await rows<{
      diff: { before: { origins: string[] }; after: { origins: string[] } };
    }>(
      `SELECT diff FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'embed.settings_changed' ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    );
    expect(audit[0]?.diff.after.origins).toEqual(["https://acme.com", "https://www.acme.com"]);
    // The settings jsonb is replaced wholesale, so a partial write would have dropped `branding`
    // and everything else; the branding route still answers from the same row.
    const branding = await json<{ effectiveName: string }>(
      await request("acme", "/api/v1/branding", { cookie: owner.cookie }),
    );
    expect(branding.effectiveName).toBe("Acme");
  });

  it("needs a fresh session, and the permission is owner/admin only", async () => {
    // An editor manages texts and pages; repointing whose site may wrap the portal is not that.
    const asEditor = await put(editor.cookie, { origins: [] });
    expect(asEditor.status).toBe(403);
    expect((await json<ErrorBody>(asEditor)).error.code).toBe("forbidden");
    // An investor gets the 404 an unknown URL gives, not the 403 that would confirm the route.
    const asInvestor = await request("acme", "/api/v1/embed/settings", { cookie: ada.cookie });
    expect(asInvestor.status).toBe(404);
    /*
     * A staff session that has not reached the workspace's required sign-in strength is refused,
     * and so is a stale one: `PUT` declares `embed.manage+fresh` (pinned against the matrix by
     * `authz-matrix.test.ts`), which adds the ten-minute freshness check on top of the level.
     * design/02 §78 lists this class of change for the same reason E2.1 stepped up custom
     * domains — a stolen session that could add an origin would be a clickjacking primitive.
     */
    const weak = await signIn("acme", "owner@example.com");
    const noStepUp = await put(weak.cookie, { origins: ["https://acme.com"] });
    expect(noStepUp.status).toBe(403);
    const refusal = await json<ErrorBody>(noStepUp);
    expect(refusal.error.code).toBe("step_up_required");
    expect(refusal.error.reason).toBe("level");
  });
});

describe("handoff keys", () => {
  it("stamps addedAt, preserves it for an unchanged key and drops what is left out", async () => {
    const first = await json<EmbedSettingsBody>(
      await put(owner.cookie, {
        trustHostIdentity: true,
        handoffKeys: [
          { id: "wp-1", publicKey: HOST_KEY.publicKey, label: "acme.com WordPress" },
          { id: "wp-2", publicKey: OTHER_KEY.publicKey, label: "staging" },
        ],
      }),
    );
    expect(first.handoffKeys.map((k) => k.id)).toEqual(["wp-1", "wp-2"]);
    const stamped = first.handoffKeys[0]?.addedAt ?? "";
    expect(Date.parse(stamped)).toBeGreaterThan(0);

    // Whole-list replace: `wp-2` is absent, so it is gone. `wp-1` is unchanged, so its `addedAt`
    // survives — dating it from this write would make the trail claim it was registered now.
    const second = await json<EmbedSettingsBody>(
      await put(owner.cookie, {
        handoffKeys: [{ id: "wp-1", publicKey: HOST_KEY.publicKey, label: "renamed" }],
      }),
    );
    expect(second.handoffKeys).toHaveLength(1);
    expect(second.handoffKeys[0]).toMatchObject({ id: "wp-1", label: "renamed", addedAt: stamped });

    // Re-pointing a `kid` at different bytes is a new key however it is spelled.
    const third = await json<EmbedSettingsBody>(
      await put(owner.cookie, {
        handoffKeys: [{ id: "wp-1", publicKey: OTHER_KEY.publicKey, label: "rotated" }],
      }),
    );
    expect(third.handoffKeys[0]?.addedAt).not.toBe(stamped);

    // Back to the real key for the handoff tests below.
    await put(owner.cookie, {
      trustHostIdentity: true,
      handoffKeys: [{ id: "wp-1", publicKey: HOST_KEY.publicKey, label: "acme.com WordPress" }],
    });
  });

  it("refuses a key that is not 32 base64url bytes", async () => {
    const res = await put(owner.cookie, {
      handoffKeys: [{ id: "wp-9", publicKey: "not-a-key", label: "" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("the origin check on the embed document", () => {
  it("serves a listed origin, and refuses a cross-site one that is not listed", async () => {
    const allowed = await embedDoc({ site: "cross-site", referer: `${HOST_SITE}/investors` });
    expect(allowed.status).toBe(200);

    const refused = await embedDoc({ site: "cross-site", referer: "https://evil.example/wrap" });
    expect(refused.status).toBe(403);
    const html = await refused.text();
    // Minimal and unbranded: this page renders inside a site the workspace has not allow-listed,
    // so showing the workspace's identity there would be the phishing wrapper the list prevents.
    expect(html).not.toContain("Acme");
    expect(html).toContain(`https://acme.${CANON}`);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves when there is no evidence: no Referer, no Sec-Fetch-Site, or a direct visit", async () => {
    /*
     * Absence of evidence is not rejection (E2.2 §5). A host page with `Referrer-Policy:
     * no-referrer` sends us nothing, an older browser sends no `Sec-Fetch-*`, and a direct
     * top-level visit to `/embed/<slug>` is a person opening the "open in a new tab" fallback.
     * Refusing any of those would break working embeds to catch an attacker `frame-ancestors`
     * has already stopped.
     */
    expect((await embedDoc({ site: "cross-site" })).status).toBe(200);
    expect((await embedDoc({ referer: "https://evil.example/wrap" })).status).toBe(200);
    expect((await embedDoc({ site: "none" })).status).toBe(200);
    // Same-site is not refused either: in multi mode the admin screen previews its own embed
    // from `<slug>.<canonical>` while the document is served from the canonical host, and
    // `frame-ancestors 'self'` is the control there.
    expect(
      (await embedDoc({ site: "same-site", referer: `https://acme.${CANON}/admin/embed` })).status,
    ).toBe(200);
  });

  it("honours the builder-preview wildcard only while the toggle is on", async () => {
    const preview = { site: "cross-site", referer: "https://acme-portal.webflow.io/investors" };
    expect((await embedDoc(preview)).status).toBe(403);
    await put(owner.cookie, { allowPreviewOrigins: true });
    expect((await embedDoc(preview)).status).toBe(200);
    // A wildcard covers subdomains, never the bare domain: `webflow.io` is Webflow's own site.
    expect((await embedDoc({ site: "cross-site", referer: "https://webflow.io/x" })).status).toBe(
      403,
    );
    await put(owner.cookie, { allowPreviewOrigins: false });
    expect((await embedDoc(preview)).status).toBe(403);
  });

  it("audits a refusal once per (workspace, origin), not once per visitor", async () => {
    /*
     * The throttle is the point, not an optimisation: the audit log is hash-chained per
     * workspace, so every row links to the previous one and writes serialise. An unthrottled
     * write here would be a remote way to grow that table and to queue behind every real audit
     * write in the workspace — one row per visitor per page view of a disallowed site.
     */
    const before = await auditCount("embed.origin_rejected");
    const origin = "https://phisher.example";
    for (let i = 0; i < 5; i += 1) {
      expect((await embedDoc({ site: "cross-site", referer: `${origin}/${i}` })).status).toBe(403);
    }
    // The audit write is fire-and-forget, so give it a moment to land.
    await waitFor(async () =>
      (await auditCount("embed.origin_rejected")) > before ? true : undefined,
    );
    expect(await auditCount("embed.origin_rejected")).toBe(before + 1);
    const audit = await rows<{ meta: { origin: string } }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'embed.origin_rejected' ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    );
    expect(audit[0]?.meta.origin).toBe(origin);
    // A different origin is a different fact and gets its own row.
    expect(
      (await embedDoc({ site: "cross-site", referer: "https://other.example/x" })).status,
    ).toBe(403);
    await waitFor(async () =>
      (await auditCount("embed.origin_rejected")) > before + 1 ? true : undefined,
    );
  });
});

describe("the loader", () => {
  it("serves both channels from memory, with the cache policy each one has earned", async () => {
    const rolling = await req(CANON, "/embed/v1/embed.js");
    expect(rolling.status).toBe(200);
    const rollingBody = await rolling.clone().text();
    expect(rolling.headers.get("content-type")).toContain("text/javascript");
    expect(rolling.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    // `CORP: cross-origin` comes from the `asset` header profile, which until E2.2 was never
    // selected: a host page could not fetch a script that refused cross-origin embedding.
    expect(rolling.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(rolling.headers.get("access-control-allow-origin")).toBe("*");
    expect(await rolling.text()).toContain("SeedHost");

    const pinned = await req(CANON, `/embed/${EMBED_VERSION}/embed.js`);
    expect(pinned.status).toBe(200);
    // The version is in the path, so the bytes behind it can never change: `immutable` is honest
    // here and would be a lie on the rolling channel.
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await pinned.text()).toBe(rollingBody);

    const etag = pinned.headers.get("etag") ?? "";
    expect(etag).toContain("sha384-");
    const cached = await req(CANON, `/embed/${EMBED_VERSION}/embed.js`, {
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);
  });

  it("serves the ESM build and the SRI manifest, which names the same digests", async () => {
    expect((await req(CANON, "/embed/v1/embed.mjs")).status).toBe(200);
    const manifest = await req(CANON, "/embed/v1/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/json");
    const body = await json<{
      version: string;
      artifacts: Record<string, { integrity: string }>;
    }>(manifest);
    expect(body.version).toBe(EMBED_VERSION);
    expect(body.artifacts["embed.js"]?.integrity).toBe(
      EMBED_ARTIFACTS.find((a) => a.path === "embed.js")?.sha384,
    );
  });

  it("is the loader's namespace, not a workspace's, and needs no tenant", async () => {
    // `v1` is a legal workspace slug, so without the reserved prefix the namespace would depend
    // on whether a founder happened to claim it — and one who did could shadow the loader for
    // the whole install.
    for (const path of ["/embed/v1", "/embed/v1/", "/embed/v1/a/b", "/embed/v1/nope.js"]) {
      expect((await req(CANON, path)).status).toBe(404);
    }
    // The canonical host resolves no workspace in multi mode, and the loader does not need one.
    expect((await req(CANON, "/embed/v1/embed.js")).status).toBe(200);
    // A tenant host does not lend it a slug either; the bytes are the same.
    expect((await req(`acme.${CANON}`, "/embed/v1/embed.js")).status).toBe(200);
    // An unknown host is still 404 before any of this.
    expect((await req("evil.example", "/embed/v1/embed.js")).status).toBe(404);
  });
});

describe("theme.json", () => {
  it("is public, cacheable and CORS-open, and carries only this workspace's overrides", async () => {
    await request("acme", "/api/v1/branding", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ accentColor: "#3b5bdb" }),
    });
    const res = await req(CANON, "/embed/acme/theme.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    // `*` and credentials are mutually exclusive by specification, which is the property that
    // makes this safe to open: a browser will not attach the session cookie to a `*` request.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const doc = await json<Record<string, unknown>>(res);
    expect(doc["$schema"]).toBe("https://tr.designtokens.org/format/");
    expect(doc["color"]).toBeDefined();
    // Registered ahead of the SPA catch-all: otherwise this would have been an HTML document.
    expect(res.headers.get("content-type")).toContain("application/json");
    // Another workspace's slug answers that workspace, and an unknown one is a 404.
    expect((await req(CANON, "/embed/beta/theme.json")).status).toBe(200);
    expect((await req(CANON, "/embed/nobody/theme.json")).status).toBe(404);
  });
});

describe("the session cookie inside the frame", () => {
  /*
   * The point of the whole embed, and the bug that made it not work: the cookie recipe is chosen
   * from the request's classification, so a framed SPA calling `/w/<slug>/api/v1` was
   * indistinguishable from a first-party page and was handed a `SameSite=Lax` cookie the browser
   * then refused to send back from a third-party frame. The session was minted and immediately
   * unusable. The fix is the URL: the embed document's `apiBase` is its own prefix, and the
   * classifier reads the context off the path rather than off a header the caller could assert.
   */
  const otp = async (path: string, email: string) => {
    const since = mailer.sent.length;
    const start = await req(CANON, `${path}/api/v1/auth/otp/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${CANON}` },
      body: JSON.stringify({ email }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, email, since);
    return req(CANON, `${path}/api/v1/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${CANON}` },
      body: JSON.stringify({ email, code }),
    });
  };
  const sid = (res: Response) => res.headers.getSetCookie().find((c) => c.includes("sid=")) ?? "";

  it("a login under /embed/<slug>/api gets SameSite=None; Partitioned, and the plain path does not", async () => {
    const framed = await otp("/embed/acme", "ada@investor.test");
    expect(framed.status).toBe(200);
    const framedCookie = sid(framed);
    expect(framedCookie).toContain("SameSite=None");
    expect(framedCookie).toContain("Partitioned");
    // `__Host-` survives: the prefix needs `Secure`, no `Domain` and `Path=/`, and the cookie's
    // path has nothing to do with the request's.
    expect(framedCookie.startsWith("__Host-sid=")).toBe(true);
    expect(framedCookie).toContain("Path=/");
    // And it is a working session, addressed through the same prefix the page will use.
    const me = await req(CANON, "/embed/acme/api/v1/me", { cookie: cookiesOf(framed) });
    expect(me.status).toBe(200);

    const plain = await otp("/w/acme", "ada@investor.test");
    expect(plain.status).toBe(200);
    const plainCookie = sid(plain);
    expect(plainCookie).toContain("SameSite=Lax");
    expect(plainCookie).not.toContain("Partitioned");
  });

  it("records the framed session as partitioned, not first-party", async () => {
    // `core.session` is host-fenced (login runs before a membership exists), so this reads in
    // host context rather than through the tenant helper the rest of the file uses.
    const framed = await otp("/embed/acme", "ada@investor.test");
    expect(framed.status).toBe(200);
    const sessions = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT context FROM core.session WHERE last_workspace_id = '${acmeId}'::uuid
           ORDER BY created_at DESC LIMIT 1`,
      );
      return r.rows as { context: string }[];
    });
    expect(sessions[0]?.context).toBe("partitioned");
  });
});

describe("host-identity handoff", () => {
  it("refuses outright when the workspace has not opted in", async () => {
    await put(owner.cookie, { trustHostIdentity: false });
    const res = await handoff({
      assertion: assertion(HOST_KEY.privateKey, "wp-1", claimsFor("ada@investor.test", "j-off-1")),
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.reason).toBe("handoff_disabled");
    await put(owner.cookie, { trustHostIdentity: true });
  });

  it("exchanges a valid assertion for an auth_level 0 partitioned session, once", async () => {
    const jti = "j-accept-1";
    const token = assertion(HOST_KEY.privateKey, "wp-1", claimsFor("ada@investor.test", jti));
    const res = await handoff({ assertion: token });
    expect(res.status).toBe(200);
    expect(await json<{ ok: boolean; authLevel: number }>(res)).toEqual({ ok: true, authLevel: 0 });
    /*
     * `Partitioned` and `SameSite=None` because the session lives in a third-party iframe
     * (ADR-0009), and `auth_level` 0 because the host asserted this identity and nobody proved
     * it to us — every step-up gate in the product still asks.
     */
    const cookie = res.headers.getSetCookie().find((c) => c.includes("sid=")) ?? "";
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    const me = await req(CANON, "/w/acme/api/v1/me", { cookie: cookiesOf(res) });
    expect(me.status).toBe(200);
    expect((await json<{ session: { authLevel: number } }>(me)).session.authLevel).toBe(0);

    const accepted = await rows<{ meta: { keyId: string; issuer: string } }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'embed.handoff_accepted' ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    );
    expect(accepted[0]?.meta).toMatchObject({ keyId: "wp-1", issuer: HOST_SITE });

    // Single use, on `core.idempotency_key` rather than a fifth single-use table (decision 7).
    const replay = await handoff({ assertion: token });
    expect(replay.status).toBe(401);
    expect((await json<ErrorBody>(replay)).error.reason).toBe("replayed");
    const spent = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.idempotency_key
         WHERE key = 'auth.handoff:${acmeId}:${jti}'`,
    );
    expect(spent[0]?.n).toBe(1);
  });

  it("refuses an unregistered key, a forged signature, a foreign audience and a stale token", async () => {
    const cases: [string, string][] = [
      // A `kid` naming nothing and a `kid` naming a key whose bytes did not sign this both answer
      // `invalid_assertion` on the wire. Telling them apart here would make this public route a
      // `kid` oracle: a prober learns which key ids the workspace has registered, one request at
      // a time. The precise reason is still written to `embed.handoff_rejected`, which is where
      // an operator debugging a plugin reads it and where an attacker cannot.
      [
        "invalid_assertion",
        assertion(HOST_KEY.privateKey, "nope", claimsFor("ada@investor.test", "j-a")),
      ],
      [
        "invalid_assertion",
        assertion(OTHER_KEY.privateKey, "wp-1", claimsFor("ada@investor.test", "j-b")),
      ],
      [
        "audience",
        assertion(
          HOST_KEY.privateKey,
          "wp-1",
          claimsFor("ada@investor.test", "j-c", { aud: "beta" }),
        ),
      ],
      [
        "expired",
        assertion(
          HOST_KEY.privateKey,
          "wp-1",
          claimsFor("ada@investor.test", "j-d", {
            iat: Math.floor(Date.now() / 1000) - 300,
            exp: Math.floor(Date.now() / 1000) - 240,
          }),
        ),
      ],
      [
        "lifetime",
        assertion(
          HOST_KEY.privateKey,
          "wp-1",
          claimsFor("ada@investor.test", "j-e", { exp: Math.floor(Date.now() / 1000) + 3600 }),
        ),
      ],
      // `alg` is checked, never consulted: an HS256 token is not a token of this protocol.
      [
        "malformed",
        assertion(HOST_KEY.privateKey, "wp-1", claimsFor("a@b.test", "j-f"), { alg: "HS256" }),
      ],
    ];
    for (const [reason, token] of cases) {
      const res = await handoff({ assertion: token });
      expect(res.status, reason).toBe(401);
      expect((await json<ErrorBody>(res)).error.reason).toBe(reason);
    }
    const rejected = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'embed.handoff_rejected'`,
    );
    expect(rejected[0]?.n).toBeGreaterThanOrEqual(cases.length);
    // The other half of the collapse: what the wire withholds, the audit log keeps. If this ever
    // goes empty, the route has stopped recording the only copy of the distinction.
    const precise = await rows<{ reason: string }>(
      `SELECT meta->>'reason' AS reason FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'embed.handoff_rejected'`,
    );
    const reasons = new Set(precise.map((r) => r.reason));
    expect(reasons).toContain("unknown_key");
    expect(reasons).toContain("bad_signature");
  });

  it("will not sign in an address that holds no membership here", async () => {
    // The membership requirement is what keeps a host compromise from being account creation:
    // the host may assert any address it likes, and only one already in the room signs in.
    const res = await handoff({
      assertion: assertion(
        HOST_KEY.privateKey,
        "wp-1",
        claimsFor("stranger@example.com", "j-stranger"),
      ),
    });
    expect(res.status).toBe(401);
    expect((await json<ErrorBody>(res)).error.reason).toBe("not_eligible");
    const users = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership WHERE workspace_id = '${acmeId}'::uuid`,
    );
    expect(users[0]?.n).toBe(3);
  });

  it("rejects a member whose membership has expired, and says so (E3.2)", async () => {
    const deps = running.container.identityDeps;
    const gone = await provisionUser(deps, { email: "gone@investor.test", displayName: "Gone" });
    const m = await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: gone.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await running.container.db.pool.query(
      "UPDATE core.membership SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid",
      [m.id],
    );
    const res = await handoff({
      assertion: assertion(
        HOST_KEY.privateKey,
        "wp-1",
        claimsFor("gone@investor.test", "j-gone-expired"),
      ),
    });
    expect(res.status).toBe(401);
    expect((await json<ErrorBody>(res)).error.reason).toBe("membership_expired");
    const audited = await waitFor(async () => {
      const r = await rows<{ action: string; reason: string }>(
        `SELECT action, meta->>'reason' AS reason FROM audit.event
          WHERE workspace_id = '${acmeId}'::uuid AND meta->>'reason' = 'membership_expired'
          ORDER BY seq`,
      );
      return r.length >= 2 ? r : undefined;
    });
    expect(audited.map((r) => r.action).sort()).toEqual([
      "auth.login_failed",
      "embed.handoff_rejected",
    ]);
  });

  it("does not accept a key registered by another workspace", async () => {
    // `aud` is checked against the slug of the workspace the request resolved to, and Beta has
    // registered nothing: a key trusted by Acme is not a key trusted by the install.
    const res = await handoff(
      {
        assertion: assertion(
          HOST_KEY.privateKey,
          "wp-1",
          claimsFor("ada@investor.test", "j-beta", { aud: "beta" }),
        ),
      },
      "beta",
    );
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.reason).toBe("handoff_disabled");
  });
});

/** Polls until `probe` returns something; for the audit writes the request deliberately drops. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
