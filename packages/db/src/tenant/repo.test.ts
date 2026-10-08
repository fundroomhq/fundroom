import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "./context.js";
import type { Tx } from "./database.js";
import { TenantRepo } from "./repo.js";

/*
 * Verifies the SQL shape TenantRepo produces without a database: the fence must be in
 * every statement and the insert must carry the context's workspace_id, whatever the
 * caller passed.
 */
const testSchema = pgSchema("dataroom");
const doc = testSchema.table("document", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  title: text("title").notNull(),
});

class DocRepo extends TenantRepo<typeof doc> {
  byId(id: string) {
    return this.tx
      .select()
      .from(doc)
      .where(this.scope(sql`${doc.id} = ${id}`))
      .toSQL();
  }
  all() {
    return this.tx.select().from(doc).where(this.scope()).toSQL();
  }
  create(title: string, workspaceId: string) {
    return this.tx
      .insert(doc)
      .values({ ...({ workspaceId } as object), id: "x", title, workspaceId: this.ctx.workspaceId })
      .toSQL();
  }
}

const WS = "01920000-0000-7000-8000-000000000001";
const ctx: TenantContext = { workspaceId: WS, actorKind: "system" };
// drizzle.mock() builds SQL without a connection; the "transaction" handle is the db itself.
const tx = drizzle.mock() as unknown as Tx;

describe("TenantRepo", () => {
  it("fences reads by workspace_id and the extra condition", () => {
    const q = new DocRepo(doc, ctx, tx).byId("abc");
    expect(q.sql).toMatch(/"dataroom"\."document"\."workspace_id" = \$1/u);
    expect(q.sql).toMatch(/and/iu);
    expect(q.params).toEqual([WS, "abc"]);
  });

  it("fences reads even with no extra condition", () => {
    const q = new DocRepo(doc, ctx, tx).all();
    expect(q.sql).toMatch(/where "dataroom"\."document"\."workspace_id" = \$1/u);
    expect(q.params).toEqual([WS]);
  });

  it("forces workspace_id from the context on insert", () => {
    const q = new DocRepo(doc, ctx, tx).create("t", "01920000-0000-7000-8000-00000000dead");
    expect(q.params).toContain(WS);
    expect(q.params).not.toContain("01920000-0000-7000-8000-00000000dead");
  });
});
