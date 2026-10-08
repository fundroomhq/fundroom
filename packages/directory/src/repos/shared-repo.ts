import { randomUUID } from "node:crypto";
import type {
  DirectoryCell,
  DirectoryEntryState,
  DirectoryMove,
  MoveBundle,
  MoveCarried,
  MoveState,
} from "@fundroom/ports";
import type pg from "pg";

/*
 * Data access over the DIRECTORY database (`migrations/0001_directory.sql`). The only file in the
 * package that speaks SQL to it (the `only-repos-touch-drizzle` rule). Raw `pg` rather than drizzle:
 * the directory has no drizzle schema and every statement here is a short, hand-shaped CAS.
 *
 * Every write that must be atomic runs in `inTx` (one checked-out client, BEGIN … COMMIT, a server
 * statement timeout so a lock wait cannot hang a request). Lock order inside the directory:
 * move row → workspace entry row (switchover); `requestMove` takes only the entry row.
 */

export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** Directory statements never wait longer than this for a lock or a scan. */
export const DIRECTORY_STATEMENT_TIMEOUT_MS = 5_000;

export async function inTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${DIRECTORY_STATEMENT_TIMEOUT_MS}ms'`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A unique-violation on the named constraint/index (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  if (e === null || typeof e !== "object" || e.code !== "23505") return false;
  return constraint === undefined || e.constraint === constraint;
}

/** A foreign-key violation (SQLSTATE 23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  const e = error as { code?: unknown } | null;
  return e !== null && typeof e === "object" && e.code === "23503";
}

// ---------------------------------------------------------------------------------------------
// cells

interface CellRow {
  id: string;
  region: string;
  region_label: string;
  jurisdiction: string | null;
  public_origin: string;
  status: string;
  export_public_key: string | null;
  export_public_keys: unknown;
  heartbeat_at: Date | string | null;
}

type PublishedKey = { readonly keyId: string; readonly publicKey: string };

function toKeys(v: unknown): PublishedKey[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((k) =>
    k !== null &&
    typeof k === "object" &&
    typeof (k as PublishedKey).keyId === "string" &&
    typeof (k as PublishedKey).publicKey === "string"
      ? [{ keyId: (k as PublishedKey).keyId, publicKey: (k as PublishedKey).publicKey }]
      : [],
  );
}

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

export async function selectCells(q: Queryable): Promise<Omit<DirectoryCell, "local">[]> {
  const { rows } = await q.query<CellRow>(
    `SELECT id, region, region_label, jurisdiction, public_origin, status, export_public_key,
            export_public_keys, heartbeat_at
       FROM directory.cell ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id,
    region: r.region,
    regionLabel: r.region_label,
    jurisdiction: r.jurisdiction as DirectoryCell["jurisdiction"],
    publicOrigin: r.public_origin,
    status: r.status as DirectoryCell["status"],
    exportPublicKey: r.export_public_key,
    exportPublicKeys: toKeys(r.export_public_keys),
    heartbeatAt: toDate(r.heartbeat_at),
  }));
}

/**
 * Upserts a cell row. An existing row is only updated when its region is unchanged AND it is
 * owned by the caller: its `export_public_key` is null or one of `ownerKeys` (the publishing
 * deployment's export keys — every cell has its own key ring, and a rotated ring still holds its
 * old keys). Two cell databases that both carry a cell id (every database seeds `default`) can
 * therefore never overwrite each other's region facts or export key. Returns false on a refusal.
 */
export async function upsertCell(
  q: Queryable,
  cell: Omit<DirectoryCell, "local" | "heartbeatAt">,
  ownerKeys: readonly string[],
): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO directory.cell
       (id, region, region_label, jurisdiction, public_origin, status, export_public_key,
        export_public_keys, heartbeat_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $9::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       region_label = EXCLUDED.region_label,
       jurisdiction = EXCLUDED.jurisdiction,
       public_origin = EXCLUDED.public_origin,
       status = EXCLUDED.status,
       export_public_key = EXCLUDED.export_public_key,
       export_public_keys = EXCLUDED.export_public_keys,
       heartbeat_at = now(),
       updated_at = now()
     WHERE directory.cell.region = EXCLUDED.region
       AND (directory.cell.export_public_key IS NULL
            OR directory.cell.export_public_key = ANY($8::text[]))
     RETURNING id`,
    [
      cell.id,
      cell.region,
      cell.regionLabel,
      cell.jurisdiction,
      cell.publicOrigin,
      cell.status,
      cell.exportPublicKey,
      [...ownerKeys],
      JSON.stringify(
        (cell.exportPublicKeys ?? []).map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
      ),
    ],
  );
  return rows.length > 0;
}

/** A published cell's owner facts, or undefined. */
export async function selectCellOwner(
  q: Queryable,
  id: string,
): Promise<{ readonly region: string; readonly exportPublicKey: string | null } | undefined> {
  const { rows } = await q.query<{ region: string; export_public_key: string | null }>(
    "SELECT region, export_public_key FROM directory.cell WHERE id = $1",
    [id],
  );
  const r = rows[0];
  return r === undefined ? undefined : { region: r.region, exportPublicKey: r.export_public_key };
}

// ---------------------------------------------------------------------------------------------
// workspace entries

export interface EntryRow {
  readonly entryId: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly cellId: string;
  readonly state: DirectoryEntryState;
  readonly createdAt: Date;
}

interface RawEntry {
  entry_id: string;
  workspace_id: string;
  slug: string;
  cell_id: string;
  state: string;
  created_at: Date | string;
}

const ENTRY_COLUMNS = "entry_id, workspace_id, slug, cell_id, state, created_at";

function toEntry(r: RawEntry): EntryRow {
  return {
    entryId: r.entry_id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    cellId: r.cell_id,
    state: r.state as DirectoryEntryState,
    createdAt: toDate(r.created_at) ?? new Date(0),
  };
}

export async function selectEntryBySlug(q: Queryable, slug: string): Promise<EntryRow | undefined> {
  const { rows } = await q.query<RawEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM directory.workspace WHERE slug = $1 AND state <> 'deleted'`,
    [slug],
  );
  return rows[0] === undefined ? undefined : toEntry(rows[0]);
}

export async function selectEntryByWorkspace(
  q: Queryable,
  workspaceId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<EntryRow | undefined> {
  const { rows } = await q.query<RawEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM directory.workspace WHERE workspace_id = $1${
      options.forUpdate === true ? " FOR UPDATE" : ""
    }`,
    [workspaceId],
  );
  return rows[0] === undefined ? undefined : toEntry(rows[0]);
}

/** The entry `workspaceId` was the SOURCE of, through a switched (or since retired) move. */
export async function selectEntryMovedFrom(
  q: Queryable,
  workspaceId: string,
): Promise<EntryRow | undefined> {
  const { rows } = await q.query<RawEntry>(
    `SELECT ${ENTRY_COLUMNS.split(", ")
      .map((c) => `w.${c}`)
      .join(", ")}
       FROM directory.move m JOIN directory.workspace w ON w.entry_id = m.entry_id
      WHERE m.source_workspace_id = $1 AND m.state IN ('switched', 'retired')
      ORDER BY m.updated_at DESC LIMIT 1`,
    [workspaceId],
  );
  return rows[0] === undefined ? undefined : toEntry(rows[0]);
}

export async function selectCellIdByHost(
  q: Queryable,
  hostname: string,
): Promise<string | undefined> {
  const { rows } = await q.query<{ cell_id: string }>(
    `SELECT w.cell_id FROM directory.hostname h
       JOIN directory.workspace w ON w.entry_id = h.entry_id
      WHERE h.hostname = $1 AND w.state IN ('active', 'moving')`,
    [hostname],
  );
  return rows[0]?.cell_id;
}

export async function insertEntry(
  q: Queryable,
  input: {
    readonly workspaceId: string;
    readonly slug: string;
    readonly cellId: string;
    readonly state: "reserved" | "active" | "dormant";
  },
): Promise<void> {
  await q.query(
    `INSERT INTO directory.workspace (entry_id, workspace_id, slug, cell_id, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.workspaceId, input.slug, input.cellId, input.state],
  );
}

/** Rewrites an entry in place (revive a deleted one, repair slug/cell/state). */
export async function updateEntry(
  q: Queryable,
  entryId: string,
  set: { readonly slug?: string; readonly cellId?: string; readonly state?: DirectoryEntryState },
): Promise<void> {
  const parts: string[] = [];
  const values: unknown[] = [entryId];
  if (set.slug !== undefined) {
    values.push(set.slug);
    parts.push(`slug = $${values.length}`);
  }
  if (set.cellId !== undefined) {
    values.push(set.cellId);
    parts.push(`cell_id = $${values.length}`);
  }
  if (set.state !== undefined) {
    values.push(set.state);
    parts.push(`state = $${values.length}`);
  }
  if (parts.length === 0) return;
  await q.query(
    `UPDATE directory.workspace SET ${parts.join(", ")}, updated_at = now() WHERE entry_id = $1`,
    values,
  );
}

export async function activateEntry(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(
    `UPDATE directory.workspace SET state = 'active', updated_at = now()
      WHERE workspace_id = $1 AND state = 'reserved'`,
    [workspaceId],
  );
}

/** The number of rows renamed (0 = no live entry for the workspace). Throws on a slug clash. */
export async function renameEntry(q: Queryable, workspaceId: string, to: string): Promise<number> {
  const res = await q.query(
    `UPDATE directory.workspace SET slug = $2, updated_at = now()
      WHERE workspace_id = $1 AND state <> 'deleted'`,
    [workspaceId, to],
  );
  return res.rowCount ?? 0;
}

export async function releaseEntry(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(
    `DELETE FROM directory.hostname
      WHERE entry_id IN (SELECT entry_id FROM directory.workspace WHERE workspace_id = $1)`,
    [workspaceId],
  );
  await q.query(
    `UPDATE directory.workspace SET state = 'deleted', updated_at = now()
      WHERE workspace_id = $1 AND state <> 'deleted'`,
    [workspaceId],
  );
}

export async function setEntryState(
  q: Queryable,
  workspaceId: string,
  state: "active" | "moving" | "dormant",
): Promise<void> {
  await q.query(
    `UPDATE directory.workspace SET state = $2, updated_at = now()
      WHERE workspace_id = $1 AND state <> 'deleted'`,
    [workspaceId, state],
  );
}

/**
 * Releases `reserved` entries of `cellIds` created before `olderThan` whose workspace id is not in
 * `keep` (the workspaces that exist locally). Returns the released workspace ids.
 */
export async function releaseStaleReservations(
  q: Queryable,
  input: {
    readonly cellIds: readonly string[];
    readonly olderThan: Date;
    readonly keep: readonly string[];
  },
): Promise<string[]> {
  if (input.cellIds.length === 0) return [];
  const { rows } = await q.query<{ workspace_id: string }>(
    `UPDATE directory.workspace SET state = 'deleted', updated_at = now()
      WHERE state = 'reserved' AND cell_id = ANY($1::text[]) AND created_at < $2
        AND NOT (workspace_id = ANY($3::uuid[]))
      RETURNING workspace_id`,
    [input.cellIds, input.olderThan, input.keep],
  );
  return rows.map((r) => r.workspace_id);
}

/** Entries of `cellIds` (any state), for the sweep. */
export async function selectEntriesOfCells(
  q: Queryable,
  cellIds: readonly string[],
): Promise<EntryRow[]> {
  if (cellIds.length === 0) return [];
  const { rows } = await q.query<RawEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM directory.workspace WHERE cell_id = ANY($1::text[])`,
    [cellIds],
  );
  return rows.map(toEntry);
}

// ---------------------------------------------------------------------------------------------
// hostnames

/** The entry id holding `hostname` now (after an insert-if-absent for `entryId`). */
export async function claimHostname(
  q: Queryable,
  hostname: string,
  entryId: string,
): Promise<string | undefined> {
  await q.query(
    `INSERT INTO directory.hostname (hostname, entry_id) VALUES ($1, $2)
     ON CONFLICT (hostname) DO NOTHING`,
    [hostname, entryId],
  );
  const { rows } = await q.query<{ entry_id: string }>(
    "SELECT entry_id FROM directory.hostname WHERE hostname = $1",
    [hostname],
  );
  return rows[0]?.entry_id;
}

export async function releaseHostname(
  q: Queryable,
  hostname: string,
  workspaceId: string,
): Promise<void> {
  await q.query(
    `DELETE FROM directory.hostname
      WHERE hostname = $1
        AND entry_id IN (SELECT entry_id FROM directory.workspace WHERE workspace_id = $2)`,
    [hostname, workspaceId],
  );
}

// ---------------------------------------------------------------------------------------------
// moves

interface RawMove {
  id: string;
  entry_id: string;
  source_workspace_id: string;
  slug: string;
  source_cell_id: string;
  target_cell_id: string;
  state: string;
  bundle: MoveBundle | null;
  carried: MoveCarried | null;
  target_workspace_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  switched_at: Date | string | null;
  error: { stage: string; code: string } | null;
  requested_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const MOVE_COLUMNS = `id, entry_id, source_workspace_id, slug, source_cell_id, target_cell_id,
  state, bundle, carried, target_workspace_id, lease_owner, lease_expires_at, switched_at, error,
  requested_by, created_at, updated_at`;

function toMove(r: RawMove): DirectoryMove {
  return {
    id: r.id,
    entryId: r.entry_id,
    sourceWorkspaceId: r.source_workspace_id,
    slug: r.slug,
    sourceCellId: r.source_cell_id,
    targetCellId: r.target_cell_id,
    state: r.state as MoveState,
    bundle: r.bundle,
    carried: r.carried,
    targetWorkspaceId: r.target_workspace_id,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: toDate(r.lease_expires_at),
    switchedAt: toDate(r.switched_at),
    error: r.error === null ? null : { stage: r.error.stage, code: r.error.code },
    requestedBy: r.requested_by,
    createdAt: toDate(r.created_at) ?? new Date(0),
    updatedAt: toDate(r.updated_at) ?? new Date(0),
  };
}

export async function insertMove(
  q: Queryable,
  input: {
    readonly entryId: string;
    readonly sourceWorkspaceId: string;
    readonly slug: string;
    readonly sourceCellId: string;
    readonly targetCellId: string;
    readonly requestedBy: string;
    readonly carried: MoveCarried;
  },
): Promise<DirectoryMove> {
  const { rows } = await q.query<RawMove>(
    `INSERT INTO directory.move
       (id, entry_id, source_workspace_id, slug, source_cell_id, target_cell_id, state, carried,
        requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7::jsonb, $8)
     RETURNING ${MOVE_COLUMNS}`,
    [
      randomUUID(),
      input.entryId,
      input.sourceWorkspaceId,
      input.slug,
      input.sourceCellId,
      input.targetCellId,
      JSON.stringify(input.carried),
      input.requestedBy,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("directory: move insert returned no row");
  return toMove(row);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Ids that are not uuids cannot name a row; answering null beats a 22P02 from Postgres. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function selectMove(
  q: Queryable,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<DirectoryMove | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await q.query<RawMove>(
    `SELECT ${MOVE_COLUMNS} FROM directory.move WHERE id = $1${
      options.forUpdate === true ? " FOR UPDATE" : ""
    }`,
    [id],
  );
  return rows[0] === undefined ? undefined : toMove(rows[0]);
}

export async function selectMoves(
  q: Queryable,
  filter: {
    readonly cellId?: string | undefined;
    readonly role?: "source" | "target" | undefined;
    readonly states?: readonly MoveState[] | undefined;
    readonly workspaceId?: string | undefined;
    readonly limit: number;
  },
): Promise<DirectoryMove[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.cellId !== undefined) {
    values.push(filter.cellId);
    const p = `$${values.length}`;
    if (filter.role === "source") where.push(`source_cell_id = ${p}`);
    else if (filter.role === "target") where.push(`target_cell_id = ${p}`);
    else where.push(`(source_cell_id = ${p} OR target_cell_id = ${p})`);
  }
  if (filter.states !== undefined) {
    values.push([...filter.states]);
    where.push(`state = ANY($${values.length}::text[])`);
  }
  if (filter.workspaceId !== undefined) {
    if (!isUuid(filter.workspaceId)) return [];
    values.push(filter.workspaceId);
    const p = `$${values.length}`;
    where.push(`(source_workspace_id = ${p} OR target_workspace_id = ${p})`);
  }
  values.push(filter.limit);
  const { rows } = await q.query<RawMove>(
    `SELECT ${MOVE_COLUMNS} FROM directory.move
      ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY created_at DESC, id LIMIT $${values.length}`,
    values,
  );
  return rows.map(toMove);
}

const TERMINAL = ["retired", "failed", "cancelled"];

export async function casMove(
  q: Queryable,
  id: string,
  t: {
    readonly from: readonly MoveState[];
    readonly to: MoveState;
    readonly leaseOwner?: string | undefined;
    readonly patch?:
      | {
          readonly bundle?: MoveBundle | null | undefined;
          readonly targetWorkspaceId?: string | null | undefined;
          readonly error?: { readonly stage: string; readonly code: string } | null | undefined;
          readonly carried?: MoveCarried | null | undefined;
        }
      | undefined;
  },
): Promise<DirectoryMove | undefined> {
  if (!isUuid(id)) return undefined;
  const values: unknown[] = [id, [...t.from], t.to];
  const sets = ["state = $3", "updated_at = now()"];
  const patch = t.patch ?? {};
  const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
  if ("bundle" in patch && patch.bundle !== undefined) {
    values.push(json(patch.bundle));
    sets.push(`bundle = $${values.length}::jsonb`);
  }
  if ("carried" in patch && patch.carried !== undefined) {
    values.push(json(patch.carried));
    sets.push(`carried = $${values.length}::jsonb`);
  }
  if ("error" in patch && patch.error !== undefined) {
    values.push(
      patch.error === null
        ? null
        : JSON.stringify({ stage: patch.error.stage, code: patch.error.code }),
    );
    sets.push(`error = $${values.length}::jsonb`);
  }
  if ("targetWorkspaceId" in patch && patch.targetWorkspaceId !== undefined) {
    values.push(patch.targetWorkspaceId);
    sets.push(`target_workspace_id = $${values.length}::uuid`);
  }
  if (TERMINAL.includes(t.to)) sets.push("lease_owner = NULL", "lease_expires_at = NULL");
  let leaseClause = "";
  if (t.leaseOwner !== undefined) {
    values.push(t.leaseOwner);
    leaseClause = ` AND lease_owner = $${values.length} AND lease_expires_at > now()`;
  }
  const { rows } = await q.query<RawMove>(
    `UPDATE directory.move SET ${sets.join(", ")}
      WHERE id = $1 AND state = ANY($2::text[])${leaseClause}
      RETURNING ${MOVE_COLUMNS}`,
    values,
  );
  return rows[0] === undefined ? undefined : toMove(rows[0]);
}

export async function takeLease(
  q: Queryable,
  id: string,
  owner: string,
  ttlMs: number,
  from: readonly MoveState[],
): Promise<DirectoryMove | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await q.query<RawMove>(
    `UPDATE directory.move SET lease_owner = $2, lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
            updated_at = now()
      WHERE id = $1 AND state = ANY($4::text[])
        AND (lease_owner IS NULL OR lease_expires_at <= now() OR lease_owner = $2)
      RETURNING ${MOVE_COLUMNS}`,
    [id, owner, ttlMs, [...from]],
  );
  return rows[0] === undefined ? undefined : toMove(rows[0]);
}

export async function extendLease(
  q: Queryable,
  id: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const res = await q.query(
    `UPDATE directory.move SET lease_expires_at = now() + ($3::double precision * interval '1 millisecond')
      WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > now()`,
    [id, owner, ttlMs],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Inside a tx that holds the move row: true when `owner` holds an unexpired lease on it. */
export async function leaseHeld(q: Queryable, id: string, owner: string): Promise<boolean> {
  const { rows } = await q.query<{ ok: boolean }>(
    `SELECT (lease_owner = $2 AND lease_expires_at > now()) AS ok FROM directory.move WHERE id = $1`,
    [id, owner],
  );
  return rows[0]?.ok === true;
}

/** Rebinds an entry to the move's target (switchover). */
export async function rebindEntry(
  q: Queryable,
  entryId: string,
  to: { readonly workspaceId: string; readonly cellId: string },
): Promise<void> {
  await q.query(
    `UPDATE directory.workspace SET workspace_id = $2, cell_id = $3, state = 'active', updated_at = now()
      WHERE entry_id = $1`,
    [entryId, to.workspaceId, to.cellId],
  );
}

export async function lockEntry(q: Queryable, entryId: string): Promise<EntryRow | undefined> {
  const { rows } = await q.query<RawEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM directory.workspace WHERE entry_id = $1 FOR UPDATE`,
    [entryId],
  );
  return rows[0] === undefined ? undefined : toEntry(rows[0]);
}

export async function markSwitched(q: Queryable, id: string): Promise<DirectoryMove | undefined> {
  const { rows } = await q.query<RawMove>(
    `UPDATE directory.move SET state = 'switched', switched_at = now(), updated_at = now() WHERE id = $1
      RETURNING ${MOVE_COLUMNS}`,
    [id],
  );
  return rows[0] === undefined ? undefined : toMove(rows[0]);
}

export async function hasLiveMove(q: Queryable, entryId: string): Promise<boolean> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM directory.move
      WHERE entry_id = $1 AND state NOT IN ('retired', 'failed', 'cancelled')`,
    [entryId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** Every directory hostname bound to an entry of `cellIds` (the sweep's prune input). */
export async function selectHostnamesOfCells(
  q: Queryable,
  cellIds: readonly string[],
): Promise<{ readonly hostname: string; readonly workspaceId: string }[]> {
  if (cellIds.length === 0) return [];
  const { rows } = await q.query<{ hostname: string; workspace_id: string }>(
    `SELECT h.hostname, w.workspace_id FROM directory.hostname h
       JOIN directory.workspace w ON w.entry_id = h.entry_id
      WHERE w.cell_id = ANY($1::text[]) AND w.state <> 'deleted'`,
    [cellIds],
  );
  return rows.map((r) => ({ hostname: r.hostname, workspaceId: r.workspace_id }));
}

/** Releases one entry by id (the sweep displacing a local soft-deleted holder of a slug). */
export async function releaseEntryById(q: Queryable, entryId: string): Promise<void> {
  await q.query("DELETE FROM directory.hostname WHERE entry_id = $1", [entryId]);
  await q.query(
    `UPDATE directory.workspace SET state = 'deleted', updated_at = now()
      WHERE entry_id = $1 AND state <> 'deleted'`,
    [entryId],
  );
}
