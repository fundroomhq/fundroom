import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq } from "drizzle-orm";
import { page, pageRevision, sectionVisibility } from "../schema/content.js";

const CAP = 10_000;

/**
 * Content holds no data about investors — pages are the company's. What it holds about a (staff)
 * member is authorship: pages, revisions and visibility rules they created or last changed
 * (E2.7 DSAR export; see `../dsar.ts`).
 */
export async function readMemberContent(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const ws = ctx.workspaceId;
  const pages = await tx
    .select({ id: page.id, slug: page.slug, createdAt: page.createdAt })
    .from(page)
    .where(and(eq(page.workspaceId, ws), eq(page.createdBy, membershipId)))
    .orderBy(asc(page.createdAt), asc(page.id))
    .limit(CAP);
  const revisions = await tx
    .select({
      id: pageRevision.id,
      pageId: pageRevision.pageId,
      revisionNo: pageRevision.revisionNo,
      createdAt: pageRevision.createdAt,
      publishedAt: pageRevision.publishedAt,
    })
    .from(pageRevision)
    .where(and(eq(pageRevision.workspaceId, ws), eq(pageRevision.createdBy, membershipId)))
    .orderBy(asc(pageRevision.createdAt), asc(pageRevision.id))
    .limit(CAP);
  const rules = await tx
    .select({
      pageId: sectionVisibility.pageId,
      sectionKey: sectionVisibility.sectionKey,
      updatedAt: sectionVisibility.updatedAt,
    })
    .from(sectionVisibility)
    .where(
      and(eq(sectionVisibility.workspaceId, ws), eq(sectionVisibility.updatedBy, membershipId)),
    )
    .orderBy(asc(sectionVisibility.updatedAt), asc(sectionVisibility.pageId))
    .limit(CAP);
  return {
    version: 1,
    heldAboutMember: false,
    note: "Pages are the company's content; this lists only what the member created or last changed.",
    authored: {
      pages: pages.map((r) => dsarRow(r)),
      revisions: revisions.map((r) => dsarRow(r)),
      visibilityRules: rules.map((r) => dsarRow(r)),
    },
  };
}
