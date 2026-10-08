import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import type { SubjectKind } from "../model.js";
import {
  ContactRepo,
  NoteRepo,
  type NoteRow,
  OrganizationRepo,
  PipelineRepo,
} from "../repos/crm-repo.js";

/*
 * Notes (design/06 §7: polymorphic over the three subjects).
 *
 * The audit row for a note carries the subject and nothing else — never the body. A CRM note is
 * the most candid text in the product ("passed last time, thinks the valuation is silly") and
 * the audit log is the one table that is exported wholesale to counsel and kept for six years.
 * Copying the prose into it would mean writing it twice and deleting it once.
 */

/** A note or a task hangs off one of three things; it must actually be there. */
export async function requireSubject(
  ctx: TenantContext,
  tx: Tx,
  subjectKind: SubjectKind,
  subjectId: string,
): Promise<void> {
  const found =
    subjectKind === "contact"
      ? await new ContactRepo(ctx, tx).find(subjectId)
      : subjectKind === "organization"
        ? await new OrganizationRepo(ctx, tx).find(subjectId)
        : await new PipelineRepo(ctx, tx).find(subjectId);
  if (found === undefined) {
    throw new CrmError("validation_failed", `no such ${subjectKind} in this workspace`, {
      field: "subjectId",
      subjectKind,
      subjectId,
    });
  }
}

export interface NoteService {
  create(
    ctx: TenantContext,
    input: { subjectKind: SubjectKind; subjectId: string; body: string },
    actor: Actor,
  ): Promise<NoteRow>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
}

export function createNoteService(services: ModuleServices): NoteService {
  const { db, audit } = services;
  return {
    async create(ctx, input, actor) {
      return db.withTenant(ctx, async (tx) => {
        await requireSubject(ctx, tx, input.subjectKind, input.subjectId);
        const row = await new NoteRepo(ctx, tx).insert({
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          body: input.body,
          authorMembershipId: actor.membershipId,
        });
        await audit.record(tx, ctx, {
          action: "crm.note_created",
          resourceKind: "crm_note",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          // Subject and length. Never the body (§C).
          meta: { subjectKind: row.subjectKind, subjectId: row.subjectId, bytes: row.body.length },
        });
        return row;
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const repo = new NoteRepo(ctx, tx);
        const row = await repo.find(id);
        if (row === undefined) throw new CrmError("not_found", "no such note");
        await repo.softDelete(id);
        await audit.record(tx, ctx, {
          action: "crm.note_deleted",
          resourceKind: "crm_note",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          meta: { subjectKind: row.subjectKind, subjectId: row.subjectId },
        });
      });
    },
  };
}
