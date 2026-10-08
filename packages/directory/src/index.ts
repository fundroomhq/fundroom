/**
 * @fundroom/directory — the shared cell directory (EXECUTION_PLAN §15 E3.11, ADR-0059). See
 * `DirectoryPort` in `@fundroom/ports` for the contract and the two modes.
 */
export { directoryHostname } from "./hostname.js";
export { createLocalDirectory, type LocalDirectoryOptions } from "./local.js";
export { directoryMigrationSource } from "./migrations.js";
export {
  type PublishCellsInput,
  publishLocalCells,
  RESERVATION_TTL_MS,
  type ReconcileInput,
  type ReconcileLog,
  type ReconcileReport,
  reconcileDirectory,
} from "./reconcile.js";
export type { EntryRow as DirectoryEntryRow } from "./repos/shared-repo.js";
export {
  createDirectoryRouting,
  type DirectoryRoute,
  type DirectoryRouting,
  type DirectoryRoutingOptions,
  ROUTING_BUDGET,
  ROUTING_BUDGET_WINDOW_MS,
  ROUTING_CACHE_MAX,
  ROUTING_TTL_MS,
} from "./routing.js";
export {
  createSharedDirectory,
  type EnsureEntryResult,
  isSharedDirectory,
  type SharedDirectory,
  type SharedDirectoryOptions,
} from "./shared.js";
