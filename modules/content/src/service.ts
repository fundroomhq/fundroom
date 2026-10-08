import { pgErrorCode, systemContext, type TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { GroupRepo } from "@fundroom/identity";
import type { BlockViewer, ModuleServices } from "@fundroom/module-kit";
import type { RequestFacts } from "@fundroom/ports";
import { DOC_SCHEMA_VERSION, type PageDoc, validateDoc } from "./blocks.js";
import { type RenderedSection, renderSections, visibleSectionKeys } from "./render.js";
import { PageRepo, RevisionRepo, VisibilityRepo } from "./repos/content-repo.js";
import type { Page, PageKind, PageRevision } from "./schema/content.js";
import { indexPage } from "./search.js";
import { homeTemplate } from "./template.js";
import {
  DEFAULT_RULE,
  parseVisibilityMap,
  VISIBILITY_SCHEMA_VERSION,
  type VisibilityMap,
  VisibilityMapSchema,
} from "./visibility.js";

/*
 * The content service (E1.2, ADR-0033): page lifecycle (template → draft → publish →
 * revisions), section visibility with the public-sections guard, and the two read paths
 * (investor render of the published revision; staff preview of the draft as an audience).
 * Every write audits; publishing also puts `page.published` on the outbox.
 */
export class ContentError extends Error {
  override readonly name = "ContentError";
  constructor(
    readonly code: "not_found" | "conflict" | "validation_failed" | "forbidden",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface Actor {
  readonly membershipId: string;
  readonly requestId?: string | undefined;
}

export interface PageSummary {
  readonly id: string;
  readonly slug: string;
  readonly kind: PageKind;
  readonly title: string;
  readonly publishedRevisionNo: number | null;
  readonly publishedAt: Date | null;
  readonly draftSavedAt: Date | null;
  /** The draft differs from the published revision (or nothing is published yet). */
  readonly draftDirty: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PageDetail {
  readonly page: PageSummary;
  readonly draft: { readonly revisionId: string; readonly doc: PageDoc; readonly savedAt: Date };
  readonly visibility: VisibilityMap;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

export interface RevisionSummary {
  readonly id: string;
  readonly revisionNo: number;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
  readonly createdBy: string | null;
  readonly note: string | null;
  /** `<slug>:v<n>` of the disclaimer stamped onto this revision when it was published (E1.6). */
  readonly disclaimerVersion: string | null;
  readonly isCurrent: boolean;
  readonly isDraft: boolean;
}

export interface RenderedPage {
  readonly page: {
    readonly id: string;
    readonly slug: string;
    readonly kind: PageKind;
    readonly title: string;
  };
  readonly revision: {
    readonly id: string;
    readonly revisionNo: number;
    readonly publishedAt: Date | null;
  };
  readonly sections: readonly RenderedSection[];
  readonly viewer: BlockViewer["kind"];
  readonly preview: boolean;
}

export interface RenderInput {
  readonly tenant: TenantContext;
  readonly viewer: BlockViewer;
  readonly allowPublic: boolean;
  readonly facts: RequestFacts;
  readonly enabledModules: ReadonlySet<string>;
}

export interface ContentService {
  /** Creates and publishes the template home page when the workspace has none. Idempotent. */
  ensureHome(workspaceId: string, workspaceName: string): Promise<Page>;
  list(ctx: TenantContext): Promise<PageSummary[]>;
  get(ctx: TenantContext, id: string): Promise<PageDetail | undefined>;
  create(
    ctx: TenantContext,
    input: { slug: string; title: string },
    actor: Actor,
  ): Promise<PageDetail>;
  update(
    ctx: TenantContext,
    id: string,
    input: { title?: string | undefined; slug?: string | undefined },
    actor: Actor,
  ): Promise<PageDetail>;
  saveDraft(
    ctx: TenantContext,
    id: string,
    input: { doc: unknown; baseSavedAt?: Date | undefined },
    actor: Actor,
  ): Promise<PageDetail>;
  setVisibility(
    ctx: TenantContext,
    id: string,
    rules: unknown,
    actor: Actor,
    options: { allowPublic: boolean },
  ): Promise<PageDetail>;
  publish(
    ctx: TenantContext,
    id: string,
    input: { note?: string | undefined },
    actor: Actor,
  ): Promise<PageDetail>;
  restore(ctx: TenantContext, id: string, revisionId: string, actor: Actor): Promise<PageDetail>;
  revisions(ctx: TenantContext, id: string): Promise<RevisionSummary[]>;
  revision(
    ctx: TenantContext,
    id: string,
    revisionId: string,
  ): Promise<{ summary: RevisionSummary; doc: PageDoc; visibility: VisibilityMap } | undefined>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
  /** The published page for a viewer; `undefined` when there is no such published page. */
  render(slug: string, input: RenderInput): Promise<RenderedPage | undefined>;
  /** The draft rendered as an audience (staff only; `ctx` is the staff context). */
  preview(id: string, input: RenderInput): Promise<RenderedPage | undefined>;
  /** Live group ids of a membership, for the investor viewer. */
  groupIdsOf(ctx: TenantContext, membershipId: string): Promise<string[]>;
}

const sameDoc = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createContentService(services: ModuleServices): ContentService {
  const { db } = services;
  const now = () => services.now();

  function summary(
    p: Page,
    published: PageRevision | undefined,
    draft: PageRevision | undefined,
  ): PageSummary {
    return {
      id: p.id,
      slug: p.slug,
      kind: p.kind,
      title: p.title,
      publishedRevisionNo: published?.revisionNo ?? null,
      publishedAt: published?.publishedAt ?? null,
      draftSavedAt: draft?.savedAt ?? null,
      draftDirty:
        published === undefined || draft === undefined || !sameDoc(published.doc, draft.doc),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  async function loadDetail(
    ctx: TenantContext,
    tx: Parameters<Parameters<typeof db.withTenant>[1]>[0],
    p: Page,
  ): Promise<PageDetail> {
    const revisions = new RevisionRepo(ctx, tx);
    const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
    const published = p.publishedRevisionId
      ? await revisions.byId(p.publishedRevisionId)
      : undefined;
    if (draft === undefined) throw new Error(`page ${p.id} has no draft revision`);
    const rows = await new VisibilityRepo(ctx, tx).forPage(p.id);
    const visibility = parseVisibilityMap(
      Object.fromEntries(rows.map((r) => [r.sectionKey, r.rule])),
    );
    const groups = await new GroupRepo(ctx, tx).list();
    return {
      page: summary(p, published, draft),
      draft: { revisionId: draft.id, doc: draft.doc as PageDoc, savedAt: draft.savedAt },
      visibility,
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  async function livePage(
    ctx: TenantContext,
    tx: Parameters<Parameters<typeof db.withTenant>[1]>[0],
    id: string,
  ): Promise<Page> {
    const p = await new PageRepo(ctx, tx).live(id);
    if (p === undefined) throw new ContentError("not_found", "no such page");
    return p;
  }

  /** Inserts page + draft (+ published) rows; `publishedAt` set publishes revision 1 at once. */
  async function createPage(
    ctx: TenantContext,
    tx: Parameters<Parameters<typeof db.withTenant>[1]>[0],
    input: {
      slug: string;
      kind: PageKind;
      title: string;
      doc: PageDoc;
      visibility: VisibilityMap;
      publish: boolean;
      createdBy: string | null;
    },
  ): Promise<Page> {
    const pages = new PageRepo(ctx, tx);
    const revisions = new RevisionRepo(ctx, tx);
    const t = now();
    const p = await pages.create({
      slug: input.slug,
      kind: input.kind,
      title: input.title,
      createdBy: input.createdBy,
    });
    const draft = await revisions.create({
      pageId: p.id,
      revisionNo: 0,
      doc: input.doc,
      docSchemaVersion: DOC_SCHEMA_VERSION,
      createdBy: input.createdBy,
      createdAt: t,
      savedAt: t,
    });
    let publishedId: string | null = null;
    if (input.publish) {
      const published = await revisions.create({
        pageId: p.id,
        revisionNo: 1,
        doc: input.doc,
        docSchemaVersion: DOC_SCHEMA_VERSION,
        visibility: input.visibility,
        visibilitySchemaVersion: VISIBILITY_SCHEMA_VERSION,
        createdBy: input.createdBy,
        createdAt: t,
        savedAt: t,
        publishedAt: t,
        note: "Initial page",
      });
      publishedId = published.id;
    }
    await new VisibilityRepo(ctx, tx).replace(p.id, input.visibility, input.createdBy, t);
    const updated = await pages.update(p.id, {
      draftRevisionId: draft.id,
      publishedRevisionId: publishedId,
    });
    if (updated === undefined) throw new Error("page vanished during creation");
    return updated;
  }

  function audit(
    tx: Parameters<Parameters<typeof db.withTenant>[1]>[0],
    ctx: TenantContext,
    actor: Actor,
    action: string,
    pageId: string,
    meta: Record<string, string | number | boolean | null | string[]> = {},
  ) {
    return services.audit.record(tx, ctx, {
      action,
      resourceKind: "page",
      resourceId: pageId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      meta,
    });
  }

  async function renderRevision(
    input: RenderInput,
    p: Page,
    rev: PageRevision,
    visibility: VisibilityMap,
    preview: boolean,
  ): Promise<RenderedPage> {
    const doc = rev.doc as PageDoc;
    const sections = await renderSections({
      doc,
      visibility,
      viewer: input.viewer,
      allowPublic: input.allowPublic,
      hydrators: services.registry.blockHydrators,
      enabledModules: input.enabledModules,
      context: { tenant: input.tenant, viewer: input.viewer, facts: input.facts },
      log: services.log,
    });
    return {
      page: { id: p.id, slug: p.slug, kind: p.kind, title: p.title },
      revision: { id: rev.id, revisionNo: rev.revisionNo, publishedAt: rev.publishedAt },
      sections,
      viewer: input.viewer.kind,
      preview,
    };
  }

  return {
    async ensureHome(workspaceId, workspaceName) {
      const ctx = systemContext(workspaceId);
      const existing = await db.withTenant(ctx, (tx) => new PageRepo(ctx, tx).home());
      if (existing !== undefined) return existing;
      try {
        return await db.withTenant(ctx, async (tx) => {
          const t = homeTemplate(workspaceName);
          const p = await createPage(ctx, tx, {
            slug: "home",
            kind: "home",
            title: "Overview",
            doc: t.doc,
            visibility: t.visibility,
            publish: true,
            createdBy: null,
          });
          await services.audit.record(tx, ctx, {
            action: "page.created",
            resourceKind: "page",
            resourceId: p.id,
            meta: { kind: "home", source: "template" },
          });
          // Revision 1 is published at birth, so it is searchable at birth.
          await indexPage(services, tx, ctx, p.id);
          services.log("content.home_seeded", { workspaceId });
          return p;
        });
      } catch (error) {
        // Two first requests raced; the unique home index decided. Re-read the winner.
        if (pgErrorCode(error) !== "23505") throw error;
        const again = await db.withTenant(ctx, (tx) => new PageRepo(ctx, tx).home());
        if (again === undefined) throw error;
        return again;
      }
    },

    list: (ctx) =>
      db.withTenant(ctx, async (tx) => {
        const pages = await new PageRepo(ctx, tx).list();
        const revisions = new RevisionRepo(ctx, tx);
        const out: PageSummary[] = [];
        for (const p of pages) {
          const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
          const published = p.publishedRevisionId
            ? await revisions.byId(p.publishedRevisionId)
            : undefined;
          out.push(summary(p, published, draft));
        }
        return out;
      }),

    get: (ctx, id) =>
      db.withTenant(ctx, async (tx) => {
        const p = await new PageRepo(ctx, tx).live(id);
        return p === undefined ? undefined : loadDetail(ctx, tx, p);
      }),

    create: (ctx, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        if (input.slug === "home") throw new ContentError("conflict", "that slug is reserved");
        if ((await new PageRepo(ctx, tx).bySlug(input.slug)) !== undefined)
          throw new ContentError("conflict", "a page with that slug exists", { conflict: "slug" });
        let p: Page;
        try {
          p = await createPage(ctx, tx, {
            slug: input.slug,
            kind: "custom",
            title: input.title,
            doc: { sections: [] },
            visibility: {},
            publish: false,
            createdBy: actor.membershipId,
          });
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new ContentError("conflict", "a page with that slug exists", {
              conflict: "slug",
            });
          throw error;
        }
        await audit(tx, ctx, actor, "page.created", p.id, { kind: "custom", slug: p.slug });
        return loadDetail(ctx, tx, p);
      }),

    update: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const pages = new PageRepo(ctx, tx);
        const p = await livePage(ctx, tx, id);
        if (input.slug !== undefined && input.slug !== p.slug) {
          if (p.kind === "home") throw new ContentError("conflict", "the home page keeps its slug");
          if (input.slug === "home" || (await pages.bySlug(input.slug)) !== undefined)
            throw new ContentError("conflict", "a page with that slug exists", {
              conflict: "slug",
            });
        }
        let updated: Page | undefined;
        try {
          updated = await pages.update(id, {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.slug === undefined || p.kind === "home" ? {} : { slug: input.slug }),
          });
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new ContentError("conflict", "a page with that slug exists", {
              conflict: "slug",
            });
          throw error;
        }
        if (updated === undefined) throw new ContentError("not_found", "no such page");
        await audit(tx, ctx, actor, "page.updated", id, { fields: Object.keys(input) });
        // A rename changes every hit's title (and a new slug its href) — only if anything is live.
        if (updated.publishedRevisionId !== null) await indexPage(services, tx, ctx, id);
        return loadDetail(ctx, tx, updated);
      }),

    saveDraft: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const revisions = new RevisionRepo(ctx, tx);
        const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
        if (draft === undefined) throw new Error(`page ${id} has no draft revision`);
        if (
          input.baseSavedAt !== undefined &&
          draft.savedAt.getTime() !== input.baseSavedAt.getTime()
        ) {
          throw new ContentError("conflict", "the draft changed since you loaded it", {
            conflict: "draft",
            savedAt: draft.savedAt.toISOString(),
          });
        }
        const doc = validateDoc(input.doc);
        const t = now();
        const saved = await revisions.saveDraft(draft.id, {
          doc,
          savedAt: t,
          createdBy: actor.membershipId,
        });
        if (saved === undefined)
          throw new ContentError("conflict", "the draft is no longer editable");
        // Sections that no longer exist drop their rules; new ones get the default.
        const vis = new VisibilityRepo(ctx, tx);
        const current = parseVisibilityMap(
          Object.fromEntries((await vis.forPage(id)).map((r) => [r.sectionKey, r.rule])),
        );
        const next: VisibilityMap = {};
        for (const s of doc.sections) next[s.key] = current[s.key] ?? DEFAULT_RULE;
        if (!sameDoc(current, next)) await vis.replace(id, next, actor.membershipId, t);
        return loadDetail(ctx, tx, p);
      }),

    setVisibility: (ctx, id, rules, actor, options) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const parsed = VisibilityMapSchema.safeParse(rules);
        if (!parsed.success) {
          throw new ContentError("validation_failed", "invalid visibility rules", {
            issues: parsed.error.issues.map((i) => ({
              path: ["rules", ...i.path.map(String)].join("."),
              message: i.message,
              code: i.code,
            })),
          });
        }
        const revisions = new RevisionRepo(ctx, tx);
        const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
        const keys = new Set(
          ((draft?.doc as PageDoc | undefined)?.sections ?? []).map((s) => s.key),
        );
        const issues: { path: string; message: string; code: string }[] = [];
        for (const [key, rule] of Object.entries(parsed.data)) {
          if (!keys.has(key))
            issues.push({
              path: `rules.${key}`,
              message: "no such section in the draft",
              code: "unknown_section",
            });
          if (rule.mode === "public" && !options.allowPublic) {
            issues.push({
              path: `rules.${key}.mode`,
              message:
                "public sections are disabled for this workspace (content.allowPublicSections)",
              code: "public_sections_disabled",
            });
          }
        }
        if (issues.length > 0)
          throw new ContentError("validation_failed", "invalid visibility rules", { issues });
        const groupIds = new Set((await new GroupRepo(ctx, tx).list()).map((g) => g.id));
        for (const [key, rule] of Object.entries(parsed.data)) {
          if (rule.mode === "groups" && rule.groupIds.some((g) => !groupIds.has(g))) {
            throw new ContentError("validation_failed", "invalid visibility rules", {
              issues: [
                { path: `rules.${key}.groupIds`, message: "unknown group", code: "unknown_group" },
              ],
            });
          }
        }
        const next: VisibilityMap = {};
        for (const key of keys) next[key] = parsed.data[key] ?? DEFAULT_RULE;
        await new VisibilityRepo(ctx, tx).replace(id, next, actor.membershipId, now());
        await audit(tx, ctx, actor, "page.visibility_changed", id, {
          modes: Object.fromEntries(Object.entries(next).map(([k, r]) => [k, r.mode])) as never,
        });
        return loadDetail(ctx, tx, p);
      }),

    publish: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const revisions = new RevisionRepo(ctx, tx);
        const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
        if (draft === undefined) throw new Error(`page ${id} has no draft revision`);
        const doc = validateDoc(draft.doc);
        const rows = await new VisibilityRepo(ctx, tx).forPage(id);
        const stored = parseVisibilityMap(
          Object.fromEntries(rows.map((r) => [r.sectionKey, r.rule])),
        );
        const visibility: VisibilityMap = {};
        for (const s of doc.sections) visibility[s.key] = stored[s.key] ?? DEFAULT_RULE;
        const t = now();
        const revisionNo = await revisions.nextRevisionNo(id);
        const published = await revisions.create({
          pageId: id,
          revisionNo,
          doc,
          docSchemaVersion: DOC_SCHEMA_VERSION,
          visibility,
          visibilitySchemaVersion: VISIBILITY_SCHEMA_VERSION,
          note: input.note ?? null,
          // The disclaimer in force at this instant, read in the same transaction that writes
          // the snapshot: the pair is the evidence that this text and this page went out together.
          disclaimerVersion: (await services.legal.stampFor(tx, ctx)) ?? null,
          createdBy: actor.membershipId,
          createdAt: t,
          savedAt: t,
          publishedAt: t,
        });
        const updated = await new PageRepo(ctx, tx).update(id, {
          publishedRevisionId: published.id,
        });
        if (updated === undefined) throw new ContentError("not_found", "no such page");
        await audit(tx, ctx, actor, "page.published", id, {
          revisionId: published.id,
          revisionNo,
          sections: doc.sections.length,
        });
        await publish(tx, ctx, "page.published", {
          pageId: id,
          revisionId: published.id,
          revisionNo,
          slug: p.slug,
          byMembershipId: actor.membershipId,
        });
        await indexPage(services, tx, ctx, id);
        return loadDetail(ctx, tx, updated);
      }),

    restore: (ctx, id, revisionId, actor) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const revisions = new RevisionRepo(ctx, tx);
        const source = await revisions.forPage(id, revisionId);
        if (source === undefined || source.publishedAt === null)
          throw new ContentError("not_found", "no such revision");
        const draft = p.draftRevisionId ? await revisions.byId(p.draftRevisionId) : undefined;
        if (draft === undefined) throw new Error(`page ${id} has no draft revision`);
        const doc = validateDoc(source.doc);
        const t = now();
        await revisions.saveDraft(draft.id, { doc, savedAt: t, createdBy: actor.membershipId });
        const snapshot = parseVisibilityMap(source.visibility);
        const next: VisibilityMap = {};
        for (const s of doc.sections) next[s.key] = snapshot[s.key] ?? DEFAULT_RULE;
        await new VisibilityRepo(ctx, tx).replace(id, next, actor.membershipId, t);
        await audit(tx, ctx, actor, "page.updated", id, { restoredFrom: source.revisionNo });
        return loadDetail(ctx, tx, p);
      }),

    revisions: (ctx, id) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const rows = await new RevisionRepo(ctx, tx).listForPage(id);
        return rows
          .filter((r) => r.publishedAt !== null)
          .map((r) => ({
            id: r.id,
            revisionNo: r.revisionNo,
            createdAt: r.createdAt,
            publishedAt: r.publishedAt,
            createdBy: r.createdBy,
            note: r.note,
            disclaimerVersion: r.disclaimerVersion,
            isCurrent: r.id === p.publishedRevisionId,
            isDraft: false,
          }));
      }),

    revision: (ctx, id, revisionId) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        const r = await new RevisionRepo(ctx, tx).forPage(id, revisionId);
        if (r === undefined || r.publishedAt === null) return undefined;
        return {
          summary: {
            id: r.id,
            revisionNo: r.revisionNo,
            createdAt: r.createdAt,
            publishedAt: r.publishedAt,
            createdBy: r.createdBy,
            note: r.note,
            disclaimerVersion: r.disclaimerVersion,
            isCurrent: r.id === p.publishedRevisionId,
            isDraft: false,
          },
          doc: r.doc as PageDoc,
          visibility: parseVisibilityMap(r.visibility),
        };
      }),

    remove: (ctx, id, actor) =>
      db.withTenant(ctx, async (tx) => {
        const p = await livePage(ctx, tx, id);
        if (p.kind === "home")
          throw new ContentError("conflict", "the home page cannot be deleted");
        await new PageRepo(ctx, tx).update(id, { deletedAt: now() });
        await audit(tx, ctx, actor, "page.deleted", id, { slug: p.slug });
        await indexPage(services, tx, ctx, id);
      }),

    render: (slug, input) =>
      db.withTenant(input.tenant, async (tx) => {
        const ctx = input.tenant;
        const p = await new PageRepo(ctx, tx).bySlug(slug);
        if (p === undefined || p.publishedRevisionId === null) return undefined;
        const rev = await new RevisionRepo(ctx, tx).byId(p.publishedRevisionId);
        if (rev === undefined) return undefined;
        return renderRevision(input, p, rev, parseVisibilityMap(rev.visibility), false);
      }),

    preview: (id, input) =>
      db.withTenant(input.tenant, async (tx) => {
        const ctx = input.tenant;
        const p = await new PageRepo(ctx, tx).live(id);
        if (p === undefined || p.draftRevisionId === null) return undefined;
        const rev = await new RevisionRepo(ctx, tx).byId(p.draftRevisionId);
        if (rev === undefined) return undefined;
        const rows = await new VisibilityRepo(ctx, tx).forPage(id);
        const visibility = parseVisibilityMap(
          Object.fromEntries(rows.map((r) => [r.sectionKey, r.rule])),
        );
        return renderRevision(input, p, rev, visibility, true);
      }),

    groupIdsOf: (ctx, membershipId) =>
      db.withTenant(ctx, (tx) => new GroupRepo(ctx, tx).groupIdsFor(membershipId)),
  };
}

/** Does the published page have anything a signed-out visitor may see? */
export function hasPublicSections(doc: PageDoc, visibility: VisibilityMap): boolean {
  return visibleSectionKeys(doc, visibility, { kind: "anonymous", groupIds: [] }, true).length > 0;
}
