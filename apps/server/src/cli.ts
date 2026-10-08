#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  formatVerification,
  verifyAllWorkspaces,
  verifyWorkspace,
  writeAllCheckpoints,
} from "@fundroom/audit";
import {
  type AppConfig,
  ConfigError,
  doctorReport,
  formatDoctorReport,
  loadConfig,
  tryLoadConfig,
} from "@fundroom/config";
import { isOwnCellUnavailableError } from "@fundroom/control-plane";
import { createDatabase } from "@fundroom/db";
import { createModuleRegistry } from "@fundroom/module-kit";
import { errorStatus, formatUpdateStatus } from "@fundroom/update-check";
import { generateOpenApiDocument } from "./api.js";
import { createAuditAnchoring } from "./audit-anchoring.js";
import { runAuditAnchor, runAuditVerifyAnchor } from "./cli-commands/audit-anchor.js";
import { runAuditVerifyExport } from "./cli-commands/audit-verify-export.js";
import { BREAK_GLASS_USAGE, runBreakGlass } from "./cli-commands/break-glass.js";
import { CELLS_USAGE, runCells } from "./cli-commands/cells.js";
import { legacyCliNote } from "./cli-commands/cli-name.js";
import { DIRECTORY_USAGE, runDirectory } from "./cli-commands/directory.js";
import { EVIDENCE_USAGE, runEvidence } from "./cli-commands/evidence.js";
import { JOBS_DLQ_USAGE, runJobsDlq } from "./cli-commands/jobs-dlq.js";
import { MOVE_USAGE, runMove } from "./cli-commands/moves.js";
import { OPERATOR_USAGE, runOperator } from "./cli-commands/operator.js";
import { PLANS_USAGE, runPlans } from "./cli-commands/plans.js";
import { runSearchReindex, SEARCH_USAGE } from "./cli-commands/search-reindex.js";
import { runWorkspace } from "./cli-commands/workspace-restore.js";
import { createContainer, createUpdateCheck } from "./container.js";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { canonicalBaseOf } from "./path-mount.js";
import { installSignalHandlers, migrate, startServer } from "./server.js";
import { ensureSecretKey, secretKeyWarning } from "./setup/secret-key.js";
import { applyServeFlags } from "./setup/serve-flags.js";
import { resolveSetupToken, setupTokenBanner } from "./setup/token.js";
import { SERVER_VERSION } from "./version.js";

/*
 * fundroom <command>
 *   serve                 run the configured roles (api, web, worker; `--roles` overrides)
 *   migrate [--dry-run]   apply kernel + module migrations and exit
 *   doctor                validate the environment, print the resolved config (redacted)
 *   setup-token           print the first-run setup token (ADR-0018)
 *   seed-demo [...]       create a synthetic demo workspace (design/07 §7)
 *   openapi [--out f] [--check]   write the OpenAPI 3.1 document (default: packages/sdk/openapi.json)
 *   audit verify|checkpoint [--workspace id] [--from seq]
 *   audit verify-export <bundle.zip> [--public-key b64]   offline check of a signed export (E2.7)
 *   audit anchor | verify-anchor <proof.json>   external anchoring run / offline proof check (E3.13)
 *   workspace restore <id|slug>   undo a soft delete inside its 30-day window (E2.7)
 *   workspace export|import|verify-export   portable workspace zip (E2.8, packages/portability)
 *   search reindex [--workspace x] [--module id]   rebuild the search index (E2.8)
 *   jobs dlq list|retry|discard   the dead-letter queue, for operators (E2.7)
 *   break-glass open|sql|close|list   ticketed, time-boxed, audited BYPASSRLS access (E2.10)
 *   evidence access-reviews|operators|break-glass   SOC 2 evidence as JSON (E2.10)
 *   operator grant|revoke|list   platform operators of the managed-host control plane (E3.10)
 *   cell list|add|set-origin|drain control-plane cells (E3.10)
 *   directory status|sync|migrate the shared cell directory (E3.11)
 *   move list|cancel              moves between cells (E3.11; request: workspace move)
 *   plan list|upsert              control-plane plans (E3.10)
 *   version
 * `serve` and `migrate` are the image's entrypoints (ADR-0001):
 * they generate the master key into DATA_DIR when none is configured (§9.4 step 1).
 * Until the next minor release the CLI also answers to its old name `seedhost` (a second bin,
 * same file) and says so once on stderr.
 */
const USAGE = `usage: fundroom <serve|migrate|doctor|setup-token|seed-demo|openapi|audit|workspace|search|jobs|break-glass|evidence|operator|cell|directory|move|plan|version> [options]
  serve [--roles <csv>]        run ROLES (api,web,worker); --roles overrides the variable
  migrate [--dry-run]          apply migrations and exit
  doctor                       validate env, print resolved config
  setup-token                  print the first-run setup token (while setup is required)
  seed-demo [--slug s] [--name n] [--owner email] [--investors n] [--seed n] [--reset]
  openapi [--out file] [--check]   write the OpenAPI document (or verify it is current)
  audit verify [--workspace <uuid>] [--from <seq>]
  audit checkpoint
  audit anchor
  audit verify-export <bundle.zip> [--public-key <b64>]... [--anchor-cert <pem>]... [--rekor-origin <o>]... [--require-anchors]
  audit verify-anchor <proof.json> [--anchor-cert <pem>]... [--rekor-origin <o>]...
  workspace restore <workspace-id|slug>
  workspace export <slug|id> --out <file.zip> [--include-raw-analytics]
  workspace import <file.zip> --slug <new-slug> [--name <name>] [--public-key <b64>]... [--allow-unverified] [--owner-email <email>]
  workspace verify-export <file.zip> [--public-key <b64>]...
  workspace move <slug> --to <cell-id>
  search reindex [--workspace <slug|id>] [--module <id>]
  jobs dlq list [--workspace <uuid>] [--limit <n>]
  jobs dlq retry|discard <id>
  break-glass open --workspace <slug|id> --ticket <ref> --reason <text> [--minutes <1-60>] [--operator <name>]
  break-glass sql --session <id> (--query <sql> | --file <path>) [--write] [--format json|table] [--max-rows <n>]
  break-glass close --session <id>
  break-glass list [--workspace <slug|id>] [--since <date>] [--json]
  evidence access-reviews [--workspace <slug|id>] [--since <date>]
  evidence operators [--since <date>]
  evidence break-glass [--since <date>]
  operator grant|revoke <email>
  operator list [--json]
  cell list [--json]
  cell add <id> --region <region> --origin <https-origin>
  cell set-origin <id> <https-origin|"">
  cell drain <id>
  directory status [--json]
  directory sync
  directory migrate
  move list [--state <state>] [--workspace <uuid>] [--json]
  move cancel <move-id>
  plan list [--json]
  plan upsert <id> --name <name> [--limits <json>] [--modules <ids|all|none>]
              [--features <ids|all|none>] [--price <ref>] [--trial-days <n>] [--public]
  version`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Loads config for the process entrypoints. `bootstrap` first resolves the master key from
 * DATA_DIR (generating it on a fresh volume) so `docker compose up` works with no secrets set.
 */
function config(options: { bootstrap?: boolean } = {}): AppConfig {
  if (options.bootstrap) {
    const action = ensureSecretKey({ env: process.env });
    if (action.action === "generated") console.error(secretKeyWarning(action.path));
    else if (action.action === "unavailable" && process.env["APP_ENV"] !== "dev") {
      console.error(`no master key configured and none could be generated (${action.reason})`);
    }
  }
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

const DEFAULT_OPENAPI_OUT = new URL("../../../packages/sdk/openapi.json", import.meta.url);

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  // Every command that loads config finds the key `serve` generated into DATA_DIR; only the
  // bootstrap commands (see `config({ bootstrap: true })`) may create one.
  ensureSecretKey({ env: process.env, generate: false });
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      return 0;
    case "version":
      console.error(SERVER_VERSION);
      return 0;
    case "serve": {
      const flagError = applyServeFlags(rest, process.env);
      if (flagError) {
        console.error(flagError);
        return 2;
      }
      const cfg = config({ bootstrap: true });
      const logger = createLogger({
        level: cfg.raw.LOG_LEVEL,
        service: cfg.raw.OTEL_SERVICE_NAME,
        version: SERVER_VERSION,
      });
      const running = await startServer({ config: cfg, logger, modules: COMPILED_IN_MODULES });
      await installSignalHandlers(running, logger);
      return 0;
    }
    case "migrate": {
      const cfg = config({ bootstrap: true });
      const logger = createLogger({
        level: cfg.raw.LOG_LEVEL,
        service: cfg.raw.OTEL_SERVICE_NAME,
        version: SERVER_VERSION,
      });
      if (rest.includes("--dry-run")) {
        const { coreMigrationSource, migrationStatus } = await import("@fundroom/db");
        const registry = createModuleRegistry(COMPILED_IN_MODULES, { only: cfg.modules });
        const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 1 });
        try {
          const plan = await migrationStatus(db.pool, [
            coreMigrationSource,
            ...registry.migrationSources,
          ]);
          console.error(`applied: ${plan.appliedCount}, pending: ${plan.steps.length}`);
          for (const s of plan.steps) console.error(`  pending ${s.module}/${s.migration.name}`);
          for (const p of plan.problems)
            console.error(`  problem ${p.module}/${p.name}: ${p.problem}`);
          return plan.problems.length === 0 ? 0 : 1;
        } finally {
          await db.close();
        }
      }
      await migrate(cfg, logger, COMPILED_IN_MODULES);
      return 0;
    }
    case "setup-token": {
      const cfg = config({ bootstrap: true });
      // E-UP-11: the wizard and its token are off under the control plane.
      if (cfg.raw.CONTROL_PLANE === "on") {
        console.error(
          "first-run setup is off under the control plane (CONTROL_PLANE=on): there is no setup token. Workspaces come from signup or the operator API (POST /api/v1/platform/workspaces).",
        );
        return 1;
      }
      const logger = createLogger({ level: "warn", service: cfg.raw.OTEL_SERVICE_NAME });
      const container = createContainer({ config: cfg, logger, modules: COMPILED_IN_MODULES });
      try {
        if (!(await container.setupGate.required())) {
          console.error("setup is complete: a workspace already exists. Sign in at the portal.");
          return 1;
        }
        const token = resolveSetupToken({
          configured: cfg.raw.SETUP_TOKEN,
          dataDir: cfg.raw.DATA_DIR,
        });
        if (token.source === "generated" && token.path === undefined) {
          console.error(
            `no SETUP_TOKEN and ${cfg.raw.DATA_DIR} is not writable: the token is only in the running server's logs (look for "first-run setup").`,
          );
          return 1;
        }
        console.error(setupTokenBanner(token, `${canonicalBaseOf(cfg.baseUrl)}/setup`));
        return 0;
      } finally {
        await container.stop();
      }
    }
    case "seed-demo": {
      const cfg = config({ bootstrap: true });
      const logger = createLogger({
        level: cfg.raw.LOG_LEVEL,
        service: cfg.raw.OTEL_SERVICE_NAME,
        version: SERVER_VERSION,
      });
      if (cfg.isProduction && !rest.includes("--yes")) {
        console.error(
          "seed-demo in APP_ENV=prod creates synthetic investors on a real install; pass --yes to confirm.",
        );
        return 2;
      }
      const container = createContainer({ config: cfg, logger, modules: COMPILED_IN_MODULES });
      try {
        const investors = flag(rest, "--investors");
        const seed = flag(rest, "--seed");
        const result = await seedDemo(container, {
          slug: flag(rest, "--slug"),
          name: flag(rest, "--name"),
          ownerEmail: flag(rest, "--owner"),
          investors: investors === undefined ? undefined : Number(investors),
          seed: seed === undefined ? undefined : Number(seed),
          reset: rest.includes("--reset"),
        });
        console.error(
          `seeded workspace ${result.slug} (${result.workspaceId}): owner ${result.owner}, ${result.staff} staff, ${result.investorsActive} active investors, ${result.investorsInvited} invited. Sign in with an email code sent to the owner address (see the mailer logs / Mailpit).`,
        );
        return 0;
      } catch (error) {
        return ownCellRefused(error);
      } finally {
        await container.stop();
      }
    }
    case "doctor": {
      const result = tryLoadConfig();
      if (!result.ok) {
        console.error(result.error.message);
        return 2;
      }
      console.error(`FundRoom ${SERVER_VERSION}`);
      console.error(formatDoctorReport(doctorReport(result.config, result.sources)));
      // Informational only (design/07 §4.4): an offline host or a CDN outage must never turn a
      // healthy config into a failing doctor, so this line cannot change the exit code.
      const update = createUpdateCheck(result.config.raw, { log: () => {} });
      try {
        console.error(formatUpdateStatus(await update.checker.check()));
      } catch {
        console.error(formatUpdateStatus(errorStatus(SERVER_VERSION, new Date())));
      } finally {
        await update.close().catch(() => {});
      }
      return 0;
    }
    case "openapi": {
      const registry = createModuleRegistry(COMPILED_IN_MODULES, {
        only: process.env["MODULES"]?.split(",").filter(Boolean),
      });
      const doc = generateOpenApiDocument(registry);
      const json = `${JSON.stringify(doc, null, 2)}\n`;
      const out = flag(rest, "--out");
      const target = out === undefined ? DEFAULT_OPENAPI_OUT : resolve(out);
      if (rest.includes("--check")) {
        // Compare documents, not bytes: the committed file is formatted by Biome.
        let current: unknown;
        try {
          current = JSON.parse(readFileSync(target, "utf8"));
        } catch {
          current = undefined;
        }
        if (JSON.stringify(current) !== JSON.stringify(doc)) {
          console.error(
            `OpenAPI document is stale: run \`pnpm --filter @fundroom/server openapi\` and commit ${String(target)}`,
          );
          return 1;
        }
        console.error("OpenAPI document is current");
        return 0;
      }
      mkdirSync(dirname(typeof target === "string" ? target : target.pathname), {
        recursive: true,
      });
      writeFileSync(target, json);
      console.error(`wrote ${String(target)} (${Object.keys(doc.paths ?? {}).length} paths)`);
      return 0;
    }
    case "audit": {
      const [sub = "help", ...args] = rest;
      // Offline: a bundle handed to counsel is checked without a database, and without config
      // at all when the key ring is not loadable here (it then checks only the bundle's own key).
      if (sub === "verify-export") {
        const loaded = tryLoadConfig();
        return runAuditVerifyExport(args, loaded.ok ? loaded.config : undefined);
      }
      // E3.13: offline, like verify-export — a proof handed to a third party needs no config.
      if (sub === "verify-anchor") return runAuditVerifyAnchor(args);
      const cfg = config();
      const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
      try {
        if (sub === "verify") {
          const ws = flag(args, "--workspace");
          const from = flag(args, "--from");
          const anchoring = createAuditAnchoring({ config: cfg });
          try {
            const opts = {
              db,
              keyRing: cfg.keyRing,
              anchorDrivers: anchoring.drivers,
              anchorVerifiers: anchoring.verifiers,
              ...(from ? { fromSeq: Number(from) } : {}),
            };
            const results = ws
              ? [await verifyWorkspace(opts, ws)]
              : await verifyAllWorkspaces(opts);
            console.error(formatVerification(results));
            return results.every((r) => r.ok) ? 0 : 1;
          } finally {
            await anchoring.close();
          }
        }
        if (sub === "anchor") return await runAuditAnchor(cfg, db);
        if (sub === "checkpoint") {
          const results = await writeAllCheckpoints({
            db,
            keyRing: cfg.keyRing,
            log: (e, f) => console.error(e, JSON.stringify(f ?? {})),
          });
          for (const r of results) console.error(`${r.workspaceId} ${r.status} seq=${r.seq}`);
          return 0;
        }
        console.error(
          "usage: fundroom audit <verify|checkpoint|anchor|verify-export|verify-anchor> [--workspace <uuid>] [--from <seq>]",
        );
        return 2;
      } finally {
        await db.close();
      }
    }
    case "workspace": {
      // `verify-export` is offline like `audit verify-export`: no database, config optional.
      if (rest[0] === "verify-export") {
        const loaded = tryLoadConfig();
        return runWorkspace(rest, loaded.ok ? loaded.config : undefined);
      }
      try {
        return await runWorkspace(rest, config());
      } catch (error) {
        return ownCellRefused(error);
      }
    }
    case "search":
      if (rest[0] !== "reindex") {
        console.error(SEARCH_USAGE);
        return 2;
      }
      return runSearchReindex(rest, config());
    case "jobs": {
      const [sub, ...args] = rest;
      if (sub !== "dlq") {
        console.error(JOBS_DLQ_USAGE);
        return 2;
      }
      return runJobsDlq(args, config());
    }
    case "break-glass":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(BREAK_GLASS_USAGE);
        return 2;
      }
      return runBreakGlass(rest, config());
    case "evidence":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(EVIDENCE_USAGE);
        return 2;
      }
      return runEvidence(rest, config());
    // Managed-host control plane (E3.10).
    case "operator":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(OPERATOR_USAGE);
        return 2;
      }
      return runOperator(rest, config());
    case "cell":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(CELLS_USAGE);
        return 2;
      }
      return runCells(rest, config());
    case "directory":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(DIRECTORY_USAGE);
        return 2;
      }
      return runDirectory(rest, config());
    case "move":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(MOVE_USAGE);
        return 2;
      }
      return runMove(rest, config());
    case "plan":
      if (rest[0] === undefined || rest[0] === "help" || rest[0] === "--help") {
        console.error(PLANS_USAGE);
        return 2;
      }
      return runPlans(rest, config());
    default:
      console.error(`unknown command ${command}\n${USAGE}`);
      return 2;
  }
}

/**
 * E-UP-13: this process's own cell cannot take a new workspace (no `core.cell` row, or draining).
 * An operator fact with a one-line fix, so its message and exit 1, not a stack trace.
 */
function ownCellRefused(error: unknown): number {
  if (!isOwnCellUnavailableError(error)) throw error;
  console.error(error.message);
  return 1;
}

const renamed = legacyCliNote(process.argv[1]);
if (renamed !== undefined) console.error(renamed);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
    // A failed start must exit, not hang (E-UP-10): force it if a handle survived cleanup.
    setTimeout(() => process.exit(1), 10_000).unref();
  },
);
