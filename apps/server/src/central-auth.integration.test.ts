import { createWorkspace, findWorkspaceById } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { cookieName, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { safeReturnPath } from "./routes/auth.js";
import { type RunningServer, startServer } from "./server.js";
import { BASE, CANON, esignTestConfig, freshSecrets, json } from "./test/esign-harness.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Central auth origin (E3.10, ADR-0058, contract §5.6 + §7b) end to end through the real app:
 * `/auth/central/start` on a workspace host (`<slug>.<canonical>` or an active custom domain) →
 * `/auth/central/authorize` on the canonical host → `/auth/central/finish` back on the workspace
 * host, which mints a session bound to that workspace.
 *
 * The adversarial cases are the point: a code without the browser's verifier cookie, with another
 * request's cookie, replayed, finished on another workspace's host or another origin of the same
 * workspace; a custom domain that is not `active`; the source session or the membership revoked
 * between authorize and finish; a bound session on another workspace, on the canonical host and on
 * the global-account routes; auth level / auth time never upgraded; `return` as an open redirect.
 *
 * One pool connection throughout: every step must work without a second checkout while a
 * transaction is open (contract §0).
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

const SID = cookieName("session", "first_party");
const CREQ = cookieName("centralRequest", "first_party");

interface Ws {
  readonly id: string;
  readonly slug: string;
  readonly host: string;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  return { id, slug, host: `${slug}.${CANON}` };
}

async function person(
  email: string,
  memberOf: readonly { ws: Ws; kind?: "staff" | "external"; role?: string }[],
): Promise<{ userId: string; membershipIds: string[] }> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const membershipIds: string[] = [];
  for (const m of memberOf) {
    const row = await provisionMembership(deps, {
      workspaceId: m.ws.id,
      userId,
      kind: m.kind ?? "external",
      role: (m.role ?? "investor") as never,
      source: "test",
    });
    membershipIds.push(row.id);
  }
  return { userId, membershipIds };
}

/** A GET on any host, as a top-level navigation. */
async function get(host: string, path: string, cookie = ""): Promise<Response> {
  const headers = new Headers({ host });
  if (cookie !== "") headers.set("cookie", cookie);
  return await running.app.request(`http://${host}${path}`, { headers, redirect: "manual" });
}

async function post(host: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return await running.app.request(`http://${host}${path}`, {
    method: "POST",
    headers: {
      host,
      cookie,
      origin: `http://${host}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

function location(res: Response): string {
  const loc = res.headers.get("location");
  if (loc === null) throw new Error(`no Location on a ${res.status}`);
  return loc;
}

function setCookie(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

/** An OTP sign-in on the canonical host (no workspace): the source session. */
async function canonicalSignIn(email: string): Promise<string> {
  const since = mailer.sent.length;
  const start = await post(CANON, "/api/v1/auth/otp/start", "", { email });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await post(CANON, "/api/v1/auth/otp/verify", "", { email, code });
  expect(verify.status).toBe(200);
  return withSetCookies("", verify);
}

/** TOTP enrolment on the canonical host: the source session reaches auth level 2. */
async function canonicalStepUp(cookie: string): Promise<string> {
  const enrol = await post(CANON, "/api/v1/auth/totp/enrol", cookie);
  expect(enrol.status).toBe(200);
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await post(CANON, "/api/v1/auth/totp/enrol/confirm", cookie, {
    code: totp.generate(),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

interface MeBody {
  session: {
    sessionId: string;
    userId: string;
    authLevel: number;
    authTime: string;
    boundWorkspaceId?: string | null;
  };
  membership: { id: string } | null;
  workspaces: { workspaceId: string }[];
}

async function me(host: string, cookie: string): Promise<Response> {
  return await get(host, "/api/v1/me", cookie);
}

/** Step 1: start on the workspace host. Returns the authorize URL and the verifier cookie. */
async function start(
  host: string,
  query = "?return=%2Fdocuments",
  cookie = "",
): Promise<{ authorize: URL; creq: string }> {
  const res = await get(host, `/auth/central/start${query}`, cookie);
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const authorize = new URL(location(res));
  expect(authorize.origin).toBe(BASE);
  expect(authorize.pathname).toBe("/auth/central/authorize");
  const creq = setCookie(res, CREQ);
  expect(creq).toBeDefined();
  expect(res.headers.getSetCookie().find((l) => l.startsWith(`${CREQ}=`))).toMatch(
    /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/u,
  );
  return { authorize, creq: creq as string };
}

/** Step 2: authorize on the canonical host with the source session. */
async function authorize(url: URL, canonical: string): Promise<URL> {
  const res = await get(CANON, `${url.pathname}${url.search}`, canonical);
  expect(res.status).toBe(303);
  return new URL(location(res));
}

/** Step 3: finish on `host` with `creq` (or none). */
async function finish(host: string, url: URL, creq: string | undefined): Promise<Response> {
  const res = await get(host, `${url.pathname}${url.search}`, creq ? `${CREQ}=${creq}` : "");
  expect(res.status).toBe(303);
  // The verifier is cleared whatever the outcome.
  expect(res.headers.getSetCookie().some((l) => l.startsWith(`${CREQ}=;`))).toBe(true);
  return res;
}

/** The whole happy path; returns the bound session's cookie. */
async function handoff(
  host: string,
  canonical: string,
  query?: string,
): Promise<{ cookie: string; finished: Response }> {
  const s = await start(host, query);
  const code = await authorize(s.authorize, canonical);
  expect(code.host).toBe(host);
  expect(code.pathname).toBe("/auth/central/finish");
  expect(code.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const finished = await finish(host, code, s.creq);
  const sid = setCookie(finished, SID);
  expect(sid, `finish went to ${finished.headers.get("location")}`).toBeDefined();
  return { cookie: `${SID}=${sid}`, finished };
}

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, params)).rows as T[];
}

async function addDomain(ws: Ws, hostname: string, status: "pending" | "dns_ok" | "active") {
  await sql(
    `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
       VALUES ($1, $2, $3::text::core.custom_domain_status, $4,
               CASE WHEN $3::text = 'pending' THEN NULL ELSE now() END,
               CASE WHEN $3::text = 'active' THEN now() ELSE NULL END)`,
    [ws.id, hostname, status, `tok${seq}`.padEnd(20, "x")],
  );
  running.container.resolver.invalidate();
  running.container.customDomainLookup.invalidate();
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      CENTRAL_AUTH: "on",
      // One pool connection: a nested checkout inside an open transaction hangs the suite.
      DATABASE_POOL_MAX: "1",
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("the handoff (slug host and custom domain)", () => {
  it("signs a member in on <slug>.<canonical>, via the canonical login's returnTo", async () => {
    const ws = await workspace("ca");
    const other = await workspace("cb");
    const email = `inv${seq}@central.test`;
    const { userId, membershipIds } = await person(email, [{ ws }, { ws: other }]);

    const s = await start(ws.host);
    // No canonical session: to the canonical login, which comes back to exactly this URL.
    const noSession = await get(CANON, `${s.authorize.pathname}${s.authorize.search}`);
    expect(noSession.status).toBe(303);
    const login = new URL(location(noSession), BASE);
    expect(login.pathname).toBe("/login");
    const returnTo = login.searchParams.get("returnTo") ?? "";
    expect(returnTo).toBe(`/auth/central/authorize${s.authorize.search}`);
    // The server-side safe-return rule (used by the OIDC callback) keeps it byte for byte.
    expect(safeReturnPath(returnTo, "")).toBe(returnTo);

    const canonical = await canonicalSignIn(email);
    const code = await authorize(new URL(returnTo, BASE), canonical);
    const finished = await finish(ws.host, code, s.creq);
    expect(location(finished)).toBe("/documents");
    // Cross-origin, a Referer never carries the path (the app's policy), so the code stays here.
    expect(finished.headers.get("referrer-policy")).toMatch(
      /^(?:no-referrer|strict-origin-when-cross-origin)$/u,
    );
    const cookie = `${SID}=${setCookie(finished, SID)}`;

    const res = await me(ws.host, cookie);
    expect(res.status).toBe(200);
    const body = await json<MeBody>(res);
    expect(body.session.userId).toBe(userId);
    expect(body.session.boundWorkspaceId).toBe(ws.id);
    expect(body.membership?.id).toBe(membershipIds[0]);
    // A bound session learns nothing about the person's other workspaces.
    expect(body.workspaces.map((w) => w.workspaceId)).toEqual([ws.id]);

    const audit = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event
        WHERE workspace_id = $1 AND action = 'session.central_handoff' AND resource_id = $2`,
      [ws.id, body.session.sessionId],
    );
    expect(audit[0]?.n).toBe(1);
  });

  it("works on the workspace's active custom domain, with the code sent to that origin", async () => {
    const ws = await workspace("cd");
    await addDomain(ws, `ir.${ws.slug}-corp.com`, "active");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const { cookie } = await handoff(`ir.${ws.slug}-corp.com`, canonical);
    const body = await json<MeBody>(await me(`ir.${ws.slug}-corp.com`, cookie));
    expect(body.session.boundWorkspaceId).toBe(ws.id);
    // The session is host-scoped: the slug host is another origin (a different cookie jar in a
    // browser), but the same workspace, so the server would serve it there too.
    expect((await me(ws.host, cookie)).status).toBe(200);
  });

  it("does not start on a custom domain that is pending or dns_ok", async () => {
    const ws = await workspace("ce");
    const host = `dns.${ws.slug}-corp.com`;
    await addDomain(ws, host, "dns_ok");
    /*
     * `dns_ok` routes requests (E2.1) but is not the workspace's primary host. With the default
     * driver, serving a request promotes it to `active` (E2.1 S2); with cloudflare-saas it stays
     * `dns_ok` until the provider says active. That second world is the one to test: the
     * promotion is switched off for this request.
     */
    const domains = running.container.customDomains;
    const markServing = domains.markServing;
    domains.markServing = async () => false;
    let onDnsOk: Response;
    try {
      onDnsOk = await get(host, "/auth/central/start?return=%2F");
    } finally {
      domains.markServing = markServing;
    }
    const [row] = await sql<{ status: string }>(
      "SELECT status::text FROM core.custom_domain WHERE hostname = $1",
      [host],
    );
    expect(row?.status).toBe("dns_ok");
    expect(onDnsOk.status).not.toBe(303);
    expect(setCookie(onDnsOk, CREQ)).toBeUndefined();
    const ws2 = await workspace("cf");
    await addDomain(ws2, `pend.${ws2.slug}-corp.com`, "pending");
    const onPending = await get(`pend.${ws2.slug}-corp.com`, "/auth/central/start?return=%2F");
    expect(onPending.status).toBe(404);
    expect(setCookie(onPending, CREQ)).toBeUndefined();
  });

  it("refuses at authorize a request whose custom domain stopped being active since start", async () => {
    const ws = await workspace("cg");
    const host = `ir.${ws.slug}-corp.com`;
    await addDomain(ws, host, "active");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(host);
    await sql(
      "UPDATE core.custom_domain SET status = 'dns_ok', activated_at = NULL WHERE hostname = $1",
      [host],
    );
    running.container.resolver.invalidate();
    const res = await get(CANON, `${s.authorize.pathname}${s.authorize.search}`, canonical);
    // Nothing is handed to an origin that is no longer the workspace's own — not even an error.
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("is not served when CENTRAL_AUTH is off (the kernel has no service)", async () => {
    const ws = await workspace("ch");
    const kernel = running.container.centralAuth;
    const service = kernel.service;
    kernel.service = undefined;
    try {
      const res = await get(ws.host, "/auth/central/start");
      expect(res.status).not.toBe(303);
      expect(setCookie(res, CREQ)).toBeUndefined();
    } finally {
      kernel.service = service;
    }
  });
});

describe("the code is bound to the browser, the origin and one use", () => {
  it("a stolen code without the verifier cookie is refused and not burned", async () => {
    const ws = await workspace("ci");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    const stolen = await finish(ws.host, code, undefined);
    expect(location(stolen)).toBe("/login?error=binding_mismatch");
    expect(setCookie(stolen, SID)).toBeUndefined();
    // The rightful browser still finishes.
    const ok = await finish(ws.host, code, s.creq);
    expect(setCookie(ok, SID)).toBeDefined();
  });

  it("a verifier cookie from another request does not fit", async () => {
    const ws = await workspace("cj");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const a = await start(ws.host);
    const b = await start(ws.host);
    const codeA = await authorize(a.authorize, canonical);
    const crossed = await finish(ws.host, codeA, b.creq);
    expect(location(crossed)).toBe("/login?error=binding_mismatch");
    expect(setCookie(crossed, SID)).toBeUndefined();
  });

  it("a replayed code is refused, and the session its first use minted is revoked", async () => {
    const ws = await workspace("ck");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    const first = await finish(ws.host, code, s.creq);
    const cookie = `${SID}=${setCookie(first, SID)}`;
    expect((await me(ws.host, cookie)).status).toBe(200);
    // Replayed WITH the verifier: code and cookie both leaked.
    const replay = await finish(ws.host, code, s.creq);
    expect(location(replay)).toBe("/login?error=expired");
    expect(setCookie(replay, SID)).toBeUndefined();
    expect((await me(ws.host, cookie)).status).toBe(401);
    // The canonical session is untouched.
    expect((await me(CANON, canonical)).status).toBe(200);
  });

  it("a second code for the same request cannot be redeemed once the first was", async () => {
    const ws = await workspace("cl");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const one = await authorize(s.authorize, canonical);
    const two = await authorize(s.authorize, canonical);
    expect(setCookie(await finish(ws.host, one, s.creq), SID)).toBeDefined();
    const again = await finish(ws.host, two, s.creq);
    expect(location(again)).toBe("/login?error=expired");
    // And authorize now says the request is spent.
    const spent = await authorize(s.authorize, canonical);
    expect(spent.searchParams.get("error")).toBe("expired");
  });

  it("a code finished on another workspace's host, or another origin of the same one, is refused", async () => {
    const ws = await workspace("cm");
    const other = await workspace("cn");
    await addDomain(ws, `ir.${ws.slug}-corp.com`, "active");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }, { ws: other }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    const elsewhere = await finish(other.host, code, s.creq);
    expect(location(elsewhere)).toBe("/login?error=binding_mismatch");
    expect(setCookie(elsewhere, SID)).toBeUndefined();
    const otherOrigin = await finish(`ir.${ws.slug}-corp.com`, code, s.creq);
    expect(location(otherOrigin)).toBe("/login?error=binding_mismatch");
    expect(setCookie(otherOrigin, SID)).toBeUndefined();
    // Still good where it was minted for.
    expect(setCookie(await finish(ws.host, code, s.creq), SID)).toBeDefined();
  });

  it("an expired code is refused", async () => {
    const ws = await workspace("co");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    await sql(
      "UPDATE core.auth_challenge SET expires_at = now() - interval '1 second' WHERE kind = 'central_handoff' AND workspace_id = $1",
      [ws.id],
    );
    expect(location(await finish(ws.host, code, s.creq))).toBe("/login?error=expired");
  });
});

describe("the source session and the membership are re-checked", () => {
  it("a source session revoked between authorize and finish mints nothing", async () => {
    const ws = await workspace("cp");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const source = await json<MeBody>(await me(CANON, canonical));
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    await running.container.auth.revokeSession(source.session.sessionId, "logout");
    const res = await finish(ws.host, code, s.creq);
    expect(location(res)).toBe("/login?error=session_ended");
    expect(setCookie(res, SID)).toBeUndefined();
  });

  it("a membership that ended between authorize and finish mints nothing", async () => {
    const ws = await workspace("cq");
    const email = `inv${seq}@central.test`;
    const { membershipIds } = await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const code = await authorize(s.authorize, canonical);
    await sql("UPDATE core.membership SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      membershipIds[0],
    ]);
    const res = await finish(ws.host, code, s.creq);
    expect(location(res)).toBe("/login?error=no_access");
    expect(setCookie(res, SID)).toBeUndefined();
  });

  it("a non-member goes back with no_access and nothing is written", async () => {
    const ws = await workspace("cr");
    const elsewhere = await workspace("cs");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws: elsewhere }]);
    const canonical = await canonicalSignIn(email);
    const count = async () =>
      (
        await sql<{ ch: number; au: number }>(
          `SELECT (SELECT count(*)::int FROM core.auth_challenge
                    WHERE workspace_id = $1 AND kind = 'central_handoff') AS ch,
                  (SELECT count(*)::int FROM audit.event WHERE workspace_id = $1) AS au`,
          [ws.id],
        )
      )[0];
    const s = await start(ws.host);
    const before = await count();
    const back = await authorize(s.authorize, canonical);
    expect(back.origin).toBe(`http://${ws.host}`);
    expect(back.pathname).toBe("/auth/central/finish");
    expect(back.searchParams.get("error")).toBe("no_access");
    expect(back.searchParams.get("code")).toBeNull();
    expect(await count()).toEqual(before);
    const res = await finish(ws.host, back, s.creq);
    expect(location(res)).toBe("/login?error=no_access");
  });

  it("staff of an SSO-enforced workspace are sent to its SSO sign-in", async () => {
    const ws = await workspace("ct");
    const email = `staff${seq}@central.test`;
    await person(email, [{ ws, kind: "staff", role: "viewer" }]);
    await sql("UPDATE core.workspace SET sso_enforced = true WHERE id = $1", [ws.id]);
    const canonical = await canonicalSignIn(email);
    const s = await start(ws.host);
    const res = await get(CANON, `${s.authorize.pathname}${s.authorize.search}`, canonical);
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`http://${ws.host}/login?sso=1`);
  });
});

describe("a bound session", () => {
  let ws: Ws;
  let other: Ws;
  let canonical: string;
  let bound: string;

  beforeAll(async () => {
    ws = await workspace("cu");
    other = await workspace("cv");
    const email = `staff${seq}@central.test`;
    await person(email, [
      { ws, kind: "staff", role: "admin" },
      { ws: other, kind: "staff", role: "admin" },
    ]);
    canonical = await canonicalStepUp(await canonicalSignIn(email));
    bound = (await handoff(ws.host, canonical)).cookie;
  });

  it("is ignored on another workspace and on the canonical host", async () => {
    expect((await me(ws.host, bound)).status).toBe(200);
    expect((await me(other.host, bound)).status).toBe(401);
    expect((await me(CANON, bound)).status).toBe(401);
    expect((await get(CANON, `/w/${other.slug}/api/v1/me`, bound)).status).toBe(401);
    // Ignored, not revoked.
    expect((await me(ws.host, bound)).status).toBe(200);
  });

  it("cannot read or change the global account (403 bound_session_restricted)", async () => {
    const refused = async (res: Response) => {
      expect(res.status).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
        "bound_session_restricted",
      );
    };
    await refused(await get(ws.host, "/api/v1/me/sessions", bound));
    await refused(await get(ws.host, "/api/v1/me/devices", bound));
    await refused(await post(ws.host, "/api/v1/auth/logout-everywhere", bound));
    await refused(await post(ws.host, "/api/v1/auth/totp/enrol", bound));
    await refused(await get(ws.host, "/api/v1/auth/passkeys", bound));
    await refused(await get(ws.host, "/api/v1/auth/totp", bound));
    // Still a member here.
    expect((await get(ws.host, "/api/v1/access/people", bound)).status).toBe(200);
  });

  it("is minted at the source's auth level and auth time, never higher or fresher", async () => {
    const src = await json<MeBody>(await me(CANON, canonical));
    const dst = await json<MeBody>(await me(ws.host, bound));
    expect(src.session.authLevel).toBe(2);
    expect(dst.session.authLevel).toBe(2);
    expect(dst.session.authTime).toBe(src.session.authTime);

    // A level-1 source that proved itself an hour ago hands off level 1, an hour ago.
    const email = `old${seq}@central.test`;
    await person(email, [{ ws }]);
    const plain = await canonicalSignIn(email);
    const plainMe = await json<MeBody>(await me(CANON, plain));
    await sql("UPDATE core.session SET auth_time = now() - interval '1 hour' WHERE id = $1", [
      plainMe.session.sessionId,
    ]);
    const srcOld = await json<MeBody>(await me(CANON, plain));
    const { cookie } = await handoff(ws.host, plain);
    const dstOld = await json<MeBody>(await me(ws.host, cookie));
    expect(dstOld.session.authLevel).toBe(1);
    expect(dstOld.session.authTime).toBe(srcOld.session.authTime);
    expect(Date.now() - Date.parse(dstOld.session.authTime)).toBeGreaterThan(50 * 60_000);
  });

  it("signing out on the workspace host ends only that session", async () => {
    const { cookie } = await handoff(ws.host, canonical);
    const out = await post(ws.host, "/api/v1/auth/logout", cookie);
    expect(out.status).toBe(200);
    expect((await me(ws.host, cookie)).status).toBe(401);
    expect((await me(CANON, canonical)).status).toBe(200);
    expect((await me(ws.host, bound)).status).toBe(200);
  });

  it("signing out on the canonical host ends the sessions handed off from it (FR1 R2-L1)", async () => {
    const email = `src${seq}@central.test`;
    await person(email, [{ ws }, { ws: other }]);
    const source = await canonicalSignIn(email);
    const here = (await handoff(ws.host, source)).cookie;
    const there = (await handoff(other.host, source)).cookie;
    // Handed off from a different canonical session: not derived from `source`.
    const unrelated = (await handoff(ws.host, await canonicalSignIn(email))).cookie;
    expect((await me(ws.host, here)).status).toBe(200);
    expect((await post(CANON, "/api/v1/auth/logout", source)).status).toBe(200);
    expect((await me(CANON, source)).status).toBe(401);
    expect((await me(ws.host, here)).status).toBe(401);
    expect((await me(other.host, there)).status).toBe(401);
    expect((await me(ws.host, unrelated)).status).toBe(200);
  });
});

describe("re-authentication through central auth", () => {
  it("demands a fresh canonical proof, and the same person", async () => {
    const ws = await workspace("cw");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const { cookie: bound } = await handoff(ws.host, canonical);
    const src = await json<MeBody>(await me(CANON, canonical));

    // Fresh (just signed in): straight through.
    const fresh = await start(ws.host, "?return=%2F&reauth=1", bound);
    expect((await authorize(fresh.authorize, canonical)).searchParams.get("code")).not.toBeNull();

    // Stale: to the canonical step-up, which comes back to authorize.
    await sql("UPDATE core.session SET auth_time = now() - interval '6 minutes' WHERE id = $1", [
      src.session.sessionId,
    ]);
    const stale = await start(ws.host, "?return=%2F&reauth=1", bound);
    const res = await get(CANON, `${stale.authorize.pathname}${stale.authorize.search}`, canonical);
    expect(res.status).toBe(303);
    const stepUp = new URL(location(res), BASE);
    expect(stepUp.pathname).toBe("/auth/step-up");
    expect(stepUp.searchParams.get("reason")).toBe("fresh");
    expect(stepUp.searchParams.get("returnTo")).toBe(
      `/auth/central/authorize${stale.authorize.search}`,
    );

    // Someone else's canonical session cannot re-authenticate this one.
    const intruderEmail = `intruder${seq}@central.test`;
    await person(intruderEmail, [{ ws }]);
    const intruder = await canonicalSignIn(intruderEmail);
    const mismatch = await start(ws.host, "?return=%2F&reauth=1", bound);
    const back = await authorize(mismatch.authorize, intruder);
    expect(back.searchParams.get("error")).toBe("reauth_mismatch");
  });
});

describe("the minimum level through central auth (E-UP-18 D1)", () => {
  /** TOTP enrolment on the canonical host, keeping a recovery code for a later step-up. */
  async function enrolWithRecovery(cookie: string): Promise<{ cookie: string; codes: string[] }> {
    const enrol = await post(CANON, "/api/v1/auth/totp/enrol", cookie);
    expect(enrol.status).toBe(200);
    const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await post(CANON, "/api/v1/auth/totp/enrol/confirm", cookie, {
      code: totp.generate(),
    });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = await json<{ recoveryCodes: string[] }>(confirm);
    return { cookie: withSetCookies(cookie, confirm), codes: recoveryCodes };
  }

  /** Puts a canonical session back at level 1 (as a later email-code sign-in would be). */
  async function dropToLevel1(cookie: string): Promise<string> {
    const id = (await json<MeBody>(await me(CANON, cookie))).session.sessionId;
    await sql("UPDATE core.session SET auth_level = 1 WHERE id = $1", [id]);
    return id;
  }

  /** Authorize on the canonical host and expect the step-up screen; returns its `reason`. */
  async function expectStepUp(url: URL, canonical: string): Promise<string | null> {
    const res = await get(CANON, `${url.pathname}${url.search}`, canonical);
    expect(res.status).toBe(303);
    const to = new URL(location(res), BASE);
    expect(to.pathname).toBe("/auth/step-up");
    expect(to.searchParams.get("returnTo")).toBe(`/auth/central/authorize${url.search}`);
    return to.searchParams.get("reason");
  }

  it("re-auth from a level-2 workspace session needs a level-2 canonical session, and hands back 2", async () => {
    const ws = await workspace("cl");
    const email = `lvl${seq}@central.test`;
    await person(email, [{ ws }]);
    const enrolled = await enrolWithRecovery(await canonicalSignIn(email));
    const { cookie: bound } = await handoff(ws.host, enrolled.cookie);
    expect((await json<MeBody>(await me(ws.host, bound))).session.authLevel).toBe(2);

    // The canonical session is level 1 now (fresh): re-auth must not hand the workspace a 1.
    const canonicalId = await dropToLevel1(enrolled.cookie);
    const r = await start(ws.host, "?return=%2Fdocuments&reauth=1", bound);
    expect(await expectStepUp(r.authorize, enrolled.cookie)).toBe("level");

    // Stale AND below the level: `level` wins (that step-up refreshes the proof too).
    await sql("UPDATE core.session SET auth_time = now() - interval '6 minutes' WHERE id = $1", [
      canonicalId,
    ]);
    expect(await expectStepUp(r.authorize, enrolled.cookie)).toBe("level");

    // The canonical step-up, then the same authorize URL: a code, and level 2 on the workspace.
    const up = await post(CANON, "/api/v1/auth/totp/recovery", enrolled.cookie, {
      code: enrolled.codes[0],
    });
    expect(up.status).toBe(200);
    const stepped = withSetCookies(enrolled.cookie, up);
    const code = await authorize(r.authorize, stepped);
    expect(code.searchParams.get("code")).not.toBeNull();
    const finished = await finish(ws.host, code, r.creq);
    const sid = setCookie(finished, SID);
    expect(sid).toBeDefined();
    const after = await json<MeBody>(await me(ws.host, `${SID}=${sid}`));
    expect(after.session.authLevel).toBe(2);
    expect(Date.now() - Date.parse(after.session.authTime)).toBeLessThan(60_000);
  });

  it("`level=2` asks for level 2 without a re-authentication; other values ask nothing", async () => {
    const ws = await workspace("cl");
    const email = `lvl${seq}@central.test`;
    await person(email, [{ ws }]);
    const enrolled = await enrolWithRecovery(await canonicalSignIn(email));
    await dropToLevel1(enrolled.cookie);

    const asked = await start(ws.host, "?return=%2F&level=2");
    expect(await expectStepUp(asked.authorize, enrolled.cookie)).toBe("level");

    // Never trusted to mean anything but 2: these hand off the level-1 session as it is.
    for (const q of ["&level=1", "&level=0", "&level=3", "&level=two"]) {
      const { cookie } = await handoff(ws.host, enrolled.cookie, `?return=%2F${q}`);
      expect((await json<MeBody>(await me(ws.host, cookie))).session.authLevel, q).toBe(1);
    }

    const up = await post(CANON, "/api/v1/auth/totp/recovery", enrolled.cookie, {
      code: enrolled.codes[0],
    });
    expect(up.status).toBe(200);
    const code = await authorize(asked.authorize, withSetCookies(enrolled.cookie, up));
    const finished = await finish(ws.host, code, asked.creq);
    const sid = setCookie(finished, SID);
    expect((await json<MeBody>(await me(ws.host, `${SID}=${sid}`))).session.authLevel).toBe(2);
  });

  it("a non-member is told no_access before any step-up", async () => {
    const ws = await workspace("cl");
    const email = `lvl${seq}@central.test`;
    await person(email, []);
    const canonical = await canonicalSignIn(email); // level 1
    const before = (await json<MeBody>(await me(CANON, canonical))).session;
    const r = await start(ws.host, "?return=%2F&level=2");
    const back = await authorize(r.authorize, canonical);
    expect(back.origin).toBe(`http://${ws.host}`);
    expect(back.pathname).toBe("/auth/central/finish");
    expect(back.searchParams.get("error")).toBe("no_access");
    expect(back.searchParams.get("code")).toBeNull();
    // Nothing happened to the canonical session.
    expect((await json<MeBody>(await me(CANON, canonical))).session).toEqual(before);
  });

  it("enforced-SSO staff go to SSO without a step-up; an owner still steps up for break-glass", async () => {
    const ws = await workspace("cl");
    await sql("UPDATE core.workspace SET sso_enforced = true WHERE id = $1", [ws.id]);
    const staffEmail = `lvl${seq}@central.test`;
    await person(staffEmail, [{ ws, kind: "staff", role: "admin" }]);
    const staffCanonical = await canonicalSignIn(staffEmail); // level 1
    for (const q of ["?return=%2F&level=2", "?return=%2F&level=2&reauth=1"]) {
      const r = await start(ws.host, q);
      const res = await get(CANON, `${r.authorize.pathname}${r.authorize.search}`, staffCanonical);
      expect(res.status, q).toBe(303);
      expect(location(res), q).toBe(`http://${ws.host}/login?sso=1`);
    }

    const ownerEmail = `owner${seq}@central.test`;
    await person(ownerEmail, [{ ws, kind: "staff", role: "owner" }]);
    const ownerCanonical = await canonicalSignIn(ownerEmail); // level 1
    const r = await start(ws.host, "?return=%2F&level=2");
    expect(await expectStepUp(r.authorize, ownerCanonical)).toBe("level");
    // Without a minimum, a level-1 owner is still sent to SSO as before.
    const plain = await start(ws.host, "?return=%2F");
    const res = await get(
      CANON,
      `${plain.authorize.pathname}${plain.authorize.search}`,
      ownerCanonical,
    );
    expect(location(res)).toBe(`http://${ws.host}/login?sso=1`);
  });

  it("re-auth from a level-1 workspace session at level 1 is unchanged", async () => {
    const ws = await workspace("cl");
    const email = `lvl${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    const { cookie: bound } = await handoff(ws.host, canonical);
    expect((await json<MeBody>(await me(ws.host, bound))).session.authLevel).toBe(1);

    const r = await start(ws.host, "?return=%2F&reauth=1", bound);
    const code = await authorize(r.authorize, canonical);
    expect(code.searchParams.get("code")).not.toBeNull();
    const sid = setCookie(await finish(ws.host, code, r.creq), SID);
    expect((await json<MeBody>(await me(ws.host, `${SID}=${sid}`))).session.authLevel).toBe(1);
  });

  it("a request sealed without a minimum (before E-UP-18) still completes, at the source's level", async () => {
    const ws = await workspace("cl");
    const email = `lvl${seq}@central.test`;
    const { userId } = await person(email, [{ ws }]);
    const enrolled = await enrolWithRecovery(await canonicalSignIn(email));
    await dropToLevel1(enrolled.cookie);

    // The pre-E-UP-18 `start` input: a re-authentication with no `minLevel` at all.
    const kernel = running.container.centralAuth;
    const resolved = await findWorkspaceById(running.container.db, ws.id);
    expect(resolved).toBeDefined();
    const started = await kernel.service?.start({
      workspace: resolved as NonNullable<typeof resolved>,
      origin: `${kernel.baseUrl.protocol}//${ws.host}`,
      returnPath: "/",
      reauth: true,
      reauthUserId: userId,
    });
    if (started?.ok !== true) throw new Error("start refused");
    const code = await authorize(
      new URL(`${BASE}/auth/central/authorize?req=${started.requestToken}`),
      enrolled.cookie,
    );
    expect(code.searchParams.get("code")).not.toBeNull();
    const sid = setCookie(await finish(ws.host, code, started.verifier), SID);
    expect((await json<MeBody>(await me(ws.host, `${SID}=${sid}`))).session.authLevel).toBe(1);
  });
});

describe("return paths", () => {
  it("never leave the workspace host", async () => {
    const ws = await workspace("cx");
    const email = `inv${seq}@central.test`;
    await person(email, [{ ws }]);
    const canonical = await canonicalSignIn(email);
    for (const hostile of [
      "https://evil.test/x",
      "//evil.test/x",
      "/\\evil.test",
      "/%2Fevil.test",
      "javascript:alert(1)",
      "/auth/central/start",
    ]) {
      const { finished } = await handoff(
        ws.host,
        canonical,
        `?return=${encodeURIComponent(hostile)}`,
      );
      expect(location(finished), hostile).toBe("/");
    }
    // A hostile `error` is never echoed.
    const res = await get(ws.host, "/auth/central/finish?error=%3Cscript%3E");
    expect(location(res)).toBe("/login?error=expired");
    // And a forged request token on the canonical host redirects nowhere.
    const forged = await get(CANON, `/auth/central/authorize?req=${"A".repeat(43)}`, canonical);
    expect(forged.status).toBe(404);
    expect(forged.headers.get("location")).toBeNull();
  });
});
