import { ApiError } from "@fundroom/contracts";
import type { TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { QaQuestionRepo } from "../../repos/qa-repo.js";

/*
 * `POST /data-room/qa/inbox/{id}/ai-suggestion` (E3.12): start (or reuse the caller's in-flight)
 * `qa_answer` request for a question. 404 for an unknown question and for an erased asker's
 * (a tombstone — nothing is drafted for it). `AiServices.start` runs its own short transactions,
 * so the question is read in one of ours first and `start` is called with none held.
 */

export async function startQaSuggestion(
  services: ModuleServices,
  ctx: TenantContext,
  questionId: string,
  actor: { readonly membershipId: string; readonly userId: string },
): Promise<{ readonly requestId: string }> {
  const q = await services.db.withTenant(ctx, (tx) => new QaQuestionRepo(ctx, tx).byId(questionId));
  if (q === undefined || q.closedReason === "erased")
    throw new ApiError("not_found", "no such question");
  // An `AiStartError` propagates: the API error handler answers it as the error of the same
  // code (409 / 429 + Retry-After).
  const started = await services.ai.start(ctx, {
    feature: "qa_answer",
    subjectId: q.id,
    params: {},
    actor,
  });
  return { requestId: started.requestId };
}
