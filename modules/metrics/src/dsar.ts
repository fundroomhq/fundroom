import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberMetrics } from "./repos/dsar-repo.js";

/*
 * The metrics part of a subject-access export (E2.7 DSAR, `modules/metrics.json`).
 *
 * Metrics holds nothing about investors, and nothing *about* staff either: definitions, points,
 * imports and sheet connections are the company's figures and configuration. The only personal
 * datum is authorship (`created_by` / `imported_by`), so the export lists, per table, the ids and
 * times of the rows the member created or imported — never the figures, formulas, spreadsheet
 * ids or the encrypted sheet credential. Each list is capped at 10 000 rows.
 */
export const metricsDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberMetrics(ctx, tx, membershipId),
};
