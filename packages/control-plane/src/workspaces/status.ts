import type { AuditRecorder } from "@fundroom/audit";
import { PLATFORM_WORKSPACE_ID, platformContext, systemContext, type Tx } from "@fundroom/db";
import type { JsonObject, SuspendReason, WorkspaceHold, WorkspaceStatus } from "@fundroom/ports";
import {
  enterSystemContext,
  lockWorkspaceHolds,
  readTxContext,
  restoreTxContext,
  writeWorkspaceHolds,
} from "./repos/status-repo.js";

/*
 * Workspace holds (E3.10, ADR-0058): the ONE way a workspace's availability changes.
 *
 * A workspace carries independent flags (`core.workspace.holds`), each set and cleared by its own
 * owner:
 *
 *   sanctions_review   a new workspace, until its first sanctions screen is clear or cleared
 *                      (sanctions service; operator "release" with a cleared latest screening)
 *   operator           an operator's suspension (operator suspend / unsuspend)
 *   billing            the grace period ran out (billing enforce job; paid again → cleared)
 *   sanctions          an operator confirmed a sanctions match; lifted only by an operator, and
 *                      only once a LATER screening is clear or cleared — clearing some other open
 *                      screening never lifts it
 *   relocation         E3.11: the workspace is moving to another cell (moves engine only; set on
 *                      both the source and the target copy, lifted by the target after switchover)
 *
 * `status` / `suspended_reason` / `suspended_at` are DERIVED from the flags by a trigger
 * (`workspace_derive_status`, 0023) — tenant resolution and the status guard read them:
 * `suspended` while any of operator / billing / sanctions / relocation is set (reason = the
 * highest, sanctions > operator > relocation > billing), `pending_review` while only `sanctions_review` is, else
 * `active`. `deriveWorkspaceStatus` below is the same rule in TypeScript (unit-tested against the
 * trigger in `workspace-status.integration.test.ts`).
 *
 * Because every owner touches only its own flag, no owner can undo another's: an operator's
 * unsuspend leaves a sanctions review in place, a paid invoice cannot lift an operator
 * suspension, and a cleared rescreen cannot lift a confirmed sanctions suspension.
 *
 * Audit: every call that changes the flags records one entry on the workspace's chain and one on
 * the platform chain — `workspace.hold` / `workspace.release` for `sanctions_review`,
 * `workspace.suspend` / `workspace.unsuspend` for the others — with `meta { hold, on, from, to,
 * holds }` (the derived status before and after, which may be unchanged: a billing flag raised
 * under an operator suspension is still on the record). Setting a flag that is set (or clearing
 * one that is clear) is a no-op with no audit. On the tenant's chain an operator is the `host`
 * actor with NO user id (`meta.operator: true` only); the platform chain has the operator's user
 * id, IP, user agent, session and note.
 *
 * Lock order (global, see `apps/server/src/lock-order*.integration.test.ts`): the caller takes its
 * own rows (subscription, screening, …) first, then calls this BEFORE its own first audit. This
 * locks the workspace row `FOR NO KEY UPDATE` (what `lockAuditChain` takes first), writes it,
 * audits the workspace's chain, then the platform chain — so the order is workspace row →
 * workspace chain → platform chain. A caller that audits more after this must keep that order
 * (its own tenant audits before any platform audit of its own).
 *
 * The transaction may be in any context (host, system, a tenant's): the function switches it to
 * the workspace's `system` actor (the guard trigger admits only host/system writers, the audit
 * fence needs the workspace) and then the platform pseudo-workspace's, and restores the caller's
 * context before it returns. It never opens a connection of its own.
 *
 * Caches: multi-tenant resolution reads the row on every request, so a change is live on the next
 * request after commit; the single-tenant resolver caches its row for 30 s, which is what the
 * returned `afterCommit()` drops. Call it after the transaction commits.
 */

/** Who changed the flags. An operator is recorded as the `host` actor. */
export type ControlPlaneActor =
  | {
      readonly kind: "operator";
      readonly userId: string;
      readonly sessionId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly ip?: string | undefined;
      readonly userAgent?: string | undefined;
    }
  | {
      readonly kind: "system";
      /**
       * What decided it: `billing` (grace expired / paid), `sanctions`, `provisioning`, `cli`,
       * `enrol` (a new operator's enrolment link, fix round 2).
       */
      readonly source:
        | "billing"
        | "sanctions"
        | "provisioning"
        | "signup"
        | "cli"
        | "enrol"
        /** E3.11: the region boot check (placeholder cells adopting DATA_REGION). */
        | "boot"
        /** E3.11: the moves engine (the `relocation` hold). */
        | "move";
      readonly requestId?: string | undefined;
    };

export interface SetWorkspaceHoldInput {
  readonly workspaceId: string;
  readonly hold: WorkspaceHold;
  /** `true` sets the flag, `false` clears it. */
  readonly on: boolean;
  readonly actor: ControlPlaneActor;
  /** The operator's note; recorded on the platform chain only (up to 500 characters). */
  readonly note?: string | undefined;
  /** Extra ids for both audit rows (a screening id, a subscription status). Never PII. */
  readonly meta?: JsonObject | undefined;
}

export interface WorkspaceStatusDeps {
  readonly audit: AuditRecorder;
  /** Drops cached `ResolvedWorkspace` rows (`WorkspaceResolver.invalidate`); run by `afterCommit`. */
  readonly invalidate: () => void;
  readonly now?: (() => Date) | undefined;
}

export interface WorkspaceHoldState {
  readonly status: WorkspaceStatus;
  readonly reason: SuspendReason | null;
  /** Sorted. */
  readonly holds: readonly WorkspaceHold[];
}

export type WorkspaceStatusAction =
  | "workspace.suspend"
  | "workspace.unsuspend"
  | "workspace.hold"
  | "workspace.release";

export interface WorkspaceHoldChange {
  /** The flags changed (and were audited). */
  readonly changed: boolean;
  readonly before: WorkspaceHoldState;
  /** The state after the call (equal to `before` when nothing changed). */
  readonly after: WorkspaceHoldState;
  readonly action: WorkspaceStatusAction | null;
  /** Drop the resolver caches. Call after the transaction commits (a no-op when unchanged). */
  afterCommit(): void;
}

export class WorkspaceStatusError extends Error {
  override readonly name = "WorkspaceStatusError";
  constructor(
    readonly reason: "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** Suspension reasons, highest first (the derived `suspended_reason`). */
const SUSPENSION_RANK: readonly SuspendReason[] = [
  "sanctions",
  "operator",
  "relocation",
  "billing",
];

/** The trigger's rule (0023 `workspace_derive_status`), pure. */
export function deriveWorkspaceStatus(holds: readonly WorkspaceHold[]): {
  readonly status: WorkspaceStatus;
  readonly reason: SuspendReason | null;
} {
  const reason = SUSPENSION_RANK.find((r) => holds.includes(r)) ?? null;
  if (reason !== null) return { status: "suspended", reason };
  return { status: holds.includes("sanctions_review") ? "pending_review" : "active", reason: null };
}

/** The flags after setting / clearing one, sorted like the trigger stores them. */
export function applyHold(
  holds: readonly WorkspaceHold[],
  hold: WorkspaceHold,
  on: boolean,
): WorkspaceHold[] {
  const next = new Set(holds);
  if (on) next.add(hold);
  else next.delete(hold);
  return [...next].sort();
}

/** The audit action for a flag change. */
export function holdAction(hold: WorkspaceHold, on: boolean): WorkspaceStatusAction {
  if (hold === "sanctions_review") return on ? "workspace.hold" : "workspace.release";
  return on ? "workspace.suspend" : "workspace.unsuspend";
}

function stateOf(holds: readonly WorkspaceHold[]): WorkspaceHoldState {
  return { ...deriveWorkspaceStatus(holds), holds };
}

/** Sets or clears one flag (see the header). Call inside a transaction that has not audited. */
export async function setWorkspaceHold(
  tx: Tx,
  input: SetWorkspaceHoldInput,
  deps: WorkspaceStatusDeps,
): Promise<WorkspaceHoldChange> {
  const now = deps.now ?? (() => new Date());
  const saved = await readTxContext(tx);
  let result: WorkspaceHoldChange;
  try {
    await enterSystemContext(tx, input.workspaceId);
    const row = await lockWorkspaceHolds(tx, input.workspaceId);
    if (row === undefined) {
      throw new WorkspaceStatusError("not_found", "no such workspace");
    }
    const before = stateOf([...row.holds].sort());
    const nextHolds = applyHold(before.holds, input.hold, input.on);
    if (nextHolds.join(",") === before.holds.join(",")) {
      result = { changed: false, before, after: before, action: null, afterCommit: () => {} };
    } else {
      const at = now();
      // The trigger derives status / reason / suspended_at from the flags; `at` is used as
      // `suspended_at` only when this call is what suspends the workspace.
      const written = await writeWorkspaceHolds(tx, input.workspaceId, nextHolds, at);
      const after: WorkspaceHoldState = {
        status: written.status,
        reason: written.suspendedReason,
        holds: nextHolds,
      };
      const action = holdAction(input.hold, input.on);
      const actor = input.actor;
      const operator = actor.kind === "operator" ? actor : undefined;
      const common = {
        action,
        resourceKind: "workspace",
        resourceId: input.workspaceId,
        actorMembershipId: null,
        requestId: actor.requestId ?? null,
        occurredAt: at,
      } as const;
      const facts: JsonObject = {
        ...(input.meta ?? {}),
        hold: input.hold,
        on: input.on,
        from: before.status,
        to: after.status,
        ...(before.reason === null ? {} : { fromReason: before.reason }),
        ...(after.reason === null ? {} : { reason: after.reason }),
        holds: [...nextHolds],
        ...(operator !== undefined
          ? { operator: true }
          : { source: (actor as { source: string }).source }),
      };
      // The tenant's own chain: what happened to their workspace. An operator shows as the host
      // actor with no user id, IP, user agent or note — those belong to the operator's record.
      await deps.audit.record(tx, systemContext(input.workspaceId), {
        ...common,
        actorKind: operator !== undefined ? "host" : "system",
        actorUserId: null,
        meta: facts,
      });
      // The platform chain: the same event with the operator's request facts.
      await enterSystemContext(tx, PLATFORM_WORKSPACE_ID);
      await deps.audit.record(tx, platformContext(), {
        ...common,
        actorKind: "host",
        actorUserId: operator?.userId ?? null,
        ip: operator?.ip ?? null,
        userAgent: operator?.userAgent ?? null,
        sessionId: operator?.sessionId ?? null,
        meta: {
          ...facts,
          workspaceId: input.workspaceId,
          ...(input.note === undefined ? {} : { note: input.note.slice(0, 500) }),
        },
      });
      result = {
        changed: true,
        before,
        after,
        action,
        afterCommit: () => deps.invalidate(),
      };
    }
  } catch (error) {
    // The transaction is usually aborted by now and the restore fails too; the caller's error is
    // the one that matters.
    await restoreTxContext(tx, saved).catch(() => {});
    throw error;
  }
  await restoreTxContext(tx, saved);
  return result;
}
