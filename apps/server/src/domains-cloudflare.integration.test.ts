import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { CHALLENGE_LABEL, runVerifySweep } from "@fundroom/custom-domains";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { DnsAnswer, DnsRecordType, DnsResolverPort } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * `CUSTOM_DOMAIN_DRIVER=cloudflare-saas` end to end (E3.10 §5.8), against a fake Cloudflare
 * custom-hostnames API reached through the real guarded client:
 *
 *  - Cloudflare is asked to create the hostname ONLY after our TXT challenge verified it;
 *  - the domain stays `dns_ok` — through requests served on the hostname and any number of
 *    sweeps — until Cloudflare says the hostname AND its certificate are active;
 *  - Cloudflare's extra records and state are on the admin API;
 *  - a 429 does not fail or promote anything, and removal deletes the custom hostname;
 *  - E3.10 FR1: Cloudflare's id is stored and used (GET/DELETE by id, no search), and the
 *    release is an outbox job that retries a failed DELETE until Cloudflare confirms it.
 */

const BASE = "http://portal.fundroom-test.com";
const CANON = "portal.fundroom-test.com";
const EDGE = "customers.fundroom-test.com";
const CUSTOM = "investors.acme-ir.com";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const TOKEN = "cf-integration-token";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let cf: Server;

// --- fake DNS ------------------------------------------------------------------------------
const zone = new Map<string, Map<DnsRecordType, readonly string[]>>();
function publish(name: string, type: DnsRecordType, values: readonly string[]): void {
  const byType = zone.get(name) ?? new Map<DnsRecordType, readonly string[]>();
  byType.set(type, values);
  zone.set(name, byType);
}
const fakeDns: DnsResolverPort = {
  driver: "fake",
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
    const byType = zone.get(name.toLowerCase());
    return Promise.resolve({
      name,
      type,
      values: [...(byType?.get(type) ?? [])],
      rcode: byType === undefined ? "nxdomain" : "ok",
      resolver: "fake",
      chain: undefined,
    });
  },
  healthCheck: () => Promise.resolve(),
};

// --- fake Cloudflare -----------------------------------------------------------------------
interface CfRow {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; validation_records: { txt_name: string; txt_value: string }[] };
  ownership_verification: { type: string; name: string; value: string };
}
const cfRows = new Map<string, CfRow>();
const cfCalls: { method: string; path: string; auth: string | undefined }[] = [];
let cfRateLimited = false;
/** DELETEs to fail with a 500 before the fake honours one (the retrying release job). */
let cfDeleteFailures = 0;

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function handleCf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://cf");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  cfCalls.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization });
  if (cfRateLimited) return send(res, 429, { success: false }, { "retry-after": "1" });
  const prefix = `/client/v4/zones/${ZONE}/custom_hostnames`;
  const ok = (result: unknown, status = 200) =>
    send(res, status, { success: true, errors: [], messages: [], result });
  if (req.method === "POST" && url.pathname === prefix) {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { hostname: string };
    if ([...cfRows.values()].some((r) => r.hostname === body.hostname)) {
      return send(res, 409, { success: false, errors: [{ code: 1406, message: "Duplicate" }] });
    }
    const row: CfRow = {
      id: `ch-${cfRows.size + 1}`,
      hostname: body.hostname,
      status: "pending",
      ssl: {
        status: "pending_validation",
        validation_records: [{ txt_name: `_acme-challenge.${body.hostname}`, txt_value: "dcv" }],
      },
      ownership_verification: {
        type: "txt",
        name: `_cf-custom-hostname.${body.hostname}`,
        value: "own",
      },
    };
    cfRows.set(row.id, row);
    return ok(row, 201);
  }
  if (req.method === "GET" && url.pathname === prefix) {
    const h = url.searchParams.get("hostname.exact");
    const rows = [...cfRows.values()].filter((r) => r.hostname === h);
    return send(res, 200, {
      success: true,
      errors: [],
      result: rows,
      result_info: {
        page: 1,
        per_page: 50,
        count: rows.length,
        total_count: rows.length,
        total_pages: 1,
      },
    });
  }
  if (req.method === "GET" && url.pathname.startsWith(`${prefix}/`)) {
    const row = cfRows.get(url.pathname.slice(prefix.length + 1));
    if (row === undefined) return send(res, 404, { success: false, errors: [{ code: 1436 }] });
    return ok(row);
  }
  if (req.method === "DELETE" && url.pathname.startsWith(`${prefix}/`)) {
    if (cfDeleteFailures > 0) {
      cfDeleteFailures--;
      return send(res, 500, { success: false, errors: [{ code: 1500, message: "internal" }] });
    }
    const id = url.pathname.slice(prefix.length + 1);
    if (!cfRows.delete(id)) return send(res, 404, { success: false, errors: [{ code: 1436 }] });
    return ok({ id });
  }
  return send(res, 400, { success: false, errors: [{ code: 1400, message: "bad" }] });
}

// --- actors --------------------------------------------------------------------------------
async function req(host: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie) headers.set("origin", `http://${host}`);
  return running.app.request(`http://${host}${path}`, { ...init, headers });
}
const request = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  req(`acme.${CANON}`, path, init);

async function ownerCookie(workspaceId: string): Promise<string> {
  const deps = running.container.identityDeps;
  const email = "owner@acme-ir.com";
  const user = await provisionUser(deps, { email, displayName: "Owner" });
  await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  const since = mailer.sent.length;
  expect(
    (await request("/api/v1/auth/otp/start", { method: "POST", body: JSON.stringify({ email }) }))
      .status,
  ).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

interface Record_ {
  type: string;
  name: string;
  value: string;
  required: boolean;
}
interface Domain {
  id: string;
  status: "pending" | "dns_ok" | "active" | "failed";
  detail: string | null;
  activatedAt: string | null;
  providerState?: "pending" | "active" | "failed";
  providerRecords?: Record_[];
}

let owner = "";
let domainId = "";

async function listed(): Promise<{ driver: string; domains: Domain[] }> {
  const res = await request("/api/v1/domains", { cookie: owner });
  expect(res.status).toBe(200);
  return (await res.json()) as { driver: string; domains: Domain[] };
}
async function current(): Promise<Domain> {
  const d = (await listed()).domains.find((x) => x.id === domainId);
  if (d === undefined) throw new Error("domain gone");
  return d;
}
/**
 * One verify tick, ignoring the per-row provider-poll schedule by clearing `last_checked_at` and
 * the once-a-minute provider re-ask (FR1) by ageing the stored provider facts' `checkedAt`.
 */
async function sweep(hostname = CUSTOM): Promise<void> {
  await running.container.db.withHost((tx) =>
    tx.execute(
      `UPDATE core.custom_domain SET last_checked_at = NULL,
         last_answer = CASE WHEN last_answer ? 'provider'
           THEN jsonb_set(last_answer, '{provider,checkedAt}', '"2000-01-01T00:00:00.000Z"')
           ELSE last_answer END
       WHERE hostname = '${hostname}'`,
    ),
  );
  await runVerifySweep({ db: running.container.db, service: running.container.customDomains });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  cf = createServer((q, s) => void handleCf(q, s));
  await new Promise<void>((resolve) => cf.listen(0, "127.0.0.1", resolve));
  const port = (cf.address() as AddressInfo).port;
  running = await startServer({
    config: loadConfig({
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        BASE_URL: BASE,
        DATABASE_URL: pg.connectionString,
        FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
        STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
        TENANCY_MODE: "multi",
        ROLES: "api,web,worker",
        CUSTOM_DOMAIN_DRIVER: "cloudflare-saas",
        CUSTOM_DOMAIN_CNAME_TARGET: EDGE,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ZONE_ID: ZONE,
        CLOUDFLARE_API_BASE: `http://127.0.0.1:${port}/client/v4`,
        OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
        // One pool connection: a provider call or a second connection taken while a
        // transaction is open would deadlock here instead of passing by luck.
        DATABASE_POOL_MAX: "1",
      },
    }),
    logger: createLogger({ level: "warn" }),
    mailer,
    dns: fakeDns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const acme = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await ownerCookie(acme);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await new Promise((resolve) => cf?.close(resolve));
  await pg?.stop();
});

describe("cloudflare-saas custom domains", () => {
  it("names the driver and adds the hostname without telling Cloudflare anything", async () => {
    expect((await listed()).driver).toBe("cloudflare-saas");
    const res = await request("/api/v1/domains", {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ hostname: CUSTOM }),
    });
    expect(res.status).toBe(201);
    domainId = ((await res.json()) as Domain).id;
    expect(cfCalls).toEqual([]);
  });

  it("asks Cloudflare nothing while the TXT challenge is unproven, even with the CNAME in place", async () => {
    publish(CUSTOM, "CNAME", [EDGE]);
    await sweep();
    expect((await current()).status).toBe("pending");
    expect(cfCalls).toEqual([]);
  });

  it("registers the hostname once the TXT verifies, and shows Cloudflare's records", async () => {
    const token = await tokenOf();
    publish(`${CHALLENGE_LABEL}.${CUSTOM}`, "TXT", [token]);
    await sweep();
    const d = await current();
    expect(d.status).toBe("dns_ok");
    expect(cfCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /client/v4/zones/${ZONE}/custom_hostnames`,
    ]);
    expect(cfCalls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(d.providerState).toBe("pending");
    expect(d.providerRecords?.map((r) => r.name).sort()).toEqual([
      `_acme-challenge.${CUSTOM}`,
      `_cf-custom-hostname.${CUSTOM}`,
    ]);
    // FR1: Cloudflare's id is stored with the provider facts…
    const [stored] = (
      await pg.pool.query(
        `SELECT last_answer->'provider'->>'ref' AS ref FROM core.custom_domain WHERE id = $1`,
        [domainId],
      )
    ).rows as { ref: string | null }[];
    expect(stored?.ref).toBe("ch-1");
  });

  it("asks for status by id, never by searching (FR1)", async () => {
    const before = cfCalls.length;
    await sweep();
    expect(cfCalls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /client/v4/zones/${ZONE}/custom_hostnames/ch-1`,
    ]);
    // "Verify now" within a minute of that answers from the stored facts: no call at all.
    const res = await request(`/api/v1/domains/${domainId}/verify`, {
      method: "POST",
      cookie: owner,
    });
    expect(res.status).toBe(200);
    expect(cfCalls.length).toBe(before + 1);
  });

  it("is never active before Cloudflare says so: not by sweeps, not by serving requests", async () => {
    for (let i = 0; i < 3; i++) await sweep();
    // A request reaching us on the hostname (Cloudflare routes it before the cert is active).
    expect((await req(CUSTOM, "/api/v1/me", { cookie: owner })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const d = await current();
    expect(d.status).toBe("dns_ok");
    expect(d.activatedAt).toBeNull();
    expect(d.detail).toMatch(/Cloudflare is setting it up/u);

    // Hostname active but certificate still pending: still not active.
    const row = [...cfRows.values()][0] as CfRow;
    row.status = "active";
    await sweep();
    expect((await current()).status).toBe("dns_ok");
  });

  it("a 429 neither fails nor promotes; the next tick after it does promote", async () => {
    const row = [...cfRows.values()][0] as CfRow;
    row.ssl.status = "active";
    cfRateLimited = true;
    await sweep();
    let d = await current();
    expect(d.status).toBe("dns_ok");
    expect(d.detail).toMatch(/could not be asked just now/u);
    cfRateLimited = false;
    // retry-after: 1 s — the breaker refuses locally until then.
    await new Promise((r) => setTimeout(r, 1_100));
    await sweep();
    d = await current();
    expect(d.status).toBe("active");
    expect(d.providerState).toBe("active");
    expect(d.providerRecords).toEqual([]);
    expect(d.activatedAt).not.toBeNull();
  });

  it("removal deletes the Cloudflare custom hostname by id, retrying a failed DELETE (FR1)", async () => {
    // The first DELETE fails: the release job must be retried, not dropped.
    cfDeleteFailures = 1;
    const res = await request(`/api/v1/domains/${domainId}`, { method: "DELETE", cookie: owner });
    expect(res.status).toBeLessThan(300);
    const deletes = () => cfCalls.filter((c) => c.method === "DELETE");
    await until(() => deletes().length >= 1);
    expect(cfRows.size).toBe(1);
    expect(deletes()[0]?.path).toBe(`/client/v4/zones/${ZONE}/custom_hostnames/ch-1`);
    // Queued for a retry (a minute out): bring it forward rather than wait.
    await until(async () => {
      const { rows } = await pg.pool.query(
        "SELECT state FROM pgboss.job WHERE name = 'domains.provider-release' AND state = 'retry'",
      );
      return rows.length === 1;
    });
    await pg.pool.query(
      "UPDATE pgboss.job SET start_after = now() WHERE name = 'domains.provider-release' AND state = 'retry'",
    );
    await until(() => cfRows.size === 0);
    expect(deletes()).toHaveLength(2);
    expect(cfCalls.some((c) => c.method === "GET" && c.path.endsWith("/custom_hostnames"))).toBe(
      false,
    );
  });

  it("registration and release of one hostname never interleave: both take its lock (FR3)", async () => {
    const HOST2 = "ir.acme-ir.com";
    const add = await request("/api/v1/domains", {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ hostname: HOST2 }),
    });
    expect(add.status).toBe(201);
    const id = ((await add.json()) as Domain).id;
    const listing = (await listed()).domains as unknown as { id: string; records: Record_[] }[];
    const token = listing.find((d) => d.id === id)?.records.find((r) => r.type === "TXT")?.value;
    publish(HOST2, "CNAME", [EDGE]);
    publish(`${CHALLENGE_LABEL}.${HOST2}`, "TXT", [token ?? ""]);
    const posts = () => cfCalls.filter((c) => c.method === "POST").length;
    const deletes = () => cfCalls.filter((c) => c.method === "DELETE").length;

    // Somebody (a release in flight) holds the hostname's lock: the registration waits for it.
    const holder = await pg.pool.connect();
    const lock = `SELECT pg_advisory_lock(24303, hashtext('${HOST2}'))`;
    const unlock = `SELECT pg_advisory_unlock(24303, hashtext('${HOST2}'))`;
    try {
      await holder.query(lock);
      const before = posts();
      const ticking = sweep(HOST2);
      await new Promise((r) => setTimeout(r, 600));
      expect(posts()).toBe(before);
      await holder.query(unlock);
      await ticking;
      expect(posts()).toBe(before + 1);

      // And the release job waits for a registration in flight the same way.
      await holder.query(lock);
      const deletesBefore = deletes();
      const res = await request(`/api/v1/domains/${id}`, { method: "DELETE", cookie: owner });
      expect(res.status).toBeLessThan(300);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(deletes()).toBe(deletesBefore);
      await holder.query(unlock);
      await until(() => deletes() === deletesBefore + 1);
      expect([...cfRows.values()].some((r) => r.hostname === HOST2)).toBe(false);
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    }
  });

  it("caps domain adds and removals per workspace (10 an hour) with a cloudflare-saas driver (FR3)", async () => {
    // Four changes so far in this file (two adds, two removals): six more are allowed.
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request("/api/v1/domains", {
        method: "POST",
        cookie: owner,
        body: JSON.stringify({ hostname: `h${i}.acme-ir.com` }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 429]);
  });
});

/** Polls until `ok` (the release runs on the worker, a poll interval after the commit). */
async function until(ok: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function tokenOf(): Promise<string> {
  const res = await request("/api/v1/domains", { cookie: owner });
  const body = (await res.json()) as { domains: { id: string; records: Record_[] }[] };
  const d = body.domains.find((x) => x.id === domainId);
  return d?.records.find((r) => r.type === "TXT")?.value ?? "";
}
