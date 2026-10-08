import type { TenantContext, Tx } from "@fundroom/db";
import { AiRequestRepo } from "./repos/ai-repo.js";

/**
 * Member erasure (E3.12 contract §7): deletes every AI request the member started, inside the
 * identity step's transaction (`packages/compliance/src/service/identity-erasure.ts`). Row locks
 * only. A request whose model call is under way is emptied at once (params and result cleared,
 * `discarded`) and deleted when its job settles — it keeps its in-flight slot until then (RR1-M1). A
 * start racing the erasure commits a row the erasure could not see; its job then refuses it
 * (`forbidden`: the membership is revoked) and the hourly sweep deletes it at `expires_at`.
 */
export async function deleteAiRequestsOfMember(
  tx: Tx,
  ctx: TenantContext,
  membershipId: string,
): Promise<number> {
  return new AiRequestRepo(ctx, tx).deleteRequestedBy(membershipId, new Date());
}
