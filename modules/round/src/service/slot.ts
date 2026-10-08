import { isLiveModuleServices, type ModuleServices } from "@fundroom/module-kit";

/*
 * The composition root's `ModuleServices`, parked for the parts of the manifest that are static
 * values — the `round_summary` hydrator and the E3.5 event handlers — and so cannot be handed the
 * services any earlier. Both `routes(api, services)` and `jobs(services)` fill it (the worker
 * process registers jobs and handlers but may never mount routes).
 *
 * The guard matters. `generateOpenApiDocument()` builds a second API app against `stubDeps()`,
 * whose `ModuleServices` is a Proxy that throws on every property read, and it runs on each
 * `GET /api/v1/openapi.json` — at runtime, on a live server. Capturing unconditionally would let
 * one request for the contract replace the real services with the throwing stub.
 */
let registered: ModuleServices | undefined;

export function captureRoundServices(services: ModuleServices): void {
  if (!isLiveModuleServices(services)) return;
  registered = services;
}

export function roundServices(): ModuleServices {
  if (registered === undefined) throw new Error("round: ModuleServices not initialised");
  return registered;
}
