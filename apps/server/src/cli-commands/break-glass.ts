import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { type AuditInput, type AuditRecorder, createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import {
  activateBreakGlassSession,
  BREAK_GLASS_MAX_MINUTES,
  BreakGlassInputError,
  type BreakGlassSession,
  BreakGlassStatementError,
  type BreakGlassStatementResult,
  checkBreakGlassStatement,
  claimBreakGlassStatement,
  closeBreakGlassSession,
  createDatabase,
  type Database,
  findBreakGlassSession,
  findWorkspaceById,
  findWorkspaceBySlug,
  hostRoleStatus,
  insertBreakGlassSession,
  listBreakGlassSessions,
  listWorkspaceOwnerContacts,
  type OwnerContact,
  platformContext,
  runBreakGlassStatement,
  systemContext,
  validateOpenInput,
  vetBreakGlassStatement,
} from "@fundroom/db";
import { t } from "@fundroom/i18n";
import type { JsonObject, MailerPort } from "@fundroom/ports";
import pino from "pino";

/*
 * `fundroom break-glass` (E2.10; design/02 "Break-glass", EXECUTION_PLAN §10 Audit row) — the
 * host operator's only sanctioned way past row-level security.
 *
 *   open  --workspace <slug|id> --ticket <ref> --reason <text> [--minutes <1-60>] [--operator <name>]
 *   sql   --session <id> (--query "<sql>" | --file <path>) [--write] [--format json|table] [--max-rows n]
 *   close --session <id>
 *   list  [--workspace <slug|id>] [--since <iso-date>] [--json]
 *
 * Every step fails closed and is recorded twice: in the session's workspace chain, where the
 * tenant can see it, and in the platform chain. What each chain gets:
 *
 *  - open    the session row is created *pending* (unusable) together with `host.break_glass`
 *            (ticket, reason, operator, OS user, window) in the tenant chain, then the platform
 *            chain, then every active or dormant owner is mailed (transactional stream: a
 *            security notice is never suppressed) and `host.break_glass_notified` (recipients,
 *            delivered, failed) is recorded. Only then is the session activated. When owners
 *            exist and not one message was delivered, the session is closed instead
 *            (`notification_failed`) and the command exits 1: access nobody was told about does
 *            not start — and a crash anywhere before activation leaves it pending until it
 *            expires. A workspace with no owner at all opens with a warning (fixing that may be
 *            the reason for the ticket) and says `recipients: 0`.
 *  - sql     Postgres first checks that the text is one preparable statement (nothing recorded
 *            when it is not: exit 2). BEFORE running: the session counter is bumped (refused by the database once the
 *            session is closed or past `expires_at` by *its* clock) and `host.break_glass_statement`
 *            is written — so nothing runs unrecorded even if the process dies mid-statement.
 *            AFTER: `host.break_glass_result` (outcome, command, row count, duration). The tenant
 *            chain gets the statement's SHA-256 and size, never its text: operator SQL can carry
 *            literals from *other* workspaces (an email, an id) and the tenant log must not leak
 *            them. The platform chain gets the text (first 16 KiB) as well, so a hash quoted by a
 *            tenant can be matched to the statement. A `--write` statement that committed — or
 *            whose COMMIT outcome is unknown — also mails the owners, even when recording its
 *            result failed.
 *  - close   `host.break_glass_closed` (statements, writes).
 *
 * Trust model (docs/runbooks/break-glass.md): `seedhost_host` bypasses RLS, so a statement can
 * read any workspace; the session declares which tenant is being investigated and makes the
 * access visible to it. It is not a boundary against the operator, who holds DATABASE_URL.
 *
 * Exit codes: 0 ok, 1 refused / failed / not found, 2 usage.
 */
export const BREAK_GLASS_USAGE = `usage: fundroom break-glass <open|sql|close|list> …
  break-glass open --workspace <slug|id> --ticket <ref> --reason <text> [--minutes <1-60>] [--operator <name>]
  break-glass sql --session <id> (--query <sql> | --file <path>) [--write] [--format json|table] [--max-rows <n>]
  break-glass close --session <id>
  break-glass list [--workspace <slug|id>] [--since <date>] [--json]`;

export interface BreakGlassDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly mailer: MailerPort;
  /** The OS account running the CLI (recorded next to `--operator`). */
  readonly osUser: string;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
  readonly readFile?: ((path: string) => string) | undefined;
  /** Upper bound per statement (the session window lowers it). Default 60 s. */
  readonly statementTimeoutMs?: number | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Platform-chain copy of the statement text. */
const PLATFORM_SQL_CHARS = 16 * 1024;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function state(s: BreakGlassSession): "open" | "pending" | "expired" | "closed" {
  if (s.closedAt !== null) return "closed";
  if (s.open) return "open";
  return s.notifiedAt === null && s.expiresAt.getTime() > Date.now() ? "pending" : "expired";
}

function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The facts every audit row of a session carries. */
function sessionMeta(s: BreakGlassSession): JsonObject {
  return {
    via: "cli",
    sessionId: s.id,
    ticket: s.ticket,
    operator: s.operator,
    osUser: s.osUser,
  };
}

async function resolveWorkspace(db: Database, target: string) {
  return UUID_RE.test(target)
    ? findWorkspaceById(db, target.toLowerCase())
    : findWorkspaceBySlug(db, target.toLowerCase());
}

/** Tenant chain inside `tx`-less flows: one transaction per row, as the system actor. */
async function auditBoth(
  deps: BreakGlassDeps,
  workspaceId: string,
  tenant: Omit<AuditInput, "actorKind">,
  platformExtra: JsonObject = {},
): Promise<void> {
  await deps.audit.recordDetached(systemContext(workspaceId), { ...tenant, actorKind: "host" });
  await deps.audit.recordDetached(platformContext(), {
    ...tenant,
    actorKind: "host",
    meta: { ...(tenant.meta ?? {}), workspaceId, ...platformExtra },
  });
}

interface MailOutcome {
  readonly recipients: number;
  readonly delivered: number;
  readonly failed: number;
}

async function mailOwners(
  deps: BreakGlassDeps,
  workspaceId: string,
  owners: readonly OwnerContact[],
  compose: (locale: string) => { subject: string; title: string; paragraphs: string[] },
  tags: readonly string[],
): Promise<MailOutcome> {
  const err = deps.err ?? ((l: string) => console.error(l));
  let delivered = 0;
  for (const owner of owners) {
    const m = compose(owner.locale);
    try {
      await deps.mailer.send({
        to: owner.email,
        subject: m.subject,
        text: [m.title, ...m.paragraphs].join("\n\n"),
        template: {
          name: "notification",
          props: { title: m.title, paragraphs: m.paragraphs, locale: owner.locale },
        },
        tags: [...tags],
        // A security notice: never suppressed, never a digest.
        stream: "transactional",
        workspaceId,
      });
      delivered += 1;
    } catch (error) {
      err(
        `could not notify owner membership ${owner.membershipId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { recipients: owners.length, delivered, failed: owners.length - delivered };
}

async function open(args: readonly string[], deps: BreakGlassDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const target = flag(args, "--workspace");
  const ticket = flag(args, "--ticket");
  const reason = flag(args, "--reason");
  const minutesArg = flag(args, "--minutes");
  if (target === undefined || ticket === undefined || reason === undefined) {
    err(BREAK_GLASS_USAGE);
    return 2;
  }
  const minutes = minutesArg === undefined ? BREAK_GLASS_MAX_MINUTES : Number(minutesArg);
  const operator = flag(args, "--operator") ?? deps.osUser;
  const input = { workspaceId: "", ticket, reason, operator, osUser: deps.osUser, minutes };
  try {
    validateOpenInput(input);
  } catch (error) {
    if (error instanceof BreakGlassInputError) {
      err(error.message);
      return 2;
    }
    throw error;
  }
  const role = await hostRoleStatus(deps.db.pool);
  if (!role.ok) {
    err(`break-glass is unavailable: ${role.problem}`);
    return 1;
  }
  const ws = await resolveWorkspace(deps.db, target);
  if (ws === undefined) {
    err(`no live workspace ${target}`);
    return 1;
  }
  const ctx = systemContext(ws.id);
  const { session, owners } = await deps.db.withTenant(ctx, async (tx) => {
    const session = await insertBreakGlassSession(tx, { ...input, workspaceId: ws.id });
    await deps.audit.record(tx, ctx, {
      action: "host.break_glass",
      actorKind: "host",
      resourceKind: "break_glass_session",
      resourceId: session.id,
      meta: {
        ...sessionMeta(session),
        phase: "opened",
        reason: session.reason,
        openedAt: session.openedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      },
    });
    return { session, owners: await listWorkspaceOwnerContacts(tx) };
  });
  await deps.audit.recordDetached(platformContext(), {
    action: "host.break_glass",
    actorKind: "host",
    resourceKind: "break_glass_session",
    resourceId: session.id,
    meta: {
      ...sessionMeta(session),
      phase: "opened",
      workspaceId: ws.id,
      reason: session.reason,
      expiresAt: session.expiresAt.toISOString(),
    },
  });

  const mailed = await mailOwners(
    deps,
    ws.id,
    owners,
    (locale) => ({
      subject: t(locale, "security.break_glass.subject", { workspace: ws.name }),
      title: t(locale, "security.break_glass.title", { workspace: ws.name }),
      paragraphs: [
        t(locale, "security.break_glass.intro", { workspace: ws.name }),
        t(locale, "security.break_glass.ticket", { ticket: session.ticket }),
        t(locale, "security.break_glass.reason", { reason: session.reason }),
        t(locale, "security.break_glass.operator", { operator: session.operator }),
        t(locale, "security.break_glass.expires", { expires: utc(session.expiresAt) }),
        t(locale, "security.break_glass.audit"),
      ],
    }),
    ["security", "break-glass"],
  );
  await auditBoth(deps, ws.id, {
    action: "host.break_glass_notified",
    resourceKind: "break_glass_session",
    resourceId: session.id,
    outcome: mailed.recipients > 0 && mailed.delivered === 0 ? "failure" : "success",
    meta: { ...sessionMeta(session), ...mailed },
  });

  if (mailed.recipients > 0 && mailed.delivered === 0) {
    // Never activated, so nothing could have run on it.
    const closed = await deps.db.withTenant(ctx, (tx) =>
      closeBreakGlassSession(tx, session.id, "notification_failed"),
    );
    await auditBoth(deps, ws.id, {
      action: "host.break_glass_closed",
      resourceKind: "break_glass_session",
      resourceId: session.id,
      meta: {
        ...sessionMeta(session),
        closeReason: "notification_failed",
        statements: closed?.statements ?? 0,
        writes: closed?.writes ?? 0,
      },
    });
    err(
      `no owner of ${ws.slug} could be notified (${mailed.recipients} tried); the session was closed. Fix outbound mail and open a new one.`,
    );
    return 1;
  }
  // Recorded in both chains and the owners were told: only now can a statement run on it.
  const active = await deps.db.withTenant(ctx, (tx) => activateBreakGlassSession(tx, session.id));
  if (active === undefined) {
    err(`break-glass session ${session.id} expired or was closed before it could be activated`);
    return 1;
  }
  if (mailed.recipients === 0) {
    err(`warning: ${ws.slug} has no active owner with an email address; nobody was notified.`);
  } else if (mailed.failed > 0) {
    err(`warning: ${mailed.failed} of ${mailed.recipients} owner notification(s) failed.`);
  }
  out(session.id);
  err(
    `break-glass session ${session.id} open on ${ws.slug} (${ws.id}) until ${session.expiresAt.toISOString()} (database clock); ticket ${session.ticket}; ${mailed.delivered} owner(s) notified.`,
  );
  return 0;
}

function formatTable(result: BreakGlassStatementResult): string {
  if (result.fields.length === 0) return `${result.command} ${result.rowCount}`;
  const cell = (v: unknown): string =>
    v === null || v === undefined
      ? ""
      : v instanceof Date
        ? v.toISOString()
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
  const rows = result.rows.map((r) => result.fields.map((f) => cell(r[f]).replace(/\s+/gu, " ")));
  const widths = result.fields.map((f, i) =>
    Math.min(60, Math.max(f.length, ...rows.map((r) => (r[i] ?? "").length))),
  );
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i] ?? 0)).join(" | ");
  return [
    line(result.fields),
    widths.map((w) => "-".repeat(w)).join("-+-"),
    ...rows.map(line),
    `(${result.rowCount} row${result.rowCount === 1 ? "" : "s"}${result.truncated ? ", output truncated" : ""})`,
  ].join("\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function sqlCommand(args: readonly string[], deps: BreakGlassDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const sessionId = flag(args, "--session");
  const query = flag(args, "--query");
  const file = flag(args, "--file");
  const write = args.includes("--write");
  const format = flag(args, "--format") ?? "json";
  const maxRowsArg = flag(args, "--max-rows");
  const maxRows = maxRowsArg === undefined ? 1000 : Number(maxRowsArg);
  if (
    sessionId === undefined ||
    !UUID_RE.test(sessionId) ||
    (query === undefined) === (file === undefined) ||
    (format !== "json" && format !== "table") ||
    !Number.isInteger(maxRows) ||
    maxRows < 1
  ) {
    err(BREAK_GLASS_USAGE);
    return 2;
  }
  let text: string;
  try {
    text =
      query ??
      (deps.readFile ?? ((p: string) => readFileSync(p, "utf8")))(file as string).trimEnd();
  } catch (error) {
    err(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  // A trailing semicolon is harmless; anything after it is a second statement (refused later).
  text = text.replace(/;\s*$/u, "");
  let verb: string;
  try {
    verb = checkBreakGlassStatement(text, write);
  } catch (error) {
    if (error instanceof BreakGlassStatementError) {
      err(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const role = await hostRoleStatus(deps.db.pool);
  if (!role.ok) {
    err(`break-glass is unavailable: ${role.problem}`);
    return 1;
  }
  // Postgres decides what the text is (one preparable statement), before anything is recorded.
  try {
    await vetBreakGlassStatement(deps.db.pool, text);
  } catch (error) {
    if (error instanceof BreakGlassStatementError) {
      err(`${error.code === "refused" ? "refused" : "statement failed"}: ${error.message}`);
      return error.code === "refused" ? 2 : 1;
    }
    throw error;
  }
  const found = await deps.db.withHost((tx) => findBreakGlassSession(tx, sessionId.toLowerCase()));
  if (found === undefined) {
    err(`no break-glass session ${sessionId}`);
    return 1;
  }
  const ws = found.workspaceId;
  const ctx = systemContext(ws);
  const sha256 = sha256Hex(text);
  const bytes = Buffer.byteLength(text, "utf8");
  const statementMeta: JsonObject = { sha256, bytes, verb, write };
  // Counted and recorded BEFORE it runs; refused by the database when closed or expired.
  const claimed = await deps.db.withTenant(ctx, async (tx) => {
    const s = await claimBreakGlassStatement(tx, found.id, write);
    if (s === undefined) return undefined;
    await deps.audit.record(tx, ctx, {
      action: "host.break_glass_statement",
      actorKind: "host",
      resourceKind: "break_glass_session",
      resourceId: s.id,
      meta: { ...sessionMeta(s), ...statementMeta, statement: s.statements },
    });
    return s;
  });
  if (claimed === undefined) {
    err(`break-glass session ${found.id} is ${state(found)}; open a new one`);
    return 1;
  }
  await deps.audit.recordDetached(platformContext(), {
    action: "host.break_glass_statement",
    actorKind: "host",
    resourceKind: "break_glass_session",
    resourceId: claimed.id,
    meta: {
      ...sessionMeta(claimed),
      ...statementMeta,
      statement: claimed.statements,
      workspaceId: ws,
      sql: text.slice(0, PLATFORM_SQL_CHARS),
      sqlTruncated: text.length > PLATFORM_SQL_CHARS,
    },
  });

  let result: BreakGlassStatementResult | undefined;
  let failure: BreakGlassStatementError | undefined;
  try {
    result = await runBreakGlassStatement(deps.db.pool, {
      sessionId: claimed.id,
      workspaceId: ws,
      sql: text,
      write,
      statementTimeoutMs: deps.statementTimeoutMs,
      maxRows,
    });
  } catch (error) {
    if (!(error instanceof BreakGlassStatementError)) throw error;
    failure = error;
  }
  // What the statement reported: after a COMMIT whose outcome is unknown, too.
  const reported = result ?? failure?.result;
  // The result is recorded and — for a write that committed or may have — the owners are told,
  // each independently: a failure to record the result must not keep the owners in the dark.
  let auditError: unknown;
  try {
    await auditBoth(deps, ws, {
      action: "host.break_glass_result",
      resourceKind: "break_glass_session",
      resourceId: claimed.id,
      outcome: result === undefined ? "failure" : "success",
      meta: {
        ...sessionMeta(claimed),
        ...statementMeta,
        statement: claimed.statements,
        ...(result === undefined ? { error: failure?.code ?? "failed" } : {}),
        ...(reported === undefined
          ? {}
          : {
              command: reported.command,
              rowCount: reported.rowCount,
              durationMs: reported.durationMs,
            }),
      },
    });
  } catch (error) {
    auditError = error;
    err(
      `could not record the statement's result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (write && reported !== undefined) {
    const ctxOwners = await deps.db.withTenant(ctx, (tx) => listWorkspaceOwnerContacts(tx));
    const wsRow = await findWorkspaceById(deps.db, ws);
    const name = wsRow?.name ?? ws;
    const mailed = await mailOwners(
      deps,
      ws,
      ctxOwners,
      (locale) => ({
        subject: t(locale, "security.break_glass_write.subject", { workspace: name }),
        title: t(locale, "security.break_glass_write.title", { workspace: name }),
        paragraphs: [
          t(locale, "security.break_glass_write.intro", {
            session: claimed.id,
            ticket: claimed.ticket,
            verb: reported.command || verb.toUpperCase(),
            count: reported.rowCount,
          }),
          t(locale, "security.break_glass_write.audit", { sha256 }),
        ],
      }),
      ["security", "break-glass", "write"],
    );
    await auditBoth(deps, ws, {
      action: "host.break_glass_notified",
      resourceKind: "break_glass_session",
      resourceId: claimed.id,
      outcome: mailed.recipients > 0 && mailed.delivered === 0 ? "failure" : "success",
      meta: { ...sessionMeta(claimed), sha256, statement: claimed.statements, ...mailed },
    });
    if (mailed.failed > 0 || mailed.recipients === 0) {
      err(
        `warning: ${mailed.delivered} of ${mailed.recipients} owner(s) were told about this write.`,
      );
    }
  }
  if (auditError !== undefined) throw auditError;
  if (result === undefined) {
    err(`statement failed (${failure?.code}): ${failure?.message}`);
    return 1;
  }

  if (format === "table") out(formatTable(result));
  else
    out(
      JSON.stringify(
        {
          command: result.command,
          rowCount: result.rowCount,
          fields: result.fields,
          rows: result.rows,
          truncated: result.truncated,
        },
        jsonReplacer,
        2,
      ),
    );
  err(
    `${result.command} ${result.rowCount} in ${result.durationMs} ms (statement ${claimed.statements} of session ${claimed.id}, sha256 ${sha256})`,
  );
  return 0;
}

async function close(args: readonly string[], deps: BreakGlassDeps): Promise<number> {
  const err = deps.err ?? ((l: string) => console.error(l));
  const sessionId = flag(args, "--session");
  if (sessionId === undefined || !UUID_RE.test(sessionId)) {
    err(BREAK_GLASS_USAGE);
    return 2;
  }
  const found = await deps.db.withHost((tx) => findBreakGlassSession(tx, sessionId.toLowerCase()));
  if (found === undefined) {
    err(`no break-glass session ${sessionId}`);
    return 1;
  }
  const closed = await deps.db.withTenant(systemContext(found.workspaceId), (tx) =>
    closeBreakGlassSession(tx, found.id, "closed"),
  );
  if (closed === undefined) {
    err(`break-glass session ${found.id} is already closed`);
    return 1;
  }
  await auditBoth(deps, found.workspaceId, {
    action: "host.break_glass_closed",
    resourceKind: "break_glass_session",
    resourceId: closed.id,
    meta: {
      ...sessionMeta(closed),
      closeReason: "closed",
      expiredBeforeClose: !found.open,
      statements: closed.statements,
      writes: closed.writes,
    },
  });
  err(
    `closed break-glass session ${closed.id}: ${closed.statements} statement(s), ${closed.writes} write(s)`,
  );
  return 0;
}

/** One session as the listings print it (`list --json`, `fundroom evidence break-glass`). */
export function sessionJson(s: BreakGlassSession, slug?: string): JsonObject {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    ...(slug === undefined ? {} : { workspaceSlug: slug }),
    ticket: s.ticket,
    reason: s.reason,
    operator: s.operator,
    osUser: s.osUser,
    openedAt: s.openedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    closeReason: s.closeReason,
    state: state(s),
    statements: s.statements,
    writes: s.writes,
    lastStatementAt: s.lastStatementAt?.toISOString() ?? null,
  };
}

async function list(args: readonly string[], deps: BreakGlassDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const target = flag(args, "--workspace");
  const sinceArg = flag(args, "--since");
  const since = sinceArg === undefined ? undefined : new Date(sinceArg);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    err("--since must be a date (YYYY-MM-DD or ISO 8601)");
    return 2;
  }
  let workspaceId: string | undefined;
  if (target !== undefined) {
    const ws = await resolveWorkspace(deps.db, target);
    if (ws === undefined) {
      err(`no live workspace ${target}`);
      return 1;
    }
    workspaceId = ws.id;
  }
  const sessions = await deps.db.withHost((tx) =>
    listBreakGlassSessions(tx, { workspaceId, since }),
  );
  if (args.includes("--json")) {
    out(
      JSON.stringify(
        sessions.map((s) => sessionJson(s)),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const s of sessions) {
    out(
      [
        s.id,
        s.workspaceId,
        state(s),
        s.ticket,
        s.operator,
        s.openedAt.toISOString(),
        s.expiresAt.toISOString(),
        `statements=${s.statements}`,
        `writes=${s.writes}`,
      ].join("\t"),
    );
  }
  err(`${sessions.length} break-glass session(s)`);
  return 0;
}

/** The command against injected dependencies; `runBreakGlass` wires the real ones. */
export async function breakGlassCommand(
  argv: readonly string[],
  deps: BreakGlassDeps,
): Promise<number> {
  const [sub, ...args] = argv;
  switch (sub) {
    case "open":
      return open(args, deps);
    case "sql":
      return sqlCommand(args, deps);
    case "close":
      return close(args, deps);
    case "list":
      return list(args, deps);
    default:
      (deps.err ?? ((l: string) => console.error(l)))(BREAK_GLASS_USAGE);
      return 2;
  }
}

function osUser(): string {
  try {
    return process.env["SUDO_USER"] || userInfo().username || "unknown";
  } catch {
    return process.env["USER"] || "unknown";
  }
}

/**
 * `fundroom break-glass …`. `open` and `sql --write` send mail, so they need the container's
 * mailer (templated, branded, transactional); the others need only the database.
 */
export async function runBreakGlass(argv: readonly string[], cfg: AppConfig): Promise<number> {
  const [sub] = argv;
  if (sub !== "open" && sub !== "sql" && sub !== "close" && sub !== "list") {
    console.error(BREAK_GLASS_USAGE);
    return 2;
  }
  const needsMail = sub === "open" || (sub === "sql" && argv.includes("--write"));
  if (needsMail) {
    const [{ createContainer }, { createLogger }, { COMPILED_IN_MODULES }, { SERVER_VERSION }] =
      await Promise.all([
        import("../container.js"),
        import("../logger.js"),
        import("../modules.js"),
        import("../version.js"),
      ]);
    // Logs (the dev log mailer included) go to stderr: stdout is the command's output — the
    // session id of `open`, the rows of `sql` — and must stay parseable by a script.
    const logger = createLogger({
      level: cfg.raw.LOG_LEVEL,
      version: SERVER_VERSION,
      destination: pino.destination(2),
    });
    const container = createContainer({ config: cfg, logger, modules: COMPILED_IN_MODULES });
    try {
      return await breakGlassCommand(argv, {
        db: container.db,
        audit: container.audit,
        mailer: container.mailer,
        osUser: osUser(),
      });
    } finally {
      await container.stop();
    }
  }
  const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
  try {
    const noMail: MailerPort = {
      driver: "none",
      send: async () => {
        throw new Error("break-glass: this subcommand sends no mail");
      },
      healthCheck: async () => {},
    };
    return await breakGlassCommand(argv, {
      db,
      audit: createAuditService({ db, truncateIp: cfg.raw.AUDIT_IP_TRUNCATE }),
      mailer: noMail,
      osUser: osUser(),
    });
  } finally {
    await db.close();
  }
}
