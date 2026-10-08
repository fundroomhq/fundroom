import type { TenantContext } from "@fundroom/db";
import type { EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { ERASED_HOLDER_NAME } from "./model.js";
import { CaptableRepo } from "./repos/captable-repo.js";

/*
 * `member.erasure_requested` (E2.6/E3.6): the member's holding lines — linked to the membership,
 * or unlinked but carrying the member's address — are pseudonymised: the name becomes
 * "Erased holder", the address and the member link are cleared and `erased_at` is set (the
 * migration's `holding_guard` admits exactly that change). The shares and amounts stay: a cap
 * table is the company's record of who holds what, and a line vanishing would make every total
 * and every other holder's percentage wrong.
 *
 * **Not gated on enablement**: a DSAR must reach lines imported while the module was on. Runs
 * in the dispatcher's transaction after the kernel's `prelockErasureSubject`, then takes the
 * cap-table lock, so an import running beside it either commits first (and its lines are erased
 * here) or starts after (and sees the erasure through `legal.isErased`). Idempotent: a redelivery
 * finds nothing un-erased and reports zero; the kernel keeps the first report.
 */
export function createErasureHandler(live: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx }) => {
    if (ctx.actorKind === "host") return;
    const services = live();
    const tenant = ctx as TenantContext;
    const { requestId, membershipId } = event.payload as {
      requestId: string;
      membershipId: string;
    };
    const repo = new CaptableRepo(tenant, tx);
    await repo.lockWorkspace();
    // The addresses are still readable: the kernel's identity step runs after every module reported.
    const ids = await repo.lockSubjectHoldings(membershipId, await repo.memberEmails(membershipId));
    const holdings = await repo.pseudonymise(ids, ERASED_HOLDER_NAME, services.now());
    if (holdings > 0) {
      await services.audit.record(tx, tenant, {
        action: "captable.holder_erased",
        resourceKind: "membership",
        resourceId: membershipId,
        subjectMembershipId: membershipId,
        meta: { requestId, holdings },
      });
    }
    await services.legal.completeErasureStep(tx, tenant, requestId, "captable", { holdings });
  };
}
