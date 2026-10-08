import { toApiError } from "@fundroom/contracts";
import type { ResolvedWorkspace } from "@fundroom/db";
import type { EntitlementsPort } from "@fundroom/ports";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { createEntitlements } from "../entitlements.js";
import type { AppEnv } from "../env.js";
import { requireFeature } from "./entitlements.js";

/*
 * The feature gate as route middleware (A-3, ADR-0063). Pins: 402 `plan_limit` with the feature
 * when the plan leaves it out, straight through otherwise (no plan, CONTROL_PLANE off, feature
 * listed, list absent), no answer of its own without a workspace, and `deps` read per request —
 * never when the route is built (the OpenAPI build registers routes against a throwing stub).
 */

type Ws = Pick<ResolvedWorkspace, "planId" | "planLimits">;

function fakeContext(workspace: Ws | undefined): Context<AppEnv> {
  return {
    get: (key: string) => (key === "workspace" ? workspace : undefined),
  } as unknown as Context<AppEnv>;
}

async function run(
  deps: { readonly entitlements: EntitlementsPort },
  workspace: Ws | undefined,
): Promise<{ reached: boolean; status?: number; body?: Record<string, unknown> }> {
  let reached = false;
  try {
    await requireFeature(deps, "sso")(fakeContext(workspace), async () => {
      reached = true;
    });
    return { reached };
  } catch (error) {
    const api = toApiError(error);
    if (api === undefined) throw error;
    return { reached, status: api.status, body: api.toBody().error };
  }
}

const enforced = { entitlements: createEntitlements({ enforced: true }) };

describe("requireFeature", () => {
  it("402s when the plan leaves the feature out", async () => {
    expect(await run(enforced, { planId: "p", planLimits: { features: ["ai"] } })).toEqual({
      reached: false,
      status: 402,
      body: {
        code: "plan_limit",
        limit: "feature",
        feature: "sso",
        message: "the workspace's plan does not include the sso feature",
      },
    });
  });

  it("passes when the feature is listed, the list is absent, there is no plan, or it is off", async () => {
    expect(await run(enforced, { planId: "p", planLimits: { features: ["sso"] } })).toEqual({
      reached: true,
    });
    expect(await run(enforced, { planId: "p", planLimits: { staffSeats: 2 } })).toEqual({
      reached: true,
    });
    expect(await run(enforced, { planId: null, planLimits: null })).toEqual({ reached: true });
    expect(
      await run(
        { entitlements: createEntitlements({ enforced: false }) },
        { planId: "p", planLimits: { features: [] } },
      ),
    ).toEqual({ reached: true });
  });

  it("has no answer of its own without a resolved workspace", async () => {
    expect(await run(enforced, undefined)).toEqual({ reached: true });
  });

  it("reads deps per request, not when the route is built", () => {
    const stub = new Proxy({} as { entitlements: EntitlementsPort }, {
      get() {
        throw new Error("deps read at registration time");
      },
    });
    expect(() => requireFeature(stub, "sso")).not.toThrow();
  });
});
