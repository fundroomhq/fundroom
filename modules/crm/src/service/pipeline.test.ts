import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import type { PipelineItemRow, StageRow } from "../repos/crm-repo.js";
import { moveItem, roundFilterOf } from "./pipeline.js";

/*
 * `moveItem` is the single door every stage change goes through — the board route and all four
 * outbox handlers — so its three writes and its one no-op are worth pinning without Postgres.
 *
 * The fake `Tx` answers canned rows in call order and records nothing else; the fake recorder
 * collects audit input. Between them they show what a move costs and, more importantly, what a
 * redelivered event costs: nothing.
 */

const ctx: TenantContext = {
  workspaceId: "0192f1a0-0000-7000-8000-000000000001",
  actorKind: "system",
};

interface AuditCall {
  action: string;
  resourceId?: string | null | undefined;
  meta?: JsonObject | undefined;
  actorMembershipId?: string | null | undefined;
}

function harness(responses: unknown[][]) {
  const executed: unknown[] = [];
  const audited: AuditCall[] = [];
  let next = 0;
  const tx = {
    execute: (query: unknown) => {
      executed.push(query);
      const rows = responses[next] ?? [];
      next += 1;
      return Promise.resolve({ rows });
    },
  } as unknown as Tx;
  const services = {
    audit: {
      record: (_tx: unknown, _ctx: unknown, input: AuditCall) => {
        audited.push(input);
        return Promise.resolve({});
      },
    },
  } as unknown as ModuleServices;
  return { tx, services, executed, audited };
}

const stage = (id: string, key: string, position: number): StageRow => ({
  id,
  key,
  name: key,
  position,
  isTerminal: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const CONTACTED = stage("0192f1a0-0000-7000-8000-0000000000a1", "contacted", 2);
const SIGNED = stage("0192f1a0-0000-7000-8000-0000000000a2", "signed", 8);

const card: PipelineItemRow = {
  id: "0192f1a0-0000-7000-8000-0000000000b1",
  roundId: "0192f1a0-0000-7000-8000-0000000000c1",
  contactId: "0192f1a0-0000-7000-8000-0000000000d1",
  organizationId: null,
  stageId: CONTACTED.id,
  amount: "250000.000000",
  currency: "USD",
  ownerMembershipId: null,
  commitmentId: null,
  position: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** What the repo's `RETURNING` hands back for the moved row. */
const movedRow = (stageId: string, position: number) => ({
  id: card.id,
  roundId: card.roundId,
  contactId: card.contactId,
  organizationId: null,
  stageId,
  amount: card.amount,
  currency: card.currency,
  ownerMembershipId: null,
  commitmentId: null,
  position,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("moveItem", () => {
  it("updates the card, writes a transition and audits the two keys", async () => {
    const h = harness([
      [{ next: 3 }], // nextPosition
      [movedRow(SIGNED.id, 3)], // update
      [{ id: "t1", createdAt: new Date(0) }], // transition insert
    ]);
    const moved = await moveItem(h.services, ctx, h.tx, {
      item: card,
      from: CONTACTED,
      to: SIGNED,
      cause: "commitment_changed",
    });
    expect(moved.stageId).toBe(SIGNED.id);
    expect(moved.position).toBe(3);
    expect(h.executed).toHaveLength(3);
    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]?.action).toBe("crm.pipeline_item_moved");
    expect(h.audited[0]?.meta).toEqual({
      from: "contacted",
      to: "signed",
      cause: "commitment_changed",
    });
  });

  /*
   * This is the whole of the handlers' idempotency, said once. A redelivered
   * `round.commitment_changed` for a status the card already reflects must produce no second
   * history row and no second audit event — a board showing two "moved to Signed" entries a
   * second apart would be lying about what happened.
   */
  it("writes nothing at all when the card is already in the target stage", async () => {
    const h = harness([]);
    const moved = await moveItem(h.services, ctx, h.tx, {
      item: card,
      from: CONTACTED,
      to: CONTACTED,
      cause: "commitment_changed",
    });
    expect(moved).toBe(card);
    expect(h.executed).toHaveLength(0);
    expect(h.audited).toHaveLength(0);
  });

  it("reorders within a stage without writing a transition", async () => {
    const h = harness([[movedRow(CONTACTED.id, 7)]]);
    const moved = await moveItem(h.services, ctx, h.tx, {
      item: card,
      from: CONTACTED,
      to: CONTACTED,
      cause: "staff",
      position: 7,
    });
    expect(moved.position).toBe(7);
    // One statement — the update. No `nextPosition`, no transition, no audit row: reordering a
    // column is not a change of stage and must not read as one in the history.
    expect(h.executed).toHaveLength(1);
    expect(h.audited).toHaveLength(0);
  });

  it("records a first move out of no stage at all as a null `from`", async () => {
    const h = harness([
      [{ next: 1 }],
      [movedRow(SIGNED.id, 1)],
      [{ id: "t1", createdAt: new Date(0) }],
    ]);
    await moveItem(h.services, ctx, h.tx, {
      item: card,
      from: null,
      to: SIGNED,
      cause: "staff",
      actor: { membershipId: "0192f1a0-0000-7000-8000-0000000000e1" },
    });
    expect(h.audited[0]?.meta).toEqual({ from: null, to: "signed", cause: "staff" });
    expect(h.audited[0]?.actorMembershipId).toBe("0192f1a0-0000-7000-8000-0000000000e1");
  });

  it("attributes a handler-driven move to nobody", async () => {
    const h = harness([
      [{ next: 1 }],
      [movedRow(SIGNED.id, 1)],
      [{ id: "t1", createdAt: new Date(0) }],
    ]);
    await moveItem(h.services, ctx, h.tx, {
      item: card,
      from: CONTACTED,
      to: SIGNED,
      cause: "commitment_created",
    });
    expect(h.audited[0]?.actorMembershipId).toBeNull();
  });

  it("refuses when the card vanished under it", async () => {
    const h = harness([[{ next: 1 }], []]);
    await expect(
      moveItem(h.services, ctx, h.tx, {
        item: card,
        from: CONTACTED,
        to: SIGNED,
        cause: "staff",
      }),
    ).rejects.toThrow(/no such pipeline item/u);
  });
});

describe("roundFilterOf", () => {
  it("reads an absent roundId as every card", () => {
    expect(roundFilterOf(undefined)).toEqual({ kind: "all" });
  });

  it("reads the `none` sentinel as the cards attached to no round", () => {
    expect(roundFilterOf("none")).toEqual({ kind: "one", id: null });
  });

  it("reads a uuid as that round", () => {
    expect(roundFilterOf(card.roundId ?? "")).toEqual({ kind: "one", id: card.roundId });
  });
});
