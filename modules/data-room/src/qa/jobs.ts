import {
  listActiveWorkspaceIds,
  lockWorkspaceFacts,
  systemContext,
  type TenantContext,
} from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import { slaState } from "./rules.js";

/*
 * The Q&A SLA sweep (E3.3 D7): `data-room.qa-sla`, every 15 minutes, singleton. Per active
 * workspace — each in its own tenant transaction, skipped while the data room or Q&A is off —
 * every unanswered question gets at most one `due_soon` reminder (once `now` is within
 * `reminderLeadHours` of `due_at`; never when the lead is 0) and at most one `overdue`
 * reminder (at or after `due_at`). Each reminder is a stamp on the row, a system audit entry
 * `qa.question_due` and a `qa.question_due` event (notify turns it into mail). A question that
 * is already overdue when first seen gets only the overdue reminder: "due soon" would be a lie.
 * One failing workspace is logged and skipped; its reminders go out on the next run.
 *
 * Lock order (the Q&A order: question rows → workspace row FOR NO KEY UPDATE → search entries →
 * audit chain → outbox; the global rule, E3.5 LX, is workspace row → audit chain, and every
 * audit takes the row first). The transaction row-locks the workspace (FOR NO KEY UPDATE, which
 * is also where it reads the Q&A settings — never FOR SHARE: the audit below would have to
 * upgrade it) and then every candidate question in ONE statement (`dueCandidates`, FOR UPDATE
 * SKIP LOCKED), all BEFORE its first audit entry. A settings writer holds the row and then
 * audits; a staff action holds its question row, then the workspace row, and then audits. Taking
 * the question rows after the workspace row is safe only because SKIP LOCKED never waits: a row
 * a staff action holds is skipped (its reminder goes out next run) instead of being waited for
 * while this transaction holds the workspace row — which is exactly the cycle a per-row lock
 * inside the loop would close.
 */
export const JOB_QA_SLA = "data-room.qa-sla";

export interface QaSlaSummary {
  workspaces: number;
  dueSoon: number;
  overdue: number;
  failed: number;
}

export async function runQaSla(
  services: ModuleServices,
  input: { readonly workspaceId?: string | undefined; readonly at?: Date | undefined } = {},
): Promise<QaSlaSummary> {
  const now = input.at ?? services.now();
  const summary: QaSlaSummary = { workspaces: 0, dueSoon: 0, overdue: 0, failed: 0 };
  const ids =
    input.workspaceId === undefined
      ? await listActiveWorkspaceIds(services.db)
      : [input.workspaceId];
  for (const id of ids) {
    try {
      const ctx: TenantContext = systemContext(id);
      const counted = await services.db.withTenant(ctx, async (tx) => {
        // Before any audit write (see the lock-order note above).
        const facts = await lockWorkspaceFacts(tx, id);
        if (facts === undefined) return undefined;
        const qa = parseWorkspaceSettings(facts.settings).dataRoom.qa;
        if (!qa.enabled) return undefined;
        const view = await services.enablement.get(services.db, ctx, tx);
        if (!view.enabled.has("data-room")) return undefined;
        const repo = new QaLifecycleRepo(ctx, tx);
        const out = { dueSoon: 0, overdue: 0 };
        // Every candidate row-locked here, in one statement, before the first audit below.
        const candidates = await repo.dueCandidates(now, qa.reminderLeadHours);
        for (const q of candidates) {
          const state = slaState(q.dueAt, now, qa.reminderLeadHours, q.status);
          let phase: "due_soon" | "overdue" | undefined;
          if (state === "overdue" && q.overdueNotifiedAt === null) phase = "overdue";
          else if (state === "due_soon" && q.dueSoonNotifiedAt === null) phase = "due_soon";
          if (phase === undefined) continue;
          if (!(await repo.stampDue(q.id, phase, now))) continue;
          const dueAt = q.dueAt.toISOString();
          await services.audit.record(tx, ctx, {
            action: "qa.question_due",
            resourceKind: "qa_question",
            resourceId: q.id,
            meta: { phase, dueAt },
          });
          await publish(tx, ctx, "qa.question_due", {
            questionId: q.id,
            phase,
            dueAt,
            assigneeMembershipId: q.assigneeMembershipId,
          });
          if (phase === "overdue") out.overdue += 1;
          else out.dueSoon += 1;
        }
        return out;
      });
      if (counted === undefined) continue;
      summary.workspaces += 1;
      summary.dueSoon += counted.dueSoon;
      summary.overdue += counted.overdue;
    } catch (error) {
      summary.failed += 1;
      services.log("data-room.qa_sla_failed", {
        level: "error",
        workspaceId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  services.log("data-room.qa_sla_checked", { ...summary });
  return summary;
}
