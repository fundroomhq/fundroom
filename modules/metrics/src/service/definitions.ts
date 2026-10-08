import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, MetricsError } from "../errors.js";
import { type Formula, referencedKeys, wouldCycle } from "../formula.js";
import { DEFAULT_AUDIENCE } from "../model.js";
import {
  type DefinitionPatch,
  DefinitionRepo,
  type DefinitionRow,
  type NewDefinition,
  SourceBindingRepo,
} from "../repos/metrics-repo.js";

/*
 * Metric definitions: what a number *is* (E2.4 §9 `/definitions`).
 *
 * The validations here exist so that a formula the admin cannot possibly have meant comes back
 * as a field-level `validation_failed` naming the offending key, rather than as a 500 from a
 * CHECK constraint or — worse — as a recompute that hangs. Three of them are load-bearing:
 * an unknown reference, a cycle, and the `aggregation = 'last'` rule for derived metrics.
 */

export interface DefinitionInput extends Omit<NewDefinition, "createdBy"> {}

/** A formula's inputs must exist and must not close a loop back onto `key`. */
async function checkFormula(
  repo: DefinitionRepo,
  key: string,
  formula: Formula,
  aggregation: string | undefined,
): Promise<void> {
  /*
   * A formula is evaluated per period, so summing its output across periods is arithmetic on
   * something that was never a quantity: "the sum of this month's gross margin and last
   * month's" is not a number anybody wants. The column CHECKs it
   * (`definition_derived_aggregation`); refusing here is what turns a 500 into a message the
   * form can point at the aggregation field.
   */
  if (aggregation !== undefined && aggregation !== "last") {
    throw new MetricsError(
      "validation_failed",
      "a derived metric aggregates `last`: a formula is evaluated per period",
      { field: "aggregation", aggregation },
    );
  }
  const graph = await repo.formulaGraph();
  for (const ref of referencedKeys(formula)) {
    if (ref === key) {
      throw new MetricsError("validation_failed", `formula references itself (${ref})`, {
        field: "formula",
        key: ref,
        cycle: true,
      });
    }
    const target = await repo.findByKey(ref);
    if (target === undefined) {
      throw new MetricsError(
        "validation_failed",
        `formula references \`${ref}\`, which is not a metric in this workspace`,
        { field: "formula", key: ref },
      );
    }
  }
  if (wouldCycle(key, formula, graph)) {
    /*
     * Not merely a nicety: the recompute cascade terminates *because* the graph is acyclic
     * (§6). A cycle admitted here would be a loop in a background job, so this is the guard
     * that lets the job walk the graph without counting iterations.
     */
    throw new MetricsError(
      "validation_failed",
      `this formula would make \`${key}\` depend on itself through other metrics`,
      { field: "formula", key, cycle: true },
    );
  }
}

/** The column CHECK spelled out, so a mismatched unit is a form error and not a 500. */
function checkCurrency(unit: string | undefined, currency: string | null | undefined): void {
  if (unit === undefined) return;
  const wants = unit === "currency";
  const has = currency !== null && currency !== undefined && currency !== "";
  if (wants && !has) {
    throw new MetricsError("validation_failed", "a currency metric needs an ISO 4217 code", {
      field: "currency",
    });
  }
  if (!wants && has) {
    throw new MetricsError("validation_failed", "only a currency metric carries a currency", {
      field: "currency",
      unit,
    });
  }
}

export function createDefinitionService(services: ModuleServices) {
  const { db } = services;

  const repoOf = (ctx: TenantContext, tx: Tx) => new DefinitionRepo(ctx, tx);

  return {
    /** Live definitions in grid order. RLS drops the ones an external reader may not see. */
    list(ctx: TenantContext): Promise<DefinitionRow[]> {
      return db.withTenant(ctx, (tx) => repoOf(ctx, tx).list());
    },

    async get(ctx: TenantContext, id: string): Promise<DefinitionRow> {
      const found = await db.withTenant(ctx, (tx) => repoOf(ctx, tx).find(id));
      if (found === undefined) throw new MetricsError("not_found", "no such metric");
      return found;
    },

    async create(ctx: TenantContext, input: DefinitionInput, actor: Actor): Promise<DefinitionRow> {
      checkCurrency(input.unit, input.currency);
      return db.withTenant(ctx, async (tx) => {
        const repo = repoOf(ctx, tx);
        if ((await repo.findByKey(input.key)) !== undefined) {
          throw new MetricsError("conflict", `a metric named \`${input.key}\` already exists`, {
            field: "key",
            key: input.key,
          });
        }
        if (input.formula != null) {
          await checkFormula(repo, input.key, input.formula, input.aggregation);
        }
        const created = await repo.insert({
          ...input,
          ...(input.formula == null ? {} : { aggregation: "last" as const }),
          audience: input.audience ?? DEFAULT_AUDIENCE,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "metrics.definition_created",
          resourceKind: "metric_definition",
          resourceId: created.id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: {
            key: created.key,
            unit: created.unit,
            derived: created.formula !== null,
            audience: created.audience.kind,
          },
        });
        return created;
      });
    },

    async patch(
      ctx: TenantContext,
      id: string,
      patch: DefinitionPatch,
      actor: Actor,
    ): Promise<DefinitionRow> {
      return db.withTenant(ctx, async (tx) => {
        const repo = repoOf(ctx, tx);
        const before = await repo.find(id);
        if (before === undefined) throw new MetricsError("not_found", "no such metric");
        const unit = patch.unit ?? before.unit;
        const currency = patch.currency === undefined ? before.currency : patch.currency;
        checkCurrency(unit, currency);
        const formula = patch.formula === undefined ? before.formula : patch.formula;
        if (formula != null) {
          await checkFormula(repo, before.key, formula, patch.aggregation ?? before.aggregation);
        }
        /*
         * A metric fed by a KPI integration (E3.6) stays monthly and manual: the sync writes
         * calendar months, and a formula's points belong to the recompute. Unbind it first.
         */
        const periodKind = patch.periodKind ?? before.periodKind;
        if (periodKind !== "month" || formula != null) {
          const binding = await new SourceBindingRepo(ctx, tx).findByDefinition(id);
          if (binding !== undefined) {
            throw new MetricsError(
              "binding_period_unsupported",
              `\`${before.key}\` is fed by ${binding.provider}; remove that binding before making it ${formula != null ? "a formula" : `a ${periodKind} metric`}`,
              { provider: binding.provider, periodKind, derived: formula != null },
            );
          }
        }
        const updated = await repo.update(id, {
          ...patch,
          ...(formula == null ? {} : { aggregation: "last" as const }),
        });
        if (updated === undefined) throw new MetricsError("not_found", "no such metric");
        const audienceChanged =
          patch.audience !== undefined && patch.audience.kind !== before.audience.kind;
        await services.audit.record(tx, ctx, {
          action: "metrics.definition_updated",
          resourceKind: "metric_definition",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: {
            key: updated.key,
            fields: Object.keys(patch),
            ...(audienceChanged
              ? { audienceFrom: before.audience.kind, audienceTo: updated.audience.kind }
              : {}),
          },
        });
        return updated;
      });
    },

    /**
     * Soft delete. The points stay: a number an investor was shown last quarter did not stop
     * having been shown because somebody tidied the admin screen, and the audit trail would be
     * unreadable without the definition it names.
     */
    async remove(ctx: TenantContext, id: string, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const repo = repoOf(ctx, tx);
        const before = await repo.find(id);
        if (before === undefined) throw new MetricsError("not_found", "no such metric");
        /*
         * Refuse while another metric's formula still reads this one. Deleting it would leave
         * that formula permanently unevaluable — `evaluate` would answer `undefined` for every
         * period from now on — and the admin would see a metric that silently stopped updating
         * with nothing on screen to say why.
         */
        const graph = await repo.formulaGraph();
        const dependents = [...graph.entries()]
          .filter(([key, f]) => key !== before.key && referencedKeys(f).includes(before.key))
          .map(([key]) => key);
        if (dependents.length > 0) {
          throw new MetricsError(
            "conflict",
            `\`${before.key}\` is used by the formula of ${dependents.join(", ")}`,
            { dependents },
          );
        }
        await repo.softDelete(id);
        await services.audit.record(tx, ctx, {
          action: "metrics.definition_deleted",
          resourceKind: "metric_definition",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: { key: before.key },
        });
      });
    },
  };
}

export type DefinitionService = ReturnType<typeof createDefinitionService>;
