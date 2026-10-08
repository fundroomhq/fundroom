import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { contentModule } from "./index.js";
import { contentPortability } from "./portability.js";
import { page, pageRevision, sectionVisibility } from "./schema/content.js";

describe("content portability spec", () => {
  it("lists every table of the schema, in FK order, all carried as rows", () => {
    const tables = [page, pageRevision, sectionVisibility].map((t) => getTableConfig(t).name);
    expect(contentPortability.tables.map((t) => t.table)).toEqual(tables);
    expect(contentPortability.tables.every((t) => t.mode === "rows")).toBe(true);
    expect(contentModule.portability).toBe(contentPortability);
    expect(contentModule.search?.version).toBe(1);
  });

  it("asks for a search rebuild of the imported workspace", async () => {
    const asked: string[] = [];
    await contentPortability.afterImport?.({
      tx: {} as never,
      ctx: { workspaceId: "w2" } as never,
      services: {
        search: { requestReindex: async (_tx: unknown, _ctx: unknown, m: string) => asked.push(m) },
      } as never,
    });
    expect(asked).toEqual(["content"]);
  });
});
