import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { lockWorkspaceFacts, updateWorkspaceSettings } from "@fundroom/db";
import {
  parseWorkspaceSettings,
  WORKSPACE_SETTINGS_SCHEMA_VERSION,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { AccessDecision } from "@fundroom/ports";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { attachmentDisposition } from "./disposition.js";
import { type Actor, DataRoomError } from "./errors.js";
import { registerForensicRoutes } from "./forensic/routes.js";
import { FOLDER_TEMPLATES, parseProtection, protectionView } from "./model.js";
import { registerQaIoRoutes } from "./qa/io-routes.js";
import { registerQaRoutes } from "./qa/routes.js";
import { unindexAllQuestions } from "./qa/search.js";
import type { Blob, Document, DocumentVersion, Folder, Upload } from "./schema/dataroom.js";
import type { Viewer } from "./service/access.js";
import { type DeliveryContext, type DeliveryService, sharedDelivery } from "./service/delivery.js";
import {
  createDocumentService,
  type DocumentDetail,
  type DocumentService,
} from "./service/documents.js";
import { createFolderService, type FolderService, type Tree } from "./service/folders.js";
import { createSearchIndexer, SEARCH_MODULE } from "./service/search.js";
import { createUploadService, type UploadService } from "./service/uploads.js";

/*
 * `/api/v1/data-room/*` (E1.3). Staff routes mount the kernel guards; member routes (tree,
 * document detail, pages, thumbnail, search, download, viewed) serve investors and staff
 * alike and decide per resource through `AuthzPort.check()`. Bytes never leave through a
 * presigned URL (ADR-0015): pages and downloads stream from here with `no-store`.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 415, 429, 500, 503);
/**
 * The two writes that can turn a plan feature on (A-3, ADR-0063): the settings (Q&A, the forensic
 * default) and a document's protection (`forensic`). 402 `plan_limit` only for the off→on
 * transition; a write that keeps an already-on toggle on, or changes other fields, passes.
 */
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 413, 415, 429, 500, 503);
const TAGS = ["data-room"];

type Vars = ModuleEnv["Variables"];
interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!session && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function folderBody(f: Folder, index: string | null) {
  return {
    id: f.id,
    parentId: f.parentId,
    name: f.name,
    path: f.path,
    index,
    sortOrder: f.sortOrder,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    deletedAt: iso(f.deletedAt),
    purgeAfter: iso(f.purgeAfter),
  };
}

function documentBody(
  d: Document,
  index: string,
  version: DocumentVersion | null,
  blob: Pick<Blob, "scanStatus"> | null,
  viewerKind: "staff" | "external" = "staff",
) {
  return {
    id: d.id,
    folderId: d.folderId,
    title: d.title,
    index,
    sortOrder: d.sortOrder,
    protection: protectionView(parseProtection(d.protection), viewerKind),
    legalHold: d.legalHold,
    currentVersionId: d.currentVersionId,
    contentType: version?.contentType ?? null,
    sizeBytes: version?.sizeBytes ?? null,
    pageCount: version?.pageCount ?? null,
    renderStatus: version?.renderStatus ?? null,
    scanStatus: blob?.scanStatus ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    deletedAt: iso(d.deletedAt),
    purgeAfter: iso(d.purgeAfter),
  };
}

function versionBody(v: DocumentVersion, currentId: string | null) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    fileName: v.fileName,
    contentType: v.contentType,
    sizeBytes: v.sizeBytes,
    pageCount: v.pageCount,
    renderStatus: v.renderStatus,
    renderDetail: v.renderDetail,
    changeNote: v.changeNote,
    uploadedBy: v.uploadedBy,
    createdAt: v.createdAt.toISOString(),
    isCurrent: v.id === currentId,
  };
}

function uploadBody(u: Upload) {
  return {
    id: u.id,
    status: u.status,
    method: u.method,
    fileName: u.fileName,
    size: u.declaredSize,
    contentType: u.declaredType,
    folderId: u.folderId,
    documentId: u.documentId,
    versionId: u.versionId,
    error: u.error,
    expiresAt: u.expiresAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
  };
}

function decisionBody(d: AccessDecision) {
  return {
    allowed: d.allowed,
    capabilities: [...d.capabilities],
    pendingGates: d.pendingGates.map((g) => ({
      kind: g.kind,
      detail: { ...g.detail },
      source: g.source,
    })),
    reason: d.reason,
  };
}

function detailBody(d: DocumentDetail, viewerKind: "staff" | "external" = "staff") {
  return {
    document: documentBody(d.document, d.index, d.currentVersion, d.blob, viewerKind),
    folder: d.folder,
    currentVersion: d.currentVersion
      ? versionBody(d.currentVersion, d.document.currentVersionId)
      : null,
    scan: d.blob
      ? {
          status: d.blob.scanStatus,
          engine: d.blob.scanEngine,
          detail: d.blob.scanDetail,
          scannedAt: iso(d.blob.scannedAt),
        }
      : null,
    versions: d.versions.map((v) => versionBody(v, d.document.currentVersionId)),
    access: decisionBody(d.decision),
    availability: d.availability,
    legalHold: d.document.legalHold
      ? {
          reason: d.document.legalHoldReason,
          setBy: d.document.legalHoldSetBy,
          setAt: iso(d.document.legalHoldSetAt),
        }
      : null,
  };
}

function rethrow(error: unknown): never {
  if (error instanceof DataRoomError) throw new ApiError(error.code, error.message, error.details);
  throw error;
}

export function registerDataRoomRoutes(api: ModuleRouter, services: ModuleServices): void {
  let folders: FolderService | undefined;
  let documents: DocumentService | undefined;
  let uploads: UploadService | undefined;
  let delivery: DeliveryService | undefined;
  const svc = () => {
    folders ??= createFolderService(services);
    documents ??= createDocumentService(services);
    uploads ??= createUploadService(services);
    delivery ??= sharedDelivery(services);
    return { folders, documents, uploads, delivery };
  };
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();

  const viewerOf = (c: Context<ModuleEnv>, sg: Signed): Viewer => ({
    membershipId: sg.membership.id,
    kind: sg.membership.kind,
    // One builder, shared with the kernel (`ModuleServices.requestFacts`, E2.3 contract §5.6).
    // Hand-rolling this was fine until there were two copies of it: `min_auth_level` and
    // `ip_allowlist` both fail *closed* on a field they cannot see (`settleGates` keeps the gate
    // pending), so a fact added to `RequestFacts` has to reach every construction of it at once.
    facts: services.requestFacts(c),
  });
  const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
    membershipId: sg.membership.id,
    requestId: requestIdOf(c),
    sessionId: sg.session?.sessionId,
    apiKeyId: c.get("apiKey")?.id,
    ip: services.clientIp(c),
  });
  const settingsOf = (sg: Signed) => parseWorkspaceSettings(sg.workspace.settings).dataRoom;
  registerQaIoRoutes(api, services); // E3.3: GET /qa/export, POST /qa/import
  registerForensicRoutes(api, services); // E3.13: forensic detect + recipients

  async function treeBody(sg: Signed, c: Context<ModuleEnv>) {
    const tree: Tree = await svc().folders.tree(sg.tenant, viewerOf(c, sg));
    const sys = { workspaceId: sg.tenant.workspaceId, actorKind: "system" as const };
    // Version/blob summaries for the listed documents (one pass, system read).
    const { versions, blobs } = await services.db.withTenant(sys, async (tx) => {
      const { VersionRepo, BlobRepo } = await import("./repos/dataroom-repo.js");
      const vIds = tree.documents
        .map((d) => d.document.currentVersionId)
        .filter((x): x is string => x !== null);
      const vs = await new VersionRepo(sys, tx).byIds(vIds);
      const bs = new Map<string, Blob>();
      const blobRepo = new BlobRepo(sys, tx);
      for (const v of vs) {
        if (!bs.has(v.blobId)) {
          const b = await blobRepo.byId(v.blobId);
          if (b) bs.set(v.blobId, b);
        }
      }
      return { versions: new Map(vs.map((v) => [v.id, v])), blobs: bs };
    });
    return {
      rootId: tree.root.id,
      folders: tree.folders.map((f) => ({
        ...folderBody(
          {
            id: f.id,
            parentId: f.parentId,
            name: f.name,
            path: f.path,
            sortOrder: f.sortOrder,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
            deletedAt: null,
            purgeAfter: null,
          } as Folder,
          f.index,
        ),
        access: decisionBody(f.decision),
        passthrough: f.passthrough,
      })),
      documents: tree.documents.map((d) => {
        const v = d.document.currentVersionId
          ? (versions.get(d.document.currentVersionId) ?? null)
          : null;
        const b = v ? (blobs.get(v.blobId) ?? null) : null;
        return {
          ...documentBody(d.document, d.index, v, b, sg.membership.kind),
          access: decisionBody(d.decision),
        };
      }),
    };
  }

  /** Loads a document for delivery: 404 unless the viewer may `capability` it. */
  async function deliverable(
    c: Context<ModuleEnv>,
    sg: Signed,
    id: string,
    capability: "view" | "download",
  ): Promise<{ detail: DocumentDetail; ctx: DeliveryContext }> {
    let detail: DocumentDetail;
    try {
      detail = await svc().documents.get(sg.tenant, id, viewerOf(c, sg), settingsOf(sg));
    } catch (error) {
      rethrow(error);
    }
    if (!detail.decision.allowed) {
      if (detail.decision.reason === "gated") {
        throw new ApiError("forbidden", "an access requirement is pending", {
          pendingGates: detail.decision.pendingGates,
        });
      }
      throw new ApiError("not_found", "no such document");
    }
    if (capability === "download" && detail.availability.download === null) {
      throw new ApiError("forbidden", "downloads are not allowed for this document");
    }
    if (detail.currentVersion === null || detail.blob === null) {
      throw new ApiError("not_found", "this document has no file yet");
    }
    const sys = { workspaceId: sg.tenant.workspaceId, actorKind: "system" as const };
    const loaded = await svc().documents.load(sys, id);
    if (loaded === undefined || loaded.version === null || loaded.blob === null) {
      throw new ApiError("not_found", "this document has no file yet");
    }
    const viewer = await svc().delivery.watermarkViewer(
      sg.tenant,
      sg.membership.id,
      sg.workspace.slug,
    );
    return {
      detail,
      ctx: {
        ctx: sys,
        document: loaded.document,
        version: loaded.version,
        blob: loaded.blob,
        protection: detail.protection,
        viewer,
        actor: actorOf(c, sg),
        // View as investor (E3.13 FIX1 D3): the investor's visible line, the acting staff
        // member's own forensic mark — never the investor's, never none.
        markMembershipId: c.get("viewAs")?.staffMembershipId,
      },
    };
  }

  // --- tree ------------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/tree",
      tags: TAGS,
      summary:
        "The folder tree and documents as this member sees them (index numbers, access per node)",
      description:
        "Staff see everything live; investors see the documents and folders their grants reach (folder grants inherit down the tree), plus the folders on the way to them (`passthrough`). Gated items (NDA pending) are listed with `access.reason = gated`.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.TreeSchema, "Tree"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json(await treeBody(sg, c), 200);
    },
  );

  // --- folders (staff) -------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/folders",
      tags: TAGS,
      summary: "Create a folder",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { body: jsonBody(s.FolderCreateBody) },
      responses: { 201: jsonResponse(s.TreeSchema, "Created; the whole tree"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().folders.create(sg.tenant, c.req.valid("json"), actorOf(c, sg));
      } catch (error) {
        rethrow(error);
      }
      return c.json(await treeBody(sg, c), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/folders/{id}",
      tags: TAGS,
      summary: "Rename, move or reorder a folder (moving rewrites the paths of its grants)",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams, body: jsonBody(s.FolderPatchBody) },
      responses: { 200: jsonResponse(s.TreeSchema, "Updated; the whole tree"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().folders.update(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
      } catch (error) {
        rethrow(error);
      }
      return c.json(await treeBody(sg, c), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/folders/{id}",
      tags: TAGS,
      summary: "Move a folder and everything below it to the recycle bin",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.DeleteResultSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const deleted = await svc().folders.remove(
          sg.tenant,
          c.req.valid("param").id,
          actorOf(c, sg),
          settingsOf(sg).purgeAfterDays,
        );
        return c.json({ deleted }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/folders/{id}/restore",
      tags: TAGS,
      summary: "Restore a folder (and its contents) from the recycle bin",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.TreeSchema, "Restored; the whole tree"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().folders.restore(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
      } catch (error) {
        rethrow(error);
      }
      return c.json(await treeBody(sg, c), 200);
    },
  );

  // --- templates -------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/templates",
      tags: TAGS,
      summary: "Folder templates (Seed, Series A due diligence, Board)",
      security: sessionSecurity,
      "x-requires": "data-room.read",
      middleware: [perm("data-room.read")] as const,
      responses: { 200: jsonResponse(s.TemplateListSchema, "Templates"), ...ERRORS },
    }),
    async (c) => {
      signed(c);
      const flat = (items: (typeof FOLDER_TEMPLATES)[number]["folders"], prefix = ""): string[] =>
        items.flatMap((i) => [
          `${prefix}${i.name}`,
          ...flat(i.children ?? [], `${prefix}${i.name} / `),
        ]);
      return c.json(
        {
          templates: FOLDER_TEMPLATES.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            folders: flat(t.folders),
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/templates/{id}/apply",
      tags: TAGS,
      summary: "Create a template's folders under the root (or a folder); existing names are kept",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.TemplateParams, body: jsonBody(s.TemplateApplyBody) },
      responses: { 200: jsonResponse(s.TemplateApplyResultSchema, "Applied"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        // The root folder is created lazily by the first `tree()` read, so a workspace whose
        // data room has never been opened has none — and applying a template to the root is
        // exactly what the setup wizard (E1.7) does before anyone opens anything. Ensure it
        // here rather than inside `applyTemplate`, which runs in one transaction and must not
        // nest the `withTenant` that `ensureRoot` opens.
        await svc().folders.ensureRoot(sg.tenant.workspaceId);
        const r = await svc().folders.applyTemplate(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json").parentId,
          actorOf(c, sg),
        );
        return c.json({ created: r.created, tree: await treeBody(sg, c) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- documents -------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}",
      tags: TAGS,
      summary: "One document: current version, availability for this viewer, versions (staff)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.DocumentDetailSchema, "Document"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().documents.get(
          sg.tenant,
          c.req.valid("param").id,
          viewerOf(c, sg),
          settingsOf(sg),
        );
        return c.json(detailBody(d, sg.membership.kind), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/documents/{id}",
      tags: TAGS,
      summary: "Rename, move, reorder or change the protection of a document",
      description:
        'Turning `protection.forensic` on for a document that does not have it answers 402 `plan_limit` (`feature: "forensic"`) when the workspace\'s plan does not include forensic watermarking; a document that already has it keeps it.',
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams, body: jsonBody(s.DocumentPatchBody) },
      responses: { 200: jsonResponse(s.DocumentDetailSchema, "Updated"), ...GATED_ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const id = c.req.valid("param").id;
      try {
        await svc().documents.update(sg.tenant, id, c.req.valid("json"), actorOf(c, sg));
        const d = await svc().documents.get(sg.tenant, id, viewerOf(c, sg), settingsOf(sg));
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/documents/{id}",
      tags: TAGS,
      summary: "Move a document to the recycle bin (refused under legal hold)",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().documents.remove(
          sg.tenant,
          c.req.valid("param").id,
          actorOf(c, sg),
          settingsOf(sg).purgeAfterDays,
        );
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/documents/{id}/restore",
      tags: TAGS,
      summary: "Restore a document from the recycle bin",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.DocumentDetailSchema, "Restored"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const id = c.req.valid("param").id;
      try {
        await svc().documents.restore(sg.tenant, id, actorOf(c, sg));
        const d = await svc().documents.get(sg.tenant, id, viewerOf(c, sg), settingsOf(sg));
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/documents/{id}/purge",
      tags: TAGS,
      summary:
        "Delete a binned document for good (versions, renditions; blobs follow in the purge job)",
      security: sessionSecurity,
      "x-requires": "data-room.manage+fresh",
      middleware: [perm("data-room.manage", true)] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(OkSchema, "Purged"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().documents.purge(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/documents/{id}/legal-hold",
      tags: TAGS,
      summary: "Set or clear a legal hold (blocks deletion and purge; audited with the reason)",
      security: sessionSecurity,
      "x-requires": "data-room.legal_hold+fresh",
      middleware: [perm("data-room.legal_hold", true)] as const,
      request: { params: s.IdParams, body: jsonBody(s.LegalHoldBody) },
      responses: { 200: jsonResponse(s.DocumentDetailSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const id = c.req.valid("param").id;
      try {
        await svc().documents.setLegalHold(sg.tenant, id, c.req.valid("json"), actorOf(c, sg));
        const d = await svc().documents.get(sg.tenant, id, viewerOf(c, sg), settingsOf(sg));
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/versions",
      tags: TAGS,
      summary: "Every version of a document, newest first",
      security: sessionOrApiKeySecurity,
      "x-requires": "data-room.read+apikey",
      middleware: [keyPerm("data-room.read")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.VersionListSchema, "Versions"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await svc().documents.get(
          sg.tenant,
          c.req.valid("param").id,
          viewerOf(c, sg),
          settingsOf(sg),
        );
        return c.json(
          { versions: d.versions.map((v) => versionBody(v, d.document.currentVersionId)) },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- delivery --------------------------------------------------------------------------------
  const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/thumbnail",
      tags: TAGS,
      summary: "First-page thumbnail (WebP) of the current version",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.IdParams },
      responses: { 200: s.BinaryResponse("image/webp", "Thumbnail"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { ctx } = await deliverable(c, sg, c.req.valid("param").id, "view");
      const thumb = await svc().delivery.thumbnail(ctx);
      if (thumb === undefined) throw new ApiError("not_found", "no thumbnail yet");
      return c.body(thumb.bytes as unknown as ArrayBuffer, 200, {
        ...noStore,
        "Content-Type": thumb.contentType,
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/pages/{n}",
      tags: TAGS,
      summary: "One page of the current version as an image, watermarked for this viewer",
      description:
        "Rendered on first request and cached encrypted; the watermark (viewer email · time · workspace) is burned in per viewer. `Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.PageParams },
      responses: { 200: s.BinaryResponse("image/webp", "Page image"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id, n } = c.req.valid("param");
      const { detail, ctx } = await deliverable(c, sg, id, "view");
      if (!detail.availability.viewable) {
        throw new ApiError("conflict", "this document cannot be viewed", {
          reason: detail.availability.reason,
        });
      }
      try {
        const page = await svc().delivery.page(ctx, n);
        return c.body(page.bytes as unknown as ArrayBuffer, 200, {
          ...noStore,
          "Content-Type": page.contentType,
        }) as never;
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/pages/{n}/text",
      tags: TAGS,
      summary: "The extracted text of one page of the current version (for assistive technology)",
      description:
        "The text layer behind the page image, so screen readers, zoom-to-text and find-in-page work in the secure viewer. " +
        "Exactly the page image's checks: `view` on the document (grant or folder grant), gates pending → 403 with " +
        "`pendingGates`, no access → 404, a version that is not viewable → 409 with `reason`, a page past `pageCount` → 404. " +
        "Protection does not remove it: `download`/`print` govern copies of the file, and the watermark is a deterrent on " +
        "images — the words themselves are already readable by anyone this route admits, and withholding them would lock " +
        "out screen-reader users only (WCAG 1.1.1). Read-only: nothing is audited or counted here (the viewer's " +
        "`POST …/viewed` records the view once). Plain text, never HTML; empty for a page with no text layer (a scan). " +
        "`Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.PageParams },
      responses: { 200: jsonResponse(s.PageTextSchema, "Page text"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id, n } = c.req.valid("param");
      // The page image's checks, verbatim: the text is the same page in another form.
      const { detail, ctx } = await deliverable(c, sg, id, "view");
      if (!detail.availability.viewable) {
        throw new ApiError("conflict", "this document cannot be viewed", {
          reason: detail.availability.reason,
        });
      }
      const pageCount = ctx.version.pageCount ?? 0;
      if (n > pageCount) throw new ApiError("not_found", "no such page");
      const text = await svc().delivery.pageText(ctx.ctx, ctx.version.id, n);
      for (const [k, v] of Object.entries(noStore)) c.header(k, v);
      return c.json({ pageNo: n, pageCount, text }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/search",
      tags: TAGS,
      summary: "Find pages of the current version containing the query (extracted text)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.IdParams, query: s.SearchQuery },
      responses: { 200: jsonResponse(s.SearchResultSchema, "Hits"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { ctx } = await deliverable(c, sg, c.req.valid("param").id, "view");
      const hits = await svc().delivery.search(ctx.ctx, ctx.version.id, c.req.valid("query").q);
      return c.json({ hits }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/download",
      tags: TAGS,
      summary:
        "Download the current version: watermarked PDF, or the original for staff with the download permission",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.IdParams, query: s.DownloadQuery },
      responses: { 200: s.BinaryResponse("application/octet-stream", "File"), ...ERRORS },
    }),
    async (c) => {
      // View as investor (E2.7): a download is a copy leaving the portal in the investor's name
      // (watermarked with their address, audited as theirs), so it is refused outright.
      if (c.get("viewAs") !== undefined)
        throw new ApiError(
          "view_as_read_only",
          "downloads are disabled while viewing as an investor",
        );
      const sg = signed(c);
      const { detail, ctx } = await deliverable(c, sg, c.req.valid("param").id, "download");
      const allowed = detail.availability.download;
      if (allowed === null)
        throw new ApiError("forbidden", "downloads are not allowed for this document");
      const wanted = c.req.valid("query").variant ?? allowed;
      // Watermarked is always allowed when any download is; the original only when granted.
      const variant = wanted === "original" && allowed !== "original" ? "watermarked" : wanted;
      try {
        const file = await svc().delivery.download(ctx, variant);
        return c.body(file.body, 200, {
          ...noStore,
          "Content-Type": file.contentType,
          "Content-Disposition": attachmentDisposition(file.fileName),
          ...(file.size === undefined ? {} : { "Content-Length": String(file.size) }),
        }) as never;
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/documents/{id}/viewed",
      tags: TAGS,
      summary:
        "Record that this viewer opened the document (audit + `document.viewed`, deduplicated per session)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.ViewedResultSchema, "Recorded"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { ctx } = await deliverable(c, sg, c.req.valid("param").id, "view");
      const recorded = await svc().delivery.recordView(ctx);
      return c.json({ recorded }, 200);
    },
  );

  // --- uploads (staff) -------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/uploads",
      tags: TAGS,
      summary: "Start an upload: a new document in a folder, or a new version of a document",
      description:
        "Returns presigned multipart part URLs on the S3 driver, or the tus endpoint on the filesystem driver (resumable, through the app). Bytes land on a quarantine key; call `complete` when they are all there.",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { body: jsonBody(s.UploadStartBody) },
      responses: { 201: jsonResponse(s.UploadStartSchema, "Started"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const r = await svc().uploads.start(
          sg.tenant,
          c.req.valid("json"),
          actorOf(c, sg),
          settingsOf(sg),
        );
        return c.json(
          {
            upload: uploadBody(r.upload),
            method: r.method,
            multipart: r.multipart
              ? { partSize: r.multipart.partSize, parts: [...r.multipart.parts] }
              : null,
            tus: r.tus ?? null,
          },
          201,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/uploads/{id}/complete",
      tags: TAGS,
      summary:
        "Finish an upload: verify size, type and hash; create the document/version; queue scan + render",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams, body: jsonBody(s.UploadCompleteBody) },
      responses: { 200: jsonResponse(s.UploadCompleteSchema, "Completed"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const r = await svc().uploads.complete(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
          settingsOf(sg),
        );
        const d = await svc().documents.get(
          sg.tenant,
          r.document.id,
          viewerOf(c, sg),
          settingsOf(sg),
        );
        return c.json(
          {
            upload: uploadBody(r.upload),
            document: documentBody(d.document, d.index, d.currentVersion, d.blob),
            version: versionBody(r.version, r.document.currentVersionId ?? r.version.id),
            deduplicated: r.deduplicated,
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/uploads/{id}",
      tags: TAGS,
      summary: "Upload status",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(s.UploadSchema, "Upload"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const up = await svc().uploads.get(sg.tenant, c.req.valid("param").id);
      if (up === undefined || up.createdBy !== sg.membership.id)
        throw new ApiError("not_found", "no such upload");
      return c.json(uploadBody(up), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/uploads/{id}",
      tags: TAGS,
      summary: "Abort an upload and drop its bytes",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      request: { params: s.IdParams },
      responses: { 200: jsonResponse(OkSchema, "Aborted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await svc().uploads.abort(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- recycle bin, settings ------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/trash",
      tags: TAGS,
      summary: "The recycle bin: deleted folders and documents with their purge dates",
      security: sessionSecurity,
      "x-requires": "data-room.manage",
      middleware: [perm("data-room.manage")] as const,
      responses: { 200: jsonResponse(s.TrashSchema, "Recycle bin"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const [fs, ds] = await Promise.all([
        svc().folders.listDeleted(sg.tenant),
        svc().documents.listDeleted(sg.tenant),
      ]);
      return c.json(
        {
          folders: fs.map((f) => folderBody(f, null)),
          documents: ds.map((d) => documentBody(d, "", null, null)),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary:
        "Data room settings (defaults for new documents, unscanned policy, recycle bin retention)",
      security: sessionSecurity,
      "x-requires": "data-room.read",
      middleware: [perm("data-room.read")] as const,
      responses: { 200: jsonResponse(s.DataRoomSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json(
        {
          ...settingsOf(sg),
          limits: {
            uploadMaxBytes: services.limits.uploadMaxBytes,
            renderMaxBytes: services.limits.renderMaxBytes,
          },
          scanner: services.scanner.driver,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change data room settings",
      description:
        '402 `plan_limit` when the write turns on what the workspace\'s plan does not include: `qa.enabled` false→true (`feature: "qa"`) or `forensicByDefault` false→true (`feature: "forensic"`). A setting already on stays on, and every other field can still be changed.',
      security: sessionSecurity,
      "x-requires": "data-room.settings+fresh",
      middleware: [perm("data-room.settings", true)] as const,
      request: { body: jsonBody(s.DataRoomSettingsPatchBody) },
      responses: { 200: jsonResponse(s.DataRoomSettingsSchema, "Settings"), ...GATED_ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { qa: qaPatch, ...patch } = c.req.valid("json");
      const fields = [...Object.keys(patch), ...Object.keys(qaPatch ?? {}).map((k) => `qa.${k}`)];
      // Read-modify-write on the locked row, never on the resolver's cached copy: the whole
      // jsonb is replaced, so a concurrent writer of any other key must not be undone.
      const next = await services.db.withTenant(sg.tenant, async (tx) => {
        const facts = await lockWorkspaceFacts(tx, sg.workspace.id);
        if (facts === undefined) throw new ApiError("not_found", "no such workspace");
        const raw =
          typeof facts.settings === "object" && facts.settings !== null
            ? (facts.settings as Record<string, unknown>)
            : {};
        const current = parseWorkspaceSettings(raw);
        const merged = WorkspaceSettingsSchema.parse({
          ...current,
          dataRoom: {
            ...current.dataRoom,
            ...patch,
            qa: { ...current.dataRoom.qa, ...qaPatch },
          },
        });
        // A-3: the plan gates turning Q&A or the forensic default ON — judged against the locked
        // row, so a toggle already on (a downgraded workspace's) stays on and every other field
        // can still be saved. The plan is read on this transaction, only when something turns on.
        const turnsOn = [
          ...(merged.dataRoom.qa.enabled && !current.dataRoom.qa.enabled ? (["qa"] as const) : []),
          ...(merged.dataRoom.forensicByDefault && !current.dataRoom.forensicByDefault
            ? (["forensic"] as const)
            : []),
        ];
        if (turnsOn.length > 0) {
          const entitlements = await services.entitlements.forWorkspace(tx, sg.workspace.id);
          for (const feature of turnsOn) services.entitlements.assertFeature(entitlements, feature);
        }
        await updateWorkspaceSettings(tx, sg.workspace.id, {
          ...raw,
          ...merged,
          settingsSchemaVersion: WORKSPACE_SETTINGS_SCHEMA_VERSION,
        });
        // Whether unscanned files' text is searchable follows the unscanned policy. Turned off,
        // the text leaves the index in this transaction (a rebuild is still asked for, as the
        // belt for an ingest that read the old setting); turned on, the rebuild brings it back.
        const unscannedFlipped = merged.dataRoom.allowUnscanned !== current.dataRoom.allowUnscanned;
        if (unscannedFlipped && !merged.dataRoom.allowUnscanned)
          await createSearchIndexer(services).unscannedTextOff(tx, sg.tenant);
        // Q&A answers are searchable only while Q&A is on (the provider skips them while it is
        // off): a flip either way rebuilds the module's entries. Turned off, they also leave
        // the index now, in this transaction — no window until the rebuild runs. (Q&A writers
        // take this row — FOR NO KEY UPDATE — before indexing, so none can index behind this.)
        const qaFlipped = merged.dataRoom.qa.enabled !== current.dataRoom.qa.enabled;
        if (qaFlipped && !merged.dataRoom.qa.enabled)
          await unindexAllQuestions(services, tx, sg.tenant);
        if (unscannedFlipped || qaFlipped)
          await services.search.requestReindex(tx, sg.tenant, SEARCH_MODULE);
        // Audit last: the global lock order (E3.5 LX) is workspace row → search entries → audit
        // chain. Every search write and every audit takes the workspace row first, so a document
        // rename or trash (entries, then audit) queues behind this transaction on the row
        // instead of holding an entry this one needs.
        await services.audit.record(tx, sg.tenant, {
          action: "data_room.settings_changed",
          resourceKind: "workspace",
          resourceId: sg.workspace.id,
          actorMembershipId: sg.membership.id,
          requestId: requestIdOf(c),
          meta: { fields },
        });
        return merged;
      });
      services.workspaces.invalidate(sg.workspace.id);
      return c.json(
        {
          ...next.dataRoom,
          limits: {
            uploadMaxBytes: services.limits.uploadMaxBytes,
            renderMaxBytes: services.limits.renderMaxBytes,
          },
          scanner: services.scanner.driver,
        },
        200,
      );
    },
  );

  // E3.3 Q&A (`qa/routes.ts`).
  registerQaRoutes(api, services);
}
