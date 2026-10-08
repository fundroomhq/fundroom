import type { TenantContext, Tx } from "@fundroom/db";
import type { SearchIndexService } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { dataRoomModule } from "../index.js";
import { SEARCH_BODY_MAX } from "../repos/dataroom-repo.js";
import {
  cleanBody,
  createSearchIndexer,
  documentEntry,
  folderEntry,
  SEARCH_MODULE,
  SEARCH_VERSION,
} from "./search.js";

const DOC = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FOLDER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
const at = new Date("2026-09-23T10:00:00Z");

describe("data-room search entries", () => {
  it("maps a document to a resource entry checked against its folder's path (ADR-0034)", () => {
    const path = `r.${FOLDER.replaceAll("-", "")}`;
    expect(
      documentEntry({
        id: DOC,
        title: "Pitch deck",
        folderPath: path,
        updatedAt: at,
        body: "a\nb",
        staffOnly: false,
      }),
    ).toEqual({
      kind: "document",
      refId: DOC,
      title: "Pitch deck",
      body: "a\nb",
      acl: { kind: "resource", resourceKind: "document", resourceId: DOC, path },
      href: `/data-room/documents/${DOC}`,
      updatedAt: at,
    });
  });

  it("indexes a document without a ready version by title only", () => {
    const e = documentEntry({
      id: DOC,
      title: "Draft",
      folderPath: "r",
      updatedAt: at,
      body: null,
      staffOnly: false,
    });
    expect(e.body).toBe("");
    expect(e.title).toBe("Draft");
  });

  it("strips control characters (the engine's highlight delimiters among them) and caps the body", () => {
    expect(cleanBody("a\u0002b\u0003c\td\ne\u0000")).toBe("a b c\td\ne ");
    expect(cleanBody("x".repeat(SEARCH_BODY_MAX + 10))).toHaveLength(SEARCH_BODY_MAX);
  });

  it("maps a folder to a title-only entry on its own path, linking the investor folder view", () => {
    const path = `r.${FOLDER.replaceAll("-", "")}`;
    expect(
      folderEntry({
        id: FOLDER,
        parentId: "p",
        name: "Financials",
        path,
        updatedAt: at,
        staffOnly: false,
      }),
    ).toEqual({
      kind: "folder",
      refId: FOLDER,
      title: "Financials",
      acl: { kind: "resource", resourceKind: "folder", resourceId: FOLDER, path },
      href: `/data-room/folders/${FOLDER}`,
      updatedAt: at,
    });
  });

  it("indexes anything under a staff-only folder with the staff ACL, never a resource one (E3.5)", () => {
    const path = `r.${FOLDER.replaceAll("-", "")}`;
    const doc = documentEntry({
      id: DOC,
      title: "SAFE — signed",
      folderPath: path,
      updatedAt: at,
      body: "signed text",
      staffOnly: true,
    });
    expect(doc.acl).toEqual({ kind: "staff" });
    expect(doc.body).toBe("signed text");
    const f = folderEntry({
      id: FOLDER,
      parentId: "p",
      name: "Signed documents",
      path,
      updatedAt: at,
      staffOnly: true,
    });
    expect(f?.acl).toEqual({ kind: "staff" });
  });

  it("does not index the root folder", () => {
    expect(
      folderEntry({
        id: FOLDER,
        parentId: null,
        name: "Data room",
        path: "r",
        updatedAt: at,
        staffOnly: false,
      }),
    ).toBeUndefined();
  });

  it("is declared on the manifest", () => {
    expect(dataRoomModule.search?.version).toBe(SEARCH_VERSION);
    expect(SEARCH_MODULE).toBe(dataRoomModule.id);
  });
});

describe("the incremental indexer", () => {
  function fake() {
    const calls: string[] = [];
    const search: SearchIndexService = {
      async upsert(_tx, _ctx, module, entries) {
        calls.push(`upsert ${module} ${entries.map((e) => e.refId).join(",")}`);
      },
      async replace() {
        calls.push("replace");
      },
      async remove(_tx, _ctx, module, ref) {
        calls.push(`remove ${module} ${ref.kind} ${ref.refId} ${ref.part ?? "*"}`);
      },
      async requestReindex(_tx, _ctx, module) {
        calls.push(`reindex ${module}`);
      },
      async moveAclPath(_tx, _ctx, module, from, to) {
        calls.push(`move ${module} ${from} -> ${to}`);
        return 2;
      },
      async clearBodies(_tx, _ctx, module, kind, refIds) {
        calls.push(`clear ${module} ${kind} ${refIds.join(",")}`);
        return refIds.length;
      },
    };
    return { calls, indexer: createSearchIndexer({ search }) };
  }
  const tx = {} as Tx;
  const ctx = { workspaceId: "w", actorKind: "system" } as TenantContext;

  it("removes every part of each ref on the caller's transaction", async () => {
    const { calls, indexer } = fake();
    await indexer.remove(tx, ctx, "document", ["a", "b"]);
    await indexer.remove(tx, ctx, "folder", ["c"]);
    expect(calls).toEqual([
      "remove data-room document a *",
      "remove data-room document b *",
      "remove data-room folder c *",
    ]);
  });

  it("a subtree move re-paths the entries in SQL and reads no document (fix A #5)", async () => {
    const { calls, indexer } = fake();
    // Any read through the transaction would throw: the move must not touch the source tables.
    const noReads = new Proxy({} as Tx, {
      get() {
        throw new Error("the move read through the transaction");
      },
    });
    await indexer.moved(noReads, ctx, "r.a.b", "r.c.b");
    expect(calls).toEqual(["move data-room r.a.b -> r.c.b"]);
  });

  it("does nothing (and reads nothing) for an empty id list", async () => {
    const { calls, indexer } = fake();
    await indexer.documents(tx, ctx, []);
    await indexer.folders(tx, ctx, []);
    expect(calls).toEqual([]);
  });
});
