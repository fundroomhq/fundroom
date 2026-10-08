import type { TenantContext, Tx } from "@fundroom/db";
import { markdownToText } from "@fundroom/markdown";
import type {
  ModuleSearch,
  ModuleServices,
  SearchAcl,
  SearchEntryInput,
} from "@fundroom/module-kit";
import type { Block, PageDoc, Section } from "./blocks.js";
import { PageRepo, RevisionRepo } from "./repos/content-repo.js";
import type { Page, PageRevision } from "./schema/content.js";
import { parseVisibilityMap, ruleFor, type VisibilityRule } from "./visibility.js";

/*
 * Workspace search for the overview pages (E2.8). One entry per (published page, section):
 * the text of the section's *static* blocks in the PUBLISHED revision, guarded by the
 * section's rule in that revision's visibility snapshot — the same pair an investor's render
 * reads, so search can never find a word the page would not show them.
 *
 * Reference blocks (`metric_grid`, `document_list`, `disclaimer`, `round_summary`) are skipped:
 * their content belongs to another module (or to the legal library), is hydrated per viewer at
 * render time, and is indexed — if at all — by its owner under its own ACL.
 *
 * Kept current at write time on the caller's transaction (`indexPage` from publish, rename and
 * delete); `contentSearch.entries` is the full rebuild.
 */
export const SEARCH_MODULE = "content";
export const SEARCH_KIND = "page";
/** Bump to reindex every workspace after a change to what is extracted. */
export const CONTENT_SEARCH_VERSION = 1;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** Plain text of one block; "" for reference blocks and anything unreadable. */
export function blockText(block: Pick<Block, "type" | "data">): string {
  const d = (block.data ?? {}) as Record<string, unknown>;
  const parts: (string | undefined)[] = [];
  switch (block.type) {
    case "hero":
      parts.push(str(d["heading"]), str(d["subheading"]));
      break;
    case "rich_text": {
      const text = str(d["text"]);
      if (text !== undefined) parts.push(markdownToText(text));
      break;
    }
    case "team":
      for (const m of Array.isArray(d["members"]) ? d["members"] : []) {
        const member = (m ?? {}) as Record<string, unknown>;
        parts.push(str(member["name"]), str(member["title"]), str(member["bio"]));
      }
      break;
    case "faq":
      for (const i of Array.isArray(d["items"]) ? d["items"] : []) {
        const item = (i ?? {}) as Record<string, unknown>;
        parts.push(str(item["question"]), str(item["answer"]));
      }
      break;
    case "embed":
      parts.push(str(d["title"]));
      break;
    default:
      // metric_grid, document_list, disclaimer, round_summary: hydrated from elsewhere.
      break;
  }
  return parts.filter((p): p is string => p !== undefined && p.length > 0).join("\n");
}

/** Plain text of a section's static blocks, one block per paragraph. */
export function sectionText(section: Pick<Section, "blocks">): string {
  return section.blocks
    .map(blockText)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** Search title of a section: the document title, then the section heading when it has one. */
export function sectionTitle(docTitle: string, section: Pick<Section, "title">): string {
  const heading = section.title?.trim();
  return heading ? `${docTitle} — ${heading}` : docTitle;
}

/**
 * Who may find a section. Search is a signed-in feature, so `public` and `authenticated` both
 * mean "any live member"; staff see every entry regardless of its ACL.
 */
export function aclForRule(rule: VisibilityRule): SearchAcl {
  switch (rule.mode) {
    case "public":
    case "authenticated":
      return { kind: "members" };
    case "groups":
      return { kind: "groups", groupIds: [...rule.groupIds] };
    case "staff_only":
      return { kind: "staff" };
  }
}

/** The portal route that renders a page. */
export function pageHref(page: Pick<Page, "kind" | "slug">): string {
  return page.kind === "home" ? "/" : `/p/${page.slug}`;
}

/** Entries for one page's published revision. */
export function pageSearchEntries(
  page: Pick<Page, "id" | "kind" | "slug" | "title">,
  revision: Pick<PageRevision, "doc" | "visibility" | "publishedAt" | "createdAt">,
): SearchEntryInput[] {
  const doc = revision.doc as PageDoc | null;
  const visibility = parseVisibilityMap(revision.visibility);
  const href = pageHref(page);
  const updatedAt = revision.publishedAt ?? revision.createdAt;
  return (doc?.sections ?? []).map((section) => ({
    kind: SEARCH_KIND,
    refId: page.id,
    part: section.key,
    title: sectionTitle(page.title, section),
    body: sectionText(section),
    acl: aclForRule(ruleFor(visibility, section.key)),
    href,
    updatedAt,
  }));
}

/**
 * Brings one page's entries in line with the database, on the caller's transaction: its
 * published revision's sections when it is live and published, nothing otherwise.
 */
export async function indexPage(
  services: Pick<ModuleServices, "search">,
  tx: Tx,
  ctx: TenantContext,
  pageId: string,
): Promise<void> {
  const page = await new PageRepo(ctx, tx).byId(pageId);
  const revision =
    page !== undefined && page.deletedAt === null && page.publishedRevisionId !== null
      ? await new RevisionRepo(ctx, tx).byId(page.publishedRevisionId)
      : undefined;
  if (page === undefined || revision === undefined || page.deletedAt !== null) {
    await services.search.remove(tx, ctx, SEARCH_MODULE, { kind: SEARCH_KIND, refId: pageId });
    return;
  }
  await services.search.replace(
    tx,
    ctx,
    SEARCH_MODULE,
    SEARCH_KIND,
    pageId,
    pageSearchEntries(page, revision),
  );
}

/** Full rebuild: every live, published page of `ctx.workspaceId`. */
export const contentSearch: ModuleSearch = {
  version: CONTENT_SEARCH_VERSION,
  async entries({ tx, ctx }) {
    const out: SearchEntryInput[] = [];
    const revisions = new RevisionRepo(ctx, tx);
    for (const page of await new PageRepo(ctx, tx).list()) {
      if (page.publishedRevisionId === null) continue;
      const revision = await revisions.byId(page.publishedRevisionId);
      if (revision !== undefined) out.push(...pageSearchEntries(page, revision));
    }
    return out;
  },
};
