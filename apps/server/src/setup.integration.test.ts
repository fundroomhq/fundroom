import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { sha256 } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/*
 * First-run setup end to end (§9.4, ADR-0018): a fresh database, no workspace, a fixed
 * SETUP_TOKEN. The wizard's backend must gate everything on the token, create the owner
 * and sign them in, flip `setupRequired` everywhere at once, and let the owner run the
 * mail and storage probes on that session.
 */
const BASE = "http://localhost:3000";
const HOST = "localhost:3000";
const TOKEN = "e2e-setup-token-0123456789";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let dataDir: string;

async function request(
  path: string,
  init: RequestInit & { cookie?: string; origin?: boolean } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
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

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** Rows read as the workspace's `system` actor — no session, no authz, just the facts. */
async function rows<T>(workspaceId: string, query: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** `progress` is for a signed-in staff owner/admin only (E2.10 ZAP-04). */
async function progressOf(cookie: string): Promise<Record<string, boolean>> {
  const body = (await (await request("/api/v1/setup/status", { cookie })).json()) as {
    progress: Record<string, boolean>;
  };
  return body.progress;
}

/*
 * What the wizard's "secure your account" step does. Everything past the probes is a staff
 * route behind `requirePermission`, and an owner always needs a level-2 session (§6.2), so the
 * branding and offering halves of the wizard are unreachable until this has happened — which
 * is exactly what the wizard tells the founder.
 */
async function stepUpToMfa(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status, await confirm.text()).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function pageConfig(path: string): Promise<WebConfig> {
  const html = await (await request(path)).text();
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error("no config meta");
  return JSON.parse(m[1].replace(/&quot;/gu, '"').replace(/&amp;/gu, "&")) as WebConfig;
}

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta property="csp-nonce" nonce="__CSP_NONCE__"></head><body></body></html>`,
  );
  return dir;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  dataDir = mkdtempSync(join(tmpdir(), "fundroom-data-"));
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: join(dataDir, "storage"),
      DATA_DIR: dataDir,
      SETUP_TOKEN: TOKEN,
      TENANCY_MODE: "single",
      ROLES: "api,web,worker",
      WEB_DIST_PATH: fakeWebDist(),
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    modules: [],
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("before setup", () => {
  it("flags setupRequired on every page and in the status endpoint", async () => {
    expect((await pageConfig("/")).setupRequired).toBe(true);
    expect((await pageConfig("/setup")).setupRequired).toBe(true);
    expect((await pageConfig("/admin")).setupRequired).toBe(true);
    const status = await request("/api/v1/setup/status");
    expect(status.status).toBe(200);
    // Anonymous before setup: what the token and owner steps need, never drivers or probes.
    expect(await status.json()).toEqual({
      required: true,
      tenancy: "single",
      instanceName: expect.any(String),
      baseUrl: `${BASE}/`,
      tokenSource: "env",
      passwordEnabled: false,
    });
    expect(running.container.setupToken.source).toBe("env");
    expect(existsSync(join(dataDir, "setup-token"))).toBe(false);
  });

  it("rejects a wrong token, rate limits guesses, and refuses probes without a session", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await request("/api/v1/setup/token/verify", {
        method: "POST",
        body: JSON.stringify({ token: `wrong-token-${i}-0123456789` }),
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("invalid_credential");
    }
    const limited = await request("/api/v1/setup/token/verify", {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
    await running.container.rateLimiter.reset(`setup:token:${sha256("unknown")}`);

    const ok = await request("/api/v1/setup/token/verify", {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(ok.status).toBe(200);

    const probe = await request("/api/v1/setup/probes/storage", { method: "POST" });
    expect(probe.status).toBe(401);
  });

  it("refuses an owner with the wrong token and a bad slug", async () => {
    const wrong = await request("/api/v1/setup/owner", {
      method: "POST",
      body: JSON.stringify({
        token: "not-the-token-0123456789",
        email: "sam@acme.test",
        displayName: "Sam",
        workspaceName: "Acme",
      }),
    });
    expect(wrong.status).toBe(401);
    const badSlug = await request("/api/v1/setup/owner", {
      method: "POST",
      body: JSON.stringify({
        token: TOKEN,
        email: "sam@acme.test",
        displayName: "Sam",
        workspaceName: "Acme",
        workspaceSlug: "Not A Slug",
      }),
    });
    expect(badSlug.status).toBe(400);
    expect(await errorCode(badSlug)).toBe("validation_failed");
    expect((await pageConfig("/")).setupRequired).toBe(true);
  });
});

describe("creating the owner", () => {
  let cookie: string;
  let workspaceId: string;

  it("creates the workspace and owner, signs them in, and retires the token", async () => {
    const res = await request("/api/v1/setup/owner", {
      method: "POST",
      body: JSON.stringify({
        token: TOKEN,
        email: "Sam@Acme.test",
        displayName: "Sam Founder",
        workspaceName: "Acme Inc.",
      }),
    });
    const body = (await res.json()) as {
      session: { sessionId: string; userId: string; authLevel: number; population: string };
      membership: { kind: string; role: string; status: string };
      workspace: { id: string; slug: string; name: string };
      isNewUser: boolean;
    };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.workspace).toMatchObject({ slug: "acme-inc", name: "Acme Inc." });
    expect(body.membership).toMatchObject({ kind: "staff", role: "owner", status: "active" });
    expect(body.session).toMatchObject({ authLevel: 1, population: "staff" });
    expect(body.isNewUser).toBe(true);
    workspaceId = body.workspace.id;
    cookie = cookiesOf(res);
    expect(cookie).toContain("__Host-sid=");

    const me = await request("/api/v1/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      membership: { role: "owner" },
      workspaces: [{ workspaceId, role: "owner" }],
    });

    expect((await pageConfig("/")).setupRequired).toBe(false);
    expect((await pageConfig("/")).workspace).toEqual({ slug: "acme-inc", name: "Acme Inc." });
    // E2.10 ZAP-04: after setup a stranger learns that setup is done, and nothing else.
    const anonymous = await request("/api/v1/setup/status");
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ required: false });
    const status = (await (await request("/api/v1/setup/status", { cookie })).json()) as {
      required: boolean;
      tokenSource?: string;
    };
    expect(status).toMatchObject({
      required: false,
      tenancy: "single",
      baseUrl: `${BASE}/`,
      passwordEnabled: false,
      drivers: { storage: "fs", mail: "memory" },
      probes: { mail: "pending", storage: "pending" },
    });
    expect(status.tokenSource).toBeUndefined();
    // The wizard resumes off `progress`: the owner is done, nothing after it is.
    expect(await progressOf(cookie)).toEqual({
      owner: true,
      mail: false,
      storage: false,
      branding: false,
      offering: false,
    });

    const again = await request("/api/v1/setup/owner", {
      method: "POST",
      body: JSON.stringify({
        token: TOKEN,
        email: "someone@else.test",
        displayName: "X",
        workspaceName: "Other",
      }),
    });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("conflict");
    expect(running.container.setupToken.verify(TOKEN)).toBe(false);
  });

  it("lets the owner run the probes on the setup session and primes readiness", async () => {
    mailer.clear();
    const mail = await request("/api/v1/setup/probes/mail", {
      method: "POST",
      cookie,
      body: JSON.stringify({}),
    });
    expect(mail.status).toBe(200);
    expect(await mail.json()).toMatchObject({ ok: true, driver: "memory" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("sam@acme.test");
    expect(mailer.sent[0]?.subject).toContain("test email");
    expect(mailer.sent[0]?.html).toContain("Outbound mail works");

    const storage = await request("/api/v1/setup/probes/storage", { method: "POST", cookie });
    expect(storage.status).toBe(200);
    expect(await storage.json()).toMatchObject({ ok: true, driver: "fs" });
    expect(existsSync(join(dataDir, "storage"))).toBe(true);

    const status = await request("/api/v1/setup/status", { cookie });
    expect(await status.json()).toMatchObject({ probes: { mail: "passed", storage: "passed" } });
    expect(await progressOf(cookie)).toMatchObject({ owner: true, mail: true, storage: true });
    expect(running.readiness.passed("mail")).toBe(true);
    expect((await request("/readyz")).status).toBe(200);
  });

  it("seeded the legal defaults in the same request that created the workspace", async () => {
    // ADR-0037 deferred `seedDefaults` to E1.7; without it E1.6's acceptance gate would point
    // at a workspace with no documents at all.
    const docs = await rows<{ slug: string; kind: string; title: string }>(
      workspaceId,
      "select slug, kind, title from core.legal_document order by slug",
    );
    expect(docs.map((d) => d.slug)).toEqual(["offering-legends", "privacy-notice"]);
    expect(docs.map((d) => d.kind)).toEqual(["disclaimer", "privacy_notice"]);
    // Every seeded document has a published version, not just a row.
    const versions = await rows<{ n: string }>(
      workspaceId,
      "select count(*) as n from core.legal_document_version",
    );
    expect(Number(versions[0]?.n)).toBe(2);
    // The workspace name was the template context, so the notice names the tenant.
    const body = await rows<{ body: string }>(
      workspaceId,
      "select v.body from core.legal_document_version v join core.legal_document d on d.id = v.document_id where d.slug = 'privacy-notice'",
    );
    expect(body[0]?.body).toContain("Acme Inc.");

    const settings = await rows<{ settings: { legal?: { defaultDisclaimerSlug?: string } } }>(
      workspaceId,
      "select settings from core.workspace",
    );
    expect(settings[0]?.settings.legal?.defaultDisclaimerSlug).toBe("offering-legends");
  });

  it("accepts a second-factor enrolment on the fresh session", async () => {
    const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
    expect(enrol.status).toBe(200);
    expect(await enrol.json()).toMatchObject({ otpauthUri: expect.stringContaining("otpauth://") });
  });

  it("opens the rest of the wizard once the owner has a second factor, and progress follows", async () => {
    const before = await request("/api/v1/branding", { cookie });
    expect(before.status).toBe(403);
    expect(await errorCode(before)).toBe("step_up_required");

    cookie = await stepUpToMfa(cookie);

    const brand = await request("/api/v1/branding", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ accentColor: "#1d4ed8" }),
    });
    expect(brand.status, await brand.text()).toBe(200);
    expect(await progressOf(cookie)).toMatchObject({ branding: true, offering: false });

    // Reading the offering opens the first period, which is the fact `progress.offering` is.
    const offering = await request("/api/v1/compliance/offering", { cookie });
    expect(offering.status).toBe(200);
    expect(await progressOf(cookie)).toEqual({
      owner: true,
      mail: true,
      storage: true,
      branding: true,
      offering: true,
    });

    // And the legal documents the wizard seeded are the ones the admin screens now list.
    const docs = await request("/api/v1/compliance/documents", { cookie });
    expect(docs.status).toBe(200);
    const listed = (await docs.json()) as { documents: { slug: string }[] };
    expect(listed.documents.map((d) => d.slug).sort()).toEqual([
      "offering-legends",
      "privacy-notice",
    ]);
  });

  /*
   * `progress.branding` has to be exactly as wide as the step it gates. The wizard's company
   * step saves a display name and a tagline on their own — it sends `accentColor: null` when
   * the colour field is left blank — so a brand told only by name has to read as done, or
   * `resumeStep()` sends that founder back to `company` on every cold load.
   */
  it("counts a name-only or tagline-only brand as done, and an untouched one as not", async () => {
    const clear = await request("/api/v1/branding", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ displayName: null, tagline: null, accentColor: null }),
    });
    expect(clear.status, await clear.text()).toBe(200);
    // Nothing the founder can choose is set; the defaulted font, radius and attribution line
    // are true of a workspace nobody has opened and must not count as a brand.
    expect(await progressOf(cookie)).toMatchObject({ branding: false });

    const named = await request("/api/v1/branding", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ displayName: "Acme Portal", accentColor: null }),
    });
    expect(named.status, await named.text()).toBe(200);
    expect(await progressOf(cookie)).toMatchObject({ branding: true });

    const tagline = await request("/api/v1/branding", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ displayName: null, tagline: "Seed-stage investor relations" }),
    });
    expect(tagline.status, await tagline.text()).toBe(200);
    expect(await progressOf(cookie)).toMatchObject({ branding: true });

    // Back to the colour the story above set, so nothing after this reads a half-cleared brand.
    const accent = await request("/api/v1/branding", {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ tagline: null, accentColor: "#1d4ed8" }),
    });
    expect(accent.status, await accent.text()).toBe(200);
    expect(await progressOf(cookie)).toMatchObject({ branding: true });
  });

  it("forbids probes for an investor session", async () => {
    await running.container.auth.invites.create({
      workspaceId,
      email: "ada@investor.test",
      kind: "external",
      role: "investor",
      send: false,
    });
    mailer.clear();
    const since = mailer.sent.length;
    const start = await request("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test" }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, "ada@investor.test", since);
    const verify = await request("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test", code }),
    });
    expect(verify.status).toBe(200);
    const probe = await request("/api/v1/setup/probes/storage", {
      method: "POST",
      cookie: cookiesOf(verify),
    });
    expect(probe.status).toBe(403);
    // Nor does an investor's session see the deployment details (E2.10 ZAP-04).
    const status = await request("/api/v1/setup/status", { cookie: cookiesOf(verify) });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ required: false });
  });

  it("keeps the mail probe from being a relay: recipient, auth level and rate (F-28)", async () => {
    const otpSession = async (email: string): Promise<string> => {
      mailer.clear();
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
      return cookiesOf(verify);
    };
    const probe = (who: string, to?: string) =>
      request("/api/v1/setup/probes/mail", {
        method: "POST",
        cookie: who,
        body: JSON.stringify(to === undefined ? {} : { to }),
      });

    // `cookie` is the founder's level-2 session (TOTP, above). Arbitrary addresses: refused.
    mailer.clear();
    const stranger = await probe(cookie, "victim@elsewhere.test");
    expect(stranger.status).toBe(400);
    expect(await errorCode(stranger)).toBe("invalid_request");
    expect(mailer.sent).toHaveLength(0);

    // A verified address of this workspace's staff: allowed.
    await running.container.auth.invites.create({
      workspaceId,
      email: "colleague@acme.test",
      kind: "staff",
      role: "editor",
      send: false,
    });
    await otpSession("colleague@acme.test"); // verifies the address
    mailer.clear();
    const colleague = await probe(cookie, "colleague@acme.test");
    expect(colleague.status, await colleague.clone().text()).toBe(200);
    expect(mailer.sent.at(-1)?.to).toBe("colleague@acme.test");

    // The founder now has a second factor: an email-code session (level 1) is not enough.
    const weak = await otpSession("sam@acme.test");
    const levelOne = await probe(weak);
    expect(levelOne.status).toBe(403);
    expect(await errorCode(levelOne)).toBe("step_up_required");

    // Five per user per hour: one ran on the setup session, one just now.
    for (let i = 0; i < 3; i++) expect((await probe(cookie)).status).toBe(200);
    const limited = await probe(cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
  });

  it("refuses seed-demo next to a real single-tenant workspace", async () => {
    await expect(seedDemo(running.container)).rejects.toThrow(/TENANCY_MODE=single/u);
  });

  it("will not delete the only workspace, and a deleted one in its restore window keeps setup closed", async () => {
    // The owner stepped up to MFA above; DELETE /workspace is owner + step-up + typed slug.
    const res = await request("/api/v1/workspace", {
      method: "DELETE",
      cookie,
      body: JSON.stringify({ confirm: "acme-inc" }),
    });
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "conflict", reason: "last_workspace" },
    });
    const host = <T>(q: string) =>
      running.container.db.withHost(async (tx) => (await tx.execute(q)).rows as T[]);
    const [live] = await host<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM core.workspace WHERE id = '${workspaceId}'::uuid`,
    );
    expect(live?.deleted).toBe(false);

    // A workspace deleted some other way, still inside its 30-day restore window, must never
    // let the setup token mint a new owner next to it.
    await host(
      `UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days'
         WHERE id = '${workspaceId}'::uuid RETURNING id`,
    );
    try {
      running.container.setupGate.invalidate();
      expect(await running.container.setupGate.required()).toBe(false);
      const status = (await (await request("/api/v1/setup/status")).json()) as {
        required: boolean;
      };
      expect(status.required).toBe(false);
      const owner = await request("/api/v1/setup/owner", {
        method: "POST",
        body: JSON.stringify({
          token: TOKEN,
          email: "mallory@evil.test",
          displayName: "M",
          workspaceName: "Takeover",
        }),
      });
      expect(owner.status).toBe(409);
    } finally {
      await host(
        `UPDATE core.workspace SET deleted_at = NULL, purge_after = NULL
           WHERE id = '${workspaceId}'::uuid RETURNING id`,
      );
      running.container.setupGate.invalidate();
    }
  });
});
