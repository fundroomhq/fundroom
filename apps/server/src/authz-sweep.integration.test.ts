import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyScopes } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { mintTestApiKey } from "./test/api-keys.js";
import {
  ACTORS,
  type ActorName,
  AUTHZ_NOT_FOUND_MESSAGES,
  cellKey,
  concretePath,
  HANDLER_NOT_FOUND_MESSAGES,
  KNOWN_FINDINGS,
  listOperations,
  type Outcome,
  planFor,
  type SweepOperation,
} from "./test/authz-sweep-plan.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The behavioural authz sweep (E3.2 WP-SWEEP, ASVS F-30): every non-public OpenAPI operation ×
 * {anonymous, other tenant's owner, investor, owner, admin, editor, viewer, finance, legal, a
 * level-1 and a stale owner, and the liveness actors — an expired and a revoked admin, delegates
 * of scope `all` and `data_room`, and a delegate whose principal is suspended}, against a real
 * server on a real database.
 *
 *  - Every DENIAL cell the matrix predicts is sent, whatever the method: the guard answers before
 *    any validator or handler runs, so an empty `{}` body and a UUID that matches nothing still
 *    get the authz answer, and a cell that is supposed to be refused never reaches a handler that
 *    could change anything. The exact status *and* error code are asserted (401
 *    `unauthenticated`, 404 `not_found` with the middleware's own message, 403 `forbidden`).
 *  - ALLOW cells are sent only for GET operations (no destructive allowed calls): the answer must
 *    not be an authz refusal. A validation error or a 404 for the unknown id is fine.
 *
 * Every module is enabled and the workspace offers under 506(b), so no answer is the enablement
 * or offering-mode 404 instead of the authz one. Every mismatch is collected and reported in one
 * readable failure; accepted ones live in `KNOWN_FINDINGS` (test/authz-sweep-plan.ts).
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const SLUG = "sweep";
const OTHER = "elsewhere";
const CONCURRENCY = 16;

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const cookies = new Map<ActorName, string | undefined>();
/** `Authorization` header per actor: only `apiKeyOwner` (E3.4) has one, and it has no cookie. */
const authorizations = new Map<ActorName, string>();

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; authorization?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

async function signIn(slug: string, email: string): Promise<{ cookie: string; userId: string }> {
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
  const { session } = (await verify.json()) as { session: { userId: string } };
  const cookie = cookiesOf(verify);
  expect((await request(slug, "/api/v1/me", { cookie })).status).toBe(200);
  return { cookie, userId: session.userId };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: string,
  options: {
    mfa?: boolean;
    staleAuth?: boolean;
    delegateOf?: { principalMembershipId: string; scope: "all" | "data_room" };
  } = {},
): Promise<string> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  if (options.delegateOf === undefined) {
    await provisionMembership(deps, {
      workspaceId,
      userId,
      kind,
      role: role as never,
      source: "test",
    });
  } else {
    // A delegate is an ordinary membership row with its principal and scope (core 0017): made
    // here directly, so the sweep does not depend on the delegate routes' request shapes.
    await rowsAsSystem(
      workspaceId,
      `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source,
           principal_membership_id, delegate_scope, activated_at)
         VALUES ('${workspaceId}', '${userId}', 'external', 'delegate', 'active', 'test',
                 '${options.delegateOf.principalMembershipId}', '${options.delegateOf.scope}', now())`,
    );
  }
  const signedIn = await signIn(slug, email);
  const mfa = options.mfa ?? (role === "owner" || role === "admin");
  const cookie = mfa ? await stepUpToMfa(slug, signedIn.cookie) : signedIn.cookie;
  if (options.staleAuth) {
    // Past the 10-minute step-up window (STEP_UP_MAX_AGE_MS), well inside every session lifetime.
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.session SET auth_time = now() - interval '11 minutes'
           WHERE user_id = '${signedIn.userId}'::uuid AND revoked_at IS NULL`,
      ),
    );
  }
  return cookie;
}

async function rowsAsSystem<T = Record<string, unknown>>(
  workspaceId: string,
  query: string,
): Promise<T[]> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

async function membershipIdOf(workspaceId: string, email: string): Promise<string> {
  const [row] = await rowsAsSystem<{ id: string }>(
    workspaceId,
    `SELECT m.id FROM core.membership m JOIN core.user_identity ui ON ui.user_id = m.user_id
      WHERE m.workspace_id = '${workspaceId}'::uuid AND ui.identifier = '${email}'`,
  );
  if (row === undefined) throw new Error(`no membership for ${email}`);
  return row.id;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      UPDATE_CHECK: "false",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    // ~3000 refused requests: `warn` would log every one of them.
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  const sweepId = (await createWorkspace(db, { slug: SLUG, name: "Sweep Co" })).id;
  const otherId = (await createWorkspace(db, { slug: OTHER, name: "Elsewhere Co" })).id;

  // Every module on (metrics, round and crm are `defaultEnabled: false`) and an offering that
  // closes nothing (round and share links 404 under `none` / `informational`).
  const ctx = systemContext(sweepId);
  await db.withTenant(ctx, async (tx) => {
    const repo = new ModuleEnablementRepo(ctx, tx);
    for (const m of COMPILED_IN_MODULES) if (m.required !== true) await repo.set(m.id, true);
    await updateOfferingStatus(tx, sweepId, "506b" as never);
  });
  running.container.enablement.invalidate(sweepId);
  running.container.resolver.invalidate();

  cookies.set("anonymous", undefined);
  // E3.4: a key the owner created with every key scope; the actor sends no cookie at all.
  cookies.set("apiKeyOwner", undefined);
  cookies.set("otherOwner", await member(OTHER, otherId, "owner@elsewhere.test", "staff", "owner"));
  cookies.set(
    "investor",
    await member(SLUG, sweepId, "investor@sweep.test", "external", "investor"),
  );
  for (const role of ["owner", "admin", "editor", "viewer", "finance", "legal"] as const)
    cookies.set(role, await member(SLUG, sweepId, `${role}@sweep.test`, "staff", role));
  cookies.set(
    "ownerLevel1",
    await member(SLUG, sweepId, "level1@sweep.test", "staff", "owner", { mfa: false }),
  );
  cookies.set(
    "staleOwner",
    await member(SLUG, sweepId, "stale@sweep.test", "staff", "owner", { staleAuth: true }),
  );

  // Liveness actors (E3.2 L-3): each signs in while live; its membership (or its principal's)
  // is then changed underneath the session, which is left alive.
  cookies.set(
    "expiredAdmin",
    await member(SLUG, sweepId, "expired-admin@sweep.test", "staff", "admin"),
  );
  cookies.set(
    "revokedAdmin",
    await member(SLUG, sweepId, "revoked-admin@sweep.test", "staff", "admin"),
  );
  const investorId = await membershipIdOf(sweepId, "investor@sweep.test");
  cookies.set(
    "delegateAll",
    await member(SLUG, sweepId, "delegate-all@sweep.test", "external", "delegate", {
      delegateOf: { principalMembershipId: investorId, scope: "all" },
    }),
  );
  cookies.set(
    "delegateDataRoom",
    await member(SLUG, sweepId, "delegate-dr@sweep.test", "external", "delegate", {
      delegateOf: { principalMembershipId: investorId, scope: "data_room" },
    }),
  );
  const { userId: principalUser } = await provisionUser(running.container.identityDeps, {
    email: "suspended-principal@sweep.test",
    displayName: "Suspended principal",
  });
  const principalId = (
    await provisionMembership(running.container.identityDeps, {
      workspaceId: sweepId,
      userId: principalUser,
      kind: "external",
      role: "investor",
      source: "test",
    })
  ).id;
  cookies.set(
    "orphanDelegate",
    await member(SLUG, sweepId, "orphan-delegate@sweep.test", "external", "delegate", {
      delegateOf: { principalMembershipId: principalId, scope: "all" },
    }),
  );
  const expiredId = await membershipIdOf(sweepId, "expired-admin@sweep.test");
  const revokedId = await membershipIdOf(sweepId, "revoked-admin@sweep.test");
  await rowsAsSystem(
    sweepId,
    `UPDATE core.membership SET expires_at = now() - interval '1 minute' WHERE id = '${expiredId}'`,
  );
  await rowsAsSystem(
    sweepId,
    `UPDATE core.membership SET status = 'revoked', revoked_at = now() WHERE id = '${revokedId}'`,
  );
  await rowsAsSystem(
    sweepId,
    `UPDATE core.membership SET status = 'suspended' WHERE id = '${principalId}'`,
  );
  // Still signed in: the sessions answer a `session` route, so every 404 below is the guard's.
  for (const actor of ["expiredAdmin", "revokedAdmin", "orphanDelegate"] as const) {
    const me = await request(SLUG, "/api/v1/me", { cookie: cookies.get(actor) });
    expect(me.status, actor).toBe(200);
  }

  const scopes = apiKeyScopes();
  const { token } = await mintTestApiKey(db, {
    workspaceId: sweepId,
    creatorMembershipId: await membershipIdOf(sweepId, "owner@sweep.test"),
    // The DB refuses an empty scope list; before any row is key-callable, a harmless one.
    scopes: scopes.length > 0 ? scopes : ["access.read"],
    name: "sweep",
  });
  authorizations.set("apiKeyOwner", `Bearer ${token}`);
  const keyed = await request(SLUG, "/api/v1/me", { authorization: `Bearer ${token}` });
  expect(keyed.status).toBe(401);

  const boot = (await (
    await request(SLUG, "/api/v1/modules", { cookie: cookies.get("owner") })
  ).json()) as { modules: { id: string; enabled: boolean }[] };
  expect(boot.modules.filter((m) => !m.enabled).map((m) => m.id)).toEqual([]);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

interface Observed {
  status: number;
  code: string | undefined;
  reason: string | undefined;
  message: string | undefined;
}

async function send(
  op: SweepOperation,
  actor: ActorName,
  /** E3.10: send this cookie instead of the actor's (the platform operator's sessions). */
  cookieOverride?: string,
): Promise<Observed> {
  const res = await request(SLUG, concretePath(op.path), {
    method: op.method,
    cookie: cookieOverride ?? cookies.get(actor),
    authorization: cookieOverride === undefined ? authorizations.get(actor) : undefined,
    ...(op.method === "GET" ? {} : { body: "{}" }),
  });
  let code: string | undefined;
  let reason: string | undefined;
  let message: string | undefined;
  const text = await res.text();
  try {
    const body = JSON.parse(text) as {
      error?: { code?: string; reason?: unknown; message?: string };
    };
    code = body.error?.code;
    reason = typeof body.error?.reason === "string" ? body.error.reason : undefined;
    message = body.error?.message;
  } catch {
    // Not JSON (a CSV, a PNG, an HTML page): no error envelope to read.
  }
  return { status: res.status, code, reason, message };
}

const SHOWN_REASONS = new Set(["level", "fresh", "api_key_not_allowed", "scope_missing"]);
const show = (o: Observed) =>
  `${o.status} ${o.code ?? "-"}${o.reason !== undefined && SHOWN_REASONS.has(o.reason) ? `/${o.reason}` : ""}`;
const describeOutcome = (o: Outcome) =>
  o.kind === "allow"
    ? "allowed"
    : o.kind === "admit"
      ? "admitted by the guard"
      : `${o.status} ${o.code}${o.reason ? `/${o.reason}` : ""}`;

function matchesDenial(
  op: SweepOperation,
  expected: Outcome & { kind: "deny" },
  got: Observed,
): boolean {
  if (got.status !== expected.status || got.code !== expected.code) return false;
  if (expected.reason !== undefined && got.reason !== expected.reason) return false;
  if (expected.code !== "not_found") return true;
  // A 404 must be the guard's, not the handler's "no such document" for the fake id.
  const handler = HANDLER_NOT_FOUND_MESSAGES.get(`${op.method} ${op.path}`);
  return [...AUTHZ_NOT_FOUND_MESSAGES, ...(handler ? [handler] : [])].includes(got.message ?? "");
}

/** Any answer an authz layer gives: the thing an allowed cell must never see. */
function isAuthzRefusal(got: Observed): boolean {
  if (got.status === 401) return true;
  if (got.status === 403)
    return ["forbidden", "step_up_required", "legal_acceptance_required"].includes(got.code ?? "");
  if (got.status === 404)
    return (
      got.code === "module_disabled" ||
      (got.code === "not_found" && AUTHZ_NOT_FOUND_MESSAGES.includes(got.message ?? ""))
    );
  return false;
}

/**
 * A refusal only the kernel guard gives (not a handler's delegate-scope `forbidden`): what an
 * `admit` cell must never see.
 */
function isGuardRefusal(got: Observed): boolean {
  if (got.status === 403 && got.code === "forbidden") return false;
  return isAuthzRefusal(got);
}

async function pool<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await worker(item);
      }
    }),
  );
}

describe("authz sweep (F-30)", () => {
  it("every operation × actor answers as the matrix says", async () => {
    const started = Date.now();
    const cells: { op: SweepOperation; actor: ActorName; expected: Outcome }[] = [];
    let skipped = 0;
    for (const op of listOperations()) {
      const plan = planFor(op);
      if (plan.kind === "unplanned") throw new Error(`${op.method} ${op.path}: ${plan.reason}`);
      if (plan.kind === "skip") {
        skipped++;
        continue;
      }
      for (const actor of ACTORS) {
        const expected = plan.cells.get(actor) as Outcome;
        // Allowed cells only where nothing can change: GET.
        if (expected.kind !== "deny" && op.method !== "GET") continue;
        cells.push({ op, actor, expected });
      }
    }

    const mismatches: string[] = [];
    const accepted = new Set<string>();
    const serverErrors: string[] = [];
    await pool(cells, async ({ op, actor, expected }) => {
      const got = await send(op, actor);
      const ok =
        expected.kind === "deny"
          ? matchesDenial(op, expected, got)
          : expected.kind === "admit"
            ? !isGuardRefusal(got)
            : !isAuthzRefusal(got);
      if (got.status >= 500) serverErrors.push(`${op.method} ${op.path} as ${actor}: ${show(got)}`);
      if (ok) return;
      const k = cellKey(op, actor);
      const known = KNOWN_FINDINGS.get(k);
      if (known !== undefined && known.got === show(got)) {
        accepted.add(k);
        return;
      }
      mismatches.push(
        `${op.method.padEnd(6)} ${op.path}  as ${actor}: expected ${describeOutcome(expected)}, got ${show(got)}${got.message ? ` (${got.message})` : ""}`,
      );
    });

    const denials = cells.filter((c) => c.expected.kind === "deny").length;
    const stale = [...KNOWN_FINDINGS.keys()].filter((k) => !accepted.has(k));
    console.info(
      `authz sweep: ${cells.length} cells (${denials} denials, ${cells.length - denials} allowed GETs) over ${
        new Set(cells.map((c) => `${c.op.method} ${c.op.path}`)).size
      } operations, ${skipped} public/skipped, ${accepted.size} known findings, ${Date.now() - started} ms`,
    );
    if (serverErrors.length > 0)
      console.warn(`5xx answers (not authz):\n${serverErrors.sort().join("\n")}`);

    expect(
      mismatches.sort(),
      `${mismatches.length} (method, path, actor) cells disagree with authz-matrix.yaml`,
    ).toEqual([]);
    expect(stale, "KNOWN_FINDINGS entries that no longer reproduce: remove them").toEqual([]);
    expect(denials).toBeGreaterThan(1800);
  });

  /*
   * E3.10: a live platform operator holding an operator session (`__Host-op_sid`, and the same
   * token replayed in the tenant `__Host-sid`) is nobody on a tenant host: every operation answers
   * exactly what it answers the anonymous actor — 401 on tenant routes, the plain 404 on the
   * operator surface (a tenant host is never the canonical one). The operator session grants no
   * membership, no permission and no session.
   */
  it("an operator session is anonymous on every tenant operation", async () => {
    const { db, auth, identityDeps } = running.container;
    const { userId } = await provisionUser(identityDeps, {
      email: "operator@platform.test",
      displayName: "Operator",
    });
    await db.withHost((tx) =>
      tx.execute(
        `INSERT INTO core.platform_operator (user_id, created_by) VALUES ('${userId}', 'cli:sweep')`,
      ),
    );
    const minted = await auth.sessions.startSession({
      userId,
      population: "operator",
      context: "first_party",
      authLevel: 2,
    });
    const cookie = `__Host-op_sid=${minted.token}; __Host-sid=${minted.token}`;
    const cells: { op: SweepOperation; expected: Outcome & { kind: "deny" } }[] = [];
    for (const op of listOperations()) {
      const plan = planFor(op);
      if (plan.kind !== "sweep") continue;
      const expected = plan.cells.get("anonymous") as Outcome;
      if (expected.kind !== "deny") continue;
      cells.push({ op, expected });
    }
    const mismatches: string[] = [];
    await pool(cells, async ({ op, expected }) => {
      const got = await send(op, "anonymous", cookie);
      if (matchesDenial(op, expected, got)) return;
      const known = KNOWN_FINDINGS.get(cellKey(op, "anonymous"));
      if (known !== undefined && known.got === show(got)) return;
      mismatches.push(
        `${op.method.padEnd(6)} ${op.path}  as operator: expected ${describeOutcome(expected)}, got ${show(got)}`,
      );
    });
    expect(mismatches.sort(), "operator-session cells that differ from anonymous").toEqual([]);
    expect(cells.length).toBeGreaterThan(300);
  });
});
