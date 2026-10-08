import type { ModuleServices } from "@fundroom/module-kit";

/*
 * Event handlers in the manifest are static closures with only `tx`/`ctx`; delivery needs
 * the mailer, authz and URLs. The composition root calls `jobs(services)` before the event
 * workers start (apps/server/src/container.ts), so the jobs factory parks the services here
 * and the handlers read them lazily.
 */
let slot: ModuleServices | undefined;

export function setNotifyServices(services: ModuleServices): void {
  slot = services;
}

export function notifyServices(): ModuleServices {
  if (slot === undefined)
    throw new Error("notify: ModuleServices not initialised — createNotifyJobs() must run first");
  return slot;
}
