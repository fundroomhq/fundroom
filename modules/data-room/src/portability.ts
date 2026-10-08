import { DEFAULT_PURPOSE } from "@fundroom/crypto";
import {
  type ModulePortability,
  type PortableImportContext,
  PortableImportRefusal,
} from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { JOB_INGEST } from "./jobs.js";
import { ROOT_LABEL } from "./model.js";
import { FolderRepo, SearchSourceRepo } from "./repos/dataroom-repo.js";
import { SEARCH_MODULE } from "./service/search.js";

/*
 * Workspace export/import (E2.8). Every `dataroom` table in FK order. Carried: the tree, the
 * content-addressed blobs (decrypted into the zip, re-encrypted under the new workspace's DEK
 * on import), documents with protection and legal-hold state, and the immutable versions.
 * Not carried: renditions and page text (derived — `afterImport` re-queues the ingest job for
 * every current version, which re-renders the thumbnail / sanitised PDF and re-extracts the
 * text without re-scanning or adding versions) and staged uploads (transient).
 *
 * ltree paths are made of folder ids without hyphens, which the generic id remap cannot see:
 * `folder.path` and `document.folder_path` go through `ctx.remapLtree`. The remap cannot tell a
 * crafted path from a real one, and access rules are derived from these paths (a folder grant's
 * `resource_path` is its folder's `path`, re-derived on import), so `afterImport` checks the tree's
 * shape — root at `r`, every folder at its parent's path plus its own label, every document at its
 * folder's path — and refuses the whole import on a mismatch (E3.2 L-2).
 *
 * A blob that never left quarantine (pending / scanning / error / infected) has no encrypted
 * object — and an infected one is malware — so its bytes are not exported: `exportRow` nulls its
 * key and import gives the row a placeholder key and `scan_status = 'error'`, which keeps the
 * version row's FK and shows the file as failed rather than silently dropping history.
 *
 * Q&A (E3.3) travels whole: questions and answers, their status, SLA stamps and approvals.
 * Every uuid in them — document/folder targets, asker/assignee/author/approver memberships —
 * is an exported row id and goes through the generic remap. Their search entries come back
 * with the reindex `afterImport` asks for (published questions on live targets only).
 */
/** 2: Q&A (`qa_question`, `qa_answer`, E3.3) joined the export. */
export const PORTABILITY_VERSION = 2;
export const NOT_EXPORTED_DETAIL = "bytes not carried by the workspace export";

const PROMOTED = new Set(["clean", "skipped"]);

function remapPath(row: JsonObject, column: string, ctx: PortableImportContext): JsonObject {
  const value = row[column];
  return typeof value === "string" ? { ...row, [column]: ctx.remapLtree(value) } : row;
}

export function exportBlobRow(row: JsonObject): JsonObject {
  const status = row["scan_status"];
  if (typeof status === "string" && PROMOTED.has(status)) return row;
  return { ...row, storage_key: null };
}

export function importBlobRow(row: JsonObject, ctx: PortableImportContext): JsonObject {
  if (row["storage_key"] !== null && row["storage_key"] !== undefined) return row;
  const id = typeof row["id"] === "string" ? row["id"] : "unknown";
  return {
    ...row,
    storage_key: `ws/${ctx.workspaceId}/quarantine/not-exported-${id}`,
    encryption: {},
    scan_status: "error",
    scan_detail: NOT_EXPORTED_DETAIL,
  };
}

export const dataRoomPortability: ModulePortability = {
  version: PORTABILITY_VERSION,
  tables: [
    {
      table: "folder",
      mode: "rows",
      importRow: (row, ctx) => remapPath(row, "path", ctx),
    },
    {
      table: "blob",
      mode: "rows",
      blobs: [
        {
          keyColumn: "storage_key",
          encryptionColumn: "encryption",
          purpose: DEFAULT_PURPOSE,
          sha256Column: "sha256",
        },
      ],
      exportRow: exportBlobRow,
      importRow: importBlobRow,
    },
    {
      table: "document",
      mode: "rows",
      // E3.5: `esign_envelope_id` names a kernel envelope, which is vendor-bound and not exported
      // (the vaulted copy travels, the link does not): an exported id would be a dangling — or,
      // on the same instance, another workspace's — reference.
      exportRow: (row) => ("esign_envelope_id" in row ? { ...row, esign_envelope_id: null } : row),
      importRow: (row, ctx) => remapPath(row, "folder_path", ctx),
    },
    { table: "document_version", mode: "rows" },
    { table: "qa_question", mode: "rows" },
    { table: "qa_answer", mode: "rows" },
    { table: "rendition", mode: "skip", reason: "derived" },
    { table: "page_text", mode: "skip", reason: "derived" },
    { table: "upload", mode: "skip", reason: "transient" },
    // E3.13: marks are keyed by this install's key ring; another install could never detect them.
    { table: "forensic_mark", mode: "skip", reason: "instance-local" },
  ],
  async afterImport({ tx, ctx, services }) {
    const bad = await new FolderRepo(ctx, tx).treeShapeViolations(ROOT_LABEL);
    if (bad.length > 0) {
      throw new PortableImportRefusal(
        `the data room's folder tree is inconsistent (a path does not match its parent folder): ${bad
          .map((b) => `${b.kind} ${b.id}`)
          .join(", ")}`,
      );
    }
    const versions = await new SearchSourceRepo(ctx, tx).resetForRederive();
    for (const v of versions) {
      await services.queue.sendInTransaction(
        tx,
        JOB_INGEST,
        { workspaceId: ctx.workspaceId, versionId: v.versionId, blobId: v.blobId, rederive: true },
        { idempotencyKey: `ingest:${v.versionId}` },
      );
    }
    // Folders and titles now; each document's body lands when its ingest finishes.
    await services.search.requestReindex(tx, ctx, SEARCH_MODULE);
  },
};
