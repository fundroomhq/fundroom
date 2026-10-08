import { userInfo } from "node:os";
import { type AuditRecorder, createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import {
  createEnrolLink,
  grantOperator,
  listOperators,
  OPERATOR_ENROL_LINK_TTL_MS,
  OperatorEnrolError,
  OperatorGrantRefused,
  OperatorInputError,
  revokeOperator,
} from "@fundroom/control-plane";
import { createDatabase, type Database } from "@fundroom/db";

export const OPERATOR_USAGE = `usage: fundroom operator enrol-link <email>
       fundroom operator grant <email>
       fundroom operator revoke <email>
       fundroom operator list [--json]`;

/*
 * fundroom operator enrol-link|grant|revoke|list (E3.10, ADR-0058). The ONLY way a platform
 * operator is made or unmade. `enrol-link` prints (once, never emailed) a 30-minute single-use link
 * a brand-new operator uses to prove the mailbox and add a first factor; `grant` needs an existing
 * account that already holds a passkey or a confirmed
 * authenticator (a mailbox alone must never become an operator — whoever reads it could enrol a
 * factor of their own), both audit on the platform chain (`operator.grant` / `operator.revoke`,
 * created_by `cli:<os user>`), and `revoke` ends the user's operator sessions. Exit 0 ok, 1 not
 * found / refused, 2 usage.
 *
 * Granting is not signing in: the operator still needs a fresh level-2 session on the canonical
 * host, proven with a factor that existed before that session started, to open `/platform`.
 */

export interface OperatorCommandDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** The OS account running the CLI (recorded as `cli:<user>`). */
  readonly osUser: string;
  /** BASE_URL: the enrolment link points at `<BASE_URL>/platform/enrol`. */
  readonly baseUrl?: string | undefined;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
}

function osUser(): string {
  try {
    return process.env["SUDO_USER"] || userInfo().username || "unknown";
  } catch {
    return process.env["USER"] || "unknown";
  }
}

const utc = (d: Date | null) =>
  d === null ? "-" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The command itself, on injected deps (tests call this directly). */
export async function operatorCommand(
  argv: readonly string[],
  deps: OperatorCommandDeps,
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const [sub, arg] = argv;
  const by = `cli:${deps.osUser}`.slice(0, 200);
  try {
    switch (sub) {
      case "enrol-link": {
        if (arg === undefined || arg.startsWith("--")) break;
        const link = await createEnrolLink(deps, { email: arg, createdBy: by });
        // Printed ONCE, to this terminal only: hand it to the new operator out of band. It is
        // stored only as a hash and never emailed.
        const url = new URL(
          "platform/enrol",
          `${(deps.baseUrl ?? "https://localhost").replace(/\/+$/u, "")}/`,
        );
        url.searchParams.set("token", link.token);
        out(
          `enrolment link for ${link.email} (single use, ${OPERATOR_ENROL_LINK_TTL_MS / 60_000} min):`,
        );
        out(url.href);
        out(
          "they confirm the address with an emailed code and add a passkey or authenticator; then run `fundroom operator grant`",
        );
        return 0;
      }
      case "grant": {
        if (arg === undefined || arg.startsWith("--")) break;
        const r = await grantOperator(deps, { email: arg, createdBy: by });
        out(
          r.changed
            ? `granted: ${r.email} (user ${r.userId})`
            : `already an operator: ${r.email} (user ${r.userId})`,
        );
        return 0;
      }
      case "revoke": {
        if (arg === undefined || arg.startsWith("--")) break;
        const r = await revokeOperator(deps, { email: arg, revokedBy: by });
        if (r === undefined) {
          err(`not an operator: ${arg}`);
          return 1;
        }
        out(`revoked: ${r.email} (${r.sessionsEnded} operator session(s) ended)`);
        return 0;
      }
      case "list": {
        const rows = await listOperators(deps.db);
        if (argv.includes("--json")) {
          out(JSON.stringify(rows, null, 2));
          return 0;
        }
        if (rows.length === 0) {
          out("no operators");
          return 0;
        }
        for (const r of rows) {
          out(
            `${(r.email ?? r.userId).padEnd(40)} ${r.revokedAt === null ? "live   " : "revoked"}  granted ${utc(r.createdAt)} by ${r.createdBy}${r.revokedAt === null ? "" : `, revoked ${utc(r.revokedAt)}`}`,
          );
        }
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof OperatorInputError || error instanceof OperatorEnrolError) {
      err(error.message);
      return 2;
    }
    if (error instanceof OperatorGrantRefused) {
      err(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
  err(OPERATOR_USAGE);
  return 2;
}

export async function runOperator(argv: readonly string[], config: AppConfig): Promise<number> {
  const db = createDatabase({ connectionString: config.raw.DATABASE_URL, poolMax: 2 });
  try {
    return await operatorCommand(argv, {
      db,
      audit: createAuditService({ db, truncateIp: config.raw.AUDIT_IP_TRUNCATE }),
      osUser: osUser(),
      baseUrl: config.raw.BASE_URL,
    });
  } finally {
    await db.close();
  }
}
