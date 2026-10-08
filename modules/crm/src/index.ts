import {
  defineModule,
  isLiveModuleServices,
  type ModuleManifest,
  type ModuleServices,
} from "@fundroom/module-kit";
import { crmDsar } from "./dsar.js";
import { createCrmHandlers } from "./handlers.js";
import { crmPortability } from "./portability.js";
import { registerCrmRoutes } from "./routes.js";

/*
 * CRM-lite (E2.5, EXECUTION_PLAN §15, design/03 §82, design/06 §7, ADR-0024, ADR-0043): the
 * relationships behind a raise — who the company has spoken to, which firm they are from, where
 * each conversation stands, and what was said. Contacts that need no login, organisations, a
 * per-round pipeline with a ladder the tenant owns, notes and tasks.
 *
 * **Two modules, not one** (E2.5 D1). The obvious packaging would have put this inside `round`,
 * since the board exists to run a raise. It is the wrong cut for a reason that shows up
 * immediately in the offering rules: `round` is `disabledWhen: ["none", "informational"]` — a
 * workspace that is not raising must not have a round page at all — while a CRM is exactly what
 * a founder uses *before* there is anything to offer. Tracking relationships is not soliciting
 * one, so this manifest carries no `offeringStatusRules` whatsoever, and a workspace in
 * `informational` mode runs the whole board with the round module switched off underneath it.
 *
 * `dependsOn: ["access"]` and nothing else. In particular **not** `round`: the coupling between
 * the two is one-way and runs entirely over the outbox (`handlers.ts`). This module never
 * imports the round module, never reads `round.*`, and holds `commitment_id` as a bare uuid —
 * which is also why `round.commitment` can stay the single system of record for money (D2) while
 * a card's `amount` is only ever a forecast.
 *
 * `defaultEnabled: false` (design/03 §157 lists CRM among the things that are off): a workspace
 * that never opens the board should not carry seven tables and a stage ladder.
 *
 * There is no `content.blocks` entry and no hydrator, and that absence is the requirement rather
 * than an oversight. Every RLS policy in the `crm` schema admits staff and system and nobody
 * else — "only company staff see CRM" (design/03 §82) — so there is no viewer-safe projection of
 * any of this to put on an investor-facing page.
 */

/*
 * `services` is captured when the routes are mounted, the way `modules/metrics` does it: the
 * manifest is a value, so the outbox subscribers declared *on* it cannot be handed the
 * composition root any earlier.
 *
 * `isLiveModuleServices` is what keeps the capture honest. `generateOpenApiDocument()` builds a
 * second API app against `stubDeps()`, whose `ModuleServices` is a Proxy that throws on every
 * property read, and it runs on each `GET /api/v1/openapi.json` — i.e. at runtime, on a live
 * server. Capturing unconditionally would let one request for the contract replace the real
 * services with the throwing stub, and the next `round.commitment_changed` would fail to move a
 * card.
 */
let registeredServices: ModuleServices | undefined;

function captureServices(services: ModuleServices): void {
  if (!isLiveModuleServices(services)) return;
  registeredServices = services;
}

function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("crm routes are not registered");
  return registeredServices;
}

export const crmModule: ModuleManifest = defineModule({
  id: "crm",
  version: "0.1.0",
  dsar: crmDsar,
  dependsOn: ["access"],
  schema: "crm",
  migrations: new URL("../migrations/", import.meta.url),
  defaultEnabled: false,
  permissions: ["crm.read", "crm.manage"],
  portability: crmPortability,
  routes: (api, services) => {
    captureServices(services);
    registerCrmRoutes(api, services);
  },
  /*
   * Subscribes to four of the round module's topics — plus the kernel's
   * `member.erasure_requested` (E2.6), which pseudonymises a member's contact and deletes what
   * staff wrote about them, and `integration.booking_recorded` (E3.6), which logs a booked,
   * moved or cancelled meeting on the contact it is about — and emits none of its own. The CRM is a
   * *reader* of what happened elsewhere: nothing that moves a card is news to anybody but this
   * board, and a `crm.pipeline_item_moved` topic would be an event with no subscriber and a
   * permanent invitation for one module to start reading another's business.
   */
  events: { handles: createCrmHandlers(liveServices) },
  slots: {
    // 37, straight after Round (36). The two are read together — an admin looks at the board and
    // then at the allocation tracker — and a CRM item on the investor nav would be a category
    // error: externals have no CRM surface at all.
    "admin.nav": [{ id: "crm-admin", label: "CRM", to: "/admin/crm", order: 37, icon: "crm" }],
  },
});

export default crmModule;

export * from "./contracts.js";
export { crmDsar } from "./dsar.js";
export { type Actor, CrmError, type CrmErrorCode } from "./errors.js";
export { createCrmHandlers } from "./handlers.js";
export {
  ACTIVITY_FOR_BOOKING_STATUS,
  ACTIVITY_KINDS,
  ACTIVITY_LIST_LIMIT,
  type ActivityKind,
  CUSTOM_STAGE_PREFIX,
  customStageKey,
  DEFAULT_STAGE_KEYS,
  DEFAULT_STAGES,
  NO_ROUND,
  ORGANIZATION_KINDS,
  type OrganizationKind,
  PROTECTED_STAGE_KEYS,
  STAGE_FOR_COMMITMENT_STATUS,
  STAGE_KEY_RE,
  STAGE_ON_COMMITMENT,
  STAGE_ON_DECLINED,
  STAGE_ON_INTEREST,
  type StageSeed,
  SUBJECT_KINDS,
  type SubjectKind,
  TRANSITION_CAUSES,
  type TransitionCause,
} from "./model.js";
export { crmPortability } from "./portability.js";
export {
  ActivityRepo,
  type ActivityRow,
  type ContactPatch,
  ContactRepo,
  type ContactRow,
  ERASED_CONTACT_NAME,
  type ErasureCounts,
  ErasureRepo,
  type NewBookingActivity,
  type NewContact,
  type NewOrganization,
  type NewPipelineItem,
  type NewTransition,
  NoteRepo,
  type NoteRow,
  type OrganizationPatch,
  OrganizationRepo,
  type OrganizationRow,
  type Page,
  type PipelineItemPatch,
  type PipelineItemRow,
  PipelineRepo,
  type RoundFilter,
  StageRepo,
  type StageRow,
  type StageWrite,
  type TaskPatch,
  TaskRepo,
  type TaskRow,
  TransitionRepo,
  type TransitionRow,
} from "./repos/crm-repo.js";
export { PERM_MANAGE, PERM_READ, registerCrmRoutes } from "./routes.js";
export { type ActivityService, createActivityService } from "./service/activity.js";
export {
  type ContactDetail,
  type ContactService,
  createContactService,
} from "./service/contacts.js";
export { createNoteService, type NoteService, requireSubject } from "./service/notes.js";
export {
  createOrganizationService,
  type OrganizationService,
} from "./service/organizations.js";
export {
  type Board,
  type BoardItem,
  type CreateItemInput,
  createPipelineService,
  moveItem,
  type PatchItemInput,
  type PipelineService,
  type PlacedItem,
  roundFilterOf,
} from "./service/pipeline.js";
export {
  createStageService,
  ensureStages,
  resolveLadder,
  type StageEntry,
  type StageService,
  stagesByKey,
} from "./service/stages.js";
export { createTaskService, type TaskService } from "./service/tasks.js";
