import { ApiError } from "@fundroom/contracts";
import type { Database } from "@fundroom/db";
import type { DirectoryMoves, DirectoryPort } from "@fundroom/ports";
import { listLocalCells } from "./repos/local-cells-repo.js";

/*
 * `local` mode (no DIRECTORY_DATABASE_URL): every self-host and every E3.10 install. A thin
 * adapter over this database's own `core.cell` / `core.workspace`: claims always succeed (the
 * local unique indexes stay the judge, exactly as before E3.11), lookups return null (there is no
 * other cell to route to), the lifecycle calls are no-ops, and moves are unavailable.
 */

function unavailable(): never {
  throw new ApiError("move_unavailable", "moves between cells need a shared cell directory", {
    reason: "no_directory",
  });
}

const localMoves: DirectoryMoves = {
  request: async () => unavailable(),
  get: async () => unavailable(),
  list: async () => unavailable(),
  transition: async () => unavailable(),
  acquireLease: async () => unavailable(),
  heartbeat: async () => unavailable(),
  switchover: async () => unavailable(),
};

export interface LocalDirectoryOptions {
  /** The cell database (host context reads `core.cell`). */
  readonly db: Database;
}

export function createLocalDirectory(options: LocalDirectoryOptions): DirectoryPort {
  return {
    mode: "local",
    listCells: () => listLocalCells(options.db),
    publishCell: async () => {},
    lookupSlug: async () => null,
    lookupHost: async () => null,
    lookupWorkspace: async () => null,
    claimSlug: async () => "claimed",
    activate: async () => {},
    renameSlug: async () => "renamed",
    release: async () => {},
    setState: async () => {},
    claimHost: async () => "claimed",
    releaseHost: async () => {},
    moves: localMoves,
    close: async () => {},
  };
}
