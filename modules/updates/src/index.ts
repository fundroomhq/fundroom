import {
  defineModule,
  isLiveModuleServices,
  type ModuleManifest,
  type ModuleServices,
} from "@fundroom/module-kit";
import { createUpdateDraftTask } from "./ai/task.js";
import { updatesDsar } from "./dsar.js";
import { createUpdatesHandlers } from "./handlers.js";
import { createUpdatesJobs } from "./jobs.js";
import { updatesPortability } from "./portability.js";
import { registerUpdatesRoutes } from "./routes.js";
import { updatesSearch } from "./search.js";

/*
 * `services` is captured when the routes or the jobs are built (whichever the process's roles
 * build first), the way `modules/crm` does it: the manifest is a value, so the outbox
 * subscribers declared on it cannot be handed the composition root any earlier.
 * `isLiveModuleServices` keeps `GET /openapi.json` — which registers routes against a throwing
 * stub — from replacing the real services.
 */
let registeredServices: ModuleServices | undefined;

function captureServices(services: ModuleServices): void {
  if (!isLiveModuleServices(services)) return;
  registeredServices = services;
}

function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("updates services are not registered");
  return registeredServices;
}

/*
 * Investor updates (E1.4, ADR-0035): block-editor drafts on the content block schema,
 * templates, audiences with per-section rules, test send, schedule, the send job with
 * per-recipient status, the gated web archive, private reply threads, unsubscribe
 * compliance and per-workspace sending domains (DKIM). Hidden from investors while the
 * workspace is `informational` (ADR-0019): updates are offering material.
 */
export const updatesModule: ModuleManifest = defineModule({
  id: "updates",
  version: "0.1.0",
  dsar: updatesDsar,
  search: updatesSearch,
  portability: updatesPortability,
  dependsOn: ["access", "content"],
  schema: "updates",
  migrations: new URL("../migrations/", import.meta.url),
  permissions: ["updates.read", "updates.manage", "updates.send", "updates.settings"],
  resourceKinds: {
    post: { staff: { view: "updates.read", edit: "updates.manage", comment: "updates.read" } },
  },
  routes: (api, services) => {
    captureServices(services);
    registerUpdatesRoutes(api, services);
  },
  jobs: (services) => {
    captureServices(services);
    return createUpdatesJobs(services);
  },
  // E3.12: AI assist drafts an update (a suggestion staff apply through POST/PUT draft).
  aiTasks: (services) => [createUpdateDraftTask(services)],
  events: {
    emits: ["update.published", "update.sent", "update.replied", "update.viewed"],
    // E2.6: ESP delivery feedback for update mail, and DSAR erasure of a member's rows.
    handles: createUpdatesHandlers(liveServices),
  },
  slots: {
    "investor.nav": [
      { id: "updates", label: "Updates", to: "/updates", order: 10, icon: "updates" },
    ],
    "admin.nav": [
      { id: "updates-admin", label: "Updates", to: "/admin/updates", order: 25, icon: "updates" },
    ],
    // E2.7: the settings hub (`/admin/settings`) lists every manifest's `admin.settings` entries.
    "admin.settings": [
      {
        id: "updates-settings",
        label: "Updates sending",
        to: "/admin/updates/settings",
        order: 42,
        icon: "updates",
      },
    ],
  },
  offeringStatusRules: { hiddenWhen: ["informational"] },
  // E3.4: `update.viewed` is person-level engagement, delivered only when tracking consent allows.
  webhooks: ["update.published", "update.sent", "update.viewed"],
});

export default updatesModule;

export * from "./ai/index.js";
export * from "./contracts.js";
export { updatesDsar } from "./dsar.js";
export { type Actor, UpdatesError, type UpdatesErrorCode } from "./errors.js";
export { createUpdatesHandlers } from "./handlers.js";
export { createUpdatesJobs, JOB_DISPATCH, JOB_SEND } from "./jobs.js";
export * from "./model.js";
export {
  IMPORT_INTERRUPTED,
  importPostRow,
  importRecipientRow,
  importSendRow,
  updatesPortability,
} from "./portability.js";
export { type EmailInput, type RenderedEmail, renderUpdateEmail } from "./render/email.js";
export {
  aclFor,
  indexPost,
  isSearchable,
  postHref,
  postSearchEntries,
  UPDATES_SEARCH_VERSION,
  updatesSearch,
} from "./search.js";
export {
  type Candidate,
  createDeliveryService,
  type DeliveryService,
  isSuppressed,
  trackingFor,
} from "./service/delivery.js";
export {
  createSendingDomainService,
  type DnsRecord,
  dkimMatches,
  lookupTxt,
  recordsFor,
  type SendingDomainService,
  type SendingDomainView,
} from "./service/domains.js";
export {
  bounceError,
  type FeedbackKind,
  isDeliveryFact,
  nextRecipientStatus,
} from "./service/feedback.js";
export {
  type ArchiveEntry,
  type ArchivePage,
  createPostService,
  type PostDetail,
  type PostService,
  type PostSummary,
  type SendSummary,
} from "./service/posts.js";
export {
  createReplyService,
  type ReplyService,
  type Thread,
  type ThreadReply,
} from "./service/replies.js";
export { createSubscriptionService, type SubscriptionService } from "./service/subscriptions.js";
export {
  TEMPLATE_KEYS,
  TEMPLATES,
  type TemplateKey,
  templateByKey,
  type UpdateTemplate,
} from "./templates.js";
export {
  decodeUnsubscribeToken,
  signUnsubscribeToken,
  UNSUBSCRIBE_PURPOSE,
  verifyUnsubscribeToken,
} from "./tokens.js";
