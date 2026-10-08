import type { TenantContext } from "@fundroom/db";
import type { EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { VerificationRepo } from "./repos/round-repo.js";

/*
 * `member.erasure_requested` (E3.7): the round keeps its verification rows as legal evidence (the
 * decision, its method, the digest of what was read — E2.6 decision 5), but not the vendor
 * handoff: a Parallel widget config carries the investor's email and name. Every verification of
 * the member keeps only the handoff's kind, and a pending vendor one stops being polled
 * (`vendor_error = 'member_erased'`; the start and sync jobs also refuse an erased member).
 *
 * **Not gated on enablement**: rows written while the module was on must be reached with it off.
 * Runs in the dispatcher's transaction after the kernel's `prelockErasureSubject`; it updates its
 * rows before its audit entry (row locks → audit chain, the global order). Idempotent: a
 * redelivery rewrites the same values, and the kernel keeps the first report.
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
    const verifications = await new VerificationRepo(tenant, tx).eraseMember(membershipId);
    if (verifications > 0) {
      await services.audit.record(tx, tenant, {
        action: "round.verification_member_erased",
        actorKind: "system",
        resourceKind: "membership",
        resourceId: membershipId,
        subjectMembershipId: membershipId,
        meta: { requestId, verifications },
      });
    }
    await services.legal.completeErasureStep(tx, tenant, requestId, "round", { verifications });
  };
}
