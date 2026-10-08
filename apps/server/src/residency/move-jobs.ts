import type { AuditService } from "@fundroom/audit";
import { rebuildEffectiveAccess, rederiveRulePaths } from "@fundroom/authz";
import type { AppConfig } from "@fundroom/config";
import { createMoveJobs as createEngineJobs, type MoveEngineDeps } from "@fundroom/control-plane";
import type { EnvelopeService } from "@fundroom/crypto";
import type { CustomDomainService } from "@fundroom/custom-domains";
import { type Database, systemContext, type WorkspaceResolver } from "@fundroom/db";
import type { ModuleManifest, ModuleRegistry, ModuleServices } from "@fundroom/module-kit";
import { createOutboundHttp } from "@fundroom/outbound-http";
import type {
  DirectoryPort,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  ObjectStoragePort,
} from "@fundroom/ports";
import { createS3Storage } from "@fundroom/storage-s3";
import { SERVER_VERSION } from "../version.js";
import { purgeDeletedWorkspaces } from "../workspace/lifecycle.js";

/*
 * The moves engine's wiring (E3.11, ADR-0059; owner C): `move.export`, `move.import`, the minute
 * `move.poll` and the hourly `move.retire`, registered only when the directory is shared (a
 * self-host has no other cell to move to).
 *
 *  - Bundles are presigned by a SECOND S3 client over the same bucket whose presign cap is the
 *    bundle TTL (24 h): ADR-0015's 60 s cap stays for document delivery. With STORAGE_DRIVER=fs
 *    nothing can presign, and a move request is refused (`move_unavailable`, reason `storage`).
 *  - Downloads use their own SSRF-guarded agent: the operator's OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]
 *    (a cell's object store is often on a private network), no redirects, a deadline long enough
 *    for MOVE_MAX_BUNDLE_BYTES, and a response cap of the same size.
 *  - The export/import temp files go under `<DATA_DIR>/moves/` (size that volume above
 *    MOVE_MAX_BUNDLE_BYTES on the worker pods).
 */

export interface MoveWiring {
  readonly config: AppConfig;
  readonly db: Database;
  readonly audit: AuditService;
  readonly directory: DirectoryPort;
  readonly storage: ObjectStoragePort;
  readonly envelope: EnvelopeService;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly resolver: Pick<WorkspaceResolver, "invalidate">;
  readonly registry: Pick<ModuleRegistry, "modules">;
  readonly moduleServices: ModuleServices;
  readonly customDomains?: Pick<CustomDomainService, "add"> | undefined;
  /** Every compiled-in module (names the owner of an omitted schema in the export). */
  readonly compiledModules?: readonly ModuleManifest[] | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** A download may take this long end to end (50 GiB at ~3 MB/s). */
export const MOVE_DOWNLOAD_DEADLINE_MS = 6 * 3600_000;

/** The engine's dependencies for one cell (the jobs', the routes' and the tests'). */
export function moveEngineDeps(w: MoveWiring): MoveEngineDeps {
  const raw = w.config.raw;
  const log = w.log;
  const signer =
    raw.STORAGE_DRIVER === "s3"
      ? createS3Storage({
          bucket: raw.S3_BUCKET ?? "",
          region: raw.S3_REGION,
          endpoint: raw.S3_ENDPOINT,
          accessKeyId: raw.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: raw.S3_SECRET_ACCESS_KEY ?? "",
          forcePathStyle: raw.S3_FORCE_PATH_STYLE,
          presignGetMaxSeconds: 24 * 3600,
        })
      : undefined;
  const outbound = createOutboundHttp({
    allowPrivate: raw.OUTBOUND_HTTP_ALLOW_PRIVATE,
    allowedPrivateHosts: raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? [],
    userAgent: `FundRoom/${SERVER_VERSION} (+moves)`,
    timeoutMs: MOVE_DOWNLOAD_DEADLINE_MS,
    maxResponseBytes: raw.MOVE_MAX_BUNDLE_BYTES + 1024 * 1024,
    maxRedirects: 0,
    ...(log === undefined ? {} : { log }),
  });
  return {
    db: w.db,
    audit: w.audit,
    directory: w.directory,
    cellId: raw.CELL_ID,
    invalidate: () => w.resolver.invalidate(),
    queue: w.queue,
    canPresign: signer !== undefined,
    ...(w.now === undefined ? {} : { now: w.now }),
    ...(log === undefined ? {} : { log }),
    storage: w.storage,
    presignBundle: async (key, seconds) => {
      if (signer === undefined) throw new Error("this object store cannot presign");
      return signer.presignGet(key, { expiresInSeconds: seconds });
    },
    portability: {
      db: w.db,
      storage: w.storage,
      envelope: w.envelope,
      keyRing: w.config.keyRing,
      modules: w.registry.modules,
      compiledModules: w.compiledModules ?? [],
      instanceVersion: SERVER_VERSION,
      audit: w.audit,
      moduleServices: w.moduleServices,
      rederiveRulePaths,
      rebuildAccess: async (tx, ctx) => {
        await rebuildEffectiveAccess(tx, ctx);
      },
      tmpDir: raw.DATA_DIR,
      ...(w.now === undefined ? {} : { now: w.now }),
      ...(log === undefined ? {} : { log }),
    },
    dataDir: raw.DATA_DIR,
    fetch: outbound.fetch,
    maxBundleBytes: raw.MOVE_MAX_BUNDLE_BYTES,
    retentionHours: raw.MOVE_SOURCE_RETENTION_HOURS,
    purge: async () => {
      await purgeDeletedWorkspaces({
        db: w.db,
        audit: w.audit,
        invalidateKeys: (id) => w.envelope.invalidate(id),
        storage: w.storage,
        ...(w.now === undefined ? {} : { now: w.now }),
        ...(log === undefined ? {} : { log }),
      });
    },
    readdDomains: async (workspaceId, hostnames) => {
      const service = w.customDomains;
      if (service === undefined) return;
      for (const hostname of hostnames) {
        try {
          await service.add(systemContext(workspaceId), { hostname });
        } catch (error) {
          log?.("moves.domain_readd_failed", {
            level: "warn",
            workspaceId,
            hostname,
            error: error instanceof Error ? error.message.slice(0, 200) : String(error),
          });
        }
      }
    },
  };
}

/** The container's one call: the move jobs, or none without the shared directory. */
export function createMoveJobs(w: MoveWiring): JobDefinition<JsonObject>[] {
  if (w.directory.mode !== "shared") return [];
  return createEngineJobs(moveEngineDeps(w));
}
