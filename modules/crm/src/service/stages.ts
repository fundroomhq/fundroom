import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import { customStageKey, DEFAULT_STAGES, PROTECTED_STAGE_KEYS, STAGE_KEY_RE } from "../model.js";
import { PipelineRepo, StageRepo, type StageRow, type StageWrite } from "../repos/crm-repo.js";

/*
 * The pipeline ladder (E2.5 D10).
 *
 * Two things live here and nothing else does. The **lazy seed**: a workspace's stages are
 * tenant data, so the migration writes none and the first CRM read of a workspace writes the
 * ten defaults — which is also why every other service in this module goes through
 * `ensureStages` rather than reading the table directly. And the **replace**, which is the only
 * way a tenant edits the ladder: `PUT /crm/stages` is a whole-list write rather than a
 * per-stage CRUD because position is a property *of the list*, and a REST resource that let two
 * admins each move one stage would produce an order neither of them asked for.
 */

/** One entry of the submitted ladder, before keys and positions are resolved. */
export interface StageEntry {
  readonly id?: string | undefined;
  readonly key?: string | undefined;
  readonly name: string;
  readonly isTerminal: boolean;
}

/**
 * The workspace's stages, seeding the defaults the first time anybody looks.
 *
 * Exported because the pipeline service and the outbox handlers need the same guarantee: a
 * handler that fired before a human ever opened the CRM screen must still find `contacted`.
 */
export async function ensureStages(ctx: TenantContext, tx: Tx): Promise<StageRow[]> {
  const repo = new StageRepo(ctx, tx);
  const existing = await repo.list();
  if (existing.length > 0) return existing;
  await repo.seed(DEFAULT_STAGES);
  return repo.list();
}

/** The same, indexed by key — what a handler mapping a commitment status wants. */
export async function stagesByKey(
  ctx: TenantContext,
  tx: Tx,
): Promise<ReadonlyMap<string, StageRow>> {
  return new Map((await ensureStages(ctx, tx)).map((s) => [s.key, s]));
}

/**
 * Resolves the submitted list into rows to write, refusing everything that cannot be a ladder.
 *
 * Pure, and separately tested: the rules — an id that is not a stage of this workspace, a key
 * that is not a key, two entries claiming one key — are the part of `PUT /crm/stages` worth
 * pinning without a database.
 */
export function resolveLadder(
  entries: readonly StageEntry[],
  existing: readonly StageRow[],
): { writes: StageWrite[]; removed: StageRow[] } {
  if (entries.length === 0) {
    throw new CrmError("validation_failed", "a pipeline needs at least one stage", {
      field: "stages",
    });
  }
  const byId = new Map(existing.map((s) => [s.id, s]));
  const keptIds = new Set<string>();
  const seenKeys = new Set<string>();
  const writes: StageWrite[] = [];

  entries.forEach((entry, index) => {
    const name = entry.name.trim();
    if (name.length === 0) {
      throw new CrmError("validation_failed", "a stage needs a name", {
        field: "name",
        position: index + 1,
      });
    }
    let key: string;
    if (entry.id !== undefined) {
      const row = byId.get(entry.id);
      if (row === undefined) {
        throw new CrmError("validation_failed", "no such stage in this workspace", {
          field: "id",
          id: entry.id,
        });
      }
      if (keptIds.has(entry.id)) {
        throw new CrmError("validation_failed", "the same stage appears twice", {
          field: "id",
          id: entry.id,
        });
      }
      keptIds.add(entry.id);
      // The key of a kept stage is *not* patchable, for the same reason a metric key is not: a
      // stage key is other people's stored data — the event handlers address `soft_committed`
      // by it — so renaming one is a migration, not a field edit. The human name is what the
      // board shows and what this route exists to change.
      key = row.key;
    } else {
      key = (entry.key ?? customStageKey(name)).trim();
      if (!STAGE_KEY_RE.test(key)) {
        throw new CrmError(
          "validation_failed",
          "a stage key is lower-case letters, digits and underscores",
          {
            field: "key",
            key,
          },
        );
      }
    }
    if (seenKeys.has(key)) {
      throw new CrmError("validation_failed", "two stages claim the same key", {
        field: "key",
        key,
      });
    }
    seenKeys.add(key);
    writes.push({
      ...(entry.id === undefined ? {} : { id: entry.id }),
      key,
      name,
      isTerminal: entry.isTerminal,
      position: index + 1,
    });
  });

  const removed = existing.filter((s) => !keptIds.has(s.id));
  for (const stage of removed) {
    /*
     * A seeded terminal stage cannot be removed. Renaming and reordering it is fine — this is
     * not about the words on the column — but `round.commitment_changed` maps `wired` onto one
     * of these and `withdrawn` onto the other, and a workspace that had deleted either would
     * silently stop recording half of what the round module tells it. The handlers no-op on a
     * missing stage rather than throwing, which is precisely why the refusal has to be here: a
     * silent no-op is not something an admin would ever notice.
     */
    if (PROTECTED_STAGE_KEYS.includes(stage.key)) {
      throw new CrmError("conflict", `the ${stage.name} stage cannot be removed`, {
        reason: "stage_protected",
        stageId: stage.id,
        key: stage.key,
      });
    }
  }
  return { writes, removed };
}

export interface StageService {
  list(ctx: TenantContext): Promise<StageRow[]>;
  replace(ctx: TenantContext, entries: readonly StageEntry[], actor: Actor): Promise<StageRow[]>;
}

export function createStageService(services: ModuleServices): StageService {
  const { db, audit } = services;
  return {
    list(ctx) {
      return db.withTenant(ctx, (tx) => ensureStages(ctx, tx));
    },

    async replace(ctx, entries, actor) {
      return db.withTenant(ctx, async (tx) => {
        const stages = new StageRepo(ctx, tx);
        const items = new PipelineRepo(ctx, tx);
        const existing = await ensureStages(ctx, tx);
        const { writes, removed } = resolveLadder(entries, existing);

        const removedIds = removed.map((s) => s.id);
        const live = await stages.liveItemCounts(removedIds);
        for (const stage of removed) {
          const n = live.get(stage.id) ?? 0;
          if (n > 0) {
            throw new CrmError(
              "conflict",
              `${n} card${n === 1 ? "" : "s"} still sit in ${stage.name}; move them first`,
              { reason: "stage_in_use", stageId: stage.id, key: stage.key, items: n },
            );
          }
        }

        /*
         * Order matters, and each step is here for a failure it prevents.
         *
         *  1. Park the removed rows under a throwaway key. `(workspace_id, key)` is unique and
         *     *not* deferrable, so a tenant who deletes `meeting` and adds a new stage also
         *     called `meeting` in one request would otherwise collide on the insert before the
         *     delete ever ran.
         *  2. Write the ladder. `(workspace_id, position)` *is* deferrable, so 1..n can be
         *     assigned in one pass without shuffling anybody out of the way first.
         *  3. Re-point archived cards. `pipeline_item.stage_id` is ON DELETE RESTRICT, and that
         *     restriction does not know about `deleted_at`: a stage that once held a card the
         *     staff have since archived would be permanently undeletable. The tombstone keeps
         *     its place in the table; its column is simply gone, and `crm.stage_transition`
         *     still records the key it was in, which is where that history actually lives.
         *  4. Delete.
         */
        if (removedIds.length > 0) await stages.parkForRemoval(removedIds);
        const written: StageRow[] = [];
        for (const write of writes) written.push(await stages.upsert(write));
        const survivor = written[0];
        if (removedIds.length > 0 && survivor !== undefined) {
          await items.repointArchived(removedIds, survivor.id);
          await stages.deleteByIds(removedIds);
        }

        await audit.record(tx, ctx, {
          action: "crm.stages_replaced",
          resourceKind: "crm_stage",
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          // Keys and counts only. A stage name is tenant prose, and the audit row is exported
          // to counsel; the key is the stable thing a reader needs to follow the history.
          meta: {
            stages: written.length,
            keys: written.map((s) => s.key),
            removed: removed.map((s) => s.key),
          },
        });
        return written;
      });
    },
  };
}
