import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { TenantContext } from "./context.js";
import type { Tx } from "./database.js";

/** A table that carries the tenant column. Every module table except the global ones. */
export type TenantTable = PgTable & {
  readonly workspaceId: PgColumn;
};

/** Tables with a single-column `id` primary key get the by-id helpers. */
export type TenantTableWithId = TenantTable & { readonly id: PgColumn };

/**
 * Base for repositories over tenant-scoped tables (design/06 §3).
 *
 * RLS already filters rows, but the repo appends `workspace_id = ctx.workspaceId` to every
 * read and forces it on every insert so:
 *  - the planner uses the (workspace_id, …) index instead of relying on the policy,
 *  - a query still returns nothing if RLS were ever disabled on a table,
 *  - an insert with a foreign workspace_id cannot even be expressed.
 *
 * Repositories are the only place that imports drizzle-orm outside packages/db
 * (dependency-cruiser rule `only-repos-touch-drizzle`).
 */
export abstract class TenantRepo<TTable extends TenantTable> {
  constructor(
    protected readonly table: TTable,
    protected readonly ctx: TenantContext,
    protected readonly tx: Tx,
  ) {}

  /** `workspace_id = :ws [AND extra]` for use in where clauses. */
  protected scope(extra?: SQL): SQL {
    const fence = eq(this.table.workspaceId, this.ctx.workspaceId);
    if (extra === undefined) return fence;
    const combined = and(fence, extra);
    // `and()` only returns undefined when called with zero arguments.
    return combined ?? fence;
  }

  protected async findById(
    this: TenantRepo<TTable & TenantTableWithId>,
    id: string,
  ): Promise<TTable["$inferSelect"] | undefined> {
    const rows = await this.tx
      .select()
      .from(this.table as PgTable)
      .where(this.scope(eq(this.table.id, id)))
      .limit(1);
    return rows[0] as TTable["$inferSelect"] | undefined;
  }

  protected async findMany(where?: SQL): Promise<TTable["$inferSelect"][]> {
    const rows = await this.tx
      .select()
      .from(this.table as PgTable)
      .where(this.scope(where));
    return rows as TTable["$inferSelect"][];
  }

  /** Inserts with `workspace_id` forced from the context; a caller-supplied value is ignored. */
  protected async insertOne(
    values: Omit<TTable["$inferInsert"], "workspaceId">,
  ): Promise<TTable["$inferSelect"]> {
    const rows = await this.tx
      .insert(this.table as PgTable)
      .values({ ...(values as Record<string, unknown>), workspaceId: this.ctx.workspaceId })
      .returning();
    return rows[0] as TTable["$inferSelect"];
  }

  protected async deleteById(
    this: TenantRepo<TTable & TenantTableWithId>,
    id: string,
  ): Promise<number> {
    const rows = await this.tx
      .delete(this.table as PgTable)
      .where(this.scope(eq(this.table.id, id)))
      .returning();
    return rows.length;
  }
}
