import type { TransactionHandle } from "./jobs.js";

/**
 * Cross-agent seams of the managed-host control plane (EXECUTION_PLAN §15 E3.10, ADR-0058),
 * implemented by `@fundroom/control-plane`, `@fundroom/billing` and `@fundroom/sanctions` and
 * wired through the server's container.
 *
 * A workspace's availability changes ONLY through `@fundroom/control-plane` `setWorkspaceHold`:
 * independent flags (`WorkspaceHold`), from which the status and suspend reason are derived.
 */
export type WorkspaceStatus = "active" | "pending_review" | "suspended";
/** E3.11 adds `relocation`: set while the workspace moves to another cell (ranked below `operator`). */
export type SuspendReason = "operator" | "billing" | "sanctions" | "relocation";
/** `sanctions_review` holds (`pending_review`); the others suspend. */
export type WorkspaceHold = "sanctions_review" | SuspendReason;

/** The facts a new workspace is provisioned with (operator create, self-service signup). */
export interface ProvisionedWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string | null;
  readonly planId: string | null;
  readonly ownerEmail: string;
}

export interface ControlPlaneHooks {
  /**
   * Called in-tx (host context) by the provisioning path after the workspace row exists, before
   * the provisioning path's first audit. Network work is enqueued (`sendInTransaction`), never
   * done here. May hold the workspace (`sanctions_review`) through `setWorkspaceHold`.
   */
  onWorkspaceCreated?(tx: TransactionHandle, ws: ProvisionedWorkspace): Promise<void>;
}
