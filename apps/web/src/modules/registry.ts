import type { ModuleLoader } from "./types.js";

/*
 * Client-side module registry (§5.3). The server's `/api/v1/modules` bootstrap says which
 * modules are enabled for this workspace; this map says which of them ship UI in this build.
 * Phase 1 modules register their lazily imported route component here, keyed by module id:
 *
 *   "data-room": () => import("@fundroom/module-data-room/web"),
 *
 * The component receives the remainder of the path (`splat`) and renders its own routes.
 * An enabled module without an entry renders "not available in this build".
 */
export type { ModuleLoader, ModulePageProps } from "./types.js";

export const investorModules: Readonly<Record<string, ModuleLoader>> = {
  captable: () => import("./captable/investor.js"),
  "data-room": () => import("./data-room/investor.js"),
  metrics: () => import("./metrics/investor.js"),
  round: () => import("./round/investor.js"),
  updates: () => import("./updates/investor.js"),
};
export const adminModules: Readonly<Record<string, ModuleLoader>> = {
  analytics: () => import("./analytics/admin.js"),
  captable: () => import("./captable/admin.js"),
  // The overview page editor (E1.2). Investor rendering is the portal home, not a module page.
  content: () => import("./content/admin.js"),
  crm: () => import("./crm/admin.js"),
  "data-room": () => import("./data-room/admin.js"),
  metrics: () => import("./metrics/admin.js"),
  notify: () => import("./notify/admin.js"),
  round: () => import("./round/admin.js"),
  updates: () => import("./updates/admin.js"),
};
