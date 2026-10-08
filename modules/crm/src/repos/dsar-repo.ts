import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  activity,
  contact,
  note,
  organization,
  pipelineItem,
  pipelineStage,
  stageTransition,
  task,
} from "../schema/crm.js";

const CAP = 10_000;

/**
 * Everything the CRM holds about one member (E2.7 DSAR export; see `../dsar.ts`). The contact
 * set is the one `ErasureRepo.contactIdsFor` erases — linked by membership, or unlinked but
 * carrying the member's address (or an address of one of their linked contacts) — read here
 * without the `FOR UPDATE` the erasure needs.
 */
export async function readMemberCrm(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  email: string | null,
): Promise<JsonObject> {
  const ws = ctx.workspaceId;
  const linkedEmails = tx
    .select({ email: contact.email })
    .from(contact)
    .where(
      and(
        eq(contact.workspaceId, ws),
        eq(contact.membershipId, membershipId),
        isNotNull(contact.email),
      ),
    );
  const unlinkedMatch = and(
    isNull(contact.membershipId),
    isNotNull(contact.email),
    or(
      email === null ? sql`false` : sql`${contact.email} = ${email}::citext`,
      inArray(contact.email, linkedEmails),
    ),
  );
  const contacts = await tx
    .select({
      id: contact.id,
      linked: sql<boolean>`${contact.membershipId} IS NOT NULL`,
      displayName: contact.displayName,
      email: contact.email,
      title: contact.title,
      tags: contact.tags,
      notes: contact.notes,
      organization: organization.name,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      deletedAt: contact.deletedAt,
    })
    .from(contact)
    .leftJoin(
      organization,
      and(eq(organization.id, contact.organizationId), eq(organization.workspaceId, ws)),
    )
    .where(
      and(eq(contact.workspaceId, ws), or(eq(contact.membershipId, membershipId), unlinkedMatch)),
    )
    .orderBy(asc(contact.createdAt), asc(contact.id))
    .limit(CAP);
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) {
    return {
      version: 1,
      contacts: [],
      pipelineItems: [],
      stageHistory: [],
      notes: [],
      tasks: [],
      activities: [],
    };
  }

  const items = await tx
    .select({
      id: pipelineItem.id,
      contactId: pipelineItem.contactId,
      roundId: pipelineItem.roundId,
      stageKey: pipelineStage.key,
      stageName: pipelineStage.name,
      amount: pipelineItem.amount,
      currency: pipelineItem.currency,
      commitmentId: pipelineItem.commitmentId,
      createdAt: pipelineItem.createdAt,
      updatedAt: pipelineItem.updatedAt,
      deletedAt: pipelineItem.deletedAt,
    })
    .from(pipelineItem)
    .leftJoin(
      pipelineStage,
      and(eq(pipelineStage.id, pipelineItem.stageId), eq(pipelineStage.workspaceId, ws)),
    )
    .where(and(eq(pipelineItem.workspaceId, ws), inArray(pipelineItem.contactId, contactIds)))
    .orderBy(asc(pipelineItem.createdAt), asc(pipelineItem.id))
    .limit(CAP);
  const itemIds = items.map((i) => i.id);

  const history =
    itemIds.length === 0
      ? []
      : await tx
          .select({
            pipelineItemId: stageTransition.pipelineItemId,
            fromStageKey: stageTransition.fromStageKey,
            toStageKey: stageTransition.toStageKey,
            cause: stageTransition.cause,
            createdAt: stageTransition.createdAt,
          })
          .from(stageTransition)
          .where(
            and(
              eq(stageTransition.workspaceId, ws),
              inArray(stageTransition.pipelineItemId, itemIds),
            ),
          )
          .orderBy(asc(stageTransition.createdAt), asc(stageTransition.id))
          .limit(CAP);

  const aboutContactOrItem = (
    kind: typeof note.subjectKind | typeof task.subjectKind,
    id: typeof note.subjectId | typeof task.subjectId,
  ) =>
    or(
      and(eq(kind, "contact"), inArray(id, contactIds)),
      itemIds.length === 0 ? sql`false` : and(eq(kind, "pipeline_item"), inArray(id, itemIds)),
    );
  const notes = await tx
    .select({
      id: note.id,
      subjectKind: note.subjectKind,
      subjectId: note.subjectId,
      body: note.body,
      authorMembershipId: note.authorMembershipId,
      createdAt: note.createdAt,
    })
    .from(note)
    .where(
      and(
        eq(note.workspaceId, ws),
        isNull(note.deletedAt),
        aboutContactOrItem(note.subjectKind, note.subjectId),
      ),
    )
    .orderBy(asc(note.createdAt), asc(note.id))
    .limit(CAP);
  const tasks = await tx
    .select({
      id: task.id,
      subjectKind: task.subjectKind,
      subjectId: task.subjectId,
      title: task.title,
      dueAt: task.dueAt,
      doneAt: task.doneAt,
      createdAt: task.createdAt,
    })
    .from(task)
    .where(and(eq(task.workspaceId, ws), aboutContactOrItem(task.subjectKind, task.subjectId)))
    .orderBy(asc(task.createdAt), asc(task.id))
    .limit(CAP);

  // E3.6: the meetings recorded on those contacts (when, what kind of meeting, which vendor).
  const activities = await tx
    .select({
      id: activity.id,
      contactId: activity.contactId,
      kind: activity.kind,
      occurredAt: activity.occurredAt,
      startsAt: activity.startsAt,
      endsAt: activity.endsAt,
      title: activity.title,
      provider: activity.provider,
    })
    .from(activity)
    .where(and(eq(activity.workspaceId, ws), inArray(activity.contactId, contactIds)))
    .orderBy(asc(activity.occurredAt), asc(activity.id))
    .limit(CAP);

  return {
    version: 1,
    contacts: contacts.map((r) => dsarRow(r)),
    pipelineItems: items.map((r) => dsarRow(r)),
    stageHistory: history.map((r) => dsarRow(r)),
    notes: notes.map((r) => dsarRow(r)),
    tasks: tasks.map((r) => dsarRow(r)),
    activities: activities.map((r) => dsarRow(r)),
  };
}
