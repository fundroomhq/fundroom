import { createHash, randomBytes } from "node:crypto";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ScimAdminError } from "@fundroom/scim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { SCIM_RATE_LIMIT_PER_MINUTE } from "./routes/scim.js";
import { type RunningServer, startServer } from "./server.js";
import {
  BASE,
  CANON,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
  waitFor,
} from "./test/esign-harness.js";

/*
 * SCIM 2.0 end to end (E3.8, ADR-0056 decision 11): `/scim/v2` on the canonical host, the
 * workspace taken from the bearer token. Replays what the Entra SCIM validator and Okta's SCIM
 * client actually send (research §3.3–§3.5), then the rules around them: verified domains, owner
 * protections, external-member conflicts, group → role recompute, token isolation / revocation,
 * the per-token rate limit, SCIM_ENABLED=false, the 1 MiB body cap.
 */
let pg: TestPostgres;
let running: RunningServer;
let disabled: RunningServer;
/** The default pool (10): real parallelism for the burst test. */
let wide: RunningServer;
let mailer: MemoryMailer;
const h = harness(
  () => running,
  () => mailer,
);

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

interface Ws {
  id: string;
  slug: string;
  domain: string;
  token: string;
  ownerEmail: string;
  ownerMembershipId: string;
}

type Body = Record<string, unknown> & {
  id?: string;
  Resources?: Record<string, unknown>[];
  totalResults?: number;
};

let seq = 0;
async function workspace(prefix: string, opts: { jitRole?: string } = {}): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const domain = `${slug}.test`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const deps = running.container.identityDeps;
  const ownerEmail = `owner@${domain}`;
  const { userId } = await provisionUser(deps, { email: ownerEmail, displayName: "Owner" });
  const owner = await provisionMembership(deps, {
    workspaceId: id,
    userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  await pg.pool.query(
    `INSERT INTO core.sso_domain (workspace_id, domain, token, status, verified_at)
     VALUES ($1, $2, 'tok-0123456789abcdef', 'verified', now())`,
    [id, domain],
  );
  if (opts.jitRole !== undefined) {
    await pg.pool.query(
      `INSERT INTO core.sso_connection (workspace_id, protocol, name, enabled, oidc_issuer, oidc_client_id, jit_role)
       VALUES ($1, 'oidc', 'IdP', true, 'https://idp.example.test', $2, $3)`,
      [id, `client-${slug}`, opts.jitRole],
    );
  }
  const { token } = await running.container.scim.createToken(
    systemContext(id),
    { name: "Entra" },
    { membershipId: owner.id },
  );
  return { id, slug, domain, token, ownerEmail, ownerMembershipId: owner.id };
}

async function scim(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  init: { contentType?: string; server?: RunningServer; host?: string; raw?: string } = {},
): Promise<Response> {
  const headers = new Headers({ host: init.host ?? CANON });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined || init.raw !== undefined) {
    headers.set("content-type", init.contentType ?? "application/scim+json");
  }
  return (init.server ?? running).app.request(`${BASE}/scim/v2${path}`, {
    method,
    headers,
    ...(init.raw !== undefined
      ? { body: init.raw }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
  });
}

async function ok(res: Response, status = 200): Promise<Body> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  if (status !== 204) expect(res.headers.get("content-type")).toMatch(/^application\/scim\+json/u);
  return text === "" ? {} : (JSON.parse(text) as Body);
}

async function scimError(res: Response, status: number, scimType?: string): Promise<Body> {
  const body = (await res.json()) as Body;
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^application\/scim\+json/u);
  expect(body["schemas"]).toEqual([ERROR]);
  expect(body["status"]).toBe(String(status));
  if (scimType !== undefined) expect(body["scimType"]).toBe(scimType);
  return body;
}

const q = encodeURIComponent;

async function membership(id: string) {
  const { rows } = await pg.pool.query<{
    role: string;
    status: string;
    kind: string;
    user_id: string;
  }>("SELECT role, status, kind, user_id FROM core.membership WHERE id = $1", [id]);
  return rows[0];
}

async function membershipOfScimUser(scimUserId: string): Promise<string> {
  const { rows } = await pg.pool.query<{ membership_id: string }>(
    "SELECT membership_id FROM core.scim_user WHERE id = $1",
    [scimUserId],
  );
  return rows[0]?.membership_id as string;
}

async function createUser(ws: Ws, local: string, extra: Record<string, unknown> = {}) {
  return ok(
    await scim(ws.token, "POST", "/Users", {
      schemas: [USER],
      userName: `${local}@${ws.domain}`,
      active: true,
      emails: [{ primary: true, type: "work", value: `${local}@${ws.domain}` }],
      name: { givenName: local, familyName: "Test" },
      ...extra,
    }),
    201,
  );
}

async function createGroup(ws: Ws, displayName: string, members: string[] = []) {
  return ok(
    await scim(ws.token, "POST", "/Groups", {
      schemas: [GROUP],
      displayName,
      members: members.map((value) => ({ value })),
    }),
    201,
  );
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const secrets = freshSecrets(pg.connectionString);
  running = await startServer({
    // One pooled connection: a SCIM path that opened a transaction inside another (the
    // pool-deadlock rule) would hang here instead of passing.
    config: esignTestConfig(secrets, { ROLES: "api", DATABASE_POOL_MAX: "1" }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  wide = await startServer({
    config: esignTestConfig(secrets, { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  disabled = await startServer({
    config: esignTestConfig(secrets, { ROLES: "api", SCIM_ENABLED: "false" }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await disabled?.stop();
  await wide?.stop();
  await running?.stop();
  await pg?.stop();
});

describe("discovery", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas as SCIM JSON", async () => {
    const ws = await workspace("disc");
    const spc = await ok(await scim(ws.token, "GET", "/ServiceProviderConfig"));
    expect(spc).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    const types = await ok(await scim(ws.token, "GET", "/ResourceTypes"));
    expect(types).toMatchObject({ schemas: [LIST], totalResults: 2 });
    const schemas = await ok(await scim(ws.token, "GET", "/Schemas"));
    expect(schemas["schemas"]).toEqual([LIST]);
    expect(schemas.Resources?.map((r) => r["id"])).toContain(USER);
    await ok(await scim(ws.token, "GET", `/Schemas/${USER}`));
    await ok(await scim(ws.token, "GET", "/ResourceTypes/User"));
    await scimError(await scim(ws.token, "GET", "/Bulk"), 404);
    await scimError(await scim(ws.token, "GET", "/Me"), 404);
  });
});

describe("an Entra-validator-like script", () => {
  it("creates, refuses a duplicate, filters, patches, deactivates, reactivates, deletes", async () => {
    const ws = await workspace("entra");
    const userName = `Test_User_ab6490ee@${ws.domain}`;
    const externalId = "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef";
    const post = {
      schemas: [USER, ENTERPRISE],
      externalId,
      userName,
      active: true,
      displayName: "BJensen",
      emails: [{ primary: true, type: "work", value: `Test_User_fd0ea19b@${ws.domain}` }],
      meta: { resourceType: "User" },
      name: { formatted: "Ryan Leenay", familyName: "Leenay", givenName: "Ryan" },
      roles: [],
      password: "ignored-Pa55!",
      [ENTERPRISE]: { employeeNumber: "42", department: "Eng" },
    };
    const res = await scim(ws.token, "POST", "/Users", post);
    const created = await ok(res, 201);
    const id = created.id as string;
    expect(res.headers.get("location")).toBe(`${BASE}/scim/v2/Users/${id}`);
    expect(created).toMatchObject({
      schemas: [USER],
      userName,
      externalId,
      displayName: "BJensen",
      active: true,
      emails: [{ value: `Test_User_fd0ea19b@${ws.domain}`, type: "work", primary: true }],
      name: { givenName: "Ryan", familyName: "Leenay" },
      meta: { resourceType: "User", location: `${BASE}/scim/v2/Users/${id}` },
    });
    const membershipId = await membershipOfScimUser(id);
    expect(await membership(membershipId)).toMatchObject({
      kind: "staff",
      role: "viewer",
      status: "active",
    });
    // The global user got the userName address as its email identity; nothing else from SCIM.
    const { rows: ids } = await pg.pool.query<{ identifier: string }>(
      `SELECT i.identifier FROM core.user_identity i JOIN core.membership m ON m.user_id = i.user_id
        WHERE m.id = $1 AND i.type = 'email'`,
      [membershipId],
    );
    expect(ids.map((r) => r.identifier.toLowerCase())).toEqual([userName.toLowerCase()]);

    // Duplicate → 409 uniqueness (also case-insensitively on userName, and on externalId).
    await scimError(await scim(ws.token, "POST", "/Users", post), 409, "uniqueness");
    await scimError(
      await scim(ws.token, "POST", "/Users", { ...post, userName: userName.toUpperCase() }),
      409,
      "uniqueness",
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", { ...post, userName: `other@${ws.domain}` }),
      409,
      "uniqueness",
    );

    // Filter on the joining property and the other matching attributes.
    for (const filter of [
      `userName eq "${userName}"`,
      `userName eq "${userName.toLowerCase()}"`,
      `externalId eq "${externalId}"`,
      `emails[type eq "work"].value eq "Test_User_fd0ea19b@${ws.domain}"`,
      `emails.value eq "test_user_fd0ea19b@${ws.domain}"`,
      `userName eq "${userName}" and externalId eq "${externalId}"`,
    ]) {
      const list = await ok(await scim(ws.token, "GET", `/Users?filter=${q(filter)}`));
      expect(list, filter).toMatchObject({ schemas: [LIST], totalResults: 1, startIndex: 1 });
      expect(list.Resources?.[0]).toMatchObject({ id, userName });
    }
    const none = await ok(
      await scim(ws.token, "GET", `/Users?filter=${q('userName eq "nobody@x.test"')}`),
    );
    expect(none).toMatchObject({ totalResults: 0, itemsPerPage: 0, Resources: [] });

    // PATCH (Entra default dialect): capitalised op, path-less multi-attribute value with dotted
    // and URN keys.
    const patched = await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [
          {
            op: "Replace",
            value: {
              displayName: "Ryan L",
              "name.givenName": "Ryann",
              "name.familyName": "Leenay-Smith",
              [`${ENTERPRISE}:employeeNumber`]: "43",
            },
          },
          { op: "Add", path: "nickName", value: "Ry" },
          {
            op: "Replace",
            path: 'emails[type eq "work"].value',
            value: `ryan.new@${ws.domain}`,
          },
        ],
      }),
    );
    expect(patched).toMatchObject({
      displayName: "Ryan L",
      name: { givenName: "Ryann", familyName: "Leenay-Smith" },
      emails: [{ value: `ryan.new@${ws.domain}` }],
    });
    const again = await ok(await scim(ws.token, "GET", `/Users/${id}`));
    expect(again).toMatchObject({ displayName: "Ryan L" });

    // PATCH the joining property, then filter on the new value.
    const renamed = `Test_User_renamed@${ws.domain}`;
    await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "userName", value: renamed }],
      }),
    );
    const byNew = await ok(
      await scim(ws.token, "GET", `/Users?filter=${q(`userName eq "${renamed}"`)}`),
    );
    expect(byNew.totalResults).toBe(1);
    // The membership still points at the same global user (SCIM never re-links or edits it).
    expect(await membershipOfScimUser(id)).toBe(membershipId);
    // …and a rename outside the verified domains is refused.
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "userName", value: "x@elsewhere.test" }],
      }),
      400,
      "invalidValue",
    );

    // A live session of this user in the workspace, revoked by the deactivation.
    const m = await membership(membershipId);
    const started = await running.container.auth.sessions.startSession({
      userId: m?.user_id as string,
      population: "staff",
      context: "first_party",
      authLevel: 1,
      workspaceId: ws.id,
    });

    // Deactivate the Entra way: string "False".
    const off = await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      }),
    );
    expect(off["active"]).toBe(false);
    expect((await membership(membershipId))?.status).toBe("suspended");
    const { rows: sess } = await pg.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM core.session WHERE id = $1",
      [started.session.sessionId],
    );
    expect(sess[0]?.revoked_at).not.toBeNull();
    // Still listed, active:false (Entra and Okta both require it).
    const listed = await ok(
      await scim(ws.token, "GET", `/Users?filter=${q(`userName eq "${renamed}"`)}`),
    );
    expect(listed.Resources?.[0]).toMatchObject({ id, active: false });

    // Reactivate: "True".
    const on = await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "active", value: "True" }],
      }),
    );
    expect(on["active"]).toBe(true);
    expect((await membership(membershipId))?.status).toBe("active");

    // Groups: create, duplicate 409, rename, add member, filter without members, remove member.
    const group = await createGroup(ws, "Validator Group");
    const gid = group.id as string;
    expect(group).toMatchObject({ schemas: [GROUP], displayName: "Validator Group", members: [] });
    await scimError(
      await scim(ws.token, "POST", "/Groups", { schemas: [GROUP], displayName: "validator group" }),
      409,
      "uniqueness",
    );
    expect(
      (
        await scim(ws.token, "PATCH", `/Groups/${gid}`, {
          schemas: [PATCH],
          Operations: [{ op: "Replace", path: "displayName", value: "Validator Group 2" }],
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await scim(ws.token, "PATCH", `/Groups/${gid}`, {
          schemas: [PATCH],
          Operations: [{ op: "Add", path: "members", value: [{ value: id }] }],
        })
      ).status,
    ).toBe(204);
    const found = await ok(
      await scim(
        ws.token,
        "GET",
        `/Groups?excludedAttributes=members&filter=${q('displayName eq "Validator Group 2"')}`,
      ),
    );
    expect(found.totalResults).toBe(1);
    expect(found.Resources?.[0]).not.toHaveProperty("members");
    const withMember = await ok(
      await scim(
        ws.token,
        "GET",
        `/Groups?excludedAttributes=members&filter=${q(`id eq "${gid}" and members[value eq "${id}"]`)}`,
      ),
    );
    expect(withMember.totalResults).toBe(1);
    const full = await ok(await scim(ws.token, "GET", `/Groups/${gid}`));
    expect(full["members"]).toEqual([
      { value: id, display: "Ryan L", $ref: `${BASE}/scim/v2/Users/${id}` },
    ]);
    // Entra legacy remove: path "members" with a value list.
    expect(
      (
        await scim(ws.token, "PATCH", `/Groups/${gid}`, {
          schemas: [PATCH],
          Operations: [{ op: "Remove", path: "members", value: [{ value: id }] }],
        })
      ).status,
    ).toBe(204);
    expect((await ok(await scim(ws.token, "GET", `/Groups/${gid}`)))["members"]).toEqual([]);
    // Unknown member → 400 invalidValue, nothing applied.
    await scimError(
      await scim(ws.token, "PATCH", `/Groups/${gid}`, {
        schemas: [PATCH],
        Operations: [
          { op: "Replace", path: "displayName", value: "Should Not Stick" },
          {
            op: "Add",
            path: "members",
            value: [{ value: "01920000-0000-7000-8000-00000000dead" }],
          },
        ],
      }),
      400,
      "invalidValue",
    );
    expect((await ok(await scim(ws.token, "GET", `/Groups/${gid}`)))["displayName"]).toBe(
      "Validator Group 2",
    );

    // Delete: membership revoked, 404 after, not listed.
    expect((await scim(ws.token, "DELETE", `/Users/${id}`)).status).toBe(204);
    expect((await membership(membershipId))?.status).toBe("revoked");
    await scimError(await scim(ws.token, "GET", `/Users/${id}`), 404);
    await scimError(await scim(ws.token, "DELETE", `/Users/${id}`), 404);
    const gone = await ok(
      await scim(ws.token, "GET", `/Users?filter=${q(`userName eq "${renamed}"`)}`),
    );
    expect(gone.totalResults).toBe(0);
    expect((await scim(ws.token, "DELETE", `/Groups/${gid}`)).status).toBe(204);
    await scimError(await scim(ws.token, "GET", `/Groups/${gid}`), 404);

    // Audit: SCIM writes are the system actor `scim:<tokenId>`.
    const { rows: audit } = await pg.pool.query<{
      action: string;
      actor_kind: string;
      meta: Record<string, unknown>;
    }>(
      `SELECT action, actor_kind, meta FROM audit.event WHERE workspace_id = $1 AND action LIKE 'scim.user_%' ORDER BY occurred_at`,
      [ws.id],
    );
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "scim.user_created",
        "scim.user_updated",
        "scim.user_suspended",
        "scim.user_reactivated",
        "scim.user_deleted",
      ]),
    );
    for (const r of audit) {
      expect(r.actor_kind).toBe("system");
      expect(String(r.meta["actor"])).toMatch(/^scim:/u);
    }
  });
});

describe("an Okta-like script", () => {
  it("looks up, creates, PUTs, deactivates path-less and manages groups", async () => {
    const ws = await workspace("okta");
    const userName = `dade.murphy@${ws.domain}`;
    const lookup = await ok(
      await scim(
        ws.token,
        "GET",
        `/Users?filter=${q(`userName eq "${userName}"`)}&startIndex=1&count=100`,
        undefined,
      ),
    );
    expect(lookup).toMatchObject({ totalResults: 0, startIndex: 1, itemsPerPage: 0 });
    const created = await ok(
      await scim(
        ws.token,
        "POST",
        "/Users",
        {
          schemas: [USER],
          userName,
          name: { givenName: "Dade", familyName: "Murphy" },
          emails: [{ primary: true, value: userName, type: "work" }],
          displayName: "Dade Murphy",
          locale: "en-US",
          externalId: "00ujl29u0le5T6Aj10h7",
          groups: [],
          password: "1mz050nq",
          active: true,
        },
        { contentType: "application/json" },
      ),
      201,
    );
    const id = created.id as string;
    const membershipId = await membershipOfScimUser(id);

    // Custom-app profile update: PUT (full replace).
    const put = await ok(
      await scim(ws.token, "PUT", `/Users/${id}`, {
        schemas: [USER],
        id,
        userName,
        name: { givenName: "Dade", familyName: "Murphy-Crash" },
        emails: [{ primary: true, value: userName, type: "work" }],
        displayName: "Crash Override",
        active: true,
      }),
    );
    expect(put).toMatchObject({
      displayName: "Crash Override",
      name: { familyName: "Murphy-Crash" },
    });
    expect(put).not.toHaveProperty("externalId");

    // Deactivate Okta's way.
    const off = await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    );
    expect(off["active"]).toBe(false);
    expect((await membership(membershipId))?.status).toBe("suspended");
    const on = await ok(
      await scim(ws.token, "PATCH", `/Users/${id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", value: { active: true } }],
      }),
    );
    expect(on["active"]).toBe(true);

    // Groups: push with members, replace, remove by filter, rename path-less with id, delete.
    const other = await createUser(ws, "kate");
    const g = await createGroup(ws, "Hackers", [id]);
    const gid = g.id as string;
    expect(g["members"]).toHaveLength(1);
    await ok(
      await scim(ws.token, "PATCH", `/Groups/${gid}`, {
        schemas: [PATCH],
        Operations: [
          { op: "replace", path: "members", value: [{ value: other.id }, { value: id }] },
        ],
      }),
      204,
    );
    await ok(
      await scim(ws.token, "PATCH", `/Groups/${gid}`, {
        schemas: [PATCH],
        Operations: [{ op: "remove", path: `members[value eq "${id}"]` }],
      }),
      204,
    );
    await ok(
      await scim(ws.token, "PATCH", `/Groups/${gid}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", value: { id: gid, displayName: "Hackers 1995" } }],
      }),
      204,
    );
    const now = await ok(await scim(ws.token, "GET", `/Groups/${gid}`));
    expect(now).toMatchObject({ displayName: "Hackers 1995", members: [{ value: other.id }] });
    // PUT a group (full replace).
    const put2 = await ok(
      await scim(ws.token, "PUT", `/Groups/${gid}`, {
        schemas: [GROUP],
        displayName: "Hackers",
        members: [{ value: id }],
      }),
    );
    expect(put2).toMatchObject({ displayName: "Hackers", members: [{ value: id }] });
    await ok(await scim(ws.token, "DELETE", `/Groups/${gid}`), 204);

    // Pagination and projection.
    const page = await ok(await scim(ws.token, "GET", "/Users?startIndex=2&count=1"));
    expect(page).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 });
    const zero = await ok(await scim(ws.token, "GET", "/Users?count=0"));
    expect(zero).toMatchObject({ totalResults: 2, itemsPerPage: 0, Resources: [] });
    const slim = await ok(await scim(ws.token, "GET", `/Users/${id}?attributes=userName`));
    expect(Object.keys(slim).sort()).toEqual(["id", "schemas", "userName"]);
  });
});

describe("group → role mapping", () => {
  it("recomputes roles on membership changes and mapping changes, never touching owners", async () => {
    const ws = await workspace("roles", { jitRole: "editor" });
    const a = await createUser(ws, "alice");
    const b = await createUser(ws, "bob");
    // The owner, adopted by SCIM.
    const owner = await ok(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: ws.ownerEmail }),
      201,
    );
    const ma = await membershipOfScimUser(a.id as string);
    const mb = await membershipOfScimUser(b.id as string);
    expect(await membershipOfScimUser(owner.id as string)).toBe(ws.ownerMembershipId);
    // Default role = the connection's JIT role.
    expect((await membership(ma))?.role).toBe("editor");

    const admins = await createGroup(ws, "Admins", [a.id as string, owner.id as string]);
    const legal = await createGroup(ws, "Legal", [a.id as string, b.id as string]);
    const svc = running.container.scim;
    const ctx = systemContext(ws.id);
    const actor = { membershipId: ws.ownerMembershipId };
    await svc.setGroupRole(ctx, legal.id as string, "legal", actor);
    expect((await membership(ma))?.role).toBe("legal");
    expect((await membership(mb))?.role).toBe("legal");
    const mapped = await svc.setGroupRole(ctx, admins.id as string, "admin", actor);
    expect(mapped).toMatchObject({ role: "admin", memberCount: 2 });
    // admin > legal.
    expect((await membership(ma))?.role).toBe("admin");
    expect((await membership(mb))?.role).toBe("legal");
    expect((await membership(ws.ownerMembershipId))?.role).toBe("owner");

    // Leaving the admin group drops alice to legal; leaving legal drops bob to the default.
    await ok(
      await scim(ws.token, "PATCH", `/Groups/${admins.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "remove", path: `members[value eq "${a.id}"]` }],
      }),
      204,
    );
    expect((await membership(ma))?.role).toBe("legal");
    await ok(
      await scim(ws.token, "PATCH", `/Groups/${legal.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Remove", path: "members", value: [{ value: b.id }] }],
      }),
      204,
    );
    expect((await membership(mb))?.role).toBe("editor");

    // Unmapping legal: alice falls back to the default.
    await svc.setGroupRole(ctx, legal.id as string, null, actor);
    expect((await membership(ma))?.role).toBe("editor");
    // Deleting a mapped group recomputes its members.
    await svc.setGroupRole(ctx, legal.id as string, "finance", actor);
    expect((await membership(ma))?.role).toBe("finance");
    await ok(await scim(ws.token, "DELETE", `/Groups/${legal.id}`), 204);
    expect((await membership(ma))?.role).toBe("editor");

    // Owner protections: never deactivated or deleted by SCIM.
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${owner.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      }),
      400,
      "mutability",
    );
    await scimError(await scim(ws.token, "DELETE", `/Users/${owner.id}`), 400, "mutability");
    expect(await membership(ws.ownerMembershipId)).toMatchObject({
      role: "owner",
      status: "active",
    });
    const stillActive = await ok(await scim(ws.token, "GET", `/Users/${owner.id}`));
    expect(stillActive["active"]).toBe(true);

    // Admin views.
    const view = await svc.adminView(ctx);
    expect(view).toMatchObject({
      enabled: true,
      baseUrl: `${BASE}/scim/v2`,
      counts: { users: 3, activeUsers: 3, groups: 1 },
    });
    const users = await svc.listUsers(ctx, { limit: 2 });
    expect(users.items).toHaveLength(2);
    expect(users.nextCursor).not.toBeNull();
    const rest = await svc.listUsers(ctx, { cursor: users.nextCursor as string, limit: 2 });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const alice = [...users.items, ...rest.items].find((u) => u.id === a.id);
    expect(alice).toMatchObject({ role: "editor", groups: [] });
    const groups = await svc.listGroups(ctx);
    expect(groups).toEqual([
      expect.objectContaining({ displayName: "Admins", role: "admin", memberCount: 1 }),
    ]);
  });
});

describe("provisioning rules", () => {
  it("refuses an unverified domain, a non-email identity and an external member", async () => {
    const ws = await workspace("rules");
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: "eve@unverified.test" }),
      400,
      "invalidValue",
    );
    // A verified-looking subdomain is a different domain.
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: `x@sub.${ws.domain}` }),
      400,
      "invalidValue",
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: "no-at-sign" }),
      400,
      "invalidValue",
    );
    // Non-email userName with a verified work email: fine (the email is the identity).
    const handle = await ok(
      await scim(ws.token, "POST", "/Users", {
        schemas: [USER],
        userName: "jdoe",
        emails: [{ type: "work", value: `jdoe@${ws.domain}` }],
      }),
      201,
    );
    expect(handle["userName"]).toBe("jdoe");

    // An investor (external member) with a verified-domain email: 409, nothing written.
    const deps = running.container.identityDeps;
    const email = `investor@${ws.domain}`;
    const { userId } = await provisionUser(deps, { email, displayName: "Inv" });
    await provisionMembership(deps, {
      workspaceId: ws.id,
      userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: email }),
      409,
      "uniqueness",
    );
    const { rows } = await pg.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.scim_user WHERE workspace_id = $1 AND user_name = $2",
      [ws.id, email],
    );
    expect(rows[0]?.n).toBe(0);

    // Created inactive: provisioned suspended.
    const off = await createUser(ws, "late", { active: false });
    expect(off["active"]).toBe(false);
    expect((await membership(await membershipOfScimUser(off.id as string)))?.status).toBe(
      "suspended",
    );
  });

  it("answers protocol errors as SCIM errors", async () => {
    const ws = await workspace("errs");
    await scimError(
      await scim(ws.token, "GET", `/Users?filter=${q('userName co "x"')}`),
      400,
      "invalidFilter",
    );
    await scimError(
      await scim(ws.token, "GET", `/Users?filter=${q("userName eq")}`),
      400,
      "invalidFilter",
    );
    await scimError(
      await scim(ws.token, "GET", `/Users?filter=${q('title eq "x"')}`),
      400,
      "invalidFilter",
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", undefined, { raw: "{not json" }),
      400,
      "invalidSyntax",
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER] }, { contentType: "text/plain" }),
      415,
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER] }),
      400,
      "invalidValue",
    );
    await scimError(await scim(ws.token, "GET", "/Users/not-a-uuid"), 404);
    const u = await createUser(ws, "pat");
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "move" }],
      }),
      400,
      "invalidSyntax",
    );
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "remove", path: "userName" }],
      }),
      400,
      "mutability",
    );
    // 1 MiB cap.
    const big = JSON.stringify({ schemas: [USER], userName: "x", pad: "y".repeat(1024 * 1024) });
    await scimError(await scim(ws.token, "POST", "/Users", undefined, { raw: big }), 413);
  });
});

describe("tokens", () => {
  it("isolates workspaces, refuses revoked/unknown tokens and caps live tokens at two", async () => {
    const a = await workspace("isoa");
    const b = await workspace("isob");
    const ua = await createUser(a, "amy");
    const ub = await createUser(b, "ben");
    // A's token sees only A.
    await scimError(await scim(a.token, "GET", `/Users/${ub.id}`), 404);
    await scimError(
      await scim(a.token, "PATCH", `/Users/${ub.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
      404,
    );
    await scimError(await scim(a.token, "DELETE", `/Users/${ub.id}`), 404);
    const listA = await ok(await scim(a.token, "GET", "/Users"));
    expect(listA.Resources?.map((r) => r["id"])).toEqual([ua.id]);
    // A's token cannot put B's users in A's groups.
    await scimError(
      await scim(a.token, "POST", "/Groups", {
        schemas: [GROUP],
        displayName: "Sneaky",
        members: [{ value: ub.id }],
      }),
      400,
      "invalidValue",
    );
    // …and B's domain is not A's to provision.
    await scimError(
      await scim(a.token, "POST", "/Users", { schemas: [USER], userName: `new@${b.domain}` }),
      400,
      "invalidValue",
    );

    // No token, a garbage token, a well-formed unknown token → 401.
    await scimError(await scim(undefined, "GET", "/Users"), 401);
    await scimError(await scim("nope", "GET", "/Users"), 401);
    await scimError(await scim(`shs_${"A".repeat(43)}`, "GET", "/Users"), 401);
    await scimError(await scim(`frs_${"A".repeat(43)}`, "GET", "/Users"), 401);
    const unauth = await scim(undefined, "GET", "/Users");
    expect(unauth.headers.get("www-authenticate")).toMatch(/^Bearer/u);

    // Two live tokens at most; a revoked one stops working at once.
    const svc = running.container.scim;
    const ctx = systemContext(a.id);
    const second = await svc.createToken(ctx, { name: "Rotation" }, { membershipId: null });
    expect(second.token).toMatch(/^frs_[A-Za-z0-9_-]{43}$/u);
    expect(a.token).toMatch(/^frs_[A-Za-z0-9_-]{43}$/u);
    await expect(
      svc.createToken(ctx, { name: "Third" }, { membershipId: null }),
    ).rejects.toMatchObject({ code: "scim_token_limit", status: 409 });
    await ok(await scim(second.token, "GET", "/Users"));
    const view = await svc.adminView(ctx);
    expect(view.tokens).toHaveLength(2);
    expect(view.tokens.find((t) => t.id === second.view.id)?.lastUsedAt).not.toBeNull();
    await svc.revokeToken(ctx, second.view.id, { membershipId: null });
    await scimError(await scim(second.token, "GET", "/Users"), 401);
    await expect(
      svc.revokeToken(ctx, second.view.id, { membershipId: null }),
    ).rejects.toBeInstanceOf(ScimAdminError);
    // Revocation freed a slot.
    await svc.createToken(ctx, { name: "Third" }, { membershipId: null });
  });

  it("a legacy shs_ token minted before the rename still authenticates (A-2)", async () => {
    const ws = await workspace("legacy");
    const legacy = `shs_${randomBytes(32).toString("base64url")}`;
    // As a pre-rename `createToken` stored it: sha256 of the whole token, first 12 characters.
    await pg.pool.query(
      `INSERT INTO core.scim_token (workspace_id, token_hash, display_prefix, name)
       VALUES ($1, $2, $3, 'Okta (old)')`,
      [ws.id, createHash("sha256").update(legacy, "utf8").digest(), legacy.slice(0, 12)],
    );
    await ok(await scim(legacy, "GET", "/Users"));
    await scimError(await scim(`frs_${legacy.slice(4)}`, "GET", "/Users"), 401);
    const view = await running.container.scim.adminView(systemContext(ws.id));
    expect(view.tokens.map((t) => t.displayPrefix).sort()).toEqual(
      [legacy.slice(0, 12), ws.token.slice(0, 12)].sort(),
    );
  });

  it("rate-limits per token (429 with Retry-After)", async () => {
    const ws = await workspace("rate");
    const other = await workspace("rateb");
    let limited: Response | undefined;
    // A minute boundary may reset the window once mid-burst.
    for (let i = 0; i < 2 * SCIM_RATE_LIMIT_PER_MINUTE + 2 && limited === undefined; i++) {
      const res = await scim(ws.token, "GET", "/ServiceProviderConfig");
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(200);
    }
    expect(limited).toBeDefined();
    const body = await scimError(limited as Response, 429);
    expect(body["detail"]).toBeTruthy();
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another workspace's token is unaffected.
    await ok(await scim(other.token, "GET", "/ServiceProviderConfig"));
  }, 120_000);
});

describe("concurrency", () => {
  it("serialises a burst of parallel SCIM writes per workspace with no deadlock", async () => {
    const ws = await workspace("burst", { jitRole: "viewer" });
    const deadlocks = async () =>
      Number(
        (
          await pg.pool.query<{ n: string }>(
            "SELECT sum(deadlocks)::text AS n FROM pg_stat_database",
          )
        ).rows[0]?.n ?? 0,
      );
    const before = await deadlocks();
    const seedUsers = await Promise.all(["u1", "u2", "u3"].map((l) => createUser(ws, l)));
    const g = await createGroup(ws, "Burst", []);
    await running.container.scim.setGroupRole(systemContext(ws.id), g.id as string, "finance", {
      membershipId: null,
    });
    const ops: Promise<Response>[] = [];
    for (const [i, u] of seedUsers.entries()) {
      ops.push(
        scim(
          ws.token,
          "PATCH",
          `/Groups/${g.id}`,
          {
            schemas: [PATCH],
            Operations: [{ op: "add", path: "members", value: [{ value: u.id }] }],
          },
          { server: wide },
        ),
        scim(
          ws.token,
          "PATCH",
          `/Users/${u.id}`,
          {
            schemas: [PATCH],
            Operations: [{ op: "replace", path: "active", value: i % 2 === 0 ? "False" : "True" }],
          },
          { server: wide },
        ),
        scim(
          ws.token,
          "POST",
          "/Users",
          { schemas: [USER], userName: `p${i}@${ws.domain}` },
          {
            server: wide,
          },
        ),
      );
    }
    const results = await Promise.all(ops);
    for (const r of results) expect(r.status, await r.clone().text()).toBeLessThan(300);
    expect(await deadlocks()).toBe(before);
    const members = await ok(await scim(ws.token, "GET", `/Groups/${g.id}`));
    expect(members["members"]).toHaveLength(3);
    for (const u of seedUsers) {
      expect((await membership(await membershipOfScimUser(u.id as string)))?.role).toBe("finance");
    }
  });
});

describe("fix round 1", () => {
  it("R2-H1: role recompute locks every membership before the first role change", async () => {
    const ws = await workspace("hone");
    const a = await createUser(ws, "a1");
    const b = await createUser(ws, "b1");
    const g = await createGroup(ws, "Pair", [a.id as string, b.id as string]);
    const ids = [
      await membershipOfScimUser(a.id as string),
      await membershipOfScimUser(b.id as string),
    ].sort();
    const before = await deadlocks(pg.pool);
    const holder = await pg.pool.connect();
    let holderError: unknown;
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '20s'");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      // The membership the recompute reaches second.
      await holder.query("SELECT 1 FROM core.membership WHERE id = $1 FOR NO KEY UPDATE", [ids[1]]);
      pending = wide.container.scim
        .setGroupRole(systemContext(ws.id), g.id as string, "admin", { membershipId: null })
        .then(
          () => "ok",
          (e: unknown) => e,
        );
      await waitFor("the recompute to block on the held membership", async () => {
        const { rows } = await pg.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return (rows[0]?.n ?? 0) > 0 || undefined;
      });
      // Now the holder takes the workspace row (what a revoke / erasure does next).
      try {
        await holder.query(
          "UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1",
          [ws.id],
        );
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK");
      }
    } finally {
      holder.release();
    }
    expect(holderError).toBeUndefined();
    expect(await pending).toBe("ok");
    for (const id of ids) expect((await membership(id))?.role).toBe("admin");
    expect(await deadlocks(pg.pool)).toBe(before);
  });

  it("R2-H2: racing creates that lose leave no live unmanaged membership", async () => {
    const ws = await workspace("htwo");
    const results = await Promise.all(
      ["amy", "bob", "dave", "erik"].map((n) =>
        scim(
          ws.token,
          "POST",
          "/Users",
          { schemas: [USER], userName: `${n}@${ws.domain}`, externalId: "same-ext" },
          { server: wide },
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const { rows } = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership m
        WHERE m.workspace_id = $1 AND m.kind = 'staff' AND m.role <> 'owner' AND m.status <> 'revoked'
          AND NOT EXISTS (SELECT 1 FROM core.scim_user s WHERE s.membership_id = m.id AND s.deleted_at IS NULL)`,
      [ws.id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("R2-M1: a tombstoned (erased) user is 404 to late writers; a later POST re-provisions", async () => {
    const ws = await workspace("mone");
    const u = await createUser(ws, "erin");
    await pg.pool.query(
      "UPDATE core.scim_user SET deleted_at = now(), active = false WHERE id = $1",
      [u.id],
    );
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "displayName", value: "Erin Erased" }],
      }),
      404,
    );
    await scimError(
      await scim(ws.token, "PUT", `/Users/${u.id}`, {
        schemas: [USER],
        userName: `erin@${ws.domain}`,
      }),
      404,
    );
    await scimError(await scim(ws.token, "DELETE", `/Users/${u.id}`), 404);
    const again = await createUser(ws, "erin");
    expect(again.id).not.toBe(u.id);
  });

  it("R2-M2: a soft-deleted workspace's token authenticates nothing", async () => {
    const ws = await workspace("mtwo");
    await ok(await scim(ws.token, "GET", "/Users"));
    await pg.pool.query("UPDATE core.workspace SET deleted_at = now() WHERE id = $1", [ws.id]);
    await scimError(await scim(ws.token, "GET", "/Users"), 401);
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: `z@${ws.domain}` }),
      401,
    );
  });

  it("R2-M3: a membership revoked outside SCIM reads active:false and re-provisions", async () => {
    const ws = await workspace("mthree");
    const u = await createUser(ws, "rita");
    const g = await createGroup(ws, "Counsel", [u.id as string]);
    await running.container.scim.setGroupRole(systemContext(ws.id), g.id as string, "legal", {
      membershipId: null,
    });
    const first = await membershipOfScimUser(u.id as string);
    const revoke = () =>
      running.container.auth.memberships.revoke(
        systemContext(ws.id),
        { membershipId: first, reason: "admin" },
        { kind: "system", label: "test:admin" },
      );
    await revoke();
    expect((await ok(await scim(ws.token, "GET", `/Users/${u.id}`)))["active"]).toBe(false);
    const listed = await ok(
      await scim(ws.token, "GET", `/Users?filter=${q(`userName eq "rita@${ws.domain}"`)}`),
    );
    expect(listed.Resources?.[0]?.["active"]).toBe(false);
    // The IdP's active:true re-provisions and relinks (and the mapped role comes back).
    const back = await ok(
      await scim(ws.token, "PATCH", `/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "Replace", path: "active", value: "True" }],
      }),
    );
    expect(back["active"]).toBe(true);
    const second = await membershipOfScimUser(u.id as string);
    expect(second).not.toBe(first);
    expect(await membership(second)).toMatchObject({ status: "active", role: "legal" });
    // Revoked again; a POST for the same person relinks the same SCIM user.
    await running.container.auth.memberships.revoke(
      systemContext(ws.id),
      { membershipId: second, reason: "admin" },
      { kind: "system", label: "test:admin" },
    );
    const reposted = await createUser(ws, "rita");
    expect(reposted.id).toBe(u.id);
    expect(reposted["active"]).toBe(true);
    const third = await membershipOfScimUser(u.id as string);
    expect(await membership(third)).toMatchObject({ status: "active" });
    expect(third).not.toBe(second);
  });

  it("R2-L1 / R2-L2: control characters are 400; createToken refuses when SCIM is disabled", async () => {
    const ws = await workspace("lone");
    const u = await createUser(ws, "nul");
    await scimError(
      await scim(ws.token, "PATCH", `/Users/${u.id}`, {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "displayName", value: "a\u0000b" }],
      }),
      400,
      "invalidValue",
    );
    await scimError(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: `x\u0000@${ws.domain}` }),
      400,
      "invalidValue",
    );
    await scimError(
      await scim(ws.token, "GET", `/Users?filter=${q('displayName eq "a\u0000"')}`),
      400,
      "invalidFilter",
    );
    await expect(
      disabled.container.scim.createToken(
        systemContext(ws.id),
        { name: "x" },
        { membershipId: null },
      ),
    ).rejects.toMatchObject({ code: "scim_disabled", status: 404 });
  });
});

describe("fix round 2", () => {
  /** A co-owner created AFTER `member` (higher membership id), SCIM-adopted, in a group with it. */
  async function ownerAndMember(prefix: string) {
    const ws = await workspace(prefix);
    const member = await createUser(ws, "a1");
    const deps = running.container.identityDeps;
    const coEmail = `coowner@${ws.domain}`;
    const { userId } = await provisionUser(deps, { email: coEmail, displayName: "Co" });
    const co = await provisionMembership(deps, {
      workspaceId: ws.id,
      userId,
      kind: "staff",
      role: "owner",
      source: "test",
    });
    const coScim = await ok(
      await scim(ws.token, "POST", "/Users", { schemas: [USER], userName: coEmail }),
      201,
    );
    const memberMembership = await membershipOfScimUser(member.id as string);
    expect(memberMembership < co.id).toBe(true);
    const g = await createGroup(ws, "Admins", [member.id as string, coScim.id as string]);
    return { ws, g, memberMembership, co: { id: co.id, userId } };
  }

  it("R2-H1b: recompute takes owners before members (deterministic interleave)", async () => {
    const { ws, g, memberMembership } = await ownerAndMember("honeb");
    const before = await deadlocks(pg.pool);
    const holder = await pg.pool.connect();
    let holderError: unknown;
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '20s'");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      // What ownership transfer does: every owner row first…
      await holder.query(
        `SELECT 1 FROM core.membership WHERE workspace_id = $1 AND kind = 'staff' AND role = 'owner'
          ORDER BY id FOR NO KEY UPDATE`,
        [ws.id],
      );
      pending = wide.container.scim
        .setGroupRole(systemContext(ws.id), g.id as string, "legal", { membershipId: null })
        .then(
          () => "ok",
          (e: unknown) => e,
        );
      await waitFor("the recompute to block on the owner rows", async () => {
        const { rows } = await pg.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return (rows[0]?.n ?? 0) > 0 || undefined;
      });
      // …then the target member.
      try {
        await holder.query("SELECT 1 FROM core.membership WHERE id = $1 FOR NO KEY UPDATE", [
          memberMembership,
        ]);
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK");
      }
    } finally {
      holder.release();
    }
    expect(holderError).toBeUndefined();
    expect(await pending).toBe("ok");
    expect((await membership(memberMembership))?.role).toBe("legal");
    expect(await deadlocks(pg.pool)).toBe(before);
  });

  it("R2-H1b: setGroupRole racing ownership transfer ×20 never deadlocks", async () => {
    const { ws, g, memberMembership, co } = await ownerAndMember("honec");
    const { rows } = await pg.pool.query<{ user_id: string }>(
      "SELECT user_id FROM core.membership WHERE id = $1",
      [memberMembership],
    );
    const people = [
      { membershipId: co.id, userId: co.userId },
      { membershipId: memberMembership, userId: rows[0]?.user_id as string },
    ];
    const before = await deadlocks(pg.pool);
    const failures: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const from = people[i % 2] as (typeof people)[number];
      const to = people[(i + 1) % 2] as (typeof people)[number];
      const ctx = {
        workspaceId: ws.id,
        actorKind: "staff" as const,
        membershipId: from.membershipId,
        userId: from.userId,
      };
      const results = await Promise.allSettled([
        wide.container.scim.setGroupRole(
          systemContext(ws.id),
          g.id as string,
          i % 2 === 0 ? "admin" : "legal",
          { membershipId: null },
        ),
        wide.container.auth.memberships.transferOwnership(
          ctx,
          { toMembershipId: to.membershipId },
          { ...from, role: "owner" },
        ),
      ]);
      for (const r of results) if (r.status === "rejected") failures.push(r.reason);
    }
    expect(failures).toEqual([]);
    expect(await deadlocks(pg.pool)).toBe(before);
  }, 120_000);

  it("R2-M1b: a losing create never revokes an invitation it activated", async () => {
    const ws = await workspace("monebe");
    const deps = running.container.identityDeps;
    let invitesLost = 0;
    // Race until an invitee has lost twice (who wins each pair is up to the scheduler).
    for (let i = 0; i < 40 && invitesLost < 2; i++) {
      const email = `inv${i}@${ws.domain}`;
      const { userId } = await provisionUser(deps, { email, displayName: `Inv ${i}` });
      const invite = await provisionMembership(deps, {
        workspaceId: ws.id,
        userId,
        kind: "staff",
        role: "admin",
        source: "test",
        status: "invited",
      });
      const ext = `E${i}`;
      const [inv, other] = await Promise.all([
        scim(
          ws.token,
          "POST",
          "/Users",
          { schemas: [USER], userName: email, externalId: ext },
          {
            server: wide,
          },
        ),
        scim(
          ws.token,
          "POST",
          "/Users",
          { schemas: [USER], userName: `x${i}@${ws.domain}`, externalId: ext },
          { server: wide },
        ),
      ]);
      expect([inv.status, other.status].sort()).toEqual([201, 409]);
      if (inv.status === 409) invitesLost++;
      const m = await membership(invite.id);
      expect(m?.status, `invite ${i}`).not.toBe("revoked");
      expect(m?.role).toBe("admin");
    }
    // The race must actually have been lost by an invitee at least once to mean anything.
    expect(invitesLost).toBeGreaterThan(0);
  }, 120_000);
});

describe("fix round 3", () => {
  it("R4-C1: a relinking PATCH takes the owner rows before any audit", async () => {
    const ws = await workspace("cone");
    const u = await createUser(ws, "rita");
    const first = await membershipOfScimUser(u.id as string);
    await running.container.auth.memberships.revoke(
      systemContext(ws.id),
      { membershipId: first, reason: "admin" },
      { kind: "system", label: "test:admin" },
    );
    const before = await deadlocks(pg.pool);
    const holder = await pg.pool.connect();
    let holderError: unknown;
    let pending: Promise<Response | unknown> = Promise.resolve();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '20s'");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      // 1. What transfer / owner revoke / erasure do first: the owner rows.
      await holder.query(
        `SELECT 1 FROM core.membership WHERE workspace_id = $1 AND kind = 'staff' AND role = 'owner'
          ORDER BY id FOR NO KEY UPDATE`,
        [ws.id],
      );
      // 2. A profile change + active:true on the revoked user (re-provision + relink).
      pending = scim(
        ws.token,
        "PATCH",
        `/Users/${u.id}`,
        {
          schemas: [PATCH],
          Operations: [{ op: "replace", value: { active: true, displayName: "Rita Renamed" } }],
        },
        { server: wide },
      ).catch((e: unknown) => e);
      await waitFor("the relink to block on the owner rows", async () => {
        const { rows } = await pg.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%scim_user%' IS NOT TRUE`,
          [pid],
        );
        return (rows[0]?.n ?? 0) > 0 || undefined;
      });
      // 3. …then the workspace row (the audit chain's first lock).
      try {
        await holder.query(
          "UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = $1",
          [ws.id],
        );
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK");
      }
    } finally {
      holder.release();
    }
    expect(holderError).toBeUndefined();
    const res = (await pending) as Response;
    const body = await ok(res);
    expect(body).toMatchObject({ active: true, displayName: "Rita Renamed" });
    expect(await deadlocks(pg.pool)).toBe(before);
  });
});

describe("E3.10 FR1: a held or suspended workspace (R1-M1)", () => {
  /** The control plane's flags, written the way it writes them (host context). */
  const setHolds = (id: string, holds: string) =>
    running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET holds = '${holds}' WHERE id = '${id}'`),
    );

  it("answers 403 on every /scim/v2 operation and writes nothing; active again, it serves", async () => {
    const ws = await workspace("held");
    const u = await createUser(ws, "hana");
    for (const holds of ["{sanctions_review}", "{operator}", "{billing}"]) {
      await setHolds(ws.id, holds);
      await scimError(await scim(ws.token, "GET", "/Users"), 403);
      await scimError(await scim(ws.token, "GET", `/Users/${u.id}`), 403);
      await scimError(
        await scim(ws.token, "POST", "/Users", {
          schemas: [USER],
          userName: `ivan@${ws.domain}`,
          emails: [{ primary: true, value: `ivan@${ws.domain}` }],
        }),
        403,
      );
      await scimError(
        await scim(ws.token, "PATCH", `/Users/${u.id}`, {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
        403,
      );
      await scimError(await scim(ws.token, "DELETE", `/Users/${u.id}`), 403);
      await scimError(await scim(ws.token, "GET", "/Groups"), 403);
    }
    // Nothing was written while held.
    expect((await membership(await membershipOfScimUser(u.id as string)))?.status).toBe("active");
    const { rows } = await pg.pool.query("SELECT 1 FROM core.user_identity WHERE identifier = $1", [
      `ivan@${ws.domain}`,
    ]);
    expect(rows).toEqual([]);
    await setHolds(ws.id, "{}");
    await ok(await scim(ws.token, "GET", `/Users/${u.id}`));
  });
});

describe("SCIM_ENABLED=false", () => {
  it("answers 404 everywhere under /scim/v2", async () => {
    const ws = await workspace("off");
    for (const path of ["/Users", "/ServiceProviderConfig", "", "/Groups/x"]) {
      await scimError(await scim(ws.token, "GET", path, undefined, { server: disabled }), 404);
    }
    const view = await disabled.container.scim.adminView(systemContext(ws.id));
    expect(view.enabled).toBe(false);
  });

  it("is not answered on a workspace host", async () => {
    const ws = await workspace("host");
    const res = await h.request(ws.slug, "/scim/v2/Users", {
      headers: { authorization: `Bearer ${ws.token}` },
    });
    expect(res.headers.get("content-type") ?? "").not.toMatch(/scim\+json/u);
  });
});
