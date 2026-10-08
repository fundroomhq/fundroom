import {
  defineModule,
  isLiveModuleServices,
  type ModuleManifest,
  type ModuleServices,
} from "@fundroom/module-kit";
import { captableDsar } from "./dsar.js";
import { createErasureHandler } from "./erasure.js";
import { captablePortability } from "./portability.js";
import { registerCaptableRoutes } from "./routes.js";

/*
 * Cap table (E3.6, ADR-0054): read-only snapshots imported from our CSV template, a Carta export
 * or a Pulley export (FILE imports: both vendors' APIs are partner-gated). Admins see the summary
 * fully diluted by class, the option pool and SAFEs/notes outstanding; an investor sees their own
 * holdings (or a class-level summary, per the module's `investorView` setting). Published
 * snapshots are immutable (triggers in migrations/0001_captable.sql).
 *
 * This module is a **mirror**, never the system of record: every investor view carries the
 * disclaimer (`DEFAULT_DISCLAIMER`, overridable per workspace).
 *
 * `defaultEnabled: false`: a workspace that never imports a cap table should not carry it.
 * Settings live in the module's own `core.module_enablement.config.settings` (read and written by
 * `GET/PUT /captable/settings`), not in the workspace settings document.
 */

/*
 * Services are captured when the routes are mounted (the erasure subscriber needs them); the
 * `isLiveModuleServices` probe keeps the OpenAPI generator's throwing stub from replacing them.
 */
let registeredServices: ModuleServices | undefined;

function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("captable routes are not registered");
  return registeredServices;
}

export const captableModule: ModuleManifest = defineModule({
  id: "captable",
  version: "0.1.0",
  dependsOn: ["access"],
  schema: "captable",
  migrations: new URL("../migrations/", import.meta.url),
  defaultEnabled: false,
  permissions: ["captable.read", "captable.manage"],
  dsar: captableDsar,
  portability: captablePortability,
  routes: (api, services) => {
    if (isLiveModuleServices(services)) registeredServices = services;
    registerCaptableRoutes(api, services);
  },
  events: { handles: { "member.erasure_requested": createErasureHandler(liveServices) } },
  slots: {
    "admin.nav": [
      {
        id: "captable-admin",
        label: "Cap table",
        to: "/admin/captable",
        order: 38,
        icon: "pie-chart",
      },
    ],
    // The investor's "Holdings" page (web registers `/captable`); `/captable/me` answers 404 when
    // there is nothing to show, and the page shows an empty state then.
    "investor.nav": [
      { id: "captable", label: "Holdings", to: "/captable", order: 60, icon: "pie-chart" },
    ],
  },
});

export default captableModule;

export * from "./contracts.js";
export { captableDsar } from "./dsar.js";
export { createErasureHandler } from "./erasure.js";
export { type Actor, CaptableError, type CaptableErrorCode } from "./errors.js";
export {
  HEADER_ALIASES,
  IMPORT_FIELDS,
  type ImportPlan,
  type ImportProblem,
  type PlanResult,
  planImport,
} from "./import-plan.js";
export {
  CAPTABLE_IMPORT_BODY_LIMIT_BYTES,
  type CaptableSettings,
  type CaptableSummary,
  computeSummary,
  DEFAULT_DISCLAIMER,
  DEFAULT_SETTINGS,
  ERASED_HOLDER_NAME,
  IMPORT_FORMATS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  INVESTOR_VIEWS,
  type InvestorView,
  percentText,
  SECURITY_KINDS,
  type SecurityKind,
} from "./model.js";
export { captablePortability } from "./portability.js";
export { PERM_MANAGE, PERM_READ, registerCaptableRoutes } from "./routes.js";
