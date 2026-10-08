import {
  defineModule,
  isLiveModuleServices,
  type ModuleManifest,
  type ModuleServices,
} from "@fundroom/module-kit";
import { BLOCK_TYPES } from "./blocks.js";
import { createDisclaimerHydrator } from "./disclaimer.js";
import { contentDsar } from "./dsar.js";
import { contentPortability } from "./portability.js";
import { registerContentRoutes } from "./routes.js";
import { contentSearch } from "./search.js";

/*
 * The content module (E1.2, ADR-0033): the investor overview page. Kernel-owned per §12
 * (`required`, cannot be switched off) but built as the first module package so it
 * exercises the seams every optional module uses: its own schema + migrations, routes
 * mounted from the manifest with `ModuleServices`, block hydration from other modules.
 *
 * `services` is captured when the routes are mounted, the way data-room does it: the manifest
 * is a value, so the hydrator cannot be handed the composition root any earlier.
 */
let hydratorServices: ModuleServices | undefined;

export const contentModule: ModuleManifest = defineModule({
  id: "content",
  version: "0.1.0",
  dsar: contentDsar,
  search: contentSearch,
  portability: contentPortability,
  required: true,
  dependsOn: ["access"],
  schema: "content",
  migrations: new URL("../migrations/", import.meta.url),
  permissions: ["content.read", "content.manage", "content.publish", "content.settings"],
  routes: (api, services) => {
    // Only the live composition root is kept: `GET /api/v1/openapi.json` re-runs this callback
    // against the throwing stub, and assigning unconditionally meant one contract fetch broke
    // disclaimer hydration for the life of the process (found in E2.4).
    if (isLiveModuleServices(services)) hydratorServices = services;
    registerContentRoutes(api, services);
  },
  events: { emits: ["page.published"] },
  blockHydrators: [
    {
      type: "disclaimer",
      hydrate(data, ctx) {
        if (hydratorServices === undefined) throw new Error("content routes not registered");
        return createDisclaimerHydrator(hydratorServices).hydrate(data, ctx);
      },
    },
  ],
  slots: {
    "admin.nav": [
      {
        id: "content-page",
        label: "Overview page",
        to: "/admin/content",
        order: 10,
        icon: "document",
      },
    ],
    // E2.7: the settings hub lists this. Content has no settings sub-route — its one setting
    // (public sections) is a card on the editor page, so the entry points there.
    "admin.settings": [
      {
        id: "content-settings",
        label: "Overview page",
        to: "/admin/content",
        order: 40,
        icon: "document",
      },
    ],
    "content.blocks": [...BLOCK_TYPES],
  },
});

export default contentModule;

export {
  BLOCK_REGISTRY,
  BLOCK_TYPES,
  type Block,
  type BlockDefinition,
  type BlockDescriptor,
  type BlockType,
  blockDescriptors,
  DISCLAIMER_SLUG_RE,
  DisclaimerSchema,
  DOC_SCHEMA_VERSION,
  type DocIssue,
  DocValidationError,
  isBlockType,
  LIMITS,
  type PageDoc,
  PageDocSchema,
  providerOf,
  type Section,
  validateDoc,
} from "./blocks.js";
export { createDisclaimerHydrator, disclaimerPayload, slugOf } from "./disclaimer.js";
export { contentDsar } from "./dsar.js";
export { contentPortability } from "./portability.js";
export {
  type RenderedBlock,
  type RenderedSection,
  renderSections,
  visibleSectionKeys,
} from "./render.js";
export {
  aclForRule,
  blockText,
  CONTENT_SEARCH_VERSION,
  contentSearch,
  indexPage,
  pageHref,
  pageSearchEntries,
  sectionText,
  sectionTitle,
} from "./search.js";
export {
  type Actor,
  ContentError,
  type ContentService,
  createContentService,
  hasPublicSections,
  type PageDetail,
  type PageSummary,
  type RenderedPage,
  type RevisionSummary,
} from "./service.js";
export { homeTemplate } from "./template.js";
export {
  DEFAULT_RULE,
  PreviewAsSchema,
  parseVisibilityMap,
  ruleFor,
  sectionVisible,
  VISIBILITY_SCHEMA_VERSION,
  type VisibilityMap,
  VisibilityMapSchema,
  type VisibilityRule,
  VisibilityRuleSchema,
  viewerForPreview,
} from "./visibility.js";
