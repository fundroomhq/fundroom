import type { TenantContext, Tx } from "@fundroom/db";
import type {
  ModuleSearch,
  ModuleServices,
  SearchEntryInput,
  SearchPage,
} from "@fundroom/module-kit";
import { qaSearchPage } from "../qa/search.js";
import {
  type DocumentSearchRow,
  type FolderSearchRow,
  SEARCH_BODY_MAX,
  SearchSourceRepo,
} from "../repos/dataroom-repo.js";

/*
 * Workspace search (E2.8). One entry per live document — title always, body = the current
 * version's extracted page text once that version is `ready` and its blob servable — and one
 * title-only entry per live non-root folder. Both carry a `resource` ACL whose path is the one
 * `core.has_access` and `AuthzPort.check()` evaluate for that node (ADR-0034: a document is
 * checked against its folder's path, a folder against its own), so an investor finds exactly
 * what the tree would show them, and a gated (NDA pending) document shows its title only.
 *
 * Every write that changes what an entry says calls the indexer on the write's own
 * transaction; `dataRoomSearch.entries` is the full rebuild.
 *
 * E3.5: a document or folder at or below a staff-only folder is indexed with the `staff` ACL
 * instead — no grant makes it findable by an external member (the staff-only veil, README
 * "Vaulting"). A move that changes whether a subtree is veiled re-reads it (`subtree`), because
 * `moveAclPath` only re-paths `resource` entries.
 */
export const SEARCH_MODULE = "data-room";
/** 2: published Q&A (kind `qa`, E3.3) joined the rebuild. */
export const SEARCH_VERSION = 2;
/** Folders per page (title only). */
const PAGE = 500;
/**
 * Documents per page when bodies are read (≤ 200 000 characters each): bounds the text one page
 * holds in memory (~10 M characters) and how long a rebuild page holds the index lock.
 */
const DOC_PAGE = 50;

// C0 controls other than tab/newline/CR: extracted PDF text can carry them, and the engine uses
// \u0002/\u0003 as highlight delimiters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function cleanBody(text: string | null): string {
  if (text === null) return "";
  return text.replace(CONTROL, " ").slice(0, SEARCH_BODY_MAX);
}

export function documentEntry(row: DocumentSearchRow): SearchEntryInput {
  return {
    kind: "document",
    refId: row.id,
    title: row.title,
    body: cleanBody(row.body),
    // E3.5: inside a staff-only folder the entry is staff-only whatever the grants say.
    acl: row.staffOnly
      ? { kind: "staff" }
      : { kind: "resource", resourceKind: "document", resourceId: row.id, path: row.folderPath },
    href: `/data-room/documents/${row.id}`,
    updatedAt: row.updatedAt,
  };
}

/** Title-only; the root folder ("Data room") is the module itself and is not indexed. */
export function folderEntry(row: FolderSearchRow): SearchEntryInput | undefined {
  if (row.parentId === null) return undefined;
  return {
    kind: "folder",
    refId: row.id,
    title: row.name,
    acl: row.staffOnly
      ? { kind: "staff" }
      : { kind: "resource", resourceKind: "folder", resourceId: row.id, path: row.path },
    href: `/data-room/folders/${row.id}`,
    updatedAt: row.updatedAt,
  };
}

/**
 * One page of the full rebuild. Cursor: `f:<last folder id>` while folders remain (`f:` = from
 * the start), then `d:<last document id>`, then `q:<last question id>` (published Q&A on live
 * targets, E3.3); keyset by id, so pages stay correct while rows change.
 */
export async function searchPage(
  tx: Tx,
  ctx: TenantContext,
  cursor: string | null,
): Promise<SearchPage> {
  const repo = new SearchSourceRepo(ctx, tx);
  const c = cursor ?? "f:";
  const after = c.length > 2 ? c.slice(2) : undefined;
  if (c.startsWith("f:")) {
    const folders = await repo.folders({ afterId: after, limit: PAGE });
    const entries = folders.map(folderEntry).filter((e): e is SearchEntryInput => e !== undefined);
    const last = folders.at(-1)?.id;
    return { entries, next: folders.length < PAGE || last === undefined ? "d:" : `f:${last}` };
  }
  if (c.startsWith("q:")) {
    const qa = await qaSearchPage(tx, ctx, after);
    return { entries: qa.entries, next: qa.done || qa.last === undefined ? null : `q:${qa.last}` };
  }
  if (!c.startsWith("d:")) throw new Error(`data-room search: bad cursor ${JSON.stringify(c)}`);
  const docs = await repo.documents({ afterId: after, limit: DOC_PAGE });
  const last = docs.at(-1)?.id;
  return {
    entries: docs.map(documentEntry),
    next: docs.length < DOC_PAGE || last === undefined ? "q:" : `d:${last}`,
  };
}

async function* allEntries(tx: Tx, ctx: TenantContext): AsyncGenerator<SearchEntryInput> {
  let cursor: string | null = null;
  do {
    const page: SearchPage = await searchPage(tx, ctx, cursor);
    yield* page.entries;
    cursor = page.next;
  } while (cursor !== null);
}

/**
 * The manifest's full-rebuild source. The rebuild uses `page` (one short transaction per page, so
 * a large data room never blocks renames, moves or ingest while it is rebuilt); `entries` yields
 * the same thing in one pass.
 */
export const dataRoomSearch: ModuleSearch = {
  version: SEARCH_VERSION,
  entries: ({ tx, ctx }) => allEntries(tx, ctx),
  page: ({ tx, ctx, cursor }) => searchPage(tx, ctx, cursor),
};

export interface SearchIndexer {
  /** Re-reads the documents and upserts them, or removes the ones no longer live. */
  documents(tx: Tx, ctx: TenantContext, ids: readonly string[]): Promise<void>;
  /** Re-reads the folders and upserts them, or removes the ones no longer live. */
  folders(tx: Tx, ctx: TenantContext, ids: readonly string[]): Promise<void>;
  /**
   * Everything live under a folder path (the folder included), re-read and upserted: after a
   * restore, whose soft delete had removed the entries. Documents are read `DOC_PAGE` at a time.
   */
  subtree(tx: Tx, ctx: TenantContext, path: string): Promise<void>;
  /**
   * A subtree moved from `from` to `to`: re-paths the ACL of every entry under it in SQL. No
   * document is re-read — the text did not change, only the path RLS and authz check.
   */
  moved(tx: Tx, ctx: TenantContext, from: string, to: string): Promise<void>;
  /**
   * Unscanned files stopped being servable (`allowUnscanned` turned off): their text leaves the
   * index now, in the setting's transaction; titles stay.
   */
  unscannedTextOff(tx: Tx, ctx: TenantContext): Promise<void>;
  /** Drops entries by id without reading (hard deletes, subtree soft deletes). */
  remove(
    tx: Tx,
    ctx: TenantContext,
    kind: "document" | "folder",
    ids: readonly string[],
  ): Promise<void>;
}

export function createSearchIndexer(services: Pick<ModuleServices, "search">): SearchIndexer {
  const remove: SearchIndexer["remove"] = async (tx, ctx, kind, ids) => {
    for (const refId of ids) await services.search.remove(tx, ctx, SEARCH_MODULE, { kind, refId });
  };
  return {
    remove,
    async documents(tx, ctx, ids) {
      if (ids.length === 0) return;
      const rows = await new SearchSourceRepo(ctx, tx).documents({ ids });
      if (rows.length > 0)
        await services.search.upsert(tx, ctx, SEARCH_MODULE, rows.map(documentEntry));
      const live = new Set(rows.map((r) => r.id));
      await remove(
        tx,
        ctx,
        "document",
        ids.filter((id) => !live.has(id)),
      );
    },
    async folders(tx, ctx, ids) {
      if (ids.length === 0) return;
      const rows = await new SearchSourceRepo(ctx, tx).folders({ ids });
      const entries = rows.map(folderEntry).filter((e): e is SearchEntryInput => e !== undefined);
      if (entries.length > 0) await services.search.upsert(tx, ctx, SEARCH_MODULE, entries);
      const live = new Set(entries.map((e) => e.refId));
      await remove(
        tx,
        ctx,
        "folder",
        ids.filter((id) => !live.has(id)),
      );
    },
    async subtree(tx, ctx, path) {
      // Keyset pages: a large move stays a bounded number of bounded statements.
      const repo = new SearchSourceRepo(ctx, tx);
      let after: string | undefined;
      for (;;) {
        const folders = await repo.folders({ underPath: path, afterId: after, limit: PAGE });
        const entries = folders
          .map(folderEntry)
          .filter((e): e is SearchEntryInput => e !== undefined);
        if (entries.length > 0) await services.search.upsert(tx, ctx, SEARCH_MODULE, entries);
        if (folders.length < PAGE) break;
        after = folders.at(-1)?.id;
      }
      after = undefined;
      for (;;) {
        const docs = await repo.documents({ underPath: path, afterId: after, limit: DOC_PAGE });
        if (docs.length > 0)
          await services.search.upsert(tx, ctx, SEARCH_MODULE, docs.map(documentEntry));
        if (docs.length < DOC_PAGE) break;
        after = docs.at(-1)?.id;
      }
    },
    async moved(tx, ctx, from, to) {
      await services.search.moveAclPath(tx, ctx, SEARCH_MODULE, from, to);
    },
    async unscannedTextOff(tx, ctx) {
      const repo = new SearchSourceRepo(ctx, tx);
      let after: string | undefined;
      for (;;) {
        const ids = await repo.unscannedDocumentIds({ afterId: after, limit: PAGE });
        if (ids.length > 0)
          await services.search.clearBodies(tx, ctx, SEARCH_MODULE, "document", ids);
        if (ids.length < PAGE) break;
        after = ids.at(-1);
      }
    },
  };
}
