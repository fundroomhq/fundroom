import type { ModulePortability } from "@fundroom/module-kit";
import { SEARCH_MODULE } from "./search.js";

/*
 * Workspace export/import (E2.8). Every `content` table travels as rows: a page, its draft and
 * published revisions and the live section rules are all authored data, and there is nothing
 * secret, keyed or stored outside Postgres (hero images, team photos and embeds are URLs).
 *
 * Order is FK order: `page` first, then `page_revision` (→ page), then `section_visibility`
 * (→ page). `page.published_revision_id` / `draft_revision_id` point forward into
 * `page_revision`, and those two FKs are DEFERRABLE INITIALLY DEFERRED (0001), so the import
 * transaction resolves them at commit. `page_revision` is immutable only to UPDATE; the import
 * inserts, which the trigger does not touch. Group ids inside `section_visibility.rule` and the
 * `page_revision.visibility` snapshot are whole jsonb strings, so the engine's generic id remap
 * carries them to the new workspace's groups.
 */
export const contentPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "page", mode: "rows" },
    { table: "page_revision", mode: "rows" },
    { table: "section_visibility", mode: "rows" },
  ],
  // The search index is kernel data rebuilt per workspace; ask for it rather than wait for the
  // sweep to notice the new workspace.
  async afterImport({ tx, ctx, services }) {
    await services.search.requestReindex(tx, ctx, SEARCH_MODULE);
  },
};
