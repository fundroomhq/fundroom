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
import { READ_ONLY_EXEMPT, refusesWhileReadOnly } from "./module-read-only.js";
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
  STAFF_ACTORS,
  type SweepOperation,
} from "./test/authz-sweep-plan.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The authz sweep under the most restrictive plan (A-3 / E-UP-2, ADR-0063): CONTROL_PLANE=on and a
 * workspace on a plan with `modules: []` and `features: []`, every optional module switched on —
 * so every optional module is read-only and no gated feature may be turned on. The same operation
 * list and actors as `authz-sweep.integration.test.ts` (`test/authz-sweep-plan.ts`).
 *
 *  1. Every DENY cell answers exactly as in the base sweep — a 402 is only ever produced after
 *     the caller passed the route's own authorization, so the plan is never an oracle.
 *  2. Every staff write of an optional module — permission-guarded, or a `member` route a staff
 *     member writes through (R1 M1) — answers 402 `plan_limit` `{ limit: "module", module }` to a
 *     caller the guard admits — a session and, on key-callable rows, an API key — unless
 *     `refusesWhileReadOnly` lets it through (every DELETE, `READ_ONLY_EXEMPT`), which answers
 *     anything but 402. Refused calls never reach a handler, so the `{}` bodies change nothing;
 *     the allowed ones target ids that match nothing.
 *  3. No GET ever answers 402, whoever asks; and no investor (`member`) or `public` write of an
 *     optional module does either — the same member routes that refuse staff above.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const SLUG = "sweep";
const OTHER = "elsewhere";
const CONCURRENCY = 16;
const OPTIONAL = new Set(COMPILED_IN_MODULES.filter((m) => m.required !== true).map((m) => m.id));
/** `x-requires` words whose guard never refuses for read-only (permission and `member` do). */
const UNGUARDED = new Set(["public", "session", "owner-or-admin"]);

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const cookies = new Map<ActorName, string | undefined>();
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
  if (init.method && init.method !== "GET") headers.set("origin", `https://${slug}.${CANON}`);
  return running.app.request(`https://${slug}.${CANON}${path}`, { ...init, headers });
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
  return { cookie: cookiesOf(verify), userId: session.userId };
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

/** The base sweep's actors, made the same way (see `authz-sweep.integration.test.ts`). */
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
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.session SET auth_time = now() - interval '11 minutes'
           WHERE user_id = '${signedIn.userId}'::uuid AND revoked_at IS NULL`,
      ),
    );
  }
  return cookie;
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
      CONTROL_PLANE: "on",
      ROLES: "api,web",
      UPDATE_CHECK: "false",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  const sweepId = (await createWorkspace(db, { slug: SLUG, name: "Sweep Co" })).id;
  const otherId = (await createWorkspace(db, { slug: OTHER, name: "Elsewhere Co" })).id;

  // Every optional module on, an offering that closes nothing, and the plan that allows nothing.
  const ctx = systemContext(sweepId);
  await db.withTenant(ctx, async (tx) => {
    const repo = new ModuleEnablementRepo(ctx, tx);
    for (const m of COMPILED_IN_MODULES) if (m.required !== true) await repo.set(m.id, true);
    await updateOfferingStatus(tx, sweepId, "506b" as never);
  });
  await db.withHost(async (tx) => {
    await tx.execute(
      `INSERT INTO core.plan (id, name, limits, limits_schema_version)
         VALUES ('nothing', 'Nothing', '{"modules":[],"features":[]}', 2)`,
    );
    await tx.execute(`UPDATE core.workspace SET plan_id = 'nothing' WHERE id = '${sweepId}'`);
  });
  running.container.enablement.invalidate(sweepId);
  running.container.resolver.invalidate();

  cookies.set("anonymous", undefined);
  cookies.set("apiKeyOwner", undefined);
  cookies.set("otherOwner", await member(OTHER, otherId, "owner@elsewhere.test", "staff", "owner"));
  cookies.set(
    "investor",
    await member(SLUG, sweepId, "investor@sweep.test", "external", "investor"),
  );
  for (const role of STAFF_ACTORS)
    cookies.set(role, await member(SLUG, sweepId, `${role}@sweep.test`, "staff", role));
  cookies.set(
    "ownerLevel1",
    await member(SLUG, sweepId, "level1@sweep.test", "staff", "owner", { mfa: false }),
  );
  cookies.set(
    "staleOwner",
    await member(SLUG, sweepId, "stale@sweep.test", "staff", "owner", { staleAuth: true }),
  );
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

  const scopes = apiKeyScopes();
  const { token } = await mintTestApiKey(db, {
    workspaceId: sweepId,
    creatorMembershipId: await membershipIdOf(sweepId, "owner@sweep.test"),
    scopes: scopes.length > 0 ? scopes : ["access.read"],
    name: "sweep",
  });
  authorizations.set("apiKeyOwner", `Bearer ${token}`);

  // The premise: every optional module on and read-only for staff, the plan disclosed to staff.
  const boot = (await (
    await request(SLUG, "/api/v1/modules", { cookie: cookies.get("owner") })
  ).json()) as {
    modules: { id: string; enabled: boolean; readOnly: boolean }[];
    entitlements?: unknown;
  };
  expect(boot.modules.filter((m) => !m.enabled).map((m) => m.id)).toEqual([]);
  expect(
    boot.modules
      .filter((m) => m.readOnly)
      .map((m) => m.id)
      .sort(),
  ).toEqual([...OPTIONAL].sort());
  expect(boot.entitlements).toEqual({ modules: [], features: [] });
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
  limit: string | undefined;
  module: string | undefined;
  feature: string | undefined;
}

async function send(op: SweepOperation, actor: ActorName): Promise<Observed> {
  const res = await request(SLUG, concretePath(op.path), {
    method: op.method,
    cookie: cookies.get(actor),
    authorization: authorizations.get(actor),
    ...(op.method === "GET" ? {} : { body: "{}" }),
  });
  const text = await res.text();
  let error: Record<string, unknown> = {};
  try {
    error = ((JSON.parse(text) as { error?: Record<string, unknown> }).error ?? {}) as Record<
      string,
      unknown
    >;
  } catch {
    // Not JSON (a CSV, a PNG, an HTML page): no error envelope to read.
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    status: res.status,
    code: str(error["code"]),
    reason: str(error["reason"]),
    message: str(error["message"]),
    limit: str(error["limit"]),
    module: str(error["module"]),
    feature: str(error["feature"]),
  };
}

const show = (o: Observed) =>
  `${o.status} ${o.code ?? "-"}${o.reason ? `/${o.reason}` : ""}${o.limit ? ` limit=${o.limit}` : ""}`;

/** The base sweep's denial match (`authz-sweep.integration.test.ts`), verbatim in substance. */
function matchesDenial(
  op: SweepOperation,
  expected: Outcome & { kind: "deny" },
  got: Observed,
): boolean {
  if (got.status !== expected.status || got.code !== expected.code) return false;
  if (expected.reason !== undefined && got.reason !== expected.reason) return false;
  if (expected.code !== "not_found") return true;
  const handler = HANDLER_NOT_FOUND_MESSAGES.get(`${op.method} ${op.path}`);
  return [...AUTHZ_NOT_FOUND_MESSAGES, ...(handler ? [handler] : [])].includes(got.message ?? "");
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

const moduleOf = (op: SweepOperation) => op.path.split("/")[1] ?? "";
const requirementOf = (op: SweepOperation) => op.requires?.split("+")[0] ?? "";
const isStaffWrite = (op: SweepOperation) =>
  op.method !== "GET" &&
  OPTIONAL.has(moduleOf(op)) &&
  op.requires !== undefined &&
  !UNGUARDED.has(requirementOf(op));
/** What the guard decides for `op` while its module is read-only. */
const refused = (op: SweepOperation) =>
  refusesWhileReadOnly(op.method, moduleOf(op), op.path.slice(moduleOf(op).length + 1));

/** Every (operation, actor) cell the base sweep plans. */
function plannedCells(): { op: SweepOperation; actor: ActorName; expected: Outcome }[] {
  const cells: { op: SweepOperation; actor: ActorName; expected: Outcome }[] = [];
  for (const op of listOperations()) {
    const plan = planFor(op);
    if (plan.kind === "unplanned") throw new Error(`${op.method} ${op.path}: ${plan.reason}`);
    if (plan.kind === "skip") continue;
    for (const actor of ACTORS)
      cells.push({ op, actor, expected: plan.cells.get(actor) as Outcome });
  }
  return cells;
}

describe("entitlement sweep (A-3): a plan that allows nothing", () => {
  it("answers every deny cell exactly as the base sweep does — never 402", async () => {
    const cells = plannedCells().filter((c) => c.expected.kind === "deny");
    const mismatches: string[] = [];
    await pool(cells, async ({ op, actor, expected }) => {
      const got = await send(op, actor);
      if (matchesDenial(op, expected as Outcome & { kind: "deny" }, got)) return;
      const known = KNOWN_FINDINGS.get(cellKey(op, actor));
      if (known !== undefined) return;
      mismatches.push(`${op.method.padEnd(6)} ${op.path}  as ${actor}: got ${show(got)}`);
    });
    expect(mismatches.sort(), "deny cells that changed under the plan").toEqual([]);
    expect(cells.length).toBeGreaterThan(1800);
  });

  it("refuses every staff write of an optional module with 402, except DELETE and READ_ONLY_EXEMPT", async () => {
    const sends: { op: SweepOperation; actor: ActorName }[] = [];
    for (const op of listOperations().filter(isStaffWrite)) {
      const plan = planFor(op);
      if (plan.kind !== "sweep") throw new Error(`${op.method} ${op.path} is not swept`);
      // The first staff role the guard admits (fresh and at its MFA level); `owner` on a member route.
      const actor = STAFF_ACTORS.find((a) => plan.cells.get(a)?.kind === "allow");
      if (actor === undefined) throw new Error(`${op.method} ${op.path}: no staff role admitted`);
      sends.push({ op, actor });
      // A key-callable row: the key is refused exactly like its creator's session.
      if (plan.cells.get("apiKeyOwner")?.kind === "allow") sends.push({ op, actor: "apiKeyOwner" });
    }
    const wrong: string[] = [];
    const exemptSeen = new Set<string>();
    let memberRefused = 0;
    await pool(sends, async ({ op, actor }) => {
      const got = await send(op, actor);
      const key = `${op.method} ${op.path}`;
      if (!refused(op)) {
        exemptSeen.add(key);
        if (got.status === 402) wrong.push(`${key} as ${actor}: exempt but got ${show(got)}`);
        return;
      }
      if (requirementOf(op) === "member") memberRefused++;
      const ok =
        got.status === 402 &&
        got.code === "plan_limit" &&
        got.limit === "module" &&
        got.module === moduleOf(op);
      if (!ok) wrong.push(`${key} as ${actor}: expected 402 limit=module, got ${show(got)}`);
    });
    console.info(
      `entitlement sweep: ${sends.length} staff writes over ${new Set(sends.map((s) => s.op.path + s.op.method)).size} operations, ${exemptSeen.size} exempt`,
    );
    expect(wrong.sort()).toEqual([]);
    // Every exemption that is an OpenAPI operation was exercised (raw-only ones have no op here).
    const documented = new Set(listOperations().map((op) => `${op.method} ${op.path}`));
    expect(
      [...READ_ONLY_EXEMPT.keys()].filter((k) => documented.has(k) && !exemptSeen.has(k)),
    ).toEqual([]);
    expect(sends.length).toBeGreaterThan(100);
    // Staff writing through member routes (replies, Q&A questions, round interest, evidence…).
    expect(memberRefused).toBeGreaterThanOrEqual(5);
    expect([...exemptSeen].some((k) => k.startsWith("DELETE "))).toBe(true);
  });

  /*
   * The one GET that may answer 402 (decision 20): the anchoring proof download is the customer-
   * facing surface of the `anchoring` feature, gated after its permission guard. A feature gate,
   * not module read-only — so the only 402 it may give is `{ limit: "feature", feature:
   * "anchoring" }`. Every other GET stays asserted.
   */
  const GET_FEATURE_GATES: ReadonlyMap<string, string> = new Map([
    ["GET /audit/anchors/{checkpointId}/proof", "anchoring"],
  ]);

  it("never answers 402 to a GET (but the anchoring proof), nor to an investor's or a public write", async () => {
    const cells: { op: SweepOperation; actor: ActorName }[] = [];
    for (const { op, actor, expected } of plannedCells()) {
      if (op.method === "GET" && expected.kind !== "deny") cells.push({ op, actor });
    }
    for (const op of listOperations()) {
      if (op.method === "GET" || !OPTIONAL.has(moduleOf(op))) continue;
      if (op.requires === "member" || op.requires?.startsWith("member+"))
        cells.push({ op, actor: "investor" });
      if (op.requires === "public") cells.push({ op, actor: "anonymous" });
    }
    const wrong: string[] = [];
    const gated = new Set<string>();
    await pool(cells, async ({ op, actor }) => {
      const got = await send(op, actor);
      if (got.status !== 402) return;
      const feature = GET_FEATURE_GATES.get(`${op.method} ${op.path}`);
      if (feature !== undefined && got.limit === "feature" && got.feature === feature) {
        gated.add(`${op.method} ${op.path}`);
        return;
      }
      wrong.push(`${op.method} ${op.path} as ${actor}: ${show(got)}`);
    });
    expect(wrong.sort()).toEqual([]);
    expect(cells.some((c) => c.op.method !== "GET")).toBe(true);
    // The exception is exercised, not merely tolerated: an admitted caller does get the 402.
    expect([...gated]).toEqual([...GET_FEATURE_GATES.keys()]);
  });
});
