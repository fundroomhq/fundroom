import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  createSsoService,
  type SsoActor,
  type SsoConnectionView,
  type SsoService,
} from "@fundroom/sso";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";
import { withSetCookies } from "./test/session-cookies.js";
import {
  createTestSamlIdp,
  encodeResponse,
  type FakeOidcIdp,
  fakeDns,
  PERSISTENT_NAMEID_FORMAT,
  parseAuthnRequest,
  type SamlResponseOptions,
  selfSignedCertificate,
  startFakeOidcIdp,
} from "./test/sso-idp.js";

/*
 * Staff SSO login, end to end (E3.8, ADR-0056 decisions 2–7, 9, 10, 13) against a real server on a
 * real database, with a real-HTTP fake OpenID Provider on 127.0.0.1 and a signing SAML IdP:
 *
 *  - OIDC and SAML logins through begin (workspace origin, `sso_req` cookie) → IdP → callback / ACS
 *    (canonical host, 303) → finish (workspace origin), with cookies, in multi-tenant mode;
 *  - every SAML attack of research §1 refused at the ACS; OIDC nonce / issuer / key / error refused;
 *  - the handoff: binding cookie mismatch (and the handoff not burned by it), replay, expiry, a
 *    finish on another workspace;
 *  - linking rules a–d, JIT on/off at the capped role, suspended / external refusals, the session's
 *    `sso_*` binding and auth level (MFA mapping);
 *  - a test login writes no identity, membership or session; enforcement preconditions and the
 *    `sso_enforced` mirror; deleting revokes bound sessions; domain verification through a fake
 *    DNS resolver and `sso_domain_taken`.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let idp: FakeOidcIdp;
const dns = fakeDns();
const saml = createTestSamlIdp({
  entityId: "https://idp.beta-corp.com/saml",
  ssoUrl: "https://idp.beta-corp.com/sso",
});
const h = harness(
  () => running,
  () => mailer,
);
const { request, member } = h;

let acmeId: string;
let betaId: string;
let gammaId: string;
let acmeOwner: Actor;
let acmeViewer: Actor;
let betaOwner: Actor;
let acmeConn: SsoConnectionView;
let betaConn: SsoConnectionView;

const sso = (): SsoService => running.container.sso;

function staffCtx(workspaceId: string, membershipId: string): TenantContext {
  return { workspaceId, actorKind: "staff", membershipId };
}
const actorOf = (a: Actor): SsoActor => ({ membershipId: a.membershipId });

async function q<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

/** A user with a membership here (any kind/status), without signing them in. */
async function person(
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: string,
  status?: "suspended" | "invited",
): Promise<{ userId: string; membershipId: string }> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId,
    userId,
    kind,
    role: role as never,
    source: "test",
  });
  if (status !== undefined) {
    await q("UPDATE core.membership SET status = $2 WHERE id = $1", [m.id, status]);
  }
  return { userId, membershipId: m.id };
}

function cookiesOf(res: Response, jar = ""): string {
  return withSetCookies(jar, res);
}

function hasSessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => /^[^=]*sid=[^;]+/u.test(c.split(";")[0] ?? ""));
}

interface Flow {
  readonly beginStatus: number;
  readonly url: string;
  /** The workspace-origin cookie jar after begin (holds `sso_req`). */
  readonly jar: string;
}

async function begin(
  slug: string,
  body: Record<string, unknown> = {},
  cookie?: string,
): Promise<Flow> {
  const res = await request(slug, "/api/v1/auth/sso/begin", {
    method: "POST",
    body: JSON.stringify(body),
    ...(cookie === undefined ? {} : { cookie }),
  });
  const payload = res.status === 200 ? await json<{ url: string }>(res) : { url: "" };
  return { beginStatus: res.status, url: payload.url, jar: cookiesOf(res, cookie ?? "") };
}

/** A request on the canonical host (the ops tree). */
async function canonical(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", CANON);
  return running.app.request(url, { ...init, headers });
}

interface Finished {
  /** Where finish sent the browser (path + query). */
  readonly location: string;
  readonly res: Response;
  readonly jar: string;
  readonly handoff: string;
}

/** Follows a 303 from the callback / ACS to finish on the workspace origin. */
async function finish(slug: string, handoffLocation: string, jar: string): Promise<Finished> {
  const u = new URL(handoffLocation);
  expect(u.host).toBe(`${slug}.${CANON}`);
  expect(u.pathname).toBe("/api/v1/auth/sso/finish");
  const res = await request(slug, `${u.pathname}${u.search}`, { cookie: jar });
  expect(res.status).toBe(302);
  return {
    location: res.headers.get("location") ?? "",
    res,
    jar: cookiesOf(res, jar),
    handoff: handoffLocation,
  };
}

async function oidcLogin(
  slug: string,
  options: Parameters<FakeOidcIdp["authorize"]>[1] & {
    body?: Record<string, unknown>;
    cookie?: string;
  } = {},
): Promise<Finished> {
  const b = await begin(slug, options.body ?? {}, options.cookie);
  expect(b.beginStatus).toBe(200);
  const back = idp.authorize(b.url, options);
  const cb = await canonical(back);
  expect(cb.status).toBe(303);
  const location = cb.headers.get("location") ?? "";
  if (!location.includes("/api/v1/auth/sso/finish")) {
    return {
      location: new URL(location).pathname + new URL(location).search,
      res: cb,
      jar: b.jar,
      handoff: "",
    };
  }
  return finish(slug, location, b.jar);
}

async function acsPost(connectionId: string, form: Record<string, string>): Promise<Response> {
  return canonical(`${BASE}/sso/saml/${connectionId}/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function samlLogin(
  slug: string,
  response: (req: { requestId: string }) => Partial<SamlResponseOptions>,
  body: Record<string, unknown> = {},
  cookie?: string,
): Promise<Finished & { xml: string; relayState: string }> {
  const b = await begin(slug, body, cookie);
  expect(b.beginStatus).toBe(200);
  const req = parseAuthnRequest(b.url);
  expect(b.url.startsWith(saml.ssoUrl)).toBe(true);
  const xml = saml.response({
    requestId: req.requestId,
    acsUrl: betaConn.sp.samlAcsUrl,
    audience: betaConn.sp.samlEntityId,
    nameId: "nobody@beta-corp.com",
    ...response(req),
  });
  const res = await acsPost(betaConn.id, {
    SAMLResponse: encodeResponse(xml),
    RelayState: req.relayState,
  });
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  if (!location.includes("/api/v1/auth/sso/finish")) {
    const u = new URL(location);
    return {
      location: u.pathname + u.search,
      res,
      jar: b.jar,
      handoff: "",
      xml,
      relayState: req.relayState,
    };
  }
  return { ...(await finish(slug, location, b.jar)), xml, relayState: req.relayState };
}

async function sessionsOf(userId: string) {
  return q<{
    id: string;
    auth_level: number;
    sso_workspace_id: string | null;
    sso_connection_id: string | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, auth_level, sso_workspace_id, sso_connection_id, revoked_at
       FROM core.session WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

async function userIdByEmail(email: string): Promise<string | undefined> {
  const [r] = await q<{ user_id: string }>(
    `SELECT user_id FROM core.user_identity WHERE type = 'email' AND identifier = $1`,
    [email],
  );
  return r?.user_id;
}

async function verifyDomain(workspaceId: string, owner: Actor, domain: string) {
  const ctx = staffCtx(workspaceId, owner.membershipId);
  const added = await sso().addDomain(ctx, domain, actorOf(owner));
  dns.txt.set(added.txtName, [added.txtValue]);
  return sso().verifyDomain(ctx, added.id, actorOf(owner));
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  idp = await startFakeOidcIdp();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      SSO_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      // One pool connection (R3-M1 lock order): a nested transaction or a lock held across a
      // second checkout hangs the suite instead of passing by luck.
      DATABASE_POOL_MAX: "1",
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    dns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
  gammaId = (await createWorkspace(db, { slug: "gamma", name: "Gamma" })).id;
  acmeOwner = await member("acme", acmeId, "owner@acme.example.org", "staff", "owner");
  acmeViewer = await member("acme", acmeId, "viewer@acme.example.org", "staff", "viewer");
  betaOwner = await member("beta", betaId, "owner@beta.example.org", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await idp?.close();
  await pg?.stop();
});

describe("OIDC connection setup (live verification, sealed secret)", () => {
  const ctx = () => staffCtx(acmeId, acmeOwner.membershipId);
  const base = {
    name: "Acme IdP",
    jit: { enabled: false, role: "viewer" as const },
    mfa: { trust: false, values: [] },
  };

  it("refuses a create without a secret, a multi-tenant Entra issuer and an unreachable issuer", async () => {
    await expect(
      sso().saveConnection(
        ctx(),
        { ...base, protocol: "oidc", issuer: idp.issuer, clientId: idp.clientId },
        actorOf(acmeOwner),
      ),
    ).rejects.toMatchObject({ code: "sso_invalid_config", details: { reason: "secret_required" } });
    await expect(
      sso().saveConnection(
        ctx(),
        {
          ...base,
          protocol: "oidc",
          issuer: "https://login.microsoftonline.com/common/v2.0",
          clientId: "x",
          clientSecret: "y",
        },
        actorOf(acmeOwner),
      ),
    ).rejects.toMatchObject({ code: "sso_invalid_config", details: { reason: "issuer_mismatch" } });
    await expect(
      sso().saveConnection(
        ctx(),
        {
          ...base,
          protocol: "oidc",
          issuer: "http://127.0.0.1:1/none",
          clientId: "x",
          clientSecret: "y",
        },
        actorOf(acmeOwner),
      ),
    ).rejects.toMatchObject({
      code: "sso_invalid_config",
      details: { reason: "discovery_failed" },
    });
    expect(await sso().getConnection(ctx())).toBeNull();
  });

  it("saves after live discovery; the view never carries the secret", async () => {
    acmeConn = await sso().saveConnection(
      ctx(),
      {
        ...base,
        protocol: "oidc",
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
      },
      actorOf(acmeOwner),
    );
    expect(acmeConn).toMatchObject({
      protocol: "oidc",
      enabled: false,
      enforce: "off",
      oidc: { issuer: idp.issuer, clientId: idp.clientId, hasSecret: true },
      sp: { oidcRedirectUri: `${BASE}/sso/oidc/${acmeConn.id}/callback` },
    });
    expect(JSON.stringify(acmeConn)).not.toContain(idp.clientSecret);
    const [row] = await q<{ credentials_enc: Buffer; version: number }>(
      "SELECT credentials_enc, version FROM core.sso_connection WHERE id = $1",
      [acmeConn.id],
    );
    expect(row?.credentials_enc.toString("latin1")).not.toContain(idp.clientSecret);
    // A resave without the secret keeps it (same issuer); nothing security-relevant changed, so
    // the version (and every bound session) stays.
    const again = await sso().saveConnection(
      ctx(),
      { ...base, protocol: "oidc", issuer: idp.issuer, clientId: idp.clientId },
      actorOf(acmeOwner),
    );
    expect(again.id).toBe(acmeConn.id);
    const [after] = await q<{ version: number }>(
      "SELECT version FROM core.sso_connection WHERE id = $1",
      [acmeConn.id],
    );
    expect(after?.version).toBe(row?.version);
  });

  it("is not offered while disabled: GET /auth/sso, begin 409, discover false", async () => {
    const info = await json(await request("acme", "/api/v1/auth/sso"));
    expect(info).toEqual({ available: false, name: null, protocol: null, enforced: false });
    const b = await begin("acme");
    expect(b.beginStatus).toBe(409);
    const none = await canonical(`${BASE}/api/v1/auth/sso`);
    expect(await json(none)).toEqual({
      available: false,
      name: null,
      protocol: null,
      enforced: false,
    });
  });
});

describe("enforcement preconditions and the test login", () => {
  const ctx = () => staffCtx(acmeId, acmeOwner.membershipId);

  it("refuses enforcement before the connection is enabled or ever signed in", async () => {
    await expect(
      sso().setState(ctx(), { enabled: true, enforce: "staff" }, actorOf(acmeOwner)),
    ).rejects.toMatchObject({
      code: "sso_enforce_precondition",
      details: { reason: "never_signed_in" },
    });
  });

  it("refuses a test begin without sso.manage", async () => {
    expect((await begin("acme", { test: true }, acmeViewer.cookie)).beginStatus).toBe(403);
    expect((await begin("acme", { test: true })).beginStatus).toBe(403);
  });

  it("a test login while disabled verifies everything and writes no identity, membership or session", async () => {
    const usersBefore = await q<{ n: string }>("SELECT count(*)::text AS n FROM core.user");
    const sessionsBefore = await q<{ n: string }>("SELECT count(*)::text AS n FROM core.session");
    const done = await oidcLogin("acme", {
      body: { test: true },
      cookie: acmeOwner.cookie,
      claims: { sub: "test-subject", email: "tester@nowhere.example.org" },
    });
    expect(done.location).toBe("/admin/sso?sso_test=ok");
    expect(hasSessionCookie(done.res)).toBe(false);
    expect(
      await q("SELECT 1 FROM core.user_identity WHERE identifier LIKE $1", [`${acmeConn.id}|%`]),
    ).toEqual([]);
    expect(await q<{ n: string }>("SELECT count(*)::text AS n FROM core.user")).toEqual(
      usersBefore,
    );
    expect(await q<{ n: string }>("SELECT count(*)::text AS n FROM core.session")).toEqual(
      sessionsBefore,
    );
    const view = await sso().getConnection(ctx());
    expect(view?.lastTestedAt).not.toBeNull();
    expect(view?.lastError).toBeNull();
    expect(view?.lastLoginAt).toBeNull();
  });

  it("a failed test is recorded and redirected to the admin page", async () => {
    const done = await oidcLogin("acme", {
      body: { test: true },
      cookie: acmeOwner.cookie,
      error: "access_denied",
    });
    expect(done.location).toBe("/admin/sso?sso_test=idp_error");
    expect((await sso().getConnection(ctx()))?.lastError).toContain("idp_error");
  });

  it("enables the connection", async () => {
    const v = await sso().setState(ctx(), { enabled: true, enforce: "off" }, actorOf(acmeOwner));
    expect(v.enabled).toBe(true);
    expect(await json(await request("acme", "/api/v1/auth/sso"))).toEqual({
      available: true,
      name: "Acme IdP",
      protocol: "oidc",
      enforced: false,
    });
  });
});

describe("OIDC login: handoff, linking, JIT, refusals", () => {
  let carol: { userId: string; membershipId: string };

  beforeAll(async () => {
    carol = await person(acmeId, "carol@elsewhere.example.org", "staff", "editor");
  });

  it("c: a member's email links and signs in, on a session bound to this workspace + connection", async () => {
    const done = await oidcLogin("acme", {
      body: { returnTo: "/dashboard?tab=1" },
      claims: { sub: "carol-sub", email: "Carol@Elsewhere.example.org", amr: ["pwd"] },
    });
    expect(done.location).toBe("/dashboard?tab=1");
    expect(hasSessionCookie(done.res)).toBe(true);
    expect(idp.seen.lastRedirectUri).toBe(`${BASE}/sso/oidc/${acmeConn.id}/callback`);
    const [identity] = await q<{ user_id: string }>(
      "SELECT user_id FROM core.user_identity WHERE type = 'oidc' AND identifier = $1",
      [`${acmeConn.id}|carol-sub`],
    );
    expect(identity?.user_id).toBe(carol.userId);
    const sessions = await sessionsOf(carol.userId);
    expect(sessions.at(-1)).toMatchObject({
      auth_level: 1,
      sso_workspace_id: acmeId,
      sso_connection_id: acmeConn.id,
      revoked_at: null,
    });
    // The session works on this workspace.
    const me = await request("acme", "/api/v1/me", { cookie: done.jar });
    expect(me.status).toBe(200);
    const view = await sso().getConnection(staffCtx(acmeId, acmeOwner.membershipId));
    expect(view?.lastLoginAt).not.toBeNull();
    const [audit] = await q<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'auth.login'
        ORDER BY occurred_at DESC LIMIT 1`,
      [acmeId],
    );
    expect(audit?.meta).toMatchObject({ method: "sso", connectionId: acmeConn.id });
  });

  it("a: the identity wins next time, whatever email the IdP now asserts; MFA amr → level 2", async () => {
    const done = await oidcLogin("acme", {
      claims: {
        sub: "carol-sub",
        email: "someone-else@elsewhere.example.org",
        amr: ["pwd", "otp"],
      },
    });
    expect(done.location).toBe("/");
    const sessions = await sessionsOf(carol.userId);
    expect(sessions.at(-1)).toMatchObject({ auth_level: 2, sso_connection_id: acmeConn.id });
  });

  it("d: an unknown email in an unverified domain is refused, even with JIT on", async () => {
    await sso().saveConnection(
      staffCtx(acmeId, acmeOwner.membershipId),
      {
        name: "Acme IdP",
        protocol: "oidc",
        issuer: idp.issuer,
        clientId: idp.clientId,
        jit: { enabled: true, role: "editor" },
        mfa: { trust: false, values: [] },
      },
      actorOf(acmeOwner),
    );
    const done = await oidcLogin("acme", {
      claims: { sub: "stranger", email: "stranger@elsewhere.example.org" },
    });
    expect(done.location).toBe("/login?sso_error=unknown_user");
    expect(hasSessionCookie(done.res)).toBe(false);
    expect(await userIdByEmail("stranger@elsewhere.example.org")).toBeUndefined();
  });

  it("refuses suspended and external members", async () => {
    await person(acmeId, "sam@elsewhere.example.org", "staff", "editor", "suspended");
    await person(acmeId, "ivan@elsewhere.example.org", "external", "investor");
    expect(
      (await oidcLogin("acme", { claims: { sub: "sam", email: "sam@elsewhere.example.org" } }))
        .location,
    ).toBe("/login?sso_error=suspended");
    expect(
      (await oidcLogin("acme", { claims: { sub: "ivan", email: "ivan@elsewhere.example.org" } }))
        .location,
    ).toBe("/login?sso_error=staff_only");
  });

  it("b: a verified domain links an existing global user and JIT-provisions at the capped role", async () => {
    const v = await verifyDomain(acmeId, acmeOwner, "acme-corp.com");
    expect(v.status).toBe("verified");
    // dave exists globally (staff at beta) but has no membership at acme.
    const dave = await person(betaId, "dave@acme-corp.com", "staff", "admin");
    const done = await oidcLogin("acme", {
      claims: { sub: "dave-sub", email: "dave@acme-corp.com" },
    });
    expect(done.location).toBe("/");
    const [m] = await q<{ role: string; kind: string; status: string; source: string }>(
      "SELECT role, kind, status, source FROM core.membership WHERE workspace_id = $1 AND user_id = $2",
      [acmeId, dave.userId],
    );
    expect(m).toEqual({ role: "editor", kind: "staff", status: "active", source: "sso" });
    // A brand-new person gets a new user.
    const erin = await oidcLogin("acme", {
      claims: { sub: "erin-sub", email: "erin@acme-corp.com", name: "Erin" },
    });
    expect(erin.location).toBe("/");
    const erinId = await userIdByEmail("erin@acme-corp.com");
    expect(erinId).toBeDefined();
    const [jit] = await q<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit.event WHERE workspace_id = $1 AND action = 'sso.jit_provisioned'",
      [acmeId],
    );
    expect(jit?.n).toBe("2");
  });

  it("b: with JIT off, a verified-domain person without a membership is not provisioned", async () => {
    await sso().saveConnection(
      staffCtx(acmeId, acmeOwner.membershipId),
      {
        name: "Acme IdP",
        protocol: "oidc",
        issuer: idp.issuer,
        clientId: idp.clientId,
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
      },
      actorOf(acmeOwner),
    );
    const done = await oidcLogin("acme", {
      claims: { sub: "fred-sub", email: "fred@acme-corp.com" },
    });
    expect(done.location).toBe("/login?sso_error=not_provisioned");
    expect(await userIdByEmail("fred@acme-corp.com")).toBeUndefined();
  });

  it("refuses an IdP error, a wrong nonce, a foreign signing key and another issuer", async () => {
    const claims = { sub: "carol-sub", email: "carol@elsewhere.example.org" };
    expect((await oidcLogin("acme", { claims, error: "access_denied" })).location).toBe(
      "/login?sso_error=idp_error",
    );
    for (const knob of [
      { nonce: "forged" },
      { foreignKey: true },
      { idTokenIssuer: "https://evil.example.org" },
      { audience: "other-client" },
    ]) {
      expect((await oidcLogin("acme", { claims, ...knob })).location, JSON.stringify(knob)).toBe(
        "/login?sso_error=invalid_response",
      );
    }
  });

  it("a callback's state is single use", async () => {
    const b = await begin("acme");
    const back = idp.authorize(b.url, { claims: { sub: "carol-sub" } });
    expect((await canonical(back)).status).toBe(303);
    const again = await canonical(back);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`http://acme.${CANON}/login?sso_error=expired`);
    // A state nobody issued lands on the canonical login.
    const unknown = await canonical(`${BASE}/sso/oidc/${acmeConn.id}/callback?state=nope&code=x`);
    expect(unknown.headers.get("location")).toBe(`${BASE}/login?sso_error=expired`);
  });
});

describe("the handoff", () => {
  async function toHandoff(): Promise<{ location: string; jar: string }> {
    const b = await begin("acme");
    const cb = await canonical(idp.authorize(b.url, { claims: { sub: "carol-sub" } }));
    expect(cb.status).toBe(303);
    return { location: cb.headers.get("location") ?? "", jar: b.jar };
  }

  it("goes from the canonical host to the workspace origin that began", async () => {
    const { location } = await toHandoff();
    expect(new URL(location).host).toBe(`acme.${CANON}`);
  });

  it("refuses a browser without the binding cookie — without burning the handoff", async () => {
    const { location, jar } = await toHandoff();
    const u = new URL(location);
    const foreign = await request("acme", `${u.pathname}${u.search}`);
    expect(foreign.headers.get("location")).toBe("/login?sso_error=binding_mismatch");
    expect(hasSessionCookie(foreign)).toBe(false);
    const wrongCookie = await request("acme", `${u.pathname}${u.search}`, {
      cookie: jar.replace(/(sso_req=)[^;]+/u, "$1AAAAAAAAAAAAAAAAAAAAAA"),
    });
    expect(wrongCookie.headers.get("location")).toBe("/login?sso_error=binding_mismatch");
    const done = await finish("acme", location, jar);
    expect(done.location).toBe("/");
  });

  it("is single use", async () => {
    const { location, jar } = await toHandoff();
    expect((await finish("acme", location, jar)).location).toBe("/");
    const u = new URL(location);
    const replay = await request("acme", `${u.pathname}${u.search}`, { cookie: jar });
    expect(replay.headers.get("location")).toBe("/login?sso_error=expired");
  });

  it("expires", async () => {
    const { location, jar } = await toHandoff();
    await q(
      "UPDATE core.auth_challenge SET expires_at = now() - interval '1 second' WHERE kind = 'sso_handoff' AND consumed_at IS NULL",
    );
    const u = new URL(location);
    const late = await request("acme", `${u.pathname}${u.search}`, { cookie: jar });
    expect(late.headers.get("location")).toBe("/login?sso_error=expired");
  });

  it("is refused on another workspace's origin, even with the cookie", async () => {
    const { location, jar } = await toHandoff();
    const u = new URL(location);
    const elsewhere = await request("beta", `${u.pathname}${u.search}`, { cookie: jar });
    expect(elsewhere.headers.get("location")).toBe("/login?sso_error=binding_mismatch");
  });
});

describe("FR4: SSO re-authentication for step-up (OIDC)", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  let jar: string;
  let carolId: string;

  async function sessionRows(userId: string) {
    return q<{
      id: string;
      revoked_at: Date | null;
      sso_connection_id: string | null;
      sso_connection_version: number | null;
      auth_time: Date;
    }>(
      `SELECT id, revoked_at, sso_connection_id, sso_connection_version, auth_time
         FROM core.session WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
  }

  async function reauth(claims: Record<string, unknown>): Promise<Finished & { url: string }> {
    const b = await begin("acme", { reauth: true }, jar);
    expect(b.beginStatus).toBe(200);
    const cb = await canonical(idp.authorize(b.url, { claims }));
    expect(cb.status).toBe(303);
    const location = cb.headers.get("location") ?? "";
    if (!location.includes("/api/v1/auth/sso/finish")) {
      const u = new URL(location);
      return { location: u.pathname + u.search, res: cb, jar: b.jar, handoff: "", url: b.url };
    }
    return { ...(await finish("acme", location, b.jar)), url: b.url };
  }

  beforeAll(async () => {
    const done = await oidcLogin("acme", { claims: { sub: "carol-sub" } });
    expect(done.location).toBe("/");
    jar = done.jar;
    carolId = (await userIdByEmail("carol@elsewhere.example.org")) as string;
  });

  it("forces a fresh IdP login and refuses a stale or missing auth_time", async () => {
    const stale = await reauth({ sub: "carol-sub", auth_time: nowSec() - 10 * 60 });
    const u = new URL(stale.url);
    expect(u.searchParams.get("prompt")).toBe("login");
    expect(u.searchParams.get("max_age")).toBe("0");
    expect(stale.location).toBe("/login?sso_error=reauth_required");
    expect((await reauth({ sub: "carol-sub" })).location).toBe("/login?sso_error=reauth_required");
    // A plain begin asks for neither.
    const plain = await begin("acme");
    expect(new URL(plain.url).searchParams.get("prompt")).toBeNull();
  });

  it("refuses another user and leaves the current session alone", async () => {
    const before = (await sessionRows(carolId)).filter((s) => s.revoked_at === null);
    const other = await reauth({ sub: "dave-sub", auth_time: nowSec() });
    expect(other.location).toBe("/login?sso_error=reauth_mismatch");
    expect(hasSessionCookie(other.res)).toBe(false);
    const after = (await sessionRows(carolId)).filter((s) => s.revoked_at === null);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect((await request("acme", "/api/v1/me", { cookie: jar })).status).toBe(200);
  });

  it("a fresh re-authentication replaces the session with a fresh, still-bound one", async () => {
    const old = (await sessionRows(carolId)).filter((s) => s.revoked_at === null).at(-1);
    const done = await reauth({ sub: "carol-sub", auth_time: nowSec() });
    expect(done.location).toBe("/");
    expect(hasSessionCookie(done.res)).toBe(true);
    const rows = await sessionRows(carolId);
    const fresh = rows.at(-1);
    const [conn] = await q<{ version: number }>(
      "SELECT version FROM core.sso_connection WHERE id = $1",
      [acmeConn.id],
    );
    expect(fresh).toMatchObject({
      revoked_at: null,
      sso_connection_id: acmeConn.id,
      sso_connection_version: conn?.version,
    });
    expect(Date.now() - (fresh?.auth_time.getTime() ?? 0)).toBeLessThan(60_000);
    expect(rows.find((s) => s.id === old?.id)?.revoked_at).not.toBeNull();
    expect((await request("acme", "/api/v1/me", { cookie: done.jar })).status).toBe(200);
  });

  it("is ignored without a bound session (a plain sign-in, no prompt=login)", async () => {
    const b = await begin("acme", { reauth: true });
    expect(new URL(b.url).searchParams.get("prompt")).toBeNull();
  });
});

describe("FR5: an SSO session is only as fresh as the IdP's own authentication", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const review = (slug: string, jar: string) =>
    request(slug, "/api/v1/access/reviews", { method: "POST", cookie: jar, body: "{}" });
  const authTimeOf = async (userId: string) =>
    (
      await q<{ auth_time: Date }>(
        "SELECT auth_time FROM core.session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [userId],
      )
    )[0]?.auth_time;

  it("OIDC (R6P1): a plain sign-in answered from an hour-old IdP session is not fresh", async () => {
    const adam = await person(acmeId, "adam@elsewhere.example.org", "staff", "admin");
    const done = await oidcLogin("acme", {
      claims: {
        sub: "adam-sub",
        email: "adam@elsewhere.example.org",
        amr: ["mfa"],
        auth_time: nowSec() - 3600,
      },
    });
    expect(done.location).toBe("/");
    expect(Date.now() - ((await authTimeOf(adam.userId))?.getTime() ?? 0)).toBeGreaterThan(
      55 * 60_000,
    );
    const res = await review("acme", done.jar);
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("step_up_required");
    // No auth_time at all: minted stale too.
    const none = await oidcLogin("acme", { claims: { sub: "adam-sub", amr: ["mfa"] } });
    expect(Date.now() - ((await authTimeOf(adam.userId))?.getTime() ?? 0)).toBeGreaterThan(
      10 * 60_000,
    );
    expect((await review("acme", none.jar)).status).toBe(403);
    // A reauth (fresh auth_time) yields a fresh session: the gate opens.
    const b = await begin("acme", { reauth: true }, none.jar);
    const cb = await canonical(
      idp.authorize(b.url, { claims: { sub: "adam-sub", amr: ["mfa"], auth_time: nowSec() - 30 } }),
    );
    const fresh = await finish("acme", cb.headers.get("location") ?? "", b.jar);
    expect(fresh.location).toBe("/");
    const at = (await authTimeOf(adam.userId))?.getTime() ?? 0;
    expect(Math.abs(Date.now() - 30_000 - at)).toBeLessThan(5_000); // the IdP's time, not now
    expect((await review("acme", fresh.jar)).status).not.toBe(403);
  });
});

describe("SAML (node-saml 5.1.0 + our post-checks)", () => {
  let bob: { userId: string; membershipId: string };
  const ctx = () => staffCtx(betaId, betaOwner.membershipId);

  beforeAll(async () => {
    betaConn = await sso().saveConnection(
      ctx(),
      {
        name: "Beta SAML",
        protocol: "saml",
        metadataXml: saml.metadataXml(),
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: ["urn:mfa"] },
      },
      actorOf(betaOwner),
    );
    await sso().setState(ctx(), { enabled: true, enforce: "off" }, actorOf(betaOwner));
    bob = await person(betaId, "bob@elsewhere.example.org", "staff", "legal");
  });

  it("saved the IdP from metadata and serves SP metadata on the canonical host", async () => {
    expect(betaConn.saml).toMatchObject({ idpEntityId: saml.entityId, idpSsoUrl: saml.ssoUrl });
    expect(betaConn.saml?.certificates).toHaveLength(1);
    const md = await canonical(`${BASE}/sso/saml/${betaConn.id}/metadata`);
    expect(md.status).toBe(200);
    const xml = await md.text();
    expect(xml).toContain(`entityID="${betaConn.sp.samlEntityId}"`);
    expect(xml).toContain(betaConn.sp.samlAcsUrl);
    expect((await canonical(`${BASE}/sso/saml/${acmeConn.id}/metadata`)).status).toBe(404);
    expect(
      (await canonical(`${BASE}/sso/saml/00000000-0000-4000-8000-000000000000/metadata`)).status,
    ).toBe(404);
  });

  it("refuses bad metadata and a weak certificate", async () => {
    await expect(
      sso().saveConnection(
        ctx(),
        {
          name: "x",
          protocol: "saml",
          metadataXml: "<nope/>",
          jit: { enabled: false, role: "viewer" },
          mfa: { trust: false, values: [] },
        },
        actorOf(betaOwner),
      ),
    ).rejects.toMatchObject({
      code: "sso_invalid_config",
      details: { reason: "invalid_metadata" },
    });
    await expect(
      sso().saveConnection(
        ctx(),
        {
          name: "x",
          protocol: "saml",
          idpEntityId: saml.entityId,
          idpSsoUrl: saml.ssoUrl,
          certificates: [selfSignedCertificate({ bits: 1024 }).certPem],
          jit: { enabled: false, role: "viewer" },
          mfa: { trust: false, values: [] },
        },
        actorOf(betaOwner),
      ),
    ).rejects.toMatchObject({
      code: "sso_invalid_config",
      details: { reason: "invalid_certificate" },
    });
  });

  it("signs a member in (email NameID) with a bound session; a mapped AuthnContext → level 2", async () => {
    const done = await samlLogin("beta", () => ({
      nameId: "bob@elsewhere.example.org",
      authnContextClassRef: "urn:mfa",
    }));
    expect(done.location).toBe("/");
    const s = (await sessionsOf(bob.userId)).at(-1);
    expect(s).toMatchObject({
      auth_level: 2,
      sso_workspace_id: betaId,
      sso_connection_id: betaConn.id,
    });
    const [identity] = await q<{ user_id: string }>(
      "SELECT user_id FROM core.user_identity WHERE type = 'saml' AND identifier = $1",
      [`${betaConn.id}|bob@elsewhere.example.org`],
    );
    expect(identity?.user_id).toBe(bob.userId);
  });

  it("reads the email from an attribute when the NameID is opaque", async () => {
    const done = await samlLogin("beta", () => ({
      nameId: "00u-bob-persistent",
      nameIdFormat: PERSISTENT_NAMEID_FORMAT,
      attributes: { email: "bob@elsewhere.example.org" },
    }));
    expect(done.location).toBe("/");
  });

  const attacks: [string, (r: { requestId: string }) => Partial<SamlResponseOptions>][] = [
    ["unsigned", () => ({ nameId: "bob@elsewhere.example.org", unsigned: true })],
    [
      "tampered",
      () => ({ nameId: "bob@elsewhere.example.org", tamperNameId: "owner@beta.example.org" }),
    ],
    [
      "foreign key",
      () => ({ nameId: "owner@beta.example.org", signWith: selfSignedCertificate() }),
    ],
    [
      "XSW sibling",
      () => ({
        nameId: "bob@elsewhere.example.org",
        wrap: "sibling",
        wrapNameId: "owner@beta.example.org",
      }),
    ],
    [
      "XSW nested",
      () => ({
        nameId: "bob@elsewhere.example.org",
        wrap: "nested",
        wrapNameId: "owner@beta.example.org",
      }),
    ],
    [
      "signed InResponseTo missing (#434)",
      () => ({ nameId: "bob@elsewhere.example.org", omitSignedInResponseTo: true }),
    ],
    [
      "signed InResponseTo foreign",
      () => ({ nameId: "bob@elsewhere.example.org", signedInResponseTo: "_other" }),
    ],
    [
      "wrong Recipient",
      () => ({ nameId: "bob@elsewhere.example.org", recipient: "https://evil.example.org/acs" }),
    ],
    [
      "wrong Issuer",
      () => ({ nameId: "bob@elsewhere.example.org", issuer: "https://evil.example.org/saml" }),
    ],
    [
      "wrong audience",
      () => ({
        nameId: "bob@elsewhere.example.org",
        audienceOverride: "https://evil.example.org/sp",
      }),
    ],
    ["expired", () => ({ nameId: "bob@elsewhere.example.org", clockOffsetMs: -30 * 60_000 })],
    ["SHA-1", () => ({ nameId: "bob@elsewhere.example.org", sha1: true })],
  ];
  for (const [label, make] of attacks) {
    it(`refuses ${label}`, async () => {
      const done = await samlLogin("beta", make);
      expect(done.location).toBe("/login?sso_error=invalid_response");
      expect(hasSessionCookie(done.res)).toBe(false);
    });
  }

  it("refuses a comment-injected NameID (never the prefix's account)", async () => {
    const done = await samlLogin("beta", () => ({
      nameId: "bob@elsewhere.example.org.evil.example.org",
      commentAt: "bob@elsewhere.example.org".length,
    }));
    expect(done.xml).toContain("bob@elsewhere.example.org<!---->.evil");
    expect(done.location).toMatch(/^\/login\?sso_error=(invalid_response|unknown_user)$/u);
  });

  it("refuses a replayed response and a replayed assertion id", async () => {
    const first = await samlLogin("beta", () => ({
      nameId: "bob@elsewhere.example.org",
      assertionId: "_replay-me",
    }));
    expect(first.location).toBe("/");
    // The same POST again: its RelayState was consumed.
    const again = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(first.xml),
      RelayState: first.relayState,
    });
    expect(again.headers.get("location")).toBe(`http://beta.${CANON}/login?sso_error=expired`);
    // The same assertion id answering a fresh request.
    const second = await samlLogin("beta", () => ({
      nameId: "bob@elsewhere.example.org",
      assertionId: "_replay-me",
    }));
    expect(second.location).toBe("/login?sso_error=invalid_response");
  });

  it("refuses IdP-initiated SSO (no RelayState / unknown RelayState)", async () => {
    const xml = saml.response({
      requestId: "_idp-initiated",
      responseInResponseTo: null,
      omitSignedInResponseTo: true,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId: "bob@elsewhere.example.org",
    });
    const none = await acsPost(betaConn.id, { SAMLResponse: encodeResponse(xml) });
    expect(none.status).toBe(303);
    expect(none.headers.get("location")).toBe(`${BASE}/login?sso_error=expired`);
    const unknown = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(xml),
      RelayState: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(unknown.headers.get("location")).toBe(`${BASE}/login?sso_error=expired`);
  });

  it("refuses an oversized ACS body and a non-form body", async () => {
    const big = await acsPost(betaConn.id, {
      SAMLResponse: "A".repeat(300 * 1024),
      RelayState: "x",
    });
    expect(big.status).toBe(413);
    const jsonBody = await canonical(`${BASE}/sso/saml/${betaConn.id}/acs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(jsonBody.status).toBe(415);
  });

  it("does not answer the ops routes on a workspace host", async () => {
    const res = await request("beta", `/sso/saml/${betaConn.id}/metadata`);
    expect(res.headers.get("content-type") ?? "").not.toContain("samlmetadata");
  });
});

describe("fix round 1", () => {
  const bctx = () => staffCtx(betaId, betaOwner.membershipId);
  const samlSave = (mfaValues: string[]) =>
    sso().saveConnection(
      bctx(),
      {
        name: "Beta SAML",
        protocol: "saml",
        metadataXml: saml.metadataXml(),
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: mfaValues },
      },
      actorOf(betaOwner),
    );
  const liveSsoSessions = async (userId: string) =>
    (await sessionsOf(userId)).filter((s) => s.revoked_at === null && s.sso_connection_id !== null);
  const bobId = async () => (await userIdByEmail("bob@elsewhere.example.org")) as string;
  const bindingOf = (jar: string) => /sso_req=([^;]+)/u.exec(jar)?.[1];

  /** begin (on any host/path) → ACS → the handoff Location, for beta's SAML connection. */
  async function samlToHandoff(
    beginOn: { host: string; path: string },
    nameId = "bob@elsewhere.example.org",
  ): Promise<{ location: string; jar: string }> {
    const res = await running.app.request(`http://${beginOn.host}${beginOn.path}`, {
      method: "POST",
      headers: {
        host: beginOn.host,
        origin: `http://${beginOn.host}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const { url } = await json<{ url: string }>(res);
    const req = parseAuthnRequest(url);
    const xml = saml.response({
      requestId: req.requestId,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId,
    });
    const acs = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(xml),
      RelayState: req.relayState,
    });
    expect(acs.status).toBe(303);
    return { location: acs.headers.get("location") ?? "", jar: cookiesOf(res) };
  }

  async function finishAt(location: string, jar: string): Promise<Response> {
    const u = new URL(location);
    return running.app.request(u.href, { headers: { host: u.host, cookie: jar } });
  }

  it("M1: begun on /w/<slug> (multi) → finish on the canonical host under /w/<slug>", async () => {
    const { location, jar } = await samlToHandoff({
      host: CANON,
      path: "/w/beta/api/v1/auth/sso/begin",
    });
    const u = new URL(location);
    expect(u.host).toBe(CANON);
    expect(u.pathname).toBe("/w/beta/api/v1/auth/sso/finish");
    const done = await finishAt(location, jar);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/w/beta/");
    expect(hasSessionCookie(done)).toBe(true);
  });

  it("M1: with a custom domain active, finish goes back to whichever origin the user began on", async () => {
    await q(
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
         VALUES ($1, 'investors.beta-corp.com', 'active', 'tokentokentokentoken', now(), now())`,
      [betaId],
    );
    running.container.resolver.invalidate();
    running.container.customDomainLookup.invalidate();
    try {
      const onSlug = await samlToHandoff({ host: `beta.${CANON}`, path: "/api/v1/auth/sso/begin" });
      expect(new URL(onSlug.location).host).toBe(`beta.${CANON}`);
      expect((await finishAt(onSlug.location, onSlug.jar)).headers.get("location")).toBe("/");
      const onCustom = await samlToHandoff({
        host: "investors.beta-corp.com",
        path: "/api/v1/auth/sso/begin",
      });
      expect(new URL(onCustom.location).host).toBe("investors.beta-corp.com");
      const done = await finishAt(onCustom.location, onCustom.jar);
      expect(done.headers.get("location")).toBe("/");
      expect(hasSessionCookie(done)).toBe(true);
    } finally {
      await q("DELETE FROM core.custom_domain WHERE hostname = 'investors.beta-corp.com'");
      running.container.resolver.invalidate();
      running.container.customDomainLookup.invalidate();
    }
  });

  it("M2: an in-place save of the MFA mapping or certificates revokes bound sessions; a no-op save does not", async () => {
    await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    expect((await liveSsoSessions(await bobId())).length).toBeGreaterThan(0);
    const same = await samlSave(["urn:mfa"]);
    expect(same.id).toBe(betaConn.id);
    expect((await liveSsoSessions(await bobId())).length).toBeGreaterThan(0);
    await samlSave(["urn:mfa", "urn:other"]);
    expect(await liveSsoSessions(await bobId())).toEqual([]);
    await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    const rotated = selfSignedCertificate();
    await sso().saveConnection(
      bctx(),
      {
        name: "Beta SAML",
        protocol: "saml",
        metadataXml: saml.metadataXml({ extraCerts: [rotated.certPem] }),
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: ["urn:mfa", "urn:other"] },
      },
      actorOf(betaOwner),
    );
    expect(await liveSsoSessions(await bobId())).toEqual([]);
    await samlSave(["urn:mfa"]);
  });

  it("M2: disabling the connection revokes the sessions it minted", async () => {
    await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    expect((await liveSsoSessions(await bobId())).length).toBeGreaterThan(0);
    await sso().setState(bctx(), { enabled: false, enforce: "off" }, actorOf(betaOwner));
    expect(await liveSsoSessions(await bobId())).toEqual([]);
    await sso().setState(bctx(), { enabled: true, enforce: "off" }, actorOf(betaOwner));
  });

  it("L4b: garbage posted with a pending RelayState does not cancel the real sign-in", async () => {
    const b = await begin("beta");
    const req = parseAuthnRequest(b.url);
    const junk = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse("<junk/>"),
      RelayState: req.relayState,
    });
    expect(junk.headers.get("location")).toBe(
      `http://beta.${CANON}/login?sso_error=invalid_response`,
    );
    const xml = saml.response({
      requestId: req.requestId,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId: "bob@elsewhere.example.org",
    });
    const real = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(xml),
      RelayState: req.relayState,
    });
    const location = real.headers.get("location") ?? "";
    expect(location).toContain("/api/v1/auth/sso/finish?h=");
    expect((await finish("beta", location, b.jar)).location).toBe("/");
  });

  it("two concurrent ACS posts for one begin produce exactly one handoff", async () => {
    const b = await begin("beta");
    const req = parseAuthnRequest(b.url);
    const xml = saml.response({
      requestId: req.requestId,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId: "bob@elsewhere.example.org",
    });
    const form = { SAMLResponse: encodeResponse(xml), RelayState: req.relayState };
    const before = await q<{ n: string }>(
      "SELECT count(*)::text AS n FROM core.auth_challenge WHERE kind = 'sso_handoff' AND workspace_id = $1",
      [betaId],
    );
    const results = await Promise.all([
      acsPost(betaConn.id, form),
      acsPost(betaConn.id, form),
      acsPost(betaConn.id, form),
    ]);
    const locations = results.map((r) => r.headers.get("location") ?? "");
    expect(locations.filter((l) => l.includes("/api/v1/auth/sso/finish?h=")).length).toBe(1);
    const after = await q<{ n: string }>(
      "SELECT count(*)::text AS n FROM core.auth_challenge WHERE kind = 'sso_handoff' AND workspace_id = $1",
      [betaId],
    );
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(1);
  });

  it("two concurrent OIDC callbacks for one begin produce exactly one handoff", async () => {
    // acme's connection is live until the deletion test below.
    const b = await begin("acme");
    expect(b.beginStatus).toBe(200);
    const back = idp.authorize(b.url, { claims: { sub: "carol-sub" } });
    const results = await Promise.all([canonical(back), canonical(back), canonical(back)]);
    const handoffs = results.filter((r) =>
      (r.headers.get("location") ?? "").includes("/auth/sso/finish?h="),
    );
    expect(handoffs.length).toBe(1);
  });

  it("L4a: an erasure landing between completeLogin and the link leaves no identity and no session", async () => {
    const rita = await person(betaId, "rita@elsewhere.example.org", "staff", "editor");
    const c = running.container;
    const hooked = createSsoService({
      db: c.db,
      audit: c.audit,
      crypto: c.envelope,
      dns: c.dns,
      fetch: c.ssoOutbound.fetch as typeof fetch,
      protocols: ["oidc", "saml"],
      baseUrl: c.config.baseUrl,
      basePath: c.config.basePath,
      identity: {
        deps: c.identityDeps,
        sessions: c.auth.sessions,
        memberships: c.auth.memberships,
      },
      hooks: {
        afterCompleteLogin: async () => {
          await c.auth.memberships.revoke(
            systemContext(betaId),
            { membershipId: rita.membershipId, reason: "erasure" },
            undefined,
          );
        },
      },
    });
    const { location, jar } = await samlToHandoff(
      { host: `beta.${CANON}`, path: "/api/v1/auth/sso/begin" },
      "rita@elsewhere.example.org",
    );
    const h = new URL(location).searchParams.get("h") ?? "";
    const out = await hooked.finish({
      handoff: h,
      bindingToken: bindingOf(jar),
      workspaceId: betaId,
      login: { workspaceId: betaId },
    });
    expect(out).toEqual({ kind: "error", code: "not_provisioned" });
    expect(
      await q("SELECT 1 FROM core.user_identity WHERE type = 'saml' AND user_id = $1", [
        rita.userId,
      ]),
    ).toEqual([]);
    expect((await sessionsOf(rita.userId)).filter((s) => s.revoked_at === null)).toEqual([]);
  });

  it("R3-M1: a disable that lands while finish is minting the session leaves no live session", async () => {
    const ron = await person(betaId, "ron@elsewhere.example.org", "staff", "editor");
    const c = running.container;
    const sessions = {
      ...c.auth.sessions,
      startSession: async (input: Parameters<typeof c.auth.sessions.startSession>[0]) => {
        await c.sso.setState(bctx(), { enabled: false, enforce: "off" }, actorOf(betaOwner));
        return c.auth.sessions.startSession(input);
      },
    };
    const hooked = createSsoService({
      db: c.db,
      audit: c.audit,
      crypto: c.envelope,
      dns: c.dns,
      fetch: c.ssoOutbound.fetch as typeof fetch,
      protocols: ["oidc", "saml"],
      baseUrl: c.config.baseUrl,
      basePath: c.config.basePath,
      identity: { deps: c.identityDeps, sessions, memberships: c.auth.memberships },
    });
    try {
      const { location, jar } = await samlToHandoff(
        { host: `beta.${CANON}`, path: "/api/v1/auth/sso/begin" },
        "ron@elsewhere.example.org",
      );
      const out = await hooked.finish({
        handoff: new URL(location).searchParams.get("h") ?? "",
        bindingToken: bindingOf(jar),
        workspaceId: betaId,
        login: { workspaceId: betaId },
      });
      expect(out).toEqual({ kind: "error", code: "disabled" });
      expect((await sessionsOf(ron.userId)).filter((s) => s.revoked_at === null)).toEqual([]);
      expect(
        await q("SELECT 1 FROM core.user_identity WHERE type = 'saml' AND user_id = $1", [
          ron.userId,
        ]),
      ).toEqual([]);
    } finally {
      await sso().setState(bctx(), { enabled: true, enforce: "off" }, actorOf(betaOwner));
    }
  });

  it("R3-L2: a tester demoted mid-flow gets sso_test=forbidden and records nothing", async () => {
    const owner2 = await member("beta", betaId, "owner2@beta.example.org", "staff", "owner");
    const b = await begin("beta", { test: true }, owner2.cookie);
    expect(b.beginStatus).toBe(200);
    const req = parseAuthnRequest(b.url);
    const xml = saml.response({
      requestId: req.requestId,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId: "bob@elsewhere.example.org",
    });
    const acs = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(xml),
      RelayState: req.relayState,
    });
    const location = acs.headers.get("location") ?? "";
    expect(location).toContain("/api/v1/auth/sso/finish?h=");
    const [before] = await q<{ last_tested_at: Date | null }>(
      "SELECT last_tested_at FROM core.sso_connection WHERE id = $1",
      [betaConn.id],
    );
    await q("UPDATE core.membership SET role = 'admin' WHERE id = $1", [owner2.membershipId]);
    expect((await finish("beta", location, b.jar)).location).toBe("/admin/sso?sso_test=forbidden");
    const [after] = await q<{ last_tested_at: Date | null }>(
      "SELECT last_tested_at FROM core.sso_connection WHERE id = $1",
      [betaConn.id],
    );
    expect(after?.last_tested_at).toEqual(before?.last_tested_at);
  });

  it("R3-L3: a begin on a custom domain at a foreign port is not sent back to that port", async () => {
    await q(
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
         VALUES ($1, 'investors.beta-corp.com', 'active', 'tokentokentokentoken', now(), now())`,
      [betaId],
    );
    running.container.resolver.invalidate();
    running.container.customDomainLookup.invalidate();
    try {
      const { location } = await samlToHandoff({
        host: "investors.beta-corp.com:8443",
        path: "/api/v1/auth/sso/begin",
      });
      expect(new URL(location).host).toBe("investors.beta-corp.com");
    } finally {
      await q("DELETE FROM core.custom_domain WHERE hostname = 'investors.beta-corp.com'");
      running.container.resolver.invalidate();
      running.container.customDomainLookup.invalidate();
    }
  });

  /** The container's service, except that revoking a connection's sessions always fails. */
  function revokeFailing(): SsoService {
    const c = running.container;
    return createSsoService({
      db: c.db,
      audit: c.audit,
      crypto: c.envelope,
      dns: c.dns,
      fetch: c.ssoOutbound.fetch as typeof fetch,
      protocols: ["oidc", "saml"],
      baseUrl: c.config.baseUrl,
      basePath: c.config.basePath,
      resolver: c.resolver,
      identity: {
        deps: c.identityDeps,
        sessions: {
          ...c.auth.sessions,
          revokeSessionsForSsoConnection: async () => {
            throw new Error("revoke down");
          },
        },
        memberships: c.auth.memberships,
      },
    });
  }
  const meStatus = async (jar: string) =>
    (await request("beta", "/api/v1/me", { cookie: jar })).status;

  it("FR3-A1: a mapping change between ACS and finish refuses the old handoff (no level-2 session)", async () => {
    const b = await begin("beta");
    const req = parseAuthnRequest(b.url);
    const xml = saml.response({
      requestId: req.requestId,
      acsUrl: betaConn.sp.samlAcsUrl,
      audience: betaConn.sp.samlEntityId,
      nameId: "bob@elsewhere.example.org",
      authnContextClassRef: "urn:mfa",
    });
    const acs = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(xml),
      RelayState: req.relayState,
    });
    const location = acs.headers.get("location") ?? "";
    expect(location).toContain("/api/v1/auth/sso/finish?h=");
    await samlSave(["urn:other"]);
    try {
      const done = await finish("beta", location, b.jar);
      expect(done.location).toBe("/login?sso_error=disabled");
      expect(hasSessionCookie(done.res)).toBe(false);
      expect(await liveSsoSessions(await bobId())).toEqual([]);
    } finally {
      await samlSave(["urn:mfa"]);
    }
  });

  it("FR3: a disable whose revoke fails still stops the bound session on the next request", async () => {
    const done = await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    expect(await meStatus(done.jar)).toBe(200);
    try {
      await revokeFailing().setState(
        bctx(),
        { enabled: false, enforce: "off" },
        actorOf(betaOwner),
      );
      expect((await liveSsoSessions(await bobId())).length).toBeGreaterThan(0); // not revoked
      expect(await meStatus(done.jar)).toBe(401);
      // Re-enabling does not bring it back (the disable bumped the version).
      await sso().setState(bctx(), { enabled: true, enforce: "off" }, actorOf(betaOwner));
      expect(await meStatus(done.jar)).toBe(401);
    } finally {
      await sso().setState(bctx(), { enabled: true, enforce: "off" }, actorOf(betaOwner));
    }
  });

  it("FR3: a security-relevant save stops existing bound sessions at once; a no-op save does not", async () => {
    const done = await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    expect(await meStatus(done.jar)).toBe(200);
    const failing = revokeFailing();
    const save = (values: string[]) =>
      failing.saveConnection(
        bctx(),
        {
          name: "Beta SAML (renamed)",
          protocol: "saml",
          metadataXml: saml.metadataXml(),
          jit: { enabled: false, role: "viewer" },
          mfa: { trust: false, values },
        },
        actorOf(betaOwner),
      );
    await save(["urn:mfa"]); // cosmetic only
    expect(await meStatus(done.jar)).toBe(200);
    await save(["urn:mfa", "urn:stronger"]);
    expect((await liveSsoSessions(await bobId())).length).toBeGreaterThan(0); // not revoked
    expect(await meStatus(done.jar)).toBe(401);
    await samlSave(["urn:mfa"]);
  });
});

describe("FR4: SSO re-authentication for step-up (SAML)", () => {
  let jar: string;
  let bobId: string;

  async function reauth(
    nameId: string,
    authnInstant: Date,
  ): Promise<{ location: string; res: Response; xml: string }> {
    const b = await begin("beta", { reauth: true }, jar);
    expect(b.beginStatus).toBe(200);
    const req = parseAuthnRequest(b.url);
    expect(req.xml).toContain('ForceAuthn="true"');
    const acs = await acsPost(betaConn.id, {
      SAMLResponse: encodeResponse(
        saml.response({
          requestId: req.requestId,
          acsUrl: betaConn.sp.samlAcsUrl,
          audience: betaConn.sp.samlEntityId,
          nameId,
          authnInstant,
        }),
      ),
      RelayState: req.relayState,
    });
    const location = acs.headers.get("location") ?? "";
    if (!location.includes("/api/v1/auth/sso/finish")) {
      const u = new URL(location);
      return { location: u.pathname + u.search, res: acs, xml: req.xml };
    }
    const done = await finish("beta", location, b.jar);
    return { location: done.location, res: done.res, xml: req.xml };
  }

  beforeAll(async () => {
    const done = await samlLogin("beta", () => ({ nameId: "bob@elsewhere.example.org" }));
    expect(done.location).toBe("/");
    jar = done.jar;
    bobId = (await userIdByEmail("bob@elsewhere.example.org")) as string;
  });

  it("sends ForceAuthn and refuses a stale AuthnInstant", async () => {
    const stale = await reauth("bob@elsewhere.example.org", new Date(Date.now() - 10 * 60_000));
    expect(stale.location).toBe("/login?sso_error=reauth_required");
    const plain = parseAuthnRequest((await begin("beta")).url);
    expect(plain.xml).not.toContain('ForceAuthn="true"');
  });

  it("refuses another user", async () => {
    await person(betaId, "rhea@elsewhere.example.org", "staff", "editor");
    const other = await reauth("rhea@elsewhere.example.org", new Date());
    expect(other.location).toBe("/login?sso_error=reauth_mismatch");
    expect(hasSessionCookie(other.res)).toBe(false);
    expect((await request("beta", "/api/v1/me", { cookie: jar })).status).toBe(200);
  });

  it("a fresh AuthnInstant re-authenticates the same user on a bound session", async () => {
    const ok = await reauth("bob@elsewhere.example.org", new Date());
    expect(ok.location).toBe("/");
    expect(hasSessionCookie(ok.res)).toBe(true);
    const [s] = await q<{ sso_connection_id: string; auth_time: Date }>(
      `SELECT sso_connection_id, auth_time FROM core.session
        WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [bobId],
    );
    expect(s?.sso_connection_id).toBe(betaConn.id);
    expect(Date.now() - (s?.auth_time.getTime() ?? 0)).toBeLessThan(60_000);
  });
});

describe("FR5 (SAML): an old AuthnInstant makes a stale session", () => {
  it("a level-2 SAML login with an hour-old AuthnInstant still needs a step-up", async () => {
    const sally = await person(betaId, "sally@elsewhere.example.org", "staff", "admin");
    const done = await samlLogin("beta", () => ({
      nameId: "sally@elsewhere.example.org",
      authnContextClassRef: "urn:mfa",
      authnInstant: new Date(Date.now() - 3600_000),
    }));
    expect(done.location).toBe("/");
    const [s] = await q<{ auth_time: Date; auth_level: number }>(
      "SELECT auth_time, auth_level FROM core.session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [sally.userId],
    );
    expect(s?.auth_level).toBe(2);
    expect(Date.now() - (s?.auth_time.getTime() ?? 0)).toBeGreaterThan(55 * 60_000);
    const res = await request("beta", "/api/v1/access/reviews", {
      method: "POST",
      cookie: done.jar,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("step_up_required");
  });
});

describe("enforcement, deletion, domains", () => {
  it("enforces after a successful login and mirrors it on the workspace; disabling forces it off", async () => {
    const ctx = staffCtx(acmeId, acmeOwner.membershipId);
    const on = await sso().setState(ctx, { enabled: true, enforce: "staff" }, actorOf(acmeOwner));
    expect(on.enforce).toBe("staff");
    expect(
      (
        await q<{ sso_enforced: boolean }>(
          "SELECT sso_enforced FROM core.workspace WHERE id = $1",
          [acmeId],
        )
      )[0]?.sso_enforced,
    ).toBe(true);
    expect(
      (await json<{ enforced: boolean }>(await request("acme", "/api/v1/auth/sso"))).enforced,
    ).toBe(true);
    const off = await sso().setState(ctx, { enabled: false, enforce: "staff" }, actorOf(acmeOwner));
    expect(off).toMatchObject({ enabled: false, enforce: "off" });
    expect(
      (
        await q<{ sso_enforced: boolean }>(
          "SELECT sso_enforced FROM core.workspace WHERE id = $1",
          [acmeId],
        )
      )[0]?.sso_enforced,
    ).toBe(false);
    await sso().setState(ctx, { enabled: true, enforce: "staff" }, actorOf(acmeOwner));
  });

  it("discover answers true only for a verified domain of this workspace", async () => {
    const ask = async (slug: string, email: string) =>
      (
        await json<{ sso: boolean }>(
          await request(slug, "/api/v1/auth/sso/discover", {
            method: "POST",
            body: JSON.stringify({ email }),
          }),
        )
      ).sso;
    expect(await ask("acme", "anyone@acme-corp.com")).toBe(true);
    expect(await ask("acme", "anyone@elsewhere.example.org")).toBe(false);
    expect(await ask("beta", "anyone@acme-corp.com")).toBe(false);
  });

  it("a verified domain belongs to one workspace; the refusal never names the other", async () => {
    const gammaOwner = await member("gamma", gammaId, "owner@gamma.example.org", "staff", "owner");
    await expect(verifyDomain(gammaId, gammaOwner, "acme-corp.com")).rejects.toMatchObject({
      code: "sso_domain_taken",
    });
    try {
      await verifyDomain(gammaId, gammaOwner, "acme-corp.com");
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/acme/iu);
    }
    const ctx = staffCtx(gammaId, gammaOwner.membershipId);
    const [pending] = await sso().listDomains(ctx);
    expect(pending).toMatchObject({ domain: "acme-corp.com", status: "pending" });
    // A wrong token stays pending with a reason.
    dns.txt.set("_fundroom-sso.gamma-corp.com", ["fundroom-sso=wrong"]);
    const added = await sso().addDomain(ctx, "Gamma-Corp.com", actorOf(gammaOwner));
    const checked = await sso().verifyDomain(ctx, added.id, actorOf(gammaOwner));
    expect(checked).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining("not this workspace's token"),
    });
    await expect(sso().addDomain(ctx, "co.uk", actorOf(gammaOwner))).rejects.toMatchObject({
      code: "sso_domain_invalid",
    });
    await sso().removeDomain(ctx, added.id, actorOf(gammaOwner));
    expect((await sso().listDomains(ctx)).map((d) => d.domain)).toEqual(["acme-corp.com"]);
  });

  it("deleting the connection turns enforcement off and revokes the sessions it minted", async () => {
    // (Disabling in the enforcement test above already revoked earlier ones — R1-M2.)
    expect((await oidcLogin("acme", { claims: { sub: "carol-sub" } })).location).toBe("/");
    const carolId = (await userIdByEmail("carol@elsewhere.example.org")) as string;
    const live = (await sessionsOf(carolId)).filter(
      (s) => s.revoked_at === null && s.sso_connection_id === acmeConn.id,
    );
    expect(live.length).toBeGreaterThan(0);
    await sso().deleteConnection(staffCtx(acmeId, acmeOwner.membershipId), actorOf(acmeOwner));
    const after = await sessionsOf(carolId);
    for (const s of after.filter((x) => x.sso_connection_id === acmeConn.id))
      expect(s.revoked_at).not.toBeNull();
    expect(
      (
        await q<{ sso_enforced: boolean }>(
          "SELECT sso_enforced FROM core.workspace WHERE id = $1",
          [acmeId],
        )
      )[0]?.sso_enforced,
    ).toBe(false);
    expect(await sso().getConnection(staffCtx(acmeId, acmeOwner.membershipId))).toBeNull();
    expect((await begin("acme")).beginStatus).toBe(404);
    await expect(
      sso().setState(
        staffCtx(acmeId, acmeOwner.membershipId),
        { enabled: true, enforce: "off" },
        actorOf(acmeOwner),
      ),
    ).rejects.toMatchObject({ code: "sso_not_configured" });
  });
});

describe("fix round 1: single-tenant install with a custom domain", () => {
  let single: RunningServer | undefined;

  afterAll(async () => {
    await single?.stop();
  });

  it("M1: a sign-in begun on the canonical host finishes there, not on the custom domain", async () => {
    await pg.pool.query("CREATE DATABASE sso_single");
    const url = new URL(pg.connectionString);
    url.pathname = "/sso_single";
    single = await startServer({
      config: esignTestConfig(freshSecrets(url.href), {
        SSO_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
        TENANCY_MODE: "single",
      }),
      logger: createLogger({ level: "error" }),
      mailer,
      dns,
      listenEnabled: false,
      migrate: true,
      announceSetup: false,
    });
    const s = single;
    const wsId = (await createWorkspace(s.container.db, { slug: "solo", name: "Solo" })).id;
    const deps = s.container.identityDeps;
    const owner = await provisionUser(deps, { email: "owner@solo.example.org" });
    const ownerM = await provisionMembership(deps, {
      workspaceId: wsId,
      userId: owner.userId,
      kind: "staff",
      role: "owner",
      source: "test",
    });
    const sam = await provisionUser(deps, { email: "sam@solo.example.org" });
    await provisionMembership(deps, {
      workspaceId: wsId,
      userId: sam.userId,
      kind: "staff",
      role: "editor",
      source: "test",
    });
    const ctx = staffCtx(wsId, ownerM.id);
    const conn = await s.container.sso.saveConnection(
      ctx,
      {
        name: "Solo SAML",
        protocol: "saml",
        metadataXml: saml.metadataXml(),
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
      },
      { membershipId: ownerM.id },
    );
    await s.container.sso.setState(
      ctx,
      { enabled: true, enforce: "off" },
      { membershipId: ownerM.id },
    );
    await s.container.db.withTenant(systemContext(wsId), (tx) =>
      tx.execute(
        `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
           VALUES ('${wsId}', 'investors.solo-corp.com', 'active', 'tokentokentokentoken', now(), now())`,
      ),
    );
    s.container.resolver.invalidate();

    const login = async (): Promise<{ location: URL; done: Response; jar: string }> => {
      const res = await s.app.request(`${BASE}/api/v1/auth/sso/begin`, {
        method: "POST",
        headers: { host: CANON, origin: BASE, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const jar = cookiesOf(res);
      const req = parseAuthnRequest((await json<{ url: string }>(res)).url);
      const xml = saml.response({
        requestId: req.requestId,
        acsUrl: conn.sp.samlAcsUrl,
        audience: conn.sp.samlEntityId,
        nameId: "sam@solo.example.org",
      });
      const acs = await s.app.request(`${BASE}/sso/saml/${conn.id}/acs`, {
        method: "POST",
        headers: { host: CANON, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          SAMLResponse: encodeResponse(xml),
          RelayState: req.relayState,
        }).toString(),
      });
      expect(acs.status).toBe(303);
      const location = new URL(acs.headers.get("location") ?? "");
      const done = await s.app.request(location.href, { headers: { host: CANON, cookie: jar } });
      return { location, done, jar: cookiesOf(done, jar) };
    };
    const me = async (jar: string) =>
      (await s.app.request(`${BASE}/api/v1/me`, { headers: { host: CANON, cookie: jar } })).status;
    const first = await login();
    expect(first.location.host).toBe(CANON);
    expect(first.done.status).toBe(302);
    expect(first.done.headers.get("location")).toBe("/");
    expect(hasSessionCookie(first.done)).toBe(true);
    expect(await me(first.jar)).toBe(200);
    // A5: a security-relevant save moves the version; the single-tenant resolver caches the
    // workspace, so without invalidation a login under the NEW version is ignored for 30 s.
    await s.container.sso.saveConnection(
      ctx,
      {
        name: "Solo SAML",
        protocol: "saml",
        metadataXml: saml.metadataXml(),
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: ["urn:changed"] },
      },
      { membershipId: ownerM.id },
    );
    expect(await me(first.jar)).toBe(401);
    const second = await login();
    expect(await me(second.jar)).toBe(200);
  }, 120_000);
});
