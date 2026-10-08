import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitMail, awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Share links and the NDA engine end to end (E2.3, EXECUTION_PLAN §9.3, design/04 §4 and
 * design/05 §5, ADR-0041 — and the E2.3 frozen contract's §10 notes A5, A6, A7, B4, B7, B11,
 * C2, D5, D-1, E2, E3).
 *
 * The shape of the epic, in the order this file walks it:
 *
 *   the kernel tables and their RLS, and the offering-mode switch that turns the whole feature
 *   off for staff and strangers alike → minting, where Rule 506(b) refuses a link that names no
 *   audience and the plaintext token exists exactly once → the whole flow, in which a stranger
 *   resolves a token, satisfies a passcode, is checked against the link's own allowlist, spends
 *   an emailed code and comes out the other side as a real `external` membership whose `source`
 *   is `link:<id>`, holding exactly the resource the link granted and nothing else → the
 *   `max_uses` race against real Postgres, which is the one proof the conditional `UPDATE` holds
 *   under concurrency (B11) → the authorization edge, asserted where it actually lives: a
 *   revoked, paused or expired link stops materialising rows in `core.effective_access` (A7) →
 *   anti-enumeration, where unknown, revoked, paused, expired and exhausted are one wire answer →
 *   the passcode counter, which must survive the refusal that increments it or the lockout never
 *   arrives (B7) → a link-targeted NDA gate, the `policy_target_kind = 'link'` arm end to end →
 *   the click-wrap certificate, tested as evidence: the attestation, both audit rows, their
 *   hash-chain linkage, the digest the chain claims against the bytes actually stored, and the
 *   PDF → re-acceptance on version change → accreditation's two attestation rows → the register
 *   export → RLS from the visitor's own seat → cross-tenant replay, which must 404 and never 403.
 *
 * Harness notes:
 *
 *  - Three workspaces with three offering statuses, because offering mode is a *precondition* of
 *    this epic rather than a feature of it: `acme` is `506c` (links permitted, any shape),
 *    `globex` is `506b` (links permitted, audience must be named), and `initech` stays `none`
 *    (links refused outright). A single-workspace file could test none of the three.
 *  - `ROLES: "api,web,worker"` with short poll intervals, so the outbox relay and the job runner
 *    actually tick: the `acl.changed` rebuild and the view-counting subscription both ride them.
 *  - The PDF is read back with `node:zlib` rather than pdf-lib, which is not a dependency of this
 *    app: pdf-lib Flate-compresses its content streams, and the drawn strings come back out of
 *    them as `(…) Tj` operators. `packages/clickwrap/src/pdf.test.ts` does the same job with the
 *    library; this is the same assertion made from outside the package that produced the bytes.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  // Every mutation carries an `Origin`, not only the ones with a cookie: CSRF derives
  // `selfOrigin` from the Host header per request, and a same-host origin is always correct.
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

function codeFrom(text: string): string {
  const m = /^\s{4}(\d{6})$/mu.exec(text);
  if (!m?.[1]) throw new Error(`no code in mail:\n${text}`);
  return m[1];
}

/**
 * The most recent code sent to one address, optionally only counting mail sent after `since`.
 *
 * The marker matters: `start` answers `{ status: "sent" }` whether or not a mail was sent (that
 * is the anti-enumeration contract), so a helper that fell back to an older mail would quietly
 * spend a stale — and possibly link-bound — code and report the result as a wrong code.
 *
 * The code mail is sent detached, so first wait (bounded) for one to arrive after `since`.
 */
async function codeFor(email: string, since = 0): Promise<string> {
  await awaitSignInCode(mailer, email, since);
  const mail = [...mailer.sent.slice(since)].reverse().find((m) => m.to === email);
  if (!mail) throw new Error(`no mail sent to ${email} after index ${since}`);
  return codeFrom(mail.text);
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code: await codeFor(email, since) }),
  });
  expect(verify.status, await verify.clone().text()).toBe(200);
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
  role: "owner" | "admin" | "editor" | "viewer" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/** Polls until `probe` returns something, for anything the outbox or the job runner does. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Rows read as the `system` actor of a workspace. */
async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Rows read as a specific *external* membership: exactly what RLS lets that visitor see. */
async function rowsAsExternal<T>(
  workspaceId: string,
  membershipId: string,
  query: string,
): Promise<T[]> {
  const ctx = { workspaceId, actorKind: "external" as const, membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The strings a PDF actually draws, without pdf-lib.
 *
 * pdf-lib writes its content streams Flate-compressed even with `useObjectStreams: false`, so the
 * text is not in the raw bytes; inflate each stream and pull the operands of every `Tj`. A stream
 * that does not inflate is passed through, so an uncompressed build of the same page still reads.
 */
function pdfText(raw: Uint8Array): string {
  const buf = Buffer.from(raw);
  const latin = buf.toString("latin1");
  const out: string[] = [];
  for (const m of latin.matchAll(/stream\r?\n/gu)) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    const body = buf.subarray(start, end);
    let text: string;
    try {
      text = inflateSync(body).toString("latin1");
    } catch {
      text = body.toString("latin1");
    }
    for (const t of text.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/gu)) {
      out.push((t[1] ?? "").replace(/\\(.)/gu, "$1"));
    }
    for (const t of text.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/gu)) {
      out.push(Buffer.from(t[1] ?? "", "hex").toString("latin1"));
    }
  }
  return out.join("\n");
}

/*
 * Response shapes, declared here rather than imported from `@fundroom/contracts` on purpose: a
 * contract change that this file does not know about should show up as a failing assertion, not
 * as a type that silently follows along.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    reason?: string;
    offeringStatus?: string;
    permission?: string;
  };
}
interface LinkBody {
  id: string;
  label: string;
  status: "active" | "paused" | "revoked";
  policy: { domains: string[]; emails: string[]; forceWatermark: boolean };
  grants: { resource: { kind: string; id: string; path?: string }; capabilities: string[] }[];
  groupIds: string[];
  passcodeRequired: boolean;
  maxUses: number | null;
  uses: number;
  maxViews: number | null;
  views: number;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  visits: number;
}
interface MintedBody {
  link: LinkBody;
  token: string;
  url: string;
}
interface ResolutionBody {
  valid: true;
  requiresPasscode: boolean;
  workspaceName?: string;
  emailHint?: string;
}
interface StartBody {
  status: "sent";
  emailHint: string;
  ttlMinutes: number;
}
interface LoginBody {
  membership: { id: string; kind: string; role: string; status: string } | null;
  session: { authLevel: number };
}
interface MyAccess {
  permissions: string[];
  resources: {
    kind: string;
    id: string;
    path: string | null;
    capabilities: string[];
    pendingGates: { kind: string; source: string; detail: Record<string, unknown> }[];
  }[];
}
interface TreeBody {
  rootId: string;
  folders: { id: string; name: string; path: string }[];
  documents: { id: string; title: string }[];
}
interface DocumentDetail {
  document: { id: string; slug: string; kind: string; currentVersionNo: number | null };
  current: { versionNo: number; bodySha256: string; body: string } | null;
}
interface Bootstrap {
  modules: { id: string; enabled: boolean; hidden: boolean; slots: Record<string, unknown[]> }[];
  pendingAcceptances: { documentId: string; slug: string; versionNo: number; stamp: string }[];
}
interface CertificateJson {
  version: number;
  certificateId: string;
  workspace: { id: string; name: string; host: string };
  signer: {
    membershipId: string;
    emailSha256: string;
    displayName: string | null;
    typedName: string | null;
  };
  document: {
    documentId: string;
    slug: string;
    title: string;
    versionNo: number;
    stamp: string;
    bodySha256: string;
  };
  acceptance: {
    acceptedAt: string;
    method: string;
    uaFamily: string | null;
    ipHash: string | null;
    viaLinkId: string | null;
  };
  anchor: { auditSeq: number; auditHash: string };
}
interface AuditRow {
  seq: number;
  action: string;
  hash: string;
  prev_hash: string | null;
  meta: Record<string, unknown>;
}
interface LinkRow {
  id: string;
  status: string;
  uses: number;
  views: number;
  passcode_attempts: number;
  passcode_locked_until: string | null;
  token_hash: string;
}

const PASSCODE = "open-sesame-42";
const NDA_BODY_V1 = "# Mutual NDA\n\nYou will keep what you see here to yourself. Version one.";
const NDA_BODY_V2 = "# Mutual NDA\n\nYou will keep what you see here to yourself. Version two.";

let acmeId: string;
let globexId: string;
let initechId: string;
let owner: Actor;
let counsel: Actor;
let editor: Actor;
let bystander: Actor;
let globexOwner: Actor;
let initechOwner: Actor;

/** The data room the links point at. */
let financialsId = "";
let financialsPath = "";
let overviewId = "";
let overviewPath = "";

/** The main link and the visitor it admits; most of the file follows these two. */
let linkA: MintedBody;
let ada: Actor;
/** The race link, which ends the race exhausted and is reused as the "spent" sample. */
let linkB: MintedBody;
/** Who Postgres let through the two-seat race, and who it turned away. */
let raceWinners: string[] = [];
let raceLosers: string[] = [];
/** The passcode-counter link, the paused sample and the expired sample. */
let linkC: MintedBody;
let pausedLink: MintedBody;
let expiredLink: MintedBody;
/** The link whose own NDA gate is the `policy_target_kind = 'link'` arm. */
let linkE: MintedBody;
let nick: Actor;
/** The tenant NDA, and the id of the acceptance policy attached to `linkE`. */
let ndaId = "";
let linkGateId = "";

/** A syntactically valid token that was never minted. */
const UNKNOWN_TOKEN = "Zq7wE2r9TyU4iO1pA6sD3fG8hJ0kL5zX9cV2bN7mQ4w";

async function mint(
  slug: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<{ res: Response; minted?: MintedBody }> {
  const res = await request(slug, "/api/v1/links", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify(body),
  });
  return res.status === 200 ? { res, minted: await json<MintedBody>(res) } : { res };
}

/** The public start call, which is the only place a passcode is ever sent. */
function startLink(slug: string, token: string, body: Record<string, unknown>) {
  return request(slug, `/api/v1/links/${token}/start`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function verifyLink(slug: string, token: string, body: Record<string, unknown>) {
  return request(slug, `/api/v1/links/${token}/verify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Admission through a link, start to finish, as a visitor with no account performs it. */
async function admit(
  slug: string,
  token: string,
  email: string,
  passcode?: string,
): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await startLink(slug, token, {
    email,
    ...(passcode === undefined ? {} : { passcode }),
  });
  expect(start.status, `start ${email}`).toBe(200);
  const verified = await verifyLink(slug, token, { email, code: await codeFor(email, since) });
  expect(verified.status, `verify ${email}`).toBe(200);
  const body = await json<LoginBody>(verified);
  return { cookie: cookiesOf(verified), membershipId: body.membership?.id ?? "" };
}

/** The materialised rows `core.has_access()` reads — the only place A7 can be asserted. */
async function effectiveAccess(
  membershipId: string,
): Promise<{ resource_kind: string; resource_id: string; capabilities: string[] }[]> {
  await running.container.authz.rebuild(acmeId);
  return rows(
    `SELECT resource_kind, resource_id, capabilities::text[] AS capabilities
     FROM core.effective_access
     WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${membershipId}'::uuid
     ORDER BY resource_kind, resource_id`,
  );
}

/** The error envelope minus the one field that is different on every response. */
function errorShape(body: Partial<ErrorBody>): Record<string, unknown> {
  // Tolerates a body with no `error` at all: a sample that answers 200 must be reported as the
  // odd one out, not as a TypeError inside the helper.
  const { requestId: _ignored, ...rest } = body.error ?? { code: "<not an error>", message: "" };
  return rest;
}

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
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  initechId = (await createWorkspace(running.container.db, { slug: "initech", name: "Initech" }))
    .id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  bystander = await member("acme", acmeId, "bystander@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@globex.test", "staff", "owner");
  initechOwner = await member("initech", initechId, "boss@initech.test", "staff", "owner");

  // Offering mode is a precondition, not a feature of this epic: `none` and `informational`
  // refuse share links outright, so two of the three workspaces have to leave the default.
  const acme506c = await request("acme", "/api/v1/compliance/offering", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ status: "506c", confirm: "506c", reason: "raising" }),
  });
  expect(acme506c.status).toBe(200);
  const globex506b = await request("globex", "/api/v1/compliance/offering", {
    method: "PATCH",
    cookie: globexOwner.cookie,
    body: JSON.stringify({ status: "506b", reason: "friends and family" }),
  });
  expect(globex506b.status).toBe(200);

  // Something for a link to point at. The seed template is the cheapest way to two folders.
  const applied = await request("acme", "/api/v1/data-room/templates/seed/apply", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({}),
  });
  expect(applied.status).toBe(200);
  const { tree } = await json<{ tree: TreeBody }>(applied);
  const financials = tree.folders.find((f) => f.name === "Financials");
  const overview = tree.folders.find((f) => f.name === "Overview");
  financialsId = financials?.id ?? "";
  financialsPath = financials?.path ?? "";
  overviewId = overview?.id ?? "";
  overviewPath = overview?.path ?? "";
  expect(financialsId).not.toBe("");
  expect(overviewId).not.toBe("");

  mailer.clear();
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema, registry and the offering-mode switch", () => {
  it("the share-link tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers the two permissions and the admin nav slot, and declares `disabledWhen`", async () => {
    const registry = running.container.registry;
    for (const p of ["share-links.read", "share-links.manage"]) {
      expect(registry.permissions.get(p)).toBe("share-links");
    }
    const boot = await json<Bootstrap>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = boot.modules.find((m) => m.id === "share-links");
    expect(mod?.enabled).toBe(true);
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
    expect(mod?.slots["admin.nav"]?.[0]).toMatchObject({ id: "share-links", order: 26 });
    // The first manifest in the product to declare it (contract S4/E2); E2.5's `round` was the
    // second. The manifest is what the nav reads; `routes/links.ts` reads the same constant to
    // 404 the routes themselves.
    const declaring = COMPILED_IN_MODULES.filter(
      (m) => (m.offeringStatusRules?.disabledWhen ?? []).length > 0,
    );
    expect(declaring.map((m) => m.id)).toEqual(["share-links", "round"]);
  });

  it("an `informational` offering 404s the routes for a staff owner and a stranger alike", async () => {
    // `initech` never left `none`. The guard runs before any permission check and before
    // anything reads `core.share_link`, so there is no timing difference either (contract E2).
    const staff = await request("initech", "/api/v1/links", { cookie: initechOwner.cookie });
    expect(staff.status).toBe(404);
    expect((await json<ErrorBody>(staff)).error.code).toBe("module_disabled");

    const stranger = await request("initech", `/api/v1/links/${UNKNOWN_TOKEN}`);
    expect(stranger.status).toBe(404);
    expect((await json<ErrorBody>(stranger)).error.code).toBe("module_disabled");

    const minted = await mint("initech", initechOwner, { label: "nope" });
    expect(minted.res.status).toBe(404);
  });
});

describe("minting", () => {
  it("is staff-only: an investor gets the 404 an unknown path gives, an editor a 403", async () => {
    const investor = await request("acme", "/api/v1/links", { cookie: bystander.cookie });
    expect(investor.status).toBe(404);
    const editorList = await request("acme", "/api/v1/links", { cookie: editor.cookie });
    expect(editorList.status).toBe(403);
    expect((await json<ErrorBody>(editorList)).error.permission).toBe("share-links.read");
    const editorMint = await mint("acme", editor, { label: "nope" });
    expect(editorMint.res.status).toBe(403);
  });

  it("506(b) refuses an 'any verified email' link and names the rule the admin must satisfy", async () => {
    const open = await mint("globex", globexOwner, { label: "anyone at all" });
    expect(open.res.status).toBe(403);
    const body = await json<ErrorBody>(open.res);
    expect(body.error.code).toBe("forbidden");
    expect(body.error.reason).toBe("audience_too_open");
    // The screen renders the server's refusal rather than re-deriving Rule 506 in the browser.
    expect(body.error.offeringStatus).toBe("506b");

    const named = await mint("globex", globexOwner, {
      label: "the syndicate",
      policy: { domains: ["syndicate.test"], emails: [], forceWatermark: false },
    });
    expect(named.res.status).toBe(200);
  });

  it("refuses a grant naming a resource kind no module registered", async () => {
    const res = await mint("acme", owner, {
      label: "cap table",
      grants: [{ resource: { kind: "cap_table", id: overviewId }, capabilities: ["view"] }],
    });
    expect(res.res.status).toBe(400);
    const body = await json<ErrorBody>(res.res);
    expect(body.error.code).toBe("unsupported");
    expect(body.error.reason).toBe("unknown_resource_kind");
  });

  it("returns the plaintext token exactly once and stores only its digest", async () => {
    const minted = await mint("acme", owner, {
      label: "Series B — financials",
      policy: { domains: ["investor.test"], emails: [], forceWatermark: true },
      grants: [
        {
          resource: { kind: "folder", id: financialsId, path: financialsPath },
          capabilities: ["view", "download"],
        },
      ],
      passcode: PASSCODE,
      maxUses: 3,
    });
    expect(minted.res.status).toBe(200);
    if (!minted.minted) throw new Error("no link");
    linkA = minted.minted;
    expect(linkA.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(linkA.url).toBe(`http://acme.${CANON}/s/${linkA.token}`);
    expect(linkA.link).toMatchObject({
      label: "Series B — financials",
      status: "active",
      passcodeRequired: true,
      maxUses: 3,
      uses: 0,
      visits: 0,
    });

    const stored = await rows<LinkRow>(
      `SELECT id, status, uses, encode(token_hash, 'hex') AS token_hash
       FROM core.share_link WHERE id = '${linkA.link.id}'::uuid`,
    );
    expect(stored[0]?.token_hash).toBe(sha256Hex(linkA.token));

    // Nothing can show the token again: it is not on the list and not in the row in the clear.
    const list = await json<{ links: LinkBody[] }>(
      await request("acme", "/api/v1/links", { cookie: owner.cookie }),
    );
    const listed = list.links.find((l) => l.id === linkA.link.id);
    expect(listed?.passcodeRequired).toBe(true);
    expect(JSON.stringify(list)).not.toContain(linkA.token);
    expect(JSON.stringify(list)).not.toContain(PASSCODE);

    const audit = await rows<AuditRow>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'share_link.created' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("share_link.created");
  });
});

describe("the whole flow: a stranger becomes a member with exactly what the link granted", () => {
  it("resolves the token without consuming it, and reveals nothing about the target", async () => {
    const res = await request("acme", `/api/v1/links/${linkA.token}`);
    expect(res.status).toBe(200);
    const body = await json<ResolutionBody>(res);
    expect(body).toEqual({ valid: true, requiresPasscode: true, workspaceName: "Acme" });
    // Not the folder's name, not its id, not the label the admin gave the link.
    expect(JSON.stringify(body)).not.toContain(financialsId);
    expect(JSON.stringify(body)).not.toContain("Financials");
    expect(JSON.stringify(body)).not.toContain("Series B");
    // "Never consumes": no use, no view, no visit row.
    const row = await rows<LinkRow>(
      `SELECT uses, views FROM core.share_link WHERE id = '${linkA.link.id}'::uuid`,
    );
    expect(row[0]).toMatchObject({ uses: 0, views: 0 });
  });

  it("refuses the wrong passcode, and refuses an address the link does not name", async () => {
    const wrong = await startLink("acme", linkA.token, {
      email: "ada@investor.test",
      passcode: "not-the-passcode",
    });
    expect(wrong.status).toBe(403);
    expect((await json<ErrorBody>(wrong)).error.reason).toBe("passcode_wrong");
    expect(mailer.sent).toHaveLength(0);

    // The allowlist is asked *after* the passcode, so "not on this link's list" is only ever
    // heard by somebody who has already satisfied it.
    const offList = await startLink("acme", linkA.token, {
      email: "ada@rival.test",
      passcode: PASSCODE,
    });
    expect(offList.status).toBe(403);
    expect((await json<ErrorBody>(offList)).error.reason).toBe("email_not_allowed");
    expect(mailer.sent).toHaveLength(0);

    // A missing passcode is told apart from a wrong one — both only reachable by somebody who
    // already holds a resolvable token, so neither reveals which links exist.
    const none = await startLink("acme", linkA.token, { email: "ada@investor.test" });
    expect(none.status).toBe(403);
    expect((await json<ErrorBody>(none)).error.reason).toBe("passcode_required");
  });

  it("sends the code, and the mail says nothing a forwarded copy could use", async () => {
    const since = mailer.sent.length;
    const res = await startLink("acme", linkA.token, {
      email: "ada@investor.test",
      passcode: PASSCODE,
    });
    expect(res.status).toBe(200);
    const body = await json<StartBody>(res);
    expect(body.status).toBe("sent");
    expect(body.emailHint).toMatch(/\*/u);
    expect(body.ttlMinutes).toBeGreaterThan(0);

    const mail = await awaitMail(mailer, { to: "ada@investor.test", since });
    expect(mail.to).toBe("ada@investor.test");
    expect(mail?.text).not.toContain(linkA.token);
    expect(mail?.text).not.toContain(PASSCODE);
  });

  it("spends the code and lands a real `external` membership sourced to the link", async () => {
    const res = await verifyLink("acme", linkA.token, {
      email: "ada@investor.test",
      code: await codeFor("ada@investor.test"),
    });
    expect(res.status).toBe(200);
    const body = await json<LoginBody>(res);
    expect(body.membership).toMatchObject({ kind: "external", role: "investor", status: "active" });
    // Email OTP is auth level 1. Level 0 is reserved for host-asserted identity (ADR-0040).
    expect(body.session.authLevel).toBe(1);
    ada = { cookie: cookiesOf(res), membershipId: body.membership?.id ?? "" };
    expect(ada.cookie).not.toBe("");

    const m = await rows<{ source: string; kind: string; role: string }>(
      `SELECT source, kind, role FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
    );
    expect(m[0]).toMatchObject({
      source: `link:${linkA.link.id}`,
      kind: "external",
      role: "investor",
    });

    // The binding the evaluator walks, and the seat it spent.
    const visit = await rows<{ link_id: string; revoked_at: string | null }>(
      `SELECT link_id, revoked_at FROM core.share_link_visit
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(visit).toHaveLength(1);
    expect(visit[0]).toMatchObject({ link_id: linkA.link.id, revoked_at: null });
    const row = await rows<LinkRow>(
      `SELECT uses FROM core.share_link WHERE id = '${linkA.link.id}'::uuid`,
    );
    expect(row[0]?.uses).toBe(1);

    const audit = await rows<AuditRow>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'share_link.redeemed' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit[0]?.meta["linkId"]).toBe(linkA.link.id);
  });

  it("reads exactly the resource the link granted, and nothing else in the room", async () => {
    const mine = await waitFor(async () => {
      const a = await json<MyAccess>(
        await request("acme", "/api/v1/access/my", { cookie: ada.cookie }),
      );
      return a.resources.length > 0 ? a : undefined;
    });
    expect(mine.resources.map((r) => r.id)).toEqual([financialsId]);
    expect(mine.resources[0]).toMatchObject({ kind: "folder", capabilities: ["view", "download"] });
    expect(mine.resources[0]?.pendingGates).toEqual([]);
    // An external membership holds no staff permissions, whatever the link granted.
    expect(mine.permissions).toEqual([]);

    const tree = await json<TreeBody>(
      await request("acme", "/api/v1/data-room/tree", { cookie: ada.cookie }),
    );
    const names = tree.folders.map((f) => f.name);
    expect(names).toContain("Financials");
    expect(names).not.toContain("Overview");

    // The admin can see who came in through the link, and the visit list names them.
    const visits = await json<{
      visits: { membershipId: string; email: string | null; revokedAt: string | null }[];
    }>(await request("acme", `/api/v1/links/${linkA.link.id}/visits`, { cookie: owner.cookie }));
    expect(visits.visits).toHaveLength(1);
    expect(visits.visits[0]).toMatchObject({
      membershipId: ada.membershipId,
      email: "ada@investor.test",
      revokedAt: null,
    });
  });

  it("signing in through the link ends the session the browser already held (F-12)", async () => {
    const since = mailer.sent.length;
    const start = await startLink("acme", linkA.token, {
      email: "ada@investor.test",
      passcode: PASSCODE,
    });
    expect(start.status).toBe(200);
    const again = await request("acme", `/api/v1/links/${linkA.token}/verify`, {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({
        email: "ada@investor.test",
        code: await codeFor("ada@investor.test", since),
      }),
    });
    expect(again.status, await again.clone().text()).toBe(200);
    const fresh = cookiesOf(again);
    expect((await request("acme", "/api/v1/me", { cookie: ada.cookie })).status).toBe(401);
    expect((await request("acme", "/api/v1/me", { cookie: fresh })).status).toBe(200);
    ada = { ...ada, cookie: fresh };
  });
});

describe("the `max_uses` race against real Postgres (contract B11)", () => {
  const racers = ["r1@race.test", "r2@race.test", "r3@race.test", "r4@race.test", "r5@race.test"];

  it("admits exactly `max_uses` people when five redeem at once, never more", async () => {
    const minted = await mint("acme", owner, {
      label: "two seats only",
      policy: { domains: ["race.test"], emails: [], forceWatermark: false },
      grants: [
        {
          resource: { kind: "folder", id: overviewId, path: overviewPath },
          capabilities: ["view"],
        },
      ],
      maxUses: 2,
    });
    expect(minted.res.status).toBe(200);
    if (!minted.minted) throw new Error("no link");
    linkB = minted.minted;

    // Five codes, minted one at a time: `start` is not the thing under test, and the OTP start
    // limit is keyed per link *and* email, so five addresses are five buckets.
    const sinceRacers = mailer.sent.length;
    for (const email of racers) {
      expect((await startLink("acme", linkB.token, { email })).status).toBe(200);
    }
    const codes: { email: string; code: string }[] = [];
    for (const email of racers) codes.push({ email, code: await codeFor(email, sinceRacers) });

    /*
     * The actual race. Five `verify` calls in flight together, each of which resolves the token,
     * creates a membership and asks `claimUse` for a seat. The unit proof models this with a fake
     * store; only real Postgres can say whether
     * `UPDATE … SET uses = uses + 1 WHERE uses < max_uses RETURNING uses` holds when five
     * transactions reach it at once.
     */
    const results = await Promise.all(
      codes.map((c) => verifyLink("acme", linkB.token, { email: c.email, code: c.code })),
    );
    // Which two won is Postgres's decision, not the test's — the winners are read back off the
    // responses rather than assumed, because assuming it is how a concurrency test starts
    // passing for the wrong reason.
    raceWinners = codes.filter((_, i) => results[i]?.status === 200).map((c) => c.email);
    raceLosers = codes.filter((_, i) => results[i]?.status === 404).map((c) => c.email);
    expect(raceWinners).toHaveLength(2);
    expect(raceLosers).toHaveLength(3);

    // And the database agrees with the wire, which is the half a status-code count cannot prove:
    // a seat handed out without a row, or a row without a seat, is the bug this test exists for.
    const row = await rows<LinkRow>(
      `SELECT uses FROM core.share_link WHERE id = '${linkB.link.id}'::uuid`,
    );
    expect(row[0]?.uses).toBe(2);
    const visits = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link_visit
       WHERE workspace_id = '${acmeId}'::uuid AND link_id = '${linkB.link.id}'::uuid
         AND revoked_at IS NULL`,
    );
    expect(visits[0]?.n).toBe(2);

    // The losers took nothing with them: no membership was left behind by a rolled-back seat.
    const admitted = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership
       WHERE workspace_id = '${acmeId}'::uuid AND source = 'link:${linkB.link.id}'`,
    );
    expect(admitted[0]?.n).toBe(2);
  }, 60_000);

  it("a sixth visitor is silently refused: the same 200 as everyone else, and no mail", async () => {
    // The refusal moved from the status code to the mailbox (contract H2/H3). What must not move
    // is the reply, because that is what would say whether the address was already inside.
    const row = await rows<LinkRow>(
      `SELECT uses, max_uses::int AS max_uses, status FROM core.share_link
       WHERE id = '${linkB.link.id}'::uuid`,
    );
    expect(row[0]).toMatchObject({ uses: 2, max_uses: 2, status: "active" });
    const since = mailer.sent.length;
    const res = await startLink("acme", linkB.token, { email: "r6@race.test" });
    expect(res.status).toBe(200);
    expect(mailer.sent.slice(since).filter((m) => m.to === "r6@race.test")).toHaveLength(0);
  });

  it("a visitor the spent link already admitted comes back through it, spending no second seat", async () => {
    /*
     * The fix contract note H1/H3 exists for, asserted against real Postgres.
     *
     * A use cap limits how many people may come in, not how long the ones who did may stay: an
     * exhausted link is still *open*, `PrincipalRepo` still emits its subject (A6), and answering
     * "no such link" to the people it is actively granting access to locked them out of the room
     * they are already in. So a spent link resolves, and a visitor it already admitted can sign
     * in again from a new device — without spending a second seat, because `upsertVisit` finds
     * the binding it already has and `claimUse` is only asked for a *new* one.
     */
    const resolved = await request("acme", `/api/v1/links/${linkB.token}`);
    expect(resolved.status).toBe(200);
    expect((await json<ResolutionBody>(resolved)).valid).toBe(true);

    const winner = raceWinners[0] ?? "";
    const since = mailer.sent.length;
    const start = await startLink("acme", linkB.token, { email: winner });
    expect(start.status).toBe(200);
    const code = await codeFor(winner, since);
    expect(mailer.sent.slice(since).filter((m) => m.to === winner)).toHaveLength(1);

    const back = await verifyLink("acme", linkB.token, {
      email: winner,
      code,
    });
    expect(back.status, await back.clone().text()).toBe(200);
    const row = await rows<LinkRow>(
      `SELECT uses FROM core.share_link WHERE id = '${linkB.link.id}'::uuid`,
    );
    expect(row[0]?.uses).toBe(2);
    const visits = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link_visit
       WHERE workspace_id = '${acmeId}'::uuid AND link_id = '${linkB.link.id}'::uuid`,
    );
    expect(visits[0]?.n).toBe(2);
    // And they still hold what the link granted.
    const mine = await json<MyAccess>(
      await request("acme", "/api/v1/access/my", { cookie: cookiesOf(back) }),
    );
    expect(mine.resources.map((r) => r.id)).toEqual([overviewId]);
  });

  it("answers a stranger on the spent link identically, and silently sends them nothing", async () => {
    /*
     * The anti-oracle property, pinned directly rather than through a status code (contract H2).
     *
     * `start` holds an address, so it *can* tell a returning visitor from a new one — and it must
     * never do so on the wire, because a reply that moved would answer "has this address been let
     * into this room?" for anyone ever forwarded the link, and in a private placement the list of
     * who is in the room is close to the whole secret. The caps are therefore decided one layer
     * down, in `checkEligibility`, which is silent by construction: same status, same body, same
     * duration floor, and the only difference is whether a mail exists.
     */
    // One who got in and one who did not, both on the link's allowlist, both spelled the same way.
    const inside = raceWinners[1] ?? "";
    const outside = raceLosers[0] ?? "";
    const sinceReturning = mailer.sent.length;
    const returning = await startLink("acme", linkB.token, { email: inside });
    const returningBody = await json<StartBody>(returning);
    await awaitMail(mailer, { to: inside, since: sinceReturning });
    const mailedReturning = mailer.sent.slice(sinceReturning).filter((m) => m.to === inside);

    const sinceStranger = mailer.sent.length;
    const stranger = await startLink("acme", linkB.token, { email: outside });
    const strangerBody = await json<StartBody>(stranger);
    const mailedStranger = mailer.sent.slice(sinceStranger).filter((m) => m.to === outside);

    expect(stranger.status).toBe(returning.status);
    expect(stranger.status).toBe(200);
    // Byte-identical but for the masked hint, which is a function of the address the caller
    // already typed and therefore tells them nothing they did not send.
    expect({ ...strangerBody, emailHint: "" }).toEqual({ ...returningBody, emailHint: "" });
    expect(mailedReturning).toHaveLength(1);
    expect(mailedStranger).toHaveLength(0);
  });

  it("refuses at `claimUse` a member the spent link never admitted, with the ordinary 404", async () => {
    /*
     * The seat is settled by the conditional `UPDATE`, and this is the caller that reaches it: a
     * member of this workspace by some other route, whose address the link's policy allows, so
     * `checkEligibility` mails them a code (their membership, not the link, is what makes them
     * eligible). They then present it at `verify`, `redeem` inserts a *new* binding, `claimUse`
     * finds no seat and the whole transaction rolls back to the same 404 everything else gives.
     * To get this far a caller must control the mailbox, so what they learn is about themselves.
     */
    const insider = await member("acme", acmeId, "insider@race.test", "external", "investor");
    expect(insider.membershipId).not.toBe("");
    const since = mailer.sent.length;
    const start = await startLink("acme", linkB.token, { email: "insider@race.test" });
    expect(start.status).toBe(200);
    const code = await codeFor("insider@race.test", since);
    expect(mailer.sent.slice(since).filter((m) => m.to === "insider@race.test")).toHaveLength(1);

    const res = await verifyLink("acme", linkB.token, {
      email: "insider@race.test",
      code,
    });
    expect(res.status).toBe(404);
    // The code is the ordinary one. The *message* is not: `ShareLinkError`'s "no such share link"
    // is adopted verbatim by `toApiError`, while the route's own `notFound()` says "no such
    // link", so the two 404s are distinguishable by their prose. Reachable only by somebody who
    // controls the mailbox and holds the token, so it says nothing they did not already know —
    // but it is a difference where the design says there is one answer. Recorded in §10.
    expect((await json<ErrorBody>(res)).error.code).toBe("not_found");
    // Nothing was left behind: no seat, no binding.
    const row = await rows<LinkRow>(
      `SELECT uses FROM core.share_link WHERE id = '${linkB.link.id}'::uuid`,
    );
    expect(row[0]?.uses).toBe(2);
    const bound = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link_visit
       WHERE link_id = '${linkB.link.id}'::uuid
         AND membership_id = '${insider.membershipId}'::uuid`,
    );
    expect(bound[0]?.n).toBe(0);
  }, 30_000);
});

describe("the authorization edge: a dead link materialises no access (contract A7)", () => {
  it("materialises the link's grant into `core.effective_access` while it is live", async () => {
    const live = await effectiveAccess(ada.membershipId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ resource_kind: "folder", resource_id: financialsId });
    expect(live[0]?.capabilities.sort()).toEqual(["download", "view"]);
  });

  it("writes the link's grants against the LINK, never copied per visitor (contract §2)", async () => {
    /*
     * This is the mechanism every assertion below depends on, so it is asserted directly rather
     * than inferred from the ones that follow.
     *
     * Contract §2: "The link remains the grant subject. Grants are written once against
     * `subject_kind='link', subject_id=<link id>` — never copied per visitor… Revoking the link
     * stops emitting the subject, so one write revokes everyone it admitted." D8 rests on it, and
     * so does A7. If the grants are instead copied onto each visitor as `membership` subjects,
     * every revocation below is a write that changes nothing, and the link's admin screen becomes
     * a control that does not control anything.
     */
    const grants = await rows<{ subject_kind: string; subject_id: string; note: string | null }>(
      `SELECT subject_kind, subject_id::text AS subject_id, note FROM core.access_grant
       WHERE workspace_id = '${acmeId}'::uuid AND resource_id = '${financialsId}'::uuid
         AND revoked_at IS NULL ORDER BY subject_kind`,
    );
    expect(grants.length).toBeGreaterThan(0);
    expect(new Set(grants.map((g) => g.subject_kind))).toEqual(new Set(["link"]));
    expect(new Set(grants.map((g) => g.subject_id))).toEqual(new Set([linkA.link.id]));
    // And no per-visitor copy exists to outlive the link.
    const copies = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.access_grant
       WHERE workspace_id = '${acmeId}'::uuid AND subject_kind = 'membership'
         AND subject_id = '${ada.membershipId}'::uuid AND revoked_at IS NULL`,
    );
    expect(copies[0]?.n).toBe(0);
  });

  it("pausing the link suspends everyone it already admitted, and resuming restores them", async () => {
    const paused = await request("acme", `/api/v1/links/${linkA.link.id}/pause`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(paused.status).toBe(200);
    expect((await json<LinkBody>(paused)).status).toBe("paused");
    // Wider than it looks, and the admin copy has to say so: `PrincipalRepo` stops emitting the
    // subject, so the access the link gave ends for the people who already hold it.
    expect(await effectiveAccess(ada.membershipId)).toEqual([]);

    const resumed = await request("acme", `/api/v1/links/${linkA.link.id}/resume`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(resumed.status).toBe(200);
    expect((await json<LinkBody>(resumed)).status).toBe("active");
    expect(await effectiveAccess(ada.membershipId)).toHaveLength(1);
  });

  it("an expired link materialises nothing, and un-expiring it brings the access back", async () => {
    // Backdated in SQL rather than by waiting: `mint` refuses an expiry that is already past, so
    // there is no way to create one through the API, and sleeping for a real expiry would make
    // this test a timer.
    await rows(
      `UPDATE core.share_link SET expires_at = now() - interval '1 hour'
       WHERE id = '${linkA.link.id}'::uuid`,
    );
    expect(await effectiveAccess(ada.membershipId)).toEqual([]);
    await rows(`UPDATE core.share_link SET expires_at = NULL WHERE id = '${linkA.link.id}'::uuid`);
    expect(await effectiveAccess(ada.membershipId)).toHaveLength(1);
  });

  it("revoking one visitor's binding removes only that visitor's materialised access", async () => {
    await rows(
      `UPDATE core.share_link_visit SET revoked_at = now()
       WHERE link_id = '${linkA.link.id}'::uuid AND membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(await effectiveAccess(ada.membershipId)).toEqual([]);
    await rows(
      `UPDATE core.share_link_visit SET revoked_at = NULL
       WHERE link_id = '${linkA.link.id}'::uuid AND membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(await effectiveAccess(ada.membershipId)).toHaveLength(1);
  });

  it("revoking the link ends the access it gave without ending the membership it created", async () => {
    const res = await request("acme", `/api/v1/links/${linkA.link.id}/revoke`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ revokeMemberships: false }),
    });
    expect(res.status).toBe(200);
    expect(await effectiveAccess(ada.membershipId)).toEqual([]);

    // Still a member, still holding her own session: revoking a link is not eviction.
    const m = await rows<{ status: string }>(
      `SELECT status FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
    );
    expect(m[0]?.status).toBe("active");
    expect((await request("acme", "/api/v1/access/my", { cookie: ada.cookie })).status).toBe(200);

    // Revoked is final: it cannot be resumed back into life.
    const resume = await request("acme", `/api/v1/links/${linkA.link.id}/resume`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(resume.status).toBe(409);
  });
});

describe("anti-enumeration: five different refusals, one wire answer (D7)", () => {
  it("mints the two remaining samples", async () => {
    const paused = await mint("acme", owner, {
      label: "paused sample",
      policy: { domains: ["investor.test"], emails: [], forceWatermark: false },
    });
    if (!paused.minted) throw new Error("no link");
    pausedLink = paused.minted;
    expect(
      (
        await request("acme", `/api/v1/links/${pausedLink.link.id}/pause`, {
          method: "POST",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);

    const expired = await mint("acme", owner, {
      label: "expired sample",
      policy: { domains: ["investor.test"], emails: [], forceWatermark: false },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (!expired.minted) throw new Error("no link");
    expiredLink = expired.minted;
    await rows(
      `UPDATE core.share_link SET expires_at = now() - interval '1 minute'
       WHERE id = '${expiredLink.link.id}'::uuid`,
    );
  });

  it("unknown, revoked, paused and expired are indistinguishable on resolve", async () => {
    /*
     * Four states, not D7's original five. An *exhausted* link is deliberately no longer one of
     * them (contract H1/H3): it is still open, `PrincipalRepo` still emits its subject, and
     * answering "no such link" to the people it is actively granting access to was a lie that
     * locked them out. On these four `isOpen` is exactly `PrincipalRepo.listActive()`'s
     * predicate, so a link that resolves is a link that grants — which is the property that makes
     * the collapse honest rather than merely uniform. The spent link's own behaviour is pinned
     * three tests up, where the anti-oracle claim is made about the mailbox instead.
     */
    const samples: [string, string][] = [
      ["unknown", UNKNOWN_TOKEN],
      ["revoked", linkA.token],
      ["paused", pausedLink.token],
      ["expired", expiredLink.token],
    ];
    const seen: { name: string; status: number; body: Record<string, unknown> }[] = [];
    for (const [name, token] of samples) {
      const res = await request("acme", `/api/v1/links/${token}`);
      seen.push({ name, status: res.status, body: errorShape(await json<ErrorBody>(res)) });
    }
    /*
     * Collected first and asserted afterwards, so a failure names *which* of the four is the
     * odd one out rather than stopping at the first.
     *
     * The claim is not "each is a 404" — a uniform 403 or 410 would satisfy that — but that the
     * four answers are the *same answer*, byte for byte. A caller who could tell them apart
     * could enumerate live links, and that a link exists is already the interesting fact about a
     * confidential data room. This is the property most likely to rot, because the four refusals
     * are decided in four different places.
     */
    expect(seen.map((r) => `${r.name}:${r.status}`)).toEqual(samples.map(([n]) => `${n}:404`));
    for (const r of seen) expect(r.body, r.name).toEqual(seen[0]?.body);
    expect(seen[0]?.body).toEqual({ code: "not_found", message: "no such link" });
  });

  it("…and indistinguishable on start, which is where a prober would actually look", async () => {
    // One address that every one of these links' allowlists admits, so the allowlist can never be
    // what makes the answers differ: whatever the prober does, the answer is the same.
    const samples: [string, string, string][] = [
      ["unknown", UNKNOWN_TOKEN, "prober@investor.test"],
      ["revoked", linkA.token, "prober@investor.test"],
      ["paused", pausedLink.token, "prober@investor.test"],
      ["expired", expiredLink.token, "prober@investor.test"],
    ];
    const seen: { name: string; status: number; body: Record<string, unknown> }[] = [];
    for (const [name, token, email] of samples) {
      const res = await startLink("acme", token, { email });
      seen.push({ name, status: res.status, body: errorShape(await json<ErrorBody>(res)) });
    }
    expect(seen.map((r) => `${r.name}:${r.status}`)).toEqual(samples.map(([n]) => `${n}:404`));
    for (const r of seen) expect(r.body, r.name).toEqual(seen[0]?.body);
    // And nothing was sent: a mail is an oracle too.
    expect(mailer.sent.filter((m) => m.to.includes("prober@"))).toHaveLength(0);
  });

  it("a malformed token is refused by the schema before anything is hashed", async () => {
    const res = await request("acme", "/api/v1/links/short");
    expect(res.status).toBe(400);
  });
});

describe("the passcode counter survives the refusal that increments it (contract B7)", () => {
  it("mints a passcode link", async () => {
    const minted = await mint("acme", owner, {
      label: "passcode sample",
      policy: { domains: ["investor.test"], emails: [], forceWatermark: false },
      passcode: PASSCODE,
    });
    expect(minted.res.status).toBe(200);
    if (!minted.minted) throw new Error("no link");
    linkC = minted.minted;
  });

  it("persists the incremented attempt after a refused request", async () => {
    const res = await startLink("acme", linkC.token, {
      email: "guesser@investor.test",
      passcode: "wrong-one",
    });
    expect(res.status).toBe(403);
    /*
     * The whole of B7 is this one row read. `checkPasscode` counts the attempt inside the
     * caller's transaction and *returns* the refusal; a route that turned it into an exception
     * before the commit would roll the counter back with it and hand a guesser unlimited tries.
     * A `passcode_attempts` of 0 here is not a cosmetic bug — it is the rate limit gone.
     */
    const row = await rows<LinkRow>(
      `SELECT passcode_attempts, passcode_locked_until FROM core.share_link
       WHERE id = '${linkC.link.id}'::uuid`,
    );
    expect(row[0]?.passcode_attempts).toBe(1);
    expect(row[0]?.passcode_locked_until).toBeNull();
  });

  it("locks the link after the configured number of guesses, and the lock outlives a right answer", async () => {
    // Four more, taking it to the five-attempt ceiling.
    for (let i = 0; i < 4; i += 1) {
      const res = await startLink("acme", linkC.token, {
        email: "guesser@investor.test",
        passcode: `wrong-${i}`,
      });
      expect(res.status).toBe(i < 3 ? 403 : 429);
    }
    const row = await rows<LinkRow>(
      `SELECT passcode_attempts, passcode_locked_until FROM core.share_link
       WHERE id = '${linkC.link.id}'::uuid`,
    );
    expect(row[0]?.passcode_locked_until).not.toBeNull();
    expect(Date.parse(row[0]?.passcode_locked_until ?? "")).toBeGreaterThan(Date.now());
    // Reset as the lock is set: a counter left at the ceiling would make the first attempt after
    // the lock expires instantly "locked" again (contract B7).
    expect(row[0]?.passcode_attempts).toBe(0);

    // The correct passcode does not buy a way past the lock.
    const right = await startLink("acme", linkC.token, {
      email: "guesser@investor.test",
      passcode: PASSCODE,
    });
    expect(right.status).toBe(429);
    expect((await json<ErrorBody>(right)).error.reason).toBe("passcode_locked");
    expect(mailer.sent.filter((m) => m.to === "guesser@investor.test")).toHaveLength(0);
  });
});

describe("a link-targeted NDA gate (`policy_target_kind = 'link'`)", () => {
  it("publishes the tenant NDA", async () => {
    const res = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({
        slug: "nda",
        from: "nda-clickwrap",
        requiresAcceptance: false,
        audience: "external",
      }),
    });
    expect(res.status).toBe(200);
    const detail = await json<DocumentDetail>(res);
    ndaId = detail.document.id;
    expect(detail.document.kind).toBe("nda");
    // Our own words, so the body is stable and the digest is ours to predict.
    const v2 = await request("acme", `/api/v1/compliance/documents/${ndaId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NDA_BODY_V1, summary: "tenant wording" }),
    });
    expect(v2.status).toBe(200);
  });

  it("gates the link's own grant until the visitor holds the document's current stamp", async () => {
    const minted = await mint("acme", owner, {
      label: "overview, behind the NDA",
      policy: { domains: ["investor.test"], emails: ["nick@investor.test"], forceWatermark: false },
      grants: [
        {
          resource: { kind: "folder", id: overviewId, path: overviewPath },
          capabilities: ["view"],
        },
      ],
    });
    expect(minted.res.status).toBe(200);
    if (!minted.minted) throw new Error("no link");
    linkE = minted.minted;

    // The `link` arm of `PolicyTargetSchema`, and the `{ documentId }` config that makes
    // re-acceptance automatic: the repository resolves the stamp at read time (D4).
    const policy = await request("acme", "/api/v1/access/policies", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        kind: "nda",
        target: { kind: "link", id: linkE.link.id },
        config: { documentId: ndaId },
      }),
    });
    expect(policy.status).toBe(200);
    linkGateId = (await json<{ id: string }>(policy)).id;

    nick = await admit("acme", linkE.token, "nick@investor.test");
    const gated = await waitFor(async () => {
      const a = await json<MyAccess>(
        await request("acme", "/api/v1/access/my", { cookie: nick.cookie }),
      );
      return a.resources.some((r) => r.pendingGates.length > 0) ? a : undefined;
    });
    const resource = gated.resources.find((r) => r.id === overviewId);
    expect(resource?.pendingGates).toHaveLength(1);
    expect(resource?.pendingGates[0]).toMatchObject({
      kind: "nda",
      source: `link:${linkE.link.id}`,
    });
    // A2: the detail now carries the full stamp, the bare version and the document it names.
    expect(resource?.pendingGates[0]?.detail).toMatchObject({
      stamp: "nda:v2",
      version: "v2",
      documentId: ndaId,
    });
  });

  it("shows the emailHint only for a link that names exactly one address", async () => {
    // `linkE` names one, so the visitor can answer "which of my addresses was this sent to?".
    const res = await request("acme", `/api/v1/links/${linkE.token}`);
    expect(res.status).toBe(200);
    const body = await json<ResolutionBody>(res);
    expect(body.emailHint).toBeDefined();
    expect(body.emailHint).not.toContain("nick@");
    expect(body.emailHint).toContain("investor.test");
  });

  it("removing the gate lets the link's grant through again", async () => {
    expect(
      (
        await request("acme", `/api/v1/access/policies/${linkGateId}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
    const clear = await waitFor(async () => {
      const a = await json<MyAccess>(
        await request("acme", "/api/v1/access/my", { cookie: nick.cookie }),
      );
      return a.resources.every((r) => r.pendingGates.length === 0) ? a : undefined;
    });
    expect(clear.resources.map((r) => r.id)).toEqual([overviewId]);
  });
});

describe("the click-wrap certificate, tested as evidence", () => {
  let acceptedSeq = 0;
  let certificateSha = "";
  let evidenceRef = "";
  let bodySha = "";

  it("gates the visitor on the tenant NDA and carries the exact bytes on the bootstrap", async () => {
    const patched = await request("acme", `/api/v1/compliance/documents/${ndaId}`, {
      method: "PATCH",
      cookie: counsel.cookie,
      body: JSON.stringify({ requiresAcceptance: true, audience: "external" }),
    });
    expect(patched.status).toBe(200);

    // Both kinds of external member are gated: one invited, one admitted by a share link.
    for (const who of [bystander, ada]) {
      const blocked = await request("acme", "/api/v1/access/my", { cookie: who.cookie });
      expect(blocked.status).toBe(403);
      expect((await json<ErrorBody>(blocked)).error.code).toBe("legal_acceptance_required");
    }

    const boot = await json<
      Bootstrap & { pendingAcceptances: { body: string; bodySha256: string }[] }
    >(await request("acme", "/api/v1/modules", { cookie: bystander.cookie }));
    expect(boot.pendingAcceptances).toHaveLength(1);
    expect(boot.pendingAcceptances[0]).toMatchObject({
      slug: "nda",
      versionNo: 2,
      stamp: "nda:v2",
    });
    // The bytes shown are the bytes the acceptance names — which is what makes them trustworthy,
    // rather than a hash the browser echoes back (contract C2).
    expect(boot.pendingAcceptances[0]?.body).toBe(NDA_BODY_V1);
    bodySha = boot.pendingAcceptances[0]?.bodySha256 ?? "";
    expect(bodySha).toBe(sha256Hex(NDA_BODY_V1));
  });

  it("records the attestation with a stored certificate reference", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: bystander.cookie,
      headers: { "user-agent": "Mozilla/5.0 (X11) Firefox/140.0" },
      body: JSON.stringify({ documentId: ndaId, versionNo: 2 }),
    });
    expect(res.status).toBe(200);
    expect(await json<{ stamp: string; recorded: boolean }>(res)).toMatchObject({
      stamp: "nda:v2",
      recorded: true,
    });
    expect((await request("acme", "/api/v1/access/my", { cookie: bystander.cookie })).status).toBe(
      200,
    );

    const att = await rows<{
      kind: string;
      evidence_ref: string | null;
      data: Record<string, unknown>;
    }>(
      `SELECT kind, evidence_ref, data FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${bystander.membershipId}'::uuid
         AND kind = 'nda:v2'`,
    );
    expect(att).toHaveLength(1);
    evidenceRef = att[0]?.evidence_ref ?? "";
    // `cert:v1:<certificateId>:she1:<keyId>`: the key id rides the reference because the database
    // is the durable record and a bucket copy can lose user metadata without losing bytes.
    expect(evidenceRef).toMatch(/^cert:v1:[0-9a-f-]{36}:she1:[0-9a-f-]{36}$/u);
    expect(att[0]?.data["bodySha256"]).toBe(bodySha);
    expect(att[0]?.data["uaFamily"]).toBe("firefox");
    expect(JSON.stringify(att[0]?.data)).not.toContain("Mozilla");
  });

  it("a share-link visitor can accept the NDA the link put in front of them", async () => {
    /*
     * The population this epic exists for. A share-link visitor's membership is created by
     * `establishFromLink` with `profile: {}` against a user who has never been given a name — the
     * ceremony only ever verified an address — so `MembershipRepo.namesFor` answers with the
     * empty string (`displayNameExpr` is
     * `COALESCE(NULLIF(user.display_name, ''), profile->>'displayName', '')`).
     *
     * `certificateFacts` in `apps/server/src/routes/compliance.ts` then passes
     * `who?.displayName ?? null`, which keeps `""` because `??` only catches null and undefined,
     * and `assertValidCertificateDocument`'s `nullableText` rejects a zero-length string. The
     * issuer throws, the transaction rolls back, and the acceptance is a 500.
     *
     * `CertificateDocument.signer.displayName` is `string | null` precisely so that an unnamed
     * signer is expressible; `|| null` is the whole fix. This test is the proof and stays red
     * until it is made.
     */
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ documentId: ndaId, versionNo: 2 }),
    });
    expect(res.status).toBe(200);
    const held = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${ada.membershipId}'::uuid
         AND kind = 'nda:v2'`,
    );
    expect(held[0]?.n).toBe(1);
  });

  it("writes both audit rows, and they cite each other across an unbroken chain", async () => {
    const accepted = await rows<AuditRow>(
      `SELECT seq, action, encode(hash, 'hex') AS hash, encode(prev_hash, 'hex') AS prev_hash, meta
       FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'legal.document_accepted'
         AND subject_membership_id = '${bystander.membershipId}'::uuid
       ORDER BY seq DESC LIMIT 1`,
    );
    const issued = await rows<AuditRow>(
      `SELECT seq, action, encode(hash, 'hex') AS hash, encode(prev_hash, 'hex') AS prev_hash, meta
       FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'legal.certificate_issued'
         AND subject_membership_id = '${bystander.membershipId}'::uuid
       ORDER BY seq DESC LIMIT 1`,
    );
    const a = accepted[0];
    const i = issued[0];
    if (!a || !i) throw new Error("missing audit rows");
    acceptedSeq = Number(a.seq);
    certificateSha = String(i.meta["certificateSha256"]);

    // The certificate cites the acceptance event…
    expect(Number(i.meta["acceptanceSeq"])).toBe(Number(a.seq));
    expect(i.meta["acceptanceHash"]).toBe(a.hash);
    expect(i.meta["stamp"]).toBe("nda:v2");
    expect(certificateSha).toMatch(/^[0-9a-f]{64}$/u);
    // …and it was written after it, in the same chain.
    expect(Number(i.seq)).toBeGreaterThan(Number(a.seq));

    /*
     * The linkage itself. Walking the slice between the two events, each row's `prev_hash` is the
     * previous row's `hash` — which is what "neither can be moved, removed or back-dated without
     * breaking every hash after it" actually means. Without this the two `meta` fields above
     * would be two strings that happen to match.
     */
    const slice = await rows<AuditRow>(
      `SELECT seq, encode(hash, 'hex') AS hash, encode(prev_hash, 'hex') AS prev_hash
       FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND seq BETWEEN ${Number(a.seq)} AND ${Number(i.seq)} ORDER BY seq`,
    );
    expect(slice.length).toBe(Number(i.seq) - Number(a.seq) + 1);
    for (let n = 1; n < slice.length; n += 1) {
      expect(slice[n]?.prev_hash, `seq ${slice[n]?.seq}`).toBe(slice[n - 1]?.hash);
      expect(Number(slice[n]?.seq)).toBe(Number(slice[n - 1]?.seq) + 1);
    }
  });

  it("serves the canonical JSON, and its sha256 is the digest the audit row claims", async () => {
    const res = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v2&format=json`,
      { cookie: bystander.cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    /*
     * The evidentiary claim of the whole epic, in one line: the bytes actually stored hash to the
     * number the hash-chained audit log says they hash to. Anything less — comparing the audit
     * row to a digest recomputed from a freshly built document, say — would prove only that the
     * code is self-consistent.
     */
    const probe = JSON.stringify({
      length: bytes.length,
      head: Buffer.from(bytes.subarray(0, 24)).toString("latin1"),
      tail: Buffer.from(bytes.subarray(-24)).toString("latin1"),
    });
    expect(createHash("sha256").update(bytes).digest("hex"), probe).toBe(certificateSha);

    const doc = JSON.parse(Buffer.from(bytes).toString("utf8")) as CertificateJson;
    expect(doc.version).toBe(1);
    expect(doc.workspace).toMatchObject({ id: acmeId, name: "Acme", host: `acme.${CANON}` });
    expect(doc.signer.membershipId).toBe(bystander.membershipId);
    expect(doc.signer.emailSha256).toBe(sha256Hex("bystander@investor.test"));
    expect(doc.document).toMatchObject({
      documentId: ndaId,
      slug: "nda",
      versionNo: 2,
      stamp: "nda:v2",
      bodySha256: bodySha,
    });
    expect(doc.acceptance.method).toBe("clickwrap");
    expect(doc.acceptance.uaFamily).toBe("firefox");
    // Null rather than a digest: `app.request` carries no socket address and `TRUST_PROXY` is off,
    // so `clientIp` has nothing to hash. The fact worth asserting is the shape — an explicit
    // `null`, never an absent key and never an address (the "no raw IP" check is below).
    expect(doc.acceptance.ipHash).toBeNull();
    expect("ipHash" in doc.acceptance).toBe(true);
    expect(doc.anchor.auditSeq).toBe(acceptedSeq);
    // ADR-0036: a digest of the address, a browser family and a keyed hash of the network —
    // never the address, never the User-Agent string, never a raw IP.
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).not.toContain("@");
    expect(text).not.toContain("Mozilla");
    /*
     * Two facts the shipped acceptance route cannot supply, and the certificate says so honestly
     * rather than inventing them: nothing on the wire carries the signer's typed name
     * (`AcceptanceBody` has no field for it) and nothing tells the acceptance which share link the
     * signer came in through. Both are recorded in §10; when either is wired, this assertion is
     * the one that must change.
     */
    expect(doc.signer.typedName).toBeNull();
    expect(doc.acceptance.viaLinkId).toBeNull();
  });

  it("renders a PDF that carries the body digest and both audit anchors", async () => {
    const res = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v2&format=pdf`,
      { cookie: bystander.cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");

    const text = pdfText(bytes);
    expect(text.length).toBeGreaterThan(100);
    // A lawyer opening this in six years with nothing but a PDF reader must be able to check it.
    expect(text).toContain(bodySha);
    expect(text).toContain(certificateSha);
    expect(text).toContain(`#${acceptedSeq}`);
    expect(text).toContain("Click-wrap acceptance certificate");
    // And design/03's explicit requirement: it says what it is not.
    expect(text.replace(/\n/gu, " ")).toContain("not a signed NDA");
    expect(text).not.toContain("@");
  });

  it("is evidence about a named person: another investor gets the 404 an unknown one gives", async () => {
    const other = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v2`,
      { cookie: nick.cookie },
    );
    expect(other.status).toBe(404);
    // Same answer as a stamp nobody holds — "you may not see Ada's" and "Ada has none" must read
    // the same from outside.
    const absent = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v9`,
      { cookie: counsel.cookie },
    );
    expect(absent.status).toBe(404);
    expect(errorShape(await json<ErrorBody>(other))).toEqual(
      errorShape(await json<ErrorBody>(absent)),
    );
    // Counsel holds `compliance.read`, so counsel may.
    const forCounsel = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v2&format=json`,
      { cookie: counsel.cookie },
    );
    expect(forCounsel.status).toBe(200);
    expect(evidenceRef).not.toBe("");
  });
});

describe("re-acceptance on version change", () => {
  it("publishing a new version makes a prior acceptor pending again", async () => {
    const v3 = await request("acme", `/api/v1/compliance/documents/${ndaId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NDA_BODY_V2, summary: "tightened" }),
    });
    expect(v3.status).toBe(200);
    expect(await json<{ published: boolean }>(v3)).toMatchObject({ published: true });

    // Nothing rewrote a policy row: the stamp moved, so the attestation Ada holds is no longer
    // the one the gate asks for (contract D4).
    const blocked = await request("acme", "/api/v1/access/my", { cookie: bystander.cookie });
    expect(blocked.status).toBe(403);
    const boot = await json<Bootstrap>(
      await request("acme", "/api/v1/modules", { cookie: bystander.cookie }),
    );
    expect(boot.pendingAcceptances.map((p) => p.stamp)).toEqual(["nda:v3"]);
  });

  it("the old acceptance survives on the record beside the new one", async () => {
    const accept = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: bystander.cookie,
      body: JSON.stringify({ documentId: ndaId, versionNo: 3 }),
    });
    expect(accept.status).toBe(200);
    expect((await request("acme", "/api/v1/access/my", { cookie: bystander.cookie })).status).toBe(
      200,
    );

    const held = await rows<{ kind: string; revoked_at: string | null }>(
      `SELECT kind, revoked_at FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${bystander.membershipId}'::uuid
       ORDER BY kind`,
    );
    expect(held.map((h) => h.kind)).toEqual(["nda:v2", "nda:v3"]);
    // design/04 §4.7: what was agreed and when is evidence, and evidence is not superseded.
    expect(held.every((h) => h.revoked_at === null)).toBe(true);

    // And the old certificate is still fetchable under its own stamp.
    const old = await request(
      "acme",
      `/api/v1/compliance/acceptances/${bystander.membershipId}/certificate?stamp=nda:v2&format=json`,
      { cookie: counsel.cookie },
    );
    expect(old.status).toBe(200);
  });

  it("refuses an acceptance of a superseded version", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: nick.cookie,
      body: JSON.stringify({ documentId: ndaId, versionNo: 2 }),
    });
    expect(res.status).toBe(409);
  });
});

describe("accreditation self-certification writes both rows (contract D5)", () => {
  let accreditationId = "";

  it("publishes the questionnaire as its own document", async () => {
    const res = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({
        slug: "accreditation",
        from: "accreditation-self-certification",
        requiresAcceptance: false,
        audience: "external",
      }),
    });
    expect(res.status).toBe(200);
    const detail = await json<DocumentDetail>(res);
    accreditationId = detail.document.id;
    expect(detail.document.kind).toBe("accreditation");
    expect(detail.current?.versionNo).toBe(1);
  });

  it("writes the click-wrap row and the dated `accredited` row, with the expiry only on the second", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: bystander.cookie,
      body: JSON.stringify({
        documentId: accreditationId,
        versionNo: 1,
        accreditation: {
          categories: ["us.income", "us.net_worth"],
          section: "us",
          questionnaireVersion: 1,
        },
      }),
    });
    expect(res.status).toBe(200);

    const held = await rows<{
      kind: string;
      expires_at: string | null;
      signed_at: string;
      data: Record<string, unknown>;
    }>(
      `SELECT kind, expires_at, signed_at, data FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${bystander.membershipId}'::uuid
         AND (kind = 'accreditation:v1' OR kind = 'accredited') ORDER BY kind`,
    );
    /*
     * Two rows, not one, and they must not be collapsed: `<slug>:v<n>` is "this person agreed to
     * this text" and never expires; `accredited` is "this person is accredited as of this date"
     * and is the row the gate reads. Twelve months, on the second only (contract D5).
     */
    expect(held.map((h) => h.kind)).toEqual(["accreditation:v1", "accredited"]);
    const clickwrap = held[0];
    const accredited = held[1];
    expect(clickwrap?.expires_at).toBeNull();
    expect(accredited?.expires_at).not.toBeNull();
    const months =
      (Date.parse(accredited?.expires_at ?? "") - Date.parse(accredited?.signed_at ?? "")) /
      (1000 * 60 * 60 * 24);
    expect(months).toBeGreaterThan(360);
    expect(months).toBeLessThan(370);
    // The categories travel as data, never as a code enum: Rule 501(a)'s list has moved twice in
    // five years and a TypeScript union would make that a migration (design/04 §1.5).
    const answers = accredited?.data["accreditation"] as { categories?: string[] } | undefined;
    expect(answers?.categories).toEqual(["us.income", "us.net_worth"]);
    expect(accredited?.data["method"]).toBe("self_certified");
  });
});

describe("the acceptance register and its export", () => {
  it("lists who accepted what, and pages on a cursor that carries the whole key", async () => {
    const all = await json<{
      items: {
        membershipId: string;
        stamp: string;
        bodySha256: string;
        evidenceRef: string | null;
      }[];
      nextCursor: string | null;
    }>(
      await request("acme", "/api/v1/compliance/acceptances?slug=nda", { cookie: counsel.cookie }),
    );
    // Three rows, not two: the register is keyed on the *acceptance*, not the acceptor, and two
    // different people accepted `nda:v2` above — the invited bystander and the share-link visitor
    // Ada — before the bystander re-accepted `nda:v3` on the version change.
    expect(all.items.map((i) => i.stamp).sort()).toEqual(["nda:v2", "nda:v2", "nda:v3"]);
    expect(new Set(all.items.map((i) => i.membershipId)).size).toBe(2);
    expect(all.items.every((i) => /^[0-9a-f]{64}$/u.test(i.bodySha256))).toBe(true);
    expect(all.items.every((i) => (i.evidenceRef ?? "").startsWith("cert:v1:"))).toBe(true);
    expect(all.nextCursor).toBeNull();
  });

  it("exports CSV with a BOM, CRLF endings and the fixed column order", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances/export?format=csv", {
      cookie: counsel.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toContain("acceptance-register-");
    const raw = Buffer.from(await res.arrayBuffer());
    // Read as bytes: `Response.text()` decodes UTF-8 and silently swallows a leading BOM, so a
    // test that asserted on the string could not tell a file Excel mangles from one it does not.
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = raw.toString("utf8");
    const lines = csv
      .replace(/^\ufeff/u, "")
      .split("\r\n")
      .filter(Boolean);
    expect(lines[0]).toBe(
      "membership_id,document_id,slug,version_no,stamp,body_sha256,accepted_at,evidence_ref",
    );
    // Every acceptance in the workspace, not a page of them: an evidence export that stopped at
    // the first hundred rows would be worse than none, because nobody reading it would know.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(csv).toContain("nda:v3");
    // The self-certification form is a legal document like any other (ADR-0037), so the
    // click-wrap row the D5 test above wrote — "this person agreed to this text" — is register
    // evidence and appears here.
    expect(csv).toContain("accreditation:v1");
    // Its sibling `accredited` row does not, and must not: that is the dated, expiring *status*
    // the server derives, not an acceptance of a document version. `toEntries` keeps the register
    // to `<slug>:v<n>` stamps precisely so a derived fact can never be exported as a signature.
    expect(csv).not.toContain(",accredited,");
  });

  it("neutralises a tenant-controlled value that begins `=` before counsel's spreadsheet runs it", async () => {
    /*
     * `evidence_ref` is adapter-produced and is the register's second tenant-controlled column
     * (the first, `slug`, cannot begin with a formula character — the CHECK on
     * `core.legal_document` sees to that). Setting one here is the only way to reach the escape
     * from outside the pure function, and it is exactly the shape the comment in
     * `register.ts` warns about: Excel, LibreOffice and Sheets all execute a cell beginning `=`.
     */
    const evil = '=HYPERLINK("http://evil.test","open me")';
    await rows(
      `UPDATE core.attestation SET evidence_ref = ${`'${evil.replaceAll("'", "''")}'`}
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${bystander.membershipId}'::uuid
         AND kind = 'nda:v3'`,
    );
    const csv = await (
      await request("acme", "/api/v1/compliance/acceptances/export?format=csv&slug=nda", {
        cookie: counsel.cookie,
      })
    ).text();
    // Prefixed with an apostrophe *inside* the quoted field: visible in the cell, which is the
    // point, and inert.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""open me"")"`);
    expect(csv).not.toContain(`,${evil}`);

    // JSON is the same rows in the same order, and does not need the apostrophe.
    const jsonRes = await request("acme", "/api/v1/compliance/acceptances/export?format=json", {
      cookie: counsel.cookie,
    });
    expect(jsonRes.headers.get("content-type")).toBe("application/json");
    const doc = await json<{
      version: number;
      workspaceId: string;
      count: number;
      filter: Record<string, string | null>;
      entries: { stamp: string; evidenceRef: string | null }[];
    }>(jsonRes);
    expect(doc.version).toBe(1);
    expect(doc.workspaceId).toBe(acmeId);
    expect(doc.count).toBe(doc.entries.length);
    expect(doc.entries.some((e) => e.evidenceRef === evil)).toBe(true);
  });

  it("is staff evidence: an investor cannot export the register at all", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances/export", {
      cookie: ada.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("RLS from the visitor's own seat", () => {
  it("an external member sees no row of `core.share_link` at all", async () => {
    // Staff and system can.
    const asSystem = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link WHERE workspace_id = '${acmeId}'::uuid`,
    );
    expect(asSystem[0]?.n).toBeGreaterThan(0);
    /*
     * Ada holds a live binding to a link she came in through, and still sees nothing. That is how
     * "a visitor must never read `token_hash` or `passcode_hash`" is enforced: Postgres RLS is
     * row-level, so no policy could return the row while withholding two columns, and a
     * share-link visitor *is* an external member (contract A4).
     */
    const asAda = await rowsAsExternal<{ n: number }>(
      acmeId,
      ada.membershipId,
      `SELECT count(*)::int AS n FROM core.share_link`,
    );
    expect(asAda[0]?.n).toBe(0);
  });

  it("an external member sees their own visit row and nobody else's", async () => {
    const own = await rowsAsExternal<{ n: number }>(
      acmeId,
      nick.membershipId,
      `SELECT count(*)::int AS n FROM core.share_link_visit
       WHERE membership_id = '${nick.membershipId}'::uuid`,
    );
    expect(own[0]?.n).toBe(1);
    const other = await rowsAsExternal<{ n: number }>(
      acmeId,
      nick.membershipId,
      `SELECT count(*)::int AS n FROM core.share_link_visit
       WHERE membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(other[0]?.n).toBe(0);
  });

  it("an external member cannot write the authorization edge they are on the end of", async () => {
    // No INSERT and no UPDATE policy at all (contract A5): a member who could write one would
    // grant themselves everything the link carries without the token, the passcode or the OTP.
    await expect(
      rowsAsExternal(
        acmeId,
        nick.membershipId,
        `INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id)
         VALUES ('${acmeId}'::uuid, '${linkA.link.id}'::uuid, '${nick.membershipId}'::uuid)`,
      ),
    ).rejects.toThrow();
    /*
     * An UPDATE the policy does not admit is not an error — it is a statement that matches no
     * rows, which is the quietest possible failure and the reason this is asserted on the row
     * count rather than on a throw. `external` holds `FOR SELECT` only, so the row it can read
     * is a row it cannot write.
     */
    const updated = await rowsAsExternal<{ membership_id: string }>(
      acmeId,
      nick.membershipId,
      `UPDATE core.share_link_visit SET revoked_at = now()
       WHERE membership_id = '${nick.membershipId}'::uuid RETURNING membership_id`,
    );
    expect(updated).toEqual([]);
    // …and the row really is still live, read back as the system actor.
    const live = await rows<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM core.share_link_visit
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${nick.membershipId}'::uuid`,
    );
    expect(live[0]?.revoked_at).toBeNull();
  });

  it("an external member sees no counted-view row, including their own", async () => {
    // `share_link_view` follows `share_link`, not `share_link_visit` (contract A2.4): a visit row
    // is a fact about the visitor, a view row is the meter on a control applied to them, and
    // reading the meter teaches the metering rule.
    const seen = await rowsAsExternal<{ n: number }>(
      acmeId,
      nick.membershipId,
      `SELECT count(*)::int AS n FROM core.share_link_view`,
    );
    expect(seen[0]?.n).toBe(0);
  });
});

describe("cross-tenant replay: 404, never 403", () => {
  it("every id-bearing share-link route answers 404 for another workspace's link", async () => {
    const id = linkE.link.id;
    const calls: [string, () => Promise<Response>][] = [
      [
        "pause",
        () =>
          request("globex", `/api/v1/links/${id}/pause`, {
            method: "POST",
            cookie: globexOwner.cookie,
          }),
      ],
      [
        "resume",
        () =>
          request("globex", `/api/v1/links/${id}/resume`, {
            method: "POST",
            cookie: globexOwner.cookie,
          }),
      ],
      [
        "revoke",
        () =>
          request("globex", `/api/v1/links/${id}/revoke`, {
            method: "POST",
            cookie: globexOwner.cookie,
            body: JSON.stringify({ revokeMemberships: false }),
          }),
      ],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      // A 403 would confirm the resource exists, which is the fact worth hiding.
      expect(res.status, name).toBe(404);
      expect((await json<ErrorBody>(res)).error.code, name).toBe("not_found");
    }
    // Acme's link is untouched by any of it.
    const still = await rows<LinkRow>(
      `SELECT status FROM core.share_link WHERE id = '${id}'::uuid`,
    );
    expect(still[0]?.status).toBe("active");
  });

  it("`GET /links/{id}/visits` answers 200 with an empty list rather than 404 for a foreign id", async () => {
    /*
     * The one id-bearing route that does not follow the rule, recorded rather than worked around.
     * `visits` reads `core.share_link_visit` under the caller's own tenant scope and returns
     * whatever it finds, so an id belonging to another workspace is indistinguishable from a link
     * of one's own that nobody has redeemed. Nothing leaks — the list really is empty — but it is
     * the opposite answer from `pause`, `resume` and `revoke`, which resolve the link first and
     * 404. The fix is a `byId` check before the read, which the other three get for free.
     * Asserted as-built so a change in either direction is visible.
     */
    const res = await request("globex", `/api/v1/links/${linkE.link.id}/visits`, {
      cookie: globexOwner.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{ visits: unknown[] }>(res);
    expect(body).toEqual({ visits: [] });
    // Whatever the status, it must never name acme's visitor.
    expect(JSON.stringify(body)).not.toContain(nick.membershipId);
  });

  it("a token minted for one workspace resolves on no other", async () => {
    for (const path of [`/api/v1/links/${linkE.token}`]) {
      const res = await request("globex", path);
      expect(res.status).toBe(404);
      expect(errorShape(await json<ErrorBody>(res))).toEqual({
        code: "not_found",
        message: "no such link",
      });
    }
    const start = await startLink("globex", linkE.token, { email: "nick@investor.test" });
    expect(start.status).toBe(404);
    const verify = await verifyLink("globex", linkE.token, {
      email: "nick@investor.test",
      code: "123456",
    });
    expect(verify.status).toBe(404);
    // And no membership was created in the wrong workspace by the attempt.
    const leaked = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership WHERE workspace_id = '${globexId}'::uuid
         AND source LIKE 'link:%'`,
      globexId,
    );
    expect(leaked[0]?.n).toBe(0);
  });
});

describe("a link grant is canonicalised like any other rule (review R1-A1/A2, P1-03)", () => {
  /** A folder of its own with one document in it, so nothing earlier in the file sees either. */
  let scopeId = "";
  let scopePath = "";
  const scopeDocId = randomUUID();

  it("sets up a folder with a document filed in it", async () => {
    const root = await json<TreeBody>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    const created = await request("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ parentId: root.rootId, name: "Link scope" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const scope = (await json<TreeBody>(created)).folders.find((f) => f.name === "Link scope");
    scopeId = scope?.id ?? "";
    scopePath = scope?.path ?? "";
    expect(scopePath).toMatch(/^r\.[^.]+$/u);
    await rows(
      `INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
         VALUES ('${scopeDocId}'::uuid, '${acmeId}'::uuid, '${scopeId}'::uuid,
                 '${scopePath}', 'Scoped memo')`,
    );
  });

  it("a folder link sent as `{kind, id}` covers the documents filed in that folder", async () => {
    // Exactly what the web's link form sends: no path. The server derives the folder's own.
    const minted = await mint("acme", owner, {
      label: "Scoped folder",
      grants: [{ resource: { kind: "folder", id: scopeId }, capabilities: ["view"] }],
    });
    expect(minted.res.status).toBe(200);
    if (!minted.minted) throw new Error("no link");
    const rule = await rows<{ resource_path: string | null }>(
      `SELECT resource_path::text AS resource_path FROM core.access_grant
       WHERE subject_kind = 'link' AND subject_id = '${minted.minted.link.id}'::uuid`,
    );
    expect(rule).toEqual([{ resource_path: scopePath }]);
    expect(minted.minted.link.grants[0]?.resource).toEqual({
      kind: "folder",
      id: scopeId,
      path: scopePath,
    });

    const lena = await admit("acme", minted.minted.token, "lena@scope.test");
    const decision = await waitFor(async () => {
      await running.container.authz.rebuild(acmeId);
      const d = await running.container.authz.check(
        { workspaceId: acmeId, membershipId: lena.membershipId },
        { kind: "document", id: scopeDocId, path: scopePath },
        "view",
      );
      return d.allowed ? d : undefined;
    });
    expect(decision.allowed).toBe(true);
  }, 30_000);

  it("refuses a real folder id filed under a forged path (400, nothing written)", async () => {
    const before = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link WHERE workspace_id = '${acmeId}'::uuid`,
    );
    // `r` is the data room's root: the rule would have covered every folder and document.
    for (const path of ["r", financialsPath]) {
      const forged = await mint("acme", owner, {
        label: "Whole room",
        grants: [{ resource: { kind: "folder", id: scopeId, path }, capabilities: ["view"] }],
      });
      expect(forged.res.status, path).toBe(400);
      const body = await json<ErrorBody>(forged.res);
      expect(body.error.reason, path).toBe("resource_path_mismatch");
    }
    // A document is a leaf matched by id: its folder's path is a scope it must not carry.
    const docPath = await mint("acme", owner, {
      label: "Doc as folder",
      grants: [
        { resource: { kind: "document", id: scopeDocId, path: scopePath }, capabilities: ["view"] },
      ],
    });
    expect(docPath.res.status).toBe(400);
    expect((await json<ErrorBody>(docPath.res)).error.reason).toBe("resource_path_mismatch");
    const after = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.share_link WHERE workspace_id = '${acmeId}'::uuid`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("another workspace's folder id is the same 404 as an id nobody minted", async () => {
    const globexFolder = randomUUID();
    await rows(
      `INSERT INTO dataroom.folder (id, workspace_id, name, path)
         VALUES ('${globexFolder}'::uuid, '${globexId}'::uuid, 'Globex secrets', 'r')`,
      globexId,
    );
    const answers: Record<string, unknown>[] = [];
    for (const id of [globexFolder, randomUUID()]) {
      const res = await mint("acme", owner, {
        label: "Somebody else's room",
        grants: [{ resource: { kind: "folder", id }, capabilities: ["view"] }],
      });
      expect(res.res.status).toBe(404);
      answers.push(errorShape(await json<ErrorBody>(res.res)));
    }
    expect(answers[0]).toMatchObject({ code: "not_found", reason: "unknown_resource" });
    expect(answers[0]).toEqual(answers[1]);
  });
});
