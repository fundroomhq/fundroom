import type { AppConfig } from "@fundroom/config";
import {
  type AccessReviewEvidence,
  accessReviewEvidence,
  createDatabase,
  type Database,
  type EvidenceWorkspace,
  HOST_ROLE,
  hostRoleStatus,
  listBreakGlassSessions,
  listEvidenceWorkspaces,
  workspaceSlugsById,
} from "@fundroom/db";
import { ACCESS_REVIEW_INTERVAL_DAYS } from "@fundroom/identity";
import type { EntitlementsPort, JsonObject } from "@fundroom/ports";
import { createEntitlements } from "../entitlements.js";
import { sessionJson } from "./break-glass.js";

/*
 * `fundroom evidence …` (E2.10, SOC 2 evidence hooks; docs/compliance/soc2-evidence.md). Read-only
 * JSON on stdout for an auditor's evidence folder; nothing here writes to the database.
 *
 *   access-reviews [--workspace <slug|id>] [--since <date>]
 *       Per live workspace: the last completed access review (when, reviewer, report sha256 —
 *       the digest `core.access_review` stores over the canonical report), the reviews completed
 *       since --since, when the next one is due (last + ACCESS_REVIEW_INTERVAL_DAYS, or the
 *       workspace's creation + the interval when it never had one) and whether it is overdue.
 *       Exit 0 even when reviews are overdue: this is evidence, not a gate. A-3 (ADR-0063): with
 *       CONTROL_PLANE=on, a workspace whose plan does not include `access_reviews` cannot
 *       complete one, so it is `notOnPlan: true` and never `overdue` (nor in `summary.overdue`).
 *   operators [--since <date>]
 *       Database roles with elevated attributes (superuser, BYPASSRLS, login, createrole), who
 *       may switch to seedhost_app / seedhost_host, whether break-glass is available, and the
 *       break-glass sessions opened since --since (default 90 days) plus any still open.
 *   break-glass [--since <date>]
 *       Every break-glass session since --since (default 90 days), with totals.
 *
 * Exit codes: 0 ok, 1 not found, 2 usage.
 */
export const EVIDENCE_USAGE = `usage: fundroom evidence <access-reviews|operators|break-glass> …
  evidence access-reviews [--workspace <slug|id>] [--since <date>]
  evidence operators [--since <date>]
  evidence break-glass [--since <date>]`;

const DAY_MS = 24 * 3600_000;

export interface EvidenceDeps {
  readonly db: Database;
  /** A-3 plan entitlements; absent = every workspace is expected to review (no plans). */
  readonly entitlements?: EntitlementsPort | undefined;
  readonly now?: (() => Date) | undefined;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function parseSince(value: string | undefined): Date | undefined | "invalid" {
  if (value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/** One workspace's access-review evidence; pure over its inputs (unit-tested). */
export function accessReviewEntry(
  ws: EvidenceWorkspace,
  last: AccessReviewEvidence | undefined,
  since: readonly AccessReviewEvidence[],
  now: Date,
  intervalDays: number = ACCESS_REVIEW_INTERVAL_DAYS,
  onPlan = true,
): JsonObject {
  const anchor = Date.parse(last?.completedAt ?? ws.createdAt);
  const dueAt = new Date(anchor + intervalDays * DAY_MS);
  // Not on the plan: the workspace cannot complete a review, so it is never overdue (A-3).
  const overdueMs = onPlan ? now.getTime() - dueAt.getTime() : 0;
  return {
    workspaceId: ws.id,
    slug: ws.slug,
    name: ws.name,
    createdAt: ws.createdAt,
    lastReview: last === undefined ? null : { ...last },
    neverReviewed: last === undefined,
    nextDueAt: dueAt.toISOString(),
    overdue: overdueMs > 0,
    daysOverdue: overdueMs > 0 ? Math.floor(overdueMs / DAY_MS) : 0,
    notOnPlan: !onPlan,
    reviewsInPeriod: since.map((r) => ({ ...r })),
  };
}

async function accessReviews(args: readonly string[], deps: EvidenceDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const since = parseSince(flag(args, "--since"));
  if (since === "invalid") {
    err("--since must be a date (YYYY-MM-DD or ISO 8601)");
    return 2;
  }
  const target = flag(args, "--workspace");
  const workspaces = await listEvidenceWorkspaces(deps.db, target);
  if (target !== undefined && workspaces.length === 0) {
    err(`no live workspace ${target}`);
    return 1;
  }
  const now = (deps.now ?? (() => new Date()))();
  const entries: JsonObject[] = [];
  for (const ws of workspaces) {
    const { last, inPeriod } = await accessReviewEvidence(deps.db, ws.id, since);
    const entitlements = deps.entitlements;
    // Its own short host transaction, after the evidence read closed (never nested).
    const onPlan =
      entitlements === undefined ||
      (await deps.db.withHost((tx) => entitlements.forWorkspace(tx, ws.id))).allowsFeature(
        "access_reviews",
      );
    entries.push(accessReviewEntry(ws, last, inPeriod, now, ACCESS_REVIEW_INTERVAL_DAYS, onPlan));
  }
  out(
    JSON.stringify(
      {
        kind: "access-reviews",
        generatedAt: now.toISOString(),
        intervalDays: ACCESS_REVIEW_INTERVAL_DAYS,
        since: since?.toISOString() ?? null,
        summary: {
          workspaces: entries.length,
          overdue: entries.filter((e) => e["overdue"] === true).length,
          neverReviewed: entries.filter((e) => e["neverReviewed"] === true).length,
          notOnPlan: entries.filter((e) => e["notOnPlan"] === true).length,
        },
        workspaces: entries,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function breakGlassSessions(db: Database, since: Date) {
  const [recent, slugs] = await Promise.all([
    db.withHost((tx) => listBreakGlassSessions(tx, { since, limit: 10_000 })),
    workspaceSlugsById(db),
  ]);
  // Anything still open, however old (an open session older than --since is itself a finding).
  const stillOpen = await db.withHost(async (tx) =>
    (await listBreakGlassSessions(tx, { limit: 10_000 })).filter(
      (s) => s.closedAt === null && s.open,
    ),
  );
  const seen = new Set(recent.map((s) => s.id));
  const all = [...recent, ...stillOpen.filter((s) => !seen.has(s.id))];
  return all.map((s) => sessionJson(s, slugs.get(s.workspaceId)));
}

function defaultSince(now: Date): Date {
  return new Date(now.getTime() - 90 * DAY_MS);
}

async function operators(args: readonly string[], deps: EvidenceDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const parsed = parseSince(flag(args, "--since"));
  if (parsed === "invalid") {
    err("--since must be a date (YYYY-MM-DD or ISO 8601)");
    return 2;
  }
  const now = (deps.now ?? (() => new Date()))();
  const since = parsed ?? defaultSince(now);
  const pool = deps.db.pool;
  const roles = await pool.query(
    `SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS bypass_rls,
            rolcanlogin AS can_login, rolcreaterole AS create_role, rolcreatedb AS create_db,
            rolreplication AS replication, rolvaliduntil AS valid_until
       FROM pg_roles
      WHERE rolname !~ '^pg_'
        AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolreplication
             OR rolname IN ('seedhost_app', $1))
      ORDER BY rolname`,
    [HOST_ROLE],
  );
  const members = await pool.query(
    `SELECT r.rolname AS role, m.rolname AS member, am.admin_option, am.inherit_option, am.set_option,
            g.rolname AS granted_by
       FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
       JOIN pg_roles m ON m.oid = am.member
       LEFT JOIN pg_roles g ON g.oid = am.grantor
      WHERE r.rolname IN ('seedhost_app', $1)
      ORDER BY r.rolname, m.rolname`,
    [HOST_ROLE],
  );
  const who = await pool.query(
    "SELECT current_user::text AS current_user, session_user::text AS session_user, current_setting('server_version') AS server_version",
  );
  const status = await hostRoleStatus(pool);
  const sessions = await breakGlassSessions(deps.db, since);
  out(
    JSON.stringify(
      {
        kind: "operators",
        generatedAt: now.toISOString(),
        connection: who.rows[0] ?? null,
        breakGlass: { role: HOST_ROLE, available: status.ok, problem: status.problem ?? null },
        roles: roles.rows.map((r) => ({
          ...r,
          valid_until: r["valid_until"] == null ? null : iso(r["valid_until"]),
        })),
        memberships: members.rows,
        breakGlassSessions: { since: since.toISOString(), sessions },
      },
      null,
      2,
    ),
  );
  return 0;
}

async function breakGlass(args: readonly string[], deps: EvidenceDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const parsed = parseSince(flag(args, "--since"));
  if (parsed === "invalid") {
    err("--since must be a date (YYYY-MM-DD or ISO 8601)");
    return 2;
  }
  const now = (deps.now ?? (() => new Date()))();
  const since = parsed ?? defaultSince(now);
  const sessions = await breakGlassSessions(deps.db, since);
  const sum = (k: string) => sessions.reduce((n, s) => n + Number(s[k] ?? 0), 0);
  out(
    JSON.stringify(
      {
        kind: "break-glass",
        generatedAt: now.toISOString(),
        since: since.toISOString(),
        summary: {
          sessions: sessions.length,
          open: sessions.filter((s) => s["state"] === "open").length,
          statements: sum("statements"),
          writes: sum("writes"),
          workspaces: new Set(sessions.map((s) => s["workspaceId"])).size,
        },
        sessions,
      },
      null,
      2,
    ),
  );
  return 0;
}

export async function evidenceCommand(
  argv: readonly string[],
  deps: EvidenceDeps,
): Promise<number> {
  const [sub, ...args] = argv;
  if (sub === "access-reviews") return accessReviews(args, deps);
  if (sub === "operators") return operators(args, deps);
  if (sub === "break-glass") return breakGlass(args, deps);
  (deps.err ?? ((l: string) => console.error(l)))(EVIDENCE_USAGE);
  return 2;
}

/** `fundroom evidence …`; `argv` is everything after `evidence`. */
export async function runEvidence(
  argv: readonly string[],
  cfg: Pick<AppConfig, "raw">,
): Promise<number> {
  const [sub] = argv;
  if (sub !== "access-reviews" && sub !== "operators" && sub !== "break-glass") {
    console.error(EVIDENCE_USAGE);
    return 2;
  }
  const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
  try {
    return await evidenceCommand(argv, {
      db,
      entitlements: createEntitlements({ enforced: cfg.raw.CONTROL_PLANE === "on" }),
    });
  } finally {
    await db.close();
  }
}
