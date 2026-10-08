import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { PSEUDO_CLOSE, PSEUDO_OPEN } from "@fundroom/i18n";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitMail } from "./test/sign-in-mail.js";

/*
 * Language choice end to end (E2.8, "i18n coverage of investor UI"): the user's own language
 * (`PUT /me/locale`, global like the user), the workspace default (`PUT /workspace/locale`,
 * `access.settings`, audited, resolver invalidated), both surfacing where the SPA reads them
 * (`GET /me` session, bootstrap), and the one rule that makes them matter off-screen: an email
 * goes out in `user.locale ?? workspace.default_locale ?? "en"`.
 *
 * The pseudo-locale `en-XA` is the only second locale today, so it is what the mail assertions
 * look for (its brackets). It is accepted only with `I18N_PSEUDO_LOCALE=true`; a second server
 * on the same database runs with the flag off to prove the refusal.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let plain: RunningServer;
let mailer: MemoryMailer;
let acmeId = "";

interface Actor {
  cookie: string;
  email: string;
}
let owner: Actor;
let ada: Actor;

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string } = {},
  server: RunningServer = running,
) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return server.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
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

function codeFrom(text: string): string {
  const m = /^\s{4}(\d{6})$/mu.exec(text);
  if (!m?.[1]) throw new Error(`no code in mail:\n${text}`);
  return m[1];
}

/** Requests a sign-in code and returns the email it produced. */
async function otpMail(email: string) {
  mailer.clear();
  const since = mailer.sent.length;
  const start = await request("acme", "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const mail = await awaitMail(mailer, {
    to: email,
    since,
    match: (m) => /^\s{4}\d{6}$/mu.test(m.text),
  });
  return mail;
}

async function signIn(email: string): Promise<Actor> {
  const mail = await otpMail(email);
  const verify = await request("acme", "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code: codeFrom(mail.text) }),
  });
  expect(verify.status).toBe(200);
  return { cookie: cookiesOf(verify), email };
}

async function stepUpToMfa(cookie: string): Promise<string> {
  const enrol = await request("acme", "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("acme", "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  email: string,
  kind: "staff" | "external",
  role: "owner" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind,
    role,
    source: "test",
  });
  const actor = await signIn(email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(actor.cookie);
  return actor;
}

async function auditActions(): Promise<{ action: string; diff: unknown }[]> {
  return running.container.db.withTenant(systemContext(acmeId), async (tx) => {
    const r = await tx.execute(
      `SELECT action, diff FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
       AND action = 'workspace.locale_changed' ORDER BY seq`,
    );
    return r.rows as { action: string; diff: unknown }[];
  });
}

const putMe = (actor: Actor | undefined, locale: unknown, server?: RunningServer) =>
  request(
    "acme",
    "/api/v1/me/locale",
    { method: "PUT", body: JSON.stringify({ locale }), ...(actor ? { cookie: actor.cookie } : {}) },
    server,
  );

const putWorkspace = (actor: Actor, defaultLocale: unknown, server?: RunningServer) =>
  request(
    "acme",
    "/api/v1/workspace/locale",
    { method: "PUT", cookie: actor.cookie, body: JSON.stringify({ defaultLocale }) },
    server,
  );

const isPseudo = (s: string) => s.startsWith(PSEUDO_OPEN) && s.includes(PSEUDO_CLOSE);

function configFor(pseudo: boolean, storage: string) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: secret,
      STORAGE_FS_PATH: storage,
      TENANCY_MODE: "multi",
      ROLES: "api",
      I18N_PSEUDO_LOCALE: pseudo ? "true" : "false",
    },
  });
}
const secret = randomBytes(32).toString("base64");

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const storage = mkdtempSync(join(tmpdir(), "fundroom-storage-"));
  running = await startServer({
    config: configFor(true, storage),
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  plain = await startServer({
    config: configFor(false, storage),
    logger: createLogger({ level: "warn" }),
    mailer: createMemoryMailer(),
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("owner@example.com", "staff", "owner");
  ada = await member("ada@investor.test", "external", "investor");
}, 240_000);

afterAll(async () => {
  await plain?.stop();
  await running?.stop();
  await pg?.stop();
});

describe("bootstrap", () => {
  it("exposes the pseudo-locale flag and the workspace default", async () => {
    const boot = await json<{ pseudoLocale: boolean; workspace: { defaultLocale: string } }>(
      await request("acme", "/api/v1/modules"),
    );
    expect(boot.pseudoLocale).toBe(true);
    expect(boot.workspace.defaultLocale).toBe("en");
    const off = await json<{ pseudoLocale: boolean }>(
      await request("acme", "/api/v1/modules", {}, plain),
    );
    expect(off.pseudoLocale).toBe(false);
  });

  it("carries the user's choice on the session, null until chosen", async () => {
    const me = await json<{ session: { user: { locale: string | null } } }>(
      await request("acme", "/api/v1/me", { cookie: ada.cookie }),
    );
    expect(me.session.user.locale).toBeNull();
  });
});

describe("PUT /me/locale", () => {
  it("needs a session", async () => {
    expect((await putMe(undefined, "en")).status).toBe(401);
  });

  it("rejects locales the product does not ship", async () => {
    for (const bad of ["fr", "EN", "", 3]) expect((await putMe(ada, bad)).status).toBe(400);
  });

  it("refuses the pseudo-locale where the operator has not enabled it", async () => {
    const res = await putMe(ada, "en-XA", plain);
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; details?: { reason?: string } } }>(res);
    expect(body.error.code).toBe("validation_failed");
    // …and a real locale still works there.
    expect((await putMe(ada, "en", plain)).status).toBe(200);
  });

  it("saves, reads back on /me, and clears with null", async () => {
    const res = await putMe(ada, "en-XA");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ locale: "en-XA" });
    const me = await json<{ session: { user: { locale: string | null } } }>(
      await request("acme", "/api/v1/me", { cookie: ada.cookie }),
    );
    expect(me.session.user.locale).toBe("en-XA");
    const cleared = await putMe(ada, null);
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toEqual({ locale: null });
    const after = await json<{ session: { user: { locale: string | null } } }>(
      await request("acme", "/api/v1/me", { cookie: ada.cookie }),
    );
    expect(after.session.user.locale).toBeNull();
  });
});

describe("PUT /workspace/locale", () => {
  it("is an access.settings route: an investor gets the 404 an unknown URL gives", async () => {
    expect((await putWorkspace(ada, "en")).status).toBe(404);
  });

  it("validates and refuses the pseudo-locale when it is off", async () => {
    expect((await putWorkspace(owner, "de")).status).toBe(400);
    expect((await putWorkspace(owner, null)).status).toBe(400);
    expect((await putWorkspace(owner, "en-XA", plain)).status).toBe(400);
  });

  it("saves, audits once per real change, and the bootstrap sees it at once", async () => {
    const res = await putWorkspace(owner, "en-XA");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ defaultLocale: "en-XA" });
    // The resolver cache was invalidated: the very next bootstrap reports it.
    const boot = await json<{ workspace: { defaultLocale: string } }>(
      await request("acme", "/api/v1/modules"),
    );
    expect(boot.workspace.defaultLocale).toBe("en-XA");
    // Setting it again is not a change.
    expect((await putWorkspace(owner, "en-XA")).status).toBe(200);
    const audit = await auditActions();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.diff).toEqual({
      before: { defaultLocale: "en" },
      after: { defaultLocale: "en-XA" },
    });
  });
});

describe("email language: user.locale ?? workspace.default_locale ?? en", () => {
  it("uses the workspace default for somebody who has not chosen", async () => {
    // The workspace default is en-XA from the previous block; ada cleared her own choice.
    const mail = await otpMail(ada.email);
    expect(isPseudo(mail.subject)).toBe(true);
    expect(mail.text.split("\n")[0]).toMatch(new RegExp(`^${PSEUDO_OPEN}`, "u"));
    // The code line is untouched, so the code is still machine-readable.
    expect(codeFrom(mail.text)).toMatch(/^\d{6}$/u);
    expect(mail.html).toContain('lang="en-XA"');
    expect(mail.template?.props).toMatchObject({ locale: "en-XA" });
  });

  it("lets the user's own choice beat the workspace default", async () => {
    expect((await putMe(ada, "en")).status).toBe(200);
    const mail = await otpMail(ada.email);
    expect(mail.subject).toMatch(/^\d{6} is your Acme \(.+\) sign-in code$/u);
    expect(mail.text).toContain("It expires in");
    expect(mail.html).toContain('lang="en"');
  });

  it("falls back to en once the workspace default is en again", async () => {
    expect((await putMe(ada, null)).status).toBe(200);
    expect((await putWorkspace(owner, "en")).status).toBe(200);
    const mail = await otpMail(ada.email);
    expect(isPseudo(mail.subject)).toBe(false);
    expect(mail.subject).toContain("is your Acme");
    expect(await auditActions()).toHaveLength(2);
  });

  it("uses the workspace default for an address with no account", async () => {
    expect((await putWorkspace(owner, "en-XA")).status).toBe(200);
    // An eligible address is needed for a mail to be sent at all: invite somebody new.
    mailer.clear();
    const invite = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ invites: [{ email: "newcomer@investor.test" }] }),
    });
    expect(invite.status).toBe(200);
    const mail = mailer.sent.find((m) => m.to === "newcomer@investor.test");
    expect(mail).toBeDefined();
    expect(isPseudo(mail?.subject ?? "")).toBe(true);
    expect((await putWorkspace(owner, "en")).status).toBe(200);
  });
});
