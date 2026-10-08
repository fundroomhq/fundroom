import { createApi } from "@fundroom/contracts";
import type { ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { dataRoomModule } from "./index.js";

/*
 * The same property `modules/content/src/index.test.ts` pins, for the same reason and with the
 * same history: `GET /api/v1/openapi.json` re-runs this manifest's `routes` callback against
 * the throwing OpenAPI stub, and the unconditional capture this module shipped with meant one
 * fetch of the contract document replaced the live composition root for the life of the
 * process. The visible symptom here is a `document_list` block on an investor's overview page
 * rendering `hydration_failed` — the list of documents they were meant to see, replaced by an
 * apology — with nothing tying it back to the contract fetch that caused it.
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
  dataRoomModule.routes?.(createApi() as unknown as ModuleRouter, services);
};

/**
 * `undefined` when the hydrator ran to completion. It throws *synchronously* when nothing was
 * captured — the check happens before it returns a promise — so a bare `.catch()` would miss
 * exactly the case under test. An empty block needs no database, so with live services this
 * legitimately succeeds; what matters is which of the two failures it does **not** produce.
 */
const hydrate = async (): Promise<Error | undefined> => {
  const hydrator = dataRoomModule.blockHydrators?.[0];
  const block = { folderId: null, documentIds: [] } as unknown as JsonObject;
  const ctx = { tenant: {}, viewer: { kind: "staff", groupIds: [] } } as never;
  try {
    await hydrator?.hydrate(block, ctx);
    return undefined;
  } catch (error) {
    return error as Error;
  }
};

describe("data-room manifest", () => {
  it("registers the document_list hydrator", () => {
    expect(dataRoomModule.blockHydrators?.map((h) => h.type)).toEqual(["document_list"]);
  });

  /* Ordered deliberately: the capture is module state, so the stub must be refused first. */
  it("ignores a registration against the throwing OpenAPI stub", async () => {
    register(stubServices);
    expect((await hydrate())?.message).toContain("data-room routes not registered");
  });

  it("keeps the live services when the contract document is generated afterwards", async () => {
    register(fakeServices);
    register(stubServices);
    const failure = await hydrate();
    // Either it completed, or it failed for some other reason — but never because the stub
    // overwrote the live services, which is the regression this pins.
    expect(failure?.message ?? "").not.toContain("data-room routes not registered");
    expect(failure?.message ?? "").not.toContain("at registration time");
  });
});
