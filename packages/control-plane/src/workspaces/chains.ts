import type { AuditInput, AuditRecorder } from "@fundroom/audit";
import { PLATFORM_WORKSPACE_ID, platformContext, systemContext, type Tx } from "@fundroom/db";
import type { JsonObject } from "@fundroom/ports";
import { enterSystemContext, readTxContext, restoreTxContext } from "./repos/status-repo.js";
import type { ControlPlaneActor } from "./status.js";

/*
 * Writing the two audit chains from one transaction (E3.10). An operator write that concerns a
 * tenant is recorded twice (contract §5.2): on the workspace's own chain, where the tenant sees
 * who did what to it, and on the platform chain with the operator's request facts (IP, user agent,
 * session, note). The audit fence needs the transaction's `app.workspace_id` to be the chain's
 * workspace, so each helper switches the transaction-local context, records, and restores the
 * caller's — exactly what `setWorkspaceHold` does.
 *
 * Order (the global lock order): the caller's own rows, then the tenant chain, then the platform
 * chain. Never a tenant audit after a platform one in the same transaction.
 *
 * An operator is recorded as the `host` actor with `meta.operator: true` (the actor-kind CHECK has
 * no `operator`) — with its user id on the platform chain only; a system actor as `system` with
 * `meta.source`.
 */

/** The actor columns and facts both chains share. */
export function actorFields(actor: ControlPlaneActor): {
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly facts: JsonObject;
} {
  return actor.kind === "operator"
    ? { actorUserId: actor.userId, requestId: actor.requestId ?? null, facts: { operator: true } }
    : { actorUserId: null, requestId: actor.requestId ?? null, facts: { source: actor.source } };
}

/** The request facts that go on the platform chain only. */
function requestFacts(actor: ControlPlaneActor) {
  return actor.kind === "operator"
    ? {
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        sessionId: actor.sessionId ?? null,
      }
    : {};
}

export type ChainEntry = Omit<
  AuditInput,
  "actorKind" | "actorUserId" | "actorMembershipId" | "requestId"
>;

/**
 * Records `entry` on the workspace's own chain as the host (operator) or system actor. An operator
 * is `meta.operator: true` with NO user id here: which operator acted is platform business (the
 * platform chain has it), and a tenant's audit export must not carry the operator's identity.
 */
export async function auditTenantChain(
  tx: Tx,
  audit: AuditRecorder,
  workspaceId: string,
  actor: ControlPlaneActor,
  entry: ChainEntry,
): Promise<void> {
  const saved = await readTxContext(tx);
  const a = actorFields(actor);
  await enterSystemContext(tx, workspaceId);
  await audit.record(tx, systemContext(workspaceId), {
    ...entry,
    actorKind: actor.kind === "operator" ? "host" : "system",
    actorMembershipId: null,
    actorUserId: null,
    requestId: a.requestId,
    meta: { ...(entry.meta ?? {}), ...a.facts },
  });
  await restoreTxContext(tx, saved);
}

/** Records `entry` on the platform chain (`PLATFORM_WORKSPACE_ID`) with the request facts. */
export async function auditPlatformChain(
  tx: Tx,
  audit: AuditRecorder,
  actor: ControlPlaneActor,
  entry: ChainEntry,
): Promise<void> {
  const saved = await readTxContext(tx);
  const a = actorFields(actor);
  await enterSystemContext(tx, PLATFORM_WORKSPACE_ID);
  await audit.record(tx, platformContext(), {
    ...requestFacts(actor),
    ...entry,
    actorKind: "host",
    actorMembershipId: null,
    actorUserId: a.actorUserId,
    requestId: a.requestId,
    meta: { ...(entry.meta ?? {}), ...a.facts },
  });
  await restoreTxContext(tx, saved);
}
