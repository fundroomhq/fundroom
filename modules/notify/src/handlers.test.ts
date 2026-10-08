import type { ModuleServices } from "@fundroom/module-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The E3.7 verification handlers (ADR-0055), with `fanOut` replaced: what matters here is what
 * each handler asks for — the investor alone (`alsoNotify`, no staff permission, no actor), ids and
 * the status only, and one bucket per fact. Erasure, membership status and cadence are `fanOut`'s
 * (exercised end to end in apps/server/src/notify-verification.integration.test.ts).
 */
const fanOut = vi.fn(async (..._args: unknown[]) => ({ created: 1, instant: 1, deduped: 0 }));
vi.mock("./service/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service/notify.js")>()),
  fanOut,
}));

const { onRoundVerificationDecided, onRoundVerificationExpiring } = await import("./handlers.js");
const { setNotifyServices } = await import("./service/slot.js");

const V = "7d0f2a3e-0000-4000-8000-000000000001";
const M = "7d0f2a3e-0000-4000-8000-0000000000aa";
const tx = {} as never;
const system = { workspaceId: "w1", actorKind: "system" } as never;

function envelope(topic: string, payload: Record<string, unknown>, outboxId = 1) {
  return {
    outboxId,
    topic,
    workspaceId: "w1",
    payload,
    schemaVersion: 1,
    createdAt: new Date("2026-09-26T10:00:00Z"),
  } as never;
}

beforeEach(() => {
  fanOut.mockClear();
  setNotifyServices({ now: () => new Date("2026-09-26T10:00:00Z") } as unknown as ModuleServices);
});

describe("round.verification_expiring", () => {
  it("addresses the investor alone, ids only, one bucket per verification", async () => {
    await onRoundVerificationExpiring(
      envelope("round.verification_expiring", { verificationId: V, membershipId: M }),
      { tx, ctx: system } as never,
    );
    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut.mock.calls[0]?.[3]).toEqual({
      eventType: "round.verification_expiring",
      actorMembershipId: null,
      resourceKind: "verification",
      resourceId: V,
      payload: { verificationId: V },
      bucket: V,
      permission: null,
      alsoNotify: [M],
    });
  });

  it("is ignored under a host context", async () => {
    await onRoundVerificationExpiring(
      envelope("round.verification_expiring", { verificationId: V, membershipId: M }),
      { tx, ctx: { actorKind: "host" } } as never,
    );
    expect(fanOut).not.toHaveBeenCalled();
  });
});

describe("round.verification_decided", () => {
  it.each(["verified", "rejected", "expired"])(
    "%s: the investor alone, bucketed per verification and status",
    async (status) => {
      await onRoundVerificationDecided(
        envelope("round.verification_decided", { verificationId: V, membershipId: M, status }),
        { tx, ctx: system } as never,
      );
      expect(fanOut.mock.calls[0]?.[3]).toEqual({
        eventType: "round.verification_decided",
        actorMembershipId: null,
        resourceKind: "verification",
        resourceId: V,
        payload: { verificationId: V, status },
        bucket: `${V}:${status}`,
        permission: null,
        alsoNotify: [M],
      });
    },
  );

  it("a pending status is not a decision and tells nobody", async () => {
    await onRoundVerificationDecided(
      envelope("round.verification_decided", {
        verificationId: V,
        membershipId: M,
        status: "pending",
      }),
      { tx, ctx: system } as never,
    );
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("refuses an envelope of another topic", async () => {
    await expect(
      onRoundVerificationDecided(
        envelope("round.verification_expiring", { verificationId: V, membershipId: M }),
        { tx, ctx: system } as never,
      ),
    ).rejects.toThrow(/got round.verification_expiring/u);
  });
});
