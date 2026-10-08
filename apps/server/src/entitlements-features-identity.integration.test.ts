import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyWorkspace, writeCheckpoint } from "@fundroom/audit";
import { createFakeAnchor, type FakeAnchor } from "@fundroom/audit/testing";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createAccessReviewJobs, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { EntitlementsPort } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evidenceCommand } from "./cli-commands/evidence.js";
import { createEntitlements } from "./entitlements.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer } from "./test/api-keys.js";
import {
  type Actor,
  BASE,
  CANON,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  waitFor,
} from "./test/esign-harness.js";
import { withSetCookies } from "./test/session-cookies.js";
import { type FakeOidcIdp, fakeDns, startFakeOidcIdp } from "./test/sso-idp.js";

/*
 * Plan entitlements, identity-side features (A-3 / E-UP-2, ADR-0063; contract §4 rows owned by
 * B1): `sso`, `scim`, `api_keys`, `webhooks`, `access_reviews`, `anchoring`.
 *
 * For each: a plan that includes the feature behaves exactly as before; a plan without it answers
 * 402 `plan_limit` `{ limit: "feature", feature }` on the routes that turn it on — after the
 * route's own guards, so anonymous callers, investors and staff without the permission keep their
 * old answers (no oracle) — while everything already set up keeps working (an existing SSO
 * connection signs people in and stays enforced, SCIM tokens provision, API keys authenticate and
 * can be rotated and revoked, endpoints deliver and can be disabled, past reviews and anchors stay
 * readable). The two jobs skip workspaces without the feature. CONTROL_PLANE=off, or a workspace
 * without a plan, is never gated.
 *
 * "Downgrade" = moving the workspace from plan `full` (no lists: everything) to plan `bare`
 * (`features: []`, no module list, so no module turns read-only here).
 */
let pg: TestPostgres;
let running: RunningServer;
/** The same database and secrets with CONTROL_PLANE off (every self-hosted install). */
let off: RunningServer;
let mailer: MemoryMailer;
let idp: FakeOidcIdp;
let anchor: FakeAnchor;
const dns = fakeDns();
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql } = h;

type ErrorBody = {
  error: { code: string; limit?: string; feature?: string; module?: string; max?: number };
};

interface Ws {
  readonly id: string;
  readonly slug: string;
  readonly owner: Actor;
}

// --- receiver for webhook deliveries ---------------------------------------------------------

interface Hit {
  readonly name: string;
  readonly type: string;
}
const hits: Hit[] = [];
let receiver: HttpServer;
let port: number;
const hookUrl = (name: string, v = 1) => `http://127.0.0.1:${port}/r/${name}/v${v}`;

// --- helpers -----------------------------------------------------------------------------------

async function su<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

let seq = 0;
async function workspace(prefix: string, plan: "full" | "bare" | null): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const owner = await member(slug, id, `owner@${slug}.example.org`, "staff", "owner");
  await assignPlan(id, plan);
  return { id, slug, owner };
}

/** Puts a plan on a workspace the way the control plane does (host context). */
async function assignPlan(workspaceId: string, plan: "full" | "bare" | null): Promise<void> {
  await running.container.db.withHost((tx) =>
    tx.execute(
      `UPDATE core.workspace SET plan_id = ${plan === null ? "NULL" : `'${plan}'`} WHERE id = '${workspaceId}'`,
    ),
  );
  running.container.resolver.invalidate();
  off?.container.resolver.invalidate();
}

function call(
  ws: Pick<Ws, "slug">,
  method: string,
  path: string,
  body?: unknown,
  init: {
    cookie?: string | undefined;
    headers?: Record<string, string>;
    server?: RunningServer;
  } = {},
): Promise<Response> {
  return request(ws.slug, `/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.server === undefined ? {} : { server: init.server }),
  });
}

async function expectStatus(res: Response, status: number, label = ""): Promise<string> {
  const text = await res.text();
  expect(res.status, `${label} ${text}`).toBe(status);
  return text;
}

/** The exact refusal (§2): 402 `plan_limit`, `limit: "feature"`, the feature, no `max`. */
async function expectFeatureRefused(res: Response, feature: string, label = ""): Promise<void> {
  const text = await expectStatus(res, 402, label);
  const body = JSON.parse(text) as ErrorBody;
  expect(body.error).toMatchObject({ code: "plan_limit", limit: "feature", feature });
  expect(body.error.max).toBeUndefined();
  expect(body.error.module).toBeUndefined();
}

/** A staff member with no sign-in yet (user + membership). */
async function person(
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: string,
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
  return { userId, membershipId: m.id };
}

// --- SSO sign-in through the fake IdP (as sso-flow.integration.test.ts does) ------------------

async function canonical(url: string): Promise<Response> {
  return running.app.request(url, { headers: { host: CANON } });
}

async function oidcLogin(
  slug: string,
  claims: Record<string, unknown>,
): Promise<{ location: string; jar: string }> {
  const begin = await request(slug, "/api/v1/auth/sso/begin", {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(begin.status).toBe(200);
  const { url } = await json<{ url: string }>(begin);
  const jar = withSetCookies("", begin);
  const cb = await canonical(idp.authorize(url, { claims }));
  expect(cb.status).toBe(303);
  const handoff = new URL(cb.headers.get("location") ?? "");
  expect(handoff.pathname).toBe("/api/v1/auth/sso/finish");
  const fin = await request(slug, `${handoff.pathname}${handoff.search}`, { cookie: jar });
  expect(fin.status).toBe(302);
  return { location: fin.headers.get("location") ?? "", jar: withSetCookies(jar, fin) };
}

// --- setup -------------------------------------------------------------------------------------

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let type = "";
      try {
        type = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type: string }).type;
      } catch {
        type = "";
      }
      hits.push({ name: (req.url ?? "").split("/")[2] ?? "", type });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  port = (receiver.address() as AddressInfo).port;

  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  idp = await startFakeOidcIdp();
  anchor = createFakeAnchor({ kind: "faketsa" });
  const secrets = freshSecrets(pg.connectionString);
  const env = {
    SSO_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
    WEBHOOK_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
  };
  running = await startServer({
    config: esignTestConfig(secrets, { ...env, CONTROL_PLANE: "on" }),
    logger: createLogger({ level: "error" }),
    mailer,
    dns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
    auditAnchorDrivers: [anchor],
  });
  off = await startServer({
    config: esignTestConfig(secrets, { ...env, ROLES: "api", CONTROL_PLANE: "off" }),
    logger: createLogger({ level: "error" }),
    mailer,
    dns,
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  await su(
    `INSERT INTO core.plan (id, name, limits, limits_schema_version)
     VALUES ('full', 'Full', '{}'::jsonb, 2), ('bare', 'Bare', '{"features": []}'::jsonb, 2)`,
  );
}, 300_000);

afterAll(async () => {
  await off?.stop();
  await running?.stop();
  await idp?.close();
  await pg?.stop();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
});

// --- sso ---------------------------------------------------------------------------------------

describe("sso", () => {
  let ws: Ws;
  /** A staff member with an ordinary (email code + TOTP) session, signed in before enforcement. */
  let viewer: Actor;
  let domainId: string;
  const save = (o: { jit?: boolean; trust?: boolean } = {}) => ({
    protocol: "oidc",
    name: "Acme IdP",
    jit: { enabled: o.jit ?? false, role: "viewer" },
    mfa: { trust: o.trust ?? false, values: [] },
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
  });
  const state = (enabled: boolean, enforce: "off" | "staff") =>
    call(ws, "PUT", "/sso/connection/state", { enabled, enforce }, { cookie: ws.owner.cookie });

  beforeAll(async () => {
    ws = await workspace("sso", "full");
    viewer = await member(ws.slug, ws.id, `vic@${ws.slug}.example.org`, "staff", "viewer");
  });

  it("on a plan with the feature: configure, add + verify a domain, enable, sign in, enforce", async () => {
    await expectStatus(
      await call(ws, "PUT", "/sso/connection", save({ jit: true }), { cookie: ws.owner.cookie }),
      200,
      "save",
    );
    const added = await call(
      ws,
      "POST",
      "/sso/domains",
      { domain: `${ws.slug}-corp.com` },
      { cookie: ws.owner.cookie },
    );
    const domain = JSON.parse(await expectStatus(added, 201, "domain")) as {
      domain: { id: string; txtName: string; txtValue: string };
    };
    domainId = domain.domain.id;
    dns.txt.set(domain.domain.txtName, [domain.domain.txtValue]);
    const verified = await call(ws, "POST", `/sso/domains/${domainId}/verify`, undefined, {
      cookie: ws.owner.cookie,
    });
    expect(JSON.parse(await expectStatus(verified, 200, "verify")).domain.status).toBe("verified");
    await expectStatus(await state(true, "off"), 200, "enable");
    await person(ws.id, `carol@${ws.slug}.example.org`, "staff", "editor");
    const first = await oidcLogin(ws.slug, {
      sub: "carol-sub",
      email: `carol@${ws.slug}.example.org`,
    });
    expect(first.location).toBe("/");
    await expectStatus(await state(true, "staff"), 200, "enforce");
  });

  it("after a downgrade: a new connection or domain is 402; re-keying works; it keeps signing in and stays enforced", async () => {
    await assignPlan(ws.id, "bare");

    // Decision 1: re-keying the existing connection (same IdP, a new client secret) is
    // maintenance. The IdP checks the secret at its token endpoint, so the sign-in below proves
    // the connection still works with what was saved.
    const rekeyed = await call(ws, "PUT", "/sso/connection", save({ jit: true }), {
      cookie: ws.owner.cookie,
    });
    const view = JSON.parse(await expectStatus(rekeyed, 200, "re-key")) as {
      connection: { enabled: boolean; enforce: string; jit: { enabled: boolean } };
    };
    expect(view.connection).toMatchObject({
      enabled: true,
      enforce: "staff",
      jit: { enabled: true },
    });
    // Decision 18: a re-key may keep JIT on or turn it off, never switch JIT or trusted IdP MFA on.
    await expectFeatureRefused(
      await call(ws, "PUT", "/sso/connection", save({ jit: true, trust: true }), {
        cookie: ws.owner.cookie,
      }),
      "sso",
      "trust MFA on",
    );
    await expectStatus(
      await call(ws, "PUT", "/sso/connection", save(), { cookie: ws.owner.cookie }),
      200,
      "JIT off",
    );
    await expectFeatureRefused(
      await call(ws, "PUT", "/sso/connection", save({ jit: true }), { cookie: ws.owner.cookie }),
      "sso",
      "JIT on again",
    );
    const [stored] = await su<{ jit_enabled: boolean; options: { trustMfa?: boolean } }>(
      "SELECT jit_enabled, options FROM core.sso_connection WHERE workspace_id = $1 AND deleted_at IS NULL",
      [ws.id],
    );
    expect(stored?.jit_enabled).toBe(false);
    expect(stored?.options.trustMfa ?? false).toBe(false);
    // Another protocol is a new connection (refused before any IdP is contacted) …
    await expectFeatureRefused(
      await call(
        ws,
        "PUT",
        "/sso/connection",
        {
          protocol: "saml",
          name: "Other",
          jit: { enabled: false, role: "viewer" },
          mfa: { trust: false, values: [] },
          idpEntityId: "https://idp.other.example/saml",
          idpSsoUrl: "https://idp.other.example/sso",
        },
        { cookie: ws.owner.cookie },
      ),
      "sso",
      "protocol switch",
    );
    // … and so is another IdP on the same protocol (judged on the locked row, after discovery).
    const other = await startFakeOidcIdp({ path: "/other" });
    try {
      await expectFeatureRefused(
        await call(
          ws,
          "PUT",
          "/sso/connection",
          { ...save(), issuer: other.issuer, clientId: other.clientId, clientSecret: "x" },
          { cookie: ws.owner.cookie },
        ),
        "sso",
        "another issuer",
      );
    } finally {
      await other.close();
    }
    const [conns] = await su<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.sso_connection WHERE workspace_id = $1 AND deleted_at IS NULL",
      [ws.id],
    );
    expect(conns?.n).toBe(1);
    await expectFeatureRefused(
      await call(ws, "POST", "/sso/domains", { domain: "other.com" }, { cookie: ws.owner.cookie }),
      "sso",
      "add domain",
    );
    await expectFeatureRefused(
      await call(ws, "POST", `/sso/domains/${domainId}/verify`, undefined, {
        cookie: ws.owner.cookie,
      }),
      "sso",
      "verify",
    );

    // Keeps working: sign-in through the existing connection, on a session bound to it.
    const again = await oidcLogin(ws.slug, {
      sub: "carol-sub",
      email: `carol@${ws.slug}.example.org`,
    });
    expect(again.location).toBe("/");
    await expectStatus(await request(ws.slug, "/api/v1/me", { cookie: again.jar }), 200, "me");
    // Keeps working: enforcement (the viewer's ordinary session is held out).
    const held = await call(ws, "GET", "/access/people", undefined, { cookie: viewer.cookie });
    expect(held.status).toBe(403);
    expect((await json<ErrorBody>(held)).error.code).toBe("sso_required");
    const [mirror] = await su<{ sso_enforced: boolean }>(
      "SELECT sso_enforced FROM core.workspace WHERE id = $1",
      [ws.id],
    );
    expect(mirror?.sso_enforced).toBe(true);
    // Reads stay open.
    await expectStatus(
      await call(ws, "GET", "/sso/connection", undefined, { cookie: ws.owner.cookie }),
      200,
    );
    await expectStatus(
      await call(ws, "GET", "/sso/domains", undefined, { cookie: ws.owner.cookie }),
      200,
    );

    // The state toggle is gated on the transition only.
    await expectStatus(await state(true, "staff"), 200, "unchanged");
    await expectStatus(await state(true, "off"), 200, "enforcement off");
    await expectFeatureRefused(await state(true, "staff"), "sso", "enforce again");
    await expectStatus(await state(false, "off"), 200, "disable");
    await expectFeatureRefused(await state(true, "off"), "sso", "enable again");
    // A disabled connection is never enforced, so this turns nothing on.
    await expectStatus(await state(false, "staff"), 200, "disabled + staff");

    // Removing what exists stays open.
    await expectStatus(
      await call(ws, "DELETE", `/sso/domains/${domainId}`, undefined, { cookie: ws.owner.cookie }),
      204,
      "remove domain",
    );
    await expectStatus(
      await call(ws, "DELETE", "/sso/connection", undefined, { cookie: ws.owner.cookie }),
      204,
      "delete",
    );
    // With no connection the state route still answers its own 404 (the gate never reads one).
    expect((await state(true, "off")).status).toBe(404);
    // And a connection can no longer be created.
    await expectFeatureRefused(
      await call(ws, "PUT", "/sso/connection", save(), { cookie: ws.owner.cookie }),
      "sso",
      "create",
    );
  });
});

// --- scim --------------------------------------------------------------------------------------

describe("scim", () => {
  const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
  const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
  let ws: Ws;
  let token: string;
  let tokenId: string;
  let groupId: string;

  const scim = (bearerToken: string, method: string, path: string, body?: unknown) =>
    running.app.request(`${BASE}/scim/v2${path}`, {
      method,
      headers: {
        host: CANON,
        authorization: `Bearer ${bearerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const user = (local: string) => ({
    schemas: [USER],
    userName: `${local}@${ws.slug}.test`,
    active: true,
    emails: [{ primary: true, type: "work", value: `${local}@${ws.slug}.test` }],
    name: { givenName: local, familyName: "Test" },
  });

  beforeAll(async () => {
    ws = await workspace("scim", "full");
    await su(
      `INSERT INTO core.sso_domain (workspace_id, domain, token, status, verified_at)
       VALUES ($1, $2, 'tok-0123456789abcdef', 'verified', now())`,
      [ws.id, `${ws.slug}.test`],
    );
  });

  it("on a plan with the feature: mint a token, provision, map a group", async () => {
    const created = await call(
      ws,
      "POST",
      "/sso/scim/tokens",
      { name: "Entra" },
      { cookie: ws.owner.cookie },
    );
    const body = JSON.parse(await expectStatus(created, 201, "token")) as {
      token: string;
      view: { id: string };
    };
    token = body.token;
    tokenId = body.view.id;
    await expectStatus(await scim(token, "POST", "/Users", user("ann")), 201, "user");
    await expectStatus(
      await scim(token, "POST", "/Groups", { schemas: [GROUP], displayName: "Finance" }),
      201,
      "group",
    );
    const groups = await json<{ groups: { id: string; displayName: string }[] }>(
      await call(ws, "GET", "/sso/scim/groups", undefined, { cookie: ws.owner.cookie }),
    );
    groupId = groups.groups.find((g) => g.displayName === "Finance")?.id as string;
    await expectStatus(
      await call(
        ws,
        "PUT",
        `/sso/scim/groups/${groupId}/role`,
        { role: "finance" },
        { cookie: ws.owner.cookie },
      ),
      200,
      "map",
    );
  });

  it("after a downgrade: rotation and mappings work, /scim/v2 keeps provisioning; only a first token is 402", async () => {
    await assignPlan(ws.id, "bare");
    // Decision 2: a token minted while one is live is rotation.
    const second = JSON.parse(
      await expectStatus(
        await call(ws, "POST", "/sso/scim/tokens", { name: "Again" }, { cookie: ws.owner.cookie }),
        201,
        "rotation token",
      ),
    ) as { token: string; view: { id: string } };
    await expectStatus(await scim(second.token, "GET", "/Users"), 200, "rotated token");
    // Group → role mappings are maintenance (an owner must be able to demote a group).
    await expectStatus(
      await call(
        ws,
        "PUT",
        `/sso/scim/groups/${groupId}/role`,
        { role: null },
        { cookie: ws.owner.cookie },
      ),
      200,
      "unmap",
    );
    await expectStatus(
      await call(ws, "DELETE", `/sso/scim/tokens/${second.view.id}`, undefined, {
        cookie: ws.owner.cookie,
      }),
      204,
      "revoke rotation token",
    );
    // The IdP's existing token keeps provisioning.
    await expectStatus(await scim(token, "POST", "/Users", user("bob")), 201, "provision");
    await expectStatus(await scim(token, "GET", "/Users"), 200, "list");
    const overview = await json<{ counts: { users: number } }>(
      await call(ws, "GET", "/sso/scim", undefined, { cookie: ws.owner.cookie }),
    );
    expect(overview.counts.users).toBe(2);
    // Revoking stays open; the IdP is then refused.
    await expectStatus(
      await call(ws, "DELETE", `/sso/scim/tokens/${tokenId}`, undefined, {
        cookie: ws.owner.cookie,
      }),
      204,
      "revoke",
    );
    expect((await scim(token, "GET", "/Users")).status).toBe(401);
    // With no live token, a new one would start provisioning again: refused.
    await expectFeatureRefused(
      await call(ws, "POST", "/sso/scim/tokens", { name: "Restart" }, { cookie: ws.owner.cookie }),
      "scim",
      "first token",
    );
  });
});

// --- api_keys ----------------------------------------------------------------------------------

describe("api_keys", () => {
  let ws: Ws;
  let token: string;
  let keyId: string;
  const create = (cookie: string, server?: RunningServer) =>
    call(
      ws,
      "POST",
      "/api-keys",
      { name: "Zapier", scopes: ["webhooks.read"] },
      { cookie, ...(server === undefined ? {} : { server }) },
    );
  const asKey = (t: string) =>
    call(ws, "GET", "/webhooks/deliveries", undefined, { headers: bearer(t) });

  beforeAll(async () => {
    ws = await workspace("keys", "full");
  });

  it("on a plan with the feature: a key is created and authenticates", async () => {
    const body = JSON.parse(await expectStatus(await create(ws.owner.cookie), 201)) as {
      key: { id: string };
      token: string;
    };
    token = body.token;
    keyId = body.key.id;
    await expectStatus(await asKey(token), 200, "key");
  });

  it("after a downgrade: creating is 402; the key authenticates and can be renamed, rotated, revoked", async () => {
    await assignPlan(ws.id, "bare");
    await expectFeatureRefused(await create(ws.owner.cookie), "api_keys");
    await expectStatus(await asKey(token), 200, "existing key");
    await expectStatus(
      await call(
        ws,
        "PATCH",
        `/api-keys/${keyId}`,
        { name: "Zapier (old)" },
        {
          cookie: ws.owner.cookie,
        },
      ),
      200,
      "rename",
    );
    const rotated = JSON.parse(
      await expectStatus(
        await call(
          ws,
          "POST",
          `/api-keys/${keyId}/rotate`,
          { graceHours: 0 },
          {
            cookie: ws.owner.cookie,
          },
        ),
        201,
        "rotate",
      ),
    ) as { key: { id: string }; token: string };
    expect((await asKey(token)).status).toBe(401);
    await expectStatus(await asKey(rotated.token), 200, "rotated key");
    await expectStatus(
      await call(ws, "POST", `/api-keys/${rotated.key.id}/revoke`, undefined, {
        cookie: ws.owner.cookie,
      }),
      200,
      "revoke",
    );
    expect((await asKey(rotated.token)).status).toBe(401);
    await expectStatus(
      await call(ws, "GET", "/api-keys", undefined, { cookie: ws.owner.cookie }),
      200,
    );
  });
});

// --- webhooks ----------------------------------------------------------------------------------

describe("webhooks", () => {
  let ws: Ws;
  let endpointId: string;
  let topics: string[];
  const patch = (body: unknown) =>
    call(ws, "PATCH", `/webhooks/endpoints/${endpointId}`, body, { cookie: ws.owner.cookie });

  beforeAll(async () => {
    ws = await workspace("hooks", "full");
    const list = await json<{ topics: { topic: string }[] }>(
      await call(ws, "GET", "/webhooks/topics", undefined, { cookie: ws.owner.cookie }),
    );
    topics = list.topics.map((t) => t.topic);
    expect(topics).toContain("membership.created");
  });

  it("on a plan with the feature: an endpoint is added and changed", async () => {
    const other = topics.find((t) => t !== "membership.created") as string;
    const created = await call(
      ws,
      "POST",
      "/webhooks/endpoints",
      { url: hookUrl(ws.slug), events: ["membership.created", other] },
      { cookie: ws.owner.cookie },
    );
    endpointId = (
      JSON.parse(await expectStatus(created, 201, "create")) as { endpoint: { id: string } }
    ).endpoint.id;
    await expectStatus(await patch({ url: hookUrl(ws.slug, 2) }), 200, "url");
  });

  it("after a downgrade: new endpoints, re-pointing and new topics are 402; maintenance and deliveries go on", async () => {
    await assignPlan(ws.id, "bare");
    const other = topics.find((t) => t !== "membership.created") as string;
    const third = topics.find((t) => t !== "membership.created" && t !== other) as string;
    await expectFeatureRefused(
      await call(
        ws,
        "POST",
        "/webhooks/endpoints",
        { url: hookUrl("second"), events: ["membership.created"] },
        { cookie: ws.owner.cookie },
      ),
      "webhooks",
      "create",
    );
    await expectFeatureRefused(await patch({ url: hookUrl(ws.slug, 3) }), "webhooks", "url");
    await expectFeatureRefused(
      await patch({ events: ["membership.created", other, third] }),
      "webhooks",
      "add a topic",
    );
    // Decision 3: the same URL, the same topics, and removing a topic are maintenance.
    await expectStatus(await patch({ url: hookUrl(ws.slug, 2) }), 200, "same url");
    await expectStatus(
      await patch({ events: [other, "membership.created"], description: "CRM" }),
      200,
      "same topics",
    );
    await expectStatus(await patch({ events: ["membership.created"] }), 200, "remove a topic");
    // Nothing was written by the refusals.
    const [row] = await sql<{ events: string[]; url_host: string; description: string }>(
      ws.id,
      `SELECT events, url_host, description FROM core.webhook_endpoint WHERE id = '${endpointId}'`,
    );
    expect(row?.events).toEqual(["membership.created"]);
    expect(row?.description).toBe("CRM");

    // Keeps delivering: a real event, and a test ping.
    await person(ws.id, `new@${ws.slug}.example.org`, "staff", "viewer");
    await waitFor("membership.created delivery", async () =>
      hits.some((x) => x.name === ws.slug && x.type === "membership.created"),
    );
    await expectStatus(
      await call(ws, "POST", `/webhooks/endpoints/${endpointId}/test`, undefined, {
        cookie: ws.owner.cookie,
      }),
      202,
      "test",
    );
    await waitFor("ping delivery", async () =>
      hits.some((x) => x.name === ws.slug && x.type === "webhook.ping"),
    );
    await expectStatus(
      await call(ws, "GET", "/webhooks/deliveries", undefined, { cookie: ws.owner.cookie }),
      200,
    );
    const rotated = await call(
      ws,
      "POST",
      `/webhooks/endpoints/${endpointId}/rotate-secret`,
      { graceHours: 0 },
      { cookie: ws.owner.cookie },
    );
    await expectStatus(rotated, 200, "rotate");

    // An endpoint the system disabled (the receiver kept failing) may be switched back on: the
    // receiver recovered, nothing new is added.
    await su(
      "UPDATE core.webhook_endpoint SET enabled = false, disabled_reason = 'failing' WHERE id = $1",
      [endpointId],
    );
    await expectStatus(await patch({ enabled: true }), 200, "re-enable after failing");
    // Disabling is always open; switching back on what a person switched off is gated.
    await expectStatus(await patch({ enabled: false }), 200, "disable");
    await expectStatus(await patch({ enabled: false }), 200, "still disabled");
    await expectFeatureRefused(await patch({ enabled: true }), "webhooks", "re-enable");
    await expectStatus(
      await call(ws, "DELETE", `/webhooks/endpoints/${endpointId}`, undefined, {
        cookie: ws.owner.cookie,
      }),
      200,
      "delete",
    );
  }, 60_000);
});

// --- access_reviews ----------------------------------------------------------------------------

describe("access_reviews", () => {
  let ws: Ws;
  let reviewId: string;
  const complete = (cookie: string, server?: RunningServer) =>
    call(
      ws,
      "POST",
      "/access/reviews",
      { note: "Quarterly" },
      { cookie, ...(server === undefined ? {} : { server }) },
    );

  beforeAll(async () => {
    ws = await workspace("rev", "full");
  });

  it("on a plan with the feature: a review is completed", async () => {
    reviewId = (
      JSON.parse(await expectStatus(await complete(ws.owner.cookie), 201)) as {
        id: string;
      }
    ).id;
  });

  it("after a downgrade: completing is 402; the report, past reviews and their evidence stay readable", async () => {
    await assignPlan(ws.id, "bare");
    await expectFeatureRefused(await complete(ws.owner.cookie), "access_reviews");
    await expectStatus(
      await call(ws, "GET", "/access/review", undefined, { cookie: ws.owner.cookie }),
      200,
      "report",
    );
    const past = await json<{ items: { id: string }[] }>(
      await call(ws, "GET", "/access/reviews", undefined, { cookie: ws.owner.cookie }),
    );
    expect(past.items.map((r) => r.id)).toEqual([reviewId]);
    await expectStatus(
      await call(ws, "GET", `/access/reviews/${reviewId}/report`, undefined, {
        cookie: ws.owner.cookie,
      }),
      200,
      "evidence",
    );
  });
});

// --- no oracle ---------------------------------------------------------------------------------

describe("the refusal is never an oracle", () => {
  it("anonymous callers, investors and staff without the permission keep their answers", async () => {
    const ws = await workspace("orc", "bare");
    const viewer = await member(ws.slug, ws.id, `viewer@${ws.slug}.example.org`, "staff", "viewer");
    const investor = await member(
      ws.slug,
      ws.id,
      `ivy@${ws.slug}.example.org`,
      "external",
      "investor",
    );
    const id = "01920000-0000-7000-8000-0000000000aa";
    const gated: [string, string, unknown][] = [
      [
        "PUT",
        "/sso/connection",
        {
          protocol: "oidc",
          name: "x",
          jit: { enabled: false, role: "viewer" },
          mfa: { trust: false, values: [] },
          issuer: "https://idp.example.com",
          clientId: "c",
          clientSecret: "s",
        },
      ],
      ["PUT", "/sso/connection/state", { enabled: true, enforce: "staff" }],
      ["POST", "/sso/domains", { domain: "x.com" }],
      ["POST", `/sso/domains/${id}/verify`, undefined],
      ["POST", "/sso/scim/tokens", { name: "x" }],
      ["PUT", `/sso/scim/groups/${id}/role`, { role: "viewer" }],
      ["POST", "/api-keys", { name: "x", scopes: ["webhooks.read"] }],
      [
        "POST",
        "/webhooks/endpoints",
        { url: "https://hooks.example.com/x", events: ["membership.created"] },
      ],
      ["PATCH", `/webhooks/endpoints/${id}`, { enabled: true }],
      ["POST", "/access/reviews", {}],
    ];
    for (const [method, path, body] of gated) {
      const label = `${method} ${path}`;
      expect((await call(ws, method, path, body)).status, `anonymous ${label}`).toBe(401);
      expect(
        (await call(ws, method, path, body, { cookie: investor.cookie })).status,
        `investor ${label}`,
      ).toBe(404);
      expect(
        (await call(ws, method, path, body, { cookie: viewer.cookie })).status,
        `viewer ${label}`,
      ).toBe(403);
    }
    // And the owner, who passes every guard, is the one who learns about the plan.
    await expectFeatureRefused(
      await call(
        ws,
        "POST",
        "/api-keys",
        { name: "x", scopes: ["webhooks.read"] },
        {
          cookie: ws.owner.cookie,
        },
      ),
      "api_keys",
    );
    // A PATCH of an endpoint that does not exist is its own 404, whatever the plan.
    expect(
      (
        await call(
          ws,
          "PATCH",
          `/webhooks/endpoints/${id}`,
          { enabled: true },
          {
            cookie: ws.owner.cookie,
          },
        )
      ).status,
    ).toBe(404);
  });
});

// --- no enforcement ----------------------------------------------------------------------------

describe("nothing is gated without enforcement", () => {
  it("a workspace without a plan: every gated route answers as before", async () => {
    const ws = await workspace("free", null);
    await expectStatus(
      await call(
        ws,
        "POST",
        "/api-keys",
        { name: "k", scopes: ["webhooks.read"] },
        {
          cookie: ws.owner.cookie,
        },
      ),
      201,
      "api key",
    );
    await expectStatus(
      await call(
        ws,
        "POST",
        "/webhooks/endpoints",
        { url: hookUrl(ws.slug), events: ["membership.created"] },
        { cookie: ws.owner.cookie },
      ),
      201,
      "endpoint",
    );
    await expectStatus(
      await call(
        ws,
        "POST",
        "/sso/domains",
        { domain: `${ws.slug}-corp.com` },
        {
          cookie: ws.owner.cookie,
        },
      ),
      201,
      "domain",
    );
    await expectStatus(
      await call(ws, "POST", "/sso/scim/tokens", { name: "IdP" }, { cookie: ws.owner.cookie }),
      201,
      "scim token",
    );
    await expectStatus(
      await call(ws, "POST", "/access/reviews", {}, { cookie: ws.owner.cookie }),
      201,
      "review",
    );
  });

  it("CONTROL_PLANE=off: a workspace on a plan without the features is not gated", async () => {
    const ws = await workspace("selfhost", "bare");
    const opts = { cookie: ws.owner.cookie, server: off };
    await expectStatus(
      await call(ws, "POST", "/api-keys", { name: "k", scopes: ["webhooks.read"] }, opts),
      201,
      "api key",
    );
    await expectStatus(
      await call(
        ws,
        "POST",
        "/webhooks/endpoints",
        { url: hookUrl(ws.slug), events: ["membership.created"] },
        opts,
      ),
      201,
      "endpoint",
    );
    await expectStatus(
      await call(ws, "POST", "/sso/domains", { domain: `${ws.slug}-corp.com` }, opts),
      201,
      "domain",
    );
    await expectStatus(
      await call(ws, "POST", "/sso/scim/tokens", { name: "IdP" }, opts),
      201,
      "scim token",
    );
    await expectStatus(await call(ws, "POST", "/access/reviews", {}, opts), 201, "review");
    // The same requests on the CONTROL_PLANE=on server are refused.
    await expectFeatureRefused(
      await call(
        ws,
        "POST",
        "/api-keys",
        { name: "k2", scopes: ["webhooks.read"] },
        {
          cookie: ws.owner.cookie,
        },
      ),
      "api_keys",
    );
  });
});

// --- jobs --------------------------------------------------------------------------------------

describe("access-review.overdue", () => {
  const port_ = (): EntitlementsPort => running.container.moduleServices.entitlements;

  async function age(workspaceId: string): Promise<void> {
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.workspace SET created_at = now() - interval '200 days' WHERE id = '${workspaceId}'::uuid`,
      ),
    );
  }

  const reminders = async (workspaceId: string) =>
    (
      await sql<{ n: number }>(
        workspaceId,
        `SELECT count(*)::int AS n FROM audit.event
          WHERE workspace_id = '${workspaceId}'::uuid AND action = 'access.review_overdue'`,
      )
    )[0]?.n ?? 0;

  async function run(entitlements: EntitlementsPort | undefined, at: Date): Promise<void> {
    const [job] = createAccessReviewJobs({
      deps: running.container.identityDeps,
      now: () => at,
      ...(entitlements === undefined ? {} : { entitlements }),
    });
    if (!job) throw new Error("no job");
    await job.handler({
      id: `test-review-${at.getTime()}`,
      name: job.name,
      data: {},
      signal: new AbortController().signal,
    });
  }

  it("skips overdue workspaces whose plan lacks access_reviews; not without enforcement", async () => {
    const allowed = await workspace("odfull", "full");
    const bare = await workspace("odbare", "bare");
    const free = await workspace("odfree", null);
    for (const ws of [allowed, bare, free]) await age(ws.id);
    const at = new Date();
    await run(port_(), at);
    expect(await reminders(allowed.id)).toBe(1);
    expect(await reminders(free.id)).toBe(1);
    expect(await reminders(bare.id)).toBe(0);
    // CONTROL_PLANE off (the same port, not enforced): the bare-plan workspace is reminded too.
    await run(createEntitlements({ enforced: false }), at);
    expect(await reminders(bare.id)).toBe(1);
    expect(await reminders(allowed.id)).toBe(1);
  });

  it("the server's registered job is the gated one", async () => {
    const bare = await workspace("odwired", "bare");
    await age(bare.id);
    await h.runJob("access-review.overdue", {});
    expect(await reminders(bare.id)).toBe(0);
  });

  // R2 L2: the SOC 2 evidence report does not call a workspace overdue for a review it may not do.
  it("the evidence report marks it notOnPlan, never overdue", async () => {
    const bare = await workspace("odevid", "bare");
    await age(bare.id);
    const report = async (entitlements: EntitlementsPort) => {
      let out = "";
      const code = await evidenceCommand(["access-reviews", "--workspace", bare.slug], {
        db: running.container.db,
        entitlements,
        out: (line) => {
          out += line;
        },
      });
      expect(code).toBe(0);
      return JSON.parse(out) as {
        summary: { overdue: number; notOnPlan: number };
        workspaces: { overdue: boolean; notOnPlan: boolean }[];
      };
    };
    const planned = await report(port_());
    expect(planned.workspaces[0]).toMatchObject({ overdue: false, notOnPlan: true });
    expect(planned.summary).toMatchObject({ overdue: 0, notOnPlan: 1 });
    const unplanned = await report(createEntitlements({ enforced: false }));
    expect(unplanned.workspaces[0]).toMatchObject({ overdue: true, notOnPlan: false });
  });
});

describe("anchoring (decision 20: every workspace is anchored; the plan gates the proof)", () => {
  const anchored = async (workspaceId: string, checkpointId: string) =>
    (
      await su<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit.anchor WHERE workspace_id = $1 AND checkpoint_id = $2 AND kind = 'merkle'",
        [workspaceId, checkpointId],
      )
    )[0]?.n === 1;

  async function checkpoint(workspaceId: string): Promise<string> {
    const ctx = systemContext(workspaceId);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.audit.record(tx, ctx, {
        action: "grant.changed",
        resourceKind: "grant",
        meta: {},
      }),
    );
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      workspaceId,
    );
    const [row] = await su<{ id: string }>(
      "SELECT id FROM audit.checkpoint WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1",
      [workspaceId],
    );
    return row?.id as string;
  }

  /** What a database owner does: delete rows with the immutability triggers bypassed. */
  async function asOwner(text: string, values: unknown[]): Promise<void> {
    const client = await pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(text, values);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  /** Verification 9 days on (past ANCHOR_MISSING_DAYS), exactly as the route and CLI run it. */
  const verifyLater = (workspaceId: string) =>
    verifyWorkspace(
      {
        db: running.container.db,
        keyRing: running.container.config.keyRing,
        anchorDrivers: [anchor],
        now: new Date(Date.now() + 9 * 86_400_000),
      },
      workspaceId,
    );
  const codes = (v: Awaited<ReturnType<typeof verifyLater>>) => v.anchorProblems.map((p) => p.code);
  const proof = (ws: Ws, checkpointId: string) =>
    call(ws, "GET", `/audit/anchors/${checkpointId}/proof`, undefined, { cookie: ws.owner.cookie });
  const page = async (ws: Ws) =>
    json<{
      configured: string[];
      planAllows: boolean;
      items: { checkpointId: string; state: string }[];
    }>(await call(ws, "GET", "/audit/anchors", undefined, { cookie: ws.owner.cookie }));

  it("the server's job anchors a workspace whose plan lacks anchoring, and it verifies ok", async () => {
    const ws = await workspace("anbare", "bare");
    const cp = await checkpoint(ws.id);
    await h.runJob("audit.anchor", {});
    expect(await anchored(ws.id, cp)).toBe(true);
    const v = await verifyLater(ws.id);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.anchors.checked).toBe(1);
    // The verify route too (its own clock; the anchor is there either way).
    const route = await call(ws, "GET", "/audit/verify", undefined, { cookie: ws.owner.cookie });
    expect(JSON.parse(await expectStatus(route, 200, "verify")).ok).toBe(true);
  });

  it("the list stays readable and says planAllows; the proof is 402 without the plan, 200 with it", async () => {
    const bare = await workspace("anproofbare", "bare");
    const full = await workspace("anprooffull", "full");
    const free = await workspace("anprooffree", null);
    const [b, f, n] = [
      await checkpoint(bare.id),
      await checkpoint(full.id),
      await checkpoint(free.id),
    ];
    await h.runJob("audit.anchor", {});

    const bp = await page(bare);
    expect(bp).toMatchObject({ configured: ["faketsa"], planAllows: false });
    expect(bp.items.find((i) => i.checkpointId === b)?.state).toBe("anchored");
    await expectFeatureRefused(await proof(bare, b), "anchoring", "bare proof");

    expect(await page(full)).toMatchObject({ planAllows: true });
    await expectStatus(await proof(full, f), 200, "full proof");
    // No plan (self-host) and CONTROL_PLANE=off: never gated.
    expect(await page(free)).toMatchObject({ planAllows: true });
    await expectStatus(await proof(free, n), 200, "no-plan proof");
    await expectStatus(
      await call(bare, "GET", `/audit/anchors/${b}/proof`, undefined, {
        cookie: bare.owner.cookie,
        server: off,
      }),
      200,
      "CONTROL_PLANE=off proof",
    );
    // Never an oracle: an editor (no `audit.export`), an investor and an anonymous caller keep
    // their answers on a plan without the feature.
    const editor = await member(
      bare.slug,
      bare.id,
      `ed@${bare.slug}.example.org`,
      "staff",
      "editor",
    );
    const ivy = await member(
      bare.slug,
      bare.id,
      `ivy@${bare.slug}.example.org`,
      "external",
      "investor",
    );
    expect((await call(bare, "GET", `/audit/anchors/${b}/proof`)).status).toBe(401);
    expect(
      (await call(bare, "GET", `/audit/anchors/${b}/proof`, undefined, { cookie: ivy.cookie }))
        .status,
    ).toBe(404);
    expect(
      (await call(bare, "GET", `/audit/anchors/${b}/proof`, undefined, { cookie: editor.cookie }))
        .status,
    ).toBe(403);
  });

  it("after an upgrade the proofs of past checkpoints are served at once", async () => {
    const ws = await workspace("anupgrade", "bare");
    const old = await checkpoint(ws.id);
    await h.runJob("audit.anchor", {});
    await expectFeatureRefused(await proof(ws, old), "anchoring", "before upgrade");
    await assignPlan(ws.id, "full");
    expect(await page(ws)).toMatchObject({ planAllows: true });
    const body = JSON.parse(await expectStatus(await proof(ws, old), 200, "after upgrade")) as {
      checkpoint: { workspace_id: string };
      receipts: unknown[];
    };
    expect(body.checkpoint.workspace_id).toBe(ws.id);
    expect(body.receipts.length).toBeGreaterThan(0);
  });

  // RR1 / RRR: removed evidence fails verification on every plan, before or after a downgrade.
  it("a deleted anchor or deleted receipts fail verification on any plan", async () => {
    for (const plan of ["full", "bare"] as const) {
      const anchorWs = await workspace(`rranc${plan}`, "full");
      const cpA = await checkpoint(anchorWs.id);
      const receiptWs = await workspace(`rrrcp${plan}`, "full");
      const cpR = await checkpoint(receiptWs.id);
      await h.runJob("audit.anchor", {});
      expect((await verifyLater(anchorWs.id)).ok, plan).toBe(true);
      await assignPlan(anchorWs.id, plan);
      await assignPlan(receiptWs.id, plan);
      // Delete the anchor row, before and after another run.
      await asOwner("DELETE FROM audit.anchor WHERE workspace_id = $1 AND checkpoint_id = $2", [
        anchorWs.id,
        cpA,
      ]);
      const [batch] = await su<{ id: string }>(
        "SELECT batch_id::text AS id FROM audit.anchor WHERE workspace_id = $1 AND checkpoint_id = $2",
        [receiptWs.id, cpR],
      );
      await asOwner("DELETE FROM audit.anchor_receipt WHERE batch_id = $1::uuid", [batch?.id]);
      const a = await verifyLater(anchorWs.id);
      expect(a.ok, `${plan} anchor`).toBe(false);
      expect(codes(a), `${plan} anchor`).toEqual(["anchor_missing"]);
      const r = await verifyLater(receiptWs.id);
      expect(r.ok, `${plan} receipts`).toBe(false);
      expect(codes(r), `${plan} receipts`).toEqual(["anchor_missing"]);
      // On a plan without the feature, a run after the deletion re-anchors the checkpoint (the
      // job no longer leaves anyone out), so nothing about the plan can excuse a removal.
      if (plan === "bare") {
        await h.runJob("audit.anchor", {});
        expect(await anchored(anchorWs.id, cpA)).toBe(true);
      }
    }
  });
});
