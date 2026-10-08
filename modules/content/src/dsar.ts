import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberContent } from "./repos/dsar-repo.js";

/*
 * The content part of a subject-access export (E2.7 DSAR, `modules/content.json`).
 *
 * Content records nothing about who reads a page (that is analytics), so it holds no data about
 * investors at all. For staff it holds authorship: the export lists the pages, revisions and
 * section-visibility rules the member created or last changed — ids, slugs and times, never the
 * page bodies, which are company content. Each list is capped at 10 000 rows.
 */
export const contentDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberContent(ctx, tx, membershipId),
};
