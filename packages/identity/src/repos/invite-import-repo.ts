import { core, type InviteImport, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, desc, eq } from "drizzle-orm";

/** `core.invite_import` rows: a CSV import's plan, progress and per-row status (jsonb). */
export class InviteImportRepo extends TenantRepo<typeof core.inviteImport> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(core.inviteImport, ctx, tx);
  }
  byId(id: string) {
    return this.findById(id);
  }
  create(values: Omit<typeof core.inviteImport.$inferInsert, "workspaceId">) {
    return this.insertOne(values);
  }
  async list(limit: number): Promise<InviteImport[]> {
    return this.tx
      .select()
      .from(core.inviteImport)
      .where(this.scope())
      .orderBy(desc(core.inviteImport.createdAt))
      .limit(limit);
  }
  async patch(id: string, set: Partial<typeof core.inviteImport.$inferInsert>): Promise<void> {
    await this.tx
      .update(core.inviteImport)
      .set(set)
      .where(this.scope(and(eq(core.inviteImport.id, id))));
  }
}
