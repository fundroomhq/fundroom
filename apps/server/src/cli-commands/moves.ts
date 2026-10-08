import type { AppConfig } from "@fundroom/config";
import {
  type ControlPlaneActor,
  cancelMove,
  listMoves,
  type MoveDeps,
  MoveError,
  type MoveView,
  requestMove,
} from "@fundroom/control-plane";
import { findWorkspaceBySlug } from "@fundroom/db";
import { MOVE_STATES, type MoveState } from "@fundroom/ports";
import { createContainer } from "../container.js";
import { createLogger } from "../logger.js";
import { COMPILED_IN_MODULES } from "../modules.js";
import { SERVER_VERSION } from "../version.js";

/*
 * `fundroom workspace move <slug> --to <cell-id>` and `fundroom move list|cancel` (E3.11,
 * ADR-0059; owner C). Operator commands (they need DATABASE_URL and DIRECTORY_DATABASE_URL);
 * audited on the workspace's chain and the platform chain like the operator API, as the system
 * actor with `source: "cli"`. The CLI does not enqueue the export: the worker's minute
 * `move.poll` picks the requested move up. Exit 0 ok, 1 refused / not found, 2 usage.
 */

export const MOVE_USAGE = `usage: fundroom move list [--state <state>] [--workspace <uuid>] [--json]
       fundroom move cancel <move-id>
       fundroom workspace move <slug> --to <cell-id>`;

export const WORKSPACE_MOVE_USAGE = "  move <slug> --to <cell-id>";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface MoveCommandDeps extends MoveDeps {
  /** The OS user, for `requestedBy` (`cli:<user>`). */
  readonly osUser?: string | undefined;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

const CLI_ACTOR: ControlPlaneActor = { kind: "system", source: "cli" };

function line(m: MoveView): string {
  const error = m.error === null ? "" : `  failed at ${m.error.stage}: ${m.error.code}`;
  return `${m.id}  ${m.slug.padEnd(24)} ${m.sourceCellId} (${m.sourceRegion ?? "?"}) → ${m.targetCellId} (${m.targetRegion ?? "?"})  ${m.state.padEnd(9)} ${m.updatedAt}${error}`;
}

function refusal(error: unknown, err: (l: string) => void): number {
  if (error instanceof MoveError) {
    err(
      `refused (${error.code}${error.reason === undefined ? "" : `: ${error.reason}`}): ${error.message}`,
    );
    return 1;
  }
  throw error;
}

/** `fundroom move …` on injected deps (tests call this directly). */
export async function moveCommand(argv: readonly string[], deps: MoveCommandDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const [sub, id] = argv;
  try {
    if (sub === "list") {
      const state = flag(argv, "--state");
      if (state !== undefined && !(MOVE_STATES as readonly string[]).includes(state)) {
        err(MOVE_USAGE);
        return 2;
      }
      const workspaceId = flag(argv, "--workspace");
      const items = await listMoves(deps, {
        workspaceId,
        state: state as MoveState | undefined,
      });
      if (argv.includes("--json")) out(JSON.stringify(items, null, 2));
      else for (const m of items) out(line(m));
      return 0;
    }
    if (sub === "cancel" && id !== undefined && UUID_RE.test(id)) {
      const m = await cancelMove(deps, id.toLowerCase(), CLI_ACTOR);
      out(line(m));
      return 0;
    }
  } catch (error) {
    return refusal(error, err);
  }
  err(MOVE_USAGE);
  return 2;
}

/** `fundroom workspace move <slug> --to <cell-id>` on injected deps. */
export async function workspaceMoveCommand(
  argv: readonly string[],
  deps: MoveCommandDeps,
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const [slug] = argv;
  const to = flag(argv, "--to");
  if (slug === undefined || slug.startsWith("--") || to === undefined) {
    err(`usage: fundroom workspace${WORKSPACE_MOVE_USAGE}`);
    return 2;
  }
  const ws = await findWorkspaceBySlug(deps.db, slug.toLowerCase());
  if (ws === undefined) {
    err(`no live workspace ${slug}`);
    return 1;
  }
  try {
    const m = await requestMove(deps, {
      workspaceId: ws.id,
      targetCellId: to,
      // The operator typed the slug: that is the confirmation.
      confirmSlug: slug,
      actor: CLI_ACTOR,
      requestedBy: `cli:${deps.osUser ?? "operator"}`,
    });
    out(line(m));
    err(
      "requested: the workspace is held now; members sign in again on the target (sessions, passwords, MFA, API keys, webhooks and vendor connections are not carried; custom domains need re-verification).",
    );
    return 0;
  } catch (error) {
    return refusal(error, err);
  }
}

async function withContainer(
  config: AppConfig,
  fn: (deps: MoveCommandDeps) => Promise<number>,
): Promise<number> {
  const logger = createLogger({ level: config.raw.LOG_LEVEL, version: SERVER_VERSION });
  const container = createContainer({ config, logger, modules: COMPILED_IN_MODULES });
  try {
    return await fn({
      db: container.db,
      audit: container.audit,
      directory: container.directory,
      cellId: config.raw.CELL_ID,
      invalidate: () => container.resolver.invalidate(),
      canPresign: container.storage.capabilities.presignedGet,
      storage: container.storage,
      osUser: process.env["USER"],
    });
  } finally {
    await container.stop();
  }
}

export function runMove(argv: readonly string[], config: AppConfig): Promise<number> {
  return withContainer(config, (deps) => moveCommand(argv, deps));
}

export function runWorkspaceMove(argv: readonly string[], config: AppConfig): Promise<number> {
  return withContainer(config, (deps) => workspaceMoveCommand(argv, deps));
}
