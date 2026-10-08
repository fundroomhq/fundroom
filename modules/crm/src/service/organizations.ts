import type { TenantContext } from "@fundroom/db";
import { pgErrorCode } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import {
  type NewOrganization,
  type OrganizationPatch,
  OrganizationRepo,
  type OrganizationRow,
  type Page,
} from "../repos/crm-repo.js";

/*
 * Organisations: the firms behind the contacts (design/06 §7). Thin on purpose — the only rule
 * worth a service is the one the partial unique index expresses, and the only reason it is
 * caught here rather than left to Postgres is that "23505" is not a sentence an admin can act
 * on.
 */

export interface OrganizationService {
  list(
    ctx: TenantContext,
    filter: { q?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<Page<OrganizationRow>>;
  get(ctx: TenantContext, id: string): Promise<OrganizationRow>;
  create(ctx: TenantContext, input: NewOrganization, actor: Actor): Promise<OrganizationRow>;
  patch(
    ctx: TenantContext,
    id: string,
    patch: OrganizationPatch,
    actor: Actor,
  ): Promise<OrganizationRow>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
}

/** The partial unique index on `(workspace_id, lower(name))`, said in words. */
function rethrowDuplicate(error: unknown, name: string): never {
  if (pgErrorCode(error) === "23505") {
    throw new CrmError("conflict", `an organisation called ${name} already exists`, {
      reason: "duplicate_name",
      field: "name",
    });
  }
  throw error;
}

export function createOrganizationService(services: ModuleServices): OrganizationService {
  const { db, audit } = services;

  return {
    list(ctx, filter) {
      return db.withTenant(ctx, (tx) => new OrganizationRepo(ctx, tx).list(filter));
    },

    async get(ctx, id) {
      const row = await db.withTenant(ctx, (tx) => new OrganizationRepo(ctx, tx).find(id));
      if (row === undefined) throw new CrmError("not_found", "no such organisation");
      return row;
    },

    async create(ctx, input, actor) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new OrganizationRepo(ctx, tx);
        const row = await repo
          .insert({ ...input, createdBy: actor.membershipId })
          .catch((e: unknown) => rethrowDuplicate(e, input.name));
        await audit.record(tx, ctx, {
          action: "crm.organization_created",
          resourceKind: "crm_organization",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          // Ids and shape only: the name of a firm a founder is courting is exactly the sort
          // of thing an audit export must not leak, and the row it points at holds it anyway.
          meta: { kind: row.kind ?? "unspecified" },
        });
        return row;
      });
    },

    async patch(ctx, id, patch, actor) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new OrganizationRepo(ctx, tx);
        const row = await repo
          .update(id, patch)
          .catch((e: unknown) => rethrowDuplicate(e, patch.name ?? ""));
        if (row === undefined) throw new CrmError("not_found", "no such organisation");
        await audit.record(tx, ctx, {
          action: "crm.organization_updated",
          resourceKind: "crm_organization",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          meta: { fields: Object.keys(patch).sort() },
        });
        return row;
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const removed = await new OrganizationRepo(ctx, tx).softDelete(id);
        if (!removed) throw new CrmError("not_found", "no such organisation");
        await audit.record(tx, ctx, {
          action: "crm.organization_deleted",
          resourceKind: "crm_organization",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
        });
      });
    },
  };
}
