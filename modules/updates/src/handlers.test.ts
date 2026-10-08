import type { Tx } from "@fundroom/db";
import type { EventEnvelope, EventHandler } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The two E2.6 subscribers over faked repositories: which events they refuse before touching
 * anything, what the ladder does to the rows and the send counters, and what erasure reports.
 * The SQL itself is exercised end to end in `apps/server/src/updates.integration.test.ts`.
 */

const H = vi.hoisted(() => ({
  rows: [] as { id: string; sendId: string; status: string; membershipId: string | null }[],
  applied: [] as { id: string; patch: Record<string, unknown>; at: Date }[],
  shifts: [] as [string, string, string][],
  pseudonymised: [] as string[],
  erased: [] as string[],
  optOuts: [] as string[],
}));

vi.mock("./repos/updates-repo.js", () => ({
  RecipientRepo: class {
    async lockByMessageId() {
      return H.rows;
    }
    async applyFeedback(id: string, patch: Record<string, unknown>, at: Date) {
      H.applied.push({ id, patch, at });
      const row = H.rows.find((r) => r.id === id);
      if (row !== undefined && typeof patch["status"] === "string") row.status = patch["status"];
    }
    async pseudonymiseMember(membershipId: string) {
      H.pseudonymised.push(membershipId);
      return 3;
    }
  },
  SendRepo: class {
    async shiftFeedback(id: string, from: string, to: string) {
      H.shifts.push([id, from, to]);
    }
  },
  ReplyRepo: class {
    async eraseMember(membershipId: string) {
      H.erased.push(membershipId);
      return 2;
    }
  },
  UnsubscribeRepo: class {
    async pseudonymiseMember(membershipId: string) {
      H.optOuts.push(membershipId);
      return 1;
    }
  },
}));

const { createUpdatesHandlers } = await import("./handlers.js");

const WS = "0192f1a0-0000-7000-8000-000000000001";
const MEMBER = "0192f1a0-0000-7000-8000-0000000000aa";
const REQUEST = "0192f1a0-0000-7000-8000-0000000000bb";
const tenant = { workspaceId: WS, actorKind: "system" as const };

const explodingTx = new Proxy({} as Tx, {
  get(_t, prop) {
    throw new Error(`handler touched tx.${String(prop)}`);
  },
});

function setup(enabled: readonly string[], erasedIds: readonly string[] = []) {
  let asked = 0;
  const steps: unknown[][] = [];
  const services = {
    db: {},
    enablement: {
      get: () => {
        asked += 1;
        return Promise.resolve({ enabled: new Set(enabled), flags: new Map() });
      },
    },
    legal: {
      isErased: async (_tx: unknown, _ctx: unknown, id: string) => erasedIds.includes(id),
      completeErasureStep: async (...args: unknown[]) => {
        steps.push(args.slice(2));
      },
    },
  } as unknown as ModuleServices;
  return { handlers: createUpdatesHandlers(() => services), asked: () => asked, steps };
}

const envelope = (topic: string, payload: unknown): EventEnvelope =>
  ({
    outboxId: 1,
    topic,
    workspaceId: WS,
    payload,
    schemaVersion: 1,
    createdAt: new Date(0),
  }) as unknown as EventEnvelope;

const delivery = (over: Record<string, unknown> = {}) =>
  envelope("mail.delivery_recorded", {
    messageRef: REQUEST,
    providerMessageId: "<m1@test>",
    kind: "delivered",
    bounceType: null,
    automated: false,
    refKind: "post",
    refId: REQUEST,
    membershipId: MEMBER,
    link: null,
    occurredAt: "2026-09-22T10:00:00.000Z",
    ...over,
  });

const run = (h: EventHandler | undefined, e: EventEnvelope, ctx: unknown = tenant) => {
  if (h === undefined) throw new Error("no handler");
  return h(e, { tx: explodingTx, ctx, job: {} } as never);
};

beforeEach(() => {
  H.rows = [{ id: "r1", sendId: "s1", status: "sent", membershipId: MEMBER }];
  H.applied = [];
  H.shifts = [];
  H.pseudonymised = [];
  H.erased = [];
  H.optOuts = [];
});

describe("updates outbox handlers", () => {
  it("subscribes to exactly the two E2.6 topics", () => {
    expect(Object.keys(setup(["updates"]).handlers).sort()).toEqual([
      "mail.delivery_recorded",
      "member.erasure_requested",
    ]);
  });

  it("refuses mail that is not an update, and opens/clicks, before asking anything", async () => {
    const s = setup(["updates"]);
    const h = s.handlers["mail.delivery_recorded"];
    await run(h, delivery({ refKind: "notification" }));
    await run(h, delivery({ refKind: null }));
    await run(h, delivery({ kind: "open" }));
    await run(h, delivery({ kind: "click", link: "https://acme.test/x" }));
    expect(s.asked()).toBe(0);
    expect(H.applied).toEqual([]);
  });

  it("ignores delivery feedback for a host event or a workspace with the module off", async () => {
    const s = setup(["crm"]);
    await run(s.handlers["mail.delivery_recorded"], delivery());
    await run(s.handlers["mail.delivery_recorded"], delivery(), { actorKind: "host" });
    expect(s.asked()).toBe(1);
    expect(H.applied).toEqual([]);
  });

  /*
   * Contract decision 5 (amended): a DSAR reaches rows written while the module was on, and the
   * kernel waits for this step from every workspace — so erasure never asks about enablement.
   */
  it("erases and reports even where the module is switched off", async () => {
    const s = setup(["crm"]);
    await run(
      s.handlers["member.erasure_requested"],
      envelope("member.erasure_requested", { requestId: REQUEST, membershipId: MEMBER }),
    );
    expect(s.asked()).toBe(0);
    expect(H.pseudonymised).toEqual([MEMBER]);
    expect(s.steps).toEqual([[REQUEST, "updates", { recipients: 3, replies: 2, unsubscribes: 1 }]]);
  });

  it("moves sent → delivered → bounced and shifts the send's counters with it", async () => {
    const s = setup(["updates"]);
    const h = s.handlers["mail.delivery_recorded"];
    await run(h, delivery());
    await run(h, delivery({ kind: "bounce", bounceType: "hard" }));
    expect(H.applied.map((a) => a.patch)).toEqual([
      { status: "delivered" },
      { status: "bounced", error: "bounce:hard" },
    ]);
    expect(H.shifts).toEqual([
      ["s1", "sent", "delivered"],
      ["s1", "delivered", "bounced"],
    ]);
    expect(H.applied[0]?.at.toISOString()).toBe("2026-09-22T10:00:00.000Z");
  });

  it("does not let a redelivered or late `delivered` touch a bounced row", async () => {
    H.rows = [{ id: "r1", sendId: "s1", status: "bounced", membershipId: MEMBER }];
    const s = setup(["updates"]);
    await run(s.handlers["mail.delivery_recorded"], delivery());
    await run(s.handlers["mail.delivery_recorded"], delivery({ kind: "bounce" }));
    expect(H.applied).toEqual([]);
    expect(H.shifts).toEqual([]);
  });

  it("records a complaint on top of a bounce", async () => {
    H.rows = [{ id: "r1", sendId: "s1", status: "bounced", membershipId: MEMBER }];
    const s = setup(["updates"]);
    await run(s.handlers["mail.delivery_recorded"], delivery({ kind: "complaint" }));
    expect(H.applied.map((a) => a.patch)).toEqual([{ status: "complained", error: "complaint" }]);
    expect(H.shifts).toEqual([["s1", "bounced", "complained"]]);
  });

  it("a soft bounce notes itself on the row but never moves it or the counters", async () => {
    const s = setup(["updates"]);
    const h = s.handlers["mail.delivery_recorded"];
    await run(h, delivery({ kind: "bounce", bounceType: "soft" }));
    await run(h, delivery());
    await run(h, delivery({ kind: "bounce", bounceType: "soft" }));
    await run(h, delivery({ kind: "bounce", bounceType: "hard" }));
    await run(h, delivery({ kind: "bounce", bounceType: "soft" }));
    expect(H.applied.map((a) => a.patch)).toEqual([
      { error: "bounce:soft" },
      { status: "delivered" },
      { error: "bounce:soft" },
      { status: "bounced", error: "bounce:hard" },
    ]);
    expect(H.shifts).toEqual([
      ["s1", "sent", "delivered"],
      ["s1", "delivered", "bounced"],
    ]);
  });

  it("drops feedback about a member whose erasure was requested", async () => {
    const s = setup(["updates"], [MEMBER]);
    await run(
      s.handlers["mail.delivery_recorded"],
      delivery({ kind: "bounce", bounceType: "hard" }),
    );
    // …also when the event carries no member but the row it names belongs to one.
    await run(s.handlers["mail.delivery_recorded"], delivery({ membershipId: null }));
    expect(H.applied).toEqual([]);
    expect(H.shifts).toEqual([]);
  });

  it("only stamps the clock on a delay", async () => {
    const s = setup(["updates"]);
    await run(s.handlers["mail.delivery_recorded"], delivery({ kind: "delay" }));
    expect(H.applied.map((a) => a.patch)).toEqual([{}]);
    expect(H.shifts).toEqual([]);
  });

  it("erases the member's rows and reports the counts to the kernel", async () => {
    const s = setup(["updates"]);
    await run(
      s.handlers["member.erasure_requested"],
      envelope("member.erasure_requested", { requestId: REQUEST, membershipId: MEMBER }),
    );
    expect(H.pseudonymised).toEqual([MEMBER]);
    expect(H.erased).toEqual([MEMBER]);
    expect(H.optOuts).toEqual([MEMBER]);
    expect(s.steps).toEqual([[REQUEST, "updates", { recipients: 3, replies: 2, unsubscribes: 1 }]]);
  });
});
