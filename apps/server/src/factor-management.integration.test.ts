import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { sessionSetCookie, withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E2.10 fix package I, through the real HTTP surface:
 *
 *  - P2-01: a level-1 session (an email code: "controls the mailbox") could remove an owner's
 *    authenticator and enrol its own, then step itself up to level 2. Mirrors the pen test's
 *    `02-mfa-bypass.mjs`. Once a user holds a second factor, managing factors needs level 2;
 *    every factor change mails the account and ends the other sessions.
 *  - F-12: step-up rotates the session token and re-issues the cookie.
 *  - F-26: ending *other* sessions needs a fresh proof.
 *  - P2-02: `/auth/otp/verify` answers identically for known and unknown addresses.
 *  - E-UP-18 (D2): registering a user-verified passkey steps the session up to level 2, as
 *    confirming TOTP enrolment does; a non-UV key registers without changing the level.
 */
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
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

const post = (path: string, cookie: string, body: unknown = {}) =>
  request(path, { method: "POST", cookie, body: JSON.stringify(body) });
const del = (path: string, cookie: string) => request(path, { method: "DELETE", cookie });

/** An email-code sign-in: a level-1 session, fresh. All an attacker with the mailbox gets. */
async function signIn(email: string): Promise<string> {
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
  return withSetCookies("", verify);
}

async function level(cookie: string): Promise<number | undefined> {
  const me = await request("/api/v1/me", { cookie });
  if (me.status !== 200) return undefined;
  return ((await me.json()) as { session: { authLevel: number } }).session.authLevel;
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

async function staff(email: string, role: "owner" | "admin" | "editor"): Promise<string> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId,
    kind: "staff",
    role,
    source: "test",
  });
  return userId;
}

/** Enrols TOTP from a level-1 session (onboarding) and returns the stepped-up cookie. */
async function enrolTotp(cookie: string): Promise<{ cookie: string; totp: OTPAuth.TOTP }> {
  const enrol = await post("/api/v1/auth/totp/enrol", cookie);
  expect(enrol.status).toBe(200);
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await post("/api/v1/auth/totp/enrol/confirm", cookie, { code: totp.generate() });
  expect(confirm.status).toBe(200);
  return { cookie: withSetCookies(cookie, confirm), totp };
}

/** Ages every live session of the user past the ten-minute step-up window. */
async function stale(userId: string): Promise<void> {
  await pg.pool.query(
    "UPDATE core.session SET auth_time = now() - interval '30 minutes' WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}

beforeAll(async () => {
  pg = await startPostgres();
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: `http://${CANON}`,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      AUTH_PASSWORD_ENABLED: "true",
      AUTH_HIBP_CHECK: "false",
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
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("mailbox → second factor takeover (P2-01)", () => {
  it("a level-1 session cannot remove or replace an enrolled owner's factors", async () => {
    await staff("owner@acme.test", "owner");
    // The rightful owner, signed in and enrolled: a level-2 session.
    const owner = await enrolTotp(await signIn("owner@acme.test"));
    expect(await level(owner.cookie)).toBe(2);

    // The attacker reads the owner's mailbox and signs in with an email code.
    const atk = await signIn("owner@acme.test");
    expect(await level(atk)).toBe(1);
    const invites = await request("/api/v1/access/invites", { cookie: atk });
    expect(invites.status).toBe(403);
    expect(await errorOf(invites)).toMatchObject({ code: "step_up_required" });

    // The pen test's chain, step by step: every factor-management route now asks for level 2.
    for (const [method, path] of [
      ["DELETE", "/api/v1/auth/totp"],
      ["POST", "/api/v1/auth/totp/enrol"],
      ["POST", "/api/v1/auth/totp/recovery-codes"],
      ["POST", "/api/v1/auth/passkeys/register/begin"],
      ["DELETE", "/api/v1/auth/passkeys/01920000-0000-7000-8000-000000000001"],
      ["PUT", "/api/v1/auth/password"],
      ["DELETE", "/api/v1/auth/password"],
    ] as const) {
      const res = await request(path, {
        method,
        cookie: atk,
        ...(method === "PUT" ? { body: JSON.stringify({ password: "x".repeat(16) }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorOf(res), `${method} ${path}`).toMatchObject({
        code: "step_up_required",
        reason: "level",
        requiredLevel: 2,
      });
    }
    expect(await level(atk)).toBe(1);
    const status = await request("/api/v1/auth/totp", { cookie: owner.cookie });
    expect(await status.json()).toMatchObject({ enrolled: true });
    expect(await level(owner.cookie)).toBe(2); // the owner's session is untouched
  });

  it("after a proof with the existing factor, the change goes through, mails the account and ends the other sessions", async () => {
    const userId = await staff("admin@acme.test", "admin");
    const first = await enrolTotp(await signIn("admin@acme.test"));
    const second = await signIn("admin@acme.test");
    expect(await level(second)).toBe(1);

    // Step up the second session with the existing authenticator (the next time step, so the
    // replay guard does not refuse the enrolment's code), then disable it from there.
    const verify = await post("/api/v1/auth/totp/verify", second, {
      code: first.totp.generate({ timestamp: Date.now() + 30_000 }),
    });
    expect(verify.status).toBe(200);
    const stepped = withSetCookies(second, verify);
    const mailsBefore = mailer.sent.length;
    const off = await del("/api/v1/auth/totp", stepped);
    expect(off.status).toBe(200);

    expect(await level(stepped)).toBe(2); // the session that made the change stays
    expect(await level(first.cookie)).toBeUndefined(); // every other one is signed out
    const notice = mailer.sent.slice(mailsBefore).find((m) => m.to === "admin@acme.test");
    expect(notice?.subject).toContain("Security notice");
    expect(notice?.text).toContain("The authenticator app was removed");
    expect(notice?.text).toContain("1 other session was signed out");

    const audit = await pg.pool.query<{ action: string }>(
      "SELECT action FROM audit.event WHERE actor_user_id = $1 AND action IN ('auth.mfa_disabled', 'auth.sessions_revoked_all') ORDER BY seq",
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "auth.mfa_disabled",
      "auth.sessions_revoked_all",
    ]);

    // With no second factor left, enrolling a first one from level 1 is onboarding again.
    const third = await signIn("admin@acme.test");
    const again = await post("/api/v1/auth/totp/enrol", third);
    expect(again.status).toBe(200);
  });
});

describe("password removal needs the current password (E2.10 R1-01)", () => {
  it("an email-code session cannot DELETE-then-PUT its way past F-20", async () => {
    await staff("pw-victim@acme.test", "editor");
    const owner = await signIn("pw-victim@acme.test");
    const put = (cookie: string, body: unknown) =>
      request("/api/v1/auth/password", { method: "PUT", cookie, body: JSON.stringify(body) });
    expect((await put(owner, { password: "the victim's password" })).status).toBe(200);

    // The mailbox thief: a fresh level-1 session, and the user has no second factor.
    const atk = await signIn("pw-victim@acme.test");
    const bare = await del("/api/v1/auth/password", atk);
    expect(bare.status).toBe(400);
    expect(await errorOf(bare)).toMatchObject({
      code: "invalid_request",
      field: "currentPassword",
    });
    const guess = await request("/api/v1/auth/password", {
      method: "DELETE",
      cookie: atk,
      body: JSON.stringify({ currentPassword: "a guess at it" }),
    });
    expect(guess.status).toBe(401);
    // Still set, so the PUT still asks for it.
    expect((await put(atk, { password: "the attacker's password" })).status).toBe(400);
    expect(await (await request("/api/v1/auth/password", { cookie: atk })).json()).toMatchObject({
      set: true,
    });

    // Whoever knows it can remove it; with none left, DELETE is a no-op.
    const ok = await request("/api/v1/auth/password", {
      method: "DELETE",
      cookie: owner,
      body: JSON.stringify({ currentPassword: "the victim's password" }),
    });
    expect(ok.status).toBe(200);
    expect((await del("/api/v1/auth/password", owner)).status).toBe(200);
  });
});

describe("step-up rotates the session token (F-12)", () => {
  it("re-issues the session cookie and kills the old value", async () => {
    await staff("editor@acme.test", "editor");
    const before = await signIn("editor@acme.test");
    const enrol = await post("/api/v1/auth/totp/enrol", before);
    const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await post("/api/v1/auth/totp/enrol/confirm", before, {
      code: totp.generate(),
    });
    expect(confirm.status).toBe(200);
    const set = sessionSetCookie(confirm);
    expect(set).toMatch(/^__Host-sid=[A-Za-z0-9_-]{32,};/u);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    const after = withSetCookies(before, confirm);
    expect(after).not.toBe(before);
    expect(await level(before)).toBeUndefined(); // the pre-step-up value is dead …
    expect(await level(after)).toBe(2); // … and the same session lives on under the new one

    const sessions = await request("/api/v1/me/sessions", { cookie: after });
    const list = ((await sessions.json()) as { sessions: { current: boolean }[] }).sessions;
    expect(list.filter((s) => s.current)).toHaveLength(1);

    // A plain step-up (TOTP verify) rotates again.
    const verify = await post("/api/v1/auth/totp/verify", after, {
      code: totp.generate({ timestamp: Date.now() + 30_000 }),
    });
    expect(verify.status).toBe(200);
    expect(sessionSetCookie(verify)).toBeDefined();
    expect(await level(after)).toBeUndefined();
    expect(await level(withSetCookies(after, verify))).toBe(2);
  });
});

describe("ending other sessions needs a fresh proof (F-26)", () => {
  it("refuses a stale session, but signing yourself out never asks", async () => {
    const userId = await staff("f26@acme.test", "editor");
    const a = await signIn("f26@acme.test");
    const b = await signIn("f26@acme.test");
    const list = await request("/api/v1/me/sessions", { cookie: a });
    const sessions = ((await list.json()) as { sessions: { id: string; current: boolean }[] })
      .sessions;
    const mine = sessions.find((s) => s.current)?.id as string;
    const theirs = sessions.find((s) => !s.current)?.id as string;
    await stale(userId);

    const other = await del(`/api/v1/me/sessions/${theirs}`, a);
    expect(other.status).toBe(403);
    expect(await errorOf(other)).toMatchObject({ code: "step_up_required", reason: "fresh" });
    const everywhere = await post("/api/v1/auth/logout-everywhere", a);
    expect(everywhere.status).toBe(403);
    expect(await level(b)).toBe(1); // nothing was ended

    const self = await del(`/api/v1/me/sessions/${mine}`, a);
    expect(self.status).toBe(200);
    expect(await level(a)).toBeUndefined();
  });
});

describe("OTP verify does not tell known from unknown addresses (P2-02)", () => {
  it("gives the same answers, attempt by attempt", async () => {
    await running.container.auth.invites.create({
      workspaceId: acmeId,
      email: "investor@fund.test",
      kind: "external",
      role: "investor",
      send: false,
    });
    const trail = async (email: string) => {
      const start = await request("/api/v1/auth/otp/start", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      expect(start.status).toBe(200);
      const out: unknown[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await request("/api/v1/auth/otp/verify", {
          method: "POST",
          body: JSON.stringify({ email, code: "000000" }),
        });
        const { requestId: _, message: __, ...error } = await errorOf(res);
        out.push({ status: res.status, error });
      }
      return out;
    };
    const known = await trail("investor@fund.test");
    const unknown = await trail("nobody-here@fund.test");
    expect(unknown).toEqual(known);
    expect(known[0]).toMatchObject({
      status: 400,
      error: { code: "invalid_code", attemptsLeft: 4 },
    });
  });
});

/*
 * A software authenticator for the REAL @simplewebauthn verification the server runs: a P-256 key,
 * `none` attestation, and the authenticator data flags under test. Just enough CBOR to encode the
 * attestation object and the COSE key (unsigned/negative ints, byte and text strings, maps).
 */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value] : Object.entries(value as object);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}

const RP_ORIGIN = `http://${CANON}`;

/** A `navigator.credentials.create()` result for `challenge`, user-verified or not. */
function softwareAttestation(challenge: string, userVerified: boolean) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const credId = randomBytes(16);
  const counter = Buffer.alloc(4);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(credId.length);
  // UP | AT, plus UV when the authenticator verified the user.
  const flags = 0x01 | 0x40 | (userVerified ? 0x04 : 0);
  const authData = Buffer.concat([
    createHash("sha256").update(CANON).digest(),
    Buffer.from([flags]),
    counter,
    Buffer.alloc(16), // AAGUID
    idLen,
    credId,
    cose,
  ]);
  const id = credId.toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin: RP_ORIGIN,
          crossOrigin: false,
        }),
      ).toString("base64url"),
      attestationObject: cbor({ fmt: "none", attStmt: {}, authData }).toString("base64url"),
      transports: ["internal"],
    },
  };
}

async function registerPasskey(cookie: string, userVerified: boolean): Promise<Response> {
  const begin = await post("/api/v1/auth/passkeys/register/begin", cookie);
  expect(begin.status).toBe(200);
  const { challengeId, options } = (await begin.json()) as {
    challengeId: string;
    options: { challenge: string };
  };
  return await post("/api/v1/auth/passkeys/register/finish", cookie, {
    challengeId,
    response: softwareAttestation(options.challenge, userVerified),
    label: userVerified ? "Touch ID" : "Old key",
  });
}

async function stepUpAudit(userId: string) {
  const rows = await pg.pool.query<{ meta: Record<string, unknown> }>(
    "SELECT meta FROM audit.event WHERE actor_user_id = $1 AND action = 'auth.step_up' ORDER BY seq",
    [userId],
  );
  return rows.rows.map((r) => r.meta);
}

describe("passkey registration and the session level (E-UP-18 D2)", () => {
  it("a user-verified passkey steps the session up to level 2 and rotates its token", async () => {
    const userId = await staff("uv@acme.test", "editor");
    const before = await signIn("uv@acme.test");
    expect(await level(before)).toBe(1);

    const res = await registerPasskey(before, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ label: "Touch ID", authLevel: 2, transports: ["internal"] });
    expect(body).not.toHaveProperty("userVerified");

    expect(sessionSetCookie(res)).toMatch(/^__Host-sid=[A-Za-z0-9_-]{32,};/u);
    const after = withSetCookies(before, res);
    expect(after).not.toBe(before);
    expect(await level(before)).toBeUndefined(); // the pre-step-up value is dead …
    expect(await level(after)).toBe(2); // … the same session lives on, at level 2

    expect(await stepUpAudit(userId)).toEqual([
      { method: "passkey_registration", proofLevel: 2, fromLevel: 1, toLevel: 2 },
    ]);
  });

  it("a passkey without user verification registers but leaves the level alone", async () => {
    const userId = await staff("nouv@acme.test", "editor");
    const cookie = await signIn("nouv@acme.test");

    const res = await registerPasskey(cookie, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ label: "Old key", authLevel: 1 });
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await level(cookie)).toBe(1); // same cookie, same level
    expect(await stepUpAudit(userId)).toEqual([]);
    const list = await request("/api/v1/auth/passkeys", { cookie });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { passkeys: unknown[] }).passkeys).toHaveLength(1);
  });
});
