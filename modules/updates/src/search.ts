import type { TenantContext, Tx } from "@fundroom/db";
import { type PageDoc, sectionText, sectionTitle } from "@fundroom/module-content";
import type {
  ModuleSearch,
  ModuleServices,
  SearchAcl,
  SearchEntryInput,
} from "@fundroom/module-kit";
import {
  type Audience,
  DEFAULT_RULE,
  parseAudience,
  parseSectionRules,
  type SectionRule,
} from "./model.js";
import { PostRepo, VersionRepo } from "./repos/updates-repo.js";
import type { Post, PostVersion } from "./schema/updates.js";

/*
 * Workspace search for investor updates (E2.8). One entry per (sent post, section) of the
 * PUBLISHED version — what the web archive renders — and nothing for drafts, scheduled,
 * sending or archived posts, which the archive does not serve to investors either.
 *
 * Who may find a section is the intersection of two gates the archive applies in turn: the
 * post's audience (RLS `updates.audience_includes_current(post.audience)`, the live column) and
 * the section's rule in the published version's snapshot (`sectionVisible`). A section nobody
 * outside staff could read under both is still indexed, for staff (`acl: staff`); a section whose
 * two group lists do not meet is not indexed at all — no investor reads it, and staff find the
 * post through its other sections.
 *
 * Kept current on the caller's transaction by `indexPost` at every state change (send, the
 * delivery job's `sending → sent`, publish-to-archive, archive/unarchive, delete, an audience
 * edit of a sent post); `updatesSearch.entries` is the full rebuild.
 */
export const SEARCH_MODULE = "updates";
export const SEARCH_KIND = "post";
export const UPDATES_SEARCH_VERSION = 1;

/** `audience × section rule`; `null` when no reader passes both gates. */
export function aclFor(audience: Audience, rule: SectionRule): SearchAcl | null {
  if (rule.mode === "staff_only") return { kind: "staff" };
  if (audience.kind === "all") {
    return rule.mode === "groups"
      ? { kind: "groups", groupIds: [...rule.groupIds] }
      : { kind: "members" };
  }
  if (rule.mode === "authenticated") return { kind: "groups", groupIds: [...audience.groupIds] };
  const allowed = new Set(audience.groupIds);
  const both = [...new Set(rule.groupIds)].filter((g) => allowed.has(g));
  return both.length > 0 ? { kind: "groups", groupIds: both } : null;
}

/** The investor route of a post: `/updates/<slug>` (the archive resolves posts by slug). */
export function postHref(post: Pick<Post, "slug">): string {
  return `/updates/${post.slug}`;
}

/** Whether a post belongs in the index at all. */
export function isSearchable(
  post: Pick<Post, "state" | "publishedVersionId" | "deletedAt">,
): boolean {
  return post.deletedAt === null && post.state === "sent" && post.publishedVersionId !== null;
}

/** Entries for one sent post's published version. */
export function postSearchEntries(
  post: Pick<Post, "id" | "slug" | "audience">,
  version: Pick<PostVersion, "title" | "doc" | "visibility" | "createdAt">,
): SearchEntryInput[] {
  const audience = parseAudience(post.audience);
  const rules = parseSectionRules(version.visibility);
  const doc = version.doc as PageDoc | null;
  const href = postHref(post);
  const out: SearchEntryInput[] = [];
  for (const section of doc?.sections ?? []) {
    const acl = aclFor(audience, rules[section.key] ?? DEFAULT_RULE);
    if (acl === null) continue;
    out.push({
      kind: SEARCH_KIND,
      refId: post.id,
      part: section.key,
      title: sectionTitle(version.title, section),
      body: sectionText(section),
      acl,
      href,
      updatedAt: version.createdAt,
    });
  }
  return out;
}

/**
 * Brings one post's entries in line with the database on the caller's transaction. Pass the
 * row when the caller already holds it (e.g. the one a transition returned).
 */
export async function indexPost(
  services: Pick<ModuleServices, "search">,
  tx: Tx,
  ctx: TenantContext,
  postOrId: string | Post,
): Promise<void> {
  const post = typeof postOrId === "string" ? await new PostRepo(ctx, tx).live(postOrId) : postOrId;
  const postId = typeof postOrId === "string" ? postOrId : postOrId.id;
  const version =
    post !== undefined && isSearchable(post) && post.publishedVersionId !== null
      ? await new VersionRepo(ctx, tx).byId(post.publishedVersionId)
      : undefined;
  if (post === undefined || version === undefined || !isSearchable(post)) {
    await services.search.remove(tx, ctx, SEARCH_MODULE, { kind: SEARCH_KIND, refId: postId });
    return;
  }
  await services.search.replace(
    tx,
    ctx,
    SEARCH_MODULE,
    SEARCH_KIND,
    postId,
    postSearchEntries(post, version),
  );
}

/** Full rebuild: every live sent post of `ctx.workspaceId`. */
export const updatesSearch: ModuleSearch = {
  version: UPDATES_SEARCH_VERSION,
  async entries({ tx, ctx }) {
    const out: SearchEntryInput[] = [];
    const versions = new VersionRepo(ctx, tx);
    for (const post of await new PostRepo(ctx, tx).archive()) {
      if (!isSearchable(post) || post.publishedVersionId === null) continue;
      const version = await versions.byId(post.publishedVersionId);
      if (version !== undefined) out.push(...postSearchEntries(post, version));
    }
    return out;
  },
};
