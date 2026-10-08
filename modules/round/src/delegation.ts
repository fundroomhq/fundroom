import { ApiError } from "@fundroom/contracts";
import type { Membership } from "@fundroom/db";
import { delegationAdmitsModule } from "@fundroom/domain";

/*
 * Delegates (E3.2). The round is neither data-room nor updates content, so
 * only a delegate with scope `all` reads it (anything narrower gets the 404 a missing round gets),
 * and no delegate writes round data: an indication of interest, its eligibility answers and its
 * evidence are the investor's own statements. Migration 0003_delegates is the floor under both.
 */
export function refuseNarrowDelegate(m: Pick<Membership, "role" | "delegateScope">): void {
  if (m.role === "delegate" && !delegationAdmitsModule(m.delegateScope, "round"))
    throw new ApiError("not_found", "no round to show");
}

export function refuseDelegateWrite(m: Pick<Membership, "role">): void {
  if (m.role === "delegate")
    throw new ApiError("forbidden", "a delegate cannot act in the round for the investor", {
      reason: "delegate_read_only",
    });
}
