import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { runReverifySweep } from "@fundroom/custom-domains";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { DnsAnswer, DnsRecordType, DnsResolverPort } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { workspaceUrl } from "./routes/deps.js";
import { type RunningServer, startServer } from "./server.js";
import type { Classification } from "./tenancy.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { webConfigFor } from "./web.js";

/*
 * Custom portal domains end to end (E2.1, EXECUTION_PLAN §9.2, design/07 §2.2–2.3, ADR-0039).
 *
 * The shape of the epic, in order: a hostname is refused before it is stored when accepting it
 * would be a tenant-resolution bypass → added, it is `pending` with records derived on every read
 * and nothing resolving to it → verification that says what DNS actually answered rather than
 * "failed" → `dns_ok`, and only then does Caddy's `ask` allow a certificate → `active`, at which
 * point the hostname *is* the workspace's origin and every URL the server mints uses it → a
 * request on that hostname resolving the right workspace, which is the whole point → the two
 * unique indexes answering two different questions without either leaking the other tenant →
 * a verified domain surviving a bad answer instead of being demoted, and a demotion not being a
 * death sentence → the permissions, where an investor gets the 404 an unknown URL gives rather
 * than the 403 that would confirm the route exists → removal releasing the claim.
 *
 * Two harness notes:
 *
 *  - A fake `DnsResolverPort` through the container's `dns` seam. The real resolver deliberately
 *    talks to 1.1.1.1, which a test must never do, and there is no zone here to publish to.
 *  - `investors.acme-ir.com`, not something under `.test` or `.example`: `checkHostname` refuses
 *    the RFC 6761 special-use zones outright, because a certificate can never be issued for one.
 */
/*
 * The canonical host is a `.com`, not the `.example.test` the other suites use, for one reason:
 * `checkHostname` refuses the RFC 6761 special-use zones outright, so with a `.test` canonical
 * host the "you cannot claim the host we already serve" refusals would be unreachable — every
 * such attempt would be turned away as `reserved` first, and the check that actually protects
 * tenant resolution would go untested.
 */
const BASE = "http://portal.fundroom-test.com";
const CANON = "portal.fundroom-test.com";
/** The hostname Acme wants its portal on. Three labels, so not a public suffix either. */
const CUSTOM = "investors.acme-ir.com";
const CHALLENGE = `_fundroom-challenge.${CUSTOM}`;
/** The pre-rename label (A-2): never shown, accepted forever as a fallback. */
const LEGACY_CHALLENGE = `_seedhost-challenge.${CUSTOM}`;

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

/*
 * The zone, keyed by name then type. A name that is absent answers NXDOMAIN; a name that exists
 * without the asked-for type answers NODATA (rcode `ok`, no values) — the distinction matters,
 * because `evaluate` turns each into a different sentence for the operator.
 */
const zone = new Map<string, Map<DnsRecordType, readonly string[]>>();
/** When set, every lookup answers this rcode: "we could not look", not "it is not there". */
let dnsFailure: DnsAnswer["rcode"] | undefined;

function publish(name: string, type: DnsRecordType, values: readonly string[]): void {
  const byType = zone.get(name.toLowerCase()) ?? new Map<DnsRecordType, readonly string[]>();
  byType.set(type, values);
  zone.set(name.toLowerCase(), byType);
}

function unpublish(name: string): void {
  zone.delete(name.toLowerCase());
}

const fakeDns: DnsResolverPort = {
  driver: "fake",
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
    if (dnsFailure !== undefined) {
      return Promise.resolve({
        name,
        type,
        values: [],
        rcode: dnsFailure,
        resolver: "fake",
        chain: undefined,
      });
    }
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

interface Actor {
  cookie: string;
  membershipId: string;
}

/** A request addressed to an arbitrary `Host`, which is the variable this epic is about. */
async function req(host: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  // CSRF derives `selfOrigin` from the Host header per request, so a same-host origin passes
  // on a custom domain exactly as it does on `<slug>.<canonical>` — nothing to configure.
  if (init.method && init.method !== "GET" && init.cookie) headers.set("origin", `http://${host}`);
  return running.app.request(`http://${host}${path}`, { ...init, headers });
}

const request = (slug: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  req(`${slug}.${CANON}`, path, init);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/**
 * Polls until `probe` returns something. For the one write in this epic that is deliberately not
 * awaited by the request that caused it: the `dns_ok → active` promotion (E2.1 S2), which must
 * never be able to fail or slow the response it rode in on.
 */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

interface DomainRecord {
  type: "CNAME" | "TXT" | "A";
  name: string;
  value: string;
  required: boolean;
}

interface Domain {
  id: string;
  hostname: string;
  status: "pending" | "dns_ok" | "active" | "failed";
  records: DomainRecord[];
  answer: Record<
    string,
    { name?: string; rcode: string; resolver: string; values: string[] } | null
  > | null;
  detail: string | null;
  consecutiveFailures: number;
  firstAttemptAt: string;
  deadlineAt: string;
  lastCheckedAt: string | null;
  dnsOkAt: string | null;
  activatedAt: string | null;
}

interface DomainList {
  domains: Domain[];
  driver: string;
  cnameTarget: string;
}

interface ErrorBody {
  error: { code: string; message: string; reason?: string; hostname?: string };
}

let acmeId: string;
let betaId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor;
let betaOwner: Actor;
/** The row Acme adds in the first test and the rest of the file follows. */
let domainId = "";
let token = "";
/** When the row was first attempted; a demotion has to reset it, so this is the "before". */
let firstAttemptAt = 0;
/** Beta's own pending row for the same hostname. */
let betaDomainId = "";

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    dns: fakeDns,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  betaOwner = await member("beta", betaId, "owner@beta.example.com", "staff", "owner");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("registry", () => {
  it("registers the two permissions and the admin nav slot, and cannot be switched off", async () => {
    const registry = running.container.registry;
    for (const p of ["domains.read", "domains.manage"]) {
      expect(registry.permissions.get(p)).toBe("domains");
    }
    const boot = await json<{
      modules: { id: string; enabled: boolean; slots: Record<string, unknown[]> }[];
    }>(await request("acme", "/api/v1/modules", { cookie: owner.cookie }));
    const mod = boot.modules.find((m) => m.id === "domains");
    expect(mod?.enabled).toBe(true);
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
    // `required`: a feature must not be able to switch off its own routing. The classifier does
    // not consult enablement (it runs before it), so a disabled `domains` would keep serving the
    // hostname while the screen that could remove it had vanished.
    const enablement = await json<{ modules: { id: string; locked: boolean }[] }>(
      await request("acme", "/api/v1/modules/enablement", { cookie: owner.cookie }),
    );
    expect(enablement.modules.find((m) => m.id === "domains")?.locked).toBe(true);
  });
});

describe("adding a domain", () => {
  it("starts empty, naming the configured driver and CNAME target", async () => {
    const res = await request("acme", "/api/v1/domains", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const list = await json<DomainList>(res);
    expect(list.domains).toEqual([]);
    expect(list.driver).toBe("caddy-ask");
    // Unset `CUSTOM_DOMAIN_CNAME_TARGET` means the canonical host: a self-hoster's edge is
    // their own host.
    expect(list.cnameTarget).toBe(CANON);
  });

  it("refuses the hostnames that would be a tenant-resolution bypass, naming the reason", async () => {
    const cases: [string, string][] = [
      // Both of these already route through the slug classifier, so a row for one would give a
      // second, contradictory answer for a hostname that already belongs to someone.
      [CANON, "canonical_host"],
      [`weird.${CANON}`, "canonical_subdomain"],
      ["203.0.113.7", "ip_literal"],
      ["*.acme-ir.com", "wildcard"],
      ["co.uk", "public_suffix"],
      ["portal.localhost", "reserved"],
    ];
    for (const [hostname, reason] of cases) {
      const res = await request("acme", "/api/v1/domains", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ hostname }),
      });
      expect(res.status, hostname).toBe(400);
      const body = await json<ErrorBody>(res);
      expect(body.error.code, hostname).toBe("invalid_request");
      // The rejection, not the error class: the screen has a sentence for each reason.
      expect(body.error.reason, hostname).toBe(reason);
    }
    expect(
      (await json<DomainList>(await request("acme", "/api/v1/domains", { cookie: owner.cookie })))
        .domains,
    ).toEqual([]);
  });

  it("adds the hostname as pending, with both records derived and nothing resolving yet", async () => {
    const res = await request("acme", "/api/v1/domains", {
      method: "POST",
      cookie: owner.cookie,
      // Mixed case and a trailing dot: one canonical spelling is stored, or whoever controls
      // the difference picks which workspace a request resolves to.
      body: JSON.stringify({ hostname: `INVESTORS.Acme-IR.com.` }),
    });
    expect(res.status).toBe(201);
    const domain = await json<Domain>(res);
    expect(domain.hostname).toBe(CUSTOM);
    expect(domain.status).toBe("pending");
    expect(domain.lastCheckedAt).toBeNull();
    expect(domain.dnsOkAt).toBeNull();
    expect(domain.activatedAt).toBeNull();
    // The 72 h deadline is derived from `firstAttemptAt`, never stored.
    expect(Date.parse(domain.deadlineAt) - Date.parse(domain.firstAttemptAt)).toBe(
      72 * 3600 * 1000,
    );
    domainId = domain.id;
    firstAttemptAt = Date.parse(domain.firstAttemptAt);

    const cname = domain.records.find((r) => r.type === "CNAME");
    const txt = domain.records.find((r) => r.type === "TXT");
    expect(cname).toMatchObject({ name: CUSTOM, value: CANON, required: true });
    expect(txt).toMatchObject({ name: CHALLENGE, required: true });
    // A-2: the instructions name the current label only; the old one is a silent fallback.
    expect(JSON.stringify(domain.records)).not.toContain("_seedhost-challenge");
    token = txt?.value ?? "";
    expect(token.length).toBeGreaterThanOrEqual(16);
    // Only the token is stored; the instructions are re-derived on every read (decision 4).
    const stored = await rows<{ hostname: string; status: string; token: string }>(
      `SELECT hostname, status, token FROM core.custom_domain WHERE workspace_id = '${acmeId}'::uuid`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ hostname: CUSTOM, status: "pending", token });

    const audit = await rows<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.created' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("custom_domain.created");
  });

  it("re-adding the same hostname is a 409 that says it is already on the list", async () => {
    const res = await request("acme", "/api/v1/domains", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ hostname: CUSTOM }),
    });
    expect(res.status).toBe(409);
    const body = await json<ErrorBody>(res);
    expect(body.error.reason).toBe("duplicate");
  });

  it("the challenge token is stable across reads, so the screen can be reloaded", async () => {
    const list = await json<DomainList>(
      await request("acme", "/api/v1/domains", { cookie: owner.cookie }),
    );
    expect(list.domains[0]?.records.find((r) => r.type === "TXT")?.value).toBe(token);
  });
});

describe("verification", () => {
  it("with DNS absent the row stays pending and says what the resolver actually answered", async () => {
    const res = await request("acme", `/api/v1/domains/${domainId}/verify`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const domain = await json<Domain>(res);
    // Not an error: a missing record is a verdict. "Verification failed" tells a founder
    // nothing; naming the NXDOMAIN and the record we wanted tells them what to type.
    expect(domain.status).toBe("pending");
    expect(domain.consecutiveFailures).toBe(1);
    expect(domain.lastCheckedAt).not.toBeNull();
    expect(domain.detail).toContain(CUSTOM);
    expect(domain.detail).toContain("NXDOMAIN");
    expect(domain.detail).toContain(CANON);
    expect(domain.answer?.["cname"]?.rcode).toBe("nxdomain");
    expect(domain.answer?.["txt"]?.rcode).toBe("nxdomain");
  });

  it("the CNAME alone is not enough: the TXT is what proves control of the zone", async () => {
    publish(CUSTOM, "CNAME", [CANON]);
    const domain = await json<Domain>(
      await request("acme", `/api/v1/domains/${domainId}/verify`, {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(domain.status).toBe("pending");
    expect(domain.detail).toContain(`${CUSTOM} points at ${CANON}`);
    expect(domain.detail).toContain(`${CHALLENGE} does not exist`);
  });

  it("Caddy is refused a certificate for the hostname while it is unverified", async () => {
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(404);
    // And the canonical host is always answered, without a cache or a database behind it.
    expect((await req(CANON, `/internal/tls/ask?domain=${CANON}`)).status).toBe(200);
  });

  it("with both records published the row reaches dns_ok", async () => {
    publish(CHALLENGE, "TXT", [`"${token}"`]);
    const domain = await json<Domain>(
      await request("acme", `/api/v1/domains/${domainId}/verify`, {
        method: "POST",
        cookie: owner.cookie,
      }),
    );
    expect(domain.status).toBe("dns_ok");
    expect(domain.consecutiveFailures).toBe(0);
    expect(domain.dnsOkAt).not.toBeNull();
    expect(domain.activatedAt).toBeNull();
    expect(domain.detail).toContain("_fundroom-challenge TXT matches");
    const audit = await rows<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.verified' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("custom_domain.verified");
  });

  it("Caddy may now issue a certificate — dns_ok is enough, because active cannot come first", async () => {
    // E2.1 decision 3: gating `ask` on `active` deadlocks. The certificate cannot exist before
    // the first handshake, and the first handshake is what makes the domain active.
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(200);
    expect((await req(CANON, "/internal/tls/ask?domain=nobody.acme-ir.com")).status).toBe(404);
  });

  it("no number of successful checks reaches `active`: DNS is not evidence of a certificate", async () => {
    /*
     * E2.1 S2. `runVerifySweep` used to include `dns_ok` rows and `nextState("dns_ok", ok=true)`
     * returned `active`, so the *second* good DNS poll promoted the row — and `active` is what
     * `primaryHost` keys off, so `workspaceUrl`, `canonicalOrigin` and `brandingLogoUrl` began
     * minting links at a hostname that may never have completed a handshake. A zone with a CAA
     * record excluding our CA, or an ACME account that is rate-limited, answers a TLS error, and
     * every update email would have shipped dead links with no demotion path.
     */
    for (let i = 0; i < 3; i++) {
      const domain = await json<Domain>(
        await request("acme", `/api/v1/domains/${domainId}/verify`, {
          method: "POST",
          cookie: owner.cookie,
        }),
      );
      expect(domain.status).toBe("dns_ok");
      expect(domain.activatedAt).toBeNull();
    }
  });

  it("a request actually served on the hostname is what promotes it to `active`", async () => {
    // The one place the fact is observable: the classifier resolved a live request through the
    // hostname, so the handshake completed and a certificate is in hand. Deliberately not `ask`,
    // which asks *before* the certificate exists — that is why it answers on `dns_ok`.
    const served = await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie });
    expect(served.status).toBe(200);

    // The write is fire-and-forget off the response path, so poll rather than assume.
    const active = await waitFor(async () => {
      const list = await json<DomainList>(
        await request("acme", "/api/v1/domains", { cookie: owner.cookie }),
      );
      const row = list.domains.find((d) => d.id === domainId);
      return row?.status === "active" ? row : undefined;
    });
    expect(active.activatedAt).not.toBeNull();
    // No DNS was resolved on that path, so the verifier's sentence is still the one on screen.
    expect(active.detail).toContain("_fundroom-challenge TXT matches");
    const audit = await rows<{ action: string; meta: Record<string, unknown> }>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.activated' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.meta).toMatchObject({ served: true, from: "dns_ok", to: "active" });
  });

  it("promotes at most once per cache TTL, so it is not a write per request", async () => {
    const before = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.activated'`,
    );
    for (let i = 0; i < 5; i++) await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie });
    const after = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.activated'`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe("the hostname routes to the workspace", () => {
  it("a request on the verified hostname resolves Acme, and an unknown hostname still 404s", async () => {
    const me = await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie });
    expect(me.status).toBe(200);
    expect((await json<{ membership: { id: string } | null }>(me)).membership?.id).toBe(
      owner.membershipId,
    );
    // The workspace-scoped route answers with Acme's own row, addressed by hostname alone.
    const list = await json<DomainList>(
      await req(CUSTOM, "/api/v1/domains", { cookie: owner.cookie }),
    );
    expect(list.domains.map((d) => d.hostname)).toEqual([CUSTOM]);

    // A hostname nobody has claimed is the same 404 it always was — and the same answer
    // whether it was never added or was added and never verified.
    expect(
      (await req("someone-else.acme-ir.com", "/api/v1/me", { cookie: owner.cookie })).status,
    ).toBe(404);
    expect((await req("someone-else.acme-ir.com", "/")).status).toBe(404);
  });

  it("a passkey ceremony on a custom domain is refused explicitly, not half-attempted", async () => {
    // ADR-0039 decision 12: `passkeys.rpId` and `passkeys.origins` are single values derived
    // from BASE_URL, so a ceremony here would present options the browser rejects — or worse,
    // register a credential that works nowhere. Per-domain passkeys need the central auth
    // origin, which E2.1 does not own, so the refusal is explicit and says what to do instead.
    const begin = await req(CUSTOM, "/api/v1/auth/passkeys/login/begin", { method: "POST" });
    expect(begin.status).toBe(400);
    const body = await json<ErrorBody>(begin);
    expect(body.error.code).toBe("unsupported");
    expect(body.error.reason).toBe("custom_domain");
    // Email codes still work on the custom domain: only passkeys are origin-bound.
    const otp = await req(CUSTOM, "/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com" }),
      headers: { "content-type": "application/json" },
    });
    expect(otp.status).toBe(200);
    // …and the canonical origin is unaffected.
    expect(
      (await request("acme", "/api/v1/auth/passkeys/login/begin", { method: "POST" })).status,
    ).toBe(200);
  });

  it("an active domain becomes the workspace's primary origin", async () => {
    const ws = await running.container.resolver.resolve("acme");
    if (ws === undefined) throw new Error("no workspace");
    expect(ws.primaryHost).toBe(CUSTOM);

    // Every public URL the server mints prefers it (decision 5): the emailed link, the logo
    // `<img src>`, and the page's own "open in a new tab".
    expect(workspaceUrl(new URL(BASE), "multi", ws, "/updates/1").href).toBe(
      `http://${CUSTOM}/updates/1`,
    );
    const classification: Classification = {
      tree: "app",
      host: "custom",
      slug: "acme",
      path: "/",
      embed: false,
    };
    const config = webConfigFor({
      classification,
      workspace: ws,
      tenancy: "multi",
      basePath: "",
      baseUrl: new URL(BASE),
      canonicalHost: CANON,
      instanceName: "FundRoom",
      auth: { methods: ["email_otp"], passkeyRpId: CANON },
      embedOrigins: [],
    });
    expect(config.canonicalOrigin).toBe(`http://${CUSTOM}`);
    // The slug came from the hostname lookup, not from a `/w/<slug>` prefix, so the SPA must
    // not put one in its router base.
    expect(config.routerBase).toBe("");
    expect(config.apiBase).toBe("");
  });
});

describe("two workspaces, one hostname", () => {
  it("a second workspace may hold a pending row — a squatter must not be able to block a rival", async () => {
    // `custom_domain_claim_idx` covers `dns_ok|active` only, deliberately: if a global unique
    // index covered pending rows, parking one on a rival's hostname would lock them out forever.
    const res = await req(`beta.${CANON}`, "/api/v1/domains", {
      method: "POST",
      cookie: betaOwner.cookie,
      body: JSON.stringify({ hostname: CUSTOM }),
    });
    expect(res.status).toBe(201);
    const betaDomain = await json<Domain>(res);
    expect(betaDomain.status).toBe("pending");
    betaDomainId = betaDomain.id;
    // The challenge token is per workspace (`HMAC(key, workspaceId:hostname)`), so Beta's row
    // carries a different one. That is the deeper protection and worth naming: Beta cannot
    // verify at all unless it can publish *its* token, which means controlling the zone. What
    // the claim index defends is the case where it CAN — a real domain move — so the zone below
    // publishes both, the shape a DNS owner actually produces when moving a portal.
    const betaToken = betaDomain.records.find((r) => r.type === "TXT")?.value ?? "";
    expect(betaToken).not.toBe(token);
    publish(CHALLENGE, "TXT", [`"${token}"`, `"${betaToken}"`]);
  });

  it("but it cannot verify it, and the answer never names the workspace that holds it", async () => {
    // DNS proves out — Beta's own challenge is published — but the claim is Acme's, and the
    // unique index refuses the promotion rather than letting the hostname point two ways.
    const res = await req(`beta.${CANON}`, `/api/v1/domains/${betaDomainId}/verify`, {
      method: "POST",
      cookie: betaOwner.cookie,
    });
    expect(res.status).toBe(200);
    const domain = await json<Domain>(res);
    expect(domain.status).toBe("pending");
    expect(domain.detail).toContain("already verified for another workspace");
    // The tenancy leak this is guarding: which workspace holds a hostname is not Beta's
    // business, and Beta must not be told to go and delete something of somebody else's.
    // (The hostname itself contains "acme", so what must be absent is the *workspace*: its
    // name and its id. Neither appears, and neither may.)
    expect(domain.detail).not.toContain("Acme");
    expect(domain.detail).not.toContain(acmeId);
    // Acme keeps serving throughout.
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(200);
  });

  it("a workspace's own second verified hostname is a 409 naming the one it already has", async () => {
    const res = await request("acme", "/api/v1/domains", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ hostname: "ir.acme-ir.com" }),
    });
    expect(res.status).toBe(409);
    const body = await json<ErrorBody>(res);
    expect(body.error.reason).toBe("workspace_already_verified");
    // Their own row, so naming it is not a leak — it is the only actionable answer. Two
    // verified hostnames would be two `__Host-` cookie jars rather than aliases.
    expect(body.error.hostname).toBe(CUSTOM);
    expect(body.error.message).toContain(CUSTOM);
  });
});

describe("re-verification and demotion", () => {
  /** What the weekly sweep does to one row. `verifyNow` is the same pass behind a button. */
  const recheck = () =>
    running.container.customDomains.check(systemContext(acmeId), domainId, undefined);

  it("an active domain survives a bad answer instead of being taken offline", async () => {
    // One SERVFAIL is a resolver having a bad day, not a portal that should stop working.
    dnsFailure = "servfail";
    const first = await recheck();
    expect(first?.status).toBe("active");
    expect(first?.consecutiveFailures).toBe(1);
    const second = await recheck();
    expect(second?.status).toBe("active");
    expect(second?.consecutiveFailures).toBe(2);
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(200);
  });

  it("after the grace it is demoted to pending — and is NOT immediately failed", async () => {
    const before = await recheck();
    expect(before?.status).toBe("pending");
    expect(before?.consecutiveFailures).toBe(0);
    // The trap this closes: `pending → failed` is measured from `first_attempt_at`, and this
    // row's original one is seconds old here but would be *months* old in production. A demotion
    // that kept it would flip the row from "serving" to "dead" on the very next 5-minute tick.
    expect(before?.firstAttemptAt.getTime()).toBeGreaterThan(firstAttemptAt);
    expect(Date.now() - (before?.firstAttemptAt.getTime() ?? 0)).toBeLessThan(60_000);
    const next = await recheck();
    expect(next?.status).toBe("pending");
    expect(next?.consecutiveFailures).toBe(1);
    // Demoted means "not verified", so the certificate answer changes with it — the service
    // invalidated the lookup cache on the state change rather than waiting out the 60 s TTL.
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(404);
    expect((await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie })).status).toBe(404);
    const audit = await rows<{ action: string; meta: { demoted?: boolean } }>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'custom_domain.failed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.meta.demoted).toBe(true);
  });

  it("and it recovers the moment DNS agrees again", async () => {
    dnsFailure = undefined;
    const back = await recheck();
    expect(back?.status).toBe("dns_ok");
    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(200);
    expect((await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie })).status).toBe(200);
  });
});

/*
 * A-2: `_seedhost-challenge` → `_fundroom-challenge` with a PERMANENT fallback. `domains.reverify`
 * re-checks every verified row weekly and demotes after three misses, so if the verifier stopped
 * reading the old label, every portal set up before the rename would go offline ~three weeks
 * after the upgrade. The rule: either label carrying the row's token proves control, the old one
 * is looked up only when the new one did not carry it, and the sentence names the one that did.
 */
describe("the pre-rename challenge label", () => {
  const recheck = () =>
    running.container.customDomains.check(systemContext(acmeId), domainId, undefined);
  const reverify = () =>
    runReverifySweep(
      { db: running.container.db, service: running.container.customDomains },
      { workspaceId: acmeId },
    );
  const acmeRow = async (): Promise<Domain | undefined> =>
    (
      await json<DomainList>(await request("acme", "/api/v1/domains", { cookie: owner.cookie }))
    ).domains.find((d) => d.id === domainId);
  /** What the current label held before this block moved the record; put back at the end. */
  let current: readonly string[] = [];

  it("a portal on the old label only is served and survives every weekly re-check", async () => {
    current = zone.get(CHALLENGE.toLowerCase())?.get("TXT") ?? [];
    unpublish(CHALLENGE);
    publish(LEGACY_CHALLENGE, "TXT", [`"${token}"`]);

    // Serving is what promotes; the row may already be active from the recovery above.
    const active = await waitFor(async () => {
      await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie });
      const row = await acmeRow();
      return row?.status === "active" ? row : undefined;
    });
    expect(active.status).toBe("active");

    // Past REVERIFY_GRACE (3): without the fallback the third sweep demotes the portal.
    for (let week = 1; week <= 4; week++) {
      const swept = await reverify();
      expect(swept.checked, `week ${week}`).toBeGreaterThanOrEqual(1);
      const row = await acmeRow();
      expect(row?.status, `week ${week}`).toBe("active");
      expect(row?.consecutiveFailures, `week ${week}`).toBe(0);
    }
    const row = await acmeRow();
    // The sentence and the stored answer name the record actually doing the work…
    expect(row?.detail).toContain("_seedhost-challenge TXT matches");
    expect(row?.answer?.["txt"]?.name).toBe(LEGACY_CHALLENGE);
    // …while the instructions keep showing only the new label.
    expect(row?.records.find((r) => r.type === "TXT")?.name).toBe(CHALLENGE);
    expect(JSON.stringify(row?.records)).not.toContain("_seedhost-challenge");
    expect((await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie })).status).toBe(200);
  });

  it("a wrong token under the new label does not block the right one under the old", async () => {
    publish(CHALLENGE, "TXT", ['"not-this-workspaces-token"']);
    const row = await recheck();
    expect(row?.status).toBe("active");
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.detail).toContain("_seedhost-challenge TXT matches");
  });

  it("a wrong token under both is a failed check, described against the new label", async () => {
    publish(LEGACY_CHALLENGE, "TXT", ['"also-not-it"']);
    const row = await recheck();
    // One miss is inside the re-verify grace: still serving, one failure counted.
    expect(row?.status).toBe("active");
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.detail).toContain(`${CHALLENGE} returned a different token`);
    expect(row?.detail).not.toContain("_seedhost-challenge");
  });

  it("publishing the new label again puts the row back on it", async () => {
    unpublish(LEGACY_CHALLENGE);
    publish(CHALLENGE, "TXT", current);
    const row = await recheck();
    expect(row?.status).toBe("active");
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.detail).toContain("_fundroom-challenge TXT matches");
  });
});

describe("permissions", () => {
  it("an investor gets 404 on every route: the answer must not confirm the screen exists", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/domains"],
      ["POST", "/api/v1/domains"],
      ["POST", `/api/v1/domains/${domainId}/verify`],
      ["DELETE", `/api/v1/domains/${domainId}`],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: ada.cookie,
        ...(method === "POST" && path === "/api/v1/domains"
          ? { body: JSON.stringify({ hostname: "x.acme-ir.com" }) }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await json<ErrorBody>(res)).error.code, `${method} ${path}`).not.toBe("forbidden");
    }
  });

  it("a staff editor gets 403: the route exists for them, their role does not reach it", async () => {
    const res = await request("acme", "/api/v1/domains", { cookie: editor.cookie });
    expect(res.status).toBe(403);
    expect((await json<ErrorBody>(res)).error.code).toBe("forbidden");
  });

  it("the mutations need fresh auth, so a stale session cannot repoint a portal", async () => {
    // The generated matrix is the authority CI checks; assert the tag here so the two cannot
    // drift silently in this file's own story.
    const doc = await json<{
      paths: Record<string, Record<string, { "x-requires"?: string }>>;
    }>(await request("acme", "/api/v1/openapi.json"));
    expect(doc.paths["/domains"]?.["get"]?.["x-requires"]).toBe("domains.read");
    for (const [path, method] of [
      ["/domains", "post"],
      ["/domains/{id}/verify", "post"],
      ["/domains/{id}", "delete"],
    ] as const) {
      expect(doc.paths[path]?.[method]?.["x-requires"], `${method} ${path}`).toBe(
        "domains.manage+fresh",
      );
    }
  });
});

describe("removal", () => {
  it("releases the claim, stops serving, and is idempotent about a row that is gone", async () => {
    const res = await request("acme", `/api/v1/domains/${domainId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(await json<{ ok: boolean }>(res)).toEqual({ ok: true });

    expect((await req(CANON, `/internal/tls/ask?domain=${CUSTOM}`)).status).toBe(404);
    expect((await req(CUSTOM, "/api/v1/me", { cookie: owner.cookie })).status).toBe(404);
    const ws = await running.container.resolver.resolve("acme");
    expect(ws?.primaryHost).toBeNull();

    // A soft delete: both unique indexes are `WHERE deleted_at IS NULL`, so the hostname is
    // free again while the history of it stays.
    const stored = await rows<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM core.custom_domain WHERE id = '${domainId}'::uuid`,
    );
    expect(stored[0]?.deleted_at).not.toBeNull();

    expect(
      (
        await request("acme", `/api/v1/domains/${domainId}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("and Beta can now verify the hostname it was holding pending", async () => {
    const domain = await json<Domain>(
      await req(`beta.${CANON}`, `/api/v1/domains/${betaDomainId}/verify`, {
        method: "POST",
        cookie: betaOwner.cookie,
      }),
    );
    expect(domain.status).toBe("dns_ok");
    // The hostname now answers for Beta, which is what "released" has to mean.
    const me = await req(CUSTOM, "/api/v1/me", { cookie: betaOwner.cookie });
    expect(me.status).toBe(200);
    expect((await json<{ membership: { id: string } | null }>(me)).membership?.id).toBe(
      betaOwner.membershipId,
    );
    unpublish(CUSTOM);
    unpublish(CHALLENGE);
  });
});
