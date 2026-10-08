import type { ModulePortability } from "@fundroom/module-kit";

/*
 * Workspace export/import (E2.8): every cap-table table travels as rows, in FK order, with no
 * per-row transform — nothing here is a secret, a keyed hash or a blob. The engine remaps every
 * exported row id generically: snapshot/class ids, and the membership references
 * (`holding.membership_id`, `snapshot.imported_by`; memberships are exported by the kernel).
 * Pseudonymised lines travel pseudonymised (`erased_at` set, no address, no member link).
 *
 * The immutability triggers accept these inserts: they guard UPDATE and DELETE only, and a
 * `published` snapshot row carries its `published_at`, as the shape CHECK wants.
 */
export const captablePortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "snapshot", mode: "rows" },
    { table: "security_class", mode: "rows" },
    { table: "holding", mode: "rows" },
  ],
};
