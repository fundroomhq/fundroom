import type { TenantContext, Tx } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { ModuleServices, SearchEntryInput } from "@fundroom/module-kit";
import { QaLifecycleRepo, type QaSearchRow } from "../repos/qa-lifecycle-repo.js";
import { QaQuestionRepo } from "../repos/qa-repo.js";

/*
 * Q&A in workspace search (E3.3 D7). One entry per `published` question whose target is live,
 * while `settings.dataRoom.qa.enabled` is on: kind `qa` in module `data-room`, body = public
 * wording + the answer. The ACL is the target's own resource ACL (a document is checked at its
 * folder's path, a folder at its own), so exactly the people who can view the target find the
 * answer — and a folder move re-paths these entries with everything else under the folder
 * (`indexer.moved` → `moveAclPath` for the module). The asker's identity and original words
 * never reach the index.
 *
 * The TITLE is the target's own title (document title / folder name), never Q&A text: a gated
 * caller (NDA pending) gets `resource` hits judged by their title alone (packages/search), so a
 * title carrying the question would let them search the Q&A word by word. With the target's
 * title a gated `qa` hit says no more than the gated target's own hit. Target renames re-index
 * (`documentsBack` / `foldersBack`).
 *
 * Q&A switched off: every write path removes instead of upserting, and the rebuild yields no
 * Q&A — the settings PATCH that flips `qa.enabled` requests a rebuild (`requestReindex`), which
 * drops or restores the entries. Switching off also drops them in the PATCH transaction itself
 * (`unindexAllQuestions`), so no answer stays findable until the rebuild runs.
 */
export const QA_SEARCH_KIND = "qa";
// Kept literal (not imported from ../service/search.ts) so that file can import this one.
const MODULE = "data-room";
const PAGE = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function qaEntry(row: QaSearchRow): SearchEntryInput {
  const body = row.answerBody === null ? row.publicText : `${row.publicText}\n\n${row.answerBody}`;
  return {
    kind: QA_SEARCH_KIND,
    refId: row.id,
    // Non-secret on purpose (see above): gated callers match on the title alone.
    title: row.targetTitle.slice(0, 200),
    body: body.replace(CONTROL, " "),
    // E3.5: a target under a staff-only folder is staff-only, and so is its Q&A.
    acl: row.staffOnly
      ? { kind: "staff" }
      : {
          kind: "resource",
          resourceKind: row.targetKind,
          resourceId: row.targetId,
          path: row.path,
        },
    href: `/data-room/questions/${row.id}`,
    updatedAt: row.updatedAt,
  };
}

type SearchServices = Pick<ModuleServices, "search">;

/**
 * Whether Q&A belongs in the index now (`settings.dataRoom.qa.enabled`), read on `tx`. `lock`
 * row-locks the workspace (FOR NO KEY UPDATE — the global order's workspace row, which this
 * transaction's audit would take anyway) so a concurrent PATCH flipping the switch serialises
 * with this write (use it on write transactions); `none` for read-only ones (the rebuild's pages).
 */
export async function qaSearchEnabled(
  tx: Tx,
  ctx: TenantContext,
  lock: "lock" | "none" = "lock",
): Promise<boolean> {
  const settings = await new QaLifecycleRepo(ctx, tx).workspaceSettings(lock);
  return parseWorkspaceSettings(settings).dataRoom.qa.enabled;
}

async function upsertOrRemove(
  services: SearchServices,
  tx: Tx,
  ctx: TenantContext,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = (await qaSearchEnabled(tx, ctx))
    ? await new QaLifecycleRepo(ctx, tx).searchRows({ ids })
    : [];
  if (rows.length > 0) await services.search.upsert(tx, ctx, MODULE, rows.map(qaEntry));
  const live = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!live.has(id))
      await services.search.remove(tx, ctx, MODULE, { kind: QA_SEARCH_KIND, refId: id });
  }
}

/**
 * Re-reads one question on the caller's transaction: upserts its entry when it is `published`
 * on a live target and Q&A is on, removes it otherwise. Call after any write that changes whether or what it
 * shows (release, unpublish, answer edit, public text edit, close, erasure).
 */
export async function indexQuestion(
  services: SearchServices,
  tx: Tx,
  ctx: TenantContext,
  questionId: string,
): Promise<void> {
  await upsertOrRemove(services, tx, ctx, [questionId]);
}

/** Drops one question's entry without reading it (e.g. before a hard delete). */
export async function unindexQuestion(
  services: SearchServices,
  tx: Tx,
  ctx: TenantContext,
  questionId: string,
): Promise<void> {
  await services.search.remove(tx, ctx, MODULE, { kind: QA_SEARCH_KIND, refId: questionId });
}

/**
 * Q&A was switched off: every Q&A entry of the workspace leaves the index on the caller's
 * transaction (the settings PATCH), so there is no window until the requested rebuild runs.
 * Only `published` questions ever have an entry.
 */
export async function unindexAllQuestions(
  services: SearchServices,
  tx: Tx,
  ctx: TenantContext,
): Promise<void> {
  const ids = await new QaQuestionRepo(ctx, tx).publishedIds();
  for (const id of ids) await unindexQuestion(services, tx, ctx, id);
}

/** `indexQuestion` for several at once. */
export async function indexQuestions(
  services: SearchServices,
  tx: Tx,
  ctx: TenantContext,
  ids: readonly string[],
): Promise<void> {
  await upsertOrRemove(services, tx, ctx, ids);
}

/** Target hooks called by the document / folder services on trash, restore and purge. */
export interface QaTargetIndexer {
  /** Documents left the tree (trash or purge): their published questions leave the index. */
  documentsGone(tx: Tx, ctx: TenantContext, documentIds: readonly string[]): Promise<void>;
  /** Documents came back (restore), moved folder or were renamed: their questions are re-read. */
  documentsBack(tx: Tx, ctx: TenantContext, documentIds: readonly string[]): Promise<void>;
  /** Folders were renamed: the published questions on them are re-read (the entry title). */
  foldersBack(tx: Tx, ctx: TenantContext, folderIds: readonly string[]): Promise<void>;
  /** A folder subtree was trashed: every published question on a target under it leaves. */
  subtreeGone(tx: Tx, ctx: TenantContext, path: string): Promise<void>;
  /** A folder subtree was restored: every published question on a live target under it returns. */
  subtreeBack(tx: Tx, ctx: TenantContext, path: string): Promise<void>;
}

export function createQaTargetIndexer(services: SearchServices): QaTargetIndexer {
  const drop = async (tx: Tx, ctx: TenantContext, ids: readonly string[]) => {
    for (const id of ids) await unindexQuestion(services, tx, ctx, id);
  };
  return {
    async documentsGone(tx, ctx, documentIds) {
      if (documentIds.length === 0) return;
      const ids = await new QaLifecycleRepo(ctx, tx).publishedIdsOnTargets({ documentIds });
      await drop(tx, ctx, ids);
    },
    async documentsBack(tx, ctx, documentIds) {
      if (documentIds.length === 0 || !(await qaSearchEnabled(tx, ctx))) return;
      const rows = await new QaLifecycleRepo(ctx, tx).searchRows({ documentIds });
      if (rows.length > 0) await services.search.upsert(tx, ctx, MODULE, rows.map(qaEntry));
    },
    async foldersBack(tx, ctx, folderIds) {
      if (folderIds.length === 0 || !(await qaSearchEnabled(tx, ctx))) return;
      const rows = await new QaLifecycleRepo(ctx, tx).searchRows({ folderIds });
      if (rows.length > 0) await services.search.upsert(tx, ctx, MODULE, rows.map(qaEntry));
    },
    async subtreeGone(tx, ctx, path) {
      const ids = await new QaLifecycleRepo(ctx, tx).publishedIdsOnTargets({ underPath: path });
      await drop(tx, ctx, ids);
    },
    async subtreeBack(tx, ctx, path) {
      if (!(await qaSearchEnabled(tx, ctx))) return;
      const repo = new QaLifecycleRepo(ctx, tx);
      let after: string | undefined;
      for (;;) {
        const rows = await repo.searchRows({ underPath: path, afterId: after, limit: PAGE });
        if (rows.length > 0) await services.search.upsert(tx, ctx, MODULE, rows.map(qaEntry));
        if (rows.length < PAGE) break;
        after = rows.at(-1)?.id;
      }
    },
  };
}

/** One page of the full rebuild's Q&A part, keyset by question id; none while Q&A is off. */
export async function qaSearchPage(
  tx: Tx,
  ctx: TenantContext,
  afterId: string | undefined,
): Promise<{ entries: SearchEntryInput[]; last: string | undefined; done: boolean }> {
  if (!(await qaSearchEnabled(tx, ctx, "none")))
    return { entries: [], last: undefined, done: true };
  const rows = await new QaLifecycleRepo(ctx, tx).searchRows({ afterId, limit: PAGE });
  return { entries: rows.map(qaEntry), last: rows.at(-1)?.id, done: rows.length < PAGE };
}
