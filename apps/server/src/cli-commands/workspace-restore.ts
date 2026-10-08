import { createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import { createDatabase } from "@fundroom/db";
import { createSharedDirectory } from "@fundroom/directory";
import { directoryOwnerKeys } from "../residency/directory-jobs.js";
import { restoreWorkspace, WorkspaceLifecycleError } from "../workspace/lifecycle.js";
import { runWorkspaceMove, WORKSPACE_MOVE_USAGE } from "./moves.js";
import {
  runWorkspaceExport,
  runWorkspaceImport,
  runWorkspaceVerifyExport,
  WORKSPACE_PORTABILITY_USAGE,
} from "./workspace-portability.js";

/*
 * `fundroom workspace <restore|export|import|verify-export>`.
 *
 * `restore <id|slug>` (E2.7 package B1): undoes an owner's "delete workspace" while its 30-day
 * window is open (purge_after > now, never purged). Operator-only by construction — it needs
 * DATABASE_URL — and audited on the platform trail as `workspace.restored`. A running server picks
 * the workspace up again within the resolver and custom-domain cache TTLs (≤ 60 s); sessions
 * revoked by the deletion stay revoked.
 *
 * `move <slug> --to <cell-id>` (E3.11): `moves.ts`.
 *
 * `export`, `import`, `verify-export` (E2.8): `workspace-portability.ts`. `verify-export` is
 * offline, so `cfg` may be undefined when no config is loadable (it then trusts only the keys
 * passed with --public-key, or the file's own embedded key: UNVERIFIED ORIGIN).
 */
export const WORKSPACE_USAGE = `usage: fundroom workspace <restore|export|import|verify-export|move> …
  restore <workspace-id|slug>
${WORKSPACE_PORTABILITY_USAGE}
${WORKSPACE_MOVE_USAGE}`;

export async function runWorkspace(argv: string[], cfg: AppConfig | undefined): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "verify-export") return runWorkspaceVerifyExport(rest, cfg);
  if (
    (sub === "export" || sub === "import" || sub === "restore" || sub === "move") &&
    cfg === undefined
  ) {
    console.error(`fundroom workspace ${sub} needs a loadable configuration (DATABASE_URL, …)`);
    return 2;
  }
  if (sub === "export" && cfg) return runWorkspaceExport(rest, cfg);
  if (sub === "import" && cfg) return runWorkspaceImport(rest, cfg);
  if (sub === "move" && cfg) return runWorkspaceMove(rest, cfg);
  const [target] = rest;
  if (sub !== "restore" || target === undefined || target.length === 0 || cfg === undefined) {
    console.error(WORKSPACE_USAGE);
    return 2;
  }
  const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
  // E3.11 R2-3: with a shared directory the restored workspace's entry is routed again.
  const directory =
    cfg.raw.DIRECTORY_DATABASE_URL === undefined
      ? undefined
      : createSharedDirectory({
          url: cfg.raw.DIRECTORY_DATABASE_URL,
          poolMax: 1,
          db,
          cellId: cfg.raw.CELL_ID,
          ownerKeys: directoryOwnerKeys(cfg.keyRing),
        });
  try {
    const audit = createAuditService({ db });
    const row = await restoreWorkspace(
      {
        db,
        audit,
        directory,
        log: (event, fields) => console.error(`${event} ${JSON.stringify(fields ?? {})}`),
      },
      target,
    );
    console.error(`restored workspace ${row.slug} (${row.id})`);
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceLifecycleError) {
      console.error(`cannot restore: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await directory?.close();
    await db.close();
  }
}

/** The name `cli.ts` already calls; the same dispatcher. */
export const runWorkspaceRestore = runWorkspace;
