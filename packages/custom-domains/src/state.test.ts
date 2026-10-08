import { describe, expect, it } from "vitest";
import {
  CUSTOM_DOMAIN_STATUSES,
  type CustomDomainStatus,
  nextState,
  REVERIFY_GRACE,
  VERIFY_DEADLINE_MS,
} from "./state.js";

const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function step(
  status: CustomDomainStatus,
  ok: boolean,
  opts: { now?: Date; consecutiveFailures?: number } = {},
) {
  return nextState({
    status,
    ok,
    firstAttemptAt: T0,
    now: opts.now ?? at(60_000),
    consecutiveFailures: opts.consecutiveFailures ?? 0,
  });
}

describe("nextState", () => {
  it("statuses match the migration enum order", () => {
    expect(CUSTOM_DOMAIN_STATUSES).toEqual(["pending", "dns_ok", "active", "failed"]);
  });

  it("pending → dns_ok when DNS verifies", () => {
    expect(step("pending", true)).toEqual({ status: "dns_ok", consecutiveFailures: 0 });
  });

  it("pending stays pending inside the deadline and counts the failure", () => {
    expect(
      step("pending", false, { now: at(VERIFY_DEADLINE_MS - 1), consecutiveFailures: 9 }),
    ).toEqual({ status: "pending", consecutiveFailures: 10 });
  });

  it("pending → failed exactly at the deadline", () => {
    expect(step("pending", false, { now: at(VERIFY_DEADLINE_MS) }).status).toBe("failed");
  });

  it("pending → failed past the deadline", () => {
    expect(step("pending", false, { now: at(VERIFY_DEADLINE_MS + 3_600_000) }).status).toBe(
      "failed",
    );
  });

  it("verifying on the last poll still wins over the deadline", () => {
    expect(step("pending", true, { now: at(VERIFY_DEADLINE_MS * 2) }).status).toBe("dns_ok");
  });

  it("dns_ok stays dns_ok on a good verdict: only a served request can make it active", () => {
    // E2.1 S2. `nextState("dns_ok", ok=true)` used to return `active`, so a second successful
    // DNS poll promoted the row — and `active` is what `primaryHost` keys off, so `workspaceUrl`
    // and every emailed link started pointing at a hostname that may never have completed a
    // handshake (a CAA record excluding our CA, or an ACME rate limit, and it answers a TLS
    // error). No verdict about DNS is evidence that a certificate exists.
    expect(step("dns_ok", true)).toEqual({ status: "dns_ok", consecutiveFailures: 0 });
  });

  it("never returns `active` from any verdict", () => {
    for (const status of CUSTOM_DOMAIN_STATUSES) {
      for (const ok of [true, false]) {
        for (const consecutiveFailures of [0, 1, REVERIFY_GRACE]) {
          if (status === "active") continue; // staying `active` is not a promotion
          expect(step(status, ok, { consecutiveFailures }).status).not.toBe("active");
        }
      }
    }
  });

  it("dns_ok tolerates failures below the grace", () => {
    for (let failures = 0; failures < REVERIFY_GRACE - 1; failures += 1) {
      expect(step("dns_ok", false, { consecutiveFailures: failures }).status).toBe("dns_ok");
    }
  });

  it("dns_ok → pending at the grace boundary", () => {
    expect(step("dns_ok", false, { consecutiveFailures: REVERIFY_GRACE - 1 })).toEqual({
      status: "pending",
      consecutiveFailures: 0,
    });
  });

  it("active stays active on a good re-verify and clears the counter", () => {
    expect(step("active", true, { consecutiveFailures: 2 })).toEqual({
      status: "active",
      consecutiveFailures: 0,
    });
  });

  it("active survives one and two bad re-verifies", () => {
    expect(step("active", false, { consecutiveFailures: 0 })).toEqual({
      status: "active",
      consecutiveFailures: 1,
    });
    expect(step("active", false, { consecutiveFailures: 1 })).toEqual({
      status: "active",
      consecutiveFailures: 2,
    });
  });

  it("active → pending only at the grace boundary", () => {
    expect(step("active", false, { consecutiveFailures: REVERIFY_GRACE - 2 }).status).toBe(
      "active",
    );
    expect(step("active", false, { consecutiveFailures: REVERIFY_GRACE - 1 })).toEqual({
      status: "pending",
      consecutiveFailures: 0,
    });
  });

  it("an old first_attempt_at does not demote an active domain early", () => {
    expect(
      step("active", false, { now: at(VERIFY_DEADLINE_MS * 10), consecutiveFailures: 0 }).status,
    ).toBe("active");
  });

  it("failed → pending when the admin retries (a fresh deadline window)", () => {
    expect(step("failed", false, { now: at(1000) })).toEqual({
      status: "pending",
      consecutiveFailures: 1,
    });
  });

  it("failed stays failed while the deadline is still in the past", () => {
    expect(step("failed", false, { now: at(VERIFY_DEADLINE_MS + 1) }).status).toBe("failed");
  });

  it("failed → dns_ok when a late poll succeeds", () => {
    expect(step("failed", true, { now: at(VERIFY_DEADLINE_MS * 5) })).toEqual({
      status: "dns_ok",
      consecutiveFailures: 0,
    });
  });

  it("never invents a status outside the enum", () => {
    for (const status of CUSTOM_DOMAIN_STATUSES) {
      for (const ok of [true, false]) {
        for (const now of [at(0), at(VERIFY_DEADLINE_MS), at(VERIFY_DEADLINE_MS * 3)]) {
          for (const consecutiveFailures of [0, 1, 2, 3, 99]) {
            const result = nextState({ status, ok, firstAttemptAt: T0, now, consecutiveFailures });
            expect(CUSTOM_DOMAIN_STATUSES).toContain(result.status);
            expect(result.consecutiveFailures).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});
