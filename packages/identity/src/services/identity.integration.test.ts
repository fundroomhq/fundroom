import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createAuditService, verifyWorkspace } from "@fundroom/audit";
import { parseKeyRing } from "@fundroom/config";
import {
  createDatabase,
  createWorkspace,
  type Database,
  PLATFORM_WORKSPACE_ID,
  systemContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { MailerPort, OutboundEmail } from "@fundroom/ports";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCode } from "../crypto/keys.js";
import { base32Decode, normalizeCode } from "../crypto/tokens.js";
import { isAuthError } from "../errors.js";
import { GroupRepo, MembershipRepo } from "../repos/membership-repo.js";
import { type AuthService, createAuthService } from "./auth-service.js";
import { CHALLENGE_RETENTION_MS, runIdentitySweep } from "./jobs.js";
import type { PasskeyWebauthn } from "./passkeys.js";
import { createMemoryRateLimiter, createPostgresRateLimiter } from "./rate-limiter.js";
import type { ShareLinkAccess } from "./share-link-access.js";
import type { IdentityDeps } from "./types.js";

/*
 * End-to-end kernel flows against real Postgres (RLS on, role switch on): OTP, magic link,
 * sessions/devices, TOTP + recovery codes, password + HIBP, passkeys (fake authenticator),
 * OIDC (fake IdP), invites/revocation, the Postgres rate limiter, and the global-table fences.
 */
let pg: TestPostgres;
let db: Database;
let auth: AuthService;
let clock = new Date("2026-09-10T12:00:00Z");
const sent: OutboundEmail[] = [];
let mailerFails = false;
/** Delay before a send settles (R1-03: a slow relay must not show in the start's timing). */
let mailerDelayMs = 0;
let idp: FakeIdp;
let shareLinksStub: ShareLinkAccess | undefined;
const ORIGIN = "https://investors.acme.test";
const RP_ID = "investors.acme.test";

const keyRing = (() => {
  const r = parseKeyRing(`v1:${randomBytes(32).toString("base64")}`);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
})();

function tick(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function lastMail(): OutboundEmail {
  const m = sent.at(-1);
  if (!m) throw new Error("no mail sent");
  return m;
}

function codeFrom(mail: OutboundEmail): string {
  const m = /^\s{4}(\d{6})$/mu.exec(mail.text);
  if (!m?.[1]) throw new Error(`no code in mail:\n${mail.text}`);
  return m[1];
}

function linkTokenFrom(mail: OutboundEmail): string {
  const m = /token=([A-Za-z0-9_-]+)/u.exec(mail.text);
  if (!m?.[1]) throw new Error("no link in mail");
  return m[1];
}

async function expectAuthError<T>(p: Promise<T>, code: string): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (error) {
    if (isAuthError(error)) {
      expect(error.code).toBe(code);
      return error.details;
    }
    throw error;
  }
  throw new Error(`expected AuthError ${code}`);
}

// --- fake WebAuthn authenticator ------------------------------------------------------------

function fakeWebauthn(): PasskeyWebauthn {
  const publicKey = randomBytes(65);
  const decodeChallenge = (clientDataJSON: string) =>
    (JSON.parse(Buffer.from(clientDataJSON, "base64url").toString()) as { challenge: string })
      .challenge;
  return {
    generateRegistrationOptions,
    generateAuthenticationOptions,
    verifyRegistrationResponse: (async (opts: {
      response: { id: string; response: { clientDataJSON: string } };
      expectedChallenge: (c: string) => boolean | Promise<boolean>;
      expectedRPID?: string | string[];
    }) => {
      const ok = await opts.expectedChallenge(
        decodeChallenge(opts.response.response.clientDataJSON),
      );
      if (!ok) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          fmt: "none",
          aaguid: "00000000-0000-0000-0000-000000000000",
          credential: { id: opts.response.id, publicKey, counter: 0, transports: ["internal"] },
          credentialType: "public-key",
          attestationObject: new Uint8Array(),
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: ORIGIN,
          rpID: RP_ID,
        },
      };
    }) as unknown as PasskeyWebauthn["verifyRegistrationResponse"],
    verifyAuthenticationResponse: (async (opts: {
      response: { id: string; response: { clientDataJSON: string; userVerified?: boolean } };
      expectedChallenge: (c: string) => boolean | Promise<boolean>;
      credential: { id: string; counter: number };
    }) => {
      const ok = await opts.expectedChallenge(
        decodeChallenge(opts.response.response.clientDataJSON),
      );
      if (!ok || opts.credential.id !== opts.response.id) return { verified: false };
      return {
        verified: true,
        authenticationInfo: {
          credentialID: opts.response.id,
          newCounter: opts.credential.counter + 1,
          userVerified: opts.response.response.userVerified ?? true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: ORIGIN,
          rpID: RP_ID,
        },
      };
    }) as unknown as PasskeyWebauthn["verifyAuthenticationResponse"],
  };
}

function authenticatorResponse(credId: string, challenge: string, userVerified = true) {
  return {
    id: credId,
    rawId: credId,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ challenge, origin: ORIGIN })).toString(
        "base64url",
      ),
      attestationObject: "",
      authenticatorData: "",
      signature: "",
      userVerified,
    },
  };
}

// --- fake OIDC provider ----------------------------------------------------------------------

interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  nextNonce: string;
  user: { sub: string; email: string; email_verified: boolean; name: string };
  /** Extra ID-token claims (`amr`, `acr`) for the next token. */
  extraClaims: Record<string, unknown>;
  /** Sign the next ID token with a key the JWKS does not publish (forged token). */
  forgeSignature: boolean;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

async function startFakeIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const rogue = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const state: FakeIdp = {
    issuer: "",
    clientId: "fundroom-client",
    clientSecret: "s3cret",
    nextNonce: "",
    user: {
      sub: "google|123",
      email: "staff@acme.test",
      email_verified: true,
      name: "Staff Person",
    },
    extraClaims: {},
    forgeSignature: false,
    tokenRequests: [],
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
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
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      state.tokenRequests.push(params);
      if (params.get("code") !== "the-code" || params.get("client_secret") !== state.clientSecret) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const idToken = await new SignJWT({
        ...state.user,
        ...state.extraClaims,
        nonce: state.nextNonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(state.issuer)
        .setAudience(state.clientId)
        .setSubject(state.user.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(state.forgeSignature ? rogue.privateKey : privateKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ access_token: "at", token_type: "Bearer", id_token: idToken }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  state.issuer = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

// --- setup ------------------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 6 });
  idp = await startFakeIdp();
  const deps: IdentityDeps = {
    db,
    keyRing,
    mailer: {
      driver: "test",
      async send(m) {
        if (mailerFails) throw new Error("smtp down");
        sent.push(m);
        if (mailerDelayMs > 0) await new Promise((r) => setTimeout(r, mailerDelayMs));
        return { messageId: `<${sent.length}@test>`, acceptedAt: clock };
      },
      async healthCheck() {},
    },
    rateLimiter: createPostgresRateLimiter(db, { now: () => clock }),
    // Wired per test: the identity kernel never imports `@fundroom/share-links` (contract S2).
    get shareLinks() {
      return shareLinksStub;
    },
    audit: createAuditService({ db, now: () => clock }),
    baseUrl: new URL(ORIGIN),
    productName: "FundRoom",
    now: () => clock,
  };
  auth = createAuthService(deps, {
    emailOtp: { minStartMs: 0 },
    magicLink: { minStartMs: 0 },
    passkeys: { rpId: RP_ID, rpName: "FundRoom", origins: [ORIGIN], webauthn: fakeWebauthn() },
    password: {
      enabled: true,
      breachCheck: {
        enabled: true,
        fetch: async () =>
          new Response("00000000000000000000000000000000000:0\r\n", { status: 200 }),
      },
    },
    oidc: {
      providers: {
        google: {
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          trustEmail: false,
        },
      },
      allowInsecureHttp: true,
    },
  });
});

afterAll(async () => {
  await db?.close();
  await idp?.close();
  await pg?.stop();
});

const workspaceNames = new Map<string, string>();
async function workspace(slug: string): Promise<{ id: string; name: string }> {
  const ws = await createWorkspace(db, { slug, name: `Workspace ${slug}` });
  workspaceNames.set(ws.id, ws.name);
  return { id: ws.id, name: ws.name };
}

async function invite(
  workspaceId: string,
  email: string,
  kind: "staff" | "external" = "external",
  role: "owner" | "admin" | "editor" | "investor" = "investor",
) {
  return auth.invites.create({ workspaceId, email, kind, role, send: false });
}

let ipCounter = 0;
async function otpLogin(workspaceId: string, email: string, extra: Record<string, unknown> = {}) {
  // A fresh IP per login keeps the per-IP limiter (20/h) out of unrelated tests.
  ipCounter += 1;
  const ip = `203.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  const workspaceName = workspaceNames.get(workspaceId);
  await auth.emailOtp.start({ email, workspaceId, workspaceName, ip });
  return auth.emailOtp.verify({
    email,
    code: codeFrom(lastMail()),
    workspaceId,
    workspaceName,
    ...extra,
  });
}

// --- tests ------------------------------------------------------------------------------------

describe("email OTP login (§13.1)", () => {
  it("responds identically for unknown emails but only mails invited ones", async () => {
    const ws = await workspace("otp");
    const before = sent.length;
    const r1 = await auth.emailOtp.start({ email: "nobody@example.test", workspaceId: ws.id });
    expect(r1).toEqual({ status: "sent", emailHint: "n***@example.test", ttlMinutes: 10 });
    expect(sent.length).toBe(before);

    await invite(ws.id, "Alice@Example.test");
    const r2 = await auth.emailOtp.start({
      email: "alice@example.test",
      workspaceId: ws.id,
      workspaceName: ws.name,
    });
    expect(r2).toEqual({ status: "sent", emailHint: "a***@example.test", ttlMinutes: 10 });
    expect(sent.length).toBe(before + 1);
    expect(lastMail().to).toBe("alice@example.test");
    expect(lastMail().subject).toMatch(/^\d{6} is your Workspace otp/u);
  });

  it("verifies the code, creates the user, activates the invite, mints a session", async () => {
    const ws = await workspace("otp2");
    await invite(ws.id, "bob@example.test");
    await auth.emailOtp.start({ email: "bob@example.test", workspaceId: ws.id });
    const code = codeFrom(lastMail());

    await expectAuthError(
      auth.emailOtp.verify({ email: "bob@example.test", code: "000000", workspaceId: ws.id }),
      "invalid_code",
    );
    const login = await auth.emailOtp.verify({
      email: "bob@example.test",
      code,
      workspaceId: ws.id,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0",
    });
    expect(login.isNewUser).toBe(true);
    expect(login.isNewDevice).toBe(false); // first device ever: no alert
    expect(login.membership).toMatchObject({
      kind: "external",
      role: "investor",
      status: "active",
    });
    expect(login.session).toMatchObject({
      authLevel: 1,
      population: "external",
      context: "first_party",
    });
    expect(login.session.idleExpiresAt.getTime() - clock.getTime()).toBe(24 * 3600_000);
    expect(login.session.absoluteExpiresAt.getTime() - clock.getTime()).toBe(14 * 24 * 3600_000);

    const resolved = await auth.resolveSession(login.token);
    expect(resolved?.userId).toBe(login.session.userId);
    expect(resolved?.lastWorkspaceId).toBe(ws.id);

    // The code is single use, and the invite is now accepted.
    await expectAuthError(
      auth.emailOtp.verify({ email: "bob@example.test", code, workspaceId: ws.id }),
      "invalid_code",
    );
    const landing = await auth.invites.resolve(ws.id, "x".repeat(43));
    expect(landing).toEqual({ valid: false });
    const memberships = await auth.listMemberships(login.session.userId);
    expect(memberships).toEqual([
      expect.objectContaining({
        workspaceId: ws.id,
        kind: "external",
        role: "investor",
        status: "active",
      }),
    ]);

    // E0.4: the workspace chain records the invite, the denied attempt, the membership and
    // the login (as the member, with a truncated IP); the outbox carries the domain events.
    const rows = await auditRows(ws.id);
    expect(rows.map((r) => [Number(r.seq), r.action, r.outcome, r.actor_kind])).toEqual([
      [1, "invite.created", "success", "system"],
      [2, "auth.login_failed", "denied", "external"],
      [3, "membership.created", "success", "external"],
      [4, "auth.login", "success", "external"],
    ]);
    expect(rows[3]?.actor_user_id).toBe(login.session.userId);
    expect(rows[3]?.subject_membership_id).toBe(login.membership?.id);
    expect(rows[3]?.meta).toMatchObject({ method: "email_otp", newUser: true, authLevel: 1 });
    expect(rows[1]?.meta).toEqual({ method: "email_otp", reason: "invalid_code" });
    expect((await outboxTopics(ws.id)).map((o) => o.topic)).toEqual([
      "invite.created",
      "acl.changed", // acceptance applies the invite's groups/grants (E1.1)
      "membership.created",
    ]);
    expect((await outboxTopics(null)).map((o) => o.topic)).toContain("user.created");
    expect(await verifyWorkspace({ db }, ws.id)).toMatchObject({ ok: true, headSeq: 4 });
  });

  it("answers verify identically for an address that may not sign in here (P2-02)", async () => {
    const ws = await workspace("otp-enum");
    await invite(ws.id, "known@example.test");
    const trail = async (email: string): Promise<string[]> => {
      await auth.emailOtp.start({ email, workspaceId: ws.id });
      const out: string[] = [];
      for (let i = 0; i < 7; i++) {
        try {
          await auth.emailOtp.verify({ email, code: "000000", workspaceId: ws.id });
          out.push("ok");
        } catch (error) {
          out.push(
            isAuthError(error)
              ? JSON.stringify({ code: error.code, status: error.status, details: error.details })
              : String(error),
          );
        }
      }
      return out;
    };
    const mailsBefore = sent.length;
    const known = await trail("known@example.test");
    expect(sent.length).toBe(mailsBefore + 1); // the known address got its code …
    const unknown = await trail("nobody-here@example.test");
    expect(sent.length).toBe(mailsBefore + 1); // … the unknown one got nothing
    expect(unknown).toEqual(known);
    expect(known[0]).toContain('"attemptsLeft":4');
    expect(known[5]).toContain("too_many_attempts");
  });

  it("kills the code after five wrong attempts and after expiry", async () => {
    const ws = await workspace("otp3");
    await invite(ws.id, "carol@example.test");
    await auth.emailOtp.start({ email: "carol@example.test", workspaceId: ws.id });
    const code = codeFrom(lastMail());
    for (let i = 1; i <= 4; i++) {
      const details = await expectAuthError(
        auth.emailOtp.verify({ email: "carol@example.test", code: "111111", workspaceId: ws.id }),
        "invalid_code",
      );
      expect(details["attemptsLeft"]).toBe(5 - i);
    }
    await expectAuthError(
      auth.emailOtp.verify({ email: "carol@example.test", code: "111111", workspaceId: ws.id }),
      "invalid_code",
    );
    await expectAuthError(
      auth.emailOtp.verify({ email: "carol@example.test", code, workspaceId: ws.id }),
      "too_many_attempts",
    );

    await auth.emailOtp.start({ email: "carol@example.test", workspaceId: ws.id });
    const fresh = codeFrom(lastMail());
    tick(11 * 60_000);
    await expectAuthError(
      auth.emailOtp.verify({ email: "carol@example.test", code: fresh, workspaceId: ws.id }),
      "invalid_code",
    );
  });

  it("rate limits code requests per email, and never tells the caller that mail is down (R1-03)", async () => {
    const ws = await workspace("otp4");
    await invite(ws.id, "dan@example.test");
    for (let i = 0; i < 5; i++)
      await auth.emailOtp.start({ email: "dan@example.test", workspaceId: ws.id });
    const d = await expectAuthError(
      auth.emailOtp.start({ email: "dan@example.test", workspaceId: ws.id }),
      "rate_limited",
    );
    expect(d["retryAfterMs"]).toBeGreaterThan(0);
    // Sliding window: the previous bucket still weighs in for a while; two windows clear it.
    tick(31 * 60_000);
    mailerFails = true;
    try {
      // Known and unknown addresses get the same answer while the mailer fails: the send is
      // detached from the response (a 503 for members only was an enumeration oracle).
      const known = await auth.emailOtp.start({ email: "dan@example.test", workspaceId: ws.id });
      const unknown = await auth.emailOtp.start({
        email: "stranger@example.test",
        workspaceId: ws.id,
      });
      expect(known).toEqual({ status: "sent", emailHint: "d***@example.test", ttlMinutes: 10 });
      expect(unknown).toEqual({ status: "sent", emailHint: "s***@example.test", ttlMinutes: 10 });
      const link = await auth.magicLink.start({ email: "dan@example.test", workspaceId: ws.id });
      expect(link.status).toBe("sent");
    } finally {
      mailerFails = false;
    }
  });

  it("carries the name the inviter typed onto the account, not just the membership", async () => {
    // Regression: `invite.profile.displayName` was written to the membership profile on
    // acceptance and nowhere else, so `core.user.display_name` stayed empty and the investor's
    // own portal greeted them with "Welcome," and a blank. Found by the E2.2 host harness.
    const ws = await workspace("invited-name");
    await auth.invites.create({
      workspaceId: ws.id,
      email: "ada@example.test",
      kind: "external",
      role: "investor",
      send: false,
      profile: { displayName: "Ada Investor" },
    });
    const login = await otpLogin(ws.id, "ada@example.test");
    expect(login.isNewUser).toBe(true);
    expect((await auth.resolveSession(login.token))?.user.displayName).toBe("Ada Investor");
  });

  it("leaves the account nameless when the invitation named nobody", async () => {
    const ws = await workspace("uninvited-name");
    await invite(ws.id, "nemo@example.test");
    const login = await otpLogin(ws.id, "nemo@example.test");
    expect((await auth.resolveSession(login.token))?.user.displayName).toBe("");
  });

  it("staff invites yield staff sessions with staff lifetimes", async () => {
    const ws = await workspace("staff");
    await invite(ws.id, "owner@acme.test", "staff", "owner");
    const login = await otpLogin(ws.id, "owner@acme.test");
    expect(login.membership).toMatchObject({ kind: "staff", role: "owner" });
    expect(login.session.population).toBe("staff");
    expect(login.session.idleExpiresAt.getTime() - clock.getTime()).toBe(12 * 3600_000);
  });
});

describe("magic link (POST-to-confirm + browser binding)", () => {
  it("confirms only from the requesting browser; the code is the fallback", async () => {
    const ws = await workspace("link");
    await invite(ws.id, "eve@example.test");
    const start = await auth.magicLink.start({
      email: "eve@example.test",
      workspaceId: ws.id,
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36",
    });
    expect(start.status).toBe("sent");
    expect(start.bindingMaxAgeSeconds).toBe(600); // 10 min: ASVS 6.5.5 (F-16)
    expect(start.ttlMinutes).toBe(10);
    const mail = lastMail();
    const token = linkTokenFrom(mail);
    const code = codeFrom(mail);
    expect(mail.text).toContain("Requested from: Chrome on macOS");

    expect(await auth.magicLink.peek(token)).toEqual({
      valid: true,
      emailHint: "e***@example.test",
      requestedFrom: "Chrome on macOS",
    });
    // Forwarded link, different browser: refused, link still alive.
    const details = await expectAuthError(
      auth.magicLink.confirm({ token, workspaceId: ws.id }),
      "binding_mismatch",
    );
    expect(details["emailHint"]).toBe("e***@example.test");
    await expectAuthError(
      auth.magicLink.confirm({ token, bindingToken: "wrong", workspaceId: ws.id }),
      "binding_mismatch",
    );
    // Wrong workspace never matches either.
    await expectAuthError(
      auth.magicLink.confirm({ token, bindingToken: start.bindingToken }),
      "invalid_code",
    );
    const login = await auth.magicLink.confirm({
      token,
      bindingToken: start.bindingToken,
      workspaceId: ws.id,
    });
    expect(login.membership?.status).toBe("active");
    // Single use, and the sibling code died with it.
    await expectAuthError(
      auth.magicLink.confirm({ token, bindingToken: start.bindingToken, workspaceId: ws.id }),
      "invalid_code",
    );
    await expectAuthError(
      auth.emailOtp.verify({ email: "eve@example.test", code, workspaceId: ws.id }),
      "invalid_code",
    );
    expect(await auth.magicLink.peek(token)).toEqual({ valid: false });
  });

  it("the code from a magic-link email works on its own and kills the link", async () => {
    const ws = await workspace("link2");
    await invite(ws.id, "fay@example.test");
    const start = await auth.magicLink.start({ email: "fay@example.test", workspaceId: ws.id });
    const mail = lastMail();
    const login = await auth.emailOtp.verify({
      email: "fay@example.test",
      code: codeFrom(mail),
      workspaceId: ws.id,
    });
    expect(login.session.authLevel).toBe(1);
    await expectAuthError(
      auth.magicLink.confirm({
        token: linkTokenFrom(mail),
        bindingToken: start.bindingToken,
        workspaceId: ws.id,
      }),
      "invalid_code",
    );
  });
});

describe("sessions and devices (§6.3)", () => {
  it("expires on idle and absolute timeouts, touches at most every 5 minutes", async () => {
    const ws = await workspace("sess");
    await invite(ws.id, "gus@example.test");
    const login = await otpLogin(ws.id, "gus@example.test");
    const t0 = clock.getTime();
    tick(4 * 60_000);
    const s1 = await auth.resolveSession(login.token);
    expect(s1?.idleExpiresAt.getTime()).toBe(t0 + 24 * 3600_000); // not touched yet
    tick(2 * 60_000);
    const s2 = await auth.resolveSession(login.token);
    expect(s2?.idleExpiresAt.getTime()).toBe(clock.getTime() + 24 * 3600_000); // touched
    tick(24 * 3600_000 + 1);
    expect(await auth.resolveSession(login.token)).toBeUndefined(); // idle expiry
    // A session kept alive still dies at the absolute limit.
    const again = await otpLogin(ws.id, "gus@example.test");
    const start = clock.getTime();
    while (clock.getTime() - start < 14 * 24 * 3600_000) {
      tick(12 * 3600_000);
      await auth.resolveSession(again.token);
    }
    tick(1);
    expect(await auth.resolveSession(again.token)).toBeUndefined();
    expect(await auth.resolveSession("garbage")).toBeUndefined();
  });

  it("recognises devices, alerts on new ones, and the one-click link revokes them", async () => {
    const ws = await workspace("dev");
    await invite(ws.id, "hal@example.test");
    const first = await otpLogin(ws.id, "hal@example.test", {
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36",
    });
    expect(first.isNewDevice).toBe(false);
    const mailsBefore = sent.length;

    const same = await otpLogin(ws.id, "hal@example.test", { deviceToken: first.deviceToken });
    expect(same.isNewDevice).toBe(false);
    expect(same.deviceToken).toBe(first.deviceToken);
    expect(same.session.deviceId).toBe(first.session.deviceId);
    expect(sent.length).toBe(mailsBefore + 1); // only the OTP mail

    const other = await otpLogin(ws.id, "hal@example.test", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605.1",
    });
    expect(other.isNewDevice).toBe(true);
    expect(other.deviceToken).not.toBe(first.deviceToken);
    const alert = lastMail();
    expect(alert.subject).toBe("New sign-in to Workspace dev (FundRoom)");
    expect(alert.text).toContain("Safari on iOS");
    const revokeToken = /revoke\?token=([A-Za-z0-9_-]+)/u.exec(alert.text)?.[1];
    expect(revokeToken).toBeDefined();

    const devices = await auth.sessions.listDevices(first.session.userId);
    expect(devices.map((d) => d.device).sort()).toEqual(["Chrome on macOS", "Safari on iOS"]);
    const sessions = await auth.sessions.listSessions(
      first.session.userId,
      other.session.sessionId,
    );
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions).toHaveLength(3);

    expect(await auth.sessions.revokeByToken(revokeToken as string)).toBe(true);
    expect(await auth.resolveSession(other.token)).toBeUndefined();
    expect(await auth.resolveSession(first.token)).toBeDefined();
    expect(await auth.sessions.listDevices(first.session.userId)).toHaveLength(1);
    expect(await auth.sessions.revokeByToken(revokeToken as string)).toBe(false);
  });

  it("global-user events (sign-out-everywhere) land in the platform chain, never a tenant's", async () => {
    const ws = await workspace("platform-audit");
    await invite(ws.id, "pl@example.test");
    const login = await otpLogin(ws.id, "pl@example.test");
    await auth.revokeAllSessions(login.session.userId, "logout_everywhere");
    const platform = await auditRows(PLATFORM_WORKSPACE_ID);
    const mine = platform.filter((r) => r.actor_user_id === login.session.userId);
    expect(mine.map((r) => [r.action, r.actor_kind])).toEqual([
      ["auth.sessions_revoked_all", "host"],
    ]);
    expect(mine[0]?.meta).toEqual({ reason: "logout_everywhere", count: 1 });
    expect((await auditRows(ws.id)).map((r) => r.action)).not.toContain(
      "auth.sessions_revoked_all",
    );
    expect(await verifyWorkspace({ db }, PLATFORM_WORKSPACE_ID)).toMatchObject({ ok: true });
  });

  it("sign out everywhere bumps session_version; workspace revocation is scoped", async () => {
    const a = await workspace("rev-a");
    const b = await workspace("rev-b");
    await invite(a.id, "ida@example.test");
    await invite(b.id, "ida@example.test");
    const inA = await otpLogin(a.id, "ida@example.test");
    const inB = await otpLogin(b.id, "ida@example.test");
    expect(inB.session.userId).toBe(inA.session.userId);

    expect(
      await auth.revokeSessionsForWorkspace(inA.session.userId, a.id, "membership_revoked"),
    ).toBe(1);
    expect(await auth.resolveSession(inA.token)).toBeUndefined();
    expect(await auth.resolveSession(inB.token)).toBeDefined();

    const inA2 = await otpLogin(a.id, "ida@example.test");
    expect(await auth.revokeAllSessions(inA.session.userId, "logout_everywhere")).toBe(2);
    expect(await auth.resolveSession(inA2.token)).toBeUndefined();
    expect(await auth.resolveSession(inB.token)).toBeUndefined();
    // Logging in again works and yields a session under the new version.
    const fresh = await otpLogin(a.id, "ida@example.test");
    expect(await auth.resolveSession(fresh.token)).toBeDefined();
  });

  it("caps concurrent sessions per population (external: 5)", async () => {
    const ws = await workspace("cap");
    await invite(ws.id, "jo@example.test");
    const logins = [];
    for (let i = 0; i < 6; i++) {
      tick(31 * 60_000); // stay under the per-email code limit (5 / 15 min sliding)
      logins.push(await otpLogin(ws.id, "jo@example.test"));
    }
    expect(await auth.resolveSession(logins[0]?.token as string)).toBeUndefined();
    for (const l of logins.slice(1)) expect(await auth.resolveSession(l.token)).toBeDefined();
  });

  it("remember-device stretches the absolute lifetime to 30 days", async () => {
    const ws = await workspace("remember");
    await invite(ws.id, "kim@example.test");
    const login = await otpLogin(ws.id, "kim@example.test", { rememberDevice: true });
    expect(login.session.absoluteExpiresAt.getTime() - clock.getTime()).toBe(30 * 24 * 3600_000);
    const next = await otpLogin(ws.id, "kim@example.test", { deviceToken: login.deviceToken });
    expect(next.session.absoluteExpiresAt.getTime() - clock.getTime()).toBe(30 * 24 * 3600_000);
  });
});

describe("TOTP and recovery codes", () => {
  it("enrols, confirms, steps the session up, blocks replay, consumes recovery codes", async () => {
    const ws = await workspace("totp");
    await invite(ws.id, "lee@acme.test", "staff", "admin");
    const login = await otpLogin(ws.id, "lee@acme.test");
    const userId = login.session.userId;
    expect((await auth.resolveSession(login.token))?.user.mfaEnrolled).toBe(false);

    await expectAuthError(auth.totp.verify({ userId, code: "000000" }), "mfa_not_enrolled");
    const enrol = await auth.totp.beginEnrolment({ userId });
    expect(enrol.otpauthUri).toMatch(/^otpauth:\/\/totp\/FundRoom:lee%40acme\.test\?/u);
    expect(enrol.otpauthUri).toContain(`secret=${enrol.secretBase32}`);
    const totp = new OTPAuth.TOTP({
      secret: new OTPAuth.Secret({
        buffer: base32Decode(enrol.secretBase32).buffer as ArrayBuffer,
      }),
      digits: 6,
      period: 30,
    });
    const at = () => totp.generate({ timestamp: clock.getTime() });

    await expectAuthError(auth.totp.confirmEnrolment({ userId, code: "123456" }), "invalid_code");
    const { recoveryCodes } = await auth.totp.confirmEnrolment({
      userId,
      code: at(),
      context: { sessionId: login.session.sessionId },
    });
    expect(recoveryCodes).toHaveLength(10);
    expect(await auth.totp.status(userId)).toEqual({
      enrolled: true,
      pending: false,
      recoveryCodesLeft: 10,
    });
    expect((await auth.resolveSession(login.token))?.user.mfaEnrolled).toBe(true);

    // Same step again is a replay; next step verifies and records step-up.
    await expectAuthError(auth.totp.verify({ userId, code: at() }), "invalid_code");
    tick(30_000);
    const before = clock.getTime();
    tick(60_000);
    const up = await auth.totp.verify({ userId, code: at(), sessionId: login.session.sessionId });
    // Step-up rotates the token (F-12): the pre-step-up value is dead, the same row lives on.
    expect(up?.token).toBeDefined();
    expect(up?.token).not.toBe(login.token);
    expect(await auth.resolveSession(login.token)).toBeUndefined();
    const stepped = await auth.resolveSession(up?.token ?? "");
    expect(stepped?.sessionId).toBe(login.session.sessionId);
    expect(stepped?.authLevel).toBe(2);
    expect(stepped?.authTime.getTime()).toBeGreaterThan(before);

    // Recovery code: once.
    const rc = recoveryCodes[0] as string;
    expect(await auth.totp.verifyRecoveryCode({ userId, code: rc.toUpperCase() })).toEqual({
      remaining: 9,
    });
    await expectAuthError(auth.totp.verifyRecoveryCode({ userId, code: rc }), "invalid_code");

    // Five failures lock the user out for the window.
    tick(60_000);
    for (let i = 0; i < 4; i++)
      await expectAuthError(auth.totp.verify({ userId, code: "000000" }), "invalid_code");
    await expectAuthError(auth.totp.verify({ userId, code: at() }), "rate_limited");
    tick(16 * 60_000);
    await auth.totp.verify({ userId, code: at() });

    await auth.totp.disable({ userId, context: { sessionId: login.session.sessionId } });
    expect(await auth.totp.status(userId)).toEqual({
      enrolled: false,
      pending: false,
      recoveryCodesLeft: 0,
    });
    expect((await auth.resolveSession(up?.token ?? ""))?.user.mfaEnrolled).toBe(false);
  });
});

describe("MFA hardening (E2.10: F-05, F-06, F-10, F-12, F-18)", () => {
  /** A staff user with a confirmed authenticator; `at()` is the code for the test clock. */
  async function enrolled(slug: string, email: string) {
    const ws = await workspace(slug);
    await invite(ws.id, email, "staff", "admin");
    const login = await otpLogin(ws.id, email);
    const userId = login.session.userId;
    const enrol = await auth.totp.beginEnrolment({ userId });
    const totp = new OTPAuth.TOTP({
      secret: new OTPAuth.Secret({
        buffer: base32Decode(enrol.secretBase32).buffer as ArrayBuffer,
      }),
      digits: 6,
      period: 30,
    });
    const at = () => totp.generate({ timestamp: clock.getTime() });
    const { recoveryCodes } = await auth.totp.confirmEnrolment({
      userId,
      code: at(),
      context: { sessionId: login.session.sessionId },
    });
    tick(60_000); // past the enrolment step's replay guard
    return { ws, login, userId, at, recoveryCodes };
  }

  async function warmPool(): Promise<void> {
    await Promise.all(
      Array.from({ length: 6 }, () => db.withHost((tx) => tx.execute(sql`SELECT pg_sleep(0.05)`))),
    );
  }

  function codesOf(results: PromiseSettledResult<unknown>[]): string[] {
    return results.map((r) =>
      r.status === "fulfilled" ? "ok" : isAuthError(r.reason) ? r.reason.code : String(r.reason),
    );
  }

  async function platformRowsFor(userId: string) {
    const r = await pg.pool.query<{
      action: string;
      outcome: string;
      meta: Record<string, unknown>;
    }>(
      "SELECT action, outcome, meta FROM audit.event WHERE workspace_id = $1 AND actor_user_id = $2 ORDER BY seq",
      [PLATFORM_WORKSPACE_ID, userId],
    );
    return r.rows;
  }

  it("twenty concurrent wrong TOTP codes are all counted: at most five are evaluated (F-05)", async () => {
    const { userId } = await enrolled("totp-race", "race@acme.test");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => auth.totp.verify({ userId, code: "000000" })),
    );
    const codes = codesOf(results);
    expect(codes.filter((c) => c === "invalid_code")).toHaveLength(5);
    expect(codes.filter((c) => c === "rate_limited")).toHaveLength(15);
    // Only evaluated (slot-consuming) failures reach the audit chain.
    const denied = (await platformRowsFor(userId)).filter(
      (r) => r.action === "auth.step_up" && r.outcome === "denied",
    );
    expect(denied).toHaveLength(5);
    expect(denied[0]?.meta).toEqual({ method: "totp", reason: "invalid_code" });
  });

  it("the same TOTP code and the same recovery code are each accepted once, concurrently (F-06)", async () => {
    const { userId, login, at, recoveryCodes } = await enrolled("totp-once", "once@acme.test");
    // An in-memory limiter answers instantly, so the verifies reach the database together
    // instead of queueing behind the Postgres limiter's row lock: the widest race window.
    const fast = createAuthService(
      { ...depsFor(), rateLimiter: createMemoryRateLimiter({ now: () => clock }) },
      { passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] }, password: { enabled: false } },
    );
    // Warm the pool so every verify gets a connection at once rather than one at a time.
    await warmPool();
    const code = at();
    const totpResults = codesOf(
      await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          fast.totp.verify({ userId, code, sessionId: login.session.sessionId }),
        ),
      ),
    );
    expect(totpResults.filter((c) => c === "ok")).toHaveLength(1);
    expect(totpResults.filter((c) => c === "invalid_code")).toHaveLength(4);

    tick(31 * 60_000); // two windows on: nothing left of the TOTP round in the estimate
    const rc = recoveryCodes[0] as string;
    await warmPool();
    const recoveryResults = await Promise.allSettled(
      Array.from({ length: 5 }, () => fast.totp.verifyRecoveryCode({ userId, code: rc })),
    );
    expect(codesOf(recoveryResults).filter((c) => c === "ok")).toHaveLength(1);
    expect(codesOf(recoveryResults).filter((c) => c === "invalid_code")).toHaveLength(4);
    expect(await auth.totp.status(userId)).toMatchObject({ recoveryCodesLeft: 9 });
  });

  it("stores recovery codes as salted scrypt hashes; an older HMAC set still verifies (F-18)", async () => {
    const { userId } = await enrolled("rc-format", "rc@acme.test");
    const stored = async () =>
      (
        await pg.pool.query<{ data: { codes: string[] } }>(
          "SELECT data FROM core.credential WHERE user_id = $1 AND kind = 'recovery_codes' AND revoked_at IS NULL",
          [userId],
        )
      ).rows[0]?.data.codes ?? [];
    const codes = await stored();
    expect(codes).toHaveLength(10);
    expect(codes.every((h) => h.startsWith("rc1$"))).toBe(true);
    expect(new Set(codes.map((h) => h.split("$")[1])).size).toBe(10); // one salt per code

    // A set issued before E2.10 (keyed HMAC, no salt) keeps working until regenerated.
    const legacy = hashCode(keyRing, normalizeCode("abcd-efgh"), `recovery:${userId}`).toString(
      "base64url",
    );
    await pg.pool.query(
      "UPDATE core.credential SET data = jsonb_build_object('codes', jsonb_build_array($1::text, $2::text)) WHERE user_id = $3 AND kind = 'recovery_codes' AND revoked_at IS NULL",
      [codes[0], legacy, userId],
    );
    expect(await auth.totp.verifyRecoveryCode({ userId, code: "ABCD-EFGH" })).toEqual({
      remaining: 1,
    });
    expect(await stored()).toEqual([codes[0]]);
  });

  it("audits step-up success and failure, recovery use and regeneration, password removal (F-10)", async () => {
    const { userId, login, at, recoveryCodes } = await enrolled("mfa-audit", "audit@acme.test");
    const sessionId = login.session.sessionId;
    await expectAuthError(auth.totp.verify({ userId, code: "000000", sessionId }), "invalid_code");
    await auth.totp.verify({ userId, code: at(), sessionId });
    await auth.totp.verifyRecoveryCode({ userId, code: recoveryCodes[1] as string, sessionId });
    await auth.totp.regenerateRecoveryCodes({ userId, context: { sessionId } });
    await auth.password.set({
      userId,
      password: "correct horse battery staple",
      keepSessionId: sessionId,
    });
    await auth.password.remove({
      userId,
      currentPassword: "correct horse battery staple",
      context: { sessionId },
    });
    await auth.password.remove({ userId, context: { sessionId } }); // nothing left: no second row

    const rows = await platformRowsFor(userId);
    const summary = rows
      .filter((r) => r.action !== "auth.mfa_enrolled")
      .map((r) => [r.action, r.outcome, r.meta["method"] ?? r.meta["change"] ?? null]);
    expect(summary).toEqual([
      ["auth.step_up", "denied", "totp"],
      ["auth.step_up", "success", "totp"],
      ["auth.recovery_code_used", "success", null],
      ["auth.step_up", "success", "recovery_code"],
      ["auth.recovery_codes_regenerated", "success", null],
      ["auth.password_changed", "success", "set"],
      ["auth.password_changed", "success", "removed"],
    ]);
    const up = rows.find((r) => r.action === "auth.step_up" && r.outcome === "success");
    expect(up?.meta).toMatchObject({ method: "totp", proofLevel: 2, fromLevel: 1, toLevel: 2 });
    expect(rows.find((r) => r.action === "auth.recovery_code_used")?.meta).toEqual({
      remaining: 9,
    });
    expect(await verifyWorkspace({ db }, PLATFORM_WORKSPACE_ID)).toMatchObject({ ok: true });
  });

  it("a new login revokes the session the browser already held (F-12, ASVS 7.2.4)", async () => {
    const ws = await workspace("replace");
    await invite(ws.id, "swap@example.test");
    const first = await otpLogin(ws.id, "swap@example.test");
    const unrelated = await otpLogin(ws.id, "swap@example.test");
    tick(31 * 60_000); // stay under the per-email code limit
    const second = await otpLogin(ws.id, "swap@example.test", {
      replacesSessionId: first.session.sessionId,
    });
    expect(await auth.resolveSession(first.token)).toBeUndefined();
    expect(await auth.resolveSession(second.token)).toBeDefined();
    expect(await auth.resolveSession(unrelated.token)).toBeDefined(); // other browsers untouched
    const r = await pg.pool.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM core.session WHERE id = $1",
      [first.session.sessionId],
    );
    expect(r.rows[0]?.revoked_reason).toBe("replaced");
  });
});

describe("factor changes (P2-01, F-20)", () => {
  it("replacing a password needs the current one; each change mails a notice and ends the other sessions", async () => {
    const ws = await workspace("pw-change");
    await invite(ws.id, "cur@acme.test", "staff", "editor");
    const login = await otpLogin(ws.id, "cur@acme.test");
    const userId = login.session.userId;
    const context = {
      sessionId: login.session.sessionId,
      workspaceId: ws.id,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/130.0",
    };
    await auth.password.set({ userId, password: "first password 1234", context });
    const setNotice = lastMail();
    expect(setNotice.to).toBe("cur@acme.test");
    expect(setNotice.subject).toContain("Security notice");
    expect(setNotice.text).toContain("A password was set");
    expect(setNotice.template?.name).toBe("notification");

    const other = await otpLogin(ws.id, "cur@acme.test");
    await expectAuthError(
      auth.password.set({ userId, password: "second password 1234", context }),
      "invalid_request",
    );
    await expectAuthError(
      auth.password.set({
        userId,
        password: "second password 1234",
        currentPassword: "not the password at all",
        context,
      }),
      "invalid_credential",
    );
    expect(await auth.resolveSession(other.token)).toBeDefined(); // refused: nothing happened
    await auth.password.set({
      userId,
      password: "second password 1234",
      currentPassword: "first password 1234",
      context,
    });
    expect(await auth.resolveSession(login.token)).toBeDefined(); // the session that changed it
    expect(await auth.resolveSession(other.token)).toBeUndefined(); // everybody else is out
    expect(lastMail().text).toContain("was changed");
    expect(lastMail().text).toContain("1 other session was signed out");
  });

  it("enrolling and removing an authenticator signs out the other sessions and mails the account", async () => {
    const ws = await workspace("factor-mail");
    await invite(ws.id, "fm@acme.test", "staff", "admin");
    const login = await otpLogin(ws.id, "fm@acme.test");
    const userId = login.session.userId;
    const other = await otpLogin(ws.id, "fm@acme.test");
    const enrol = await auth.totp.beginEnrolment({ userId });
    const totp = new OTPAuth.TOTP({
      secret: new OTPAuth.Secret({
        buffer: base32Decode(enrol.secretBase32).buffer as ArrayBuffer,
      }),
    });
    await auth.totp.confirmEnrolment({
      userId,
      code: totp.generate({ timestamp: clock.getTime() }),
      context: { sessionId: login.session.sessionId },
    });
    expect(await auth.resolveSession(login.token)).toBeDefined();
    expect(await auth.resolveSession(other.token)).toBeUndefined();
    expect(lastMail().text).toContain("An authenticator app was set up");
    expect(await auth.hasSecondFactor(userId)).toBe(true);

    const third = await otpLogin(ws.id, "fm@acme.test");
    await auth.totp.disable({ userId, context: { sessionId: login.session.sessionId } });
    expect(await auth.resolveSession(third.token)).toBeUndefined();
    expect(lastMail().text).toContain("The authenticator app was removed");
    expect(await auth.hasSecondFactor(userId)).toBe(false);
  });
});

describe("password login", () => {
  it("enforces policy + HIBP, verifies, and burns time for unknown emails", async () => {
    const ws = await workspace("pw");
    await invite(ws.id, "max@acme.test", "staff", "editor");
    const login = await otpLogin(ws.id, "max@acme.test");
    const userId = login.session.userId;

    await expectAuthError(auth.password.set({ userId, password: "short" }), "password_policy");
    const breachedAuth = createAuthService(
      { ...depsFor(), mailer: nullMailer() },
      {
        passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] },
        password: {
          enabled: true,
          breachCheck: {
            enabled: true,
            fetch: async () => new Response(`${sha1Suffix("passwordxxxxxxxx")}:99\r\n`),
          },
        },
      },
    );
    await expectAuthError(
      breachedAuth.password.set({ userId, password: "passwordxxxxxxxx" }),
      "password_breached",
    );

    const other = await otpLogin(ws.id, "max@acme.test");
    await auth.password.set({
      userId,
      password: "correct horse battery staple",
      keepSessionId: login.session.sessionId,
    });
    expect(await auth.resolveSession(login.token)).toBeDefined();
    expect(await auth.resolveSession(other.token)).toBeUndefined(); // credential_changed

    await expectAuthError(
      auth.password.login({ email: "max@acme.test", password: "wrong horse", workspaceId: ws.id }),
      "invalid_credential",
    );
    await expectAuthError(
      auth.password.login({
        email: "ghost@acme.test",
        password: "correct horse battery staple",
        workspaceId: ws.id,
      }),
      "invalid_credential",
    );
    const viaPassword = await auth.password.login({
      email: "MAX@acme.test",
      password: "correct horse battery staple",
      workspaceId: ws.id,
    });
    expect(viaPassword.session.authLevel).toBe(1);
    expect(viaPassword.session.population).toBe("staff");
    expect(await auth.password.has(userId)).toBe(true);

    const disabled = createAuthService(depsFor(), {
      passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] },
      password: { enabled: false },
    });
    await expectAuthError(
      disabled.password.login({ email: "max@acme.test", password: "x".repeat(12) }),
      "unsupported",
    );
  });
});

describe("breached-password check unavailable (E3.2 F-21)", () => {
  function withHibpDown(failMode: "open" | "closed" | undefined, calls: string[]): AuthService {
    return createAuthService(
      { ...depsFor(), mailer: nullMailer() },
      {
        passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] },
        password: {
          enabled: true,
          breachCheck: {
            enabled: true,
            fetch: async () => new Response("", { status: 503 }),
            ...(failMode === undefined ? {} : { failMode }),
            onUnavailable: (info) => calls.push(info.failMode),
          },
        },
      },
    );
  }
  async function skippedRows(userId: string) {
    const r = await pg.pool.query<{ outcome: string; meta: Record<string, unknown> }>(
      "SELECT outcome, meta FROM audit.event WHERE workspace_id = $1 AND actor_user_id = $2 AND action = 'auth.password_breach_check_skipped' ORDER BY seq",
      [PLATFORM_WORKSPACE_ID, userId],
    );
    return r.rows;
  }

  it("open (the default) accepts the password unchecked, audits the skip and counts it", async () => {
    const ws = await workspace("hibp-open");
    await invite(ws.id, "open@acme.test", "staff", "editor");
    const userId = (await otpLogin(ws.id, "open@acme.test")).session.userId;
    const calls: string[] = [];
    await withHibpDown(undefined, calls).password.set({ userId, password: "open mode password 1" });
    expect(await auth.password.has(userId)).toBe(true);
    expect(calls).toEqual(["open"]);
    expect(await skippedRows(userId)).toEqual([
      { outcome: "success", meta: { failMode: "open", cause: "http_status" } },
    ]);
  });

  it("closed refuses with breach_check_unavailable (503), not mail_failed, and still audits", async () => {
    const ws = await workspace("hibp-closed");
    await invite(ws.id, "closed@acme.test", "staff", "editor");
    const userId = (await otpLogin(ws.id, "closed@acme.test")).session.userId;
    const calls: string[] = [];
    const closed = withHibpDown("closed", calls);
    const err = await closed.password.set({ userId, password: "closed mode password 1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAuthError(err, "breach_check_unavailable")).toBe(true);
    expect((err as { status: number }).status).toBe(503);
    expect(await auth.password.has(userId)).toBe(false);
    expect(calls).toEqual(["closed"]);
    expect(await skippedRows(userId)).toEqual([
      { outcome: "denied", meta: { failMode: "closed", cause: "http_status" } },
    ]);
    expect(await verifyWorkspace({ db }, PLATFORM_WORKSPACE_ID)).toMatchObject({ ok: true });
  });
});

function sha1Suffix(password: string): string {
  return createHash("sha1").update(password).digest("hex").toUpperCase().slice(5);
}

function nullMailer(): MailerPort {
  return {
    driver: "null",
    async send() {
      return { messageId: "<null@test>", acceptedAt: clock };
    },
    async healthCheck() {},
  };
}

function depsFor(): IdentityDeps {
  return {
    db,
    keyRing,
    mailer: {
      driver: "test",
      async send(m) {
        sent.push(m);
        return { messageId: `<${sent.length}@test>`, acceptedAt: clock };
      },
      async healthCheck() {},
    },
    rateLimiter: createPostgresRateLimiter(db, { now: () => clock }),
    audit: createAuditService({ db, now: () => clock }),
    baseUrl: new URL(ORIGIN),
    productName: "FundRoom",
    now: () => clock,
  };
}

/** Audit rows of one chain, oldest first (superuser pool: bypasses the fence on purpose). */
async function auditRows(workspaceId: string) {
  const r = await pg.pool.query<{
    seq: string;
    action: string;
    outcome: string;
    actor_kind: string;
    actor_user_id: string | null;
    subject_membership_id: string | null;
    ip: string | null;
    meta: Record<string, unknown>;
  }>(
    "SELECT seq, action, outcome, actor_kind, actor_user_id, subject_membership_id, ip, meta FROM audit.event WHERE workspace_id = $1 ORDER BY seq",
    [workspaceId],
  );
  return r.rows;
}

async function outboxTopics(workspaceId: string | null) {
  const r = await pg.pool.query<{ topic: string; payload: Record<string, unknown> }>(
    workspaceId
      ? "SELECT topic, payload FROM core.outbox WHERE workspace_id = $1 ORDER BY id"
      : "SELECT topic, payload FROM core.outbox WHERE workspace_id IS NULL ORDER BY id",
    workspaceId ? [workspaceId] : [],
  );
  return r.rows;
}

describe("passkeys", () => {
  it("registers a discoverable credential and signs in with it at level 2", async () => {
    const ws = await workspace("pk");
    await invite(ws.id, "nia@example.test");
    const login = await otpLogin(ws.id, "nia@example.test");
    const userId = login.session.userId;

    const reg = await auth.passkeys.beginRegistration({ userId });
    expect(reg.options.rp).toEqual({ id: RP_ID, name: "FundRoom" });
    expect(reg.options.user.name).toBe("nia@example.test");
    expect(reg.options.authenticatorSelection?.residentKey).toBe("preferred");
    const credId = randomBytes(16).toString("base64url");
    await expectAuthError(
      auth.passkeys.finishRegistration({
        userId,
        challengeId: reg.challengeId,
        response: authenticatorResponse(credId, "bogus"),
      }),
      "invalid_credential",
    );
    const summary = await auth.passkeys.finishRegistration({
      userId,
      challengeId: reg.challengeId,
      response: authenticatorResponse(credId, reg.options.challenge),
      label: "MacBook Touch ID",
      context: { sessionId: login.session.sessionId },
    });
    expect(summary).toMatchObject({
      label: "MacBook Touch ID",
      backedUp: true,
      transports: ["internal"],
    });
    expect((await auth.resolveSession(login.token))?.user.mfaEnrolled).toBe(true);
    // Challenge is single use.
    await expectAuthError(
      auth.passkeys.finishRegistration({
        userId,
        challengeId: reg.challengeId,
        response: authenticatorResponse(credId, reg.options.challenge),
      }),
      "invalid_code",
    );

    const authn = await auth.passkeys.beginAuthentication({ ip: "203.0.113.9" });
    expect(authn.options.allowCredentials).toBeUndefined(); // discoverable: no email needed
    const pkLogin = await auth.passkeys.finishAuthentication({
      challengeId: authn.challengeId,
      response: authenticatorResponse(credId, authn.options.challenge),
      workspaceId: ws.id,
      embed: true,
      topSite: "https://acme.test",
    });
    expect(pkLogin.session).toMatchObject({ userId, authLevel: 2, context: "partitioned" });
    expect(pkLogin.isNewUser).toBe(false);

    // Unknown credential id, and a workspace the user is not a member of.
    const authn2 = await auth.passkeys.beginAuthentication({});
    await expectAuthError(
      auth.passkeys.finishAuthentication({
        challengeId: authn2.challengeId,
        response: authenticatorResponse("nope", authn2.options.challenge),
      }),
      "invalid_credential",
    );
    const elsewhere = await workspace("pk-other");
    const authn3 = await auth.passkeys.beginAuthentication({});
    await expectAuthError(
      auth.passkeys.finishAuthentication({
        challengeId: authn3.challengeId,
        response: authenticatorResponse(credId, authn3.options.challenge),
        workspaceId: elsewhere.id,
      }),
      "not_eligible",
    );

    // Step-up on the OTP session with the passkey.
    const authn4 = await auth.passkeys.beginAuthentication({});
    const up = await auth.passkeys.finishStepUp({
      challengeId: authn4.challengeId,
      response: authenticatorResponse(credId, authn4.options.challenge),
      sessionId: login.session.sessionId,
      userId,
    });
    expect(await auth.resolveSession(login.token)).toBeUndefined(); // rotated (F-12)
    expect((await auth.resolveSession(up.token as string))?.authLevel).toBe(2);

    expect(await auth.passkeys.rename(userId, summary.id, "Work laptop")).toBe(true);
    expect((await auth.passkeys.list(userId)).map((p) => p.label)).toEqual(["Work laptop"]);
    expect(
      await auth.passkeys.remove(userId, summary.id, { sessionId: login.session.sessionId }),
    ).toBe(true);
    expect(await auth.passkeys.list(userId)).toEqual([]);
    expect((await auth.resolveSession(up.token as string))?.user.mfaEnrolled).toBe(false);
  });
});

describe("OIDC (generic, PKCE + nonce)", () => {
  it("creates an invited user from a verified provider email and links the identity", async () => {
    const ws = await workspace("oidc");
    await invite(ws.id, "staff@acme.test", "staff", "admin");
    const oidc = auth.oidc;
    if (!oidc) throw new Error("oidc not configured");
    const redirectUri = `${ORIGIN}/auth/oidc/callback`;
    const begun = await oidc.begin({
      provider: "google",
      redirectUri,
      workspaceId: ws.id,
      returnTo: "/admin",
    });
    const url = new URL(begun.url);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(begun.state);
    idp.nextNonce = url.searchParams.get("nonce") as string;

    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "the-code");
    callback.searchParams.set("state", begun.state);
    const login = await oidc.complete({
      currentUrl: callback,
      bindingToken: begun.bindingToken,
      workspaceId: ws.id,
    });
    expect(login.isNewUser).toBe(true);
    expect(login.returnTo).toBe("/admin");
    // No `amr`/`acr` and no trust opt-in: an IdP login is one factor (F-04).
    expect(login.session.authLevel).toBe(1);
    expect(login.session.population).toBe("staff");
    expect(login.membership).toMatchObject({ kind: "staff", role: "admin", status: "active" });
    expect(idp.tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();
    expect((await auth.resolveSession(login.token))?.user.displayName).toBe("Staff Person");

    // State is single use.
    await expectAuthError(
      oidc.complete({ currentUrl: callback, bindingToken: begun.bindingToken, workspaceId: ws.id }),
      "oidc_failed",
    );

    // Second login: found by iss|sub even if the email changed at the provider.
    const again = await oidc.begin({ provider: "google", redirectUri, workspaceId: ws.id });
    idp.nextNonce = new URL(again.url).searchParams.get("nonce") as string;
    idp.user = { ...idp.user, email: "renamed@acme.test" };
    const cb2 = new URL(redirectUri);
    cb2.searchParams.set("code", "the-code");
    cb2.searchParams.set("state", again.state);
    const second = await oidc.complete({
      currentUrl: cb2,
      bindingToken: again.bindingToken,
      workspaceId: ws.id,
    });
    expect(second.session.userId).toBe(login.session.userId);
    expect(second.isNewUser).toBe(false);
  });

  it("refuses to auto-link an existing email account from an untrusted provider", async () => {
    const ws = await workspace("oidc2");
    await invite(ws.id, "existing@acme.test", "staff", "editor");
    await otpLogin(ws.id, "existing@acme.test");
    const oidc = auth.oidc as NonNullable<typeof auth.oidc>;
    const redirectUri = `${ORIGIN}/auth/oidc/callback`;
    const begun = await oidc.begin({ provider: "google", redirectUri, workspaceId: ws.id });
    idp.nextNonce = new URL(begun.url).searchParams.get("nonce") as string;
    idp.user = { sub: "google|999", email: "existing@acme.test", email_verified: true, name: "E" };
    const cb = new URL(redirectUri);
    cb.searchParams.set("code", "the-code");
    cb.searchParams.set("state", begun.state);
    const d = await expectAuthError(
      oidc.complete({ currentUrl: cb, bindingToken: begun.bindingToken, workspaceId: ws.id }),
      "oidc_failed",
    );
    expect(d["reason"]).toBe("link_required");

    // Wrong nonce / tampered token exchange fails closed.
    const b2 = await oidc.begin({ provider: "google", redirectUri, workspaceId: ws.id });
    idp.nextNonce = "not-the-nonce";
    const cb2 = new URL(redirectUri);
    cb2.searchParams.set("code", "the-code");
    cb2.searchParams.set("state", b2.state);
    await expectAuthError(
      oidc.complete({ currentUrl: cb2, bindingToken: b2.bindingToken, workspaceId: ws.id }),
      "oidc_failed",
    );
  });

  /** Begins a login and returns the callback URL the IdP would redirect to. */
  async function oidcRound(workspaceId: string) {
    const oidc = auth.oidc as NonNullable<typeof auth.oidc>;
    const redirectUri = `${ORIGIN}/auth/oidc/callback`;
    const begun = await oidc.begin({ provider: "google", redirectUri, workspaceId });
    idp.nextNonce = new URL(begun.url).searchParams.get("nonce") as string;
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "the-code");
    callback.searchParams.set("state", begun.state);
    return { oidc, begun, callback };
  }

  it("completes only in the browser that began the login (F-03, ASVS 10.1.2)", async () => {
    const ws = await workspace("oidc-bind");
    await invite(ws.id, "bind@acme.test", "staff", "editor");
    idp.user = { sub: "google|bind", email: "bind@acme.test", email_verified: true, name: "B" };
    const { oidc, begun, callback } = await oidcRound(ws.id);
    expect(begun.bindingToken.length).toBeGreaterThanOrEqual(20);
    expect(begun.bindingMaxAgeSeconds).toBe(600);

    // Another browser (no cookie, or its own cookie) is refused …
    const none = await expectAuthError(
      oidc.complete({ currentUrl: callback, workspaceId: ws.id }),
      "oidc_failed",
    );
    expect(none["reason"]).toBe("binding_mismatch");
    const other = await oidcRound(ws.id);
    const wrong = await expectAuthError(
      oidc.complete({
        currentUrl: callback,
        bindingToken: other.begun.bindingToken,
        workspaceId: ws.id,
      }),
      "oidc_failed",
    );
    expect(wrong["reason"]).toBe("binding_mismatch");
    // … and the refusal did not burn the state: the right browser still completes.
    idp.nextNonce = new URL(begun.url).searchParams.get("nonce") as string;
    const login = await oidc.complete({
      currentUrl: callback,
      bindingToken: begun.bindingToken,
      workspaceId: ws.id,
    });
    expect(login.session.userId).toBeTruthy();
  });

  it("grants level 2 only for an MFA amr/acr or an explicit trust opt-in (F-04)", async () => {
    const ws = await workspace("oidc-amr");
    await invite(ws.id, "amr@acme.test", "staff", "admin");
    idp.user = { sub: "google|amr", email: "amr@acme.test", email_verified: true, name: "A" };
    const levelWith = async (claims: Record<string, unknown>, flow = auth) => {
      idp.extraClaims = claims;
      const oidc = flow.oidc as NonNullable<typeof flow.oidc>;
      const redirectUri = `${ORIGIN}/auth/oidc/callback`;
      const begun = await oidc.begin({ provider: "google", redirectUri, workspaceId: ws.id });
      idp.nextNonce = new URL(begun.url).searchParams.get("nonce") as string;
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", "the-code");
      cb.searchParams.set("state", begun.state);
      const r = await oidc.complete({
        currentUrl: cb,
        bindingToken: begun.bindingToken,
        workspaceId: ws.id,
      });
      return r.session.authLevel;
    };
    try {
      expect(await levelWith({})).toBe(1);
      expect(await levelWith({ amr: ["pwd"] })).toBe(1);
      expect(await levelWith({ amr: ["hwk"] })).toBe(1);
      expect(await levelWith({ amr: ["pwd", "mfa"] })).toBe(2);
      expect(await levelWith({ amr: ["pwd", "otp"] })).toBe(2);
      expect(await levelWith({ acr: "urn:acme:loa:mfa" })).toBe(1); // not configured
      const configured = createAuthService(depsFor(), {
        passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] },
        password: { enabled: false },
        oidc: {
          providers: {
            google: {
              issuer: idp.issuer,
              clientId: idp.clientId,
              clientSecret: idp.clientSecret,
              mfaAcrValues: ["urn:acme:loa:mfa"],
            },
          },
          allowInsecureHttp: true,
        },
      });
      expect(await levelWith({ acr: "urn:acme:loa:mfa" }, configured)).toBe(2);
      expect(await levelWith({ acr: "urn:acme:loa:pwd" }, configured)).toBe(1);
      const trusted = createAuthService(depsFor(), {
        passkeys: { rpId: RP_ID, rpName: "x", origins: [ORIGIN] },
        password: { enabled: false },
        oidc: {
          providers: {
            google: {
              issuer: idp.issuer,
              clientId: idp.clientId,
              clientSecret: idp.clientSecret,
              trustMfa: true,
            },
          },
          allowInsecureHttp: true,
        },
      });
      expect(await levelWith({}, trusted)).toBe(2);
    } finally {
      idp.extraClaims = {};
    }
  });

  it("verifies the ID token signature against the IdP's JWKS (F-19, ASVS 6.8.2)", async () => {
    const ws = await workspace("oidc-sig");
    await invite(ws.id, "sig@acme.test", "staff", "editor");
    idp.user = { sub: "google|sig", email: "sig@acme.test", email_verified: true, name: "S" };
    const { oidc, begun, callback } = await oidcRound(ws.id);
    idp.forgeSignature = true;
    try {
      await expectAuthError(
        oidc.complete({
          currentUrl: callback,
          bindingToken: begun.bindingToken,
          workspaceId: ws.id,
        }),
        "oidc_failed",
      );
    } finally {
      idp.forgeSignature = false;
    }
    const ok = await oidcRound(ws.id);
    const login = await ok.oidc.complete({
      currentUrl: ok.callback,
      bindingToken: ok.begun.bindingToken,
      workspaceId: ws.id,
    });
    expect(login.session.userId).toBeTruthy();
  });
});

describe("invites, groups and revocation (§13.2 core)", () => {
  it("revoking a membership cascades to delegates, group rows and their invites", async () => {
    const ws = await workspace("revoke");
    const inv = await auth.invites.create({
      workspaceId: ws.id,
      email: "prin@fund.test",
      kind: "external",
      role: "investor",
      workspaceName: ws.name,
    });
    expect(lastMail().to).toBe("prin@fund.test");
    expect(lastMail().text).toContain(inv.url);
    expect(await auth.invites.resolve(ws.id, inv.token)).toMatchObject({
      valid: true,
      emailHint: "p***@fund.test",
      kind: "external",
    });
    // Re-inviting the same email supersedes the earlier token.
    const inv2 = await invite(ws.id, "prin@fund.test");
    expect(await auth.invites.resolve(ws.id, inv.token)).toEqual({ valid: false });
    expect((await auth.invites.resolve(ws.id, inv2.token)).valid).toBe(true);

    const principal = await otpLogin(ws.id, "prin@fund.test");
    const principalMembershipId = principal.membership?.id as string;
    await expectAuthError(invite(ws.id, "prin@fund.test"), "conflict");

    const ctx = systemContext(ws.id);
    const { delegateId, groupId } = await db.withTenant(ctx, async (tx) => {
      const memberships = new MembershipRepo(ctx, tx);
      const groups = new GroupRepo(ctx, tx);
      // Global rows are written in host context; a tenant context may not create users.
      const delegateUser = await db.withHost((htx) =>
        htx.execute<{ id: string }>(
          sql`INSERT INTO core."user" (display_name) VALUES ('Delegate') RETURNING id`,
        ),
      );
      const delegate = await memberships.create({
        userId: delegateUser.rows[0]?.id as string,
        kind: "external",
        role: "delegate",
        status: "active",
        source: "invite",
        principalMembershipId,
        delegateScope: "all",
      });
      const g = await groups.create({ name: "Seed investors", kind: "round" });
      await groups.addMember(g.id, principalMembershipId);
      await groups.addMember(g.id, delegate.id);
      expect(await groups.groupIdsFor(principalMembershipId)).toEqual([g.id]);
      return { delegateId: delegate.id, groupId: g.id };
    });
    const byPrincipal = await db.withTenant(ctx, (tx) =>
      new (class extends MembershipRepo {})(ctx, tx)
        .create({
          userId: principal.session.userId,
          kind: "external",
          role: "investor",
          status: "active",
          source: "test",
        })
        .catch((e: unknown) => e),
    );
    expect(byPrincipal).toBeInstanceOf(Error); // one active membership per (workspace, user)

    const revoked = await auth.invites.revokeMembership({
      workspaceId: ws.id,
      membershipId: principalMembershipId,
      reason: "offboarded",
    });
    expect([...revoked].sort()).toEqual([principalMembershipId, delegateId].sort());
    await auth.revokeSessionsForWorkspace(principal.session.userId, ws.id, "membership_revoked");
    expect(await auth.resolveSession(principal.token)).toBeUndefined();

    await db.withTenant(ctx, async (tx) => {
      const groups = new GroupRepo(ctx, tx);
      expect(await groups.membersOf(groupId)).toEqual([]);
      const rows = await tx.execute<{ status: string; revoke_reason: string | null }>(
        sql`SELECT status, revoke_reason FROM core.membership ORDER BY created_at`,
      );
      expect(rows.rows.map((r) => [r.status, r.revoke_reason])).toEqual([
        ["revoked", "offboarded"],
        ["revoked", "principal_revoked"],
      ]);
    });
    // A revoked member can no longer start a login.
    const before = sent.length;
    await auth.emailOtp.start({ email: "prin@fund.test", workspaceId: ws.id });
    expect(sent.length).toBe(before);
    expect(await auth.listMemberships(principal.session.userId)).toEqual([]);

    // E0.4: revocation is audited in the workspace chain and published for subscribers.
    const rows = await auditRows(ws.id);
    const revokedRow = rows.find((r) => r.action === "membership.revoked");
    expect(revokedRow).toMatchObject({
      actor_kind: "system",
      subject_membership_id: principalMembershipId,
      meta: { reason: "offboarded" },
    });
    expect(((revokedRow?.meta["membershipIds"] ?? []) as string[]).sort()).toEqual(
      [principalMembershipId, delegateId].sort(),
    );
    expect(rows.at(-1)?.action).toBe("auth.sessions_revoked_workspace");
    const events = await outboxTopics(ws.id);
    expect(events.filter((e) => e.topic === "membership.revoked")).toHaveLength(1);
    expect(events.find((e) => e.topic === "membership.revoked")?.payload).toMatchObject({
      reason: "offboarded",
      byMembershipId: null,
    });
    expect(
      (await outboxTopics(null)).filter((e) => e.topic === "session.revoked"),
    ).not.toHaveLength(0);
    expect(await verifyWorkspace({ db }, ws.id)).toMatchObject({ ok: true });
  });
});

describe("row-level security on identity tables", () => {
  it("tenant contexts see only their own user's sessions/credentials and members' users", async () => {
    const a = await workspace("rls-a");
    const b = await workspace("rls-b");
    await invite(a.id, "ann@example.test");
    await invite(b.id, "ben@example.test");
    const ann = await otpLogin(a.id, "ann@example.test");
    const ben = await otpLogin(b.id, "ben@example.test");

    const count = async (ctx: Parameters<Database["withTenant"]>[0], table: string) =>
      db.withTenant(ctx, async (tx) => {
        const r = await tx.execute<{ n: number }>(
          sql.raw(`SELECT count(*)::int AS n FROM core.${table}`),
        );
        return r.rows[0]?.n;
      });
    const asAnn = {
      workspaceId: a.id,
      actorKind: "external" as const,
      membershipId: ann.membership?.id as string,
      userId: ann.session.userId,
    };
    expect(await count(asAnn, "session")).toBe(1);
    expect(await count(asAnn, "device")).toBe(1);
    expect(await count(asAnn, "membership")).toBe(1);
    expect(await count(asAnn, '"user"')).toBe(1); // herself (member of a); ben is invisible
    expect(await count(asAnn, "user_identity")).toBe(1);
    expect(await count(asAnn, "auth_challenge")).toBeGreaterThan(0);

    // A system job in workspace b sees b's member (ben) but no sessions at all.
    expect(await count(systemContext(b.id), '"user"')).toBe(1);
    expect(await count(systemContext(b.id), "session")).toBe(0);
    expect(await count(systemContext(b.id), "membership")).toBe(1);

    // Ann cannot write another user's session row even with a valid user id.
    await expect(
      db.withTenant(asAnn, (tx) =>
        tx.execute(
          sql`UPDATE core.session SET revoked_at = now() WHERE user_id = ${ben.session.userId}`,
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    // Host context lists memberships only for the named user.
    const mine = await db.withHost(
      async (tx) =>
        (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM core.membership`))
          .rows[0]?.n,
      { actorKind: "host", userId: ann.session.userId },
    );
    expect(mine).toBe(1);
    const none = await db.withHost(
      async (tx) =>
        (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM core.membership`))
          .rows[0]?.n,
    );
    expect(none).toBe(0);
  });
});

describe("Postgres rate limiter", () => {
  it("counts across the sliding window and resets", async () => {
    const rl = createPostgresRateLimiter(db, { now: () => clock });
    const rule = { max: 2, windowMs: 60_000 };
    expect((await rl.hit("k", rule)).allowed).toBe(true);
    expect((await rl.hit("k", rule)).allowed).toBe(true);
    expect((await rl.hit("k", rule)).allowed).toBe(false);
    expect((await rl.peek("k", rule)).allowed).toBe(false);
    await rl.reset("k");
    expect((await rl.peek("k", rule)).allowed).toBe(true);
    tick(2 * 60_000);
    expect((await rl.hit("k", rule)).allowed).toBe(true);
    expect(await rl.sweep(0)).toBeGreaterThanOrEqual(0);
  });

  it("multiplies every ceiling by RATE_LIMIT_MULTIPLIER (E2.10)", async () => {
    const rl = createPostgresRateLimiter(db, { now: () => clock, multiplier: 3 });
    const rule = { max: 2, windowMs: 60_000 };
    for (let i = 0; i < 6; i++) expect((await rl.hit("k-mult", rule)).allowed).toBe(true);
    expect((await rl.peek("k-mult", rule)).allowed).toBe(false);
    expect((await rl.hit("k-mult", rule)).allowed).toBe(false);
    await rl.reset("k-mult");
  });
});

/*
 * Share-link admission (E2.3). The link package is not imported here — identity only knows the
 * structural `ShareLinkAccess` it declares — so the stub below plays the part `@fundroom/share-links`
 * plays in production, including writing the `core.share_link_visit` row.
 *
 * That row is the point of the test. It is an authorization edge: `PrincipalRepo` walks it to emit
 * the `link` grant subject, so an `external` member who could insert one would grant themselves
 * every capability the link carries without holding the token, the passcode or the OTP. RLS
 * therefore gives `external` **no** INSERT policy on the table (contract A5), and
 * `establishMembership` must write it under the `system` context. Under the visitor's own context
 * this test fails — and in production it would fail the quiet way, with the visitor admitted and
 * the link's grants never materialising.
 */
async function mintLink(
  workspaceId: string,
  policy: { domains?: string[]; groupIds?: string[] } = {},
): Promise<string> {
  const ctx = systemContext(workspaceId);
  return db.withTenant(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO core.share_link (workspace_id, label, token_hash, policy, group_ids)
      VALUES (
        ${workspaceId},
        'Series A room',
        ${createHash("sha256").update(randomBytes(16)).digest()},
        ${JSON.stringify({ domains: policy.domains ?? [], emails: [], forceWatermark: false })}::jsonb,
        ${sql.raw(`ARRAY[${(policy.groupIds ?? []).map((g) => `'${g}'::uuid`).join(",")}]::uuid[]`)}
      )
      RETURNING id
    `);
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error("no link");
    return id;
  });
}

async function visitRows(workspaceId: string, linkId: string): Promise<number> {
  // Read under the tenant's own system context: `core.share_link_visit` is fenced, so a host
  // connection sees zero rows whether or not the insert happened.
  return db.withTenant(
    systemContext(workspaceId),
    async (tx) =>
      (
        await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM core.share_link_visit
          WHERE workspace_id = ${workspaceId} AND link_id = ${linkId} AND revoked_at IS NULL
        `)
      ).rows[0]?.n ?? 0,
  );
}

function stubShareLinks(admitDomain: string, groupIds: readonly string[] = []): ShareLinkAccess {
  return {
    async admits(_ctx, _tx, _linkId, email) {
      return email.endsWith(`@${admitDomain}`);
    },
    async bind(ctx, tx, input) {
      // The whole point of A5: writing this row IS granting access, so it may only happen under a
      // context that is allowed to grant. A visitor's own `external` context matches no INSERT
      // policy and would affect zero rows.
      expect(ctx.actorKind).toBe("system");
      await tx.execute(sql`
        INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id)
        VALUES (${ctx.workspaceId}, ${input.linkId}, ${input.membershipId})
        ON CONFLICT (link_id, membership_id) DO UPDATE SET revoked_at = NULL
      `);
      await tx.execute(sql`
        UPDATE core.share_link SET uses = uses + 1 WHERE id = ${input.linkId}
      `);
      return { groupIds: [...groupIds], grants: [] };
    },
  };
}

describe("share-link admission (E2.3)", () => {
  it("admits an address the link's policy names, and only that address", async () => {
    const ws = await workspace("sl-admit");
    const linkId = await mintLink(ws.id, { domains: ["fund.test"] });
    shareLinksStub = stubShareLinks("fund.test");
    try {
      const before = sent.length;
      // No link named: eligibility is unchanged, so nothing is sent to a stranger.
      await auth.emailOtp.start({ email: "pat@fund.test", workspaceId: ws.id });
      expect(sent.length).toBe(before);

      // The same address, through the link, is admitted by the link's own domain policy.
      await auth.emailOtp.start({ email: "pat@fund.test", workspaceId: ws.id, linkId });
      expect(sent.length).toBe(before + 1);

      // An address the link does not name gets nothing, and the response is the same shape.
      const r = await auth.emailOtp.start({
        email: "mallory@evil.test",
        workspaceId: ws.id,
        linkId,
      });
      expect(r.status).toBe("sent");
      expect(sent.length).toBe(before + 1);
    } finally {
      shareLinksStub = undefined;
    }
  });

  it("creates the membership, writes the visit row under system context, and applies groups", async () => {
    const ws = await workspace("sl-redeem");
    const ctx = systemContext(ws.id);
    const group = await db.withTenant(ctx, (tx) =>
      new GroupRepo(ctx, tx).create({ name: "Series A", kind: "custom" }),
    );
    const linkId = await mintLink(ws.id, { domains: ["fund.test"] });
    shareLinksStub = stubShareLinks("fund.test", [group.id]);
    try {
      expect(await visitRows(ws.id, linkId)).toBe(0);

      await auth.emailOtp.start({ email: "sam@fund.test", workspaceId: ws.id, linkId });
      const result = await auth.emailOtp.verify({
        email: "sam@fund.test",
        code: codeFrom(lastMail()),
        workspaceId: ws.id,
        linkId,
      });

      expect(result.membership?.kind).toBe("external");
      expect(result.membership?.role).toBe("investor");
      expect(result.session.authLevel).toBe(1);

      // The row itself, not merely that `bind` returned.
      expect(await visitRows(ws.id, linkId)).toBe(1);

      const membershipId = result.membership?.id ?? "";
      const row = await db.withTenant(ctx, async (tx) => {
        const rows = await tx.execute<{ source: string | null }>(sql`
          SELECT source FROM core.membership WHERE id = ${membershipId}
        `);
        return rows.rows[0];
      });
      expect(row?.source).toBe(`link:${linkId}`);

      const members = await db.withTenant(ctx, (tx) => new GroupRepo(ctx, tx).membersOf(group.id));
      expect(members.map((m) => m.membershipId)).toContain(membershipId);
    } finally {
      shareLinksStub = undefined;
    }
  });

  it("refuses a code minted for one link when it is presented against another", async () => {
    const ws = await workspace("sl-binding");
    const linkA = await mintLink(ws.id, { domains: ["fund.test"] });
    const linkB = await mintLink(ws.id, { domains: ["fund.test"] });
    shareLinksStub = stubShareLinks("fund.test");
    try {
      await auth.emailOtp.start({ email: "eve@fund.test", workspaceId: ws.id, linkId: linkA });
      const code = codeFrom(lastMail());
      // Link B may have a passcode link A does not; a transferable code would bypass it.
      await expect(
        auth.emailOtp.verify({ email: "eve@fund.test", code, workspaceId: ws.id, linkId: linkB }),
      ).rejects.toThrow();
      expect(await visitRows(ws.id, linkB)).toBe(0);
    } finally {
      shareLinksStub = undefined;
    }
  });

  it("refuses a link-bound code at the ordinary sign-in page, which names no link", async () => {
    const ws = await workspace("sl-unbound");
    const linkId = await mintLink(ws.id, { domains: ["fund.test"] });
    shareLinksStub = stubShareLinks("fund.test");
    try {
      await auth.emailOtp.start({ email: "ida@fund.test", workspaceId: ws.id, linkId });
      const code = codeFrom(lastMail());
      await expect(
        auth.emailOtp.verify({ email: "ida@fund.test", code, workspaceId: ws.id }),
      ).rejects.toThrow();
    } finally {
      shareLinksStub = undefined;
    }
  });
});

// --- Security hardening -------------------------------------------------------------------------

describe("E2.10 review fixes (R1-01..R1-05, R1-A5)", () => {
  it("removing a password needs the current one unless the session is level 2 (R1-01)", async () => {
    const ws = await workspace("r1-pw");
    await invite(ws.id, "pwrm@acme.test", "staff", "editor");
    // A mailbox thief's session: an email code, level 1, fresh; the user has no second factor.
    const login = await otpLogin(ws.id, "pwrm@acme.test");
    const userId = login.session.userId;
    const context = { sessionId: login.session.sessionId };
    await auth.password.set({ userId, password: "victim password 1234", context });

    // The F-20 bypass: DELETE then PUT. The DELETE is now refused without the password…
    await expectAuthError(auth.password.remove({ userId, context }), "invalid_request");
    await expectAuthError(
      auth.password.remove({ userId, currentPassword: "a wrong guess!!", context }),
      "invalid_credential",
    );
    await expectAuthError(
      auth.password.remove({ userId, sessionAuthLevel: 1, context }),
      "invalid_request",
    );
    expect(await auth.password.has(userId)).toBe(true);
    // …so the PUT still has something to check.
    await expectAuthError(
      auth.password.set({ userId, password: "attacker password 1234", context }),
      "invalid_request",
    );
    const denied = await pg.pool.query(
      "SELECT 1 FROM audit.event WHERE workspace_id = $1 AND actor_user_id = $2 AND action = 'auth.step_up' AND outcome = 'denied'",
      [PLATFORM_WORKSPACE_ID, userId],
    );
    expect(denied.rowCount).toBe(1); // the wrong guess is audited like any failed proof

    // The rightful owner, who knows it, can remove it.
    await auth.password.remove({ userId, currentPassword: "victim password 1234", context });
    expect(await auth.password.has(userId)).toBe(false);
    // No password: nothing to prove, nothing happens.
    await auth.password.remove({ userId, context });

    // A level-2 session (a second factor proved) may remove it without: the forgotten-password path.
    await auth.password.set({ userId, password: "another password 1234", context });
    await auth.password.remove({ userId, sessionAuthLevel: 2, context });
    expect(await auth.password.has(userId)).toBe(false);
  });

  it("the identity sweep deletes sign-in challenges a while after they expired (R1-02)", async () => {
    const ws = await workspace("r1-sweep");
    const decoys = ["gone1@nowhere.test", "gone2@nowhere.test", "gone3@nowhere.test"];
    for (const email of decoys) await auth.emailOtp.start({ email, workspaceId: ws.id });
    const count = async (emails: string[]) =>
      Number(
        (
          await pg.pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM core.auth_challenge WHERE email = ANY($1)",
            [emails],
          )
        ).rows[0]?.n,
      );
    expect(await count(decoys)).toBe(3); // decoy rows hold the address and the IP (P2-02)

    // Expired (10 min) but inside the retention: kept.
    tick(30 * 60_000);
    await runIdentitySweep({ db, sessions: auth.sessions, now: () => clock });
    expect(await count(decoys)).toBe(3);

    // A fresh challenge started now must survive the next sweep.
    await auth.emailOtp.start({ email: "fresh@nowhere.test", workspaceId: ws.id });
    tick(CHALLENGE_RETENTION_MS);
    const swept = await runIdentitySweep({ db, sessions: auth.sessions, now: () => clock });
    expect(swept.challenges).toBeGreaterThanOrEqual(3);
    expect(await count(decoys)).toBe(0);
    expect(await count(["fresh@nowhere.test"])).toBe(1);
  });

  it("a slow or failing mailer shows neither in the answer nor in the time it takes (R1-03)", async () => {
    const ws = await workspace("r1-mail");
    await invite(ws.id, "slow@acme.test");
    mailerDelayMs = 2_000;
    try {
      const t0 = performance.now();
      const known = await auth.emailOtp.start({
        email: "slow@acme.test",
        workspaceId: ws.id,
        ip: "198.51.100.40",
      });
      const knownMs = performance.now() - t0;
      const t1 = performance.now();
      const unknown = await auth.emailOtp.start({
        email: "nobody-slow@acme.test",
        workspaceId: ws.id,
        ip: "198.51.100.41",
      });
      const unknownMs = performance.now() - t1;
      expect(known.status).toBe("sent");
      expect(unknown.status).toBe("sent");
      // The relay takes 2 s; the known address must not wait for it.
      expect(knownMs).toBeLessThan(1_000);
      expect(Math.abs(knownMs - unknownMs)).toBeLessThan(750);
      expect(lastMail().to).toBe("slow@acme.test"); // and the mail was still handed over
    } finally {
      mailerDelayMs = 0;
    }
  });

  it("concurrent step-ups on one session leave the browser a live token (R1-04)", async () => {
    const ws = await workspace("r1-race");
    await invite(ws.id, "stepup-race@acme.test");
    const login = await otpLogin(ws.id, "stepup-race@acme.test");
    const sessionId = login.session.sessionId;
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        auth.sessions.stepUp(sessionId, 2, "totp", { presentedToken: login.token }),
      ),
    );
    const issued = results.map((r) => r.token).filter((t): t is string => t !== undefined);
    // Exactly one rotation: every response either carries the live token or none at all, so
    // whichever order the browser applies them in, its cookie works.
    expect(issued).toHaveLength(1);
    expect((await auth.resolveSession(issued[0] as string))?.authLevel).toBe(2);
    expect(await auth.resolveSession(login.token)).toBeUndefined(); // F-12 still holds

    // Sequential step-ups each rotate, as before.
    const again = await auth.sessions.stepUp(sessionId, 2, "totp", {
      presentedToken: issued[0],
    });
    expect(again.token).toBeDefined();
    expect(await auth.resolveSession(issued[0] as string)).toBeUndefined();
    expect(await auth.resolveSession(again.token as string)).toBeDefined();
  });

  it("a step-up waits for a rotation in flight and does not overwrite its token (R1-04)", async () => {
    const ws = await workspace("r1-race-lock");
    await invite(ws.id, "stepup-lock@acme.test");
    const login = await otpLogin(ws.id, "stepup-lock@acme.test");
    const sessionId = login.session.sessionId;
    // Another step-up of the same browser is mid-commit: the row holds its new hash, uncommitted.
    const winner = randomBytes(32).toString("base64url");
    const client = await pg.pool.connect();
    let loser: Awaited<ReturnType<AuthService["sessions"]["stepUp"]>>;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE core.session SET token_hash = $1, auth_level = 2 WHERE id = $2", [
        createHash("sha256").update(winner).digest(),
        sessionId,
      ]);
      const pending = auth.sessions.stepUp(sessionId, 2, "totp", { presentedToken: login.token });
      await new Promise((r) => setTimeout(r, 300));
      await client.query("COMMIT");
      loser = await pending;
    } finally {
      client.release();
    }
    // Without the row lock the loser read the old hash, rotated again and killed the winner's.
    expect(loser.token).toBeUndefined();
    expect(await auth.resolveSession(winner)).toBeDefined();
  });

  it("a security key without user verification can unlock factor management, only for its session (R1-05)", async () => {
    const ws = await workspace("r1-uvless");
    await invite(ws.id, "key@acme.test", "staff", "editor");
    const login = await otpLogin(ws.id, "key@acme.test");
    const userId = login.session.userId;
    const reg = await auth.passkeys.beginRegistration({ userId });
    const credId = randomBytes(16).toString("base64url");
    await auth.passkeys.finishRegistration({
      userId,
      challengeId: reg.challengeId,
      response: authenticatorResponse(credId, reg.options.challenge),
      context: { sessionId: login.session.sessionId },
    });
    expect(await auth.hasSecondFactor(userId)).toBe(true);

    // An email-code session: no factor proved, no factor management (P2-01 unchanged).
    const mailbox = await otpLogin(ws.id, "key@acme.test");
    const session = { userId, sessionId: mailbox.session.sessionId, authLevel: 1 };
    expect(await auth.canManageFactors(session)).toBe(false);

    // Step up with the key, no PIN: the session stays level 1 (it is not MFA)…
    const authn = await auth.passkeys.beginAuthentication({});
    const up = await auth.passkeys.finishStepUp({
      challengeId: authn.challengeId,
      response: authenticatorResponse(credId, authn.options.challenge, false),
      sessionId: mailbox.session.sessionId,
      userId,
      presentedToken: mailbox.token,
    });
    expect((await auth.resolveSession(up.token as string))?.authLevel).toBe(1);
    // …but it proved the enrolled key, so this session may now manage factors.
    expect(await auth.canManageFactors(session)).toBe(true);
    // Not another session of the same user, and not after the step-up window.
    const other = await otpLogin(ws.id, "key@acme.test");
    expect(
      await auth.canManageFactors({ userId, sessionId: other.session.sessionId, authLevel: 1 }),
    ).toBe(false);
    tick(11 * 60_000);
    expect(await auth.canManageFactors(session)).toBe(false);
    // Level 2 and "no second factor" behave as before.
    expect(await auth.canManageFactors({ ...session, authLevel: 2 })).toBe(true);
  });

  it("two owners demoting each other at once cannot leave the workspace with none (R1-A5)", async () => {
    const ws = await workspace("r1-owners");
    await invite(ws.id, "own-a@acme.test", "staff", "owner");
    await invite(ws.id, "own-b@acme.test", "staff", "owner");
    const a = await otpLogin(ws.id, "own-a@acme.test");
    const b = await otpLogin(ws.id, "own-b@acme.test");
    const aId = a.membership?.id as string;
    const bId = b.membership?.id as string;
    const ctx = systemContext(ws.id);

    // Owner B's demotion of A is in flight: A's row is updated but not yet committed.
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE core.membership SET role = 'admin' WHERE id = $1", [aId]);
      // Meanwhile owner A demotes B. Without the owner lock A counts two owners (B's change is
      // not committed) and goes ahead; with it, A waits for B's transaction to end.
      const demoteB = auth.memberships.update(
        ctx,
        bId,
        { role: "admin" },
        { membershipId: aId, userId: a.session.userId, role: "owner" },
      );
      const settled = demoteB.then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );
      const early = await Promise.race([
        settled,
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 500)),
      ]);
      expect(early).toBe("pending");
      await client.query("COMMIT");
      await expectAuthError(demoteB, "invalid_request");
    } finally {
      client.release();
    }
    const owners = await pg.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM core.membership WHERE workspace_id = $1 AND role = 'owner' AND status <> 'revoked'",
      [ws.id],
    );
    expect(Number(owners.rows[0]?.n)).toBe(1);
  });
});

describe("E3.2: expired memberships and invitation grants at acceptance", () => {
  it("a kind the kernel cannot look up is granted without the stored path", async () => {
    // No module owns `widget` here, so the resolver answers `unchecked`: the grant is written
    // matched by id, and the path the invitation row carried — a scope nobody can check — is not.
    const ws = await workspace("e32-unchecked");
    const widgetId = "01920000-0000-7000-8000-0000000000e1";
    await auth.invites.create({
      workspaceId: ws.id,
      email: "widget@example.test",
      kind: "external",
      role: "investor",
      grants: [{ resource: { kind: "widget", id: widgetId, path: "r" }, capabilities: ["view"] }],
      send: false,
    });
    const login = await otpLogin(ws.id, "widget@example.test");
    const rows = await pg.pool.query<{ resource_path: string | null }>(
      "SELECT resource_path::text FROM core.access_grant WHERE subject_id = $1 AND revoked_at IS NULL",
      [login.membership?.id],
    );
    expect(rows.rows).toEqual([{ resource_path: null }]);
    const created = (await auditRows(ws.id)).find((r) => r.action === "membership.created");
    expect(created?.meta).toMatchObject({ grants: 1, grantsDropped: 0 });
  });

  it("OTP verify refuses an expired membership after the code is proven, and audits why", async () => {
    const ws = await workspace("e32-expired");
    await invite(ws.id, "late@example.test");
    const first = await otpLogin(ws.id, "late@example.test");
    const membershipId = first.membership?.id as string;
    await pg.pool.query("UPDATE core.membership SET expires_at = $2 WHERE id = $1", [
      membershipId,
      new Date(clock.getTime() - 1000),
    ]);
    await expectAuthError(otpLogin(ws.id, "late@example.test"), "membership_expired");
    const failed = (await auditRows(ws.id)).filter((r) => r.action === "auth.login_failed");
    expect(failed.at(-1)?.meta).toEqual({ method: "email_otp", reason: "membership_expired" });
    // The host (no workspace) refuses too: this user's only membership has ended.
    await expectAuthError(
      (async () => {
        await auth.emailOtp.start({ email: "late@example.test" });
        return auth.emailOtp.verify({ email: "late@example.test", code: codeFrom(lastMail()) });
      })(),
      "membership_expired",
    );
    await pg.pool.query("UPDATE core.membership SET expires_at = NULL WHERE id = $1", [
      membershipId,
    ]);
    expect((await otpLogin(ws.id, "late@example.test")).membership?.id).toBe(membershipId);
  });
});

describe("E3.10 FR1: session caps by population and binding, derived sessions (R1-L1, R2-M2, R2-L1)", () => {
  async function userIn(slug: string, email: string) {
    const ws = await workspace(slug);
    await invite(ws.id, email, "staff", "editor");
    const login = await otpLogin(ws.id, email);
    return { ws, userId: login.session.userId, first: login };
  }
  const mint = (
    userId: string,
    population: "staff" | "external" | "operator",
    extra: { workspaceId?: string; boundWorkspaceId?: string; sourceSessionId?: string } = {},
  ) => {
    tick(1_000); // least-recently-seen order is the mint order
    return auth.sessions.startSession({
      userId,
      population,
      context: "first_party",
      authLevel: population === "operator" ? 2 : 1,
      ...extra,
    });
  };
  const live = async (token: string) => (await auth.resolveSession(token)) !== undefined;

  it("an operator mint never evicts a staff session, and staff logins never evict operator sessions", async () => {
    const { userId, first } = await userIn("cap-op", "op-cap@acme.test");
    const staff: { token: string }[] = [first];
    for (let i = 0; i < 2; i++) staff.push(await mint(userId, "staff"));
    // Four operator mints: the operator cap (3) evicts the oldest OPERATOR session only.
    const ops = [];
    for (let i = 0; i < 4; i++) ops.push(await mint(userId, "operator"));
    for (const s of staff) expect(await live(s.token)).toBe(true);
    expect(await live(ops[0]?.token as string)).toBe(false);
    for (const o of ops.slice(1)) expect(await live(o.token)).toBe(true);
    // Staff logins up to and past the staff cap (10) never touch the operator sessions.
    for (let i = 0; i < 9; i++) staff.push(await mint(userId, "staff"));
    for (const o of ops.slice(1)) expect(await live(o.token)).toBe(true);
    expect(await live(staff[0]?.token as string)).toBe(false); // 12 staff → the 2 oldest went
    expect(await live(staff[1]?.token as string)).toBe(false);
    expect(await live(staff[2]?.token as string)).toBe(true);
  });

  it("bound sessions have their own cap per workspace and never evict the canonical session", async () => {
    const { ws, userId, first } = await userIn("cap-bound", "bound-cap@acme.test");
    const other = await workspace("cap-bound-b");
    const inOther = await mint(userId, "staff", {
      workspaceId: other.id,
      boundWorkspaceId: other.id,
    });
    const bound = [];
    for (let i = 0; i < 4; i++) {
      bound.push(await mint(userId, "staff", { workspaceId: ws.id, boundWorkspaceId: ws.id }));
    }
    // The fourth handoff for (user, ws) replaced the oldest; the canonical session and the
    // other workspace's bound session are untouched.
    expect(await live(bound[0]?.token as string)).toBe(false);
    for (const b of bound.slice(1)) expect(await live(b.token)).toBe(true);
    expect(await live(first.token)).toBe(true);
    expect(await live(inOther.token)).toBe(true);
    // Unbound staff logins up to the cap do not count the bound sessions either.
    const unbound = [];
    for (let i = 0; i < 9; i++) unbound.push(await mint(userId, "staff"));
    expect(await live(first.token)).toBe(true); // 1 + 9 = 10 unbound: at the cap, none evicted
    for (const b of bound.slice(1)) expect(await live(b.token)).toBe(true);
  });

  it("revoking a source session revokes the sessions minted from it; a replaced one does not", async () => {
    const { ws, userId, first } = await userIn("derived", "derived@acme.test");
    const handoff = await mint(userId, "staff", {
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      sourceSessionId: first.session.sessionId,
    });
    const op = await mint(userId, "operator", { sourceSessionId: first.session.sessionId });
    const unrelated = await mint(userId, "staff", { workspaceId: ws.id, boundWorkspaceId: ws.id });
    await auth.revokeSession(first.session.sessionId, "logout");
    expect(await live(first.token)).toBe(false);
    expect(await live(handoff.token)).toBe(false);
    expect(await live(op.token)).toBe(false);
    expect(await live(unrelated.token)).toBe(true);
    const rows = await db.withHost((tx) =>
      tx.execute<{ revoked_reason: string }>(
        sql`SELECT revoked_reason FROM core.session WHERE id = ${handoff.session.sessionId}`,
      ),
    );
    expect(rows.rows[0]?.revoked_reason).toBe("source_revoked");
  });

  it("FR3 RR1-M2: a same-user re-login re-parents what the old session handed out; logging the new one out ends it", async () => {
    const { userId } = await userIn("reparent", "reparent@acme.test");
    // S1 → O1 (an operator session minted from S1, level 2); re-login (level 2) → S2.
    tick(1_000);
    const s1 = await auth.sessions.startSession({
      userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
    });
    const o1 = await mint(userId, "operator", { sourceSessionId: s1.session.sessionId });
    tick(1_000);
    const s2 = await auth.sessions.startSession({
      userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
      replacesSessionId: s1.session.sessionId,
    });
    expect(await live(s1.token)).toBe(false);
    expect(await live(o1.token)).toBe(true); // kept across the re-login…
    await auth.revokeSession(s2.session.sessionId, "logout");
    expect(await live(o1.token)).toBe(false); // …and ended by signing S2 out
  });

  it("FR3 RR1-M2: another user's login replacing a session revokes what that session handed out", async () => {
    const { ws, userId } = await userIn("replace-other", "victim@acme.test");
    const other = await userIn("replace-other-b", "intruder@acme.test");
    const s1 = await mint(userId, "staff");
    const child = await mint(userId, "staff", {
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      sourceSessionId: s1.session.sessionId,
    });
    tick(1_000);
    await auth.sessions.startSession({
      userId: other.userId,
      population: "staff",
      context: "first_party",
      authLevel: 1,
      replacesSessionId: s1.session.sessionId,
    });
    expect(await live(s1.token)).toBe(false);
    expect(await live(child.token)).toBe(false);
  });

  it("FR3 RR1-L1: a session evicted by the concurrent cap takes its derived sessions with it", async () => {
    const { ws, userId, first } = await userIn("cap-derived", "cap-derived@acme.test");
    const child = await mint(userId, "staff", {
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      sourceSessionId: first.session.sessionId,
    });
    // Ten more unbound staff sessions: the cap (10) evicts the oldest, `first`.
    for (let i = 0; i < 10; i++) await mint(userId, "staff");
    expect(await live(first.token)).toBe(false);
    expect(await live(child.token)).toBe(false);
  });

  it("FR3 RR1-L2: a workspace revocation spares operator and canonical sessions not tied to it", async () => {
    const { ws, userId, first } = await userIn("ws-rev", "ws-rev@acme.test");
    const canonicalOnly = await mint(userId, "staff"); // no workspace served yet
    const op = await mint(userId, "operator");
    const boundHere = await mint(userId, "staff", { workspaceId: ws.id, boundWorkspaceId: ws.id });
    const other = await workspace("ws-rev-b");
    const boundThere = await mint(userId, "staff", {
      workspaceId: other.id,
      boundWorkspaceId: other.id,
    });
    await auth.revokeSessionsForWorkspace(userId, ws.id, "membership_revoked");
    expect(await live(first.token)).toBe(false); // used on ws
    expect(await live(boundHere.token)).toBe(false);
    expect(await live(canonicalOnly.token)).toBe(true);
    expect(await live(op.token)).toBe(true);
    expect(await live(boundThere.token)).toBe(true);
  });
  it("FR4: an operator session moves only onto a canonical level-2 login; otherwise it is revoked", async () => {
    const { ws, userId } = await userIn("fr4-elig", "fr4-elig@acme.test");
    const start = (extra: Record<string, unknown>) => {
      tick(1_000);
      return auth.sessions.startSession({
        userId,
        population: "staff",
        context: "first_party",
        authLevel: 2,
        ...extra,
      });
    };
    // Replaced by a level-1 login: the operator session goes, the bound handoff moves.
    const s1 = await start({});
    const o1 = await mint(userId, "operator", { sourceSessionId: s1.session.sessionId });
    const h1 = await mint(userId, "staff", {
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      sourceSessionId: s1.session.sessionId,
    });
    const s2 = await start({ authLevel: 1, replacesSessionId: s1.session.sessionId });
    expect(await live(o1.token)).toBe(false);
    expect(await live(h1.token)).toBe(true);
    const [row] = (
      await db.withHost((tx) =>
        tx.execute<{ revoked_reason: string }>(
          sql`SELECT revoked_reason FROM core.session WHERE id = ${o1.session.sessionId}`,
        ),
      )
    ).rows;
    expect(row?.revoked_reason).toBe("source_revoked");
    await auth.revokeSession(s2.session.sessionId, "logout");
    expect(await live(h1.token)).toBe(false); // moved onto s2, so ended with it

    // Replaced by a workspace-bound login (level 2): the operator session goes too.
    const s3 = await start({});
    const o3 = await mint(userId, "operator", { sourceSessionId: s3.session.sessionId });
    await start({
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      replacesSessionId: s3.session.sessionId,
    });
    expect(await live(o3.token)).toBe(false);

    // Replaced by a canonical level-2 login: it moves.
    const s4 = await start({});
    const o4 = await mint(userId, "operator", { sourceSessionId: s4.session.sessionId });
    await start({ replacesSessionId: s4.session.sessionId });
    expect(await live(o4.token)).toBe(true);
  });

  it("FR4: bulk revocations (by workspace, by device) take the derived sessions with them", async () => {
    const { ws, userId, first } = await userIn("fr4-bulk", "fr4-bulk@acme.test");
    // `first` served ws; an operator session minted from it.
    const op = await mint(userId, "operator", { sourceSessionId: first.session.sessionId });
    await auth.revokeSessionsForWorkspace(userId, ws.id, "membership_revoked");
    expect(await live(first.token)).toBe(false);
    expect(await live(op.token)).toBe(false);

    const src = await mint(userId, "staff");
    const child = await mint(userId, "staff", {
      workspaceId: ws.id,
      boundWorkspaceId: ws.id,
      sourceSessionId: src.session.sessionId,
    });
    expect(await auth.sessions.revokeDevice(userId, src.session.deviceId as string)).toBe(true);
    expect(await live(src.token)).toBe(false);
    expect(await live(child.token)).toBe(false);
  });
});
