import { createApi } from "@fundroom/contracts";
import type { ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { metricsModule } from "./index.js";

/*
 * The manifest, and one property that is easy to lose and fails silently when it is:
 * a registration against the OpenAPI generation stub must not replace the live services.
 *
 * `GET /api/v1/openapi.json` builds a whole second API app against `stubDeps()` and re-runs
 * every module's `routes` callback, so an unconditional capture would let one request for the
 * contract document break block hydration for everybody afterwards.
 */

/**
 * What `moduleServicesOf(stubDeps())` behaves like: every property read reaches the throwing
 * dep Proxy — except `guards`, whose middleware factories close over thunks and so can be built
 * without a live container. That asymmetry is exactly why registration *succeeds* against the
 * stub and why the capture has to be the thing that refuses it.
 */
const noopMiddleware = async (_c: unknown, next: () => Promise<void>) => {
  await next();
};
const stubServices = new Proxy({} as ModuleServices, {
  get(_t, prop) {
    if (prop === "guards") {
      return { requirePermission: () => noopMiddleware, requireMember: () => noopMiddleware };
    }
    throw new Error(`route touched deps.${String(prop)} at registration time`);
  },
});

const fakeServices = {
  db: {},
  now: () => new Date(),
  log: () => {},
  guards: { requirePermission: () => noopMiddleware, requireMember: () => noopMiddleware },
} as unknown as ModuleServices;

const register = (services: ModuleServices) => {
  metricsModule.routes?.(createApi() as unknown as ModuleRouter, services);
};

describe("metrics manifest", () => {
  it("wires routes, jobs, the hydrator and its own recompute subscriber", () => {
    expect(metricsModule.routes).toBeTypeOf("function");
    expect(metricsModule.jobs).toBeTypeOf("function");
    expect(metricsModule.blockHydrators?.map((h) => h.type)).toEqual(["metric_grid"]);
    expect(metricsModule.slots?.["content.blocks"]).toEqual(["metric_grid"]);
    // It emits the topic and handles it: the recompute cascade is the module's own business.
    expect(metricsModule.events?.emits).toContain("metric.points_changed");
    expect(Object.keys(metricsModule.events?.handles ?? {})).toEqual(["metric.points_changed"]);
  });

  it("names its jobs under the module id, which is what the registry requires", () => {
    const build = metricsModule.jobs as (
      s: ModuleServices,
    ) => readonly { name: string; cron?: string }[];
    const jobs = build(fakeServices);
    expect(jobs.map((j) => j.name)).toEqual([
      "metrics.import",
      "metrics.sheets_sync",
      "metrics.kpi_sync",
      "metrics.kpi_sync_provider",
    ]);
    expect(jobs.find((j) => j.name === "metrics.sheets_sync")?.cron).toBe("35 4 * * *");
    expect(jobs.find((j) => j.name === "metrics.kpi_sync")?.cron).toBe("55 4 * * *");
  });

  /*
   * These two run in order on purpose: the capture is module state, so the stub has to be
   * rejected *before* a live registration, and the live one has to survive a stub afterwards.
   */
  it("ignores a registration against the throwing OpenAPI stub", async () => {
    register(stubServices);
    const hydrator = metricsModule.blockHydrators?.[0];
    // Still "not registered" rather than "route touched deps.db": the stub was not captured.
    await expect(hydrator?.hydrate({} as JsonObject, {} as never)).rejects.toThrow(
      "metrics routes are not registered",
    );
  });

  it("keeps the live services when the contract document is generated afterwards", async () => {
    register(fakeServices);
    register(stubServices);
    const hydrator = metricsModule.blockHydrators?.[0];
    const block = { definitionIds: ["01920000-0000-7000-8000-0000000000a1"] } as JsonObject;
    const ctx = { tenant: {}, viewer: { kind: "staff", groupIds: [] } } as never;
    const failure = await hydrator?.hydrate(block, ctx).catch((e: unknown) => e as Error);
    /*
     * It reaches the fake's missing database, i.e. it used the services captured *first*. Had
     * the second registration won, it would have died on `deps.now` inside the throwing stub
     * before it ever looked for a table.
     */
    expect((failure as Error).message).not.toContain("metrics routes are not registered");
    expect((failure as Error).message).not.toContain("at registration time");
  });
});
