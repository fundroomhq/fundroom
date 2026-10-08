import type { TenantContext } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import type { SubjectKind } from "../model.js";
import { type TaskPatch, TaskRepo, type TaskRow } from "../repos/crm-repo.js";
import { requireSubject } from "./notes.js";

/*
 * Tasks: "call Ada back on Thursday", hanging off the same three subjects as a note.
 *
 * `crm.task` is the one table in this schema with no `deleted_at`, and the delete route is
 * therefore a real DELETE. That is the model rather than an omission: a task is a reminder
 * somebody set for themselves, and a tombstoned reminder is just a reminder that still shows up
 * in the count. A note is a record of what was said and is kept; a task is a piece of a to-do
 * list and is not.
 */

export interface TaskService {
  create(
    ctx: TenantContext,
    input: {
      subjectKind: SubjectKind;
      subjectId: string;
      title: string;
      dueAt?: Date | undefined;
      assigneeMembershipId?: string | undefined;
    },
    actor: Actor,
  ): Promise<TaskRow>;
  patch(ctx: TenantContext, id: string, patch: TaskPatch, actor: Actor): Promise<TaskRow>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
}

export function createTaskService(services: ModuleServices): TaskService {
  const { db, audit } = services;

  return {
    async create(ctx, input, actor) {
      return db.withTenant(ctx, async (tx) => {
        await requireSubject(ctx, tx, input.subjectKind, input.subjectId);
        if (input.assigneeMembershipId !== undefined) {
          const member = await new MembershipRepo(ctx, tx).byId(input.assigneeMembershipId);
          if (member === undefined) {
            throw new CrmError("validation_failed", "no such member in this workspace", {
              field: "assigneeMembershipId",
            });
          }
        }
        const row = await new TaskRepo(ctx, tx).insert({
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          title: input.title,
          dueAt: input.dueAt ?? null,
          assigneeMembershipId: input.assigneeMembershipId ?? null,
          createdBy: actor.membershipId,
        });
        await audit.record(tx, ctx, {
          action: "crm.task_created",
          resourceKind: "crm_task",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          // The title is a sentence somebody wrote about an investor; the subject ids are what
          // a reader of the audit trail actually needs.
          meta: {
            subjectKind: row.subjectKind,
            subjectId: row.subjectId,
            assigned: row.assigneeMembershipId !== null,
          },
        });
        return row;
      });
    },

    async patch(ctx, id, patch, actor) {
      return db.withTenant(ctx, async (tx) => {
        if (patch.assigneeMembershipId != null) {
          const member = await new MembershipRepo(ctx, tx).byId(patch.assigneeMembershipId);
          if (member === undefined) {
            throw new CrmError("validation_failed", "no such member in this workspace", {
              field: "assigneeMembershipId",
            });
          }
        }
        const row = await new TaskRepo(ctx, tx).update(id, patch);
        if (row === undefined) throw new CrmError("not_found", "no such task");
        await audit.record(tx, ctx, {
          action: "crm.task_updated",
          resourceKind: "crm_task",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          meta: { fields: Object.keys(patch).sort(), done: row.doneAt !== null },
        });
        return row;
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const removed = await new TaskRepo(ctx, tx).remove(id);
        if (!removed) throw new CrmError("not_found", "no such task");
        await audit.record(tx, ctx, {
          action: "crm.task_deleted",
          resourceKind: "crm_task",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
        });
      });
    },
  };
}
