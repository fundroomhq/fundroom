import {
  core,
  type NewWorkspaceKey,
  type TenantContext,
  TenantRepo,
  type Tx,
  type WorkspaceKey,
} from "@fundroom/db";
import { and, asc, eq, isNull } from "drizzle-orm";

/*
 * The only file that touches core.workspace_key through drizzle. Every read is scoped to
 * the context's workspace on top of RLS; the app role cannot DELETE (migration 0003), so
 * retirement is an UPDATE.
 */
export class WorkspaceKeyRepo extends TenantRepo<typeof core.workspaceKey> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(core.workspaceKey, ctx, tx);
  }

  async findActive(purpose: string): Promise<WorkspaceKey | undefined> {
    const rows = await this.tx
      .select()
      .from(this.table)
      .where(this.scope(and(eq(this.table.purpose, purpose), isNull(this.table.retiredAt))))
      .limit(1);
    return rows[0];
  }

  async byId(id: string): Promise<WorkspaceKey | undefined> {
    return this.findById(id);
  }

  async listAll(purpose?: string): Promise<WorkspaceKey[]> {
    const rows = await this.tx
      .select()
      .from(this.table)
      .where(this.scope(purpose === undefined ? undefined : eq(this.table.purpose, purpose)))
      .orderBy(asc(this.table.createdAt));
    return rows;
  }

  async insert(values: Omit<NewWorkspaceKey, "workspaceId" | "id">): Promise<WorkspaceKey> {
    return this.insertOne(values);
  }

  async retire(id: string, at: Date): Promise<boolean> {
    const rows = await this.tx
      .update(this.table)
      .set({ retiredAt: at })
      .where(this.scope(and(eq(this.table.id, id), isNull(this.table.retiredAt))))
      .returning({ id: this.table.id });
    return rows.length > 0;
  }

  async updateWrapped(id: string, wrappedDek: Buffer, kmsKeyRef: string): Promise<boolean> {
    const rows = await this.tx
      .update(this.table)
      .set({ wrappedDek, kmsKeyRef })
      .where(this.scope(eq(this.table.id, id)))
      .returning({ id: this.table.id });
    return rows.length > 0;
  }
}
