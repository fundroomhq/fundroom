import { isApiError } from "@fundroom/contracts";
import type { OfferingStatus } from "@fundroom/db";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { requireOffering } from "./authz.js";

/*
 * The offering-mode route guard (E1.6 R3, E2.3 contract S4).
 *
 * `offeringStatusRules.disabledWhen` on a manifest cannot switch a *kernel* route off: those
 * routes are registered above `api.ts`'s per-module enablement middleware (that is the whole
 * point of being kernel-owned), and `isDisabledForOffering` short-circuits to `false` for the
 * `required` manifests kernel features carry. So the rule is enforced here, and this is where it
 * is proven — including the part E1.6's as-built insists on, that it applies to **staff**, not
 * only to the investor's menu.
 */
function fakeContext(workspace: { offeringStatus: OfferingStatus } | undefined): Context<AppEnv> {
  return {
    get: (key: string) => (key === "workspace" ? workspace : undefined),
  } as unknown as Context<AppEnv>;
}

const OFF: readonly OfferingStatus[] = ["none", "informational"];

async function run(
  workspace: { offeringStatus: OfferingStatus } | undefined,
): Promise<{ reached: boolean; status?: number; code?: string }> {
  let reached = false;
  try {
    await requireOffering(OFF)(fakeContext(workspace), async () => {
      reached = true;
    });
    return { reached };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { reached, status: error.status, code: error.code };
  }
}

describe("requireOffering", () => {
  it("404s a listed status — for staff too, which is the whole point of `disabledWhen`", async () => {
    for (const offeringStatus of OFF) {
      // The guard never looks at the session or the membership: it is mounted first on every
      // route in the file, so an owner and an anonymous visitor get the identical answer, and a
      // staff caller cannot walk around a compliance control by holding a permission.
      expect(await run({ offeringStatus })).toEqual({
        reached: false,
        status: 404,
        code: "module_disabled",
      });
    }
  });

  it("lets every other status through", async () => {
    for (const offeringStatus of ["506b", "506c", "closed"] as OfferingStatus[]) {
      expect(await run({ offeringStatus })).toEqual({ reached: true });
    }
  });

  it("is not the answer to 'no workspace' — that question belongs to the classifier", async () => {
    // A request that resolved no workspace has a different problem, and answering `module_disabled`
    // here would hide `setup_required` from a first-run install.
    expect(await run(undefined)).toEqual({ reached: true });
  });

  it("an empty list is a no-op, so a feature that declares nothing is never switched off", async () => {
    let reached = false;
    await requireOffering([])(fakeContext({ offeringStatus: "none" }), async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });
});
