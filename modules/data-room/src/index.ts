import {
  defineModule,
  isLiveModuleServices,
  type ModuleManifest,
  type ModuleServices,
} from "@fundroom/module-kit";
import { dataRoomDsar } from "./dsar.js";
import { createDocumentListHydrator } from "./hydrator.js";
import { createDataRoomJobs } from "./jobs.js";
import { dataRoomPortability } from "./portability.js";
import { createQaAnswerTask } from "./qa/ai/task.js";
import { createQaErasureHandler } from "./qa/erasure.js";
import { registerDataRoomRawRoutes } from "./raw-routes.js";
import { registerDataRoomRoutes } from "./routes.js";
import { dataRoomSearch } from "./service/search.js";
import { createVaultHandler } from "./service/vault.js";
import { dataRoomUsage } from "./usage.js";

/*
 * The data room (E1.3, ADR-0034): folders with index numbering, the upload pipeline
 * (quarantine → scan → sanitise → encrypt → render), versions, protection, the secure
 * viewer's page images and watermarked downloads, legal hold, recycle bin + purge,
 * folder templates. Hidden from investors while the workspace is `informational` (ADR-0019).
 */
let hydratorServices: Parameters<typeof createDocumentListHydrator>[0] | undefined;
/** Live services for event handlers (captured from `routes` / `jobs`, never the contract stub). */
let registeredServices: ModuleServices | undefined;

function captureServices(services: ModuleServices): void {
  if (isLiveModuleServices(services)) registeredServices = services;
}

function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("data-room services are not registered");
  return registeredServices;
}

export const dataRoomModule: ModuleManifest = defineModule({
  id: "data-room",
  version: "0.1.0",
  dsar: dataRoomDsar,
  dependsOn: ["access", "content"],
  schema: "dataroom",
  migrations: new URL("../migrations/", import.meta.url),
  permissions: [
    "data-room.read",
    "data-room.manage",
    "data-room.download",
    "data-room.legal_hold",
    "data-room.settings",
    // E3.3 Q&A: expert, coordinator, approver (the inbox itself is `data-room.read`)
    "data-room.qa_answer",
    "data-room.qa_manage",
    "data-room.qa_approve",
    // E3.13: trace a leaked page image to its recipient (forensic watermark detection)
    "data-room.forensics",
  ],
  resourceKinds: {
    folder: {
      staff: { view: "data-room.read", download: "data-room.download", edit: "data-room.manage" },
    },
    document: {
      staff: { view: "data-room.read", download: "data-room.download", edit: "data-room.manage" },
    },
  },
  routes: (api, services) => {
    // See the note in `modules/content/src/index.ts`: this callback also runs against the
    // throwing stub whenever the contract is fetched, and capturing that stub would leave
    // `document_list` blocks reporting `hydration_failed` until the process restarts.
    if (isLiveModuleServices(services)) hydratorServices = services;
    captureServices(services);
    registerDataRoomRoutes(api, services);
  },
  rawRoutes: registerDataRoomRawRoutes,
  jobs: (services) => {
    captureServices(services);
    return createDataRoomJobs(services);
  },
  search: dataRoomSearch,
  // E3.12: AI assist's suggested Q&A answer (sources bounded by what the asker may view).
  aiTasks: (services) => [createQaAnswerTask(services)],
  portability: dataRoomPortability,
  usage: dataRoomUsage,
  events: {
    emits: [
      "document.viewed",
      "document.downloaded",
      "document.ingested",
      "qa.question_asked",
      "qa.question_assigned",
      "qa.answer_submitted",
      "qa.answer_released",
      "qa.question_declined",
      "qa.question_due",
      "document.vaulted",
    ],
    handles: {
      // E3.3: DSAR erasure of a member's Q&A questions (not gated on enablement).
      "member.erasure_requested": createQaErasureHandler(liveServices),
      // E3.5: vault a completed envelope's signed artifacts (the job checks enablement).
      "esign.envelope_completed": createVaultHandler(liveServices),
    },
  },
  blockHydrators: [
    {
      type: "document_list",
      hydrate(data, ctx) {
        if (hydratorServices === undefined) throw new Error("data-room routes not registered");
        return createDocumentListHydrator(hydratorServices).hydrate(data, ctx);
      },
    },
  ],
  slots: {
    "investor.nav": [
      { id: "data-room", label: "Data room", to: "/data-room", order: 20, icon: "folder" },
    ],
    "admin.nav": [
      {
        id: "data-room-admin",
        label: "Data room",
        to: "/admin/data-room",
        order: 30,
        icon: "folder",
      },
    ],
    // E2.7: the settings hub (`/admin/settings`) lists every manifest's `admin.settings` entries.
    "admin.settings": [
      {
        id: "data-room-settings",
        label: "Data room",
        to: "/admin/data-room/settings",
        order: 41,
        icon: "folder",
      },
    ],
    "content.blocks": ["document_list"],
  },
  offeringStatusRules: { hiddenWhen: ["informational"] },
  webhooks: ["document.viewed", "document.downloaded", "qa.question_asked", "qa.answer_released"],
});

export default dataRoomModule;

export * from "./contracts.js";
export { dataRoomDsar } from "./dsar.js";
export { type Actor, DataRoomError, type DataRoomErrorCode } from "./errors.js";
export {
  createDataRoomJobs,
  JOB_INGEST,
  JOB_PURGE,
  JOB_QA_SLA,
  JOB_RECONCILE,
  JOB_VAULT,
} from "./jobs.js";
export * from "./model.js";
export { dataRoomPortability, PORTABILITY_VERSION } from "./portability.js";
export * from "./qa/contracts.js";
export { createQaErasureHandler } from "./qa/erasure.js";
export {
  LEGACY_QA_EXPORT_TRUNCATED_HEADER,
  QA_EXPORT_ONLY_COLUMNS,
  QA_EXPORT_TRUNCATED_HEADER,
  QA_IMPORT_BODY_LIMIT_BYTES,
} from "./qa/io-routes.js";
export { type QaSlaSummary, runQaSla } from "./qa/jobs.js";
export * from "./qa/rules.js";
export {
  indexQuestion,
  indexQuestions,
  QA_SEARCH_KIND,
  qaEntry,
  qaSearchEnabled,
  unindexQuestion,
} from "./qa/search.js";
export * from "./qa/view.js";
export {
  createAccess,
  loadVeil,
  VEILED,
  type Veil,
  type Viewer,
  veilOf,
} from "./service/access.js";
export { createDeliveryService, type DeliveryService, PAGE_WIDTH } from "./service/delivery.js";
export {
  type Availability,
  blobServable,
  createDocumentService,
  type DocumentDetail,
  type DocumentService,
} from "./service/documents.js";
export {
  computeIndexes,
  createFolderService,
  type FolderService,
  type Tree,
} from "./service/folders.js";
export {
  BlobNotReadyError,
  createDocumentFromStaged,
  discardStaged,
  type FromBytesInput,
  type FromBytesResult,
  type StagedBytes,
  stageBytes,
} from "./service/from-bytes.js";
export { createIngestService, type IngestService } from "./service/ingest.js";
export { createMaintenanceService, type MaintenanceService } from "./service/maintenance.js";
export {
  createSearchIndexer,
  dataRoomSearch,
  documentEntry,
  folderEntry,
  SEARCH_MODULE,
  SEARCH_VERSION,
  type SearchIndexer,
} from "./service/search.js";
export { createUploadService, type UploadService } from "./service/uploads.js";
export {
  createVaultHandler,
  createVaultService,
  type EnsuredVaultFolder,
  ensureVaultFolder,
  VAULT_MAX_SEGMENTS,
  VAULT_PROTECTION,
  type VaultFolder,
  type VaultFolderOps,
  type VaultOutcome,
  type VaultService,
  type VaultTitles,
  vaultFolderOf,
  vaultPathSegments,
  vaultTitles,
} from "./service/vault.js";
