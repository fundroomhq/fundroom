import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberAnalytics } from "./repos/dsar-repo.js";

/*
 * The analytics part of a subject-access export (E2.7 DSAR, `modules/analytics.json`).
 *
 * Exported — everything the erasure handler deletes, because it is all about the member:
 *   events          every recorded view, download, dwell and email open/click, with its props
 *   viewSessions    when each viewing session started and was last seen, browser family, embed
 *   pageOpens       per page of each document: first/last seen and time spent
 *   resourceRollups per document/post: views, downloads, total time, pages seen
 *   pagesRead       which pages of which version the member has read
 *   hotLeadAlerts   whether (and with what score) staff were alerted about the member
 * Each list is capped at 50 000 rows; `truncated` says when a cap was hit.
 *
 * Left out: `session_key` and `ip_hash` (keyed hashes the pipeline uses to join rows — they
 * identify nothing to the person and would only help someone re-identify the hashed ip), and the
 * workspace-wide rollups (`daily_resource_rollup`, `page_rollup`), which are counts over everyone
 * and hold nothing attributable to one member.
 */
export const analyticsDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberAnalytics(ctx, tx, membershipId),
};
