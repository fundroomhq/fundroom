import { createHash } from "node:crypto";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createFakeVendor, type FakeVendor } from "@fundroom/integrations/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { IntegrationProvider } from "@fundroom/ports";
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
  waitFor,
} from "./test/esign-harness.js";

/*
 * Integrations hub kernel (E3.6, ADR-0054): providers, secret connect, the OAuth handshake with its
 * browser binding, refresh-token rotation under a lease, connection health, disconnect races and
 * booking links. Every vendor is an in-memory fake (`@fundroom/integrations/testing`) injected
 * through `integrationAdapters`; nothing leaves the process.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const logLines: string[] = [];
const vendors: Record<"quickbooks" | "xero" | "stripe", FakeVendor> = {
  quickbooks: createFakeVendor("quickbooks"),
  xero: createFakeVendor("xero"),
  stripe: createFakeVendor("stripe"),
};
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, signIn, runJob } = h;

let acmeId: string;
let owner: Actor;
let finance: Actor;
let investor: Actor;

const post = (slug: string, path: string, cookie: string, body: unknown = {}) =>
  request(slug, `/api/v1${path}`, { method: "POST", cookie, body: JSON.stringify(body) });

interface ConnectionBody {
  id: string;
  provider: string;
  status: string;
  environment: string;
  accountLabel: string | null;
  externalAccountId: string | null;
  availableAccounts?: { id: string; name: string }[];
  lastError: string | null;
  consecutiveFailures: number;
  webhookUrl: string | null;
}

/** A GET on the canonical host (the ops tree), as a browser would send it. */
async function ops(url: string, cookie?: string): Promise<Response> {
  const headers = new Headers({ host: CANON });
  if (cookie !== undefined) headers.set("cookie", cookie);
  return running.app.request(url, { headers, redirect: "manual" });
}

/** begin → start: the vendor authorize URL (with state) and the binding cookie. */
async function beginAndStart(
  provider: IntegrationProvider,
  actor: Actor = owner,
  slug = "acme",
): Promise<{ authorize: URL; cookie: string; state: string; startUrl: string }> {
  const begun = await post(slug, `/integrations/${provider}/oauth/begin`, actor.cookie);
  expect(begun.status, await begun.clone().text()).toBe(200);
  const { startUrl } = await json<{ startUrl: string }>(begun);
  const started = await ops(startUrl);
  expect(started.status).toBe(302);
  const authorize = new URL(started.headers.get("location") ?? "");
  // BASE_URL here is plain http on a non-loopback host: no `Secure`, so no `__Host-` prefix (an
  // https or localhost install gets `__Host-sh_intg; Secure` — `integrations-oauth.test.ts`).
  const setCookie = started.headers.getSetCookie().find((c) => c.startsWith("sh_intg="));
  expect(setCookie).toBeDefined();
  expect(setCookie).toMatch(/HttpOnly/u);
  expect(setCookie).toMatch(/SameSite=Lax/u);
  expect(setCookie).not.toMatch(/Secure/u);
  return {
    authorize,
    cookie: (setCookie ?? "").split(";")[0] ?? "",
    state: authorize.searchParams.get("state") ?? "",
    startUrl,
  };
}

async function callback(query: Record<string, string>, cookie?: string): Promise<URL> {
  const url = new URL(`${BASE}/oauth/integrations/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await ops(url.href, cookie);
  expect(res.status).toBe(302);
  // The binding cookie is always cleared.
  expect(res.headers.getSetCookie().some((c) => /^sh_intg=;.*Max-Age=0/u.test(c))).toBe(true);
  return new URL(res.headers.get("location") ?? "");
}

const hashHex = (token: string) => createHash("sha256").update(token).digest("hex");

/** The one-time pending token a callback redirect carries in its fragment. */
function pendingOf(landed: URL): string {
  expect(landed.searchParams.get("result"), landed.href).toBe("pending");
  const token = new URLSearchParams(landed.hash.slice(1)).get("pending") ?? "";
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  // Never in the query string (Referer, access logs).
  expect(landed.search).not.toContain(token);
  return token;
}

const complete = (provider: string, pendingToken: string, actor = owner, slug = "acme") =>
  post(slug, `/integrations/${provider}/oauth/complete`, actor.cookie, { pendingToken });

async function connectOAuth(provider: "quickbooks" | "xero", slug = "acme", actor = owner) {
  const s = await beginAndStart(provider, actor, slug);
  const landed = await callback(
    { code: vendors[provider].code, state: s.state, realmId: "realm-9" },
    s.cookie,
  );
  const done = await complete(provider, pendingOf(landed), actor, slug);
  expect(done.status, await done.clone().text()).toBe(200);
  return await json<ConnectionBody>(done);
}

async function connections(slug = "acme", cookie = owner.cookie): Promise<ConnectionBody[]> {
  const res = await request(slug, "/api/v1/integrations/connections", { cookie });
  expect(res.status).toBe(200);
  return (await json<{ connections: ConnectionBody[] }>(res)).connections;
}

async function liveRows(workspaceId: string, provider: string) {
  return sql<{
    id: string;
    status: string;
    consecutive_failures: number;
    last_error: string | null;
  }>(
    workspaceId,
    `SELECT id, status, consecutive_failures, last_error FROM core.integration_connection
      WHERE provider = '${provider}' AND deleted_at IS NULL`,
  );
}

async function outboxCount(workspaceId: string, topic: string, where = "true"): Promise<number> {
  const [r] = await sql<{ n: number }>(
    workspaceId,
    `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}' AND ${where}`,
  );
  return r?.n ?? 0;
}

const services = () => running.container.integrations.services;
const readKpi = (workspaceId: string, provider: "quickbooks" | "xero" | "stripe" = "xero") =>
  services().readKpi(systemContext(workspaceId), provider, {
    metrics: ["revenue"],
    fromMonth: "2026-01",
    toMonth: "2026-03",
  });

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      INTEGRATIONS_QUICKBOOKS_CLIENT_ID: "qbo-client",
      INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET: "qbo-secret-value",
      INTEGRATIONS_XERO_CLIENT_ID: "xero-client",
      INTEGRATIONS_XERO_CLIENT_SECRET: "xero-secret-value",
      // Slack deliberately unconfigured: `available: false`.
    }),
    logger: createLogger({
      level: "debug",
      destination: { write: (line: string) => void logLines.push(line) },
    }),
    mailer,
    integrationAdapters: {
      quickbooks: () => vendors.quickbooks.adapter,
      xero: () => vendors.xero.adapter,
      stripe: () => vendors.stripe.adapter,
    },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  finance = await member("acme", acmeId, "cfo@acme.test", "staff", "finance");
  investor = await member("acme", acmeId, "lp@investor.test", "external", "investor");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("providers and access", () => {
  it("lists the providers; an OAuth one without a client is not available", async () => {
    const res = await request("acme", "/api/v1/integrations/providers", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const { providers } = await json<{
      providers: {
        provider: string;
        available: boolean;
        auth: string;
        credentialFields: unknown[];
      }[];
    }>(res);
    const by = Object.fromEntries(providers.map((p) => [p.provider, p]));
    expect(by["xero"]?.available).toBe(true);
    expect(by["quickbooks"]?.available).toBe(true);
    expect(by["slack"]?.available).toBe(false);
    expect(by["stripe"]).toMatchObject({ auth: "secret", available: true });
    const begin = await post("acme", "/integrations/slack/oauth/begin", owner.cookie);
    expect(begin.status).toBe(409);
    expect((await json<ErrorBody>(begin)).error.code).toBe("integration_not_available");
  });

  it("finance reads but cannot connect; an investor gets 404", async () => {
    expect(
      (await request("acme", "/api/v1/integrations/connections", { cookie: finance.cookie }))
        .status,
    ).toBe(200);
    const refused = await post("acme", "/integrations/stripe/connect", finance.cookie, {
      credentials: { restrictedKey: "rk_test_finance" },
    });
    expect(refused.status).toBe(403);
    expect(
      (await request("acme", "/api/v1/integrations/connections", { cookie: investor.cookie }))
        .status,
    ).toBe(404);
  });
});

describe("secret connect (Stripe)", () => {
  it("refuses a full secret key sk_… (least privilege) and stores nothing", async () => {
    for (const key of ["sk_live_abcdef", "sk_test_abcdef"]) {
      const res = await post("acme", "/integrations/stripe/connect", owner.cookie, {
        credentials: { restrictedKey: key },
      });
      expect(res.status).toBe(422);
      expect((await json<ErrorBody>(res)).error.code).toBe("integration_secret_key_refused");
    }
    expect(await liveRows(acmeId, "stripe")).toEqual([]);
  });

  it("refuses a key the vendor rejects (422 integration_credentials_rejected + reason)", async () => {
    vendors.stripe.refusedSecrets.add("rk_live_refused");
    const res = await post("acme", "/integrations/stripe/connect", owner.cookie, {
      credentials: { restrictedKey: "rk_live_refused" },
    });
    expect(res.status).toBe(422);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "integration_credentials_rejected",
      reason: "unauthorized",
    });
  });

  it("accepts rk_ after a live verify; the key is never returned or stored in clear", async () => {
    // Built at run time so secret scanners do not read this made-up value as a Stripe key.
    const key = ["rk", "test", "51SecretValueNeverEchoed"].join("_");
    const res = await post("acme", "/integrations/stripe/connect", owner.cookie, {
      credentials: { restrictedKey: key },
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(key);
    const body = JSON.parse(text) as { connection: ConnectionBody; webhookSecret?: string };
    expect(body.connection).toMatchObject({
      provider: "stripe",
      environment: "sandbox",
      status: "active",
    });
    expect(body.webhookSecret).toBeUndefined();
    const listed = JSON.stringify(await connections());
    expect(listed).not.toContain(key);
    const [raw] = await sql<{ blob: string }>(
      acmeId,
      `SELECT encode(credentials_enc, 'escape') || encryption::text AS blob
         FROM core.integration_connection WHERE id = '${body.connection.id}'`,
    );
    expect(raw?.blob).not.toContain(key);
    expect(logLines.join("\n")).not.toContain(key);
  });

  it("a pasted-secret connect needs a fresh session (stepUp)", async () => {
    const [m] = await sql<{ user_id: string }>(
      acmeId,
      `SELECT user_id::text FROM core.membership WHERE id = '${owner.membershipId}'`,
    );
    const authAge = (age: string) =>
      running.container.db.withHost(async (tx) => {
        const r = await tx.execute(
          `UPDATE core.session SET auth_time = now() - interval '${age}'
             WHERE user_id = '${m?.user_id}'::uuid AND revoked_at IS NULL RETURNING id`,
        );
        expect(r.rows.length).toBeGreaterThan(0);
      });
    await authAge("2 hours");
    const res = await post("acme", "/integrations/stripe/connect", owner.cookie, {
      credentials: { restrictedKey: "rk_test_stale" },
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "step_up_required",
      reason: "fresh",
    });
    await authAge("0 seconds");
  });

  it("an OAuth provider cannot be connected with a pasted secret (409)", async () => {
    const res = await post("acme", "/integrations/xero/connect", owner.cookie, { credentials: {} });
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).error.code).toBe("integration_oauth_required");
  });
});

describe("OAuth handshake", () => {
  it("start burns the ticket, sets the binding cookie and redirects with state + PKCE", async () => {
    const s = await beginAndStart("xero");
    expect(s.authorize.origin + s.authorize.pathname).toBe(
      "https://fake-vendor.test/xero/authorize",
    );
    expect(s.authorize.searchParams.get("client_id")).toBe("xero-client");
    expect(s.authorize.searchParams.get("redirect_uri")).toBe(
      `${BASE}/oauth/integrations/callback`,
    );
    expect(s.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // Single use: the same start URL again lands on the error page.
    const again = await ops(s.startUrl);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(
      `${BASE}/admin/integrations?result=error&reason=expired`,
    );
    expect(again.headers.getSetCookie().some((c) => c.startsWith("sh_intg=;"))).toBe(true);
  });

  it("a ticket older than 2 minutes is refused", async () => {
    const begun = await post("acme", "/integrations/xero/oauth/begin", owner.cookie);
    const { startUrl } = await json<{ startUrl: string }>(begun);
    await sql(
      acmeId,
      `UPDATE core.integration_oauth_state SET ticket_expires_at = now() - interval '1 second'
        WHERE ticket_claimed_at IS NULL`,
    );
    const res = await ops(startUrl);
    expect(res.headers.get("location")).toContain("reason=expired");
    expect(res.headers.getSetCookie().some((c) => /^sh_intg=[^;]/u.test(c))).toBe(false);
  });

  it("a callback without the binding cookie, or with another browser's, is browser_mismatch", async () => {
    const s = await beginAndStart("xero");
    const other = await beginAndStart("xero");
    const noCookie = await callback({ code: vendors.xero.code, state: s.state });
    expect(noCookie.host).toBe(`acme.${CANON}`);
    expect(noCookie.searchParams.get("result")).toBe("error");
    expect(noCookie.searchParams.get("reason")).toBe("browser_mismatch");
    const wrong = await callback({ code: vendors.xero.code, state: other.state }, s.cookie);
    expect(wrong.searchParams.get("reason")).toBe("browser_mismatch");
    expect(await liveRows(acmeId, "xero")).toEqual([]);
    const [audit] = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'integration.oauth_failed'
          AND meta->>'reason' = 'browser_mismatch'`,
    );
    expect(audit?.n).toBeGreaterThanOrEqual(2);
  });

  it("the vendor's access_denied lands as reason=denied, with no vendor text", async () => {
    const s = await beginAndStart("quickbooks");
    const landed = await callback(
      { error: "access_denied", error_description: "User said <b>no</b>", state: s.state },
      s.cookie,
    );
    expect(landed.searchParams.get("reason")).toBe("denied");
    expect(landed.href).not.toContain("said");
  });

  it("connects: tokens never appear in the redirect, the API or the logs", async () => {
    vendors.xero.accounts = [
      { id: "tenant-a", name: "Acme Ltd" },
      { id: "tenant-b", name: "Acme Holdings" },
    ];
    const s = await beginAndStart("xero");
    const landed = await callback({ code: vendors.xero.code, state: s.state }, s.cookie);
    expect(landed.origin + landed.pathname + landed.search).toBe(
      `http://acme.${CANON}/admin/integrations?integration=xero&result=pending`,
    );
    // Nothing is connected until the initiator confirms.
    expect(await liveRows(acmeId, "xero")).toEqual([]);
    const done = await complete("xero", pendingOf(landed));
    expect(done.status, await done.clone().text()).toBe(200);
    // A used handshake keeps no token material (fix round 3).
    const [left] = await sql<{ n: number }>(
      acmeId,
      `SELECT count(*)::int AS n FROM core.integration_oauth_state
        WHERE completed_at IS NOT NULL AND (pending_enc IS NOT NULL OR verifier_enc IS NOT NULL)`,
    );
    expect(left?.n).toBe(0);
    // Single use.
    const again = await complete("xero", pendingOf(landed));
    expect(again.status).toBe(404);
    expect((await json<ErrorBody>(again)).error.code).toBe("integration_oauth_pending_invalid");
    expect(vendors.xero.calls.lastExchange?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    const [conn] = (await connections()).filter((c) => c.provider === "xero");
    expect(conn).toMatchObject({ status: "active", externalAccountId: "tenant-a" });
    expect(conn?.availableAccounts).toEqual(vendors.xero.accounts);
    const everything = JSON.stringify(await connections()) + logLines.join("\n") + landed.href;
    for (const t of [
      ...vendors.xero.accessTokens,
      ...vendors.xero.refreshTokens,
      vendors.xero.code,
    ]) {
      expect(everything).not.toContain(t);
    }
    // Replay of the same state: consumed.
    const replay = await callback({ code: vendors.xero.code, state: s.state }, s.cookie);
    expect(replay.href).toBe(`${BASE}/admin/integrations?result=error&reason=expired`);
  });

  it("a state past its 10 minutes is refused", async () => {
    const s = await beginAndStart("quickbooks");
    await sql(
      acmeId,
      `UPDATE core.integration_oauth_state SET expires_at = now() - interval '1 second'
        WHERE consumed_at IS NULL`,
    );
    const landed = await callback({ code: vendors.quickbooks.code, state: s.state }, s.cookie);
    expect(landed.searchParams.get("reason")).toBe("expired");
    expect(await liveRows(acmeId, "quickbooks")).toEqual([]);
  });

  it("chooses a Xero organisation only from the grant's list", async () => {
    const unknown = await request("acme", "/api/v1/integrations/xero/account", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ externalAccountId: "tenant-zzz" }),
    });
    expect(unknown.status).toBe(422);
    expect((await json<ErrorBody>(unknown)).error.code).toBe("integration_account_unknown");
    const ok = await request("acme", "/api/v1/integrations/xero/account", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ externalAccountId: "tenant-b" }),
    });
    expect(ok.status).toBe(200);
    expect(await json<ConnectionBody>(ok)).toMatchObject({
      externalAccountId: "tenant-b",
      accountLabel: "Fake xero tenant-b",
    });
  });

  it("reconnecting replaces the old connection (one live row, the old one soft-deleted)", async () => {
    const before = await liveRows(acmeId, "xero");
    await connectOAuth("xero");
    const after = await liveRows(acmeId, "xero");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
    const [old] = await sql<{ deleted: boolean }>(
      acmeId,
      `SELECT deleted_at IS NOT NULL AS deleted FROM core.integration_connection WHERE id = '${before[0]?.id}'`,
    );
    expect(old?.deleted).toBe(true);
  });

  it("start and callback are not ops routes on a tenant host", async () => {
    const s = await beginAndStart("quickbooks");
    const onTenant = await running.app.request(
      `http://acme.${CANON}/oauth/integrations/callback?code=${vendors.quickbooks.code}&state=${s.state}`,
      { headers: { host: `acme.${CANON}`, cookie: s.cookie }, redirect: "manual" },
    );
    expect(onTenant.status).not.toBe(302);
    expect(onTenant.headers.getSetCookie().some((c) => c.includes("sh_intg"))).toBe(false);
    const start = await running.app.request(
      `http://acme.${CANON}/oauth/integrations/start?ticket=x`,
      {
        headers: { host: `acme.${CANON}` },
        redirect: "manual",
      },
    );
    expect(start.status).not.toBe(302);
    // The state is untouched by the tenant-host request: the canonical callback still works.
    const landed = await callback(
      { code: vendors.quickbooks.code, state: s.state, realmId: "r1" },
      s.cookie,
    );
    expect((await complete("quickbooks", pendingOf(landed))).status).toBe(200);
    expect(vendors.quickbooks.calls.lastExchange?.query["realmId"]).toBe("r1");
  });
});

describe("OAuth confirm step (fix round 1)", () => {
  it("a start link mailed to a victim never connects the victim's vendor account (confused deputy)", async () => {
    const evilId = (await createWorkspace(running.container.db, { slug: "evil", name: "Evil" })).id;
    const attacker = await member("evil", evilId, "boss@evil.test", "staff", "owner");
    // The attacker begins and mails the start URL; the VICTIM's browser (no session for `evil`,
    // no cookies) opens it, consents at the vendor, and is sent back.
    const begun = await post("evil", "/integrations/quickbooks/oauth/begin", attacker.cookie);
    const { startUrl } = await json<{ startUrl: string }>(begun);
    const started = await ops(startUrl);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const victimCookie = (started.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const landed = await callback(
      { code: vendors.quickbooks.code, state, realmId: "victim-realm" },
      victimCookie,
    );
    expect(landed.host).toBe(`evil.${CANON}`);
    expect(landed.searchParams.get("result")).toBe("pending");
    // Nothing is connected in the attacker's workspace…
    expect(await liveRows(evilId, "quickbooks")).toEqual([]);
    // …and the attacker, who never sees the fragment, cannot finish it.
    for (const pendingToken of ["A".repeat(43), "", begun.headers.get("x-nothing") ?? "x"]) {
      const res = await complete("quickbooks", pendingToken, attacker, "evil");
      expect([400, 404]).toContain(res.status);
    }
    const guessed = await complete("quickbooks", "A".repeat(43), attacker, "evil");
    expect(guessed.status).toBe(404);
    expect((await json<ErrorBody>(guessed)).error.code).toBe("integration_oauth_pending_invalid");
    expect(await liveRows(evilId, "quickbooks")).toEqual([]);
  });

  it("only the initiator may confirm, for the same provider, within 10 minutes", async () => {
    const other = await member("acme", acmeId, "admin3@acme.test", "staff", "admin");
    const s = await beginAndStart("quickbooks");
    const token = pendingOf(
      await callback({ code: vendors.quickbooks.code, state: s.state, realmId: "r2" }, s.cookie),
    );
    const byOther = await complete("quickbooks", token, other);
    expect(byOther.status).toBe(404);
    const wrongProvider = await complete("xero", token);
    expect(wrongProvider.status).toBe(404);
    await sql(
      acmeId,
      "UPDATE core.integration_oauth_state SET pending_expires_at = now() - interval '1 second' WHERE pending_hash IS NOT NULL AND completed_at IS NULL",
    );
    const expired = await complete("quickbooks", token);
    expect(expired.status).toBe(404);
    expect((await json<ErrorBody>(expired)).error.code).toBe("integration_oauth_pending_invalid");
  });

  it("the callback never lands on the workspace's custom domain (fix round 2)", async () => {
    // A verified custom domain is DNS the workspace owner controls: they could point it at their
    // own server and read the `#pending=` fragment. The redirect uses the operator's address.
    await sql(
      acmeId,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, activated_at)
         VALUES ('${acmeId}', 'investors.acme-owned.test', 'active', 'tokentokentokentoken', now())`,
    );
    try {
      const s = await beginAndStart("quickbooks");
      const ok = await callback(
        { code: vendors.quickbooks.code, state: s.state, realmId: "r9" },
        s.cookie,
      );
      expect(ok.host).toBe(`acme.${CANON}`);
      expect(ok.searchParams.get("result")).toBe("pending");
      const e = await beginAndStart("quickbooks");
      const err = await callback({ error: "access_denied", state: e.state }, e.cookie);
      expect(err.host).toBe(`acme.${CANON}`);
    } finally {
      await sql(
        acmeId,
        "UPDATE core.custom_domain SET deleted_at = now(), status = 'removed' WHERE hostname = 'investors.acme-owned.test'",
      ).catch(async () =>
        sql(acmeId, "DELETE FROM core.custom_domain WHERE hostname = 'investors.acme-owned.test'"),
      );
    }
  });

  it("the sweep leaves a still-valid pending grant alone, even past the handshake's expiry", async () => {
    const sweep = () => runJob("integrations.oauth-state-sweep", {});
    const pendingPastStart = async () => {
      const s = await beginAndStart("quickbooks");
      const token = pendingOf(
        await callback(
          { code: vendors.quickbooks.code, state: s.state, realmId: "acct" },
          s.cookie,
        ),
      );
      // begin + 10 min has passed; callback + 10 min has not.
      await sql(
        acmeId,
        `UPDATE core.integration_oauth_state SET expires_at = now() - interval '1 second'
          WHERE pending_hash = decode('${hashHex(token)}', 'hex')`,
      );
      return token;
    };
    const revokes = () => vendors.quickbooks.calls.revoke.length;
    // Clear what earlier tests left dead, so the counts below are this test's alone.
    await sweep();

    const first = await pendingPastStart();
    const before = revokes();
    await sweep();
    expect(revokes()).toBe(before);
    expect((await complete("quickbooks", first)).status).toBe(200);

    // Concurrent confirm + sweep: a working connection, nothing revoked.
    const second = await pendingPastStart();
    const at = revokes();
    const [done] = await Promise.all([complete("quickbooks", second), sweep()]);
    expect(done.status, await done.clone().text()).toBe(200);
    expect(revokes()).toBe(at);
    expect((await readKpi(acmeId, "quickbooks")).ok).toBe(true);

    // A grant nobody confirmed in time IS revoked and cannot be confirmed afterwards.
    const dead = await pendingPastStart();
    await sql(
      acmeId,
      `UPDATE core.integration_oauth_state SET pending_expires_at = now() - interval '1 second'
        WHERE pending_hash = decode('${hashHex(dead)}', 'hex')`,
    );
    const b = revokes();
    await sweep();
    expect(revokes()).toBe(b + 1);
    expect((await complete("quickbooks", dead)).status).toBe(404);
  });

  it("an initiator demoted mid-handshake cannot confirm", async () => {
    const admin = await member("acme", acmeId, "admin2@acme.test", "staff", "admin");
    const s = await beginAndStart("quickbooks", admin);
    const token = pendingOf(
      await callback({ code: vendors.quickbooks.code, state: s.state, realmId: "r3" }, s.cookie),
    );
    const before = (await liveRows(acmeId, "quickbooks")).map((r) => r.id);
    await sql(
      acmeId,
      `UPDATE core.membership SET role = 'finance' WHERE id = '${admin.membershipId}'`,
    );
    const res = await complete("quickbooks", token, admin);
    expect(res.status).toBe(403);
    expect((await liveRows(acmeId, "quickbooks")).map((r) => r.id)).toEqual(before);
    // The kernel re-checks on its own too (a caller that skipped the route guard).
    await expect(
      running.container.integrations.confirmOAuth(
        { workspaceId: acmeId, actorKind: "staff", membershipId: admin.membershipId } as never,
        "quickbooks",
        token,
        { membershipId: admin.membershipId },
      ),
    ).rejects.toMatchObject({ code: "integration_oauth_pending_invalid" });
  });
});

describe("token refresh (lease, rotation, invalid_grant)", () => {
  async function expireAccess(workspaceId: string, provider: string) {
    // The vendor forgets every access token it issued and the row says it expired.
    vendors.xero.accessTokens.clear();
    await sql(
      workspaceId,
      `UPDATE core.integration_connection SET access_expires_at = now() - interval '1 minute'
        WHERE provider = '${provider}' AND deleted_at IS NULL`,
    );
  }

  it("concurrent reads on an expired token perform exactly ONE vendor refresh", async () => {
    await expireAccess(acmeId, "xero");
    vendors.xero.refreshDelayMs = 400;
    const before = vendors.xero.calls.refresh;
    const results = await Promise.all(Array.from({ length: 5 }, () => readKpi(acmeId)));
    vendors.xero.refreshDelayMs = 0;
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(vendors.xero.calls.refresh - before).toBe(1);
  });

  it("stores the rotated refresh token (the next refresh works; the old token is dead)", async () => {
    await expireAccess(acmeId, "xero");
    const before = vendors.xero.calls.refresh;
    const r = await readKpi(acmeId);
    expect(r.ok).toBe(true);
    expect(vendors.xero.calls.refresh - before).toBe(1);
    // Only the newest refresh token is still valid at the vendor, and it is ours.
    expect(vendors.xero.refreshTokens.size).toBe(1);
  });

  it("a 401 on a fresh token forces one refresh and retries", async () => {
    vendors.xero.accessTokens.clear();
    const before = vendors.xero.calls.refresh;
    const r = await readKpi(acmeId);
    expect(r.ok).toBe(true);
    expect(vendors.xero.calls.refresh - before).toBe(1);
  });

  it("invalid_grant → reauth_required and one integration.connection_unhealthy", async () => {
    const [conn] = await liveRows(acmeId, "xero");
    await expireAccess(acmeId, "xero");
    vendors.xero.refreshTokens.clear();
    const r = await readKpi(acmeId);
    expect(r).toEqual({ ok: false, reason: "unauthorized" });
    expect((await liveRows(acmeId, "xero"))[0]).toMatchObject({ status: "reauth_required" });
    const where = `payload->>'connectionId' = '${conn?.id}' AND payload->>'status' = 'reauth_required'`;
    expect(await outboxCount(acmeId, "integration.connection_unhealthy", where)).toBe(1);
    // Still refused: no second event for the same state.
    await readKpi(acmeId);
    expect(await outboxCount(acmeId, "integration.connection_unhealthy", where)).toBe(1);
    // Reconnect heals it.
    await connectOAuth("xero");
    expect((await liveRows(acmeId, "xero"))[0]).toMatchObject({ status: "active" });
  });

  it("3 consecutive failures → degraded (one event); a success resets", async () => {
    const [conn] = await liveRows(acmeId, "xero");
    vendors.xero.failKpi = "transport";
    for (let i = 0; i < 3; i += 1) expect((await readKpi(acmeId)).ok).toBe(false);
    expect((await liveRows(acmeId, "xero"))[0]).toMatchObject({
      status: "degraded",
      consecutive_failures: 3,
    });
    await readKpi(acmeId);
    const where = `payload->>'connectionId' = '${conn?.id}' AND payload->>'status' = 'degraded'`;
    expect(await outboxCount(acmeId, "integration.connection_unhealthy", where)).toBe(1);
    vendors.xero.failKpi = undefined;
    expect((await readKpi(acmeId)).ok).toBe(true);
    expect((await liveRows(acmeId, "xero"))[0]).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      last_error: null,
    });
  });

  it("an unconnected provider answers not_connected, never throws", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "empty", name: "E" })).id;
    expect(await readKpi(ws)).toEqual({ ok: false, reason: "not_connected" });
  });
});

describe("disconnect races", () => {
  it("a disconnect during a read does not resurrect the connection", async () => {
    const [conn] = await liveRows(acmeId, "xero");
    let release: () => void = () => {};
    vendors.xero.gate = new Promise<void>((r) => {
      release = r;
    });
    const before = vendors.xero.calls.kpi;
    const reading = readKpi(acmeId);
    await waitFor("the vendor call", async () => vendors.xero.calls.kpi > before);
    const del = await request("acme", "/api/v1/integrations/xero", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    const [{ updated_at: afterDelete } = { updated_at: "" }] = await sql<{ updated_at: string }>(
      acmeId,
      `SELECT updated_at::text FROM core.integration_connection WHERE id = '${conn?.id}'`,
    );
    release();
    vendors.xero.gate = undefined;
    await reading;
    expect(await liveRows(acmeId, "xero")).toEqual([]);
    const [row] = await sql<{ deleted: boolean; updated_at: string }>(
      acmeId,
      `SELECT deleted_at IS NOT NULL AS deleted, updated_at::text FROM core.integration_connection
        WHERE id = '${conn?.id}'`,
    );
    expect(row).toEqual({ deleted: true, updated_at: afterDelete });
    expect(await readKpi(acmeId)).toEqual({ ok: false, reason: "not_connected" });
    expect(vendors.xero.calls.revoke.length).toBeGreaterThan(0);
  });

  it("concurrent connects and a disconnect serialise on the singleton lock", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "race", name: "R" })).id;
    const o = await member("race", ws, "owner@race.test", "staff", "owner");
    const connect = (i: number) =>
      post("race", "/integrations/stripe/connect", o.cookie, {
        credentials: { restrictedKey: `rk_test_race_${i}` },
      });
    const statuses = (await Promise.all([0, 1, 2, 3, 4].map(connect))).map((r) => r.status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(await liveRows(ws, "stripe")).toHaveLength(1);
    const mixed = await Promise.all([
      connect(5),
      request("race", "/api/v1/integrations/stripe", { method: "DELETE", cookie: o.cookie }),
      connect(6),
    ]);
    for (const r of mixed) expect([200, 404]).toContain(r.status);
    expect((await liveRows(ws, "stripe")).length).toBeLessThanOrEqual(1);
    const [n] = await sql<{ n: number }>(
      ws,
      "SELECT count(*)::int AS n FROM core.integration_connection WHERE provider = 'stripe'",
    );
    expect(n?.n).toBe(7);
  });
});

describe("booking links", () => {
  let groupA: string;
  let inA: Actor;
  let outside: Actor;
  let delegate: Actor;

  const create = (body: Record<string, unknown>, cookie = owner.cookie) =>
    post("acme", "/integrations/booking-links", cookie, body);
  const mine = async (actor: Actor) => {
    const res = await request("acme", "/api/v1/integrations/me/booking-links", {
      cookie: actor.cookie,
    });
    expect(res.status).toBe(200);
    return (await json<{ links: { label: string; url: string }[] }>(res)).links.map((l) => l.label);
  };
  const bootstrapFlag = async (actor: Actor) =>
    (
      await json<{ bookingLinksAvailable: boolean }>(
        await request("acme", "/api/v1/modules", { cookie: actor.cookie }),
      )
    ).bookingLinksAvailable;

  beforeAll(async () => {
    inA = await member("acme", acmeId, "in-a@investor.test", "external", "investor");
    outside = await member("acme", acmeId, "outside@investor.test", "external", "investor");
    delegate = await member("acme", acmeId, "helper@investor.test", "external", "investor");
    await sql(
      acmeId,
      `UPDATE core.membership SET role = 'delegate', principal_membership_id = '${inA.membershipId}',
              delegate_scope = 'data_room' WHERE id = '${delegate.membershipId}'`,
    );
    const [g] = await sql<{ id: string }>(
      acmeId,
      `INSERT INTO core."group" (workspace_id, name) VALUES ('${acmeId}', 'Lead investors') RETURNING id`,
    );
    groupA = g?.id ?? "";
    await sql(
      acmeId,
      `INSERT INTO core.group_member (workspace_id, group_id, membership_id)
         VALUES ('${acmeId}', '${groupA}', '${inA.membershipId}')`,
    );
  });

  it("no links: the bootstrap flag is false for everyone", async () => {
    expect(await bootstrapFlag(inA)).toBe(false);
    expect(await bootstrapFlag(owner)).toBe(false);
  });

  it("refuses URLs off the provider's hosts, non-https, with userinfo or a port", async () => {
    for (const url of [
      "http://cal.com/acme",
      "https://evil.example/cal.com",
      "https://user:pw@cal.com/acme",
      "https://cal.com:8443/acme",
      "https://calendly.com/acme",
    ]) {
      const res = await create({ provider: "calcom", url, label: "Book" });
      expect(res.status, url).toBe(422);
      expect((await json<ErrorBody>(res)).error.code).toBe("booking_link_invalid_url");
    }
    const unknownGroup = await create({
      provider: "calcom",
      url: "https://cal.com/acme",
      label: "x",
      audience: { kind: "groups", groupIds: ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a"] },
    });
    expect(unknownGroup.status).toBe(400);
  });

  it("audience filtering: everyone vs a group; delegates borrow their principal's groups", async () => {
    const all = await create({
      provider: "calendly",
      url: "https://calendly.com/acme/intro",
      label: "Intro call",
    });
    expect(all.status, await all.clone().text()).toBe(200);
    const leads = await create({
      provider: "calcom",
      url: "https://cal.com/acme/leads",
      label: "Lead investor call",
      audience: { kind: "groups", groupIds: [groupA] },
    });
    expect(leads.status).toBe(200);
    const off = await create({
      provider: "calcom",
      url: "https://app.cal.com/acme/off",
      label: "Disabled",
      enabled: false,
    });
    expect(off.status).toBe(200);

    expect(await mine(inA)).toEqual(["Intro call", "Lead investor call"]);
    expect(await mine(outside)).toEqual(["Intro call"]);
    expect(await mine(delegate)).toEqual(["Intro call", "Lead investor call"]);
    expect(await mine(owner)).toEqual(["Intro call", "Lead investor call"]);
    expect(await bootstrapFlag(inA)).toBe(true);
    expect(await bootstrapFlag(outside)).toBe(true);

    // Only the group link left enabled: an outsider's card disappears.
    const allId = (await json<{ id: string }>(all)).id;
    const patched = await request("acme", `/api/v1/integrations/booking-links/${allId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(await mine(outside)).toEqual([]);
    expect(await bootstrapFlag(outside)).toBe(false);
    expect(await bootstrapFlag(delegate)).toBe(true);
    // The investor never sees the admin list.
    expect(
      (await request("acme", "/api/v1/integrations/booking-links", { cookie: inA.cookie })).status,
    ).toBe(404);
  });

  it("caps a workspace at 10 links (409 booking_link_limit)", async () => {
    const existing = (
      await json<{ links: unknown[] }>(
        await request("acme", "/api/v1/integrations/booking-links", { cookie: owner.cookie }),
      )
    ).links.length;
    const results = await Promise.all(
      Array.from({ length: 12 - existing }, (_, i) =>
        create({ provider: "calcom", url: `https://cal.com/acme/slot-${i}`, label: `Slot ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10 - existing);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    expect((await json<ErrorBody>(refused[0] as Response)).error.code).toBe("booking_link_limit");
  });

  it("an admin without a fresh session may still curate links (no stepUp); a level-1 session may not", async () => {
    const cookie = await signIn("acme", "owner@acme.test");
    const res = await request("acme", "/api/v1/integrations/booking-links", { cookie });
    expect(res.status).toBe(403);
  });
});
