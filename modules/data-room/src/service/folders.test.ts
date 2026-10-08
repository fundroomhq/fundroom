import { describe, expect, it } from "vitest";
import type { Document, Folder } from "../schema/dataroom.js";
import { computeIndexes } from "./folders.js";

const t = new Date();
function folder(id: string, parentId: string | null, name: string, sortOrder = 0): Folder {
  return {
    id,
    workspaceId: "w",
    parentId,
    name,
    path: id,
    sortOrder,
    staffOnly: false,
    createdBy: null,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
  };
}
function doc(id: string, folderId: string, title: string, sortOrder = 0): Document {
  return {
    id,
    workspaceId: "w",
    folderId,
    folderPath: folderId,
    title,
    sortOrder,
    currentVersionId: null,
    protection: {},
    protectionSchemaVersion: 1,
    legalHold: false,
    legalHoldReason: null,
    legalHoldSetBy: null,
    legalHoldSetAt: null,
    esignEnvelopeId: null,
    createdBy: null,
    createdAt: t,
    updatedAt: t,
    deletedAt: null,
    deletedBy: null,
    purgeAfter: null,
  };
}

describe("computeIndexes", () => {
  it("produces DD-checklist numbers: folders first, then documents, nested", () => {
    const root = folder("root", null, "Data room");
    const folders = [
      root,
      folder("legal", "root", "Legal", 2),
      folder("corp", "root", "Corporate", 1),
      folder("charter", "corp", "Charter"),
    ];
    const documents = [
      doc("d-root", "root", "Overview deck"),
      doc("d-corp", "corp", "Bylaws"),
      doc("d-charter", "charter", "Articles"),
    ];
    const idx = computeIndexes(root, folders, documents);
    expect(idx.get("corp")).toBe("1");
    expect(idx.get("legal")).toBe("2");
    expect(idx.get("d-root")).toBe("3");
    expect(idx.get("charter")).toBe("1.1");
    expect(idx.get("d-corp")).toBe("1.2");
    expect(idx.get("d-charter")).toBe("1.1.1");
    expect(idx.has("root")).toBe(false);
  });
});
