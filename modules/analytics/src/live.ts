import { isLiveModuleServices, type ModuleServices } from "@fundroom/module-kit";

/*
 * The subscribers need `ModuleServices` (consent re-check, `legal.isErased`, audit,
 * `legal.completeErasureStep`), and the manifest is a value, so they read the services captured
 * when the routes are mounted or the jobs are resolved — whichever the process does (a
 * worker-only process resolves jobs; an API process mounts routes). `isLiveModuleServices` keeps
 * `GET /openapi.json`, which mounts the routes against a throwing stub on a live server, from
 * replacing the real services.
 */
let registeredServices: ModuleServices | undefined;

export function captureServices(services: ModuleServices): void {
  if (!isLiveModuleServices(services)) return;
  registeredServices = services;
}

export function liveServices(): ModuleServices {
  if (registeredServices === undefined) throw new Error("analytics services are not registered");
  return registeredServices;
}
