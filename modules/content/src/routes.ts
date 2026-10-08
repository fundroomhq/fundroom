import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { lockWorkspaceFacts, systemContext, updateWorkspaceSettingsBlock } from "@fundroom/db";
import {
  delegationAdmitsModule,
  parseWorkspaceSettings,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import type { BlockViewer, ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import { BLOCK_REGISTRY, blockDescriptors, DocValidationError, type PageDoc } from "./blocks.js";
import * as s from "./contracts.js";
import {
  type Actor,
  ContentError,
  type ContentService,
  createContentService,
  hasPublicSections,
  type PageDetail,
  type PageSummary,
  type RenderedPage,
  type RevisionSummary,
} from "./service.js";
import { parseVisibilityMap, viewerForPreview } from "./visibility.js";

/*
 * `/api/v1/content/*` (E1.2). Staff routes mount the kernel guards from `ModuleServices`;
 * the render route is public-shaped: it answers signed-out visitors with the page's public
 * sections when the workspace allows them, and `unauthenticated` otherwise.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["content"];

type Vars = ModuleEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

const actorOf = (c: Context<ModuleEnv>, s: Signed): Actor => ({
  membershipId: s.membership.id,
  requestId: requestIdOf(c),
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function pageBody(p: PageSummary) {
  return {
    ...p,
    publishedAt: iso(p.publishedAt),
    draftSavedAt: iso(p.draftSavedAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function detailBody(d: PageDetail) {
  return {
    page: pageBody(d.page),
    draft: {
      revisionId: d.draft.revisionId,
      doc: d.draft.doc,
      savedAt: d.draft.savedAt.toISOString(),
    },
    visibility: d.visibility,
    groups: [...d.groups],
  };
}

function revisionBody(r: RevisionSummary) {
  return { ...r, createdAt: r.createdAt.toISOString(), publishedAt: iso(r.publishedAt) };
}

function renderedBody(r: RenderedPage) {
  return {
    page: r.page,
    revision: { ...r.revision, publishedAt: iso(r.revision.publishedAt) },
    sections: r.sections.map((sec) => ({
      key: sec.key,
      title: sec.title,
      visibility: sec.visibility,
      blocks: sec.blocks.map((b) => ({
        id: b.id,
        type: b.type,
        schemaVersion: b.schemaVersion,
        data: b.data as Record<string, unknown>,
        ...(b.unavailable === undefined ? {} : { unavailable: b.unavailable }),
      })),
    })),
    viewer: r.viewer,
    preview: r.preview,
  };
}

function rethrow(error: unknown): never {
  if (error instanceof ContentError) throw new ApiError(error.code, error.message, error.details);
  if (error instanceof DocValidationError) {
    throw new ApiError("validation_failed", "invalid page document", { issues: error.issues });
  }
  throw error;
}

function allowPublicOf(workspace: Signed["workspace"] | NonNullable<Vars["workspace"]>): boolean {
  return parseWorkspaceSettings(workspace.settings).content.allowPublicSections;
}

export function registerContentRoutes(api: ModuleRouter, services: ModuleServices): void {
  let service: ContentService | undefined;
  const svc = () => {
    service ??= createContentService(services);
    return service;
  };
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  const facts = (c: Context<ModuleEnv>) => ({
    authLevel: c.get("session")?.authLevel,
    ip: services.clientIp(c),
  });

  // --- investor render ------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/render/{slug}",
      tags: TAGS,
      summary:
        "The published page as this viewer sees it (sections filtered, reference blocks hydrated)",
      description:
        "Members see the sections their audience allows (staff see every section, badged). Signed-out visitors get the public sections when the workspace allows public sections, else `unauthenticated`. The home page is seeded from the template on first request.",
      "x-requires": "public",
      request: { params: s.SlugParams },
      responses: { 200: jsonResponse(s.RenderedPageSchema, "Rendered page"), ...ERRORS },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const { slug } = c.req.valid("param");
      const session = c.get("session");
      const membership = c.get("membership");
      const tenant = c.get("tenant");
      if (slug === "home") await svc().ensureHome(workspace.id, workspace.name);
      const allowPublic = allowPublicOf(workspace);
      const enabled = (await services.enablement.get(services.db, systemContext(workspace.id)))
        .enabled;

      if (session !== undefined && (membership === undefined || tenant === undefined)) {
        throw new ApiError("not_found", "no such workspace for this account");
      }
      // F3 (E3.2): a page's member sections are "updates" content. A delegate whose scope does not
      // admit them (`data_room`) sees what a signed-out visitor would: the public sections, when
      // the workspace allows them, and otherwise an empty page (it is signed in, so not a 401).
      // RLS (migration 0003) refuses it the page under its own context, so this renders under a
      // system context, exactly like the anonymous branch.
      const narrowDelegate =
        membership !== undefined &&
        membership.role === "delegate" &&
        !delegationAdmitsModule(membership.delegateScope, "content");
      if (narrowDelegate) {
        const rendered = await svc().render(slug, {
          tenant: systemContext(workspace.id),
          viewer: { kind: "anonymous", groupIds: [] },
          allowPublic,
          facts: facts(c),
          enabledModules: enabled,
        });
        if (rendered === undefined) throw new ApiError("not_found", "no such page");
        return c.json(renderedBody(allowPublic ? rendered : { ...rendered, sections: [] }), 200);
      }
      if (session === undefined || membership === undefined || tenant === undefined) {
        // Anonymous: only when the page has public sections and the workspace allows them.
        const rendered = await svc().render(slug, {
          tenant: systemContext(workspace.id),
          viewer: { kind: "anonymous", groupIds: [] },
          allowPublic,
          facts: facts(c),
          enabledModules: enabled,
        });
        if (rendered === undefined || !allowPublic || rendered.sections.length === 0) {
          throw new ApiError("unauthenticated", "sign in to see this page");
        }
        return c.json(renderedBody(rendered), 200);
      }
      const viewer: BlockViewer =
        membership.kind === "staff"
          ? { kind: "staff", membershipId: membership.id, groupIds: [] }
          : {
              kind: "external",
              membershipId: membership.id,
              groupIds: await svc().groupIdsOf(tenant, membership.id),
              delegateScope: membership.role === "delegate" ? membership.delegateScope : null,
            };
      const rendered = await svc().render(slug, {
        tenant,
        viewer,
        allowPublic,
        facts: facts(c),
        enabledModules: enabled,
      });
      if (rendered === undefined) throw new ApiError("not_found", "no such page");
      return c.json(renderedBody(rendered), 200);
    },
  );

  // --- pages (staff) --------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/pages",
      tags: TAGS,
      summary: "Pages of this workspace with draft/published state",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      responses: { 200: jsonResponse(s.PageListSchema, "Pages"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      await svc().ensureHome(sg.workspace.id, sg.workspace.name);
      const pages = await svc().list(sg.tenant);
      return c.json({ pages: pages.map(pageBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/pages",
      tags: TAGS,
      summary: "Create a custom page (empty draft, unpublished)",
      security: sessionSecurity,
      "x-requires": "content.manage",
      middleware: [perm("content.manage")] as const,
      request: { body: jsonBody(s.CreatePageBody) },
      responses: { 201: jsonResponse(s.PageDetailSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().create(sg.tenant, c.req.valid("json"), actorOf(c, sg));
        return c.json(detailBody(d), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/pages/{id}",
      tags: TAGS,
      summary: "One page: the draft document, section visibility and the groups to target",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      request: { params: s.PageIdParams },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const d = await svc().get(sg.tenant, c.req.valid("param").id);
      if (d === undefined) throw new ApiError("not_found", "no such page");
      return c.json(detailBody(d), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/pages/{id}",
      tags: TAGS,
      summary: "Rename a page or change a custom page's slug",
      security: sessionSecurity,
      "x-requires": "content.manage",
      middleware: [perm("content.manage")] as const,
      request: { params: s.PageIdParams, body: jsonBody(s.PatchPageBody) },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().update(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/pages/{id}",
      tags: TAGS,
      summary: "Delete a custom page (soft; the home page cannot be deleted)",
      security: sessionSecurity,
      "x-requires": "content.manage+fresh",
      middleware: [perm("content.manage", true)] as const,
      request: { params: s.PageIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/pages/{id}/draft",
      tags: TAGS,
      summary: "Save the draft document (autosave; validated against the block registry)",
      description:
        "Blocks are normalised to the current schema version. New sections get the default visibility (`authenticated`); rules of removed sections are dropped. Pass `baseSavedAt` to detect concurrent edits (409).",
      security: sessionSecurity,
      "x-requires": "content.manage",
      middleware: [perm("content.manage")] as const,
      request: { params: s.PageIdParams, body: jsonBody(s.SaveDraftBody) },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const d = await svc().saveDraft(
          sg.tenant,
          c.req.valid("param").id,
          { doc: body.doc, baseSavedAt: body.baseSavedAt ? new Date(body.baseSavedAt) : undefined },
          actorOf(c, sg),
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/pages/{id}/visibility",
      tags: TAGS,
      summary: "Set the audience of every section (authenticated | groups | staff_only | public)",
      description:
        "`public` is refused unless the workspace setting `allowPublicSections` is on. Rules take effect on the next publish; the editor's preview shows them at once.",
      security: sessionSecurity,
      "x-requires": "content.manage",
      middleware: [perm("content.manage")] as const,
      request: { params: s.PageIdParams, body: jsonBody(s.VisibilityBody) },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().setVisibility(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json").rules,
          actorOf(c, sg),
          { allowPublic: allowPublicOf(sg.workspace) },
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/pages/{id}/publish",
      tags: TAGS,
      summary: "Publish the draft as a new immutable revision (visibility snapshotted)",
      security: sessionSecurity,
      "x-requires": "content.publish",
      middleware: [perm("content.publish")] as const,
      request: { params: s.PageIdParams, body: jsonBody(s.PublishBody) },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Published"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().publish(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/pages/{id}/preview",
      tags: TAGS,
      summary: "Render the draft as an audience would see it (preview-as-group)",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      request: { params: s.PageIdParams, query: s.PreviewQuery },
      responses: { 200: jsonResponse(s.RenderedPageSchema, "Preview"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { as } = c.req.valid("query");
      const enabled = (await services.enablement.get(services.db, sg.tenant)).enabled;
      const rendered = await svc().preview(c.req.valid("param").id, {
        tenant: sg.tenant,
        viewer: viewerForPreview(as),
        allowPublic: allowPublicOf(sg.workspace),
        facts: facts(c),
        enabledModules: enabled,
      });
      if (rendered === undefined) throw new ApiError("not_found", "no such page");
      return c.json(renderedBody(rendered), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/pages/{id}/revisions",
      tags: TAGS,
      summary: "Published revisions, newest first",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      request: { params: s.PageIdParams },
      responses: { 200: jsonResponse(s.RevisionListSchema, "Revisions"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const rows = await svc().revisions(sg.tenant, c.req.valid("param").id);
        return c.json({ revisions: rows.map(revisionBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/pages/{id}/revisions/{revisionId}",
      tags: TAGS,
      summary: "One published revision: document and the visibility snapshot",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      request: { params: s.RevisionParams },
      responses: { 200: jsonResponse(s.RevisionDetailSchema, "Revision"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id, revisionId } = c.req.valid("param");
      try {
        const r = await svc().revision(sg.tenant, id, revisionId);
        if (r === undefined) throw new ApiError("not_found", "no such revision");
        return c.json(
          { revision: revisionBody(r.summary), doc: r.doc, visibility: r.visibility },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/pages/{id}/revisions/{revisionId}/restore",
      tags: TAGS,
      summary: "Copy a published revision (document and visibility) into the draft",
      description:
        "Rollback is restore then publish: the old content becomes a new revision, history stays.",
      security: sessionSecurity,
      "x-requires": "content.manage",
      middleware: [perm("content.manage")] as const,
      request: { params: s.RevisionParams },
      responses: { 200: jsonResponse(s.PageDetailSchema, "Draft replaced"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id, revisionId } = c.req.valid("param");
      try {
        const d = await svc().restore(sg.tenant, id, revisionId, actorOf(c, sg));
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- registry + settings --------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/blocks",
      tags: TAGS,
      summary:
        "The block registry: types, schema versions and which reference blocks can be hydrated here",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      responses: { 200: jsonResponse(s.BlockListSchema, "Blocks"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const enabled = (await services.enablement.get(services.db, sg.tenant)).enabled;
      const blocks = blockDescriptors().map((b) => {
        const provider = services.registry.blockHydrators.get(b.type);
        const available =
          BLOCK_REGISTRY[b.type].kind === "static" ||
          (provider !== undefined && enabled.has(provider.module));
        return { ...b, providedBy: provider?.module ?? null, available };
      });
      return c.json({ blocks }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "Content settings (public sections)",
      security: sessionSecurity,
      "x-requires": "content.read",
      middleware: [perm("content.read")] as const,
      responses: { 200: jsonResponse(s.ContentSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json(parseWorkspaceSettings(sg.workspace.settings).content, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change content settings (allow public sections)",
      description:
        "Switching public sections off does not rewrite rules: sections marked `public` render as `authenticated` until the setting is on again.",
      security: sessionSecurity,
      "x-requires": "content.settings+fresh",
      middleware: [perm("content.settings", true)] as const,
      request: { body: jsonBody(s.ContentSettingsPatchBody) },
      responses: { 200: jsonResponse(s.ContentSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const patch = c.req.valid("json");
      const next = await services.db.withTenant(sg.tenant, async (tx) => {
        // The `content` block alone, merged on the row-locked copy (A-3 R2 M1): never the request's
        // cached settings, never the whole document — a concurrent writer of another block keeps
        // its change. Row lock first, audit last (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, sg.workspace.id))?.settings,
        );
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          content: { ...current.content, ...patch },
        });
        await updateWorkspaceSettingsBlock(tx, sg.workspace.id, "content", next.content);
        await services.audit.record(tx, sg.tenant, {
          action: "content.settings_changed",
          resourceKind: "workspace",
          resourceId: sg.workspace.id,
          requestId: requestIdOf(c),
          meta: { fields: Object.keys(patch) },
        });
        return next;
      });
      services.workspaces.invalidate(sg.workspace.id);
      return c.json(next.content, 200);
    },
  );
}

/** Exposed for tests: does a published doc have anything a signed-out visitor may see? */
export function publicSectionCount(doc: PageDoc, visibility: unknown): number {
  return hasPublicSections(doc, parseVisibilityMap(visibility)) ? 1 : 0;
}
