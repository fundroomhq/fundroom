import type { BlockHydrator, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import type { Viewer } from "./service/access.js";
import { createFolderService } from "./service/folders.js";

/*
 * `document_list` (ADR-0033 §3): the content page stores a folder id and/or document ids;
 * at render time — after section visibility — the data room answers with the documents this
 * viewer may open, in index order. Signed-out viewers get an empty list: documents are never
 * public.
 */
export function createDocumentListHydrator(services: ModuleServices): BlockHydrator {
  const folders = createFolderService(services);
  return {
    type: "document_list",
    async hydrate(data: JsonObject, { tenant, viewer, facts }) {
      if (viewer.kind === "anonymous" || viewer.membershipId === undefined)
        return { documents: [] };
      const v: Viewer = { membershipId: viewer.membershipId, kind: viewer.kind, facts };
      const folderId = typeof data["folderId"] === "string" ? data["folderId"] : null;
      const ids = Array.isArray(data["documentIds"])
        ? data["documentIds"].filter((x): x is string => typeof x === "string")
        : [];
      const tree = await folders.tree(tenant, v);
      const documents = tree.documents
        .filter(
          (d) =>
            (folderId !== null && d.document.folderId === folderId) || ids.includes(d.document.id),
        )
        .map((d) => ({
          id: d.document.id,
          title: d.document.title,
          index: d.index,
          folderId: d.document.folderId,
          updatedAt: d.document.updatedAt.toISOString(),
          gated: d.decision.reason === "gated",
        }));
      return { documents };
    },
  };
}
