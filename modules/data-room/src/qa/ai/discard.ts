import { lockWorkspaceRow, type TenantContext, type Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";

/*
 * AI suggestions die with what they quote (E3.12 fix round 1, review R2-M1). When documents are
 * binned or purged — or a folder with its documents — every `qa_answer` request whose stored
 * result cites one of them is deleted, and so is every request for a question that targeted
 * them. Inside the caller's transaction, after the workspace row (the global lock order: entity
 * rows → workspace row → ai_request rows); the caller has already taken the question rows.
 */
export async function discardAiSuggestions(
  services: Pick<ModuleServices, "ai">,
  tx: Tx,
  ctx: TenantContext,
  opts: { readonly documentIds: readonly string[]; readonly questionIds: readonly string[] },
): Promise<void> {
  if (opts.documentIds.length === 0 && opts.questionIds.length === 0) return;
  await lockWorkspaceRow(tx, ctx.workspaceId); // a no-op when the caller's audit already took it
  for (const id of opts.documentIds) await services.ai.discardCiting(tx, ctx, id);
  for (const id of opts.questionIds) await services.ai.discardForSubject(tx, ctx, "qa_answer", id);
}
