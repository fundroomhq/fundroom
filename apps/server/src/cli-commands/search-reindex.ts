import { type AuditRecorder, createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import {
  createDatabase,
  type Database,
  findWorkspaceById,
  findWorkspaceBySlug,
  isPlatformWorkspace,
  listLiveWorkspaceIds,
  platformContext,
} from "@fundroom/db";
import { createModuleRegistry, type ModuleManifest } from "@fundroom/module-kit";
import { reindexWorkspaceModule } from "@fundroom/search";
import { COMPILED_IN_MODULES } from "../modules.js";

export const SEARCH_USAGE =
  "usage: fundroom search reindex [--workspace <slug|id>] [--module <id>]";

/*
 * `fundroom search reindex [--workspace <slug|id>] [--module <id>]` (E2.8).
 *
 * Runs the rebuild **synchronously**, in this process, with the same function the
 * `search.reindex` job runs (`reindexWorkspaceModule`: short system-context transactions per
 * (workspace, module) — provider pages upserted, stale rows deleted, `core.search_state`). No
 * worker has to be running and the operator sees each result, which is what one reaches for
 * after a restore, an import or a botched provider deploy. Without `--workspace` every live
 * workspace is rebuilt; without `--module` every module that declares `search` (a module id that
 * no longer indexes is accepted and has its stale entries removed).
 *
 * Each rebuilt workspace gets one `search.reindex_requested` event on the platform audit chain
 * (`meta.via = "cli"`, the workspace id and modules) — the operator holds no membership, so the
 * tenant chain has no actor to name, the same choice `jobs dlq` made.
 *
 * A rebuild that throws is reported on its own line (`<ws>\t<module>\tfailed\t<message>`) and the
 * command carries on with the remaining pairs.
 *
 * Exit 0 done, 1 unknown workspace or module or any rebuild failed, 2 usage.
 */
export interface SearchReindexDeps {
  readonly db: Database;
  readonly modules: readonly ModuleManifest[];
  readonly audit: Pick<AuditRecorder, "recordDetached">;
  readonly out?: ((line: string) => void) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ParsedArgs {
  readonly workspace?: string | undefined;
  readonly module?: string | undefined;
}

/** `argv` is everything after `search`. Returns undefined on a usage error. */
export function parseSearchReindexArgs(argv: readonly string[]): ParsedArgs | undefined {
  const [sub, ...rest] = argv;
  if (sub !== "reindex") return undefined;
  let workspace: string | undefined;
  let module: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    if (name === "--workspace" && workspace === undefined) workspace = value;
    else if (name === "--module" && module === undefined) module = value;
    else return undefined;
  }
  return { workspace, module };
}

/** The command against an open database; `runSearchReindex` wires the real one. */
export async function searchReindexCommand(
  argv: readonly string[],
  deps: SearchReindexDeps,
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const args = parseSearchReindexArgs(argv);
  if (args === undefined) {
    console.error(SEARCH_USAGE);
    return 2;
  }
  const searchable = deps.modules.filter((m) => m.search !== undefined).map((m) => m.id);
  let modules: string[];
  if (args.module !== undefined) {
    if (!deps.modules.some((m) => m.id === args.module)) {
      console.error(
        `unknown module ${args.module}; modules that index: ${searchable.join(", ") || "(none)"}`,
      );
      return 1;
    }
    modules = [args.module];
  } else {
    modules = searchable;
  }

  let workspaceIds: string[];
  if (args.workspace !== undefined) {
    const key = args.workspace.trim();
    const ws = UUID_RE.test(key)
      ? await findWorkspaceById(deps.db, key.toLowerCase())
      : await findWorkspaceBySlug(deps.db, key);
    if (ws === undefined || isPlatformWorkspace(ws.id)) {
      console.error(`no live workspace ${key}`);
      return 1;
    }
    workspaceIds = [ws.id];
  } else {
    workspaceIds = (await listLiveWorkspaceIds(deps.db)).filter((id) => !isPlatformWorkspace(id));
  }

  const modulesById = () => deps.modules;
  let failed = 0;
  for (const workspaceId of workspaceIds) {
    const done: string[] = [];
    for (const module of modules) {
      // One failing (workspace, module) — a provider bug, a lock timeout — must not stop the
      // rest: it is reported, the command carries on, and the exit code says something failed.
      let r: Awaited<ReturnType<typeof reindexWorkspaceModule>>;
      try {
        r = await reindexWorkspaceModule(
          { db: deps.db, modules: modulesById },
          workspaceId,
          module,
        );
      } catch (error) {
        failed += 1;
        const message = (error instanceof Error ? error.message : String(error)).replace(
          /\s+/gu,
          " ",
        );
        out(`${workspaceId}\t${module}\tfailed\t${message.slice(0, 300)}`);
        continue;
      }
      out(
        `${workspaceId}\t${module}\t${r.status}\tentries=${r.entries}${r.invalid > 0 ? `\tinvalid=${r.invalid}` : ""}`,
      );
      if (r.status !== "skipped") done.push(module);
    }
    if (done.length > 0) {
      await deps.audit.recordDetached(platformContext(), {
        action: "search.reindex_requested",
        resourceKind: "search_index",
        resourceId: workspaceId,
        actorKind: "system",
        meta: { via: "cli", workspaceId, modules: done },
      });
    }
  }
  console.error(`reindexed ${modules.length} module(s) in ${workspaceIds.length} workspace(s)`);
  if (failed > 0) {
    console.error(`${failed} rebuild(s) failed (lines marked "failed" above)`);
    return 1;
  }
  return 0;
}

/** `fundroom search …`; `argv` is everything after `search` (`["reindex", …flags]`). */
export async function runSearchReindex(argv: readonly string[], cfg: AppConfig): Promise<number> {
  if (parseSearchReindexArgs(argv) === undefined) {
    console.error(SEARCH_USAGE);
    return 2;
  }
  const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
  try {
    const registry = createModuleRegistry(COMPILED_IN_MODULES, { only: cfg.modules });
    return await searchReindexCommand(argv, {
      db,
      modules: registry.modules,
      audit: createAuditService({ db, truncateIp: cfg.raw.AUDIT_IP_TRUNCATE }),
    });
  } finally {
    await db.close();
  }
}
