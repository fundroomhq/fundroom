/*
 * Workspace export / import (E2.8, EXECUTION_PLAN §15): the signed `seed-host.workspace-export`
 * v1 zip (manifest + JSONL + blobs + audit trail), its offline verification, and re-import into a
 * new workspace. See README.md.
 */
export { PortabilityError, type PortabilityErrorCode } from "./errors.js";
export {
  type ExportWorkspaceInput,
  type ExportWorkspaceResult,
  exportWorkspace,
  omittedWarnings,
  type PortabilityEngineDeps,
} from "./export.js";
export {
  blobEntryName,
  classifyEntry,
  ENTRY,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORT_OBJECT_PURPOSE,
  EXPORT_SIGNING_PURPOSE,
  EXPORT_VERIFY_EXIT,
  type ExportManifest,
  type ExportPublicKey,
  type ExportSigningKey,
  exportPublicKeys,
  exportSigningKey,
  IMPORT_ARCHIVE_PURPOSE,
  KERNEL_PORTABILITY_VERSION,
  MAX_ENTRY_BYTES,
  type ManifestTable,
  manifestBytes,
  type OmittedSchema,
  signManifest,
  tableEntryName,
  UNVERIFIED_ORIGIN_LINE,
  verifyManifestSignature,
} from "./format.js";
export {
  type ImportDeps,
  type ImportRelocation,
  type ImportWorkspaceInput,
  type ImportWorkspaceResult,
  importWorkspace,
} from "./import.js";
export { BLOB_VALUE_RE, checkImportedKey, collectUuids, scrubForeign } from "./import-guards.js";
export { KERNEL_TABLES, type KernelSpecial, type KernelTable } from "./kernel-tables.js";
export {
  findUndeclared,
  KERNEL_OWNER,
  orderModules,
  type PlannedTable,
  PortabilityPlanError,
  planTables,
} from "./plan.js";
export { IdMap, isUuid, uuidv7 } from "./remap.js";
export { listCatalogTables, makeOwner } from "./repos/portability-repo.js";
export {
  beginDownload,
  createPortabilityJobs,
  deleteExport,
  EXPIRE_JOB,
  EXPORT_HEARTBEAT_MS,
  EXPORT_JOB,
  EXPORT_RETENTION_DAYS,
  EXPORT_STALE_HOURS,
  EXPORT_STALE_MINUTES,
  type ExportRow,
  ExportRunningError,
  ExportStateError,
  expireExports,
  exportObjectKey,
  findExport,
  isStaleExport,
  listExports,
  openExportObject,
  type PortabilityServiceDeps,
  pgConstraintOf,
  purgeExports,
  type RunExportResult,
  requestExport,
  runExport,
  staleCutoffs,
  sweepExportTempFiles,
} from "./service.js";
export {
  type ExportVerification,
  formatVerification,
  manifestShapeProblem,
  type VerifyExportOptions,
  verificationExitCode,
  verifyExportFile,
} from "./verify.js";
export { lines, type ZipEntry, ZipFileReader, ZipFormatError } from "./zip/reader.js";
export { type WrittenEntry, ZipFileWriter } from "./zip/writer.js";
