import type { Tx } from "@fundroom/db";
import type { JsonObject } from "@fundroom/ports";
import { sql } from "drizzle-orm";

/*
 * Every SQL statement of the export/import engine (repos are the only place raw SQL lives).
 * Identifiers are interpolated only after `ident()` validated them against the catalog grammar;
 * values always travel as bind parameters, except the workspace uuid inside the export cursor
 * (validated by `uuidLiteral`).
 */

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`invalid SQL identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export function qualified(schema: string, table: string): string {
  return `${ident(schema)}.${ident(table)}`;
}

function uuidLiteral(id: string): string {
  if (!UUID_RE.test(id)) throw new Error("invalid uuid");
  return `'${id.toLowerCase()}'::uuid`;
}

const rowsOf = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

// --- catalog ------------------------------------------------------------------------------------

export interface CatalogTable {
  readonly schema: string;
  readonly table: string;
  readonly hasWorkspaceId: boolean;
}

/** Every ordinary/partitioned table (partitions excluded) outside system schemas. */
export async function listCatalogTables(tx: Tx): Promise<CatalogTable[]> {
  const r = await tx.execute(sql`
    SELECT n.nspname AS schema, c.relname AS table,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                   AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS "hasWorkspaceId"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pg_toast')
      AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1, 2`);
  return rowsOf<CatalogTable>(r);
}

export interface ColumnInfo {
  readonly name: string;
  /** `format_type` text, e.g. `numeric(20,6)`, `uuid[]`. */
  readonly type: string;
  readonly generated: boolean;
  readonly identityAlways: boolean;
  readonly notNull: boolean;
  /** Carried as JSON text so no precision is lost in a JS number (numeric, bigint, money). */
  readonly asText: boolean;
}

export interface ForeignKeyInfo {
  readonly column: string;
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumn: string;
  readonly deferrable: boolean;
}

export interface TableInfo {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  /** Single-column foreign keys only (the engine defers these when needed). */
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

export async function describeTable(tx: Tx, schema: string, table: string): Promise<TableInfo> {
  const cols = rowsOf<{
    name: string;
    type: string;
    generated: boolean;
    identityAlways: boolean;
    notNull: boolean;
    base: string;
  }>(
    await tx.execute(sql`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             a.attgenerated <> '' AS generated, a.attidentity = 'a' AS "identityAlways",
             a.attnotnull AS "notNull", t.typname AS base
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = ${schema} AND c.relname = ${table} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`),
  );
  if (cols.length === 0) throw new Error(`table ${schema}.${table} does not exist`);
  const pk = rowsOf<{ name: string }>(
    await tx.execute(sql`
      SELECT a.attname AS name
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum
      WHERE n.nspname = ${schema} AND c.relname = ${table} AND k.contype = 'p'
      ORDER BY u.ord`),
  );
  const fks = rowsOf<ForeignKeyInfo>(
    await tx.execute(sql`
      SELECT a.attname AS column, rn.nspname AS "refSchema", rc.relname AS "refTable",
             ra.attname AS "refColumn", k.condeferrable AS deferrable
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = k.confkey[1]
      WHERE n.nspname = ${schema} AND c.relname = ${table} AND k.contype = 'f'
        AND array_length(k.conkey, 1) = 1`),
  );
  return {
    schema,
    table,
    columns: cols.map((c) => ({
      name: c.name,
      type: c.type,
      generated: c.generated,
      identityAlways: c.identityAlways,
      notNull: c.notNull,
      asText: ["numeric", "int8", "money", "_numeric", "_int8"].includes(c.base),
    })),
    primaryKey: pk.map((p) => p.name),
    foreignKeys: fks,
  };
}

// --- export -------------------------------------------------------------------------------------

/**
 * Export session settings. READ ONLY: the snapshot phase writes nothing (and a bug that tried
 * would fail loudly). `statement_timeout` off because one FETCH may have to sort a large table;
 * parallel plans off because the single UNION ALL cursor (one statement, so one snapshot for every
 * table even under READ COMMITTED) relies on `Append` running its children in order.
 */
export async function prepareExportSession(tx: Tx): Promise<void> {
  await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
  await tx.execute(sql.raw("SET LOCAL max_parallel_workers_per_gather = 0"));
}

/**
 * This workspace's rows in a table the export leaves out (a module schema that is not loaded), or
 * null when they cannot be counted here (no grant, no policy): in a savepoint, so a refusal does
 * not abort the export's transaction.
 */
export async function countWorkspaceRows(
  tx: Tx,
  schema: string,
  table: string,
  workspaceId: string,
): Promise<number | null> {
  try {
    return await tx.transaction(async (sp) => {
      const r = rowsOf<{ n: number | string }>(
        await sp.execute(
          sql.raw(
            `SELECT count(*) AS n FROM ${qualified(schema, table)} WHERE workspace_id = ${uuidLiteral(workspaceId)}`,
          ),
        ),
      );
      return Number(r[0]?.n ?? 0);
    });
  } catch {
    return null;
  }
}

export interface CursorTable {
  readonly info: TableInfo;
  /** Custom ORDER BY over alias `t`; default the primary key. */
  readonly orderBy?: string | undefined;
  /** `membership`: join the member's email identity in as `$identity`. */
  readonly withIdentity?: boolean | undefined;
}

function rowExpression(t: CursorTable): string {
  const gen = t.info.columns.filter((c) => c.generated).map((c) => ` - '${c.name}'`);
  let expr = `(to_jsonb(t)${gen.join("")})`;
  const asText = t.info.columns.filter((c) => c.asText && !c.generated);
  if (asText.length > 0) {
    const pairs = asText.map((c) => `'${c.name}', t.${ident(c.name)}::text`).join(", ");
    expr = `(${expr} || jsonb_build_object(${pairs}))`;
  }
  if (t.withIdentity) {
    expr = `((${expr} - 'user_id') || jsonb_build_object('$identity', (
      SELECT jsonb_build_object('email', ui.identifier::text, 'displayName', u.display_name)
      FROM core.user_identity ui JOIN core."user" u ON u.id = ui.user_id
      WHERE ui.user_id = t.user_id AND ui.type = 'email' AND u.deleted_at IS NULL
        AND ui.identifier::text NOT LIKE 'erased+%@erased.invalid'
      ORDER BY ui.is_primary DESC, ui.created_at LIMIT 1)))`;
  }
  return expr;
}

/**
 * Opens ONE cursor over every table (a UNION ALL in the given order), so the whole export reads a
 * single snapshot: a row inserted mid-export cannot reference a row the export already passed.
 * Rows come back as `{ t: <index>, r: <row json> }`, grouped by table in order.
 */
export async function openExportCursor(
  tx: Tx,
  workspaceId: string,
  tables: readonly CursorTable[],
): Promise<void> {
  if (tables.length === 0) return;
  const ws = uuidLiteral(workspaceId);
  const parts = tables.map((t, i) => {
    const order =
      t.orderBy ??
      (t.info.primaryKey.length > 0
        ? t.info.primaryKey.map((c) => `t.${ident(c)}`).join(", ")
        : "1");
    return `SELECT ${i} AS t, r FROM (SELECT ${rowExpression(t)} AS r FROM ${qualified(t.info.schema, t.info.table)} t WHERE t.workspace_id = ${ws} ORDER BY ${order}) s${i}`;
  });
  await tx.execute(
    sql.raw(`DECLARE portability_export NO SCROLL CURSOR FOR ${parts.join("\nUNION ALL\n")}`),
  );
}

export async function fetchExportCursor(
  tx: Tx,
  count: number,
): Promise<{ t: number; r: JsonObject }[]> {
  const n = Math.max(1, Math.floor(count));
  return rowsOf<{ t: number; r: JsonObject }>(
    await tx.execute(sql.raw(`FETCH ${n} FROM portability_export`)),
  );
}

export async function closeExportCursor(tx: Tx): Promise<void> {
  await tx.execute(sql.raw("CLOSE portability_export"));
}

export async function readWorkspaceRow(
  tx: Tx,
  workspaceId: string,
): Promise<JsonObject | undefined> {
  const r = rowsOf<{ r: JsonObject }>(
    await tx.execute(sql`
      SELECT jsonb_build_object('id', w.id, 'slug', w.slug::text, 'name', w.name,
        'offering_status', w.offering_status, 'settings', w.settings,
        'settings_schema_version', w.settings_schema_version,
        'default_locale', w.default_locale, 'created_at', w.created_at) AS r
      FROM core.workspace w WHERE w.id = ${workspaceId}::uuid AND w.deleted_at IS NULL`),
  );
  return r[0]?.r;
}

/** Addresses the kernel knows for this workspace: members' email identities and invitations. */
export async function knownEmails(tx: Tx, workspaceId: string): Promise<string[]> {
  const r = rowsOf<{ email: string }>(
    await tx.execute(sql`
      SELECT DISTINCT lower(ui.identifier::text) AS email
      FROM core.membership m JOIN core.user_identity ui ON ui.user_id = m.user_id AND ui.type = 'email'
      WHERE m.workspace_id = ${workspaceId}::uuid
      UNION
      SELECT DISTINCT lower(i.email::text) FROM core.invite i WHERE i.workspace_id = ${workspaceId}::uuid`),
  );
  return r.map((row) => row.email).filter((e) => !/^erased\+.*@erased\.invalid$/u.test(e));
}

export interface SuppressionRow {
  readonly id: string;
  readonly addressHash: Buffer;
  readonly addressMasked: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export async function listSuppressions(tx: Tx, workspaceId: string): Promise<SuppressionRow[]> {
  return rowsOf<SuppressionRow>(
    await tx.execute(sql`
      SELECT id, address_hash AS "addressHash", address_masked AS "addressMasked", reason,
             to_jsonb(created_at) #>> '{}' AS "createdAt", created_by AS "createdBy"
      FROM core.mail_suppression WHERE workspace_id = ${workspaceId}::uuid ORDER BY id`),
  );
}

export async function auditSeqRange(
  tx: Tx,
  workspaceId: string,
): Promise<{ fromSeq: number; toSeq: number } | undefined> {
  const r = rowsOf<{ lo: string | number | null; hi: string | number | null }>(
    await tx.execute(
      sql`SELECT min(seq) AS lo, max(seq) AS hi FROM audit.event WHERE workspace_id = ${workspaceId}::uuid`,
    ),
  );
  const row = r[0];
  if (!row || row.lo === null || row.hi === null) return undefined;
  return { fromSeq: Number(row.lo), toSeq: Number(row.hi) };
}

// --- import -------------------------------------------------------------------------------------

/** Inserts the new workspace (host context). Throws 23505 on a slug taken by a live workspace. */
export async function insertWorkspace(
  tx: Tx,
  input: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly settings: JsonObject;
    readonly offeringStatus: string;
    readonly defaultLocale: string;
    /** E3.11: CELL_ID (omitted: the column default). */
    readonly cellId?: string | undefined;
    /** E3.11 moves: the control-plane facts carried from the source cell. */
    readonly holds?: readonly string[] | undefined;
    readonly planId?: string | null | undefined;
    readonly legalName?: string | null | undefined;
    readonly country?: string | null | undefined;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.workspace (id, slug, name, settings, offering_status, default_locale,
                                cell_id, holds, plan_id, legal_name, country)
    VALUES (${input.id}::uuid, ${input.slug}, ${input.name}, ${JSON.stringify(input.settings)}::jsonb,
            ${input.offeringStatus}::core.offering_status, ${input.defaultLocale},
            coalesce(${input.cellId ?? null}::text, 'default'),
            ${`{${(input.holds ?? []).join(",")}}`}::text[],
            ${input.planId ?? null}::text, ${input.legalName ?? null}::text, ${input.country ?? null}::text)`);
}

/** The live user holding this email identity (host context). */
export async function findUserIdByEmail(tx: Tx, email: string): Promise<string | undefined> {
  const r = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT u.id FROM core.user_identity ui JOIN core."user" u ON u.id = ui.user_id
      WHERE ui.type = 'email' AND ui.identifier = ${email} AND u.deleted_at IS NULL LIMIT 1`),
  );
  return r[0]?.id;
}

/** A new user with a verified email identity (what `provisionUser` creates), host context. */
export async function createUserWithEmail(
  tx: Tx,
  input: { readonly id: string; readonly email: string; readonly displayName: string },
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO core."user" (id, display_name) VALUES (${input.id}::uuid, ${input.displayName})`,
  );
  await tx.execute(sql`
    INSERT INTO core.user_identity (user_id, type, identifier, verified_at, is_primary)
    VALUES (${input.id}::uuid, 'email', ${input.email}, now(), true)`);
}

/**
 * A user that can never sign in: no identity, already deleted. Holds a membership whose person
 * was erased (or had no email identity) in the source, so the rows that cite it stay intact.
 */
export async function createTombstoneUser(tx: Tx, id: string): Promise<void> {
  await tx.execute(
    sql`INSERT INTO core."user" (id, display_name, deleted_at) VALUES (${id}::uuid, '', now())`,
  );
}

/**
 * Switches the open transaction from the host context to the `system` actor of `workspaceId`
 * (transaction-local settings, exactly what `withTenant` sets), so the rows of the new workspace
 * are written through its tenant fence in the same transaction that created it.
 */
export async function enterSystemContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${workspaceId}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}

export async function prepareImportSession(tx: Tx): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
  await tx.execute(sql.raw("SET CONSTRAINTS ALL DEFERRED"));
}

/**
 * `INSERT … SELECT <cols> FROM jsonb_populate_recordset(NULL::<table>, $rows)`: every value goes
 * through its column type's input function (bytea from `\x…`, ltree, ranges, arrays, enums).
 * Columns absent from the rows are not named, so their defaults apply.
 */
export async function insertRows(
  tx: Tx,
  schema: string,
  table: string,
  columns: readonly string[],
  rows: readonly JsonObject[],
  overriding: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  const t = qualified(schema, table);
  const cols = columns.map(ident).join(", ");
  const over = overriding ? " OVERRIDING SYSTEM VALUE" : "";
  await tx.execute(
    sql`${sql.raw(`INSERT INTO ${t} (${cols})${over} SELECT ${cols} FROM jsonb_populate_recordset(NULL::${t}, `)}${JSON.stringify(rows)}::jsonb${sql.raw(")")}`,
  );
}

/** Sets one deferred FK column: `UPDATE t SET col = v WHERE id = k` for each pair. */
export async function applyDeferred(
  tx: Tx,
  schema: string,
  table: string,
  column: string,
  type: string,
  pairs: readonly { readonly id: string; readonly value: string }[],
): Promise<number> {
  if (pairs.length === 0) return 0;
  if (!/^[a-z0-9_ ()[\],"]+$/iu.test(type)) throw new Error(`unexpected column type ${type}`);
  const t = qualified(schema, table);
  const r = await tx.execute(
    sql`${sql.raw(`UPDATE ${t} AS t SET ${ident(column)} = (v.value)::${type} FROM jsonb_to_recordset(`)}${JSON.stringify(pairs)}::jsonb${sql.raw(") AS v(id uuid, value text) WHERE t.id = v.id")}`,
  );
  return (r as { rowCount?: number | null }).rowCount ?? 0;
}

export async function insertSuppression(
  tx: Tx,
  row: {
    readonly workspaceId: string;
    readonly id: string;
    readonly addressHash: Buffer;
    readonly keyId: string;
    readonly addressMasked: string;
    readonly reason: string;
    readonly createdAt: string;
    readonly createdBy: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.mail_suppression (workspace_id, id, address_hash, key_id, address_masked,
      reason, created_at, created_by)
    VALUES (${row.workspaceId}::uuid, ${row.id}::uuid, ${row.addressHash}, ${row.keyId}::uuid,
      ${row.addressMasked}, ${row.reason}, ${row.createdAt}::timestamptz, ${row.createdBy}::uuid)
    ON CONFLICT (workspace_id, address_hash) DO NOTHING`);
}

/** The live membership of `userId` in the workspace, if any. */
export async function liveMembershipOf(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<{ id: string; kind: string; role: string } | undefined> {
  const r = rowsOf<{ id: string; kind: string; role: string }>(
    await tx.execute(sql`
      SELECT id, kind::text AS kind, role::text AS role FROM core.membership
      WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid AND status <> 'revoked'
      LIMIT 1`),
  );
  return r[0];
}

/**
 * Promotes a membership to a live staff owner. A promoted *investor* stops being anybody's principal
 * Its delegates are revoked and their pending invitations withdrawn first,
 * because a delegate acts for an external investor and nothing else — left alone they would keep
 * pointing at a staff owner.
 */
export async function makeOwner(tx: Tx, membershipId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE core.membership SET status = 'revoked', revoked_at = now(), revoke_reason = 'principal_promoted'
    WHERE principal_membership_id = ${membershipId}::uuid AND status <> 'revoked'`);
  await tx.execute(sql`
    UPDATE core.invite SET status = 'revoked', revoked_at = now()
    WHERE principal_membership_id = ${membershipId}::uuid AND status = 'pending'`);
  await tx.execute(sql`
    UPDATE core.membership SET kind = 'staff', role = 'owner', status = 'active',
      principal_membership_id = NULL, delegate_scope = NULL,
      activated_at = coalesce(activated_at, now()),
      -- owners never expire (P1-02); an expired row promoted as-is would be refused sign-in (E3.2)
      expires_at = NULL
    WHERE id = ${membershipId}::uuid`);
}

export async function insertOwnerMembership(
  tx: Tx,
  input: { readonly id: string; readonly workspaceId: string; readonly userId: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.membership (id, workspace_id, user_id, kind, role, status, source, activated_at)
    VALUES (${input.id}::uuid, ${input.workspaceId}::uuid, ${input.userId}::uuid, 'staff', 'owner',
            'active', 'import', now())`);
}

/**
 * Owners who can administer the imported workspace: the same predicate as identity's
 * `MembershipRepo.countActiveOwners` (E3.2) — a staff owner, `active`, not past its own
 * `expires_at` at `now`. A `dormant` or `invited` owner does not stop the "no live owner" warning.
 */
export async function countLiveOwners(
  tx: Tx,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const r = rowsOf<{ n: number | string }>(
    await tx.execute(sql`
      SELECT count(*) AS n FROM core.membership
      WHERE workspace_id = ${workspaceId}::uuid AND kind = 'staff' AND role = 'owner'
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)`),
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * E3.5 fix A16: an imported legal document whose ceremony is `esign` would name a vendor
 * connection the import never carries (`core.esign_connection` is skipped — its secrets are
 * sealed under the source's key), leaving a gate nobody can pass. They are reset to `clickwrap`;
 * returns the slugs reset, for the import report.
 */
export async function resetEsignCeremonies(tx: Tx, workspaceId: string): Promise<string[]> {
  const r = rowsOf<{ slug: string }>(
    await tx.execute(sql`
      UPDATE core.legal_document SET ceremony = 'clickwrap'
      WHERE workspace_id = ${workspaceId}::uuid AND ceremony = 'esign'
        AND NOT EXISTS (SELECT 1 FROM core.esign_connection c
                         WHERE c.workspace_id = ${workspaceId}::uuid AND c.deleted_at IS NULL)
      RETURNING slug::text AS slug`),
  );
  return r.map((x) => x.slug).sort();
}

export async function insertWorkspaceImport(
  tx: Tx,
  row: {
    readonly id: string;
    readonly workspaceId: string;
    readonly source: JsonObject;
    readonly counts: JsonObject;
    readonly auditArchiveKey: string | null;
    readonly auditArchiveEncryption: JsonObject | null;
    readonly importedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO core.workspace_import (id, workspace_id, source, counts, audit_archive_key,
      audit_archive_encryption, imported_by)
    VALUES (${row.id}::uuid, ${row.workspaceId}::uuid, ${JSON.stringify(row.source)}::jsonb,
      ${JSON.stringify(row.counts)}::jsonb, ${row.auditArchiveKey},
      ${row.auditArchiveEncryption === null ? null : JSON.stringify(row.auditArchiveEncryption)}::jsonb,
      ${row.importedBy})`);
}

export async function updateWorkspaceSettings(
  tx: Tx,
  workspaceId: string,
  settings: JsonObject,
): Promise<void> {
  await tx.execute(
    sql`UPDATE core.workspace SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${workspaceId}::uuid`,
  );
}

// --- import guards (E2.8 fix C) ------------------------------------------------------------------

export interface ForeignReference {
  /** The uuid, lower-case. */
  readonly id: string;
  /** `<schema>.<table>` of the row it names in another workspace. */
  readonly table: string;
  /** The row belongs to the export's (claimed) source workspace. */
  readonly inSource: boolean;
}

const FOREIGN_CHUNK = 5_000;

/**
 * Which of `ids` are the `id` of a row of ANOTHER workspace on this instance
 * (`core.import_foreign_references`, SECURITY DEFINER, migration 0014). Must run on the import
 * transaction in the new workspace's `system` context, before any membership row is inserted.
 */
export async function findForeignReferences(
  tx: Tx,
  workspaceId: string,
  sourceWorkspaceId: string,
  ids: readonly string[],
): Promise<ForeignReference[]> {
  const out: ForeignReference[] = [];
  for (let i = 0; i < ids.length; i += FOREIGN_CHUNK) {
    const chunk = ids.slice(i, i + FOREIGN_CHUNK);
    for (const id of chunk) if (!UUID_RE.test(id)) throw new Error("invalid uuid");
    const literal = `{${chunk.join(",")}}`;
    const r = rowsOf<{ id: string; table: string; inSource: boolean }>(
      await tx.execute(sql`
        SELECT ref_id::text AS id, table_name AS "table", in_source AS "inSource"
        FROM core.import_foreign_references(${workspaceId}::uuid, ${sourceWorkspaceId}::uuid,
          ${literal}::uuid[])`),
    );
    for (const row of r)
      out.push({ id: row.id.toLowerCase(), table: row.table, inSource: row.inSource === true });
  }
  return out;
}

interface ForeignKeyRow {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly columns: string[];
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: string[];
  readonly refHasWorkspace: boolean;
  readonly hasWorkspace: boolean;
}

/**
 * Every foreign key (any arity) whose child is one of `tables`, and for each one whose parent is
 * workspace-scoped (a `workspace_id` column, or `core.workspace` itself): does a row of the new
 * workspace reference a parent row outside it? Foreign-key checks bypass RLS, so a crafted row
 * could otherwise point at another tenant's folder or membership — and then block its deletion
 * (RESTRICT) or be cascaded by it. Returns the first offending constraint, or undefined.
 * Runs in the new workspace's context: the NOT EXISTS sees only this workspace's parents, and
 * the explicit `workspace_id` predicate holds even where RLS would not.
 */
export async function findCrossWorkspaceForeignKey(
  tx: Tx,
  workspaceId: string,
  tables: ReadonlySet<string>,
): Promise<
  { readonly constraint: string; readonly child: string; readonly parent: string } | undefined
> {
  const fks = rowsOf<ForeignKeyRow>(
    await tx.execute(sql`
      SELECT k.conname::text AS name, n.nspname::text AS schema, c.relname::text AS table,
        (SELECT array_agg(a.attname::text ORDER BY u.ord)
           FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS columns,
        rn.nspname::text AS "refSchema", rc.relname::text AS "refTable",
        (SELECT array_agg(a.attname::text ORDER BY u.ord)
           FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum) AS "refColumns",
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.confrelid
                AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS "refHasWorkspace",
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.conrelid
                AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS "hasWorkspace"
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE k.contype = 'f' AND k.conparentid = 0
      ORDER BY 2, 3, 1`),
  );
  const ws = uuidLiteral(workspaceId);
  for (const fk of fks) {
    if (!tables.has(`${fk.schema}.${fk.table}`) || !fk.hasWorkspace) continue;
    const toWorkspace = fk.refSchema === "core" && fk.refTable === "workspace";
    if (!toWorkspace && !fk.refHasWorkspace) continue;
    const child = qualified(fk.schema, fk.table);
    const notNull = fk.columns.map((col) => `c.${ident(col)} IS NOT NULL`).join(" AND ");
    let outside: string;
    if (toWorkspace) {
      const i = fk.refColumns.indexOf("id");
      if (i < 0 || fk.columns[i] === undefined) continue;
      outside = `c.${ident(fk.columns[i] as string)} <> ${ws}`;
    } else {
      const join = fk.columns
        .map((col, i) => `p.${ident(fk.refColumns[i] as string)} = c.${ident(col)}`)
        .join(" AND ");
      outside = `NOT EXISTS (SELECT 1 FROM ${qualified(fk.refSchema, fk.refTable)} p WHERE ${join} AND p.workspace_id = ${ws})`;
    }
    const r = await tx.execute(
      sql.raw(
        `SELECT 1 AS hit FROM ${child} c WHERE c.workspace_id = ${ws} AND ${notNull} AND ${outside} LIMIT 1`,
      ),
    );
    if (rowsOf(r).length > 0)
      return {
        constraint: fk.name,
        child: `${fk.schema}.${fk.table}(${fk.columns.join(", ")})`,
        parent: `${fk.refSchema}.${fk.refTable}`,
      };
  }
  return undefined;
}
