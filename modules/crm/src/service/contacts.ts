import { pgErrorCode, type TenantContext, type Tx } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CrmError } from "../errors.js";
import {
  type ContactPatch,
  ContactRepo,
  type ContactRow,
  type NewContact,
  NoteRepo,
  type NoteRow,
  OrganizationRepo,
  type OrganizationRow,
  type Page,
  type PipelineItemRow,
  PipelineRepo,
  type StageRow,
  TaskRepo,
  type TaskRow,
} from "../repos/crm-repo.js";
import { ensureStages } from "./stages.js";

/*
 * Contacts (design/06 §7, E2.5 §C).
 *
 * The one idea worth stating: **a contact is not a login.** `membership_id` is an optional link
 * to `core.membership`, and the display name and email on the CRM row are the CRM's own copy —
 * staff correct a misspelt name without touching identity, and a member who has no portal
 * account yet still has a card. What the link buys is the upsert key the outbox handlers use,
 * and a sensible default for the two fields when the link is first made: a staff member who
 * picks somebody out of the people list should not then have to retype their name.
 *
 * The kernel read here goes through `@fundroom/identity`'s `MembershipRepo` rather than a
 * query of `core.membership`: modules never read `core.*` themselves (principle 2), and that
 * repo is the sanctioned seam.
 */

export interface ContactDetail {
  readonly contact: ContactRow;
  readonly organization: OrganizationRow | null;
  readonly notes: readonly NoteRow[];
  readonly tasks: readonly TaskRow[];
  readonly items: readonly { readonly item: PipelineItemRow; readonly stage: StageRow | null }[];
}

export interface ContactService {
  list(
    ctx: TenantContext,
    filter: {
      q?: string | undefined;
      organizationId?: string | undefined;
      tag?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<Page<ContactRow>>;
  get(ctx: TenantContext, id: string): Promise<ContactRow>;
  detail(ctx: TenantContext, id: string): Promise<ContactDetail>;
  create(ctx: TenantContext, input: NewContact, actor: Actor): Promise<ContactRow>;
  patch(ctx: TenantContext, id: string, patch: ContactPatch, actor: Actor): Promise<ContactRow>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
}

/** The partial unique index on `(workspace_id, membership_id)`, said in words. */
function rethrowDuplicateLink(error: unknown): never {
  if (pgErrorCode(error) === "23505") {
    throw new CrmError("conflict", "another contact is already linked to that member", {
      reason: "membership_linked",
      field: "membershipId",
    });
  }
  throw error;
}

/**
 * What a `membershipId` on a create or a patch resolves to.
 *
 * Refused rather than ignored when the member is not one of this workspace's: a silently
 * dropped link would leave the admin looking at a contact that is not connected to the person
 * they just chose. `MembershipRepo` is workspace-scoped, so a member of another tenant reads
 * as absent here, which is also the right answer for a cross-tenant id.
 */
async function resolveMember(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<{ displayName: string; email: string | null }> {
  const repo = new MembershipRepo(ctx, tx);
  const membership = await repo.byId(membershipId);
  if (membership === undefined) {
    throw new CrmError("validation_failed", "no such member in this workspace", {
      field: "membershipId",
      membershipId,
    });
  }
  const person = await repo.person(membershipId);
  return { displayName: person?.displayName ?? "", email: person?.email ?? null };
}

async function checkOrganization(
  ctx: TenantContext,
  tx: Tx,
  organizationId: string,
): Promise<void> {
  const row = await new OrganizationRepo(ctx, tx).find(organizationId);
  if (row === undefined) {
    throw new CrmError("validation_failed", "no such organisation in this workspace", {
      field: "organizationId",
      organizationId,
    });
  }
}

export function createContactService(services: ModuleServices): ContactService {
  const { db, audit } = services;

  return {
    list(ctx, filter) {
      return db.withTenant(ctx, (tx) => new ContactRepo(ctx, tx).list(filter));
    },

    async get(ctx, id) {
      const row = await db.withTenant(ctx, (tx) => new ContactRepo(ctx, tx).find(id));
      if (row === undefined) throw new CrmError("not_found", "no such contact");
      return row;
    },

    /** Everything the contact screen shows, in one transaction and one round trip. */
    async detail(ctx, id) {
      return db.withTenant(ctx, async (tx) => {
        const row = await new ContactRepo(ctx, tx).find(id);
        if (row === undefined) throw new CrmError("not_found", "no such contact");
        const organization =
          row.organizationId === null
            ? null
            : ((await new OrganizationRepo(ctx, tx).find(row.organizationId)) ?? null);
        const notes = await new NoteRepo(ctx, tx).listFor("contact", id);
        const tasks = await new TaskRepo(ctx, tx).listFor("contact", id);
        const items = await new PipelineRepo(ctx, tx).listForContact(id);
        const stages = new Map((await ensureStages(ctx, tx)).map((s) => [s.id, s]));
        return {
          contact: row,
          organization,
          notes,
          tasks,
          items: items.map((item) => ({ item, stage: stages.get(item.stageId) ?? null })),
        };
      });
    },

    async create(ctx, input, actor) {
      return db.withTenant(ctx, async (tx) => {
        if (input.organizationId != null) await checkOrganization(ctx, tx, input.organizationId);
        let values: NewContact = { ...input, createdBy: actor.membershipId };
        if (input.membershipId != null) {
          const member = await resolveMember(ctx, tx, input.membershipId);
          // Defaults, not overrides: a caller who typed a name keeps it.
          values = {
            ...values,
            displayName:
              input.displayName.trim() === ""
                ? member.displayName.trim() === ""
                  ? "Unnamed contact"
                  : member.displayName
                : input.displayName,
            email: input.email == null || input.email === "" ? member.email : input.email,
          };
        }
        if (values.displayName.trim() === "") {
          // Reached only when there was no member to borrow a name from: `CreateContactBody`
          // defaults `displayName` to the empty string precisely so the link can fill it in.
          throw new CrmError("validation_failed", "a contact needs a name", {
            field: "displayName",
          });
        }
        const row = await new ContactRepo(ctx, tx)
          .insert(values)
          .catch((e: unknown) => rethrowDuplicateLink(e));
        await audit.record(tx, ctx, {
          action: "crm.contact_created",
          resourceKind: "crm_contact",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          apiKeyId: actor.apiKeyId,
          // `subjectMembershipId` is the kernel's field for "this row is about that person";
          // the name and the email stay off the audit row entirely (§C).
          ...(row.membershipId === null ? {} : { subjectMembershipId: row.membershipId }),
          meta: {
            linked: row.membershipId !== null,
            ...(row.organizationId === null ? {} : { organizationId: row.organizationId }),
          },
        });
        return row;
      });
    },

    async patch(ctx, id, patch, actor) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new ContactRepo(ctx, tx);
        const before = await repo.find(id);
        if (before === undefined) throw new CrmError("not_found", "no such contact");
        if (patch.organizationId != null) await checkOrganization(ctx, tx, patch.organizationId);
        let values = patch;
        if (patch.membershipId != null && patch.membershipId !== before.membershipId) {
          const member = await resolveMember(ctx, tx, patch.membershipId);
          const wantsName = (patch.displayName ?? before.displayName).trim();
          const wantsEmail = patch.email === undefined ? before.email : patch.email;
          values = {
            ...patch,
            ...(wantsName === "" && member.displayName.trim() !== ""
              ? { displayName: member.displayName }
              : {}),
            ...(wantsEmail == null || wantsEmail === "" ? { email: member.email } : {}),
          };
        }
        const row = await repo.update(id, values).catch((e: unknown) => rethrowDuplicateLink(e));
        if (row === undefined) throw new CrmError("not_found", "no such contact");
        await audit.record(tx, ctx, {
          action: "crm.contact_updated",
          resourceKind: "crm_contact",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          apiKeyId: actor.apiKeyId,
          ...(row.membershipId === null ? {} : { subjectMembershipId: row.membershipId }),
          meta: { fields: Object.keys(patch).sort(), linked: row.membershipId !== null },
        });
        return row;
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const removed = await new ContactRepo(ctx, tx).softDelete(id);
        if (!removed) throw new CrmError("not_found", "no such contact");
        await audit.record(tx, ctx, {
          action: "crm.contact_deleted",
          resourceKind: "crm_contact",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId ?? null,
          sessionId: actor.sessionId ?? null,
          apiKeyId: actor.apiKeyId,
        });
      });
    },
  };
}
