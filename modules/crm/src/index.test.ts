import { createApi } from "@fundroom/contracts";
import type { EventHandler } from "@fundroom/events";
import type { ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { crmModule } from "./index.js";

/*
 * The manifest, and the one property that is easy to lose and fails silently when it is: a
 * registration against the OpenAPI generation stub must not replace the live services.
 *
 * `GET /api/v1/openapi.json` builds a whole second API app against `stubDeps()` and re-runs
 * every module's `routes` callback, so an unconditional capture would let one request for the
 * contract document break every outbox handler afterwards.
 */
const noopMiddleware = async (_c: unknown, next: () => Promise<void>) => {
  await next();
};

/**
 * What `moduleServicesOf(stubDeps())` behaves like: every property read reaches the throwing
 * dep Proxy — except `guards`, whose middleware factories close over thunks and so can be built
 * without a live container. That asymmetry is exactly why registration *succeeds* against the
 * stub and why the capture has to be the thing that refuses it.
 */
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
  crmModule.routes?.(createApi() as unknown as ModuleRouter, services);
};

const handlerFor = (topic: string): EventHandler => {
  const handles = crmModule.events?.handles ?? {};
  const found = (handles as Record<string, EventHandler | undefined>)[topic];
  if (found === undefined) throw new Error(`no handler for ${topic}`);
  return found;
};

describe("crm manifest", () => {
  it("is an optional module that owns the crm schema and depends only on access", () => {
    expect(crmModule.id).toBe("crm");
    expect(crmModule.schema).toBe("crm");
    expect(crmModule.defaultEnabled).toBe(false);
    expect(crmModule.dependsOn).toEqual(["access"]);
    expect(String(crmModule.migrations)).toMatch(/migrations\/$/u);
  });

  it("declares exactly the two permissions the matrix gives it", () => {
    expect(crmModule.permissions).toEqual(["crm.read", "crm.manage"]);
  });

  /*
   * The load-bearing absence (E2.5 D1). `round` is `disabledWhen: ["none", "informational"]`;
   * the CRM must not be, because tracking relationships before there is anything to offer is
   * the whole point of running one. A test rather than a comment, because adding the rule to
   * this manifest would be a one-line change that silently broke `informational` workspaces.
   */
  it("declares no offering rules at all, so an informational workspace keeps its board", () => {
    expect(crmModule.offeringStatusRules).toBeUndefined();
  });

  it("contributes one admin nav item and nothing to the investor nav", () => {
    expect(crmModule.slots?.["admin.nav"]).toEqual([
      { id: "crm-admin", label: "CRM", to: "/admin/crm", order: 37, icon: "crm" },
    ]);
    expect(crmModule.slots?.["investor.nav"]).toBeUndefined();
  });

  /*
   * Every RLS policy in the schema admits staff and system and nobody else, so there is no
   * viewer-safe projection of any of this to put on an investor-facing page.
   */
  it("registers no content block and no hydrator", () => {
    expect(crmModule.slots?.["content.blocks"]).toBeUndefined();
    expect(crmModule.blockHydrators).toBeUndefined();
  });

  it("subscribes to the four round topics, bookings and DSAR erasure, and emits none of its own", () => {
    expect(Object.keys(crmModule.events?.handles ?? {}).sort()).toEqual([
      "integration.booking_recorded",
      "member.erasure_requested",
      "round.commitment_changed",
      "round.commitment_created",
      "round.interest_decided",
      "round.interest_submitted",
    ]);
    expect(crmModule.events?.emits).toBeUndefined();
  });

  it("declares no jobs and no raw routes", () => {
    expect(crmModule.jobs).toBeUndefined();
    expect(crmModule.rawRoutes).toBeUndefined();
  });

  it("routes a handler only for its own topic", async () => {
    const handler = handlerFor("round.commitment_changed");
    await expect(
      handler({ topic: "round.opened", payload: {} } as never, {} as never),
    ).rejects.toThrow(/round.commitment_changed handler got round.opened/u);
  });

  /*
   * These two run in order on purpose: the capture is module state, so the stub has to be
   * rejected *before* a live registration, and the live one has to survive a stub afterwards.
   */
  it("ignores a registration against the throwing OpenAPI stub", async () => {
    register(stubServices);
    const handler = handlerFor("round.interest_submitted");
    // Still "not registered" rather than "route touched deps.db": the stub was not captured.
    await expect(
      handler(
        { topic: "round.interest_submitted", payload: {} } as never,
        {
          ctx: { actorKind: "system", workspaceId: "w" },
        } as never,
      ),
    ).rejects.toThrow("crm routes are not registered");
  });

  it("keeps the live services when the contract document is generated afterwards", async () => {
    register(fakeServices);
    register(stubServices);
    const handler = handlerFor("round.interest_submitted");
    const failure = await handler(
      { topic: "round.interest_submitted", payload: {} } as never,
      { ctx: { actorKind: "system", workspaceId: "w" } } as never,
    ).catch((e: unknown) => e as Error);
    // It reached the fake's missing `enablement`, i.e. it used the services captured *first*.
    // Had the second registration won, it would have died inside the throwing stub instead.
    expect(failure?.message).not.toContain("crm routes are not registered");
    expect(failure?.message).not.toContain("at registration time");
  });
});
