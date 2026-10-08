import { createHash } from "node:crypto";

/**
 * Migration file format (design/06 §9, ADR-0004):
 *
 *  - Files are named `NNNN_snake_case.sql` and applied in name order per module.
 *  - `--> statement-breakpoint` (drizzle-kit's marker) separates chunks. A chunk may hold
 *    several statements; the whole file runs in ONE transaction unless it opts out.
 *  - A file whose header (comments before the first statement) contains
 *    `-- seedhost: no-transaction` runs chunk by chunk in autocommit mode. That is the
 *    only way to run `CREATE INDEX CONCURRENTLY`; such files should be idempotent
 *    (`IF NOT EXISTS`) because a failure midway leaves earlier chunks applied.
 *  - Files are forward-only and content-addressed: the sha256 of the file is journaled
 *    and re-verified on every run, so an edited applied migration is an error.
 */

export const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
export const NO_TRANSACTION_MARKER = /^--\s*seedhost:\s*no-transaction\s*$/imu;
const CONCURRENTLY_RE = /\b(?:CREATE|DROP|REINDEX)\b[^;]*?\bCONCURRENTLY\b/iu;

export interface ParsedMigration {
  readonly name: string;
  readonly sequence: number;
  readonly checksum: string;
  readonly chunks: readonly string[];
  readonly transactional: boolean;
}

export class MigrationFormatError extends Error {
  override readonly name = "MigrationFormatError";
}

export function checksumOf(content: string): string {
  return `sha256:${createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex")}`;
}

/** Parses one migration file. Throws `MigrationFormatError` for anything the runner cannot apply safely. */
export function parseMigration(fileName: string, content: string): ParsedMigration {
  const m = MIGRATION_FILE_RE.exec(fileName);
  if (!m) {
    throw new MigrationFormatError(
      `${fileName}: migration files must be named NNNN_snake_case.sql (e.g. 0002_add_invites.sql)`,
    );
  }
  const sequence = Number(m[1]);
  const name = fileName.slice(0, -".sql".length);
  const transactional = !NO_TRANSACTION_MARKER.test(content);

  const chunks = content
    .split(STATEMENT_BREAKPOINT)
    .map((c) => c.trim())
    .filter((c) => stripComments(c).trim().length > 0);

  if (chunks.length === 0) {
    throw new MigrationFormatError(`${fileName}: migration has no SQL statements`);
  }

  const body = stripComments(content);
  if (transactional && CONCURRENTLY_RE.test(body)) {
    throw new MigrationFormatError(
      `${fileName}: CONCURRENTLY cannot run inside a transaction. Add the header ` +
        "`-- seedhost: no-transaction` and make every chunk idempotent (IF NOT EXISTS).",
    );
  }
  if (/(?:^|;)\s*SET\s+(?!LOCAL\b)/imu.test(body)) {
    throw new MigrationFormatError(
      `${fileName}: session-level SET is not allowed (pooled connections leak it); use SET LOCAL.`,
    );
  }

  return { name, sequence, checksum: checksumOf(content), chunks, transactional };
}

/** Removes `-- line` comments and `/* block *\/` comments (not inside string literals, best effort). */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, "");
}
