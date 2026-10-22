import type { SignupDeps } from "@fundroom/control-plane";
import { describe, expect, it } from "vitest";
import { forgetSignupLive, SIGNUP_LIVE_TTL_MS, signupLive } from "./signup.js";

/*
 * E-UP-26 L3: whether the default plan is live is read once per SIGNUP_LIVE_TTL_MS per process and
 * shared by the signup routes and the page config, not once per request.
 */
function fakeSignup(plan: () => { archivedAt: Date | null } | undefined) {
  let reads = 0;
  const deps = {
    defaultPlanId: "starter",
    provisioning: {
      db: {
        withHost: async () => {
          reads += 1;
          return plan();
        },
      },
    },
  } as unknown as SignupDeps;
  return { deps, reads: () => reads };
}

describe("signupLive", () => {
  it("reuses one answer for the TTL, then reads again", async () => {
    let archivedAt: Date | null = null;
    const { deps, reads } = fakeSignup(() => ({ archivedAt }));
    expect(await signupLive(deps, 1_000)).toBe(true);
    archivedAt = new Date();
    expect(await signupLive(deps, 1_000 + SIGNUP_LIVE_TTL_MS - 1)).toBe(true);
    expect(reads()).toBe(1);
    expect(await signupLive(deps, 1_000 + SIGNUP_LIVE_TTL_MS)).toBe(false);
    expect(reads()).toBe(2);
  });

  it("shares one read between concurrent callers, and forgets on request", async () => {
    const { deps, reads } = fakeSignup(() => undefined);
    const answers = await Promise.all([signupLive(deps, 0), signupLive(deps, 0)]);
    expect(answers).toEqual([false, false]);
    expect(reads()).toBe(1);
    forgetSignupLive(deps);
    await signupLive(deps, 0);
    expect(reads()).toBe(2);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const { deps, reads } = fakeSignup(() => {
      if (fail) throw new Error("db down");
      return { archivedAt: null };
    });
    await expect(signupLive(deps, 0)).rejects.toThrow("db down");
    fail = false;
    expect(await signupLive(deps, 1)).toBe(true);
    expect(reads()).toBe(2);
  });
});
