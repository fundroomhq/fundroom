import { lockWorkspaceRow, type TenantContext } from "@fundroom/db";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import { QA_ERASED_TEXT } from "./rules.js";
import { unindexQuestion } from "./search.js";

/*
 * DSAR erasure (E3.3 D7) of a member's data-room questions, on `member.erasure_requested`.
 *
 * Every question the member asked loses its words — subject, body and public wording become
 * "[erased]" — and ends `closed` with reason `erased`, one already closed (declined, withdrawn)
 * included: `erased` is what bars reopening, releasing or answering it afterwards. A
 * published one therefore leaves search and the target's thread; the staff answer row stays
 * (the firm's text, and its audit trail) but nobody can read it any more: a closed question is
 * visible to its asker only, and the asker is gone.
 *
 * **Not gated on enablement**: a DSAR must reach rows written while the module was on, and the
 * kernel waits for a step from every module that handles the topic. Runs in the dispatcher's
 * per-workspace system transaction; a retry finds the rows already erased and reports again.
 */
export function createQaErasureHandler(live: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx }) => {
    if (event.topic !== "member.erasure_requested")
      throw new Error(`data-room: member.erasure_requested handler got ${event.topic}`);
    if (ctx.actorKind === "host") return;
    const services = live();
    const tenant = ctx as TenantContext;
    const { requestId, membershipId } = (
      event as unknown as EventEnvelope<"member.erasure_requested">
    ).payload;
    const repo = new QaLifecycleRepo(tenant, tx);
    // Row-locks the questions first (id order): question rows precede search entries and the
    // audit chain in the Q&A lock order, and a staff action holds its row while it re-indexes.
    const asked = await repo.askedBy(membershipId);
    // E3.12: AI suggestions drafted from these questions (built from the member's words) go too.
    // Global lock order (fix round 1, R1-M2): ai_request rows are locked only AFTER the workspace
    // row — `PUT /ai/settings` holds the workspace row and then cancels in-flight requests. The
    // workspace row comes right after the question rows here (the Q&A order) and before the
    // search entries and the audit chain, which would take it anyway.
    await lockWorkspaceRow(tx, tenant.workspaceId);
    for (const q of asked) await services.ai.discardForSubject(tx, tenant, "qa_answer", q.id);
    const published = asked.filter((q) => q.status === "published");
    for (const q of published) await unindexQuestion(services, tx, tenant, q.id);
    const questions = await repo.erase(
      asked.map((q) => q.id),
      QA_ERASED_TEXT,
      services.now(),
    );
    await services.legal.completeErasureStep(tx, tenant, requestId, "data-room", {
      questions,
      unpublished: published.length,
    });
  };
}
