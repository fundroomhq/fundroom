import { createApi } from "@fundroom/contracts";
import type { ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { contentModule } from "./index.js";

/*
 * One property, and it is the one that failed silently for two phases: a registration against
 * the OpenAPI generation stub must not replace the services captured at boot.
 *
 * `GET /api/v1/openapi.json` is a live route. It builds a second API app against `stubDeps()`
 * and re-runs every module's `routes` callback, so the unconditional `hydratorServices =
 * services` this module shipped with meant a single fetch of the contract document replaced the
 * real composition root with a Proxy that throws on every property read — permanently, for the
 * life of the process. After that, every `disclaimer` block on every investor page rendered
 * `hydration_failed`: an apology, in place of the legal legend that is the whole point of the
 * block, with nothing in the logs connecting it to a contract fetch that happened hours earlier.
 * Found while building E2.4, whose own hydrator would have inherited the same shape.
 */

/**
 * What `moduleServicesOf(stubDeps())` behaves like: every property read reaches the throwing
 * Proxy, except `guards`, whose middleware factories close over thunks and can therefore be
 * built without a live container. That asymmetry is why registration *succeeds* against the
 * stub, and why the capture — not the registration — has to be the thing that refuses it.
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
  legal: {},
  guards: { requirePermission: () => noopMiddleware, requireMember: () => noopMiddleware },
} as unknown as ModuleServices;

const register = (services: ModuleServices) => {
  contentModule.routes?.(createApi() as unknown as ModuleRouter, services);
};

/**
 * The manifest's `hydrate` throws *synchronously* when nothing has been captured — it checks
 * before it returns a promise — so a bare `.catch()` would miss exactly the case under test.
 */
const hydrate = async (): Promise<Error> => {
  const hydrator = contentModule.blockHydrators?.[0];
  const block = { slug: "nda" } as JsonObject;
  const ctx = { tenant: {}, viewer: { kind: "staff", groupIds: [] } } as never;
  try {
    await hydrator?.hydrate(block, ctx);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the hydrator to fail against these services");
};

describe("content manifest", () => {
  it("registers the disclaimer hydrator and declares the block types it owns", () => {
    expect(contentModule.blockHydrators?.map((h) => h.type)).toEqual(["disclaimer"]);
    expect(contentModule.slots?.["content.blocks"]).toContain("metric_grid");
    expect(contentModule.required).toBe(true);
  });

  /*
   * These two run in order deliberately: the capture is module state, so the stub has to be
   * refused *before* any live registration, and a live capture has to survive a stub after it.
   */
  it("ignores a registration against the throwing OpenAPI stub", async () => {
    register(stubServices);
    // Still the "not registered" complaint, not "route touched deps.…": nothing was captured.
    expect((await hydrate()).message).toContain("content routes not registered");
  });

  it("keeps the live services when the contract document is generated afterwards", async () => {
    register(fakeServices);
    register(stubServices);
    const failure = await hydrate();
    /*
     * It gets far enough to reach the fake's missing database, which means it used the services
     * captured *first*. Had the second registration won, it would have died inside the stub
     * before it ever looked for a legal document.
     */
    expect(failure.message).not.toContain("content routes not registered");
    expect(failure.message).not.toContain("at registration time");
  });
});
