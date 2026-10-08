import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { rebuildEffectiveAccess, rederiveRulePaths } from "@fundroom/authz";
import type { AppConfig } from "@fundroom/config";
import { localPlacementCell } from "@fundroom/control-plane";
import { findWorkspaceById, findWorkspaceBySlug, systemContext } from "@fundroom/db";
import {
  EXPORT_VERIFY_EXIT,
  exportPublicKeys,
  formatVerification,
  importWorkspace,
  PortabilityError,
  requestExport,
  runExport,
  verificationExitCode,
  verifyExportFile,
} from "@fundroom/portability";
import { createContainer } from "../container.js";
import { createLogger } from "../logger.js";
import { COMPILED_IN_MODULES } from "../modules.js";
import { SERVER_VERSION } from "../version.js";

/*
 * `fundroom workspace export | import | verify-export` (E2.8 contract §3). Operator commands:
 * export and import need DATABASE_URL (and the same storage the server uses); verify-export needs
 * nothing but the file.
 *
 *   export <slug|id> --out <file.zip> [--include-raw-analytics]
 *       Runs the export synchronously (the same code path as the `portability.export` job, with a
 *       `core.workspace_export` row and its audit events), keeps the encrypted copy in storage like
 *       a portal export, and writes the plaintext zip to --out. Exit 0 / 1.
 *   import <file.zip> --slug <new-slug> [--name <name>] [--public-key <b64>]... [--allow-unverified]
 *          [--owner-email <email>]
 *       Verifies, then creates a NEW workspace. The signature must come from a pinned key: the
 *       --public-key values, or (none given) this instance's own export keys. Exit 0 imported,
 *       1 failed (nothing was written), 2 usage, 3 refused: UNVERIFIED ORIGIN (pass
 *       --allow-unverified to import it anyway).
 *   verify-export <file.zip> [--public-key <b64>]...
 *       Offline. Exit 0 verified and trusted, 1 failed, 3 intact but unpinned (UNVERIFIED ORIGIN).
 */

export const WORKSPACE_PORTABILITY_USAGE = `  export <slug|id> --out <file.zip> [--include-raw-analytics]
  import <file.zip> --slug <new-slug> [--name <name>] [--public-key <base64>]... [--allow-unverified] [--owner-email <email>]
  verify-export <file.zip> [--public-key <base64>]...`;

/** `usage: fundroom workspace <line>` for one subcommand (0 export, 1 import, 2 verify-export). */
export function workspaceUsageLine(index: 0 | 1 | 2): string {
  return `usage: fundroom workspace ${(WORKSPACE_PORTABILITY_USAGE.split("\n")[index] ?? "").trim()}`;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function flags(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => {
    const next = argv[i + 1];
    return a === name && next !== undefined ? [next] : [];
  });
}

/** Positional arguments (not a flag, not a flag's value). */
function positionals(argv: readonly string[], valued: readonly string[]): string[] {
  return argv.filter((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function containerFor(cfg: AppConfig) {
  const logger = createLogger({ level: cfg.raw.LOG_LEVEL, version: SERVER_VERSION });
  return createContainer({ config: cfg, logger, modules: COMPILED_IN_MODULES });
}

export async function runWorkspaceExport(argv: readonly string[], cfg: AppConfig): Promise<number> {
  const [target] = positionals(argv, ["--out"]);
  const out = flag(argv, "--out");
  if (target === undefined || out === undefined) {
    console.error(workspaceUsageLine(0));
    return 2;
  }
  const container = containerFor(cfg);
  try {
    const ws = UUID_RE.test(target)
      ? await findWorkspaceById(container.db, target.toLowerCase())
      : await findWorkspaceBySlug(container.db, target.toLowerCase());
    if (ws === undefined) {
      console.error(`no live workspace ${target}`);
      return 1;
    }
    const ctx = systemContext(ws.id);
    let row: Awaited<ReturnType<typeof requestExport>>;
    try {
      row = await container.db.withTenant(ctx, (tx) =>
        requestExport({ audit: container.audit }, tx, ctx, {
          requestedBy: null,
          includeRawAnalytics: argv.includes("--include-raw-analytics"),
        }),
      );
    } catch (error) {
      console.error(`cannot export: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    mkdirSync(resolve(out, ".."), { recursive: true });
    // Not enqueued: it runs here, so no worker can race it.
    const result = await runExport(
      {
        db: container.db,
        storage: container.storage,
        envelope: container.envelope,
        keyRing: cfg.keyRing,
        modules: container.registry.modules,
        compiledModules: COMPILED_IN_MODULES,
        instanceVersion: SERVER_VERSION,
        audit: container.audit,
        dataDir: cfg.raw.DATA_DIR,
      },
      { exportId: row.id, workspaceId: ws.id, copyTo: resolve(out) },
    );
    if (result.status !== "ready" || result.row === undefined) {
      console.error(`export failed: ${result.error ?? result.status}`);
      return 1;
    }
    const key = exportPublicKeys(cfg.keyRing)[0];
    console.error(
      `exported ${ws.slug} (${ws.id}) to ${resolve(out)}: ${result.row.sizeBytes} bytes, sha256 ${result.row.sha256}`,
    );
    if (key) console.error(`signed with key ${key.keyId}: ${key.publicKey}`);
    for (const w of result.row.warnings) console.error(`warning: ${w}`);
    return 0;
  } finally {
    await container.stop();
  }
}

export async function runWorkspaceImport(argv: readonly string[], cfg: AppConfig): Promise<number> {
  const valued = ["--slug", "--name", "--public-key", "--owner-email"];
  const [file] = positionals(argv, valued);
  const slug = flag(argv, "--slug");
  if (file === undefined || slug === undefined) {
    console.error(workspaceUsageLine(1));
    return 2;
  }
  const given = flags(argv, "--public-key");
  const trusted = given.length > 0 ? given : exportPublicKeys(cfg.keyRing).map((k) => k.publicKey);
  const container = containerFor(cfg);
  try {
    await container.queue.start();
    const result = await importWorkspace(
      {
        db: container.db,
        storage: container.storage,
        envelope: container.envelope,
        keyRing: cfg.keyRing,
        modules: container.registry.modules,
        instanceVersion: SERVER_VERSION,
        audit: container.audit,
        moduleServices: container.moduleServices,
        rederiveRulePaths,
        rebuildAccess: async (tx, ctx) => {
          await rebuildEffectiveAccess(tx, ctx);
        },
        tmpDir: cfg.raw.DATA_DIR,
        // E3.11: the new workspace is placed like the setup wizard and the demo seed place one
        // (CELL_ID; refused when that cell has no row or takes no new workspaces, E-UP-13 — never
        // a silent `default`), and claims its slug in the directory (a no-op claim in local mode).
        cellId: await localPlacementCell(container.db, cfg.raw.CELL_ID),
        directory: container.directory,
      },
      {
        file: resolve(file),
        slug,
        name: flag(argv, "--name"),
        trustedPublicKeys: trusted,
        allowUnverified: argv.includes("--allow-unverified"),
        ownerEmail: flag(argv, "--owner-email"),
        importedBy: `cli:${process.env["USER"] ?? "operator"}`,
      },
    );
    const rows = Object.values(result.counts).reduce((a, b) => a + b, 0);
    console.error(
      `imported into ${result.slug} (${result.workspaceId}): ${Object.keys(result.counts).length} tables, ${rows} rows, ${result.objects} objects; signature ${result.signature}`,
    );
    for (const w of result.warnings) console.error(`warning: ${w}`);
    console.error(
      "not carried: custom domains, share-link tokens and passcodes, integration secrets (sheet connections, chat webhooks, sending domains), sessions, passkeys and MFA — see the portability README.",
    );
    return 0;
  } catch (error) {
    if (error instanceof PortabilityError) {
      console.error(`import refused: ${error.message}`);
      for (const d of error.details) console.error(`  - ${d}`);
      return error.code === "unverified_origin" ? EXPORT_VERIFY_EXIT.unverifiedOrigin : 1;
    }
    throw error;
  } finally {
    await container.queue.stop({ timeoutMs: 5_000 }).catch(() => undefined);
    await container.stop();
  }
}

export async function runWorkspaceVerifyExport(
  argv: readonly string[],
  cfg?: Pick<AppConfig, "keyRing">,
): Promise<number> {
  const [file] = positionals(argv, ["--public-key"]);
  if (file === undefined) {
    console.error(workspaceUsageLine(2));
    return 2;
  }
  const given = flags(argv, "--public-key");
  const trusted =
    given.length > 0
      ? given
      : cfg
        ? exportPublicKeys(cfg.keyRing).map((k) => k.publicKey)
        : undefined;
  const result = await verifyExportFile(resolve(file), { trustedPublicKeys: trusted });
  console.error(formatVerification(result));
  return verificationExitCode(result);
}
