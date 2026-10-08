import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@fundroom/contracts";
import type { ModuleEnv, ModuleRawRouter, ModuleServices } from "@fundroom/module-kit";
import { createTusUploadServer, type TusUploadServer } from "@fundroom/storage-fs";
import type { Context, MiddlewareHandler } from "hono";
import { registerForensicRawRoutes } from "./forensic/routes.js";
import { createUploadService } from "./service/uploads.js";

/*
 * `/api/v1/data-room/uploads/tus[/<id>]` — the resumable upload protocol for the
 * filesystem driver (ADR-0028 §4). Mounted outside the JSON body limit; the session, CSRF
 * and enablement chain still runs first, then `requirePermission("data-room.manage")`. The upload id is minted by `POST /uploads`; the
 * tus client echoes it in `Upload-Metadata: upload <base64 id>` and PATCHes to `/tus/<id>`.
 * Only the member who started the upload may write to it, and only while it is `pending`.
 */
export const TUS_PATH = "/uploads/tus";

export function registerDataRoomRawRoutes(app: ModuleRawRouter, services: ModuleServices): void {
  let server: TusUploadServer | undefined;
  const pending = new WeakMap<Request, { workspaceId: string; membershipId: string }>();

  function tus(): TusUploadServer {
    if (server !== undefined) return server;
    const stagingDir = join(services.limits.dataDir, "uploads", "tus");
    mkdirSync(stagingDir, { recursive: true });
    const uploads = createUploadService(services);
    server = createTusUploadServer({
      storage: services.storage,
      stagingDir,
      path: `/api/v1/data-room${TUS_PATH}`,
      maxSize: services.limits.uploadMaxBytes,
      log: services.log,
      resolveUpload: async (request, uploadId) => {
        const who = pending.get(request);
        if (who === undefined) return undefined;
        const ctx = { workspaceId: who.workspaceId, actorKind: "system" as const };
        return uploads.resolveTus(ctx, uploadId, who.membershipId);
      },
      onUploadFinish: async ({ uploadId }) => {
        // The finishing request is the one that carries the context.
        const who = lastFinish.get(uploadId);
        if (who === undefined) return;
        await uploads.markStored({ workspaceId: who.workspaceId, actorKind: "system" }, uploadId);
      },
    });
    return server;
  }
  const lastFinish = new Map<string, { workspaceId: string; membershipId: string }>();

  /*
   * The kernel guard chain first (E3.2 SWEEP-1), exactly as `POST /uploads` mounts it: signed in,
   * a live staff member here (anybody else gets the 404 an unknown path gives — no oracle), a
   * session as strong as the role needs (MFA), then the permission. Resolved per request: the
   * services are not readable at registration time.
   */
  const guard: MiddlewareHandler<ModuleEnv> = (c, next) =>
    services.guards.requirePermission("data-room.manage")(c, next);
  // E3.13: forensic detection takes a multipart image of up to 15 MiB.
  registerForensicRawRoutes(app, services);
  app.all(`${TUS_PATH}/*`, guard, handle);
  app.all(TUS_PATH, guard, handle);

  async function handle(c: Context<ModuleEnv>): Promise<Response> {
    const session = c.get("session");
    const membership = c.get("membership");
    const workspace = c.get("workspace");
    // Unreachable behind the guard; kept so the handler never runs on a half-resolved request.
    if (!session || !membership || !workspace) throw new ApiError("unauthenticated");
    const who = { workspaceId: workspace.id, membershipId: membership.id };
    pending.set(c.req.raw, who);
    const id = c.req.path.split("/").pop() ?? "";
    if (/^[0-9a-f-]{36}$/iu.test(id)) lastFinish.set(id.toLowerCase(), who);
    try {
      return await tus().handle(c.req.raw);
    } finally {
      if (/^[0-9a-f-]{36}$/iu.test(id)) lastFinish.delete(id.toLowerCase());
    }
  }
}
