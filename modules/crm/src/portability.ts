import type { ModulePortability } from "@fundroom/module-kit";

/*
 * Workspace export/import (E2.8): every CRM table travels as rows, in FK order, with no
 * per-row transform. Nothing here is a secret, a keyed hash or a blob.
 *
 * What the engine already does for us:
 *  * `contact.search_tsv` is GENERATED ALWAYS … STORED, so the engine strips it on export and
 *    Postgres recomputes it on insert.
 *  * Every uuid that is an exported row id is remapped generically: `contact.membership_id`,
 *    the `*_membership_id` / `created_by` columns (memberships are exported by the kernel),
 *    `organization_id`, `stage_id`, the polymorphic `note/task.subject_id`, the history's
 *    `from_stage_id` / `to_stage_id`, and the soft references into the round module
 *    (`pipeline_item.round_id`, `commitment_id`). A soft reference whose target was not
 *    exported (a stage removed since, a round that no longer exists) keeps its old value,
 *    which is what the source held too: a dangling soft reference.
 *
 * No `after`: the CRM has no foreign key into another module (the round module imports after
 * the CRM, not the other way round).
 */
export const crmPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "organization", mode: "rows" },
    { table: "contact", mode: "rows" },
    { table: "pipeline_stage", mode: "rows" },
    { table: "pipeline_item", mode: "rows" },
    { table: "note", mode: "rows" },
    { table: "task", mode: "rows" },
    { table: "stage_transition", mode: "rows" },
    // E3.6: meeting activity. `booking_id` points at `core.integration_booking`, which is not
    // exported (vendor-bound): it travels as a dangling soft reference, like a round id.
    { table: "activity", mode: "rows" },
  ],
};
