import type { TenantContext, Tx } from "@fundroom/db";
import type { SearchEntryInput } from "@fundroom/module-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchRow } from "./entry.js";

const calls = vi.hoisted(() => ({ log: [] as unknown[][] }));

// E3.5 LX: every write takes the workspace row first (global order: row → index → chain).
vi.mock("@fundroom/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fundroom/db")>()),
  lockWorkspaceRow: async (_tx: Tx, ws: string) => {
    calls.log.push(["row", ws]);
  },
}));

vi.mock("./repos/search-repo.js", () => ({
  lockModuleIndexShared: async (_tx: Tx, ws: string, module: string) => {
    calls.log.push(["lock", ws, module]);
  },
  moveAclPath: async (_tx: Tx, ws: string, module: string, from: string, to: string) => {
    calls.log.push(["move", ws, module, from, to]);
    return 3;
  },
  clearBodies: async (_tx: Tx, ws: string, module: string, kind: string, ids: string[]) => {
    calls.log.push(["clear", ws, module, kind, ids]);
    return ids.length;
  },
  upsertRows: async (_tx: Tx, ws: string, rows: readonly SearchRow[]) => {
    calls.log.push(["upsert", ws, rows.map((r) => `${r.kind}/${r.refId}/${r.part}:${r.title}`)]);
  },
  deleteRef: async (
    _tx: Tx,
    ws: string,
    module: string,
    kind: string,
    refId: string,
    part?: string,
  ) => {
    calls.log.push(["delete", ws, module, kind, refId, part]);
    return 0;
  },
  markReindexRequested: async (_tx: Tx, ws: string, module: string) => {
    calls.log.push(["requested", ws, module]);
  },
}));

const { createSearchIndex, SearchEntryError, UPSERT_BATCH_ROWS } = await import("./index.js").then(
  async (m) => ({
    ...m,
    UPSERT_BATCH_ROWS: (await import("./index-service.js")).UPSERT_BATCH_ROWS,
  }),
);

const WS = "0192f1a0-5c3e-7d2a-9a3b-00000000aaaa";
const REF = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
const system: TenantContext = { workspaceId: WS, actorKind: "system" };
const tx = {} as Tx;

function entry(over: Partial<SearchEntryInput> = {}): SearchEntryInput {
  return {
    kind: "page",
    refId: REF,
    title: "Home",
    acl: { kind: "members" },
    href: "/p/home",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

function queue() {
  const sent: unknown[][] = [];
  return {
    sent,
    port: {
      sendInTransaction: async (...args: unknown[]) => {
        sent.push(args.slice(1));
        return "job-1";
      },
    },
  };
}

beforeEach(() => {
  calls.log = [];
});

describe("SearchIndex", () => {
  it("upsert validates, dedupes keys within the call (last wins) and writes on the caller's tx", async () => {
    const index = createSearchIndex({ queue: queue().port });
    await index.upsert(tx, system, "content", [
      entry({ title: "Old" }),
      entry({ part: "intro", title: "Intro" }),
      entry({ title: "New" }),
    ]);
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "content"],
      ["upsert", WS, [`page/${REF}/intro:Intro`, `page/${REF}/:New`]],
    ]);
  });

  it("upsert batches large inputs", async () => {
    const index = createSearchIndex({ queue: queue().port });
    const many = Array.from({ length: UPSERT_BATCH_ROWS * 2 + 5 }, (_, i) =>
      entry({ part: `p${i}` }),
    );
    await index.upsert(tx, system, "content", many);
    expect(calls.log.slice(2).map((c) => (c[2] as unknown[]).length)).toEqual([
      UPSERT_BATCH_ROWS,
      UPSERT_BATCH_ROWS,
      5,
    ]);
  });

  it("replace deletes every part of the ref, then inserts; refuses entries of another ref", async () => {
    const index = createSearchIndex({ queue: queue().port });
    await index.replace(tx, system, "content", "page", REF.toUpperCase(), [
      entry({ part: "a" }),
      entry({ part: "b" }),
    ]);
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "content"],
      ["delete", WS, "content", "page", REF, undefined],
      ["upsert", WS, [`page/${REF}/a:Home`, `page/${REF}/b:Home`]],
    ]);
    calls.log = [];
    await expect(
      index.replace(tx, system, "content", "page", REF, [entry({ kind: "post" })]),
    ).rejects.toThrow(/belongs to another ref/u);
    expect(calls.log).toEqual([]);
  });

  it("replace with no entries is a remove", async () => {
    const index = createSearchIndex({ queue: queue().port });
    await index.replace(tx, system, "content", "page", REF, []);
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "content"],
      ["delete", WS, "content", "page", REF, undefined],
    ]);
  });

  it("remove deletes all parts, or one part", async () => {
    const index = createSearchIndex({ queue: queue().port });
    await index.remove(tx, system, "content", { kind: "page", refId: REF });
    await index.remove(tx, system, "content", { kind: "page", refId: REF, part: "intro" });
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "content"],
      ["delete", WS, "content", "page", REF, undefined],
      ["row", WS],
      ["lock", WS, "content"],
      ["delete", WS, "content", "page", REF, "intro"],
    ]);
  });

  it("requestReindex stamps the state and enqueues search.reindex in the same tx, deduped per pair", async () => {
    const q = queue();
    const index = createSearchIndex({ queue: q.port });
    await index.requestReindex(tx, system, "data-room");
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "data-room"],
      ["requested", WS, "data-room"],
    ]);
    expect(q.sent).toEqual([
      [
        "search.reindex",
        { workspaceId: WS, module: "data-room" },
        { idempotencyKey: `search:${WS}:data-room` },
      ],
    ]);
  });

  it("moveAclPath re-paths in SQL; clearBodies empties bodies — both under the shared lock", async () => {
    const index = createSearchIndex({ queue: queue().port });
    expect(await index.moveAclPath(tx, system, "data-room", "r.a", "r.b.a")).toBe(3);
    expect(await index.moveAclPath(tx, system, "data-room", "r.a", "r.a")).toBe(0);
    expect(
      await index.clearBodies(tx, system, "data-room", "document", [REF.toUpperCase(), REF]),
    ).toBe(1);
    expect(await index.clearBodies(tx, system, "data-room", "document", [])).toBe(0);
    expect(calls.log).toEqual([
      ["row", WS],
      ["lock", WS, "data-room"],
      ["move", WS, "data-room", "r.a", "r.b.a"],
      ["row", WS],
      ["lock", WS, "data-room"],
      ["clear", WS, "data-room", "document", [REF]],
    ]);
    calls.log = [];
    await expect(index.moveAclPath(tx, system, "data-room", "r.a", "r..b")).rejects.toThrow(
      /not an ltree path/u,
    );
    await expect(index.clearBodies(tx, system, "data-room", "document", ["x"])).rejects.toThrow(
      /must be a uuid/u,
    );
    await expect(
      index.moveAclPath(
        tx,
        { ...system, actorKind: "external", membershipId: REF },
        "data-room",
        "a",
        "b",
      ),
    ).rejects.toThrow(/staff or system/u);
    expect(calls.log).toEqual([]);
  });

  it("an entry whose title is empty after cleaning is written, not refused (fix A #7)", async () => {
    const index = createSearchIndex({ queue: queue().port });
    await index.upsert(tx, system, "content", [entry({ title: "\u0007 \u0001" })]);
    await index.replace(tx, system, "content", "page", REF, [entry({ title: "   " })]);
    expect(calls.log.filter((c) => c[0] === "upsert")).toEqual([
      ["upsert", WS, [`page/${REF}/:\u2014`]],
      ["upsert", WS, [`page/${REF}/:\u2014`]],
    ]);
  });

  it("refuses an external or view-as context, and bad module ids, before touching the tx", async () => {
    const index = createSearchIndex({ queue: queue().port });
    const external: TenantContext = { workspaceId: WS, actorKind: "external", membershipId: REF };
    const viewAs: TenantContext = {
      workspaceId: WS,
      actorKind: "staff",
      membershipId: REF,
      viewAs: { staffMembershipId: REF, staffUserId: REF },
    };
    await expect(index.upsert(tx, external, "content", [entry()])).rejects.toThrow(
      /needs a staff or system context/u,
    );
    await expect(index.requestReindex(tx, viewAs, "content")).rejects.toThrow(/read only/u);
    await expect(
      index.remove(tx, system, "Content!", { kind: "page", refId: REF }),
    ).rejects.toThrow(SearchEntryError);
    await expect(index.upsert(tx, system, "content", [entry({ href: "//x" })])).rejects.toThrow(
      /href/u,
    );
    expect(calls.log).toEqual([]);
  });
});
