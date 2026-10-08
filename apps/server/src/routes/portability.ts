import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  portability as pt,
  requestIdOf,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import {
  beginDownload,
  deleteExport,
  type ExportRow,
  ExportRunningError,
  ExportStateError,
  exportPublicKeys,
  findExport,
  listExports,
  openExportObject,
  requestExport,
} from "@fundroom/portability";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";

/*
 * Workspace export (E2.8): `/api/v1/portability/*` (authz-matrix.yaml "workspace export
 * (E2.8)"). Contracts: `@fundroom/contracts` `portability.ts`; the engine and the zip format:
 * `@fundroom/portability`.
 *
 * - One queued/running export per workspace: the partial unique index `workspace_export_active_idx`
 *   answers a second POST with 409 `export_running`, across processes (no in-memory flag).
 * - The zip is built by the `portability.export` job, never in the request; it is stored SHE1-
 *   encrypted (purpose `workspace-export`) and streamed back decrypted by the download, which
 *   records `workspace.export_downloaded` before the first byte.
 * - Owner only (`portability.export`); POST and the download also need a fresh sign-in. Investors
 *   get 404 from `requirePermission`, other staff 403.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const DOWNLOAD_ERRORS = errorResponses(400, 401, 403, 404, 409, 410, 429, 500, 503);
const TAGS = ["portability"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { membership, tenant, workspace };
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function exportBody(row: ExportRow) {
  return {
    id: row.id,
    status: row.status,
    options: { includeRawAnalytics: row.options.includeRawAnalytics },
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    expiresAt: iso(row.expiresAt),
    downloadedAt: iso(row.downloadedAt),
    warnings: [...row.warnings],
  };
}

function stateError(error: unknown): never {
  if (error instanceof ExportStateError) {
    switch (error.code) {
      case "not_found":
        throw new ApiError("not_found", "no such export");
      case "export_running":
        throw new ApiError("export_running", "the export is still queued or running");
      case "export_not_ready":
        throw new ApiError("export_not_ready", "the export is not ready");
      case "export_expired":
        throw new ApiError("export_expired", "the export has expired and its file was deleted");
    }
  }
  if (error instanceof ExportRunningError) throw new ApiError("export_running", error.message);
  throw error;
}

export function registerPortabilityRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (fresh = false) =>
    requirePermission({ authz: () => deps.authz }, "portability.export", { fresh });

  api.openapi(
    createRoute({
      method: "get",
      path: "/portability/exports",
      tags: TAGS,
      summary: "The workspace's exports, newest first",
      security: sessionSecurity,
      "x-requires": "portability.export",
      middleware: [perm()] as const,
      responses: { 200: jsonResponse(pt.WorkspaceExportListSchema, "Exports"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const rows = await deps.db.withTenant(s.tenant, (tx) => listExports(tx, s.workspace.id));
      return c.json({ items: rows.map(exportBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/portability/exports",
      tags: TAGS,
      summary: "Start an export of the whole workspace",
      description:
        "Queues a signed `seed-host.workspace-export` v1 zip of every table, file and the audit trail. One export at a time per workspace (409 `export_running`); an export whose worker stopped making progress 15 minutes ago is failed first and does not block a new one. Owner only, with a fresh sign-in; records `workspace.export_requested`. The file is kept for 7 days after it is ready; `warnings` lists data it could not include.",
      security: sessionSecurity,
      "x-requires": "portability.export+fresh",
      middleware: [perm(true)] as const,
      request: { body: jsonBody(pt.WorkspaceExportBody) },
      responses: { 202: jsonResponse(pt.WorkspaceExportSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const row = await deps.db
        .withTenant(s.tenant, (tx) =>
          requestExport({ audit: deps.audit, queue: deps.queue }, tx, s.tenant, {
            requestedBy: s.membership.id,
            includeRawAnalytics: body.includeRawAnalytics === true,
            requestId: requestIdOf(c),
          }),
        )
        .catch(stateError);
      return c.json(exportBody(row), 202);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/portability/exports/{id}",
      tags: TAGS,
      summary: "One export's status",
      security: sessionSecurity,
      "x-requires": "portability.export",
      middleware: [perm()] as const,
      request: { params: pt.WorkspaceExportParams },
      responses: { 200: jsonResponse(pt.WorkspaceExportSchema, "Export"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const row = await deps.db.withTenant(s.tenant, (tx) => findExport(tx, s.workspace.id, id));
      if (row === undefined) throw new ApiError("not_found", "no such export");
      return c.json(exportBody(row), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/portability/exports/{id}/download",
      tags: TAGS,
      summary: "Download a ready export",
      description:
        'The decrypted zip, streamed. `Content-Disposition: attachment; filename="<slug>-export-<date>.zip"`, `X-Content-SHA256` (hex), `Cache-Control: private, no-store`. 409 `export_not_ready` until it is ready, 410 `export_expired` after its 7 days. Owner only, with a fresh sign-in; records `workspace.export_downloaded`.',
      security: sessionSecurity,
      "x-requires": "portability.export+fresh",
      middleware: [perm(true)] as const,
      request: { params: pt.WorkspaceExportParams },
      responses: {
        200: {
          description: "The export zip",
          content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...DOWNLOAD_ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      // State check, `downloaded_at` and the audit row commit before the first byte leaves.
      const started = await deps.db
        .withTenant(s.tenant, (tx) =>
          beginDownload({ audit: deps.audit, envelope: deps.crypto }, tx, s.tenant, id, {
            now: new Date(),
            requestId: requestIdOf(c),
          }),
        )
        .catch(stateError);
      const stream = await openExportObject(deps.storage, started.key, started.dek);
      if (stream === undefined) throw new ApiError("export_expired", "the export's file is gone");
      const stamp = (started.row.completedAt ?? started.row.createdAt).toISOString().slice(0, 10);
      return c.body(stream, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${s.workspace.slug}-export-${stamp}.zip"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(started.row.sizeBytes === null
          ? {}
          : { "Content-Length": String(started.row.sizeBytes) }),
        ...(started.row.sha256 === null ? {} : { "X-Content-SHA256": started.row.sha256 }),
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/portability/exports/{id}",
      tags: TAGS,
      summary: "Delete an export and its file",
      description:
        "Deletes the stored file now rather than at expiry. A queued export is cancelled. A running export is refused with 409 `export_running` unless it is stale — no progress for 15 minutes (its worker died) — in which case it is deleted too. Records `workspace.export_deleted`.",
      security: sessionSecurity,
      "x-requires": "portability.export",
      middleware: [perm()] as const,
      request: { params: pt.WorkspaceExportParams },
      responses: { 204: { description: "Deleted" }, ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const key = await deps.db
        .withTenant(s.tenant, (tx) =>
          deleteExport({ audit: deps.audit }, tx, s.tenant, id, requestIdOf(c), new Date()),
        )
        .catch(stateError);
      // After the commit: a failed delete leaves an orphan the purge still removes with its keys.
      if (key !== null) await deps.storage.delete(key).catch(() => undefined);
      return c.body(null, 204) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/portability/export-key",
      tags: TAGS,
      summary: "The public keys workspace exports are signed with",
      description:
        "Ed25519 public keys (base64, raw 32 bytes), one per server key ring entry. Pin one when importing (`fundroom workspace import --public-key`): an export proves its origin only against a key obtained independently of it.",
      security: sessionSecurity,
      "x-requires": "portability.export",
      middleware: [perm()] as const,
      responses: { 200: jsonResponse(pt.WorkspaceExportKeysSchema, "Public keys"), ...ERRORS },
    }),
    (c) => {
      signed(c);
      return c.json({ keys: exportPublicKeys(deps.keyRing) }, 200);
    },
  );
}
