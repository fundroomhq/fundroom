import { describe, expect, it } from "vitest";
import { grantLockTimeoutWithin } from "./pgboss-queue.js";

/*
 * E-UP-10: the start-up grant is one query that may wait on two advisory locks in turn. On a
 * pool that abandons a query client-side, both waits must end first, or a bare client timeout
 * hides the lock-timeout error that names the lock. The container passes its pool's bounds.
 */
describe("grantLockTimeoutWithin", () => {
  it("keeps pg-boss's 30 s when the pool never cuts a query", () => {
    expect(grantLockTimeoutWithin({ clientTimeoutMs: 0, graceMs: 0 })).toBe(30_000);
  });

  it("fits both lock waits inside the client bound, leaving the grace for the grants", () => {
    // The container's default: DATABASE_STATEMENT_TIMEOUT_MS=30000 → 35 s bound, 5 s grace.
    const perLock = grantLockTimeoutWithin({ clientTimeoutMs: 35_000, graceMs: 5_000 });
    expect(perLock).toBe(15_000);
    expect(2 * perLock + 5_000).toBeLessThanOrEqual(35_000);
    // A low statement timeout: 2 s → 3 s bound, 1 s grace.
    expect(grantLockTimeoutWithin({ clientTimeoutMs: 3_000, graceMs: 1_000 })).toBe(1_000);
  });

  it("never exceeds 30 s, and never answers 0 (which would turn lock_timeout off)", () => {
    expect(grantLockTimeoutWithin({ clientTimeoutMs: 3_600_000, graceMs: 5_000 })).toBe(30_000);
    expect(grantLockTimeoutWithin({ clientTimeoutMs: 1_000, graceMs: 1_000 })).toBe(1);
  });
});
