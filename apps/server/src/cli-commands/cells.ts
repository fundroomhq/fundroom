import { type AuditRecorder, createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import {
  addCell,
  CellInputError,
  drainCell,
  listCells,
  setCellOrigin,
} from "@fundroom/control-plane";
import { createDatabase, type Database } from "@fundroom/db";

export const CELLS_USAGE = `usage: fundroom cell list [--json]
       fundroom cell add <id> --region <region> --origin <https-origin> [--label <text>] [--jurisdiction eu|uk|ch|us|ca|au|other]
       fundroom cell set-origin <id> <https-origin|"">
       fundroom cell drain <id>`;

/*
 * fundroom cell list|add|set-origin|drain (E3.10, ADR-0058; owner: agent A). `core.cell` rows; audited
 * `cell.add` / `cell.update` on the platform chain. Exit 0 ok, 1 not found, 2 usage.
 *
 * E3.11: `add` takes the region's human label and jurisdiction, and with DATA_REGION set the
 * region must equal it (one database = one region; a cell elsewhere is another deployment).
 *
 * A cell is where a workspace is served (`core.workspace.cell_id`); a process serves the one its
 * `CELL_ID` names and answers 421 `wrong_cell` for the others. `drain` stops new placements on a
 * cell (provisioning and the operator's cell change refuse it); its workspaces stay until moved.
 *
 * E-UP-13 fix round 1: `set-origin` corrects a cell's public origin — notably the own cell's row
 * the server creates at start-up from BASE_URL, which `add` cannot touch (the id exists). Same
 * validation as `add`; `""` means this install. Audited `cell.update`. Only the origin: a region
 * never changes, and the label and jurisdiction follow DATA_REGION_LABEL / _JURISDICTION at boot.
 */

export interface CellsCommandDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** DATA_REGION (E3.11). */
  readonly dataRegion?: string | undefined;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

/** The command itself, on injected deps (tests call this directly). */
export async function cellsCommand(
  argv: readonly string[],
  deps: CellsCommandDeps,
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const [sub, id] = argv;
  try {
    switch (sub) {
      case "list": {
        const cells = await listCells(deps.db);
        if (argv.includes("--json")) {
          out(JSON.stringify(cells, null, 2));
          return 0;
        }
        for (const c of cells) {
          out(
            `${c.id.padEnd(24)} ${c.status.padEnd(9)} ${c.region.padEnd(16)} ${(c.jurisdiction ?? "-").padEnd(6)} ${String(c.workspaces).padStart(6)} workspace(s)  ${c.publicOrigin === "" ? "(this install)" : c.publicOrigin}${c.regionLabel === "" ? "" : `  ${c.regionLabel}`}`,
          );
        }
        return 0;
      }
      case "add": {
        const region = flag(argv, "--region");
        const origin = flag(argv, "--origin");
        if (id === undefined || id.startsWith("--") || region === undefined || origin === undefined)
          break;
        const regionLabel = flag(argv, "--label");
        const jurisdiction = flag(argv, "--jurisdiction");
        if (argv.includes("--label") && regionLabel === undefined) break;
        if (argv.includes("--jurisdiction") && jurisdiction === undefined) break;
        const row = await addCell(deps, {
          id,
          region,
          publicOrigin: origin,
          regionLabel,
          jurisdiction,
        });
        if (row === undefined) {
          err(`a cell "${id}" exists already`);
          return 1;
        }
        out(
          `added: ${row.id} (${row.region}${row.jurisdiction === null ? "" : `/${row.jurisdiction}`}, ${row.publicOrigin})`,
        );
        return 0;
      }
      case "set-origin": {
        const origin = argv[2];
        if (id === undefined || id.startsWith("--") || origin === undefined) break;
        const row = await setCellOrigin(deps, id, origin);
        if (row === undefined) {
          err(`no such cell: ${id}`);
          return 1;
        }
        out(
          `origin: ${row.id} ${row.publicOrigin === "" ? "(this install)" : row.publicOrigin} (a shared directory has it at the next heartbeat, or run: fundroom directory sync)`,
        );
        return 0;
      }
      case "drain": {
        if (id === undefined || id.startsWith("--")) break;
        const row = await drainCell(deps, id);
        if (row === undefined) {
          err(`no such cell: ${id}`);
          return 1;
        }
        out(`draining: ${row.id} (no new workspaces are placed there)`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CellInputError) {
      err(`${error.field}: ${error.message}`);
      return 2;
    }
    throw error;
  }
  err(CELLS_USAGE);
  return 2;
}

export async function runCells(argv: readonly string[], config: AppConfig): Promise<number> {
  const db = createDatabase({ connectionString: config.raw.DATABASE_URL, poolMax: 2 });
  try {
    return await cellsCommand(argv, {
      db,
      audit: createAuditService({ db, truncateIp: config.raw.AUDIT_IP_TRUNCATE }),
      dataRegion: config.raw.DATA_REGION,
    });
  } finally {
    await db.close();
  }
}
