import type { Tx } from "@fundroom/db";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { createCrmHandlers } from "./handlers.js";

/*
 * The two refusals every handler makes before it touches anything, and the one it makes before
 * it even asks.
 *
 * The fake `Tx` throws on use, so "did nothing" is provable rather than merely likely: if a
 * guard were removed, the test would fail with the transaction's own message instead of a soft
 * assertion about a call count.
 */

const WORKSPACE = "0192f1a0-0000-7000-8000-000000000001";

const explodingTx = new Proxy({} as Tx, {
  get(_t, prop) {
    throw new Error(`handler touched tx.${String(prop)}`);
  },
});

function servicesWith(enabled: readonly string[], erased: readonly string[] = []) {
  let asked = 0;
  let bookingsRead = 0;
  const services = {
    integrations: {
      booking: async () => {
        bookingsRead += 1;
        return undefined;
      },
    },
    db: {},
    enablement: {
      get: () => {
        asked += 1;
        return Promise.resolve({ enabled: new Set(enabled), flags: new Map() });
      },
      invalidate: () => {},
    },
    legal: {
      isErased: async (_tx: unknown, _ctx: unknown, id: string) => erased.includes(id),
    },
  } as unknown as ModuleServices;
  return { services, asked: () => asked, bookingsRead: () => bookingsRead };
}

const handlers = (enabled: readonly string[], erased: readonly string[] = []) => {
  const { services, asked, bookingsRead } = servicesWith(enabled, erased);
  return { handlers: createCrmHandlers(() => services), asked, bookingsRead };
};

const envelope = <T>(topic: string, payload: T): EventEnvelope =>
  ({
    outboxId: 1,
    topic,
    workspaceId: WORKSPACE,
    payload,
    schemaVersion: 1,
    createdAt: new Date(0),
  }) as unknown as EventEnvelope;

const tenantContext = { workspaceId: WORKSPACE, actorKind: "system" as const };
const hostContext = { actorKind: "host" as const };

const run = async (
  handler: EventHandler | undefined,
  event: EventEnvelope,
  ctx: unknown,
): Promise<void> => {
  if (handler === undefined) throw new Error("no handler");
  await handler(event, { tx: explodingTx, ctx, job: {} } as never);
};

const TOPICS = [
  "round.interest_submitted",
  "round.interest_decided",
  "round.commitment_created",
  "round.commitment_changed",
] as const;

describe("crm outbox handlers", () => {
  it("subscribes to the four round topics, to bookings and to DSAR erasure", () => {
    expect(Object.keys(handlers(["crm"]).handlers).sort()).toEqual(
      [...TOPICS, "integration.booking_recorded", "member.erasure_requested"].sort(),
    );
  });

  /*
   * Contract decision 5 (amended): erasure is the one handler that must NOT stop at "module
   * off". It goes straight to the transaction (which the exploding fake proves) without asking.
   */
  it("goes to work on an erasure even in a workspace with the CRM off", async () => {
    const h = handlers(["updates"]);
    await expect(
      run(
        h.handlers["member.erasure_requested"],
        envelope("member.erasure_requested", { requestId: WORKSPACE, membershipId: WORKSPACE }),
        tenantContext,
      ),
    ).rejects.toThrow(/handler touched tx/u);
    expect(h.asked()).toBe(0);
  });

  /*
   * A workspace that never switched the CRM on must not acquire CRM rows because somebody
   * indicated interest in a round. The module is off; the events are not its business.
   */
  it("does nothing at all when the workspace has the CRM switched off", async () => {
    const h = handlers([]);
    await run(
      h.handlers["round.interest_submitted"],
      envelope("round.interest_submitted", {
        submissionId: WORKSPACE,
        roundId: WORKSPACE,
        membershipId: WORKSPACE,
      }),
      tenantContext,
    );
    expect(h.asked()).toBe(1);
  });

  it("does nothing for any of the four when the module is off", async () => {
    const h = handlers(["metrics", "round"]);
    await run(
      h.handlers["round.commitment_changed"],
      envelope("round.commitment_changed", {
        commitmentId: WORKSPACE,
        roundId: WORKSPACE,
        status: "wired",
      }),
      tenantContext,
    );
    await run(
      h.handlers["round.commitment_created"],
      envelope("round.commitment_created", { commitmentId: WORKSPACE, roundId: WORKSPACE }),
      tenantContext,
    );
    expect(h.asked()).toBe(2);
  });

  /*
   * A host-level event has no workspace to fence to. There is nothing for a per-tenant board to
   * do with one, and reading `enablement` for a context with no workspace id would be the first
   * thing to break.
   */
  it("ignores a host-level event without even asking about enablement", async () => {
    const h = handlers(["crm"]);
    for (const topic of TOPICS) {
      await run(h.handlers[topic], envelope(topic, { decision: "declined" }), hostContext);
    }
    expect(h.asked()).toBe(0);
  });

  /*
   * An acceptance produces a commitment, and `round.commitment_created` is what moves the card.
   * Handling both would move it twice and write two history rows for one decision — so this
   * handler leaves before it has even asked whether the module is on.
   */
  it("leaves an accepted interest submission to the commitment handler", async () => {
    const h = handlers(["crm"]);
    await run(
      h.handlers["round.interest_decided"],
      envelope("round.interest_decided", {
        submissionId: WORKSPACE,
        roundId: WORKSPACE,
        membershipId: WORKSPACE,
        decision: "accepted",
        commitmentId: WORKSPACE,
      }),
      tenantContext,
    );
    expect(h.asked()).toBe(0);
  });

  /*
   * E2.6: an event about a member whose erasure was requested (emitted before the request,
   * dispatched after it) must not re-create the contact the erasure pseudonymised. The
   * exploding transaction proves nothing was read or written.
   */
  it("drops round events about an erased member before touching the transaction", async () => {
    const MEMBER = "0192f1a0-0000-7000-8000-0000000000ee";
    const h = handlers(["crm"], [MEMBER]);
    await run(
      h.handlers["round.interest_submitted"],
      envelope("round.interest_submitted", {
        submissionId: WORKSPACE,
        roundId: WORKSPACE,
        membershipId: MEMBER,
      }),
      tenantContext,
    );
    await run(
      h.handlers["round.interest_decided"],
      envelope("round.interest_decided", {
        submissionId: WORKSPACE,
        roundId: WORKSPACE,
        membershipId: MEMBER,
        decision: "declined",
      }),
      tenantContext,
    );
    // A commitment naming only the erased member has nothing left to hang a card on.
    await run(
      h.handlers["round.commitment_created"],
      envelope("round.commitment_created", {
        commitmentId: WORKSPACE,
        roundId: WORKSPACE,
        membershipId: MEMBER,
      }),
      tenantContext,
    );
    expect(h.asked()).toBe(3);
  });

  /*
   * E3.6 bookings. A workspace without the CRM gets no activity (and no contact) from a booking
   * webhook: the handler leaves before it even asks the kernel for the booking. A host context,
   * or a booking the kernel no longer holds (retention, erasure), touches nothing either.
   */
  describe("integration.booking_recorded", () => {
    const booked = envelope("integration.booking_recorded", {
      bookingId: WORKSPACE,
      provider: "calendly",
      status: "booked",
    });

    it("does nothing when the CRM is off", async () => {
      const h = handlers(["metrics"]);
      await run(h.handlers["integration.booking_recorded"], booked, tenantContext);
      expect(h.asked()).toBe(1);
      expect(h.bookingsRead()).toBe(0);
    });

    it("ignores a host-level event", async () => {
      const h = handlers(["crm"]);
      await run(h.handlers["integration.booking_recorded"], booked, hostContext);
      expect(h.asked()).toBe(0);
      expect(h.bookingsRead()).toBe(0);
    });

    it("writes nothing for a booking the kernel no longer holds", async () => {
      const h = handlers(["crm"]);
      await run(h.handlers["integration.booking_recorded"], booked, tenantContext);
      expect(h.bookingsRead()).toBe(1);
    });
  });

  it("refuses an event routed to the wrong handler", async () => {
    const h = handlers(["crm"]);
    await expect(
      run(h.handlers["round.commitment_created"], envelope("round.opened", {}), tenantContext),
    ).rejects.toThrow(/round.commitment_created handler got round.opened/u);
  });

  it("throws a legible error when the module's routes were never registered", async () => {
    const unregistered = createCrmHandlers(() => {
      throw new Error("crm routes are not registered");
    });
    await expect(
      run(
        unregistered["round.interest_submitted"],
        envelope("round.interest_submitted", {}),
        tenantContext,
      ),
    ).rejects.toThrow("crm routes are not registered");
  });
});
