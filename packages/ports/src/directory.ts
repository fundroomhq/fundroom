import type { Jurisdiction } from "./residency.js";

/**
 * The cell directory (EXECUTION_PLAN §15 E3.11, ADR-0059): the only thing shared between cells.
 * A small Postgres schema `directory` at DIRECTORY_DATABASE_URL holding cells, workspace entries
 * (slug → cell), verified hostnames and move rows. No personal data. Implemented by
 * `@fundroom/directory`:
 *
 *  - `local` mode (no DIRECTORY_DATABASE_URL — every self-host and every E3.10 install): a thin
 *    adapter over this database's own `core.cell` / `core.workspace`. Claims always succeed (the
 *    local unique indexes stay the judge), lookups return null, `listCells` returns this
 *    database's cells with `local: true`, the lifecycle calls are no-ops and every `moves`
 *    method throws `ApiError("move_unavailable")`.
 *  - `shared` mode: the directory database decides slug/hostname uniqueness across cells and
 *    routes cross-cell requests (421 `wrong_cell`). `listCells` marks `local: true` for the cells
 *    present in this database's `core.cell`.
 */
export type DirectoryMode = "local" | "shared";

export type DirectoryCellStatus = "active" | "draining" | "closed";

export interface DirectoryCell {
  readonly id: string;
  readonly region: string;
  readonly regionLabel: string;
  readonly jurisdiction: Jurisdiction | null;
  /** The https origin an edge routes this cell's workspaces to; '' = this install. */
  readonly publicOrigin: string;
  readonly status: DirectoryCellStatus;
  /** SPKI PEM (or the format `@fundroom/portability` publishes) of the cell's export signing key. */
  readonly exportPublicKey: string | null;
  /**
   * E3.11 fix R1-6: every export public key of the cell's key ring (current first), each with the
   * ring entry id the export manifest names as `signature.keyId` (= `MoveBundle.signerKeyFingerprint`).
   * A target verifies a bundle against the key whose `keyId` matches. Shared mode always fills it
   * (`[]` when unknown); optional on input so callers without a key ring can publish.
   */
  readonly exportPublicKeys?: readonly { readonly keyId: string; readonly publicKey: string }[];
  readonly heartbeatAt: Date | null;
  /** Served by this database (present in its `core.cell`). */
  readonly local: boolean;
}

/**
 * `dormant` (E3.11 fix R2-3): a soft-deleted workspace inside its restore window. It keeps its slug
 * and hostnames (nobody else can claim them) but is never routed: lookups answer null exactly as
 * for a slug that never existed.
 */
export type DirectoryEntryState = "reserved" | "active" | "moving" | "dormant" | "deleted";

export type MoveState =
  | "requested"
  | "exporting"
  | "exported"
  | "importing"
  | "imported"
  | "switched"
  | "retired"
  | "failed"
  | "cancelled";

export const MOVE_STATES = [
  "requested",
  "exporting",
  "exported",
  "importing",
  "imported",
  "switched",
  "retired",
  "failed",
  "cancelled",
] as const satisfies readonly MoveState[];

/** States a move never leaves. */
export const TERMINAL_MOVE_STATES = [
  "retired",
  "failed",
  "cancelled",
] as const satisfies readonly MoveState[];

export interface MoveBundle {
  /** Presigned GET on the source cell's object store (never shown to anybody). */
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  /** ISO timestamp. */
  readonly expiresAt: string;
  readonly signerKeyFingerprint: string;
}

/** Control-plane facts a move carries from the source to the target copy. */
export interface MoveCarried {
  readonly planId: string | null;
  readonly legalName: string | null;
  readonly country: string | null;
  /** The source's holds minus `relocation`: a held workspace stays held after a move. */
  readonly holds: string[];
  readonly [k: string]: unknown;
}

export interface DirectoryMove {
  readonly id: string;
  readonly entryId: string;
  readonly sourceWorkspaceId: string;
  readonly slug: string;
  readonly sourceCellId: string;
  readonly targetCellId: string;
  readonly state: MoveState;
  readonly bundle: MoveBundle | null;
  readonly carried: MoveCarried | null;
  readonly targetWorkspaceId: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  /** When `switchover` rebound the entry (E3.11 fix RR3-4); null before. Optional on fakes. */
  readonly switchedAt?: Date | null;
  readonly error: { readonly stage: string; readonly code: string } | null;
  /** Opaque operator reference (never an email). */
  readonly requestedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DirectoryMoves {
  request(input: {
    workspaceId: string;
    slug: string;
    sourceCellId: string;
    targetCellId: string;
    requestedBy: string;
    carried: MoveCarried;
  }): Promise<DirectoryMove | "busy" | "unknown_workspace">;
  get(id: string): Promise<DirectoryMove | null>;
  list(filter: {
    cellId?: string;
    role?: "source" | "target";
    states?: MoveState[];
    workspaceId?: string;
    limit?: number;
  }): Promise<DirectoryMove[]>;
  /** Compare-and-set; returns null when the row was not in one of `from` (or lease not held when leaseOwner given). */
  transition(
    id: string,
    t: {
      from: MoveState[];
      to: MoveState;
      leaseOwner?: string;
      patch?: Partial<Pick<DirectoryMove, "bundle" | "targetWorkspaceId" | "error" | "carried">>;
    },
  ): Promise<DirectoryMove | null>;
  acquireLease(
    id: string,
    owner: string,
    ttlMs: number,
    from: MoveState[],
  ): Promise<DirectoryMove | null>;
  heartbeat(id: string, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * One directory tx: entry.workspace_id := targetWorkspaceId, entry.cell_id := move.target_cell_id,
   * entry.state := 'active', move.state := 'switched'. Requires state 'imported' and the lease.
   */
  switchover(id: string, owner: string): Promise<DirectoryMove | null>;
}

export interface DirectoryPort {
  readonly mode: DirectoryMode;
  listCells(): Promise<DirectoryCell[]>;
  /** shared: upsert this cell's row + heartbeat; local: no-op. */
  publishCell(cell: Omit<DirectoryCell, "local" | "heartbeatAt">): Promise<void>;
  lookupSlug(
    slug: string,
  ): Promise<{ cellId: string; state: "reserved" | "active" | "moving" } | null>;
  lookupHost(hostname: string): Promise<{ cellId: string } | null>;
  lookupWorkspace(
    workspaceId: string,
  ): Promise<{ entryId: string; cellId: string; state: DirectoryEntryState } | null>;
  /** Entry state `reserved`. */
  claimSlug(input: {
    workspaceId: string;
    slug: string;
    cellId: string;
  }): Promise<"claimed" | "taken">;
  /** reserved → active (idempotent). */
  activate(workspaceId: string): Promise<void>;
  renameSlug(input: { workspaceId: string; to: string }): Promise<"renamed" | "taken">;
  /** → deleted (frees the slug and its hostnames). */
  release(workspaceId: string): Promise<void>;
  /**
   * Any non-deleted entry. `dormant` on soft delete, `active` on restore (E3.11 fix R2-3); `moving`
   * / `active` around a move.
   */
  setState(workspaceId: string, state: "active" | "moving" | "dormant"): Promise<void>;
  claimHost(input: { hostname: string; workspaceId: string }): Promise<"claimed" | "taken">;
  releaseHost(input: { hostname: string; workspaceId: string }): Promise<void>;
  /** Local mode: every method throws `ApiError("move_unavailable")`. */
  readonly moves: DirectoryMoves;
  close(): Promise<void>;
}
