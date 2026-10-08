import type { ModulePortability } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { EVIDENCE_KEY_PURPOSE } from "./model.js";

/*
 * Workspace export/import (E2.8). Everything in `round` is the record of a raise — terms as they
 * were shown, who said they were interested and under which offering status, who was verified
 * and on what evidence, the money — so every table travels as rows. Nothing is derived (the
 * allocation tracker adds commitments up on read) and nothing is secret or keyed.
 *
 * FK order: round → terms (→ round) → interest_submission (→ round) → verification
 * (→ interest_submission) → commitment (→ round, interest_submission) → closing_task (→ round).
 * The three forward references — `terms.superseded_by` (the next revision, a later row),
 * `interest_submission.verification_id` and `.commitment_id` — are DEFERRABLE INITIALLY DEFERRED
 * since 0002, and resolve at the import's COMMIT. `terms` is append-only to UPDATE only; the import
 * INSERTs every revision as exported, and `terms_one_current` (deferred) holds at COMMIT because it
 * held in the source. `commitment.organization_id` / `contact_id` / `signed_document_id` are soft
 * references into crm and data-room: the engine's generic id remap carries them when those rows
 * travel too.
 *
 * `verification` carries a blob: the accreditation evidence, SHE1 under the workspace's
 * `round-evidence` DEK, at `round/verification/<workspace>/<verification>` — outside `ws/`, which
 * `ctx.remapKey` handles because it rewrites every uuid in the key. `evidence_sha256` is hex
 * *text* (not the bytea the engine verifies), so it is not declared as `sha256Column`; it travels
 * as a plain column. `optional`: the purge job or a lost object leaves a row without a file, and
 * that must not fail an export — the decision and its digest are what prove it, not the bytes.
 */
/**
 * An object sealed before 0002 whose descriptor the migration could not backfill cannot be
 * decrypted by the engine, so its key is dropped and the row says the file is gone — the CHECK
 * `verification_verified_has_evidence` still holds through `evidence_sha256`.
 */
export function exportVerificationRow(row: JsonObject, now: Date = new Date()): JsonObject {
  if (row["evidence_key"] == null || row["evidence_encryption"] != null) return row;
  return {
    ...row,
    evidence_key: null,
    evidence_purged_at:
      typeof row["evidence_purged_at"] === "string" ? row["evidence_purged_at"] : now.toISOString(),
  };
}

/**
 * E3.7: a vendor verification's handoff (the vendor SDK's config, the vendor's record id) is bound
 * to this install's vendor connection and does not travel; nor does its polling schedule — the
 * target has no connection its ref means anything to (`next_check_at` is cleared on import, so no
 * sync ever runs against it; an admin there decides a still-pending one by hand).
 */
export function exportVendorColumns(row: JsonObject): JsonObject {
  return "handoff" in row ? { ...row, handoff: null } : row;
}

export function importVerificationRow(row: JsonObject): JsonObject {
  const vendor = typeof row["provider"] === "string" && row["provider"] !== "manual";
  return {
    ...row,
    handoff: null,
    next_check_at: null,
    // Marks a vendor row as not this install's: callbacks, check-now, the sweeps and the
    // lifecycle re-check never ask a vendor about it (the start job and sync skip it too).
    ...(vendor ? { vendor_error: "imported" } : {}),
  };
}

export const roundPortability: ModulePortability = {
  version: 1,
  tables: [
    { table: "round", mode: "rows" },
    { table: "terms", mode: "rows" },
    { table: "interest_submission", mode: "rows" },
    {
      table: "verification",
      mode: "rows",
      exportRow: (row) => exportVendorColumns(exportVerificationRow(row)),
      importRow: (row) => importVerificationRow(row),
      blobs: [
        {
          keyColumn: "evidence_key",
          encryptionColumn: "evidence_encryption",
          purpose: EVIDENCE_KEY_PURPOSE,
          optional: true,
        },
      ],
    },
    { table: "commitment", mode: "rows" },
    { table: "closing_task", mode: "rows" },
    // E3.5: mirrors of kernel e-sign envelopes, which are bound to the source's vendor connection
    // and do not travel (the signed copies travel as vaulted data-room documents).
    { table: "signature_request", mode: "skip", reason: "instance-local" },
  ],
};
