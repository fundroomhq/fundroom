import type { JobQueuePort, TransactionHandle } from "@fundroom/ports";

/*
 * The `billing.cancel` outbox job's name and enqueue (E3.10 R3-L1), apart from `jobs.ts` so the
 * webhook ingest can enqueue it too without an import cycle. The job body is in `jobs.ts`.
 */

/**
 * Cancels a workspace's provider subscription (R3-L1): enqueued IN the transaction that soft-deletes
 * the workspace or confirms a sanctions match (the outbox: the job exists iff that commits).
 */
export const BILLING_CANCEL_JOB = "billing.cancel";

export type BillingCancelReason = "deleted" | "sanctions";

/**
 * Enqueues `billing.cancel` inside `tx`. `subscriptionId`: a provider subscription to cancel
 * besides the one the workspace's row stores (a late checkout, a second subscription — FR4-1);
 * one queued job per (workspace, subscription).
 */
export async function enqueueBillingCancel(
  queue: Pick<JobQueuePort, "sendInTransaction">,
  tx: TransactionHandle,
  workspaceId: string,
  reason: BillingCancelReason,
  subscriptionId?: string | undefined,
): Promise<void> {
  await queue.sendInTransaction(
    tx,
    BILLING_CANCEL_JOB,
    subscriptionId === undefined
      ? { workspaceId, reason }
      : { workspaceId, reason, subscriptionId },
    { idempotencyKey: `cancel:${workspaceId}:${subscriptionId ?? "stored"}` },
  );
}
