import type { TenantContext, Tx } from "@fundroom/db";
import { ESignError } from "./errors.js";
import { ESignConnectionRepo } from "./repos/connection-repo.js";

/**
 * For the compliance route that sets a legal document's ceremony to `esign` (C2): takes the
 * connection advisory lock in the caller's transaction and refuses (409 `esign_not_configured`)
 * when no connection is live. Holding the lock to commit means a concurrent connection delete
 * (which takes the same lock and then counts `esign` documents) cannot interleave. Call it BEFORE
 * the transaction's first audit entry (lock order: advisory lock → rows → audit chain).
 */
export async function assertESignConnected(tx: Tx, ctx: TenantContext): Promise<void> {
  const repo = new ESignConnectionRepo(ctx, tx);
  await repo.lockSingleton();
  if ((await repo.live()) === undefined) {
    throw new ESignError("esign_not_configured", "connect an e-signature provider first");
  }
}
