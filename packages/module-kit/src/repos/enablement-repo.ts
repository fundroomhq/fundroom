import { core, type ModuleEnablement, type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, eq, sql } from "drizzle-orm";

/** `core.module_enablement`: one row per (workspace, module); absent = the module's `defaultEnabled`. */
export class ModuleEnablementRepo extends TenantRepo<typeof core.moduleEnablement> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(core.moduleEnablement, ctx, tx);
  }

  async list(): Promise<ModuleEnablement[]> {
    return this.findMany();
  }

  async get(module: string): Promise<ModuleEnablement | undefined> {
    const rows = await this.findMany(eq(this.table.module, module));
    return rows[0];
  }

  /** Upsert; `config` untouched when omitted. */
  async set(
    module: string,
    enabled: boolean,
    config?: Record<string, unknown>,
  ): Promise<ModuleEnablement> {
    const rows = await this.tx
      .insert(this.table)
      .values({
        workspaceId: this.ctx.workspaceId,
        module,
        enabled,
        ...(config === undefined ? {} : { config }),
      })
      .onConflictDoUpdate({
        target: [this.table.workspaceId, this.table.module],
        set: {
          enabled,
          ...(config === undefined ? {} : { config }),
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("upsert returned no row");
    return row;
  }

  /**
   * "On" for a module that may only stay on, never be switched on (A-3: an optional module the
   * workspace's plan does not include), as one conditional write: keeps the row on when it is on,
   * and answers whether it was. With no row, `defaultEnabled` decides — a default-on module is on
   * (the insert records it), a default-off one is off. A row that says off, including one a
   * concurrent switch-off committed while this statement waited on its lock, matches nothing, so
   * the module is never switched back on; the caller refuses. Decided here, in the caller's
   * transaction, rather than from the per-process enablement cache, which another instance's
   * switch-off never reaches (ROUND-2 decision 15).
   */
  async keepOnIfOn(module: string, defaultEnabled: boolean): Promise<boolean> {
    const t = this.table;
    const onlyIfOn = sql`${t.enabled}`;
    const rows = defaultEnabled
      ? await this.tx
          .insert(t)
          .values({ workspaceId: this.ctx.workspaceId, module, enabled: true })
          .onConflictDoUpdate({
            target: [t.workspaceId, t.module],
            set: { enabled: true, updatedAt: sql`now()` },
            setWhere: onlyIfOn,
          })
          .returning({ module: t.module })
      : await this.tx
          .update(t)
          .set({ updatedAt: sql`now()` })
          .where(and(eq(t.workspaceId, this.ctx.workspaceId), eq(t.module, module), onlyIfOn))
          .returning({ module: t.module });
    return rows.length > 0;
  }
}
