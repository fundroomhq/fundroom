import { type Database, systemContext, type Tx } from "@fundroom/db";
import { readForcedWatermark } from "../repos/share-link-repo.js";

/**
 * What a share link forces on the protection of everything its visitors see (E3.13; the
 * `ModuleServices.shareLinks` seam). Only the visible watermark can be forced — and only ON
 * (`LinkPolicy.forceWatermark`: "a link may force watermarking on; it may never turn an inherited
 * watermark off"). The forensic mark is never forced by links.
 */
export interface ForcedProtection {
  readonly forceWatermark: boolean;
}

export interface ShareLinkProtectionService {
  /**
   * Pass the caller's `tx` when it holds one (it must be fenced to `workspaceId`, any actor
   * kind): a second pool connection while holding a transaction deadlocks a saturated pool.
   * Without `tx` the read runs in its own short system-context transaction.
   */
  forcedProtection(workspaceId: string, membershipId: string, tx?: Tx): Promise<ForcedProtection>;
}

export function createShareLinkProtection(db: Database): ShareLinkProtectionService {
  return {
    async forcedProtection(workspaceId, membershipId, tx) {
      const forceWatermark =
        tx === undefined
          ? await db.withTenant(systemContext(workspaceId), (t) =>
              readForcedWatermark(t, workspaceId, membershipId),
            )
          : await readForcedWatermark(tx, workspaceId, membershipId);
      return { forceWatermark };
    },
  };
}
