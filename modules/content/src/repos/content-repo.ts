import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type NewPage,
  type NewPageRevision,
  type Page,
  type PageRevision,
  page,
  pageRevision,
  type SectionVisibilityRow,
  sectionVisibility,
} from "../schema/content.js";

/*
 * Repositories over `content.*` (design/06 §3: the only place drizzle is touched in this
 * module). Reads carry the workspace fence explicitly on top of RLS; writes force it.
 */
export class PageRepo extends TenantRepo<typeof page> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(page, ctx, tx);
  }

  byId(id: string): Promise<Page | undefined> {
    return this.findById(id);
  }

  async live(id: string): Promise<Page | undefined> {
    const rows = await this.findMany(and(eq(page.id, id), isNull(page.deletedAt)));
    return rows[0];
  }

  async bySlug(slug: string): Promise<Page | undefined> {
    const rows = await this.findMany(and(eq(page.slug, slug), isNull(page.deletedAt)));
    return rows[0];
  }

  async home(): Promise<Page | undefined> {
    const rows = await this.findMany(and(eq(page.kind, "home"), isNull(page.deletedAt)));
    return rows[0];
  }

  async list(): Promise<Page[]> {
    const rows = await this.tx
      .select()
      .from(page)
      .where(this.scope(isNull(page.deletedAt)))
      .orderBy(sql`${page.kind} = 'home' DESC`, page.title);
    return rows;
  }

  create(values: Omit<NewPage, "workspaceId">): Promise<Page> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Page, "title" | "slug" | "publishedRevisionId" | "draftRevisionId" | "deletedAt">
    >,
  ): Promise<Page | undefined> {
    const rows = await this.tx
      .update(page)
      .set(patch)
      .where(this.scope(eq(page.id, id)))
      .returning();
    return rows[0];
  }
}

export class RevisionRepo extends TenantRepo<typeof pageRevision> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pageRevision, ctx, tx);
  }

  byId(id: string): Promise<PageRevision | undefined> {
    return this.findById(id);
  }

  async forPage(pageId: string, revisionId: string): Promise<PageRevision | undefined> {
    const rows = await this.findMany(
      and(eq(pageRevision.pageId, pageId), eq(pageRevision.id, revisionId)),
    );
    return rows[0];
  }

  async listForPage(pageId: string): Promise<PageRevision[]> {
    return this.tx
      .select()
      .from(pageRevision)
      .where(this.scope(eq(pageRevision.pageId, pageId)))
      .orderBy(desc(pageRevision.revisionNo));
  }

  async nextRevisionNo(pageId: string): Promise<number> {
    const rows = await this.tx
      .select({ max: sql<number | null>`max(${pageRevision.revisionNo})` })
      .from(pageRevision)
      .where(this.scope(eq(pageRevision.pageId, pageId)));
    return (rows[0]?.max ?? 0) + 1;
  }

  create(values: Omit<NewPageRevision, "workspaceId">): Promise<PageRevision> {
    return this.insertOne(values);
  }

  /** Only the draft row (`published_at IS NULL`) accepts updates; the trigger enforces it too. */
  async saveDraft(
    id: string,
    values: { doc: unknown; savedAt: Date; createdBy?: string | null | undefined },
  ): Promise<PageRevision | undefined> {
    const rows = await this.tx
      .update(pageRevision)
      .set({
        doc: values.doc,
        savedAt: values.savedAt,
        ...(values.createdBy === undefined ? {} : { createdBy: values.createdBy }),
      })
      .where(this.scope(and(eq(pageRevision.id, id), isNull(pageRevision.publishedAt))))
      .returning();
    return rows[0];
  }
}

export class VisibilityRepo extends TenantRepo<typeof sectionVisibility> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(sectionVisibility, ctx, tx);
  }

  async forPage(pageId: string): Promise<SectionVisibilityRow[]> {
    return this.findMany(eq(sectionVisibility.pageId, pageId));
  }

  /** Replaces every rule of the page in one go (rules are few; a diff buys nothing). */
  async replace(
    pageId: string,
    rules: Readonly<Record<string, unknown>>,
    updatedBy: string | null,
    now: Date,
  ): Promise<void> {
    await this.tx.delete(sectionVisibility).where(this.scope(eq(sectionVisibility.pageId, pageId)));
    const entries = Object.entries(rules);
    if (entries.length === 0) return;
    await this.tx.insert(sectionVisibility).values(
      entries.map(([sectionKey, rule]) => ({
        workspaceId: this.ctx.workspaceId,
        pageId,
        sectionKey,
        rule,
        updatedBy,
        updatedAt: now,
      })),
    );
  }
}
