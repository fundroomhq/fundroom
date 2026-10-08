import type { Capability, GrantEffect, SubjectRef } from "./authz.js";

/**
 * External relationship engine port (EXECUTION_PLAN §15 E3.13, ADR-0061).
 *
 * Postgres stays the source of truth for access and keeps materialising `core.effective_access`
 * (RLS reads it). An external engine (adapter `@fundroom/authz-openfga`) receives a projection of
 * the RAW rules of one workspace and answers capability questions for non-delegate external
 * principals. The kernel (`@fundroom/authz` `withRelationshipEngine`) uses it in `shadow` mode
 * (compare only) or `enforce` mode (it can only narrow Postgres's answer; errors fail closed).
 *
 * The engine must reproduce ADR-0032 resolution over the rules covering a node (itself plus its
 * ancestors via `parent`): nearest node first, then subject specificity (membership > link >
 * group > role), exclude wins a full tie; a rule counts only while `at` is inside its validity.
 * Gates, the staff-only veil, delegates, staff role capabilities, explain/whoHasAccess and
 * max_views stay in Postgres.
 */

/** A resource and its parent (folders, documents, …); flat resources have `parent: null`. */
export interface RelationshipNode {
  readonly kind: string;
  readonly id: string;
  readonly parent: { readonly kind: string; readonly id: string } | null;
}

/** An external, active, non-delegate membership and what it belongs to. */
export interface RelationshipMember {
  readonly membershipId: string;
  readonly role: string;
  readonly groupIds: readonly string[];
  readonly linkIds: readonly string[];
}

/** One live (not revoked) grant of the workspace, any validity window (conditions decide time). */
export interface RelationshipRule {
  readonly id: string;
  readonly subject: SubjectRef;
  readonly resource: { readonly kind: string; readonly id: string };
  readonly capability: Capability;
  readonly effect: GrantEffect;
  /** ISO; null = unbounded. */
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface RelationshipSnapshot {
  readonly workspaceId: string;
  readonly aclVersion: number;
  readonly nodes: readonly RelationshipNode[];
  readonly members: readonly RelationshipMember[];
  readonly rules: readonly RelationshipRule[];
  /**
   * Every resource kind the installation can ask about (the module registry's resource kinds, plus
   * `folder`/`document` when the data room exists), whether or not a node or rule of this workspace
   * mentions it yet (FIX3 RR2-1): the model must declare them all, so a node of a kind first created
   * after the sync (the room's first document) is decided rather than refused. Optional for old
   * callers; the engine adds the kinds its nodes and rules mention anyway.
   */
  readonly kinds?: readonly string[] | undefined;
}

/** What the kernel persists in `core.authz_engine_state` between calls. */
export interface EngineState {
  readonly storeRef: string | null;
  readonly modelRef: string | null;
}

/** A node reference (`kind`, `id`). */
export interface RelationshipNodeRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * A resource to decide, with its ancestor chain as the kernel knows it NOW (nearest first: the
 * node's parent, then the parent's parent, …). The engine adds them as contextual `parent` links,
 * so a node created after the last sync (or moved since) resolves through its current ancestors
 * without waiting for a sync. Omitted/empty: the synced tree alone decides. A chain too long for
 * the engine to send is a per-item failure (`batchCheck`) or an error (`check`), never a widening.
 */
export interface RelationshipResource extends RelationshipNodeRef {
  readonly ancestors?: readonly RelationshipNodeRef[] | undefined;
}

/** `batchCheck` result: allowed ids, and the ids the engine could not decide (deny those). */
export interface RelationshipBatchResult {
  readonly allowed: ReadonlySet<string>;
  readonly failed: ReadonlyMap<string, RelationshipEngineErrorCode>;
}

export interface RelationshipEnginePort {
  readonly driver: string;
  /** Make the engine's state equal to the snapshot (full diff, idempotent). Returns refs to persist. */
  sync(
    snapshot: RelationshipSnapshot,
    state: EngineState,
  ): Promise<EngineState & { readonly writes: number; readonly deletes: number }>;
  check(
    state: EngineState,
    q: {
      readonly membershipId: string;
      readonly resource: RelationshipResource;
      readonly capabilities: readonly Capability[];
      readonly at: Date;
    },
  ): Promise<Readonly<Record<Capability, boolean>>>;
  /**
   * The ids (of `resources`) on which the member holds `capability` at `at`. A failure of one item
   * lands in `failed` (the caller denies it); only a whole-request failure throws.
   */
  batchCheck(
    state: EngineState,
    q: {
      readonly membershipId: string;
      readonly resources: readonly RelationshipResource[];
      readonly capability: Capability;
      readonly at: Date;
    },
  ): Promise<RelationshipBatchResult>;
  dropWorkspace(state: EngineState): Promise<void>;
  healthCheck(): Promise<void>;
}

export const RELATIONSHIP_ENGINE_ERROR_CODES = [
  "unreachable",
  "timeout",
  "rejected",
  "unauthorized",
  "invalid_response",
] as const;
export type RelationshipEngineErrorCode = (typeof RELATIONSHIP_ENGINE_ERROR_CODES)[number];

export class RelationshipEngineError extends Error {
  override readonly name = "RelationshipEngineError";
  constructor(
    readonly code: RelationshipEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
