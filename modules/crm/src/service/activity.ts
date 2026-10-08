import type { TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { CrmError } from "../errors.js";
import { ACTIVITY_LIST_LIMIT } from "../model.js";
import { ActivityRepo, type ActivityRow, ContactRepo } from "../repos/crm-repo.js";

/*
 * Contact activity (E3.6): the meetings a verified booking webhook recorded on a contact
 * (`handlers.ts` writes them; nothing else does). Read-only here — staff do not type activities
 * in, and a row is removed only by erasure or with its contact.
 */
export interface ActivityService {
  /** Newest first, at most `ACTIVITY_LIST_LIMIT`; 404 for a missing or deleted contact. */
  forContact(ctx: TenantContext, contactId: string): Promise<ActivityRow[]>;
}

export function createActivityService(services: ModuleServices): ActivityService {
  return {
    forContact: (ctx, contactId) =>
      services.db.withTenant(ctx, async (tx) => {
        if ((await new ContactRepo(ctx, tx).find(contactId)) === undefined) {
          throw new CrmError("not_found", "no such contact");
        }
        return new ActivityRepo(ctx, tx).listForContact(contactId, ACTIVITY_LIST_LIMIT);
      }),
  };
}
