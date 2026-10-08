import type { TenantContext, Tx } from "@fundroom/db";
import { pgErrorCode } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import { NO_ROUND, type TransitionCause } from "../model.js";
import {
  ContactRepo,
  type ContactRow,
  OrganizationRepo,
  type OrganizationRow,
  type PipelineItemRow,
  PipelineRepo,
  type RoundFilter,
  type StageRow,
  TransitionRepo,
} from "../repos/crm-repo.js";
import { ensureStages } from "./stages.js";

/*
 * The pipeline board (design/03 §82, E2.5 §C).
 *
 * `amount` on a card is a **forecast** — what staff expect — and never the committed figure
 * (E2.5 D2): `round.commitment` is the system of record for money and this module does not read
 * it, which is why `commitment_id` is a bare uuid and why the reconciliation panel is assembled
 * in the browser from two APIs rather than by a join nobody is allowed to write.
 *
 * Every stage change goes through `moveItem`, and it writes three things in one transaction:
 * the card's new `stage_id`, a `crm.stage_transition` row, and an audit event carrying the two
 * stage **keys**. The transition table is what makes "stage transitions audited" a fact of the
 * database rather than of the audit log alone — it survives a stage being renamed, it survives
 * the stage being deleted, and it is where the *cause* lives, which the audit row cannot carry
 * usefully because half of these moves have no human actor at all.
 */

export interface BoardItem {
  readonly item: PipelineItemRow;
  readonly stage: StageRow | null;
  readonly contact: ContactRow | null;
  readonly organization: OrganizationRow | null;
}

export interface Board {
  readonly stages: readonly StageRow[];
  readonly items: readonly BoardItem[];
}

export interface CreateItemInput {
  readonly roundId?: string | null | undefined;
  readonly contactId?: string | null | undefined;
  readonly organizationId?: string | null | undefined;
  readonly stageKey?: string | undefined;
  readonly stageId?: string | undefined;
  readonly amount?: string | null | undefined;
  readonly currency?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly commitmentId?: string | null | undefined;
}

export interface PatchItemInput {
  readonly stageId?: string | undefined;
  readonly stageKey?: string | undefined;
  readonly amount?: string | null | undefined;
  readonly currency?: string | null | undefined;
  readonly ownerMembershipId?: string | null | undefined;
  readonly commitmentId?: string | null | undefined;
  readonly position?: number | undefined;
  readonly organizationId?: string | null | undefined;
}

/** `roundId` as the query spells it: absent, the `none` sentinel, or a uuid. */
export function roundFilterOf(roundId: string | undefined): RoundFilter {
  if (roundId === undefined) return { kind: "all" };
  return { kind: "one", id: roundId === NO_ROUND ? null : roundId };
}

/**
 * Moves one card and records it, inside the caller's transaction.
 *
 * Shared with the outbox handlers, which is why it takes a `tx` rather than opening one: an
 * event-driven move must land in the same transaction as everything else the handler did, or a
 * retry would replay half of it.
 *
 * A move to the stage the card is already in writes nothing at all — not the update, not the
 * transition, not the audit row. That is what makes the handlers idempotent under redelivery:
 * a second `round.commitment_changed` for the same status produces no second history row, and a
 * board that showed two "moved to Signed" entries a second apart would be lying about what
 * happened.
 */
export async function moveItem(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  input: {
    readonly item: PipelineItemRow;
    readonly from: StageRow | null;
    readonly to: StageRow;
    readonly cause: TransitionCause;
    readonly actor?: Actor | undefined;
    readonly position?: number | undefined;
  },
): Promise<PipelineItemRow> {
  const { item, from, to, cause } = input;
  if (item.stageId === to.id && input.position === undefined) return item;
  const items = new PipelineRepo(ctx, tx);
  const position = input.position ?? (await items.nextPosition(to.id));
  const moved = await items.update(item.id, { stageId: to.id, position });
  if (moved === undefined) throw new CrmError("not_found", "no such pipeline item");
  if (item.stageId === to.id) return moved;

  await new TransitionRepo(ctx, tx).insert({
    pipelineItemId: item.id,
    fromStageId: from?.id ?? null,
    fromStageKey: from?.key ?? null,
    toStageId: to.id,
    toStageKey: to.key,
    actorMembershipId: input.actor?.membershipId ?? null,
    cause,
  });
  await services.audit.record(tx, ctx, {
    action: "crm.pipeline_item_moved",
    resourceKind: "crm_pipeline_item",
    resourceId: item.id,
    // No `actorKind` override: it defaults from the context, which is a staff tenant context on
    // the board route and the system context inside an outbox handler — exactly the two answers
    // that are true.
    actorMembershipId: input.actor?.membershipId ?? null,
    requestId: input.actor?.requestId ?? null,
    sessionId: input.actor?.sessionId ?? null,
    // Keys, not names: a key survives a rename, and a name is tenant prose in an export that
    // goes to counsel.
    meta: { from: from?.key ?? null, to: to.key, cause },
  });
  return moved;
}

/** A card and the stage it is in, which is what every write returns to the route. */
export interface PlacedItem {
  readonly item: PipelineItemRow;
  readonly stage: StageRow | null;
}

export interface PipelineService {
  board(ctx: TenantContext, roundId: string | undefined): Promise<Board>;
  create(ctx: TenantContext, input: CreateItemInput, actor: Actor): Promise<PlacedItem>;
  patch(ctx: TenantContext, id: string, patch: PatchItemInput, actor: Actor): Promise<PlacedItem>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
}

export function createPipelineService(services: ModuleServices): PipelineService {
  const { db, audit } = services;

  /** The stage a create or a patch asked for, by id or by key, with a sensible default. */
  const stageFor = (
    stages: readonly StageRow[],
    by: { stageId?: string | undefined; stageKey?: string | undefined },
    fallback: StageRow,
  ): StageRow => {
    if (by.stageId !== undefined) {
      const found = stages.find((s) => s.id === by.stageId);
      if (found === undefined) {
        throw new CrmError("validation_failed", "no such stage in this workspace", {
          field: "stageId",
          stageId: by.stageId,
        });
      }
      return found;
    }
    if (by.stageKey !== undefined) {
      const found = stages.find((s) => s.key === by.stageKey);
      if (found === undefined) {
        throw new CrmError("validation_failed", "no such stage in this workspace", {
          field: "stageKey",
          stageKey: by.stageKey,
        });
      }
      return found;
    }
    return fallback;
  };

  return {
    async board(ctx, roundId) {
      return db.withTenant(ctx, async (tx) => {
        const stages = await ensureStages(ctx, tx);
        const items = await new PipelineRepo(ctx, tx).list(roundFilterOf(roundId));
        const byStage = new Map(stages.map((s) => [s.id, s]));
        const contactIds = [
          ...new Set(items.map((i) => i.contactId).filter((v): v is string => v !== null)),
        ];
        const organizationIds = [
          ...new Set(items.map((i) => i.organizationId).filter((v): v is string => v !== null)),
        ];
        const contacts = new Map(
          (await new ContactRepo(ctx, tx).byIds(contactIds)).map((c) => [c.id, c]),
        );
        const organizations = new Map(
          (await new OrganizationRepo(ctx, tx).byIds(organizationIds)).map((o) => [o.id, o]),
        );
        return {
          stages,
          items: items.map((item) => ({
            item,
            stage: byStage.get(item.stageId) ?? null,
            contact: item.contactId === null ? null : (contacts.get(item.contactId) ?? null),
            organization:
              item.organizationId === null
                ? null
                : (organizations.get(item.organizationId) ?? null),
          })),
        };
      });
    },

    async create(ctx, input, actor) {
      if (input.contactId == null && input.organizationId == null) {
        throw new CrmError(
          "validation_failed",
          "a pipeline card needs a contact or an organisation",
          {
            field: "contactId",
          },
        );
      }
      return db.withTenant(ctx, async (tx) => {
        const stages = await ensureStages(ctx, tx);
        const first = stages[0];
        if (first === undefined) throw new CrmError("conflict", "this workspace has no stages");
        const stage = stageFor(stages, input, first);
        if (input.contactId != null) {
          const contact = await new ContactRepo(ctx, tx).find(input.contactId);
          if (contact === undefined) {
            throw new CrmError("validation_failed", "no such contact in this workspace", {
              field: "contactId",
              contactId: input.contactId,
            });
          }
        }
        if (input.organizationId != null) {
          const organization = await new OrganizationRepo(ctx, tx).find(input.organizationId);
          if (organization === undefined) {
            throw new CrmError("validation_failed", "no such organisation in this workspace", {
              field: "organizationId",
              organizationId: input.organizationId,
            });
          }
        }
        const items = new PipelineRepo(ctx, tx);
        const row = await items
          .insert({
            roundId: input.roundId ?? null,
            contactId: input.contactId ?? null,
            organizationId: input.organizationId ?? null,
            stageId: stage.id,
            amount: input.amount ?? null,
            currency: input.currency ?? null,
            ownerMembershipId: input.ownerMembershipId ?? null,
            commitmentId: input.commitmentId ?? null,
            position: await items.nextPosition(stage.id),
            createdBy: actor.membershipId,
          })
          .catch((e: unknown) => {
            if (pgErrorCode(e) === "23505") {
              throw new CrmError("conflict", "this contact already has a card in that round", {
                reason: "duplicate_card",
                field: "contactId",
              });
            }
            throw e;
          });
        // The opening position is history too: without it the first entry of a card's history
        // is whatever it moved to *second*, and "created in Prospect" is a fact staff rely on.
        await new TransitionRepo(ctx, tx).insert({
          pipelineItemId: row.id,
          toStageId: stage.id,
          toStageKey: stage.key,
          actorMembershipId: actor.membershipId,
          cause: "staff",
        });
        await audit.record(tx, ctx, {
          action: "crm.pipeline_item_created",
          resourceKind: "crm_pipeline_item",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          meta: {
            to: stage.key,
            ...(row.roundId === null ? {} : { roundId: row.roundId }),
            ...(row.contactId === null ? {} : { contactId: row.contactId }),
            ...(row.organizationId === null ? {} : { organizationId: row.organizationId }),
          },
        });
        return { item: row, stage };
      });
    },

    async patch(ctx, id, patch, actor) {
      return db.withTenant(ctx, async (tx) => {
        const items = new PipelineRepo(ctx, tx);
        const before = await items.find(id);
        if (before === undefined) throw new CrmError("not_found", "no such pipeline item");
        const stages = await ensureStages(ctx, tx);
        const current = stages.find((s) => s.id === before.stageId) ?? null;
        const fallback = current ?? stages[0];
        if (fallback === undefined) throw new CrmError("conflict", "this workspace has no stages");
        // `stageFor`'s fallback is unreachable here — it is only consulted when neither
        // `stageId` nor `stageKey` was sent, and that is the branch that skips the move.
        const target =
          patch.stageId === undefined && patch.stageKey === undefined
            ? null
            : stageFor(stages, patch, fallback);

        const fields: PatchItemInput = patch;
        // Everything but the stage first, so the move's audit row describes only the move.
        const updated = await items.update(id, {
          ...(fields.amount === undefined ? {} : { amount: fields.amount }),
          ...(fields.currency === undefined ? {} : { currency: fields.currency }),
          ...(fields.ownerMembershipId === undefined
            ? {}
            : { ownerMembershipId: fields.ownerMembershipId }),
          ...(fields.commitmentId === undefined ? {} : { commitmentId: fields.commitmentId }),
          ...(fields.organizationId === undefined ? {} : { organizationId: fields.organizationId }),
          ...(target === null && fields.position !== undefined
            ? { position: fields.position }
            : {}),
        });
        if (updated === undefined) throw new CrmError("not_found", "no such pipeline item");

        const moved =
          target === null
            ? updated
            : await moveItem(services, ctx, tx, {
                item: updated,
                from: current,
                to: target,
                cause: "staff",
                actor,
                ...(patch.position === undefined ? {} : { position: patch.position }),
              });

        const touched = Object.keys(patch).filter((k) => k !== "stageId" && k !== "stageKey");
        if (touched.length > 0) {
          await audit.record(tx, ctx, {
            action: "crm.pipeline_item_updated",
            resourceKind: "crm_pipeline_item",
            resourceId: id,
            actorMembershipId: actor.membershipId,
            requestId: actor.requestId ?? null,
            sessionId: actor.sessionId ?? null,
            meta: { fields: touched.sort() },
          });
        }
        return { item: moved, stage: target ?? current };
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const removed = await new PipelineRepo(ctx, tx).softDelete(id);
        if (!removed) throw new CrmError("not_found", "no such pipeline item");
        await audit.record(tx, ctx, {
          action: "crm.pipeline_item_deleted",
          resourceKind: "crm_pipeline_item",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
        });
      });
    },
  };
}
