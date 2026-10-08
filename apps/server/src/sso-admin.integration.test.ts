import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { DnsAnswer, DnsRecordType, DnsResolverPort } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";
import {
  createTestSamlIdp,
  EMAIL_NAMEID_FORMAT,
  encodeResponse,
  type FakeOidcIdp,
  parseAuthnRequest,
  startFakeOidcIdp,
} from "./test/sso-idp.js";

/*
 * The staff SSO admin API (E3.8, ADR-0056, `routes/sso.ts`) end to end against a real server on a
 * real database:
 *
 *  - who may read (owner/admin 200; editor/viewer/finance/legal 403; investor 404; anonymous 401)
 *    and write (the owner only — FR1: an admin who could point the workspace at an IdP they control
 *    could sign in as the owner), and which writes need a fresh session (step-up) — re-checking a
 *    domain does not;
 *  - the connection: empty state, strict request bodies, the 10/h save budget, enforcement
 *    preconditions, deletion;
 *  - domains: add → verify against a fake DNS zone (200 while pending, `lastError` says why) →
 *    taken elsewhere → remove;
 *  - SCIM admin: token value shown exactly once, never listed, two live at most; users and groups
 *    pushed through the SCIM protocol, and group → role mapping re-roling members;
 *  - no response ever carries a secret (client secret, SCIM token after the create).
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const h = harness(
  () => running,
  () => mailer,
);
const { request, member } = h;

let acmeId: string;
let betaId: string;
let gammaId: string;
let owner: Actor;
let admin: Actor;
let stale: Actor;
let editor: Actor;
let viewer: Actor;
let finance: Actor;
let legal: Actor;
let ada: Actor;
let betaOwner: Actor;
let gammaOwner: Actor;

/** The fake zone: `name → TXT values`. */
const zone = new Map<string, string[]>();
const fakeDns: DnsResolverPort = {
  driver: "fake",
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
    const values = type === "TXT" ? zone.get(name.toLowerCase()) : undefined;
    return Promise.resolve({
      name,
      type,
      values: [...(values ?? [])],
      rcode: values === undefined ? "nxdomain" : "ok",
      resolver: "fake",
      chain: undefined,
    });
  },
  healthCheck: () => Promise.resolve(),
};

const DOMAIN = "acme-sso-test.com";

interface DomainBody {
  id: string;
  domain: string;
  status: "pending" | "verified";
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

interface TokenView {
  id: string;
  name: string;
  displayPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ScimAdminBody {
  enabled: boolean;
  baseUrl: string;
  tokens: TokenView[];
  counts: { users: number; activeUsers: number; groups: number };
}

async function send(
  slug: string,
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return request(slug, `/api/v1${path}`, {
    method,
    ...(cookie === undefined ? {} : { cookie }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A SCIM protocol request on the canonical host (the ops tree), as the IdP makes it. */
async function scim(token: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({ host: CANON, authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/scim+json");
  return running.app.request(`${BASE}/scim/v2${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Every session of `actor`'s user authenticated `ageMs` ago (past the step-up window). */
async function age(actor: Actor, ageMs: number): Promise<void> {
  await pg.pool.query(
    `UPDATE core.session SET auth_time = now() - ($2::bigint * interval '1 millisecond')
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1) AND revoked_at IS NULL`,
    [actor.membershipId, ageMs],
  );
}

const OIDC_SAVE = {
  protocol: "oidc",
  name: "Nowhere",
  jit: { enabled: false, role: "viewer" },
  mfa: { trust: false, values: [] },
  // Nothing listens on port 9: discovery fails fast, the save is refused (and still charged).
  issuer: "http://127.0.0.1:9/nowhere",
  clientId: "fundroom",
  clientSecret: "client-secret-that-must-never-come-back",
} as const;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      SSO_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    dns: fakeDns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
  gammaId = (await createWorkspace(db, { slug: "gamma", name: "Gamma" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  admin = await member("acme", acmeId, "admin@acme.test", "staff", "admin");
  stale = await member("acme", acmeId, "stale@acme.test", "staff", "owner");
  editor = await member("acme", acmeId, "editor@acme.test", "staff", "editor");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  finance = await member("acme", acmeId, "finance@acme.test", "staff", "finance");
  legal = await member("acme", acmeId, "legal@acme.test", "staff", "legal");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  betaOwner = await member("beta", betaId, "owner@beta.test", "staff", "owner");
  gammaOwner = await member("gamma", gammaId, "owner@gamma.test", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

const READS = [
  "/sso/connection",
  "/sso/domains",
  "/sso/scim",
  "/sso/scim/users",
  "/sso/scim/groups",
] as const;
const ID = "7e57a11c-0000-4000-8000-00000000e038";
/** Every write, with a body that passes validation (the guard answers first anyway). */
const WRITES: readonly (readonly [string, string, unknown, boolean])[] = [
  ["PUT", "/sso/connection", OIDC_SAVE, true],
  ["PUT", "/sso/connection/state", { enabled: true, enforce: "off" }, true],
  ["DELETE", "/sso/connection", undefined, true],
  ["POST", "/sso/domains", { domain: "example.org" }, true],
  ["POST", `/sso/domains/${ID}/verify`, undefined, false],
  ["DELETE", `/sso/domains/${ID}`, undefined, true],
  ["POST", "/sso/scim/tokens", { name: "Entra" }, true],
  ["DELETE", `/sso/scim/tokens/${ID}`, undefined, true],
  ["PUT", `/sso/scim/groups/${ID}/role`, { role: "finance" }, true],
];

describe("who may see and change SSO", () => {
  it("owner and admin read; other staff 403; an investor 404; anonymous 401", async () => {
    for (const path of READS) {
      for (const who of [owner, admin]) {
        const res = await send("acme", who.cookie, "GET", path);
        expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
      }
      for (const who of [editor, viewer, finance, legal]) {
        const res = await send("acme", who.cookie, "GET", path);
        expect(res.status, path).toBe(403);
        expect((await json<ErrorBody>(res)).error.code).toBe("forbidden");
      }
      expect((await send("acme", ada.cookie, "GET", path)).status, path).toBe(404);
      expect((await send("acme", undefined, "GET", path)).status, path).toBe(401);
    }
  });

  it("every write is owner-only: an admin reads but cannot change who gets in", async () => {
    for (const [method, path, body] of WRITES) {
      for (const who of [admin, editor, viewer, finance, legal]) {
        const res = await send("acme", who.cookie, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await json(res)).toMatchObject({
          error: { code: "forbidden", permission: "sso.manage" },
        });
      }
      expect((await send("acme", ada.cookie, method, path, body)).status).toBe(404);
      expect((await send("acme", undefined, method, path, body)).status).toBe(401);
    }
    // Nor may an admin run a test sign-in (it needs sso.manage too).
    const test = await send("acme", admin.cookie, "POST", "/auth/sso/begin", { test: true });
    expect(test.status).toBe(403);
    expect(await json(test)).toMatchObject({
      error: { code: "forbidden", permission: "sso.manage" },
    });
  });

  it("writes that change who gets in need a fresh session; re-checking a domain does not", async () => {
    await age(stale, 20 * 60_000);
    for (const [method, path, body, stepUp] of WRITES) {
      const res = await send("acme", stale.cookie, method, path, body);
      if (stepUp) {
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await json(res)).toMatchObject({
          error: { code: "step_up_required", reason: "fresh" },
        });
      } else {
        // Past the guard: the id matches nothing.
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    // Reads never need freshness.
    expect((await send("acme", stale.cookie, "GET", "/sso/connection")).status).toBe(200);
  });
});

describe("the connection", () => {
  it("starts unconfigured, with the protocols the operator offers", async () => {
    const res = await send("acme", admin.cookie, "GET", "/sso/connection");
    expect(await json(res)).toEqual({
      connection: null,
      protocolsOffered: ["oidc", "saml"],
      spPreview: null,
    });
  });

  it("refuses malformed bodies before the service sees them", async () => {
    for (const body of [
      { ...OIDC_SAVE, extra: true },
      { ...OIDC_SAVE, protocol: "ldap" },
      { ...OIDC_SAVE, jit: { enabled: true, role: "owner" } },
      { ...OIDC_SAVE, name: "" },
      {
        protocol: "saml",
        name: "Both",
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
        metadataXml: "<EntityDescriptor/>",
        idpEntityId: "https://idp.example",
      },
      {
        protocol: "saml",
        name: "Neither",
        jit: { enabled: false, role: "viewer" },
        mfa: { trust: false, values: [] },
      },
    ]) {
      const res = await send("gamma", gammaOwner.cookie, "PUT", "/sso/connection", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<ErrorBody>(res)).error.code).toBe("validation_failed");
    }
  });

  it("state and delete answer 404 sso_not_configured with no connection", async () => {
    for (const [method, path, body] of [
      ["PUT", "/sso/connection/state", { enabled: true, enforce: "off" }],
      ["DELETE", "/sso/connection", undefined],
    ] as const) {
      const res = await send("gamma", gammaOwner.cookie, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await json<ErrorBody>(res)).error.code).toBe("sso_not_configured");
    }
  });

  it("allows 10 save attempts an hour per workspace (refused ones count), then 429", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await send("gamma", gammaOwner.cookie, "PUT", "/sso/connection", OIDC_SAVE);
      const text = await res.text();
      expect(res.status, text).toBe(400);
      expect(text).toContain("sso_invalid_config");
      expect(text).not.toContain(OIDC_SAVE.clientSecret);
    }
    const limited = await send("gamma", gammaOwner.cookie, "PUT", "/sso/connection", OIDC_SAVE);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect((await json<ErrorBody>(limited)).error.code).toBe("rate_limited");
    // Nothing was stored.
    expect((await send("gamma", gammaOwner.cookie, "GET", "/sso/connection")).status).toBe(200);
    expect(
      (await pg.pool.query("SELECT 1 FROM core.sso_connection WHERE workspace_id = $1", [gammaId]))
        .rowCount,
    ).toBe(0);
    // Another workspace's budget is its own.
    const beta = await send("beta", betaOwner.cookie, "PUT", "/sso/connection", OIDC_SAVE);
    expect(beta.status).toBe(400);
  });
});

describe("domains", () => {
  let domain: DomainBody;

  it("refuses a name that is not a hostname", async () => {
    for (const bad of ["not a domain", "-acme.com", "localhost", "acme..com"]) {
      const res = await send("acme", owner.cookie, "POST", "/sso/domains", { domain: bad });
      expect(res.status, bad).toBe(400);
      expect((await json<ErrorBody>(res)).error.code, bad).toBe("sso_domain_invalid");
    }
  });

  it("adds a pending domain with the TXT record to publish", async () => {
    const res = await send("acme", owner.cookie, "POST", "/sso/domains", {
      domain: DOMAIN.toUpperCase(),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    domain = (await json<{ domain: DomainBody }>(res)).domain;
    expect(domain).toMatchObject({
      domain: DOMAIN,
      status: "pending",
      txtName: `_fundroom-sso.${DOMAIN}`,
      verifiedAt: null,
    });
    expect(domain.txtValue).toMatch(/^fundroom-sso=\S{16,}$/u);
    // Adding it again is idempotent: the same pending domain.
    const again = await send("acme", owner.cookie, "POST", "/sso/domains", { domain: DOMAIN });
    expect(again.status).toBe(201);
    expect((await json<{ domain: DomainBody }>(again)).domain.id).toBe(domain.id);
    const list = await json<{ domains: DomainBody[] }>(
      await send("acme", admin.cookie, "GET", "/sso/domains"),
    );
    expect(list.domains.map((d) => d.id)).toEqual([domain.id]);
  });

  it("verify answers 200 while the record is missing, then verifies once it is published", async () => {
    const missing = await send("acme", owner.cookie, "POST", `/sso/domains/${domain.id}/verify`);
    expect(missing.status).toBe(200);
    const pending = (await json<{ domain: DomainBody }>(missing)).domain;
    expect(pending.status).toBe("pending");
    expect(pending.lastError).not.toBeNull();
    expect(pending.lastCheckedAt).not.toBeNull();

    zone.set(domain.txtName, ["v=spf1 -all", domain.txtValue]);
    const ok = await send("acme", owner.cookie, "POST", `/sso/domains/${domain.id}/verify`);
    expect(ok.status).toBe(200);
    const verified = (await json<{ domain: DomainBody }>(ok)).domain;
    expect(verified).toMatchObject({ status: "verified", lastError: null });
    expect(verified.verifiedAt).not.toBeNull();
  });

  it("another workspace cannot verify a domain verified here", async () => {
    const added = await send("beta", betaOwner.cookie, "POST", "/sso/domains", { domain: DOMAIN });
    if (added.status === 409) {
      expect((await json<ErrorBody>(added)).error.code).toBe("sso_domain_taken");
      return;
    }
    expect(added.status).toBe(201);
    const theirs = (await json<{ domain: DomainBody }>(added)).domain;
    zone.set(theirs.txtName, [domain.txtValue, theirs.txtValue]);
    const res = await send("beta", betaOwner.cookie, "POST", `/sso/domains/${theirs.id}/verify`);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.code).toBe("sso_domain_taken");
    expect(
      (await send("beta", betaOwner.cookie, "DELETE", `/sso/domains/${theirs.id}`)).status,
    ).toBe(204);
  });

  /*
   * A-2: `_seedhost-sso` / `seedhost-sso=` → `_fundroom-sso` / `fundroom-sso=`, with a permanent
   * fallback. A domain added before the rename was told to publish the old spelling; any of the
   * four label × prefix combinations carrying this row's token proves it, the old label is read
   * only when the new one did not carry it, and the screen keeps showing the new spelling.
   */
  it("verifies a domain whose admin published the pre-rename label and prefix", async () => {
    const legacyDomain = "legacy-sso-test.com";
    const added = await send("acme", owner.cookie, "POST", "/sso/domains", {
      domain: legacyDomain,
    });
    expect(added.status).toBe(201);
    const pending = (await json<{ domain: DomainBody }>(added)).domain;
    expect(pending.txtName).toBe(`_fundroom-sso.${legacyDomain}`);
    expect(pending.txtValue.startsWith("fundroom-sso=")).toBe(true);
    const secret = pending.txtValue.slice("fundroom-sso=".length);
    const verify = async () =>
      (
        await json<{ domain: DomainBody }>(
          await send("acme", owner.cookie, "POST", `/sso/domains/${pending.id}/verify`),
        )
      ).domain;

    // A wrong token under the new label is not rescued by a wrong one under the old…
    zone.set(`_fundroom-sso.${legacyDomain}`, ["fundroom-sso=not-ours"]);
    zone.set(`_seedhost-sso.${legacyDomain}`, ["seedhost-sso=not-ours-either"]);
    const refused = await verify();
    expect(refused.status).toBe("pending");
    // …and a failure is described against the label the admin is shown.
    expect(refused.lastError).toContain(`_fundroom-sso.${legacyDomain}`);
    expect(refused.lastError).toContain("not this workspace's token");

    // …but the right token under the old label, old prefix, proves the domain.
    zone.set(`_seedhost-sso.${legacyDomain}`, ["v=spf1 -all", `seedhost-sso=${secret}`]);
    const verified = await verify();
    expect(verified).toMatchObject({ status: "verified", lastError: null });
    // The instructions still name only the new spelling.
    expect(verified.txtName).toBe(`_fundroom-sso.${legacyDomain}`);
    expect(verified.txtValue).toBe(`fundroom-sso=${secret}`);
    zone.delete(`_fundroom-sso.${legacyDomain}`);
    zone.delete(`_seedhost-sso.${legacyDomain}`);
    expect((await send("acme", owner.cookie, "DELETE", `/sso/domains/${pending.id}`)).status).toBe(
      204,
    );
  });

  it("accepts the old prefix under the new label, and the new prefix under the old label", async () => {
    for (const [name, label, prefix] of [
      ["mixed-new-label-sso-test.com", "_fundroom-sso", "seedhost-sso="],
      ["mixed-old-label-sso-test.com", "_seedhost-sso", "fundroom-sso="],
    ] as const) {
      const added = await send("acme", owner.cookie, "POST", "/sso/domains", { domain: name });
      expect(added.status).toBe(201);
      const pending = (await json<{ domain: DomainBody }>(added)).domain;
      const secret = pending.txtValue.slice("fundroom-sso=".length);
      zone.set(`${label}.${name}`, [`${prefix}${secret}`]);
      const res = await send("acme", owner.cookie, "POST", `/sso/domains/${pending.id}/verify`);
      expect((await json<{ domain: DomainBody }>(res)).domain.status, `${label} ${prefix}`).toBe(
        "verified",
      );
      zone.delete(`${label}.${name}`);
      expect(
        (await send("acme", owner.cookie, "DELETE", `/sso/domains/${pending.id}`)).status,
      ).toBe(204);
    }
  });

  it("a domain id of another workspace is 404", async () => {
    const res = await send("beta", betaOwner.cookie, "POST", `/sso/domains/${domain.id}/verify`);
    expect(res.status).toBe(404);
    const del = await send("beta", betaOwner.cookie, "DELETE", `/sso/domains/${domain.id}`);
    expect(del.status).toBe(404);
  });
});

interface ConnectionBody {
  id: string;
  protocol: "oidc" | "saml";
  name: string;
  enabled: boolean;
  enforce: "off" | "staff";
  status: string;
  lastError: string | null;
  lastVerifiedAt: string | null;
  lastTestedAt: string | null;
  lastLoginAt: string | null;
  oidc: { issuer: string; clientId: string; hasSecret: boolean } | null;
  saml: {
    idpEntityId: string;
    idpSsoUrl: string;
    certificates: { fingerprintSha256: string; notAfter: string; subject: string }[];
  } | null;
  sp: {
    oidcRedirectUri: string;
    samlAcsUrl: string;
    samlEntityId: string;
    samlMetadataUrl: string;
  };
}

async function connectionOf(slug: string, cookie: string) {
  const res = await send(slug, cookie, "GET", "/sso/connection");
  expect(res.status).toBe(200);
  return json<{ connection: ConnectionBody | null; spPreview: ConnectionBody["sp"] | null }>(res);
}

/**
 * A test sign-in (`POST /auth/sso/begin {test:true}`) through the IdP and back: `idp` plays the
 * browser at the IdP and returns the request our canonical host receives. Returns where finish
 * sent the browser.
 */
async function testSignIn(
  slug: string,
  cookie: string,
  idp: (url: string) => Promise<Response>,
): Promise<string> {
  const begin = await send(slug, cookie, "POST", "/auth/sso/begin", { test: true });
  expect(begin.status, await begin.clone().text()).toBe(200);
  const binding = begin.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  const { url } = await json<{ url: string }>(begin);
  const back = await idp(url);
  expect(back.status, await back.clone().text()).toBe(303);
  const finish = new URL(back.headers.get("location") ?? "");
  const done = await running.app.request(finish.href, {
    headers: { host: finish.host, cookie: `${cookie}; ${binding}` },
  });
  expect(done.status).toBe(302);
  return done.headers.get("location") ?? "";
}

describe("an OIDC connection", () => {
  let idp: FakeOidcIdp;
  let conn: ConnectionBody;

  beforeAll(async () => {
    idp = await startFakeOidcIdp();
  });
  afterAll(async () => {
    await idp?.close();
  });

  const save = (extra: Record<string, unknown> = {}) => ({
    protocol: "oidc",
    name: "Acme IdP",
    jit: { enabled: true, role: "editor" },
    mfa: { trust: false, values: ["mfa"] },
    issuer: idp.issuer,
    clientId: idp.clientId,
    ...extra,
  });

  it("needs the client secret on create", async () => {
    const res = await send("acme", owner.cookie, "PUT", "/sso/connection", save());
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: { code: "sso_invalid_config", reason: "secret_required" },
    });
  });

  it("saves after live discovery, starts disabled, and never returns the secret", async () => {
    const res = await send(
      "acme",
      owner.cookie,
      "PUT",
      "/sso/connection",
      save({ clientSecret: idp.clientSecret }),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(idp.clientSecret);
    conn = (JSON.parse(text) as { connection: ConnectionBody }).connection;
    expect(conn).toMatchObject({
      protocol: "oidc",
      name: "Acme IdP",
      enabled: false,
      enforce: "off",
      status: "active",
      lastError: null,
      lastLoginAt: null,
      jit: { enabled: true, role: "editor" },
      mfa: { trust: false, values: ["mfa"] },
      oidc: { issuer: idp.issuer, clientId: idp.clientId, hasSecret: true },
      saml: null,
      sp: {
        oidcRedirectUri: `${BASE}/sso/oidc/${conn.id}/callback`,
        samlAcsUrl: `${BASE}/sso/saml/${conn.id}/acs`,
        samlMetadataUrl: `${BASE}/sso/saml/${conn.id}/metadata`,
      },
    });
    expect(conn.lastVerifiedAt).not.toBeNull();

    const read = await send("acme", admin.cookie, "GET", "/sso/connection");
    const readText = await read.text();
    expect(readText).not.toContain(idp.clientSecret);
    const body = JSON.parse(readText) as { connection: ConnectionBody; spPreview: unknown };
    expect(body.connection.id).toBe(conn.id);
    expect(body.spPreview).toEqual(conn.sp);
    const [row] = (
      await pg.pool.query<{ blob: string }>(
        `SELECT encode(credentials_enc, 'escape') || coalesce(encryption::text, '') || options::text AS blob
           FROM core.sso_connection WHERE id = $1`,
        [conn.id],
      )
    ).rows;
    expect(row?.blob).not.toContain(idp.clientSecret);
  });

  it("keeps the stored secret on a same-issuer save without one", async () => {
    const res = await send(
      "acme",
      owner.cookie,
      "PUT",
      "/sso/connection",
      save({ name: "Acme Okta" }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const { connection } = await json<{ connection: ConnectionBody }>(res);
    expect(connection).toMatchObject({
      id: conn.id,
      name: "Acme Okta",
      oidc: { hasSecret: true },
    });
  });

  it("enforcement needs a successful sign-in or test; a disabled connection is never enforced", async () => {
    // A disabled connection is never enforced: the request is answered with `enforce: off`.
    const off = await send("acme", owner.cookie, "PUT", "/sso/connection/state", {
      enabled: false,
      enforce: "staff",
    });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ connection: { enabled: false, enforce: "off" } });
    const enabled = await send("acme", owner.cookie, "PUT", "/sso/connection/state", {
      enabled: true,
      enforce: "off",
    });
    expect(enabled.status).toBe(200);
    expect(await json(enabled)).toMatchObject({ connection: { enabled: true, enforce: "off" } });
    const never = await send("acme", owner.cookie, "PUT", "/sso/connection/state", {
      enabled: true,
      enforce: "staff",
    });
    expect(never.status).toBe(409);
    expect(await json(never)).toMatchObject({
      error: { code: "sso_enforce_precondition", reason: "never_signed_in" },
    });

    const landed = await testSignIn("acme", owner.cookie, async (url) => {
      const back = new URL(idp.authorize(url, { claims: { email: "owner@acme.test" } }));
      return running.app.request(back.href, { headers: { host: back.host } });
    });
    expect(landed).toBe("/admin/sso?sso_test=ok");
    expect((await connectionOf("acme", admin.cookie)).connection?.lastTestedAt).not.toBeNull();

    const enforced = await send("acme", owner.cookie, "PUT", "/sso/connection/state", {
      enabled: true,
      enforce: "staff",
    });
    expect(enforced.status, await enforced.clone().text()).toBe(200);
    expect(await json(enforced)).toMatchObject({ connection: { enforce: "staff" } });
    const [ws] = (
      await pg.pool.query<{ sso_enforced: boolean }>(
        "SELECT sso_enforced FROM core.workspace WHERE id = $1",
        [acmeId],
      )
    ).rows;
    expect(ws?.sso_enforced).toBe(true);
  });

  it("disabling turns enforcement off", async () => {
    const off = await send("acme", owner.cookie, "PUT", "/sso/connection/state", {
      enabled: false,
      enforce: "staff",
    });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ connection: { enabled: false, enforce: "off" } });
    const [ws] = (
      await pg.pool.query<{ sso_enforced: boolean }>(
        "SELECT sso_enforced FROM core.workspace WHERE id = $1",
        [acmeId],
      )
    ).rows;
    expect(ws?.sso_enforced).toBe(false);
  });

  it("deletes the connection (204); the next read is empty", async () => {
    const res = await send("acme", owner.cookie, "DELETE", "/sso/connection");
    expect(res.status).toBe(204);
    expect(await connectionOf("acme", admin.cookie)).toEqual({
      connection: null,
      protocolsOffered: ["oidc", "saml"],
      spPreview: null,
    });
    const again = await send("acme", owner.cookie, "DELETE", "/sso/connection");
    expect(again.status).toBe(404);
  });
});

describe("a SAML connection", () => {
  const idp = createTestSamlIdp();
  let conn: ConnectionBody;
  const base = {
    protocol: "saml",
    name: "Beta Entra",
    jit: { enabled: false, role: "viewer" },
    mfa: { trust: false, values: [] },
  };

  it("refuses metadata that is not SAML metadata", async () => {
    const res = await send("beta", betaOwner.cookie, "PUT", "/sso/connection", {
      ...base,
      metadataXml: "<html>not metadata</html>",
    });
    expect(res.status).toBe(400);
    expect((await json<ErrorBody>(res)).error.code).toBe("sso_invalid_config");
  });

  it("saves from the IdP's metadata XML; certificates come back as fingerprints", async () => {
    const res = await send("beta", betaOwner.cookie, "PUT", "/sso/connection", {
      ...base,
      metadataXml: idp.metadataXml(),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain("BEGIN CERTIFICATE");
    conn = (JSON.parse(text) as { connection: ConnectionBody }).connection;
    expect(conn).toMatchObject({
      protocol: "saml",
      enabled: false,
      oidc: null,
      saml: { idpEntityId: idp.entityId, idpSsoUrl: idp.ssoUrl },
      sp: {
        samlAcsUrl: `${BASE}/sso/saml/${conn.id}/acs`,
        samlMetadataUrl: `${BASE}/sso/saml/${conn.id}/metadata`,
      },
    });
    expect(conn.saml?.certificates).toHaveLength(1);
    expect(conn.saml?.certificates[0]?.fingerprintSha256).toMatch(/^[0-9A-Fa-f:]{64,95}$/u);
  });

  it("an update without certificates keeps the saved ones (the admin UI never has the PEMs)", async () => {
    const res = await send("beta", betaOwner.cookie, "PUT", "/sso/connection", {
      ...base,
      name: "Beta Entra ID",
      idpEntityId: idp.entityId,
      idpSsoUrl: idp.ssoUrl,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { connection } = await json<{ connection: ConnectionBody }>(res);
    expect(connection.id).toBe(conn.id);
    expect(connection.name).toBe("Beta Entra ID");
    expect(connection.saml?.certificates).toEqual(conn.saml?.certificates);
  });

  it("a test sign-in through the IdP ends on /admin/sso?sso_test=ok", async () => {
    const landed = await testSignIn("beta", betaOwner.cookie, async (url) => {
      const req = parseAuthnRequest(url);
      const xml = idp.response({
        requestId: req.requestId,
        acsUrl: conn.sp.samlAcsUrl,
        audience: conn.sp.samlEntityId,
        nameId: "owner@beta.test",
        nameIdFormat: EMAIL_NAMEID_FORMAT,
      });
      const acs = new URL(conn.sp.samlAcsUrl);
      return running.app.request(acs.href, {
        method: "POST",
        headers: { host: acs.host, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          SAMLResponse: encodeResponse(xml),
          RelayState: req.relayState,
        }).toString(),
      });
    });
    expect(landed).toBe("/admin/sso?sso_test=ok");
    expect((await connectionOf("beta", betaOwner.cookie)).connection?.lastTestedAt).not.toBeNull();
  });
});

describe("SCIM admin", () => {
  const tokens: { token: string; view: TokenView }[] = [];

  it("shows the base URL and no tokens", async () => {
    const res = await send("acme", admin.cookie, "GET", "/sso/scim");
    expect(await json(res)).toEqual({
      enabled: true,
      baseUrl: `${BASE}/scim/v2`,
      tokens: [],
      counts: { users: 0, activeUsers: 0, groups: 0 },
    });
  });

  it("returns a token's value once, lists it without the value, and caps live tokens at two", async () => {
    for (const name of ["Entra", "Entra (rotation)"]) {
      const res = await send("acme", owner.cookie, "POST", "/sso/scim/tokens", { name });
      expect(res.status, await res.clone().text()).toBe(201);
      const created = await json<{ token: string; view: TokenView }>(res);
      expect(created.token).toMatch(/^frs_[A-Za-z0-9_-]{43}$/u);
      expect(created.view).toMatchObject({ name, lastUsedAt: null });
      expect(created.token.startsWith(created.view.displayPrefix)).toBe(true);
      tokens.push(created);
    }
    const third = await send("acme", owner.cookie, "POST", "/sso/scim/tokens", { name: "Okta" });
    expect(third.status).toBe(409);
    expect((await json<ErrorBody>(third)).error.code).toBe("scim_token_limit");

    const text = await (await send("acme", admin.cookie, "GET", "/sso/scim")).text();
    for (const t of tokens) expect(text).not.toContain(t.token);
    const view = JSON.parse(text) as ScimAdminBody;
    expect(view.tokens.map((t) => t.id).sort()).toEqual(tokens.map((t) => t.view.id).sort());
  });

  it("a revoked token stops working and frees a slot", async () => {
    const [first] = tokens;
    if (first === undefined) throw new Error("no token");
    expect((await scim(first.token, "GET", "/Users")).status).toBe(200);
    const res = await send("acme", owner.cookie, "DELETE", `/sso/scim/tokens/${first.view.id}`);
    expect(res.status).toBe(204);
    expect((await scim(first.token, "GET", "/Users")).status).toBe(401);
    // Another workspace cannot revoke acme's token.
    const other = tokens[1];
    if (other === undefined) throw new Error("no token");
    expect(
      (await send("beta", betaOwner.cookie, "DELETE", `/sso/scim/tokens/${other.view.id}`)).status,
    ).toBe(404);
    const again = await send("acme", owner.cookie, "POST", "/sso/scim/tokens", { name: "Okta" });
    expect(again.status).toBe(201);
    tokens.splice(0, 1, await json<{ token: string; view: TokenView }>(again));
  });

  it("lists SCIM users and groups, and maps a group to a role that re-roles its members", async () => {
    const token = tokens[0]?.token ?? "";
    const created = await scim(token, "POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: `sam@${DOMAIN}`,
      name: { givenName: "Sam", familyName: "Scim" },
      displayName: "Sam Scim",
      emails: [{ value: `sam@${DOMAIN}`, type: "work", primary: true }],
      active: true,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const user = await json<{ id: string }>(created);
    const group = await scim(token, "POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "Finance team",
      members: [{ value: user.id }],
    });
    expect(group.status, await group.clone().text()).toBe(201);
    const groupId = (await json<{ id: string }>(group)).id;

    const users = await json<{
      items: { id: string; userName: string; role: string | null; groups: string[] }[];
      nextCursor: string | null;
    }>(await send("acme", admin.cookie, "GET", "/sso/scim/users?limit=10"));
    expect(users.nextCursor).toBeNull();
    expect(users.items).toEqual([
      expect.objectContaining({
        id: user.id,
        userName: `sam@${DOMAIN}`,
        role: "viewer",
        groups: ["Finance team"],
      }),
    ]);

    const groups = await json<{ groups: { id: string; role: string | null }[] }>(
      await send("acme", admin.cookie, "GET", "/sso/scim/groups"),
    );
    expect(groups.groups).toEqual([
      expect.objectContaining({
        id: groupId,
        displayName: "Finance team",
        role: null,
        memberCount: 1,
      }),
    ]);

    const mapped = await send("acme", owner.cookie, "PUT", `/sso/scim/groups/${groupId}/role`, {
      role: "finance",
    });
    expect(mapped.status).toBe(200);
    expect(await json(mapped)).toMatchObject({ group: { id: groupId, role: "finance" } });
    const after = await json<{ items: { role: string | null }[] }>(
      await send("acme", admin.cookie, "GET", "/sso/scim/users"),
    );
    expect(after.items[0]?.role).toBe("finance");

    // Never owner; `null` unmaps.
    const owned = await send("acme", owner.cookie, "PUT", `/sso/scim/groups/${groupId}/role`, {
      role: "owner",
    });
    expect(owned.status).toBe(400);
    const unmapped = await send("acme", owner.cookie, "PUT", `/sso/scim/groups/${groupId}/role`, {
      role: null,
    });
    expect(await json(unmapped)).toMatchObject({ group: { role: null } });
    const back = await json<{ items: { role: string | null }[] }>(
      await send("acme", admin.cookie, "GET", "/sso/scim/users"),
    );
    expect(back.items[0]?.role).toBe("viewer");

    const counts = await json<ScimAdminBody>(await send("acme", admin.cookie, "GET", "/sso/scim"));
    expect(counts.counts).toEqual({ users: 1, activeUsers: 1, groups: 1 });
    // Another workspace sees none of it.
    const beta = await json<{ groups: unknown[] }>(
      await send("beta", betaOwner.cookie, "GET", "/sso/scim/groups"),
    );
    expect(beta.groups).toEqual([]);
    expect(
      (
        await send("beta", betaOwner.cookie, "PUT", `/sso/scim/groups/${groupId}/role`, {
          role: "admin",
        })
      ).status,
    ).toBe(404);
  });
});
